// SPDX-License-Identifier: Apache-2.0
// LAZYDASD.CPP  Lazy, chunked, read-only CCKD base volumes for the browser build
//
//   Linked into Hercules (QPL 1.0); distributed as a separate file. Hercules itself is not
//   changed: this is a WasmFS backend. Each base volume (for example /mvs/DASD/mvsres.3350) is a
//   read-only WasmFS file of the original size. Its bytes come from:
//     - the metadata blob (both headers, the L1 table and every L2 table), loaded before impl();
//     - content-addressed track chunks (scripts/dasd-chunk.py, manifest format 2): a chunk holds
//       the compressed track images of a run of consecutive tracks. A read of a track image is
//       mapped to (chunk, offset). If the chunk is not in the in-heap LRU, the reading Hercules
//       thread queues it, wakes the DASD I/O worker (library_lazydasd.js, the loader pthread:
//       Cache Storage, else fetch()) and waits on a futex (the chunk state word) until it is
//       there. The browser main thread never waits and never copies DASD bytes.
//   Bytes that are in no extent (free space in the CCKD file) read as zeros (counted: gapBytes).
//   Writes are refused (EACCES at open for O_RDWR/O_WRONLY, EROFS on write): CCKD opens the base
//   read-only and writes to the sf= shadow files, which live on another backend/mount (/mvs/shadow).
//
//   Exports for the I/O worker (JS, a pthread): hw_lazy_init, hw_lazy_vol_add, hw_lazy_boot,
//   hw_lazy_mount, hw_lazy_next_demand, hw_lazy_claim, hw_lazy_fill_begin, hw_lazy_fill_end,
//   hw_lazy_fail, hw_lazy_waiting. For the page (main thread, lock-free reads only): hw_lazy_statd,
//   hw_lazy_trace_buf, hw_lazy_trace_len, hw_lazy_vol_count, hw_lazy_vol_devnum.

#include <atomic>
#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>
#include <fcntl.h>
#include <pthread.h>
#include <sys/stat.h>
#include <unistd.h>
#include <emscripten.h>
#include <emscripten/threading.h>

#include "backend.h"
#include "file.h"
#include "memory_backend.h"
#include "wasmfs.h"

using namespace wasmfs;

// From the public <emscripten/wasmfs.h> (not included: its C typedef `struct Backend* backend_t` clashes
// with wasmfs::Backend in the internal headers; the WasmFS sources do the same).
extern "C" int wasmfs_create_file(const char* pathname, mode_t mode, wasmfs::Backend* backend);

