// Mock engine: a stand-in for web/engine/schwung.js that implements exactly
// the page-facing contract in docs/ENGINE-INTERFACE.md, so the panel, the
// audio ring, the worklet and the pacing can be exercised end to end before
// (or without) the real Emscripten build.
//
//   const Module = await createMockSchwung();
//   Module._sw_start(44100);
//
// Shape: a fake Module whose `_sw_*` exports return byte offsets into a
// shared WebAssembly.Memory (`Module.wasmMemory`, `Module.HEAPU8`). A Worker
// (this same file, loaded as a module worker) plays the "device thread": it
// drains the MIDI SPSC ring, runs a small polyphonic synth into the int16
// stereo audio ring, parks in Atomics.wait when the ring is full, and draws
// the OLED / LED state. Nothing on the hot path uses postMessage.
//
// The synth: pads play notes (chromatic from C3, bottom-left up), knobs 1-8 =
// wave, cutoff, resonance, attack, release, detune, delay, volume; master =
// output level; jog = tempo; Play toggles a 16-step sequencer (steps toggle);
// track buttons pick a preset; Up/Down octave, Left/Right semitone.

/* ------------------------------------------------------------------ layout */
const LAYOUT = {
  displaySeq: 64, ledsSeq: 68, midiHead: 72, midiTail: 76,   // u32
  ctl: 128,          // 4 x u32: write, read, capacity, underruns
  stat: 160,         // 4 x u32: frames, ui ticks, render us*10, voices
  bpm: 192,          // i32 bpm * 1000
  transport: 196,    // i32: -1 untouched, 0 stop, 1 play (set by sw_transport)
  display: 1024,     // 1024 B
  leds: 4096,        // 3 x 128 x 2 B
  ledRgb: 8192,      // 2 x 128 x 4 B
  midi: 12288,       // MIDI_SLOTS x 4 B: cable, b0, b1, b2
  ring: 16384,       // RING_BLOCKS x 128 x 2 x int16
};
const MIDI_SLOTS = 512;
const RING_BLOCKS = 8;
const BLOCK = 128;

const IS_WORKER = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

/* ============================================================ main thread */
export default async function createMockSchwung(opts = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const buf = memory.buffer;
  const HEAPU8 = new Uint8Array(buf), HEAP32 = new Int32Array(buf), HEAPU32 = new Uint32Array(buf);
  const i32 = (off) => off >> 2;
  Atomics.store(HEAP32, i32(LAYOUT.ctl) + 2, RING_BLOCKS);
  Atomics.store(HEAP32, i32(LAYOUT.bpm), 120000);
  Atomics.store(HEAP32, i32(LAYOUT.transport), -1);
  let worker = null;

  const Module = {
    isMock: true,
    wasmMemory: memory, HEAPU8, HEAP32, HEAPU32,
    _sw_start(sampleRate) {
      if (worker) return 0;
      worker = new Worker(new URL(import.meta.url), { type: 'module', name: 'mock-device' });
      worker.onerror = (e) => (opts.printErr || console.error)('mock engine worker:', e.message || e);
      worker.postMessage({ memory, sampleRate: sampleRate | 0 || 44100, layout: LAYOUT });
      return 0;
    },
    _sw_midi_in(cable, b0, b1, b2) {
      const h = Atomics.load(HEAPU32, i32(LAYOUT.midiHead));
      const t = Atomics.load(HEAPU32, i32(LAYOUT.midiTail));
      if (((h - t) >>> 0) >= MIDI_SLOTS) return;           // full: drop, like the C ring
      const o = LAYOUT.midi + (h % MIDI_SLOTS) * 4;
      HEAPU8[o] = cable; HEAPU8[o + 1] = b0; HEAPU8[o + 2] = b1; HEAPU8[o + 3] = b2;
      Atomics.store(HEAPU32, i32(LAYOUT.midiHead), (h + 1) >>> 0);
    },
    _sw_display: () => LAYOUT.display,
    _sw_display_seq: () => LAYOUT.displaySeq,
    _sw_leds: () => LAYOUT.leds,
    _sw_leds_seq: () => LAYOUT.ledsSeq,
    _sw_led_rgb: () => LAYOUT.ledRgb,
    _sw_audio_ring: () => LAYOUT.ring,
    _sw_audio_ring_ctl: () => LAYOUT.ctl,
    _sw_set_bpm(bpm) { Atomics.store(HEAP32, i32(LAYOUT.bpm), Math.round(bpm * 1000)); },
    _sw_transport(playing) { Atomics.store(HEAP32, i32(LAYOUT.transport), playing ? 1 : 0); },
    _sw_stat: (which) => Atomics.load(HEAPU32, i32(LAYOUT.stat) + (which | 0)),
  };
  return Module;
}

