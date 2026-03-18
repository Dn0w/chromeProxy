#!/usr/bin/python3
"""
Chrome Proxy Extension — Native Messaging Host
Runs an HTTP/HTTPS proxy server and communicates with the Chrome extension
via the Native Messaging protocol (4-byte length-prefixed JSON on stdin/stdout).
"""

import sys
import json
import struct
import threading
import socket
import select
import time
import queue
import os
from urllib.parse import urlparse

# ── Native messaging I/O ──────────────────────────────────────────────────────

_write_lock = threading.Lock()


def send_message(msg: dict):
    """Send a JSON message to the Chrome extension via stdout."""
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with _write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message() -> dict | None:
    """Read a JSON message from the Chrome extension via stdin.
    Returns None on EOF or error.
    """
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0 or msg_len > 10 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(msg_len)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


# ── Proxy connection handler ──────────────────────────────────────────────────

BUFFER_SIZE = 65536
TIMEOUT = 20

# Stealth mode: headers stripped from outgoing HTTP requests
STEALTH_STRIP = {
    b"via", b"x-forwarded-for", b"x-forwarded-proto", b"x-forwarded-host",
    b"forwarded", b"x-real-ip", b"proxy-connection", b"proxy-authorization",
    b"proxy-authenticate", b"x-proxy-id",
}

# Latest stable Chrome UA (update periodically)
CHROME_UA = (
    b"Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    b"AppleWebKit/537.36 (KHTML, like Gecko) "
    b"Chrome/130.0.0.0 Safari/537.36"
)


class ProxyHandler:
    def __init__(self, client_sock: socket.socket, client_addr, log_queue: queue.Queue, stealth: bool = False):
        self.client = client_sock
        self.addr = client_addr
        self.q = log_queue
        self.stealth = stealth

    def _log(self, **kwargs):
        self.q.put(
            {
                "type": "log",
                "timestamp": time.strftime("%H:%M:%S"),
                **kwargs,
            }
        )

    def handle(self):
        try:
            self.client.settimeout(TIMEOUT)
            # Read initial request data (headers)
            raw = b""
            while b"\r\n\r\n" not in raw:
                chunk = self.client.recv(BUFFER_SIZE)
                if not chunk:
                    return
                raw += chunk
                if len(raw) > 256 * 1024:
                    return  # header too large, bail

            header_end = raw.index(b"\r\n\r\n")
            header_bytes = raw[:header_end]
            body_bytes = raw[header_end + 4 :]

            first_line = header_bytes.split(b"\r\n")[0].decode("utf-8", errors="replace")
            parts = first_line.split(" ", 2)
            if len(parts) < 2:
                return

            method = parts[0].upper()
            url = parts[1]
            version = parts[2] if len(parts) > 2 else "HTTP/1.0"

            if method == "CONNECT":
                self._handle_connect(url)
            else:
                self._handle_http(method, url, version, header_bytes, body_bytes)
        except Exception:
            pass
        finally:
            try:
                self.client.close()
            except Exception:
                pass

    def _handle_connect(self, host_port: str):
        """Handle HTTPS CONNECT tunnel."""
        try:
            host, port_str = host_port.rsplit(":", 1)
            port = int(port_str)
        except (ValueError, TypeError):
            self.client.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return

        self._log(method="CONNECT", host=host, port=port, path="", status="tunneling")

        try:
            remote = socket.create_connection((host, port), timeout=TIMEOUT)
        except OSError as e:
            self.client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            self._log(method="CONNECT", host=host, port=port, path="", status="error: " + str(e))
            return

        try:
            # Plain 200 — no proxy-identifying headers visible to client
            self.client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self._relay(self.client, remote)
        finally:
            try:
                remote.close()
            except Exception:
                pass

    def _handle_http(self, method: str, url: str, version: str, header_bytes: bytes, body_bytes: bytes):
        """Handle a plain HTTP request."""
        try:
            parsed = urlparse(url if url.startswith("http") else "http://" + url)
            host = parsed.hostname
            port = parsed.port or 80
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
        except Exception:
            self.client.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return

        self._log(method=method, host=host, port=port, path=path, status="forwarding")

        try:
            remote = socket.create_connection((host, port), timeout=TIMEOUT)
            remote.settimeout(TIMEOUT)

            # Rebuild request with relative path
            lines = header_bytes.split(b"\r\n")
            lines[0] = f"{method} {path} {version}".encode()

            filtered = []
            for ln in lines[1:]:
                name = ln.split(b":", 1)[0].lower().strip()
                if self.stealth:
                    # Strip ALL proxy-revealing headers
                    if name in STEALTH_STRIP:
                        continue
                    # Replace User-Agent with Chrome's
                    if name == b"user-agent":
                        filtered.append(b"User-Agent: " + CHROME_UA)
                        continue
                else:
                    # Always strip the most obvious proxy headers
                    if name in (b"proxy-connection", b"proxy-authorization"):
                        continue
                filtered.append(ln)

            filtered.insert(0, lines[0])

            # Ensure Host header is present
            has_host = any(ln.lower().startswith(b"host:") for ln in filtered[1:])
            if not has_host:
                filtered.insert(1, f"Host: {host}".encode() + (f":{port}".encode() if port != 80 else b""))

            # Stealth: inject Chrome UA if the client sent none
            if self.stealth and not any(ln.lower().startswith(b"user-agent:") for ln in filtered[1:]):
                filtered.insert(2, b"User-Agent: " + CHROME_UA)

            rebuilt = b"\r\n".join(filtered) + b"\r\n\r\n" + body_bytes
            remote.sendall(rebuilt)

            # Relay response
            while True:
                try:
                    data = remote.recv(BUFFER_SIZE)
                    if not data:
                        break
                    self.client.sendall(data)
                except OSError:
                    break
            remote.close()
            self._log(method=method, host=host, port=port, path=path, status="ok")
        except OSError as e:
            try:
                self.client.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            except Exception:
                pass
            self._log(method=method, host=host, port=port or 80, path=path, status="error: " + str(e))

    def _relay(self, a: socket.socket, b: socket.socket):
        """Bidirectional relay between two sockets until one closes."""
        socks = [a, b]
        while True:
            try:
                readable, _, exceptional = select.select(socks, [], socks, TIMEOUT)
            except OSError:
                return
            if exceptional or not readable:
                return
            for src in readable:
                dst = b if src is a else a
                try:
                    data = src.recv(BUFFER_SIZE)
                    if not data:
                        return
                    dst.sendall(data)
                except OSError:
                    return


