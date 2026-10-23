# MVS 3.8J in the browser: research notes

Goal: a public web page that IPLs MVS 3.8J on Hercules (SDL Hyperion) compiled to WebAssembly. All of it runs on the client. The visitor watches the IPL, then logs on to TSO from a 3270 terminal in the page. The Hercules console and commands stay hidden.

Five research tracks are below: Hercules internals, MVS distribution, browser I/O, Emscripten runtime, and hosting. Line numbers refer to Hyperion commit `ae9b4971849e6560fae47f26bdd89f95accc994f` (2025-12-07). Base URL: `https://github.com/SDL-Hercules-390/hyperion/blob/master/<file>`. The Emscripten facts come from `main` (latest release 6.0.13, 2026-10-19).

---

## 1. Track: Hercules internals

### 1.1 Recommendation
- Use the herclin embedding model. Write a new `wasm_main.c` that does these steps in order:
  1. Call `registerLogCallback`.
  2. Call `impl()`.
  3. Set `sysblk.panel_init=1` and `sysblk.herclin=1`.
  4. Use `getCommandHandler()` to send hidden commands.
- Do not use `bootstrap.c` or `panel.c`.
- Build steps:
  1. Run `emconfigure ./configure --host=wasm32-unknown-emscripten --enable-extpkgs=$EXT --disable-shared --enable-static --without-included-ltdl --enable-multi-cpu=1`. Disable Rexx and pass cache values such as `ac_cv_func_fork=no`. Use this step only to get `config.h`.
  2. Compile an explicit list of source files with `emcc -pthread -fwasm-exceptions -O3 -DOPTION_NO_WATCHDOG -DOPTION_NO_SHARED_DEVICES`.
  3. Link with `-sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=24 -sSUPPORT_LONGJMP=wasm -sUSE_ZLIB=1 -sINITIAL_MEMORY=512MB`.
- Patches, in this order:
  1. A static HDL registry in `hdl.c`. Link only hdteq, hdt3270, hdt1052c, hdt3505, hdt1403 and hdt3525. Compile `sockdev.c` one time only.
  2. `read_pipe` in `hmacros.h`: call `poll()` before `read`.
  3. `CRASH()` becomes `__builtin_trap()`.
  4. A `__EMSCRIPTEN__` block in `hostopts.h` with `MAX_DEVICE_THREADS 4`.
  5. A web transport for the 3270 path in `console.c` (see section 3 for the bridge design).
- Web config: `TIMERINT 1000`, `DEVTMAX 4`, `CCKD ra=1,wr=1`, CCKD DASD with `sf=` shadow files. Phase 1 loads the files into MEMFS. Later phases move to WasmFS with OPFS or the fetch backend, so that only the tracks that are read get downloaded.
- No earlier Hercules port to Emscripten was found. The nearest benchmark is ve2cuy/ibm-z-emu (section 1.8).

### 1.2 Blockers (each has a workaround)
| # | Blocker | Where | Workaround |
|---|---|---|---|
| 1 | HDL needs dlopen. All modules export the same 6 entry-point names. | hdl.c:163-322, hdl.h:262-480, configure.ac:2710 | Static registry plus per-module `-D` renames. Link only the modules you need. |
| 2 | The browser has no listen, accept or socketpair. | console.c:3302-3740; libsockfs.js:587; emscripten_syscall_stubs.c:192 | A web transport in console.c (section 3) |
| 3 | A pipe read never blocks (EAGAIN). | logger.c:340; hmacros.h:199; libpipefs.js:163 | `poll()` before read in `read_pipe`, or a condvar ring buffer |
| 4 | The browser main thread cannot block, and `impl()` waits on condition variables and I/O. | everywhere | `-sPROXY_TO_PTHREAD`. JS UI on the main thread only. |
| 5 | Workers start asynchronously, and Hercules creates many threads at run time. | channel.c:2712, cckddasd.c, console.c | `-sPTHREAD_POOL_SIZE=24`, `DEVTMAX 4`, `CCKD ra=1,wr=1` |
| 6 | setjmp/longjmp in the CPU loop | cpu.c:668-2038, channel.c | `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` |
| 7 | The prebuilt extpkg `.a` files are x86 only. | crypto/ decNumber/ SoftFloat/ telnet/ lib | Build with emcmake into `<pkg>32.Release` with `-pthread`, then pass `--enable-extpkgs` |
| 8 | Configure run-tests fail when you cross-compile. | configure.ac:1826/1892/2047/2441 | `--host=wasm32-unknown-emscripten` plus cache values |
| 9 | Signals, crash handlers and the SIGILL probe | bootstrap.c:56; impl.c:883 | New `wasm_main.c`; do not use `-msse2` |
| 10 | `CRASH()` does not trap. | hmacros.h:522 | `__builtin_trap()` |
| 11 | The watchdog can fire when a tab is frozen. | impl.c:1721; featall.h:124 | `-DOPTION_NO_WATCHDOG` |
| 12 | The timer wakes up every 50 µs. | featall.h:72; timer.c:336 | `TIMERINT 1000` or higher |
| 13 | Legacy JS FS syscalls are proxied to the main thread. | all file I/O | Phase 1: MEMFS. Later: WasmFS with the OPFS or fetch backend |
| 14 | fork, system, Rexx, tuntap, HTTP server, shared devices | hscmisc.c, printer.c, hRexx*.c | Disable them in configure or featall, and do not configure them |
| 15 | Per-thread CPU clocks are not supported. | config.c:1079 | Hercules already falls back to `host_tod()` |
| 16 | The host is 32-bit with at most 4 GB of memory. | — | A 16 MB mainstor is fine. Use `-sINITIAL_MEMORY=512MB` and `-sSTACK_SIZE=2MB`. |
| 17 | SharedArrayBuffer needs cross-origin isolation. | Emscripten pthreads.rst | COOP `same-origin` + COEP `require-corp` |

