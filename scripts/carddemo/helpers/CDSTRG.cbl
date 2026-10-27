       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDSTRG.
      * CDSTRG TGT TLEN PTR SRC SLEN MODE: ONE STRING SOURCE.
      * MODE 0 DELIMITED BY SIZE, 1 BY SPACE, 2 BY TWO SPACES,
      * 4 TRAILING SPACES TRIMMED.
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  I        PIC S9(8) COMP.
       77  N        PIC S9(8) COMP.
       77  J        PIC S9(8) COMP.
       LINKAGE SECTION.
       01  TGT.
           05  TC   PIC X OCCURS 32000 TIMES.
       01  TLEN     PIC S9(8) COMP.
       01  PTR      PIC S9(8) COMP.
       01  SRC.
           05  SC   PIC X OCCURS 32000 TIMES.
       01  SLEN     PIC S9(8) COMP.
       01  SMODE    PIC S9(8) COMP.
       PROCEDURE DIVISION USING TGT TLEN PTR SRC SLEN SMODE.
       P0.
           MOVE SLEN TO N.
           IF SMODE = 4 PERFORM P4 THRU P4X.
           IF SMODE = 1 OR SMODE = 2 MOVE 1 TO I PERFORM P3 THRU P3X.
           MOVE 1 TO I.
           PERFORM P1 UNTIL I > N OR PTR > TLEN OR PTR < 1.
           GOBACK.
       P1.
           MOVE SC (I) TO TC (PTR). ADD 1 TO I. ADD 1 TO PTR.
       P3.
           IF I > N GO TO P3X.
           IF SMODE = 1 AND SC (I) = SPACE
               COMPUTE N = I - 1 GO TO P3X.
           COMPUTE J = I + 1.
           IF SMODE = 2 AND I < N AND SC (I) = SPACE
               AND SC (J) = SPACE
               COMPUTE N = I - 1 GO TO P3X.
           ADD 1 TO I.
           GO TO P3.
       P3X.
           EXIT.
       P4.
           IF N < 1 GO TO P4X.
           IF SC (N) NOT = SPACE GO TO P4X.
           SUBTRACT 1 FROM N.
           GO TO P4.
       P4X.
           EXIT.