# ── Proxy server ──────────────────────────────────────────────────────────────

class ProxyServer:
    def __init__(self, log_queue: queue.Queue):
        self.q = log_queue
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self.running = False
        self.port = 8080
        self.bind_addr = "0.0.0.0"
        self.stealth = False

    def start(self, port: int = 8080, bind_addr: str = "0.0.0.0", stealth: bool = False) -> bool:
        if self.running:
            self.stop()
        self.port = port
        self.bind_addr = bind_addr or "0.0.0.0"
        self.stealth = stealth
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((self.bind_addr, port))
            s.listen(256)
            self._sock = s
            self.running = True
            self._thread = threading.Thread(target=self._accept_loop, daemon=True)
            self._thread.start()
            mode = "stealth" if self.stealth else "normal"
            self.q.put({"type": "log", "timestamp": time.strftime("%H:%M:%S"),
                        "method": "INFO", "host": f"Proxy started on {self.bind_addr}:{port} [{mode}]", "port": port, "path": "", "status": "ok"})
            return True
        except OSError as e:
            self.q.put({"type": "error", "message": f"Cannot bind {self.bind_addr}:{port}: {e}"})
            return False

    def stop(self):
        self.running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def _accept_loop(self):
        while self.running:
            try:
                self._sock.settimeout(1.0)
                try:
                    client, addr = self._sock.accept()
                    t = threading.Thread(
                        target=ProxyHandler(client, addr, self.q, self.stealth).handle,
                        daemon=True,
                    )
                    t.start()
                except socket.timeout:
                    continue
            except OSError:
                break


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log_queue: queue.Queue = queue.Queue()
    proxy = ProxyServer(log_queue)

    def log_sender():
        """Background thread: flush log queue → extension."""
        while True:
            try:
                entry = log_queue.get(timeout=0.5)
                send_message(entry)
            except queue.Empty:
                continue
            except Exception:
                break

    threading.Thread(target=log_sender, daemon=True).start()

    # Main thread: read commands from extension
    while True:
        msg = read_message()
        if msg is None:
            # EOF — Chrome closed the connection
            proxy.stop()
            sys.exit(0)

        cmd = msg.get("command")

        if cmd == "start":
            port = int(msg.get("port", 8080))
            bind_addr = msg.get("bindAddr", "0.0.0.0")
            stealth = bool(msg.get("stealth", False))
            success = proxy.start(port, bind_addr, stealth)
            send_message({"type": "status", "running": success, "port": port, "bindAddr": proxy.bind_addr,
                          "stealth": proxy.stealth,
                          "error": None if success else f"Could not bind {bind_addr}:{port}"})

        elif cmd == "stop":
            proxy.stop()
            send_message({"type": "status", "running": False, "port": proxy.port, "bindAddr": proxy.bind_addr,
                          "stealth": proxy.stealth, "error": None})

        elif cmd == "getStatus":
            send_message({"type": "status", "running": proxy.running, "port": proxy.port,
                          "bindAddr": proxy.bind_addr, "stealth": proxy.stealth, "error": None})


if __name__ == "__main__":
    main()
