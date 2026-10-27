# SPDX-License-Identifier: Apache-2.0
"""The pending authorization programs (COPAUS0C, COPAUS1C, COPAUS2C) on VSAM instead of IMS and Db2.

Upstream keeps the pending authorizations in the IMS HIDAM database DBPAUTP0: a summary segment PAUTSUM0 per
account (key ACCNTID, the packed account number) with its detail segments PAUTDTL1 (key PAUT9CTS, the complemented
date and time, so the newest comes first). MVS 3.8J has no IMS: here they are two KSDS files, PAUTSUM (the
100-byte summaries, key the account number) and PAUTDTL (the account number then the 200-byte detail, key the
account number and PAUT9CTS), loaded from the sample unload file. Each EXEC DLI call becomes a PERFORM of
KICKS file commands that sets DIBSTAT as IMS would: GU of the summary (by account) sets the parent; GNP reads the
next detail of that parent ('GE' after the last), or the one with a given key; REPL rewrites the detail; SCHD and
TERM have nothing to do. Fraud reports (COPAUS2C) go to the Db2 table AUTHFRDS upstream, here to the KSDS
AUTHFRDS (the DCLGEN record, key card number and authorization time); INSERT of a key that is there (-803) is
followed by the program's UPDATE of the fraud flag and date, as with Db2.
"""
import re

DIB = """
01 CDDLI-DIB.
  05 DIBSTAT PIC X(2) VALUE SPACES.
01 CDDLI-VARS.
  05 CDDLI-RESP PIC S9(8) COMP VALUE 0.
  05 CDDLI-I PIC S9(4) COMP VALUE 0.
  05 CDDLI-PARENT PIC X(6) VALUE LOW-VALUES.
  05 CDDLI-POS PIC X(8) VALUE LOW-VALUES.
  05 CDDLI-ACCT-G.
    10 CDDLI-ACCT-N PIC S9(11) COMP-3.
  05 CDDLI-SKEY PIC X(6).
  05 CDDLI-KEY.
    10 CDDLI-KEY-ACCT PIC X(6).
    10 CDDLI-KEY-TS PIC X(8).
  05 CDDLI-DREC.
    10 CDDLI-DREC-ACCT PIC X(6).
    10 CDDLI-DREC-SEG PIC X(200).
"""

