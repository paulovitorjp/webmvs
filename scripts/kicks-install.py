#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Install KICKS for TSO 1.5.0 (Mike Noel, http://www.kicksfortso.com/) on a copy of the MVS/CE volumes.

  kicks-install.py --mvsce DIR --zip kicks-tso-v1r5m0.zip --out DIR [--herc BINDIR]

DIR is a writable MVS/CE tree (scripts/build.sh kicks extracts a fresh one from the release tar). Three native
Hercules sessions, each ended by the MVS/CE shutdown script (SCRIPTS/SHUTDOWN.RC: JES2 stop, Z EOD, QUIESCE):

  1. new volume KICKS0 (0351, ICKDSF), VATLST00 entry, user catalog UCKICKS0 + alias KICKS in the master
     catalog, RECV370 of the KICKS XMI and its nested libraries (KICKS Installation Guide)
  2. KFIX (HLQ KICKS)
  3. the KICKS CLIST in SYS1.CMDPROC (TCP(1$)), an empty KICKS.KICKS.V1R5M0.SKIKLOAD, the sample VSAM files (Murach, TAC, KIKSDB, KIKINTRA,
     KIKTEMP; their jobs come from the installed INSTLIB with the volume set to KICKS0), and RAKF
     SYS1.SECURE.CNTL(PROFILES) lines KICKS.* and UCKICKS0 UPDATE (KICKS opens its VSAM files for update)

