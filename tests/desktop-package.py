"""Offline package smoke test. No browser, speakers, real history, or external network."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "src-tauri/resources"
manifest = json.loads((RESOURCES / "manifest.json").read_text())
for name, record in manifest.items():
    path = RESOURCES / name
    assert path.is_file(), name
    with path.open("rb") as file:
        assert hashlib.file_digest(file, "sha256").hexdigest() == record["sha256"], name
    if name.startswith("data/"):
        assert name in ("data/puzzle-bank.json", "data/public-puzzles.json") or name.startswith("data/openings/"), name
assert not any(name.endswith((".pgn", ".pt")) or "/torch/" in name for name in manifest)
binary = RESOURCES / "workers/coach-runtime" / ("coach-runtime.exe" if os.name == "nt" else "coach-runtime")
engine = RESOURCES / "bin" / ("stockfish.exe" if os.name == "nt" else "stockfish")


def worker(mode, requests, directory):
    # Python/Rust are deliberately absent from PATH: these must be native frozen workers.
    env = {**os.environ, "KNIGHTLIGHT_RESOURCES": str(RESOURCES), "HF_HUB_OFFLINE": "1", "PATH": os.environ.get("SystemRoot", "") + ("\\System32" if os.name == "nt" else "/usr/bin:/bin")}
    result = subprocess.run([str(binary), mode], input="".join(json.dumps(r) + "\n" for r in requests),
                            text=True, capture_output=True, cwd=directory, env=env, timeout=120)
    assert result.returncode == 0, result.stderr[-5000:]
    replies = []
    for line in result.stdout.splitlines():
        try: replies.append(json.loads(line))
        except json.JSONDecodeError: pass
    assert len(replies) == len(requests), (replies, result.stderr[-5000:])
    assert not any("error" in r for r in replies), replies
    return replies


with tempfile.TemporaryDirectory(prefix="knightlight-package-") as directory:
    fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
    replies = worker("opponent", [{"fen": fen, "moves": [], "rating": r} for r in [400, 1200, 2400]], directory)
    for response in replies:
        assert len(response["candidates"]) == 12
        assert all(0 < c["probability"] <= 1 for c in response["candidates"])
    assert replies[0]["candidates"] != replies[-1]["candidates"], "Elo conditioning lost"
    voices = ["af_heart", "am_michael", "bf_emma"]
    if (RESOURCES / "vendor/voices/en/en_US/lessac/medium").exists():
        voices.append("piper")
    voice = worker("speech", [{"text": "Your move.", "voice": v} for v in voices], directory)
    for result in voice:
        wav = Path(directory) / "data/audio" / result["url"].split("/")[-1]
        assert wav.read_bytes()[:4] == b"RIFF" and wav.stat().st_size > 1000, result
    env = {**os.environ}
    # PyInstaller on Linux sets no environment in this parent process. Engines
    # run from an unrelated writable profile with no workspace-relative paths.
    result = subprocess.run([str(engine)], input="uci\nisready\nquit\n", cwd=directory,
                            capture_output=True, text=True, env=env, timeout=20)
    assert result.returncode == 0 and "uciok" in result.stdout and "readyok" in result.stdout, result.stderr
print(f"PASS: {len(manifest)} resource checksums; no personal data or PyTorch; standalone Elo-conditioned opponent; {len(voices)} voices synthesized silently; Stockfish UCI ready")
