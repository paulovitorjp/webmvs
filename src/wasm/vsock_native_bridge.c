// SPDX-License-Identifier: Apache-2.0
/* vsock_native_bridge.c  Native test bridge: TCP <-> hw_term_*        */
/*                                                                     */
/* Part of webmvs (native test of wasmsock.c). Native              */
/* builds only (-DWASMSOCK_NATIVE). wasmsock.c calls                    */
/* vsock_native_bridge_start() (weak) when Hercules first listens.     */
/* A thread listens on 127.0.0.1:$VSOCK_BRIDGE_PORT (default 3370).    */
/* Each TCP client gets hw_term_open(""); one thread per client moves  */
/* bytes with hw_term_input / hw_term_read, exactly as the JS side     */
/* (scripts/node-harness.mjs, web WasmConnection) does.                */
/* The bridge binds to loopback only (127.0.0.0/8); other addresses     */
/* in $VSOCK_BRIDGE_ADDR are rejected.                                  */

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "wasmsock.h"

#include <stdatomic.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/socket.h>

#if !defined(WASMSOCK_NATIVE)
  #error "vsock_native_bridge.c is for native test builds only"
#endif

static atomic_int started;

typedef struct { int tcp; char peer[ 64 ]; } client_arg;

static int write_all( int fd, const uint8_t* p, int n )
{
    while (n > 0)
    {
        ssize_t w = send( fd, p, (size_t) n, MSG_NOSIGNAL );
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        p += w; n -= (int) w;
    }
    return 0;
}

static void* client_thread( void* arg )
{
    client_arg* ca = (client_arg*) arg;
    int tcp = ca->tcp, id, inlen = 0, inoff = 0, tcp_eof = 0;
    uint8_t inbuf[ 16384 ], outbuf[ 16384 ];
    const char* tt = getenv( "VSOCK_BRIDGE_TTYPE" );
    id = hw_term_open( tt ? tt : "" );
    fprintf( stderr, "vsock bridge: client %s -> id %d\n", ca->peer, id );
    if (id < 0) { close( tcp ); free( ca ); return NULL; }

    for (;;)
    {
        int k;
        /* 1. push pending client input */
        while (inoff < inlen)
        {
            k = hw_term_input( id, inbuf + inoff, inlen - inoff );
            if (k < 0) goto herc_closed;
            if (k == 0) break;          /* ring full: drain output, retry */
            inoff += k;
        }
        if (inoff == inlen) inoff = inlen = 0;

        /* 2. drain Hercules output */
        while ((k = hw_term_read( id, outbuf, (int) sizeof( outbuf ))) > 0)
            if (write_all( tcp, outbuf, k ) < 0) { tcp_eof = 1; break; }
        if (k == -2 || k == -1) goto herc_closed;
        if (tcp_eof) break;

        /* 3. wait for more client input (5 ms: also the output poll interval) */
        {
            struct pollfd pfd = { tcp, (short)( inlen ? 0 : POLLIN ), 0 };
            int pr = poll( &pfd, 1, inlen ? 1 : 5 );
            if (pr > 0 && (pfd.revents & (POLLIN | POLLHUP | POLLERR)))
            {
                ssize_t r = recv( tcp, inbuf, sizeof( inbuf ), 0 );
                if (r < 0 && errno == EINTR) continue;
                if (r <= 0) { tcp_eof = 1; break; }
                inlen = (int) r; inoff = 0;
            }
        }
    }
    /* client closed the TCP connection */
    fprintf( stderr, "vsock bridge: id %d: client closed\n", id );
    hw_term_close( id );
    close( tcp );
    free( ca );
    return NULL;

herc_closed:
    fprintf( stderr, "vsock bridge: id %d: Hercules closed\n", id );
    hw_term_close( id );
    shutdown( tcp, SHUT_RDWR );
    close( tcp );
    free( ca );
    return NULL;
}

static void* bridge_main( void* arg )
{
    const char* ps = getenv( "VSOCK_BRIDGE_PORT" );
    const char* as = getenv( "VSOCK_BRIDGE_ADDR" );
    int port = ps ? atoi( ps ) : 3370, ls, one = 1;
    struct sockaddr_in sin;
    (void) arg;

    memset( &sin, 0, sizeof( sin ));
    sin.sin_family = AF_INET;
    sin.sin_port   = htons( (uint16_t) port );
    if (!as) as = "127.0.0.1";
    if (inet_pton( AF_INET, as, &sin.sin_addr ) != 1 || (ntohl( sin.sin_addr.s_addr ) >> 24) != 127)
    {
        fprintf( stderr, "vsock bridge: refusing non-loopback address '%s'\n", as );
        return NULL;
    }
    if ((ls = socket( AF_INET, SOCK_STREAM, 0 )) < 0) { perror( "vsock bridge: socket" ); return NULL; }
    setsockopt( ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof( one ));
    if (bind( ls, (struct sockaddr*) &sin, sizeof( sin )) < 0 || listen( ls, 16 ) < 0)
    {
        fprintf( stderr, "vsock bridge: bind/listen %s:%d failed: %s\n", as, port, strerror( errno ));
        close( ls );
        return NULL;
    }
    fprintf( stderr, "vsock bridge: listening on %s:%d\n", as, port );

    for (;;)
    {
        struct sockaddr_in peer;
        socklen_t pl = sizeof( peer );
        pthread_t t;
        client_arg* ca;
        int cs = accept( ls, (struct sockaddr*) &peer, &pl );
        if (cs < 0) { if (errno == EINTR) continue; perror( "vsock bridge: accept" ); usleep( 100000 ); continue; }
        setsockopt( cs, IPPROTO_TCP, TCP_NODELAY, &one, sizeof( one ));
        if (!(ca = (client_arg*) calloc( 1, sizeof( *ca )))) { close( cs ); continue; }
        ca->tcp = cs;
        snprintf( ca->peer, sizeof( ca->peer ), "%s:%d", inet_ntoa( peer.sin_addr ), ntohs( peer.sin_port ));
        if (pthread_create( &t, NULL, client_thread, ca ) != 0) { close( cs ); free( ca ); continue; }
        pthread_detach( t );
    }
    return NULL;
}

__attribute__((visibility("default")))
void vsock_native_bridge_start( void )
{
    pthread_t t;
    if (atomic_exchange( &started, 1 )) return;
    if (pthread_create( &t, NULL, bridge_main, NULL ) == 0)
        pthread_detach( t );
}
