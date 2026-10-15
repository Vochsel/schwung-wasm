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
| tool | `modules/tools/<id>/<module.json "dsp" or dsp.so>` | shim overtake loader: `move_plugin_init_v2`, else `move_audio_fx_init_v2` |
| overtake | `modules/overtake/<id>/<module.json "dsp" or dsp.so>` | same as tool |

(Tool and overtake paths come from `src/shared/store_utils.mjs` `getInstallSubdir`
and `schwung_shim.c` `shadow_overtake_dsp_load`. The test host also accepts a
legacy `move_plugin_init_v1` for them.)

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
    {"mkdir": "presets"},               // empty directory the tarball ships
    {"from": "gen/*.wav", "to": "/data/UserData/UserLibrary/Samples/schwung-wasm-demo/"}  // absolute VFS path
  ],
  "so_name": "dsp.so",                  // device file name: dsp.so, or <id>.so for audio_fx
  "upstream_build": "…",                // free text: the upstream command this mirrors
  "extra_repos": [                      // pinned dependencies cloned INSIDE the module tree
    {"repo": "owner/lib", "commit": "<sha>", "dir": "deps/lib", "submodules": false}],
  "downloads": [                        // sha256-pinned files, cached in build/module-downloads/
    {"url": "https://…/x.tar.gz", "sha256": "…", "src": true, "to": "deps/x"},          // into the source tree (extracted)
    {"url": "https://…/kit.zip", "sha256": "…", "to": "/data/UserData/UserLibrary/Samples/schwung-wasm-demo/kit",
     "extract": "zip", "license": "CC0-1.0"}],                                           // into the VFS
  "pre_build": ["emcmake cmake -S deps/lib -B deps/lib/b -DCMAKE_C_FLAGS='-fPIC -pthread' && cmake --build deps/lib/b"],
                                        // run in the emsdk container from the source root, BEFORE
                                        // sources are globbed (codegen, configure, static deps)
  "test": {                             // optional test-module.mjs overrides
    "transport": true,                  // run Move's transport (default: midi_fx only)
    "params": {"preset": "3"},          // set_param after create_instance
    "create_json": {"pack": "…"},       // 2nd argument of create_instance
    "audio_in": true,                   // generators: feed the saw into the mailbox audio-in
    "seconds": 4,
    "wait_ms": 2000,                    // after create_instance, wait (pumping proxied calls) for loader threads
    "realtime": true,                   // pace rendering at real time (DSP built on a worker)
    "notes": [68, 69] },                // or [[t, status, d1, d2], …]: replaces the default stimulus
  "skip": false, "skip_reason": "…"
}
```

Every translation unit is compiled as

```
emcc|em++ -c -O2 -fPIC -pthread -fvisibility=hidden [-fvisibility-inlines-hidden for C++] \
  -include /w/compat/include/schwung_module_prelude.h -include /w/compat/wasm_compat.h \
  <includes> <defines> <cflags|cxxflags> <file>
