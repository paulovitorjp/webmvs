#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Install the CardDemo sample application (Apache-2.0, Copyright Amazon.com, Inc. or its affiliates) on a new volume
CARDD0 (0352) of an MVS/CE tree that already has KICKS (scripts/kicks-install.py).

  carddemo-install.py --mvsce DIR --src CARDDEMO_CHECKOUT --out DIR [--herc BINDIR] --base DIR
                      [--work DIR --stages a,b,..]   (development: reuse a tree, run some stages)

The COBOL sources are converted to the dialect of the MVT ANS COBOL compiler (scripts/carddemo/cob2ans.py, with the
fixes in scripts/carddemo/fixes.py), the BMS maps go through the KICKS map generator, the programs are compiled with
the KICKS COBOL preprocessor. One native Hercules session, ended by the MVS/CE shutdown script:

  vol      CARDD0 (ICKDSF), VATLST00 entry, user catalog UCCARDD0 + alias CARDDEMO
  libs     CARDDEMO.COBOL / .ORIGCBL / .BMS / .COPYLIB / .JCL / .KIKRPL / .SKIKLOAD / .LOADLIB / .SUBLIB
  data     VSAM KSDS files + alternate indexes and paths, loaded from CardDemo's data files
  helpers  small COBOL subprograms the converted programs call (reference modification, STRING, dates, NUMVAL)
  maps     BMS mapsets -> CARDDEMO.KIKRPL (physical) and CARDDEMO.COPYLIB (symbolic)
  online   KICKS programs -> CARDDEMO.KIKRPL
  batch    batch programs -> CARDDEMO.LOADLIB (compiled and linked)
  tables   KICKS PPT/PCT/FCT suffix CD -> CARDDEMO.SKIKLOAD
  clist    SYS1.CMDPROC(CARDDEMO): KICKS with the CardDemo files and tables, first transaction CC00
  rakf     SYS1.SECURE.CNTL(PROFILES): CARDDEMO.* ALTER, UCCARDD0 UPDATE
