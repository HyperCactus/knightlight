#!/usr/bin/env python3
"""Supply exact Ubuntu source archives for the shared libraries in an AppImage."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import time
from urllib.parse import quote
import urllib.request

ROOT = Path(__file__).resolve().parents[1]

def source_files(dsc):
    files = []
    active = False
    for line in dsc.splitlines():
        if line == 'Checksums-Sha256:': active = True; continue
        if not active: continue
        if not line.startswith(' '): break
        digest, size, name = line.split()
        if not re.fullmatch(r'[a-f0-9]{64}', digest) or Path(name).name != name or name.startswith('.'):
            raise ValueError('Unsafe source archive entry')
        files.append((digest, int(size), name))
    if not files: raise ValueError('Source descriptor has no SHA256 file list')
    return files

def download(url, destination):
    if destination.exists(): return
    for attempt in range(3):
        try:
            temp = destination.with_name(destination.name + '.tmp')
            with urllib.request.urlopen(url, timeout=180) as response, temp.open('wb') as file:
                import shutil
                shutil.copyfileobj(response, file)
            temp.replace(destination)
            return
        except OSError as error:
            if attempt == 2: raise RuntimeError(f"Source download failed: {url}") from error
            time.sleep(1 + attempt)

def collect(appdir):
    libraries = {}
    worker_libraries = []
    worker_names = {p.name for p in appdir.rglob('*') if p.is_file() and '.so' in p.name and 'resources' in p.parts}
    packages = set()
    for file in (appdir / 'usr/lib').rglob('*'):
        if '.so' not in file.name or not file.is_file() or 'resources' in file.parts: continue
        if file.name in libraries: continue
        result = subprocess.run(['dpkg-query', '-S', '*/' + file.name], capture_output=True, text=True)
        owners = sorted({owner for line in result.stdout.splitlines() if ': ' in line
                         for owner in line.split(': ', 1)[0].split(', ')})
        if not owners:
            if file.name in worker_names:
                # linuxdeploy also copies wheel-provided libraries to usr/lib.
                # Their provider metadata/licenses are in resources/notices/python-runtime.
                worker_libraries.append(file.name)
                continue
            raise RuntimeError('No Ubuntu source owner for ' + file.name)
        libraries[file.name] = owners
        packages.update(owners)
    sources = set()
    for package in sorted(packages):
        output = subprocess.check_output(['dpkg-query', '-W', '-f=${source:Package}\t${source:Version}\n', package], text=True)
        for line in output.splitlines():
            name, version = line.split('\t')
            sources.add((name, version))
    destination = ROOT / 'build/desktop/linux-toolkit-source'
    destination.mkdir(parents=True, exist_ok=True)
    def fetch(item):
        name, version = item
        folder = destination / re.sub(r'[^a-zA-Z0-9_.+-]', '_', name + '_' + version)
        folder.mkdir(exist_ok=True)
        archive = '~zorinos/+archive/ubuntu/stable' if '+zorin' in version else 'ubuntu/+archive/primary'
        base = f'https://launchpad.net/{archive}/+sourcefiles/{quote(name, safe="")}/{quote(version, safe="")}/'
        filename = f'{name}_{version.split(":")[-1]}.dsc'
        dsc = folder / filename
        download(base + quote(filename, safe=''), dsc)
        records = source_files(dsc.read_text())
        for digest, size, filename in records:
            target = folder / filename
            download(base + quote(filename, safe=''), target)
            with target.open('rb') as stream:
                if target.stat().st_size != size or hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
                    target.unlink()
                    raise RuntimeError('Source checksum mismatch: ' + filename)
        print(f'Corresponding toolkit source: {name} {version}', flush=True)
        return {'name': name, 'version': version, 'url': base}
    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(fetch, sorted(sources)))
    (destination / 'SOURCE-INDEX.json').write_text(json.dumps({'libraries': libraries, 'sources': records, 'wheel_provided_libraries': sorted(worker_libraries)}, indent=2)+'\n')
    (destination / 'README.txt').write_text('Matching Ubuntu sources for AppImage native libraries. Each source directory contains its signed .dsc, original source and distribution patches. Use dpkg-source -x <file.dsc> to unpack, and the included debian/rules to rebuild. Tauri 2 packaging relocates WebKit helper paths for AppImage; Knightlight source and build scripts are supplied in the release source tag. Installed copyright/license texts remain in the AppImage usr/share/doc/.\n')
    archive = ROOT / 'build/desktop/linux-toolkit-sources.tar.gz'
    with tarfile.open(archive, 'w:gz', compresslevel=1) as package:
        package.add(destination, arcname='linux-toolkit-source')
    print(f'{len(sources)} exact toolkit sources: {archive}', flush=True)
    return archive

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('appdir', type=Path)
    collect(parser.parse_args().appdir)
