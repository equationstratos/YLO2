"""Serveur local : sert le visualiseur et diffuse l'état du robot simulé.

    ylo2-sim serve --port 8770 --page index.html

Routes :
    GET  /                page HTML (index.html du dépôt par défaut)
    GET  /api/state       état courant (JSON)
    GET  /api/stream      flux Server-Sent Events, une trame par pas
    POST /api/cmd         consigne {vx, vy, wz, height, swing, gait}

Le visualiseur ouvre /api/stream et pilote la boucle par /api/cmd : les
curseurs de la page agissent alors sur la boucle Python, pas sur le
générateur du navigateur.
"""
from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict

from . import gait as gaitmod
from .sim import Robot


class Loop:
    """Boucle de simulation temps réel, pilotable depuis l'extérieur."""

    def __init__(self, rate: float = 50.0) -> None:
        self.robot = Robot(rate=rate)
        self.robot.set_gait("trot")
        self.robot.command(0.12, 0.0, 0.0)
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> "Loop":
        self.thread.start()
        return self

    def stop(self) -> None:
        self.running = False

    def _run(self) -> None:
        period = self.robot.dt
        nxt = time.perf_counter()
        while self.running:
            with self.lock:
                self.robot.step()
                if len(self.robot.frames) > 4000:      # mémoire bornée
                    del self.robot.frames[:2000]
            nxt += period
            delay = nxt - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            else:
                nxt = time.perf_counter()

    def state(self) -> Dict[str, Any]:
        with self.lock:
            r = self.robot
            return {
                "t": round(r.t, 4),
                "q": [round(v, 5) for v in r.q],
                "base": [round(v, 5) for v in r.base],
                "contact": [1 if c else 0 for c in r.contacts],
                "phase": round(r.phase, 4),
                "gait": r.gait.name,
                "cmd": {"vx": r.vx, "vy": r.vy, "wz": r.wz,
                        "height": r.height, "swing": r.swing},
                "margin": round(r.support_margin(), 4),
            }

    def apply(self, cmd: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            r = self.robot
            if "gait" in cmd and cmd["gait"] in gaitmod.GAITS:
                r.set_gait(cmd["gait"])
            if "height" in cmd:
                r.set_height(float(cmd["height"]))
            if "swing" in cmd:
                r.swing = float(cmd["swing"])
            keys = {k: float(cmd[k]) for k in ("vx", "vy", "wz") if k in cmd}
            if keys:
                r.command(**keys)
        return self.state()


def make_handler(loop: Loop, page: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):            # journal silencieux
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):                              # noqa: N802
            if self.path in ("/", "/index.html"):
                if not os.path.exists(page):
                    self._send(404, b"page introuvable : " + page.encode(), "text/plain; charset=utf-8")
                    return
                with open(page, "rb") as fh:
                    self._send(200, fh.read(), "text/html; charset=utf-8")
                return
            if self.path == "/api/state":
                self._send(200, json.dumps(loop.state()).encode(), "application/json")
                return
            if self.path == "/api/stream":
                self._stream()
                return
            self._send(404, b"not found", "text/plain")

        def do_POST(self):                             # noqa: N802
            if self.path != "/api/cmd":
                self._send(404, b"not found", "text/plain")
                return
            length = int(self.headers.get("Content-Length", "0"))
            try:
                cmd = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                self._send(400, b'{"error":"json"}', "application/json")
                return
            self._send(200, json.dumps(loop.apply(cmd)).encode(), "application/json")

        def _stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                while loop.running:
                    payload = json.dumps(loop.state())
                    self.wfile.write(b"data: " + payload.encode() + b"\n\n")
                    self.wfile.flush()
                    time.sleep(1 / 30.0)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return Handler


def serve(port: int = 8770, page: str = "index.html", rate: float = 50.0) -> None:
    loop = Loop(rate=rate).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(loop, page))
    print(f"Simulateur YLO-2 sur http://127.0.0.1:{port}  (page : {page})")
    print("Ctrl-C pour arrêter.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\narrêt")
    finally:
        loop.stop()
        httpd.server_close()
