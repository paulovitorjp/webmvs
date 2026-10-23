// replay of the TSO password prompt race against the page's own TermView
// (web/app/src/termview.ts + the vendored @tn3270/core Session, no canvas). Run: node web/app/test/kbdhold-unit.mjs
// The records are the ones of the failed logon (trace build 0016, run T2-srf-16 iteration 4):
//   host EW  WCC X'C1' (no keyboard restore): the prompt text 'ENTER CURRENT PASSWORD FOR MVSCE02-', cursor set
//   (key typed here)
//   host W   WCC X'C3' (restore): SBA(row 2 col 1) SF X'4C' (non-display) IC
// Expected: the Read Modified of the Enter carries all 6 characters of the password.
import { TermView } from '../src/termview.ts';
import { cp037, type Connection } from '@tn3270/core';

const sent: Uint8Array[] = [];
const conn: Connection = { write: (b: Uint8Array) => { sent.push(b.slice()); }, close: () => {}, onData: undefined, onClose: undefined, onError: undefined };
const host = { appendChild: () => {}, clientWidth: 800, clientHeight: 600 } as unknown as HTMLElement;
const view = new TermView(host, { geometry: {}, coverage: new Uint8Array(0), blank: new Set() } as never, { terminalType: 'IBM-3278-2-E', connect: async () => conn });
await view.connect();
const exec = (b: number[]): void => (view.session as unknown as { executeRecord: (x: Uint8Array, w: unknown) => void }).executeRecord(Uint8Array.from(b), null);
const e = (s: string): number[] => [...s].map((c) => cp037.fromUnicode(c));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const variant = process.env.VARIANT ?? 'ic80';

// the screen after 'LOGON MVSCE02': EW WCC C3 blank (keyboard unlocked)
exec([0xf5, 0xc3, 0x11, 0x5d, 0x7f, 0x1d, 0x40, 0x11, 0x40, 0x40, 0x13]);
// Read Partition Query: the page answers, enter-inhibit
exec([0xf3, 0x00, 0x05, 0x01, 0xff, 0x02]);
const kb0 = view.session.oia.keyboard;
// prompt: EW WCC C1, SBA 1919 SF 40, SBA 0 SF C8 + text, then (variant) SBA 80 [SF 40] IC
const tail = variant === 'ic80' ? [0x11, 0xc1, 0x50, 0x13] : [0x11, 0xc1, 0x50, 0x1d, 0x40, 0x13];
exec([0xf5, 0xc1, 0x11, 0x5d, 0x7f, 0x1d, 0x40, 0x11, 0x40, 0x40, 0x1d, 0xc8, ...e('ENTER CURRENT PASSWORD FOR MVSCE02-'), ...tail]);
const unlockedBetween = view.unlocked();
view.action({ kind: 'type', text: 'P' });      // the first key, typed between the two records
await tick();
exec([0xf1, 0xc3, 0x11, 0xc1, 0x50, 0x1d, 0x4c, 0x13]);
await tick();
for (const c of 'ASS4U') { view.action({ kind: 'type', text: c }); await tick(); }
view.action({ kind: 'enter' } as never);
await tick();
// the last data write is the Read Modified: IAC-escaped telnet record; drop IAC EOR, take AID, cursor, SBA, data
const all = sent.map((b) => [...b]).filter((b) => b[0] === 0x7d);
const rm = all.pop() ?? [];
const body = rm.slice(0, rm.length - 2);
const data = body.slice(6);
const text = data.map((x) => cp037.toUnicode(x)).join('');
console.log(JSON.stringify({ variant, kbdhold: process.env.Q ?? '', keyboardAfterQuery: kb0, unlockedBetween, sentBytes: body.length, password: text.replace(/./g, '*'), chars: text.length, ok: text === 'PASS4U', typeahead: view.ahead_(), log: view.kbdlog.map((x) => `${x.ev} ${x.d ?? ''}`.slice(0, 70)) }));
process.exit(text === 'PASS4U' ? 0 : 1);
