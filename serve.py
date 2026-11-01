"""Serves the dashboard on http://localhost:8000 with caching disabled,
so the browser always loads the latest files after an update (no Ctrl+F5 needed).

    python serve.py            (port 8000)
    python serve.py 8080       (another port)
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard")


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Dashboard: http://localhost:{PORT}  (Ctrl+C to stop)")
        httpd.serve_forever()
