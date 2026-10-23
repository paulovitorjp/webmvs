// SPDX-License-Identifier: Apache-2.0
/* wasmsock_test.c  Native logic test for wasmsock.c                    */
/* Build: cc -O2 -pthread -DWASMSOCK_NATIVE -o wasmsock_test             */
/*           wasmsock_test.c wasmsock.c                                  */
/* A "console thread" (pselect loop like console.c) echoes every byte    */
/* back with +1; client threads use hw_term_* only (like JS).            */

#define _GNU_SOURCE
#include "wasmsock.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#define NCLI   8
#define BYTES  (2 * 1024 * 1024)

static volatile int flag;               /* like sysblk.cnslpipe_flag */
static atomic_int  stop, served_closed;
static int lsock;
static double t_signal;
static _Atomic double t_woke;

static double now( void ) { struct timespec ts; clock_gettime( CLOCK_MONOTONIC, &ts ); return ts.tv_sec + ts.tv_nsec / 1e9; }
#define CHECK( c ) do { if (!(c)) { fprintf( stderr, "CHECK FAILED line %d: %s (errno %d)\n", __LINE__, #c, errno ); exit( 1 ); } } while (0)

static void* console_thread( void* arg )
{
    int conns[ VSOCK_MAX ], nc = 0, i;
    (void) arg;
    while (!atomic_load( &stop ))
    {
        fd_set rs; int maxfd = lsock, rc;
        struct timespec to = { 0, 100000000 };
        FD_ZERO( &rs ); FD_SET( lsock, &rs );
        for (i = 0; i < nc; i++) { FD_SET( conns[i], &rs ); if (conns[i] > maxfd) maxfd = conns[i]; }
        vsock_select_watch_flag( &flag );
        rc = vsock_pselect( maxfd + 1, &rs, NULL, NULL, &to, NULL );
        if (__atomic_load_n( &flag, __ATOMIC_SEQ_CST )) { t_woke = now(); __atomic_store_n( &flag, 0, __ATOMIC_SEQ_CST ); }
        if (rc <= 0) continue;
        if (FD_ISSET( lsock, &rs ))
        {
            struct sockaddr_in a; socklen_t al = sizeof( a );
            int c = vsock_accept( lsock, (struct sockaddr*) &a, &al );
            CHECK( c >= VSOCK_FD_BASE );
            CHECK( vsock_getpeername( c, (struct sockaddr*) &a, &al ) == 0 && a.sin_addr.s_addr == htonl( INADDR_LOOPBACK ));
            conns[ nc++ ] = c;
        }
        for (i = 0; i < nc; i++)
        {
            uint8_t buf[ 3000 ]; ssize_t n; int k;
            if (!FD_ISSET( conns[i], &rs )) continue;
            vsock_set_blocking_mode( conns[i], 0 );
            n = vsock_recv( conns[i], buf, sizeof( buf ), 0 );
            vsock_set_blocking_mode( conns[i], 1 );
            if (n < 0) { CHECK( errno == EAGAIN ); continue; }
            if (n == 0)
            {
                CHECK( vsock_close( conns[i] ) == 0 );
                CHECK( vsock_close( conns[i] ) == -1 && errno == EBADF );
                conns[i] = conns[ --nc ]; i--;
                atomic_fetch_add( &served_closed, 1 );
                continue;
            }
            for (k = 0; k < n; k++) buf[k]++;
            CHECK( vsock_write_socket( conns[i], buf, (int) n ) == n );
        }
    }
    for (i = 0; i < nc; i++) vsock_close( conns[i] );
    return NULL;
}