Writes OUT/mvsres.3350, OUT/mvs000.3350 (changed) and OUT/kicks0.3350 (new), compacted with cckdcomp and
checked with cckdcdsk. SYS1.HASPCKPT on MVS000 is put back to the release's tracks (JES2 checkpoint = the
release's SPOOL1). The other volumes are not changed in a way the web build uses (it takes them from the tar).
No KICKS file is part of this repository: the jobs that come from KICKS are made from the installed libraries.
"""
import argparse, bz2, os, re, shutil, socket, struct, subprocess, threading, time, zipfile, zlib

JOBCARD = "//{name:<8} JOB (1),'KICKS',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1),\n//         REGION=4096K,USER=IBMUSER,PASSWORD=SYS1\n"


class Herc:
    def __init__(self, mvsce, herc, log):
        self.dir, self.log = mvsce, log
        env = dict(os.environ)
        env['PATH'] = herc + os.pathsep + env.get('PATH', '')
        lib = os.path.join(os.path.dirname(herc), 'lib')
        if os.path.isdir(lib):
            env['LD_LIBRARY_PATH'] = lib + os.pathsep + env.get('LD_LIBRARY_PATH', '')
        for f in ('printers/prt00e.txt',):
            p = os.path.join(mvsce, f)
            if os.path.exists(p): os.remove(p)
        self.p = subprocess.Popen([os.path.join(herc, 'hercules'), '--externalgui', '-f', 'conf/local.cnf', '-r', 'conf/mvsce.rc'],
                                  cwd=mvsce, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.lines, self.lock = [], threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.p.stdout:
            s = raw.decode('latin-1').rstrip('\r\n')
            with self.lock: self.lines.append(s)
            self.log.write(s + '\n'); self.log.flush()

    def mark(self):
        with self.lock: return len(self.lines)

    def wait(self, rx, since=0, timeout=900):
        r = re.compile(rx); t0 = time.time()
        while time.time() - t0 < timeout:
            with self.lock: new = self.lines[since:]
            for i, l in enumerate(new):
                m = r.search(l)
                if m: return m
            if self.p.poll() is not None: raise RuntimeError(f'hercules ended while waiting for {rx!r}')
            time.sleep(0.5)
        raise TimeoutError(f'{rx!r} not seen in {timeout} s')

    def herc(self, cmd):
        self.log.write(f'>>> {cmd}\n'); self.p.stdin.write((cmd + '\n').encode()); self.p.stdin.flush()

    def oper(self, cmd): self.herc('/' + cmd)

    def prt(self):
        p = os.path.join(self.dir, 'printers/prt00e.txt')
        return open(p, 'r', errors='replace').read() if os.path.exists(p) else ''

    def job(self, jcl, timeout=1800, expect=None):
        name = re.match(r'//(\S+)\s+JOB', jcl).group(1)
        m, before = self.mark(), len(self.prt())
        with socket.create_connection(('127.0.0.1', 3505)) as s: s.sendall(jcl.encode())
        self.wait(r'HASP250 %s\s+IS PURGED' % re.escape(name), m, timeout)
        time.sleep(1)
        out = self.prt()[before:]
        rcs = re.findall(r'IEF142I %s .*COND CODE (\d{4})' % re.escape(name), out)
        bad = [l for l in out.splitlines() if re.search(r'IEF\d{3}I %s\b.*(JCL ERROR|NOT EXECUTED|ABEND)' % re.escape(name), l)
               or re.search(r'IEF272I %s ' % re.escape(name), l)]
        print(f'{name}: steps {len(rcs)} cc {sorted(set(rcs))}', flush=True)
        if not rcs or any(c != '0000' for c in rcs) or bad:
            raise RuntimeError(f'job {name} failed: cc={rcs} {bad[:3]}')
        if expect and expect not in out:
            raise RuntimeError(f'job {name}: {expect!r} not in its output')
        return out

    def ipl(self):
        self.wait(r'IKT005I TCAS IS INITIALIZED', 0, 900)

    def shutdown(self):
        """MVS/CE SCRIPTS/SHUTDOWN.RC: stops TSO, VTAM, JES2 ($PJES2), Z EOD, QUIESCE, then quits Hercules."""
        m = self.mark()
        self.herc('script SCRIPTS/SHUTDOWN.RC')
        self.wait(r'IEE334I HALT +EOD SUCCESSFUL', m, 900)
        try:
            self.p.wait(600)
        except subprocess.TimeoutExpired:
            raise RuntimeError('hercules did not quit after QUIESCE')
        with self.lock: text = '\n'.join(self.lines[m:])
        if 'HASP085' not in text: raise RuntimeError('no $HASP085 JES2 TERMINATION COMPLETE')
        print('clean shutdown: JES2 stopped, Z EOD, QUIESCE, hercules ended rc=%s' % self.p.returncode, flush=True)

    def kill(self):
        if self.p.poll() is None:
            try: self.herc('quit'); self.p.wait(60)
            except Exception: self.p.kill()


def pdsu(herc, vol, dsn, dest):
    os.makedirs(dest, exist_ok=True)
    env = dict(os.environ); lib = os.path.join(os.path.dirname(herc), 'lib')
    if os.path.isdir(lib): env['LD_LIBRARY_PATH'] = lib
    subprocess.run([os.path.join(herc, 'dasdpdsu'), vol, dsn, 'ascii'], cwd=dest, env=env, check=True, stdout=subprocess.DEVNULL)


def member(d, name):
    return open(os.path.join(d, name.lower() + '.mac'), errors='replace').read().splitlines()


def from_instlib(lines):
    """A KICKS INSTLIB job with this build's job card and volume KICKS0 (the installation guide's PUB002)."""
    name = re.match(r'//(\S+)\s+JOB', lines[0]).group(1)
    assert not lines[0].rstrip().endswith(','), 'multi-line job card'
    body = '\n'.join(l.replace('PUB002', 'KICKS0') for l in lines[1:])
    return name, JOBCARD.format(name=name) + body + '\n'


def iebupdte(name, dsn, mem, lines):
    for l in lines:
        assert len(l) <= 80 and not l.startswith('./') and '@@' not in l, l
    return (JOBCARD.format(name=name) + f"//UPD     EXEC PGM=IEBUPDTE,PARM=NEW\n//SYSPRINT DD SYSOUT=*\n//SYSUT2   DD DSN={dsn},DISP=SHR\n"
            f"//SYSIN    DD DATA,DLM=@@\n./ ADD NAME={mem},LIST=ALL\n" + '\n'.join(lines) + '\n@@\n')


def rakf_add(lines, names):
    """RAKF PROFILES with 'DATASET <name> UPDATE' for each name, in the member's sorted order (after the * lines)."""
    out = list(lines)
    for n in names:
        new = 'DATASET ' + n.ljust(44) + ''.ljust(8) + 'UPDATE'
        if any(l.split()[:2] == ['DATASET', n] for l in out if l.strip()): continue
        at = next(i for i, l in enumerate(out) if l.startswith('DATASET ') and l.split()[1] != '*' and l.split()[1] > n)
        out.insert(at, new)
    return out


