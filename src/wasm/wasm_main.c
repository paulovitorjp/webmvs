// SPDX-License-Identifier: Apache-2.0
/* WASM_MAIN.C   main() for the wasm32 Hercules build (webmvs)       */
/*                                                                   */
/*   Linked into Hercules (QPL 1.0); distributed as a separate file. */
/*   Based on the herclin.c model (herclin.c main()):                */
/*     registerLogCallback(cb) -> impl(argc,argv) ->                 */
/*     sysblk.panel_init = sysblk.herclin = 1 -> wait until exit.    */
/*                                                                   */
/*   Never pass -d/-n to impl(): in NoUI mode impl() runs the rc     */
/*   file synchronously before it returns (impl.c, process_rc_file). */
/*   With a log callback impl() returns after setup, and the rc      */
/*   thread starts when it sees sysblk.panel_init (it polls 10 ms).  */
/*                                                                   */
/*   With -sPROXY_TO_PTHREAD this main() runs on a pthread (worker), */
/*   so blocking waits are allowed here.                             */
/*                                                                   */
/*   Extra option (removed before impl() sees argv):                 */
/*     --cmdfile=PATH  poll PATH every 100 ms; each new complete     */
/*                     line is a Hercules panel command. This is for */
/*                     Node tests only (NODERAWFS reads the real     */
/*                     file); the browser build will use an export.  */
/*                                                                   */
/*   Browser build (-DHW_WEB, with webrt.c): more options:         */
/*     --cwd=DIR       mkdir -p DIR and chdir there before impl()    */
/*     --webload=JSON  fetch DASD chunks + boot files into WasmFS    */
/*                     before impl() (webrt_load, loader worker)     */
/*     --log-stdout    also write the log to stdout (debug)          */
/*     --opfs=DIR      mount the WasmFS OPFS backend at DIR before    */
/*                     --webload (persistent shadow files)            */
/*     --cckd-wrthru   CCKD write-through (patch 0014): a channel  */
/*                     program ends only after its updated tracks are */
/*                     written to the shadow file                     */
/*     --cckd-wrthru-skip=0152[,...]  devices without write-through   */
/*     --outsink=DIR[,DIR...]  output device dirs (printers,       */
/*                     punchcards) on the bounded outsink backend     */
/*                     (outsink.cpp): only the last bytes of each     */
/*                     file stay in the heap and run out of memory)  */
/*     --outsink-ring=KIB  bytes kept per output file (default 64)    */
/*   The log goes to the webrt log ring (page: hw_log_read), and     */
/*   commands come from hw_command() through a command thread.       */

#include "hstdinc.h"
#include "hercules.h"
#ifdef HW_WEB
#include "cckddasd.h"
#include "webrt.h"
#include <dirent.h>     /* snaprm */
#include <sys/stat.h>
static int log_stdout = 0;
extern int cckd_wasm_wrthru;     /* patch 0014-cckd-write-through (cckddasd.c) */
extern U16 cckd_wasm_wrthru_skip[ 8 ];
extern int cckd_wasm_wrthru_nskip;
extern int hw_outsink_mount( const char* dir, double ringBytes );   /* outsink.cpp */
#endif

/* Plain pthread objects, not Hercules LOCK/COND: those need the    */
/* hthreads lock list, which impl() initializes. (Before that, the   */
/* list anchor is zero and a lookup reads address 0, which does not  */
/* trap in wasm: it spins.)                                          */
static volatile int    hercules_has_exited = 0;
static pthread_mutex_t exit_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t  exit_cond = PTHREAD_COND_INITIALIZER;

/* Log callback: runs on impl.c's log_do_callback thread. msglen==0  */
/* means the logger ended (Hercules has shut down).                  */
static void wasm_log_callback( const char* msg, size_t msglen )
{
    if (!msglen)
    {
        static const char m[] = "wasm_main: log callback got end of log\n";
        (void) write( 2, m, sizeof( m ) - 1 );
#ifdef HW_WEB
        webrt_set_phase( WEBRT_PHASE_ENDED );
        webrt_cmd_wake();
#endif
        pthread_mutex_lock( &exit_lock );
        hercules_has_exited = 1;
        pthread_cond_broadcast( &exit_cond );
        pthread_mutex_unlock( &exit_lock );
        return;
    }
#ifdef HW_WEB
    webrt_log_put( msg, msglen );
    if (!log_stdout) return;
#endif
    fwrite( msg, 1, msglen, stdout );
    fflush( stdout );
}

