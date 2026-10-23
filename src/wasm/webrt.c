// SPDX-License-Identifier: Apache-2.0
/* WEBRT.C   Browser runtime support for the wasm32 Hercules (webmvs) */
/*                                                                   */
/*   Linked into Hercules (QPL 1.0); distributed as a separate file. */
/*   Only in the browser build (make -f src/wasm/Makefile.wasm web), */
/*   together with wasm_main.c compiled with -DHW_WEB and the JS      */
/*   library src/wasm/library_webload.js.                             */
/*                                                                   */
/*   1. Log ring: the Hercules log callback (a worker thread) puts    */
/*      the log text here; the page drains it on the main thread      */
/*      with hw_log_read() (lock-free, no malloc).                    */
/*   2. Command queue: hw_command() (main thread, lock-free) queues   */
/*      a Hercules panel command; a worker thread in wasm_main.c      */
/*      takes it with webrt_cmd_next() and runs it.                   */
/*   3. DASD/file loader: webrt_load() runs on the proxied main       */
/*      pthread before impl(). It starts a loader pthread that runs   */
/*      the async JS loader (fetch + sha256 inside that worker) and   */
/*      writes the files into WasmFS (memory backend) with the        */
/*      hw_fs_* helpers below. The browser main thread never copies   */
/*      DASD bytes. Progress is in atomics that the page reads.       */
/*   4. Stats: heap use / peak (mallinfo, sbrk) sampled by a worker   */
/*      thread, read by the page with hw_stat().                      */
/*                                                                   */
/*   Every function that the page calls on the browser main thread    */
/*   (hw_log_*, hw_command, hw_cmd_buf, hw_stat, hw_load_*, hw_phase) */
/*   only uses atomics and emscripten_futex_wake: with                */
/*   -sALLOW_BLOCKING_ON_MAIN_THREAD=0 a wait there would throw.      */

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <malloc.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sys/stat.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <emscripten/wasmfs.h>

#include "webrt.h"

#define KEEP EMSCRIPTEN_KEEPALIVE

/*-------------------------------------------------------------------*/
/* Phase (read by the page)                                          */
/*-------------------------------------------------------------------*/
static _Atomic int phase = WEBRT_PHASE_INIT;

void webrt_set_phase( int p ) { atomic_store( &phase, p ); }
KEEP int hw_phase( void )     { return atomic_load( &phase ); }

/*-------------------------------------------------------------------*/
/* 1. Log ring (multi-producer with a spin flag, single consumer =   */
/*    the page on the main thread)                                   */
/*-------------------------------------------------------------------*/
#define LOG_RING   (1u << 19)               /* 512 KB, power of 2    */
#define LOG_JSBUF  65536
static uint8_t          log_ring[ LOG_RING ];
static _Atomic uint32_t log_head;           /* written by producers  */
static _Atomic uint32_t log_tail;           /* written by consumer   */
static _Atomic uint32_t log_dropped;
static atomic_flag      log_spin = ATOMIC_FLAG_INIT;
static uint8_t          log_jsbuf[ LOG_JSBUF ];

void webrt_log_put( const char* msg, size_t len )
{
    uint32_t h, t, i;
    while (atomic_flag_test_and_set_explicit( &log_spin, memory_order_acquire ))
        ;                                    /* producers are workers */
    h = atomic_load_explicit( &log_head, memory_order_relaxed );
    t = atomic_load_explicit( &log_tail, memory_order_acquire );
    if (len > LOG_RING - (h - t))
        atomic_fetch_add( &log_dropped, (uint32_t) len );   /* page too slow */
    else
    {
        for (i = 0; i < len; i++)
            log_ring[ (h + i) & (LOG_RING - 1) ] = (uint8_t) msg[i];
        atomic_store_explicit( &log_head, h + (uint32_t) len, memory_order_release );
    }
    atomic_flag_clear_explicit( &log_spin, memory_order_release );
}

void webrt_log_str( const char* s ) { webrt_log_put( s, strlen( s )); }

/* A note line from JS in a worker (e.g. the DASD I/O worker) into the log ring. */
KEEP void hw_log_note( const char* s ) { webrt_log_str( s ); }

KEEP uint8_t* hw_log_buf( void )      { return log_jsbuf; }
KEEP int      hw_log_buf_size( void ) { return LOG_JSBUF; }
KEEP uint32_t hw_log_dropped( void )  { return atomic_load( &log_dropped ); }

