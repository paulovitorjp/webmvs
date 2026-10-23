#!/usr/bin/env python3
"""Dev server for web/app. Binds to 127.0.0.1 only.

Static files from --root, plus a small dev API for the NATIVE Hercules backend (?backend=native):
  GET  /dev/status         {"hercules": bool, "logSize": int}
  GET  /dev/log?off=N      Hercules log bytes from offset N (N<0: the last 64 KB); header X-Log-Next
  POST /dev/cmd            body = one Hercules command, typed into our tmux session (-L <tmux> -t <session>)
  POST /dev/quit           Hercules 'quit' (+ Enter every 2 s until it exits; Hercules on a pipe needs it)
--coi-headers adds COOP/COEP/CORP (like Cloudflare Pages _headers). Without it the page must rely on
coi-serviceworker (like GitHub Pages).
"""
import argparse, json, os, subprocess, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, required=True)
ap.add_argument('--root', required=True)
ap.add_argument('--log', required=True)
ap.add_argument('--tmux', default='ui')
ap.add_argument('--session', default='herc')
ap.add_argument('--herc-pattern', default='bin/hercules -n -f ' + os.path.expanduser('~/webmvs/web/app/run/web-ui.cnf'))
ap.add_argument('--coi-headers', action='store_true')
ap.add_argument('--no-dev-api', action='store_true')
A = ap.parse_args()


def tmux_keys(*keys, literal=None):
    if literal is not None:
        subprocess.run(['tmux', '-L', A.tmux, 'send-keys', '-t', A.session, '-l', literal], check=False)
    for k in keys:
        subprocess.run(['tmux', '-L', A.tmux, 'send-keys', '-t', A.session, k], check=False)


def herc_running():
    return subprocess.run(['pgrep', '-f', '--', A.herc_pattern], capture_output=True).returncode == 0


class H(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript',
                      '.wasm': 'application/wasm', '.bdf': 'text/plain', '.map': 'application/json', '': 'application/octet-stream'}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=A.root, **k)

    def end_headers(self):
        if A.coi_headers:
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
            self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '/dev/log' in (self.path or ''):
            return
        super().log_message(fmt, *args)

    def reply(self, code, body=b'', ctype='application/json', extra=None):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith('/dev/') and not A.no_dev_api:
            if u.path == '/dev/status':
                size = os.path.getsize(A.log) if os.path.exists(A.log) else 0
                return self.reply(200, json.dumps({'hercules': herc_running(), 'logSize': size}))
            if u.path == '/dev/log':
                off = int(parse_qs(u.query).get('off', ['-1'])[0])
                size = os.path.getsize(A.log) if os.path.exists(A.log) else 0
                if off < 0 or off > size:
                    off = max(0, size - 65536)
                with open(A.log, 'rb') as f:
                    f.seek(off)
                    data = f.read(min(size - off, 262144))
                cut = data.rfind(b'\n') + 1   # whole lines only
                data = data[:cut]
                return self.reply(200, data, 'text/plain; charset=utf-8', {'X-Log-Next': str(off + len(data))})
            return self.reply(404, '{}')
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if A.no_dev_api or not u.path.startswith('/dev/'):
            return self.reply(404, '{}')
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode('utf-8', 'replace').strip()
        if u.path == '/dev/cmd':
            if not body or '\n' in body or len(body) > 200:
                return self.reply(400, '{"error":"one command line"}')
            tmux_keys('Enter', literal=body)
            return self.reply(200, '{"ok":true}')
        if u.path == '/dev/quit':
            def quit_loop():
                tmux_keys('Enter', literal='quit')
                for _ in range(15):
                    time.sleep(2)
                    if not herc_running():
                        break
                    tmux_keys('Enter')
            threading.Thread(target=quit_loop, daemon=True).start()
            return self.reply(200, '{"ok":true}')
        return self.reply(404, '{}')


ThreadingHTTPServer.allow_reuse_address = True
srv = ThreadingHTTPServer(('127.0.0.1', A.port), H)
print(f'devserver on 127.0.0.1:{A.port} root={A.root} coi_headers={A.coi_headers}', flush=True)
srv.serve_forever()
