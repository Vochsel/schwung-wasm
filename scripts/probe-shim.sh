#!/usr/bin/env bash
# Compile each shim translation unit separately and summarise errors.
cd "$(dirname "$0")/.." && bash scripts/prepare.sh >/dev/null
FILES=$(sed -n '/-o build\/schwung-shim.so/,/SHIM_TTS_SRC/p' build/schwung/scripts/build.sh | grep -oE 'src/[a-z_/]+\.c' | tr '\n' ' ')
EM_CWD=build/schwung scripts/em bash -c "
for f in $FILES src/host/tts_engine_stub.c src/shadow/shadow_ui.c; do
  out=\$(emcc -O1 -pthread -include /w/compat/wasm_compat.h -I/w/compat/include -Isrc -Isrc/host -Isrc/lib -Ilibs/quickjs/quickjs-2025-04-26 -D_GNU_SOURCE -DENABLE_SCREEN_READER=0 -c \$f -o /tmp/o.o 2>&1 | grep -E 'error:')
  n=\$(echo -n \"\$out\" | grep -c error:)
  [ \$n -gt 0 ] && { echo \"== \$f (\$n)\"; echo \"\$out\" | head -${SHOW:-4}; }
done; echo done"
