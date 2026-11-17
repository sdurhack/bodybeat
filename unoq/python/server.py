"""Tiny stdlib HTTP server exposing the heart rate.

  GET /          live page (big pulsing heart + BPM)
  GET /bpm       {"bpm": 72.4, "quality": 0.008, "source": "light:ir", "beats": 123, "t": ...}
  GET /events    Server-Sent Events: "event: beat" on every beat, "event: bpm" once a second

SSE instead of WebSocket = zero dependencies, and any browser/JS can consume it:
    new EventSource("http://<uno-q-ip>:7000/events").addEventListener("beat", ...)
Python consumer (for the heartbeat-DJ step): see README.
"""
import json
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.data = {"bpm": None, "quality": 0.0, "source": None, "beats": 0, "t": 0.0}
        self.subs = []

    def update(self, **kw):
        with self.lock:
            self.data.update(kw)
            self.data["t"] = time.time()

    def snapshot(self):
        with self.lock:
            return dict(self.data)

    def publish(self, event, payload):
        msg = "event: %s\ndata: %s\n\n" % (event, json.dumps(payload))
        for q in list(self.subs):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


STATE = State()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")

    def do_GET(self):
        if self.path.startswith("/bpm"):
            body = json.dumps(STATE.snapshot()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/events"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self._cors()
            self.end_headers()
            q = queue.Queue(maxsize=100)
            STATE.subs.append(q)
            try:
                self.wfile.write(("event: bpm\ndata: %s\n\n" % json.dumps(STATE.snapshot())).encode())
                self.wfile.flush()
                while True:
                    try:
                        msg = q.get(timeout=15)
                    except queue.Empty:
                        msg = ": keepalive\n\n"
                    self.wfile.write(msg.encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                STATE.subs.remove(q)
        else:
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)


def start(port=7000):
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print("heartbeat: http://0.0.0.0:%d  (/bpm, /events)" % port, flush=True)
    return srv
