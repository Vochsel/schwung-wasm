#!/usr/bin/env bash
# Build the engine: Schwung's shim + shadow UI + QuickJS + engine/ glue as one
# Emscripten pthreads program (web/engine/schwung.{js,wasm,data}), plus the
# chain host and Schwung's built-in modules as side modules the shim dlopens
# from the virtual FS at their device paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bash scripts/prepare.sh
bash scripts/stage-vfs.sh
mkdir -p build/vfs/data/UserData/schwung/modules
OPT="${OPT:--O2}"
mkdir -p build/obj web/engine
EM_CWD=build/schwung OPT="$OPT" scripts/em bash -s <<'IN'
set -euo pipefail
OPT="${OPT:--O2}"
Q=libs/quickjs/quickjs-2025-04-26
OBJ=/w/build/obj
V=/w/build/vfs-base/data/UserData/schwung/modules
export CF="$OPT -g2 -pthread -fPIC -include /w/compat/wasm_compat.h -I/w/compat/include -Isrc -Isrc/host -Isrc/lib -I$Q -D_GNU_SOURCE -DENABLE_SCREEN_READER=0 -DCONFIG_VERSION=\"2025-04-26\" -sUSE_ZLIB=1 -Wno-unused-function -Wno-unused-variable -Wno-macro-redefined -Wno-implicit-const-int-float-conversion"
export OBJ
SRCS="src/schwung_shim.c src/lib/schwung_spi_lib.c src/host/shadow_sampler.c src/host/shadow_transport.c src/host/shadow_set_pages.c src/host/shadow_dbus.c src/host/shadow_metronome.c src/host/shadow_chain_mgmt.c src/host/shadow_scene_bus.c src/host/shadow_link_audio.c src/host/shadow_process.c src/host/shadow_resample.c src/host/shadow_overlay.c src/host/shadow_pin_scanner.c src/host/shadow_led_queue.c src/host/clip_state.c src/host/move_model.c src/host/move_model_sync.c src/host/step_menu.c src/host/move_info.c src/host/edit_follow.c src/host/edit_gesture.c src/host/undo_timeline.c src/host/shadow_state.c src/host/shadow_xmos_audio.c src/host/usbc_out_gate.c src/host/shadow_midi.c src/host/shadow_midi_filter.c src/host/shadow_overtake_midi.c src/host/unified_log.c src/host/shim_worker.c src/host/rt_thread_audit.c src/host/spi_tally.c src/host/align_capture.c src/host/lane_trace.c src/host/shadow_shm_util.c src/host/schwung_trace.c src/host/shadow_test_stream.c src/host/tts_engine_stub.c
src/host/js_display.c src/host/analytics.c src/host/js_host_common.c
$Q/quickjs.c $Q/dtoa.c $Q/libregexp.c $Q/libunicode.c $Q/cutils.c $Q/quickjs-libc.c
src/shadow/shadow_ui.c
$(ls /w/engine/*.c)"
rm -f $OBJ/*.o
echo "$SRCS" | tr ' ' '\n' | grep . | xargs -P 8 -I{} sh -c '
  f={}; o=$OBJ/$(echo $f | sed "s#^/w/##; s#/#_#g; s#\.c\$#.o#")
  extra=""; [ "$f" = src/shadow/shadow_ui.c ] && extra="-Dmain=shadow_ui_main"
  emcc $CF $extra -I/w/build/schwung/src -c $f -o $o'
# Side modules first: they are packaged into the preloaded FS by the link below.
SIDE="$OPT -pthread -sSIDE_MODULE=1 -fPIC -D_GNU_SOURCE -include /w/compat/wasm_compat.h -Isrc -Isrc/host"
emcc $SIDE src/modules/chain/dsp/chain_*.c src/host/unified_log.c src/host/lane_store.c src/host/lane_serial.c src/host/lane_edit.c -o $V/chain/dsp.so
emcc $SIDE src/modules/audio_fx/freeverb/freeverb.c -o $V/audio_fx/freeverb/freeverb.so
emcc $SIDE src/modules/midi_fx/chord/dsp/chord.c -o $V/midi_fx/chord/dsp.so
emcc $SIDE src/modules/midi_fx/arp/dsp/arp.c -o $V/midi_fx/arp/dsp.so
emcc $SIDE src/modules/sound_generators/linein/linein.c -o $V/sound_generators/linein/dsp.so
emcc $OPT -g2 -pthread $OBJ/*.o -o /w/web/engine/schwung.js \
  -sMAIN_MODULE=1 -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createSchwung \
  -sENVIRONMENT=web,worker -sINITIAL_MEMORY=768MB -sALLOW_MEMORY_GROWTH=0 \
  -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB -sPTHREAD_POOL_SIZE=24 \
  -sEXPORTED_RUNTIME_METHODS=wasmMemory,HEAPU8,HEAP16,HEAPU32,FS \
  -Wl,--wrap=mmap,--wrap=munmap,--wrap=ftruncate,--wrap=fstat,--wrap=close,--wrap=shm_open,--wrap=shm_unlink \
  --preload-file /w/build/vfs-base/data@/data --preload-file /w/build/vfs/data@/data -lm -sUSE_ZLIB=1 2> /w/build/link.log || { cat /w/build/link.log; exit 1; }
if grep "may need to be added to EXPORTED_FUNCTIONS" /w/build/link.log; then echo "UNDEFINED SYMBOLS (above)"; exit 1; fi
IN
ls -la web/engine
