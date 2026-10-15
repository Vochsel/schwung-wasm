# Engine ↔ page interface

The engine is Schwung's own C (shim core, chain host, shadow UI + QuickJS) built as one
Emscripten pthreads program (`web/engine/schwung.js` + `.wasm`). The page drives it through
a handful of exported C functions and reads/writes shared memory directly. Nothing on the hot
path uses `postMessage`.

Requires cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`). `scripts/serve.mjs` sets both.

## Lifecycle

```js
const Module = await createSchwung({ /* emscripten opts */ });
Module._sw_start(44100);        // boots device thread + shadow_ui thread; returns immediately
```

## Exports (all `int`/pointer, call as `Module._name(...)`)

| C export | Meaning |
|---|---|
| `int sw_start(int sample_rate)` | Boot. 0 on success. |
| `void sw_midi_in(int cable, int b0, int b1, int b2)` | One USB-MIDI event from the virtual surface (cable 0 = Move surface, 2 = external). Lock-free SPSC ring, any thread. |
| `uint8_t *sw_display(void)` | 1024 B OLED frame, SSD1306 page layout: byte `page*128+x`, bit j = row `page*8+j`. |
| `uint32_t *sw_display_seq(void)` | Incremented after each new display frame. |
| `uint8_t *sw_leds(void)` | LED state, 3 × 128 × 2 bytes: `[notes][ccs]` then repeat for cable-2-unused. Entry = `(value, channel)`; value is a palette index (pads/steps/RGB buttons) or brightness; channel encodes animation (0 solid, 1–5 transition, 6–10 pulse, 11–15 blink). Layout: offset `0` notes 0..127 × 2 B, offset `256` CCs 0..127 × 2 B. |
| `uint32_t *sw_leds_seq(void)` | Incremented when LEDs change. |
| `uint8_t *sw_led_rgb(void)` | RGB overrides from SysEx `3B`: 2 × 128 × 4 B (`r,g,b,set`), notes then CCs. |
| `int16_t *sw_audio_ring(void)` | Interleaved stereo int16 ring, `SW_RING_BLOCKS` × 128 frames. |
| `uint32_t *sw_audio_ring_ctl(void)` | `[0]=write_block`, `[1]=read_block`, `[2]=capacity_blocks`, `[3]=underruns`, `[4]=target fill`, `[5]=blocks dropped while the worklet was stalled` (all u32, monotonically increasing block counters; index = counter % capacity). The worklet advances `[1]` and `Atomics.notify`s it; the device thread `Atomics.wait`s on it when the ring is full. |
| `void sw_set_bpm(float bpm)`, `void sw_transport(int playing)` | Virtual Move transport. |
| `void sw_set_latency_blocks(int n)` | Ring fill target (`ctl[4]`, default 4 blocks ≈ 11.6 ms). |
| `void sw_set_pad_layout(int track, int drums)`, `int sw_get_pad_layout(int track)`, `int sw_get_track(void)` | Virtual Move pad layout per track (Track 1 drums by default) and the selected track. |
| `uint32_t *sw_ext_ring(void)`, `uint32_t *sw_ext_w(void)` | Cable-2 MIDI out (256 × `status<<16 \| d1<<8 \| d2`, monotonically increasing write counter). |
| `int sw_web_param_set(int slot, const char *key, const char *value)` | Schwung's web-manager param ring (only reaches slots that already have a module). |
| `int sw_ui_eval(const char *js)`, `int sw_ui_done(void)`, `const char *sw_ui_result(void)` | Dev/test door: run JS in the shadow UI's own QuickJS context between ticks; result is JSON. |
| `int sw_stat(int which)` | 0 blocks rendered, 1 last block µs, 2 max block µs, 3 underruns, 4 dropped blocks, 5 display frames, 6 pad events Move saw, 7 notes echoed, 8 audio peak since last read (resets). |

## Worklet

`web/worklet.js` gets `{ memory: Module.wasmMemory, ring, ctl }` (byte offsets) via
`port.postMessage` once, then each `process()` pulls one 128-frame block (int16 → float32).
On underrun it outputs silence and increments `ctl[3]`. `AudioContext({ sampleRate: 44100 })`
so the render quantum equals Move's 128-frame block.

## Surface input mapping (from Schwung's constants)

Pads notes 68–99 (bottom-left 68, `68 + (3-row)*8 + col`), steps 16–31, knob touch notes 0–7,
master touch 8, jog touch 9 (127 touched / 0 released). Knobs CC 71–78, master CC 79, jog CC 14:
relative, 1..63 clockwise, 65..127 counter-clockwise. Buttons CC 127/0: 3 jog click, 40–43
tracks (43 = Track 1), 49 Shift, 50 Menu, 51 Back, 52 Capture, 54 Down, 55 Up, 56 Undo,
58 Loop, 60 Copy, 62 Left, 63 Right, 85 Play, 86 Rec, 88 Mute, 118 Sample, 119 Delete.
