// SPDX-License-Identifier: Apache-2.0
/**
 * Browser keyboard -> 3270 action (docs/RESEARCH.md 3.5 keyboard map).
 *
 *   Enter = Enter            Esc = Clear              F1-F12 = PF1-PF12
 *   Shift+F1-F12 = PF13-PF24 (F13-F24 too)            Ctrl+1/2/3 = PA1/PA2/PA3 (Alt+1/2/3 too)
 *   Ctrl+R = Reset           End = Erase EOF          Ctrl+U = Erase Input
 *   Tab / Shift+Tab = field tab, arrows, Home, Backspace, Delete, Insert = local edit keys
 * Unknown keys return null (the browser keeps them: Ctrl+C copy, Ctrl+V paste, Cmd+... menus).
 */
import type { Action } from '@tn3270/frontend';

const NAMED: Record<string, Action> = {
  Enter: { kind: 'enter' }, Escape: { kind: 'clear' },
  ArrowLeft: { kind: 'left' }, ArrowRight: { kind: 'right' }, ArrowUp: { kind: 'up' }, ArrowDown: { kind: 'down' },
  Home: { kind: 'home' }, End: { kind: 'eraseEOF' }, Backspace: { kind: 'backspace' }, Delete: { kind: 'delete' },
  Insert: { kind: 'toggleInsert' },
};
const PA: Record<string, number> = { Digit1: 1, Digit2: 2, Digit3: 3, Numpad1: 1, Numpad2: 2, Numpad3: 3 };

export function actionForKey(e: KeyboardEvent): Action | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'NumLock', 'ScrollLock', 'Dead', 'Process', 'Unidentified'].includes(e.key)) return null;
  if (e.isComposing) return null;
  const fn = /^F(\d{1,2})$/.exec(e.key);
  if (fn && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const n = Number(fn[1]);
    if (n >= 1 && n <= 12) return { kind: 'pf', n: e.shiftKey ? n + 12 : n };
    if (n >= 13 && n <= 24) return { kind: 'pf', n };
    return null;
  }
  if ((e.ctrlKey || e.altKey) && !e.metaKey && PA[e.code] !== undefined) return { kind: 'pa', n: PA[e.code]! };
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'r') return { kind: 'reset' };
    if (k === 'u') return { kind: 'eraseInput' };
    if (k === 'a') return { kind: 'attn' };
    if (k === 'enter') return { kind: 'newline' };
    return null;
  }
  if (e.metaKey || e.altKey) return null;
  if (e.key === 'Tab') return e.shiftKey ? { kind: 'backTab' } : { kind: 'tab' };
  const named = NAMED[e.key];
  if (named) return named;
  if ([...e.key].length === 1) return { kind: 'type', text: e.key };
  return null;
}

/** On-screen AID keypad (mobile and mouse users). */
export interface PadKey { label: string; action: Action; wide?: boolean }
export const PAD_MAIN: PadKey[] = [
  { label: 'Enter', action: { kind: 'enter' }, wide: true },
  { label: 'Clear', action: { kind: 'clear' } },
  { label: 'PA1', action: { kind: 'pa', n: 1 } },
  { label: 'PA2', action: { kind: 'pa', n: 2 } },
  { label: 'PA3', action: { kind: 'pa', n: 3 } },
  { label: 'Reset', action: { kind: 'reset' } },
  { label: 'Tab', action: { kind: 'tab' } },
  { label: 'BkTab', action: { kind: 'backTab' } },
  { label: 'ErEOF', action: { kind: 'eraseEOF' } },
  { label: 'Home', action: { kind: 'home' } },
  { label: '←', action: { kind: 'left' } },
  { label: '→', action: { kind: 'right' } },
  { label: '↑', action: { kind: 'up' } },
  { label: '↓', action: { kind: 'down' } },
];
export const PAD_PF: PadKey[] = Array.from({ length: 24 }, (_, i) => ({ label: `PF${i + 1}`, action: { kind: 'pf', n: i + 1 } as Action }));
