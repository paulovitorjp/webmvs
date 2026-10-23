#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Generate the track-access trace in cckddasd.c (source of patches/0000-trace-trk.patch).
Usage: mk-trace-patch.py <path/to/cckddasd.c>   (edits the file in place)"""
import sys
p = sys.argv[1]; s = open(p).read()
func = r'''/*-------------------------------------------------------------------*/
/* Track trace (patches/0000-trace-trk.patch).                       */
/* If env HERC_TRK_TRACE names a file, append one line for each      */
/* track image that cckd_read_trk reads from the image file (cache   */
/* miss): "epoch_sec.usec,DEVN,trk,ra"   (ra 0 = i/o thread,         */
/* ra > 0 = readahead thread). Not for production builds.            */
/*-------------------------------------------------------------------*/
static void cckd_trk_trace( U16 devnum, int trk, int ra )
{
    static pthread_mutex_t  trc_mtx  = PTHREAD_MUTEX_INITIALIZER;
    static FILE*            trc_fp   = NULL;
    static int              trc_init = 0;
    struct timespec         ts;

    pthread_mutex_lock( &trc_mtx );
    if (!trc_init)
    {
        const char* fn = getenv( "HERC_TRK_TRACE" );
        trc_init = 1;
        if (fn && *fn)
            trc_fp = fopen( fn, "a" );
    }
    if (trc_fp)
    {
        clock_gettime( CLOCK_REALTIME, &ts );
        fprintf( trc_fp, "%ld.%06ld,%4.4X,%d,%d\n", (long) ts.tv_sec,
                 (long) (ts.tv_nsec / 1000), devnum, trk, ra );
        fflush( trc_fp );
    }
    pthread_mutex_unlock( &trc_mtx );
}

'''
anchor = 'int cckd_read_trk(DEVBLK *dev, int trk, int ra, BYTE *unitstat)\n{'
assert s.count(anchor) == 1, "cckd_read_trk anchor"
# put the function before the comment block that precedes cckd_read_trk
i = s.index(anchor)
j = s.rfind('/*-------------------------------------------------------------------*/\n/* Read a track image', 0, i)
assert j > 0, "comment block anchor"
s = s[:j] + func + s[j:]
call_anchor = '''    /* Read the track image */
    obtain_lock( &cckd->filelock );
    {
        len = cckd_read_trkimg (dev, buf, trk, unitstat);'''
assert s.count(call_anchor) == 1, "read anchor"
s = s.replace(call_anchor, '''    cckd_trk_trace( dev->devnum, trk, ra );   /* track trace */

''' + call_anchor)
open(p, 'w').write(s)
print("trace inserted")
