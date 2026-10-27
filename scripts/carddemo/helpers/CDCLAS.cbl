       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDCLAS.
      * CDCLAS SRC OFS LEN KIND RES: TEST SRC(OFS:LEN), RES 'Y' OR 'N'.
      * KIND N: NUMERIC, A: ALPHABETIC (LETTERS AND SPACES),
      * S: ALL SPACES, L: ALL LOW-VALUES (REFERENCE MODIFICATION WITH A
      * VARIABLE LENGTH IN A CONDITION).
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  I        PIC S9(8) COMP.
       77  E        PIC S9(8) COMP.
       01  C        PIC X.
       LINKAGE SECTION.
       01  SRC.
           05  SC   PIC X OCCURS 32000 TIMES.
       01  OFS      PIC S9(8) COMP.
       01  LEN      PIC S9(8) COMP.
       01  KIND     PIC X.
       01  RES      PIC X.
       PROCEDURE DIVISION USING SRC OFS LEN KIND RES.
       P0.
           MOVE 'Y' TO RES.
           IF LEN < 1 AND (KIND = 'N' OR KIND = 'A') MOVE 'N' TO RES.
           MOVE OFS TO I.
           COMPUTE E = OFS + LEN - 1.
           PERFORM P1 UNTIL I > E OR RES = 'N'.
           GOBACK.
       P1.
           MOVE SC (I) TO C.
           IF KIND = 'N' AND C NOT NUMERIC MOVE 'N' TO RES.
           IF KIND = 'A' AND C NOT ALPHABETIC MOVE 'N' TO RES.
           IF KIND = 'S' AND C NOT = SPACE MOVE 'N' TO RES.
           IF KIND = 'L' AND C NOT = LOW-VALUE MOVE 'N' TO RES.
           ADD 1 TO I.
