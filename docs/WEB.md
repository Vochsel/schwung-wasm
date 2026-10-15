# Web

## Web front-end

The page that runs Schwung in the browser: a virtual Ableton Move with realtime audio.
It is plain ES modules with no framework, bundler or npm dependencies. It codes against
[ENGINE-INTERFACE.md](ENGINE-INTERFACE.md).

### Run

```sh
node scripts/serve.mjs              # http://localhost:8790  (PORT=… to change)
```

Open the page and press **Power on**. Browsers only start audio after a user gesture, so
the button creates the `AudioContext`, loads the engine and starts it.

- If `web/engine/schwung.js` exists (checked with a HEAD request), the real Emscripten
  engine is loaded. `web/engine/persist.mjs` restores and autosaves `/data/UserData` to
  IndexedDB.
- If it is missing, the page falls back to `web/mock-engine.js` and shows a **mock engine**
  badge.
- To choose an engine explicitly, add `?engine=mock` or `?engine=real` to the URL.

### Files

| File | Role |
|---|---|
| `scripts/serve.mjs` | Static server for `web/`. Sends COOP `same-origin`, COEP `require-corp` and CORP `same-origin`, so `crossOriginIsolated` and SharedArrayBuffer work. Sets correct MIME types for `.wasm`, `.js`, `.mjs`, `.data` and `.json`. Uses `Cache-Control: no-store`. Node stdlib only. |
| `web/index.html` | Page shell, status bar, Power-on overlay, help overlay (`?`). |
| `web/app.js` | Engine loading, AudioContext and worklet wiring, status stats, keyboard, Web MIDI, toolbar (Open Schwung, Pads layout, Buffer, BPM). Exposes `window.swDebug` for tests. |
| `web/panel.js` | The Move front panel on one canvas: geometry, palette and LED animation derived from `schwung-manager/static/mirror.html` (MIT, attribution kept). Also handles hit testing and pointer/wheel input, turning it into cable-0 MIDI. |
| `web/worklet.js` | `AudioWorkletProcessor`. Reads int16 stereo 128-frame blocks from the ring in shared wasm memory. Advances `ctl[1]` and calls `Atomics.notify` on it. Counts underruns in `ctl[3]`. Handles any render-quantum size. |
| `web/mock-engine.js` | A drop-in engine that implements the same exports over a shared `WebAssembly.Memory`. A module Worker plays the device thread: MIDI SPSC ring → 16-voice sine/saw synth + SVF + ping-pong delay → audio ring (paced to `ctl[4]` with `Atomics.wait`), plus the SSD1306 OLED and LEDs. Audio goes through the same worklet path as the real engine. |
| `scripts/smoke.mjs` | Headless end-to-end test (see below). |

Data flow: the page's `rAF` loop reads `sw_display_seq` and `sw_leds_seq`. It redraws only
when one changes or an LED is animating. Input goes straight to `_sw_midi_in`. Nothing on
the hot path uses `postMessage`.

### Panel controls

All panel input is cable-0 MIDI as Move sends it. Releases go out as `0x80 n 0`.

- **Pads** (notes 68–99)
  - Pointer down/up, multi-touch.
  - Velocity comes from pen/touch pressure when there is real pressure. Otherwise it comes
    from where you hit the pad: top = 127, centre = 100, bottom = 73.
  - Changes in touch pressure send poly aftertouch (`0xA0`).
- **Steps** (notes 16–31): sent as note on 127 / note off.
- **Knobs 1–8 and master** (CC 71–78 / 79, relative 1..63 / 65..127)
  - Drag vertically. The step size accelerates with drag speed; hold Shift for fine moves.
  - The mouse wheel also turns them.
  - Touch notes 0–7 / 8: note on 127 when touched, note off on release. A wheel turn sends
    touch-on and then touch-off after 350 ms of idle.
- **Jog**
  - Drag around the rim or scroll to turn: CC 14, one detent per 15°.
  - Click the centre to push: CC 3.
  - Any contact sends touch note 9.
- **Buttons**: CC 127 on press, 0 on release.
  - Shift 49, Menu 50, Back 51, Capture 52, Down/Up 54/55, Undo 56, Loop 58, Copy 60,
    Left/Right 62/63, Play 85, Rec 86, Mute 88, Sample 118, Delete 119.
  - Track buttons 40–43, reversed: Track 1 = CC 43.
