#!/usr/bin/env bash
# Lay out /data/UserData/schwung in build/vfs exactly as Schwung's
# scripts/build.sh lays out build/ for the device tarball (JS, fonts, assets,
# module manifests). Compiled pieces (chain dsp.so, module .so files) are added
# by build-engine.sh and build-modules.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="$ROOT/build/schwung"
D="$ROOT/build/vfs-base/data/UserData/schwung"
mkdir -p "$D"/{host/fonts,shared,shadow,modules,patches,presets/track_presets,config,bin} \
         "$ROOT/build/vfs-base/data/UserData/UserLibrary/Samples" "$ROOT/build/vfs-base/data/UserData/settings"
cd "$S"
PY="uv run -q --no-project --with pillow==11.3.0 python3"
$PY scripts/generate_font.py --deploy-png "$D/host/font.png" >/dev/null
for size in 5x9 6x12 7x13 7x14 8x15 8x16 10x20; do
  h=${size#*x}
  $PY scripts/generate_font.py --bdf "fonts/tamzen/Tamzen${size}r.bdf" --deploy-png "$D/host/fonts/tamzen-${h}.png" >/dev/null
done
cp src/shared/*.mjs "$D/shared/"; cp src/shared/*.json "$D/shared/" 2>/dev/null || true
for d in src/shared/*/; do p=$(basename "$d"); mkdir -p "$D/shared/$p"; cp "$d"*.mjs "$D/shared/$p/" 2>/dev/null || true; cp "$d"*.json "$D/shared/$p/" 2>/dev/null || true; done
cp src/host/menu_ui.js "$D/host/"; cp src/host/*.mjs "$D/host/" 2>/dev/null || true
cp assets/*.png "$D/host/" 2>/dev/null || true
cp src/shadow/shadow_ui.js src/shadow/*.mjs "$D/shadow/"
echo "schwung-wasm $(git -C "$ROOT/third_party/schwung" rev-parse --short HEAD)" > "$D/host/version.txt"
find src/modules -type f \( -name "*.js" -o -name "*.mjs" -o -name "*.json" -o -name "*.txt" \) \
  -not -path "*/splash-test/*" -not -path "*/text-test/*" -not -path "*/standalone-example/*" \
  -not -path "*/ui-test/*" -not -path "*/seq-test/*" -not -path "*/config-test/*" \
  -not -path "*/controller/*" -not -path "*/store/*" -not -path "*/sysex-test/*" -not -path "*/sysex_probe/*" \
  -not -path "*/widget-test/*" -not -path "*/gesture-test/*" -not -path "*/voice-poc/*" -not -path "*/rnbo-runner/*" \
  | while IFS= read -r f; do dest="$D/${f#src/}"; mkdir -p "$(dirname "$dest")"; cp "$f" "$dest"; done
cp src/patches/*.json "$D/patches/" 2>/dev/null || true
cp src/presets/track_presets/*.json "$D/presets/track_presets/" 2>/dev/null || true
du -sh "$ROOT/build/vfs-base" | cut -f1 | xargs echo "staged vfs:"
# The emulator never sends usage analytics: answer Schwung's first-run prompt "No".
echo 1 > "$D/analytics-prompted"
: > "$D/analytics-opt-out"
