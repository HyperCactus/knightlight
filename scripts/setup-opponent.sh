#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=1e13597c42d4858b7cfd7cfdae01e297263364b2
if [[ ! -d vendor/maia3 ]]; then
  git clone https://github.com/CSSLab/maia3.git vendor/maia3
  git -C vendor/maia3 checkout --detach "$revision"
fi
uv venv --python 3.11 --allow-existing vendor/maia-env
uv pip install --python vendor/maia-env/bin/python 'torch==2.15.0+cpu' --index-url https://download.pytorch.org/whl/cpu
uv pip install --python vendor/maia-env/bin/python -e vendor/maia3
hf download UofTCSSLab/Maia3-5M maia3-5m.pt README.md --local-dir vendor/maia-model
