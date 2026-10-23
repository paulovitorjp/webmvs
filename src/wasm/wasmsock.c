// SPDX-License-Identifier: Apache-2.0
/* wasmsock.c  In-process TN3270 loopback ("vsock") for Hercules        */
/*                                                                     */
/* Part of webmvs. In-process 3270 bridge. API: wasmsock.h.        */
/*                                                                     */
/* - A static table of VSOCK_MAX slots. A slot is a listening socket   */
/*   or one connection. Hercules sees pseudo-fds VSOCK_FD_BASE + slot. */
/* - Each connection has two SPSC byte rings (in: client -> Hercules,  */
/*   out: Hercules -> client) with free-running atomic indices.        */
/* - One doorbell (a 32-bit futex word). Every state change (input,    */
/*   output drained, open, close, console signal) increments it and    */
/*   wakes all waiters. Waiters read the doorbell, check their         */
/*   condition, then futex-wait on the value they read, so a wake-up   */
/*   can not be lost.                                                  */
/* - The terminal side (hw_term_*) uses only atomics, memcpy and       */
/*   futex wake: no lock, no malloc, no wait. Safe on the browser main */
/*   thread.                                                           */
/* - The Hercules side may block (futex wait), so it must never run on */
/*   the browser main thread (PROXY_TO_PTHREAD keeps Hercules off it). */
/*                                                                     */
/* Build: emcc -pthread ...  or  cc -pthread -DWASMSOCK_NATIVE ...     */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "wasmsock.h"

#include <stdatomic.h>
#include <errno.h>
#include <string.h>
#include <limits.h>
#include <poll.h>
#include <unistd.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#if defined(__EMSCRIPTEN__)
  #include <emscripten.h>
  #include <emscripten/threading.h>
  #define VS_EXPORT EMSCRIPTEN_KEEPALIVE
#elif defined(WASMSOCK_NATIVE)
  #include <linux/futex.h>
  #include <sys/syscall.h>
  #define VS_EXPORT __attribute__((used, visibility("default")))
#else
  #error "wasmsock.c: build with Emscripten, or define WASMSOCK_NATIVE (Linux)"
#endif

#if (VSOCK_RING & (VSOCK_RING - 1)) != 0
  #error "VSOCK_RING must be a power of 2"
#endif
#if VSOCK_FD_BASE + VSOCK_MAX > FD_SETSIZE
  #error "pseudo-fds must fit in an fd_set"
#endif

/*-------------------------------------------------------------------*/
/* Data                                                               */
/*-------------------------------------------------------------------*/
typedef struct {
    _Atomic uint32_t head;              /* producer index (free-running) */
    _Atomic uint32_t tail;              /* consumer index (free-running) */
    uint8_t          data[ VSOCK_RING ];
} vring;

enum { ST_FREE = 0, ST_INIT, ST_SOCK, ST_LISTEN, ST_PENDING, ST_OPEN };

#define FL_CCLOSED  1u                  /* client (terminal side) closed */
#define FL_HCLOSED  2u                  /* Hercules closed               */

#define ID_SHIFT    5                   /* id = gen << 5 | slot          */
#define ID_MASK     ((1u << ID_SHIFT) - 1)
#define GEN_MASK    0x03FFFFFFu         /* keeps id a positive int       */

typedef struct {
    _Atomic uint32_t state;
    _Atomic uint32_t flags;
    _Atomic uint32_t gen;
    _Atomic uint32_t ticket;            /* accept order (FIFO)           */
    _Atomic int      nonblock;
    _Atomic int      port;              /* listener: bound port          */
    _Atomic int      want_port;         /* pending: 0 = primary listener */
    atomic_flag      send_lock;         /* Hercules-side senders         */
    char             ttype[ 48 ];
    vring            in;                /* client -> Hercules            */
    vring            out;               /* Hercules -> client            */
} vslot;

_Static_assert( VSOCK_MAX <= (int) ID_MASK + 1, "VSOCK_MAX too large for id encoding" );

