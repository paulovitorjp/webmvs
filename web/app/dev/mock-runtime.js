// Dev-only stand-in for the wasm runtime module (tests the ?backend=wasm code path of the page
// against NATIVE Hercules). It implements exactly the integration contract in src/machine.ts:
//   export async function createRuntime({ onProgress, debug }) -> { openTerminal, ipl, command, onLog }
// openTerminal() returns the RawTerminal shape {write(Uint8Array), onData(cb), onClose(cb), close()},
// here over websockify instead of hw_term_*; ipl/command/onLog use the dev server API.
export async function createRuntime({ onProgress }) {
  const total = 83479361;   // the 7-volume web set, to exercise the progress bar
  for (let i = 1; i <= 10; i++) { onProgress({ phase: 'download', loaded: (total * i) / 10, total, detail: 'mock' }); await new Promise((r) => setTimeout(r, 60)); }
  onProgress({ phase: 'prepare', detail: 'mock' });
  onProgress({ phase: 'start', detail: 'mock runtime' });
  const ws = `ws://${location.hostname}:8213/`;
  let off = -1;
  const logCbs = [];
  return {
    openTerminal() {
      return new Promise((ok, fail) => {
        const s = new WebSocket(ws, ['binary']); s.binaryType = 'arraybuffer';
        let dataCb, closeCb; const early = [];
        s.onopen = () => ok({
          write: (b) => s.send(b.slice()),
          onData: (cb) => { dataCb = cb; early.splice(0).forEach(cb); },
          onClose: (cb) => { closeCb = cb; },
          close: () => s.close(),
        });
        s.onmessage = (e) => { const b = new Uint8Array(e.data); if (dataCb) dataCb(b); else early.push(b); };
        s.onerror = () => fail(new Error('mock runtime: websocket error'));
        s.onclose = () => closeCb?.();
      });
    },
    async ipl() { await fetch('/dev/cmd', { method: 'POST', body: 'ipl 150' }); },
    async command(c) { await fetch(c === 'quit' ? '/dev/quit' : '/dev/cmd', { method: 'POST', body: c }); },
    onLog(cb) {
      logCbs.push(cb);
      if (logCbs.length > 1) return;
      setInterval(async () => {
        const r = await fetch(`/dev/log?off=${off}`, { cache: 'no-store' });
        const first = off < 0; off = Number(r.headers.get('X-Log-Next')); const t = await r.text();
        if (!first) for (const l of t.split('\n')) if (l) logCbs.forEach((f) => f(l));
      }, 700);
    },
  };
}
