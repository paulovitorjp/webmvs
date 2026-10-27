#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Install IND$FILE 2.0.5 (Mike Rayborn; 3270 file transfer, CUT and DFT) in SYS2.CMDLIB of an MVS/CE tree.

  indfile-install.py --mvsce DIR --out DIR --base DIR [--herc BINDIR]

DIR is a writable MVS/CE tree whose DASD has the volumes to change (scripts/build.sh indfile puts the CardDemo
install's volumes in it). The package is the one MVS/CE ships in its package manager (MVP/packages/IND$FILE, an XMI
with the install job #001JCL and the nested XMI IND$FILE); this does what 'RX MVP INSTALL IND$FILE' does, in one
batch job: RECV370 of the package to a temporary library, RECV370 of its IND$FILE member into SYS2.CMDLIB, and the
line 'IND$FILE 2.0.5' in MVP.MVPDB (so 'RX MVP LIST --INSTALLED' lists it). One native Hercules session, ended by the
MVS/CE shutdown script. Writes OUT/mvs000.3350 (SYS2.CMDLIB and MVP.MVPDB are on MVS000), with SYS1.HASPCKPT put back
to the base volume's tracks, compacted and checked. No other volume is changed in a way the web build uses.
"""
import argparse, importlib.util, os, shutil, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('kicks_install', os.path.join(HERE, 'kicks-install.py'))
ki = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ki)

JOBCARD = "//{name:<8} JOB (1),'IND$FILE',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1),\n//         REGION=4096K,USER=IBMUSER,PASSWORD=SYS1\n"
VERSION = '2.0.5'
MEMBERS = ('IND$FILE', 'CDPGDFLT', 'CDPG037', 'CDPG1047')

INSTALL = """//JOBLIB   DD DISP=SHR,DSN=SYSC.LINKLIB
//PKG     EXEC PGM=RECV370
//RECVLOG  DD SYSOUT=*
//XMITIN   DD UNIT=01C,DCB=BLKSIZE=80
//SYSPRINT DD SYSOUT=*
//SYSUT1   DD DSN=&&SYSUT1,UNIT=SYSALLDA,VOL=SER=WORK01,
//            SPACE=(TRK,(60,30)),DISP=(NEW,DELETE,DELETE)
//SYSUT2   DD DSN=&&PKG,UNIT=SYSALLDA,VOL=SER=WORK01,
//            SPACE=(TRK,(60,30,8)),DISP=(NEW,PASS)
//SYSIN    DD DUMMY
//CMDLIB  EXEC PGM=RECV370
//RECVLOG  DD SYSOUT=*
//XMITIN   DD DSN=&&PKG(IND$FILE),DISP=(OLD,PASS)
//SYSPRINT DD SYSOUT=*
//SYSUT1   DD DSN=&&SYSUT1,UNIT=SYSALLDA,VOL=SER=WORK01,
//            SPACE=(TRK,(60,30)),DISP=(NEW,DELETE,DELETE)
//SYSUT2   DD DSN=SYS2.CMDLIB,DISP=SHR
//SYSIN    DD DUMMY
//MVPDB   EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT2   DD DSN=MVP.MVPDB,DISP=MOD
//SYSUT1   DD *
IND$FILE {version}
/*
//LIST    EXEC PGM=IKJEFT01,REGION=1024K
//SYSTSPRT DD SYSOUT=*
//SYSTSIN  DD *
 LISTDS 'SYS2.CMDLIB' MEMBERS
/*
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mvsce', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--base', required=True, help='DASD dir with the mvs000.3350 to take SYS1.HASPCKPT from')
    ap.add_argument('--herc', default=os.path.expanduser('~/herc-native/bin'))
    a = ap.parse_args()
    d = os.path.abspath(a.mvsce); herc = os.path.abspath(a.herc); out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    pkg = os.path.join(d, 'MVP', 'packages', 'IND$FILE')
    assert open(pkg, 'rb').read(8)[2:8] == 'INMR01'.encode('cp037'), f'{pkg}: not an XMI'
    log = open(os.path.join(out, 'indfile-install.log'), 'w')
    h = ki.Herc(d, herc, log)
    try:
        h.ipl()
        h.herc(f'devinit 01c {pkg} ebcdic')
        o = h.job(JOBCARD.format(name='INDFILE') + INSTALL.format(version=VERSION), timeout=900)
        missing = [m for m in MEMBERS if m not in o]
        if missing: raise RuntimeError(f'not in SYS2.CMDLIB after the install: {missing}')
        h.shutdown()
    except BaseException:
        h.kill(); raise
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(herc), 'lib'))
    v = 'mvs000.3350'; dst = os.path.join(out, v); shutil.copyfile(os.path.join(d, 'DASD', v), dst)
    ext, n = ki.restore_dataset(os.path.join(os.path.abspath(a.base), v), dst, 'SYS1.HASPCKPT')
    print(f'{v}: SYS1.HASPCKPT tracks {ext}: {n} tracks restored from the base volume', flush=True)
    subprocess.run([os.path.join(herc, 'cckdcomp'), dst], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = subprocess.run([os.path.join(herc, 'cckdcdsk'), '-3', dst], env=env, capture_output=True, text=True)
    if r.returncode != 0: raise RuntimeError(f'cckdcdsk {v}: rc={r.returncode} {r.stdout[-500:]}')
    print(f'{v}: {os.path.getsize(dst)} bytes, cckdcdsk -3 ok', flush=True)
    print('IND$FILE install ok', flush=True)


if __name__ == '__main__':
    main()
