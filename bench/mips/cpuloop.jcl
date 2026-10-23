//CPULOOP  JOB (1),'PERF LOOP',CLASS=A,MSGCLASS=A,MSGLEVEL=(1,1),
//             TIME=1440
//* CPU-bound S/370 loop (no SVC in the loop). Inner loop =
//* 12 instructions (L A ST MVC CLC SR IC SLL N LR AR BCT) x 100, outer
//* BCT; COUNT outer iterations = about COUNT x 1202 instructions.
//* SYSPUNCH DUMMY: a punch deck needs an operator forms setup
//* ($HASP190), which blocks the JES2 drain at shutdown.
//STEP1    EXEC ASMFCLG
//ASM.SYSPUNCH DD DUMMY
//ASM.SYSIN DD *
CPULOOP  CSECT
         STM   14,12,12(13)
         BALR  12,0
         USING *,12
         L     5,COUNT
OUTER    LA    6,100
INNER    L     2,VALA
         A     2,VALB
         ST    2,VALC
         MVC   FLDD(16),FLDE
         CLC   FLDD(16),FLDE
         SR    3,3
         IC    3,VALC+3
         SLL   3,2
         N     3,MASK
         LR    4,3
         AR    4,2
         BCT   6,INNER
         BCT   5,OUTER
         LM    14,12,12(13)
         SR    15,15
         BR    14
COUNT    DC    F'1000000'
VALA     DC    F'1'
VALB     DC    F'3'
VALC     DC    F'0'
MASK     DC    F'255'
FLDD     DS    CL16
FLDE     DC    CL16'ABCDEFGHIJKLMNOP'
         END   CPULOOP
/*
//
