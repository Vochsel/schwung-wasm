# Schwung catalog → WebAssembly / AudioWorklet feasibility survey

Source: ``. It lists 158 modules from 152 distinct GitHub repos. All 152 repos exist and are public. Each repo was shallow-cloned into `scratchpad/repos/` (2.6 GB in total) and grepped for risk patterns. Matches in `tests/`, `tools/`, `bench/` and vendored third-party headers were excluded by hand, as were hits on the API header comments (for example the `dlopen`/`pthread` notes in `plugin_api_v1.h`). The judgement is static: **nothing was compiled.**

## Classes
- **A**: easy. Plain C/C++ (or Faust-generated C++) with no risky deps. Expected to compile with `emcc` plus a small glue file.
- **B**: moderate. Needs one or more of: a worker-thread removal or stub, a VFS for samples/ROMs/user files, audio-in or `mapped_memory`/shm host emulation, a bigger library (FluidLite, setBfree, libkeyfinder+FFTW), a Rust toolchain, or tool/overtake UI-host emulation.
- **C**: hard. ROM-based CPU/DSP emulators (Gearmulator JIT, Nuked/JV-880), a CLAP host that uses `dlopen`, neural models (NAM/RTNeural/Eigen, Spleeter), or huge codebases (Surge, Helm+JUCE, Bungee+Eigen, sfizz).
- **D**: not feasible as-is. Network receivers or streamers (AirPlay, RTSP, radio, yt-dlp), or no source (release-only repos, a prebuilt ELF blob).
- **J**: JS-only (no DSP; UI or controller only).

Tools and overtakes that ship C DSP are classed **B at minimum**. They are full-surface apps that also need Schwung's QuickJS UI host (display, pads, `host_*` JS APIs) emulated.

## Counts

| class | modules | repos |
|---|---|---|
| A | 67 | 65 |
| B | 58 | 54 |
| C | 16 | 16 |
| D | 9 | 9 |
| J | 8 | 8 |
| **total** | **158** | **152** |

The repo count uses the repo's primary class. Two repos are mixed: `sd88me/schwung-maze` (B, but `maze-voice` is A) and `timncox/schwung-mono` (B, but `mono-voice` is A).

Modules per component type:

| type | A | B | C | D | J |
|---|---|---|---|---|---|
| sound_generator (64) | 30 | 22 | 7 | 5 | – |
| audio_fx (45) | 28 | 15 | 2 | – | – |
| midi_fx (14) | 9 | 5 | – | – | – |
| tool (19) | – | 12 | 4 | 1 | 2 |
| overtake (16) | – | 4 | 3 | 3 | 6 |

**Bottom line:** about 79% of modules (125 of 158) are in A or B. That is 52 of 64 sound generators, 43 of 45 audio FX (only `nam` and the airwindows CLAP host are C) and all 14 MIDI FX. Class A alone is 58 SG + FX modules that should port with essentially zero source changes.

Licences of the A repos: 34 MIT, 19 GPL-3.0, 1 GPL-2.0, 1 AGPL-3.0, and **10 with no licence** (no redistribution rights). Across all repos, 30 have no licence at all. Two (`kliegsablaze/quilt`, `kliegsablaze/strut`) are **PolyForm Strict**, which forbids derivatives. Two are CC-BY-NC-SA (`schwung-m8`, `move-anything-dj`), and `schwung-jv880` uses a MAME-style non-commercial licence. Hosting a compiled port publicly needs a licence check for each module.

## Top risks
1. **Licensing, more than technology.** 30 of 152 repos have no licence, 2 are PolyForm Strict and 3 are non-commercial. GPL/AGPL modules are fine for a GPL/AGPL web host but contaminate a closed one.
2. **Host-API surface.** 50 repos touch `host->mapped_memory`, 14 call `get_beat_position`, and 18 `dlsym` optional host exports. About 126 read `module_dir` (presets and bundled assets), which an Emscripten `--preload-file` VFS covers. A browser host must provide a non-NULL `mapped_memory` buffer (audio-in at `audio_in_offset`), clock and transport, and the current `host_api_v1_t` layout including `get_beat_position` and `reserved[8]`.
3. **Worker threads.** About 40 repos `pthread_create` an io, loader or state thread from DSP code (and drop it to SCHED_OTHER). In an AudioWorklet these must become synchronous calls or `#ifdef`'d out. Using WASM pthreads inside a worklet is not practical.
4. **shm/mmap of host internals.** `aphex`, `denis`, `punchfx` and `loopex` read `/dev/shm` shadow-control or Link Audio. Stub them out (degrades Shift and pressure features), or class C for loopex.
5. **ROM and sample payloads.** ROMs: `midiverb`, `rrverb10` (Roland ROM, not redistributable), and `jv880`/`virus`/`jp8000` (user ROMs plus JIT). Bundled audio: `strut` 50 MB, `breakbeat` 16 MB, `scratch` 10 MB, `nam` 12 MB of .nam models. `dr32` and `kit-builder` depend on Move's factory sample library.
6. **SIMD and asm.** ARM NEON is used unguarded only in `jv880` (`resampler_fixed.h`). Other hits are `dr_flac`/`minimp3`/`pffft`/Eigen with scalar fallbacks, or FTZ `mrs/msr fpcr` asm guarded by `__aarch64__` (omega, ottx, quilt, strut, 303). Treat as low risk.

