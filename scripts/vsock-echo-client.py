#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Echo client for vsock_echo_main.c behind scripts/node-harness.mjs (or the native bridge).
Usage: vsock-echo-client.py [port] [clients] [bytes] [--quit]
Each client sends random bytes in random-size chunks and checks that every byte comes back +1."""
import os, random, socket, sys, threading, time
port = int(sys.argv[1]) if len(sys.argv) > 1 else 3372
ncli = int(sys.argv[2]) if len(sys.argv) > 2 else 4
nbytes = int(sys.argv[3]) if len(sys.argv) > 3 else 1 << 20
results = []
def client(i):
    rnd = random.Random(i)
    data = os.urandom(nbytes)
    want = bytes((b + 1) & 255 for b in data)
    s = socket.create_connection(("127.0.0.1", port))
    got = bytearray()
    def reader():
        while len(got) < nbytes:
            d = s.recv(65536)
            if not d: break
            got.extend(d)
    t = threading.Thread(target=reader); t.start()
    off = 0
    while off < nbytes:
        n = rnd.randint(1, 9000)
        s.sendall(data[off:off + n]); off += n
    t.join(60)
    s.close()
    results.append((i, len(got), bytes(got) == want))
t0 = time.time()
ts = [threading.Thread(target=client, args=(i,)) for i in range(ncli)]
[t.start() for t in ts]; [t.join() for t in ts]
dt = time.time() - t0
ok = all(r[2] for r in results) and len(results) == ncli
for r in sorted(results): print(f"client {r[0]}: {r[1]} bytes back, match={r[2]}")
print(f"{'PASS' if ok else 'FAIL'}: {ncli} clients x {nbytes} bytes, {dt:.2f} s, {2*ncli*nbytes/dt/1e6:.1f} MB/s both ways")
if "--quit" in sys.argv:
    s = socket.create_connection(("127.0.0.1", port)); s.sendall(b"QUIT\n"); time.sleep(0.5); s.close()
sys.exit(0 if ok else 1)