"""
import argparse, importlib.util, os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('kicks_install', os.path.join(HERE, 'kicks-install.py'))
ki = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ki)
sys.path.insert(0, os.path.join(HERE, 'carddemo'))
import cob2ans, fixes, dlivsam  # noqa: E402

JOBCARD = "//{name:<8} JOB (1),'CARDDEMO',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1),\n//         REGION=4096K,USER=IBMUSER,PASSWORD=SYS1\n"
VOL = 'CARDD0'
UNIT = '0352'

# VSAM files: (name, record length, key length, key offset, data file, alternate index (keylen, offset) or None)
FILES = [
    ('ACCTDATA', 300, 11, 0, 'ACCTDATA', None),
    ('CARDDATA', 150, 16, 0, 'CARDDATA', (11, 16, 150)),
    ('CUSTDATA', 500, 9, 0, 'CUSTDATA', None),
    ('CARDXREF', 50, 16, 0, 'CARDXREF', (11, 25, 50)),
    ('TRANSACT', 350, 16, 0, 'DALYTRAN', None),
    ('USRSEC', 80, 8, 0, 'USRSEC', None),
    ('TCATBALF', 50, 17, 0, 'TCATBALF', None),
    ('DISCGRP', 50, 16, 0, 'DISCGRP', None),
    ('TRANCATG', 60, 6, 0, 'TRANCATG', None),
    ('TRANTYPE', 60, 2, 0, 'TRANTYPE', None),
]
# KICKS file names (CardDemo's CICS FILE definitions) -> data set
KFILES = [('ACCTDAT', 'CARDDEMO.ACCTDATA.KSDS', None), ('CARDDAT', 'CARDDEMO.CARDDATA.KSDS', None),
          ('CARDAIX', 'CARDDEMO.CARDDATA.PATH', 'CARDDAT'), ('CCXREF', 'CARDDEMO.CARDXREF.KSDS', None),
          ('CXACAIX', 'CARDDEMO.CARDXREF.PATH', 'CCXREF'), ('CUSTDAT', 'CARDDEMO.CUSTDATA.KSDS', None),
          ('TRANSACT', 'CARDDEMO.TRANSACT.KSDS', None), ('USRSEC', 'CARDDEMO.USRSEC.KSDS', None),
          ('TRANTYPE', 'CARDDEMO.TRANTYPE.KSDS', None), ('TRANCATG', 'CARDDEMO.TRANCATG.KSDS', None),
          ('PAUTSUM', 'CARDDEMO.PAUTSUM.KSDS', None), ('PAUTDTL', 'CARDDEMO.PAUTDTL.KSDS', None),
          ('AUTHFRDS', 'CARDDEMO.AUTHFRDS.KSDS', None)]
# online programs and their transactions (CardDemo CSD); MAPS: mapsets
ONLINE = [('COSGN00C', 'CC00'), ('COMEN01C', 'CM00'), ('COADM01C', 'CA00'), ('COACTVWC', 'CAVW'),
          ('COCRDLIC', 'CCLI'), ('COCRDSLC', 'CCDL'), ('COUSR00C', 'CU00'), ('COTRN00C', 'CT00'), ('COTRN01C', 'CT01'),
          ('COUSR01C', 'CU01'), ('COUSR02C', 'CU02'), ('COUSR03C', 'CU03'), ('COTRN02C', 'CT02'), ('COBIL00C', 'CB00'),
          ('COACTUPC', 'CAUP'), ('COCRDUPC', 'CCUP'), ('CORPT00C', 'CR00'), ('COTRTLIC', 'CTLI'), ('COTRTUPC', 'CTTU'),
          ('COPAUS0C', 'CPVS'), ('COPAUS1C', 'CPVD'), ('COPAUS2C', None)]
# programs outside app/cbl: their directory (cbl, cpy, bms, cpy-bms under it); the transaction type programs use
# Db2 upstream, here the TRANTYPE file (carddemo/sqlvsam.py)
APPDIR = {'COTRTLIC': 'app/app-transaction-type-db2', 'COTRTUPC': 'app/app-transaction-type-db2',
          'COPAUS0C': 'app/app-authorization-ims-db2-mq', 'COPAUS1C': 'app/app-authorization-ims-db2-mq',
          'COPAUS2C': 'app/app-authorization-ims-db2-mq'}
APPDIRS = ['app'] + sorted(set(APPDIR.values()))


def app_file(src, kind, name):
    """the source of a program (kind cbl) or mapset (bms) in app/ or the directory of an optional part"""
    for d in APPDIRS:
        f = os.path.join(src, d, kind, name + '.' + kind)
        if os.path.exists(f): return f
    return os.path.join(src, 'app', kind, name + '.' + kind)
OTHER_TRANS = []
BATCH = ['CBACT02C', 'CBACT03C', 'CBCUS01C', 'CBTRN03C']
# batch programs of this port (scripts/carddemo/helpers): CDTRFLT selects transactions by date for the report job
TOOLS = ['CDTRFLT', 'CDUNHEX']
READALL = """//READALL  JOB (1),'CARDDEMO',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1)
//* CardDemo batch readers: list the card, card xref and customer files
//ACCT    EXEC PGM=CBACT02C
//STEPLIB  DD DSN=CARDDEMO.LOADLIB,DISP=SHR
//CARDFILE DD DSN=CARDDEMO.CARDDATA.KSDS,DISP=SHR
//SYSOUT   DD SYSOUT=*
//XREF    EXEC PGM=CBACT03C
//STEPLIB  DD DSN=CARDDEMO.LOADLIB,DISP=SHR
//XREFFILE DD DSN=CARDDEMO.CARDXREF.KSDS,DISP=SHR
//SYSOUT   DD SYSOUT=*
//CUST    EXEC PGM=CBCUS01C
//STEPLIB  DD DSN=CARDDEMO.LOADLIB,DISP=SHR
//CUSTFILE DD DSN=CARDDEMO.CUSTDATA.KSDS,DISP=SHR
//SYSOUT   DD SYSOUT=*
"""
HELPERS = ['CDMOVC', 'CDSTRG', 'CDDATE', 'CDREPC', 'CDNUMV', 'CSUTLDTC', 'CDTLEN', 'CDIDAT', 'CDCLAS', 'CDLIKE']


def run_job(h, jcl, outdir, timeout=900, expect=None, maxcc=4):
    """submit, wait, keep the printout in outdir/NAME.txt; condition codes up to maxcc are fine"""
    import socket, time
    name = re.match(r'//(\S+)\s+JOB', jcl).group(1)
    assert len(name) <= 8, name
    m, before = h.mark(), len(h.prt())
    with socket.create_connection(('127.0.0.1', 3505)) as s: s.sendall(jcl.encode())
    t0 = time.time()
    while True:
        r = h.wait(r'HASP250 %s\s+IS PURGED|\*(\d+) IEF238D %s ' % (re.escape(name), re.escape(name)), m,
                   max(1, timeout - (time.time() - t0)))
        if not r.group(1): break
        h.oper(f"r {r.group(1)},'CANCEL'"); m = h.mark()
    time.sleep(1)
    out = h.prt()[before:]
    open(os.path.join(outdir, name + '.txt'), 'w').write(out)
    rcs = re.findall(r'IEF142I %s .*COND CODE (\d{4})' % re.escape(name), out)
    bad = [l for l in out.splitlines() if re.search(r'IEF\d{3}I %s\b.*(JCL ERROR|ABEND)' % re.escape(name), l)
           or re.search(r'IEF272I %s .*NOT EXECUTED' % re.escape(name), l)]
    print(f'{name}: steps {len(rcs)} cc {sorted(set(rcs))}', flush=True)
    bad += [l for l in out.splitlines() if re.match(r'IEB80[57]I', l)]   # IEBUPDTE member errors (CC 4)
    if not rcs or any(int(c) > maxcc for c in rcs) or bad:
        raise RuntimeError(f'job {name} failed: cc={rcs} {bad[:3]}')
    if expect and expect not in out:
        raise RuntimeError(f'job {name}: {expect!r} not in its output')
    return out


def fix_bms(lines):
    """BMS source for the KICKS map generator (KIKMG):
    - an unnamed LENGTH=0 field is a stopper attribute (it ends the input field before it) and KIKMG rejects
      LENGTH=0: LENGTH=1 (ASKIP unless it has an ATTRB) when the next field starts 2 or more positions later,
      else dropped
    - no JUSTIFY / VALIDN in KIKMG: dropped
    - no CTRL on DFHMDI in KIKMG: it goes to the DFHMSD (without FREEKB the keyboard stays locked)
    - PICIN='99999999999' (a numeric input field) makes the ANS COBOL compiler abend (S0C4) on the symbolic
      map: dropped, the field stays alphanumeric
    - KIKMG shifts a continued INITIAL literal that has doubled quotes ('Type ''S'' to ...'): '' becomes a double quote"""
    def stmts():
        # statement text: columns 1-71, continuation lines from column 16 (a continued literal goes on there)
        join = lambda st: st[0][:71].ljust(71) + ''.join(x[15:71].ljust(56) for x in st[1:])
        stmt = []
        for l in lines:
            stmt.append(l)
            if len(l) >= 72 and l[71] != ' ': continue
            yield stmt, join(stmt); stmt = []
        if stmt: yield stmt, join(stmt)
    mdi_ctrl = None
    for _, text in stmts():
        m = re.match(r'\S+\s+DFHMDI\b.*?(CTRL=\([A-Z,]*\))', text)
        if m: mdi_ctrl = m.group(1)
    pos = lambda text: tuple(map(int, re.search(r'POS=\((\d+),(\d+)\)', text).groups()))
    fields = [text for stmt, text in stmts() if re.match(r'\S*\s+DFHMDF\b', stmt[0])]
    out, fi = [], -1
    for stmt, text in stmts():
        msd = re.match(r'\S+\s+DFHMSD\b', text) and 'TYPE=FINAL' not in text
        if re.match(r'\S*\s+DFHMDF\b', stmt[0]): fi += 1
        if re.match(r'\s+DFHMDF\b', stmt[0]) and re.search(r'LENGTH=0\b', text):
            (r, c), nxt = pos(text), (pos(fields[fi + 1]) if fi + 1 < len(fields) else (99, 1))
            if nxt > (r, c + 1) and c < 80:
                new = 'LENGTH=1' if 'ATTRB=' in text else 'ATTRB=ASKIP,LENGTH=1'   # a stopper: autoskip
                stmt = [re.sub(r'LENGTH=0\b', new, l[:71].rstrip()).ljust(71 if len(l) > 71 else 0) + l[71:]
                        for l in stmt]
                text = re.sub(r'LENGTH=0\b', new, text)
            else: continue
        if not (re.search(r"JUSTIFY=|VALIDN=|PICIN=|''", text) or re.match(r'\S+\s+DFHMDI\b.*CTRL=', text)
                or (msd and mdi_ctrl and 'CTRL=' not in text)):
            out += stmt; continue
        m = re.match(r'(\S*)\s+(\S+)\s+(.*)$', text)
        body = re.sub(r'\s+-(?=\s)', ' ', ' ' + m.group(3)).strip()
        body = re.sub(r'(JUSTIFY|VALIDN)=\([A-Z,]*\),?\s*', '', body).rstrip(', ')
        body = re.sub(r"PICIN='[^']*',?\s*", '', body).rstrip(', ')
        if "''" in body:   # a continued literal: join it (continuation lines start in column 16)
            body = body.replace("''", '"')
        if m.group(2) == 'DFHMDI': body = re.sub(r'CTRL=\([A-Z,]*\),\s*', '', body)
        toks = re.findall(r"(?:[^,'\s(]|\([^)]*\)|'(?:[^']|'')*')+", body)
        if msd and mdi_ctrl and 'CTRL=' not in text: toks.insert(1, mdi_ctrl)
        first = f'{m.group(1):<8}{m.group(2)} '
        for i, t in enumerate(toks):
            last = i == len(toks) - 1
            l = (first if i == 0 else ' ' * 15) + t + ('' if last else ',')
            while len(l) > 71:   # a long literal: continued in column 16
                out.append(l[:71] + '-'); l = ' ' * 15 + l[71:]
            out.append(l if last else f'{l:<71}-')
    return out


def maps_for(programs, src):
    m = []
    for p in programs:
        t = open(app_file(src, 'cbl', p), errors='replace').read()
        for c in re.findall(r"MAPSET\s*\(\s*'([A-Z0-9]+)'", t) + re.findall(r"VALUE\s+'(CO[A-Z0-9]+) *'\s*\.", t):
            if os.path.exists(app_file(src, 'bms', c)) and c not in m: m.append(c)
    return m


def gener(name, dsn, lines):
    """write one PDS member (added or replaced) with IEBGENER"""
    j = JOBCARD.format(name=name) + "//GEN     EXEC PGM=IEBGENER\n//SYSPRINT DD SYSOUT=*\n//SYSIN    DD DUMMY\n" \
        f"//SYSUT2   DD DSN={dsn},DISP=SHR\n//SYSUT1   DD DATA,DLM=@@\n"
    for l in lines:
        assert len(l.rstrip()) <= 80 and '@@' not in l, l
        j += l.rstrip() + '\n'
    return j + '@@\n'


def iebupdte(name, dsn, members, new=False):
    j = JOBCARD.format(name=name) + "//UPD     EXEC PGM=IEBUPDTE,PARM=MOD\n//SYSPRINT DD SYSOUT=*\n" \
        f"//SYSUT1   DD DSN={dsn},DISP=SHR\n//SYSUT2   DD DSN={dsn},DISP=SHR\n//SYSIN    DD DATA,DLM=@@\n"
    for mem, lines in members.items():
        j += f'./ {"ADD" if new else "REPL"} NAME={mem}\n'
        for l in lines:
            l = l.rstrip()
            assert len(l) <= 80 and not l.startswith('./') and '@@' not in l, (mem, l)
            j += l + '\n'
    return j + '@@\n'


def card_deck(lines, n):
    out = []
    for l in lines:
        l = l.ljust(n * 80)[:n * 80]
        for i in range(n): out.append(l[i * 80:(i + 1) * 80])
    return out


def data_lines(src, f, reclen):
    """records of CardDemo's EBCDIC data file (fixed length, character data only) as text for the card reader"""
    d = open(os.path.join(src, 'app/data/EBCDIC', f'AWS.M2.CARDDEMO.{f}.PS'), 'rb').read().decode('cp037')
    assert len(d) % reclen == 0 and all(32 <= ord(c) < 127 for c in d), f
    return [d[i:i + reclen] for i in range(0, len(d), reclen)]