static const char*     cmdfile = NULL;
static COMMANDHANDLER  process_command = NULL;

static void* cmdfile_thread( void* arg )
{
    long   offset = 0;
    char   line[ 1024 ];
    size_t used = 0;

    UNREFERENCED( arg );

    while (!hercules_has_exited)
    {
        FILE* f = fopen( cmdfile, "r" );
        if (f)
        {
            int c;
            if (fseek( f, offset, SEEK_SET ) == 0)
            {
                while ((c = fgetc( f )) != EOF)
                {
                    offset++;
                    if (c == '\n')
                    {
                        line[ used ] = 0;
                        used = 0;
                        if (line[0] && process_command)
                            process_command( line );
                    }
                    else if (c != '\r' && used < sizeof( line ) - 1)
                        line[ used++ ] = (char) c;
                }
            }
            fclose( f );
        }
        USLEEP( 100 * 1000 );
    }
    return NULL;
}

#ifdef HW_WEB
/* MVS 3.8 SRM time-driven interval.        */
/*                                                                   */
/* TSO answers 30-200 times slower while a CPU-bound               */
/* batch job runs (NUMCPU 1). Measured on native Hercules too, so it */
/* is MVS: a TSO user is swapped out at every terminal wait, and the */
/* SRM swaps it in again only at its next time-driven invocation.    */
/* With an idle CPU that comes at once (wait state); with a CPU-     */
/* bound job only at the SRM timer, every 1000 units of 1.024 ms     */
/* (the external interrupt comes every 1.024 s, and every TSO reply  */
/* ends just after one). The                                       */
/* interval is an SRM constant in the nucleus (IRARMCNS), not an     */
/* IEAOPT/IEAIPS parameter in MVS 3.8. "srmtune N" (page command at  */
/* TSO ready; not a Hercules command) sets in main storage:          */
/*   RMPT+X'18' RMPTTOM = N, RMPT+X'1C' RMPTTOL = N/2, and the        */
/*   invocation interval RMEP+X'1C' of every time-driven SRM routine  */
/*   that has the default 1000 to N.                                  */
/* Layouts: OS/VS2 Debugging Handbook Vol. 3 (GC28-0710-0), RMCT,     */
/* RMPT, RMEP. CVT = PSA+X'10', RMCT = CVT+X'25C' (CVTOPCTP), RMPT =  */
/* RMCT+X'10', time-driven queue head = RMCT+X'5C' (RMCTTMQE). All    */
/* are in the nucleus (V=R). Every eye-catcher is checked first       */
/* ('RMCT', 'RMPT', 'TMQE'); on any mismatch nothing is changed.      */
#define SRM_EBC_RMCT 0xD9D4C3E3u
#define SRM_EBC_RMPT 0xD9D4D7E3u
#define SRM_EBC_TMQE 0xE3D4D8C5u
static U32 srm_px;
static int srm_get( U32 a, U32* v )
{
    U32 p, x;
    a &= 0x7FFFFFFF; p = a & 0x7FFFF000;
    x = (p == 0 || p == srm_px) ? (a ^ srm_px) : a;      /* S/370 prefixing */
    if ((U64) x + 4 > (U64) sysblk.mainsize) return 0;
    *v = ((U32) sysblk.mainstor[x] << 24) | ((U32) sysblk.mainstor[x+1] << 16)
       | ((U32) sysblk.mainstor[x+2] << 8) | sysblk.mainstor[x+3];
    return 1;
}
static int srm_put( U32 a, U32 v )
{
    U32 p, x;
    a &= 0x7FFFFFFF; p = a & 0x7FFFF000;
    x = (p == 0 || p == srm_px) ? (a ^ srm_px) : a;
    if ((U64) x + 4 > (U64) sysblk.mainsize) return 0;
    __atomic_store_n( (U32*)(sysblk.mainstor + x), CSWAP32( v ), __ATOMIC_SEQ_CST );   /* aligned fullword */
    return 1;
}
/* returns the number of RMEP intervals changed (>= 0) or < 0 if the */
/* control blocks were not found                                      */
static int srm_tune( U32 n, char* msg, size_t msz )
{
    U32 cvt, rmct, rmpt, head, eye, p, iv, tom = 0, tol = 0;
    int k, changed = 0;
    if (!sysblk.mainstor || !sysblk.regs[0]) { snprintf( msg, msz, "no CPU" ); return -1; }
    srm_px = (U32) sysblk.regs[0]->PX_L & 0x7FFFF000;
    if (!srm_get( 0x10, &cvt ) || !(cvt &= 0x7FFFFFFF)) { snprintf( msg, msz, "no CVT" ); return -2; }
    if (!srm_get( cvt + 0x25C, &rmct ) || !srm_get( rmct, &eye ) || eye != SRM_EBC_RMCT) { snprintf( msg, msz, "no RMCT" ); return -3; }
    if (!srm_get( rmct + 0x10, &rmpt ) || !srm_get( rmpt, &eye ) || eye != SRM_EBC_RMPT) { snprintf( msg, msz, "no RMPT" ); return -4; }
    if (!srm_get( rmct + 0x5C, &head ) || !(head &= 0x7FFFFFFF) || !srm_get( head + 0x0C, &eye ) || eye != SRM_EBC_TMQE)
        { snprintf( msg, msz, "no TMQE" ); return -5; }
    srm_get( rmpt + 0x18, &tom ); srm_get( rmpt + 0x1C, &tol );
    srm_put( rmpt + 0x18, n ); srm_put( rmpt + 0x1C, n > 1 ? n / 2 : 1 );
    if (!srm_get( head + 0x10, &p )) p = 0;
    for (k = 0; k < 64 && (p &= 0x7FFFFFFF) && p != head; k++)
    {
        if (srm_get( p + 0x1C, &iv ) && iv == 1000) { srm_put( p + 0x1C, n ); changed++; }
        if (!srm_get( p + 0x10, &p )) break;
    }
    snprintf( msg, msz, "RMCT %08X RMPT %08X: RMPTTOM %u -> %u, RMPTTOL %u -> %u, %d of %d time-driven SRM routines 1000 -> %u (units of 1.024 ms)",
              rmct, rmpt, tom, n, tol, n > 1 ? n / 2 : 1, changed, k, n );
    return changed;
}

