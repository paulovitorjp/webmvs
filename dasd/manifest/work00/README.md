# Native boot trace with WORK00

One traced native IPL (`~/herc-trace`, `patches/0000-trace-trk.patch`, `HERC_TRK_TRACE`) of `conf/web.cnf` with the 8
volumes (WORK00 at 0251 added), fresh shadows, 0010 connected before `ipl 150` (the page's order), then TSO logon MVSCE02
to READY. Hercules: `~/herc-trace/bin/hercules`; files made by
`scripts/boot-manifest.py` (the `ipl 150` line was upper-cased in a copy of the log: the script looks for `IPL`).

WORK00 adds 3 tracks: `0251,0` at the IPL (volume label, read when MVS mounts the volume) and `0251,1`, `0251,30` at the
logon (VTOC and the new `MVSCE02.ISP.PROF` of `SYS1.CMDPROC(REVINIT)`). WORK00 share of the working set: 8,186 bytes
(754 track bytes + 1,024 header + 264 L1 + 6,144 L2). Whole re-trace: 4,233,921 bytes (native trace without WORK00:
4,166,543; the rest of the difference is run-to-run variation of the other volumes, 9 more tracks).

`scripts/build.sh chunks` appends `boot-tracks.csv` / `boot-tracks-ikt007i.csv` of this directory to the boot lists
(after the native trace and the browser traces), so the WORK00 tracks are in the boot prefetch.
`scripts/e2e.mjs --ws-bytes` default: 4,174,729 = working set 4,166,543 + the WORK00 share 8,186.
