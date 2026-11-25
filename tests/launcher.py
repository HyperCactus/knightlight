"""Exercise desktop installation and startup without opening an audible browser."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

launch = module('launch', 'launch.py')
install = module('install', 'install-desktop.py')

class LauncherTests(unittest.TestCase):
    def test_start_reuse_and_workspace_identity(self):
        with tempfile.TemporaryDirectory(prefix='knightlight-launch-') as tmp:
            project = Path(tmp)
            (project / 'target/release').mkdir(parents=True)
            (project / 'target/release/chess-study').symlink_to(ROOT / 'target/release/chess-study')
            (project / 'static').symlink_to(ROOT / 'static')
            with socket.socket() as available:
                available.bind(('127.0.0.1', 0))
                port = available.getsockname()[1]
            launcher = launch.Launcher(project, port, project / 'state')
            try:
                self.assertEqual(launcher.start(timeout=20), launcher.url)
                self.assertTrue(launcher.healthy())
                second = launch.Launcher(project, port, project / 'state')
                self.assertEqual(second.start(timeout=3), launcher.url)
                self.assertIsNone(second.child, 'A second click must reuse the server')
                wrong_project = launch.Launcher(ROOT, port, project / 'other-state')
                self.assertFalse(wrong_project.healthy())
                with self.assertRaisesRegex(RuntimeError, 'another app'):
                    wrong_project.start(timeout=3)
                self.assertIsNone(launcher.child.poll(), 'Never kill a conflicting service')
            finally:
                if launcher.child is not None:
                    launcher.child.terminate()
                    launcher.child.wait(timeout=10)

    def test_malformed_health_is_not_our_app(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'[]')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                self.assertFalse(launch.Launcher(ROOT, server.server_port, tmp).healthy())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_default_browser_handler(self):
        # Verify the actual command without opening the user's browser or speakers.
        with patch.object(launch.subprocess, 'run') as run:
            launch.open_browser('http://127.0.0.1:3000')
        run.assert_called_once_with(['xdg-open', 'http://127.0.0.1:3000'], check=True, timeout=30)

    def test_isolated_desktop_install(self):
        with tempfile.TemporaryDirectory(prefix='knightlight install ') as tmp:
            home = Path(tmp)
            with patch.multiple(install, HOME=home, DATA=home / 'share', CONFIG=home / 'config', BIN=home / 'bin'), patch.object(install.shutil, 'which', return_value=None):
                install.main()
            entry = home / 'share/applications/knightlight.desktop'
            desktop = home / 'Desktop/Knightlight.desktop'
            subprocess.run(['desktop-file-validate', str(entry), str(desktop)], check=True)
            text = entry.read_text()
            self.assertIn('Name=Knightlight\n', text)
            self.assertIn('Keywords=chess;', text)
            self.assertIn(f'Exec="{home}/bin/knightlight"', text)
            self.assertTrue(os.access(home / 'bin/knightlight', os.X_OK))
            self.assertTrue((home / 'share/icons/hicolor/512x512/apps/knightlight.png').is_file())
            unit = (home / 'config/systemd/user/knightlight.service').read_text()
            self.assertIn('WorkingDirectory=' + str(ROOT) + '\n', unit)
            self.assertNotIn('[Install]', unit, 'Do not start automatically at login')
            subprocess.run(['systemd-analyze', '--user', 'verify', str(home / 'config/systemd/user/knightlight.service')], check=True)

if __name__ == '__main__':
    unittest.main(verbosity=2)
