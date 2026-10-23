// SPDX-License-Identifier: Apache-2.0
// library_lazydasd.js -- the DASD I/O worker for lazy CCKD volumes.
// Runs in the loader pthread (a worker; library_webload.js calls lazyDasd.start() when the DASD
// manifest has format 2, scripts/dasd-chunk.py). The C side is src/wasm/lazydasd.cpp.
//
//  1. Load the metadata blob (headers + L1 + L2 of each volume, gzip), from Cache Storage or the
//     network, gunzip it in this worker, register the volumes (hw_lazy_vol_add) and create the
//     read-only volume files in WasmFS (hw_lazy_mount). Then impl() can start.
//  2. Serve chunks: demanded chunks first (a Hercules thread waits on a futex for them; it rings
//     a BroadcastChannel, a poll timer is the fallback), then the boot list (prefetch, in
//     first-access order, `concurrency` (6) parallel requests; demand may use 2 more).
//     Each chunk: Cache Storage hit, else fetch() of the whole file (no Range requests), size and
//     sha256 check (the file name is the sha256), cache.put(), copy into the heap buffer that C
//     gives (in-heap LRU), then hw_lazy_fill_end() wakes the waiters.
// The browser main thread is not involved.

addToLibrary({
  $lazyDasd__deps: ['malloc', 'free', '$stringToNewUTF8', 'hw_lazy_init', 'hw_lazy_vol_add', 'hw_lazy_boot',
                    'hw_lazy_mount', 'hw_lazy_next_demand', 'hw_lazy_claim', 'hw_lazy_fill_begin',
                    'hw_lazy_fill_end', 'hw_lazy_fail', 'hw_lazy_prefetch_done', 'hw_load_progress', 'hw_lazy_waiting'],
  $lazyDasd: {
    opts(spec) {
      return Object.assign({ concurrency: 6, extraDemand: 2, budgetMiB: 24, cache: true, cacheName: 'mvs-dasd-c1',
        prefetch: 'ready', prefetchAll: false, prefetchWait: false, verify: spec.verify !== false, pollMs: 25, cleanup: true,
        packs: true }, spec.lazy || {});
    },
    // called by webload as soon as the manifest is parsed (in parallel with the OPFS
    // preparation and the small boot files): opens Cache Storage and starts the metadata read.
    early(manifest, murl, spec) {
      if (this.pre) return this.pre;
      const o = this.opts(spec);
      const cacheP = (async () => {
        if (!o.cache || typeof caches === 'undefined') return { cache: null, err: null };
        try { return { cache: await caches.open(o.cacheName), err: null }; } catch (e) { return { cache: null, err: e }; }
      })();
      const mf = manifest.meta;
      const metaP = cacheP.then(({ cache }) => this.getFile(cache, new URL(mf.file, murl).href, mf.size, mf.file.split('/').pop(), true, null));
      metaP.catch(() => {});
      this.pre = { cacheP, metaP };
      return this.pre;
    },
    // undo scripts/dasd-packs.py --meta l2delta (per volume: 8 byte planes of LE dpos u32, len u16, dsize u16)
    unL2delta(t, vols) {
      const out = new Uint8Array(t);
      for (const v of vols) {
        const base = v.metaOff, pre = 1024 + 4 * v.numl1, n = 256 * v.l2tabs, o = base + pre;
        const be = (t[base + 512 + 3] & 2) !== 0;
        const dv = new DataView(out.buffer, out.byteOffset + o, 8 * n);
        let prev = 0;
        for (let i = 0; i < n; i++) {
          let pos = (t[o + i] | t[o + n + i] << 8 | t[o + 2 * n + i] << 16 | t[o + 3 * n + i] << 24) >>> 0;
          const len = t[o + 4 * n + i] | t[o + 5 * n + i] << 8;
          let size = t[o + 6 * n + i] | t[o + 7 * n + i] << 8;
          if (pos) { pos = (prev + pos - 1) >>> 0; prev = (pos + len) >>> 0; size = (size + len) & 0xffff; }
          dv.setUint32(8 * i, pos, !be); dv.setUint16(8 * i + 4, len, !be); dv.setUint16(8 * i + 6, size, !be);
        }
      }
      return out;
    },
    hex: (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(''),
    async sha256(b) { return this.hex(await crypto.subtle.digest('SHA-256', b)); },
    putErrors: 0,
    put(cache, u, b, note) {
      if (cache) cache.put(u, new Response(b, { headers: { 'content-type': 'application/octet-stream' } }))
        .catch((e) => { if (this.putErrors++ === 0 && note) note(`lazy: Cache Storage put failed: ${e && e.message || e}`); });
    },
    // whole-file GET, cache first; returns { bytes, cached }
    async getFile(cache, u, size, sha, verify, note) {
        if (cache) {
          try {
            const r = await cache.match(u);
            if (r) {
              const b = new Uint8Array(await r.arrayBuffer());
              if (b.length === size && (!verify || await this.sha256(b) === sha)) return { bytes: b, cached: true };
              await cache.delete(u);
            }
          } catch (e) { /* treat as a miss */ }
        }
        const r = await fetch(u, { credentials: 'same-origin' });
        if (!r.ok) throw new Error(`GET ${u}: HTTP ${r.status}`);
        const b = new Uint8Array(await r.arrayBuffer());
        if (b.length !== size) throw new Error(`GET ${u}: ${b.length} bytes, expected ${size}`);
        if (verify && await this.sha256(b) !== sha) throw new Error(`GET ${u}: sha256 mismatch`);
        this.put(cache, u, b, note);
        return { bytes: b, cached: false };
    },
    // manifest: parsed format-2 manifest; murl: its URL; spec: the webload spec (spec.lazy = options).
    // note(msg): log line. Resolves when impl() may start (after the volumes exist; with
    // prefetchWait also after the boot prefetch).
    async start(manifest, murl, spec, note) {
      const o = this.opts(spec);
      const url = (f) => new URL(f, murl).href;
      const sha256 = (b) => this.sha256(b);
      const withStr = (s, f) => { const p = stringToNewUTF8(s); try { return f(p); } finally { _free(p); } };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = performance.now();

      const pre = this.early(manifest, murl, spec);
      const cr = await pre.cacheP;
      const cache = cr.cache;
      if (cr.err) note(`lazy: Cache Storage not available (${cr.err && cr.err.message || cr.err}); network only`);
      const getFile = (u, size, sha, verify) => this.getFile(cache, u, size, sha, verify, note);
      getFile.put = (u, b) => this.put(cache, u, b, note);
      // 1. metadata (read started by early())
      const mf = manifest.meta;
      const mg = await pre.metaP;
      let raw = mg.bytes;
      if (mf.encoding === 'gzip') {
        raw = new Uint8Array(await new Response(new Blob([mg.bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      }
      if (mf.transform === 'l2delta') raw = this.unL2delta(raw, manifest.volumes);
      else if (mf.transform) throw new Error(`lazy: metadata transform ${mf.transform} not supported`);
      if (raw.length !== mf.rawSize || await sha256(raw) !== mf.rawSha256) throw new Error('lazy: metadata blob does not match the manifest');
      const nch = manifest.chunks.length;
      const chan = `mvs-lazy-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const sizes = _malloc(4 * nch);
      for (let i = 0; i < nch; i++) HEAPU32[(sizes >> 2) + i] = manifest.chunks[i][1];
      withStr(chan, (p) => _hw_lazy_init(nch, sizes, o.budgetMiB * 1048576, p));
      _free(sizes);
      for (const v of manifest.volumes) {
        const mp = _malloc(v.metaLen); HEAPU8.set(raw.subarray(v.metaOff, v.metaOff + v.metaLen), mp);
        const rp = _malloc(12 * v.runs.length + 4);
        v.runs.forEach((r, k) => { HEAPU32[(rp >> 2) + 3 * k] = r[0]; HEAPU32[(rp >> 2) + 3 * k + 1] = r[1]; HEAPU32[(rp >> 2) + 3 * k + 2] = r[2]; });
        const rc = withStr(v.name, (p) => _hw_lazy_vol_add(p, parseInt(v.dev || '0', 16), v.size, mp, v.metaLen, rp, v.runs.length));
        _free(mp); _free(rp);
        if (rc < 0) throw new Error(`lazy: volume ${v.name}: hw_lazy_vol_add rc=${rc}`);
      }
      const boot = o.prefetch === 'none' ? [] : (manifest.boot && (o.prefetch === 'ikt007i' ? manifest.boot.ikt007i : manifest.boot.ready)) || [];
      const bp = _malloc(4 * boot.length + 4);
      boot.forEach((id, k) => { HEAPU32[(bp >> 2) + k] = id; });
      _hw_lazy_boot(bp, boot.length); _free(bp);
      const dir = (spec.dasdDir || 'DASD').replace(/\/$/, '');
      const mrc = withStr(dir, (p) => _hw_lazy_mount(p));
      if (mrc < 0) throw new Error(`lazy: mount ${dir}: errno ${-mrc}`);
      const metaMs = Math.round(performance.now() - t0);
      note(`lazy: ${manifest.volumes.length} volumes, ${nch} chunks, metadata ${mf.size} B (${mg.cached ? 'cache' : 'network'}) in ${metaMs} ms; boot list ${boot.length} chunks (${o.prefetch}), concurrency ${o.concurrency}, LRU ${o.budgetMiB} MiB, cache ${cache ? o.cacheName : 'off'}`);

      // 2. chunk pump. prefetchAll (test/stress option): after the boot list, prefetch every other chunk too
      // (more than the LRU budget: exercises eviction and the Cache Storage reload path).
      // boot packs (manifest.packs, scripts/dasd-packs.py): the boot chunks also come as a few
      // big files, so the cold boot needs 4 requests instead of about 100. The chunks of a pack are not in the
      // per-chunk queue; a pack that is not read (all its chunks in Cache Storage, or an error) gives them back.
      const packs = o.packs && o.prefetch === 'ready' && Array.isArray(manifest.packs) ? manifest.packs : [];
      const inPack = new Set(); for (const pk of packs) for (const id of pk.ids) inPack.add(id);
      const queue = boot.filter((id) => !inPack.has(id));
      if (o.prefetchAll) { const inBoot = new Set(boot); for (let i = 0; i < nch; i++) if (!inBoot.has(i)) queue.push(i); }
      let inflight = 0, inflightPrefetch = 0, pq = 0, bootDone = false, errors = 0, packsLeft = packs.length;
      const packStat = { packs: packs.length, read: 0, skipped: 0, failed: 0, bytes: 0, chunks: 0, rescued: 0 };
      // A Hercules thread that waits for a chunk which its pack stream reaches only later (more than RESCUE bytes
      // ahead) would wait for the whole stream (NIP then says IEA120A VOLID NOT READ): that chunk is read on its
      // own at once, like a demand read. rescued: ids read on their own; the first copy in is used.
      const RESCUE = o.packRescueBytes ?? 65536;
      const rescued = new Set(), packFirst = new Set(), rescueFirst = new Set(), active = [];
      let resolveBoot; const bootPromise = new Promise((r) => { resolveBoot = r; });
      const bootTotal = boot.reduce((a, id) => a + manifest.chunks[id][1], 0);
      async function load(id, demand) {
        inflight++; if (!demand) inflightPrefetch++;
        const [sha, size] = manifest.chunks[id];
        let got = null;
        for (let attempt = 0; attempt < 4 && !got; attempt++) {
          try { got = await getFile(url(`c/${sha}`), size, sha, o.verify); }
          catch (e) { errors++; note(`lazy: chunk ${id} attempt ${attempt + 1}: ${e && e.message || e}`); await sleep(250 << attempt); }
        }
        if (got && rescued.has(id)) {      // a pack chunk read on its own: only the first copy is used
          rescued.delete(id);
          if (packFirst.delete(id)) { inflight--; if (!demand) inflightPrefetch--; pump(); return; }
          rescueFirst.add(id);
        }
        if (got) {
          const p = _hw_lazy_fill_begin(id);
          if (p) { HEAPU8.set(got.bytes, p); _hw_lazy_fill_end(id, got.cached ? 1 : 0); }
          else { note(`lazy: no heap memory for chunk ${id} (${size} B)`); _hw_lazy_fail(id); }
        } else _hw_lazy_fail(id);
        inflight--; if (!demand) inflightPrefetch--;
        pump();
      }
      function pump() {
        for (const a of active) {
          for (let k = a.k + 1; k < a.pk.ids.length; k++) {
            const id = a.pk.ids[k];
            if (a.offs[k] - a.got <= RESCUE) continue;
            if (!a.mine[k] || a.filled[k] || rescued.has(id) || !_hw_lazy_waiting(id)) continue;
            rescued.add(id); packStat.rescued++; load(id, true);
          }
        }
        for (;;) {
          if (inflight >= o.concurrency + o.extraDemand) break;
          const id = _hw_lazy_next_demand();
          if (id < 0) break;
          load(id, true);
        }
        while (inflight < o.concurrency && pq < queue.length) {
          const id = queue[pq++];
          if (_hw_lazy_claim(id)) load(id, false);
        }
        if (!bootDone && pq >= queue.length && inflightPrefetch === 0 && packsLeft === 0) {
          bootDone = true; _hw_lazy_prefetch_done();
          note(`lazy: boot prefetch done: ${boot.length} chunks, ${bootTotal} B${queue.length > boot.length ? ` (+${queue.length - boot.length} more chunks)` : ''}, ${Math.round(performance.now() - t0)} ms after start, ${errors} errors` +
            (packs.length ? `; packs ${JSON.stringify(packStat)}` : ''));
          resolveBoot();
          if (o.cleanup && cache) setTimeout(cleanup, 5000);
        }
      }
      async function cleanup() {          // drop cached chunks that the manifest no longer uses
        try {
          const keep = new Set(manifest.chunks.map((c) => url(`c/${c[0]}`))); keep.add(url(mf.file));
          const base = url('c/');
          let n = 0;
          for (const req of await cache.keys()) if (req.url.startsWith(base) && !keep.has(req.url)) { await cache.delete(req); n++; }
          if (n) note(`lazy: removed ${n} old chunks from Cache Storage`);
        } catch (e) { /* ignore */ }
      }
      // One pack: a stream of whole chunks in pk.ids order. Each chunk is checked (sha256), put in Cache Storage
      // and given to Hercules as soon as its last byte is in.
      const giveBack = (ids) => { const back = ids.filter((id) => !queue.includes(id)); queue.splice(pq, 0, ...back); };
      async function runPack(pk) {
        let mine = null; const filled = pk.ids.map(() => false);
        try {
          if (cache) {
            const hit = await Promise.all(pk.ids.map((id) => cache.match(url(`c/${manifest.chunks[id][0]}`)).then((r) => !!r, () => false)));
            if (hit.every(Boolean)) { packStat.skipped++; giveBack(pk.ids); return; }
          }
          mine = pk.ids.map((id) => _hw_lazy_claim(id) === 1);
          const offs = []; let o2 = 0; for (const id of pk.ids) { offs.push(o2); o2 += manifest.chunks[id][1]; }
          const a = { pk, mine, filled, offs, k: 0, got: 0 }; active.push(a);
          const r = await fetch(url(pk.file), { credentials: 'same-origin' });
          if (!r.ok) throw new Error(`GET ${pk.file}: HTTP ${r.status}`);
          const rd = r.body.getReader();
          let k = 0, off = 0, cur = new Uint8Array(manifest.chunks[pk.ids[0]][1]);
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            packStat.bytes += value.length; a.got += value.length;
            for (let i = 0; i < value.length;) {
              if (k >= pk.ids.length) throw new Error(`${pk.file}: longer than its chunks`);
              const n = Math.min(value.length - i, cur.length - off);
              cur.set(value.subarray(i, i + n), off); off += n; i += n;
              if (off === cur.length) {
                const id = pk.ids[k];
                let use = mine[k];
                if (use && rescued.has(id)) { if (rescueFirst.delete(id)) { rescued.delete(id); use = false; } else packFirst.add(id); }
                if (use) {
                  const sha = manifest.chunks[id][0];
                  if (o.verify && await sha256(cur) !== sha) throw new Error(`${pk.file}: chunk ${id}: sha256 mismatch`);
                  getFile.put(url(`c/${sha}`), cur);
                  const p = _hw_lazy_fill_begin(id);
                  if (p) { HEAPU8.set(cur, p); _hw_lazy_fill_end(id, 0); } else { note(`lazy: no heap memory for chunk ${id}`); _hw_lazy_fail(id); }
                  packStat.chunks++;
                }
                filled[k] = true;
                k++; a.k = k; off = 0;
                if (k < pk.ids.length) cur = new Uint8Array(manifest.chunks[pk.ids[k]][1]);
              }
            }
          }
          if (k !== pk.ids.length) throw new Error(`${pk.file}: ${k} of ${pk.ids.length} chunks`);
          packStat.read++;
        } catch (e) {
          errors++; packStat.failed++; note(`lazy: pack ${pk.file}: ${e && e.message || e}; the rest of it goes chunk by chunk`);
          if (mine) pk.ids.forEach((id, k) => { if (mine[k] && !filled[k] && !rescued.has(id)) load(id, false); });
          else giveBack(pk.ids);
        } finally {
          const i = active.findIndex((x) => x.pk === pk); if (i >= 0) active.splice(i, 1);
          packsLeft--; pump();
        }
      }
      for (const pk of packs) runPack(pk);
      const bc = new BroadcastChannel(chan);
      bc.onmessage = () => pump();
      setInterval(pump, o.pollMs);
      pump();
      if (o.prefetchWait) await bootPromise;
      return { metaMs, bootChunks: boot.length, bootTotal };
    },
  },
});
