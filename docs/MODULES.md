# Module pipeline: catalog modules as Emscripten side modules

The engine (shim + chain host + shadow UI) is one Emscripten `MAIN_MODULE` with
pthreads. It loads module DSP with the real `dlopen()` from the Emscripten
virtual FS, at the same paths as on the Move. This pipeline produces those
files.

```
modules/recipes/<id>.json      how to build one module (sources, flags, assets, pinned commit)
modules/patches/<id>/*.patch   optional wasm-only source patches (applied with patch -p1)
modules/testhost/              Emscripten MAIN_MODULE test host (testhost.c + pre.js)
scripts/build-modules.sh       clone at pin → patch → emcc in Docker → stage into the VFS tree
scripts/test-module.mjs        dlopen each module in the test host, render 2 s, check, write WAV
compat/include/schwung_module_prelude.h   force-included before compat/wasm_compat.h (see below)
```

Outputs (all under `build/`, which is gitignored):

```
build/module-src/<owner>__<repo>/      shallow clone at the pinned commit (never committed: licensing)
build/module-obj/<id>/                 build.sh (generated), build.log, objects, the .so
build/vfs/data/UserData/schwung/modules/<category>/<id>/   preloaded by the engine at /data (alongside
                                       the engine's own build/vfs-base/). The script only ever replaces
                                       individual <id>/ dirs; never `rm -rf build/vfs`.
build/vfs/modules-manifest.json        id, name, type, version, license, repo, commit, path, dsp
build/vfs/modules-imports.json         symbols the side modules need from the main module
build/module-test/<id>.wav|.log        test renders; results.json = latest result per id
```

## Commands

```sh
bash scripts/build-modules.sh                       # every recipe
bash scripts/build-modules.sh cloudseed hush1 303   # some
node scripts/test-module.mjs                        # test everything in the manifest
node scripts/test-module.mjs --build braids         # build, then test
node scripts/test-module.mjs --threaded             # render on a pre-existing pthread (engine shape)
```

Env: `MODULE_MIRROR=<dir>` fetches from local clones named `<owner>_<repo>`
before GitHub; `JOBS=n` sets compile parallelism; `KEEP_GOING=0` stops at the
first failure.

## Device layout (what the chain host dlopens)

From `src/modules/chain/dsp/chain_synth_load.c` and `chain_fx_load.c` (the chain's
`module_dir` is `/data/UserData/schwung/modules/chain`):

| type | path | entry symbol |
|---|---|---|
| sound_generator | `modules/sound_generators/<id>/dsp.so` | `move_plugin_init_v2` (optional `move_plugin_render_split`) |
| audio_fx | `modules/audio_fx/<id>/<id>.so` | `move_audio_fx_init_v2` (optional `move_audio_fx_on_midi`) |
| midi_fx | `modules/midi_fx/<id>/dsp.so` | `move_midi_fx_init` |

`create_instance()` gets the module directory (`.../<category>/<id>`) and reads
`module.json`, presets, banks and other assets from there itself. The staged
directory therefore mirrors the module's release tarball exactly: same `.so`
name, plus `module.json`, `ui.js`/`ui_chain.js`/`canvas.js`, `help.json`,
`presets/`, `banks/`, `chain_patches/`, `patterns/`, and so on, taken from the
repo's own `scripts/build.sh` (or `Makefile`/`package.sh`) packaging step.

## Recipe format

