       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDTLEN.
      * CDTLEN SRC SLEN RES: RES = LENGTH OF SRC(1:SLEN) WITHOUT ITS
      * LEADING AND TRAILING SPACES (FUNCTION LENGTH(FUNCTION TRIM)),
      * 0 WHEN IT IS ALL SPACES.
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  I        PIC S9(8) COMP.
       77  J        PIC S9(8) COMP.
       77  F        PIC X.
       LINKAGE SECTION.
       01  SRC.
           05  SC   PIC X OCCURS 32000 TIMES.
       01  SLEN     PIC S9(8) COMP.
       01  RES      PIC S9(8) COMP.
       PROCEDURE DIVISION USING SRC SLEN RES.
       P0.
           MOVE 0 TO RES. MOVE 0 TO I. MOVE 'N' TO F.
           PERFORM P1 UNTIL F = 'Y' OR I NOT < SLEN.
           IF F = 'N' GOBACK.
           MOVE SLEN TO J.
           PERFORM P2 UNTIL SC (J) NOT = SPACE.
           COMPUTE RES = J - I + 1.
           GOBACK.
       P1.
           ADD 1 TO I.
           IF SC (I) NOT = SPACE MOVE 'Y' TO F.
       P2.
           SUBTRACT 1 FROM J.
