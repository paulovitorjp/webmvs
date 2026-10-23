#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""TSO response times on a NATIVE Hercules, idle and while a CPU-bound batch job runs.

Question: in the browser, TSO commands are 25-30 times slower while the bench/mips/cpuloop.jcl job
runs (Chromium: `status` 7.1 s against 0.26 s idle). Is that MVS (SRM / dispatching with NUMCPU 1) or the wasm build?
This logs on with s3270, runs a list of commands N times and records the time from Enter to the keyboard unlock with
READY on the screen. The caller submits the job between two phases (devinit of the card reader).

Usage: tso-load-probe.py <host:port> <out.json> [--phases idle:3,job:4] [--cmds 'time,status,listcat,lista st']
         [--job-cmd '<shell command that submits the job>'] [--job-log <Hercules log>]
         [--job-start-re RE] [--job-end-re RE] [--timeout 120]
  Logs on (MVSCE02 / PASS4U), then runs each phase: <name>:<rounds> x every command (Clear, type, Enter, wait for the
  keyboard unlock with READY on the screen; a '***' screen is paged with Enter). Phase 'job' first runs --job-cmd and
  waits until --job-start-re is in --job-log (job started), then 5 s. The JSON has every time, the medians, and if the
  job still ran at the end of the phase. Example: an internal (unpublished) test script (native Hercules, devinit 00c cpuloop.jcl).
"""
import argparse, json, re, statistics, subprocess, sys, time

ap = argparse.ArgumentParser()
ap.add_argument('target'); ap.add_argument('out')
ap.add_argument('--phases', default='idle:3')
ap.add_argument('--cmds', default='time,status,listcat,lista st')
ap.add_argument('--user', default='MVSCE02'); ap.add_argument('--password', default='PASS4U')
ap.add_argument('--job-cmd', default=None); ap.add_argument('--job-log', default=None)
ap.add_argument('--job-start-re', default=r'IEF403I CPULOOP|\$HASP373 CPULOOP')
ap.add_argument('--job-end-re', default=r'\$HASP395 CPULOOP')
ap.add_argument('--timeout', type=float, default=120)
ap.add_argument('--perform', default=None, help='log on with PERFORM(n)')
ap.add_argument('--display-cmd', default=None, help='shell command run once in the job phase (e.g. an MVS D A,L)')
a = ap.parse_args()

p = subprocess.Popen(['s3270', '-model', '3278-2'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
def act(cmd, to=60):
    p.stdin.write(cmd + '\n'); p.stdin.flush()
    data = []
    t_end = time.time() + to
    while time.time() < t_end:
        l = p.stdout.readline()
        if not l: break
        l = l.rstrip('\n')
        if l == 'ok': return True, data
        if l == 'error': return False, data
        if l.startswith('data: '): data.append(l[6:])
    return False, data
def screen():
    ok, d = act('Ascii()'); return '\n'.join(x.rstrip() for x in d)
def wait_screen(rx, to=60):
    end = time.time() + to
    while time.time() < end:
        act('Wait(1,Output)', 5)
        s = screen()
        if re.search(rx, s, re.M): return s
    raise SystemExit(f'timeout waiting for {rx!r}; screen:\n{screen()}')
def log(*x): print(f'{time.strftime("%H:%M:%S")}', *x, flush=True)

ok, d = act(f'Connect({a.target})', 30)
if not ok: raise SystemExit(f'connect failed {d}')
s = wait_screen(r'CLEAR the screen|TSO Logon|Logon', 30)
if 'TSO Logon ===>' not in s:
    act('Clear()'); act('Wait(5,Unlock)', 10); wait_screen(r'TSO Logon ===>', 30)
act(f'String("logon {a.user}' + (f' perform({a.perform})' if a.perform else '') + '")'); act('Enter()'); act('Wait(10,Unlock)', 15)
pw = False
for _ in range(60):
    s = wait_screen(r'ENTER CURRENT PASSWORD|READY *$|\*\*\* *$|IKJ56\d{3}[AI]', 60)
    if re.search(r'IN USE|REJECTED|NOT AUTHORIZED|IKJ56425I', s): raise SystemExit('logon rejected:\n' + s)
    if not pw and 'ENTER CURRENT PASSWORD' in s:
        act(f'String("{a.password}")'); act('Enter()'); act('Wait(10,Unlock)', 15); pw = True
    elif re.search(r'READY *$', s, re.M): break
    elif re.search(r'\*\*\* *$', s, re.M): act('Enter()'); act('Wait(10,Unlock)', 15)
log('logged on')

cmds = [c.strip() for c in a.cmds.split(',') if c.strip()]
res = {'target': a.target, 'phases': []}
def run_cmd(c):
    act('Clear()'); act('Wait(5,Unlock)', 10)
    act(f'String("{c}")')
    t0 = time.time(); act('Enter()')
    while True:
        act(f'Wait({int(a.timeout)},Unlock)', a.timeout + 5)
        s = screen()
        if re.search(r'\*\*\* *$', s, re.M): act('Enter()'); continue      # screen full: page on
        if re.search(r'READY *$', s, re.M): break
        if time.time() - t0 > a.timeout: break
        time.sleep(0.05)
    return round(time.time() - t0, 3), s
def job_running():
    if not a.job_log: return None
    txt = open(a.job_log, errors='replace').read()
    return bool(re.search(a.job_start_re, txt)) and not re.search(a.job_end_re, txt)
for spec in a.phases.split(','):
    name, rounds = spec.split(':'); rounds = int(rounds)
    ph = {'name': name, 'times': {c: [] for c in cmds}, 'jobRunningAtEnd': None}
    if name == 'job':
        if a.job_cmd: subprocess.run(a.job_cmd, shell=True, check=True); log('job submitted')
        end = time.time() + 300
        while a.job_log and time.time() < end:
            if re.search(a.job_start_re, open(a.job_log, errors='replace').read()): break
            time.sleep(0.5)
        log('job started'); time.sleep(5)
        if a.display_cmd: subprocess.run(a.display_cmd, shell=True)
    for r in range(rounds):
        for c in cmds:
            t, s = run_cmd(c)
            ph['times'][c].append(t)
            log(f'{name} round {r + 1} {c!r}: {t:.2f} s  job running: {job_running()}')
    ph['jobRunningAtEnd'] = job_running()
    ph['median'] = {c: statistics.median(v) for c, v in ph['times'].items()}
    res['phases'].append(ph)
act('Clear()'); act('String("logoff")'); act('Enter()'); time.sleep(2)
act('Disconnect()'); act('Quit()')
json.dump(res, open(a.out, 'w'), indent=1)
for ph in res['phases']:
    print('SUMMARY', ph['name'], ' '.join(f'{c}={m:.2f}s' for c, m in ph['median'].items()), 'job running at end:', ph['jobRunningAtEnd'])