def job_vol(h):
    ki.Herc  # noqa
    h.herc(f'attach {UNIT} 3350 DASD/cardd0.3350')
    m = h.mark()
    jcl = JOBCARD.format(name='CDDSF') + ("//ICKDSF EXEC PGM=ICKDSF,REGION=4096K\n//SYSPRINT DD SYSOUT=*\n//SYSIN    DD *\n"
          f"  INIT UNITADDRESS({UNIT[1:]}) VERIFY(111111) -\n               VOLID({VOL}) OWNER(HERCULES) -\n               VTOC(0,1,15)\n/*\n")
    import socket
    with socket.create_connection(('127.0.0.1', 3505)) as s: s.sendall(jcl.encode())
    r = h.wait(rf'(\d\d) ICK003D REPLY U TO ALTER VOLUME {UNIT[1:]}', m, 120)
    h.oper(f'r {r.group(1)},U')
    h.wait(r'HASP250 CDDSF\s+IS PURGED', m, 600)
    m = h.mark(); h.oper(f'v {UNIT[1:]},online'); h.wait(rf'IEE302I {UNIT[1:]}\s+ONLINE', m, 120)
    m = h.mark(); h.oper(f'm {UNIT[1:]},vol=(sl,{VOL.lower()}),use=private'); h.wait(r'HASP395 MOUNT\s+ENDED', m, 300)
    h.job(JOBCARD.format(name='CDVATL') + f"""//EDIT    EXEC PGM=IKJEFT01,REGION=1024K,DYNAMNBR=50
//SYSPRINT DD  SYSOUT=*
//SYSTSPRT DD  SYSOUT=*
//SYSTERM  DD  SYSOUT=*
//SYSTSIN  DD  *
 EDIT 'SYS1.PARMLIB(VATLST00)' CNTL OLD
 BOTTOM
 INSERT {VOL},0,2,3350    ,N        CARDDEMO SAMPLE APPLICATION
 LIST
 SAVE
 END
/*
""", expect=f'{VOL},0,2,3350')
    h.job(JOBCARD.format(name='CDCAT') + f"""//IDCAMS  EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//{VOL} DD UNIT=SYSALLDA,DISP=OLD,VOL=SER={VOL}
//SYSIN DD *
  DEFINE USERCATALOG ( -
      NAME (UCCARDD0) -
      VOLUME ({VOL}) -
      TRACKS (1500 0) -
      FOR (9999) ) -
      DATA (TRACK (15 5) ) -
      INDEX (TRACKS (15) ) -
      CATALOG (SYS1.VSAM.MASTER.CATALOG/SYSPROG)
  DEFINE ALIAS ( -
      NAME (CARDDEMO) -
      RELATE (UCCARDD0) ) -
      CATALOG (SYS1.VSAM.MASTER.CATALOG/SYSPROG)
/*
""")


def job_libs(only=None, name='CDLIBS'):
    """allocate the CARDDEMO libraries; with only=[...]: delete and allocate those again (source reload)"""
    libs = [('COBOL', 'FB', 80, 3120, 60, 60), ('ORIGCBL', 'FB', 80, 3120, 90, 60), ('BMS', 'FB', 80, 3120, 30, 40),
            ('COPYLIB', 'FB', 80, 3120, 30, 60), ('JCL', 'FB', 80, 3120, 10, 20), ('KIKRPL', 'U', 0, 19069, 60, 60),
            ('SKIKLOAD', 'U', 0, 19069, 5, 10), ('LOADLIB', 'U', 0, 19069, 15, 20), ('SUBLIB', 'U', 0, 19069, 10, 20)]
    if only: libs = [l for l in libs if l[0] in only]
    j = JOBCARD.format(name=name)
    if only:
        j += '//DELETE  EXEC PGM=IEFBR14\n' + ''.join(f'//{l[0]:<8} DD DSN=CARDDEMO.{l[0]},DISP=(OLD,DELETE)\n' for l in libs)
    j += '//ALLOC   EXEC PGM=IEFBR14\n'
    for n, rf, lr, bs, trk, dirb in libs:
        dcb = f'RECFM={rf},LRECL={lr},BLKSIZE={bs}' if rf == 'FB' else f'RECFM=U,BLKSIZE={bs}'
        j += (f'//{n:<8} DD DSN=CARDDEMO.{n},DISP=(NEW,CATLG),\n//            UNIT=3350,VOL=SER={VOL},'
              f'SPACE=(TRK,({trk},{trk // 2},{dirb})),\n//            DCB=({dcb},DSORG=PO)\n')
    return j


