#!/usr/bin/env python3
"""Copy an explicit public-source allowlist, never a user's library or dependencies."""
import argparse
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
FILES = ["Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "README.md", "LICENSE", "NOTICE", ".gitignore", ".gitattributes",
         "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json",
         "data/puzzle-bank.json", "data/public-puzzles.json", "data/bot-openings.json", "data/PUBLIC-PUZZLES.md"]
DIRECTORIES = ["src", "static", "scripts", "tests", "docs", "licenses", ".github", "data/openings", "src-tauri/src", "src-tauri/icons", "src-tauri/loading"]

def copy_source(destination):
    destination = destination.resolve()
    if destination == ROOT or ROOT.is_relative_to(destination):
        raise ValueError("Choose a separate staging directory")
    destination.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, path)
    for name in DIRECTORIES:
        shutil.copytree(ROOT / name, destination / name, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".env", "*.bak", "*.tmp", "node_modules"))
    for path in (ROOT / "reports").glob("*.md"):
        (destination / "reports").mkdir(exist_ok=True)
        shutil.copy2(path, destination / "reports" / path.name)
    # Notices are authored metadata, not the model assets under vendor/.
    for path in (ROOT / "vendor").glob("*-NOTICE.md"):
        (destination / "vendor").mkdir(exist_ok=True)
        shutil.copy2(path, destination / "vendor" / path.name)
    print(f"Public source staged in {destination}; no PGNs, profiles, keys, models or environments copied")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    copy_source(parser.parse_args().destination)