namespace {

enum : uint32_t { C_ABSENT = 0, C_QUEUED = 1, C_FETCHING = 2, C_READY = 3, C_ERROR = 4 };

struct Chunk {
  std::atomic<uint32_t> state{C_ABSENT};   // futex word
  uint32_t size = 0;
  uint8_t* buf = nullptr;
  uint64_t lru = 0;
  double   treq = 0;                       // time of the first demand request (ms)
  uint8_t  boot = 0, loadedOnce = 0, fails = 0, demanded = 0;
  std::atomic<uint32_t> waiting{0};        // 1 = a Hercules thread waits for this chunk (read by the I/O worker)
};

struct Extent {                            // a byte range of the volume file
  uint32_t pos, len;
  int32_t  chunk;                          // -1 = metadata blob
  uint32_t off;                            // offset in the metadata blob or in the chunk
  uint32_t trk;
};

struct Volume {
  std::string name;
  uint32_t devnum = 0;
  uint64_t size = 0;
  std::vector<uint8_t> meta;
  std::vector<Extent> ext;                 // sorted by pos
  std::vector<uint8_t> seen;               // per track: read at least once (trace)
  uint32_t index = 0;
};

pthread_mutex_t mtx = PTHREAD_MUTEX_INITIALIZER;
std::vector<Chunk>* chunks = nullptr;
std::vector<Volume*> vols;
std::vector<uint32_t> ring;                // demand queue (chunk ids), protected by mtx
size_t ring_head = 0, ring_tail = 0;
uint64_t lru_clock = 0, lru_used = 0, lru_budget = 24u << 20;
char chan_name[128];

// statistics (doubles: written under mtx or by one writer, read lock-free by the page)
enum {
  S_BOOT_TOTAL, S_BOOT_LOADED, S_NET_BYTES, S_CACHE_BYTES, S_NET_REQ, S_CACHE_REQ,
  S_DEMAND_WAITS, S_WAIT_MS, S_LRU_USED, S_LRU_PEAK, S_EVICTIONS, S_GAP_BYTES, S_ERRORS,
  S_CHUNKS_LOADED, S_BOOT_CHUNKS, S_BOOT_CHUNKS_LOADED, S_MAX_WAIT_MS, S_READS, S_PREFETCH_DONE,
  S_META_BYTES, S_DEMAND_NONBOOT, S_TRACKS_READ, S_REFETCH, S_LRU_BUDGET, S_PREFETCH_DONE_MS,
  S_FIRST_WAIT_MS, S_COUNT
};
std::atomic<double> st[S_COUNT];
std::atomic<uint64_t> reads_count{0}, gap_bytes{0};
void sadd(int i, double v) { st[i].store(st[i].load(std::memory_order_relaxed) + v, std::memory_order_relaxed); }

constexpr uint32_t TRACE_MAX = 32768;
uint32_t trace_buf[TRACE_MAX];
std::atomic<uint32_t> trace_len{0};

EM_JS(void, lazy_js_wake, (const char* name), {
  // Runs in the calling Hercules thread (a worker). BroadcastChannel reaches the DASD I/O worker
  // without the browser main thread (no relay through it); the I/O worker also polls as a fallback.
  if (!globalThis.__mvsLazyBC) globalThis.__mvsLazyBC = new BroadcastChannel(UTF8ToString(name));
  globalThis.__mvsLazyBC.postMessage(1);
});

uint32_t rd32(const uint8_t* p, bool be) {
  return be ? (uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3])
            : (uint32_t(p[3]) << 24 | uint32_t(p[2]) << 16 | uint32_t(p[1]) << 8 | p[0]);
}
uint16_t rd16(const uint8_t* p, bool be) { return be ? uint16_t(p[0] << 8 | p[1]) : uint16_t(p[1] << 8 | p[0]); }

// Evict least recently used READY chunks until `need` more bytes fit. Called with mtx held.
void make_room(uint64_t need) {
  while (lru_used + need > lru_budget) {
    Chunk* victim = nullptr;
    for (auto& c : *chunks)
      if (c.state.load() == C_READY && c.buf && (!victim || c.lru < victim->lru)) victim = &c;
    if (!victim) return;                   // nothing evictable: go over the budget
    free(victim->buf); victim->buf = nullptr;
    lru_used -= victim->size;
    victim->state.store(C_ABSENT);
    sadd(S_EVICTIONS, 1);
  }
}

