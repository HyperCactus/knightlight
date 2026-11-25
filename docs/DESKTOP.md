# Install Knightlight

The desktop edition opens in its own window. Stockfish, Kokoro voices, the human opponent, and the offline puzzle bank are included. You do not need Rust, Node, Python, or a running browser to use an installer. It works offline after installation.

## Choose your installer

| System | File | Installation |
| --- | --- | --- |
| Windows 10/11, x64 | `Knightlight_*_x64-setup.exe` | Run the installer, then find **Knightlight** in Start. Installation is per user. If WebView2 is missing, its bundled bootstrapper needs internet once to install Microsoft's runtime. |
| macOS 14+, Apple Silicon | `Knightlight_*_aarch64.dmg` | Open the disk image and drag **Knightlight** to **Applications**. |
| macOS 14+, Intel | `Knightlight_*_x64.dmg` | Open the disk image and drag **Knightlight** to **Applications**. |
| Ubuntu 24.04+/Zorin 18+/Debian 13+, x64 | `Knightlight_*_amd64.deb` | Open it in your software installer, or run `sudo apt install ./Knightlight_*_amd64.deb`. Launch **Knightlight** from system search. |
| Other Linux, x64 | `Knightlight_*.AppImage` | Make it executable (`chmod +x Knightlight_*.AppImage`) and double-click it. Requires a compatible desktop Linux installation with GTK/WebKitGTK 4.1. |