/* Copy up to cap queued log bytes to buf. Returns the byte count.   */
KEEP int hw_log_read( uint8_t* buf, int cap )
{
    uint32_t t = atomic_load_explicit( &log_tail, memory_order_relaxed );
    uint32_t h = atomic_load_explicit( &log_head, memory_order_acquire );
    uint32_t n = h - t, i;
    if (cap <= 0) return 0;
    if (n > (uint32_t) cap) n = (uint32_t) cap;
    for (i = 0; i < n; i++)
        buf[i] = log_ring[ (t + i) & (LOG_RING - 1) ];
    atomic_store_explicit( &log_tail, t + n, memory_order_release );
    return (int) n;
}

/*-------------------------------------------------------------------*/
/* 2. Command queue (single producer = page, single consumer)        */
/*-------------------------------------------------------------------*/
#define CMD_SLOTS  64
static char             cmd_q[ CMD_SLOTS ][ WEBRT_CMD_LEN ];
static _Atomic uint32_t cmd_head;           /* futex word too        */
static _Atomic uint32_t cmd_tail;
static char             cmd_jsbuf[ WEBRT_CMD_LEN ];

KEEP char* hw_cmd_buf( void )      { return cmd_jsbuf; }
KEEP int   hw_cmd_buf_size( void ) { return WEBRT_CMD_LEN; }

/* Queue one Hercules command line (copied). 0 = queued, -1 = full,  */
/* -2 = too long, -3 = Hercules not running.                         */
KEEP int hw_command( const char* cmd )
{
    uint32_t h = atomic_load_explicit( &cmd_head, memory_order_relaxed );
    uint32_t t = atomic_load_explicit( &cmd_tail, memory_order_acquire );
    size_t   n = strnlen( cmd, WEBRT_CMD_LEN );
    if (n >= WEBRT_CMD_LEN)     return -2;
    if (h - t >= CMD_SLOTS)     return -1;
    if (atomic_load( &phase ) >= WEBRT_PHASE_ENDED) return -3;
    memcpy( cmd_q[ h % CMD_SLOTS ], cmd, n + 1 );
    atomic_store_explicit( &cmd_head, h + 1, memory_order_release );
    emscripten_futex_wake( (void*) &cmd_head, 1 );
    return 0;
}

/* Worker side: wait up to timeout_ms for a command. 1 = got one.     */
int webrt_cmd_next( char* out, int timeout_ms )
{
    uint32_t t = atomic_load_explicit( &cmd_tail, memory_order_relaxed );
    uint32_t h = atomic_load_explicit( &cmd_head, memory_order_acquire );
    if (h == t)
    {
        emscripten_futex_wait( (void*) &cmd_head, h, (double) timeout_ms );
        h = atomic_load_explicit( &cmd_head, memory_order_acquire );
        if (h == t) return 0;
    }
    memcpy( out, cmd_q[ t % CMD_SLOTS ], WEBRT_CMD_LEN );
    out[ WEBRT_CMD_LEN - 1 ] = 0;
    atomic_store_explicit( &cmd_tail, t + 1, memory_order_release );
    return 1;
}

void webrt_cmd_wake( void ) { emscripten_futex_wake( (void*) &cmd_head, 1 ); }

/*-------------------------------------------------------------------*/
/* 4. Stats                                                          */
/*-------------------------------------------------------------------*/
static _Atomic uint32_t st[ WEBRT_ST_COUNT ];

void webrt_stats_sample( void )
{
    struct mallinfo mi = mallinfo();
    uint32_t used = (uint32_t) mi.uordblks;
    uint32_t top  = (uint32_t) (uintptr_t) sbrk( 0 );
    atomic_store( &st[ WEBRT_ST_HEAP_USED ], used );
    if (used > atomic_load( &st[ WEBRT_ST_HEAP_PEAK ] )) atomic_store( &st[ WEBRT_ST_HEAP_PEAK ], used );
    atomic_store( &st[ WEBRT_ST_ARENA ], (uint32_t) mi.arena );
    atomic_store( &st[ WEBRT_ST_SBRK ], top );
    if (top > atomic_load( &st[ WEBRT_ST_SBRK_PEAK ] )) atomic_store( &st[ WEBRT_ST_SBRK_PEAK ], top );
    atomic_store( &st[ WEBRT_ST_MEM ], (uint32_t)( __builtin_wasm_memory_size( 0 ) * 65536u ));
    atomic_fetch_add( &st[ WEBRT_ST_SAMPLES ], 1 );
}
void webrt_stat_set( int i, uint32_t v ) { if (i >= 0 && i < WEBRT_ST_COUNT) atomic_store( &st[i], v ); }
void webrt_stat_add( int i, int32_t v )  { if (i >= 0 && i < WEBRT_ST_COUNT) atomic_fetch_add( &st[i], (uint32_t) v ); }
/* sr.c (patch 0018) counts its checkpoints for the page's pagehide wait */
extern volatile uint32_t sr_ckpt_progress __attribute__(( weak ));   /* (absent without 0018: 0) */
KEEP uint32_t hw_stat( int i )
{
    if (i == WEBRT_ST_CKPT) return &sr_ckpt_progress ? __atomic_load_n( &sr_ckpt_progress, __ATOMIC_SEQ_CST ) : 0;
    return (i >= 0 && i < WEBRT_ST_COUNT) ? atomic_load( &st[i] ) : 0;
}

