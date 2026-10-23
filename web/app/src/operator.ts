// SPDX-License-Identifier: Apache-2.0
/**
 * The page as MVS operator on the 0010 master console (design decision):
 *  - 0010 is connected BEFORE the IPL, so it becomes the NIP console and the visitor sees NIP.
 *  - IEA101A SPECIFY SYSTEM PARAMETERS arrives on 0010; the page answers it with ENTER like an
 *    operator (the 009 HAO rule "hao tgt input for console 0:0009" stays in the rc as a fallback,
 *    for the case where IEA101A goes to 009).
 *  - When the MVS console format comes up (IEE152I PFK line / IEE159E), the page sets roll mode
 *    (K S,DEL=R,...), otherwise the screen holds at IEE159E MESSAGE WAITING and IKT007I is never shown.
 *  - IKT007I TCAS ACCEPTING LOGONS (on 0010, or earlier in the Hercules log) -> onTsoReady (the page
 *    connects the TSO terminal). IKT007I on the 0010 screen -> onConsoleReady (the page selects the TSO
 *    tab a short time after that, so the visitor sees the end of the IPL on the Console tab).
 *  - $HASP426 fallback reply if the 009 HAO rule did not answer it.
 *  - shutdown(): the stock MVS/CE shutdown sequence, typed on the master console.
 */
import type { TermView } from './termview.js';

export const ROLL_CMD = new URLSearchParams(location.search).get('roll') ?? 'K S,DEL=R,RNUM=19,RTME=1';

const IKT_DELAY = Number(new URLSearchParams(location.search).get('iktdelay') ?? 0) || 0;

export interface OperatorEvent { t: number; what: string }

/**
 * How many distinct console lines the page keeps (a long soak test showed that the list grew for the life of the page,
 * about 1,700 lines an hour with short batch jobs). The 0010 screen shows 24 lines, so a line that rolled off
 * the window long ago can not still be on the screen. Older lines are dropped in steps of SEEN_DROP.
 */
const SEEN_MAX = 4000;
const SEEN_DROP = 500;

export class ConsoleOperator {
  /** The newest distinct console lines (at most SEEN_MAX + SEEN_DROP), oldest first; seenBase = absolute index of seen[0]. */
  readonly seen: string[] = [];
  seenBase = 0;
  private seenSet = new Set<string>();
  /** Number of distinct lines seen since the IPL started (absolute index of the next line). */
  get seenTotal(): number { return this.seenBase + this.seen.length; }
  /** Lines with an absolute index >= from (lines that were dropped from the window are not returned). */
  seenSince(from: number): string[] { return this.seen.slice(Math.max(0, from - this.seenBase)); }
  readonly events: OperatorEvent[] = [];
  iea101a: 'none' | 'seen' | 'page' = 'none';
  rollSent = 0;
  private rollAt = 0;
  tsoReadyAt = 0;
  /** performance.now() when IKT007I was first seen on the 0010 screen (0 = not yet). */
  consoleIktAt = 0;
  private consoleReadyCbs: (() => void)[] = [];
  private hasp426Seen = 0;
  private hasp426Replied = false;
  private timer: number | undefined;
  private readyCbs: (() => void)[] = [];
  private lineCbs: ((l: string) => void)[] = [];
  enabled = true;
  t0 = performance.now();

  constructor(readonly view: TermView, private readonly log: (s: string) => void) {
    view.onScreen(() => this.schedule());
  }

  /**
   * the machine is resumed from a snapshot, not IPLed. Put the saved console lines back
   * (the restored 0010 screen shows only the last 24 lines; these are the lines before them) and switch the IPL
   * automation off: MVS is already up (IEA101A answered, roll mode set, TSO accepting logons).
   */
  resumed(history: string[]): void {
    for (const raw of history) {
      const l = String(raw).trimEnd();
      if (!l.trim() || this.seenSet.has(l)) continue;
      this.seenSet.add(l); this.seen.push(l);
    }
    if (this.seen.length > SEEN_MAX) { const d = this.seen.splice(0, this.seen.length - SEEN_MAX); for (const x of d) this.seenSet.delete(x); this.seenBase += d.length; }
    this.restoredLines = this.seen.length;
    this.iea101a = 'page'; this.rollSent = 1; this.rollAt = performance.now();
    this.tsoReadyAt = performance.now(); this.consoleIktAt = performance.now();
    this.note(`resumed from a snapshot: ${this.restoredLines} console lines restored`);
  }
  restoredLines = 0;