- **Hover tooltips** show each control's name and its keyboard shortcut.

LEDs come from `sw_leds()`, with `(value, channel)` entries for notes and then CCs.
`sw_led_rgb()` overrides take priority.

- Values are palette indices. White-only buttons use the white-balance column.
- The channel sets the animation, synced to the BPM field (default 120):
  - 1–5: transition, drawn solid.
  - 6–10: pulse at 24th, 16th, 8th, quarter and half notes.
  - 11–14: blink.
  - 15: solid. As in mirror.html, it is the normal channel for steps and white buttons on
    hardware.

The OLED is decoded from SSD1306 pages into a pixel-snapped device-resolution canvas, with
a faint glow.

### Keyboard

| Keys | Action |
|---|---|
| `A W S E D F T G Y H U J K O L P ; '` | Piano on the pads: bottom-left pad = `A`, chromatic up the rows |
| `Z` / `X` | Piano range down / up by 12 pads |
| Arrows | Left / Right / Up / Down |
| `[` `]` / `Enter` | Jog turn / jog click |
| `Backspace`, `Esc` | Back |
| `Shift`, `Space`, `R` | Shift, Play, Rec |
| `M` `C` `B` `N` `V` `I` `Delete`, `Ctrl/⌘+Z` | Menu, Capture, Loop, Mute, Copy, Sample, Delete, Undo |
| `F1`–`F4` | Track 1–4 |
| hold `1`–`8` (`9` = master) | Touch that knob; scroll anywhere or press `-` / `=` to turn it |
| `Q` | Open Schwung (Shift + Volume touch + current Track) |
| `?` | Help overlay |

### Toolbar

- **Open Schwung**: sends the chord Shift + master touch (note 8) + the current track's
  button (`sw_get_track`). This opens Schwung's slot editor from Virtual Move's home screen.
- **Tn pads: Drums/Notes**: switches the current track's pad layout
  (`sw_set_pad_layout` / `sw_get_pad_layout`). At boot, Track 1 uses the drum-rack layout.
- **Buffer**: sets the ring target fill in 2.9 ms blocks (`sw_set_latency_blocks`,
  `ctl[4]`). Default 4.
- **BPM**: sets the tempo (`sw_set_bpm`). It also sets the LED animation rate.
- **MIDI in**: forwards Web MIDI input (notes, CC, pitch bend, pressure; not SysEx or
  realtime) to `_sw_midi_in(2, …)`.

### Status bar

| Field | What it shows |
|---|---|
| latency | `baseLatency + outputLatency + ring fill × 2.9 ms` |
| ring | Fill / capacity |
| underruns | `ctl[3]`, plus dropped blocks from `ctl[5]` |
| dsp | `sw_stat(1)` last render µs as % of the 2.9 ms block, and `sw_stat(2)` max |
| ui | Display frames per second (from `sw_display_seq`) |

### Smoke test

```sh
node scripts/smoke.mjs                     # whatever engine is present
SMOKE_ENGINE=mock node scripts/smoke.mjs   # force the mock
```

Requirements:

- Playwright, resolved from `build/tools`, `$PLAYWRIGHT_DIR` or a global install.
- A Chromium. The script uses the newest full `chromium-*` in Playwright's cache, or
  `$CHROME`. The full browser in new headless mode has an audio output, so the worklet
  really runs. To install one: `npx -y playwright@1.56.1 install chromium`.

What the test does:

1. Serves `web/` on a spare port and launches Chromium with
   `--autoplay-policy=no-user-gesture-required`.
2. Clicks Power on, presses a pad, drags a knob, scrolls the master, plays a key. On the
   real engine it also opens Schwung.
3. Asserts:
   - `crossOriginIsolated`
   - the worklet consumes about 344 blocks/s
   - zero new underruns after warm-up
   - a non-empty OLED
   - the pad LED lights
   - CCs go out
   - no page errors
   - the panel fits a 390 px wide viewport
4. Saves screenshots to `build/smoke/`: `panel.png`, `panel-pad.png`, `panel-phone.png`,
   `boot.png`, `schwung-open.png`.
