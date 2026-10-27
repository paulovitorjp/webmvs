# SPDX-License-Identifier: Apache-2.0
"""Source changes for CardDemo programs before scripts/carddemo/cob2ans.py converts them: (old text, new text[, n])
tuples; old must match exactly n times (default 1) in the program after COPY members are expanded, or functions of
the program text."""
import dlivsam
import sqlvsam

# programs of this port (online menu options that run); the other menu options say "not available in this version"
PORTED = {'COACTVWC', 'COCRDLIC', 'COCRDSLC', 'COTRN00C', 'COTRN01C', 'COUSR00C', 'COUSR01C', 'COUSR02C', 'COUSR03C',
          'COTRN02C', 'COBIL00C', 'COACTUPC', 'COCRDUPC', 'CORPT00C', 'COTRTLIC', 'COTRTUPC', 'COPAUS0C',
          'COPAUS1C', 'COPAUS2C'}
NOT_AVAILABLE = 'is not available in this version'

ABEND = ("CALL 'CEE3ABD' USING ABCODE, TIMING.", "STOP RUN.")


def menu(programs):
    """menu table entries of programs not in PORTED -> DUMMYnnn (the menu programs' own 'not installed' path)"""
    return [(f"VALUE '{p}'.", f"VALUE 'DUMMY{i:03d}'.") for i, p in enumerate(programs) if p not in PORTED]