EXPORTS = host entry points the objects (and any .o/.a/@rsp in ldflags) define   # llvm-nm
emcc|em++ -O2 -pthread -sSIDE_MODULE=2 -sEXPORTED_FUNCTIONS=$EXPORTS <ldflags> <objects> -o <so_name>
```

### Symbol isolation (one global namespace)

Emscripten's dynamic linker has a single global symbol namespace; `RTLD_LOCAL`
does not isolate side modules the way it does on the device. When every
symbol was exported, a module loaded later bound its own calls to an earlier
module's same-named export: freak and plaits both contain `plaits::`, and
loading plaits after freak trapped "null function" in the engine. So:

- Every module is compiled with `-fvisibility=hidden`, and C++ with
  `-fvisibility-inlines-hidden` as well.
- Every module is linked `SIDE_MODULE=2`, exporting only the host entry
  points it defines. The entry points are `move_plugin_init_v2`,
  `move_plugin_init_v1`, `move_audio_fx_init_v2`, `move_audio_fx_init_v1`,
  `move_midi_fx_init`, `move_audio_fx_on_midi`, `move_plugin_render_split`,
  and `clap_entry` for the airwindows `.clap`. These are every name
  `build/schwung/src` dlsyms from a module.
- Dependencies built in `pre_build` (CMake or configure) must pass
  `-fvisibility=hidden -fvisibility-inlines-hidden` too. wasm-ld still exports
  default-visibility symbols from archives in a `-shared` link.
- `build-modules.sh` fails if two staged modules export the same non-entry
  symbol, and it reports the count of non-entry exports. About 116 remain,
  mostly RTTI for `std::` types and two FluidLite hooks, all unique.
- `test-module.mjs --coload` dlopens every other built module into the same
  process before testing each one. This is a regression test for this bug
  class.

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

Demo content: only content shipped in the module's own repo (under its licence),
content generated procedurally in `pre_build`, or sha256-pinned downloads of
CC0, public-domain or MIT files with the licence recorded. Never Move factory
content, and never ROMs.

## Notes for the engine (main module)

- **Stack.** Emscripten's default stack is 64 KB for the main thread and every
  pthread; the device has 8 MB. `forge` puts more than 256 KB of structs on the
  stack in `create_instance`/`render`. The test host links with
  `-sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB`, and the engine should
  too, at least for the loader and device threads.
- **sched/pthread_setname_np.** Emscripten's libc has no `sched_setscheduler`,
  `sched_{get,set}{scheduler,param,affinity}` or `pthread_setname_np`. Module
  workers call these as the documented demote-to-SCHED_OTHER pattern. Modules
  get no-op versions from `compat/include/schwung_module_prelude.h`. Engine
  code that calls them needs the same.
- **Memory growth plus threads.** One run of `tablor` with `--threaded` trapped
  with "memory access out of bounds" while its loader thread was allocating
  under `ALLOW_MEMORY_GROWTH`, and was clean with a fixed 1 GB
  `INITIAL_MEMORY`. A later run with growth also passed. Prefer a pre-sized
  heap in the engine.
- **C++ exceptions.** Modules and the engine use Emscripten's default (no
  wasm EH; `__cxa_throw` comes from the JS library and aborts). `surge` needs
  `-fwasm-exceptions` in both the module and the main module: its init and
  `std::filesystem` code depend on try/catch. performance-fx probably does
  too. This is an engine-wide decision.
- **Nested dlopen deadlocks.** A static constructor that calls `dlopen()`
  while the host is inside `dlopen()` hangs silently, because Emscripten's
  dlopen lock isn't recursive. Surge's MTS-ESP client did this; it is patched.
- **Import check.** `test-module.mjs` fails a module that imports a symbol
  the main module provides neither as a wasm export nor as a JS-library
  function. Emscripten otherwise stubs it lazily, and it only traps when first
  called, often on a worker.
- **dlopen.** `wasm_compat.h` maps `dlopen` to `schwung_wasm_dlopen`
  (`engine/dlsync.c`, which waits for the device thread to sync), and `dlsym`
  to `schwung_wasm_dlsym`. The test host defines both as plain passthroughs,
  so modules that dlopen something themselves (clap, dr32) link in both
  hosts. Dependencies built by their own CMake (surge, nam) don't get the
  macro.

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

<!-- TABLE -->
**109 modules built; 109/109 pass all three test modes** (default / `--threaded` / `--coload`). By survey class: A: 57, B: 47, C: 3, plus 2 published after the survey (`shape-walk`, `shape-walk-seq`).
Results are in `build/module-test/results-{default,threaded,coload}.json`.

| id | type | class | repo @ pin | licence | dsp | test (default / threaded / coload) | level | notes |
|---|---|---|---|---|---|---|---|---|
| `303` | sound_generator | A | [charlesvestal/schwung-303](https://github.com/charlesvestal/schwung-303) `7680578` | GPL-3.0 | `dsp.so` 38 KB | pass / pass / pass | peak -4.15 dB |  |
| `4k-eq` | audio_fx | A | [athousanddetails/schwung-4keq](https://github.com/athousanddetails/schwung-4keq) `3493c94` | GPL-3.0 | `4k-eq.so` 52 KB | pass / pass / pass | peak -4.19 dB, wet-dry -14.35 |  |
| `6w6` | sound_generator | A | [athousanddetails/schwung-6W6](https://github.com/athousanddetails/schwung-6W6) `2bda07e` | GPL-3.0 | `dsp.so` 61 KB | pass / pass / pass | peak -6.62 dB |  |
| `8w8` | sound_generator | A | [athousanddetails/schwung-8W8](https://github.com/athousanddetails/schwung-8W8) `6fa3f70` | GPL-3.0 | `dsp.so` 74 KB | pass / pass / pass | peak 0 dB |  |
| `9w9` | sound_generator | A | [athousanddetails/schwung-9W9](https://github.com/athousanddetails/schwung-9W9) `8e9aebd` | GPL-3.0 | `dsp.so` 54 KB | pass / pass / pass | peak -3.76 dB |  |
| `ambiotica` | audio_fx | A | [charlesvestal/schwung-ambiotica](https://github.com/charlesvestal/schwung-ambiotica) `ac710ba` | MIT | `ambiotica.so` 15 KB | pass / pass / pass | peak -7.05 dB, wet-dry -17.17 |  |
| `aphex` | sound_generator | B | [filliformes/aphex-move](https://github.com/filliformes/aphex-move) `9246640` | MIT | `dsp.so` 64 KB | pass / pass / pass | peak -9.98 dB |  |
| `arranger` | overtake | B | [chaolue/schwung-arranger](https://github.com/chaolue/schwung-arranger) `c76cae3` | MIT | `dsp.so` 71 KB | pass / pass / pass | silent | silent by design: song arranger overtake: emits MIDI via host midi_send_*/midi_inject_to_move, renders no audio |
| `beatbank` | midi_fx | B | [mission-minnow/beatbank](https://github.com/mission-minnow/beatbank) `7d1b57f` | MIT | `dsp.so` 11 KB | pass / pass / pass | 14 notes out |  |
| `belt-in` | sound_generator | B | [timncox/schwung-belt](https://github.com/timncox/schwung-belt) `febf1a4` | MIT | `dsp.so` 18 KB | pass / pass / pass | peak -0.07 dB |  |
| `belt` | audio_fx | B | [timncox/schwung-belt](https://github.com/timncox/schwung-belt) `febf1a4` | MIT | `belt.so` 18 KB | pass / pass / pass | peak -0.07 dB, wet-dry -8.22 |  |
| `bouba-kiki` | sound_generator | A | [charlesvestal/schwung-bouba-kiki](https://github.com/charlesvestal/schwung-bouba-kiki) `2c2ee4b` | MIT | `dsp.so` 26 KB | pass / pass / pass | peak -0.09 dB |  |
| `braids` | sound_generator | A | [charlesvestal/schwung-braids](https://github.com/charlesvestal/schwung-braids) `5920d30` | MIT | `dsp.so` 110 KB | pass / pass / pass | peak -7.15 dB |  |
| `busdriver` | audio_fx | A | [legsmechanical/schwung-busdriver](https://github.com/legsmechanical/schwung-busdriver) `36b6788` | MIT | `busdriver.so` 25 KB | pass / pass / pass | peak -1.1 dB, wet-dry -14.94 |  |
| `capicola` | audio_fx | B | [charlesvestal/schwung-capicola](https://github.com/charlesvestal/schwung-capicola) `ab8b72d` | AGPL-3.0 | `capicola.so` 26 KB | pass / pass / pass | peak -3.15 dB, wet-dry -6.79 |  |
| `breakbeat` | sound_generator | B | [mestela/schwung-breakbeat](https://github.com/mestela/schwung-breakbeat) `c6e5b94` | MIT (module.json) | `dsp.so` 60 KB | pass / pass / pass | peak -0.56 dB | no LICENSE file; `src/module.json` declares MIT and the author asked for it. 23 bundled breaks ride in extra.data |
| `chiptune` | sound_generator | A | [charlesvestal/schwung-chiptune](https://github.com/charlesvestal/schwung-chiptune) `f792807` | MIT | `dsp.so` 44 KB | pass / pass / pass | peak -15.69 dB |  |
| `chonk` | sound_generator | A | [legsmechanical/schwung-chonk](https://github.com/legsmechanical/schwung-chonk) `da41ad0` | GPL-3.0 | `dsp.so` 39 KB | pass / pass / pass | peak -8.09 dB |  |
| `chord-finder` | tool | B | [lukeco11/chord-finder-for-move](https://github.com/lukeco11/chord-finder-for-move) `484a029` | MIT | `dsp.so` 8 KB | pass / pass / pass | silent | silent by design: chord tool: emits MIDI via host midi_send_*/midi_inject_to_move, renders no audio |
| `chorddex` | tool | B | [dony01001/ChordDex](https://github.com/dony01001/ChordDex) `5e25dad` | MIT | `dsp.so` 1 KB | pass / pass / pass | silent | silent by design: MIDI monitor: no audio output |
| `chordism` | sound_generator | A | [charlesvestal/schwung-chordism](https://github.com/charlesvestal/schwung-chordism) `2a65614` | MIT | `dsp.so` 84 KB | pass / pass / pass | peak -8.9 dB |  |
| `chowtape` | audio_fx | A | [charlesvestal/schwung-chowtape](https://github.com/charlesvestal/schwung-chowtape) `8a2a6d0` | GPL-3.0 | `chowtape.so` 14 KB | pass / pass / pass | peak -2.16 dB, wet-dry -25.04 |  |
| `clap` | audio_fx | C | [charlesvestal/schwung-airwindows](https://github.com/charlesvestal/schwung-airwindows) `91a004f` | MIT | `clap.so` 47 KB | pass / pass / pass | peak -4.18 dB, wet-dry -20.37 |  |
| `clementine-xt` | sound_generator | B | [sd88me/schwung-clementineXT](https://github.com/sd88me/schwung-clementineXT) `6577e1f` | GPL-3.0 | `dsp.so` 177 KB | pass / pass / pass | peak -10.38 dB |  |
| `cloudseed` | audio_fx | A | [charlesvestal/schwung-cloudseed](https://github.com/charlesvestal/schwung-cloudseed) `fdbc24b` | MIT | `cloudseed.so` 17 KB | pass / pass / pass | peak -2.75 dB, wet-dry -16.51 |  |
| `cw78` | sound_generator | A | [athousanddetails/schwung-cw-78](https://github.com/athousanddetails/schwung-cw-78) `e4b529e` | GPL-3.0 | `dsp.so` 67 KB | pass / pass / pass | peak -7.66 dB |  |
| `davebox` | tool | B | [legsmechanical/schwung-davebox](https://github.com/legsmechanical/schwung-davebox) `2883827` | MIT | `dsp.so` 323 KB | pass / pass / pass | silent | silent audio, sent 2048 MIDI msgs to host |
| `denis` | sound_generator | B | [filliformes/denis-move](https://github.com/filliformes/denis-move) `da7fb7f` | MIT | `dsp.so` 33 KB | pass / pass / pass | peak -11.78 dB |  |
| `dexed` | sound_generator | A | [charlesvestal/schwung-dx7](https://github.com/charlesvestal/schwung-dx7) `07f7fed` | GPL-3.0 | `dsp.so` 56 KB | pass / pass / pass | peak -15.24 dB |  |
| `dissolver` | audio_fx | A | [filliformes/dissolver-move](https://github.com/filliformes/dissolver-move) `0edff5f` | GPL-3.0 | `dissolver.so` 24 KB | pass / pass / pass | peak -9.84 dB, wet-dry -11.85 |  |
| `dr32` | sound_generator | C | [legsmechanical/schwung-dr32](https://github.com/legsmechanical/schwung-dr32) `313086b` | GPL-3.0 | `dsp.so` 477 KB | pass / pass / pass | silent | silent by design: loads; needs a drum kit (Move factory .ablpreset kits are not redistributable) |
| `dragonfly-hall` | audio_fx | B | [wolfrenegade1976/move-anything-dragonfly-hall](https://github.com/wolfrenegade1976/move-anything-dragonfly-hall) `4ab76d0` | GPL-3.0 | `dragonfly-hall.so` 53 KB | pass / pass / pass | peak -4.42 dB, wet-dry -22.81 |  |
| `drums-practice` | tool | B | [graebe/schwung-drums-practice](https://github.com/graebe/schwung-drums-practice) `6249306` | GPL-3.0 | `dsp.so` 11 KB | pass / pass / pass | peak -10.93 dB |  |
| `ducker` | audio_fx | A | [charlesvestal/schwung-ducker](https://github.com/charlesvestal/schwung-ducker) `0f1c932` | MIT | `ducker.so` 7 KB | pass / pass / pass | peak -6.23 dB, wet-dry -20.98 |  |
| `essaim` | sound_generator | A | [filliformes/essaim-move](https://github.com/filliformes/essaim-move) `22f63b7` | MIT | `dsp.so` 33 KB | pass / pass / pass | peak -16.66 dB |  |
| `eucalypso` | midi_fx | A | [handcraftedcc/move-everything-eucalypso](https://github.com/handcraftedcc/move-everything-eucalypso) `f0ff525` | MIT | `dsp.so` 23 KB | pass / pass / pass | 3 notes out |  |
| `fizzik` | sound_generator | A | [filliformes/fizzik-move](https://github.com/filliformes/fizzik-move) `1af291e` | MIT | `dsp.so` 55 KB | pass / pass / pass | peak -10.75 dB |  |
| `forge` | sound_generator | B | [filliformes/forge-move](https://github.com/filliformes/forge-move) `fc69e18` | MIT | `dsp.so` 154 KB | pass / pass / pass | peak -6.59 dB |  |
| `fork` | midi_fx | B | [andree182/schwung-fork](https://github.com/andree182/schwung-fork) `181d332` | GPL-3.0 | `dsp.so` 12 KB | pass / pass / pass | 9 notes out |  |
| `freak` | sound_generator | A | [handcraftedcc/move-everything-mrhyde](https://github.com/handcraftedcc/move-everything-mrhyde) `3c47f35` | MIT | `dsp.so` 216 KB | pass / pass / pass | peak -6.19 dB |  |
| `gate` | audio_fx | A | [charlesvestal/schwung-gate](https://github.com/charlesvestal/schwung-gate) `49bc5a5` | MIT | `gate.so` 5 KB | pass / pass / pass | peak -6.23 dB, wet-dry -40.63 |  |
| `granular` | audio_fx | A | [filliformes/boris-move](https://github.com/filliformes/boris-move) `2f8f61c` | GPL-3.0 | `granular.so` 17 KB | pass / pass / pass | peak -5.51 dB, wet-dry -23.47 |  |
| `groovebank` | midi_fx | A | [mission-minnow/groovebank](https://github.com/mission-minnow/groovebank) `4edfa2f` | MIT | `dsp.so` 13 KB | pass / pass / pass | 7 notes out |  |
| `guitar-tuner` | tool | B | [eightfour-dev/schwung-guitar-tuner](https://github.com/eightfour-dev/schwung-guitar-tuner) `343a097` | MIT | `dsp.so` 2 KB | pass / pass / pass | silent | silent by design: pitch analyser: render_block always writes silence (documented in guitar_tuner.c); results are read via get_param |
| `hera` | sound_generator | A | [charlesvestal/schwung-hera](https://github.com/charlesvestal/schwung-hera) `7bcf8b8` | GPL-3.0 | `dsp.so` 35 KB | pass / pass / pass | peak -21.09 dB |  |
| `hush1` | sound_generator | A | [charlesvestal/schwung-hush1](https://github.com/charlesvestal/schwung-hush1) `598ab90` | MIT | `dsp.so` 35 KB | pass / pass / pass | peak -10.23 dB |  |
| `junologue-chorus` | audio_fx | A | [charlesvestal/schwung-junologue-chorus](https://github.com/charlesvestal/schwung-junologue-chorus) `0b1ecd9` | MIT | `junologue-chorus.so` 4 KB | pass / pass / pass | peak -3.64 dB, wet-dry -12.67 |  |
| `keydetect` | audio_fx | B | [charlesvestal/schwung-keydetect](https://github.com/charlesvestal/schwung-keydetect) `66b6130` | MIT | `keydetect.so` 634 KB | pass / pass / pass | peak -6.23 dB, wet-dry -999 | output == input (pass-through at defaults) |
| `krautdrums` | sound_generator | A | [filliformes/krautdrums-move](https://github.com/filliformes/krautdrums-move) `c359afe` | MIT | `dsp.so` 41 KB | pass / pass / pass | peak -11.4 dB |  |
| `magneto` | audio_fx | B | [filliformes/magneto-move](https://github.com/filliformes/magneto-move) `4305a8f` | MIT | `magneto.so` 30 KB | pass / pass / pass | peak -3.86 dB, wet-dry -15.64 |  |
| `mark` | overtake | B | [timncox/schwung-mark](https://github.com/timncox/schwung-mark) `a9470f3` | MIT | `dsp.so` 42 KB | pass / pass / pass | peak -6.23 dB |  |
| `maze-voice` | sound_generator | A | [sd88me/schwung-maze](https://github.com/sd88me/schwung-maze) `e774a67` | MIT | `dsp.so` 14 KB | pass / pass / pass | peak -4 dB |  |
| `maze_seq` | tool | B | [sd88me/schwung-maze](https://github.com/sd88me/schwung-maze) `e774a67` | MIT | `dsp.so` 9 KB | pass / pass / pass | silent | silent audio, sent 40 MIDI msgs to host |
| `maze_seq_lite` | midi_fx | B | [sd88me/schwung-maze](https://github.com/sd88me/schwung-maze) `e774a67` | MIT | `dsp.so` 5 KB | pass / pass / pass | 16 notes out |  |
| `midi-player` | midi_fx | B | [charlesvestal/schwung-midi-player](https://github.com/charlesvestal/schwung-midi-player) `4c19bcf` | MIT | `dsp.so` 7 KB | pass / pass / pass | 18 notes out |  |
| `midiverb` | audio_fx | B | [charlesvestal/schwung-midiverb](https://github.com/charlesvestal/schwung-midiverb) `ae0e91b` | GPL-3.0-or-later | `midiverb.so` 307 KB | pass / pass / pass | peak -6.36 dB, wet-dry -19.15 |  |
| `monksynth` | sound_generator | B | [charlesvestal/schwung-monksynth](https://github.com/charlesvestal/schwung-monksynth) `38649a6` | MIT | `dsp.so` 21 KB | pass / pass / pass | peak -5.09 dB |  |
| `mono-voice` | sound_generator | A | [timncox/schwung-mono](https://github.com/timncox/schwung-mono) `ce37774` | MIT | `dsp.so` 76 KB | pass / pass / pass | peak -3.62 dB |  |
| `mono` | overtake | B | [timncox/schwung-mono](https://github.com/timncox/schwung-mono) `ce37774` | MIT | `dsp.so` 76 KB | pass / pass / pass | peak -8.76 dB |  |
| `moog` | sound_generator | A | [charlesvestal/schwung-moog](https://github.com/charlesvestal/schwung-moog) `4f1f658` | MIT | `dsp.so` 14 KB | pass / pass / pass | peak -10.96 dB |  |
| `mrdrums` | sound_generator | B | [handcraftedcc/move-everything-mrdrums](https://github.com/handcraftedcc/move-everything-mrdrums) `609630e` | MIT | `dsp.so` 44 KB | pass / pass / pass | peak -4.84 dB |  |
| `mrsample` | sound_generator | B | [charlesvestal/schwung-mrsample](https://github.com/charlesvestal/schwung-mrsample) `44ffb2d` | MIT | `dsp.so` 101 KB | pass / pass / pass | peak -0.45 dB |  |
| `munchi-delay` | audio_fx | B | [charlesvestal/schwung-munchi-delay](https://github.com/charlesvestal/schwung-munchi-delay) `37ec685` | MIT | `munchi-delay.so` 14 KB | pass / pass / pass | peak -6.23 dB, wet-dry -16.78 |  |
| `mverb` | audio_fx | A | [charlesvestal/schwung-mverb](https://github.com/charlesvestal/schwung-mverb) `edb2cba` | GPL-3.0 | `mverb.so` 14 KB | pass / pass / pass | peak -6 dB, wet-dry -20.34 |  |
| `nam` | audio_fx | C | [charlesvestal/schwung-nam](https://github.com/charlesvestal/schwung-nam) `da4af3f` | MIT | `nam.so` 452 KB | pass / pass / pass | peak -21.29 dB, wet-dry -17.05 |  |
| `noisemaker` | sound_generator | A | [legsmechanical/schwung-noisemaker](https://github.com/legsmechanical/schwung-noisemaker) `543fc70` | GPL-2.0 | `dsp.so` 259 KB | pass / pass / pass | peak -11.08 dB |  |
| `nusaw` | sound_generator | A | [charlesvestal/schwung-nusaw](https://github.com/charlesvestal/schwung-nusaw) `e378773` | MIT | `dsp.so` 17 KB | pass / pass / pass | peak -5.57 dB |  |
| `obxd` | sound_generator | A | [charlesvestal/schwung-obxd](https://github.com/charlesvestal/schwung-obxd) `f02973f` | GPL-3.0 | `dsp.so` 116 KB | pass / pass / pass | peak -7.85 dB |  |
| `oktonik` | tool | B | [skerryvibe/oktonik](https://github.com/skerryvibe/oktonik) `cfb4660` | MIT | `dsp.so` 26 KB | pass / pass / pass | silent | silent by design: chord/bass performance tool: emits MIDI via host midi_send_*/midi_inject_to_move, renders no audio |
| `ottx` | audio_fx | A | [legsmechanical/schwung-ottx](https://github.com/legsmechanical/schwung-ottx) `8035c5e` | GPL-3.0 | `ottx.so` 17 KB | pass / pass / pass | peak -0.23 dB, wet-dry -6.62 |  |
| `oversmack` | overtake | B | [timncox/schwung-smack](https://github.com/timncox/schwung-smack) `c018eca` | MIT | `dsp.so` 33 KB | pass / pass / pass | peak -6.23 dB |  |
| `palette` | audio_fx | A | [filliformes/palette-move](https://github.com/filliformes/palette-move) `7a5a142` | MIT | `palette.so` 69 KB | pass / pass / pass | peak -2.34 dB, wet-dry -36.34 |  |
| `piano-practice` | tool | B | [graebe/schwung-piano-practice](https://github.com/graebe/schwung-piano-practice) `4aa0998` | GPL-3.0 | `dsp.so` 16 KB | pass / pass / pass | peak -6.82 dB |  |
| `pixel-walkers` | midi_fx | A | [mestela/schwung-pixel-walkers](https://github.com/mestela/schwung-pixel-walkers) `5bc3df9` | MIT | `dsp.so` 9 KB | pass / pass / pass | 24 notes out |  |
| `plaits` | sound_generator | A | [j3threejay/move-anything-plaits](https://github.com/j3threejay/move-anything-plaits) `6d2ab08` | MIT | `dsp.so` 197 KB | pass / pass / pass | peak -9.61 dB |  |
| `psxverb` | audio_fx | A | [charlesvestal/schwung-psxverb](https://github.com/charlesvestal/schwung-psxverb) `c8cc042` | MIT | `psxverb.so` 8 KB | pass / pass / pass | peak -4.89 dB, wet-dry -20.13 |  |
| `punchfx` | audio_fx | B | [filliformes/punchfx-move](https://github.com/filliformes/punchfx-move) `7b9604a` | MIT | `punchfx.so` 10 KB | pass / pass / pass | peak -6.23 dB, wet-dry -999 | output == input (pass-through at defaults) |
| `rex` | sound_generator | B | [charlesvestal/schwung-rex](https://github.com/charlesvestal/schwung-rex) `c46ed64` | MIT | `dsp.so` 17 KB | pass / pass / pass | peak 0 dB |  |
| `rrverb10` | audio_fx | B | [legsmechanical/schwung-rrverb10](https://github.com/legsmechanical/schwung-rrverb10) `a8cbbb9` | LGPL-2.1 | `rrverb10.so` 7 KB | pass / pass / pass | peak -6.23 dB, wet-dry -999 | output == input (pass-through at defaults) |
| `ruminant` | audio_fx | A | [mestela/schwung-ruminant](https://github.com/mestela/schwung-ruminant) `d6cdedc` | MIT | `ruminant.so` 6 KB | pass / pass / pass | peak -4.94 dB, wet-dry -14.51 |  |
| `samplerobot` | tool | B | [charlesvestal/schwung-autosample](https://github.com/charlesvestal/schwung-autosample) `7f8fbd8` | MIT | `dsp.so` 20 KB | pass / pass / pass | peak -6.23 dB |  |
| `scratch` | sound_generator | B | [mestela/schwung-scratch](https://github.com/mestela/schwung-scratch) `9be303b` | GPL-3.0-or-later | `dsp.so` 20 KB | pass / pass / pass | peak -0.8 dB |  |
| `setbfree-organ` | sound_generator | B | [pdubucq/schwung-setbfree](https://github.com/pdubucq/schwung-setbfree) `53834bd` | GPL-2.0 | `dsp.so` 102 KB | pass / pass / pass | peak 0 dB |  |
| `sf2` | sound_generator | B | [charlesvestal/schwung-sf2](https://github.com/charlesvestal/schwung-sf2) `825cf31` | LGPL-2.1 | `dsp.so` 80 KB | pass / pass / pass | peak -2.65 dB |  |
| `shape-walk` | midi_fx | A | [mestela/schwung-shape-walk](https://github.com/mestela/schwung-shape-walk) `827275f` | MIT | `dsp.so` 20 KB | pass / pass / pass | 16 notes out |  |
| `shape-walk-seq` | tool | A | [mestela/schwung-shape-walk](https://github.com/mestela/schwung-shape-walk) `827275f` | MIT | `dsp.so` 24 KB | pass / pass / pass | silent by design | overtake tool; plays chords from its UI |
| `signal` | sound_generator | A | [filliformes/signal-move](https://github.com/filliformes/signal-move) `77b6a88` | GPL-3.0 | `dsp.so` 88 KB | pass / pass / pass | peak -17.07 dB |  |
| `simian` | sound_generator | A | [legsmechanical/schwung-simian](https://github.com/legsmechanical/schwung-simian) `647c2bb` | GPL-3.0 | `dsp.so` 111 KB | pass / pass / pass | peak -6.22 dB |  |
| `smack-in` | sound_generator | B | [timncox/schwung-smack](https://github.com/timncox/schwung-smack) `c018eca` | MIT | `dsp.so` 33 KB | pass / pass / pass | peak -6.23 dB |  |
| `smack` | audio_fx | B | [timncox/schwung-smack](https://github.com/timncox/schwung-smack) `c018eca` | MIT | `smack.so` 33 KB | pass / pass / pass | peak -6.23 dB, wet-dry -999 | output == input (pass-through at defaults) |
| `sophie` | sound_generator | A | [mestela/schwung-sophie](https://github.com/mestela/schwung-sophie) `abd132d` | MIT | `dsp.so` 20 KB | pass / pass / pass | peak -8.81 dB |  |
| `spectra` | audio_fx | A | [filliformes/spectra-move](https://github.com/filliformes/spectra-move) `c631fff` | MIT | `spectra.so` 31 KB | pass / pass / pass | peak 0 dB, wet-dry -12.41 |  |
| `stereoid` | audio_fx | A | [legsmechanical/schwung-stereoid](https://github.com/legsmechanical/schwung-stereoid) `7efecf1` | MIT | `stereoid.so` 10 KB | pass / pass / pass | peak -1.49 dB, wet-dry -22.64 |  |
| `structor` | audio_fx | A | [filliformes/structor-move](https://github.com/filliformes/structor-move) `db3595e` | MIT | `structor.so` 40 KB | pass / pass / pass | peak -2.21 dB, wet-dry -12.53 |  |
| `superarp` | midi_fx | A | [handcraftedcc/move-everything-superarp](https://github.com/handcraftedcc/move-everything-superarp) `6eefd02` | MIT | `dsp.so` 26 KB | pass / pass / pass | 13 notes out |  |
| `tablor` | sound_generator | B | [athousanddetails/schwung-tablor](https://github.com/athousanddetails/schwung-tablor) `0662122` | BSD-3-Clause | `dsp.so` 163 KB | pass / pass / pass | peak -3.43 dB |  |
| `tape-echo2` | audio_fx | A | [athousanddetails/schwung-tape-echo2](https://github.com/athousanddetails/schwung-tape-echo2) `da2e6b5` | GPL-3.0 | `tape-echo2.so` 51 KB | pass / pass / pass | peak -0.46 dB, wet-dry -17.4 |  |
| `tapedelay` | audio_fx | A | [charlesvestal/schwung-space-delay](https://github.com/charlesvestal/schwung-space-delay) `87e0cbf` | MIT | `tapedelay.so` 7 KB | pass / pass / pass | peak -4.3 dB, wet-dry -18.2 |  |
| `tapescam` | audio_fx | A | [charlesvestal/schwung-tapescam](https://github.com/charlesvestal/schwung-tapescam) `e9ab1ae` | MIT | `tapescam.so` 17 KB | pass / pass / pass | peak -2.82 dB, wet-dry -11.86 |  |
| `tb3po` | tool | B | [charlesvestal/schwung-tb3po](https://github.com/charlesvestal/schwung-tb3po) `f49d81d` | GPL-3.0 | `dsp.so` 16 KB | pass / pass / pass | silent | silent audio, sent 60 MIDI msgs to host |
| `trance-gate` | audio_fx | B | [graebe/neon-ingvy-audio-plugins](https://github.com/graebe/neon-ingvy-audio-plugins) `0188772` | GPL-3.0 | `trance-gate.so` 187 KB | pass / pass / pass | peak -6.23 dB, wet-dry -15.73 |  |
| `tuner` | tool | B | [CatsAreCool710/Move-Everything-Tuner](https://github.com/CatsAreCool710/Move-Everything-Tuner) `b8b8d6b` | GPL-3.0 | `dsp.so` 25 KB | pass / pass / pass | peak -7.96 dB |  |
| `usefulity` | audio_fx | A | [charlesvestal/schwung-usefulity](https://github.com/charlesvestal/schwung-usefulity) `5bb2f00` | MIT | `usefulity.so` 7 KB | pass / pass / pass | peak -6.23 dB, wet-dry -999 | output == input (pass-through at defaults) |
| `verglas` | audio_fx | A | [filliformes/verglas-move](https://github.com/filliformes/verglas-move) `4c159d8` | MIT | `verglas.so` 90 KB | pass / pass / pass | peak -6.78 dB, wet-dry -16.17 |  |
| `vocoder` | audio_fx | A | [charlesvestal/schwung-vocoder](https://github.com/charlesvestal/schwung-vocoder) `261ce6a` | MIT | `vocoder.so` 7 KB | pass / pass / pass | peak 0 dB, wet-dry -5.17 | 48% of samples at full scale |
| `war_bells` | audio_fx | A | [seajaysec/war-bells](https://github.com/seajaysec/war-bells) `bd13e89` | AGPL-3.0 | `war_bells.so` 64 KB | pass / pass / pass | peak -6.57 dB, wet-dry -19.79 |  |
| `waveform-editor` | tool | B | [charlesvestal/schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor) `7d53b8e` | MIT | `dsp.so` 36 KB | pass / pass / pass | silent | silent by design: audio file editor: plays audio only after the UI loads a file from the VFS |
| `work` | audio_fx | B | [timncox/schwung-work](https://github.com/timncox/schwung-work) `c88ec15` | MIT | `work.so` 91 KB | pass / pass / pass | peak -6.23 dB, wet-dry -999 | output == input (pass-through at defaults) |
| `wurl` | sound_generator | A | [filliformes/wurl-move](https://github.com/filliformes/wurl-move) `2d5b77d` | GPL-3.0 | `dsp.so` 26 KB | pass / pass / pass | peak -10.25 dB |  |

### Recipes present but not built (`"skip": true`)

| id | class | repo | licence | reason |
|---|---|---|---|---|
| `helm` | C | [andree182/schwung-helm](https://github.com/andree182/schwung-helm) | GPL-3.0 | Compiles (1.8 MB side module) but dlopen fails: JUCE 8.0.10's JUCE_WASM target has no native implementations for 59 juce_core/juce_events symbols helm links (DirectoryIterator::NativeIterator, File::getSpecialLocation, Thread::createNativeThread, MessageManager platform hooks, sockets/WebInputStream/NamedPipe/ChildProcess). Next step: compile JUCE as JUCE_LINUX with stub headers for sys/prctl.h, sys/ptrace.h, sys/timerfd.h, sys/sysinfo.h (POSIX natives mostly work on Emscripten), or add a small wasm natives file (dir iteration + pthread thread + no-op message queue). Realistic with ~half a day. |
| `osirus` | C | [charlesvestal/schwung-virus](https://github.com/charlesvestal/schwung-virus) | GPL-3.0 | Gearmulator DSP56300 emulator: JIT (asmjit) only for x86_64/arm64. The interpreter fallback would compile for wasm but is far from realtime for Virus firmware (the JIT is already near the limit on the Move's CM4). Also needs a user-supplied Virus ROM, plus threads/mmap. Not realistic. |
| `performance-fx` | C | [charlesvestal/schwung-performance-fx](https://github.com/charlesvestal/schwung-performance-fx) | MIT | Overtake built on Bungee, Eigen and FFTW-like code (about 2000 source files, 31 std::thread sites, 35 try blocks). Needs the overtake UI host plus probably -fwasm-exceptions (like surge). Realistic with significant work. |
| `sfz` | C | [charlesvestal/schwung-sfz](https://github.com/charlesvestal/schwung-sfz) | MIT | Shipping build is the Rust xsynth shim (cargo +nightly, staticlib) linked into dsp.so; sfizz is a legacy path. Needs a Rust nightly toolchain with -Zbuild-std for wasm32-unknown-emscripten, relocation-model=pic and +atomics,+bulk-memory to match the pthreads main module; not available in the emsdk image. Realistic with work (custom Docker image: emsdk + rustup nightly). Sample libraries need a VFS/upload flow. |
| `stems` | C | [charlesvestal/schwung-stems](https://github.com/charlesvestal/schwung-stems) | MIT | Tool: SpleeterRT neural stem separation, offline over whole files (large models, heavy CPU, long-running). Technically compilable C, but offline neural processing of full tracks in a browser worker is impractical next to realtime audio. Low priority. |
| `stretch` | C | [charlesvestal/schwung-stretch](https://github.com/charlesvestal/schwung-stretch) | MIT | Tool (needs the QuickJS UI host). DSP is Bungee (C++ plus Eigen, submodule), offline file time-stretching; a prebuilt dsp.so is committed. Bungee itself is portable C++, so this is realistic with work (CMake pre_build like nam), but it is file-centric and low value until tools run in the engine. |
| `surge` | C | [charlesvestal/schwung-surge](https://github.com/charlesvestal/schwung-surge) | GPL-3.0 | Builds (7.5 MB + 40 MB surge-data) and plays in an EH-enabled host, but needs C++ exceptions (-fwasm-exceptions) in the module AND the main module. In a no-EH engine its dlopen fails and leaves half-registered exports in Emscripten's global symbol table, which breaks every later dlopen in the process, so it must not be staged until the engine is built with -fwasm-exceptions. Set skip:false to build. |
<!-- /TABLE -->

### Notable per-module workarounds
- **Rust (trance-gate, drums-practice, piano-practice):** `pre_build` installs
  a pinned nightly (`nightly-2026-09-01` + `rust-src`) into
  `build/rust-toolchain`, inside the emsdk container. It builds a `staticlib`
  for `wasm32-unknown-emscripten` with `-Zbuild-std`,
  `+atomics,+bulk-memory,+mutable-globals` and `relocation-model=pic`, which
  emcc links `--whole-archive`. It takes about 15 to 60 s per crate, and the
  cached toolchain is 1.7 GB.
- **Bigger libraries:**
  - keydetect builds FFTW 3.3.10 (sha256-pinned tarball) and libkeyfinder.
  - nam builds NeuralAudio and RTNeural.
  - dragonfly-hall pins dragonfly-reverb with submodules.
  - clap rebuilds airwin2rack as a second side module,
    `plugins/Airwindows.clap`, because the committed one is an aarch64 ELF.
  - All of these deps are compiled `-fvisibility=hidden`.
- **Worker-thread loaders:** these need `test.wait_ms` or `test.realtime` to
  become audible in the faster-than-real-time test: clementine-xt,
  setbfree-organ, munchi-delay, tablor, scratch and nam. In the engine they
  run in real time.
- **Demo content:** generated, CC0, by `modules/demo/gen_demo_*.py` at build
  time:
  - drum, keys and pad WAVs in
    `/data/UserData/UserLibrary/Samples/schwung-wasm-demo/` (mrsample, mrdrums)
  - a `.sf2` (sf2)
  - a `.mid` (midi-player)
  - an `.rx2` encoded with rex's own encoder

  Repo-shipped content is used under its module's licence: tablor wavetables,
  the scratch sample, beatbank patterns, nam models (12 MB, GPL-3.0).
- **Audio-in modules** (belt-in, smack-in) are tested with
  `test.audio_in: true`. In the engine the mailbox audio-in is silent until
  mic input is wired.
- **shm modules** (aphex, denis, punchfx): `shm_open` fails in the browser and
  each module falls back gracefully; no patch. Shift and selected-slot features
  degrade.
- **Expected warnings:**
  - usefulity, keydetect and samplerobot leave the signal unchanged; they
    are utilities or analysers.
  - smack, work and rrverb10 also leave it unchanged. smack and work need a
    capture trigger, and rrverb10 needs a user ROM.
  - vocoder clips, because its carrier and modulator are the same saw.
- **Silent by design** (the test passes on loading, or on MIDI the module
  sends to the host): the MIDI-only tools and overtakes (tb3po, maze_seq,
  arranger, chord-finder, oktonik, davebox), the analysers and editors
  (chorddex, guitar-tuner, waveform-editor), and dr32, which needs a Move
  factory kit.

## What is not built, and why

**Licence: not redistributable, so no recipe.**
- No licence:
  - class A: `branchage`, `filter`, `velocity_scale`, `euclidrum`,
    `genera`, `superboom`, `tinyk`, `omega`, `pushnpull`,
    `impressive-chords`
  - class B: `hank`, `weird-dreams`, `granny`, `slicer`, `elusive-muse`,
    `forgetful`, `wayward`, `po32-drum`, `acid`
  - class C/D: `jp8000`, `loopex`, `twinsampler`, `dronage-tool`,
    `overwork-mix`
- PolyForm Strict: `quilt`, `strut`.
- Non-commercial: `minijv`, `dj`, `m8`.

**Class C, evaluated** (skip recipes with the reasons are listed above):
- **surge:** builds, and plays 675 patches with an EH-enabled host. It needs
  `-fwasm-exceptions` engine-wide.
- **helm:** JUCE 8's wasm target leaves 59 native functions undefined. Two
  patches are kept for whoever continues; about half a day of work.
- **sfz:** needs the Rust xsynth shim. That is now feasible with the Rust
  recipe pattern above.
- **osirus:** not realistic. The DSP56300 JIT is x86/arm64 only, and the
  interpreter is too slow.
- **stretch, stems, performance-fx:** not attempted. Large codebases and/or
  offline processing, and they need the tool/overtake UI host.
- **Built and passing:** clap (Airwindows, 49 KB host plus a 5.9 MB `.clap`),
  nam (860 KB plus models), and dr32 (loads, needs a kit).
- **Not attempted:** `movy` (a Rust engine that itself hosts modules via
  dlopen) and `kit-builder` (needs the Move sample library).

**Class D:** network streamers (`airplay`, `radiogarden`, `webstream`,
`streamrtsp`) can't work in a browser sandbox. `overwork` and `work-in` are
distribution-only repos whose source is `schwung-work`; they could become
recipes pointing at that repo.

**Class J (JS-only):** `sidcontrol` and `snake` (MIT) have no DSP. They only
need their files staged, which would need a no-`.so` recipe mode. That mode
does not exist yet.