PARAS = """
CDDLI-GU-SUM.
    MOVE PA-ACCT-ID TO CDDLI-ACCT-N
    MOVE CDDLI-ACCT-G TO CDDLI-SKEY
    EXEC CICS READ DATASET('PAUTSUM') INTO(PENDING-AUTH-SUMMARY) RIDFLD(CDDLI-SKEY) RESP(CDDLI-RESP) END-EXEC
    EVALUATE TRUE
      WHEN CDDLI-RESP = DFHRESP(NORMAL)
        MOVE SPACES TO DIBSTAT
        MOVE CDDLI-SKEY TO CDDLI-PARENT
        MOVE LOW-VALUES TO CDDLI-POS
      WHEN CDDLI-RESP = DFHRESP(NOTFND)
        MOVE 'GE' TO DIBSTAT
      WHEN OTHER
        MOVE 'AO' TO DIBSTAT
    END-EVALUATE.
CDDLI-GNP-DTL.
    MOVE CDDLI-PARENT TO CDDLI-KEY-ACCT
    MOVE CDDLI-POS TO CDDLI-KEY-TS
    MOVE 'GE' TO DIBSTAT
    EXEC CICS STARTBR DATASET('PAUTDTL') RIDFLD(CDDLI-KEY) GTEQ RESP(CDDLI-RESP) END-EXEC
    IF CDDLI-RESP = DFHRESP(NORMAL)
      EXEC CICS READNEXT DATASET('PAUTDTL') INTO(CDDLI-DREC) RIDFLD(CDDLI-KEY) RESP(CDDLI-RESP) END-EXEC
      IF CDDLI-RESP = DFHRESP(NORMAL) AND CDDLI-KEY-ACCT = CDDLI-PARENT AND CDDLI-KEY-TS = CDDLI-POS
        EXEC CICS READNEXT DATASET('PAUTDTL') INTO(CDDLI-DREC) RIDFLD(CDDLI-KEY) RESP(CDDLI-RESP) END-EXEC
      END-IF
      IF CDDLI-RESP = DFHRESP(NORMAL) AND CDDLI-KEY-ACCT = CDDLI-PARENT
        MOVE CDDLI-DREC-SEG TO PENDING-AUTH-DETAILS
        MOVE CDDLI-KEY-TS TO CDDLI-POS
        MOVE SPACES TO DIBSTAT
      END-IF
      EXEC CICS ENDBR DATASET('PAUTDTL') END-EXEC
    END-IF.
CDDLI-GNP-DTL-KEY.
    MOVE CDDLI-PARENT TO CDDLI-KEY-ACCT
    MOVE PA-AUTHORIZATION-KEY TO CDDLI-KEY-TS
    EXEC CICS READ DATASET('PAUTDTL') INTO(CDDLI-DREC) RIDFLD(CDDLI-KEY) RESP(CDDLI-RESP) END-EXEC
    EVALUATE TRUE
      WHEN CDDLI-RESP = DFHRESP(NORMAL)
        MOVE CDDLI-DREC-SEG TO PENDING-AUTH-DETAILS
        MOVE CDDLI-KEY-TS TO CDDLI-POS
        MOVE SPACES TO DIBSTAT
      WHEN CDDLI-RESP = DFHRESP(NOTFND)
        MOVE 'GE' TO DIBSTAT
      WHEN OTHER
        MOVE 'AO' TO DIBSTAT
    END-EVALUATE.
CDDLI-REPL-DTL.
    MOVE CDDLI-PARENT TO CDDLI-KEY-ACCT
    MOVE PA-AUTHORIZATION-KEY TO CDDLI-KEY-TS
    EXEC CICS READ DATASET('PAUTDTL') INTO(CDDLI-DREC) RIDFLD(CDDLI-KEY) UPDATE RESP(CDDLI-RESP) END-EXEC
    IF CDDLI-RESP = DFHRESP(NORMAL)
      MOVE PENDING-AUTH-DETAILS TO CDDLI-DREC-SEG
      EXEC CICS REWRITE DATASET('PAUTDTL') FROM(CDDLI-DREC) RESP(CDDLI-RESP) END-EXEC
    END-IF
    IF CDDLI-RESP = DFHRESP(NORMAL)
      MOVE SPACES TO DIBSTAT
    ELSE
      MOVE 'AO' TO DIBSTAT
    END-IF.
"""

DLI = [
    ('SCHD ', 'MOVE SPACES TO DIBSTAT'),
    ('TERM', 'MOVE SPACES TO DIBSTAT'),
    ('GU USING PCB(PAUT-PCB-NUM) SEGMENT (PAUTSUM0) INTO (PENDING-AUTH-SUMMARY) WHERE (ACCNTID = PA-ACCT-ID)',
     'PERFORM CDDLI-GU-SUM'),
    ('GNP USING PCB(PAUT-PCB-NUM) SEGMENT (PAUTDTL1) INTO (PENDING-AUTH-DETAILS) WHERE (PAUT9CTS = PA-AUTHORIZATION-KEY)',
     'PERFORM CDDLI-GNP-DTL-KEY'),
    ('GNP USING PCB(PAUT-PCB-NUM) SEGMENT (PAUTDTL1) INTO (PENDING-AUTH-DETAILS)', 'PERFORM CDDLI-GNP-DTL'),
    ('REPL USING PCB(PAUT-PCB-NUM) SEGMENT (PAUTDTL1) FROM (PENDING-AUTH-DETAILS)', 'PERFORM CDDLI-REPL-DTL'),
]