static vslot            S[ VSOCK_MAX ];
static _Atomic uint32_t bell;           /* the doorbell (futex word)     */
static _Atomic uint32_t ticket_ctr;
static _Atomic uint32_t out_seq;
static _Atomic int      primary = -1;   /* slot of the CNSLPORT listener */
static _Thread_local volatile int* watch_flag;
static uint8_t          jsbuf[ 65536 ];
static int              vdebug = -1;

#define VDBG( ... )  do { if (vdebug < 0) vdebug = getenv( "WASMSOCK_DEBUG" ) != NULL; \
                          if (vdebug) { fprintf( stderr, "wasmsock: " __VA_ARGS__ ); } } while (0)

/*-------------------------------------------------------------------*/
/* Doorbell                                                           */
/*-------------------------------------------------------------------*/
static void futex_wake_all( _Atomic uint32_t* addr )
{
#if defined(__EMSCRIPTEN__)
    emscripten_futex_wake( (volatile void*) addr, INT_MAX );
#else
    syscall( SYS_futex, (uint32_t*) addr, FUTEX_WAKE_PRIVATE, INT_MAX, NULL, NULL, 0 );
#endif
}

/* Wait until *addr != val, a wake, or ms elapsed (ms < 0: no limit). */
static void futex_wait_ms( _Atomic uint32_t* addr, uint32_t val, double ms )
{
#if defined(__EMSCRIPTEN__)
    emscripten_futex_wait( (volatile void*) addr, val, ms < 0 ? INFINITY : ms );
#else
    struct timespec ts, *tp = NULL;
    if (ms >= 0)
    {
        ts.tv_sec  = (time_t)( ms / 1000 );
        ts.tv_nsec = (long)( ( ms - (double) ts.tv_sec * 1000 ) * 1e6 );
        tp = &ts;
    }
    syscall( SYS_futex, (uint32_t*) addr, FUTEX_WAIT_PRIVATE, val, tp, NULL, 0 );
#endif
}

VS_EXPORT void vsock_doorbell_ring( void )
{
    atomic_fetch_add( &bell, 1 );
    futex_wake_all( &bell );
}

static uint32_t bell_seen( void ) { return atomic_load( &bell ); }

static double now_ms( void )
{
    struct timespec ts;
    clock_gettime( CLOCK_MONOTONIC, &ts );
    return (double) ts.tv_sec * 1000.0 + (double) ts.tv_nsec / 1e6;
}

/* Wait for the doorbell to move on from 'seen'. Each wait is capped at
   1 s as a safety net; callers always re-check their condition.     */
static void bell_wait( uint32_t seen, double ms )
{
    if (ms < 0 || ms > 1000) ms = 1000;
    futex_wait_ms( &bell, seen, ms );
}

VS_EXPORT void vsock_select_watch_flag( volatile int* flag )
{
    watch_flag = flag;
}

/*-------------------------------------------------------------------*/
/* Rings (single producer, single consumer)                           */
/*-------------------------------------------------------------------*/
static uint32_t ring_used( vring* r )
{
    return atomic_load_explicit( &r->head, memory_order_acquire )
         - atomic_load_explicit( &r->tail, memory_order_acquire );
}

static size_t ring_put( vring* r, const uint8_t* p, size_t n )
{
    uint32_t h = atomic_load_explicit( &r->head, memory_order_relaxed );
    uint32_t t = atomic_load_explicit( &r->tail, memory_order_acquire );
    size_t space = VSOCK_RING - (size_t)( h - t ), off, a;
    if (n > space) n = space;
    if (!n) return 0;
    off = h & (VSOCK_RING - 1);
    a = VSOCK_RING - off; if (a > n) a = n;
    memcpy( r->data + off, p, a );
    memcpy( r->data, p + a, n - a );
    atomic_store_explicit( &r->head, h + (uint32_t) n, memory_order_release );
    return n;
}