/* "snaprm <dir>" (page runtime, hidden). The                      */
/* runtime keeps the last 2 snapshot slots /opfs/snap/s<n> and used  */
/* to remove older ones from its own OPFS worker, behind the back of */
/* WasmFS. WasmFS caches every directory entry it has seen (dcache:  */
/* a File object per child, and for the OPFS backend a JS            */
/* FileSystemHandle per File), so every removed slot (its directory  */
/* and the ~10 files the checkpoint wrote) stayed cached for the     */
/* life of the page: about 12 OPFS handles per checkpoint that were  */
/* never released (Chromium: the browser process grew by about 0.3   */
/* MiB per checkpoint). Removing the slot through WasmFS (unlink +   */
/* rmdir) drops the cache entries, so the handles are freed. Only    */
/* /opfs/snap/s<digits> (and one subdirectory level) is accepted.    */
static int snaprm_dir( const char* dir, int depth, int* files )
{
    char names[ 64 ][ 128 ], p[ 512 ];
    int n = 0, rc = 0, i;
    struct dirent* e;
    DIR* d = opendir( dir );
    if (!d) return -errno;
    while ((e = readdir( d )) && n < 64)
    {
        if (!strcmp( e->d_name, "." ) || !strcmp( e->d_name, ".." ) || strlen( e->d_name ) >= sizeof( names[0] )) continue;
        strcpy( names[ n++ ], e->d_name );
    }
    closedir( d );
    for (i = 0; i < n; i++)
    {
        struct stat st;
        snprintf( p, sizeof( p ), "%s/%s", dir, names[i] );
        if (lstat( p, &st ) == 0 && S_ISDIR( st.st_mode ))
        {
            int r = depth < 1 ? snaprm_dir( p, depth + 1, files ) : -EMLINK;
            if (r && !rc) rc = r;
        }
        else if (unlink( p ) == 0) (*files)++;
        else if (!rc) rc = -errno;
    }
    if (rmdir( dir ) != 0 && !rc) rc = -errno;
    return rc;
}
static int snaprm( const char* dir, int* files )
{
    const char* q = dir + 12;
    *files = 0;
    if (strncmp( dir, "/opfs/snap/s", 12 ) != 0 || !*q) return -EINVAL;
    for (; *q; q++) if (*q < '0' || *q > '9') return -EINVAL;
    return snaprm_dir( dir, 0, files );
}

