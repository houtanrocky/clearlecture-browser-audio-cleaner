#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo 'Open http://localhost:4173 in Chrome or Edge'
python3 -m http.server 4173
