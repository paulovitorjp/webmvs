# Browser boot traces (build input)

Track traces of real browser IPLs (first read of each track, IPL to TSO READY), recorded with
`globalThis.__mvsRuntime.lazyTrace()`. `scripts/build.sh chunks`
joins them with the native trace `../boot-tracks.csv` into the boot list of `scripts/dasd-chunk.py --boot`: the
chunks that the page prefetches before and during the IPL.