/* Browser: run the commands queued by hw_command() (page, main      */
/* thread) and sample the heap statistics.                           */
static void* webcmd_thread( void* arg )
{
    char line[ WEBRT_CMD_LEN ];
    UNREFERENCED( arg );
    webrt_stats_sample();
    while (!hercules_has_exited)
    {
        if (webrt_cmd_next( line, 250 ) && line[0] && process_command && !hercules_has_exited)
        {
            if (strncmp( line, "srmtune", 7 ) == 0 && (line[7] == 0 || line[7] == ' '))
            {
                /* see srm_tune() above */
                char msg[ 256 ];
                long n = line[7] ? strtol( line + 8, NULL, 10 ) : 20;
                int rc = (n >= 1 && n <= 1000) ? srm_tune( (U32) n, msg, sizeof( msg ) ) : (snprintf( msg, sizeof( msg ), "bad value" ), -9);
                webrt_stat_set( WEBRT_ST_SRMTUNE, rc >= 0 ? (uint32_t)( n * 1000 + rc ) : 0 );
                logmsg( "wasm_main: srmtune %ld rc=%d: %s\n", n, rc, msg );
                webrt_stat_add( WEBRT_ST_CMDS, 1 );
                continue;
            }
            if (strncmp( line, "snaprm ", 7 ) == 0)
            {
                int files = 0, rc = snaprm( line + 7, &files );
                logmsg( "wasm_main: snaprm %s rc=%d files=%d\n", line + 7, rc, files );
                webrt_stat_add( WEBRT_ST_CMDS, 1 );
                continue;
            }
            process_command( line );
            webrt_stat_add( WEBRT_ST_CMDS, 1 );
        }
        webrt_stats_sample();
    }
    return NULL;
}
#endif

