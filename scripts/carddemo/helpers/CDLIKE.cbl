       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDLIKE.
      * CDLIKE TXT PAT RES: RES = 'Y' WHEN THE 50 CHARACTERS OF TXT ARE
      * LIKE THE 52 CHARACTERS OF PAT (SQL LIKE OF TRIM(PAT): % ANY
      * CHARACTERS, _ ONE CHARACTER), IGNORING THE CASE OF LETTERS.
      * THE TRANSACTION TYPE LIST USES IT FOR ITS DESCRIPTION FILTER.
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  N        PIC S9(4) COMP.
       77  M        PIC S9(4) COMP.
       77  I        PIC S9(4) COMP.
       77  J        PIC S9(4) COMP.
       77  K        PIC S9(4) COMP.
       77  L        PIC S9(4) COMP.
       77  J1       PIC S9(4) COMP.
       77  N1       PIC S9(4) COMP.
       77  F        PIC X.
       77  C        PIC X.
       01  LOW      PIC X(26) VALUE 'abcdefghijklmnopqrstuvwxyz'.
       01  LOWT REDEFINES LOW.
           05  LC   PIC X OCCURS 26 TIMES.
       01  UPP      PIC X(26) VALUE 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.
       01  UPPT REDEFINES UPP.
           05  UC   PIC X OCCURS 26 TIMES.
       01  T.
           05  TC   PIC X OCCURS 52 TIMES.
       01  P.
           05  PC   PIC X OCCURS 52 TIMES.
      * MATCHING STATE: S(I, J) = PAT(1:J) MATCHES TXT(1:I), ROW BY ROW
       01  SROW.
           05  SA   PIC X OCCURS 53 TIMES.
       01  SNEW.
           05  SB   PIC X OCCURS 53 TIMES.
       LINKAGE SECTION.
       01  TXT      PIC X(50).
       01  PAT      PIC X(52).
       01  RES      PIC X.
       PROCEDURE DIVISION USING TXT PAT RES.
       P0.
           MOVE TXT TO T. MOVE PAT TO P.
           MOVE 1 TO K. PERFORM P-UPT 52 TIMES.
      * N: LENGTH OF TRIM(PAT), M: LENGTH OF TXT WITHOUT TRAILING SPACES
           MOVE 52 TO N.
           PERFORM P-DN UNTIL N = 0 OR PC (N) NOT = SPACE.
           MOVE 50 TO M.
           PERFORM P-DM UNTIL M = 0 OR TC (M) NOT = SPACE.
      * ROW 0: ONLY LEADING % MATCH THE EMPTY TEXT
           MOVE 'Y' TO SA (1). MOVE 1 TO J.
           PERFORM P-R0 UNTIL J > N.
           MOVE 1 TO I.
           PERFORM P-ROW UNTIL I > M.
           COMPUTE N1 = N + 1. MOVE SA (N1) TO RES.
           GOBACK.
       P-UPT.
           MOVE TC (K) TO C. PERFORM P-UP. MOVE C TO TC (K).
           MOVE PC (K) TO C. PERFORM P-UP. MOVE C TO PC (K).
           ADD 1 TO K.
       P-UP.
           MOVE 0 TO L. MOVE 'N' TO F.
           PERFORM P-UP1 UNTIL F = 'Y' OR L = 26.
       P-UP1.
           ADD 1 TO L.
           IF C = LC (L) MOVE UC (L) TO C MOVE 'Y' TO F.
       P-DN.
           SUBTRACT 1 FROM N.
       P-DM.
           SUBTRACT 1 FROM M.
       P-R0.
           COMPUTE J1 = J + 1.
           IF PC (J) = '%' AND SA (J) = 'Y'
              MOVE 'Y' TO SA (J1)
           ELSE
              MOVE 'N' TO SA (J1).
           ADD 1 TO J.
       P-ROW.
           MOVE 'N' TO SB (1). MOVE 1 TO J.
           PERFORM P-CELL UNTIL J > N.
           MOVE SNEW TO SROW.
           ADD 1 TO I.
       P-CELL.
           COMPUTE J1 = J + 1.
           MOVE 'N' TO SB (J1).
           IF PC (J) = '%'
              IF SB (J) = 'Y' OR SA (J1) = 'Y'
                 MOVE 'Y' TO SB (J1).
           IF PC (J) NOT = '%' AND SA (J) = 'Y'
              IF PC (J) = '_' OR PC (J) = TC (I)
                 MOVE 'Y' TO SB (J1).
           ADD 1 TO J.