## Schwung host licence (charlesvestal/schwung)
`ref/schwung/LICENSE` is **MIT** (© 2025-2026 Charles Vestal). `THIRD_PARTY_LICENSES.md` states that the source is MIT everywhere. Only some *binaries* become GPL, because they link eSpeak NG, Ableton Link or jack2. No `src/` subdirectory carries its own licence file, and no `src/modules/*` file mentions GPL. So `src/modules` (chain, freeverb, arp, chord, linein, …) and the host code (`src/host/*.h`, including the `plugin_api_v1.h`/`audio_fx_api_v2.h`/`midi_fx_api_v1.h` ABIs) can be ported under MIT with attribution. Port only the MIT sources and skip the eSpeak, Link and jack pieces. Porting caveat: `chain/dsp` (about 14k lines) does `dlopen`/`dlsym`, `mmap` and threads in `chain_host.c`, `chain_fx_load.c`, `chain_synth_load.c` and `chain_bus.c`. A WASM chain needs those loaders rewritten to static links or separate WASM module instances.

## m-dwyer/moveforge glue
- **Licence: none.** The GitHub API reports `license: null` and the repo has no LICENSE or COPYING file, so by default all rights are reserved. Treat it as a reference only, or ask the author to add a licence. The glue is small (`schwung_wasm_glue_sg.c` 103 lines, `..._fx.c` 126, `midi_fx_wasm_glue.c` 110) and trivial to re-implement clean-room.
- **What it does:** calls `move_plugin_init_v2` / `move_audio_fx_init_v2` with a stub `host_api_v1_t` (44.1 kHz, 128-frame blocks, `get_bpm`=120, log and midi no-ops). It does `create_instance("", NULL)` and exports `sch_init/sch_set_param/sch_midi/sch_render` plus float L/R buffers (int16 interleave conversion).
- **Fit for arbitrary third-party modules: only partly.**
  - Its `plugin_api_v1.h` is an **older copy**. It lacks `get_beat_position` and the `reserved[8]` tail that the current Schwung header static-asserts at offset 120. A module that reads `host->get_beat_position` (14 repos) reads past the struct. Schwung's own header notes that breakbeat over-reads into exactly that area.
  - `mapped_memory = NULL`. Modules that read audio-in through mapped memory (belt-in, smack-in, work, etc., 50 repos reference it) would crash or produce silence.
  - `module_dir` is `""` and there is no VFS. Presets, wavetables, .syx banks and samples won't load.
  - No `get_param` export (UI readback, chain_params state), no `json_defaults`, no state save/load, fixed sample rate, one instance only.
  - No `dlsym`-style optional host exports, and no clock or transport MIDI (0xF8, start/stop) is driven.
  - It works for A-class modules with self-contained, `module_dir`-independent DSP (for example 303, cloudseed, plaits, wurl, braids with defaults). As a generic catalog host it needs the fixes above.
- Also note that `seajaysec/war-bells` already ships its own browser build (`wasm/build_wasm.sh`, `wbw.c`) that drives the real audio_fx v2 API. It is a second proof that the approach works.

## Best first prototype candidates
1. **seajaysec/war-bells** (`war_bells`, audio_fx, AGPL-3.0). Granular, glitch, delay and looper multi-FX, about 167k C. **It already has an emcc build and JS glue**, so it costs almost nothing and checks the glue against a known-good target. Uses only `host->log`/`get_bpm`.
2. **charlesvestal/schwung-303** (`303`, sound_generator, GPL-3.0). Open303 plus Devilfish and drive, about 114k C++, no file I/O, uses only `move_plugin_init_v2`. Iconic and easy to hear.
3. **charlesvestal/schwung-cloudseed** (`cloudseed`, audio_fx, MIT). Single-file C algorithmic reverb, about 52k, uses only `host->log`. A lush FX to pair with the 303.
4. **charlesvestal/schwung-hush1** (`hush1`, sound_generator, MIT). SH-101 subtractive mono synth, plain C. Uses `sample_rate` (so it tests passing 48 kHz) and an optional preset `fopen`.
5. **j3threejay/move-anything-plaits** (`plaits`, sound_generator, MIT), or **charlesvestal/schwung-braids** (MIT). Mutable Plaits, 24 engines, plain C++ with stmlib. Very audible variety, no host deps beyond init. Compile only `plaits/` and `stmlib/dsp`, skipping the 500 vendored STM HAL headers.

Runners-up: `filliformes/wurl-move` (Wurlitzer, GPL, single file), `athousanddetails/schwung-8W8` (808, GPL), `charlesvestal/schwung-dx7` (Dexed/MSFA, GPL, needs .syx VFS), `charlesvestal/schwung-psxverb` (MIT), `charlesvestal/schwung-junologue-chorus` (MIT).

## Per-repo table
Sorted by class. A module id followed by "(A)" overrides its repo's class.