CDSTACK = """       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDSTACK.
      * card images ({n} per record) to {rl}-byte records.  KICKS' STKCARDS
      * drops a lone blank at the end of a card, which shifts the record.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT CARDS ASSIGN TO UT-S-CARDS.
           SELECT RECS ASSIGN TO UT-S-RECS.
       DATA DIVISION.
       FILE SECTION.
       FD  CARDS LABEL RECORDS ARE OMITTED
           RECORD CONTAINS 80 CHARACTERS.
       01  CARD PIC X(80).
       FD  RECS LABEL RECORDS ARE STANDARD
           RECORD CONTAINS {rl} CHARACTERS.
       01  REC PIC X({rl}).
       WORKING-STORAGE SECTION.
       01  BUF.
           05 BCARD PIC X(80) OCCURS {n} TIMES.
       01  I PIC S9(4) COMP.
       01  EOF PIC X VALUE 'N'.
       PROCEDURE DIVISION.
           OPEN INPUT CARDS OUTPUT RECS.
       NEXT-REC.
           PERFORM READ-CARD VARYING I FROM 1 BY 1 UNTIL I > {n}.
           IF EOF = 'Y' GO TO DONE.
           MOVE BUF TO REC. WRITE REC.
           GO TO NEXT-REC.
       READ-CARD.
           IF EOF = 'N' READ CARDS AT END MOVE 'Y' TO EOF.
           IF EOF = 'N' MOVE CARD TO BCARD (I).
       DONE.
           CLOSE CARDS RECS. STOP RUN.
"""


def stack_steps(rl, n, deck):
    """compile, link and run CDSTACK: the card deck -> &&RECS (fixed {rl}-byte records)"""
    return f"""//STKC    EXEC PGM=IKFCBL00,REGION=4096K,PARM='LOAD,NODECK,SUPMAP'
//STEPLIB  DD DSN=SYSC.LINKLIB,DISP=SHR
//SYSPRINT DD SYSOUT=*
//SYSPUNCH DD DUMMY
//SYSUT1   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT2   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT3   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT4   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSLIN   DD DSN=&&STKO,DISP=(,PASS),UNIT=SYSDA,SPACE=(80,(500,100))
//SYSIN    DD *
{CDSTACK.format(rl=rl, n=n)}/*
//STKL    EXEC PGM=IEWL,PARM='LIST,LET',COND=(5,LT,STKC)
//SYSPRINT DD SYSOUT=*
//SYSLIB   DD DSN=SYSC.COBLIB,DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(1024,(200,20))
//SYSLMOD  DD DSN=&&STKL(GO),DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(TRK,(5,5,1))
//SYSLIN   DD DSN=&&STKO,DISP=(OLD,DELETE)
//STACK   EXEC PGM=*.STKL.SYSLMOD,COND=((5,LT,STKC),(5,LT,STKL))
//SYSOUT   DD SYSOUT=*
//RECS     DD DSN=&&RECS,DISP=(,PASS),UNIT=SYSDA,SPACE=(TRK,(30,15)),
//         DCB=(RECFM=FB,LRECL={rl},BLKSIZE={rl * (6000 // rl)})
//CARDS    DD DATA,DLM=@@
""" + '\n'.join(deck) + "\n@@\n"


def define(name, rl, kl, ko, nrec, aix=None):
    """IDCAMS statements: (re)define the KSDS CARDDEMO.name.KSDS (and its alternate index and path)"""
    dsn = f'CARDDEMO.{name}.KSDS'
    ctl = f""" DELETE {dsn} CLUSTER
 SET MAXCC = 0
 DEFINE CLUSTER (NAME({dsn}) -
        VOLUMES({VOL}) TRACKS({max(2, nrec * rl // 15000 + 2)} 5) KEYS({kl} {ko}) -
        RECORDSIZE({rl} {rl}) SHAREOPTIONS(2 3) INDEXED) -
   DATA (NAME({dsn}.DATA)) -
   INDEX (NAME({dsn}.INDEX))
"""
    if aix:
        a = f'CARDDEMO.{name}.AIX'
        ctl += f""" DEFINE ALTERNATEINDEX (NAME({a}) -
        RELATE({dsn}) -
        KEYS({aix[0]} {aix[1]}) NONUNIQUEKEY UPGRADE -
        RECORDSIZE({aix[2]} {aix[2]}) VOLUMES({VOL}) TRACKS(5 5)) -
   DATA (NAME({a}.DATA)) -
   INDEX (NAME({a}.INDEX))
 DEFINE PATH (NAME(CARDDEMO.{name}.PATH) -
        PATHENTRY({a}))
"""
    return ctl


def job_data(src):
    jobs = []
    for name, rl, kl, ko, f, aix in FILES:
        dsn = f'CARDDEMO.{name}.KSDS'
        recs = data_lines(src, f, rl)
        if name == 'TRANSACT':   # posted transactions: processing time = origin time (the sample has it blank)
            recs = [r[:304] + r[278:304] + r[330:] if not r[304:330].strip() else r for r in recs]
        n = (rl + 79) // 80
        j = JOBCARD.format(name='CDL' + name[:5]) + f"""//DEFINE  EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//SYSIN    DD *
{define(name, rl, kl, ko, len(recs), aix)}/*
""" + stack_steps(rl, n, card_deck(recs, n)) + f"""//LOAD    EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//IN       DD DSN=&&RECS,DISP=(OLD,DELETE)
//SYSIN    DD *
 REPRO INFILE(IN) OUTDATASET({dsn})
"""
        j += '/*\n'
        if aix:
            j += ("//INDEX   EXEC PGM=IDCAMS\n//SYSPRINT DD SYSOUT=*\n//SYSIN    DD *\n"
                  f" BLDINDEX INDATASET({dsn}) -\n          OUTDATASET(CARDDEMO.{name}.AIX)\n/*\n")
        jobs.append((j, f'NUMBER OF RECORDS PROCESSED WAS {len(recs)}'))
    return jobs


def paut_records(src):
    """the pending authorizations of the IMS unload file (DFSURGU0 format: a 2-byte length, then for each segment
    its code, length and name and the segment data from offset 39): summaries (100 bytes, key the packed account
    number) and details (the account number, then the 200-byte segment: key account number and PAUT9CTS)"""
    d = open(os.path.join(src, APPDIR['COPAUS0C'], 'data/EBCDIC/AWS.M2.CARDDEMO.IMSDATA.DBPAUTP0.dat'), 'rb').read()
    i, summ, det, acct = 0, [], [], None
    while i < len(d):
        n = int.from_bytes(d[i:i + 2], 'big'); r = d[i:i + n]; i += n
        if r[10:18] == 'PAUTSUM0'.encode('cp037') and n == 140:
            acct = r[39:45]; summ.append(r[39:139])
        elif r[10:18] == 'PAUTDTL1'.encode('cp037') and n == 240:
            det.append(acct + r[39:239])
    return sorted(summ), sorted(det)