### 1.3 Build system
- Hyperion uses autotools only: `configure.ac`, `Makefile.am`, libtool (`AC_PROG_LIBTOOL`, `AC_LIBTOOL_DLOPEN`, `AC_LIB_LTDL`, configure.ac:377-544) and `autogen.sh`. It has no CMake. Windows builds use `makefile.msvc`.
- `autoconf/config.sub:2004` already knows `emscripten*`. The source tree has no `__EMSCRIPTEN__` references today.
- Libraries (Makefile.am:150-600):
  - `libhercs` (hsys.c)
  - `libhercu` (hdl.c, hthreads.c, logger.c, hsocket.c, ...)
  - `libhercd` (ckddasd, cckddasd, fbadasd, cache, shared)
  - `libherct` (tape utilities)
  - `libherc` (about 90 files: cpu.c, channel.c, panel.c, impl.c, config.c, ...)
- `hercules` itself is only `bootstrap.c`, linked with `-dlopen self`. `herclin.c` is a sample program that embeds Hercules with no panel. Use it as the template for the wasm `main()`.
- Device modules (`HERCMODS`, built as `-module` .la files):
  - `hdt3270` = console.c
  - `hdt1052c` = con1052c.c
  - `hdt1403` = printer.c + sockdev.c
  - `hdt3505` = cardrdr.c + sockdev.c
  - `hdt3525` = cardpch.c + sockdev.c
  - `hdt3420` = 8 tape files (duplicated by `libhdt3420_not_mod.la`)
  - `hdteq`, `dyncrypt`, `dyngui`, plus the network modules
