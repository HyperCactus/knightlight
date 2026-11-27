"""Linux native webview smoke/relaunch test, in Xvfb with verified audio mute."""
import argparse
import json
import os
from pathlib import Path
import re
import resource
import signal
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, default=ROOT / "src-tauri/target/release/knightlight-desktop")
parser.add_argument("--display", action="store_true",
                    help="Use the current DISPLAY to check the real graphics driver (verified-muted test windows)")
args = parser.parse_args()
xvfb = os.environ.get("CHESS_TEST_XVFB") or shutil.which("Xvfb")
assert args.display or xvfb, "Install xvfb, set CHESS_TEST_XVFB, or use --display"
assert not args.display or os.environ.get("DISPLAY"), "--display requires DISPLAY"


def desktop_limits():
    # Shells used by CI/agents often allow a million descriptors. GNOME's
    # normal application limit is 1024; the higher limit hid a renderer leak.
    hard = resource.getrlimit(resource.RLIMIT_NOFILE)[1]
    soft = 1024 if hard == resource.RLIM_INFINITY else min(1024, hard)
    resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))


def renderer_descriptors(root_pid):
    """Inspect only this test's descendants, including children of GLib threads."""
    pending, seen, samples = [root_pid], set(), []
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        directory = Path(f"/proc/{pid}")
        try:
            for task in (directory / "task").iterdir():
                try:
                    pending.extend(int(child) for child in (task / "children").read_text().split())
                except (FileNotFoundError, ProcessLookupError):
                    pass
            if not (directory / "comm").read_text().startswith("WebKitWeb"):
                continue
            try:
                descriptors = list((directory / "fd").iterdir())
                sync = 0
                for descriptor in descriptors:
                    try:
                        sync += os.readlink(descriptor) == "anon_inode:sync_file"
                    except (FileNotFoundError, ProcessLookupError):
                        pass
                samples.append((len(descriptors), sync))
            except PermissionError:
                # WebKit's sandbox can hide fd links even from the test parent.
                # FDSize remains readable: its table capacity grows as a leak
                # approaches the 1024 limit. Keep the sandbox enabled.
                status = (directory / "status").read_text()
                samples.append((int(re.search(r"^FDSize:\s+(\d+)", status, re.M)[1]), None))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return samples


with tempfile.TemporaryDirectory(prefix="knightlight-native-") as directory:
    profile = Path(directory) / "profile"
    with (Path(directory) / "display").open("w+") as display_file:
        display = None if args.display else subprocess.Popen(
            [xvfb, "-displayfd", str(display_file.fileno()), "-screen", "0", "1440x1000x24", "-nolisten", "tcp"],
            pass_fds=(display_file.fileno(),), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            target_display = os.environ.get("DISPLAY") if args.display else None
            if display:
                for _ in range(100):
                    display_file.seek(0)
                    number = display_file.read().strip()
                    if number: break
                    assert display.poll() is None, "Xvfb exited"
                    time.sleep(.05)
                assert number, "Xvfb failed to start"
                target_display = ":" + number
            ports = []
            descriptor_samples = []
            for iteration in range(2):
                env = {**os.environ, "DISPLAY": target_display, "KNIGHTLIGHT_PROFILE": str(profile),
                       "XDG_DATA_HOME": str(Path(directory) / "xdg-data"),
                       "XDG_CACHE_HOME": str(Path(directory) / "xdg-cache"),
                       "KNIGHTLIGHT_DESKTOP_SMOKE": "1"}
                # Exercise production startup defaults, not a workaround
                # supplied by the test that could hide real graphics crashes.
                env.pop("WEBKIT_DISABLE_DMABUF_RENDERER", None)
                with (Path(directory) / f"run-{iteration}.log").open("w+") as log:
                    app = subprocess.Popen(["dbus-run-session", "--", str(args.binary.resolve())],
                                           env=env, stdout=log, stderr=log, preexec_fn=desktop_limits,
                                           start_new_session=True)
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
                        deadline = time.monotonic() + 70
                        while app.poll() is None:
                            samples = renderer_descriptors(app.pid)
                            descriptor_samples.extend(samples)
                            assert all((size < 1024 if sync is None else sync <= 128)
                                       for size, sync in samples), (
                                f"Renderer resources are accumulating toward the file limit: {samples}")
                            if time.monotonic() >= deadline:
                                log.seek(0)
                                raise TimeoutError("Native navigation stalled:\n" + log.read())
                            time.sleep(.25)
                        log.seek(0)
                        output = log.read()
                        assert app.returncode == 0 and "mute verified" in output and "PASS: native" in output, output
                    finally:
                        if app.poll() is None:
                            os.killpg(app.pid, signal.SIGTERM)
                            try:
                                app.wait(timeout=10)
                            except subprocess.TimeoutExpired:
                                os.killpg(app.pid, signal.SIGKILL)
                                app.wait(timeout=5)
            assert ports[0] == ports[1], "Local storage origin changed on normal relaunch"
            assert descriptor_samples, "No renderer resource measurements captured"
            exact = [(total, sync) for total, sync in descriptor_samples if sync is not None]
            capacities = [total for total, sync in descriptor_samples if sync is None]
            if exact:
                print(f"Native renderer resource peaks: {max(total for total, _ in exact)} descriptors, "
                      f"{max(sync for _, sync in exact)} graphics sync handles")
            if capacities:
                print(f"Sandboxed renderer descriptor-table capacity peaked at {max(capacities)} slots")
            if "Native UI timings:" in output:
                print(next(line for line in output.splitlines() if "Native UI timings:" in line))
            print("PASS: 100 rendered native section changes per launch at a 1024-file limit, 64-square board, Web Audio and coach playback twice; audio mute verified; settings and origin survive relaunch; disposable profile only")
        finally:
            if display:
                display.terminate()
                display.wait(timeout=5)