/* flush request from the page (visibilitychange / */
/* pagehide / beforeunload, main thread: lock-free). The wasm_webdirty */
/* thread (wasm_main.c) takes it and wakes the CCKD Dasd Hardener.     */
static _Atomic uint32_t flush_req;           /* futex word too       */
static uint32_t         flush_seen;          /* dirty thread only    */
KEEP int hw_cckd_flush( void )
{
    atomic_fetch_add( &flush_req, 1 );
    emscripten_futex_wake( (void*) &flush_req, 1 );
    return 0;
}
/* turn the CCKD write-through of patch 0014 on/off (cckddasd.c   */
/* cckd_wasm_wrthru; a plain int read by the device threads at the end */
/* of each channel program). The page turns it on at TSO ready.        */
extern int cckd_wasm_wrthru;
KEEP int hw_cckd_wrthru( int on ) { __atomic_store_n( &cckd_wasm_wrthru, on ? 1 : 0, __ATOMIC_SEQ_CST ); return 0; }

static _Atomic uint32_t cckd_devnum[ 16 ];
void webrt_set_devnum( int k, uint32_t devnum ) { if (k >= 0 && k < 16) atomic_store( &cckd_devnum[k], devnum ); }
KEEP uint32_t hw_cckd_devnum( int k ) { return (k >= 0 && k < 16) ? atomic_load( &cckd_devnum[k] ) : 0; }
int webrt_flush_take( void )
{
    uint32_t r = atomic_load( &flush_req );
    if (r == flush_seen) return 0;
    flush_seen = r;
    return 1;
}
void webrt_flush_wait( int timeout_ms )
{
    uint32_t r = atomic_load( &flush_req );
    if (r != flush_seen) return;
    emscripten_futex_wait( (void*) &flush_req, r, (double) timeout_ms );
}

/*-------------------------------------------------------------------*/
/* 5. Persistent storage: mount the WasmFS OPFS    */
/*    backend at `path` (e.g. /opfs). The CCKD shadow files live in   */
/*    <path>/shadow (sf=/opfs/shadow/<vol>_*.cckd), so the visitor's  */
/*    writes stay after a reload. Must run on a worker (the proxied   */
/*    main pthread): the backend starts its own OPFS proxy pthread,   */
/*    and every OPFS call from a Hercules thread blocks only that     */
/*    thread until the proxy has done the async OPFS operation.       */
/*    The OPFS directory is prepared (reset / busy-handle probe /     */
/*    seed files) by the JS loader before impl() opens any file.      */
/*-------------------------------------------------------------------*/
int webrt_mount_opfs( const char* path, char* msg, size_t msgsize )
{
    backend_t b;
    int       rc;
    struct stat st;

    if (stat( path, &st ) == 0)
    {
        snprintf( msg, msgsize, "opfs: %s already exists", path );
        return -1;
    }
    b = wasmfs_create_opfs_backend();
    if (!b)
    {
        snprintf( msg, msgsize, "opfs: wasmfs_create_opfs_backend() failed" );
        return -1;
    }
    rc = wasmfs_create_directory( path, 0777, b );
    if (rc != 0)
    {
        snprintf( msg, msgsize, "opfs: wasmfs_create_directory(%s) rc=%d", path, rc );
        return -1;
    }
    snprintf( msg, msgsize, "opfs: OPFS backend mounted at %s", path );
    return 0;
}

/*-------------------------------------------------------------------*/
/* 3. Loader                                                         */
/*-------------------------------------------------------------------*/
static _Atomic uint32_t load_bytes, load_total, load_files;
static int              load_rc = 1;        /* 1 = still running     */
static char             load_msg[ 4096 ];   /* (+ webload-opfs JSON) */
static pthread_mutex_t  load_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t   load_cond = PTHREAD_COND_INITIALIZER;