# CORPT00C writes this job to the JOBS queue, which CICS passes to the internal reader. KICKS has no such queue,
# but writes to the internal reader itself: SPOOLOPEN with WRITER('INTRDR'), SPOOLWRITE per line, and SPOOLCLOSE
# submits the job (the /*EOF line, which ends the job for the spooler, is not written). The original job uses a
# procedure library, symbolic names and the DFSORT INCLUDE statement, which MVS 3.8J does not have: here the
# transactions are unloaded with IDCAMS, CDTRFLT keeps those processed between the two dates (the INCLUDE), IDCAMS
# puts them in order of card number (a work KSDS with an alternate index on the card number, read through its path)
# and CBTRN03C writes the report to CARDDEMO.TRANREPT. The OS/360 sort on SYSCPK would do the ordering, but it
# needs 2314 work volumes, which the browser system does not have. The work files are unblocked, as the converted
# programs' files are (no BLOCK CONTAINS).
TRANREPT_JCL = """\
//TRNRPT00 JOB (1),TRANREPT,CLASS=A,MSGCLASS=A
//* CARDDEMO TRANSACTION REPORT, FROM CORPT00C
@FROM
@TO
//DELETE  EXEC PGM=IEFBR14
//OLD      DD DSN=CARDDEMO.TRANREPT,DISP=(MOD,DELETE),
//            UNIT=SYSDA,SPACE=(TRK,1)
//DATES   EXEC PGM=IEBGENER
//SYSPRINT DD SYSOUT=*
//SYSIN    DD DUMMY
//SYSUT2   DD DSN=&&DATES,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(TRK,1),
//            DCB=(RECFM=F,LRECL=80,BLKSIZE=80)
//SYSUT1   DD *
@DATES
/*
//UNLOAD  EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//IN       DD DSN=CARDDEMO.TRANSACT.KSDS,DISP=SHR
//OUT      DD DSN=&&TRAN,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(CYL,(2,1)),
//            DCB=(RECFM=F,LRECL=350,BLKSIZE=350)
//SYSIN    DD *
 REPRO INFILE(IN) OUTFILE(OUT)
/*
//FILTER  EXEC PGM=CDTRFLT
//STEPLIB  DD DSN=CARDDEMO.LOADLIB,DISP=SHR
//SYSOUT   DD SYSOUT=*
//TRANIN   DD DSN=&&TRAN,DISP=(OLD,DELETE)
//TRANOUT  DD DSN=&&SEL,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(CYL,(2,1)),
//            DCB=(RECFM=F,LRECL=350,BLKSIZE=350)
//DATEPARM DD DSN=&&DATES,DISP=(OLD,PASS)
//SORT    EXEC PGM=IDCAMS
//SYSPRINT DD SYSOUT=*
//SEL      DD DSN=&&SEL,DISP=(OLD,DELETE)
//DALY     DD DSN=&&DALY,DISP=(,PASS),UNIT=SYSDA,
//            SPACE=(CYL,(2,1)),
//            DCB=(RECFM=F,LRECL=350,BLKSIZE=350)
//SYSIN    DD *
 DELETE CARDDEMO.TRANREPT.WORK CLUSTER
 SET MAXCC = 0
 DEFINE CLUSTER (NAME(CARDDEMO.TRANREPT.WORK) -
        VOLUMES(CARDD0) TRACKS(30 15) KEYS(16 0) -
        RECORDSIZE(350 350) INDEXED) -
   DATA (NAME(CARDDEMO.TRANREPT.WORK.DATA)) -
   INDEX (NAME(CARDDEMO.TRANREPT.WORK.INDEX))
 DEFINE ALTERNATEINDEX (NAME(CARDDEMO.TRANREPT.WORKAIX) -
        RELATE(CARDDEMO.TRANREPT.WORK) -
        KEYS(16 262) NONUNIQUEKEY NOUPGRADE -
        CONTROLINTERVALSIZE(4096) -
        RECORDSIZE(37 4089) VOLUMES(CARDD0) TRACKS(5 5)) -
   DATA (NAME(CARDDEMO.TRANREPT.WORKAIX.DATA)) -
   INDEX (NAME(CARDDEMO.TRANREPT.WORKAIX.INDEX))
 DEFINE PATH (NAME(CARDDEMO.TRANREPT.WORKPATH) -
        PATHENTRY(CARDDEMO.TRANREPT.WORKAIX))
 REPRO INFILE(SEL) OUTDATASET(CARDDEMO.TRANREPT.WORK)
 BLDINDEX INDATASET(CARDDEMO.TRANREPT.WORK) -
        OUTDATASET(CARDDEMO.TRANREPT.WORKAIX)
 REPRO INDATASET(CARDDEMO.TRANREPT.WORKPATH) OUTFILE(DALY)
 DELETE CARDDEMO.TRANREPT.WORK CLUSTER
/*
//REPORT  EXEC PGM=CBTRN03C
//STEPLIB  DD DSN=CARDDEMO.LOADLIB,DISP=SHR
//SYSOUT   DD SYSOUT=*
//TRANFILE DD DSN=&&DALY,DISP=(OLD,DELETE)
//CARDXREF DD DSN=CARDDEMO.CARDXREF.KSDS,DISP=SHR
//TRANTYPE DD DSN=CARDDEMO.TRANTYPE.KSDS,DISP=SHR
//TRANCATG DD DSN=CARDDEMO.TRANCATG.KSDS,DISP=SHR
//DATEPARM DD DSN=&&DATES,DISP=(OLD,PASS)
//TRANREPT DD DSN=CARDDEMO.TRANREPT,DISP=(NEW,CATLG),
//            UNIT=3350,VOL=SER=CARDD0,
//            SPACE=(TRK,(15,15),RLSE),
//            DCB=(RECFM=F,LRECL=133,BLKSIZE=133)
/*EOF"""
TRANREPT_OLD = """\
   05 FILLER                     PIC X(80) VALUE
   "//TRNRPT00 JOB 'TRAN REPORT',CLASS=A,MSGCLASS=0,".
   05 FILLER                     PIC X(80) VALUE
   "// NOTIFY=&SYSUID".
   05 FILLER                     PIC X(80) VALUE
   "//*".
   05 FILLER                     PIC X(80) VALUE
   "//JOBLIB JCLLIB ORDER=('AWS.M2.CARDDEMO.PROC')".
   05 FILLER                     PIC X(80) VALUE
   "//*".
   05 FILLER                     PIC X(80) VALUE
   "//STEP10 EXEC PROC=TRANREPT".
   05 FILLER                     PIC X(80) VALUE
   "//*".
   05 FILLER                     PIC X(80) VALUE
   "//STEP05R.SYMNAMES DD *".
   05 FILLER                     PIC X(80) VALUE
   "TRAN-CARD-NUM,263,16,ZD".
   05 FILLER                     PIC X(80) VALUE
   "TRAN-PROC-DT,305,10,CH".
   05 FILLER-1.
      10 FILLER                  PIC X(18) VALUE
   "PARM-START-DATE,C'".
      10 PARM-START-DATE-1       PIC X(10) VALUE SPACES.
      10 FILLER                  PIC X(52) VALUE "'".
   05 FILLER-2.
      10 FILLER                  PIC X(16) VALUE
   "PARM-END-DATE,C'".
      10 PARM-END-DATE-1         PIC X(10) VALUE SPACES.
      10 FILLER                  PIC X(54) VALUE "'".
   05 FILLER                     PIC X(80) VALUE
   "/*".
   05 FILLER                     PIC X(80) VALUE
   "//STEP10R.DATEPARM DD *".
   05 FILLER-3.
      10 PARM-START-DATE-2       PIC X(10) VALUE SPACES.
      10 FILLER                  PIC X VALUE SPACE.
      10 PARM-END-DATE-2         PIC X(10) VALUE SPACES.
      10 FILLER                  PIC X(59) VALUE SPACES.
   05 FILLER                     PIC X(80) VALUE
   "/*".
   05 FILLER                     PIC X(80) VALUE
   "/*EOF"."""


