# Architecture

schwung-wasm runs Schwung's own C and JavaScript in a browser. It is not a
reimplementation: the shim, chain host, shadow UI, QuickJS and every module are
the upstream sources, compiled with Emscripten. What is new is the thin layer
that stands in for the things a browser doesn't have: the SPI hardware, Ableton's
Move firmware, processes and the device's filesystem.

## On the device

```
MoveOriginal (Ableton, closed)
  └─ LD_PRELOAD schwung-shim.so ── hooks ioctl() on /dev/ablspi0.0 once per 128-frame block
        pre():  route MIDI, render the 4 chain slots (chain/dsp.so → module .so files), mix,
                serve the shadow UI's parameter requests, swap in the shadow UI's display
        post(): filter MIDI_IN (what Move sees), forward input to the shadow UI
shadow_ui (separate process, QuickJS) ── shadow_ui.js + module ui.js, talks to the shim via /dev/shm
```

Schwung's chain slots hear Move's tracks because Move echoes the notes it plays
to MIDI_OUT cable 2 on each track's channel; the shim picks those up.

## In the browser

```
page (main thread)                        AudioWorklet
  virtual Move panel ── sw_midi_in() ──┐    pulls 128-frame int16 blocks from the ring
  reads OLED + LEDs from shared memory │          ▲
                                       ▼          │ SharedArrayBuffer ring (sw_audio_ring)
device pthread (engine/vspi.c) ─────────────────────┘
  Virtual Move: write MIDI_OUT echo, clock, own screen     ← stands in for MoveOriginal
  schwung_spi_wasm_transfer():  shim pre() → TX copy → virtual XMOS exchange → RX copy → shim post()
  Virtual Move: read the MIDI_IN the shim let through
shadow_ui pthread (engine/shadow_ui_thread.c)
  shadow_ui.c main loop + QuickJS, unchanged, at 60 Hz
other shim threads (slot loader, shim worker, …) as on the device
```

| Device | Here | Where |
|---|---|---|
| `/dev/ablspi0.0` + `ioctl` hook | `schwung_spi_wasm_transfer()`, one call per block | `patches/apply.py` (spi lib), `engine/vspi.c` |
| XMOS (audio out, MIDI in, display pull) | `schwung_wasm_hw_exchange()` | `engine/vspi.c` |
| MoveOriginal (pads → notes, clock, its screen) | Virtual Move | `engine/vspi.c` (`vm_*`) |
| `fork`/`exec` of shadow_ui | a pthread | `engine/shadow_ui_thread.c`, patch to `shadow_process.c` |
| `/dev/shm` segments | named heap blocks; `--wrap` on `mmap` & co. | `engine/shm.c` |
| `mkdir`, `rm`, `cp`, `mv`, `tar` via fork/exec | in-process | `engine/exec.c`, `engine/untar.c` |
| Move's live song model, JACK, xattrs, CPU affinity | "not available" stubs | `engine/stubs.c` |
| `/data/UserData` on eMMC | Emscripten FS preloaded from `build/vfs-base` + `build/vfs`; user files saved to IndexedDB | `scripts/stage-vfs.sh`, `engine/js/persist.mjs` |
| module `dsp.so` (aarch64) | the module rebuilt from source as an Emscripten side module, at the same path | `scripts/build-modules.sh`, `modules/recipes/` |

Everything the shim and shadow UI do is otherwise unchanged: the same 128-frame
cadence (the AudioWorklet's render quantum at 44.1 kHz), the same shared-memory
structs, the same synchronous parameter channel, the same display slicing.

## Pacing

The device thread renders ahead into a 16-block ring and keeps it `target`
blocks full (default 4, ≈ 11.6 ms). It sleeps on the ring's read counter, which
the worklet bumps and `Atomics.notify`s each quantum. If the worklet stops (tab
suspended), the device keeps running in real time and drops blocks, so the
shadow UI's synchronous parameter reads are still answered.

## What can't be emulated

Anything that lives in Ableton's firmware: Move's own instruments, sequencer,
clips, sets and UI, and the Schwung features layered on them (Link Audio,
automation lanes and p-locks read from Move's song, mute/solo follow, Move's
metronome and screen-reader text). Virtual Move provides the minimum Schwung
needs from Move: tracks with pad layouts that echo notes, a transport clock, and
a home screen.

## Patching upstream

`patches/apply.py` makes exact-match edits to a copy of the Schwung tree
(`build/schwung`), each behind `#ifdef SCHWUNG_WASM` and each with a reason. A
missing anchor fails the build by name, so upstream drift is caught. The
submodule is never modified. `compat/wasm_compat.h` is force-included and fills
the few glibc extensions musl lacks.
