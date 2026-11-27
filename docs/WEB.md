# Browser edition

The desktop app is the simplest way to use Knightlight. Its **Knightlight → Open in browser** menu opens the same running session in your default browser. Keep the desktop app open while using that window.

## Run the standalone web server

For a source checkout, first follow the [desktop build setup](DESKTOP.md#build-from-source) to install Rust, Stockfish, and the local models. Then run from the repository:

```bash
cargo run --release
```

Open **http://127.0.0.1:3000** and keep the server running. This edition stores its data in the workspace’s `data/` folder and is separate from the installed desktop profile. Import PGNs through Game review, or place `.pgn` files in the repository root before startup. `CHESS_PLAYER='YourName' cargo run --release` overrides automatic player-name detection. `PORT=3001` selects another port.

The optional Linux shortcut installer (`python3 scripts/install-desktop.py`) creates a browser launcher and user service for a prepared source checkout. It is not needed for the native desktop app.

## Mobile home-screen icon

The interface includes icons and a web manifest for **Add to Home Screen**. This adds a shortcut, not an offline mobile app. The server binds only to localhost by default; reaching it from another device requires a separately configured deployment.

See the [user guide](USER-GUIDE.md) for controls and the [desktop guide](DESKTOP.md#games-settings-and-upgrades) for transferring an existing browser library.