#ifdef HW_WEB
/* save state of the CCKD files for the page.     */
/*                                                                   */
/* CCKD keeps an updated track in its cache until the next Dasd      */
/* Hardener (dhint) or garbage collector (gcint) pass flushes it to  */
/* the writer thread; only then does it reach the shadow file on     */
/* OPFS. A reload in that window loses the change (measured: no    */
/* track write within 3 s after a TSO                              */
/* SAVE). This thread computes "unsaved" = updated track images in   */
/* the cache (not yet written), every 100 ms, into                   */
/* hw_stat(WEBRT_ST_DIRTY) (+ device masks). hw_cckd_flush() (page, lock- */
/* free) asks for an immediate hardener pass (flush + wait for the    */
/* writes + harden + fdatasync = OPFS flush()), as "cckd dhint=" does */
/* (cckddasd.c cckd_command: broadcast dhcond).                       */
#define DIRTY_MAXDEV 16
struct dirty_ctx { int n; int ndev; U16 devnum[ DIRTY_MAXDEV ]; uint32_t mask, hmask; uint32_t uwrites; };
/* write counts per device at the last sample, and when each device was last seen written */
static uint32_t dev_writes_prev[ DIRTY_MAXDEV ];
static time_t   dev_written_at[ DIRTY_MAXDEV ];
static int dirty_scan( int* answer, int ix, int i, void* data )
{
    struct dirty_ctx* c = data;
    U16 devnum; U32 trk; int k;
    UNREFERENCED( answer );
    if (cache_getflag( ix, i ) & (CCKD_CACHE_UPDATED | CCKD_CACHE_WRITE | CCKD_CACHE_WRITING))
    {
        c->n++;
        CCKD_CACHE_GETKEY( i, devnum, trk );
        UNREFERENCED( trk );
        for (k = 0; k < c->ndev; k++) if (c->devnum[k] == devnum) c->mask |= 1u << k;
    }
    return 0;
}
/* Unsaved CCKD data = updated track images still in the CCKD cache (not yet written by the writer thread; once   */
/* written, the track image and its L2 entry are in the shadow file: cckd_write_trkimg -> cckd_write_l2ent).     */
/* Returns their count; *mask = bit k for the k-th CCKD device with such entries (devnums: webrt_set_devnum,     */
/* page: hw_cckd_devnum(k)); *hmask = devices with pending writes or written since their last harden (header,    */
/* L1, free space not yet rewritten: after a close without harden CCKD's check at open repairs that).            */
static int cckd_unsaved( uint32_t* mask, uint32_t* hmask )
{
    struct dirty_ctx c = { 0 };
    DEVBLK*   dev;
    CCKD_EXT* cckd;
    *mask = *hmask = 0;
    if (!cckdblk.dev1st) return 0;
    cckd_lock_devchain( 0 );
    for (dev = cckdblk.dev1st; dev; dev = cckd->devnext)
    {
        cckd = dev->cckd_ext;
        if (dev->cckd64) break;                 /* (not used: all web volumes are 32-bit CCKD) */
        if (c.ndev < DIRTY_MAXDEV) { webrt_set_devnum( c.ndev, dev->devnum ); c.devnum[ c.ndev ] = dev->devnum; }
        if ((cckd->needsdh || cckd->wrpending) && c.ndev < DIRTY_MAXDEV) c.hmask |= 1u << c.ndev;
        {   /* writes of this device (all its files), for the snapshot scheduler / stale protection */
            uint32_t w = 0; int k, skip = 0;
            for (k = 0; k <= cckd->sfn && k <= CCKD_MAX_SF; k++) w += (uint32_t) cckd->writes[k];
            for (k = 0; k < cckd_wasm_wrthru_nskip; k++) if (cckd_wasm_wrthru_skip[k] == dev->devnum) skip = 1;
            if (!skip) c.uwrites += w;
            if (c.ndev < DIRTY_MAXDEV)
            {
                if (w != dev_writes_prev[ c.ndev ]) { dev_writes_prev[ c.ndev ] = w; dev_written_at[ c.ndev ] = time( NULL ); }
                webrt_stat_set( WEBRT_ST_DEVWRITES0 + c.ndev, w );
            }
        }
        c.ndev++;
    }
    cckd_unlock_devchain();
    if (c.ndev > DIRTY_MAXDEV) c.ndev = DIRTY_MAXDEV;
    cache_lock( CACHE_DEVBUF );
    cache_scan( CACHE_DEVBUF, dirty_scan, &c );
    cache_unlock( CACHE_DEVBUF );
    *mask = c.mask; *hmask = c.hmask;
    {
        uint32_t wm = 0; int k; time_t now = time( NULL );
        for (k = 0; k < c.ndev; k++) if (dev_written_at[k] && now - dev_written_at[k] <= 10) wm |= 1u << k;
        webrt_stat_set( WEBRT_ST_USERWRITES, c.uwrites );
        webrt_stat_set( WEBRT_ST_WRITEMASK, wm );
    }
    return c.n;
}
static void* webdirty_thread( void* arg )
{
    UNREFERENCED( arg );
    while (!hercules_has_exited && !sysblk.shutdown)
    {
        if (webrt_flush_take())
        {
            obtain_lock( &cckdblk.dhlock );
            broadcast_condition( &cckdblk.dhcond );
            release_lock( &cckdblk.dhlock );
            webrt_stat_add( WEBRT_ST_FLUSHES, 1 );
        }
        {
            uint32_t mask, hmask, n = (uint32_t) cckd_unsaved( &mask, &hmask );
            webrt_stat_set( WEBRT_ST_DIRTYMASK, mask );
            webrt_stat_set( WEBRT_ST_HARDMASK, hmask );
            webrt_stat_set( WEBRT_ST_DIRTY, n );
        }
        /* activity counters for the page (checkpoint only when something changed,
           MVS idle = CP00 in a wait state; resume watchdog = CP00 started and its instruction count moves).
           Racy reads of single words, like the stock panel does. */
        webrt_stat_set( WEBRT_ST_CKDWRITES, (uint32_t) cckdblk.stats_writes );
        {
            REGS*    r = sysblk.regs[0];
            uint32_t f = 0x80000000u;
            if (r)
            {
                webrt_stat_set( WEBRT_ST_INSTCNT, (uint32_t) INSTCOUNT( r ) );
                if (r->cpustate == CPUSTATE_STARTED) f |= 1;
                if (WAITSTATE( &r->psw ))            f |= 2;
            }
            webrt_stat_set( WEBRT_ST_CPUSTATE, f );
        }
        webrt_flush_wait( 100 );
    }
    webrt_stat_set( WEBRT_ST_DIRTY, 0 );
    webrt_stat_set( WEBRT_ST_DIRTYMASK, 0 );
    webrt_stat_set( WEBRT_ST_HARDMASK, 0 );
    return NULL;
}
#endif

