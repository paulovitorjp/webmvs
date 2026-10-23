/* setjmp/longjmp micro-benchmark shaped like Hercules run_cpu().
 *
 * Shape copied from hyperion ee86c4d cpu.c:2038-2100 and opcode.h:636:
 *   run_cpu() calls setjmp(regs->progjmp) once, then runs an endless
 *   dispatch loop through a 256-entry opcode table (function pointers).
 *   An instruction handler that needs an interrupt check (SVC, LPSW, ...)
 *   calls a non-inlined helper (program_interrupt / RETURN_INTCHECK) that
 *   does longjmp(regs->progjmp, code). Control comes back at the setjmp,
 *   which re-arms it, and the loop continues.
 *
 * Tests (each reported as ns per unit):
 *   jmp1    every instruction longjmps (K=1): cost of one setjmp+longjmp
 *           round trip plus one dispatch. Unit = longjmp.
 *   nojmp   same loop, no instruction longjmps. Unit = dispatched instruction.
 *           (Under JS SjLj every call made by the setjmp function goes
 *           through an invoke_* JS wrapper, so this shows that tax.)
 *   jmp256  one longjmp every 256 instructions. Unit = instruction.
 *
 * Usage: longjmp_bench [N=10000000] [reps=5]
 */
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <time.h>

#define NOINLINE __attribute__((noinline))

typedef struct REGS REGS;
typedef void (*INSTR_FUNC)(const uint8_t *ip, REGS *regs);

struct REGS {
    jmp_buf   progjmp;
    uint64_t  instcount;     /* instructions executed */
    uint64_t  jumps;         /* longjmps taken */
    uint64_t  limit;         /* stop after this many instructions */
    uint64_t  gr[16];
    const uint8_t *ip;       /* current "PSW" into the stream */
    const uint8_t *stream;
    const uint8_t *stream_end;
    int       execflag;
};

static INSTR_FUNC opcode_table[256];

static double now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}

/* Like program_interrupt() / RETURN_INTCHECK: never returns. */
NOINLINE static void program_interrupt(REGS *regs, int code)
{
    regs->jumps++;
    regs->gr[15] ^= (uint64_t)code;
    longjmp(regs->progjmp, code);
}

static inline void advance(REGS *regs)
{
    regs->ip++;
    if (regs->ip == regs->stream_end)
        regs->ip = regs->stream;
}

/* An ordinary instruction (like LR / AR). */
NOINLINE static void op_ar(const uint8_t *ip, REGS *regs)
{
    int r = ip[0] & 15;
    regs->gr[r] += regs->gr[(r + 1) & 15] + 1;
    advance(regs);
}

/* An instruction that ends with RETURN_INTCHECK (like SVC / LPSW). */
NOINLINE static void op_svc(const uint8_t *ip, REGS *regs)
{
    regs->gr[1] += ip[0];
    advance(regs);
    regs->instcount++;           /* count it: the longjmp skips the loop's ++ */
    program_interrupt(regs, 0x0A);
}

/* The CPU loop. Returns when instcount reaches limit (checked every
   instruction here; Hercules checks INTERRUPT_PENDING every MAX_CPU_LOOPS). */
NOINLINE static void run_cpu(REGS *regs)
{
    if (setjmp(regs->progjmp)) {
        /* Came back from a longjmp: Hercules updates counters and traces here. */
        regs->execflag = 0;
    }
    for (;;) {
        if (regs->instcount >= regs->limit)
            return;
        const uint8_t *ip = regs->ip;
        opcode_table[ip[0]](ip, regs);
        regs->instcount++;
    }
}

static uint8_t *make_stream(int k)
{
    /* k-1 ordinary instructions then one SVC; k==0 means no SVC at all. */
    int len = k ? k : 256;
    uint8_t *s = malloc((size_t)len);
    for (int i = 0; i < len; i++)
        s[i] = (uint8_t)(0x10 + (i % 15));       /* 0x10..0x1E -> op_ar */
    if (k)
        s[len - 1] = 0x0A;                        /* SVC */
    return s;
}

static double run_test(int k, uint64_t n, uint64_t *jumps_out)
{
    REGS *regs = calloc(1, sizeof(REGS));
    uint8_t *s = make_stream(k);
    int len = k ? k : 256;
    regs->stream = regs->ip = s;
    regs->stream_end = s + len;
    regs->limit = n;
    double t0 = now_ns();
    run_cpu(regs);
    double t1 = now_ns();
    uint64_t sum = 0;
    for (int i = 0; i < 16; i++) sum += regs->gr[i];
    if (sum == 0x123456789ULL) printf("unlikely\n");  /* keep results live */
    if (regs->instcount != n) {
        printf("ERROR instcount %llu != %llu\n",
               (unsigned long long)regs->instcount, (unsigned long long)n);
        exit(2);
    }
    *jumps_out = regs->jumps;
    free(s); free(regs);
    return t1 - t0;
}

static int cmp_d(const void *a, const void *b)
{
    double x = *(const double *)a, y = *(const double *)b;
    return x < y ? -1 : x > y;
}

int main(int argc, char **argv)
{
    uint64_t n = argc > 1 ? strtoull(argv[1], 0, 10) : 10000000ULL;
    int reps = argc > 2 ? atoi(argv[2]) : 5;
    if (reps < 1) reps = 1;
    if (reps > 32) reps = 32;

    for (int i = 0; i < 256; i++) opcode_table[i] = op_ar;
    opcode_table[0x0A] = op_svc;

    static const struct { const char *name; int k; } tests[] = {
        { "jmp1", 1 }, { "nojmp", 0 }, { "jmp256", 256 },
    };
    uint64_t j;
    for (unsigned t = 0; t < sizeof tests / sizeof tests[0]; t++) {
        run_test(tests[t].k, n / 10, &j);            /* warm-up (JIT tier-up) */
        double v[32];
        for (int r = 0; r < reps; r++) {
            v[r] = run_test(tests[t].k, n, &j);
        }
        qsort(v, (size_t)reps, sizeof v[0], cmp_d);
        double unit = tests[t].k == 1 ? (double)j : (double)n;
        printf("RESULT test=%s n=%llu longjmps=%llu reps=%d min_ns_per=%.2f "
               "median_ns_per=%.2f max_ns_per=%.2f min_total_ms=%.1f\n",
               tests[t].name, (unsigned long long)n, (unsigned long long)j, reps,
               v[0] / unit, v[reps / 2] / unit, v[reps - 1] / unit, v[0] / 1e6);
        fflush(stdout);
    }
    printf("DONE\n");
    fflush(stdout);
    return 0;
}
