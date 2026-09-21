#!/usr/bin/env bash
# Render ffmpeg ground truth, then measure the preview pipeline against it.
# Needs a vite dev server on 5199 (npx vite --port 5199) and chromium.
# Usage: scripts/preview-parity/run.sh [dump=case1,case2]
set -euo pipefail
cd "$(dirname "$0")/../.."
(cd src-tauri && cargo test --quiet preview_parity_fixtures -- --ignored >/dev/null)
chromium --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader \
  --virtual-time-budget=60000 --dump-dom \
  "http://localhost:5199/scripts/preview-parity/index.html?${1:-}" 2>/dev/null \
  | sed -n '/<pre/,/<\/pre>/p' | sed -e 's/<[^>]*>//g' -e 's/&gt;/>/g'
