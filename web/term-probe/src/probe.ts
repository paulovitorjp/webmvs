/**
 * Terminal probe: athornton/tn3270 in a browser page, talking to native Hercules
 * through websockify (binary WebSocket <-> TCP). The tn3270 Session runs IN the page with an
 * injected Connection; the vendored canvas renderer.ts is used unmodified through the same
 * four-function window.tn3270 bridge that the upstream Electron GUI and web gateway provide.
 *
 * Query parameters:
 *   ws    WebSocket URL (default ws://<page host>:8081/ - websockify on the build host)
 *   type  telnet TERMINAL-TYPE (default IBM-3278-2; use IBM-3278-2@0010 style for a device)
 * TN3270E is always off (Hercules does not do TN3270E).
 */
import { Session, resolve, cp037 } from '@tn3270/core';
import { drawList, type DrawList } from '../../vendor/tn3270/packages/canvas/src/drawlist.js';
import { blankColumns } from '../../vendor/tn3270/packages/canvas/src/blit.js';
import { parseBdf } from '../../vendor/tn3270/packages/canvas/src/bdf.js';
import type { AtlasGeometry } from '../../vendor/tn3270/packages/canvas/src/geometry.js';
import { applyAction, resolveScheme, type Action } from '@tn3270/frontend';

const params = new URLSearchParams(location.search);
const wsUrl = params.get('ws') ?? `ws://${location.hostname}:8081/`;
const terminalType = params.get('type') ?? 'IBM-3278-2';

const status = (s: string): void => {
  const el = document.getElementById('status');
  if (el) el.textContent = s;
  (window as unknown as { probeStatus: string }).probeStatus = s;
};

/** A Connection over a binary WebSocket to websockify. Resolves when the socket is open. */
function wsConnect(url: string): Promise<import('@tn3270/core').Connection> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url, ['binary']);
    ws.binaryType = 'arraybuffer';
    const conn: import('@tn3270/core').Connection = {
      write: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); },
      close: () => { ws.close(); },
      onData: undefined, onClose: undefined, onError: undefined,
    };
    let opened = false;
    ws.onopen = () => { opened = true; ok(conn); };
    ws.onmessage = (e) => { conn.onData?.(new Uint8Array(e.data as ArrayBuffer)); };
    ws.onerror = () => { if (!opened) fail(new Error(`WebSocket error: ${url}`)); else conn.onError?.(new Error('WebSocket error')); };
    ws.onclose = () => { if (!opened) fail(new Error(`WebSocket closed before open: ${url}`)); else conn.onClose?.(); };
  });
}

/** Bake the atlas in the page, exactly as canvas/scripts/build-atlas.mjs does at build time. */
async function loadAtlas(): Promise<{ geometry: AtlasGeometry; coverage: Uint8Array; blank: number[] }> {
  const font = parseBdf(await (await fetch('./3270.bdf')).text());
  const codes = [...font.glyphs.keys()].sort((a, b) => a - b);
  const index: Record<number, number> = {};
  codes.forEach((c, i) => { index[c] = i; });
  const cols = codes.length;
  const stride = cols * font.width;
  const coverage = new Uint8Array(stride * font.height);
  codes.forEach((code, i) => {
    const g = font.glyphs.get(code)!;
    for (let y = 0; y < font.height; y++) {
      const row = g.rows[y]!;
      for (let x = 0; x < font.width; x++) coverage[y * stride + i * font.width + x] = row[x] ? 255 : 0;
    }
  });
  const geometry = { cellWidth: font.width, cellHeight: font.height, cols, index } as unknown as AtlasGeometry;
  return { geometry, coverage, blank: [...blankColumns(coverage, geometry)] };
}

async function main(): Promise<void> {
  const atlas = await loadAtlas();
  const scheme = resolveScheme();
  const session = new Session({ connect: () => wsConnect(wsUrl), terminalType, tn3270e: false });

  // The four-function bridge renderer.ts expects (see vendor .../web/src/bridgecore.ts).
  let onFrame: ((l: DrawList) => void) | undefined;
  let onErr: ((m: string) => void) | undefined;
  const frame = (): void => {
    const snap = session.screen.snapshot();
    const oia = session.oia.toText();
    onFrame?.(drawList(snap, resolve(snap), atlas.geometry, scheme, oia === '' ? undefined : oia));
  };
  (window as unknown as { tn3270: unknown }).tn3270 = {
    onAtlas: (fn: (a: unknown) => void) => { fn(atlas); },
    onFrame: (fn: (l: DrawList) => void) => { onFrame = fn; frame(); },
    onError: (fn: (m: string) => void) => { onErr = fn; },
    sendAction: (a: Action) => {
      if (a.kind === 'quit') { session.disconnect(); return; }
      if (a.kind === 'toggleKeypad') return;
      applyAction(session, a);
      frame();
    },
  };
  await import('../../vendor/tn3270/packages/canvas/src/renderer.js');

  // Test hooks for the headless check (scripts/term-probe-shot.mjs).
  Object.assign(window, {
    probe: {
      session,
      /** Screen as text rows; hidden (non-display) fields are blanked. */
      text: (): string => {
        const snap = session.screen.snapshot();
        const r = resolve(snap);
        const rows: string[] = [];
        for (let y = 0; y < snap.rows; y++) {
          rows.push(r.slice(y * snap.cols, (y + 1) * snap.cols).map((c) => (c.hidden ? ' ' : c.text)).join(''));
        }
        return rows.join('\n');
      },
      oia: (): string => session.oia.toText(),
      cp037,
    },
  });

  session.on('screen', frame);
  session.on('connect', () => { status(`connected ${wsUrl} as ${terminalType}`); frame(); });
  session.on('disconnect', () => { status('disconnected'); frame(); });
  status(`connecting ${wsUrl} as ${terminalType}`);
  try {
    // host/port are informational here: the injected connect() ignores them.
    await session.connect('websockify', 0, { tn3270e: false });
    status(`connected ${wsUrl} as ${terminalType}`);
  } catch (e) {
    status(`connect failed: ${String(e)}`);
    onErr?.(String(e));
  }
}

void main();