static void* client_thread( void* arg )
{
    long seed = (long) arg;
    uint8_t* src = malloc( BYTES ); uint8_t* got = malloc( BYTES );
    int id, sent = 0, recvd = 0, i;
    unsigned r = (unsigned) seed * 2654435761u;
    for (i = 0; i < BYTES; i++) { r = r * 1103515245u + 12345u; src[i] = (uint8_t)( r >> 16 ); }
    id = hw_term_open( "IBM-3278-2" );
    CHECK( id > 0 );
    while (recvd < BYTES)
    {
        if (sent < BYTES)
        {
            r = r * 1103515245u + 12345u;
            int want = 1 + (int)( (r >> 8) % 9000 ), k;
            if (want > BYTES - sent) want = BYTES - sent;
            k = hw_term_input( id, src + sent, want );
            CHECK( k >= 0 );
            sent += k;
        }
        int k = hw_term_read( id, got + recvd, BYTES - recvd );
        CHECK( k >= 0 );
        recvd += k;
        if (!k) sched_yield();
    }
    for (i = 0; i < BYTES; i++) CHECK( got[i] == (uint8_t)( src[i] + 1 ));
    CHECK( hw_term_close( id ) == 0 );
    CHECK( hw_term_close( id ) == -1 );
    free( src ); free( got );
    return NULL;
}

static uint8_t big[ 1 << 20 ];
static int snd_fd;
static void* snd( void* p )
{
    (void) p;
    for (int k = 0; k < (int) sizeof( big ); k++) big[k] = (uint8_t) k;
    CHECK( vsock_write_socket( snd_fd, big, sizeof( big )) == (int) sizeof( big ));
    return NULL;
}