static size_t ring_get( vring* r, uint8_t* p, size_t n )
{
    uint32_t t = atomic_load_explicit( &r->tail, memory_order_relaxed );
    uint32_t h = atomic_load_explicit( &r->head, memory_order_acquire );
    size_t used = (size_t)( h - t ), off, a;
    if (n > used) n = used;
    if (!n) return 0;
    off = t & (VSOCK_RING - 1);
    a = VSOCK_RING - off; if (a > n) a = n;
    memcpy( p, r->data + off, a );
    memcpy( p + a, r->data, n - a );
    atomic_store_explicit( &r->tail, t + (uint32_t) n, memory_order_release );
    return n;
}

/*-------------------------------------------------------------------*/
/* Slots                                                              */
/*-------------------------------------------------------------------*/
/* Claim a free slot (lock-free). It is left in ST_INIT; the caller
   fills it and then publishes the final state.                      */
static int slot_alloc( void )
{
    int i;
    for (i = 0; i < VSOCK_MAX; i++)
    {
        uint32_t expect = ST_FREE;
        if (atomic_compare_exchange_strong( &S[i].state, &expect, ST_INIT ))
        {
            vslot* s = &S[i];
            uint32_t g = ( atomic_load( &s->gen ) + 1 ) & GEN_MASK;
            if (!g) g = 1;
            atomic_store( &s->gen, g );
            atomic_store( &s->flags, 0 );
            atomic_store( &s->nonblock, 0 );
            atomic_store( &s->port, 0 );
            atomic_store( &s->want_port, 0 );
            atomic_store( &s->in.head, 0 );  atomic_store( &s->in.tail, 0 );
            atomic_store( &s->out.head, 0 ); atomic_store( &s->out.tail, 0 );
            atomic_flag_clear( &s->send_lock );
            s->ttype[0] = 0;
            return i;
        }
    }
    return -1;
}

static void slot_free( int i )
{
    int p = i;
    atomic_compare_exchange_strong( &primary, &p, -1 );
    atomic_store( &S[i].state, ST_FREE );
}

static int fd_index( int fd )
{
    return (fd >= VSOCK_FD_BASE && fd < VSOCK_FD_BASE + VSOCK_MAX) ? fd - VSOCK_FD_BASE : -1;
}

VS_EXPORT int vsock_is_vsock( int fd )
{
    int i = fd_index( fd );
    return i >= 0 && atomic_load( &S[i].state ) != ST_FREE;
}

/* Hercules-side lookup: a socket, a listener, or an open connection
   that Hercules has not closed yet.                                 */
static vslot* herc_slot( int fd, int* idx )
{
    int i = fd_index( fd );
    uint32_t st;
    if (i < 0) return NULL;
    st = atomic_load( &S[i].state );
    if (st == ST_SOCK || st == ST_LISTEN
        || (st == ST_OPEN && !(atomic_load( &S[i].flags ) & FL_HCLOSED)))
    {
        if (idx) *idx = i;
        return &S[i];
    }
    return NULL;
}

static vslot* herc_conn( int fd )
{
    int i;
    vslot* s = herc_slot( fd, &i );
    return (s && atomic_load( &s->state ) == ST_OPEN) ? s : NULL;
}

/* Terminal-side lookup by id. */
static vslot* js_slot( int id )
{
    uint32_t i, st;
    if (id <= 0) return NULL;
    i = (uint32_t) id & ID_MASK;
    if (i >= VSOCK_MAX) return NULL;
    if (atomic_load( &S[i].gen ) != ((uint32_t) id >> ID_SHIFT)) return NULL;
    st = atomic_load( &S[i].state );
    return (st == ST_PENDING || st == ST_OPEN) ? &S[i] : NULL;
}

/* Oldest pending connection for listener li, or -1. */
static int find_pending( int li )
{
    int i, best = -1, lport = atomic_load( &S[li].port ), prim = atomic_load( &primary );
    uint32_t bt = 0;
    for (i = 0; i < VSOCK_MAX; i++)
    {
        int wp;
        if (atomic_load( &S[i].state ) != ST_PENDING) continue;
        wp = atomic_load( &S[i].want_port );
        if (wp ? wp != lport : li != prim) continue;
        if (best < 0 || (int32_t)( atomic_load( &S[i].ticket ) - bt ) < 0)
        {
            best = i;
            bt = atomic_load( &S[i].ticket );
        }
    }
    return best;
}