def job_paut(src):
    """PAUTSUM and PAUTDTL from the IMS unload (binary: in hexadecimal on the cards, CDUNHEX makes the 206-byte
    records, IEBGENER cuts the summaries to 100), and AUTHFRDS, the fraud reports, with one record that no
    authorization has (an empty KSDS cannot be opened for update)"""
    summ, det = paut_records(src)
    jobs = []
    for name, rl, kl, recs in (('PAUTSUM', 100, 6, summ), ('PAUTDTL', 206, 14, det)):
        cards = []
        for r in recs:
            h = r.ljust(206, b'\0').hex().upper().ljust(480, '0')
            cards += [h[k:k + 80] for k in range(0, 480, 80)]
        dsn = f'CARDDEMO.{name}.KSDS'
        j = JOBCARD.format(name='CDL' + name[:5]) + f"""//DEFINE  EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//SYSIN    DD *
{define(name, rl, kl, 0, len(recs))}/*
//UNHEX   EXEC PGM=CDUNHEX
//STEPLIB  DD DSN=CARDDEMO.LOADLIB,DISP=SHR
//SYSOUT   DD SYSOUT=*
//BINOUT   DD DSN=&&BIN,DISP=(NEW,PASS),UNIT=SYSDA,
//         SPACE=(TRK,(20,10)),
//         DCB=(RECFM=F,LRECL=206,BLKSIZE=206)
//HEXIN    DD *
""" + '\n'.join(cards) + '\n/*\n'
        if rl < 206:
            j += f"""//CUT     EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSUT1   DD DSN=&&BIN,DISP=(OLD,DELETE)
//SYSUT2   DD DSN=&&RECS,DISP=(NEW,PASS),UNIT=SYSDA,
//         SPACE=(TRK,(20,10)),
//         DCB=(RECFM=F,LRECL={rl},BLKSIZE={rl})
//SYSIN    DD *
  GENERATE MAXFLDS=1
  RECORD FIELD=({rl},1,,1)
/*
"""
        j += f"""//LOAD    EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//IN       DD DSN={'&&RECS' if rl < 206 else '&&BIN'},DISP=(OLD,DELETE)
//SYSIN    DD *
 REPRO INFILE(IN) OUTDATASET({dsn})
/*
"""
        jobs.append((j, f'NUMBER OF RECORDS PROCESSED WAS {len(recs)}'))
    rl = dlivsam.FRDS_LEN
    rec = ('9' * 16 + '9999-12-31-23.59.59.999999').ljust(rl)
    n = (rl + 79) // 80
    j = JOBCARD.format(name='CDLAUTHF') + f"""//DEFINE  EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//SYSIN    DD *
{define('AUTHFRDS', rl, 42, 0, 1)}/*
""" + stack_steps(rl, n, card_deck([rec], n)) + """//LOAD    EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//IN       DD DSN=&&RECS,DISP=(OLD,DELETE)
//SYSIN    DD *
 REPRO INFILE(IN) OUTDATASET(CARDDEMO.AUTHFRDS.KSDS)
/*
"""
    jobs.append((j, 'NUMBER OF RECORDS PROCESSED WAS 1'))
    return jobs


COBSTEP = """//{s}C   EXEC PGM=IKFCBL00,REGION=4096K,
//            PARM='LOAD,NODECK,SUPMAP,SIZE=2048K,BUF=1024K,LIB'
//STEPLIB  DD DSN=SYSC.LINKLIB,DISP=SHR
//SYSPRINT DD SYSOUT=*
//SYSPUNCH DD DUMMY
//SYSLIB   DD DSN=CARDDEMO.COPYLIB,DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT2   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT3   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT4   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSLIN   DD DSN=&&OBJ{s},DISP=(,PASS),UNIT=SYSDA,SPACE=(80,(500,100))
//SYSIN    DD DSN=CARDDEMO.COBOL({m}),DISP=SHR
//{s}L   EXEC PGM=IEWL,PARM='LIST,XREF,LET{ncal}',COND=(5,LT,{s}C)
//SYSPRINT DD SYSOUT=*
//SYSLIB   DD DSN=SYSC.COBLIB,DISP=SHR
//         DD DSN=CARDDEMO.SUBLIB,DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(1024,(200,20))
//SYSLMOD  DD DSN=CARDDEMO.{lib}({m}),DISP=SHR
//SYSLIN   DD DSN=&&OBJ{s},DISP=(OLD,DELETE)
"""


def job_cobol(name, members, lib, ncal=False):
    j = JOBCARD.format(name=name)
    for i, m in enumerate(members):
        j += COBSTEP.format(s=f'S{i:02d}', m=m, lib=lib, ncal=',NCAL' if ncal else '')
    return j