- CKD and FBA DASD support is built in through `hdl_define_devtypes_ep` (hdl.c:1408ff). It is not a module.
- External packages: crypto, decNumber, SoftFloat and telnet (https://github.com/SDL-Hercules-390/{crypto,decNumber,SoftFloat,telnet}). Hyperion ships only x86/x64 prebuilt libraries (`readme/README.EXTPKG.md`).
  - Each package uses CMake. The library name comes from the build directory name (`cmake/modules/ParseBinaryDir.cmake`), so a directory named `<pkg>32.Release` gives `lib<pkg>32.a`.
  - configure links `-l<pkg>${hc_cv_pkg_lib_suffix}` (configure.ac:3141-3352). wasm32 gives `hc_cv_cpu_bits=32` (configure.ac:206-215).
  - `--enable-extpkgs=DIR` searches `DIR/lib` and `DIR/include` (configure.ac:2200).
  - Recipe for each package:
    ```
    mkdir SoftFloat32.Release && cd SoftFloat32.Release
    emcmake cmake -DCMAKE_C_FLAGS="-pthread -O3" -DCMAKE_INSTALL_PREFIX=$EXT ../ext-SoftFloat
    emmake make install
    ```
  - Every object must be built with `-pthread`. If one is not, wasm-ld rejects shared memory ("not compiled with atomics/bulk-memory").
- How configure behaves under Emscripten:
  - `target_os=emscripten` takes the `*)` branch, so `hc_cv_is_nix=no`. This only disables hercifc.
  - `hostopts.h` reaches the "unknown target platform" `#else` (hostopts.h:367). Check with `emcc -dM -E` whether `__linux__` is defined.
  - The `AC_TRY_RUN` defaults for cross-compiling are pessimistic: `hc_cv_builtin_alloca_broke=yes`, `hc_cv_regparm_attr_broke=yes`, `hc_cv_gcc_strict_aliasing_insanity=yes`.
  - configure stops with an error if it finds no dlopen (configure.ac:2710). Emscripten libc has a `dlopen` symbol. Use `--without-included-ltdl` (configure.ac:552).
- Approach: use configure only to make `config.h`, then compile with a small custom Makefile. Do not try to make libtool `-module`, `-dlopen self` or shared libraries work under wasm.

### 1.4 Threading (hthreads)
- `hthreads.c` wraps pthreads. `hthread_create_thread()` gives each thread a 1 MB stack (`HTHREAD_STACK_SIZE`, hthreads.c:79).
- Threads in a typical MVS configuration:
  - CPU (`cpu_thread`, one per NUMCPU, config.c ~1060)
  - timer (`timer_thread`, cpu.c:2363 and timer.c:167; `USLEEP(sysblk.timerint)` with a default of 50 µs, featall.h:72)
  - logger (logger.c:618; blocking `read_pipe` on a pipe that receives stdout/stderr through dup2, logger.c:203 and 608)
  - watchdog (impl.c:1721)
  - rc-file thread (impl.c:1766)
  - log callback (impl.c:1776)
  - console (`console_connection_handler`, console.c:718 and 3385; uses `pselect`; starts one `connect_client` thread per connection, console.c:3732)
  - device I/O pool (channel.c:2712; no limit by default; set a cap with `DEVTMAX`)
  - CCKD readahead, writer, garbage collector and hardener (cckddasd.c:1495-5390; set with `CCKD ra=,wr=,gcint=`, cckddasd.c:6505)
- Budget: about 12 to 18 threads in steady state with 1 CPU, `DEVTMAX 4` and `CCKD ra=1,wr=1`. Use a pool of 24.

### 1.5 Dynamic loading (HDL)
- HDL is mandatory in Hyperion 4.x. `OPTION_DYNAMIC_LOAD` is legacy and only `tcpnje.c:44` still defines it.
- `hdl_main()` registers the main executable and preloads `hdteq` and `dyncrypt` (`hdl_preload[]`, hdl.c:23).
- `hdl_DEVHND()` (hdl.c:1132) loads the module `"hdt"+type`. If that fails, it uses the device-type equivalents in hdteq (hdteq.c:34-83). Examples: 3215/1052/3287/SYSG use hdt3270, 3215-C uses hdt1052c, 1442/2501 use 3505, 3211 uses 1403, 3480 uses 3420.
- `hdl_loadmod` calls `hdl_dlopen()` (hdl.c:163), then `dlsym` for 6 names (hdl.c:293-322): `hdl_check_depends_ep`, `hdl_register_symbols_ep`, `hdl_resolve_symbols_ep`, `hdl_define_devtypes_ep`, `hdl_define_instructs_ep`, `hdl_on_module_unload_ep`. All modules export these same names (hdl.h:262-480).
- con1052c overrides `panel_command` with `HDL_REGISTER` and chains to the next handler with `hdl_next`. The port must keep the HDL semantics.
- Emscripten `dlopen` with pthreads is still experimental (Dynamic-Linking.rst).
- Workaround (recommended):
  1. Compile each module with `-Dhdl_check_depends_ep=hdt3270_hdl_check_depends_ep` (and the same for the other 5 names).
  2. Add an `#ifdef __EMSCRIPTEN__` table `{modname, symname, addr}` to hdl.c.
  3. Make `hdl_dlopen` and the dlsym lookup use that table.
- Link these modules: hdteq, hdt3270, hdt1052c, hdt3505, hdt1403, hdt3525, and hdt3420 if you want tape. Skip dyncrypt, dyngui, the network modules and hRexx.
- Alternative: libtool `-dlpreopen` with libltdl (herclin.c already calls `LTDL_SET_PRELOADED_SYMBOLS`). This still needs the renames.

### 1.6 Signals, select, sockets, mmap, fork, TTY
- Signals: Emscripten does not deliver async signals. bootstrap.c installs crash handlers with `sigaction` (bootstrap.c:56-62). The PCLMULQDQ SIGILL probe (impl.c:883-936) runs only if `_GCC_SSE2_` is defined, so do not pass `-msse2`.
- select/pselect: Emscripten 4.0.23 and later can block in select/poll from a background thread when the fds include pipes. 5.0.4 added `ppoll` and `pselect`. 6.0.3 moved poll onto per-inode wait queues.
- Pipes: `libpipefs.js:163-164` ("Behave as if the read end is always non-blocking") throws EAGAIN. logger.c:340-375 treats EAGAIN as an error. `SEND/RECV_PIPE_SIGNAL` (hmacros.h:733) reads only after select, so it works.
- Sockets: SOCKFS supports `listen()` only on Node (`libsockfs.js:587-589`), and `socketpair` is not implemented. console.c calls `socket/bind/listen` (3302-3372), `accept` (3650/3655), `getpeername`, `inet_ntoa` and `setsockopt` (2859ff), `recv` (2606) and `write_socket` (312).
- mmap: Hercules does not use it. Main storage uses calloc (config.c:364).
- fork: used only by the `sh` command, printer pipes and tuntap. `ac_cv_func_fork=no` selects `USE_ANSI_SYSTEM_API_FOR_SH_COMMAND`.
- TTY: used only by panel.c, hconsole.c and bootstrap.c.
- `pthread_getcpuclockid` returns ENOENT. clock.c:905 then falls back to `host_tod()`.
- `CRASH()` is `*(BYTE*)NULL=0` (hmacros.h:522). Address 0 is valid memory in wasm, so this corrupts memory without a trap.
- setjmp/longjmp: cpu.c:1988-2038 sets `exitjmp`, `archjmp` and `progjmp`. Every program interrupt does a longjmp.
- Atomics: the C11 fallback in machdep.h:604-636 covers cmpxchg1/4/8.

### 1.7 Headless start and config
- `-d` now means `-n`/`--NoUI` (impl.c:2076-2094).
- Embedding API: `registerLogCallback(cb)` (impl.c:103). When a callback is registered, `impl()` returns after setup (impl.c:1772-1784). `getCommandHandler()` (impl.c:774) returns `panel_command`. The rc-file thread waits for `panel_init` (impl.c:812-816).
- Options: `-f cfg`, `-r rcfile`, a `hercules.rc` file in the cwd (impl.c:794-806), `-o logfile`, `-p modpath`, `-s sym=val`.
- Suggested web config:
  ```
  NUMCPU 1
  MAINSIZE 16
  TIMERINT 1000
  DEVTMAX 4
  CCKD ra=1,raq=4,wr=1,gcint=10
  ```
- Size option: HQA scenario 1 (hqadefs.h:25-32: `NO_390_MODE`, `NO_900_MODE`) is a supported S/370-only build. First check that the herc_370_extension instructions are still present in that build.

### 1.8 Prior art
- No Emscripten or wasm build of Hercules was found on GitHub or in the Hyperion issue tracker.
- https://github.com/ve2cuy/ibm-z-emu (Apache-2.0, created 2026-10-16) is a separate S/370 emulator written in Rust. It contains no Hercules code. It runs MVS 3.8j TK5 in the browser from a 309 KB single-threaded wasm, with about 290 MB of volumes stored in OPFS. TSO is ready about 1 minute after IPL. Demo: https://ve2cuy.github.io/ibm-z-emu/
- Server-side gateways: josh-ISI/tk5-gateway, ardumajonchi/mvsq.

---

## 2. Track: MVS distribution

### 2.1 Recommendation
- Use **MVS/CE v3.0.0** (https://github.com/MVS-sysgen/sysgen/releases/tag/v3.0.0, `MVSCE.release.v3.0.0.tar`, 198,789,120 bytes).
- Minimal volume set: MVSRES 0150, MVS000 0151, PAGE00 0152, SPOOL1 0153, PUB000 0180 and PUB001 0190. That is 54.7 MB of CCKD files (about 42.8 MB in use) and 2.89 GB raw.
- MVS/CE needs SDL Hyperion 4.5 or later.
- The IPL needs only `IPL 150` and two `hao` rules: reply `/` on console 009, and reply `/r 0,noreq` to `$HASP426`.
- Visitor user: MVSCE02/PASS4U.
- Later image: TK5 Update 5, but only after the author agrees to redistribution.
- Do not use TK4-. It has had no update since 2016, its host is offline, and it ships a pre-SDL Hercules 4.00.

### 2.2 MVS/CE details
- Source: https://github.com/MVS-sysgen/sysgen. `sysgen.py` automates Jay Moseley's V8 sysgen (https://www.jaymoseley.com/hercules/installMVS/iMVSintroV8.htm). It adds RAKF, BREXX, NJE38, RFE/REVIEW, Wally ISPF, MVP, FTPD, HTTPD and UFSD, and it runs in GitHub Actions.
- Volumes (CCKD, zlib comp=1; 150.2 MB of files, 111.1 MB in use, 4.38 GB raw), from `conf/local.cnf`:

| Addr | Volume | Type | File | Used | Contents |
|---|---|---|---|---|---|
| 0150 | MVSRES | 3350 | 15.2 MB | 12.4 MB | SYS1.*, master catalog, UADS, PARMLIB |
| 0151 | MVS000 | 3350 | 2.8 MB | 2.7 MB | HASPCKPT, SYS2.*, VTAMLST, CMDPROC, RAKF |
| 0152 | PAGE00 | 3350 | 16.5 MB | 6.8 MB | page datasets |
| 0153 | SPOOL1 | 3350 | 10.6 MB | 2.5 MB | SYS1.HASPACE |
| 0180 | PUB000 | 3380 | 0.9 MB | 0.4 MB | user CLIST/CNTL/EXEC, UFS |
| 0190 | PUB001 | 3390 | 8.7 MB | 8.0 MB | BREXX, ISPF, REVIEW, RAKF, user catalog |
| 0250 | SMP000 | 3350 | 48.6 MB | — | SMP |
| 0251 | WORK00 | 3350 | 1.1 MB | — | empty |
| 0252 | WORK01 | 3350 | 16.9 MB | — | sysgen leftovers |
| 0253 | SYSCPK | 3350 | 28.8 MB | — | compilers |
| 0220-0225 | SORTW1-6 | 2314 | ~0 | — | sort work |

- Why this is the minimum: VATLST00 marks only MVSRES, MVS000, PAGE00 and SPOOL1 as `Y`. TSOLOGON allocates `&SYSUID..CLIST` (PUB000) and the BREXX RXLIB (PUB001). This set has not been boot-tested yet.
- IPL: `start_mvs.sh` runs `hercules -f conf/local.cnf -r conf/mvsce.rc`. The `mvsce.rc` file:
  - enables `HERC_TCPIP_EXTENSION`, `HERC_TCPIP_PROB_STATE` and `herc_370_extension`
  - runs `IPL 150`
  - sets `hao tgt input for console 0:0009` with `hao cmd /`
  - sets `hao tgt $HASP426 ...` with `hao cmd /r 0,noreq`
- Consoles and devices:
  - `0010 3270 console` is the master console.
  - `0009 3215-C /` is the alternate console. It is required for automation.
  - `0015 1403 mvslog.txt` is the hardcopy log.
  - `0400.32 3270` are the TSO terminals.
  - Other settings: CPUMODEL 0148, MAINSIZE 16, NUMCPU 2, CODEPAGE 819/1047.
- IEASYS00 has CVIO and no CLPA (PLPA is warm-started). COMMND00 starts JES2 (WARM,NOREQ), SETPFKEY, ZTIMER and NET.
- Users: IBMUSER/SYS1, MVSCE01/CUL8TR (admin), MVSCE02/PASS4U.
- The repo has no LICENSE file. Ask the maintainer before public hosting, and check the add-on licenses (Wally ISPF in particular).

### 2.3 TK5 (Rob Prins), Update 5
- Page: https://web.archive.org/web/20260614003925/https://www.prince-webdesign.nl/index.php/software/mvs-3-8j-turnkey-5. Full zip: 474,708,515 bytes.
- Bundles SDL Hyperion 4.9.1. The logs show 4.6.0.10941-SDL.
- 15 core volumes, 272.3 MB compressed (Update 4 tree: https://github.com/patrickraths/MVS-TK5/tree/main/mvs-tk5/dasd):
  - TK5RES 0390 (43.4 MB, IPL)
  - TK5CAT 0391 (10.4 MB)
  - TK5DLB 0392 (30.5 MB)
  - TK5001 0298 (90.4 MB)
  - TK5002 0299 (74.7 MB)
  - TSO001-003 0190-0192
  - PAGE00 0248, SPOOL0 0249
  - WORK01-04 0290-0293
  - INT001 0380 (8.6 MB)
- Likely minimum: TK5RES, TK5CAT, TK5001, TK5002, TSO001-003, PAGE00 and SPOOL0. That is about 228 MB.
- IPL: `ipl 390`. HAO answers IEA101A/IEA305A. IEASYS00 has CLPA. Console is `0009 3215-C`. Other settings: CPUMODEL 3084, NUMCPU 2, TIMERINT 10000.
- Native IPL time measured from the log: about 96 s.
- No explicit license. Intercomm (INT001), a formerly commercial product, is the largest risk.

### 2.4 TK4- (Update 08, 2016)
- Archived download (238,899,125 bytes): https://web.archive.org/web/20221216124017/https://wotho.ethz.ch/tk4-/tk4-_v1.00_current.zip
- The manual (Appendix A) places TK4- in the public domain, as far as no third-party copyrights are affected.
- 28 volumes, about 211.6 MB. IPL is `ipl 148`. The bundled Hercules logs "version 4.00".
- Not recommended.

### 2.5 Browser-specific changes to the image (with sysgen.py)
- Add CLPA to IEASYS00.
- Set NUMCPU 1.
- Remove the 0010 console, or connect it to an in-page widget before IPL. Unused consoles can make MVS run out of WTO buffers.
- Drop SYSCPK, SMP000, WORK and SORTW. Remove `SYSC.LINKLIB SYSCPK` from IEAAPF00, and update VATLST00 to match.
- Compact the volumes with `cckdcomp`, or copy them with `dasdcopy`.
- Format PAGE00 again as a near-empty volume (CLPA makes its contents disposable).
- Cold-start JES2 with format, then shut down cleanly, to get a near-empty SPOOL1.
- Optional: start ISPF at logon.

---

## 3. Track: browser I/O (3270 bridge)

### 3.1 Recommendation
- Build an in-process TN3270 loopback in C. Keep libtelnet and the console.c logic. Add a small `wasmsock.c`.
- Under `__EMSCRIPTEN__`, about 20 lines of `#define`s in console.c map `socket/bind/listen/accept/recv/send/getpeername/pselect/close_socket/socket_set_blocking_mode` to `vsock_*` functions.
- Each connection gets two SPSC byte rings in a SharedArrayBuffer (JS to C, and C to JS).
- `vsock_pselect` waits on one futex "doorbell" word with `emscripten_futex_wait`. These events ring the doorbell:
  - JS input
  - new JS connections
  - `SIGNAL_CONSOLE_THREAD`
- Pseudo-fds start at 900, which is below FD_SETSIZE.
- Exports:
  - `hw_term_open(const char* ttype)` returns a connection id. Example ttype: `"IBM-3279-2-E@0010"`.
  - `hw_term_input(id, ptr, len)`
  - `hw_term_close(id)`
  - The main thread drains the output on `requestAnimationFrame`.
- Add a con1052c.c hook next to `LOGMSG`, so that 3215-C lines reach the page. Add an internal-only `hw_panel_command()`.
- Do not use Emscripten SOCKFS, WebSocket emulation or `PROXY_POSIX_SOCKETS`. Do not use a JS SOCKFS override: it depends on SOCKFS internals, proxies every call to the main thread, and does not work under WasmFS.

### 3.2 console.c facts (https://github.com/SDL-Hercules-390/hyperion/blob/master/console.c, 4767 lines)
- `console_connection_handler()` (3385) calls `get_listening_socket()` (3302), then loops on `pselect()` (about line 3580) over the listen fd, the client fds and `sysblk.cnslrpipe`. It then calls `accept()` and starts `connect_client()` (2859).
- Output path: `telnet_ev_handler()` `TELNET_EV_SEND` calls `write_socket` (312). `sendto_client()` is at 641.
- Input path: `recv_3270_data()` (2587) calls `telnet_recv()`, then `loc3270_input()` (2443). `solicit_3270_data()` (2692) is a blocking loop, so the shim must support blocking recv.
- `negotiate_ttype()` (2330) handles plain TN3270 only (TTYPE, BINARY, EOR). There is no TN3270E. Terminal types are in `tttab[]` (2250). A `@devnum` or `@group` suffix selects the device (2336).
- `HERCLOGO` replaces the connect logo.
- 3215-C (con1052c.c): output goes to `LOGMSG`. Input goes through `con1052_panel_command()` with the command prefix.
- Hercules is under QPL 1.0 (https://sdl-hercules-390.github.io/html/herclic.html). The QPL requires that you distribute changes as patches, and it is GPL-incompatible.

### 3.3 Bridge options that were rejected
- (a) SOCKFS/WebSocket emulation: in the browser, `listen` throws EOPNOTSUPP. `PROXY_POSIX_SOCKETS` needs a native proxy, and select, poll and close are not proxied (https://github.com/emscripten-core/emscripten/blob/main/site/source/docs/porting/networking.rst). WasmFS returns ENOSYS for all socket syscalls (`system/lib/wasmfs/syscalls.cpp`).
- (b) A JS loopback override of SOCKFS (`createPeer`, `pending`, `emit('connection')`): this is fragile (#27226 changed the poll signature), every call is proxied synchronously to the main thread, and it does not work with WasmFS.
- (c2) Remove libtelnet and pass raw 3270 records. This needs a custom terminal and you lose TN3270 tooling. The Hercules-internals track preferred this option (`web3270_connect` / `web3270_input`). It stays as a fallback.

### 3.4 Terminal libraries
| Project | License | Verdict |
|---|---|---|
| athornton/tn3270 https://github.com/athornton/tn3270 | MIT | Primary choice. TS `packages/core` (session.ts, telnet.ts, screen.ts, codepage cp037) and `packages/canvas`. `Session` takes an injected `Connection {write, close, onData, onClose, onError}` (session.ts:32-38). Tested with TK5 on Hercules. Young project. |
| pmattes/x3270 (b3270) https://github.com/pmattes/x3270 | BSD-3 | Fallback: compile to WASM |
| bencz/IronTerm | GPL-3.0 | Reference only |
| zowe/tn3270-ng2 | EPL-2.0 | Avoid (720 KB minified blob, proxy-based) |
| gurungabit/tnz3270-node | MIT | Use for automated tests |
| wren-creator/web3270, moshix/web3270, 3270io | GPL or no license | Not suitable |
| rbanffy/3270font https://github.com/rbanffy/3270font | BSD-3 | Font |

### 3.5 Page flow and keyboard
- Page flow:
  1. Loading screen.
  2. A 3215-C "console printer" pane shows the NIP messages.
  3. Connect the master console 010 before IPL (an unconnected 3270 gives intervention-required).
  4. When `IKT007I TCAS ACCEPTING LOGONS` appears, open a TSO tab with `hw_term_open("IBM-3278-2")`.
- Each tab uses one 3270 device. The Hercules log is hidden unless the URL has `?debug=1`.
- Keys:
  - Enter = Enter. Esc = Clear.
  - F1-F12 = PF1-12. Shift+F1-F12 = PF13-24.
  - Ctrl+1/2/3 = PA1/2/3. PA1 is TSO attention.
  - Ctrl+R = Reset. End = Erase EOF. Ctrl+End = Erase Input.
  - Fullscreen uses the Keyboard Lock API.
  - The page also has an on-screen AID keypad and a hidden textarea for mobile keyboards.

### 3.6 How other emulators deliver disks
- v86 (https://github.com/copy/v86/blob/master/src/buffer.js): `AsyncXHRBuffer` uses Range requests. `AsyncXHRPartfileBuffer` uses pre-split chunks, optionally `.zst`. The cache is in memory only.
- CheerpX (https://cheerpx.io/docs/guides/File-System-support): `HttpBytesDevice`, `IDBDevice` and `OverlayDevice`. This is the model to copy.
- CCKD suits lazy loading: CCKD_DEVHDR, then an L1 table (U32 per 256 tracks), then L2 entries `{U32 trkoff; U16 len; U16 size}` (cckd.h:154), then compressed track images. Writes go to `sf=` shadow files (up to `CCKD_MAX_SF` 8).
- It is not confirmed which emulator the levelsio Windows XP demo uses.

---

## 4. Track: Emscripten runtime

### 4.1 Recommendation
- Build a static wasm32 binary with `-pthread -sPROXY_TO_PTHREAD`, a pool of about 24 workers, a fixed heap of about 768 MB with no growth, and `-O3 -flto`.
- `-sSUPPORT_LONGJMP=wasm` on every object and at link time is the most important flag.
- Do not use Asyncify or JSPI.
- Storage: WasmFS, with a fetch backend (64-256 KB chunks) for the base volumes and memory or OPFS for the shadow files. Do not use `FS.createLazyFile`.
- Patches:
  - `host_tod` uses `CLOCK_MONOTONIC`.
  - The logger uses a condvar ring.
  - console.c uses the SAB transport.
  - Disable the PCLMUL probe.
  - `TIMERINT` about 1000.

### 4.2 Details
- emsdk 6.0.13 (https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md):
  - JSPI is stable (6.0.8). `WASM_BIGINT` is always on.
  - Use `-pthread` (not `-sUSE_PTHREADS`).
  - `GROWABLE_ARRAYBUFFERS` defaults to 0.
  - `MIN_SAFARI_VERSION` 15.0, so bulk-memory is always on.
- Threads (https://github.com/emscripten-core/emscripten/blob/main/site/source/docs/porting/pthreads.rst):
  - Use `-sPROXY_TO_PTHREAD`. Hercules creates a thread and then waits on a cond (cpu.c:2036). That deadlocks on the main thread.
  - `-sALLOW_BLOCKING_ON_MAIN_THREAD=0`
  - `-sPTHREAD_POOL_SIZE=24 -sPTHREAD_POOL_SIZE_STRICT=0`
  - `-sSTACK_SIZE=2MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB`
  - Firefox has a per-domain worker cap (`dom.workers.maxPerDomain`). Test the real number.
  - Do not use `-sWASM_WORKERS`.
  - `-sMALLOC=mimalloc` is optional.
- Memory:
  - Avoid growth with pthreads.
  - Stay on wasm32 (Memory64: Chrome 133, Firefox 134, Safari preview only).
  - Stay at about 1 GB or less for iOS.
- Filesystem:
  - The legacy FS proxies every syscall to the main thread (`libcore.js` `wrapSyscallFunction`, `__proxy:'sync'`).
  - `createLazyFile` needs a Worker context, uses 1 MiB chunks, and copies byte by byte.
  - WasmFS fetch backend: `wasmfs_create_fetch_backend(base_url, chunk_size)` (`wasmfs.h`). Do not call it on the main thread. It needs `Content-Length` and `Accept-Ranges`. The default chunk is 16 MiB. It is read-only and does not evict (`libwasmfs_fetch.js`).
  - OPFS backend: `wasmfs_create_opfs_backend()`.
  - WasmFS pipes return 0 when empty (`pipe_backend.h`).
  - Fallback: `wasmfs_create_jsimpl_backend`, or a Hercules-level I/O shim that talks to an I/O worker through a futex.
- setjmp/longjmp:
  - `RETURN_INTCHECK` = `longjmp(progjmp, SIE_NO_INTERCEPT)` (opcode.h:636) has 29 call sites, including SVC (general2.c ~1750) and LPSW. So longjmp is on a hot path.
  - JS SjLj sends every call in `run_cpu` through `invoke_*` (`WebAssemblyLowerEmscriptenEHSjLj.cpp`).
  - Use `-sSUPPORT_LONGJMP=wasm` (https://github.com/emscripten-core/emscripten/blob/main/site/source/docs/porting/setjmp-longjmp.rst).
  - Legacy EH (Chrome 95, Firefox 100, Safari 15.2) is the default. exnref (`-sWASM_LEGACY_EXCEPTIONS=0`) needs Chrome 137, Firefox 131, Safari 18.4.
  - If throws turn out to be costly, change `RETURN_INTCHECK` to set a flag that ends the loop (`MAX_CPU_LOOPS` 256, hconsts.h:36).
  - Asyncify cannot unwind from catch (`Asyncify.cpp:99-103`).
- Clocks:
  - `CLOCK_REALTIME` is `Date.now()` (1 ms). Other clocks use `performance.timeOrigin + performance.now()` (`libcore.js:1495`).
  - `host_tod` uses CLOCK_REALTIME (clock.c:577).
  - `usleep` becomes `emscripten_thread_sleep`.
- Performance:
  - Native Hercules does 300+ MIPS (https://sdl-hercules-390.github.io/html/hercfaq.html).
  - Wasm is 45-55% slower on SPEC (Jangda et al., https://www.usenix.org/conference/atc19/presentation/jangda).
  - Estimate: 20-80 MIPS for one S/370 CPU. MVS needs a few MIPS, so DASD latency will decide the IPL time.
  - Wasm has no bswap, so `fetch_fw`/`store_fw` cost more.
  - `SIZEOF_LONG` 4 selects the 32-bit host paths (vstore.h:185).
- Prior art:
  - ktock/qemu-wasm (https://github.com/ktock/qemu-wasm): Asyncify + PROXY_TO_PTHREAD, disks preloaded.
  - container2wasm (Bochs, wasi-sdk, asyncify setjmp, wizer).
  - v86.
  - Infinite Mac (https://blog.persistent.info/2022/03/blog-post.html): 256 KB content-addressed chunks, service worker, about 3 s cold boot.

### 4.3 Starting flag set
```
CFLAGS:  -O3 -flto -pthread -sSUPPORT_LONGJMP=wasm -D_GNU_SOURCE
LDFLAGS: -O3 -flto -pthread -sSUPPORT_LONGJMP=wasm -sPROXY_TO_PTHREAD \
  -sPTHREAD_POOL_SIZE=24 -sPTHREAD_POOL_SIZE_STRICT=0 -sALLOW_BLOCKING_ON_MAIN_THREAD=0 \
  -sINITIAL_MEMORY=768MB -sSTACK_SIZE=2MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
  -sWASMFS -sFORCE_FILESYSTEM -sUSE_ZLIB=1 -sUSE_BZIP2=1 \
  -sENVIRONMENT=web,worker -sMODULARIZE -sEXPORT_ES6 -sEXIT_RUNTIME=0
debug: -O1 -g -sASSERTIONS=2 -sEXCEPTION_STACK_TRACES
```

---

## 5. Track: hosting

### 5.1 Recommendation
- Host the static bundle on GitHub Pages (coi-serviceworker provides cross-origin isolation) or Cloudflare Pages
  (`_headers` sets COOP same-origin, COEP require-corp, CORP same-origin). See docs/DEPLOY.md.
- Serve DASD as uncompressed, content-hashed, immutable chunks under `dasd/*`.
- Cross-origin isolation: https://web.dev/articles/coop-coep. `credentialless` is not supported in Safari, so use `require-corp` and keep everything same-origin.
- coi-serviceworker (https://github.com/gzuidhof/coi-serviceworker): fallback for hosts that cannot set headers; it reloads the page on the first visit.