int main( int argc, char* argv[] )
{
    int    rc, i, n;
    char** av;
#ifdef HW_WEB
    const char* webcwd  = NULL;
    const char* webload = NULL;
    const char* webopfs = NULL;
    const char* outsink = NULL;
    double      outring = 64 * 1024;
    char        msg[ 4200 ];
#endif


    /* Remove our own options from argv */
    av = calloc( argc + 1, sizeof( char* ));
    for (i = 0, n = 0; i < argc; i++)
    {
        if (strncmp( argv[i], "--cmdfile=", 10 ) == 0)
            cmdfile = argv[i] + 10;
#ifdef HW_WEB
        else if (strncmp( argv[i], "--cwd=", 6 ) == 0)
            webcwd = argv[i] + 6;
        else if (strncmp( argv[i], "--webload=", 10 ) == 0)
            webload = argv[i] + 10;
        else if (strncmp( argv[i], "--opfs=", 7 ) == 0)
            webopfs = argv[i] + 7;
        else if (strncmp( argv[i], "--outsink=", 10 ) == 0)
            outsink = argv[i] + 10;     /* bounded output dirs (outsink.cpp) */
        else if (strncmp( argv[i], "--outsink-ring=", 15 ) == 0)
            outring = atof( argv[i] + 15 ) * 1024;
        else if (strcmp( argv[i], "--log-stdout" ) == 0)
            log_stdout = 1;
        else if (strcmp( argv[i], "--cckd-wrthru" ) == 0)
            cckd_wasm_wrthru = 1;       /* CCKD write-through (patch 0014) */
        else if (strncmp( argv[i], "--cckd-wrthru-skip=", 19 ) == 0)
        {                               /* devices without write-through, hex, comma separated */
            const char* q = argv[i] + 19;
            while (*q && cckd_wasm_wrthru_nskip < 8)
            {
                char* e;
                unsigned long d = strtoul( q, &e, 16 );
                if (e == q) break;
                cckd_wasm_wrthru_skip[ cckd_wasm_wrthru_nskip++ ] = (U16) d;
                q = (*e == ',') ? e + 1 : e;
            }
        }
#endif
        else if (strcmp( argv[i], "-d" ) == 0 || strcmp( argv[i], "-n" ) == 0)
            fprintf( stderr, "wasm_main: ignoring %s (NoUI mode is not supported)\n", argv[i] );
        else
            av[ n++ ] = argv[i];
    }
    av[ n ] = NULL;

#ifdef HW_WEB
    if (webcwd)
    {
        char p[ 1024 ];
        size_t k;
        snprintf( p, sizeof( p ), "%s", webcwd );
        for (k = 1; p[k]; k++)
            if (p[k] == '/') { p[k] = 0; mkdir( p, 0777 ); p[k] = '/'; }
        mkdir( p, 0777 );
        if (chdir( webcwd ) != 0)
        {
            snprintf( msg, sizeof( msg ), "wasm_main: chdir(%s) failed: %s\n", webcwd, strerror( errno ));
            webrt_log_str( msg );
            webrt_set_phase( WEBRT_PHASE_FAILED );
            return 1;
        }
    }
    if (webopfs)
    {
        rc = webrt_mount_opfs( webopfs, msg, sizeof( msg ) - 2 );
        strcat( msg, "\n" );
        webrt_log_str( msg );
        if (rc != 0)
        {
            webrt_set_phase( WEBRT_PHASE_FAILED );
            return 1;
        }
    }
    if (outsink)
    {
        /* the output devices' files keep only their last outring bytes in the heap. */
        /* Before the loader, which then finds the dirs already there (mkdir EEXIST is fine for it).       */
        char d[ 256 ];
        const char* q = outsink;
        while (*q)
        {
            size_t k = strcspn( q, "," );
            if (k > 0 && k < sizeof( d ))
            {
                memcpy( d, q, k ); d[ k ] = 0;
                rc = hw_outsink_mount( d, outring );
                snprintf( msg, sizeof( msg ), "wasm_main: outsink %s (keeps the last %.0f bytes of each file) rc=%d\n", d, outring, rc );
                webrt_log_str( msg );
                if (rc != 0)
                {
                    webrt_set_phase( WEBRT_PHASE_FAILED );
                    return 1;
                }
            }
            q += k; if (*q == ',') q++;
        }
    }
    if (webload)
    {
        rc = webrt_load( webload, msg, sizeof( msg ) - 2 );
        strcat( msg, "\n" );
        webrt_log_str( msg );
        if (rc != 0)
        {
            webrt_set_phase( WEBRT_PHASE_FAILED );
            return 1;
        }
    }
    webrt_set_phase( WEBRT_PHASE_STARTING );
#endif

    registerLogCallback( wasm_log_callback );

    if ((rc = impl( n, av )) != 0)
    {
        fprintf( stderr, "wasm_main: impl() rc=%d\n", rc );
#ifdef HW_WEB
        snprintf( msg, sizeof( msg ), "wasm_main: impl() rc=%d\n", rc );
        webrt_log_str( msg );
        webrt_set_phase( WEBRT_PHASE_FAILED );
#endif
        return rc;
    }

    /* Same as herclin.c: the rc thread waits for panel_init */
    sysblk.panel_init = 1;
    sysblk.herclin    = 1;

    process_command = getCommandHandler();

#ifdef HW_WEB
    webrt_set_phase( WEBRT_PHASE_RUNNING );
    {
        TID tid;
        if ((rc = create_thread( &tid, DETACHED, webcmd_thread, NULL, "wasm_webcmd" )))
            // "Error in function create_thread(): %s"
            WRMSG( HHC00102, "E", strerror( rc ));
        if ((rc = create_thread( &tid, DETACHED, webdirty_thread, NULL, "wasm_webdirty" )))
            // "Error in function create_thread(): %s"
            WRMSG( HHC00102, "E", strerror( rc ));
    }
#endif

    if (cmdfile)
    {
        TID tid;
        if ((rc = create_thread( &tid, DETACHED, cmdfile_thread, NULL, "wasm_cmdfile" )))
            // "Error in function create_thread(): %s"
            WRMSG( HHC00102, "E", strerror( rc ));
    }

    pthread_mutex_lock( &exit_lock );
    while (!hercules_has_exited)
        pthread_cond_wait( &exit_cond, &exit_lock );
    pthread_mutex_unlock( &exit_lock );

    sysblk.panel_init = 0;
    fflush( stdout );
    {
        static const char m[] = "wasm_main: Hercules has ended, exit(0)\n";
        (void) write( 2, m, sizeof( m ) - 1 );   /* (synchronous; stdio may be lost at exit) */
    }
    return 0;
}
