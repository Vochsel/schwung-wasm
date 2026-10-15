# schwung-wasm: scoping a browser emulation of Schwung on a virtual Ableton Move

Source studied: `third_party/schwung` (read-only). All paths below are relative to it.
Docs read first: `AGENTS.md`, `CLAUDE.md` (index), `README.md`, `docs/ARCHITECTURE.md`, plus targeted parts of `docs/MODULES.md`, `docs/SPI_PROTOCOL.md`, `docs/REALTIME_SAFETY.md`, `docs/BOOT_TARGETS.md`, `BUILDING.md`/`scripts/build.sh`.

---

## TL;DR

- **The thing users know as "Schwung" is NOT `schwung_host.c`.** On device, every JS module runs inside the `shadow_ui` QuickJS process, and all DSP (chain slots, Master FX, sends, buses, LFOs, scenes) runs inside the LD_PRELOAD shim (`schwung-shim.so`) in Ableton's `MoveOriginal` (`docs/ARCHITECTURE.md:50-54`). The standalone host (`src/schwung_host.c`) is built and shipped but **never invoked on device**; it has no chain host and no shadow UI.
- So "emulate Schwung's real UI and real modules" = emulate **shim core + chain host + shadow_ui (QuickJS + `shadow_ui.js`, 31k lines)**, with a **"Virtual Move" stand-in** for the closed firmware: it turns pads into notes on the selected track channel, owns the transport/BPM, and lets the shadow UI own the OLED full-time.
- The shim↔shadow_ui boundary is **entirely POSIX SHM structs** (`src/host/shadow_constants.h`) plus a **synchronous busy-wait param channel** that the shim serves once per 128-frame block (`shadow_ui.c:1672`, served at `schwung_shim.c:7088` → `shadow_chain_mgmt.c:5379`). That maps almost 1:1 onto **one Emscripten pthreads program on a shared `WebAssembly.Memory`**: each SHM segment becomes a static shared region, `fork/exec shadow_ui` becomes `pthread_create`, and the busy-wait becomes `Atomics.wait`.
- **Recommendation:**
  - Compile the real C to wasm: chain host as-is; the shim core minus Move-specific subsystems; `shadow_ui.c` + QuickJS + `js_display.c`.
  - Run DSP in a dedicated "device" worker that renders ahead into a SharedArrayBuffer (SAB) ring, with a thin AudioWorklet that only copies.
  - Run QuickJS-in-wasm in a UI worker for M2 fidelity.
  - Statically register built-in modules first, then use Emscripten `SIDE_MODULE` + `dlopen` for the catalog.
  - **Total ≈ 75–110 engineer-days** to a usable M3. M0–M1 alone is ≈ 2.5–3.5 weeks.
