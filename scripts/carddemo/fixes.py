# SPDX-License-Identifier: Apache-2.0
"""Source changes for CardDemo programs before scripts/carddemo/cob2ans.py converts them: (old text, new text[, n])
tuples; old must match exactly n times (default 1) in the program after COPY members are expanded."""

# programs of this port (online menu options that run); the other menu options say "not available in this version"
PORTED = {'COACTVWC', 'COCRDLIC', 'COCRDSLC', 'COTRN00C', 'COTRN01C', 'COUSR00C', 'COUSR01C', 'COUSR02C', 'COUSR03C',
          'COTRN02C', 'COBIL00C', 'COACTUPC', 'COCRDUPC'}
NOT_AVAILABLE = 'is not available in this version'

ABEND = ("CALL 'CEE3ABD' USING ABCODE, TIMING.", "STOP RUN.")


def menu(programs):
    """menu table entries of programs not in PORTED -> DUMMYnnn (the menu programs' own 'not installed' path)"""
    return [(f"VALUE '{p}'.", f"VALUE 'DUMMY{i:03d}'.") for i, p in enumerate(programs) if p not in PORTED]


FIXES = {
    'CBACT02C': [ABEND], 'CBACT03C': [ABEND], 'CBCUS01C': [ABEND],
    'COMEN01C': menu(['COACTVWC', 'COACTUPC', 'COCRDLIC', 'COCRDSLC', 'COCRDUPC', 'COTRN00C', 'COTRN01C',
                      'COTRN02C', 'CORPT00C', 'COBIL00C', 'COPAUS0C']) + [
        # 11 menu entries: the table REDEFINES 11 entries, not 12
        ('10 CDEMO-MENU-OPT OCCURS 12 TIMES.', '10 CDEMO-MENU-OPT OCCURS 11 TIMES.'),
        ("DELIMITED BY SPACE 'is coming soon ...' DELIMITED BY SIZE",
         f"DELIMITED BY '  ' ' {NOT_AVAILABLE}' DELIMITED BY SIZE")],
    'COADM01C': menu(['COUSR00C', 'COUSR01C', 'COUSR02C', 'COUSR03C', 'COTRTLIC', 'COTRTUPC']) + [
        ('10 CDEMO-ADMIN-OPT OCCURS 9 TIMES.', '10 CDEMO-ADMIN-OPT OCCURS 6 TIMES.'),
        ("'is not installed ...'", f"'{NOT_AVAILABLE}'", 2)],
    # sign-on screen after a key it does not take: the cursor goes back to the User ID field, and the message is
    # only for Clear, PA1, PA3 and the PF keys: the browser terminal sends PA2 (redisplay) when KICKS starts
    # KICKS: one FORMATTIME per format (the date with DATESEP, then the time with TIMESEP)
    'COBIL00C': [("EXEC CICS FORMATTIME ABSTIME(WS-ABS-TIME) YYYYMMDD(WS-CUR-DATE-X10) DATESEP('-') "
                  "TIME(WS-CUR-TIME-X08) TIMESEP(':') END-EXEC",
                  "EXEC CICS FORMATTIME ABSTIME(WS-ABS-TIME) YYYYMMDD(WS-CUR-DATE-X10) DATESEP('-') END-EXEC "
                  "EXEC CICS FORMATTIME ABSTIME(WS-ABS-TIME) TIME(WS-CUR-TIME-X08) TIMESEP(':') END-EXEC")],
    # two items named WS-EDIT-DATE-X (the second redefines the first): the second gets its own name
    'COACTUPC': [('10 WS-EDIT-DATE-X REDEFINES WS-EDIT-DATE-X PIC 9(10).',
                  '10 WS-EDIT-DATE-X9 REDEFINES WS-EDIT-DATE-X PIC 9(10).')],
    'COSGN00C': [("MOVE CCDA-MSG-INVALID-KEY TO WS-MESSAGE PERFORM SEND-SIGNON-SCREEN",
                  "MOVE -1 TO USERIDL OF COSGN0AI MOVE 'N' TO WS-ERR-FLG IF " + ' OR '.join(
                      f'EIBAID = {k}' for k in ['DFHCLEAR', 'DFHPA1', 'DFHPA3']
                      + [f'DFHPF{i}' for i in range(1, 25)])
                  + " MOVE 'Y' TO WS-ERR-FLG MOVE CCDA-MSG-INVALID-KEY TO WS-MESSAGE END-IF"
                  " PERFORM SEND-SIGNON-SCREEN")],
}