KIKCOB = """//{s}A   EXEC PGM=KIKPPCOB,PARM='-v -t -dmapin1'
//STEPLIB  DD DSN=KICKS.KICKSSYS.V1R5M0.SKIKLOAD,DISP=SHR
//SYSPRINT DD DSN=&&PP1,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(800,(800,100),RLSE),
//            DCB=(RECFM=FB,LRECL=80,BLKSIZE=800)
//SYSTERM  DD SYSOUT=*,DCB=(BLKSIZE=120,RECFM=F)
//SYSLIB   DD DSN=CARDDEMO.COPYLIB,DISP=SHR
//         DD DSN=KICKS.KICKSSYS.V1R5M0.COBCOPY,DISP=SHR
//SYSIN    DD DSN=CARDDEMO.COBOL({m}),DISP=SHR
//{s}B   EXEC PGM=IKFCBL00,REGION=4096K,COND=(5,LT,{s}A),
// PARM='DMAP,SOURCE,NOCLIST,NODECK,NOLOAD,SIZE=2048K,BUF=1024K,LIB'
//STEPLIB  DD DSN=SYSC.LINKLIB,DISP=SHR
//SYSPRINT DD DSN=&&DMAP,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(1210,(900,100),RLSE),
//            DCB=(RECFM=FB,LRECL=121,BLKSIZE=1210)
//SYSPUNCH DD DUMMY
//SYSLIB   DD DSN=CARDDEMO.COPYLIB,DISP=SHR
//         DD DSN=KICKS.KICKSSYS.V1R5M0.COBCOPY,DISP=SHR
//SYSLIN   DD UNIT=SYSDA,SPACE=(80,(250,100))
//SYSUT1   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT2   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT3   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT4   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSIN    DD DSN=&&PP1,DISP=(OLD,DELETE)
//{s}C   EXEC PGM=KIKPPCOB,COND=((5,LT,{s}A),(12,LT,{s}B)),
//            PARM='-t -dmapin2'
//STEPLIB  DD DSN=KICKS.KICKSSYS.V1R5M0.SKIKLOAD,DISP=SHR
//SYSPRINT DD DSN=&&PP2,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(800,(800,100),RLSE),
//            DCB=(RECFM=FB,LRECL=80,BLKSIZE=800)
//SYSTERM  DD SYSOUT=*,DCB=(BLKSIZE=120,RECFM=F)
//SYSLIB   DD DSN=CARDDEMO.COPYLIB,DISP=SHR
//         DD DSN=KICKS.KICKSSYS.V1R5M0.COBCOPY,DISP=SHR
//DMAPIN   DD DSN=&&DMAP,DISP=(OLD,DELETE)
//SYSIN    DD DSN=CARDDEMO.COBOL({m}),DISP=SHR
//{s}D   EXEC PGM=IKFCBL00,REGION=4096K,COND=((5,LT,{s}A),(5,LT,{s}C)),
//            PARM='NODECK,LOAD,SIZE=2048K,BUF=1024K,SUPMAP,LIB{opt}'
//STEPLIB  DD DSN=SYSC.LINKLIB,DISP=SHR
//SYSPRINT DD SYSOUT=*
//SYSPUNCH DD DUMMY
//SYSLIB   DD DSN=CARDDEMO.COPYLIB,DISP=SHR
//         DD DSN=KICKS.KICKSSYS.V1R5M0.COBCOPY,DISP=SHR
//SYSLIN   DD DSN=&&OBJ,DISP=(,PASS),UNIT=SYSDA,SPACE=(80,(500,100))
//SYSUT1   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT2   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT3   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSUT4   DD UNIT=SYSDA,SPACE=(460,(700,100))
//SYSIN    DD DSN=&&PP2,DISP=(OLD,DELETE)
//{s}E   EXEC PGM=IEWL,COND=((5,LT,{s}A),(5,LT,{s}D)),
//            PARM='LIST,XREF,LET,MAP'
//SYSPRINT DD SYSOUT=*
//SYSLIB   DD DSN=SYSC.COBLIB,DISP=SHR
//         DD DSN=CARDDEMO.SUBLIB,DISP=SHR
//SYSLMOD  DD DSN=CARDDEMO.KIKRPL,DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(1024,(200,20))
//SKIKLOAD DD DSN=KICKS.KICKSSYS.V1R5M0.SKIKLOAD,DISP=SHR
//SYSLIN   DD DSN=&&OBJ,DISP=(OLD,DELETE)
//         DD *
 INCLUDE SKIKLOAD(KIKCOBGL)
 ENTRY {m}
 NAME {m}(R)
/*
"""


def job_online(name, members):
    j = JOBCARD.format(name=name)
    for i, m in enumerate(members): j += KIKCOB.format(s=f'P{i:02d}', m=m, opt=os.environ.get('CDCOBOPT', ''))
    return j


KIKMAP = """//{s}A   EXEC PGM=KIKMG,PARM='-v -t -g=map'
//STEPLIB  DD DSN=KICKS.KICKSSYS.V1R5M0.SKIKLOAD,DISP=SHR
//SYSPRINT DD DSN=&&MAPOUT,DISP=(,PASS),UNIT=SYSDA,
//         DCB=(RECFM=FB,LRECL=80,BLKSIZE=800),SPACE=(TRK,(90,90),RLSE)
//SYSUT1   DD UNIT=SYSDA,SPACE=(TRK,(15,15)),DCB=(RECFM=U,BLKSIZE=800)
//SYSTERM  DD SYSOUT=*,DCB=(BLKSIZE=120,RECFM=F)
//SYSIN    DD DSN=CARDDEMO.BMS({m}),DISP=SHR
//{s}B   EXEC PGM=IFOX00,COND=(5,LT,{s}A),PARM='DECK,NOLIST'
//SYSLIB   DD DSN=SYS1.MACLIB,DISP=SHR
//SYSUT1   DD UNIT=SYSALLDA,SPACE=(CYL,(5,5))
//SYSUT2   DD UNIT=SYSALLDA,SPACE=(CYL,(5,5))
//SYSUT3   DD UNIT=SYSALLDA,SPACE=(CYL,(5,5))
//SYSPRINT DD SYSOUT=*
//SYSLIN   DD DUMMY
//SYSGO    DD DUMMY
//SYSPUNCH DD DSN=&&OBJSET,DISP=(,PASS),UNIT=SYSDA,SPACE=(TRK,(15,15))
//SYSIN    DD DSN=&&MAPOUT,DISP=(OLD,DELETE)
//{s}C   EXEC PGM=IEWL,COND=((5,LT,{s}A),(8,LT,{s}B)),
//            PARM='XREF,MAP,LET,NCAL'
//SYSLIN   DD DSN=&&OBJSET,DISP=(OLD,DELETE)
//SYSLMOD  DD DSN=CARDDEMO.KIKRPL({m}),DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(CYL,(2,1))
//SYSPRINT DD SYSOUT=*
//{s}D   EXEC PGM=KIKMG,COND=(5,LT,{s}A),PARM='-t -g=dsect -l=cobol'
//STEPLIB  DD DSN=KICKS.KICKSSYS.V1R5M0.SKIKLOAD,DISP=SHR
//SYSPRINT DD DSN=CARDDEMO.COPYLIB({m}),DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(TRK,(15,15)),DCB=(RECFM=U,BLKSIZE=800)
//SYSTERM  DD SYSOUT=*,DCB=(BLKSIZE=120,RECFM=F)
//SYSIN    DD DSN=CARDDEMO.BMS({m}),DISP=SHR
"""


def job_maps(name, mapsets):
    j = JOBCARD.format(name=name)
    for i, m in enumerate(mapsets): j += KIKMAP.format(s=f'M{i:02d}', m=m)
    return j


def asm_job(name, member, source, lib):
    return JOBCARD.format(name=name) + f"""//ASM     EXEC PGM=IFOX00,PARM='DECK,NOLIST'
//SYSLIB   DD DSN=SYS1.MACLIB,DISP=SHR
//         DD DSN=KICKS.KICKSSYS.V1R5M0.MACLIB,DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(CYL,(2,1))
//SYSUT2   DD UNIT=SYSDA,SPACE=(CYL,(2,1))
//SYSUT3   DD UNIT=SYSDA,SPACE=(CYL,(2,1))
//SYSPRINT DD SYSOUT=*
//SYSLIN   DD DUMMY
//SYSGO    DD DUMMY
//SYSPUNCH DD DSN=&&OBJSET,UNIT=SYSDA,SPACE=(80,(200,200)),DISP=(,PASS)
//SYSIN    DD *
{source}
/*
//LKED     EXEC PGM=IEWL,PARM='XREF,MAP,LET,NCAL',COND=(0,NE,ASM)
//SYSLIN   DD DSN=&&OBJSET,DISP=(OLD,DELETE)
//SYSLMOD  DD DSN={lib}({member}),DISP=SHR
//SYSUT1   DD UNIT=SYSDA,SPACE=(CYL,(2,1))
//SYSPRINT DD SYSOUT=*
"""