static void fill_addr( struct sockaddr* addr, socklen_t* len, int port )
{
    struct sockaddr_in sin;
    if (!addr || !len) return;
    memset( &sin, 0, sizeof( sin ));
    sin.sin_family      = AF_INET;
    sin.sin_port        = htons( (uint16_t) port );
    sin.sin_addr.s_addr = htonl( INADDR_LOOPBACK );
    memcpy( addr, &sin, *len < sizeof( sin ) ? *len : sizeof( sin ));
    *len = sizeof( sin );
}

/*-------------------------------------------------------------------*/
/* Hercules side                                                      */
/*-------------------------------------------------------------------*/
VS_EXPORT int vsock_socket( int domain, int type, int protocol )
{
    int i;
    if (domain != AF_INET || (type & 0xF) != SOCK_STREAM)
        return socket( domain, type, protocol );
    if ((i = slot_alloc()) < 0) { errno = EMFILE; return -1; }
    atomic_store( &S[i].state, ST_SOCK );
    return VSOCK_FD_BASE + i;
}

VS_EXPORT int vsock_setsockopt( int fd, int level, int name, const void* val, socklen_t len )
{
    if (fd_index( fd ) < 0) return setsockopt( fd, level, name, val, len );
    if (!herc_slot( fd, NULL )) { errno = EBADF; return -1; }
    return 0;
}

VS_EXPORT int vsock_bind( int fd, const struct sockaddr* addr, socklen_t len )
{
    int i, j, port;
    vslot* s;
    if (fd_index( fd ) < 0) return bind( fd, addr, len );
    if (!(s = herc_slot( fd, &i )) || atomic_load( &s->state ) != ST_SOCK) { errno = EBADF; return -1; }
    if (!addr || len < (socklen_t) sizeof( struct sockaddr_in ) || addr->sa_family != AF_INET)
    { errno = EINVAL; return -1; }
    port = ntohs( ((const struct sockaddr_in*) addr)->sin_port );
    for (j = 0; j < VSOCK_MAX; j++)
    {
        uint32_t st = atomic_load( &S[j].state );
        if (j != i && port && (st == ST_SOCK || st == ST_LISTEN) && atomic_load( &S[j].port ) == port)
        { errno = EADDRINUSE; return -1; }
    }
    atomic_store( &s->port, port );
    return 0;
}

#if defined(WASMSOCK_NATIVE)
extern void vsock_native_bridge_start( void ) __attribute__((weak));
#endif

VS_EXPORT int vsock_listen( int fd, int backlog )
{
    int i, none = -1;
    vslot* s;
    (void) backlog;
    if (fd_index( fd ) < 0) return listen( fd, backlog );
    if (!(s = herc_slot( fd, &i )) || atomic_load( &s->state ) != ST_SOCK) { errno = EBADF; return -1; }
    atomic_store( &s->state, ST_LISTEN );
    atomic_compare_exchange_strong( &primary, &none, i );
    VDBG( "listen fd %d port %d%s\n", fd, atomic_load( &s->port ), atomic_load( &primary ) == i ? " (primary)" : "" );
    vsock_doorbell_ring();
#if defined(WASMSOCK_NATIVE)
    if (vsock_native_bridge_start) vsock_native_bridge_start();
#endif
    return 0;
}

VS_EXPORT int vsock_accept( int fd, struct sockaddr* addr, socklen_t* len )
{
    int li;
    vslot* s;
    if (fd_index( fd ) < 0) return accept( fd, addr, len );
    for (;;)
    {
        uint32_t seen = bell_seen();
        int pi;
        if (!(s = herc_slot( fd, &li )) || atomic_load( &s->state ) != ST_LISTEN) { errno = EBADF; return -1; }
        if ((pi = find_pending( li )) >= 0)
        {
            uint32_t expect = ST_PENDING;
            if (atomic_compare_exchange_strong( &S[pi].state, &expect, ST_OPEN ))
            {
                VDBG( "accept fd %d -> fd %d (ttype '%s')\n", fd, VSOCK_FD_BASE + pi, S[pi].ttype );
                fill_addr( addr, len, 49152 + pi );
                vsock_doorbell_ring();
                return VSOCK_FD_BASE + pi;
            }
            continue;
        }
        if (atomic_load( &s->nonblock )) { errno = EAGAIN; return -1; }
        bell_wait( seen, -1 );
    }
}

