#!/usr/bin/env python3
"""Summarize web/runtime test results (run-test.mjs summary JSON). Usage: websum.py <summary.json>..."""
import json, sys
print(f"{'tag':10s} {'ok':5s} {'ipl->IKT007I':>12s} {'logon':>7s} {'TIME':>6s} {'ready->logoff':>13s} longtask")
for f in sys.argv[1:]:
    try: s = json.load(open(f))
    except Exception as e: print(f, "bad", e); continue
    r = s.get("result") or {}; t = r.get("t", {}); ri = r.get("readyInfo", {})
    tag = f.split("web-")[-1].replace(".summary.json", "")
    print(f"{tag:10s} {str(s['ok']):5s} {ri.get('iplToReadyMs', 0):12d} {t.get('tsoReady',0)-t.get('tsoLogo',0):7d} "
          f"{t.get('tsoTime',0)-t.get('tsoReady',0):6d} {t.get('tsoLogoff',0)-t.get('ready',0):13d} {r.get('longtask')}")
