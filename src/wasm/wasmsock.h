// SPDX-License-Identifier: Apache-2.0
/* wasmsock.h  In-process TN3270 loopback ("vsock") for Hercules        */
/*                                                                     */
/* Part of webmvs (in-process 3270 bridge).                        */
/* Hercules console.c uses the vsock_* calls (mapped by patch 0008 in  */
/* hsocket.h/hmacros.h when USE_WASMSOCK is defined). The other side   */
/* (JS in the browser/Node, or vsock_native_bridge.c natively) uses    */
/* the hw_term_* calls. hw_term_* are lock-free and never malloc, so   */
/* they are safe on the browser main thread with                       */
/* -sALLOW_BLOCKING_ON_MAIN_THREAD=0.                                  */
/*                                                                     */
/* Build: emscripten (atomics + emscripten_futex_wait/wake), or native */
/* Linux with -DWASMSOCK_NATIVE (atomics + futex(2)).                  */

#ifndef _WASMSOCK_H
#define _WASMSOCK_H

#include <stdint.h>
#include <stddef.h>
#include <time.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/select.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VSOCK_FD_BASE   900     /* first pseudo-fd                     */
#define VSOCK_MAX       16      /* slots (listeners + connections)     */
#define VSOCK_RING      65536   /* bytes per ring (power of 2)         */

/*-------------------------------------------------------------------*/
/* Hercules side (BSD socket look-alikes). Calls on fds outside the   */
/* vsock range fall through to the real libc functions.               */
/*-------------------------------------------------------------------*/
int     vsock_socket( int domain, int type, int protocol );
int     vsock_setsockopt( int fd, int level, int name, const void* val, socklen_t len );
int     vsock_bind( int fd, const struct sockaddr* addr, socklen_t len );
int     vsock_listen( int fd, int backlog );
int     vsock_accept( int fd, struct sockaddr* addr, socklen_t* len );
ssize_t vsock_recv( int fd, void* buf, size_t len, int flags );
ssize_t vsock_send( int fd, const void* buf, size_t len, int flags );
int     vsock_read_socket( int fd, void* buf, int n );        /* read_socket()  */
int     vsock_write_socket( int fd, const void* buf, int n ); /* write_socket() */
int     vsock_getpeername( int fd, struct sockaddr* addr, socklen_t* len );
int     vsock_getsockname( int fd, struct sockaddr* addr, socklen_t* len );
int     vsock_pselect( int nfds, fd_set* r, fd_set* w, fd_set* e,
                       const struct timespec* timeout, const sigset_t* sigmask );
int     vsock_select( int nfds, fd_set* r, fd_set* w, fd_set* e, struct timeval* timeout );
int     vsock_close( int fd );
int     vsock_shutdown( int fd, int how );
int     vsock_set_blocking_mode( int fd, int blocking );      /* socket_set_blocking_mode() */
int     vsock_set_keepalive( int fd, int idle, int intv, int cnt ); /* set_socket_keepalive() */
int     vsock_disable_nagle( int fd );                        /* disable_nagle() */
int     vsock_is_vsock( int fd );

/* Doorbell. vsock_doorbell_ring() wakes every vsock waiter (pselect,  */
/* blocking recv/send/accept). vsock_select_watch_flag(p) makes the   */
/* next vsock_pselect/vsock_select call by this thread treat "*p > 0" */
/* as one extra ready descriptor (this replaces the console wake-up   */
/* pipe sysblk.cnslrpipe; see patch 0008, hmacros.h).                 */
void    vsock_doorbell_ring( void );
void    vsock_select_watch_flag( volatile int* flag );

/*-------------------------------------------------------------------*/
/* Terminal side (JS / native bridge). Lock-free, no malloc.          */
/* id > 0 identifies one connection (slot index + generation).        */
/*-------------------------------------------------------------------*/

/* Queue a new client connection; the next accept() on the CNSLPORT
   listener (or on the listener bound to 'port') returns it. May be
   called before Hercules starts listening (the connection waits).
   ttype is informational only (logged; the client sends its TTYPE in
   the telnet negotiation). Returns id > 0, or -1 if no slot is free. */
int      hw_term_open( const char* ttype );
int      hw_term_open_port( const char* ttype, int port );

/* Client -> Hercules bytes. Returns the number of bytes queued (0..len;
   less than len if the input ring is full: retry the rest later), or
   -1 if id is invalid or Hercules has closed the connection.          */
int      hw_term_input( int id, const uint8_t* ptr, int len );

/* Hercules -> client bytes. Returns n > 0 bytes copied, 0 if nothing is
   queued now, -1 if id is invalid, -2 if Hercules closed the connection
   and all output was read (EOF: call hw_term_close).                  */
int      hw_term_read( int id, uint8_t* ptr, int cap );

/* Client closed. Hercules sees EOF on recv() after the queued input.
   The slot is freed when both sides have closed. 0 = ok, -1 = bad id.*/
int      hw_term_close( int id );

/* Bit mask: 1 = pending (not yet accepted), 2 = accepted, 4 = Hercules
   closed, 8 = client closed. -1 = invalid id.                        */
int      hw_term_state( int id );
int      hw_term_out_avail( int id );   /* bytes waiting for hw_term_read */
int      hw_term_in_space( int id );    /* free bytes in the input ring    */

/* Incremented whenever Hercules queues output or closes a connection:
   the JS side polls it (rAF / timer) and drains only when it changed. */
uint32_t hw_term_out_seq( void );

/* A static 64 KB exchange buffer in the wasm heap for the (single
   threaded) JS side, so JS never has to malloc: copy input into it
   before hw_term_input, pass it to hw_term_read.                      */
uint8_t* hw_term_buf( void );
int      hw_term_buf_size( void );

#ifdef __cplusplus
}
#endif

#endif /* _WASMSOCK_H */