VS_EXPORT ssize_t vsock_recv( int fd, void* buf, size_t len, int flags )
{
    vslot* s;
    if (fd_index( fd ) < 0) return recv( fd, buf, len, flags );
    if (!(s = herc_conn( fd ))) { errno = EBADF; return -1; }
    if (!len) return 0;
    for (;;)
    {
        uint32_t seen = bell_seen();
        uint32_t f = atomic_load( &s->flags );  /* before the ring read: see below */
        size_t n = ring_get( &s->in, (uint8_t*) buf, len );
        if (n) return (ssize_t) n;
        /* The client queues its last bytes before it sets FL_CCLOSED, so
           with FL_CCLOSED seen first, the ring read above saw them.    */
        if (f & FL_CCLOSED) return 0;
        if (f & FL_HCLOSED) { errno = EBADF; return -1; }
        if (atomic_load( &s->nonblock ) || (flags & MSG_DONTWAIT)) { errno = EAGAIN; return -1; }
        bell_wait( seen, -1 );
    }
}

/* Queue bytes for the client. all != 0: block until everything is queued
   even in non-blocking mode (write_socket semantics).               */
static ssize_t do_send( vslot* s, const uint8_t* p, size_t len, int all, int dontwait )
{
    size_t total = 0;
    ssize_t rc;
    while (atomic_flag_test_and_set_explicit( &s->send_lock, memory_order_acquire ))
        sched_yield();
    for (;;)
    {
        uint32_t seen = bell_seen();
        size_t n;
        if (atomic_load( &s->flags ) & FL_CCLOSED)
        {
            if (!total) { errno = EPIPE; rc = -1; goto done; }
            break;
        }
        n = ring_put( &s->out, p + total, len - total );
        if (n)
        {
            total += n;
            atomic_fetch_add( &out_seq, 1 );
        }
        if (total == len) break;
        if (n) continue;
        if (!all && (dontwait || atomic_load( &s->nonblock )))
        {
            if (!total) { errno = EAGAIN; rc = -1; goto done; }
            break;
        }
        bell_wait( seen, -1 );      /* hw_term_read rings when it frees space */
    }
    rc = (ssize_t) total;
done:
    atomic_flag_clear_explicit( &s->send_lock, memory_order_release );
    return rc;
}

VS_EXPORT ssize_t vsock_send( int fd, const void* buf, size_t len, int flags )
{
    vslot* s;
    if (fd_index( fd ) < 0) return send( fd, buf, len, flags );
    if (!(s = herc_conn( fd ))) { errno = EBADF; return -1; }
    if (!len) return 0;
    return do_send( s, (const uint8_t*) buf, len, 0, (flags & MSG_DONTWAIT) != 0 );
}

VS_EXPORT int vsock_write_socket( int fd, const void* buf, int n )
{
    vslot* s;
    if (fd_index( fd ) < 0)
    {
        const char* p = (const char*) buf;
        int left = n;
        while (left > 0)
        {
            ssize_t w = write( fd, p, (size_t) left );
            if (w <= 0) return (int) w;
            p += w; left -= (int) w;
        }
        return n;
    }
    if (!(s = herc_conn( fd ))) { errno = EBADF; return -1; }
    if (n <= 0) return 0;
    return (int) do_send( s, (const uint8_t*) buf, (size_t) n, 1, 0 );
}

VS_EXPORT int vsock_read_socket( int fd, void* buf, int n )
{
    int got = 0;
    while (got < n)
    {
        ssize_t r = fd_index( fd ) < 0 ? read( fd, (char*) buf + got, (size_t)( n - got ))
                                       : vsock_recv( fd, (char*) buf + got, (size_t)( n - got ), 0 );
        if (r < 0) return (int) r;
        if (r == 0) break;
        got += (int) r;
    }
    return got;
}

