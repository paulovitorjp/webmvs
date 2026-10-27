       IDENTIFICATION DIVISION.
       PROGRAM-ID. CSUTLDTC.
      * DATE CHECK CALLED BY COTRN02C (CARDDEMO'S CSUTLDTC CALLS THE
      * LE SERVICE CEEDAYS, NOT ON MVS 3.8J): LS-DATE YYYY-MM-DD.
      * LS-RESULT: SEVERITY 0000 (VALID) OR 0003, 11 BYTES, MSG NUMBER.
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  D.
           05  DY   PIC 9(4).
           05  S1   PIC X.
           05  DM   PIC 99.
           05  S2   PIC X.
           05  DD   PIC 99.
       01  MAXD     PIC 99.
       01  Q        PIC 9(4).
       01  R        PIC 9(4).
       01  RES.
           05  RSEV PIC X(4).
           05  FILLER PIC X(11) VALUE SPACES.
           05  RNUM PIC X(4).
           05  FILLER PIC X(61) VALUE SPACES.
       01  DAYS-TAB.
           05  FILLER PIC X(24) VALUE '312831303130313130313031'.
       01  DAYS-R REDEFINES DAYS-TAB.
           05  DT   PIC 99 OCCURS 12 TIMES.
       LINKAGE SECTION.
       01  LS-DATE   PIC X(10).
       01  LS-FMT    PIC X(10).
       01  LS-RESULT PIC X(80).
       PROCEDURE DIVISION USING LS-DATE LS-FMT LS-RESULT.
       P0.
           MOVE LS-DATE TO D.
           MOVE '0003' TO RSEV. MOVE '2508' TO RNUM.
           IF DY NOT NUMERIC OR DM NOT NUMERIC OR DD NOT NUMERIC
               GO TO P9.
           IF S1 NOT = '-' OR S2 NOT = '-' GO TO P9.
           IF DM < 1 OR DM > 12 OR DD < 1 OR DY < 1601 GO TO P9.
           MOVE DT (DM) TO MAXD.
           IF DM NOT = 2 GO TO P1.
           COMPUTE Q = DY / 4. COMPUTE R = DY - Q * 4.
           IF R = 0 MOVE 29 TO MAXD.
           COMPUTE Q = DY / 100. COMPUTE R = DY - Q * 100.
           IF R = 0 MOVE 28 TO MAXD.
           COMPUTE Q = DY / 400. COMPUTE R = DY - Q * 400.
           IF R = 0 MOVE 29 TO MAXD.
       P1.
           IF DD > MAXD GO TO P9.
           MOVE '0000' TO RSEV. MOVE '0000' TO RNUM.
       P9.
           MOVE RES TO LS-RESULT.
           GOBACK.
