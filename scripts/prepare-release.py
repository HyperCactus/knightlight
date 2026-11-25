#!/usr/bin/env python3
"""Set one monotonic version in manifests and locks; used only in CI worktrees."""
import argparse
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def prepare(root, version):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected a numeric major.minor.patch version")
    for file in ["Cargo.toml", "src-tauri/Cargo.toml"]:
        path = root / file
        path.write_text(re.sub(r'^version = "[^"]+"', f'version = "{version}"', path.read_text(), count=1, flags=re.M))
    for file in ["Cargo.lock", "src-tauri/Cargo.lock"]:
        path = root / file
        path.write_text(re.sub(r'(name = "(?:chess-study|knightlight-desktop)"\nversion = ")[^"]+', lambda m: m[1] + version, path.read_text()))
    path = root / "src-tauri/tauri.conf.json"
    config = json.loads(path.read_text())
    config["version"] = version
    config["bundle"]["createUpdaterArtifacts"] = True
    path.write_text(json.dumps(config, indent=2) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    prepare(ROOT, parser.parse_args().version)
