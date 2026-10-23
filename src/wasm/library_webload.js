// SPDX-License-Identifier: Apache-2.0
// library_webload.js -- Emscripten JS library for the browser build.
// hw_js_webload(spec) runs in the *loader pthread* (a worker), started by webrt_load() in
// webrt.c on the proxied main pthread before impl(). It fetches the DASD chunk files and the
// small boot files, checks size and sha256 in this worker, and writes them into WasmFS
// (memory backend) through the hw_fs_* C helpers. The browser main thread never touches the
// bytes.
//
// spec (JSON string from wasm_main --webload=...):
//   { "manifest": "<absolute URL of dasd manifest.json>",     (optional)
//     "dasdDir":  "DASD",                                      (target dir for the volumes)
//     "files":    [ { "path": "conf/web.cnf", "url": "<absolute URL>" }, ... ],
//     "dirs":     [ "shadow", "printers", ... ],
//     "empty":    [ "rdr/rdr00c.txt", ... ],
//     "concurrency": 4, "verify": true,
//     "opfs": { "dir": "shadow", "reset": false, "probeMs": 15000,          (persistence, optional)
//               "seed": [ { "name": "mvsres_1.cckd", "url": "<abs URL>", "sha256": "..." } ],
//               "snapDir": "snap", "snapReset": false,                     (snapshots, optional)
//               "restore": { "from": "snap/s12", "shadowDir": "" | "shadow", "files": [ { "name", "size", "sha256" } ],
//                            "srf": { "size", "sha256" } } } }
// files[] entries may have "text" (inline content, e.g. a config edited by the runtime) instead of "url".
//
// opfs: runs FIRST, in this worker, on the OPFS directory <dir> (the WasmFS OPFS
// backend is mounted by wasm_main --opfs=/opfs, so <dir> = /opfs/<dir> for Hercules):
//   1. reset: remove <dir> recursively ('Reset machine'; Hercules has not opened anything yet).
//   2. probe: open a sync access handle on every existing file and close it again, retrying while
//      another context still holds one (NoModificationAllowedError / InvalidStateError: a page that
//      is closing, whose workers have not ended yet). Without this, cckd_sf_init would fail the R/W
//      open (WasmFS returns EACCES), open the file read-only and CREATE A NEW shadow file [2].
//   3. seed: write each seed file that does not exist yet (the web image's config-only change: the
//      SMFPRM00 track, scripts/mk-seed-shadow.py).
//   snapReset removes the snapshot directory <snapDir> (this load IPLs: every old
//   checkpoint is older than the disks from now on); <snapDir> is created. restore (this load resumes a checkpoint):
//   after step 2, read every file of the slot, check size + sha256 (and machine.srf), then REPLACE the files of <dir>
//   with the slot's shadow files (the live shadows are newer than the checkpoint: resuming on them would mix two
//   points in time). A verify error leaves <dir> as it is (restore.ok false: the page IPLs); an error while
//   copying empties <dir> (restore.wiped: fresh disks + seed, never a mix).
//   The result is logged as one line 'webload-opfs: {json}' (files, sizes, waits, seeded, reset, restore).
// manifest.json (scripts/mk-dasd-chunks.sh):
//   { "format": 1, "chunkSize": N, "volumes": [ { "name": "mvsres.3350", "size": N, "sha256": "...",
//       "chunks": [ { "file": "mvsres.3350.000", "offset": 0, "size": N, "sha256": "..." }, ... ] } ] }
// Chunk URLs are relative to the manifest URL.

