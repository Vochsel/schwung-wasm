#!/usr/bin/env bash
# Copy the pinned Schwung source into build/schwung and apply patches/apply.py.
# The submodule is never modified; edit patches/apply.py, not build/schwung.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/build/schwung"
rsync -a --delete --exclude .git "$ROOT/third_party/schwung/" "$ROOT/build/schwung/"
python3 "$ROOT/patches/apply.py" "$ROOT/build/schwung"