```jsonc
{
  "id": "braids",                       // module id = directory name (from module.json / catalog)
  "name": "Braids",                     // optional; defaults to module.json "name"
  "repo": "charlesvestal/schwung-braids",
  "commit": "5920d30c…",                // full SHA; fetched with `git fetch --depth 1 origin <sha>`
  "license": "MIT",                     // SPDX id from the repo's LICENSE
  "component_type": "sound_generator",  // sound_generator | audio_fx | midi_fx
  "category_dir": "sound_generators",   // sound_generators | audio_fx | midi_fx
  "submodules": false,                  // true = git submodule update --init --recursive
  "sources": ["src/dsp/*.cc", "!src/dsp/test_*.cc", "?src/dsp/*.cpp"],  // globs; "!" excludes, "?" may match nothing
  "include": ["src/dsp"],               // -I, relative to the repo
  "include_abs": ["/w/build/schwung/src"],  // -I as-is (container paths): the patched Schwung tree
  "defines": ["TEST"],                  // -D
  "cflags": ["-std=c11"],               // C files only
  "cxxflags": ["-std=c++14"],           // C++ files only (.cc .cpp .cxx)
  "cflags_all": [],                     // both
  "per_file_flags": {"src/x.c": ["-x", "c++"]},   // extra flags for one file (moog, chiptune)
  "wasm_notes": "…",                    // free text: why the recipe deviates from upstream
  "ldflags": [],
  "cxx": true,                          // link with em++ (C++ runtime symbols)
  "assets": [                           // copied into the module dir, mirroring the tarball
    "src/module.json",                  // string: glob, copied by basename
    {"from": "src/help.json", "optional": true},
    {"from": "src/presets/*.braids", "to": "presets/"},   // "to" ending in / = directory
    {"mkdir": "presets"}                // empty directory the tarball ships
  ],
  "so_name": "dsp.so",                  // device file name: dsp.so, or <id>.so for audio_fx
  "upstream_build": "…",                // free text: the upstream command this mirrors
  "test": {"transport": true},          // optional test-module.mjs overrides
  "skip": false, "skip_reason": "…"
}
```

Every translation unit is compiled as

```
emcc|em++ -c -O2 -fPIC -pthread \
  -include /w/compat/include/schwung_module_prelude.h -include /w/compat/wasm_compat.h \
  <includes> <defines> <cflags|cxxflags> <file>
emcc|em++ -O2 -pthread -sSIDE_MODULE=1 <objects> -o <so_name>
```

Upstream optimisation flags (`-O3`, `-Ofast`, `-march=…`) are replaced by `-O2`.
Where upstream used `-Ofast` or `-ffast-math`, the recipe adds `-ffast-math` to
keep the same float semantics. `-pthread` must match the main module, and
`SIDE_MODULE=1` keeps every symbol exported.

### Automatic wasm32 fixups (applied to every checkout)

- Many modules ship their own copy of `plugin_api_v1.h` with
  `_Static_assert(offsetof(host_api_v1_t, reserved) == 120, …)` (or similar
  `get_bpm == 88` checks). Those are LP64 offsets, and on wasm32 the struct is
  smaller. The build wraps each one in `#if UINTPTR_MAX > 0xFFFFFFFFu`, the
  same fix `patches/apply.py` applies to the host's copy. Layout compatibility
  still holds because the module and the engine are both wasm32 and the
  struct is append-only.
- `compat/include/schwung_module_prelude.h` renames `pthread_setaffinity_np`
  and `pthread_attr_setaffinity_np` before `compat/wasm_compat.h` defines its
  static-inline shims. Under `_GNU_SOURCE`, which is always on for C++, musl's
  `<pthread.h>` already declares them extern, so without the rename every C++
  module fails to compile. **The engine's C++ code will hit the same error.**
  Suggested fix in `wasm_compat.h`: include `<pthread.h>`, then `#define` the
  names to private ones before the definitions. Once that lands, the prelude
  can be dropped.

## Test host

`modules/testhost/testhost.c` is linked with `em++ -sMAIN_MODULE=1 -pthread`
(em++ so that libc++/libc++abi are in the main module for C++ side modules).
`pre.js` mounts `build/vfs/data` at `/data` (NODEFS) and `build/module-test`
at `/out`. It provides:

- A `host_api_v1_t`: `log`, `get_bpm` returning 120, `get_clock_status`,
  `get_beat_position`, `midi_send_*`, `midi_inject_to_move` and
  `slot_recv_channel` stubs, `mapped_memory` pointing at a zeroed 4 KB
  mailbox, 128 frames per block, 44100 Hz, and `reserved[]` all NULL.
- `dlopen(<device path>)`, then the matching init symbol, then
  `create_instance(module_dir, NULL)`.
- Stimulus:
  - sound generators get note-ons and note-offs (36, 38 and 42 for drum maps; 48 to 72 for melodic voices).
  - audio FX get a 110 Hz saw at -6 dBFS for 1.5 s, then silence for the tail. The same block is also written to the mailbox audio-in, and note-ons go to the dlsym'd `move_audio_fx_on_midi`.
  - MIDI FX get the same notes. Their output drives a built-in sine synth so the WAV is audible.