VS_EXPORT int vsock_getpeername( int fd, struct sockaddr* addr, socklen_t* len )
{
    int i;
    if (fd_index( fd ) < 0) return getpeername( fd, addr, len );
    if (!herc_conn( fd )) { errno = ENOTCONN; return -1; }
    i = fd_index( fd );
    fill_addr( addr, len, 49152 + i );
    return 0;
}

VS_EXPORT int vsock_getsockname( int fd, struct sockaddr* addr, socklen_t* len )
{
    int i;
    vslot* s;
    if (fd_index( fd ) < 0) return getsockname( fd, addr, len );
    if (!(s = herc_slot( fd, &i ))) { errno = EBADF; return -1; }
    fill_addr( addr, len, atomic_load( &s->state ) == ST_OPEN ? 0 : atomic_load( &s->port ));
    return 0;
}

VS_EXPORT int vsock_set_blocking_mode( int fd, int blocking )
{
    vslot* s;
    if (fd_index( fd ) < 0)
    {
        extern int socket_set_blocking_mode( int, int ) __attribute__((weak));
        if (socket_set_blocking_mode) return socket_set_blocking_mode( fd, blocking );
        errno = ENOTSOCK; return -1;
    }
    if (!(s = herc_slot( fd, NULL ))) { errno = EBADF; return -1; }
    atomic_store( &s->nonblock, blocking ? 0 : 1 );
    return 0;
}

VS_EXPORT int vsock_set_keepalive( int fd, int idle, int intv, int cnt )
{
    if (fd_index( fd ) < 0)
    {
        extern int set_socket_keepalive( int, int, int, int ) __attribute__((weak));
        if (set_socket_keepalive) return set_socket_keepalive( fd, idle, intv, cnt );
        errno = ENOTSOCK; return -1;
    }
    if (!herc_slot( fd, NULL )) { errno = EBADF; return -1; }
    return 0;   /* 0 = keepalive "fully supported": the peer is in-process */
}

VS_EXPORT int vsock_disable_nagle( int fd )
{
    if (fd_index( fd ) < 0)
    {
        extern int disable_nagle( int ) __attribute__((weak));
        if (disable_nagle) return disable_nagle( fd );
        errno = ENOTSOCK; return -1;
    }
    if (!herc_slot( fd, NULL )) { errno = EBADF; return -1; }
    return 0;
}

VS_EXPORT int vsock_shutdown( int fd, int how )
{
    if (fd_index( fd ) < 0) return shutdown( fd, how );
    if (!herc_slot( fd, NULL )) { errno = EBADF; return -1; }
    return 0;
}

VS_EXPORT int vsock_close( int fd )
{
    int i;
    vslot* s;
    uint32_t st, old;
    if (fd_index( fd ) < 0) return close( fd );
    if (!(s = herc_slot( fd, &i ))) { errno = EBADF; return -1; }
    st = atomic_load( &s->state );
    if (st == ST_SOCK || st == ST_LISTEN)
    {
        VDBG( "close listener fd %d\n", fd );
        slot_free( i );
        vsock_doorbell_ring();
        return 0;
    }
    old = atomic_fetch_or( &s->flags, FL_HCLOSED );
    if (old & FL_HCLOSED) { errno = EBADF; return -1; }
    VDBG( "close fd %d by Hercules%s\n", fd, (old & FL_CCLOSED) ? " (slot freed)" : "" );
    atomic_fetch_add( &out_seq, 1 );
    if (old & FL_CCLOSED) slot_free( i );
    vsock_doorbell_ring();
    return 0;
}

/*-------------------------------------------------------------------*/
/* pselect / select                                                   */
/*-------------------------------------------------------------------*/
static int vs_readable( int i )
{
    uint32_t st = atomic_load( &S[i].state ), f;
    if (st == ST_LISTEN) return find_pending( i ) >= 0;
    if (st != ST_OPEN) return 0;
    f = atomic_load( &S[i].flags );
    return ring_used( &S[i].in ) > 0 || (f & (FL_CCLOSED | FL_HCLOSED));
}