// Make chunk ci READY, then copy n bytes at off into dst. Hercules thread (may wait).
int chunk_copy(uint32_t ci, uint32_t off, uint8_t* dst, uint32_t n) {
  Chunk& c = (*chunks)[ci];
  double t0 = 0;
  bool waited = false;
  pthread_mutex_lock(&mtx);
  for (;;) {
    uint32_t s = c.state.load();
    if (s == C_READY) {
      c.lru = ++lru_clock;
      memcpy(dst, c.buf + off, n);
      pthread_mutex_unlock(&mtx);
      if (waited) {
        double w = emscripten_get_now() - t0;
        pthread_mutex_lock(&mtx);
        sadd(S_WAIT_MS, w);
        if (w > st[S_MAX_WAIT_MS].load()) st[S_MAX_WAIT_MS].store(w);
        pthread_mutex_unlock(&mtx);
      }
      return 0;
    }
    bool wake = false;
    if (s == C_ABSENT || s == C_ERROR) {
      if (s == C_ERROR && c.fails >= 3) { pthread_mutex_unlock(&mtx); return -EIO; }
      if (c.loadedOnce) sadd(S_REFETCH, 1);
      c.state.store(C_QUEUED);
      s = C_QUEUED;
      ring[ring_tail % ring.size()] = ci; ring_tail++;
      if (!c.demanded) { c.demanded = 1; if (!c.boot) sadd(S_DEMAND_NONBOOT, 1); }
      wake = true;
    }
    if (!waited) {
      waited = true; t0 = emscripten_get_now();
      sadd(S_DEMAND_WAITS, 1);
      if (st[S_FIRST_WAIT_MS].load() == 0) st[S_FIRST_WAIT_MS].store(t0);
    }
    c.waiting.store(1);
    pthread_mutex_unlock(&mtx);
    if (wake) lazy_js_wake(chan_name);
    // Wait until the state word changes (READY or ERROR); re-ring the bell every second.
    if (emscripten_futex_wait((volatile void*) &c.state, s, 1000.0) == -ETIMEDOUT) lazy_js_wake(chan_name);
    pthread_mutex_lock(&mtx);
  }
}

class LazyFile : public DataFile {
  Volume* v;
  int open(oflags_t) override { return 0; }   // WasmFS refuses O_RDWR/O_WRONLY (mode 0444)
  int close() override { return 0; }
  int flush() override { return 0; }
  off_t getSize() override { return (off_t) v->size; }
  int setSize(off_t) override { return -EROFS; }
  ssize_t write(const uint8_t*, size_t, off_t) override { return -EROFS; }
  ssize_t read(uint8_t* buf, size_t len, off_t offset) override {
    if (offset < 0) return -EINVAL;
    if ((uint64_t) offset >= v->size) return 0;
    if ((uint64_t) offset + len > v->size) len = (size_t) (v->size - (uint64_t) offset);
    reads_count.fetch_add(1, std::memory_order_relaxed);
    uint64_t pos = (uint64_t) offset, end = pos + len;
    auto& ex = v->ext;
    while (pos < end) {
      // last extent with e.pos <= pos
      auto it = std::upper_bound(ex.begin(), ex.end(), pos, [](uint64_t p, const Extent& e) { return p < e.pos; });
      const Extent* e = (it == ex.begin()) ? nullptr : &*(it - 1);
      if (!e || pos >= (uint64_t) e->pos + e->len) {          // gap: zeros up to the next extent
        uint64_t nxt = (it == ex.end()) ? end : std::min<uint64_t>(end, it->pos);
        memset(buf + (pos - offset), 0, nxt - pos);
        gap_bytes.fetch_add(nxt - pos, std::memory_order_relaxed);
        pos = nxt;
        continue;
      }
      uint32_t in = (uint32_t) (pos - e->pos);
      uint32_t n = (uint32_t) std::min<uint64_t>(end - pos, e->len - in);
      if (e->chunk < 0) memcpy(buf + (pos - offset), v->meta.data() + e->off + in, n);
      else {
        int rc = chunk_copy((uint32_t) e->chunk, e->off + in, buf + (pos - offset), n);
        if (rc < 0) return pos > (uint64_t) offset ? (ssize_t) (pos - offset) : rc;
        if (!v->seen[e->trk]) {               // first read of this track: trace (boot manifest)
          pthread_mutex_lock(&mtx);
          if (!v->seen[e->trk]) {
            v->seen[e->trk] = 1;
            sadd(S_TRACKS_READ, 1);
            uint32_t k = trace_len.load();
            if (k < TRACE_MAX) {
              trace_buf[k] = (v->index << 24) | (e->trk & 0xFFFFFF);
              trace_len.store(k + 1, std::memory_order_release);
            }
          }
          pthread_mutex_unlock(&mtx);
        }
      }
      pos += n;
    }
    return (ssize_t) len;
  }
public:
  LazyFile(mode_t mode, backend_t b, Volume* vol) : DataFile(mode, b), v(vol) {}
};

