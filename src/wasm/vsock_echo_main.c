// SPDX-License-Identifier: Apache-2.0
/* vsock_echo_main.c  Test program for scripts/node-harness.mjs (wasm).   */
/* A console.c-like loop on the vsock shim: listen on CNSLPORT-like port, */
/* pselect over the listener + connections, echo every byte +1 (mod 256). */
/* A client that sends the line "QUIT\n" ends the program (exit 0).       */
/* Build: emcc -O2 -pthread -sPROXY_TO_PTHREAD -sEXIT_RUNTIME=1 ...       */
/*        (see scripts/vsock-wasm-test.sh)                                */
#include "wasmsock.h"
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <netinet/in.h>

int main( void )
{
    int ls = vsock_socket( AF_INET, SOCK_STREAM, 0 ), conns[ VSOCK_MAX ], nc = 0, i;
    struct sockaddr_in a;
    long long total = 0;
    memset( &a, 0, sizeof( a )); a.sin_family = AF_INET; a.sin_port = htons( 3270 );
    if (ls < 0 || vsock_bind( ls, (struct sockaddr*) &a, sizeof( a )) || vsock_listen( ls, 10 ))
    { perror( "vsock listen" ); return 1; }
    printf( "echo: listening (vsock fd %d)\n", ls ); fflush( stdout );
    for (;;)
    {
        fd_set rs; int maxfd = ls, rc;
        struct timespec to = { 0, 100000000 };
        FD_ZERO( &rs ); FD_SET( ls, &rs );
        for (i = 0; i < nc; i++) { FD_SET( conns[i], &rs ); if (conns[i] > maxfd) maxfd = conns[i]; }
        rc = vsock_pselect( maxfd + 1, &rs, NULL, NULL, &to, NULL );
        if (rc <= 0) continue;
        if (FD_ISSET( ls, &rs ))
        {
            int c = vsock_accept( ls, NULL, NULL );
            if (c >= 0) { conns[ nc++ ] = c; printf( "echo: accepted fd %d\n", c ); fflush( stdout ); }
        }
        for (i = 0; i < nc; i++)
        {
            unsigned char buf[ 4096 ]; ssize_t n; int k;
            if (!FD_ISSET( conns[i], &rs )) continue;
            vsock_set_blocking_mode( conns[i], 0 );
            n = vsock_recv( conns[i], buf, sizeof( buf ), 0 );
            vsock_set_blocking_mode( conns[i], 1 );
            if (n < 0 && errno == EAGAIN) continue;
            if (n <= 0)
            {
                printf( "echo: fd %d closed\n", conns[i] ); fflush( stdout );
                vsock_close( conns[i] ); conns[i] = conns[ --nc ]; i--;
                continue;
            }
            if (n == 5 && !memcmp( buf, "QUIT\n", 5 ))
            {
                printf( "echo: QUIT, %lld bytes echoed\n", total ); fflush( stdout );
                for (k = 0; k < nc; k++) vsock_close( conns[k] );
                vsock_close( ls );
                return 0;
            }
            for (k = 0; k < n; k++) buf[k]++;
            if (vsock_write_socket( conns[i], buf, (int) n ) != n) { perror( "echo: write" ); return 1; }
            total += n;
        }
    }
}