| repo | module ids | type | license | lang (top) | class | flags / notes |
|---|---|---|---|---|---|---|
| [athousanddetails/schwung-4keq](https://github.com/athousanddetails/schwung-4keq) | 4k-eq | audio_fx | GPL-3.0 | C++ 214k Python 27k | **A** | plain C++ console EQ; denormal asm guarded |
| [athousanddetails/schwung-6W6](https://github.com/athousanddetails/schwung-6W6) | 6w6 | sound_generator | GPL-3.0 | C++ 177k C 79k | **A** | plain C/C++ circuit-model 606; dlopen only in tools/ |
| [athousanddetails/schwung-8W8](https://github.com/athousanddetails/schwung-8W8) | 8w8 | sound_generator | GPL-3.0 | C++ 326k C 99k | **A** | plain C/C++ circuit-model 808 |
| [athousanddetails/schwung-9W9](https://github.com/athousanddetails/schwung-9W9) | 9w9 | sound_generator | GPL-3.0 | C 191k JavaScript 24k | **A** | plain C 909 (hats embedded); webaudio.h is C reimpl of WebAudio nodes |
| [athousanddetails/schwung-cw-78](https://github.com/athousanddetails/schwung-cw-78) | cw78 | sound_generator | GPL-3.0 | C++ 185k C 126k | **A** | plain C/C++ circuit-model CR-78 |
| [athousanddetails/schwung-tape-echo2](https://github.com/athousanddetails/schwung-tape-echo2) | tape-echo2 | audio_fx | GPL-3.0 | C++ 288k HTML 30k | **A** | plain C++ (ported dusk DSP; fetched in docker-build) |
| [broduoliviercontact-web/Schwung-Midi-Fx-branchages-Multi-Random-generator](https://github.com/broduoliviercontact-web/Schwung-Midi-Fx-branchages-Multi-Random-generator) | branchage | midi_fx | none | C 76k JavaScript 30k | **A** | plain C midi_fx (Grids); committed .so but source present; NO LICENSE |
| [charlesvestal/schwung-303](https://github.com/charlesvestal/schwung-303) | 303 | sound_generator | GPL-3.0 | C++ 222k C 39k | **A** | Open303 C++ (20 files); FTZ asm guarded |
| [charlesvestal/schwung-ambiotica](https://github.com/charlesvestal/schwung-ambiotica) | ambiotica | audio_fx | MIT | C 80k | **A** | plain C ambient FX chain |
| [charlesvestal/schwung-bouba-kiki](https://github.com/charlesvestal/schwung-bouba-kiki) | bouba-kiki | sound_generator | MIT | C 91k JavaScript 14k | **A** | plain C synth |
| [charlesvestal/schwung-braids](https://github.com/charlesvestal/schwung-braids) | braids | sound_generator | MIT | C++ 598k C 12k | **A** | Mutable Braids C++ (stmlib) |
| [charlesvestal/schwung-chiptune](https://github.com/charlesvestal/schwung-chiptune) | chiptune | sound_generator | MIT | C++ 126k C 10k | **A** | Nes_Snd_Emu (submodule) + gb_snd_emu C++ |
| [charlesvestal/schwung-chordism](https://github.com/charlesvestal/schwung-chordism) | chordism | sound_generator | MIT | C++ 199k | **A** | single-file C++ synth |
| [charlesvestal/schwung-chowtape](https://github.com/charlesvestal/schwung-chowtape) | chowtape | audio_fx | GPL-3.0 | C 49k | **A** | single-file C tape model |
| [charlesvestal/schwung-cloudseed](https://github.com/charlesvestal/schwung-cloudseed) | cloudseed | audio_fx | MIT | C 60k | **A** | single-file C reverb |
| [charlesvestal/schwung-ducker](https://github.com/charlesvestal/schwung-ducker) | ducker | audio_fx | MIT | C 29k | **A** | tiny C FX (MIDI-triggered) |
| [charlesvestal/schwung-dx7](https://github.com/charlesvestal/schwung-dx7) | dexed | sound_generator | GPL-3.0 | C++ 176k JavaScript 1k | **A** | MSFA/Dexed C++; .syx banks via preload VFS |
| [charlesvestal/schwung-filter](https://github.com/charlesvestal/schwung-filter) | filter | audio_fx | none | C 58k | **A** | plain C filter; NO LICENSE |
| [charlesvestal/schwung-gate](https://github.com/charlesvestal/schwung-gate) | gate | audio_fx | MIT | C 24k | **A** | tiny C gate |
| [charlesvestal/schwung-hera](https://github.com/charlesvestal/schwung-hera) | hera | sound_generator | GPL-3.0 | C++ 111k C 4k | **A** | Faust-generated C++ Juno-60 |
| [charlesvestal/schwung-hush1](https://github.com/charlesvestal/schwung-hush1) | hush1 | sound_generator | MIT | C 147k Python 38k | **A** | plain C SH-101 |
| [charlesvestal/schwung-junologue-chorus](https://github.com/charlesvestal/schwung-junologue-chorus) | junologue-chorus | audio_fx | MIT | C 21k | **A** | tiny C chorus |
| [charlesvestal/schwung-moog](https://github.com/charlesvestal/schwung-moog) | moog | sound_generator | MIT | C++ 34k C 28k | **A** | small C/C++ mono synth |
| [charlesvestal/schwung-mverb](https://github.com/charlesvestal/schwung-mverb) | mverb | audio_fx | GPL-3.0 | C++ 35k C 9k | **A** | single-file MVerb C++ |
| [charlesvestal/schwung-nusaw](https://github.com/charlesvestal/schwung-nusaw) | nusaw | sound_generator | MIT | C++ 56k C 8k | **A** | small C++ supersaw |
| [charlesvestal/schwung-obxd](https://github.com/charlesvestal/schwung-obxd) | obxd | sound_generator | GPL-3.0 | C 177k C++ 141k | **A** | OB-Xd engine C++ with JuceCompat shim (no real JUCE) |
| [charlesvestal/schwung-psxverb](https://github.com/charlesvestal/schwung-psxverb) | psxverb | audio_fx | MIT | C 43k | **A** | single-file C PSX reverb |
| [charlesvestal/schwung-space-delay](https://github.com/charlesvestal/schwung-space-delay) | tapedelay | audio_fx | MIT | C 34k | **A** | small C tape delay |
| [charlesvestal/schwung-tapescam](https://github.com/charlesvestal/schwung-tapescam) | tapescam | audio_fx | MIT | C 71k | **A** | single-file C tape FX |
| [charlesvestal/schwung-usefulity](https://github.com/charlesvestal/schwung-usefulity) | usefulity | audio_fx | MIT | C 27k | **A** | tiny C utility |
| [charlesvestal/schwung-velocity-scale](https://github.com/charlesvestal/schwung-velocity-scale) | velocity_scale | midi_fx | none | C 35k | **A** | tiny C midi_fx; NO LICENSE |
| [charlesvestal/schwung-vocoder](https://github.com/charlesvestal/schwung-vocoder) | vocoder | audio_fx | MIT | C 26k | **A** | small C vocoder (needs audio-in modulator) |
| [filliformes/boris-move](https://github.com/filliformes/boris-move) | granular | audio_fx | GPL-3.0 | C 52k | **A** | single-file C granular |
| [filliformes/dissolver-move](https://github.com/filliformes/dissolver-move) | dissolver | audio_fx | GPL-3.0 | C 168k | **A** | C spectral (pffft has scalar fallback) |
| [filliformes/essaim-move](https://github.com/filliformes/essaim-move) | essaim | sound_generator | MIT | C 66k | **A** | single-file C oscillator swarm |
| [filliformes/euclidrum-move](https://github.com/filliformes/euclidrum-move) | euclidrum | midi_fx | none | C 86k | **A** | single-file C midi_fx; NO LICENSE |
| [filliformes/fizzik-move](https://github.com/filliformes/fizzik-move) | fizzik | sound_generator | MIT | C 140k Python 9k | **A** | plain C physical modelling |
| [filliformes/genera-move](https://github.com/filliformes/genera-move) | genera | midi_fx | none | C 73k | **A** | single-file C midi_fx; NO LICENSE |
| [filliformes/krautdrums-move](https://github.com/filliformes/krautdrums-move) | krautdrums | sound_generator | MIT | C 165k | **A** | single-file C drum machine |
| [filliformes/palette-move](https://github.com/filliformes/palette-move) | palette | audio_fx | MIT | C 234k C++ 9k | **A** | C + vendored Clouds/Warps/airwindows (plain C++) |
| [filliformes/signal-move](https://github.com/filliformes/signal-move) | signal | sound_generator | GPL-3.0 | C 182k | **A** | single-file C rhythm generator |
| [filliformes/spectra-move](https://github.com/filliformes/spectra-move) | spectra | audio_fx | MIT | C 81k | **A** | single-file C resonator bank |
| [filliformes/structor-move](https://github.com/filliformes/structor-move) | structor | audio_fx | MIT | C 311k JavaScript 9k | **A** | C + pffft (scalar fallback) |
| [filliformes/super-boom-move](https://github.com/filliformes/super-boom-move) | superboom | audio_fx | none | C 50k JavaScript 12k | **A** | single-file C bus FX; NO LICENSE |
| [filliformes/verglas-move](https://github.com/filliformes/verglas-move) | verglas | audio_fx | MIT | C++ 444k C 0k | **A** | Mutable Clouds C++ |
| [filliformes/wurl-move](https://github.com/filliformes/wurl-move) | wurl | sound_generator | GPL-3.0 | C 56k | **A** | single-file C Wurlitzer (OpenWurli port) |
| [fleshinachair/TinyK](https://github.com/fleshinachair/TinyK) | tinyk | sound_generator | none | C 1329k Python 333k | **A** | plain C VA synth (1.3MB incl. preset tables); NO LICENSE |
| [handcraftedcc/move-everything-eucalypso](https://github.com/handcraftedcc/move-everything-eucalypso) | eucalypso | midi_fx | MIT | C 77k | **A** | single-file C midi_fx |
| [handcraftedcc/move-everything-mrhyde](https://github.com/handcraftedcc/move-everything-mrhyde) | freak | sound_generator | MIT | C++ 121k Rich Text Format 25k | **A** | Mutable Plaits (vendored eurorack tree, only plaits/stmlib needed) |
| [handcraftedcc/move-everything-superarp](https://github.com/handcraftedcc/move-everything-superarp) | superarp | midi_fx | MIT | C 92k Python 1k | **A** | single-file C midi_fx |
| [j3threejay/move-anything-plaits](https://github.com/j3threejay/move-anything-plaits) | plaits | sound_generator | MIT | C++ 1147k Linker Script 30k | **A** | Mutable Plaits C++ (stmlib) |
| [james-fish/schwung-omega](https://github.com/james-fish/schwung-omega) | omega | sound_generator | none | C 1060k Python 4k | **A** | plain C (Makefile), FTZ asm guarded by __aarch64__; NO LICENSE |
| [legsmechanical/schwung-busdriver](https://github.com/legsmechanical/schwung-busdriver) | busdriver | audio_fx | MIT | Python 131k C++ 120k | **A** | single-file C++ bus glue |
| [legsmechanical/schwung-chonk](https://github.com/legsmechanical/schwung-chonk) | chonk | sound_generator | GPL-3.0 | Rust 666k C++ 151k | **A** | Faust-generated C++ (Rust original only for reference) |
| [legsmechanical/schwung-noisemaker](https://github.com/legsmechanical/schwung-noisemaker) | noisemaker | sound_generator | GPL-2.0 | C 606k C++ 409k | **A** | TAL NoiseMaker C++ with juce_shim (no real JUCE) |
| [legsmechanical/schwung-ottx](https://github.com/legsmechanical/schwung-ottx) | ottx | audio_fx | GPL-3.0 | C 68k JavaScript 4k | **A** | single-file C OTT; FTZ asm guarded |
| [legsmechanical/schwung-pushnpull](https://github.com/legsmechanical/schwung-pushnpull) | pushnpull | audio_fx | none | C 87k JavaScript 23k | **A** | plain C sidechain shaper; NO LICENSE |
| [legsmechanical/schwung-simian](https://github.com/legsmechanical/schwung-simian) | simian | sound_generator | GPL-3.0 | Rust 735k C++ 235k | **A** | Faust-generated C++ drum synth |
| [legsmechanical/schwung-stereoid](https://github.com/legsmechanical/schwung-stereoid) | stereoid | audio_fx | MIT | C 91k JavaScript 11k | **A** | small C widener |
| [mestela/schwung-impressive-chords](https://github.com/mestela/schwung-impressive-chords) | impressive-chords | midi_fx | none | C 213k Python 17k | **A** | C midi_fx; one system(python) call to strip; NO LICENSE |
| [mestela/schwung-pixel-walkers](https://github.com/mestela/schwung-pixel-walkers) | pixel-walkers | midi_fx | MIT | C 32k JavaScript 8k | **A** | small C midi_fx |
| [mestela/schwung-ruminant](https://github.com/mestela/schwung-ruminant) | ruminant | audio_fx | MIT | C 24k Python 0k | **A** | small C freq-shift delay |
| [mestela/schwung-sophie](https://github.com/mestela/schwung-sophie) | sophie | sound_generator | MIT | C 48k JavaScript 15k | **A** | single-file C FM percussion |
| [mission-minnow/groovebank](https://github.com/mission-minnow/groovebank) | groovebank | midi_fx | MIT | C 54k JavaScript 9k | **A** | C midi_fx; small bundled templates |
| [seajaysec/war-bells](https://github.com/seajaysec/war-bells) | war_bells | audio_fx | AGPL-3.0 | C 254k HTML 66k | **A** | plain C; ALREADY has wasm/build_wasm.sh + wbw.c browser glue; AGPL |
| [andree182/schwung-fork](https://github.com/andree182/schwung-fork) | fork | midi_fx | GPL-3.0 | C 56k Python 1k | **B** | MIDI router; io pthread + glibc .symver asm; low value in browser |
| [athousanddetails/schwung-tablor](https://github.com/athousanddetails/schwung-tablor) | tablor | sound_generator | BSD-3-Clause | C 547k C++ 286k | **B** | wavetable synth; dr_flac + wavetable files from module_dir; rt thread header |
| [CatsAreCool710/Move-Everything-Tuner](https://github.com/CatsAreCool710/Move-Everything-Tuner) | tuner | tool | GPL-3.0 | C 82k JavaScript 56k | **B** | tool: pitch-detect C + JS UI; needs audio-in + UI-host emulation |
| [chaolue/schwung-arranger](https://github.com/chaolue/schwung-arranger) | arranger | overtake | MIT | JavaScript 746k C 588k | **B** | overtake: 588k C + 746k JS; pthread; needs full UI-host |
| [charlesvestal/schwung-autosample](https://github.com/charlesvestal/schwung-autosample) | samplerobot | tool | MIT | C 54k JavaScript 13k | **B** | tool: samples external MIDI gear -> SFZ; needs WebMIDI out, audio-in, file writes |
| [charlesvestal/schwung-capicola](https://github.com/charlesvestal/schwung-capicola) | capicola | audio_fx | AGPL-3.0 | C++ 122k C 13k | **B** | C++ time stretcher; pthread; AGPL |
| [charlesvestal/schwung-hank](https://github.com/charlesvestal/schwung-hank) | hank | sound_generator | none | C++ 100k Python 47k | **B** | C++ 2-op FM; pthread in DSP; NO LICENSE |
| [charlesvestal/schwung-keydetect](https://github.com/charlesvestal/schwung-keydetect) | keydetect | audio_fx | MIT | C++ 29k C 19k | **B** | libkeyfinder + FFTW3 (built in Docker); pthread |
| [charlesvestal/schwung-midi-player](https://github.com/charlesvestal/schwung-midi-player) | midi-player | midi_fx | MIT | C 40k | **B** | midi_fx; reads .mid files from disk (VFS) |
| [charlesvestal/schwung-midiverb](https://github.com/charlesvestal/schwung-midiverb) | midiverb | audio_fx | GPL-3.0 | C 865k Python 3k | **B** | plain C emulator but needs Alesis ROM data (rom.h) |
| [charlesvestal/schwung-monksynth](https://github.com/charlesvestal/schwung-monksynth) | monksynth | sound_generator | MIT | C 118k JavaScript 98k | **B** | C FOF synth; pthread |
| [charlesvestal/schwung-mrsample](https://github.com/charlesvestal/schwung-mrsample) | mrsample | sound_generator | MIT | C 724k C++ 66k | **B** | sample player; dr_wav/mp3/flac + file browser (VFS) |
| [charlesvestal/schwung-munchi-delay](https://github.com/charlesvestal/schwung-munchi-delay) | munchi-delay | audio_fx | MIT | C++ 120k C 26k | **B** | DaisySP C++; std::thread loader |
| [charlesvestal/schwung-rex](https://github.com/charlesvestal/schwung-rex) | rex | sound_generator | MIT | C 124k JavaScript 1k | **B** | REX2 slice player; needs user .rx2 files (VFS) |
| [charlesvestal/schwung-sf2](https://github.com/charlesvestal/schwung-sf2) | sf2 | sound_generator | LGPL-2.1 | C 30k JavaScript 0k | **B** | FluidLite (+vorbis) C; .sf2 via VFS |
| [charlesvestal/schwung-tb3po](https://github.com/charlesvestal/schwung-tb3po) | tb3po | tool | GPL-3.0 | JavaScript 178k C 66k | **B** | tool: generative seq C + JS UI; pthread state worker |
| [charlesvestal/schwung-waveform-editor](https://github.com/charlesvestal/schwung-waveform-editor) | waveform-editor | tool | MIT | JavaScript 146k C 135k | **B** | tool: on-device audio file editor (C + JS); file-centric |
| [dony01001/ChordDex](https://github.com/dony01001/ChordDex) | chorddex | tool | MIT | JavaScript 59k C 6k | **B** | tool: tiny C MIDI monitor + JS UI |
| [eightfour-dev/schwung-guitar-tuner](https://github.com/eightfour-dev/schwung-guitar-tuner) | guitar-tuner | tool | MIT | C 12k JavaScript 11k | **B** | tool: small C tuner + JS UI; audio-in |
| [filliformes/aphex-move](https://github.com/filliformes/aphex-move) | aphex | sound_generator | MIT | C 189k | **B** | single-file C MS-20; mmaps host /dev/shm (stub out) |
| [filliformes/denis-move](https://github.com/filliformes/denis-move) | denis | sound_generator | MIT | C 85k | **B** | single-file C Serge synth; shm shadow-control (stub out) |
| [filliformes/forge-move](https://github.com/filliformes/forge-move) | forge | sound_generator | MIT | C 334k Python 25k | **B** | single-file C drum synth; io pthread |
| [filliformes/magneto-move](https://github.com/filliformes/magneto-move) | magneto | audio_fx | MIT | C 99k | **B** | single-file C tape looper; io pthread |
| [filliformes/punchfx-move](https://github.com/filliformes/punchfx-move) | punchfx | audio_fx | MIT | C 52k JavaScript 8k | **B** | single-file C FX; shm shadow-control + pressure pads |
| [filliformes/weird-dreams-move](https://github.com/filliformes/weird-dreams-move) | weird-dreams | sound_generator | none | C 139k | **B** | single-file C drum machine; io pthread; NO LICENSE |
| [graebe/neon-ingvy-audio-plugins](https://github.com/graebe/neon-ingvy-audio-plugins) | trance-gate | audio_fx | GPL-3.0 | C++ 2242k Rust 2181k | **B** | Rust crate (tg-move) in a huge JUCE/Rust monorepo; build via cargo wasm32 not emcc; needs song position |
| [graebe/schwung-drums-practice](https://github.com/graebe/schwung-drums-practice) | drums-practice | tool | GPL-3.0 | JavaScript 667k Rust 64k | **B** | tool: Rust DSP + 667k JS UI |
| [graebe/schwung-piano-practice](https://github.com/graebe/schwung-piano-practice) | piano-practice | tool | GPL-3.0 | JavaScript 752k Rust 36k | **B** | tool: Rust DSP + 752k JS UI |
| [handcraftedcc/move-everything-granny](https://github.com/handcraftedcc/move-everything-granny) | granny | sound_generator | none | C++ 83k Rich Text Format 34k | **B** | granular sampler; file browser/samples (VFS); NO LICENSE |
| [handcraftedcc/move-everything-mrdrums](https://github.com/handcraftedcc/move-everything-mrdrums) | mrdrums | sound_generator | MIT | C++ 147k C 4k | **B** | 16-pad sample drums; samples via VFS |
| [j3threejay/move-anything-slicer](https://github.com/j3threejay/move-anything-slicer) | slicer | sound_generator | none | C 596k C++ 102k | **B** | sample slicer; dr_flac/minimp3 + user samples; NO LICENSE |
| [kliegsablaze/elusive-muse](https://github.com/kliegsablaze/elusive-muse) | elusive-muse | audio_fx | none | JavaScript 105k C 48k | **B** | audio_fx that is mostly display (prompts); pthread; NO LICENSE |
| [kliegsablaze/forgetful](https://github.com/kliegsablaze/forgetful) | forgetful | audio_fx | none | C 340k JavaScript 25k | **B** | C tape memories; pthread; NO LICENSE |
| [kliegsablaze/quilt](https://github.com/kliegsablaze/quilt) | quilt | sound_generator | PolyForm-Strict | C 493k JavaScript 74k | **B** | C instruments (16 files); pthread; PolyForm-Strict (no porting rights) |
| [kliegsablaze/strut](https://github.com/kliegsablaze/strut) | strut | sound_generator | PolyForm-Strict | C 365k JavaScript 59k | **B** | C drum synth + 50MB samples; pthread; PolyForm-Strict |
| [kliegsablaze/wayward](https://github.com/kliegsablaze/wayward) | wayward | audio_fx | none | C 134k Python 5k | **B** | C looper; pthread; NO LICENSE |
| [legsmechanical/schwung-davebox](https://github.com/legsmechanical/schwung-davebox) | davebox | tool | MIT | C 1393k JavaScript 1355k | **B** | tool: 1.4MB C sequencer + 1.3MB JS UI; files |
| [legsmechanical/schwung-rrverb10](https://github.com/legsmechanical/schwung-rrverb10) | rrverb10 | audio_fx | LGPL-2.1 | JavaScript 150k C++ 35k | **B** | chip emulator; needs non-redistributable Roland ROM |
| [lukeco11/chord-finder-for-move](https://github.com/lukeco11/chord-finder-for-move) | chord-finder | tool | MIT | JavaScript 129k C 47k | **B** | tool: C + JS UI |
| [mestela/schwung-breakbeat](https://github.com/mestela/schwung-breakbeat) | breakbeat | sound_generator | none | C 212k JavaScript 17k | **B** | C; 16MB bundled breaks, mmap file load, pthread; NO LICENSE |
| [mestela/schwung-libpo32](https://github.com/mestela/schwung-libpo32) | po32-drum | sound_generator | none | C 297k JavaScript 8k | **B** | C drum synth; render pthread; NO LICENSE |
| [mestela/schwung-scratch](https://github.com/mestela/schwung-scratch) | scratch | sound_generator | GPL-3.0 | C 90k JavaScript 25k | **B** | sample scratcher; 10MB sample, loader thread, DVS |
| [mission-minnow/beatbank](https://github.com/mission-minnow/beatbank) | beatbank | midi_fx | MIT | C 46k JavaScript 8k | **B** | midi_fx; .beat files + midi_inject_to_move |
| [pdubucq/schwung-setbfree](https://github.com/pdubucq/schwung-setbfree) | setbfree-organ | sound_generator | GPL-2.0 | C 508k Python 7k | **B** | setBfree C (CMake); pthread, config files |
| [sd88me/schwung-acid](https://github.com/sd88me/schwung-acid) | acid | midi_fx | none | C 107k | **B** | C midi_fx; pthread; NO LICENSE |
| [sd88me/schwung-clementineXT](https://github.com/sd88me/schwung-clementineXT) | clementine-xt | sound_generator | GPL-3.0 | C 175k HTML 84k | **B** | C wavetable synth; pthread, SSE guarded, wavetable data |
| [sd88me/schwung-maze](https://github.com/sd88me/schwung-maze) | maze_seq, maze_seq_lite, maze-voice (A) | midi_fx,sound_generator,tool | MIT | C 97k HTML 78k | **B** | 3 modules: maze-voice is plain C; seqs use pthread |
| [skerryvibe/oktonik](https://github.com/skerryvibe/oktonik) | oktonik | tool | MIT | JavaScript 391k C 117k | **B** | tool: C + 391k JS UI |
| [timncox/schwung-belt](https://github.com/timncox/schwung-belt) | belt, belt-in | audio_fx,sound_generator | MIT | C 95k C++ 35k | **B** | autotune/harmonizer C/C++; needs audio-in via mapped_memory |
| [timncox/schwung-mark](https://github.com/timncox/schwung-mark) | mark | overtake | MIT | C 186k JavaScript 64k | **B** | overtake looper; pthread; mapped_memory |
| [timncox/schwung-mono](https://github.com/timncox/schwung-mono) | mono, mono-voice (A) | overtake,sound_generator | MIT | C 250k JavaScript 126k | **B** | mono-voice is plain C; overtake needs UI-host |
| [timncox/schwung-smack](https://github.com/timncox/schwung-smack) | smack, smack-in, oversmack | audio_fx,overtake,sound_generator | MIT | C 187k JavaScript 66k | **B** | slice-glitch looper C; audio-in via mapped_memory; overtake variant |
| [timncox/schwung-work](https://github.com/timncox/schwung-work) | work | audio_fx | MIT | C 499k JavaScript 301k | **B** | 26 machines incl sample sources; 1MB C + JS; mapped_memory |
| [wolfrenegade1976/move-anything-dragonfly-hall](https://github.com/wolfrenegade1976/move-anything-dragonfly-hall) | dragonfly-hall | audio_fx | GPL-3.0 | C++ 8k JavaScript 2k | **B** | Dragonfly Hall reverb; DSP source git-cloned at build (freeverb3 subset) |
| [andree182/schwung-helm](https://github.com/andree182/schwung-helm) | helm | sound_generator | GPL-3.0 | C++ 45k JavaScript 1k | **C** | Helm + JUCE submodule (CMake); big C++ codebase |
| [charlesvestal/schwung-airwindows](https://github.com/charlesvestal/schwung-airwindows) | clap | audio_fx | MIT | C++ 102k C 59k | **C** | CLAP host: dlopen()s airwin2rack .clap; pthread. Airwindows DSP itself is plain C++ (could be statically linked) |
| [charlesvestal/schwung-je8086](https://github.com/charlesvestal/schwung-je8086) | jp8000 | sound_generator | none | C++ 293k Python 85k | **C** | Gearmulator DSP56300 JIT emulator + ROM; threads, mmap; NO LICENSE |
| [charlesvestal/schwung-jv880](https://github.com/charlesvestal/schwung-jv880) | minijv | sound_generator | MAME-style (non-commercial) | C++ 440k JavaScript 77k | **C** | Nuked-SC55-style ROM emulator (user ROMs), NEON resampler, threads, mmap; non-commercial license |
| [charlesvestal/schwung-nam](https://github.com/charlesvestal/schwung-nam) | nam | audio_fx | MIT | C++ 30k C 10k | **C** | NeuralAudio/RTNeural/Eigen submodule; .nam model files; pthread |
| [charlesvestal/schwung-performance-fx](https://github.com/charlesvestal/schwung-performance-fx) | performance-fx | overtake | MIT | C++ 13498k Fortran 1295k | **C** | overtake; Bungee + Eigen + FFTW-ish, 870 src files, threads |
| [charlesvestal/schwung-sfz](https://github.com/charlesvestal/schwung-sfz) | sfz | sound_generator | MIT | C 407k Python 19k | **C** | sfizz + Rust xsynth shim; threads; sample libraries |
| [charlesvestal/schwung-stems](https://github.com/charlesvestal/schwung-stems) | stems | tool | MIT | C 15k Python 5k | **C** | tool: SpleeterRT neural stem separation, offline file processing |
| [charlesvestal/schwung-stretch](https://github.com/charlesvestal/schwung-stretch) | stretch | tool | MIT | C++ 29k JavaScript 26k | **C** | tool: Bungee (Eigen) timestretch; prebuilt dsp.so committed |
| [charlesvestal/schwung-surge](https://github.com/charlesvestal/schwung-surge) | surge | sound_generator | GPL-3.0 | C++ 62k JavaScript 1k | **C** | Surge XT submodule (huge, CMake, JUCE-adjacent deps) |
| [charlesvestal/schwung-virus](https://github.com/charlesvestal/schwung-virus) | osirus | sound_generator | GPL-3.0 | C++ 155k HTML 81k | **C** | Gearmulator DSP56300 JIT (Virus) + ROM; threads, mmap |
| [DimaDake/schwung-movy](https://github.com/DimaDake/schwung-movy) | movy | tool | MIT | JavaScript 2393k TypeScript 2272k | **C** | tool: Rust engine that itself hosts other modules (dlopen chain_host), render thread pool, 2.3MB TS UI |
| [djhardrich/move-anything-dj](https://github.com/djhardrich/move-anything-dj) | dj | tool | CC-BY-NC-SA-4.0 | C 516k JavaScript 129k | **C** | tool: Bungee timestretch + stems, threads; CC-BY-NC-SA |
| [filliformes/loopex-move](https://github.com/filliformes/loopex-move) | loopex | overtake | none | C 500k JavaScript 124k | **C** | overtake: samples other Move tracks over Link Audio/shm; threads; NO LICENSE |
| [legsmechanical/schwung-dr32](https://github.com/legsmechanical/schwung-dr32) | dr32 | sound_generator | GPL-3.0 | C 1206k C++ 1029k | **C** | loads Move factory .ablpreset kits/samples; threads; many engines incl chowdsp |
| [sd88me/schwung-kit-builder](https://github.com/sd88me/schwung-kit-builder) | kit-builder | overtake | MIT | JavaScript 263k C 43k | **C** | overtake: builds kits from Move sample library; threads |
| [boorch/dronage-move-release](https://github.com/boorch/dronage-move-release) | dronage-tool | tool | none | - | **D** | release-only repo, no source (binary tarball) |
| [charlesvestal/schwung-airplay](https://github.com/charlesvestal/schwung-airplay) | airplay | sound_generator | MIT | C 25k JavaScript 4k | **D** | AirPlay receiver (shairport-sync, avahi, sockets) |
| [charlesvestal/schwung-radiogarden](https://github.com/charlesvestal/schwung-radiogarden) | radiogarden | sound_generator | MIT | JavaScript 80k C 31k | **D** | network radio streaming (curl/ffmpeg, pthread) |
| [charlesvestal/schwung-webstream](https://github.com/charlesvestal/schwung-webstream) | webstream | sound_generator | MIT | C 122k Python 39k | **D** | yt-dlp + ffmpeg network streaming |
| [handcraftedcc/schwung-StreamRTSP](https://github.com/handcraftedcc/schwung-StreamRTSP) | streamrtsp | sound_generator | MIT | Rich Text Format 107k C 48k | **D** | RTSP network receiver (sockets, librespot) |
| [jrucho/schwung-twinsampler](https://github.com/jrucho/schwung-twinsampler) | twinsampler | overtake | none | C 522k JavaScript 254k | **D** | core DSP is a prebuilt aarch64 ELF embedded as dsp_core_blob.h; no core source; NO LICENSE |
| [timncox/schwung-overwork](https://github.com/timncox/schwung-overwork) | overwork | overtake | MIT | - | **D** | distribution-only repo (release.json -> schwung-work tarball); source lives in timncox/schwung-work |
| [timncox/schwung-overwork-mix](https://github.com/timncox/schwung-overwork-mix) | overwork-mix | overtake | none | - | **D** | distribution-only repo; source in schwung-work; NO LICENSE |
| [timncox/schwung-work-in](https://github.com/timncox/schwung-work-in) | work-in | sound_generator | MIT | - | **D** | distribution-only repo; source in schwung-work |
| [chaolue/move-anything-control](https://github.com/chaolue/move-anything-control) | control | overtake | none | JavaScript 61k | **J** | JS-only overtake (MIDI controller) |
| [charlesvestal/schwung-m8](https://github.com/charlesvestal/schwung-m8) | m8 | overtake | CC-BY-NC-SA-4.0 | JavaScript 24k Python 16k | **J** | JS-only overtake (Launchpad emu for M8 over USB); CC-BY-NC-SA |
| [charlesvestal/schwung-sidcontrol](https://github.com/charlesvestal/schwung-sidcontrol) | sidcontrol | overtake | MIT | JavaScript 9k | **J** | JS-only overtake (SIDaster controller) |
| [eightfour-dev/schwung-ai-assistant](https://github.com/eightfour-dev/schwung-ai-assistant) | ai-assistant | tool | none | JavaScript 33k | **J** | JS-only tool; cloud LLM/voice API; NO LICENSE |
| [eightfour-dev/schwung-ai-manual](https://github.com/eightfour-dev/schwung-ai-manual) | ai-manual | tool | none | JavaScript 41k | **J** | JS-only tool; cloud LLM/voice API; NO LICENSE |
| [madeinspace/move-juno-controller](https://github.com/madeinspace/move-juno-controller) | juno_control | overtake | none | JavaScript 38k | **J** | JS-only overtake (SysEx editor); NO LICENSE |
| [pi43r/move-bitwig](https://github.com/pi43r/move-bitwig) | move-bitwig | overtake | none | JavaScript 193k Python 3k | **J** | JS-only overtake (Bitwig controller, network); NO LICENSE |
| [samircaus/move-anything-snake](https://github.com/samircaus/move-anything-snake) | snake | overtake | MIT | JavaScript 21k | **J** | JS-only overtake (game) |
