#!/usr/bin/env python3
"""Install per-user Linux desktop/search entries. No sudo or login startup."""
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[1]
HOME = Path.home()
DATA = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share"))
CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config"))
BIN = HOME / ".local/bin"


def executable(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


def desktop_quote(value):
    value = str(value)
    # Desktop Exec quoting has its own escaping layer, separate from a shell.
    for original, escaped in [("\\", "\\\\\\\\"), ('"', '\\\\"'), ('`', '\\\\`'), ('$', '\\\\$')]:
        value = value.replace(original, escaped)
    return '"' + value.replace('%', '%%') + '"'


def unit_quote(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def main():
    if sys.platform != "linux":
        raise SystemExit("This desktop installer supports Linux.")
    launcher = BIN / "knightlight"
    executable(launcher, "#!/bin/sh\nexec /usr/bin/python3 " + shlex.quote(str(PROJECT / "scripts/launch.py")) + ' "$@"\n')
    icons = DATA / "icons/hicolor"
    for size in [48, 192, 512]:
        dest = icons / f"{size}x{size}/apps/knightlight.png"
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PROJECT / f"static/icons/icon-{size}.png", dest)
    vector = icons / "scalable/apps/knightlight.svg"
    vector.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(PROJECT / "static/icons/knightlight.svg", vector)
    entry = "\n".join([
        "[Desktop Entry]", "Version=1.0", "Type=Application", "Name=Knightlight",
        "GenericName=Personal Chess Coach", "Comment=Your games. Your next good move.",
        "Exec=" + desktop_quote(launcher), "TryExec=" + str(launcher),
        "Icon=knightlight", "Terminal=false", "StartupNotify=false",
        "Categories=Game;BoardGame;", "Keywords=chess;coach;puzzles;training;review;Knightlight;", "",
    ])
    application = DATA / "applications/knightlight.desktop"
    executable(application, entry)
    desktop = HOME / "Desktop"
    if shutil.which("xdg-user-dir"):
        result = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True, check=False)
        if result.returncode == 0 and result.stdout.strip():
            desktop = Path(result.stdout.strip())
    # A desktop disabled by XDG may point at HOME; don't scatter launchers there.
    if desktop != HOME:
        shortcut = desktop / "Knightlight.desktop"
        # Absolute icon also works before the desktop's icon theme cache refreshes.
        executable(shortcut, entry.replace("Icon=knightlight", "Icon=" + str(PROJECT / "static/icons/icon-512.png")))
        if shutil.which("gio"):
            subprocess.run(["gio", "set", str(shortcut), "metadata::trusted", "true"], capture_output=True, check=False)
        print("Desktop shortcut:", shortcut)
    unit = CONFIG / "systemd/user/knightlight.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text("\n".join([
        f"# Project: {PROJECT}", "[Unit]", "Description=Knightlight personal chess coach",
        "StartLimitIntervalSec=60", "StartLimitBurst=3", "", "[Service]", "Type=simple",
        # WorkingDirectory takes a complete path, not an Exec command argument;
        # surrounding quotes become literal path characters in this directive.
        "WorkingDirectory=" + str(PROJECT).replace('%', '%%'),
        "ExecStart=" + unit_quote(PROJECT / "target/release/chess-study"),
        "Environment=PORT=3000", "Restart=on-failure", "RestartSec=3", "KillMode=control-group", "",
    ]))
    if shutil.which("systemctl"):
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True, check=False)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(DATA / "applications")], check=False)
    if shutil.which("gtk-update-icon-cache"):
        # User hicolor overlays often inherit the system index.theme, while an
        # old local cache can hide newly installed icons until it is rebuilt.
        subprocess.run(["gtk-update-icon-cache", "--force", "--quiet", "--ignore-theme-index", str(icons)], check=False)
    print("Search application:", application)
    print("Launch with:", launcher)
    print("The service starts on demand; it has not been enabled at login.")


if __name__ == "__main__":
    main()
