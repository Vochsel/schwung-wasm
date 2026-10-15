#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.." && bash scripts/prepare.sh >/dev/null
mkdir -p build/probe
EM_CWD=build/schwung scripts/em bash -c 'emcc -O2 -sSIDE_MODULE=2 -pthread -include /w/compat/wasm_compat.h -Isrc -Isrc/host src/modules/chain/dsp/chain_*.c src/host/unified_log.c src/host/lane_store.c src/host/lane_serial.c src/host/lane_edit.c -o /w/build/probe/chain.wasm 2>&1 | grep -E "error|undefined" | head -30; ls -la /w/build/probe'
