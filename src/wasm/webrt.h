// SPDX-License-Identifier: Apache-2.0
/* webrt.h  Browser runtime support, see webrt.c        */
#ifndef _WEBRT_H
#define _WEBRT_H
#include <stddef.h>
#include <stdint.h>

/* hw_phase() values */
#define WEBRT_PHASE_INIT     0
#define WEBRT_PHASE_LOADING  1   /* fetching DASD/conf into WasmFS     */
#define WEBRT_PHASE_STARTING 2   /* impl() running                     */
#define WEBRT_PHASE_RUNNING  3   /* impl() returned, Hercules is up    */
#define WEBRT_PHASE_ENDED    4   /* Hercules ended (log closed)        */
#define WEBRT_PHASE_FAILED   5   /* load or impl() failed              */

/* hw_stat(i) indexes */
#define WEBRT_ST_HEAP_USED   0   /* mallinfo().uordblks, last sample   */
#define WEBRT_ST_HEAP_PEAK   1   /* max uordblks                       */
#define WEBRT_ST_ARENA       2   /* mallinfo().arena                   */
#define WEBRT_ST_SBRK        3   /* sbrk(0), last sample               */
#define WEBRT_ST_SBRK_PEAK   4   /* max sbrk(0) = heap high-water mark */
#define WEBRT_ST_SAMPLES     5
#define WEBRT_ST_THREADS     6   /* Hercules threads (HHC00100I - HHC00101I/HHC00102E) */
#define WEBRT_ST_THREADS_PEAK 7
#define WEBRT_ST_CMDS        8   /* commands executed                  */
#define WEBRT_ST_MEM         9   /* wasm memory size in bytes (grows with WEBGROW=1) */
#define WEBRT_ST_DIRTY      10   /* updated CCKD track images not yet written to the shadow files, 0 = saved */
#define WEBRT_ST_FLUSHES    11   /* hw_cckd_flush() requests served (hardener passes started) */
#define WEBRT_ST_DIRTYMASK  12   /* bit k = the k-th CCKD device has unsaved data (devnum: hw_cckd_devnum(k)) */
#define WEBRT_ST_HARDMASK   13   /* bit k = the k-th CCKD device: pending writes or not hardened since a write */
#define WEBRT_ST_SRMTUNE    14   /* srmtune: N*1000 + routines changed; 0 = not done / failed */
/* activity and CPU state for the page's checkpoint scheduler and resume watchdog,
   sampled every 100 ms by the wasm_webdirty thread (wasm_main.c) */
#define WEBRT_ST_CKDWRITES  15   /* CCKD track writes (cckdblk.stats_writes, low 32 bits) */
#define WEBRT_ST_INSTCNT    16   /* CP00 instruction count (low 32 bits) */
#define WEBRT_ST_CPUSTATE   17   /* 0x80000000 = valid | bit0 CP00 started | bit1 CP00 in wait state */
#define WEBRT_ST_USERWRITES 18   /* track writes of the CCKD devices that are not --cckd-wrthru-skip (PAGE00) */
#define WEBRT_ST_WRITEMASK  19   /* bit k = the k-th CCKD device (hw_cckd_devnum(k)) was written in the last 10 s */
#define WEBRT_ST_DEVWRITES0 20   /* 20 + k = track writes of the k-th CCKD device (k < 16) */
#define WEBRT_ST_COUNT      36
#define WEBRT_ST_CKPT       40   /* sr.c sr_ckpt_progress = 4 * checkpoints ended + phase (1 paused, 2 writing the manifest) */

#define WEBRT_CMD_LEN        512

void webrt_set_phase( int p );
void webrt_log_put( const char* msg, size_t len );
void webrt_log_str( const char* s );
int  webrt_cmd_next( char* out, int timeout_ms );
void webrt_cmd_wake( void );
void webrt_stats_sample( void );
void webrt_stat_set( int i, uint32_t v );
void webrt_stat_add( int i, int32_t v );
int  webrt_load( const char* spec_json, char* msg, size_t msgsize );
int  webrt_flush_take( void );
void webrt_set_devnum( int k, uint32_t devnum );
void webrt_flush_wait( int timeout_ms );
int  webrt_mount_opfs( const char* path, char* msg, size_t msgsize );
#endif
