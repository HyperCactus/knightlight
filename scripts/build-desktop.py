#!/usr/bin/env python3
"""Build native offline installers. Run on the OS/architecture being packaged."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / "src-tauri/resources"
BUILD = ROOT / "build/desktop"


def run(*args, **kwargs):
    print("+", *map(str, args), flush=True)
    subprocess.run(list(map(str, args)), cwd=ROOT, check=True, **kwargs)


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns(".cache", "__pycache__", "*.pyc", ".git"))
    else:
        shutil.copy2(source, target)


def python(env):
    return ROOT / "vendor" / f"{env}-env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def freeze(force=False):
    interpreter = python("speech")
    if not interpreter.is_file():
        raise SystemExit("Missing worker environment. Run python scripts/setup-desktop.py first.")
    output = BUILD / "workers"
    name = "coach-runtime"
    stamp = BUILD / f"{name}.stamp"
    sources = ["desktop_worker", "desktop_opponent", "speech"]
    versions = subprocess.check_output([str(interpreter), "-c", "import importlib.metadata as m; print(sorted((d.metadata['Name'], d.version) for d in m.distributions()))"])
    fingerprint = hashlib.sha256(Path(__file__).read_bytes() + versions + b"".join((ROOT / f"scripts/{source}.py").read_bytes() for source in sources)).hexdigest()
    binary = output / name / (name + (".exe" if os.name == "nt" else ""))
    if force or not binary.is_file() or not stamp.is_file() or stamp.read_text() != fingerprint:
        options = ["--noconfirm", "--clean", "--onedir", "--noupx", "--console", "--name", name,
                   "--distpath", output, "--workpath", BUILD / "pyinstaller" / name,
                   "--specpath", BUILD, "--paths", ROOT / "scripts",
                   "--hidden-import", "speech", "--hidden-import", "desktop_opponent",
                   "--exclude-module", "tkinter", "--exclude-module", "matplotlib",
                   "--exclude-module", "IPython", "--exclude-module", "pytest",
                   "--exclude-module", "torch"]
        for package in ["kokoro_onnx", "piper", "espeakng_loader", "language_tags", "segments", "phonemizer"]:
            options += ["--collect-all", package]
        run(interpreter, "-m", "PyInstaller", *options, ROOT / "scripts/desktop_worker.py")
        stamp.write_text(fingerprint)
    copy(output / name, STAGE / "workers" / name)


def stage(force=False, use_exported=False, public_release=False):
    if not use_exported:
        run(python("maia"), ROOT / "scripts/export-desktop-opponent.py")
        run(python("maia"), ROOT / "tests/desktop-policy.py")
    run(python("speech"), ROOT / "tests/desktop-policy-runtime.py")
    # An allowlist is intentional. Never package somebody's games/preferences,
    # cached voice clips, virtual environments, tokens, or progress backups.
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)
    for item in ["static", "data/openings", "data/puzzle-bank.json", "data/public-puzzles.json",
                 "vendor/kokoro/onnx/model_quantized.onnx", "vendor/kokoro/voices.npz",
                 "vendor/kokoro/README.md", "vendor/kokoro/original",
                 "vendor/maia-model/maia3-5m.onnx",
                 "vendor/maia-model/desktop-config.json",
                 "vendor/maia-model/README.md", "vendor/KOKORO-NOTICE.md"]:
        source = ROOT / item
        if item == "data/puzzle-bank.json" and not source.exists():
            raise SystemExit("Missing puzzle bank; see docs/DESKTOP.md to recreate it.")
        copy(source, STAGE / item)
    if not public_release:
        copy(ROOT / "vendor/voices/en/en_US/lessac/medium", STAGE / "vendor/voices/en/en_US/lessac/medium")
    else:
        page = STAGE / "static/index.html"
        page.write_text(page.read_text(encoding="utf-8").replace('<option value="piper">Lessac · lightweight Piper</option>', ''), encoding="utf-8")
    for item in ["LICENSE", "NOTICE", "licenses"]:
        copy(ROOT / item, STAGE / "notices" / item)
    engine = Path(os.environ.get("STOCKFISH", ROOT / ("vendor/stockfish/usr/games/stockfish.exe" if os.name == "nt" else "vendor/stockfish/usr/games/stockfish")))
    if not engine.is_file():
        raise SystemExit("Set STOCKFISH to a native Stockfish executable, or run scripts/setup-desktop.py.")
    copy(engine, STAGE / "bin" / ("stockfish.exe" if os.name == "nt" else "stockfish"))
    freeze(force)
    notices = STAGE / "notices"
    run(python("speech"), ROOT / "scripts/collect-desktop-licenses.py", notices / "python-runtime")
    copy(ROOT / "docs/DESKTOP-NOTICES.md", notices / "README.md")
    copy(ROOT / "vendor/maia3/LICENSE", notices / "MAIA3-LICENSE")
    if (ROOT / "vendor/stockfish/usr/share/doc/stockfish").exists():
        copy(ROOT / "vendor/stockfish/usr/share/doc/stockfish", notices / "stockfish")
    # Include the upstream Maia source and our worker adapters for its AGPL.
    # Stockfish is a separate unmodified GPL executable; source is supplied beside installers.
    with tarfile.open(notices / "worker-source.tar.gz", "w:gz") as archive:
        for item in ["scripts/speech.py", "scripts/opponent.py", "scripts/desktop_opponent.py", "scripts/desktop_worker.py", "scripts/export-desktop-opponent.py", "vendor/maia3"]:
            archive.add(ROOT / item, arcname=item,
                        filter=lambda info: None if any(x in Path(info.name).parts for x in [".git", "__pycache__"]) else info)
    manifest = {str(p.relative_to(STAGE)): {"bytes": p.stat().st_size,
                "sha256": hashlib.file_digest(p.open("rb"), "sha256").hexdigest()}
                for p in sorted(STAGE.rglob("*")) if p.is_file()}
    (STAGE / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Offline resources: {sum(v['bytes'] for v in manifest.values()) / 1024**2:.0f} MiB", flush=True)


def release_artifact_name(name, system, machine, version):
    # Tauri names both Mac updater archives Knightlight.app.tar.gz.
    # Give each architecture its own release asset URL (and matching .sig).
    if system == "darwin" and (name.endswith(".app.tar.gz") or name.endswith(".app.tar.gz.sig")):
        arch = "aarch64" if machine.lower() in ("arm64", "aarch64") else "x64"
        suffix = ".app.tar.gz.sig" if name.endswith(".sig") else ".app.tar.gz"
        return f"Knightlight_{version}_{arch}{suffix}"
    return name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage-only", action="store_true")
    parser.add_argument("--force-workers", action="store_true")
    parser.add_argument("--bundles", help="Tauri bundle formats, e.g. deb,appimage / nsis / app,dmg")
    parser.add_argument("--use-exported-model", action="store_true", help="Validate/use portable model artifact without PyTorch")
    parser.add_argument("--public-release", action="store_true", help="Exclude the optional Lessac voice with unclear redistribution terms")
    args = parser.parse_args()
    stage(args.force_workers, args.use_exported_model, args.public_release)
    if args.stage_only:
        return
    npm = "npm.cmd" if os.name == "nt" else "npm"
    options = ["--bundles", args.bundles] if args.bundles else []
    # Restored Rust caches can contain installers from a previous version.
    # Never mix them into this release's manifest or checksums.
    bundle = ROOT / "src-tauri/target/release/bundle"
    if bundle.exists():
        shutil.rmtree(bundle)
    run(npm, "exec", "--", "tauri", "build", "--ci", *options)
    toolkit_source = None
    if args.public_release and sys.platform == "linux":
        appdirs = list(bundle.glob("appimage/*.AppDir"))
        if appdirs:
            run(sys.executable, ROOT / "scripts/collect-linux-sources.py", appdirs[0])
            toolkit_source = BUILD / "linux-toolkit-sources.tar.gz"
    output = ROOT / "dist" / f"{sys.platform}-{os.uname().machine if hasattr(os, 'uname') else os.environ.get('PROCESSOR_ARCHITECTURE', 'unknown')}"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)
    for pattern in ["**/*.deb", "**/*.AppImage", "**/*.rpm", "**/*.dmg", "**/*-setup.exe", "**/*.msi", "**/*.sig", "**/*.app.tar.gz"]:
        for artifact in bundle.glob(pattern):
            machine = os.uname().machine if hasattr(os, 'uname') else os.environ.get('PROCESSOR_ARCHITECTURE', 'unknown')
            version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
            copy(artifact, output / release_artifact_name(artifact.name, sys.platform, machine, version))
    # Supply exact engine sources when setup-desktop.py built it (all clean CI builds).
    source = BUILD / "stockfish-source.tar.gz"
    if source.exists():
        copy(source, output / source.name)
    components = BUILD / "copyleft-component-sources.tar.gz"
    if args.public_release:
        if not components.is_file():
            raise SystemExit("Public releases require scripts/collect-release-sources.py first")
        copy(components, output / f"copyleft-component-sources-{output.name}.tar.gz")
    if toolkit_source is not None:
        copy(toolkit_source, output / toolkit_source.name)
    copy(ROOT / "docs/DESKTOP.md", output / "INSTALL.md")
    files = [p for p in output.iterdir() if p.is_file() and p.name != "SHA256SUMS"]
    (output / "SHA256SUMS").write_text("".join(f"{hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()}  {p.name}\n" for p in sorted(files)))
    print(f"Installers: {output}")


if __name__ == "__main__":
    main()