- Transport: MIDI FX run with transport by default (`0xFA`, then 24 PPQN
  `0xF8` at 120 BPM as 1-byte messages, the way the chain forwards them;
  `get_clock_status` returns RUNNING; `get_beat_position` is live). Other types
  run with the transport stopped. Override per recipe with
  `"test": {"transport": …}`.
- `--threaded`: the render pthread already exists when the module is dlopened
  on the main thread, and only then starts calling into it. This is the
  engine's shape (slot-loader thread vs. audio thread).

Pass criteria: the run completes without trap or abort; peak above -60 dBFS;
no "output died while input was live" symptom (wasm saturates NaN to 0 on
float→int); fewer than 50% of samples at full scale; for MIDI FX, at least one
note-on comes out. For audio FX the result also reports `wet-dry`, the level of
(out - in), so a pass-through FX is visible.

## Notes for the engine (main module)

- **Exports.** `MAIN_MODULE=1` exports all of libc, so it just works. With
  `MAIN_MODULE=2` the engine must export at least every symbol listed in
  `build/vfs/modules-imports.json` (libc, libm, libc++ `operator new`/`delete`,
  `std::__shared_weak_count`, typeinfo vtables, …). Link the engine with
  **em++** or C++ side modules will fail to resolve libc++ symbols at dlopen.
- **Threads.** Emscripten makes a side module dlopened on one thread available
  to other threads lazily, when those threads next wait (futex/`sem_wait`/
  `emscripten_yield`). The `--threaded` test passes because the render thread
  is blocked in `sem_wait` while the loader runs. An audio thread that only
  spins, and never waits, may call a function pointer from a newly loaded
  module before it has synced, which traps with "null function". Make sure the
  audio thread passes through a wait, or call `emscripten_dlsync`-style
  syncing, between a slot load and the first `render_block`.
- **Exceptions.** Modules are compiled with Emscripten's default
  (`-fno-exceptions` semantics: `throw` aborts). The main module must use the
  same setting (the default `libc++-mt-noexcept`).
- **FX `on_midi`.** As on the device, use the dlsym'd `move_audio_fx_on_midi`,
  never `audio_fx_api_v2_t::on_midi`. Older modules (cloudseed and others)
  declare a shorter struct, so that field reads past the end.

## How a module author adds a wasm build

1. Make sure the module builds from plain sources with no prebuilt `.so`, no
   inline aarch64 asm without a fallback, and no `fork`/`exec`.
   Threads are fine (`-pthread`).
2. Add `modules/recipes/<id>.json`. Copy the compile line from your
   `scripts/build.sh` into `sources`, `include`, `defines` and `cflags`, and copy
   the `dist/<id>/` packaging step into `assets`. Pin `commit` to a tagged
   release's SHA.
3. If something needs a wasm-only change, prefer an `#ifdef __EMSCRIPTEN__` in
   the module repo. Failing that, add `modules/patches/<id>/0001-*.patch`.
4. Run `node scripts/test-module.mjs --build <id>`, listen to
   `build/module-test/<id>.wav`, and also run with `--threaded`.
5. Use the modules' own release CI for distribution: run the same recipe in
   the module repo's workflow and publish `<id>-wasm.tar.gz` next to the
   ARM64 tarball (a `wasm_download_url` in `release.json`). This repo's recipe
   then becomes the reference implementation of that build.

## Built modules

Status: default run / `--threaded` run. Latest results are in `build/module-test/results.json`.