def table_src(kind, base_lines, extra):
    """the KICKS table of suffix 1$ (from KICKS.KICKSSYS.V1R5M0.INSTLIB) with suffix CD and CardDemo's entries"""
    src = []
    inside = False
    for l in base_lines:
        if l.startswith('//SYSIN'): inside = True; continue
        if inside and l.startswith('/*'): break
        if inside: src.append(l)
    src = [l.replace('SUFFIX=1$', 'SUFFIX=CD') for l in src]
    fin = next(i for i, l in enumerate(src) if f'{kind} TYPE=FINAL' in l)
    return '\n'.join(src[:fin] + extra + src[fin:])


def clist(kicks_clist):
    """SYS1.CMDPROC(CARDDEMO): the KICKS CLIST with CardDemo's tables, files and first transaction"""
    t = '\n'.join(kicks_clist)
    # FFREEKB(YES): every screen unlocks the keyboard, also a SEND without FREEKB
    t = t.replace('FFREEKB()', 'FFREEKB(YES)').replace('PLTPI() PLTSD()', 'PLTPI(CC00) PLTSD()').replace('PCT() PPT() FCT()', 'PCT(CD) PPT(CD) FCT(CD)')
    # the CALL parameter is cut at 100 characters: leave out the empty DCT/OPID/FCP overrides
    t = t.replace('PCT=&PCT PPT=&PPT FCT=&FCT DCT=&DCT OPID=&OPID TCP=&TCP +\nFCP=&FCP PLTPI=',
                  'PCT=&PCT PPT=&PPT FCT=&FCT TCP=&TCP +\nPLTPI=')
    assert 'PLTPI(CC00)' in t and 'FFREEKB(YES)' in t and 'FCT=&FCT TCP=&TCP +' in t and 'PCT(CD) PPT(CD) FCT(CD)' in t
    # CardDemo load libraries in front of the KICKS ones
    t = t.replace("ALLOC FILE(SKIKLOAD) DSN('&TSOID..KICKS.&VER..SKIKLOAD' +", "ALLOC FILE(SKIKLOAD) DSN('CARDDEMO.SKIKLOAD' +\n                          '&TSOID..KICKS.&VER..SKIKLOAD' +")
    t = t.replace("ALLOC FILE(KIKRPL)   DSN('&TSOID..KICKS.&VER..KIKRPL' +", "ALLOC FILE(KIKRPL)   DSN('CARDDEMO.KIKRPL' +\n                          '&TSOID..KICKS.&VER..KIKRPL' +")
    assert t.count("'CARDDEMO.") == 2
    # files: free and allocate CardDemo's next to the sample files
    frees = '\n'.join(f' FREE  FI({f})' for f, _, _ in KFILES)
    allocs = '\n'.join(f" ALLOC FI({f:<8}) DA('{d}') SHR" for f, d, _ in KFILES)
    t = t.replace(" FREE  FI(TACDATA)\n", frees + "\n FREE  FI(TACDATA)\n")
    t = t.replace(" ALLOC FI(TACDATA) DA('&KIKID..KICKS.TACDATA')        SHR\n",
                  allocs + "\n ALLOC FI(TACDATA) DA('&KIKID..KICKS.TACDATA')        SHR\n")
    assert t.count('CARDDEMO.ACCTDATA.KSDS') == 1 and t.count(' FREE  FI(ACCTDAT)') == 2
    return t.splitlines()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mvsce', required=True); ap.add_argument('--src', required=True); ap.add_argument('--out')
    ap.add_argument('--herc', default=os.path.expanduser('~/herc-native/bin')); ap.add_argument('--base')
    ap.add_argument('--stages', default='vol,libs,src,data,helpers,maps,online,batch,tables,clist,rakf')
    ap.add_argument('--keep-going', action='store_true')
    ap.add_argument('--only', default='', help='online/batch programs to (re)build, default all')
    a = ap.parse_args()
    d = os.path.abspath(a.mvsce); herc = os.path.abspath(a.herc); src = os.path.abspath(a.src)
    stages = a.stages.split(',')
    work = os.path.join(d, 'carddemo-work'); os.makedirs(work, exist_ok=True)
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.join(os.path.dirname(herc), 'lib'))
    vol = os.path.join(d, 'DASD/cardd0.3350')
    if 'vol' in stages:
        if os.path.exists(vol): os.remove(vol)
        subprocess.run([os.path.join(herc, 'dasdinit'), '-z', '-a', vol, '3350', '111111'], env=env, check=True, stdout=subprocess.DEVNULL)
    cnf = os.path.join(d, 'conf/local.cnf'); c = open(cnf).read()
    online = [p for p, _ in ONLINE if not a.only or p in a.only.split(',')]
    batch = [p for p in BATCH if not a.only or p in a.only.split(',')]

    # conversion (host side)
    conv = os.path.join(work, 'conv'); os.makedirs(conv, exist_ok=True)
    cobol, failed = {}, []
    cob2ans.MAPDIRS[:] = [os.path.join(src, d, 'cpy-bms') for d in APPDIRS]
    for p in online + batch:
        try:
            lines, g = cob2ans.convert(app_file(src, 'cbl', p), [os.path.join(src, d, 'cpy') for d in APPDIRS],
                                       fixes=fixes.FIXES.get(p))
            cobol[p] = lines
            open(os.path.join(conv, p + '.cbl'), 'w').write('\n'.join(lines) + '\n')
        except cob2ans.CvtError as e:
            failed.append((p, str(e))); print(f'convert {p}: {e}', flush=True)
    if failed and not a.keep_going: raise SystemExit('conversion failed')
    online = [p for p in online if p in cobol]; batch = [p for p in batch if p in cobol]
    helpers = {h: open(os.path.join(HERE, 'carddemo/helpers', h + '.cbl')).read().splitlines() for h in HELPERS + TOOLS}
    mapsets = maps_for(online, src)
    bms = {}
    for m in mapsets:
        lines = open(app_file(src, 'bms', m), encoding='latin-1').read().splitlines()
        bms[m] = fix_bms([l.rstrip().replace('&&SYSPARM', '&SYSPARM')[:80] for l in lines])
    print(f'online {online}\nbatch {batch}\nmaps {mapsets}', flush=True)

    jobs = []   # (jcl, expect)
    if 'libs' in stages: jobs.append((job_libs(), None))
    if 'src' in stages:
        if 'libs' not in stages: jobs.append((job_libs(['COBOL', 'ORIGCBL', 'BMS'], 'CDRELIB'), None))
        nw = True
        jobs.append((iebupdte('CDSRC1', 'CARDDEMO.COBOL', {**cobol, **helpers}, nw), None))
        jobs.append((iebupdte('CDSRC2', 'CARDDEMO.BMS', bms, nw), None))
        orig = {p: [l.rstrip()[:80] for l in open(app_file(src, 'cbl', p), encoding='latin-1').read().splitlines()]
                for p in online + batch}
        jobs.append((iebupdte('CDSRC3', 'CARDDEMO.ORIGCBL', orig, nw), None))
    if 'data' in stages: jobs += job_data(src)
    if 'helpers' in stages: jobs.append((job_cobol('CDHELP', HELPERS, 'SUBLIB', ncal=True), None))
    if 'maps' in stages:
        for m in mapsets: jobs.append((job_maps('M' + m, [m]), None))
    if 'online' in stages:
        for m in online: jobs.append((job_online('P' + m[:7], [m]), None))
    if 'batch' in stages:
        jobs.append((job_cobol('CDBATCH', batch + TOOLS, 'LOADLIB'), None))
    if 'data' in stages: jobs += job_paut(src)     # after the batch stage: CDUNHEX loads them
    ex = os.path.join(work, 'x')
    if 'tables' in stages or 'clist' in stages or 'rakf' in stages:
        for dsn in ('KICKS.KICKSSYS.V1R5M0.INSTLIB', 'KICKS.KICKSSYS.V1R5M0.CLIST'):
            ki.pdsu(herc, os.path.join(d, 'DASD/kicks0.3350'), dsn, os.path.join(ex, dsn))
        ki.pdsu(herc, os.path.join(d, 'DASD/mvs000.3350'), 'SYS1.SECURE.CNTL', os.path.join(ex, 'SECURE'))
    if 'tables' in stages:
        il = os.path.join(ex, 'KICKS.KICKSSYS.V1R5M0.INSTLIB')
        ppt = [f'         KIKPPT TYPE=ENTRY,PROGRAM={p},PGMLANG=CMDLVL' for p in [x for x, _ in ONLINE] + [p for _, p in OTHER_TRANS]]
        ppt += [f'         KIKPPT TYPE=ENTRY,PROGRAM={m},USAGE=MAP' for m in maps_for([x for x, _ in ONLINE], src)]
        pct = [f'         KIKPCT TYPE=ENTRY,TRANSID={t},PROGRAM={p}' for p, t in ONLINE if t] + \
              [f'         KIKPCT TYPE=ENTRY,TRANSID={t},PROGRAM={p}' for t, p in OTHER_TRANS]
        fct = []
        for f, _, base in KFILES:
            fct.append(f'         KIKFCT TYPE=DATASET,DATASET={f}' + (f',BASE={base}' if base else ''))
        jobs.append((asm_job('CDPPT', 'KIKPPTCD', table_src('KIKPPT', ki.member(il, 'KIKPPT1$'), ppt), 'CARDDEMO.SKIKLOAD'), None))
        jobs.append((asm_job('CDPCT', 'KIKPCTCD', table_src('KIKPCT', ki.member(il, 'KIKPCT1$'), pct), 'CARDDEMO.SKIKLOAD'), None))
        jobs.append((asm_job('CDFCT', 'KIKFCTCD', table_src('KIKFCT', ki.member(il, 'KIKFCT1$'), fct), 'CARDDEMO.SKIKLOAD'), None))
    if 'clist' in stages:
        cl = clist(ki.member(os.path.join(ex, 'KICKS.KICKSSYS.V1R5M0.CLIST'), 'KICKS'))
        cl = [l.replace('TCP(2$)', 'TCP(1$)') for l in cl]
        jobs.append((gener('CDCLIST', 'SYS1.CMDPROC(CARDDEMO)', cl), None))
        jobs.append((gener('CDJCL', 'CARDDEMO.JCL(READALL)', READALL.splitlines()), None))
    if 'rakf' in stages:
        prof = ki.rakf_add(ki.member(os.path.join(ex, 'SECURE'), 'PROFILES'), ['CARDDEMO.*', 'UCCARDD0'])
        # ALTER: the transaction report job, which KICKS submits without a user (RAKF's default PROD account),
        # defines and deletes its work files and the report (with CARDDEMO.* UPDATE, a CARDDEMO.TRANREPT* ALTER
        # profile did not give that account ALTER: RAKF0005)
        prof = [l.replace('UPDATE', 'ALTER ') if l.split()[:2] == ['DATASET', 'CARDDEMO.*'] else l
                for l in prof if not (l.split()[:2] and l.split()[1].startswith('CARDDEMO.TRANREPT'))]
        jobs.append((ki.iebupdte('RAKFCARD', 'SYS1.SECURE.CNTL', 'PROFILES', prof), None))
    open(os.path.join(work, 'jobs.jcl'), 'w').write('\n'.join(j for j, _ in jobs))
    for j, _ in jobs:
        for l in j.splitlines():
            if l.startswith('//') and len(l) > 71: raise SystemExit('JCL line longer than 71: ' + l)

    line = f'{UNIT}    3350    DASD/cardd0.3350'
    if 'vol' in stages:      # attached after the IPL (ICKDSF), in the configuration from then on
        c = c.replace('\n' + line, ''); open(cnf, 'w').write(c)
    elif line not in c:
        raise SystemExit('no CARDD0 in conf/local.cnf: run the vol stage')
    log = open(os.path.join(work, 'session.log'), 'a')
    outdir = os.path.join(work, 'out'); os.makedirs(outdir, exist_ok=True)
    h = ki.Herc(d, herc, log)
    errors = []
    try:
        h.ipl()
        if 'vol' in stages: job_vol(h)
        for j, expect in jobs:
            try:
                out = run_job(h, j, outdir, expect=expect)
            except RuntimeError as e:
                errors.append(str(e)); print('FAILED', e, flush=True)
                if not a.keep_going: raise
        h.shutdown()
    except BaseException:
        h.kill(); raise
    finally:
        c = open(cnf).read()
        if line not in c and os.path.exists(vol):
            c = c.replace('0351    3350    DASD/kicks0.3350', '0351    3350    DASD/kicks0.3350\n' + line)
            assert 'cardd0' in c; open(cnf, 'w').write(c)
    if errors: print('errors:', *errors, sep='\n'); sys.exit(1)
    if a.out:
        out = os.path.abspath(a.out); os.makedirs(out, exist_ok=True)
        for v in ('mvsres.3350', 'mvs000.3350', 'cardd0.3350'):
            dst = os.path.join(out, v); shutil.copyfile(os.path.join(d, 'DASD', v), dst)
            if v == 'mvs000.3350':
                ext, n = ki.restore_dataset(os.path.join(os.path.abspath(a.base), v), dst, 'SYS1.HASPCKPT')
                print(f'{v}: SYS1.HASPCKPT {n} tracks restored', flush=True)
            subprocess.run([os.path.join(herc, 'cckdcomp'), dst], env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            r = subprocess.run([os.path.join(herc, 'cckdcdsk'), '-3', dst], env=env, capture_output=True, text=True)
            if r.returncode != 0: raise RuntimeError(f'cckdcdsk {v}: rc={r.returncode}')
            print(f'{v}: {os.path.getsize(dst)} bytes, cckdcdsk -3 ok', flush=True)
    print('CardDemo install ok', flush=True)


if __name__ == '__main__':
    main()