def session1(h, xmi):
    h.ipl()
    h.herc('attach 0351 3350 DASD/kicks0.3350')
    m = h.mark()
    jcl = JOBCARD.format(name='KICKDSF') + ("//ICKDSF EXEC PGM=ICKDSF,REGION=4096K\n//SYSPRINT DD SYSOUT=*\n//SYSIN    DD *\n"
          "  INIT UNITADDRESS(351) VERIFY(111111) -\n               VOLID(KICKS0) OWNER(HERCULES) -\n               VTOC(0,1,15)\n/*\n")
    with socket.create_connection(('127.0.0.1', 3505)) as s: s.sendall(jcl.encode())
    r = h.wait(r'(\d\d) ICK003D REPLY U TO ALTER VOLUME 351', m, 600)
    h.oper(f'r {r.group(1)},U')
    h.wait(r'HASP250 KICKDSF\s+IS PURGED', m, 600)
    m = h.mark(); h.oper('v 351,online'); h.wait(r'IEE302I 351\s+ONLINE', m, 120)
    m = h.mark(); h.oper('m 351,vol=(sl,kicks0),use=private'); h.wait(r'HASP395 MOUNT\s+ENDED', m, 300)
    h.job(JOBCARD.format(name='ADDDASD') + """//EDIT    EXEC PGM=IKJEFT01,REGION=1024K,DYNAMNBR=50
//SYSPRINT DD  SYSOUT=*
//SYSTSPRT DD  SYSOUT=*
//SYSTERM  DD  SYSOUT=*
//SYSTSIN  DD  *
 EDIT 'SYS1.PARMLIB(VATLST00)' CNTL OLD
 BOTTOM
 INSERT KICKS0,0,2,3350    ,N        KICKS LIBRARIES/DATA (PRIVATE)
 LIST
 SAVE
 END
/*
""", expect='KICKS0,0,2,3350')
    h.job(JOBCARD.format(name='KICKSCAT') + """//IDCAMS  EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//KICKS0 DD UNIT=SYSALLDA,DISP=OLD,VOL=SER=KICKS0
//SYSIN DD *
  DEFINE USERCATALOG ( -
      NAME (UCKICKS0) -
      VOLUME (KICKS0) -
      TRACKS (7500 0) -
      FOR (9999) ) -
      DATA (TRACK (15 5) ) -
      INDEX (TRACKS (15) ) -
      CATALOG (SYS1.VSAM.MASTER.CATALOG/SYSPROG)
  DEFINE ALIAS ( -
      NAME (KICKS) -
      RELATE (UCKICKS0) ) -
      CATALOG (SYS1.VSAM.MASTER.CATALOG/SYSPROG)
/*
""")
    # the outer XMI (a PDS of XMI members) goes to a temporary data set on WORK01, a volume the web build does not use
    h.herc(f'devinit 01c {xmi} ebcdic')
    steps = [('HCB2', 'CB2', 150), ('HCOB', 'COB', 150), ('HCOBCOPY', 'COBCOPY', 150), ('HGCC', 'GCC', 150),
             ('HGCCCOPY', 'GCCCOPY', 150), ('HINSTLIB', 'INSTLIB', 30), ('HKIKRPL', 'KIKRPL', 150), ('HMAPSRC', 'MAPSRC', 45),
             ('HOPIDS', 'OPIDS', 15), ('HSPUFI', "'SPUFI.IN'", 15)]
    ssteps = [('SCMDPROC', 'CLIST', 15), ('SCOB', 'COB', 45), ('SCOBCOPY', 'COBCOPY', 60), ('SDOC', 'DOC', 15), ('SGCC', 'GCC', 15),
              ('SGCCCOPY', 'GCCCOPY', 60), ('SINSTLIB', 'INSTLIB', 30), ('SKIKRPL', 'KIKRPL', 150), ('SMACLIB', 'MACLIB', 15),
              ('SMAPSRC', 'MAPSRC', 45), ('SPROCLIB', 'PROCLIB', 30), ('SPROCLIZ', 'PROCLIBZ', 30), ('SSKIKLOD', 'SKIKLOAD', 150),
              ('STESTCOB', 'TESTCOB', 30), ('STESTGCC', 'TESTGCC', 30), ('STESTFIL', 'TESTFILE', 45)]
    jcl = JOBCARD.format(name='KICKSINS') + """//JOBLIB   DD DISP=SHR,DSN=SYSC.LINKLIB
//RECV    PROC MEM=,MEM2=,TRK=30,MLQ=KICKS
//RECV370 EXEC PGM=RECV370
//RECVLOG  DD SYSOUT=*
//XMITIN   DD DSN=&&INSTALL(&MEM),DISP=(OLD,PASS)
//SYSPRINT DD SYSOUT=*
//SYSUT1   DD DSN=&&SYSUT1,UNIT=SYSALLDA,VOL=SER=WORK01,
//            SPACE=(TRK,(300,60)),DISP=(NEW,DELETE,DELETE)
//SYSUT2   DD DSN=KICKS.&MLQ..V1R5M0.&MEM2,
//            UNIT=SYSALLDA,VOL=SER=KICKS0,
//            SPACE=(TRK,(&TRK,&TRK,100)),DISP=(NEW,CATLG,DELETE)
//SYSIN    DD DUMMY
//        PEND
//INSTALL EXEC PGM=RECV370
//RECVLOG  DD SYSOUT=*
//XMITIN   DD UNIT=01C,DCB=BLKSIZE=80
//SYSPRINT DD SYSOUT=*
//SYSUT1   DD DSN=&&SYSUT1,UNIT=SYSALLDA,VOL=SER=WORK01,
//            SPACE=(TRK,(300,60)),DISP=(NEW,DELETE,DELETE)
//SYSUT2   DD DSN=&&INSTALL,UNIT=SYSALLDA,VOL=SER=WORK01,
//            SPACE=(TRK,(600,,8)),DISP=(NEW,PASS)
//SYSIN    DD DUMMY
"""
    for s, d, t in steps: jcl += f"//{s:<8} EXEC RECV,MEM={s},MEM2={d},TRK={t}\n"
    for s, d, t in ssteps: jcl += f"//{s:<8} EXEC RECV,MLQ=KICKSSYS,MEM={s},MEM2={d},TRK={t}\n"
    h.job(jcl, timeout=3600)
    h.shutdown()


