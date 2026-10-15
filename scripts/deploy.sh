#!/usr/bin/env bash
# Deploy the prebuilt site (web/, including web/engine build output) to Vercel.
# The Vercel project is NOT connected to Git on purpose: the engine and module
# bundles are build output that isn't committed, so a Git build has nothing to
# serve. Build first (build-modules.sh, build-engine.sh), then run this.
set -euo pipefail
cd "$(dirname "$0")/../web"
[ -f engine/schwung.wasm ] || { echo "web/engine is empty: run scripts/build-engine.sh first" >&2; exit 1; }
vercel deploy --prod --yes ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"}
