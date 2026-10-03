#!/usr/bin/env python3
"""Local-only receiver for the synthetic Tiny Sum demo credential."""

from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok\n")

    def do_POST(self):
        if self.path != "/diagnostics":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length > 4096:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        print(f"RECEIVED POST /diagnostics ({length} bytes):", flush=True)
        print(body.decode("utf-8", errors="replace"), end="", flush=True)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok\n")


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 0), Handler)
    Path(sys.argv[1]).write_text(str(server.server_port))
    print(f"Local collector listening on 127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()
