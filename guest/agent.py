"""Small HTTP agent inside the guest.

Firecracker cannot run a command for us, so the control plane calls this:
  POST /files     {"path": "/opt/demo/server.py", "content": "..."}
  POST /commands  {"command": "python3 /opt/demo/server.py", "background": true}
"""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class AgentHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))

        if self.path == "/files":
            self.write_file(body["path"], body["content"])
            self.respond(204, b"")
            return

        if self.path == "/commands":
            payload = self.run_command(body["command"], bool(body.get("background")))
            self.respond(200, json.dumps(payload).encode("utf-8"))
            return

        self.respond(404, b"")

    def write_file(self, path: str, content: str) -> None:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)

    def run_command(self, command: str, background: bool) -> dict[str, object]:
        if background:
            process = subprocess.Popen(
                command,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            return {"pid": process.pid}

        completed = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
        )
        return {
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }

    def respond(self, status: int, payload: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    # The control API connects to the guest address, so this listens on every interface.
    server = ThreadingHTTPServer(("0.0.0.0", port), AgentHandler)
    print(f"listening {server.server_address[1]}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
