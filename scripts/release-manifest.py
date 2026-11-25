#!/usr/bin/env python3
"""Validate a complete signed release and generate Tauri's platform manifest."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import quote

PLATFORMS = {
    "linux-x86_64": "*.AppImage",
    "windows-x86_64": "*_x64-setup.exe",
    "darwin-x86_64": "*_x64.app.tar.gz",
    "darwin-aarch64": "*_aarch64.app.tar.gz",
}

def verify_signature(file, signature, pubkey, version):
    # Minisign's format: Ed25519 over a BLAKE2b-512 digest, plus a signed
    # trusted comment. The latter binds the artifact to its release version.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    key_lines = base64.b64decode(pubkey, validate=True).decode().splitlines()
    key = base64.b64decode(key_lines[1], validate=True)
    lines = base64.b64decode(signature, validate=True).decode().splitlines()
    if len(lines) != 4 or not lines[2].startswith('trusted comment: '):
        raise ValueError('Invalid Minisign signature format')
    raw = base64.b64decode(lines[1], validate=True)
    if len(key) != 42 or len(raw) != 74 or key[:2] != b'Ed' or raw[:2] != b'ED' or key[2:10] != raw[2:10]:
        raise ValueError('Unexpected signing key or algorithm')
    trusted = lines[2][17:]
    if f'version:{version}' not in trusted.split('\t'):
        raise ValueError('Signed version does not match release')
    verifier = Ed25519PublicKey.from_public_bytes(key[10:])
    with file.open('rb') as stream:
        digest = hashlib.file_digest(stream, lambda: hashlib.blake2b(digest_size=64)).digest()
    verifier.verify(raw[10:], digest)
    verifier.verify(base64.b64decode(lines[3], validate=True), raw[10:] + trusted.encode())

def manifest(directory, version, repo, commit, pubkey=None):
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Invalid version")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
        raise ValueError("Invalid repository")
    platforms = {}
    for platform, pattern in PLATFORMS.items():
        matches = list(directory.glob(pattern))
        if len(matches) != 1:
            raise ValueError(f"Expected one {platform} artifact, found {matches}")
        file = matches[0]
        signature = file.with_name(file.name + ".sig").read_text().strip()
        decoded = base64.b64decode(signature, validate=True).decode()
        comment = next((line for line in decoded.splitlines() if line.startswith("trusted comment:")), "")
        if f"version:{version}" not in comment.removeprefix("trusted comment: ").split("\t"):
            raise ValueError(f"{file.name}: signature must bind version {version}: {comment}")
        if pubkey is not None:
            verify_signature(file, signature, pubkey, version)
        platforms[platform] = {"signature": signature, "url": f"https://github.com/{repo}/releases/download/v{version}/{quote(file.name)}"}
    return {"version": version, "notes": f"Knightlight built from main commit {commit}. Updates install when you quit; games and settings are preserved.",
            "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "platforms": platforms}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    config = json.loads((Path(__file__).resolve().parents[1] / "src-tauri/tauri.conf.json").read_text())
    result = manifest(args.directory, args.version, args.repo, args.commit, config["plugins"]["updater"]["pubkey"])
    (args.directory / "latest.json").write_text(json.dumps(result, indent=2) + "\n")
    files = sorted(p for p in args.directory.iterdir() if p.is_file() and p.name != "SHA256SUMS")
    (args.directory / "SHA256SUMS").write_text("".join(f"{hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()}  {p.name}\n" for p in files))
    print(f"Validated {len(result['platforms'])} signed platform packages for {args.version}")
