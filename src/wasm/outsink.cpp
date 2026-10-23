// SPDX-License-Identifier: Apache-2.0
// OUTSINK.CPP  Bounded output files for the browser build
//
//   Linked into Hercules (QPL 1.0); distributed as a separate file. Hercules itself is not changed: this is a
//   WasmFS backend for the directories of the unit-record OUTPUT devices (web.cnf: printers/ = 000E 1403 and
//   000F 3211 for JES2, 0015 1403 = hardcopy log; punchcards/ = 000D and 001D 3525).
//
//   Why (found in long soak tests): in the default WasmFS memory backend a file
//   is a std::vector in the fixed 112 MiB wasm heap. JES2 printer output is never read in the browser, but it
//   stays in the heap for the life of the page, and the vector doubles its capacity: after about 16 MiB of
//   print (701 jobs of 228 lines) the next growth needs one 32 MiB block while the old 16 MiB block still
//   exists, and Hercules aborts (Aborted(OOM)). The same holds for the hardcopy log and the punches, only
//   slower. With this backend an output file keeps only its logical size and the LAST `ring` bytes (a ring
//   buffer allocated once, at the first write); older bytes are dropped. So the heap that output can use is
//   bounded: ring x number of files (default 64 KiB x 5).
//
//   File semantics (enough for printer.c / cardpch.c: open O_CREAT [O_TRUNC], lseek SEEK_END, ftruncate,
//   write at the end): getSize = logical size (all bytes written); write(buf, len, off) keeps the bytes that
//   fall into the last `ring` positions of the file; read returns those bytes if they are still in the ring,
//   else zeros; setSize sets the logical size (bytes past a smaller size are forgotten).
//
//   Exports: hw_outsink_mount(dir, ringBytes) (wasm_main --outsink=, before the loader makes its dirs) and, for
//   the page (lock-free reads), hw_outsink_statd(i): 0 bytes written, 1 files created, 2 heap bytes in rings,
//   3 dirs mounted, 4 largest logical file size.

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>
#include <sys/stat.h>
#include <emscripten.h>

#include "backend.h"
#include "file.h"
#include "memory_backend.h"
#include "wasmfs.h"

using namespace wasmfs;

// From <emscripten/wasmfs.h> (not included, see lazydasd.cpp: its C backend_t typedef clashes with wasmfs::Backend).
extern "C" int wasmfs_create_directory(char* path, mode_t mode, wasmfs::Backend* backend);

namespace {

enum { O_BYTES, O_FILES, O_RING_HEAP, O_DIRS, O_MAX_SIZE, O_COUNT };
std::atomic<double> ost[O_COUNT];
void oadd(int i, double v) { double c = ost[i].load(std::memory_order_relaxed); while (!ost[i].compare_exchange_weak(c, c + v)) {} }
void omax(int i, double v) { double c = ost[i].load(std::memory_order_relaxed); while (v > c && !ost[i].compare_exchange_weak(c, v)) {} }

// Called by WasmFS with the file locked (DataFile::Handle), so one file is never used by two threads at once.
class SinkFile : public DataFile {
  size_t cap;                      // ring capacity in bytes (0 = keep nothing)
  std::vector<uint8_t> ring;       // allocated at the first write: ring[pos % cap] = byte at file position pos
  uint64_t size = 0;               // logical file size

  int open(oflags_t) override { return 0; }
  int close() override { return 0; }
  int flush() override { return 0; }
  off_t getSize() override { return (off_t) size; }
  int setSize(off_t s) override {
    if (s < 0) return -EINVAL;
    if ((uint64_t) s > size && !ring.empty()) {         // growing: the new bytes read as zeros
      for (uint64_t p = std::max<uint64_t>(size, (uint64_t) s > cap ? (uint64_t) s - cap : 0); p < (uint64_t) s; p++) ring[p % cap] = 0;
    }
    size = (uint64_t) s;
    return 0;
  }
  ssize_t write(const uint8_t* buf, size_t len, off_t offset) override {
    if (offset < 0) return -EINVAL;
    uint64_t off = (uint64_t) offset, end = off + len;
    if (cap) {
      if (ring.empty()) { ring.assign(cap, 0); oadd(O_RING_HEAP, (double) cap); }
      uint64_t from = end > cap ? std::max<uint64_t>(off, end - cap) : off;   // only the last cap bytes matter
      for (uint64_t p = from; p < end;) {
        size_t at = (size_t) (p % cap), n = (size_t) std::min<uint64_t>(end - p, cap - at);
        memcpy(&ring[at], buf + (p - off), n);
        p += n;
      }
    }
    if (end > size) size = end;
    oadd(O_BYTES, (double) len);
    omax(O_MAX_SIZE, (double) size);
    return (ssize_t) len;
  }
  ssize_t read(uint8_t* buf, size_t len, off_t offset) override {
    if (offset < 0) return -EINVAL;
    uint64_t off = (uint64_t) offset;
    if (off >= size) return 0;
    if (off + len > size) len = (size_t) (size - off);
    uint64_t keep = (cap && !ring.empty()) ? (size > cap ? size - cap : 0) : size;   // first position still kept
    for (size_t i = 0; i < len; i++) {
      uint64_t p = off + i;
      buf[i] = (p >= keep && !ring.empty()) ? ring[p % cap] : 0;
    }
    return (ssize_t) len;
  }
public:
  SinkFile(mode_t mode, backend_t b, size_t ringBytes) : DataFile(mode, b), cap(ringBytes) { oadd(O_FILES, 1); }
  ~SinkFile() override { if (!ring.empty()) oadd(O_RING_HEAP, -(double) cap); }
};

class SinkBackend : public Backend {
  size_t ringBytes;
public:
  explicit SinkBackend(size_t r) : ringBytes(r) {}
  std::shared_ptr<DataFile> createFile(mode_t mode) override { return std::make_shared<SinkFile>(mode, this, ringBytes); }
  std::shared_ptr<Directory> createDirectory(mode_t mode) override { return std::make_shared<MemoryDirectory>(mode, this); }
  std::shared_ptr<Symlink> createSymlink(std::string target) override { return std::make_shared<MemorySymlink>(target, this); }
};

} // namespace

extern "C" {

// Make `dir` (relative to the cwd or absolute; it must not exist yet) a directory whose files keep only their
// last ringBytes bytes. 0 or -errno. Call before anything creates files in it (wasm_main, before the loader).
EMSCRIPTEN_KEEPALIVE int hw_outsink_mount(const char* dir, double ringBytes) {
  struct stat st;
  if (stat(dir, &st) == 0) return -EEXIST;
  wasmfs::Backend* b = wasmFS.addBackend(std::make_unique<SinkBackend>((size_t) std::max(0.0, ringBytes)));
  std::string p(dir);
  int rc = wasmfs_create_directory(p.data(), 0777, b);
  if (rc == 0) oadd(O_DIRS, 1);
  return rc;
}

EMSCRIPTEN_KEEPALIVE double hw_outsink_statd(int i) {
  return (i >= 0 && i < O_COUNT) ? ost[i].load(std::memory_order_relaxed) : 0;
}

} // extern "C"