def run_jobs(h, jobs):
    h.ipl()
    for j in jobs: h.job(j, timeout=1800)
    h.shutdown()


def kfix_job(kfix):
    """KFIX (installation guide: customizes the KICKS JCL and CLISTs for the high level qualifier). It asks
    which HLQ to use; this copy (on WORK01, deleted at the end) takes KICKS without asking."""
    out, done = [], set()
    for l in kfix:                       # the first SET &NM / SET &UU (before the prompt loop) and the prompt label
        t = l.strip()
        if 'nm' not in done and re.fullmatch(r'SET &NM\s+= 1', t): l = l.replace('1', '2'); done.add('nm')
        elif 'uu' not in done and re.fullmatch(r'SET &UU\s+= &UU1', t): l = l.replace('&UU1', 'KICKS'); done.add('uu')
        elif t == 'DOPROMPT: +': l = 'DOPROMPT: GOTO ITSYES'; done.add('prompt')
        out.append(l)
    assert done == {'nm', 'uu', 'prompt'}, f'KFIX: changed {sorted(done)}'
    for l in out: assert len(l) <= 72 and not l.startswith('./') and '@@' not in l, l
    return JOBCARD.format(name='KFIX') + """//COPY    EXEC PGM=IEBUPDTE,PARM=NEW
//SYSPRINT DD SYSOUT=*
//SYSUT2   DD DSN=KICKS.KFIXTMP.CLIST,DISP=(NEW,CATLG),UNIT=3350,
//            VOL=SER=WORK01,SPACE=(TRK,(5,5,2)),
//            DCB=(RECFM=FB,LRECL=80,BLKSIZE=3120)
//SYSIN    DD DATA,DLM=@@
./ ADD NAME=KFIX
""" + '\n'.join(out) + """
@@
//KFIX    EXEC PGM=IKJEFT01,DYNAMNBR=64
//SYSPRINT DD SYSOUT=*
//SYSTSPRT DD SYSOUT=*
//SYSTERM  DD SYSOUT=*
//SYSTSIN  DD *
PROFILE PREFIX(KICKS)
EXEC 'KICKS.KFIXTMP.CLIST(KFIX)'
/*
//DELETE  EXEC PGM=IEFBR14
//TMP      DD DSN=KICKS.KFIXTMP.CLIST,DISP=(OLD,DELETE)
"""