class LazyBackend : public Backend {
  Volume* v;
public:
  explicit LazyBackend(Volume* vol) : v(vol) {}
  std::shared_ptr<DataFile> createFile(mode_t mode) override { return std::make_shared<LazyFile>(mode, this, v); }
  std::shared_ptr<Directory> createDirectory(mode_t mode) override { return std::make_shared<MemoryDirectory>(mode, this); }
  std::shared_ptr<Symlink> createSymlink(std::string target) override { return std::make_shared<MemorySymlink>(target, this); }
};

int mkdirs(const char* path) {
  std::string p(path);
  for (size_t i = 1; i <= p.size(); i++)
    if (i == p.size() || p[i] == '/') {
      std::string d = p.substr(0, i);
      if (mkdir(d.c_str(), 0777) != 0 && errno != EEXIST) return -errno;
    }
  return 0;
}

} // namespace

extern "C" {

// I/O worker: set up the chunk table. sizes[nchunks]. Returns 0.
EMSCRIPTEN_KEEPALIVE int hw_lazy_init(int nchunks, const uint32_t* sizes, double budget, const char* chan) {
  pthread_mutex_lock(&mtx);
  chunks = new std::vector<Chunk>(nchunks);
  for (int i = 0; i < nchunks; i++) (*chunks)[i].size = sizes[i];
  ring.assign(nchunks + 1, 0);
  if (budget > 0) lru_budget = (uint64_t) budget;
  st[S_LRU_BUDGET].store((double) lru_budget);
  snprintf(chan_name, sizeof(chan_name), "%s", chan);
  pthread_mutex_unlock(&mtx);
  return 0;
}

// I/O worker: add one volume. meta = header + L1 + L2 tables (dasd-chunk.py), runs = nruns x
// (firstTrack, endTrack, chunkId). Returns the volume index, or a negative error:
// -1 bad header, -2 run/chunk size mismatch, -3 overlapping extents, -4 track not in a run.
EMSCRIPTEN_KEEPALIVE int hw_lazy_vol_add(const char* name, int devnum, double size, const uint8_t* meta,
                                         int metaLen, const uint32_t* runs, int nruns) {
  auto* v = new Volume();
  v->name = name; v->devnum = (uint32_t) devnum; v->size = (uint64_t) size;
  v->meta.assign(meta, meta + metaLen);
  const uint8_t* m = v->meta.data();
  if (metaLen < 1024) return -1;
  bool be = (m[512 + 3] & 0x02) != 0;
  uint32_t numl1 = rd32(m + 516, be);
  uint32_t prefix = 1024 + 4 * numl1;
  if ((uint32_t) metaLen < prefix) return -1;
  v->ext.push_back({0, prefix, -1, 0, 0});
  std::vector<int32_t> l2at(numl1, -1);              // L1 index -> offset of its L2 table in meta
  uint32_t mo = prefix;
  for (uint32_t i = 0; i < numl1; i++) {
    uint32_t p = rd32(m + 1024 + 4 * i, be);
    if (p == 0 || p == 0xFFFFFFFF) continue;
    if (mo + 2048 > (uint32_t) metaLen) return -1;
    l2at[i] = (int32_t) mo;
    v->ext.push_back({p, 2048, -1, mo, 0});
    mo += 2048;
  }
  uint32_t ntracks = numl1 * 256, covered = 0, nonnull = 0;
  for (uint32_t t = 0; t < ntracks; t++) {
    int32_t lo = l2at[t >> 8];
    if (lo < 0) continue;
    const uint8_t* e = m + lo + 8 * (t & 0xFF);
    uint32_t pos = rd32(e, be); uint16_t ln = rd16(e + 4, be);
    if (pos != 0 && pos != 0xFFFFFFFF && ln) nonnull++;
  }
  for (int r = 0; r < nruns; r++) {
    uint32_t a = runs[3 * r], b = runs[3 * r + 1], ci = runs[3 * r + 2];
    if (!chunks || ci >= chunks->size() || b > ntracks) return -2;
    uint32_t off = 0;
    for (uint32_t t = a; t < b; t++) {
      int32_t lo = l2at[t >> 8];
      if (lo < 0) continue;
      const uint8_t* e = m + lo + 8 * (t & 0xFF);
      uint32_t pos = rd32(e, be); uint16_t ln = rd16(e + 4, be);
      if (pos == 0 || pos == 0xFFFFFFFF || !ln) continue;
      v->ext.push_back({pos, ln, (int32_t) ci, off, t});
      off += ln; covered++;
    }
    if (off != (*chunks)[ci].size) return -2;
  }
  if (covered != nonnull) return -4;
  std::sort(v->ext.begin(), v->ext.end(), [](const Extent& x, const Extent& y) { return x.pos < y.pos; });
  for (size_t i = 1; i < v->ext.size(); i++)
    if ((uint64_t) v->ext[i - 1].pos + v->ext[i - 1].len > v->ext[i].pos) return -3;
  v->seen.assign(ntracks, 0);
  pthread_mutex_lock(&mtx);
  v->index = (uint32_t) vols.size();
  vols.push_back(v);
  sadd(S_META_BYTES, metaLen);
  int idx = (int) vols.size() - 1;
  pthread_mutex_unlock(&mtx);
  return idx;
}

// I/O worker: mark the boot chunks (the prefetch list) for the progress numbers.
EMSCRIPTEN_KEEPALIVE void hw_lazy_boot(const uint32_t* ids, int n) {
  pthread_mutex_lock(&mtx);
  double tot = 0, cnt = 0;
  for (int i = 0; i < n; i++)
    if (ids[i] < chunks->size() && !(*chunks)[ids[i]].boot) { (*chunks)[ids[i]].boot = 1; tot += (*chunks)[ids[i]].size; cnt++; }
  st[S_BOOT_TOTAL].store(tot); st[S_BOOT_CHUNKS].store(cnt);
  pthread_mutex_unlock(&mtx);
}

// Create the volume files (mode 0444) in dir, one WasmFS backend per volume. 0 or -errno.
EMSCRIPTEN_KEEPALIVE int hw_lazy_mount(const char* dir) {
  if (int rc = mkdirs(dir)) return rc;
  for (auto* v : vols) {
    wasmfs::Backend* b = wasmFS.addBackend(std::make_unique<LazyBackend>(v));
    std::string path = std::string(dir) + "/" + v->name;
    int fd = wasmfs_create_file(path.c_str(), 0444, b);
    if (fd < 0) return fd;
    close(fd);
  }
  return 0;
}

// I/O worker: next demanded chunk (QUEUED -> FETCHING), or -1.
EMSCRIPTEN_KEEPALIVE int hw_lazy_next_demand(void) {
  int r = -1;
  pthread_mutex_lock(&mtx);
  while (ring_head != ring_tail) {
    uint32_t ci = ring[ring_head % ring.size()]; ring_head++;
    if ((*chunks)[ci].state.load() == C_QUEUED) { (*chunks)[ci].state.store(C_FETCHING); r = (int) ci; break; }
  }
  pthread_mutex_unlock(&mtx);
  return r;
}

// I/O worker: claim a chunk for prefetch (ABSENT -> FETCHING). 1 = claimed.
EMSCRIPTEN_KEEPALIVE int hw_lazy_claim(int ci) {
  int r = 0;
  pthread_mutex_lock(&mtx);
  if (ci >= 0 && (size_t) ci < chunks->size() && (*chunks)[ci].state.load() == C_ABSENT) { (*chunks)[ci].state.store(C_FETCHING); r = 1; }
  pthread_mutex_unlock(&mtx);
  return r;
}

// I/O worker (boot packs): 1 = a Hercules thread waits for chunk ci (it is claimed by a pack stream that
// has not reached it yet: the worker then reads it on its own, as a demand read).
EMSCRIPTEN_KEEPALIVE int hw_lazy_waiting(int ci) {
  return (ci >= 0 && (size_t) ci < chunks->size()) ? (int) (*chunks)[ci].waiting.load() : 0;
}

// I/O worker: buffer for a FETCHING chunk (evicts LRU chunks if needed). 0 = no memory.
EMSCRIPTEN_KEEPALIVE uint8_t* hw_lazy_fill_begin(int ci) {
  pthread_mutex_lock(&mtx);
  Chunk& c = (*chunks)[ci];
  if (!c.buf) {
    make_room(c.size);
    c.buf = (uint8_t*) malloc(c.size ? c.size : 1);
    if (c.buf) { lru_used += c.size; st[S_LRU_USED].store((double) lru_used); if (lru_used > st[S_LRU_PEAK].load()) st[S_LRU_PEAK].store((double) lru_used); }
  }
  uint8_t* p = c.buf;
  pthread_mutex_unlock(&mtx);
  return p;
}

// I/O worker: the chunk bytes are in the buffer. fromCache: 1 = Cache Storage, 0 = network.
EMSCRIPTEN_KEEPALIVE void hw_lazy_fill_end(int ci, int fromCache) {
  pthread_mutex_lock(&mtx);
  Chunk& c = (*chunks)[ci];
  c.lru = ++lru_clock; c.fails = 0; c.waiting.store(0);
  if (fromCache) { sadd(S_CACHE_BYTES, c.size); sadd(S_CACHE_REQ, 1); } else { sadd(S_NET_BYTES, c.size); sadd(S_NET_REQ, 1); }
  if (!c.loadedOnce) {
    c.loadedOnce = 1; sadd(S_CHUNKS_LOADED, 1);
    if (c.boot) { sadd(S_BOOT_LOADED, c.size); sadd(S_BOOT_CHUNKS_LOADED, 1); }
  }
  c.state.store(C_READY);
  pthread_mutex_unlock(&mtx);
  emscripten_futex_wake((volatile void*) &c.state, INT32_MAX);
}

// I/O worker: the chunk could not be loaded (after retries).
EMSCRIPTEN_KEEPALIVE void hw_lazy_fail(int ci) {
  pthread_mutex_lock(&mtx);
  Chunk& c = (*chunks)[ci];
  if (c.buf) { free(c.buf); c.buf = nullptr; lru_used -= c.size; }
  c.fails++; sadd(S_ERRORS, 1);
  c.state.store(C_ERROR);
  pthread_mutex_unlock(&mtx);
  emscripten_futex_wake((volatile void*) &c.state, INT32_MAX);
}

EMSCRIPTEN_KEEPALIVE void hw_lazy_prefetch_done(void) {
  st[S_PREFETCH_DONE_MS].store(emscripten_get_now());
  st[S_PREFETCH_DONE].store(1);
}

// Page (main thread), lock-free.
EMSCRIPTEN_KEEPALIVE double hw_lazy_statd(int i) {
  if (i == S_READS) return (double) reads_count.load(std::memory_order_relaxed);
  if (i == S_GAP_BYTES) return (double) gap_bytes.load(std::memory_order_relaxed);
  return (i >= 0 && i < S_COUNT) ? st[i].load(std::memory_order_relaxed) : 0;
}
EMSCRIPTEN_KEEPALIVE uint32_t* hw_lazy_trace_buf(void) { return trace_buf; }
EMSCRIPTEN_KEEPALIVE uint32_t hw_lazy_trace_len(void) { return trace_len.load(std::memory_order_acquire); }
EMSCRIPTEN_KEEPALIVE int hw_lazy_vol_count(void) { return (int) vols.size(); }
EMSCRIPTEN_KEEPALIVE int hw_lazy_vol_devnum(int i) { return (i >= 0 && (size_t) i < vols.size()) ? (int) vols[i]->devnum : -1; }

} // extern "C"