/* ================================================================= worker */
if (IS_WORKER) {
  self.onmessage = (e) => { self.onmessage = null; runDevice(e.data); };
}

/* 5x7 font, ASCII 0x20-0x7E, 5 column bytes each, bit 0 = top row. */
const FONT = (
  '0000000000' + '00005f0000' + '0007000700' + '147f147f14' + '242a7f2a12' + '2313086462' + '3649552250' + '0005030000' +
  '001c224100' + '0041221c00' + '082a1c2a08' + '08083e0808' + '0050300000' + '0808080808' + '0060600000' + '2010080402' +
  '3e5149453e' + '00427f4000' + '4261514946' + '2141454b31' + '1814127f10' + '2745454539' + '3c4a494930' + '0171090503' +
  '3649494936' + '064949291e' + '0036360000' + '0056360000' + '0008142241' + '1414141414' + '4122140800' + '0201510906' +
  '324979413e' + '7e1111117e' + '7f49494936' + '3e41414122' + '7f4141221c' + '7f49494941' + '7f09090101' + '3e41415132' +
  '7f0808087f' + '00417f4100' + '2040413f01' + '7f08142241' + '7f40404040' + '7f0204027f' + '7f0408107f' + '3e4141413e' +
  '7f09090906' + '3e4151215e' + '7f09192946' + '4649494931' + '01017f0101' + '3f4040403f' + '1f2040201f' + '7f2018207f' +
  '6314081463' + '0304780403' + '6151494543' + '00007f4141' + '0204081020' + '41417f0000' + '0402010204' + '4040404040' +
  '0001020400' + '2054545478' + '7f48444438' + '3844444420' + '384444487f' + '3854545418' + '087e090102' + '081454543c' +
  '7f08040478' + '00447d4000' + '2040443d00' + '007f102844' + '00417f4000' + '7c04180478' + '7c08040478' + '3844444438' +
  '7c14141408' + '081414187c' + '7c08040408' + '4854545420' + '043f444020' + '3c4040207c' + '1c2040201c' + '3c4030403c' +
  '4428102844' + '0c5050503c' + '4464544c44' + '0008364100' + '00007f0000' + '0041360800' + '08082a1c08'
);

