"""Counter that runs inside the guest.

GET /events writes one JSON line per second and keeps the connection open.
One number lives in this process. It advances only when a line is delivered,
so a new connection after restore continues where the last one stopped.

GET /health returns the last delivered line and does not advance the number.
boot_id and pid come from this machine. A Firecracker restore keeps both.

BOOT_ID, GUEST_PID, and COUNTER_START are optional.
Tests on a Mac set them so a second process can pretend to be the restored guest.
Inside the VM they stay unset.
"""

import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def boot_id() -> str:
    override = os.environ.get("BOOT_ID")
    if override:
        return override
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="utf-8") as handle:
            return handle.read().strip()
    except OSError:
        return "local"


def guest_pid() -> int:
    override = os.environ.get("GUEST_PID")
    if override:
        return int(override)
    return os.getpid()


def write_chunk(handler: BaseHTTPRequestHandler, payload: bytes) -> None:
    handler.wfile.write(f"{len(payload):X}\r\n".encode("ascii"))
    handler.wfile.write(payload)
    handler.wfile.write(b"\r\n")
    handler.wfile.flush()


subscribers: list[BaseHTTPRequestHandler] = []
subscriber_lock = threading.Lock()
counter = int(os.environ.get("COUNTER_START", "0"))
last_event: dict[str, object] | None = None


def publish() -> None:
    global counter, last_event
    interval = float(os.environ.get("INTERVAL_SEC", "1"))
    while True:
        with subscriber_lock:
            targets = list(subscribers)
        if targets:
            event = {
                "boot_id": boot_id(),
                "pid": guest_pid(),
                "counter": counter,
                "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            line = (json.dumps(event) + "\n").encode("utf-8")
            delivered = False
            for handler in targets:
                try:
                    write_chunk(handler, line)
                    delivered = True
                except (BrokenPipeError, ConnectionResetError, OSError):
                    with subscriber_lock:
                        if handler in subscribers:
                            subscribers.remove(handler)
                    done = getattr(handler, "done", None)
                    if isinstance(done, threading.Event):
                        done.set()
            if delivered:
                with subscriber_lock:
                    last_event = event
                    counter += 1
        time.sleep(interval)


class CounterHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            self.health()
            return
        if self.path != "/events":
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self.done = threading.Event()
        with subscriber_lock:
            subscribers.append(self)
        self.done.wait()

    def health(self) -> None:
        if last_event is None:
            self.send_response(503)
            self.end_headers()
            return
        payload = (json.dumps(last_event) + "\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    # The proxy connects to the guest address, so this listens on every interface.
    server = ThreadingHTTPServer(("0.0.0.0", port), CounterHandler)
    threading.Thread(target=publish, daemon=True).start()
    print(f"listening {server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