[Download installers from GitHub Releases](https://github.com/HyperCactus/knightlight/releases/latest). Each successful build of `main` publishes a complete release for all four supported platforms, with checksums, signed updater packages and matching copyleft sources. Failed or partial builds are never promoted. Local builds place installers in `dist/<platform>-<architecture>/`.

Automatic updates are enabled by default. Windows, macOS and Linux AppImage editions check after startup and every six hours, download signed updates in the background, then install when you quit. Reopen the app to use the new version. The native **Knightlight** menu has **Check for updates**, an **Automatic updates** toggle, and the current update status. Turning updates off preserves that choice across launches. Linux DEB packages show when a release is available; download/install the newer DEB using your package manager. Use AppImage if you want automatic Linux updates. A failed/offline check leaves the installed app usable. Update failures are recorded in `desktop-updates.log` in your profile.

Updates follow successfully built releases from `origin/main`; installed applications do not need Git or compile source. Every updater package must have a valid signature from Knightlight's embedded public key, with a matching signed version. Release metadata uses HTTPS. Updates replace application files and retain the separate profile.

Updater signatures are enabled, but installers do not yet have Windows publisher certificates or Apple notarization. Windows may display its unknown-publisher prompt. For a macOS build you trust, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it. Public distribution with normal trusted installation needs the publisher's signing certificates and Apple notarization.

The shell uses your OS webview rather than shipping Chromium. Desktop Maia inference uses the same unchanged weights exported to ONNX; packaging checks its legal move probabilities against the original PyTorch model across 99 varied positions. PyTorch is used only during the build, and is excluded from the installer. Speech retains the existing Kokoro model and voices. The optional Lessac voice is omitted from public installers because its redistribution terms are unclear; existing local installations are untouched. The full offline package is substantially larger than the shell because it includes the unchanged neural voice and opponent model. CPU inference avoids CUDA downloads and does not require a GPU. Models stay on disk until needed; familiar opening replies work while the opponent warms up.

## Games, settings, and upgrades

Use **Game review → Import PGN** to import your games. Exports are saved in **Downloads**. The native **Knightlight → Open data folder** menu opens your writable profile:

- Windows: `%APPDATA%\app.knightlight.desktop\`
- macOS: `~/Library/Application Support/app.knightlight.desktop/`
- Linux: `~/.local/share/app.knightlight.desktop/` (or `$XDG_DATA_HOME/app.knightlight.desktop/`).

If startup fails, check `desktop-errors.log` in the profile before changing or deleting any data.

Your history, settings, progress, and audio cache are inside the profile's `data/` folder. Replacing/upgrading the application preserves this folder. Back it up separately. Uninstalling the application does not intentionally remove your profile.

To transfer **all existing browser-edition progress**, close both editions, open the desktop data folder and quit the desktop app, then copy the old workspace's `data/` folder and root `.pgn` files into that profile. Keep the original as a backup. This is optional; importing exported PGNs transfers games only. Personal data is never baked into an installer.

Repeated desktop launches focus the existing window. Closing the app stops its backend. **Knightlight → Open in browser** opens the same running session in your default browser; keep the desktop application open while using that option. The separate source-based web edition remains available on port 3000 and uses its existing workspace history.

## Build from source

Build on the OS and architecture being packaged. Install [Rust stable](https://rustup.rs/), [Node.js 24](https://nodejs.org/), and **Python 3.11**. On macOS install Xcode Command Line Tools (`xcode-select --install`). On Windows install Visual Studio C++ Build Tools with the Windows SDK, plus a MinGW-w64 GCC and GNU Make on PATH for Stockfish (MSYS2 works). Native prerequisites are documented by [Tauri](https://v2.tauri.app/start/prerequisites/).

On Ubuntu/Zorin/Debian, install build headers first:

```bash
sudo apt install build-essential libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf python3-venv gstreamer1.0-plugins-base gstreamer1.0-plugins-good
```

Then, from the repository (use `python3.11` instead of `python` if necessary):

```bash
npm ci
python scripts/setup-desktop.py
python scripts/build-desktop.py
```

Setup downloads pinned model revisions and compiles Stockfish 16 for the current architecture. The CI workflow exports and verifies the portable opponent once on Linux, then each OS checks 99 reference positions before packaging it. This avoids requiring PyTorch on Intel Macs, where recent PyTorch wheels are unavailable.

For a local **Intel Mac** build, download **Knightlight-opponent-model.tar.gz** from [Releases](https://github.com/HyperCactus/knightlight/releases/latest) and extract it into `vendor/maia-model/`. Then use:

```bash
python scripts/setup-desktop.py --use-exported-model
python scripts/build-desktop.py --use-exported-model
```

The same option works on other platforms if you already have that validated artifact. The packaged macOS minimum is 14 to match the current local speech runtime wheels.

Setup creates separate build environments in `vendor/`. Packaging freezes these into self-contained executables and collects an explicit resource allowlist. Nothing reads personal history during packaging. The Python environments are only build dependencies.

For redistributing a manually supplied `STOCKFISH` binary, supply its matching sources too. See [component notices](DESKTOP-NOTICES.md).

If `data/puzzle-bank.json` is absent from a fresh checkout, recreate the CC0 bank before packaging:

```bash
vendor/maia-env/bin/python -m pip install zstandard
vendor/maia-env/bin/python scripts/fetch_puzzles.py --limit 100000 --output data/puzzle-bank.json
```

For faster iteration, `python scripts/build-desktop.py --stage-only` freezes/stages resources without an installer, then `npm exec tauri dev` launches the native window. Worker builds are cached; use `--force-workers` after changing their dependencies. `--bundles deb` limits Linux packaging to the DEB installer.

Verification:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
python tests/desktop-package.py
python tests/desktop-window.py  # Linux; needs Xvfb
npm run test:backend-regressions
npm run test:preferences
```

The packaging test uses temporary profiles and synthesizes WAV files silently; it never plays audio or modifies your real games. Native window testing also needs an isolated profile (`KNIGHTLIGHT_PROFILE=/tmp/knightlight-test`) and muted webview audio. Never change the user's sound preferences to silence a test.

## Maintainer release setup

The public repository's **Desktop installers** workflow builds every push to `main` and can also be started manually. Release versions are `0.2.<workflow run number>` so rebuilds remain monotonic. `scripts/prepare-release.py` changes version metadata only in each disposable build checkout. Release tags point to the exact main commit being built.

The repository secret `TAURI_SIGNING_PRIVATE_KEY` must contain a Tauri updater private key matching `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Keep a secure backup: losing this key prevents existing clients from trusting new updates. Generate a different key for forks, change the endpoint and public key, and configure your own repository secret. Never commit private keys. The signing secret is exposed only to the native bundle step, and publication is gated on every native build and package check succeeding.

Local public bundles require corresponding sources and an explicitly supplied signing key:

```bash
vendor/speech-env/bin/python scripts/collect-release-sources.py
python scripts/prepare-release.py 0.2.1
# Set TAURI_SIGNING_PRIVATE_KEY privately in your shell/CI, then:
python scripts/build-desktop.py --public-release
```

See [component notices](DESKTOP-NOTICES.md) for licensing. Original source is Apache 2.0; compiled applications and bundled components retain their GPL/AGPL and other third-party terms.
