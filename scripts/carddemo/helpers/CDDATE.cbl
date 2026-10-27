       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDDATE.
      * CDDATE T: FIRST 16 BYTES OF FUNCTION CURRENT-DATE
      * (YYYYMMDDHHMMSS00).
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01  D8       PIC X(8).
       01  D8R REDEFINES D8.
           05  DMM  PIC XX.
           05  FILLER PIC X.
           05  DDD  PIC XX.
           05  FILLER PIC X.
           05  DYY  PIC XX.
       01  T6       PIC X(6).
       01  OUT16.
           05  OCC  PIC XX VALUE '20'.
           05  OYY  PIC XX.
           05  OMM  PIC XX.
           05  ODD  PIC XX.
           05  OTM  PIC X(6).
           05  FILLER PIC XX VALUE '00'.
       LINKAGE SECTION.
       01  T        PIC X(16).
       PROCEDURE DIVISION USING T.
       P0.
           MOVE CURRENT-DATE TO D8.
           MOVE TIME-OF-DAY TO T6.
           MOVE DYY TO OYY. MOVE DMM TO OMM. MOVE DDD TO ODD.
           MOVE T6 TO OTM.
           MOVE OUT16 TO T.
           GOBACK.