addToLibrary({
  hw_js_webload__deps: ['malloc', 'free', 'hw_fs_create', 'hw_fs_pwrite', 'hw_fs_close', 'hw_fs_mkdirs', 'hw_fs_chmod',
                        'hw_load_progress', 'hw_load_finish', '$UTF8ToString', '$stringToNewUTF8', '$lazyDasd', 'hw_log_note'],
  hw_js_webload: (specPtr) => {
    const spec = JSON.parse(UTF8ToString(specPtr));
    const SLICE = 4 << 20;                       // copy into the heap in 4 MiB slices
    let stage = 0;                               // malloc'ed staging buffer
    let loaded = 0, total = 0, files = 0;
    const t0 = performance.now();
    const progress = () => _hw_load_progress(loaded, total, files);

    const withStr = (s, f) => { const p = stringToNewUTF8(s); try { return f(p); } finally { _free(p); } };
    const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

    // GET url fully into a (non-shared) Uint8Array; count bytes as they arrive.
    async function get(url, size) {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
      if (size == null) { const b = new Uint8Array(await r.arrayBuffer()); loaded += b.length; progress(); return b; }
      const out = new Uint8Array(size);
      let off = 0;
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (off + value.length > size) throw new Error(`GET ${url}: more than ${size} bytes`);
        out.set(value, off); off += value.length; loaded += value.length; progress();
      }
      if (off !== size) throw new Error(`GET ${url}: ${off} bytes, expected ${size}`);
      return out;
    }

    async function verify(what, bytes, sha) {
      if (!spec.verify || !sha) return;
      if (!crypto.subtle) throw new Error('crypto.subtle not available (not a secure context?)');
      const got = hex(await crypto.subtle.digest('SHA-256', bytes));
      if (got !== sha) throw new Error(`${what}: sha256 ${got}, expected ${sha}`);
    }

    function put(fd, bytes, offset, what) {
      for (let o = 0; o < bytes.length; o += SLICE) {
        const n = Math.min(SLICE, bytes.length - o);
        HEAPU8.set(bytes.subarray(o, o + n), stage);
        const k = _hw_fs_pwrite(fd, stage, n, offset + o);
        if (k !== n) throw new Error(`${what}: pwrite rc=${k}`);
      }
    }

    function create(path, size) {
      const fd = withStr(path, (p) => _hw_fs_create(p, size));
      if (fd < 0) throw new Error(`create ${path}: errno ${-fd}`);
      return fd;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const BUSY = new Set(['NoModificationAllowedError', 'InvalidStateError']);

    async function opfsPrepare(o) {
      if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('OPFS (navigator.storage.getDirectory) not available');
      const t0 = performance.now();
      const info = { dir: o.dir, reset: false, files: [], seeded: [], waitMs: 0, retries: 0 };
      const root = await navigator.storage.getDirectory();
      const retry = async (what, f) => {
        for (;;) {
          try { return await f(); } catch (e) {
            if (BUSY.has(e && e.name) && performance.now() - t0 < (o.probeMs || 15000)) { info.retries++; await sleep(100); continue; }
            throw new Error(`${what}: ${e && e.name}: ${e && e.message}`);
          }
        }
      };
      if (o.reset) {
        await retry(`reset ${o.dir}`, async () => {
          try { await root.removeEntry(o.dir, { recursive: true }); } catch (e) { if (!e || e.name !== 'NotFoundError') throw e; }
        });
        info.reset = true;
      }
      if (o.snapDir) {                           // snapshot slots
        if (o.snapReset) {
          await retry(`reset ${o.snapDir}`, async () => {
            try { await root.removeEntry(o.snapDir, { recursive: true }); } catch (e) { if (!e || e.name !== 'NotFoundError') throw e; }
          });
          info.snapReset = true;
        }
        await root.getDirectoryHandle(o.snapDir, { create: true });
      }
      const dir = await root.getDirectoryHandle(o.dir, { create: true });
      let names = [];
      for await (const [name, h] of dir.entries()) if (h.kind === 'file') names.push(name);
      names.sort();
      for (const name of names) {
        const fh = await dir.getFileHandle(name);
        const size = await retry(`shadow ${name} is in use (another tab, or a page that is still closing)`, async () => {
          const ah = await fh.createSyncAccessHandle();
          try { return ah.getSize(); } finally { ah.close(); }
        });
        info.files.push({ name, size });
      }
      if (o.restore) {
        const r = o.restore, ri = info.restore = { ok: false, from: r.from, files: r.files.length, bytes: 0 };
        const t1 = performance.now();
        const bufs = [];
        try {
          let sd = root;
          for (const x of `${r.from}/${r.shadowDir || ''}`.split('/').filter(Boolean)) sd = await sd.getDirectoryHandle(x);
          for (const f of r.files) {
            const b = new Uint8Array(await (await retry(`slot ${f.name}`, async () => (await sd.getFileHandle(f.name)).getFile())).arrayBuffer());
            if (b.length !== f.size) throw new Error(`${f.name}: ${b.length} bytes, manifest ${f.size}`);
            if (f.sha256 && hex(await crypto.subtle.digest('SHA-256', b)) !== f.sha256) throw new Error(`${f.name}: sha256 differs from the manifest`);
            bufs.push([f.name, b]); ri.bytes += b.length;
          }
          const dirOf = async (path) => { let d = root; for (const x of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(x); return d; };
          const readChecked = async (d, name, f, what) => {
            const b = new Uint8Array(await (await retry(`${what} ${name}`, async () => (await d.getFileHandle(name)).getFile())).arrayBuffer());
            if (b.length !== f.size) throw new Error(`${what} ${name}: ${b.length} bytes, manifest ${f.size}`);
            if (f.sha256 && hex(await crypto.subtle.digest('SHA-256', b)) !== f.sha256) throw new Error(`${what} ${name}: sha256 differs from the manifest`);
            return b;
          };
          if (r.srf) ri.srfBytes = (await readChecked(await dirOf(r.from), 'machine.srf', r.srf, 'slot')).length;
          if (r.delta) {
            // a delta slot (patch 0018): the base slot's shadow copies + shadows.dlt (written by the C side:
            // "MVSCKDL1", per file 'F' u16 name length, name, u64 size, u32 runs, runs (u64 offset, u32 length, data),
            // 'E' u32 file count; little endian); the base's machine.srf is read by resume itself (checked here)
            const bd = await dirOf(r.base.from);
            if (r.base.srf) await readChecked(bd, 'machine.srf', r.base.srf, 'base');
            const files = new Map();
            for (const f of r.base.files) files.set(f.name, await readChecked(bd, f.name, f, 'base'));
            const dl = await readChecked(await dirOf(r.from), 'shadows.dlt', r.delta, 'slot');
            const dv = new DataView(dl.buffer, dl.byteOffset, dl.byteLength);
            const u64 = (p) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
            if (new TextDecoder().decode(dl.subarray(0, 8)) !== 'MVSCKDL1') throw new Error('shadows.dlt: bad header');
            let p = 8; const seen = [];
            for (;;) {
              const t = dl[p++];
              if (t === 0x45) { if (dv.getUint32(p, true) !== seen.length) throw new Error('shadows.dlt: file count'); break; }
              if (t !== 0x46) throw new Error(`shadows.dlt: bad record at ${p - 1}`);
              const nl = dv.getUint16(p, true); p += 2;
              const name = new TextDecoder().decode(dl.subarray(p, p + nl)); p += nl;
              const size = u64(p), nruns = dv.getUint32(p + 8, true); p += 12;
              const old = files.get(name);
              if (!old) throw new Error(`shadows.dlt: ${name} is not in the base`);
              const b = new Uint8Array(size); b.set(old.subarray(0, Math.min(size, old.length)));
              for (let i = 0; i < nruns; i++) {
                const off = u64(p), len = dv.getUint32(p + 8, true); p += 12;
                if (off + len > size || p + len > dl.length) throw new Error(`shadows.dlt: ${name}: run out of range`);
                b.set(dl.subarray(p, p + len), off); p += len;
              }
              seen.push(name); bufs.push([name, b]); ri.bytes += b.length;
            }
            ri.delta = { files: seen.length, bytes: dl.length, base: r.base.from };
          }
        } catch (e) { ri.stage = 'verify'; ri.error = `${e && e.name}: ${e && e.message}`; }
        ri.verifyMs = Math.round(performance.now() - t1);
        if (!ri.error) {
          const t2 = performance.now();
          try {
            for (const name of names) await retry(`remove shadow ${name}`, () => dir.removeEntry(name));
            names = [];
            for (const [name, b] of bufs) {
              const fh = await dir.getFileHandle(name, { create: true });
              const ah = await retry(`write shadow ${name}`, () => fh.createSyncAccessHandle());
              try { ah.truncate(0); const n = ah.write(b, { at: 0 }); if (n !== b.length) throw new Error(`${name}: wrote ${n} of ${b.length}`); ah.flush(); } finally { ah.close(); }
              names.push(name);
            }
            ri.ok = true;
          } catch (e) {
            ri.stage = 'copy'; ri.error = `${e && e.name}: ${e && e.message}`;
            // never leave a mix of two points in time: start from the base volumes (+ seed) instead
            for await (const [name, h] of dir.entries()) if (h.kind === 'file') { try { await dir.removeEntry(name); } catch { /* best effort */ } }
            names = []; ri.wiped = true;
          }
          ri.copyMs = Math.round(performance.now() - t2);
          info.files = [];
          for await (const [name, h] of dir.entries()) if (h.kind === 'file') info.files.push({ name, size: (await h.getFile()).size });
          names = info.files.map((f) => f.name);
        }
      }
      for (const sd of o.seed || []) {
        if (names.includes(sd.name)) continue;
        const b = await get(sd.url, null);
        await verify(sd.name, b, sd.sha256);
        const fh = await dir.getFileHandle(sd.name, { create: true });
        const ah = await fh.createSyncAccessHandle();
        try { ah.truncate(0); const n = ah.write(b, { at: 0 }); if (n !== b.length) throw new Error(`seed ${sd.name}: wrote ${n} of ${b.length}`); ah.flush(); } finally { ah.close(); }
        info.seeded.push({ name: sd.name, size: b.length });
      }
      info.waitMs = Math.round(performance.now() - t0);
      return info;
    }

    // Run tasks with at most n in flight.
    async function pool(tasks, n) {
      let next = 0;
      const run = async () => { while (next < tasks.length) { const t = tasks[next++]; await t(); } };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(n, tasks.length)) }, run));
    }

    (async () => {
      stage = _malloc(SLICE);
      if (!stage) throw new Error('malloc(staging) failed');
      // start every network read at once (the small boot files, the manifest and,
      // for a lazy manifest, the metadata blob) instead of one after the other; they are used in the same
      // order as before. Each was one round trip (60 ms on the throttled profile) in a row.
      const quiet = (pr) => { pr.catch(() => {}); return pr; };
      const fileP = (spec.files || []).map((f) => (f.text != null ? null : quiet(get(f.url, null))));
      const manP = spec.manifest ? quiet((async () => {
        const r = await fetch(spec.manifest, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`GET ${spec.manifest}: HTTP ${r.status}`);
        const m = await r.json();
        if (m && m.format === 2) lazyDasd.early(m, spec.manifest, spec);
        return m;
      })()) : null;
      const opfsInfo = spec.opfs ? await opfsPrepare(spec.opfs) : null;
      for (const d of spec.dirs || []) withStr(d, (p) => _hw_fs_mkdirs(p));
      for (const f of spec.empty || []) _hw_fs_close(create(f, 0));

      let manifest = null;
      if (spec.manifest) {
        manifest = await manP;
        if (manifest.format !== 1 && manifest.format !== 2) throw new Error(`manifest format ${manifest.format} not supported`);
        if (manifest.format === 1) total = manifest.volumes.reduce((a, v) => a + v.size, 0);
        else total = (manifest.boot && manifest.boot.readyBytes) || 0;   // lazy: progress Y = the boot working set
        progress();
      }

      // small boot files first (conf, rc, logo, scripts)
      for (const [k, f] of (spec.files || []).entries()) {
        const b = f.text != null ? new TextEncoder().encode(f.text) : await fileP[k];
        total += b.length;
        const fd = create(f.path, b.length);
        put(fd, b, 0, f.path); _hw_fs_close(fd); files++; progress();
      }

      let lazyNote = '';
      if (manifest && manifest.format === 2) {
        // lazy chunked volumes (library_lazydasd.js); this worker stays the DASD I/O worker.
        const lz = await lazyDasd.start(manifest, spec.manifest, spec, (m) => withStr(`${m}\n`, (p) => _hw_log_note(p)));
        files += manifest.volumes.length; progress();
        lazyNote = `, lazy DASD: ${manifest.volumes.length} volumes, metadata in ${lz.metaMs} ms, boot list ${lz.bootChunks} chunks / ${lz.bootTotal} B`;
      } else if (manifest) {
        const dir = (spec.dasdDir || 'DASD').replace(/\/$/, '');
        const fds = new Map();
        for (const v of manifest.volumes) fds.set(v.name, { fd: create(`${dir}/${v.name}`, v.size), left: v.chunks.length });
        const tasks = [];
        for (const v of manifest.volumes) for (const c of v.chunks) tasks.push(async () => {
          const url = new URL(c.file, spec.manifest).href;
          const b = await get(url, c.size);
          await verify(c.file, b, c.sha256);
          const e = fds.get(v.name);
          put(e.fd, b, c.offset, c.file);
          if (--e.left === 0) {
            _hw_fs_close(e.fd); files++; progress();
            if (spec.dasdReadOnly) {                       // writes must go to the sf= shadow
              const rc = withStr(`${dir}/${v.name}`, (p) => _hw_fs_chmod(p, 0o444));
              if (rc !== 0) throw new Error(`chmod ${v.name}: errno ${-rc}`);
            }
          }
        });
        await pool(tasks, spec.concurrency || 4);
      }
      const ms = Math.round(performance.now() - t0);
      const where = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope ? `worker '${self.name || '?'}'` : 'NOT a worker';
      return `webload: ${files} files, ${loaded} bytes in ${ms} ms (in ${where})${lazyNote}` +
        (opfsInfo ? `\nwebload-opfs: ${JSON.stringify(opfsInfo)}` : '');
    })().then((msg) => {
      if (stage) _free(stage);
      withStr(msg, (p) => _hw_load_finish(0, p));
    }, (e) => {
      if (stage) _free(stage);
      withStr(`webload failed: ${e && e.message ? e.message : e}`, (p) => _hw_load_finish(-1, p));
    });
  },
});