class Cckd:
    """Raw track access to a little-endian CCKD file (L1 + L2 tables; a track entry is pos, len, size)."""
    def __init__(self, path, mode='rb'):
        self.f = open(path, mode)
        dh = self.f.read(512); assert dh[:8] in (b'CKD_C370', b'CKD_S370'), dh[:8]
        self.heads = struct.unpack_from('<I', dh, 8)[0]
        self.cd = bytearray(self.f.read(512)); assert not (self.cd[3] & 0x02), 'big-endian CCKD'
        n = struct.unpack_from('<i', self.cd, 4)[0]
        self.l1 = struct.unpack(f'<{n}I', self.f.read(4 * n))

    def entry(self, trk):
        l2 = self.l1[trk // 256]
        if l2 in (0, 0xffffffff): return None, (0, 0, 0)
        self.f.seek(l2 + 8 * (trk % 256)); return l2 + 8 * (trk % 256), struct.unpack('<IHH', self.f.read(8))

    def raw(self, trk):
        _, (pos, ln, _) = self.entry(trk)
        if not pos: return None
        self.f.seek(pos); return self.f.read(ln)

    def image(self, trk):
        r = self.raw(trk)
        if r is None: return None
        b = r[5:]; c = r[0] & 3
        return r[:5] + (zlib.decompress(b) if c == 1 else bz2.decompress(b) if c == 2 else b)

    def put_raw(self, trk, raw):
        """the track's stored bytes (as another CCKD file has them), appended; cckdcdsk -3 rebuilds the free space"""
        e, _ = self.entry(trk)
        assert e is not None, f'track {trk}: no L2 table'
        if raw is None:
            self.f.seek(e); self.f.write(struct.pack('<IHH', 0, 0, 0)); return
        self.f.seek(0, 2); pos = self.f.tell(); self.f.write(raw)
        self.f.seek(e); self.f.write(struct.pack('<IHH', pos, len(raw), len(raw)))
        struct.pack_into('<II', self.cd, 12, pos + len(raw), pos + len(raw))
        self.f.seek(512); self.f.write(self.cd)


def extents(vol, dsn):
    """[(first track, last track)] of a data set, from its format-1 DSCB in the VTOC"""
    v = Cckd(vol)
    img = v.image(0)
    p = 5 + 8 + 8                      # after the home address and R0
    vol1 = None
    while img[p:p + 8] != b'\xff' * 8:
        c = img[p:p + 8]; kl, dl = c[5], struct.unpack('>H', c[6:8])[0]
        if kl == 4 and img[p + 8:p + 12] == 'VOL1'.encode('cp037'): vol1 = img[p + 12:p + 12 + dl]
        p += 8 + kl + dl
    assert vol1 and vol1[:4] == 'VOL1'.encode('cp037'), 'no VOL1 label'
    cc, hh = struct.unpack('>HH', vol1[11:15])   # VTOC address CCHHR
    name = dsn.encode('cp037').ljust(44, b'\x40')
    for t in range(cc * v.heads + hh, cc * v.heads + hh + 15):
        img = v.image(t)
        if img is None: continue
        p = 5 + 8 + 8
        while p + 8 <= len(img):
            c = img[p:p + 8]
            if c == b'\xff' * 8: break
            kl, dl = c[5], struct.unpack('>H', c[6:8])[0]
            if kl == 44 and img[p + 8:p + 52] == name:
                d = img[p + 52:p + 52 + dl]
                out = []
                for o in (61, 71, 81):         # DS1EXT1-3: type, seq, lower CCHH, upper CCHH
                    if d[o] == 0: continue
                    c1, h1, c2, h2 = struct.unpack('>HHHH', d[o + 2:o + 10])
                    out.append((c1 * v.heads + h1, c2 * v.heads + h2))
                return out
            p += 8 + kl + dl
    raise KeyError(f'{dsn} not in the VTOC of {vol}')


def restore_dataset(base, vol, dsn):
    """Copy the tracks of data set dsn from the base volume (same extents) into vol."""
    eb, ev = extents(base, dsn), extents(vol, dsn)
    assert eb == ev, f'{dsn}: extents differ {eb} {ev}'
    b, v = Cckd(base), Cckd(vol, 'r+b')
    n = 0
    for lo, hi in eb:
        for t in range(lo, hi + 1):
            if b.image(t) != v.image(t): v.put_raw(t, b.raw(t)); n += 1
    v.f.close()
    return eb, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mvsce', required=True); ap.add_argument('--zip', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--herc', default=os.path.expanduser('~/herc-native/bin'))
    ap.add_argument('--base', required=True, help='DASD dir of the release volumes (unchanged), for SYS1.HASPCKPT')
    a = ap.parse_args()
    d = os.path.abspath(a.mvsce); herc = os.path.abspath(a.herc); out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    work = os.path.join(d, 'kicks-work'); shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
    with zipfile.ZipFile(a.zip) as z:
        xn = [n for n in z.namelist() if n.lower().endswith('.xmi')]
        assert len(xn) == 1, xn
        xmi = os.path.join(work, 'kicks.xmi'); open(xmi, 'wb').write(z.read(xn[0]))
    vol = os.path.join(d, 'DASD/kicks0.3350')
    if os.path.exists(vol): os.remove(vol)
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(herc), 'lib'))
    subprocess.run([os.path.join(herc, 'dasdinit'), '-z', '-a', vol, '3350', '111111'], env=env, check=True, stdout=subprocess.DEVNULL)
    log = open(os.path.join(out, 'kicks-install.log'), 'w')

    print('session 1: KICKS0, catalog, RECV370', flush=True)
    h = Herc(d, herc, log)
    try: session1(h, xmi)
    except BaseException: h.kill(); raise

    cnf = os.path.join(d, 'conf/local.cnf'); c = open(cnf).read()
    if 'kicks0.3350' not in c:
        c = c.replace('0253    3350    DASD/syscpk.3350', '0253    3350    DASD/syscpk.3350\n0351    3350    DASD/kicks0.3350')
        assert 'kicks0.3350' in c; open(cnf, 'w').write(c)
    ex = os.path.join(work, 'x')
    pdsu(herc, vol, 'KICKS.KICKSSYS.V1R5M0.CLIST', os.path.join(ex, 'CLIST0'))
    print('session 2: KFIX', flush=True)
    h = Herc(d, herc, log)
    try: run_jobs(h, [kfix_job(member(os.path.join(ex, 'CLIST0'), 'KFIX'))])
    except BaseException: h.kill(); raise

    # jobs for session 3 from the installed libraries (after KFIX) and the system's RAKF profiles
    for dsn in ('KICKS.KICKS.V1R5M0.INSTLIB', 'KICKS.KICKSSYS.V1R5M0.INSTLIB', 'KICKS.KICKSSYS.V1R5M0.CLIST'):
        pdsu(herc, vol, dsn, os.path.join(ex, dsn))
    pdsu(herc, os.path.join(d, 'DASD/mvs000.3350'), 'SYS1.SECURE.CNTL', os.path.join(ex, 'SECURE'))
    clist = member(os.path.join(ex, 'KICKS.KICKSSYS.V1R5M0.CLIST'), 'KICKS')
    assert sum('TCP(2$)' in l for l in clist) == 1, 'KICKS CLIST: TCP(2$) not found once'
    clist = [l.replace('TCP(2$)', 'TCP(1$)') for l in clist]  # the TSO terminal driver used by MVS/CE KICKS setups
    jobs = [iebupdte('KCLIST', 'SYS1.CMDPROC', 'KICKS', clist)]
    # the KICKS CLIST puts KICKS.KICKS.V1R5M0.SKIKLOAD (load library for your own KICKS programs) in front of the
    # system SKIKLOAD; the install does not create it: an empty one
    jobs.append(JOBCARD.format(name='KSKIKLD') + """//ALLOC   EXEC PGM=IEFBR14
//SKIKLOAD DD DSN=KICKS.KICKS.V1R5M0.SKIKLOAD,DISP=(NEW,CATLG),
//            UNIT=3350,VOL=SER=KICKS0,SPACE=(TRK,(15,15,20)),
//            DCB=(RECFM=U,BLKSIZE=19069,DSORG=PO)
""")
    for lib, mem in (('KICKS.KICKS.V1R5M0.INSTLIB', 'LOADMUR'), ('KICKS.KICKS.V1R5M0.INSTLIB', 'LOADTAC'),
                     ('KICKS.KICKS.V1R5M0.INSTLIB', 'LOADSDB'), ('KICKS.KICKSSYS.V1R5M0.INSTLIB', 'LODINTRA'),
                     ('KICKS.KICKSSYS.V1R5M0.INSTLIB', 'LODTEMP')):
        jobs.append(from_instlib(member(os.path.join(ex, lib), mem))[1])
    prof = rakf_add(member(os.path.join(ex, 'SECURE'), 'PROFILES'), ['KICKS.*', 'UCKICKS0'])
    jobs.append(iebupdte('RAKFKICK', 'SYS1.SECURE.CNTL', 'PROFILES', prof))
    open(os.path.join(work, 'session3.jcl'), 'w').write('\n'.join(jobs))

    print('session 3: CLIST, VSAM sample files, RAKF profiles', flush=True)
    h = Herc(d, herc, log)
    try: run_jobs(h, jobs)
    except BaseException: h.kill(); raise

    for v in ('mvsres.3350', 'mvs000.3350', 'kicks0.3350'):
        dst = os.path.join(out, v); shutil.copyfile(os.path.join(d, 'DASD', v), dst)
        if v == 'mvs000.3350':
            # The JES2 checkpoint (SYS1.HASPCKPT on MVS000) goes back to the release's: it must match the job queue on
            # SPOOL1, which the web build takes from the release (the install's jobs and STCs are not shipped).
            ext, n = restore_dataset(os.path.join(os.path.abspath(a.base), v), dst, 'SYS1.HASPCKPT')
            print(f'{v}: SYS1.HASPCKPT tracks {ext}: {n} tracks restored from the release volume', flush=True)
        subprocess.run([os.path.join(herc, 'cckdcomp'), dst], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        r = subprocess.run([os.path.join(herc, 'cckdcdsk'), '-3', dst], env=env, capture_output=True, text=True)
        if r.returncode != 0: raise RuntimeError(f'cckdcdsk {v}: rc={r.returncode} {r.stdout[-500:]}')
        print(f'{v}: {os.path.getsize(dst)} bytes, cckdcdsk -3 ok', flush=True)
    shutil.rmtree(work, ignore_errors=True)
    print('KICKS install ok', flush=True)


if __name__ == '__main__':
    main()
