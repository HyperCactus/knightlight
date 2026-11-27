"""Release contracts: versioning, complete manifests, and private-library exclusion."""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

release = module('release-manifest')
prepare = module('prepare-release')
public = module('public-source')
setup = module('setup-desktop')
build = module('build-desktop')
linux_sources = module('collect-linux-sources')

class Publishing(unittest.TestCase):
    def test_native_library_owners_ignore_diversions_and_unrelated_sdks(self):
        from unittest.mock import patch
        listing = '\n'.join([
            'diversion by libreadline8t64 from: /usr/lib/libreadline.so.8',
            'nsight-compute: /opt/cuda/libreadline.so.8',
            'libreadline8t64:amd64: /usr/lib/libreadline.so.8',
        ])
        with patch.object(Path, 'is_file', return_value=True), patch.object(linux_sources, 'build_id', side_effect=lambda p: 'sdk' if str(p).startswith('/opt/') else 'system'):
            self.assertEqual(linux_sources.library_owners(Path('/app/libreadline.so.8'), listing), ['libreadline8t64:amd64'])

    def test_native_source_descriptors_reject_unsafe_paths(self):
        prefix = 'Checksums-Sha256:\n ' + 'a' * 64 + ' 10 '
        self.assertEqual(linux_sources.source_files(prefix + 'source.tar.xz\nOther: value')[0][2], 'source.tar.xz')
        for name in ['../private', '/absolute', '.hidden']:
            with self.assertRaises(ValueError): linux_sources.source_files(prefix + name)

    def test_mac_update_assets_have_distinct_architecture_urls(self):
        for machine, arch in [('arm64', 'aarch64'), ('x86_64', 'x64')]:
            for suffix in ['.app.tar.gz', '.app.tar.gz.sig']:
                self.assertEqual(build.release_artifact_name('Knightlight' + suffix, 'darwin', machine, '0.2.3'), f'Knightlight_0.2.3_{arch}{suffix}')
        self.assertEqual(build.release_artifact_name('Knightlight.AppImage.sig', 'linux', 'x86_64', '0.2.3'), 'Knightlight.AppImage.sig')

    def test_engine_architecture_uses_apples_supported_target(self):
        self.assertEqual(setup.engine_arch('darwin', 'arm64'), 'apple-silicon')
        self.assertEqual(setup.engine_arch('darwin', 'x86_64'), 'x86-64')
        self.assertEqual(setup.engine_arch('linux', 'aarch64'), 'armv8')
        self.assertEqual(setup.engine_arch('win32', 'AMD64'), 'x86-64')

    def test_complete_manifest_and_version_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            artifacts = ['Knightlight_9.0.0_amd64.AppImage', 'Knightlight_9.0.0_x64-setup.exe',
                         'Knightlight_x64.app.tar.gz', 'Knightlight_aarch64.app.tar.gz']
            signature = (ROOT / 'tests/fixtures/updater/payload.sig').read_text()
            for name in artifacts:
                (path / name).write_bytes((ROOT / 'tests/fixtures/updater/payload').read_bytes())
                (path / (name + '.sig')).write_text(signature)
            result = release.manifest(path, '9.0.0', 'HyperCactus/knightlight', 'abc123')
            self.assertEqual(set(result['platforms']), set(release.PLATFORMS))
            self.assertTrue(all('/v9.0.0/' in p['url'] for p in result['platforms'].values()))
            with self.assertRaises(ValueError):
                release.manifest(path, '9.0.1', 'HyperCactus/knightlight', 'abc123')
            (path / artifacts[0]).unlink()
            with self.assertRaises(ValueError):
                release.manifest(path, '9.0.0', 'HyperCactus/knightlight', 'abc123')

    def test_real_signatures_and_tampering(self):
        from cryptography.exceptions import InvalidSignature
        fixture = ROOT / 'tests/fixtures/updater'
        signature = (fixture / 'payload.sig').read_text().strip()
        key = (fixture / 'test-public-key').read_text().strip()
        release.verify_signature(fixture / 'payload', signature, key, '9.0.0')
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / 'changed'
            changed.write_bytes(b'changed payload')
            with self.assertRaises(InvalidSignature):
                release.verify_signature(changed, signature, key, '9.0.0')
        decoded = base64.b64decode(signature).decode().replace('version:9.0.0','version:9.0.1')
        with self.assertRaises(InvalidSignature):
            release.verify_signature(fixture / 'payload', base64.b64encode(decoded.encode()).decode(), key, '9.0.1')

    def test_public_tree_excludes_personal_data_and_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            public.copy_source(path)
            files = [str(p.relative_to(path)) for p in path.rglob('*') if p.is_file()]
            self.assertFalse(any(p.endswith('.pgn') for p in files))
            # Public source must be able to reproduce the installer artwork and docs.
            for required in ['CONTRIBUTING.md', 'src-tauri/installer/macos-background.png', 'src-tauri/installer/windows-sidebar.bmp', 'docs/screenshots/training.png']:
                self.assertIn(required, files)
            self.assertFalse(any(p.startswith(('.secrets/', 'build/', '.aws/', '.codex/', '.agents/')) for p in files))
            allowed = {'data/puzzle-bank.json', 'data/public-puzzles.json', 'data/bot-openings.json', 'data/PUBLIC-PUZZLES.md'}
            self.assertTrue(all(p in allowed or p.startswith('data/openings/') for p in files if p.startswith('data/')))
            self.assertTrue(all(p.endswith('-NOTICE.md') for p in files if p.startswith('vendor/')))
            self.assertIn('src-tauri/src/updates.rs', files)
            self.assertIn('LICENSE', files)
            self.assertIn('tests/fixtures/updater/payload -text', (path / '.gitattributes').read_text())
            prepare.prepare(path, '0.2.123')
            for f in ['Cargo.toml', 'src-tauri/Cargo.toml']:
                self.assertIn('version = "0.2.123"', (path / f).read_text())
            import tomllib
            for f in ['Cargo.lock', 'src-tauri/Cargo.lock']:
                packages = tomllib.loads((path / f).read_text())['package']
                self.assertTrue(all(p['version'] == '0.2.123' for p in packages if p['name'] in ['chess-study','knightlight-desktop']))
            config = json.loads((path / 'src-tauri/tauri.conf.json').read_text())
            self.assertEqual(config['version'], '0.2.123')
            self.assertTrue(config['bundle']['createUpdaterArtifacts'])
            with self.assertRaises(ValueError):
                prepare.prepare(path, '../invalid')

if __name__ == '__main__': unittest.main()