- **Cannot be emulated without Ableton's firmware:** Move's own tracks, instruments, sequencer and clips, and everything Schwung layers over them (Link Audio Move→Schwung FX, automation lanes and p-locks, step chance, edit-follow, one-undo, the Song.abl/live-model-driven mute/solo/volume follow, Move's metronome, screen-reader text from Move, set pages tied to Move sets).

---

## 1. Run modes

### 1a. Shadow mode: `schwung-shim.so` inside MoveOriginal (the shipping mode)

Boot path:
- `/opt/move/Move` is `shim-entrypoint.sh`, a boot selector.
- It runs `schwung-entry.sh`, which sets `LD_PRELOAD=schwung-shim.so` and execs `MoveOriginal` (`docs/ARCHITECTURE.md` Layer 1, `docs/BOOT_TARGETS.md`).

**Hooks**
- `open`/`open64`/`mmap`/`ioctl` come from `src/lib/schwung_spi_lib.c:156/180/201/218`.
  - `mmap` hands Move a private 4 KB "shadow" page instead of the hardware page.
  - `ioctl(WAIT_AND_SEND, 768)` is wrapped as: `pre_fn` → copy TX half to HW → real ioctl (EINTR retry) → copy RX half back → `post_fn`.
- `connect`/`send` are at `schwung_shim.c:833/851`, and `sd_bus_default_system`/`sd_bus_start` at `:872/889`. They feed `shadow_dbus.c` (screen reader text capture).
- The constructor is `schwung_shim.c:11838`. It calls `schwung_spi_set_callbacks(shim_pre_transfer, shim_post_transfer)` (`:11854`), creates the JACK bridge (`:11857`), starts worker threads, `move_model_start()` (`:11886`), and so on.

**Per SPI frame (128 frames, 44.1 kHz, about 2.9 ms)**

`shim_pre_transfer` (`schwung_shim.c:6648`) does, in order:
- `shadow_forward_midi`
- `shadow_mix_audio` (`:4930`, which calls `shadow_inprocess_render_to_buffer` `:2188` / `mix_from_buffer` `:2890`)
- UI requests, fades
- **`shadow_inprocess_handle_param_request()`** (`:7088`)
- web param ring
- `shadow_dispatch_direct_external_midi`
- `shadow_inprocess_process_midi()` (`:1451`, which scans Move's MIDI_OUT)
- `shadow_drain_ui_midi_dsp`
- TTS mix
- `shadow_swap_display`
- LED queue flush (`shadow_flush_pending_leds`)
- …

`shim_post_transfer` (`:8415`) filters, swallows and compacts MIDI_IN, handles shortcuts and jack-detect, and forwards cable-0 input to the shadow UI.

**What depends on the stock Move app, its SPI mailbox, or the hardware**

| Dependency | Where | Emulatable? |
|---|---|---|
| SPI mailbox / XMOS (`/dev/ablspi0.0`) | `src/lib/schwung_spi_lib.{c,h}` | Yes. Replace it with a virtual mailbox and call pre/post per block. |
| **Chain slots are fed from Move's MIDI_OUT echo** (cable 2), not from pads directly | `schwung_shim.c:1451-1618` → `shadow_chain_dispatch_midi_to_slots` (`src/host/shadow_midi.c:319`); see the comment at `schwung_shim.c:11048` | Must be **synthesized**: Virtual Move emits note on/off on the slot's receive channel. |
| Move's live song model (heap read via `process_vm_readv`) | `src/host/move_model.c:349,1317`, sync `move_model_sync.c`, wired at `schwung_shim.c:2225-2266, 6997-7004, 9562` | No (closed binary). Stub it as "model not live". |
| Song.abl / per-set state (`set_state/<uuid>`) | `schwung_shim.c:6233`, `shadow_set_pages.c:121,381,700`, `song_abl_mix.h` | Partially. Fake a single "set" UUID. |
| Link Audio (Move per-track audio → shadow FX) | `link_subscriber.cpp`, `shadow_link_audio.c`, `/schwung-link-in` | No Move tracks exist, so this is N/A. Optionally route WebAudio input. |
| D-Bus screen reader (Move's announcements) | `shadow_dbus.c:473-880` | N/A. Schwung's own TTS could use `speechSynthesis`. |
| Lanes / p-locks / step chance / edit-follow / undo | `chain_lanes.c`, `lane_*.c`, `edit_follow.c`, `undo_timeline.c`, `step_*` | No. They are inert without the model (`chain_set_clip_phase` is never driven). |
| Transport / BPM / beat position | `host->get_bpm`, `get_beat_position`; `chain_get_clock_status` polls Move's `Settings.json` (`chain_midi.c:159-165`) | Yes. Virtual Move provides a clock. |
| Master volume from Move's model | `CLAUDE.md` "Gain staging" | Yes. Virtual knob CC79. |
| XMOS jack-detect CC 114/115 | `schwung_shim.c:9490-9516` | Yes, synthesize them. |

### 1b. Standalone mode: `src/schwung_host.c` (+ `start.sh`, `launch-standalone.sh`)

**`schwung_host.c` main** (`:2161`)
- It opens `/dev/ablspi0.0` directly (`:2202-2225`), not through `schwung_spi_lib`.
- It calls `mm_init` and `mm_scan_modules` (`:2242/2249`). `module_manager.c:470` `mm_load_module` dlopens `<module>/dsp.so` (`:496`) and dlsyms the v2/v1 init (`:506/525`).
- It evals `argv[1]`, or `move_default.js` (`:2181`). `src/start.sh` runs `./schwung ./host/menu_ui.js` after killing Move.

**Loop** (`:2393`)
1. JS `tick()`
2. `mm_render_block` (`:2439`)
3. MIDI clock (`:2456`)
4. LEDs
5. blocking ioctl (`:2465`)
6. MIDI_IN scan, with cable 2 going to `onMidiMessageExternal` and cable 0 to `onMidiMessageInternal` (`:2469-2568`)
7. display slice push (`:2574-2588`, `host_flush_display` `:1857`)

It has **no chain host, no shadow UI, and no SHM**. It is one module at a time, with the old `menu_ui.js` and a TTF font path (`stb_truetype`, `:25, :498-531`). There are 50 `JS_NewCFunction` bindings.

**`launch-standalone.sh`** is unrelated to `schwung_host.c`. It launches a *tool module's own* `standalone` binary (`docs/MODULES.md:132-160`):
1. SIGTERM shadow_ui
2. pause `move-launcher.service` via `schwung-heal`
3. kill Move and Schwung
4. `fuser`-kill holders of the SPI device
5. run the binary
6. resume Move

Boot targets (`docs/BOOT_TARGETS.md:95-170`) can make such a binary boot directly.

**Verdict:** `schwung_host.c` is a useful *reference* for a minimal host (a ~40-line loop) but is not what users see. Do not port it as the product.

### 1c. Minimal component set for a standalone emulation

| Component | Source | Port strategy |
|---|---|---|
| Host loop ("virtual SPI frame") | Replaces `schwung_spi_lib.c` + `ioctl` | New, about 300 lines. Calls `shim_pre_transfer` / `shim_post_transfer` on a fake 4 KB page every 128 frames. |
| Shim core (slots, param serving, MIDI routing, mix, Master FX, sends, LED queue, display swap, overlays, sampler) | `schwung_shim.c` + `src/host/shadow_{chain_mgmt,midi,midi_filter,led_queue,overlay,scene_bus,sampler,state,transport,metronome,overtake_midi,set_pages}.c`, `shim_worker.c` | **Compile to wasm**, with Move-only subsystems (`move_model*`, `shadow_dbus`, `link_audio`, `xmos`, `rt_thread_audit`, `spi_tally`, `jack_bridge`, `tts_espeak`) behind `#ifdef SCHWUNG_WASM` stubs. This is the biggest porting chunk (~25k lines touched by the build; the edits are mostly ifdefs). |
| Chain host | `src/modules/chain/dsp/*.c` + `src/host/lane_*.c` (`scripts/build.sh:598-648`) | Compile as-is (one header fix, see §2). |
| Shadow UI process | `src/shadow/shadow_ui.c` (4414 lines, 150 bindings) + `js_host_common.c` + `js_display.c` + QuickJS 2025-04-26 | Compile to wasm and run in a pthread. |
| JS | `src/shadow/*.js/.mjs`, `src/shared/**`, module `ui.js`/`ui_chain.js` | Unchanged, served from a virtual FS at `/data/UserData/schwung/...`. |
| Display server | `src/host/display_server.c` (SSE over a socket for `/mirror`) | **Not needed.** The browser reads the 1 KB display buffer from shared memory directly. |
| Virtual Move | (new) | Front panel, a pad→note "instrument" layer, transport/clock, track select, LED renderer. |

### 1d. Features only available in shadow mode (layered on stock Move), which cannot be emulated without Ableton firmware

- Move's own synths, drum racks, sampler, sequencer, clips, Session/Note modes, set management, and the native UI. Pads normally play *Move's* track, and Schwung slots hear Move's MIDI_OUT echo.
- **Move→Schwung audio** (Link Audio per-track routing through slot FX, Latency Comp, `rebuild_from_la`), and Skipback/sampler "Move Input" capturing Move's audio.
- **Automation lanes, p-locks, step chance, scenes on steps, edit-follow (copy/paste/undo mirroring), one-undo timeline.** All of these resolve clips and phase from `move_model.c` (`docs/MOVE_MODEL.md`).
- Mute/solo/volume *follow* of Move tracks, Move's metronome state, master volume read from Move's mixer.
- Screen-reader announcements of Move's UI (D-Bus), the Move speaker-EQ emulation, and USB-C audio routing.
- Set-switch per-set slot state. This can be faked with one or more synthetic "sets".
- Co-run with `CORUN_TARGET_MOVE_NATIVE` (Move's native editor).

Everything else is emulatable: 4 slots with synth + 8 audio FX + MIDI FX, Master FX, sends/buses, LFO/mod, scenes, the knob grid, presets, overtake tools, the sampler (of Schwung audio), and the Tools menu. A simple Virtual Move sequencer could later stand in for Move's (out of scope for M0–M3).

---

## 2. Audio path and native plugin ABI

**Format**
- 44100 Hz, 128 frames/block, stereo **interleaved int16 LE**.
- Constants: `src/host/plugin_api_v1.h:116-123` (`MOVE_SAMPLE_RATE`, `MOVE_FRAMES_PER_BLOCK`, `MOVE_AUDIO_OUT_OFFSET 256`, `MOVE_AUDIO_IN_OFFSET 2304`); `src/lib/schwung_spi_lib.h:37-38`.
- `render_block` overwrites the buffer; audio FX `process_block` works in place.
- The shim sums internally in int32 and soft-clips once (`mix_soft_clip.h`).

**Plugin ABIs**

| API | Struct | Entry symbol |
|---|---|---|
| Instrument v1 (deprecated singleton) | `plugin_api_v1_t` `plugin_api_v1.h:334-388` (`on_load`, `on_unload`, `on_midi`, `set_param`, `get_param`, `get_error`, `render_block`) | `move_plugin_init_v1` (`:398`) |
| **Instrument v2** | `plugin_api_v2_t` `:413-432` (`create_instance(module_dir, json_defaults)`, `destroy_instance`, `on_midi(inst,msg,len,src)`, `set_param`, `get_param`, `get_error`, `render_block(inst,int16*,frames)`) | `move_plugin_init_v2(const host_api_v1_t*)` (`:436`) |
| Audio FX v1 | `audio_fx_api_v1.h:14-38` | `move_audio_fx_init_v1` |
| **Audio FX v2** | `audio_fx_api_v2.h:16-49` (`create_instance`, `destroy_instance`, `process_block`, `set_param`, `get_param`, `on_midi`) | `move_audio_fx_init_v2` |
| **MIDI FX v1** | `midi_fx_api_v1.h:18-125` (`create_instance`, `destroy_instance`, `process_midi(in → out[16][3])`, `tick(frames, sr, out…)`, `set_param`, `get_param`) | `move_midi_fx_init` |

**`host_api_v1_t`** (`plugin_api_v1.h:160-316`): every callback a module can call.

| Field | Purpose |
|---|---|
| `api_version`, `sample_rate`, `frames_per_block` | constants |
| `mapped_memory`, `audio_out_offset`, `audio_in_offset` | raw mailbox pointer. `linein` reads input audio from `mapped_memory+2304` (`linein.c:1011-1016`), so **the wasm host must supply a fake 4 KB mailbox** |
| `log(const char*)` | logging |
| `midi_send_internal(msg,len)` | MIDI to Move surface (cable 0, LEDs) |
| `midi_send_external(msg,len)` | MIDI to USB-A (cable 2) |
| `get_clock_status()` | MIDI clock stopped/running (chain overrides it with `chain_get_clock_status`, which polls Move `Settings.json`) |
| `mod_emit_value(ctx, source_id, target, param, signal, depth, offset, bipolar, enabled)`, `mod_clear_source(ctx, source_id)`, `mod_host_ctx` | modulation bus (modules acting as LFO/mod sources) |
| `get_bpm()` | tempo |
| `midi_inject_to_move(msg,len)` | inject into Move's MIDI_IN |
| `slot_recv_channel(instance)` | slot's receive channel |
| `get_beat_position()` | transport beat |
| `reserved[8]` | must stay NULL (ABI drift guard) |

- **There are no file-path, sample-loading or allocation callbacks.** Modules get only `module_dir` (via `create_instance`) and do their own `fopen`, `opendir` and `malloc`.
- Optional dlsym'd exports:
  - `move_plugin_render_split` (`chain_synth_load.c:177`)
  - `move_audio_fx_on_midi` (`chain_fx_load.c:146`)
  - `schwung_move_info`, a host-exported seqlock that modules find with `dlsym(RTLD_DEFAULT, …)` (`move_info.h:141`, `move_info.c:155`)
- Chain-host exports the shim dlsyms (`shadow_chain_mgmt.c:2900-2933`):
  - `chain_set_inject_audio`, `chain_set_external_fx_mode`, `chain_process_fx`
  - `chain_fx_requires_continuous`, `chain_synth_requires_continuous`
  - `chain_drain_sends`, `chain_drain_main_send`
  - `chain_take_midi_tick_wake`
  - `chain_load_stage`, `chain_load_swap_step`, `chain_load_retire`
  - `chain_set_scene_morph`, `chain_take_lane_edit`, `chain_set_clip_phase`, `chain_set_clip_pass`
- **wasm32 gotcha:** `plugin_api_v1.h:325` has `_Static_assert(offsetof(host_api_v1_t, reserved) == 120)`, which is 68 on wasm32. Guard it with `#if UINTPTR_MAX == 0xFFFFFFFFFFFFFFFF`, or build wasm64 (memory64, which is less mature for AudioWorklet and toolchains). Modules are rebuilt anyway, so the 64-bit offsets do not matter.

**How the chain host loads modules**
- The shim dlopens `/data/UserData/schwung/modules/chain/dsp.so` (`shadow_chain_mgmt.h:74`, `shadow_chain_mgmt.c:2851-2877`), resolves `move_plugin_init_v2` and the extra exports, and creates 4 slot instances.
- The chain dlopens sub-modules relative to its `module_dir` with `RTLD_NOW|RTLD_LOCAL`:
  - synths: `../sound_generators/<id>/dsp.so` (`chain_synth_load.c:111,145`, with an `opendir` pack scan at `:113-139`)
  - audio FX: `../audio_fx/<id>/<id>.so` (`chain_fx_load.c:106`, `chain_bus.c:732`, `chain_host.c:262`)
  - MIDI FX: `../midi_fx/<id>/dsp.so` (`chain_fx_load.c:360`)
- Master FX and send FX are dlopened by the shim (`shadow_chain_mgmt.c:1639`).
- Sub-plugins get a memcpy of the host API with clock and mod callbacks overridden (`chain_host.c:106-112`).
- `module.json` `chain_params` / `ui_hierarchy` are parsed by `chain_params.c:638,857,1232` (strstr-based JSON in `chain_json.c`).

**Threading.** Entry points run on the SPI callback, except loads (`docs/REALTIME_SAFETY.md` rule 4; `CLAUDE.md` "Realtime safety"). `pthread_create` sites:

| Site | Thread | Needed in wasm? |
|---|---|---|
| `chain/dsp/chain_bus.c:950` | bus worker (dlopen, create, calloc of bus inserts) | yes (or run inline) |
| `host/shim_worker.c:1298` | **slot loader** (module loads off the callback) | yes |
| `host/shim_worker.c:1315` | shim worker (flag polling, sampler/skipback file I/O, deferred hooks) | yes |
| `schwung_shim.c:5528` | snapshot serializer | optional |
| `schwung_shim.c:5812, 11901` | Link-in attach retry | no |
| `schwung_shim.c:11862, 11892` | SPI timing / LED capture loggers | no |
| `host/move_model.c:1601` | Move heap reader | no |
| `host/schwung_trace.c:506` | OTLP exporter | no |
| `host/shadow_dbus.c:880` | D-Bus | no |
| `host/shadow_process.c:575` | link-subscriber monitor | no |
| `host/shadow_sampler.c:1038, 1992` | sampler / skipback WAV writers | yes (or post to the main thread) |
| `host/shadow_set_pages.c:1105` | set page change | maybe |
| `host/tts_engine_{espeak,flite}.c` | TTS | no (use Web Speech) |

- Third-party modules also spawn threads (e.g. keydetect and airwindows `clap`, see `plugin_api_v1.h:70-73`), and some **fork** DSP children (JP-8000, `capabilities.forks_processes`).
- fork/exec sites:
  - `shadow_process.c:223/240` (shadow_ui), `:377` (link-subscriber)
  - `js_host_common.c:151,186,753,777` (curl, tar)
  - `shadow_ui.c:2284,2517`, `module_manager.c:272`, `shim_worker.c:756-785`, `shadow_set_pages.c:899,1062`, `schwung_host.c:1642`, `analytics.c:154`
  - `shadow_ui.js:14130` (`os.exec` for Tools-menu file tools such as stem separation)

**Processes on device: 3 core, plus helpers**
1. `MoveOriginal` + shim. All DSP is here; the chain host is in-process.
2. `shadow_ui` (QuickJS).
3. `link-subscriber` (C++ Link Audio sidecar).

Plus `display-server` (SSE), `schwung-manager` (Go web UI, :7700), optional `jackd` + `jack_shadow.so` (RNBO), and `schwung-heal`.

**Shared memory** (`src/host/shadow_constants.h:21-40`, mapped by `shadow_shm_util.c:18`):

| Segment | Purpose |
|---|---|
| `/schwung-control` (`shadow_control_t`, ≤256 B, `:259`) | flags, display mode, overtake mode, `midi_ready`, `should_exit`, held_step, ... |
| `/schwung-ui` (`shadow_ui_state_t`, ≤512 B, `:1084`) | slot names, channels |
| `/schwung-param` (`shadow_param_t`, 133120 B, `:1144`) | the synchronous get/set channel |
| `/schwung-display` | 1024 B packed OLED from shadow_ui |
| `/schwung-ui-midi` | 1024 B shim → UI MIDI ring |
| `/schwung-midi-out` (4096 B) | UI → hardware LEDs/external |
| `/schwung-midi-dsp` (512 B) | UI → slot MIDI |
| `/schwung-midi-inject`, `/schwung-midi-inject-ui` | injection into Move |
| `/schwung-ext-midi-remap` | cable-2 channel remap table |
| `/schwung-cc-claim` | CC claims |
| `/schwung-screenreader` | screen-reader announcements |
| `/schwung-overlay` | sampler/skipback overlay state |
| Web-facing rings | `/schwung-display-live`, `-surface-live`, `-audio-live`, `-web-param-set/notify`, `-perf`, `-move-info` |
| Move/Link only | `/schwung-audio`, `/schwung-midi`, `/schwung-movein`, `-link-in`, `-pub-audio` |

**No chain or module DSP code touches SHM.** All of it is shim↔UI, web, or sidecar IPC, so in wasm every segment can be a static, zero-initialized shared struct.

---

## 3. UI / JS layer

**Runtime (shadow_ui process)**
- `main` is at `src/shadow/shadow_ui.c:4211`. It maps the SHM segments (`:112-149`) and inits QuickJS (`:3782-3792`): `js_std_init_handlers`, `js_std_add_helpers`, and `JS_SetModuleLoaderFunc(rt, NULL, js_module_loader, NULL)`, which is the stock quickjs-libc file loader.
- `JS_NewCustomContext` registers the `std` and `os` modules (`js_host_common.c:37-44`).
- It evaluates `/data/UserData/schwung/shadow/shadow_ui.js` as a module, then calls `init()` once.
- **Loop (`:4293-4407`):** MIDI from `/schwung-ui-midi` goes to `onMidiMessageInternal`/`onMidiMessageExternal`, then `tick()`, then `js_display_pack` → `memcpy` to `/schwung-display` (when dirty, or every 30 ticks).
- It sleeps to an absolute deadline: **60 Hz**, or **500 Hz** for overtake mode ≥2 (`:4388-4406`).
- `shadow_load_ui_module(path)` (`:1134-1171`) evaluates a module's `ui.js`/`ui_chain.js` **synchronously** as a fresh module `path#N`. The caller swaps `init`/`tick`/`onMidi*` globals (`shadow_ui.js:7110-7150`).

**JS size:** `shadow_ui.js` is 31,127 lines; `src/shadow/*.mjs` 6.3k; `src/shared/*.mjs` 21.2k; `src/shared/param_pages/**` 26.8k. That is **≈85k lines** of JS that must run unmodified.

**Native bindings: 245 registrations in total**
- **174** are visible in the shadow UI (150 in `shadow_ui.c:3800-4030`, 13 display, 11 common).
- **61** are in the legacy standalone host.

| Category | Functions (file:line) |
|---|---|
| **Display** (`js_display.c:746-772`) | `set_pixel`, `draw_rect`, `fill_rect`, `draw_line`, `clear_screen`, `print`, `text_width`, `fill_circle`, `draw_circle`, `draw_arc`, `draw_image` (stb_image, threshold), `set_font` (bitmap PNG atlas + `.dat` charlist; default `/data/UserData/schwung/host/font.png` at `:484`), `get_font_height`. The buffer is 1 byte/pixel `[128*64]` (`:26`), packed SSD1306-style at `:231-244`. A TTF loader exists (`:377`) but nothing uses it. |
| **Display/SHM/overlay** (shadow_ui.c) | `host_flush_display`, `shadow_get_display_mode`, `shadow_set_display_overlay`, `shadow_get_overlay_sequence/state`, `display_mirror_set/get/set_shm`, `host_e16_mirror` |
| **LED / MIDI out** | `move_midi_internal_send` (cable 0, LEDs), `move_midi_external_send` (cable 2), `move_midi_cable_send`, `shadow_send_midi_to_dsp`, `shadow_restore_knob_leds`, `shadow_set_skip_led_clear`, `shadow_get_pad_led_snapshot` |
| **MIDI inject/remap/claims** | `move_midi_inject_to_move`, `host_ext_midi_remap_set/clear/enable`, `host_cc_claim_set`, `host_cc_learn`, `host_claim_ccs`, `host_ui_midi_pace`, `host_ui_midi_foreign` |
| **Params (sync IPC)** | `shadow_get_param` (`:1672`, tri-state string / `""` / `null`, busy-wait ≤100 ms), `shadow_set_param` (`:1549`), `shadow_set_param_timeout`, `shadow_get_params`, `shadow_set_params`, `shadow_request_patch`, `host_get_module_metadata` |
| **Control-state getters/setters** | `shadow_get_slots`, `shadow_get_slot_flags`, `shadow_set_focused_slot`, `shadow_get_ui_flags`, `shadow_clear_ui_flags`, `shadow_get_selected_slot`, `shadow_get_ui_slot`, `shadow_get_shift_held`, `shadow_get_delete_held`, `shadow_get_move_ui_mode`, `shadow_get_open_tool_cmd`, `shadow_get_plock_seq`, `shadow_get_held_step(_is_hold)`, `shadow_get_step_menu`, `shadow_get_lanes_driving_mask`, `host_pad_block`, `host_pad_observe`, `host_step_observe`, `host_scene_surface`, `host_external_surface`, `host_move_model_state`, `host_get_move_info`, plus ~25 settings mirrors (`stay_in_shadow_*`, `shadow_ui_trigger_*`, `skipback_*`, `set_pages_*`, `midi_indicator_*`, `overlay_knobs_*`, `shadow_metronome_set`, `shadow_speaker_eq_set`, `shadow_recall_quantize_set`, `shadow_scene_*`, `shadow_save_stems_set`) |
| **Scenes** | `shadow_get_scene_state`, `shadow_set_scene_ab/xfade/edit/unlock`, `shadow_clear_scene_flash` |
| **Overtake / co-run** | `shadow_set_overtake_mode`, `shadow_set_overtake_suppress_*`, `shadow_set/get_suspend_overtake`, `shadow_consume_resume_last_tool`, `shadow_inbound_pad_midi_active`, `shadow_overtake_*_active`, `shadow_corun_*` (9) + ~40 `CORUN_*` integer constants (`:3828-3867`) |
| **Module/process mgmt** | `shadow_load_ui_module`, `host_list_modules`, `host_rescan_modules`, `shadow_request_exit`, `shadow_control_restart`, `host_wake_all_slots`, `exit`, `host_system_cmd` |
| **Audio/sampler/jack** | `host_mute_move_audio`, `host_preview_play/stop`, `host_speaker_active`, `host_line_in_connected`, `host_sampler_start/stop/is_recording/set_source/set_silent/get_samples_written/set_external_stop/pause/resume/is_paused` |
| **TTS/screen reader** | `host_send_screenreader`, `tts_set/get_{enabled,speed,pitch,volume,engine,debounce}` |
| **Log/trace/analytics** | `shadow_log`, `unified_log`, `unified_log_enabled`, `host_trace_begin/end`, `host_track_event`, `host_get_device_ip`, `host_get_analytics_enabled/set` |
| **File IO / network** (`js_host_common.c:1090-1100`) | `host_file_exists`, `host_read_file`, `host_read_file_base64`, `host_write_file`, `host_ensure_dir`, `host_remove_dir`, `host_http_download` (spawns `/data/UserData/schwung/bin/curl`, `:30`), `host_http_download_background`, `host_http_request_background`, `host_extract_tar`, `host_extract_tar_strip` |
| **Legacy standalone host only** (`schwung_host.c:1954-2103`) | `host_load_module`, `host_load_ui_module`, `host_unload_module`, `host_return_to_menu`, `host_module_{set,get}_param`, `host_module_get_error`, `host_module_send_midi`, `host_is_module_loaded`, `host_get_current_module`, `host_launch_standalone`, `host_{get,set}_volume`, `host_{get,set}_setting`, `host_save/reload_settings`, `host_{set,get}_refresh_rate`, `get_int16/set_int16` (raw mailbox), a `display.*` object (10 methods), and its own copy of the draw functions |

Several `host_*` names that modules call are **defined in JS by `shadow_ui.js` itself** (`setupModuleParamShims`, `:6976`): `host_module_get/set_param(s)`, `host_module_set_param_blocking`, `host_exit_module`, `host_hide_module`, `host_swap_module`, `host_open_text_entry`, `host_tool_file_path`, and others. A shim gets these for free.

**QuickJS-specific APIs** (`import * as std from 'std'` / `import * as os from 'os'`) appear in 11 files: `shadow_ui.js`, `shadow_ui_{patches,tools,presets}.mjs`, `shared/store_utils.mjs`, `shared/param_pages/wav_io_qjs.mjs`, `shared/e16_surface.mjs`, `host/menu_settings.mjs`, `modules/chain/ui.js`, `modules/store/ui.js`, `modules/tools/file-browser/ui.js`.

| Call | Count |
|---|---|
| `std.loadFile` | 26 |
| `os.readdir` | 20 |
| `os.stat` | 18 |
| `os.remove` | 13 |
| `os.mkdir` | 6 |
| `std.open` (`read`/`seek`/`close`) | 4 |
| `os.sleep` | 3 |
| `os.rename` | 2 |
| `os.exec` / `os.waitpid` / `os.kill` (Tools-menu external processes, `shadow_ui.js:14130,14484,14506`) | 1 each |
| `os.open` / `os.read` / `os.close` (WAV header sniff, `:14020`) | 1 each |

- Also: `globalThis.os` is read in `shared/filepath_browser.mjs:161`. There is no `os.setTimeout` and no live dynamic `import()`.
- **Absolute imports:** 108 import statements name `/data/UserData/schwung/shared/...` (24+ files), alongside 289 relative imports.

**Could it run as native browser JS instead of QuickJS?** Yes, with this shim work:
- An import map (or a service worker that rewrites `/data/UserData/schwung/*` to the bundle URL).
- A `std`/`os` facade over a synchronous FS: an in-memory tree mirrored to OPFS, with OPFS SyncAccessHandles usable only in workers.
- 174 binding shims over SAB-mapped structs.
- `shadow_get_param` implemented as `Atomics.wait` in a **Worker**. It cannot run on the main thread, where `Atomics.wait` is forbidden.
- A synchronous `shadow_load_ui_module`. Browser `import()` is async, so the call sites would need awaiting, or module sources must be pre-fetched and evaluated through a sync module shim (e.g. fetch the text and transform it to a function with `new Function`, which breaks `import` statements inside module UIs).
- `os.exec` tools are unsupported.

This is all feasible, but it duplicates `shadow_ui.c` semantics. The cheaper, higher-fidelity path is to **compile QuickJS + `shadow_ui.c` to wasm**, which keeps all 174 bindings, the sync module loading and the `std`/`os` semantics on the Emscripten VFS. The existing Node pieces (`tools/param-pages/harness.mjs` framebuffer and draw context, `fake_device.mjs`, the per-test global stubs in `tests/host/test_param_pages_view.sh:29-57` and `test_shadow_slot_actions.sh:64-69`) are good templates for a native-JS M1 knob-grid demo and for a later native port.

---

## 4. Hardware I/O

**Mailbox** (`src/lib/schwung_spi_lib.h:33-72`, `docs/SPI_PROTOCOL.md`)
- TX:
  - MIDI_OUT at 0, 20 × 4 B USB-MIDI packets
  - display status u32 at 80
  - display slice at 84, 172 B
  - audio out at 256, 128 × 2 × int16
- RX:
  - MIDI_IN at 2048, **31 × 8 B** (4 B USB-MIDI + u32 timestamp)
  - display status at 2296
  - audio in at 2304
  - `spi_tx_time` at 4088
- The ioctl NRs actually implemented are 6, 7, 10 (`WAIT_AND_SEND_MESSAGE_WITH_SIZE`, 768), 11 and 12 (`:82-96`).
- USB-MIDI byte 0 is `cable<<4 | CIN`.
- **A zeroed MIDI_IN slot terminates the list** (`CLAUDE.md` "A zeroed MIDI_IN slot is a TERMINATOR"). Pack events from slot 0 with increasing timestamps.

**Cables:** 0 = Move surface, 2 = external USB-A, 14 = system (power button), 15 = SPI protocol.

**Input map** (`src/shared/constants.mjs:526-607`, `src/host/shadow_midi.h:17-48`, `schwung_shim.c:134-158`)
- Pads: notes **68–99**, bottom-left = 68, rows of 8 upward (`68 + (3-row)*8 + col`). Note-on with velocity, plus poly aftertouch (0xA0) while held.
- Steps: notes **16–31**.
- Touch notes:
  - **0–7** knob 1–8, **8** master volume, **9** jog
  - 127 = touched, <64 = released
- Knobs: CC **71–78**. Master volume: **CC 79**. Jog: **CC 14**.
- Encoding is relative two's-complement: 1..63 = clockwise, 65..127 = counter-clockwise (`input_filter.mjs:134-139` `decodeDelta`).
- Buttons are 127 on press, 0 on release:

| CC | Button |
|---|---|
| 3 | jog click |
| 40–43 | tracks, **reversed**: 43 = Track 1 |
| 49 | Shift |
| 50 | Menu (also Note/Session) |
| 51 | Back |
| 52 | Capture |
| 54 / 55 | Down / Up |
| 56 | Undo |
| 58 | Loop |
| 60 | Copy |
| 62 / 63 | Left / Right |
| 85 | Play |
| 86 | Rec |
| 88 | Mute |
| 118 | Sample (C code also defines 87; JS and the mirror use 118) |
| 119 | Delete |

- System: CC 114 is line-in detect, CC 115 is headphone/speaker (`schwung_shim.c:9490-9516`). Power is SysEx `F0 00 21 1D 01 01 3A …` (`:8815-8857`).

**LED output**
- Pads and steps use note-on, buttons use CC. The value is a palette index (128 colours, `constants.mjs:9-375`), or brightness 0–127 for white-only buttons.
- The **MIDI channel encodes animation**: 0 solid, 1–5 transition, 6–10 pulse, 11–15 blink, tempo-synced (`constants.mjs:662-677`, `surface_live_shm.h:20-21`).
- RGB override SysEx is `F0 00 21 1D 01 01 3B <ns> <idx> rl rh gl gh bl bh F7`, where ns 0x00 = note and 0x10 = CC (`surface_live_shm.h:22-27,130-154`, `shadow_led_queue.c:395-410,617-640`).
- The LED queue is rate-limited (`shadow_led_queue.c`). The shadow-UI MIDI-out buffer holds 128 packets per flush.

**Display**
- 128×64 1-bpp, SSD1306 page layout: byte `page*128 + x`, bit j (LSB) = row `page*8+j` (`js_display.c:231-244`).
- Hardware pull protocol (`src/host/display_pull.h`): XMOS asks for slice 1..6 at RX+2296; slices are 172 B, the last is 164 B. **In the browser, skip the slice protocol** and read the 1024 B frame directly.

**Reusable web viewer**
- `schwung-manager/static/mirror.html` (774 lines) already draws the full Move front panel on a canvas: OLED decode (`:143-153`), palette with white balance (`:89-126`, from Cycling '74's MIT `move_midi_emulator.html`), LED animation, pad and encoder geometry (`drawDevice` `:301-488`).
- It is **display-only** (fed by SSE from `display_server.c`). Add hit-testing, pointer drag for encoders, wheel for jog, keyboard and Web MIDI input, and you have the virtual Move.

---

## 5. Native dependencies that are hard in wasm

| Dependency | Where | Browser answer | Difficulty |
|---|---|---|---|
| **JACK** (`src/lib/jack2`, `JackShadowDriver.cpp`, `schwung_jack_bridge.c`) | Only for the RNBO runner overtake; shim mixes the JACK SHM at `schwung_shim.c:3077-3081` | **Drop it.** Stub `schwung_jack_bridge_*`. RNBO patches can export to wasm/JS natively (a separate "RNBO-web" path later). | trivial (drop) |
| **pthreads** | ~18 sites (table in §2) + third-party modules | Emscripten `-pthread` (SAB + Web Workers, needs COOP/COEP). Keep the slot loader, bus worker and shim worker; stub the rest. **Thread priorities and `taskset` are no-ops.** Pre-size the pool (`-sPTHREAD_POOL_SIZE`) because `pthread_create` must not block on worker spawn mid-session. | medium |
| **fork/exec/system/popen** | `shadow_process.c:223` (spawn shadow_ui), curl/tar in `js_host_common.c`, `os.exec` tools, JP-8000-style forked DSP | shadow_ui becomes a pthread entry (`shadow_ui_main`). curl/tar become `fetch` plus a JS untar (async, via a proxied call). `os.exec` tools are unsupported (stem separation and similar). Forking modules are unsupported unless reworked to threads. | medium |
| **Signals** | ~10 `signal`/`sigaction` sites (SIGSEGV crash handler, SIGTERM save, SIGCHLD) | Remove or no-op. The `should_exit` path already exists. | easy |
| **mmap/shm_open** | `shadow_shm_util.c:18` | Replace `shadow_shm_map(name,size,…)` with a name→static-buffer table in shared linear memory. One function. | easy |
| **ioctl/SPI** | `schwung_spi_lib.c`, `schwung_host.c` | Replaced by the virtual frame driver. | easy |
| **`process_vm_readv`, `/proc`** | `move_model.c`, CPU page | Stub ("model not live"). | easy |
| **Sockets** | `display_server.c:596`, `link_subscriber`, `test_daemon` (port 47777), D-Bus | Drop. Optionally re-implement the test daemon over `postMessage` for E2E tests. | easy (drop) |
| **dlopen/dlsym** | chain, shim (Master FX), module_manager | Emscripten dynamic linking (`MAIN_MODULE`/`SIDE_MODULE`) or a static symbol registry (§6). The ARM `.so` files in catalog tarballs are **useless**; every module must be rebuilt from source. | **hard** (ecosystem) |
| **Blocking file I/O on the audio path** | Modules load WAVs/ROMs inside `set_param` (e.g. granny; `CLAUDE.md` "param read has three answers") | Make it synchronous and in-memory: WasmFS/MEMFS in the device worker, with assets **preloaded or prefetched before `create_instance`**. Never do this in the AudioWorklet. | medium |
| **stb_truetype / stb_image** | `js_display.c` (bitmap `host/font.png` atlas via stb_image; TTF loader at `:377` unused), `schwung_host.c:25,498-531` (TTF) | Pure C, compiles as-is. Ship `font.png` and TTFs in the VFS. | trivial |
| **Filesystem layout** `/data/UserData/...` | Hard-coded in 230 lines / 49 C files and 319 lines / 40 JS files; JS imports absolute `/data/UserData/schwung/shared/*.mjs` (24 files) | Mount the virtual FS at **the same absolute paths**: `/data/UserData/schwung/{host,shared,shadow,modules,presets,set_state,...}` and `/data/UserData/UserLibrary/Samples/...`. Persist user dirs to OPFS or IDBFS. No code edits needed. | easy |
| **QuickJS `std`/`os`** | §3 | Free with QuickJS-in-wasm (Emscripten libc). Needs shims if running native browser JS. | easy / medium |
| **curl, analytics, TTS (eSpeak/Flite)** | `libs/curl`, `analytics.c`, `tts_engine_*` | Use `tts_engine_stub.c` (already exists), then a Web Speech bridge. Drop analytics. Use `fetch` for downloads. | easy |
| **NEON / ARM intrinsics, JIT** in third-party modules | e.g. `osirus` (Gearmulator DSP56300 JIT), SIMD-heavy synths | `-msimd128` (Emscripten partially translates NEON intrinsics with `-mfpu=neon`). JIT engines are out of scope. | module-specific |
| **Denormal FTZ** (`shim_pre_transfer` sets FPCR) | `schwung_shim.c:6658` | wasm has no FTZ mode. Add DC offset or flush in hot IIRs, or accept the CPU cost. | low |
| **Realtime determinism** | 2.9 ms block, GC-free C | The AudioWorklet render quantum is 128 frames. With 44.1 kHz in an `AudioContext({sampleRate: 44100})` the block sizes match exactly. | low |

---

## 6. Recommended architecture: "schwung-wasm"

### 6.1 Process → thread mapping

All C is built as one Emscripten program (`-pthread`, `-sSHARED_MEMORY`, one `WebAssembly.Memory`, `-sALLOW_MEMORY_GROWTH` with care). The device's three processes become threads that share memory exactly as they shared `/dev/shm`.

```
┌────────────── Main thread (page) ─────────────────────────────┐
│ Virtual Move panel (canvas, from mirror.html geometry)       │
│  - pointer/keyboard/Web MIDI → MIDI_IN SPSC ring (SAB)       │
│  - rAF: read OLED 1 KB + LED state from SAB, draw            │
│ Asset manager: fetch module tarballs/samples → OPFS → VFS    │
└───────────────▲───────────────────────────────▲──────────────┘
                │ SAB rings (no postMessage on hot path)
┌───────────────┴──── "Device" pthread (DSP) ──┴───────────────┐
│ virtual_spi_frame(): build fake 4 KB mailbox                 │
│   = MIDI_IN from ring + Virtual-Move echo (pads→ch N notes)  │
│   shim_pre_transfer() → param serve, MIDI route, chain render│
│   shim_post_transfer()                                        │
│   write 128×2 int16 → audio SPSC ring; MIDI_OUT → LED state  │
│ Paced by ring fill: Atomics.wait on the ring's read index    │
│ Threads: slot loader, bus worker, shim worker (pthreads)     │
└───────────────▲──────────────────────────────────────────────┘
                │ shared structs (ex-SHM): control/param/ui/display/midi_*
┌───────────────┴──── "shadow_ui" pthread ─────────────────────┐
│ shadow_ui.c main loop (60 Hz deadline), QuickJS-in-wasm      │
│ evaluates /data/UserData/schwung/shadow/shadow_ui.js         │
│ shadow_get_param() busy-waits → Atomics.wait (same 1-block   │
│ latency as hardware, ~2.9 ms)                                 │
└──────────────────────────────────────────────────────────────┘
┌──────────────── AudioWorkletProcessor ───────────────────────┐
│ Pull 128 frames from SAB ring, int16→float32, output.        │
│ No wasm, no locks, no allocation. Underrun → silence + count. │
└──────────────────────────────────────────────────────────────┘
```

**Why DSP is not run inside the AudioWorklet (at first):**
- The Schwung contract is that module entry points may block. Modules allocate in `set_param` and load WAVs and ROMs synchronously. Module loads use `dlopen` plus worker threads.
- In an AudioWorklet, Emscripten's FS, dlopen and pthread creation are unavailable or unsafe, and any stall is an audible glitch.
- The device worker with 2–4 blocks of ring headroom costs about 6–12 ms of extra latency and buys robustness. That is acceptable for a virtual instrument.

Later optimisation (M4+): Emscripten Wasm Audio Worklets (`-sAUDIO_WORKLET -sWASM_WORKERS`) can run `shim_pre/post` directly in the worklet once loads are guaranteed off-thread. This is the same split the device already enforces (`slot_load_job.h`).

### 6.2 What to compile as-is vs replace

| Compile to wasm as-is (or near) | Compile behind `#ifdef SCHWUNG_WASM` stubs | Replace with a thin browser host |
|---|---|---|
| `src/modules/chain/dsp/*.c`, `src/host/lane_{store,serial,edit}.c` (guard `plugin_api_v1.h:325`) | `src/schwung_shim.c` (strip hooks/constructor; export `shim_init_subsystems`, `shim_pre_transfer`, `shim_post_transfer`) | `src/lib/schwung_spi_lib.c` → `virtual_spi.c` (fake page, frame driver) |
| `src/host/shadow_{chain_mgmt,midi,midi_filter,led_queue,overlay,scene_bus,transport,metronome,overtake_midi,state,sampler,resample}.c`, `shim_worker.c`, `unified_log.c` (log to console) | `move_model*.c`, `move_info.c`, `clip_state.c`, `edit_*`, `undo_timeline.c` → "not live" stubs | `shadow_shm_util.c` → static region table |
| `src/shadow/shadow_ui.c`, `src/host/js_host_common.c`, `src/host/js_display.c`, QuickJS 2025-04-26 (`libs/quickjs`) | `shadow_dbus.c`, `shadow_link_audio.c`, `shadow_xmos_audio.c`, `rt_thread_audit.c`, `spi_tally.c`, `schwung_trace.c`, `analytics.c`, `tts_engine_*` (use `tts_engine_stub.c`), `schwung_jack_bridge.c` | `shadow_process.c` (`launch_shadow_ui` → `pthread_create(shadow_ui_main)`) |
| Built-in modules: freeverb, arp, chord, linein, wav-player, file-browser, song-mode | `shadow_set_pages.c` (single synthetic set), `js_host_common.c` curl/tar → JS `fetch` | **Virtual Move** (new): pad→note echo on the selected slot's channel, transport/BPM/beat, track select, jack-detect CCs, LED and OLED renderer |

### 6.3 Loading third-party module DSP

Options:

1. **Static registry (M1–M2).** Link built-in and curated modules into the main wasm. Replace `dlopen(path)` with a lookup by `<id>` in a generated table and `dlsym(handle, name)` with a per-module symbol table. Use `-Wl,--wrap=dlopen,--wrap=dlsym` or an `#ifdef` in `chain_synth_load.c`, `chain_fx_load.c`, `chain_bus.c`, `chain_host.c` and `shadow_chain_mgmt.c`. Zero runtime risk; module set fixed at build time.
2. **Emscripten dynamic linking (M3, recommended for the catalog).** Main program is `-sMAIN_MODULE=2`; each module is built with `emcc -sSIDE_MODULE=2 -o dsp.so` and written to the VFS at the exact path the chain expects (`modules/sound_generators/<id>/dsp.so`, `audio_fx/<id>/<id>.so`). The real `dlopen` then works unchanged.
   - Caveats: dynamic linking + pthreads works, but side modules must be loaded in every thread that calls into them. Emscripten syncs `dlopen` across threads lazily, so test it.
   - Side modules share the one memory and malloc, so a crashing module takes the whole engine down, just like on device.
   - `RTLD_LOCAL` symbol isolation is weaker; C++ modules should hide symbols.
   - Per-module `.wasm` size: 50 KB to several MB.
3. **One wasm instance per module (fallback).** Each module gets its own memory. A bridge forwards `render_block`, `on_midi`, `set_param` and `get_param` and copies 512 B of audio per block. Host callbacks are imported functions; `mapped_memory` must be mirrored.
   - Good for isolation, for modules built with other toolchains (Rust, AssemblyScript), or for modules that need a different memory model.
   - Costs about 2 copies per block per module plus an extra JS↔wasm hop if instances live in different workers. Keep them in the device worker as a synchronous `WebAssembly.Instance` to avoid this.
   - More plumbing for `mod_emit_value` and `move_plugin_render_split` (pointer arrays).

**Recommendation:** option 1 for M1/M2 → option 2 for M3, keeping option 3 as an escape hatch.

**Module ecosystem reality** (`module-catalog.json`: 158 modules, of which 64 synths, 45 audio FX, 14 MIDI FX, 19 tools, 16 overtake):
- Each module lives in its own GitHub repo with an ARM64-only release tarball. Browser support needs **a per-module emcc build**: a CI template (`scripts/build-wasm.sh` + a `release.json` `wasm_download_url` field), plus licence review for redistribution.
- Easy wins: plain C/C++ DSP with no threads, files or SIMD.
- Medium: sample, ROM or SF2 loaders (`sf2`/FluidLite, `sfz`/sfizz, `mrsample`, `granny`, `dr32` loading `.ablpreset` kits, `nam` models, `minijv` ROMs). These need asset upload or a fetch-to-VFS flow, and ROMs raise legal issues.
- Hard or out of scope:
  - Heavy C++ engines are feasible but large: `surge`, `dexed`, `obxd`, `helm`, `setbfree`, `cloudseed`, `chowtape`.
  - JIT or fork-based engines: `osirus`/Gearmulator, `jp8000`.
  - Network or OS modules: `airplay`, `radiogarden`, `webstream`, `streamrtsp`.
  - Tools that `os.exec` binaries.

### 6.4 How the JS UI runs, and how it talks to audio

- **M2 recommendation: QuickJS compiled to wasm**, running the unmodified `shadow_ui.c` loop in its own pthread.
  - All ~200 bindings (§3) come along for free, including the synchronous `shadow_get_param` semantics, `std`/`os` against the Emscripten VFS, the absolute-path ES module loader, and display packing.
  - A desktop CPU running wasm QuickJS should match or exceed the device's Cortex-A53 running native QuickJS.
  - The UI never touches the main thread. It writes the 1 KB display buffer and LED queue into shared memory, which the page reads on rAF.
- **Native browser JS (alternative, M4+).**
  - Needs JS implementations of all ~200 bindings, mostly thin wrappers around SAB-mapped structs. The param channel becomes `Atomics.wait` in a dedicated Worker; this is impossible on the main thread.
  - Needs an `std`/`os` shim (~100 call sites, synchronous over OPFS SyncAccessHandles or an in-memory FS mirror), and an import map for `/data/UserData/schwung/...` paths.
  - Wins devtools debugging, source maps and JIT speed. Costs a second binding implementation that can drift from `shadow_ui.c`.
- Transport between threads is the ex-SHM structs in the shared wasm memory, unchanged. The page↔engine hot path uses SAB SPSC rings:
  - MIDI_IN: page → device
  - audio: device → worklet
  - display and LED snapshot: device or UI → page, as a seqlock
- Control messages (load module, upload sample, reset) use `postMessage` to the device thread, which applies them between frames.
- **Cross-origin isolation is mandatory** for SAB and wasm threads: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). Module and asset fetches from GitHub releases then need CORP/CORS-friendly hosting (proxy or mirror them, e.g. a catalog CDN). On GitHub Pages, use the `coi-serviceworker` trick.

### 6.5 VFS (samples, presets, state)

Layout (identical to the device):
```
/data/UserData/schwung/host/        font.png, version.txt, menu_ui.js …   (bundled, read-only, MEMFS/preload)
/data/UserData/schwung/shared/      *.mjs                                  (bundled)
/data/UserData/schwung/shadow/      shadow_ui.js + *.mjs                   (bundled)
/data/UserData/schwung/modules/<category>/<id>/{module.json,ui.js,ui_chain.js,dsp.so(wasm side module),assets}
/data/UserData/schwung/{presets,set_state,patches,config/features.json,…}    (persistent → OPFS)
/data/UserData/UserLibrary/Samples/…                                   (persistent → OPFS; drag-drop import)
```
- Use **WasmFS with an OPFS backend** if it is stable enough in the chosen Emscripten version (OPFS SyncAccessHandles work only in workers, which is fine because the device and UI threads are workers).
- Otherwise use MEMFS plus explicit sync to IDBFS/OPFS, on the shadow UI's existing autosave points and on a timer.
- Module DSP must find files synchronously, so the asset manager **preloads a module's whole directory into the VFS before its `<id>:module` write is allowed**. Gate this in the Virtual Move "slot loader" hook.
- Export and import of the whole `/data/UserData/schwung` tree as a zip gives backup and sharing.

### 6.6 Phased plan and effort (one experienced C/wasm + web engineer; ranges include debugging)

| Phase | Scope | Exit criteria | Eng-days |
|---|---|---|---|
| **M0: hello-tone** | Emscripten toolchain, COOP/COEP dev server, `AudioContext(44100)`, SAB ring + worklet, device pthread pacing, a trivial `plugin_api_v2` sine module rendered via a ~100-line host with a fake `host_api_v1_t` (guard the static assert). Virtual Move panel skeleton (from `mirror.html`) sending pad notes. | Pad press plays a tone; underrun counter at 0 for 10 minutes; latency measured. | 5–8 |
| **M1: chain host + 1 synth + knob grid** | Build `chain/dsp/*` + `lane_*` to wasm. Static module registry (freeverb, arp, chord, one real catalog synth, e.g. a small C synth). Minimal C host driving `chain_host` `create_instance`, `set_param("synth:module", …)`, `render_block`. JS knob-grid page via the `tools/param-pages/harness.mjs` draw context running in the browser (native JS), using `src/shared/param_pages` against `get_param`/`set_param`. | Load synth + freeverb into a chain, turn knobs, hear changes, OLED shows the real param-pages renderer. | 12–18 |
| **M2: real shadow UI** | Port the shim core: `#ifdef` out Move subsystems, `virtual_spi.c`, SHM table, `launch_shadow_ui` → pthread. Build `shadow_ui.c` + QuickJS + `js_host_common.c` + `js_display.c` to wasm. Ship `src/shadow`, `src/shared`, `src/host` JS in the VFS. Virtual Move echo (pad → slot channel), transport/BPM, jack-detect CCs, LED decode, Master FX, 4 slots, presets persisted to OPFS. Fix whatever `shadow_ui.js` assumes about Move (set UUIDs, `Song.abl`, the live model). | Boot to the Schwung shadow UI on the virtual OLED; navigate slots, pick modules, edit params, Master FX, Global Settings; state survives a reload. | 25–35 |
| **M3: module catalog loader** | `MAIN_MODULE`/`SIDE_MODULE` dlopen; module build template plus CI for third-party repos (start with 10–15 easy modules); catalog fetch via CORS proxy; tarball extract in JS; asset preloading; sample/preset import UI; error surfacing for incompatible modules (no wasm build, forks, network). | Install a module from a catalog list in the browser, then it appears in the slot picker and plays. | 20–30 |
| (M4, optional) | Wasm-audio-worklet DSP for lower latency, native-JS shadow UI, Web MIDI out/in (cable 2), Virtual Move step sequencer to re-enable lanes/p-locks in a simplified form, overtake tools, sampler/skipback export as WAV download. | | 20–40 |

**Total to M3: about 62–91 days.** With integration, docs, cross-browser fixes (Safari AudioWorklet and SAB quirks, Firefox) and CI, plan for **about 75–110 engineer-days**.

### 6.7 Key risks

1. **The shim is a 12k-line monolith tied to Move.** `schwung_shim.c` interleaves Move-specific logic (model follow, Link Audio rebuild, step and lanes gestures, D-Bus) with the parts we need (param serving, mixing, MIDI routing). Ifdef-ing it out may cascade. Mitigations: carve out `shim_core.c` incrementally, or write a reduced "shim-lite" (param serve via `shadow_inprocess_handle_param_request`, slot render and mix, MIDI dispatch, display swap, LED flush) and accept some feature loss.
2. **`shadow_ui.js` (31k lines) assumes Move exists.** It assumes set UUIDs from Move, `Song.abl` reads, Move-track long-press semantics, the pad ownership split, and that Move draws the screen when the shadow UI is hidden. Without Move, "dismiss shadow UI" leaves a blank OLED. Virtual Move needs at least a minimal home screen, or the UI must be kept pinned on.
3. **The module ecosystem must be rebuilt.** ARM `.so` binaries cannot run, and 158 external repos each need an emcc build, licence clearance and hosting. Only a fraction will work quickly; the catalog experience depends on community uptake.
4. **Module code assumes blocking, synchronous, allocating calls on the "audio thread"** (about 150 RT violations across the fleet per `CLAUDE.md`), plus threads and fork. In the browser this forces the device-worker plus ring design (latency) and VFS preloading. Fork-based modules cannot work.
5. **Dynamic linking + pthreads in Emscripten** is less battle-tested: dlopen synchronization across threads, TLS in side modules, C++ exceptions and RTTI across modules, memory growth with SAB (growth triggers views to detach; prefer a fixed max memory, e.g. 512 MB–1 GB).
6. **Cross-origin isolation** breaks naive third-party embeds and GitHub asset downloads. A CORS/CORP proxy or mirror is required. Safari's support for SAB + AudioWorklet + wasm threads is workable but historically quirky.
7. **Timing semantics.** On device, the UI's synchronous param read costs one SPI frame. In the browser, if the device thread is throttled (background tab: timers clamp and audio may suspend), UI reads time out (100 ms deadline, `shadow_ui.c:1178`), which `shadow_ui.js` treats as "read failed" (tri-state `null`). Keep the device thread paced by the audio ring, never by `setTimeout`.
8. **Floating-point and denormals:** no FTZ in wasm, so IIR tails may cost CPU. Some modules may use `long double` or `__int128` or inline asm.
9. **Legal:** Ableton trademarks and the Move look-and-feel in a public emulator; ROM-based modules (minijv, osirus, jp8000) cannot be distributed. The GPL shim (eSpeak) is avoided by building with `SCREEN_READER_ENABLED=0` (MIT).
10. **Drift.** Schwung's `main` moves fast and documents many invariants pinned by tests. A long-lived wasm fork rots. Upstream the `SCHWUNG_WASM` ifdefs and the virtual SPI driver, and add a `wasm` CI job.

### 6.8 Useful existing assets to reuse

- `schwung-manager/static/mirror.html`: front-panel geometry, palette, LED and OLED decode.
- `tools/param-pages/harness.mjs`: a Node 128×64 framebuffer and draw context (`fillRect`, `print`, `textWidth`, `clearScreen`, using the real `font5x7.json`). It ports to the browser for M1.
- `tools/param-pages/fake_device.mjs`: a fake chain slot `getParam`/`setParam` from `tests/fixtures/module-contracts.json` (95 fleet modules' contracts). Gives a UI-only demo without any DSP.
- `tests/host/Makefile`: many shim and chain units already compile with host `cc` on macOS/Linux (e.g. `test_slot_clip_phase` includes `shadow_chain_mgmt.c`; `test_chain_lanes_playback.sh` builds `chain_lanes.c` + `chain_mod.c`). This is evidence the C is reasonably portable outside ARM/glibc. `chain_host.c` itself is not built there only because it dlopens.
- `src/host/test_daemon/schwung_testd.c` + `tools/pytest-schwung`: an E2E driver protocol (MIDI inject, LED snapshot) that could be re-targeted at the browser build for regression tests.
