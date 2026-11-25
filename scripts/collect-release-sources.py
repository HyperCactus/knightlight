#!/usr/bin/env python3
"""Collect matching copyleft sources; run in the prepared native build environment."""
import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'build/desktop/corresponding-source'

def download(url, path):
    with urllib.request.urlopen(url, timeout=180) as response, path.open('wb') as file:
        shutil.copyfileobj(response, file)

def collect():
    if metadata.version('espeakng-loader') != '0.2.4' or metadata.version('piper-tts') != '1.8.0':
        raise RuntimeError('Update the pinned native source revisions before changing the speech runtime')
    OUT.mkdir(parents=True, exist_ok=True)
    records = []
    for name in ['chess', 'python-chess', 'piper-tts', 'phonemizer-fork', 'numpy']:
        dist = metadata.distribution(name)
        with urllib.request.urlopen(f'https://pypi.org/pypi/{name}/{dist.version}/json', timeout=60) as response:
            info = json.load(response)
        sources = [f for f in info['urls'] if f['packagetype'] == 'sdist']
        if not sources:
            raise RuntimeError(f'Missing upstream source for {name} {dist.version}')
        source = sources[0]
        target = OUT / source['filename']
        download(source['url'], target)
        import hashlib
        if hashlib.sha256(target.read_bytes()).hexdigest() != source['digests']['sha256']:
            raise RuntimeError('Source hash mismatch')
        records.append(f'{name} {dist.version}: {source["url"]}')
    # espeakng-loader 0.2.4 has no PyPI sdist. Its tagged source pins
    # espeak-ng as a git submodule; GitHub tarballs do not include submodules.
    for name, repo, revision in [
        ('espeakng-loader-0.2.4', 'thewh1teagle/espeakng-loader', '0ddc87adf77e5850d7eeb542ac8a87d421b64daa'),
        ('espeak-ng-loader-native', 'espeak-ng/espeak-ng', '4870adfa25b1a32b4361592f1be8a40337c58d6c'),
        ('piper-1.8.0', 'OHF-Voice/piper1-gpl', 'v1.8.0'),
        ('espeak-ng-piper-native', 'espeak-ng/espeak-ng', '724808c'),
    ]:
        url = f'https://codeload.github.com/{repo}/tar.gz/{revision}'
        download(url, OUT / f'{name}.tar.gz')
        records.append(f'{name}: {url}')
    for name, version in [('shakmaty','0.29.4'), ('pgn-reader','0.28.0')]:
        download(f'https://static.crates.io/crates/{name}/{name}-{version}.crate', OUT / f'{name}-{version}.crate')
        records.append(f'{name} {version}: https://crates.io/crates/{name}/{version}')
    (OUT / 'SOURCE-INDEX.txt').write_text('\n'.join(records)+'\n')
    target = ROOT / 'build/desktop/copyleft-component-sources.tar.gz'
    with tarfile.open(target,'w:gz') as archive:
        archive.add(OUT, arcname='corresponding-source')
        archive.add(ROOT / 'licenses',arcname='licenses')
    print(target)

if __name__ == '__main__': collect()
