#!/usr/bin/env python3
"""Start Knightlight once, then open the desktop's default browser."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]


class Launcher:
    def __init__(self, project=PROJECT, port=3000, state=None):
        self.project = Path(project).resolve()
        self.port = port
        self.url = f"http://127.0.0.1:{port}"
        self.state = Path(state) if state else Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "knightlight"
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.log = self.state / "server.log"
        self.child = None

    def healthy(self):
        try:
            # Loopback must not go through a user's HTTP proxy.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(self.url + "/api/health", timeout=1) as response:
                data = json.load(response)
            return isinstance(data, dict) and data.get("app") == "knightlight" and data.get("workspace") == str(self.project)
        except (OSError, ValueError, urllib.error.URLError):
            return False

    def occupied(self):
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=.5):
                return True
        except OSError:
            return False

    def binary(self):
        binary = self.project / "target/release/chess-study"
        if not binary.is_file():
            cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin/cargo")
            with self.log.open("ab") as output:
                result = subprocess.run([cargo, "build", "--release"], cwd=self.project, stdout=output, stderr=output, check=False)
            if result.returncode:
                raise RuntimeError(f"Knightlight could not be built. Details: {self.log}")
        return binary

    def start(self, timeout=90):
        with (self.state / "launch.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.healthy():
                return self.url
            if self.occupied():
                # A previous launch may already be starting the web service.
                for _ in range(10):
                    time.sleep(.15)
                    if self.healthy():
                        return self.url
                raise RuntimeError(f"Port {self.port} is used by another app. Knightlight has not stopped or replaced it.")
            binary = self.binary()
            unit = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "systemd/user/knightlight.service"
            managed = self.port == 3000 and bool(shutil.which("systemctl")) and unit.is_file() and f"# Project: {self.project}\n" in unit.read_text()
            if managed:
                result = subprocess.run(["systemctl", "--user", "start", "knightlight.service"], capture_output=True, text=True, timeout=15, check=False)
                if result.returncode:
                    managed = False
            if not managed:
                with self.log.open("ab", buffering=0) as output:
                    self.child = subprocess.Popen([str(binary)], cwd=self.project, env={**os.environ, "PORT": str(self.port)}, stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
                (self.state / "server.pid").write_text(str(self.child.pid) + "\n")
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if self.healthy():
                    return self.url
                if self.child is not None and self.child.poll() is not None:
                    raise RuntimeError(f"Knightlight could not start. Your saved files are kept. Details: {self.log}")
                time.sleep(.15)
            detail = "journalctl --user -u knightlight.service" if managed else str(self.log)
            raise RuntimeError(f"Knightlight did not become ready. Details: {detail}")


def open_browser(url):
    # Use the desktop's URL handler, including its existing browser profile.
    subprocess.run(["xdg-open", url], check=True, timeout=30)


def main():
    parser = argparse.ArgumentParser(description="Launch Knightlight in your default browser")
    parser.add_argument("--no-browser", action="store_true", help="Start the local server without opening a window")
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Choose a port from 1024 to 65535")
    try:
        launcher = Launcher(port=args.port)
        url = launcher.start()
        if not args.no_browser:
            open_browser(url)
        print(url)
        return 0
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        message = str(error)
        print(message, file=sys.stderr)
        if not args.no_browser and shutil.which("zenity"):
            subprocess.run(["zenity", "--error", "--title=Knightlight", "--text=" + message], check=False)
        return 1


if __name__ == "__main__":
    sys.exit(main())