| id | type | repo @ pin | licence | dsp | test | level | notes |
|---|---|---|---|---|---|---|---|
| `303` | sound_generator | [charlesvestal/schwung-303](https://github.com/charlesvestal/schwung-303) `7680578` | GPL-3.0 | `dsp.so` 69 KB | pass / pass | peak -4.15 dBFS |  |
| `4k-eq` | audio_fx | [athousanddetails/schwung-4keq](https://github.com/athousanddetails/schwung-4keq) `3493c94` | GPL-3.0 | `4k-eq.so` 61 KB | pass / pass | peak -4.19 dBFS, wet-dry -14.35 |  |
| `6w6` | sound_generator | [athousanddetails/schwung-6W6](https://github.com/athousanddetails/schwung-6W6) `2bda07e` | GPL-3.0 | `dsp.so` 65 KB | pass / pass | peak -6.62 dBFS |  |
| `8w8` | sound_generator | [athousanddetails/schwung-8W8](https://github.com/athousanddetails/schwung-8W8) `6fa3f70` | GPL-3.0 | `dsp.so` 76 KB | pass / pass | peak 0 dBFS |  |
| `9w9` | sound_generator | [athousanddetails/schwung-9W9](https://github.com/athousanddetails/schwung-9W9) `8e9aebd` | GPL-3.0 | `dsp.so` 55 KB | pass / pass | peak -3.76 dBFS |  |
| `ambiotica` | audio_fx | [charlesvestal/schwung-ambiotica](https://github.com/charlesvestal/schwung-ambiotica) `ac710ba` | MIT | `ambiotica.so` 16 KB | pass / pass | peak -7.05 dBFS, wet-dry -17.17 |  |
| `bouba-kiki` | sound_generator | [charlesvestal/schwung-bouba-kiki](https://github.com/charlesvestal/schwung-bouba-kiki) `2c2ee4b` | MIT | `dsp.so` 27 KB | pass / pass | peak -0.09 dBFS |  |
| `braids` | sound_generator | [charlesvestal/schwung-braids](https://github.com/charlesvestal/schwung-braids) `5920d30` | MIT | `dsp.so` 124 KB | pass / pass | peak -7.15 dBFS |  |
| `busdriver` | audio_fx | [legsmechanical/schwung-busdriver](https://github.com/legsmechanical/schwung-busdriver) `36b6788` | MIT | `busdriver.so` 26 KB | pass / pass | peak -1.1 dBFS, wet-dry -14.94 |  |
| `chiptune` | sound_generator | [charlesvestal/schwung-chiptune](https://github.com/charlesvestal/schwung-chiptune) `f792807` | MIT | `dsp.so` 50 KB | pass / pass | peak -15.69 dBFS | Upstream isolates gb_snd_emu's Blip_Buffer from Nes_Snd_Emu's via -fvisibility=hidden +… |
| `chonk` | sound_generator | [legsmechanical/schwung-chonk](https://github.com/legsmechanical/schwung-chonk) `da41ad0` | GPL-3.0 | `dsp.so` 42 KB | pass / pass | peak -8.09 dBFS |  |
| `chordism` | sound_generator | [charlesvestal/schwung-chordism](https://github.com/charlesvestal/schwung-chordism) `2a65614` | MIT | `dsp.so` 84 KB | pass / pass | peak -8.9 dBFS |  |
| `chowtape` | audio_fx | [charlesvestal/schwung-chowtape](https://github.com/charlesvestal/schwung-chowtape) `8a2a6d0` | GPL-3.0 | `chowtape.so` 14 KB | pass / pass | peak -2.16 dBFS, wet-dry -25.04 |  |
| `cloudseed` | audio_fx | [charlesvestal/schwung-cloudseed](https://github.com/charlesvestal/schwung-cloudseed) `fdbc24b` | MIT | `cloudseed.so` 17 KB | pass / pass | peak -2.75 dBFS, wet-dry -16.51 |  |
| `cw78` | sound_generator | [athousanddetails/schwung-cw-78](https://github.com/athousanddetails/schwung-cw-78) `e4b529e` | GPL-3.0 | `dsp.so` 69 KB | pass / pass | peak -7.66 dBFS |  |
| `dexed` | sound_generator | [charlesvestal/schwung-dx7](https://github.com/charlesvestal/schwung-dx7) `07f7fed` | GPL-3.0 | `dsp.so` 63 KB | pass / pass | peak -15.24 dBFS |  |
| `dissolver` | audio_fx | [filliformes/dissolver-move](https://github.com/filliformes/dissolver-move) `0edff5f` | GPL-3.0 | `dissolver.so` 30 KB | pass / pass | peak -9.84 dBFS, wet-dry -11.85 |  |
| `ducker` | audio_fx | [charlesvestal/schwung-ducker](https://github.com/charlesvestal/schwung-ducker) `0f1c932` | MIT | `ducker.so` 7 KB | pass / pass | peak -6.23 dBFS, wet-dry -20.98 |  |
| `essaim` | sound_generator | [filliformes/essaim-move](https://github.com/filliformes/essaim-move) `22f63b7` | MIT | `dsp.so` 33 KB | pass / pass | peak -12.99 dBFS |  |
| `eucalypso` | midi_fx | [handcraftedcc/move-everything-eucalypso](https://github.com/handcraftedcc/move-everything-eucalypso) `f0ff525` | MIT | `dsp.so` 23 KB | pass / pass | 3 notes out |  |
| `fizzik` | sound_generator | [filliformes/fizzik-move](https://github.com/filliformes/fizzik-move) `1af291e` | MIT | `dsp.so` 55 KB | pass / pass | peak -10.75 dBFS |  |
| `freak` | sound_generator | [handcraftedcc/move-everything-mrhyde](https://github.com/handcraftedcc/move-everything-mrhyde) `3c47f35` | MIT | `dsp.so` 250 KB | pass / pass | peak -6.19 dBFS |  |
| `gate` | audio_fx | [charlesvestal/schwung-gate](https://github.com/charlesvestal/schwung-gate) `49bc5a5` | MIT | `gate.so` 5 KB | pass / pass | peak -6.23 dBFS, wet-dry -40.63 |  |
| `granular` | audio_fx | [filliformes/boris-move](https://github.com/filliformes/boris-move) `2f8f61c` | GPL-3.0 | `granular.so` 17 KB | pass / pass | peak -5.51 dBFS, wet-dry -23.47 |  |
| `groovebank` | midi_fx | [mission-minnow/groovebank](https://github.com/mission-minnow/groovebank) `4edfa2f` | MIT | `dsp.so` 13 KB | pass / pass | 7 notes out |  |
| `hera` | sound_generator | [charlesvestal/schwung-hera](https://github.com/charlesvestal/schwung-hera) `7bcf8b8` | GPL-3.0 | `dsp.so` 40 KB | pass / pass | peak -21.09 dBFS |  |
| `hush1` | sound_generator | [charlesvestal/schwung-hush1](https://github.com/charlesvestal/schwung-hush1) `598ab90` | MIT | `dsp.so` 36 KB | pass / pass | peak -10.23 dBFS |  |
| `junologue-chorus` | audio_fx | [charlesvestal/schwung-junologue-chorus](https://github.com/charlesvestal/schwung-junologue-chorus) `0b1ecd9` | MIT | `junologue-chorus.so` 4 KB | pass / pass | peak -3.64 dBFS, wet-dry -12.67 |  |
| `krautdrums` | sound_generator | [filliformes/krautdrums-move](https://github.com/filliformes/krautdrums-move) `c359afe` | MIT | `dsp.so` 41 KB | pass / pass | peak -11.4 dBFS |  |
| `maze-voice` | sound_generator | [sd88me/schwung-maze](https://github.com/sd88me/schwung-maze) `e774a67` | MIT | `dsp.so` 14 KB | pass / pass | peak -4 dBFS |  |
| `mono-voice` | sound_generator | [timncox/schwung-mono](https://github.com/timncox/schwung-mono) `ce37774` | MIT | `dsp.so` 77 KB | pass / pass | peak -3.62 dBFS |  |
| `moog` | sound_generator | [charlesvestal/schwung-moog](https://github.com/charlesvestal/schwung-moog) `4f1f658` | MIT | `dsp.so` 14 KB | pass / pass | peak -10.96 dBFS |  |
| `mverb` | audio_fx | [charlesvestal/schwung-mverb](https://github.com/charlesvestal/schwung-mverb) `edb2cba` | GPL-3.0 | `mverb.so` 15 KB | pass / pass | peak -6 dBFS, wet-dry -20.34 |  |
| `noisemaker` | sound_generator | [legsmechanical/schwung-noisemaker](https://github.com/legsmechanical/schwung-noisemaker) `543fc70` | GPL-2.0 | `dsp.so` 272 KB | pass / pass | peak -11.08 dBFS |  |
| `nusaw` | sound_generator | [charlesvestal/schwung-nusaw](https://github.com/charlesvestal/schwung-nusaw) `e378773` | MIT | `dsp.so` 17 KB | pass / pass | peak -5.57 dBFS |  |
| `obxd` | sound_generator | [charlesvestal/schwung-obxd](https://github.com/charlesvestal/schwung-obxd) `f02973f` | GPL-3.0 | `dsp.so` 123 KB | pass / pass | peak -10.01 dBFS |  |
| `ottx` | audio_fx | [legsmechanical/schwung-ottx](https://github.com/legsmechanical/schwung-ottx) `8035c5e` | GPL-3.0 | `ottx.so` 17 KB | pass / pass | peak -0.23 dBFS, wet-dry -6.62 |  |
| `palette` | audio_fx | [filliformes/palette-move](https://github.com/filliformes/palette-move) `7a5a142` | MIT | `palette.so` 70 KB | pass / pass | peak -2.34 dBFS, wet-dry -36.34 |  |
| `pixel-walkers` | midi_fx | [mestela/schwung-pixel-walkers](https://github.com/mestela/schwung-pixel-walkers) `5bc3df9` | MIT | `dsp.so` 9 KB | pass / pass | 24 notes out |  |
| `plaits` | sound_generator | [j3threejay/move-anything-plaits](https://github.com/j3threejay/move-anything-plaits) `6d2ab08` | MIT | `dsp.so` 228 KB | pass / pass | peak -9.61 dBFS |  |
| `psxverb` | audio_fx | [charlesvestal/schwung-psxverb](https://github.com/charlesvestal/schwung-psxverb) `c8cc042` | MIT | `psxverb.so` 8 KB | pass / pass | peak -4.89 dBFS, wet-dry -20.13 |  |
| `ruminant` | audio_fx | [mestela/schwung-ruminant](https://github.com/mestela/schwung-ruminant) `d6cdedc` | MIT | `ruminant.so` 6 KB | pass / pass | peak -4.94 dBFS, wet-dry -14.51 |  |
| `signal` | sound_generator | [filliformes/signal-move](https://github.com/filliformes/signal-move) `77b6a88` | GPL-3.0 | `dsp.so` 88 KB | pass / pass | peak -17.07 dBFS |  |
| `simian` | sound_generator | [legsmechanical/schwung-simian](https://github.com/legsmechanical/schwung-simian) `647c2bb` | GPL-3.0 | `dsp.so` 114 KB | pass / pass | peak -6.22 dBFS |  |
| `sophie` | sound_generator | [mestela/schwung-sophie](https://github.com/mestela/schwung-sophie) `abd132d` | MIT | `dsp.so` 20 KB | pass / pass | peak -8.81 dBFS |  |
| `spectra` | audio_fx | [filliformes/spectra-move](https://github.com/filliformes/spectra-move) `c631fff` | MIT | `spectra.so` 31 KB | pass / pass | peak 0 dBFS, wet-dry -12.41 |  |
| `stereoid` | audio_fx | [legsmechanical/schwung-stereoid](https://github.com/legsmechanical/schwung-stereoid) `7efecf1` | MIT | `stereoid.so` 10 KB | pass / pass | peak -1.49 dBFS, wet-dry -22.64 |  |
| `structor` | audio_fx | [filliformes/structor-move](https://github.com/filliformes/structor-move) `db3595e` | MIT | `structor.so` 83 KB | pass / pass | peak -2.21 dBFS, wet-dry -12.53 |  |
| `superarp` | midi_fx | [handcraftedcc/move-everything-superarp](https://github.com/handcraftedcc/move-everything-superarp) `6eefd02` | MIT | `dsp.so` 26 KB | pass / pass | 13 notes out |  |
| `tape-echo2` | audio_fx | [athousanddetails/schwung-tape-echo2](https://github.com/athousanddetails/schwung-tape-echo2) `da2e6b5` | GPL-3.0 | `tape-echo2.so` 53 KB | pass / pass | peak -0.46 dBFS, wet-dry -17.4 |  |
| `tapedelay` | audio_fx | [charlesvestal/schwung-space-delay](https://github.com/charlesvestal/schwung-space-delay) `87e0cbf` | MIT | `tapedelay.so` 7 KB | pass / pass | peak -4.3 dBFS, wet-dry -18.2 |  |
| `tapescam` | audio_fx | [charlesvestal/schwung-tapescam](https://github.com/charlesvestal/schwung-tapescam) `e9ab1ae` | MIT | `tapescam.so` 17 KB | pass / pass | peak -2.82 dBFS, wet-dry -11.86 |  |
| `usefulity` | audio_fx | [charlesvestal/schwung-usefulity](https://github.com/charlesvestal/schwung-usefulity) `5bb2f00` | MIT | `usefulity.so` 7 KB | pass / pass | peak -6.23 dBFS, wet-dry -999 | output == input (pass-through at defaults) |
| `verglas` | audio_fx | [filliformes/verglas-move](https://github.com/filliformes/verglas-move) `4c159d8` | MIT | `verglas.so` 110 KB | pass / pass | peak -6.78 dBFS, wet-dry -16.17 |  |
| `vocoder` | audio_fx | [charlesvestal/schwung-vocoder](https://github.com/charlesvestal/schwung-vocoder) `261ce6a` | MIT | `vocoder.so` 7 KB | pass / pass | peak 0 dBFS, wet-dry -5.17 | 48% of samples at full scale |
| `war_bells` | audio_fx | [seajaysec/war-bells](https://github.com/seajaysec/war-bells) `bd13e89` | AGPL-3.0 | `war_bells.so` 65 KB | pass / pass | peak -6.57 dBFS, wet-dry -19.79 |  |
| `wurl` | sound_generator | [filliformes/wurl-move](https://github.com/filliformes/wurl-move) `2d5b77d` | GPL-3.0 | `dsp.so` 26 KB | pass / pass | peak -10.25 dBFS |  |
<!-- /TABLE -->

All 57 recipes were rebuilt from a clean `build/module-src` straight from GitHub
(no mirror) in about 2 min 10 s on an M-series Mac, and all pass both test
modes. Two have warnings, not failures:
- `usefulity` is bit-exact pass-through at its defaults. It is a utility.
- `vocoder` puts 48% of its samples at full scale. The test feeds the same saw
  as both carrier and modulator (the modulator is read from the audio-in
  mailbox), and the default 2x gains make it clip.

Recipe workarounds worth knowing:
- `chiptune` renames gb_snd_emu's `Blip_*` classes with `-D` on those files,
  because upstream relies on `objcopy --localize-hidden` and wasm-ld has no
  equivalent.
- `moog` compiles a `.c` file as C++, as upstream does.
- `dissolver` builds with `-DPFFFT_SIMD_DISABLE`.

## What is not built, and why

**Class A, but the licence blocks redistribution.** None of these was built.
- No licence (all rights reserved): `branchage`, `filter`, `velocity_scale`,
  `euclidrum`, `genera`, `superboom`, `tinyk`, `omega`, `pushnpull`,
  `impressive-chords`. Ask the authors for a licence; a recipe is about 15
  lines each.
- Also unlicensed (classes B to D): `hank`, `weird-dreams`, `granny`,
  `slicer`, `elusive-muse`, `forgetful`, `wayward`, `breakbeat`, `po32-drum`,
  `acid`, `jp8000`, `loopex`, `twinsampler`, and others. See
  `docs/MODULE-SURVEY.md`.
- PolyForm Strict, which forbids derivatives: `quilt`, `strut`.
- Non-commercial: `minijv` (MAME-style), `m8`, `dj` (CC-BY-NC-SA).

**Class B (needs work beyond a recipe).**
- Worker threads in DSP: `capicola`, `monksynth`, `munchi-delay`, `forge`,
  `magneto`, `clementine-xt`, `setbfree-organ`, `maze_seq*`, `fork`. Wasm
  pthreads work in the test host, so many of these may simply build. They need
  testing with the engine's worker pool size and with the "spinning audio
  thread" caveat above.
- Sample, ROM or user-file payloads that need a fetch-to-VFS or upload flow:
  `mrsample`, `mrdrums`, `rex`, `sf2` (FluidLite), `midi-player`, `tablor`,
  `scratch`, `beatbank`. ROM-based: `midiverb`, `rrverb10`.
- `/dev/shm` access to shadow-control: `aphex`, `denis`, `punchfx`. This needs
  a stub patch per module.
- Audio-in through `mapped_memory`: `belt`, `belt-in`, `smack`, `smack-in`,
  `work`. These should work, since the mailbox exists and the test host fills
  audio-in, but they are untested.
- Big library builds: `keydetect` (libkeyfinder + FFTW), `dragonfly-hall`
  (freeverb3 fetched at build time), `trance-gate` (Rust crate, needs
  `cargo --target wasm32-unknown-emscripten`).
- Tools and overtakes: they also need the engine's QuickJS UI host. Their DSP
  side would follow the same recipe format.

**Class C and D.** These are JIT or ROM emulators (`osirus`, `jp8000`,
`minijv`), a CLAP host that dlopens `.clap` files (`clap`/airwindows), neural
models (`nam`, `stems`), huge codebases (`surge`, `helm`, `sfz`, `dr32`,
`performance-fx`), network streamers, and release-only repos. They are out of
scope for this pipeline as-is.
