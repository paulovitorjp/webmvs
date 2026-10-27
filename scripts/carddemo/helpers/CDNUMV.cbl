       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDNUMV.
      * CDNUMV SRC VAL [RC]: FUNCTION NUMVAL / NUMVAL-C OF X(40)
      * SRC INTO S9(13)V99 COMP-3. ENTRY CDNUMT ALSO SETS RC
      * (0 = VALID NUMBER, AS FUNCTION TEST-NUMVAL-C).
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  I        PIC S9(8) COMP.
       77  ERR      PIC S9(8) COMP.
       77  NEG      PIC X.
       77  DOT      PIC X.
       77  NDIG     PIC S9(8) COMP.
       77  FR       PIC S9(8) COMP.
       77  ACC      PIC S9(15) COMP-3.
       77  DG       PIC 9.
       77  STATE    PIC 9.
       LINKAGE SECTION.
       01  SRC.
           05  SC   PIC X OCCURS 40 TIMES.
       01  VAL      PIC S9(13)V99 COMP-3.
       01  RC       PIC S9(8) COMP.
       PROCEDURE DIVISION USING SRC VAL.
       P0.
           PERFORM PARSE.
           GOBACK.
           ENTRY 'CDNUMT' USING SRC VAL RC.
           PERFORM PARSE.
           MOVE ERR TO RC.
           GOBACK.
       PARSE.
           MOVE 0 TO ACC ERR NDIG FR STATE. MOVE 'N' TO NEG DOT.
           MOVE 1 TO I.
           PERFORM P1 UNTIL I > 40.
           IF NDIG = 0 AND ERR = 0 MOVE 1 TO ERR.
           IF FR = 0 COMPUTE ACC = ACC * 100.
           IF FR = 1 COMPUTE ACC = ACC * 10.
           IF NEG = 'Y' COMPUTE ACC = 0 - ACC.
           COMPUTE VAL = ACC / 100.
       P1.
           IF SC (I) = SPACE OR SC (I) = '$' OR SC (I) = ','
               OR SC (I) = '+'
               NEXT SENTENCE
           ELSE IF SC (I) = '-'
               MOVE 'Y' TO NEG
           ELSE IF SC (I) = '.'
               IF DOT = 'Y' MOVE I TO ERR ELSE MOVE 'Y' TO DOT
           ELSE IF SC (I) NOT NUMERIC
               IF (SC (I) = 'C' OR 'D') AND I < 40
                   MOVE 'Y' TO NEG ADD 1 TO I
               ELSE IF ERR = 0 MOVE I TO ERR.
           IF SC (I) NUMERIC AND FR < 2
               MOVE SC (I) TO DG
               COMPUTE ACC = ACC * 10 + DG
               ADD 1 TO NDIG
               IF DOT = 'Y' ADD 1 TO FR.
           ADD 1 TO I.