def job_data(jcl):
    """JCL lines -> the FILLER items of JOB-DATA-1 (@FROM, @TO: comment lines with the dates; @DATES: the date card)"""
    out = []
    def part(lead, name):
        return (f"05 FILLER-{name[-1]}. 10 FILLER PIC X({len(lead)}) VALUE '{lead}'.\n  10 {name} PIC X(10) VALUE SPACES.\n"
                f"  10 FILLER PIC X({70 - len(lead)}) VALUE SPACES.")
    for l in jcl.split('\n'):
        if l == '@FROM': out.append(part('//* FROM ', 'PARM-START-DATE-1'))
        elif l == '@TO': out.append(part('//* TO ', 'PARM-END-DATE-1').replace('FILLER-1.', 'FILLER-2.'))
        elif l == '@DATES':
            out.append('05 FILLER-3.\n  10 PARM-START-DATE-2 PIC X(10) VALUE SPACES.\n  10 FILLER PIC X VALUE SPACE.\n'
                       '  10 PARM-END-DATE-2 PIC X(10) VALUE SPACES.\n  10 FILLER PIC X(59) VALUE SPACES.')
        else:
            assert len(l) <= 58 and "'" not in l, l
            out.append(f"05 FILLER PIC X(80) VALUE\n    '{l}'.")
    return '\n'.join(out)


