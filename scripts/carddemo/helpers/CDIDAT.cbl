       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDIDAT.
      * FUNCTION INTEGER-OF-DATE AND DATE-OF-INTEGER (DAY 1 IS
      * 1601-01-01). CDIDAT DATE RES: DATE YYYYMMDD -> RES DAY NUMBER,
      * 0 IF DATE IS NOT VALID. ENTRY CDDOFI DAYS RES: DAY NUMBER ->
      * RES YYYYMMDD. ALL ARGUMENTS PIC S9(8) COMP.
       ENVIRONMENT DIVISION.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  Y        PIC S9(8) COMP.
       77  M        PIC S9(8) COMP.
       77  D        PIC S9(8) COMP.
       77  Y1       PIC S9(8) COMP.
       77  Q        PIC S9(8) COMP.
       77  DBY      PIC S9(8) COMP.
       77  NXT      PIC S9(8) COMP.
       77  R        PIC S9(8) COMP.
       77  LEAP     PIC S9(8) COMP.
       77  ML       PIC S9(8) COMP.
       77  CM       PIC S9(8) COMP.
       01  CUMV     PIC X(36) VALUE
           '000031059090120151181212243273304334'.
       01  CUMT REDEFINES CUMV.
           05  CUM  PIC 999 OCCURS 12 TIMES.
       LINKAGE SECTION.
       01  ARG      PIC S9(8) COMP.
       01  RES      PIC S9(8) COMP.
       PROCEDURE DIVISION USING ARG RES.
       P0.
           MOVE 0 TO RES.
           DIVIDE ARG BY 10000 GIVING Y.
           COMPUTE R = ARG - Y * 10000.
           DIVIDE R BY 100 GIVING M.
           COMPUTE D = R - M * 100.
           IF Y < 1601 OR M < 1 OR M > 12 OR D < 1 GOBACK.
           PERFORM PLEAP.
           MOVE 31 TO ML.
           IF M = 4 OR M = 6 OR M = 9 OR M = 11 MOVE 30 TO ML.
           IF M = 2 COMPUTE ML = 28 + LEAP.
           IF D > ML GOBACK.
           PERFORM PDBY.
           COMPUTE RES = DBY + CUM (M) + D.
           IF M > 2 ADD LEAP TO RES.
           GOBACK.
           ENTRY 'CDDOFI' USING ARG RES.
           MOVE 0 TO RES.
           IF ARG < 1 GOBACK.
           DIVIDE ARG BY 366 GIVING Y.
           ADD 1600 TO Y.
           PERFORM PNEXT.
           PERFORM PSTEP UNTIL NXT NOT < ARG.
           PERFORM PDBY.
           PERFORM PLEAP.
           COMPUTE R = ARG - DBY.
           MOVE 13 TO M. MOVE 99999 TO CM.
           PERFORM PMON UNTIL M = 1 OR R > CM.
           COMPUTE D = R - CUM (M).
           IF M > 2 SUBTRACT LEAP FROM D.
           COMPUTE RES = Y * 10000 + M * 100 + D.
           GOBACK.
       PDBY.
           COMPUTE Y1 = Y - 1601.
           COMPUTE DBY = 365 * Y1.
           DIVIDE Y1 BY 4 GIVING Q. ADD Q TO DBY.
           DIVIDE Y1 BY 100 GIVING Q. SUBTRACT Q FROM DBY.
           DIVIDE Y1 BY 400 GIVING Q. ADD Q TO DBY.
      * NXT: THE DAY NUMBER OF DEC 31 OF YEAR Y
       PNEXT.
           ADD 1 TO Y. PERFORM PDBY. MOVE DBY TO NXT. SUBTRACT 1 FROM Y.
       PSTEP.
           ADD 1 TO Y. PERFORM PNEXT.
       PLEAP.
           MOVE 0 TO LEAP.
           DIVIDE Y BY 4 GIVING Q.
           IF Q * 4 = Y MOVE 1 TO LEAP.
           DIVIDE Y BY 100 GIVING Q.
           IF Q * 100 = Y MOVE 0 TO LEAP.
           DIVIDE Y BY 400 GIVING Q.
           IF Q * 400 = Y MOVE 1 TO LEAP.
       PMON.
           SUBTRACT 1 FROM M.
           MOVE CUM (M) TO CM.
           IF M > 2 ADD LEAP TO CM.