  onTsoReady(cb: () => void): void { this.readyCbs.push(cb); }
  /** IKT007I is visible on the 0010 screen (roll mode shows it some seconds after the Hercules log). */
  onConsoleReady(cb: () => void): void { if (this.consoleIktAt) cb(); else this.consoleReadyCbs.push(cb); }
  onLine(cb: (l: string) => void): void { this.lineCbs.push(cb); }
  private note(what: string): void {
    const t = Math.round(performance.now() - this.t0);
    this.events.push({ t, what });
    this.log(`[operator +${(t / 1000).toFixed(1)}s] ${what}`);
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => { this.timer = undefined; this.check(); }, 60);
  }

  /** Lines seen, newest last, matching re. */
  find(re: RegExp): string | undefined { for (let i = this.seen.length - 1; i >= 0; i--) if (re.test(this.seen[i]!)) return this.seen[i]; return undefined; }

  /** Feed a line from another source (Hercules log), e.g. for IKT007I when the console is not available. */
  external(line: string): void {
    // IKT007I reaches the Hercules log first; in roll mode (RTME=1) the 0010 screen shows it only
    // 3-7 s later (measured: Chromium 5 s, WebKit over 5 s). So the page opens TSO at the first
    // IKT007I from either source. ?iktdelay=<ms> delays the log source (5000 was an earlier default).
    if (/IKT007I/.test(line) && !this.tsoReadyAt) window.setTimeout(() => this.tsoReady(IKT_DELAY ? `Hercules log, ${IKT_DELAY / 1000} s fallback` : 'Hercules log'), IKT_DELAY);
  }

  private tsoReady(src: string): void {
    if (this.tsoReadyAt) return;
    this.tsoReadyAt = performance.now();
    this.note(`IKT007I seen (${src}), TSO ready`);
    for (const cb of this.readyCbs) cb();
  }

  check(): void {
    const text = this.view.text();
    for (const raw of text.split('\n')) {
      const l = raw.trimEnd();
      if (l.trim() === '' || this.seenSet.has(l)) continue;
      this.seenSet.add(l); this.seen.push(l);
      if (this.seen.length > SEEN_MAX + SEEN_DROP) {
        for (const d of this.seen.splice(0, SEEN_DROP)) this.seenSet.delete(d);
        this.seenBase += SEEN_DROP;
      }
      for (const cb of this.lineCbs) cb(l);
    }
    if (!this.enabled) return;
    const now = performance.now();

    if (this.iea101a === 'none' && /IEA101A SPECIFY SYSTEM PARAMETERS/.test(text)) {
      this.iea101a = 'seen';
      this.note('IEA101A on 0010');
      const tryReply = (n: number): void => {
        if (this.view.unlocked()) {
          this.view.action({ kind: 'enter' });
          this.iea101a = 'page';
          this.note('IEA101A answered with ENTER on 0010');
        } else if (n < 50) window.setTimeout(() => tryReply(n + 1), 100);
        else this.note('IEA101A: keyboard stayed locked, no reply sent');
      };
      window.setTimeout(() => tryReply(0), 300);
    }

    // IEA305A INVALID REPLY FORMAT after the page's IEA101A reply: keys that the visitor (or a test)
    // typed on the Console tab during NIP went out with the page's Enter, and NIP waits for a new reply (before: the
    // IPL stopped there, 'no IKT007I within 180 s'). The host's IEA305A write resets the modified field, so a plain
    // Enter is the empty reply again (Erase Input / Erase EOF + Enter were tested: MVS answers IEA305A to those too).
    const n305 = (text.match(/IEA305A INVALID REPLY FORMAT/g) ?? []).length;
    if (this.iea101a === 'page' && n305 > this.iea305Seen && this.iea305Retries < 3) {
      this.iea305Seen = n305; this.iea305Retries++;
      const retry = (n: number): void => {
        if (this.view.unlocked()) { this.view.action({ kind: 'enter' }); this.note(`IEA305A: IEA101A answered again with ENTER on 0010 (${this.iea305Retries})`); }
        else if (n < 50) window.setTimeout(() => retry(n + 1), 100);
      };
      window.setTimeout(() => retry(0), 300);
    }

    const mvsConsole = /IEE152I|IEE159E MESSAGE WAITING/.test(text);
    if (mvsConsole && this.rollSent === 0) this.sendRoll();
    else if (this.rollSent > 0 && this.rollSent < 4 && /IEE159E MESSAGE WAITING/.test(text) && now - this.rollAt > 6000) this.sendRoll();

    const h = /(?:^|\s)(\d{2}) \$HASP426 SPECIFY OPTIONS/m.exec(text);
    if (h && !this.hasp426Replied) {
      if (!this.hasp426Seen) this.hasp426Seen = now;
      else if (now - this.hasp426Seen > 8000 && !this.find(/\$HASP493|IEE600I REPLY TO/)) {
        if (this.view.typeCommand(`R ${h[1]},NOREQ`)) { this.hasp426Replied = true; this.note(`$HASP426 fallback reply R ${h[1]},NOREQ`); }
      }
      window.setTimeout(() => this.schedule(), 1000);
    }

    if (/IKT007I TCAS ACCEPTING LOGONS/.test(text)) {
      this.tsoReady('console 0010');
      if (!this.consoleIktAt) {
        this.consoleIktAt = now;
        this.note('IKT007I on the 0010 screen');
        for (const cb of this.consoleReadyCbs.splice(0)) cb();
      }
    }

    // Shutdown helper: IKT010D (users still logged on) -> FSTOP.
    // (an action message: '*00 IKT010D ...'; an older pattern needed a blank before the reply number)
    const k = /(?:^|\s)\*?(\d{2}) IKT010D/m.exec(text);
    if (k && this.shuttingDown && !this.ikt010Replied.has(k[1]!)) {
      if (this.view.typeCommand(`R ${k[1]},FSTOP`)) { this.ikt010Replied.add(k[1]!); this.note(`IKT010D reply R ${k[1]},FSTOP`); }
    }
  }

  private iea305Seen = 0;
  private iea305Retries = 0;
  private sendRoll(): void {
    const ok = this.view.typeCommand(ROLL_CMD);
    if (ok) { this.rollSent++; this.rollAt = performance.now(); this.note(`console roll mode: ${ROLL_CMD}`); }
    else window.setTimeout(() => this.schedule(), 300);
  }

  // ---------------------------------------------------------------- shutdown (on the master console)
  shuttingDown = false;
  private ikt010Replied = new Set<string>();

  private sleep(ms: number): Promise<void> { return new Promise((r) => window.setTimeout(r, ms)); }
  private async waitFor(re: RegExp, ms: number, since: number): Promise<boolean> {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      this.check();
      for (let i = Math.max(0, since - this.seenBase); i < this.seen.length; i++) if (re.test(this.seen[i]!)) return true;
      await this.sleep(250);
    }
    return false;
  }
  private async type(cmd: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (this.view.typeCommand(cmd)) { this.note(`shutdown: ${cmd}`); return; }
      await this.sleep(150);
    }
    throw new Error(`console keyboard locked, could not type ${cmd}`);
  }

  /**
   * MVS/CE SCRIPTS/SHUTDOWN.RC, typed on 0010. Resolves after IEE334I + QUIESCE; the caller then
   * waits for the disabled wait (HHC00809I in the Hercules log, if it has one) and powers off.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const mark = (): number => this.seenTotal;
    await this.type('$CA,ALL'); await this.sleep(1000);
    await this.type('SWITCH SMF'); await this.sleep(1500);
    await this.type('F TSO,USERMAX=0'); await this.sleep(1500);
    await this.type('$PI'); await this.sleep(1500);
    for (const d of ['PRT1', 'PRT2', 'PRT3', 'PUNCH1', 'RDR1', 'RDR2']) { await this.type(`$P ${d}`); await this.sleep(400); }
    await this.sleep(1500);
    let m = mark();
    await this.type('P TSO');
    if (!await this.waitFor(/IKT006I/, 30000, m)) this.note('shutdown: no IKT006I within 30 s, continuing');
    m = mark();
    await this.type('Z NET,QUICK');
    if (!await this.waitFor(/IST102I/, 30000, m)) this.note('shutdown: no IST102I within 30 s, continuing');
    if (!await this.waitFor(/\$HASP099/, 30000, 0)) this.note('shutdown: no $HASP099 within 30 s, continuing');
    m = mark();
    await this.type('$PJES2');
    if (!await this.waitFor(/\$HASP085/, 30000, m)) throw new Error('shutdown: JES2 did not end ($HASP085)');
    m = mark();
    await this.type('Z EOD');
    if (!await this.waitFor(/IEE334I/, 30000, m)) throw new Error('shutdown: no IEE334I HALT EOD SUCCESSFUL');
    await this.sleep(1000);
    await this.type('QUIESCE');
  }
}