def to_vsam(text):
    """every EXEC DLI call of COPAUS0C or COPAUS1C -> its KICKS replacement; the DIB and the paragraphs are added
    (the DIB in front of the program's first 01 item of WORKING-STORAGE, the paragraphs at its end)"""
    def one(m):
        s = ' '.join(m.group(1).split())
        for pre, new in DLI:
            if s.startswith(pre): return new
        raise ValueError('EXEC DLI not handled: ' + s[:80])
    text = re.sub(r'EXEC\s+DLI\s+(.*?)\s*END-EXEC', one, text, flags=re.S)
    text = re.sub(r'(WORKING-STORAGE\s+SECTION\s*\.)', lambda m: m.group(1) + '\n' + DIB, text, count=1)
    # the KICKS translator turns CICS into KICKS in names inside EXEC (WS-CICS-TRANID), and its DFHBMSCA has no
    # DFHBMUNP: the unprotected attribute is a space (X'40')
    text = text.replace('WS-CICS-TRANID', 'WS-CPV-TRANID')
    text = re.sub(r'MOVE\s+DFHBMUNP\s+TO', 'MOVE SPACE TO', text)
    return text.rstrip() + '\n' + PARAS


# COPAUS2C: the AUTHFRDS record (DCLGEN of the Db2 table) and its INSERT / UPDATE
FRDS_WS = """
01 SQLCA.
  05 SQLCODE PIC S9(9) COMP VALUE 0.
  05 SQLSTATE PIC X(5) VALUE SPACES.
01 CDSQL-RESP PIC S9(8) COMP VALUE 0.
01 CDSQL-FKEY PIC X(42).
01 CDSQL-FREC PIC X(@LEN).
01 DCLAUTHFRDS.
  10 CARD-NUM PIC X(16).
  10 AUTH-TS PIC X(26).
  10 AUTH-TYPE PIC X(4).
  10 CARD-EXPIRY-DATE PIC X(4).
  10 MESSAGE-TYPE PIC X(6).
  10 MESSAGE-SOURCE PIC X(6).
  10 AUTH-ID-CODE PIC X(6).
  10 AUTH-RESP-CODE PIC X(2).
  10 AUTH-RESP-REASON PIC X(4).
  10 PROCESSING-CODE PIC X(6).
  10 TRANSACTION-AMT PIC S9(10)V9(2) USAGE COMP-3.
  10 APPROVED-AMT PIC S9(10)V9(2) USAGE COMP-3.
  10 MERCHANT-CATAGORY-CODE PIC X(4).
  10 ACQR-COUNTRY-CODE PIC X(3).
  10 POS-ENTRY-MODE PIC S9(4) USAGE COMP.
  10 MERCHANT-ID PIC X(15).
  10 MERCHANT-NAME.
    49 MERCHANT-NAME-LEN PIC S9(4) USAGE COMP.
    49 MERCHANT-NAME-TEXT PIC X(22).
  10 MERCHANT-CITY PIC X(13).
  10 MERCHANT-STATE PIC X(2).
  10 MERCHANT-ZIP PIC X(9).
  10 TRANSACTION-ID PIC X(15).
  10 MATCH-STATUS PIC X(1).
  10 AUTH-FRAUD PIC X(1).
  10 FRAUD-RPT-DATE PIC X(10).
  10 ACCT-ID PIC S9(11) USAGE COMP-3.
  10 CUST-ID PIC S9(9) USAGE COMP-3.
"""
FRDS_LEN = 16 + 26 + 4 + 4 + 6 + 6 + 6 + 2 + 4 + 6 + 7 + 7 + 4 + 3 + 2 + 15 + 24 + 13 + 2 + 9 + 15 + 1 + 1 + 10 + 6 + 5
FRDS_WS = FRDS_WS.replace('@LEN', str(FRDS_LEN))

