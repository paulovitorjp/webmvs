#!/bin/bash
# Add the longjmp counter (bench/ljcount/ljcount.h) to a Hyperion source tree (ee86c4d + patches).
# Usage: bench/ljcount/instrument.sh <tree>     
set -euo pipefail
T=$1; D=$(cd "$(dirname "$0")" && pwd)
cp "$D/ljcount.h" "$T/ljcount.h"
python3 - "$T" <<'PY'
import sys, re
t = sys.argv[1]
def edit(fn, old, new, count=1):
    p = f"{t}/{fn}"; s = open(p).read()
    if new in s: return
    assert s.count(old) >= 1, (fn, old)
    s = s.replace(old, new, count); open(p, "w").write(s)
edit("hstdinc.h", "#include <setjmp.h>\n",
     "#include <setjmp.h>\n#define HW_LJCOUNT 1 /* perf instrumentation */\n"
     "extern void hw_lj_count(const char *file, int line);\nextern void hw_lj_pcode(int pcode);\nextern void hw_lj_land(void);\n"
     "#define longjmp(b, v) (hw_lj_count(__FILE__, __LINE__), longjmp((b), (v)))\n")
# cpu.c: implementation once (guarded), program interrupt code, landing time
edit("cpu.c", '#include "inline.h"\n', '#include "inline.h"\n#include "ljcount.h"\n')
edit("cpu.c", '    PTT_PGM("PGM", pcode, regs->TEA, regs->psw.IA );\n',
     '    hw_lj_pcode(pcode);\n    PTT_PGM("PGM", pcode, regs->TEA, regs->psw.IA );\n')
edit("cpu.c", "    /* Set `execflag' to 0 in case EXecuted instruction did a longjmp() */\n    regs->execflag = 0;\n",
     "    hw_lj_land();\n    /* Set `execflag' to 0 in case EXecuted instruction did a longjmp() */\n    regs->execflag = 0;\n")
print("instrumented", t)
PY
grep -n "ljcount\|hw_lj_" "$T/hstdinc.h" "$T/cpu.c" | head
