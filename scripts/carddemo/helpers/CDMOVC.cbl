       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDMOVC.
      * CDMOVC SRC SOFF SLEN DST DOFF DLEN: MOVE SRC(SOFF:SLEN) TO
      * DST(DOFF:DLEN), SPACE FILLED (REFERENCE MODIFICATION).
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  I        PIC S9(8) COMP.
       77  J        PIC S9(8) COMP.
       77  N        PIC S9(8) COMP.
       77  K        PIC S9(8) COMP.
       LINKAGE SECTION.
       01  SRC.
           05  SC   PIC X OCCURS 32000 TIMES.
       01  SOFF     PIC S9(8) COMP.
       01  SLEN     PIC S9(8) COMP.
       01  DST.
           05  DC   PIC X OCCURS 32000 TIMES.
       01  DOFF     PIC S9(8) COMP.
       01  DLEN     PIC S9(8) COMP.
       PROCEDURE DIVISION USING SRC SOFF SLEN DST DOFF DLEN.
       P0.
           MOVE SLEN TO N.
           IF N > DLEN MOVE DLEN TO N.
           IF N < 0 MOVE 0 TO N.
           MOVE SOFF TO I. MOVE DOFF TO J. MOVE 0 TO K.
           IF N > 0 PERFORM P1 N TIMES.
           IF DLEN > N COMPUTE N = DLEN - N
               PERFORM P2 N TIMES.
           GOBACK.
       P1.
           MOVE SC (I) TO DC (J). ADD 1 TO I. ADD 1 TO J.
       P2.
           MOVE SPACE TO DC (J). ADD 1 TO J.