FIXES = {
    'CORPT00C': [(TRANREPT_OLD, job_data(TRANREPT_JCL)),
                 ("05 JCL-RECORD PIC X(80) VALUE ' '.",
                  "05 JCL-RECORD PIC X(80) VALUE ' '.\n05 CD-SPOOL-TOKEN PIC X(8) VALUE SPACES.\n"
                  "05 CD-SPOOL-NODE PIC X(8) VALUE '*'.\n05 CD-SPOOL-WRITER PIC X(8) VALUE 'INTRDR'."),
                 ("SET END-LOOP-NO TO TRUE",
                  "SET END-LOOP-NO TO TRUE IF NOT ERR-FLG-ON EXEC CICS SPOOLOPEN OUTPUT TOKEN(CD-SPOOL-TOKEN) "
                  "NODE(CD-SPOOL-NODE) WRITER(CD-SPOOL-WRITER) RESP(WS-RESP-CD) RESP2(WS-REAS-CD) END-EXEC "
                  "PERFORM CD-SPOOL-CHECK END-IF"),
                 ("PERFORM WIRTE-JOBSUB-TDQ END-PERFORM END-IF.",
                  "IF NOT END-LOOP-YES PERFORM WIRTE-JOBSUB-TDQ PERFORM CD-SPOOL-CHECK END-IF END-PERFORM "
                  "IF NOT ERR-FLG-ON EXEC CICS SPOOLCLOSE TOKEN(CD-SPOOL-TOKEN) RESP(WS-RESP-CD) "
                  "RESP2(WS-REAS-CD) END-EXEC PERFORM CD-SPOOL-CHECK END-IF END-IF."),
                 ("EXEC CICS WRITEQ TD QUEUE ('JOBS') FROM (JCL-RECORD) LENGTH (LENGTH OF JCL-RECORD) "
                  "RESP(WS-RESP-CD) RESP2(WS-REAS-CD) END-EXEC.",
                  "EXEC CICS SPOOLWRITE TOKEN(CD-SPOOL-TOKEN) FROM(JCL-RECORD) FLENGTH(80) "
                  "RESP(WS-RESP-CD) RESP2(WS-REAS-CD) END-EXEC. CD-SPOOL-CHECK."),
                 ("'Unable to Write TDQ (JOBS)...'", "'Unable to submit the report job...'"),
                 # the table of JCL lines REDEFINES the job: as many lines, not 1000
                 ('05 JOB-LINES OCCURS 1000 TIMES PIC X(80).',
                  f"05 JOB-LINES OCCURS {len(TRANREPT_JCL.splitlines())} TIMES PIC X(80).")],
    'CBACT02C': [ABEND], 'CBACT03C': [ABEND], 'CBCUS01C': [ABEND],
    # no transaction between the dates: at the end of the (empty) file the record area has no amount to add
    'CBTRN03C': [ABEND, ("DISPLAY 'WS-PAGE-TOTAL' WS-PAGE-TOTAL ADD TRAN-AMT",
                         "DISPLAY 'WS-PAGE-TOTAL' WS-PAGE-TOTAL "
                         "IF TRAN-AMT NOT NUMERIC MOVE ZERO TO TRAN-AMT END-IF ADD TRAN-AMT")],
    'COMEN01C': menu(['COACTVWC', 'COACTUPC', 'COCRDLIC', 'COCRDSLC', 'COCRDUPC', 'COTRN00C', 'COTRN01C',
                      'COTRN02C', 'CORPT00C', 'COBIL00C', 'COPAUS0C']) + [
        # 11 menu entries: the table REDEFINES 11 entries, not 12
        ('10 CDEMO-MENU-OPT OCCURS 12 TIMES.', '10 CDEMO-MENU-OPT OCCURS 11 TIMES.'),
        ("DELIMITED BY SPACE 'is coming soon ...' DELIMITED BY SIZE",
         f"DELIMITED BY '  ' ' {NOT_AVAILABLE}' DELIMITED BY SIZE")],
    'COADM01C': menu(['COUSR00C', 'COUSR01C', 'COUSR02C', 'COUSR03C', 'COTRTLIC', 'COTRTUPC']) + [
        ('10 CDEMO-ADMIN-OPT OCCURS 9 TIMES.', '10 CDEMO-ADMIN-OPT OCCURS 6 TIMES.'),
        ("'is not installed ...'", f"'{NOT_AVAILABLE}'", 2),
        # the transaction types are in a VSAM file here (sqlvsam.py)
        ("'Transaction Type List/Update (Db2) '", "'Transaction Type List/Update (VSAM)'"),
        ("'Transaction Type Maintenance (Db2) '", "'Transaction Type Maintenance (VSAM)'")],
    # the Db2 IN list of the keys to delete (not used): no VALUE in a table, which this COBOL does not allow
    'COTRTLIC': [sqlvsam.to_vsam,
                 ("20 WS-TYPE-CD-DELETE-KEYS OCCURS 7 TIMES. 25 FILLER PIC X(01) VALUE QUOTE. "
                  "25 WS-TYPE-CD-DELETE-KEY PIC X(02) VALUE SPACES. 25 FILLER PIC X(01) VALUE QUOTE. "
                  "25 FILLER PIC X(01) VALUE ','.",
                  "20 WS-TYPE-CD-DELETE-KEYS OCCURS 7 TIMES.\n25 FILLER PIC X(01).\n"
                  "25 WS-TYPE-CD-DELETE-KEY PIC X(02).\n25 FILLER PIC X(01).\n25 FILLER PIC X(01).")],
    'COTRTUPC': [sqlvsam.to_vsam, ('10 WS-EDIT-DATE-X REDEFINES WS-EDIT-DATE-X PIC 9(10).',
                                   '10 WS-EDIT-DATE-X9 REDEFINES WS-EDIT-DATE-X PIC 9(10).')],
    # pending authorizations: IMS and Db2 upstream, VSAM files here (dlivsam.py); COPAUS1C looks the decline reason
    # up in a table of 10 with a loop (SEARCH ALL)
    'COPAUS0C': [dlivsam.to_vsam], 'COPAUS1C': [dlivsam.to_vsam, (dlivsam.SEARCH_OLD, dlivsam.SEARCH_NEW)],
    'COPAUS2C': [dlivsam.frds_to_vsam],
    # sign-on screen after a key it does not take: the cursor goes back to the User ID field, and the message is
    # only for Clear, PA1, PA3 and the PF keys: the browser terminal sends PA2 (redisplay) when KICKS starts
    # KICKS: one FORMATTIME per format (the date with DATESEP, then the time with TIMESEP)
    'COBIL00C': [("EXEC CICS FORMATTIME ABSTIME(WS-ABS-TIME) YYYYMMDD(WS-CUR-DATE-X10) DATESEP('-') "
                  "TIME(WS-CUR-TIME-X08) TIMESEP(':') END-EXEC",
                  "EXEC CICS FORMATTIME ABSTIME(WS-ABS-TIME) YYYYMMDD(WS-CUR-DATE-X10) DATESEP('-') END-EXEC "
                  "EXEC CICS FORMATTIME ABSTIME(WS-ABS-TIME) TIME(WS-CUR-TIME-X08) TIMESEP(':') END-EXEC")],
    # two items named WS-EDIT-DATE-X (the second redefines the first): the second gets its own name (also COTRTUPC)
    'COACTUPC': [('10 WS-EDIT-DATE-X REDEFINES WS-EDIT-DATE-X PIC 9(10).',
                  '10 WS-EDIT-DATE-X9 REDEFINES WS-EDIT-DATE-X PIC 9(10).')],
    'COSGN00C': [("MOVE CCDA-MSG-INVALID-KEY TO WS-MESSAGE PERFORM SEND-SIGNON-SCREEN",
                  "MOVE -1 TO USERIDL OF COSGN0AI MOVE 'N' TO WS-ERR-FLG IF " + ' OR '.join(
                      f'EIBAID = {k}' for k in ['DFHCLEAR', 'DFHPA1', 'DFHPA3']
                      + [f'DFHPF{i}' for i in range(1, 25)])
                  + " MOVE 'Y' TO WS-ERR-FLG MOVE CCDA-MSG-INVALID-KEY TO WS-MESSAGE END-IF"
                  " PERFORM SEND-SIGNON-SCREEN")],
}