static int vs_writable( int i )
{
    if (atomic_load( &S[i].state ) != ST_OPEN) return 0;
    return ring_used( &S[i].out ) < VSOCK_RING || (atomic_load( &S[i].flags ) & FL_CCLOSED);
}

#define MAX_REAL 32

static int vs_select( int nfds, fd_set* r, fd_set* w, fd_set* e, double tmo_ms )
{
    volatile int* wf = watch_flag;
    fd_set rin, win, rout, wout;
    struct pollfd pfd[ MAX_REAL ];
    int fd, npfd = 0, cnt, k;
    double deadline = tmo_ms < 0 ? -1 : now_ms() + tmo_ms;

    watch_flag = NULL;                  /* applies to this call only */
    if (nfds > FD_SETSIZE) nfds = FD_SETSIZE;
    FD_ZERO( &rin ); FD_ZERO( &win );
    if (r) rin = *r;
    if (w) win = *w;

    /* Validate the vsock fds and collect real fds (safety net). */
    for (fd = 0; fd < nfds; fd++)
    {
        int inr = r && FD_ISSET( fd, &rin ), inw = w && FD_ISSET( fd, &win );
        if (!inr && !inw) continue;
        if (fd_index( fd ) >= 0)
        {
            if (!herc_slot( fd, NULL )) { errno = EBADF; return -1; }
        }
        else if (npfd < MAX_REAL)
        {
            pfd[npfd].fd = fd;
            pfd[npfd].events = (short)( (inr ? POLLIN : 0) | (inw ? POLLOUT : 0) );
            npfd++;
        }
    }

    for (;;)
    {
        uint32_t seen = bell_seen();
        double wait;
        FD_ZERO( &rout ); FD_ZERO( &wout );
        cnt = 0;
        for (fd = VSOCK_FD_BASE; fd < nfds && fd < VSOCK_FD_BASE + VSOCK_MAX; fd++)
        {
            int i = fd - VSOCK_FD_BASE;
            if (r && FD_ISSET( fd, &rin ) && vs_readable( i )) { FD_SET( fd, &rout ); cnt++; }
            if (w && FD_ISSET( fd, &win ) && vs_writable( i )) { FD_SET( fd, &wout ); cnt++; }
        }
        if (npfd && poll( pfd, (nfds_t) npfd, 0 ) > 0)
        {
            for (k = 0; k < npfd; k++)
            {
                if ((pfd[k].revents & (POLLIN | POLLHUP | POLLERR)) && r && FD_ISSET( pfd[k].fd, &rin ))
                { FD_SET( pfd[k].fd, &rout ); cnt++; }
                if ((pfd[k].revents & (POLLOUT | POLLERR)) && w && FD_ISSET( pfd[k].fd, &win ))
                { FD_SET( pfd[k].fd, &wout ); cnt++; }
            }
        }
        /* Console wake-up (replaces the readable cnslrpipe). */
        if (wf && __atomic_load_n( (int*) wf, __ATOMIC_ACQUIRE ) > 0) cnt++;

        if (cnt || (deadline >= 0 && now_ms() >= deadline))
        {
            if (r) *r = rout;
            if (w) *w = wout;
            if (e) FD_ZERO( e );
            return cnt;
        }
        wait = deadline < 0 ? -1 : deadline - now_ms();
        if (npfd && (wait < 0 || wait > 10)) wait = 10;   /* real fds: poll every 10 ms */
        bell_wait( seen, wait );
    }
}

VS_EXPORT int vsock_pselect( int nfds, fd_set* r, fd_set* w, fd_set* e,
                             const struct timespec* timeout, const sigset_t* sigmask )
{
    (void) sigmask;
    return vs_select( nfds, r, w, e,
        timeout ? (double) timeout->tv_sec * 1000.0 + (double) timeout->tv_nsec / 1e6 : -1 );
}