function runDevice({ memory, sampleRate, layout: Lo }) {
  const buf = memory.buffer;
  const U8 = new Uint8Array(buf), I32 = new Int32Array(buf), U32 = new Uint32Array(buf);
  const ctl = new Int32Array(buf, Lo.ctl, 4);
  const ring = new Int16Array(buf, Lo.ring, RING_BLOCKS * BLOCK * 2);
  const stat = (i, v) => Atomics.store(U32, (Lo.stat >> 2) + i, v >>> 0);
  const sr = sampleRate;

  /* ---------------- synth state ---------------- */
  const NAMES = ['WAVE', 'CUT', 'RES', 'ATK', 'REL', 'DTN', 'DLY', 'VOL'];
  const knob = [0.25, 0.65, 0.25, 0.02, 0.30, 0.15, 0.25, 0.75];
  let master = 0.8;
  const PRESETS = [
    { name: 'SINE',  k: [0.0, 0.80, 0.10, 0.02, 0.30, 0.10, 0.20] },
    { name: 'SAW',   k: [1.0, 0.55, 0.30, 0.01, 0.25, 0.20, 0.25] },
    { name: 'PLUCK', k: [0.7, 0.40, 0.65, 0.00, 0.18, 0.05, 0.35] },
    { name: 'PAD',   k: [0.6, 0.50, 0.15, 0.55, 0.70, 0.55, 0.45] },
  ];
  let track = 0;
  const touched = new Uint8Array(10);
  const NV = 16;
  const voices = Array.from({ length: NV }, () => ({ on: false, gate: false, note: 0, pad: -1, f: 0, p1: 0, p2: 0, env: 0, vel: 0, at: 0, age: 0, until: 0 }));
  let vAge = 0;
  let octave = 0, transpose = 0;
  const padHeld = new Map();     // pad note -> voice
  const stepOn = new Uint8Array(16);
  let playing = false, step = -1, stepPhase = 0, lastNote = 60;
  let recArmed = false, shift = false;
  const heldCC = new Uint8Array(128);
  let lastEvent = 'READY', lastEventAt = 0;
  let level = 0;
  // TPT state-variable filter (stereo shares one coefficient set)
  let s1 = 0, s2 = 0;
  // ping-pong delay
  const DMAX = sr * 2;
  const dL = new Float32Array(DMAX), dR = new Float32Array(DMAX);
  let dPos = 0;
  let sampleClock = 0;
  let lastTransportWord = -1;

  const noteName = (n) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][n % 12] + (Math.floor(n / 12) - 1);
  const event = (s) => { lastEvent = s; lastEventAt = performance.now(); };
  const bpm = () => Atomics.load(I32, Lo.bpm >> 2) / 1000;

  function padToNote(pad) {
    // chromatic, bottom-left = C3, rows of 8 (matches the page's keyboard piano)
    return Math.max(0, Math.min(127, 48 + octave * 12 + transpose + (pad - 68)));
  }

  function noteOn(note, vel, pad, durSamples = 0) {
    let v = voices.find((x) => !x.on);
    if (!v) v = voices.reduce((a, b) => (a.age < b.age ? a : b));
    v.on = true; v.gate = true; v.note = note; v.pad = pad; v.vel = vel / 127; v.at = 0;
    v.f = 440 * Math.pow(2, (note - 69) / 12); v.age = ++vAge; v.env = Math.min(v.env, 0.05);
    v.until = durSamples ? sampleClock + durSamples : 0;
    lastNote = note;
    return v;
  }
  function noteOff(v) { if (v) v.gate = false; }

  const BUTTONS = { 3: 'JOG', 49: 'SHIFT', 50: 'MENU', 51: 'BACK', 52: 'CAPTURE', 54: 'DOWN', 55: 'UP',
    56: 'UNDO', 58: 'LOOP', 60: 'COPY', 62: 'LEFT', 63: 'RIGHT', 85: 'PLAY', 86: 'REC', 88: 'MUTE',
    118: 'SAMPLE', 119: 'DELETE', 40: 'TRACK 4', 41: 'TRACK 3', 42: 'TRACK 2', 43: 'TRACK 1' };
  const rel = (d) => (d < 64 ? d : d - 128);

  function setPreset(t) {
    track = t;
    PRESETS[t].k.forEach((v, i) => { knob[i] = v; });
    event('TRACK ' + (t + 1) + ' ' + PRESETS[t].name);
  }
  setPreset(0); event('READY');

  function midi(cable, b0, b1, b2) {
    const type = b0 & 0xf0;
    if (cable === 2) {                       // external keyboard/controller
      if (type === 0x90 && b2 > 0) { const v = noteOn(b1, b2, 1000 + b1); padHeld.set(1000 + b1, v); event('EXT ' + noteName(b1) + ' V' + b2); }
      else if (type === 0x80 || type === 0x90) { noteOff(padHeld.get(1000 + b1)); padHeld.delete(1000 + b1); }
      else if (type === 0xb0 && b1 === 74) knob[1] = b2 / 127;
      else if (type === 0xb0 && b1 === 7) knob[7] = b2 / 127;
      return;
    }
    if (cable !== 0) return;
    const on = type === 0x90 && b2 > 0, off = type === 0x80 || (type === 0x90 && b2 === 0);
    if (on || off) {
      if (b1 <= 9) {
        touched[b1] = on ? 1 : 0;
        if (on) event(b1 < 8 ? 'TOUCH ' + NAMES[b1] : b1 === 8 ? 'TOUCH MASTER' : 'TOUCH JOG');
      } else if (b1 >= 16 && b1 <= 31) {
        if (on) { const i = b1 - 16; stepOn[i] ^= 1; event('STEP ' + (i + 1) + (stepOn[i] ? ' ON' : ' OFF')); }
      } else if (b1 >= 68 && b1 <= 99) {
        if (on) {
          noteOff(padHeld.get(b1));
          const n = padToNote(b1);
          padHeld.set(b1, noteOn(n, b2, b1));
          event('PAD ' + (b1 - 67) + ' ' + noteName(n) + ' V' + b2);
        } else { noteOff(padHeld.get(b1)); padHeld.delete(b1); }
      }
      return;
    }
    if (type === 0xa0) { const v = padHeld.get(b1); if (v) v.at = b2 / 127; return; }
    if (type !== 0xb0) return;
    if (b1 >= 71 && b1 <= 79 || b1 === 14) {
      const d = rel(b2);
      if (b1 === 79) { master = clamp01(master + d / 100); event('MASTER ' + Math.round(master * 100) + '%'); }
      else if (b1 === 14) {
        const nb = Math.max(20, Math.min(300, Math.round(bpm()) + d));
        Atomics.store(I32, Lo.bpm >> 2, nb * 1000); event('TEMPO ' + nb + ' BPM');
      } else {
        const i = b1 - 71; knob[i] = clamp01(knob[i] + d / (shift ? 400 : 100));
        event(NAMES[i] + ' ' + Math.round(knob[i] * 100) + '%');
      }
      return;
    }
    heldCC[b1] = b2 > 0 ? 1 : 0;
    if (b2 === 0) return;
    const name = BUTTONS[b1] || 'CC ' + b1;
    switch (b1) {
      case 49: shift = true; break;
      case 85: playing = !playing; step = -1; stepPhase = 0; break;
      case 86: recArmed = !recArmed; break;
      case 40: case 41: case 42: case 43: setPreset(43 - b1); return;
      case 55: octave = Math.min(3, octave + 1); event('OCTAVE ' + octave); return;
      case 54: octave = Math.max(-3, octave - 1); event('OCTAVE ' + octave); return;
      case 63: transpose = Math.min(11, transpose + 1); event('TRANSPOSE ' + transpose); return;
      case 62: transpose = Math.max(-11, transpose - 1); event('TRANSPOSE ' + transpose); return;
      case 119: stepOn.fill(0); event('STEPS CLEARED'); return;
      case 3: Atomics.store(I32, Lo.bpm >> 2, 120000); event('TEMPO 120 BPM'); return;
    }
    event(name + (b1 === 85 ? (playing ? ' >' : ' []') : b1 === 86 ? (recArmed ? ' ARM' : ' OFF') : ''));
  }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

  function drainMidi() {
    const hI = Lo.midiHead >> 2, tI = Lo.midiTail >> 2;
    let t = Atomics.load(U32, tI);
    const h = Atomics.load(U32, hI);
    while (t !== h) {
      const o = Lo.midi + (t % MIDI_SLOTS) * 4;
      midi(U8[o], U8[o + 1], U8[o + 2], U8[o + 3]);
      t = (t + 1) >>> 0;
    }
    Atomics.store(U32, tI, t);
    // shift release arrives as CC 49 = 0
    shift = !!heldCC[49];
  }

  /* ---------------- audio ---------------- */
  const blep = (t, dt) => {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  };

  function renderBlock(slot) {
    const t0 = performance.now();
    const wave = knob[0], res = knob[2];
    const atk = 0.002 + knob[3] * knob[3] * 1.5, rls = 0.01 + knob[4] * knob[4] * 3;
    const aInc = 1 / (atk * sr), rMul = Math.exp(-4.6 / (rls * sr));
    const det = 1 + knob[5] * 0.02;
    const gain = knob[7] * knob[7] * master * master * 0.35;
    const k = 2 - 1.96 * res;
    const tr = Atomics.load(I32, Lo.transport >> 2);
    if (tr !== lastTransportWord) { lastTransportWord = tr; if (tr >= 0) { playing = tr === 1; step = -1; stepPhase = 0; } }
    const stepLen = sr * 60 / bpm() / 4;
    const dTime = Math.min(DMAX - 1, Math.round(stepLen * 3));
    const dMix = knob[6] * 0.6, dFb = 0.25 + knob[6] * 0.35;
    let pk = 0, active = 0;
    // cutoff modulated by pad aftertouch (max over held voices)
    let atMax = 0; for (const v of voices) if (v.on && v.at > atMax) atMax = v.at;
    const fc = Math.min(sr * 0.45, 30 * Math.pow(2, (knob[1] + atMax * 0.3) * 9.5));
    const g = Math.tan(Math.PI * fc / sr);
    const a1 = 1 / (1 + g * (g + k));
    for (let i = 0; i < BLOCK; i++) {
      // sequencer
      if (playing) {
        stepPhase -= 1;
        if (stepPhase <= 0) {
          stepPhase += stepLen; step = (step + 1) & 15;
          if (stepOn[step]) noteOn(lastNote, 100, -1, Math.round(stepLen * 0.5));
        }
      }
      let x = 0;
      for (let vi = 0; vi < NV; vi++) {
        const v = voices[vi];
        if (!v.on) continue;
        if (v.until && sampleClock >= v.until) { v.gate = false; v.until = 0; }
        if (v.gate) { v.env += aInc; if (v.env > 1) v.env = 1; }
        else { v.env *= rMul; if (v.env < 1e-4) { v.on = false; v.env = 0; continue; } }
        const dt1 = v.f / sr, dt2 = dt1 * det;
        let o1 = Math.sin(v.p1 * 2 * Math.PI) * (1 - wave) + (2 * v.p1 - 1 - blep(v.p1, dt1)) * wave;
        let o2 = Math.sin(v.p2 * 2 * Math.PI) * (1 - wave) + (2 * v.p2 - 1 - blep(v.p2, dt2)) * wave;
        v.p1 += dt1; if (v.p1 >= 1) v.p1 -= 1;
        v.p2 += dt2; if (v.p2 >= 1) v.p2 -= 1;
        x += (o1 + o2) * 0.5 * v.env * (0.25 + 0.75 * v.vel);
      }
      // TPT SVF lowpass
      const v3 = x - s2, v1 = a1 * (s1 + g * v3), v2 = s2 + g * v1;
      s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
      let y = v2 * gain;
      // ping-pong delay
      const rp = (dPos - dTime + DMAX) % DMAX;
      const outL = dL[rp], outR = dR[rp];
      dL[dPos] = y + outR * dFb; dR[dPos] = outL * dFb;
      dPos = (dPos + 1) % DMAX;
      let L = y + outL * dMix, R = y + outR * dMix;
      L = Math.tanh(L); R = Math.tanh(R);
      const aL = Math.abs(L); if (aL > pk) pk = aL;
      slot[i * 2] = (L * 32767) | 0;
      slot[i * 2 + 1] = (R * 32767) | 0;
      sampleClock++;
    }
    for (const v of voices) if (v.on) active++;
    level = Math.max(pk, level * 0.97);
    stat(2, Math.round((performance.now() - t0) * 10000));
    stat(3, active);
  }

  /* ---------------- OLED (SSD1306 page layout) ---------------- */
  const fb = new Uint8Array(1024);
  const px = (x, y, on = 1) => {
    if (x < 0 || x > 127 || y < 0 || y > 63) return;
    const i = (y >> 3) * 128 + x, m = 1 << (y & 7);
    if (on) fb[i] |= m; else fb[i] &= ~m;
  };
  const rect = (x, y, w, h, on = 1) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(x + i, y + j, on); };
  const frame = (x, y, w, h) => { for (let i = 0; i < w; i++) { px(x + i, y); px(x + i, y + h - 1); } for (let j = 0; j < h; j++) { px(x, y + j); px(x + w - 1, y + j); } };
  function text(s, x, y, on = 1) {
    for (const ch of String(s)) {
      let c = ch.charCodeAt(0); if (c < 32 || c > 126) c = 63;
      const o = (c - 32) * 10;
      for (let col = 0; col < 5; col++) {
        const bits = parseInt(FONT.substr(o + col * 2, 2), 16);
        for (let r = 0; r < 7; r++) if (bits & (1 << r)) px(x + col, y + r, on);
      }
      x += 6;
    }
    return x;
  }
  const textW = (s) => String(s).length * 6 - 1;

  function drawDisplay(now) {
    fb.fill(0);
    rect(0, 0, 128, 9);
    text('SCHWUNG', 2, 1, 0);
    const right = 'MOCK ' + Math.round(bpm()) + 'BPM';
    text(right, 126 - textW(right), 1, 0);
    // status line
    const st = 'T' + (track + 1) + ' ' + PRESETS[track].name;
    text(st, 0, 12);
    if (playing) { // play triangle
      for (let j = 0; j < 7; j++) for (let i = 0; i <= (j < 4 ? j : 6 - j); i++) px(80 + i, 12 + j);
      text(String((step & 15) + 1).padStart(2, ' '), 86, 12);
    }
    if (recArmed && (Math.floor(now / 250) & 1)) { rect(103, 13, 5, 5); }
    const voicesOn = voices.filter((v) => v.on).length;
    text(voicesOn + 'v', 128 - textW(voicesOn + 'v'), 12);
    // event line (fresh events inverted for a moment)
    const fresh = now - lastEventAt < 600;
    if (fresh) rect(0, 21, 128, 9);
    text(lastEvent.slice(0, 21), 1, 22, fresh ? 0 : 1);
    // knob grid, 2 rows x 4
    for (let i = 0; i < 8; i++) {
      const cx = (i & 3) * 32, cy = 32 + (i >> 2) * 15;
      const lab = NAMES[i];
      if (touched[i]) { rect(cx, cy - 1, 31, 9); text(lab, cx + 1, cy, 0); }
      else text(lab, cx + 1, cy);
      frame(cx, cy + 9, 30, 4);
      rect(cx + 1, cy + 10, Math.round(knob[i] * 28), 2);
    }
    // output level meter
    rect(0, 62, Math.round(Math.min(1, level) * 128), 2);
    U8.set(fb, Lo.display);
    Atomics.add(U32, Lo.displaySeq >> 2, 1);
  }

  /* ---------------- LEDs ---------------- */
  const leds = new Uint8Array(768);
  const ROW_DIM = [65, 79, 83, 95], ROW_BRIGHT = [1, 7, 10, 16];
  const TRACK_COL = [1, 7, 10, 16];
  const WHITE = [49, 50, 51, 52, 54, 55, 56, 58, 60, 62, 63, 88, 119];
  function updateLeds() {
    leds.fill(0);
    const setN = (n, v, ch = 0) => { leds[n * 2] = v; leds[n * 2 + 1] = ch; };
    const setC = (c, v, ch = 0) => { leds[256 + c * 2] = v; leds[256 + c * 2 + 1] = ch; };
    for (let p = 68; p <= 99; p++) {
      const row = (p - 68) >> 3;
      const isRoot = ((padToNote(p) - transpose) % 12 + 12) % 12 === 0;
      setN(p, padHeld.has(p) ? ROW_BRIGHT[row] : isRoot ? 118 : ROW_DIM[row]);
    }
    for (let s = 0; s < 16; s++) {
      const cur = playing && s === step;
      setN(16 + s, cur ? 120 : stepOn[s] ? 16 : 0);
      setC(16 + s, s % 4 === 0 ? 40 : 0);
    }
    for (const c of WHITE) setC(c, heldCC[c] ? 124 : 16);
    for (let i = 0; i < 8; i++) setC(71 + i, touched[i] ? 16 : 0);
    for (let t = 0; t < 4; t++) setC(43 - t, t === track ? TRACK_COL[t] : ROW_DIM[t]);
    setC(85, playing ? 126 : 83);                 // Play: green / dim green
    setC(86, recArmed ? 127 : 65, recArmed ? 14 : 0);   // Rec: blink 4th when armed
    setC(118, heldCC[118] ? 120 : 119);           // Sample (RGB)
    if (playing) setC(85, 126, 9);                // pulse at quarter notes
    let changed = false;
    const base = Lo.leds;
    for (let i = 0; i < 768; i++) if (U8[base + i] !== leds[i]) { U8[base + i] = leds[i]; changed = true; }
    // RGB override demo: master ring (CC 79) shows the output level while touched
    const ro = Lo.ledRgb + (128 + 79) * 4;
    const want = touched[8] ? Math.round(40 + master * 215) : 0;
    if (U8[ro + 3] !== (touched[8] ? 1 : 0) || U8[ro] !== want) {
      U8[ro] = want; U8[ro + 1] = want; U8[ro + 2] = want; U8[ro + 3] = touched[8] ? 1 : 0; changed = true;
    }
    if (changed) Atomics.add(U32, Lo.ledsSeq >> 2, 1);
  }

  /* ---------------- device loop ---------------- */
  let frames = 0, uiTicks = 0, lastUi = 0;
  const cap = RING_BLOCKS;
  for (;;) {
    drainMidi();
    let w = Atomics.load(ctl, 0);
    while (((w - Atomics.load(ctl, 1)) >>> 0) < cap) {
      const idx = (w >>> 0) % cap;
      renderBlock(ring.subarray(idx * BLOCK * 2, (idx + 1) * BLOCK * 2));
      w = (w + 1) | 0;
      Atomics.store(ctl, 0, w);
      stat(0, ++frames);
      drainMidi();
    }
    const now = performance.now();
    if (now - lastUi >= 33) {
      lastUi = now;
      drawDisplay(now);
      updateLeds();
      stat(1, ++uiTicks);
    }
    // Ring full: park until the worklet frees a slot (or 8 ms for UI/MIDI).
    Atomics.wait(ctl, 1, Atomics.load(ctl, 1), 8);
  }
}