FRDS_PARAS = """
CDSQL-FRDS-INSERT.
    MOVE 0 TO SQLCODE
    MOVE WS-CUR-DATE TO FRAUD-RPT-DATE
    MOVE DCLAUTHFRDS TO CDSQL-FREC
    MOVE DCLAUTHFRDS TO CDSQL-FKEY
    EXEC CICS WRITE DATASET('AUTHFRDS') FROM(CDSQL-FREC) RIDFLD(CDSQL-FKEY) RESP(CDSQL-RESP) END-EXEC
    EVALUATE TRUE
      WHEN CDSQL-RESP = DFHRESP(NORMAL)
        CONTINUE
      WHEN CDSQL-RESP = DFHRESP(DUPREC)
        MOVE -803 TO SQLCODE
      WHEN OTHER
        MOVE -1 TO SQLCODE
    END-EVALUATE.
CDSQL-FRDS-UPDATE.
    MOVE 0 TO SQLCODE
    MOVE WS-CUR-DATE TO FRAUD-RPT-DATE
    MOVE DCLAUTHFRDS TO CDSQL-FKEY
    EXEC CICS READ DATASET('AUTHFRDS') INTO(CDSQL-FREC) RIDFLD(CDSQL-FKEY) UPDATE RESP(CDSQL-RESP) END-EXEC
    IF CDSQL-RESP = DFHRESP(NORMAL)
      MOVE DCLAUTHFRDS TO CDSQL-FREC
      EXEC CICS REWRITE DATASET('AUTHFRDS') FROM(CDSQL-FREC) RESP(CDSQL-RESP) END-EXEC
    END-IF
    IF CDSQL-RESP = DFHRESP(NOTFND)
      MOVE 100 TO SQLCODE
    ELSE
      IF CDSQL-RESP NOT = DFHRESP(NORMAL)
        MOVE -1 TO SQLCODE
      END-IF
    END-IF.
"""


def frds_to_vsam(text):
    def one(m):
        s = ' '.join(m.group(1).split())
        if s.startswith('INCLUDE SQLCA'): return ''
        if s.startswith('INCLUDE AUTHFRDS'): return FRDS_WS
        if s.startswith('INSERT INTO CARDDEMO.AUTHFRDS'): return 'PERFORM CDSQL-FRDS-INSERT'
        if s.startswith('UPDATE CARDDEMO.AUTHFRDS'): return 'PERFORM CDSQL-FRDS-UPDATE'
        raise ValueError('EXEC SQL not handled: ' + s[:80])
    text = re.sub(r'EXEC\s+SQL\s+(.*?)\s*END-EXEC', one, text, flags=re.S)
    # ASKTIME and FORMATTIME with NOHANDLE (twice on ASKTIME): KICKS has no NOHANDLE, and neither command fails
    text = re.sub(r'\bNOHANDLE\b', '', text)
    # DATESEP without its separator ('/' by default) leaves the KICKS translator lost
    text = re.sub(r'\bDATESEP\b(?!\s*\()', "DATESEP('/')", text)
    return text.rstrip() + '\n' + FRDS_PARAS


# COPAUS1C: SEARCH ALL of the decline reasons -> a loop (the table is 10 entries)
SEARCH_OLD = """SEARCH ALL WS-DECLINE-REASON-TAB
                   AT END
                        MOVE '9999'                     TO AUTHRSNO
                        MOVE '-'                        TO AUTHRSNO(5:1)
                        MOVE 'ERROR'                    TO AUTHRSNO(6:)
                   WHEN DECL-CODE(WS-DECL-RSN-IDX) = PA-AUTH-RESP-REASON
                        MOVE PA-AUTH-RESP-REASON        TO AUTHRSNO
                        MOVE '-'                        TO AUTHRSNO(5:1)
                        MOVE DECL-DESC(WS-DECL-RSN-IDX) TO AUTHRSNO(6:)
               END-SEARCH"""
SEARCH_NEW = """MOVE '9999' TO AUTHRSNO
               MOVE '-' TO AUTHRSNO(5:1)
               MOVE 'ERROR' TO AUTHRSNO(6:)
               PERFORM VARYING CDDLI-I FROM 1 BY 1 UNTIL CDDLI-I > 10
                 IF DECL-CODE(CDDLI-I) = PA-AUTH-RESP-REASON
                   MOVE PA-AUTH-RESP-REASON TO AUTHRSNO
                   MOVE '-' TO AUTHRSNO(5:1)
                   MOVE DECL-DESC(CDDLI-I) TO AUTHRSNO(6:)
                 END-IF
               END-PERFORM"""
