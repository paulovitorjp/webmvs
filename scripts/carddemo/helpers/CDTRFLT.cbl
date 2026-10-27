       IDENTIFICATION DIVISION.
       PROGRAM-ID. CDTRFLT.
      * TRANSACTION REPORT: KEEP THE TRANSACTIONS PROCESSED BETWEEN THE
      * TWO DATES OF DATEPARM ('YYYY-MM-DD YYYY-MM-DD'). IT DOES WHAT THE
      * SORT INCLUDE STATEMENT OF THE ORIGINAL TRANREPT JOB DOES.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT TRANIN  ASSIGN TO UT-S-TRANIN.
           SELECT TRANOUT ASSIGN TO UT-S-TRANOUT.
           SELECT DATEPRM ASSIGN TO UT-S-DATEPARM.
       DATA DIVISION.
       FILE SECTION.
       FD  TRANIN
           LABEL RECORDS ARE STANDARD.
       01  TI-REC.
           05  FILLER       PIC X(304).
           05  TI-PROC-DATE PIC X(10).
           05  FILLER       PIC X(36).
       FD  TRANOUT
           LABEL RECORDS ARE STANDARD.
       01  TO-REC           PIC X(350).
       FD  DATEPRM
           LABEL RECORDS ARE STANDARD.
       01  DP-REC.
           05  DP-START     PIC X(10).
           05  FILLER       PIC X.
           05  DP-END       PIC X(10).
           05  FILLER       PIC X(59).
       WORKING-STORAGE SECTION.
       77  EOF-FLAG         PIC X VALUE 'N'.
       77  N-IN             PIC 9(8) VALUE 0.
       77  N-OUT            PIC 9(8) VALUE 0.
       01  START-DATE       PIC X(10).
       01  END-DATE         PIC X(10).
       PROCEDURE DIVISION.
       P0.
           OPEN INPUT DATEPRM.
           READ DATEPRM AT END MOVE SPACES TO DP-REC.
           MOVE DP-START TO START-DATE.
           MOVE DP-END TO END-DATE.
           CLOSE DATEPRM.
           OPEN INPUT TRANIN.
           OPEN OUTPUT TRANOUT.
           PERFORM P1 UNTIL EOF-FLAG = 'Y'.
           CLOSE TRANIN.
           CLOSE TRANOUT.
           DISPLAY 'CDTRFLT: ' START-DATE ' TO ' END-DATE ', READ '
               N-IN ', KEPT ' N-OUT.
           STOP RUN.
       P1.
           READ TRANIN AT END MOVE 'Y' TO EOF-FLAG.
           IF EOF-FLAG = 'N'
               ADD 1 TO N-IN
               IF TI-PROC-DATE NOT < START-DATE AND
                  TI-PROC-DATE NOT > END-DATE
                   ADD 1 TO N-OUT
                   WRITE TO-REC FROM TI-REC.
