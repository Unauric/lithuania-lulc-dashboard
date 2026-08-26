# Copyright (c) 2026 Lithuanian Energy Institute (LEI). All rights reserved.
# See LICENSE in the repository root -- source reuse is restricted to LEI.

r"""
Static file server for the dashboard, extended with a same-origin proxy for
the Lithuanian Hydrometeorological Service's public hydro-station API
(api.meteo.lt) — needed because that API does not send
Access-Control-Allow-Origin, so the dashboard's own client-side JS can't
fetch it directly from the browser (CORS blocks it). Proxying it through
this same server sidesteps that without needing the upstream API to change.

Serves exactly what `python -m http.server` would (same directory, same
static file behavior) plus:
  GET /api/hydro/<path> -> proxied to https://api.meteo.lt/v1/<path>

Run from the repo root (replaces `python -m http.server`):
  python serve_dashboard.py [port]
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_BASE = "https://api.meteo.lt/v1/"
PROXY_PREFIX = "/api/hydro/"
# Simple in-memory cache: upstream data changes at most hourly, and repeated
# clicks on the same station/date shouldn't re-hit the upstream API every time.
_cache: dict[str, tuple[int, bytes, str]] = {}
CACHE_MAX_ENTRIES = 500


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith(PROXY_PREFIX):
            self._proxy_hydro()
            return
        super().do_GET()

    def _proxy_hydro(self):
        upstream_path = self.path[len(PROXY_PREFIX):]
        if not upstream_path or ".." in upstream_path:
            self.send_error(400, "Bad request")
            return
        upstream_url = UPSTREAM_BASE + upstream_path

        cached = _cache.get(upstream_url)
        if cached:
            status, body, content_type = cached
        else:
            try:
                req = urllib.request.Request(upstream_url, headers={"User-Agent": "lithuania-dashboard/1.0"})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    status = resp.status
                    body = resp.read()
                    content_type = resp.headers.get("Content-Type", "application/json")
            except urllib.error.HTTPError as e:
                status = e.code
                body = e.read() or json.dumps({"error": str(e)}).encode("utf-8")
                content_type = "application/json"
            except Exception as e:  # network error, timeout, etc.
                self.send_error(502, f"Upstream fetch failed: {e}")
                return
            if status == 200:
                if len(_cache) >= CACHE_MAX_ENTRIES:
                    _cache.pop(next(iter(_cache)))
                _cache[upstream_url] = (status, body, content_type)

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Keep the same log format as the default http.server (visible in the
        # terminal), just via the standard logger call already used.
        super().log_message(format, *args)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), Handler)
    print(f"Serving Data/ on http://localhost:{port}/  (hydro API proxy at {PROXY_PREFIX})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
