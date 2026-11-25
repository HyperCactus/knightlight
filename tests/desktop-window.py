"""Linux native webview smoke/relaunch test, in Xvfb with verified audio mute."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, default=ROOT / "src-tauri/target/release/knightlight-desktop")
args = parser.parse_args()
xvfb = os.environ.get("CHESS_TEST_XVFB") or shutil.which("Xvfb")
assert xvfb, "Install xvfb or set CHESS_TEST_XVFB"

with tempfile.TemporaryDirectory(prefix="knightlight-native-") as directory:
    profile = Path(directory) / "profile"
    with (Path(directory) / "display").open("w+") as display_file:
        display = subprocess.Popen([xvfb, "-displayfd", str(display_file.fileno()), "-screen", "0", "1440x1000x24", "-nolisten", "tcp"],
                                   pass_fds=(display_file.fileno(),), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                display_file.seek(0)
                number = display_file.read().strip()
                if number: break
                assert display.poll() is None, "Xvfb exited"
                time.sleep(.05)
            assert number, "Xvfb failed to start"
            ports = []
            for iteration in range(2):
                env = {**os.environ, "DISPLAY": ":" + number, "KNIGHTLIGHT_PROFILE": str(profile),
                       "KNIGHTLIGHT_DESKTOP_SMOKE": "1", "WEBKIT_DISABLE_DMABUF_RENDERER": "1"}
                with (Path(directory) / f"run-{iteration}.log").open("w+") as log:
                    app = subprocess.Popen(["dbus-run-session", "--", str(args.binary.resolve())],
                                           env=env, stdout=log, stderr=log)
                    try:
                        for _ in range(300):
                            log.seek(0)
                            output = log.read()
                            match = re.search(r"Knightlight: (http://127\.0\.0\.1:(\d+))", output)
                            if match: break
                            assert app.poll() is None, output
                            time.sleep(.1)
                        assert match, output
                        base = match.group(1)
                        ports.append(match.group(2))
                        if iteration == 0:
                            payload = json.dumps({"updated_at": 2000, "values": {"theme": "light", "speed": 1.2, "voice": True}}).encode()
                            request = urllib.request.Request(base + "/api/preferences", data=payload,
                                                             headers={"Content-Type": "application/json"}, method="PUT")
                            with urllib.request.urlopen(request, timeout=5) as result: assert result.status == 200
                        else:
                            with urllib.request.urlopen(base + "/api/preferences", timeout=5) as result:
                                saved = json.load(result)
                            assert saved["values"] == {"theme": "light", "speed": 1.2, "voice": True}, saved
                        app.wait(timeout=40)
                        log.seek(0)
                        output = log.read()
                        assert app.returncode == 0 and "mute verified" in output and "PASS: native" in output, output
                    finally:
                        if app.poll() is None:
                            app.terminate()
                            app.wait(timeout=10)
            assert ports[0] == ports[1], "Local storage origin changed on normal relaunch"
            print("PASS: native webview loads UI/board/backend twice; audio mute verified; settings and origin survive relaunch; disposable profile only")
        finally:
            display.terminate()
            display.wait(timeout=5)
