// SPDX-License-Identifier: Apache-2.0
// inpage-cpuloop.js -- TEST ONLY (never in a bundle that is published).
// scripts/realff.sh injects this file into a COPY of a bundle (<script src="./inpage-cpuloop.js"> after app.js), so
// that a browser that Playwright cannot drive (an official Firefox release) runs the CPU benchmark by itself:
// wait for IKT007I, log on as MVSCE02 on the TSO tab (window.mvs.type/act, the page's own test API), write the
// 1.2e9-instruction CPU loop (= bench/mips/cpuloop.jcl, the soak.mjs busy job) with TSO EDIT, submit it, and wait
// for the job end. Results go to the server log as 404 paths ./__probe/<key>/<value> (pages-emu.mjs --log):
// start (user agent), IKT007I (ms after navigation), ready, edited, submitted, job (the IEFACTRT lines: the GO
// step CPU time is the benchmark), done; error on a failure.
(() => {
  const send = (k, v) => fetch(`./__probe/${k}/${encodeURIComponent(String(v)).slice(0, 900)}`).catch(() => {});
  const JCL = [
  '//MVSCE02A JOB (1),\'SOAK LOOP\',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1),',
  '//             TIME=1440',
  '//STEP1    EXEC ASMFCLG,TIME.GO=1440',
  '//ASM.SYSPUNCH DD DUMMY',
  '//ASM.SYSIN DD *',
  'CPULOOP  CSECT',
  '         STM   14,12,12(13)',
  '         BALR  12,0',
  '         USING *,12',
  '         L     5,COUNT',
  'OUTER    LA    6,100',
  'INNER    L     2,VALA',
  '         A     2,VALB',
  '         ST    2,VALC',
  '         MVC   FLDD(16),FLDE',
  '         CLC   FLDD(16),FLDE',
  '         SR    3,3',
  '         IC    3,VALC+3',
  '         SLL   3,2',
  '         N     3,MASK',
  '         LR    4,3',
  '         AR    4,2',
  '         BCT   6,INNER',
  '         BCT   5,OUTER',
  '         LM    14,12,12(13)',
  '         SR    15,15',
  '         BR    14',
  `COUNT    DC    F'1000000'`,
  "VALA     DC    F'1'",
  "VALB     DC    F'3'",
  "VALC     DC    F'0'",
  "MASK     DC    F'255'",
  '         DS    0F',
  'FLDD     DS    CL16',
  "FLDE     DC    CL16'ABCDEFGHIJKLMNOP'",
  '         END   CPULOOP',
  '/*',
  '//',
  ];
  const M = () => window.mvs; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = () => M().text('tso1'); const unl = () => M().unlocked('tso1');
  const enter = () => M().act('tso1', { kind: 'enter' });
  async function waitT(re, ms, w) { const e = performance.now() + ms; while (performance.now() < e) { try { if (re.test(txt())) return txt(); } catch {} await sleep(200); } throw new Error(`timeout ${w}`); }
  async function waitU(ms = 120000) { const e = performance.now() + ms; while (performance.now() < e) { if (unl()) return; await sleep(50); } throw new Error('locked'); }
  async function line(s) { await waitU(); M().type('tso1', s); enter(); await sleep(250); }
  const lastL = (t) => { const l = t.split('\n').map((x) => x.trim()).filter((x) => x); return [l[l.length - 1] || '', l[l.length - 2] || '']; };
  async function waitLast(re, ms, w) {
    const e = performance.now() + ms;
    for (;;) {
      const [a, b] = lastL(txt());
      if (unl() && re.test(a)) return;
      if (unl() && a === '***') { enter(); await sleep(500); if (re.test(b)) return; continue; }
      if (performance.now() > e) throw new Error(`timeout ${w} (${b} | ${a})`);
      await sleep(100);
    }
  }
  const hl = () => [...(M()?.herclog?.() ?? []).map(([, l]) => l), ...(M()?.seen?.() ?? []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))];
  (async () => {
    try {
      send('start', `${navigator.userAgent} coi=${self.crossOriginIsolated}`);
      for (;;) { if (hl().some((l) => l.includes('IKT007I'))) break; await sleep(200); }
      send('IKT007I', performance.now().toFixed(0));
      let t = await waitT(/CLEAR the screen or hit ENTER|TSO Logon ===>|LOGON/, 90000, 'logon screen');
      if (!/TSO Logon ===>/.test(t)) { await waitU(); enter(); await waitT(/TSO Logon ===>/, 60000, 'TSO Logon'); }
      await sleep(500); await line('logon mvsce02');
      await waitT(/ENTER CURRENT PASSWORD FOR MVSCE02/, 60000, 'password'); await line('PASS4U');
      for (let i = 0; ; i++) { t = await waitT(/\*\*\*\s*$|READY\s*$/m, 120000, 'READY'); if (/READY\s*$/m.test(t)) break; await waitU(); enter(); await sleep(300); if (i > 20) throw new Error('no READY'); }
      send('ready', performance.now().toFixed(0));
      await line(`delete 'mvsce02.clist(cpuloop)'`); await waitLast(/^READY$/, 60000, 'delete');
      M().act('tso1', { kind: 'reset' }); await sleep(300);
      await line(`edit 'mvsce02.clist(cpuloop)' new data`); await waitLast(/^\d{5}$/, 60000, 'EDIT INPUT');
      let n = 10;
      for (const l of JCL) { await waitLast(new RegExp(`^${String(n).padStart(5, '0')}$`), 30000, `line ${n}`); M().type('tso1', l); enter(); n += 10; await sleep(100); }
      await waitLast(new RegExp(`^${String(n).padStart(5, '0')}$`), 30000, `line ${n}`); enter();
      await waitLast(/^EDIT$/, 30000, 'EDIT mode'); await line('save'); await sleep(500); await waitLast(/^EDIT$/, 60000, 'SAVE');
      await line('end'); await sleep(1500); await waitLast(/^READY$/, 60000, 'READY after END');
      send('edited', performance.now().toFixed(0));
      await line(`submit 'mvsce02.clist(cpuloop)'`); await waitLast(/^READY$/, 60000, 'submit');
      send('submitted', performance.now().toFixed(0));
      const e = performance.now() + 900000;
      for (;;) {
        const a = hl().filter((l) => /IEFACTRT|IEF450I|HASP395 MVSCE02A/.test(l) && /MVSCE02A/.test(l));
        if (a.some((l) => /HASP395|IEF450I/.test(l)) || performance.now() > e) { send('job', a.join(' | ')); break; }
        await sleep(1000);
      }
    } catch (err) { send('error', `${err} | ${lastL(txt()).join(' / ')}`); }
    send('done', performance.now().toFixed(0));
  })();
})();