int main( void )
{
    pthread_t ct, cl[ NCLI ];
    struct sockaddr_in a;
    int i, id_early, id2;
    double t0;
    setvbuf( stdout, NULL, _IONBF, 0 );

    /* A connection queued before anyone listens (@0010 before IPL). */
    id_early = hw_term_open( "IBM-3279-2-E@0010" );
    CHECK( id_early > 0 && hw_term_state( id_early ) == 1 );

    lsock = vsock_socket( AF_INET, SOCK_STREAM, 0 );
    CHECK( lsock == VSOCK_FD_BASE + 1 );   /* slot 0 = the early connection */
    memset( &a, 0, sizeof( a )); a.sin_family = AF_INET; a.sin_port = htons( 3270 );
    CHECK( vsock_bind( lsock, (struct sockaddr*) &a, sizeof( a )) == 0 );
    {   int l2 = vsock_socket( AF_INET, SOCK_STREAM, 0 );
        CHECK( vsock_bind( l2, (struct sockaddr*) &a, sizeof( a )) == -1 && errno == EADDRINUSE );
        CHECK( vsock_close( l2 ) == 0 ); }
    CHECK( vsock_listen( lsock, 10 ) == 0 );

    /* nonblocking accept gets the early one, then EAGAIN */
    vsock_set_blocking_mode( lsock, 0 );
    {   int c = vsock_accept( lsock, NULL, NULL ), c2;
        uint8_t b[ 8 ];
        CHECK( c == VSOCK_FD_BASE );
        CHECK( hw_term_state( id_early ) == 2 );
        c2 = vsock_accept( lsock, NULL, NULL );
        CHECK( c2 == -1 && errno == EAGAIN );
        /* Hercules closes first: client reads -2 after the queued bytes */
        CHECK( vsock_send( c, "abc", 3, 0 ) == 3 );
        CHECK( vsock_close( c ) == 0 );
        CHECK( hw_term_state( id_early ) == (2 | 4) );
        CHECK( hw_term_input( id_early, (const uint8_t*) "x", 1 ) == -1 );
        CHECK( hw_term_read( id_early, b, sizeof( b )) == 3 && !memcmp( b, "abc", 3 ));
        CHECK( hw_term_read( id_early, b, sizeof( b )) == -2 );
        CHECK( hw_term_close( id_early ) == 0 );
        CHECK( hw_term_state( id_early ) == -1 );   /* slot freed */
    }
    /* pending connection closed by the client before accept */
    id2 = hw_term_open( "" );
    CHECK( hw_term_close( id2 ) == 0 && hw_term_state( id2 ) == -1 );
    {   int c = vsock_accept( lsock, NULL, NULL ); CHECK( c == -1 && errno == EAGAIN ); }
    vsock_set_blocking_mode( lsock, 1 );

    /* blocking send: Hercules writes 1 MB, client drains slowly */
    {
        int id = hw_term_open( "" ), c, tot = 0;
        static uint8_t rb[ 4096 ];
        pthread_t sender;
        c = vsock_accept( lsock, NULL, NULL );
        CHECK( c >= VSOCK_FD_BASE );
        snd_fd = c;
        pthread_create( &sender, NULL, snd, NULL );
        while (tot < (int) sizeof( big ))
        {
            int k = hw_term_read( id, rb, sizeof( rb ));
            CHECK( k >= 0 );
            for (int j = 0; j < k; j++) CHECK( rb[j] == (uint8_t)( tot + j ));
            tot += k;
            if (!k) usleep( 200 );
        }
        pthread_join( sender, NULL );
        /* client closes: Hercules recv returns 0, then send fails EPIPE */
        CHECK( hw_term_close( id ) == 0 );
        { uint8_t b[ 4 ]; CHECK( vsock_recv( c, b, 4, 0 ) == 0 ); }
        CHECK( vsock_send( c, "x", 1, 0 ) == -1 && errno == EPIPE );
        CHECK( vsock_close( c ) == 0 );
        CHECK( hw_term_state( id ) == -1 );
        printf( "blocking send 1 MB through a 64 KB ring: OK\n" );
    }

    /* echo stress: NCLI clients x 2 MB, random chunk sizes */
    pthread_create( &ct, NULL, console_thread, NULL );
    t0 = now();
    for (i = 0; i < NCLI; i++) pthread_create( &cl[i], NULL, client_thread, (void*)(long)( i + 1 ));
    for (i = 0; i < NCLI; i++) pthread_join( cl[i], NULL );
    printf( "echo: %d clients x %d bytes both ways, verified, %.2f s\n", NCLI, BYTES, now() - t0 );
    for (i = 0; i < 100 && atomic_load( &served_closed ) < NCLI; i++) usleep( 10000 );
    CHECK( atomic_load( &served_closed ) == NCLI );
    printf( "closes seen by console thread: %d\n", atomic_load( &served_closed ));

    /* console signal wakes pselect (watch flag + doorbell) */
    {
        double worst = 0;
        for (i = 0; i < 50; i++)
        {
            usleep( 20000 );
            t_woke = 0; t_signal = now();
            __atomic_store_n( &flag, 1, __ATOMIC_SEQ_CST ); vsock_doorbell_ring();
            while (!t_woke) sched_yield();
            if (t_woke - t_signal > worst) worst = t_woke - t_signal;
        }
        printf( "signal wake-up: 50 tries, worst latency %.3f ms (pselect timeout is 100 ms)\n", worst * 1000 );
        CHECK( worst < 0.050 );
    }

    atomic_store( &stop, 1 );
    vsock_doorbell_ring();
    pthread_join( ct, NULL );

    /* slot exhaustion and reuse */
    {
        int ids[ VSOCK_MAX ], n = 0;
        while (n < VSOCK_MAX && (ids[n] = hw_term_open( "" )) > 0) n++;
        CHECK( n == VSOCK_MAX - 1 );     /* one slot is the listener */
        CHECK( hw_term_open( "" ) == -1 );
        for (i = 0; i < n; i++) CHECK( hw_term_close( ids[i] ) == 0 );
        CHECK( hw_term_open( "" ) > 0 );
        printf( "slot table: %d connections + 1 listener, exhaustion -1, reuse OK\n", n );
    }

    CHECK( vsock_close( lsock ) == 0 );
    printf( "ALL OK\n" );
    return 0;
}