KEEP uint32_t hw_load_bytes( void ) { return atomic_load( &load_bytes ); }
KEEP uint32_t hw_load_total( void ) { return atomic_load( &load_total ); }
KEEP uint32_t hw_load_files( void ) { return atomic_load( &load_files ); }

/* Called by the JS loader (loader worker) */
KEEP void hw_load_progress( double bytes, double total, int files )
{
    atomic_store( &load_bytes, (uint32_t) bytes );
    atomic_store( &load_total, (uint32_t) total );
    atomic_store( &load_files, (uint32_t) files );
}

KEEP void hw_load_finish( int rc, const char* msg )
{
    pthread_mutex_lock( &load_lock );
    load_rc = rc;
    snprintf( load_msg, sizeof( load_msg ), "%s", msg ? msg : "" );
    pthread_cond_broadcast( &load_cond );
    pthread_mutex_unlock( &load_lock );
}

static int mkdirs( const char* path )        /* mkdir -p of the parent dirs + path */
{
    char   tmp[ 1024 ];
    size_t i, n = strlen( path );
    if (n >= sizeof( tmp )) return -1;
    memcpy( tmp, path, n + 1 );
    for (i = 1; i <= n; i++)
        if (tmp[i] == '/' || tmp[i] == 0)
        {
            char c = tmp[i];
            tmp[i] = 0;
            if (mkdir( tmp, 0777 ) != 0 && errno != EEXIST) return -1;
            tmp[i] = c;
        }
    return 0;
}

KEEP int hw_fs_mkdirs( const char* path ) { return mkdirs( path ); }

/* Create (truncate) a file of the final size. Sizing it first means   */
/* the memory backend allocates once; the chunks are then pwrite()n.   */
KEEP int hw_fs_create( const char* path, double size )
{
    int  fd;
    char dir[ 1024 ];
    const char* s = strrchr( path, '/' );
    if (s && s != path && (size_t)(s - path) < sizeof( dir ))
    {
        memcpy( dir, path, s - path ); dir[ s - path ] = 0;
        if (mkdirs( dir ) != 0) return -errno;
    }
    if ((fd = open( path, O_CREAT | O_TRUNC | O_RDWR, 0666 )) < 0) return -errno;
    if (size > 0 && ftruncate( fd, (off_t) size ) != 0) { int e = errno; close( fd ); return -e; }
    return fd;
}

KEEP int hw_fs_pwrite( int fd, const uint8_t* p, int n, double off )
{
    int done = 0;
    while (done < n)
    {
        ssize_t k = pwrite( fd, p + done, n - done, (off_t) off + done );
        if (k <= 0) return k < 0 ? -errno : -EIO;
        done += (int) k;
    }
    return done;
}

KEEP int hw_fs_close( int fd ) { return close( fd ) == 0 ? 0 : -errno; }

/* Persistence: make a loaded base volume read-only (0444). CCKD then opens */
/* it O_RDONLY (the R/W open fails with EACCES) and creates the sf= shadow */
/* file for the writes; with a writable base it opens the base R/W and    */
/* never uses a shadow (then "devlist" shows "[0 sfs]").                */
KEEP int hw_fs_chmod( const char* path, int mode ) { return chmod( path, (mode_t) mode ) == 0 ? 0 : -errno; }

/* Defined in library_webload.js; runs in the loader worker. */
extern void hw_js_webload( const char* spec_json );

static void* loader_thread( void* arg )
{
    hw_js_webload( (const char*) arg );     /* starts the async loader */
    emscripten_exit_with_live_runtime();    /* back to this worker's event loop */
    return NULL;
}

int webrt_load( const char* spec_json, char* msg, size_t msgsize )
{
    pthread_t      tid;
    pthread_attr_t a;
    int            rc;

    webrt_set_phase( WEBRT_PHASE_LOADING );
    pthread_attr_init( &a );
    pthread_attr_setdetachstate( &a, PTHREAD_CREATE_DETACHED );
    if ((rc = pthread_create( &tid, &a, loader_thread, (void*) spec_json )) != 0)
    {
        snprintf( msg, msgsize, "pthread_create(loader) failed: %s", strerror( rc ));
        return -1;
    }
    pthread_attr_destroy( &a );

    pthread_mutex_lock( &load_lock );
    while (load_rc == 1)
        pthread_cond_wait( &load_cond, &load_lock );
    rc = load_rc;
    snprintf( msg, msgsize, "%s", load_msg );
    pthread_mutex_unlock( &load_lock );
    return rc;
}
