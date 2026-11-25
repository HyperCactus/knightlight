#!/usr/bin/env python3
"""Recreate native packaging dependencies and model assets (Python 3.11)."""
import argparse
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build/desktop"
REVISION = "1e13597c42d4858b7cfd7cfdae01e297263364b2"


def run(*args, cwd=ROOT):
    print("+", *map(str, args), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)


def environment(name):
    directory = ROOT / f"vendor/{name}-env"
    executable = directory / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not executable.exists():
        venv.EnvBuilder(with_pip=True).create(directory)
    return executable


def extract(url, target):
    archive = BUILD / (target.name + ".tar.gz")
    if not archive.exists():
        with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
    if not target.exists():
        temp = BUILD / (target.name + "-extract")
        temp.mkdir(exist_ok=True)
        with tarfile.open(archive) as package:
            package.extractall(temp, filter="data")
        shutil.move(str(next(temp.iterdir())), target)
        temp.rmdir()
    return archive


def engine_arch(system, machine):
    if machine.lower() in ("arm64", "aarch64"):
        return "apple-silicon" if system == "darwin" else "armv8"
    return "x86-64"


def stockfish():
    source = BUILD / "stockfish-source"
    archive = extract("https://codeload.github.com/official-stockfish/Stockfish/tar.gz/refs/tags/sf_16", source)
    # Keep complete matching source alongside the distributable, including its NNUE net.
    executable = source / "src" / ("stockfish.exe" if os.name == "nt" else "stockfish")
    if not executable.exists():
        arch = engine_arch(sys.platform, platform.machine())
        compiler = "mingw" if os.name == "nt" else "clang" if sys.platform == "darwin" else "gcc"
        make = shutil.which("make") or shutil.which("mingw32-make")
        if not make:
            raise SystemExit("Install GNU Make and a native C++ compiler first (see docs/DESKTOP.md).")
        options = ["CXX=g++"] if os.name == "nt" else []
        run(make, f"-j{min(os.cpu_count() or 2, 8)}", "build", f"ARCH={arch}", f"COMP={compiler}", *options, cwd=source / "src")
        run(make, "strip", f"COMP={compiler}", cwd=source / "src")
    with tarfile.open(archive, "w:gz") as package:
        package.add(source, arcname="stockfish-source", filter=lambda info: None if Path(info.name).name in ("stockfish", "stockfish.exe") or info.name.endswith((".o", ".d")) else info)
    dest = ROOT / ("vendor/stockfish/usr/games/stockfish.exe" if os.name == "nt" else "vendor/stockfish/usr/games/stockfish")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(executable, dest)


def main():
    if sys.platform == "darwin":
        # Stockfish is built before Tauri runs; give its compiler the same minimum OS.
        os.environ.setdefault("MACOSX_DEPLOYMENT_TARGET", "14.0")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine-only", action="store_true")
    parser.add_argument("--model-only", action="store_true", help="Prepare export dependencies only")
    parser.add_argument("--use-exported-model", action="store_true", help="Use the validated portable model artifact; no PyTorch needed")
    args = parser.parse_args()
    BUILD.mkdir(parents=True, exist_ok=True)
    if not args.engine_only:
        if sys.version_info[:2] != (3, 11):
            raise SystemExit("Use Python 3.11 to build the bundled workers.")
        speech = environment("speech") if not args.model_only else None
        maia = environment("maia") if not args.use_exported_model else None
        tools = environment("desktop-tools")
        run(tools, "-m", "pip", "install", "huggingface-hub", "numpy", "pillow")
        if not args.model_only:
            run(speech, "-m", "pip", "install", "piper-tts==1.8.0", "kokoro-onnx==0.4.9", "soundfile==0.13.1", "python-chess", "pyinstaller==6.22.3")
        source = ROOT / "vendor/maia3"
        extract(f"https://codeload.github.com/CSSLab/maia3/tar.gz/{REVISION}", source)
        if not args.use_exported_model:
            if sys.platform == "darwin" and platform.machine().lower() == "x86_64":
                raise SystemExit("Intel Mac builds need the validated model artifact; see docs/DESKTOP.md and use --use-exported-model")
            torch = ["torch==2.6.0"]
            if sys.platform != "darwin":
                torch += ["--index-url", "https://download.pytorch.org/whl/cpu"]
            run(maia, "-m", "pip", "install", *torch)
            run(maia, "-m", "pip", "install", str(source), "onnx", "onnxscript", "onnxruntime")
        hf = tools.parent / ("hf.exe" if os.name == "nt" else "hf")
        for repo, revision, directory, files in [
            ("onnx-community/Kokoro-82M-v1.0-ONNX", "1939ad2a8e416c0acfeecc08a694d14ef25f2231", "kokoro", ["onnx/model_quantized.onnx", "voices/af_heart.bin", "voices/am_michael.bin", "voices/bf_emma.bin", "README.md"]),
            ("hexgrad/Kokoro-82M", "f3ff3571791e39611d31c381e3a41a3af07b4987", "kokoro/original", ["README.md", "VOICES.md"]),
            ("rhasspy/piper-voices", "e7229f7d33a10e145e109b886d661984201ac3c4", "voices", ["en/en_US/lessac/medium/en_US-lessac-medium.onnx", "en/en_US/lessac/medium/en_US-lessac-medium.onnx.json", "en/en_US/lessac/medium/MODEL_CARD"]),
            ("UofTCSSLab/Maia3-5M", "b6559de2398d7140b985f28fd2c19fb5e47ddabe", "maia-model", ["maia3-5m.pt", "README.md"]),
        ]:
            if args.model_only and directory != "maia-model":
                continue
            if args.use_exported_model and directory == "maia-model":
                files = ["README.md"]
            run(hf, "download", repo, *files, "--revision", revision, "--local-dir", ROOT / "vendor" / directory)
        if not args.model_only:
            run(tools, "-c", "from pathlib import Path; import numpy as np; r=Path('vendor/kokoro'); np.savez(r/'voices.npz', **{p.stem:np.fromfile(p,dtype=np.float32).reshape(-1,1,256) for p in (r/'voices').glob('*.bin')})")
            license_file = ROOT / "vendor/kokoro/original/LICENSE"
            with urllib.request.urlopen("https://www.apache.org/licenses/LICENSE-2.0.txt", timeout=30) as response:
                license_file.write_bytes(response.read())
    if not args.model_only:
        stockfish()


if __name__ == "__main__":
    main()