VS_EXPORT int vsock_select( int nfds, fd_set* r, fd_set* w, fd_set* e, struct timeval* timeout )
{
    return vs_select( nfds, r, w, e,
        timeout ? (double) timeout->tv_sec * 1000.0 + (double) timeout->tv_usec / 1000.0 : -1 );
}

/*-------------------------------------------------------------------*/
/* Terminal side: lock-free, no malloc, never waits                   */
/*-------------------------------------------------------------------*/
VS_EXPORT int hw_term_open_port( const char* ttype, int port )
{
    int i, k = 0;
    vslot* s;
    if ((i = slot_alloc()) < 0) return -1;
    s = &S[i];
    if (ttype)
        for (; k < (int) sizeof( s->ttype ) - 1 && ttype[k]; k++) s->ttype[k] = ttype[k];
    s->ttype[k] = 0;
    atomic_store( &s->want_port, port > 0 && port < 65536 ? port : 0 );
    atomic_store( &s->ticket, atomic_fetch_add( &ticket_ctr, 1 ));
    atomic_store( &s->state, ST_PENDING );
    vsock_doorbell_ring();
    return (int)( (atomic_load( &s->gen ) << ID_SHIFT) | (uint32_t) i );
}

VS_EXPORT int hw_term_open( const char* ttype )
{
    return hw_term_open_port( ttype, 0 );
}

VS_EXPORT int hw_term_input( int id, const uint8_t* ptr, int len )
{
    vslot* s = js_slot( id );
    size_t n;
    if (!s || (atomic_load( &s->flags ) & (FL_HCLOSED | FL_CCLOSED))) return -1;
    if (len <= 0) return 0;
    n = ring_put( &s->in, ptr, (size_t) len );
    if (n) vsock_doorbell_ring();
    return (int) n;
}

VS_EXPORT int hw_term_read( int id, uint8_t* ptr, int cap )
{
    vslot* s = js_slot( id );
    uint32_t f;
    size_t n;
    if (!s) return -1;
    f = atomic_load( &s->flags );      /* before the ring read, as in vsock_recv */
    n = cap > 0 ? ring_get( &s->out, ptr, (size_t) cap ) : 0;
    if (n) { vsock_doorbell_ring(); return (int) n; }   /* wakes a blocked sender */
    return (f & FL_HCLOSED) ? -2 : 0;
}

VS_EXPORT int hw_term_close( int id )
{
    vslot* s = js_slot( id );
    uint32_t expect = ST_PENDING, old;
    int i;
    if (!s) return -1;
    i = (int)( (uint32_t) id & ID_MASK );
    if (atomic_compare_exchange_strong( &s->state, &expect, ST_INIT ))
    {
        slot_free( i );                 /* never accepted */
        vsock_doorbell_ring();
        return 0;
    }
    old = atomic_fetch_or( &s->flags, FL_CCLOSED );
    if (old & FL_CCLOSED) return -1;
    if (old & FL_HCLOSED) slot_free( i );
    vsock_doorbell_ring();
    return 0;
}

VS_EXPORT int hw_term_state( int id )
{
    vslot* s = js_slot( id );
    uint32_t f;
    if (!s) return -1;
    f = atomic_load( &s->flags );
    return (atomic_load( &s->state ) == ST_PENDING ? 1 : 2)
         | ((f & FL_HCLOSED) ? 4 : 0) | ((f & FL_CCLOSED) ? 8 : 0);
}

VS_EXPORT int hw_term_out_avail( int id )
{
    vslot* s = js_slot( id );
    return s ? (int) ring_used( &s->out ) : -1;
}

VS_EXPORT int hw_term_in_space( int id )
{
    vslot* s = js_slot( id );
    return s ? (int)( VSOCK_RING - ring_used( &s->in )) : -1;
}

VS_EXPORT uint32_t hw_term_out_seq( void ) { return atomic_load( &out_seq ); }
VS_EXPORT uint8_t* hw_term_buf( void )     { return jsbuf; }
VS_EXPORT int      hw_term_buf_size( void ){ return (int) sizeof( jsbuf ); }
