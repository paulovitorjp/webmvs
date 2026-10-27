       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDUNHEX.
      * LOAD BINARY RECORDS FROM CARDS: EACH 206-BYTE RECORD IS GIVEN
      * IN HEXADECIMAL ON 6 CARDS (412 OF THEIR 480 COLUMNS). IT BRINGS
      * THE PENDING AUTHORIZATIONS (PACKED AND BINARY FIELDS) IN.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT HEXIN  ASSIGN TO UT-S-HEXIN.
           SELECT BINOUT ASSIGN TO UT-S-BINOUT.
       DATA DIVISION.
       FILE SECTION.
       FD  HEXIN
           LABEL RECORDS ARE STANDARD.
       01  HX-REC           PIC X(80).
       FD  BINOUT
           LABEL RECORDS ARE STANDARD.
       01  BO-REC           PIC X(206).
       WORKING-STORAGE SECTION.
       77  EOF-FLAG         PIC X VALUE 'N'.
       77  N-OUT            PIC 9(8) VALUE 0.
       77  I                PIC S9(4) COMP.
       77  J                PIC S9(4) COMP.
       77  J1               PIC S9(4) COMP.
       77  K                PIC S9(4) COMP.
       77  HI               PIC S9(4) COMP.
       77  LO               PIC S9(4) COMP.
       77  HXCH               PIC X.
       77  V                PIC S9(4) COMP.
       01  HEXDIG           PIC X(16) VALUE '0123456789ABCDEF'.
       01  HEXT REDEFINES HEXDIG.
           05  HEXD         PIC X OCCURS 16.
       01  BUF.
           05  BUF-CARD     PIC X(80) OCCURS 6.
       01  BUFT REDEFINES BUF.
           05  BUF-C        PIC X OCCURS 480.
       01  OUTR.
           05  OUTR-C       PIC X OCCURS 206.
       01  WB.
           05  WB-N         PIC S9(4) COMP.
       01  WBX REDEFINES WB.
           05  FILLER       PIC X.
           05  WB-LO        PIC X.
       PROCEDURE DIVISION.
       P0.
           OPEN INPUT HEXIN.
           OPEN OUTPUT BINOUT.
           PERFORM P1 UNTIL EOF-FLAG = 'Y'.
           CLOSE HEXIN.
           CLOSE BINOUT.
           DISPLAY 'CDUNHEX: RECORDS ' N-OUT.
           STOP RUN.
       P1.
           MOVE 1 TO I.
           PERFORM P2 UNTIL I > 6 OR EOF-FLAG = 'Y'.
           IF EOF-FLAG = 'N'
               MOVE 1 TO I
               PERFORM P3 UNTIL I > 206
               ADD 1 TO N-OUT
               WRITE BO-REC FROM OUTR.
       P2.
           READ HEXIN AT END MOVE 'Y' TO EOF-FLAG.
           IF EOF-FLAG = 'N'
               MOVE HX-REC TO BUF-CARD (I)
               ADD 1 TO I.
       P3.
           COMPUTE J = I * 2 - 1.
           COMPUTE J1 = J + 1.
           MOVE BUF-C (J) TO HXCH.
           PERFORM P4.
           MOVE V TO HI.
           MOVE BUF-C (J1) TO HXCH.
           PERFORM P4.
           MOVE V TO LO.
           COMPUTE WB-N = HI * 16 + LO.
           MOVE WB-LO TO OUTR-C (I).
           ADD 1 TO I.
       P4.
           MOVE 0 TO V.
           MOVE 1 TO K.
           PERFORM P5 UNTIL K > 16.
       P5.
           IF HEXD (K) = HXCH
               COMPUTE V = K - 1
               MOVE 17 TO K
           ELSE
               ADD 1 TO K.
