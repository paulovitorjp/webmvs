#!/usr/bin/env python3
"""Make patch 0007 in a clean Hyperion ee86c4d tree (edits in place; then `git diff`).
Usage: mk-0007.py <tree>"""
import sys
t = sys.argv[1]
def edit(fn, old, new, count=1):
    p = f"{t}/{fn}"; s = open(p).read()
    n = s.count(old)
    assert n == count, (fn, n, old)
    s = s.replace(old, new); open(p, "w").write(s)

edit("opcode.h",
"""/*-------------------------------------------------------------------*/
/*         Simple helper macro that instructions can use             */
/*         to force an immediate check for interrupts.               */
/*-------------------------------------------------------------------*/

#define RETURN_INTCHECK(_regs)                                        \\
        longjmp((_regs)->progjmp, SIE_NO_INTERCEPT)
""",
"""/*-------------------------------------------------------------------*/
/*         Simple helper macro that instructions can use             */
/*         to force an immediate check for interrupts.               */
/*-------------------------------------------------------------------*/
/* RETURN_INTCHECK may be used ONLY in the body of a DEF_INST        */
/* instruction function: outside SIE mode it ends the instruction    */
/* with a normal return. INVALIDATE_AIA makes the next               */
/* UNROLLED_EXECUTE break out of the run_cpu loop, and the 'intcheck'*/
/* flag makes run_cpu continue at the point where a longjmp(progjmp) */
/* would have landed (execflag reset, then the interrupt check).     */
/* This avoids a longjmp (a wasm exception throw, slow in some       */
/* engines) for LPSW, SSM, STNSM, STOSM, SVC, LCTL and the others.   */
/* Helper functions (not DEF_INST) use RETURN_INTCHECK_LONGJMP.      */
/*-------------------------------------------------------------------*/

#define RETURN_INTCHECK_LONGJMP(_regs)                                \\
        longjmp((_regs)->progjmp, SIE_NO_INTERCEPT)

#define RETURN_INTCHECK(_regs)                                        \\
  do                                                                  \\
  {                                                                   \\
    if (SIE_MODE( _regs ))                                            \\
        RETURN_INTCHECK_LONGJMP( _regs );                             \\
    INVALIDATE_AIA( _regs );                                          \\
    (_regs)->intcheck = 1;                                            \\
    return;                                                           \\
  }                                                                   \\
  while (0)
""")

edit("inline.h", """    if (OPEN_IC_PER_GRA( regs ))
        RETURN_INTCHECK( regs );
""", """    if (OPEN_IC_PER_GRA( regs ))
        RETURN_INTCHECK_LONGJMP( regs );
""")
edit("inline.h", """        if (OPEN_IC_PER_ZEROADDR( regs ))
            RETURN_INTCHECK( regs );
""", """        if (OPEN_IC_PER_ZEROADDR( regs ))
            RETURN_INTCHECK_LONGJMP( regs );
""")

edit("hstructs.h", """                diagnose:1;             /* Diagnose instr executing  */
""", """                diagnose:1,             /* Diagnose instr executing  */
                intcheck:1;             /* 1=RETURN_INTCHECK done    */
""")

edit("cpu.c", """    /* Set `execflag' to 0 in case EXecuted instruction did a longjmp() */
    regs->execflag = 0;
""", """    /* An instruction that ended with RETURN_INTCHECK continues here */
intcheck_resume:

    /* Set `execflag' to 0 in case EXecuted instruction did a longjmp() */
    regs->execflag = 0;
""")
CHK = """    /* Instruction ended with RETURN_INTCHECK? (see opcode.h) */
    if (regs->intcheck)
    {
        regs->intcheck = 0;
        goto intcheck_resume;
    }
"""
edit("cpu.c", """    DO_AUTOMATIC_TRACING();
    goto fastest_no_txf_loop;
""", """    DO_AUTOMATIC_TRACING();
""" + CHK + """    goto fastest_no_txf_loop;
""")
edit("cpu.c", """    DO_AUTOMATIC_TRACING();

//txf_slower_loop:
""", """    DO_AUTOMATIC_TRACING();
""" + CHK + """
//txf_slower_loop:
""")
edit("cpu.c", """    DO_AUTOMATIC_TRACING();
    goto txf_facility_loop;
""", """    DO_AUTOMATIC_TRACING();
""" + CHK + """    goto txf_facility_loop;
""")
print("0007 edits done")
