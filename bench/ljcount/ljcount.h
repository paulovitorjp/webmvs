/* bench/ljcount/ljcount.h -- perf instrumentation. NOT for release builds.
 *
 * Counts every longjmp() made by Hercules, by source site (__FILE__:__LINE__ of the call, so a
 * RETURN_INTCHECK reports the line of the instruction that used it), counts program interrupts by
 * code, and times each longjmp(progjmp) from the call to the landing in run_cpu (hw_lj_land).
 * bench/ljcount/instrument.sh copies this file into a Hyperion tree, #includes it once in cpu.c
 * and adds a longjmp() wrapper macro to hstdinc.h. Works for the native and the wasm build.
 *
 * Output: every second a block is appended to ./ljcount.log (cwd = the run dir):
 *   T <epoch.ms> inst=<sysblk.instcount> lj=<total longjmps> land=<timed landings> ljns=<sum ns>
 *     longest=<ns> waitus=<CP00 waittime_accumulated+waittime, us>
 *   S <file>:<line>=<count> ...        (cumulative, nonzero sites)
 *   P <pcode hex>=<count> ...          (cumulative program interrupts by pcode & 0xFF)
 */
#ifndef HW_LJCOUNT_IMPL
#define HW_LJCOUNT_IMPL
#include <pthread.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include <sys/time.h>

#define HW_LJ_SLOTS 1024
typedef struct { const char *file; int line; unsigned long long n; } hw_lj_site_t;
static hw_lj_site_t       hw_lj_tab[HW_LJ_SLOTS];
static unsigned long long hw_lj_pc[256];
static unsigned long long hw_lj_total, hw_lj_ns, hw_lj_lands, hw_lj_longest;
static unsigned long long hw_lj_t0;            /* start of the pending longjmp (ns), 0 = none */
static int                hw_lj_started;

#define HW_LD(x)     __atomic_load_n(&(x), __ATOMIC_RELAXED)
#define HW_ADD(x, v) __atomic_fetch_add(&(x), (v), __ATOMIC_RELAXED)

static unsigned long long hw_lj_now(void)
{
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long long)ts.tv_sec * 1000000000ull + (unsigned long long)ts.tv_nsec;
}

static void hw_lj_dump(void)
{
    FILE *f = fopen("ljcount.log", "a");
    struct timeval tv; int i; REGS *r = sysblk.regs[0];
    unsigned long long wus = 0;
    if (!f) return;
    gettimeofday(&tv, NULL);
    if (r) wus = (unsigned long long) ETOD_high64_to_usecs(r->waittime_accumulated + r->waittime);
    fprintf(f, "T %lld.%03d inst=%llu lj=%llu land=%llu ljns=%llu longest=%llu waitus=%llu\nS",
            (long long)tv.tv_sec, (int)(tv.tv_usec / 1000), (unsigned long long)sysblk.instcount,
            HW_LD(hw_lj_total), HW_LD(hw_lj_lands), HW_LD(hw_lj_ns), HW_LD(hw_lj_longest), wus);
    for (i = 0; i < HW_LJ_SLOTS; i++) {
        const char *fn = __atomic_load_n(&hw_lj_tab[i].file, __ATOMIC_ACQUIRE);
        if (fn) { const char *b = strrchr(fn, '/'); fprintf(f, " %s:%d=%llu", b ? b + 1 : fn, hw_lj_tab[i].line, HW_LD(hw_lj_tab[i].n)); }
    }
    fprintf(f, "\nP");
    for (i = 0; i < 256; i++) if (HW_LD(hw_lj_pc[i])) fprintf(f, " %02X=%llu", i, HW_LD(hw_lj_pc[i]));
    fprintf(f, "\n");
    fclose(f);
}

static void *hw_lj_thread(void *arg)
{
    (void)arg;
    for (;;) { sleep(1); hw_lj_dump(); }
    return NULL;
}

static void hw_lj_start(void)
{
    int z = 0;
    if (__atomic_compare_exchange_n(&hw_lj_started, &z, 1, 0, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED)) {
        pthread_t t; pthread_attr_t a;
        pthread_attr_init(&a); pthread_attr_setdetachstate(&a, PTHREAD_CREATE_DETACHED);
        pthread_create(&t, &a, hw_lj_thread, NULL);
    }
}

void hw_lj_count(const char *file, int line)
{
    unsigned int h = (unsigned int)(((uintptr_t)file >> 3) * 31u + (unsigned int)line * 2654435761u) % HW_LJ_SLOTS, k;
    if (!HW_LD(hw_lj_started)) hw_lj_start();
    for (k = 0; k < HW_LJ_SLOTS; k++, h = (h + 1) % HW_LJ_SLOTS) {
        const char *cur = __atomic_load_n(&hw_lj_tab[h].file, __ATOMIC_ACQUIRE);
        if (cur == file && hw_lj_tab[h].line == line) break;
        if (!cur) {
            const char *exp = NULL;
            hw_lj_tab[h].line = line;    /* set before publishing the file pointer */
            if (__atomic_compare_exchange_n(&hw_lj_tab[h].file, &exp, file, 0, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) break;
            if (exp == file && hw_lj_tab[h].line == line) break;
        }
    }
    if (k < HW_LJ_SLOTS) HW_ADD(hw_lj_tab[h].n, 1);
    HW_ADD(hw_lj_total, 1);
    hw_lj_t0 = hw_lj_now();
}

void hw_lj_pcode(int pcode)
{
    HW_ADD(hw_lj_pc[pcode & 0xFF], 1);
}

void hw_lj_land(void)
{
    if (hw_lj_t0) {
        unsigned long long d = hw_lj_now() - hw_lj_t0;
        hw_lj_t0 = 0;
        HW_ADD(hw_lj_ns, d); HW_ADD(hw_lj_lands, 1);
        if (d > hw_lj_longest) hw_lj_longest = d;
    }
}
#endif /* HW_LJCOUNT_IMPL */
