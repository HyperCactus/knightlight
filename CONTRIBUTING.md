# Contributing

Bug reports, suggestions, documentation improvements, and pull requests are welcome through [GitHub](https://github.com/HyperCactus/knightlight/issues).

For a bug, include your operating system, Knightlight version, steps to reproduce, and what you expected. Relevant profile logs can help; remove personal information and do not upload your game library unless you intend to share it.

To develop locally, follow the [desktop build setup](docs/DESKTOP.md#build-from-source), then read the [development guide](docs/DEVELOPMENT.md). Keep changes focused and explain the resulting behaviour and how you verified it in your pull request.

Before submitting Rust changes, run:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
```

Run the relevant browser suites for interface changes and the desktop package checks for installer/runtime changes. Automated audio tests must stay silent: Chromium must launch with `--mute-audio`, verified before opening the app. Use disposable profiles, games, and progress; never test against a real user’s library or change their audio preferences to silence tests.

Original contributions are made under the project’s Apache 2.0 licence. Preserve the separate licences and notices for third-party code, models, and artwork. Do not commit personal game histories, model environments, cached audio, credentials, or signing keys.
