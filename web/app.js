// schwung-wasm page: boots the engine (real Emscripten build if present,
// mock otherwise), wires the audio ring into an AudioWorklet, and drives the
// virtual Move panel. Contract: docs/ENGINE-INTERFACE.md.

import { Panel, W, H } from './panel.js';

const $ = (id) => document.getElementById(id);
const canvas = $('device');
const tip = $('tip');

/* ---------------- state ---------------- */
let Module = null, actx = null, node = null, engineKind = null;
let views = null;          // live typed-array accessors over wasm memory
let started = false;
let bpm = 120;
let persist = null;

/* ---------------- panel ---------------- */
const panel = new Panel(canvas, {
  send: (cable, b0, b1, b2) => { if (Module && started) Module._sw_midi_in(cable, b0, b1, b2); },
  onHover: showTip,
});

function layout() {
  if (viewMode === '3d') { view3d?.resize(); return; }
  const header = document.querySelector('header').offsetHeight;
  const footer = document.querySelector('footer').offsetHeight;
  const gutter = window.innerWidth < 600 ? 16 : 48;
  const availW = window.innerWidth - gutter;
  const availH = window.innerHeight - header - footer - 24;
  const w = Math.min(availW, availH * W / H, 1500);
  panel.resize(w);
}
window.addEventListener('resize', () => { showTip(null); layout(); });
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', layout);

/* ---------------- 2D / 3D view ----------------
 * Both views drive the same Panel (MIDI, held state, LED palette), so
 * switching never touches the engine or audio. three.js loads on first use. */
let viewMode = '2d', view3d = null, view3dLoading = null;
const VIEW_KEY = 'schwung.view';
function initialView() {
  const q = new URLSearchParams(location.search).get('view');
  if (q === '2d' || q === '3d') return q;
  try { return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : '2d'; } catch { return '2d'; }
}
async function setView(mode) {
  viewMode = mode;
  try { localStorage.setItem(VIEW_KEY, mode); } catch {}
  const u = new URL(location.href);
  if (u.searchParams.has('view')) { u.searchParams.set('view', mode); history.replaceState(null, '', u); }
  $('v2d').classList.toggle('on', mode === '2d');
  $('v3d').classList.toggle('on', mode === '3d');
  document.body.classList.toggle('v3d', mode === '3d');
  showTip(null);
  if (mode === '3d') {
    panel.hidden = true;
    $('view3d').classList.add('on');
    try {
      if (!view3d) {
        view3dLoading ??= import('./view3d.js').then(({ View3D }) => new View3D($('view3d'), panel, { onHover: showTip }));
        view3d = await view3dLoading;
        $('v3dLoading').remove();
      }
      if (viewMode === '3d') view3d.setActive(true);
    } catch (e) {
      console.error('3D view failed:', e);
      $('v3dLoading').textContent = '3D view unavailable: ' + (e?.message || e);
    }
  } else {
    view3d?.setActive(false);
    $('view3d').classList.remove('on');
    panel.hidden = false;
    layout();                                    // re-renders the 2D OLED and chassis
    panel.dirty = true;
  }
}
$('v2d').addEventListener('click', () => setView('2d'));
$('v3d').addEventListener('click', () => setView('3d'));
$('camReset').addEventListener('click', () => view3d?.resetView());
$('camTop').addEventListener('click', () => view3d?.topView());
layout();
setView(initialView());

function loop(now) {
  if (viewMode === '3d') { if (view3d?.active) view3d.frame(now); }
  else panel.frame(now);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------------- tooltip ---------------- */
function showTip(c, x, y) {
  if (!c) { tip.classList.remove('on'); return; }
  tip.innerHTML = '';
  tip.append(c.name);
  if (c.key) { const k = document.createElement('span'); k.className = 'key'; k.textContent = c.key; tip.append(k); }
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let tx = x + pad, ty = y + pad;
  if (tx + r.width > window.innerWidth - 4) tx = x - r.width - pad;
  if (ty + r.height > window.innerHeight - 4) ty = y - r.height - pad;
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
  tip.classList.add('on');
}

/* ---------------- engine loading ---------------- */
// ?engine=mock forces the mock, ?engine=real refuses to fall back.
const ENGINE_PREF = new URLSearchParams(location.search).get('engine');
async function haveRealEngine() {
  if (ENGINE_PREF === 'mock') return false;
  if (ENGINE_PREF === 'real') return true;
  try {
    const r = await fetch('./engine/schwung.js', { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

async function loadEngine() {
  const print = (...a) => console.log('[engine]', ...a);
  const printErr = (...a) => console.warn('[engine]', ...a);
  if (await haveRealEngine()) {
    const { default: createSchwung } = await import('./engine/schwung.js');
    engineKind = 'real';
    const engineBase = new URL('./engine/', import.meta.url);
    const M = await createSchwung({ print, printErr, locateFile: (f) => new URL(f, engineBase).href });
    // Persist the user's /data/UserData across reloads (IndexedDB), if the build ships it.
    try {
      persist = await import('./engine/persist.mjs');
      const n = await persist.restore(M);
      if (n) console.log('[persist] restored', n);
    } catch (e) { persist = null; console.warn('[persist] unavailable:', e.message); }
    return M;
  }
  const { default: createMockSchwung } = await import('./mock-engine.js');
  engineKind = 'mock';
  return createMockSchwung({ print, printErr });
}

// Typed views over the (possibly growable) shared heap. Recreated whenever
// the buffer changes size, so memory growth never leaves stale views.
function makeViews(M) {
  const mem = M.wasmMemory;
  let buf = null, u8 = null, u32 = null;
  const refresh = () => {
    const b = mem ? mem.buffer : M.HEAPU8.buffer;
    if (!buf || b.byteLength !== buf.byteLength) { buf = b; u8 = new Uint8Array(b); u32 = new Uint32Array(b); }
    return u8;
  };
  refresh();
  const p = {
    display: M._sw_display(), displaySeq: M._sw_display_seq(), leds: M._sw_leds(), ledsSeq: M._sw_leds_seq(),
    rgb: M._sw_led_rgb(), ring: M._sw_audio_ring(), ctl: M._sw_audio_ring_ctl(),
  };
  return {
    ptr: p,
    get buffer() { refresh(); return buf; },
    display: () => refresh().subarray(p.display, p.display + 1024),
    displaySeq: () => { refresh(); return Atomics.load(u32, p.displaySeq >> 2); },
    leds: () => refresh().subarray(p.leds, p.leds + 768),
    ledsSeq: () => { refresh(); return Atomics.load(u32, p.ledsSeq >> 2); },
    ledRgb: () => refresh().subarray(p.rgb, p.rgb + 1024),
    ctl: (i) => { refresh(); return Atomics.load(u32, (p.ctl >> 2) + i); },
  };
}

/* ---------------- power on ---------------- */
async function powerOn() {
  const btn = $('powerBtn'), msg = $('powerMsg');
  btn.disabled = true; msg.className = ''; msg.textContent = 'Starting audio…';
  try {
    if (!window.crossOriginIsolated)
      throw new Error('Page is not cross-origin isolated (no SharedArrayBuffer).\nServe it with: node scripts/serve.mjs');
    actx = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' });
    if (actx.sampleRate !== 44100) console.warn('AudioContext runs at', actx.sampleRate, 'Hz, not 44100');
    await actx.audioWorklet.addModule('./worklet.js');
    msg.textContent = 'Loading engine…';
    Module = await loadEngine();
    $('badge').hidden = false;
    $('badge').textContent = engineKind === 'mock' ? 'mock engine' : 'engine';
    $('badge').classList.toggle('real', engineKind === 'real');
    msg.textContent = 'Booting…';
    const rc = Module._sw_start(44100);
    if (rc !== 0) throw new Error('sw_start returned ' + rc);
    views = makeViews(Module);
    Module._sw_set_bpm?.(bpm);
    if (Module._sw_set_latency_blocks) Module._sw_set_latency_blocks(Number($('buf').value));
    else $('buf').disabled = true;
    try { persist?.autosave(Module, { everyMs: 2000 }); } catch (e) { console.warn('[persist] autosave failed:', e); }
    started = true;
    $('openBtn').disabled = false;
    $('padsBtn').disabled = !Module._sw_set_pad_layout;
    setInterval(pollTrack, 200);
    panel.setSource(views);

    node = new AudioWorkletNode(actx, 'schwung-ring', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.port.onmessage = (e) => { if (e.data?.type === 'stat') workletConsumed = e.data.consumed; };
    node.port.postMessage({ memory: Module.wasmMemory ?? Module.HEAPU8.buffer, ring: views.ptr.ring, ctl: views.ptr.ctl });
    node.connect(actx.destination);
    await actx.resume();
    $('powerOverlay').classList.add('hidden');
    $('sEngine').textContent = engineKind + (actx.state === 'running' ? '' : ' (' + actx.state + ')');
    statsTimer = setInterval(stats, 500);
    stats();
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    msg.className = 'err';
    msg.textContent = String(e?.message || e);
  }
}
$('powerBtn').addEventListener('click', powerOn);

/* ---------------- status ---------------- */
let statsTimer = 0, workletConsumed = 0;
let lastStat = null;
function stats() {
  if (!views) return;
  const now = performance.now();
  const w = views.ctl(0), r = views.ctl(1), cap = views.ctl(2), under = views.ctl(3), dropped = views.ctl(5);
  const lastUs = Module._sw_stat(1), maxUs = Module._sw_stat(2);
  const dseq = views.displaySeq();
  const fill = (w - r) >>> 0;
  const blockMs = 128 / 44100 * 1000;
  const lat = ((actx.baseLatency || 0) + (actx.outputLatency || 0)) * 1000 + fill * blockMs;
  $('sLat').textContent = lat.toFixed(1) + ' ms';
  $('sLat').title = `baseLatency ${((actx.baseLatency || 0) * 1000).toFixed(1)} ms + outputLatency ${((actx.outputLatency || 0) * 1000).toFixed(1)} ms + ring ${fill} × ${blockMs.toFixed(2)} ms`;
  $('sRing').textContent = fill + '/' + cap;
  const uEl = $('sUnder');
  uEl.className = 'v' + (lastStat && under - lastStat.under > 0 ? ' bad' : '');
  uEl.textContent = String(under) + (dropped ? ' · ' + dropped + ' dropped' : '');
  const cpu = lastUs / (blockMs * 1000) * 100;
  $('sCpu').textContent = `${lastUs} µs/blk (${cpu.toFixed(0)}%) · max ${maxUs} µs`;
  $('sCpu').className = 'v' + (cpu > 70 ? ' bad' : cpu > 40 ? ' warn' : '');
  if (lastStat) $('sUi').textContent = Math.round((dseq - lastStat.dseq) / ((now - lastStat.t) / 1000)) + ' fps';
  lastStat = { t: now, under, dseq };
  $('sEngine').textContent = engineKind + (actx.state === 'running' ? '' : ' (' + actx.state + ')');
}

/* ---------------- latency (ring target fill) ---------------- */
$('buf').addEventListener('change', (e) => { if (started) Module._sw_set_latency_blocks?.(Number(e.target.value)); });

/* ---------------- Open Schwung: Shift + Volume touch + Track ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function openSchwung() {
  if (!started) return;
  const track = Module._sw_get_track ? Module._sw_get_track() : 0;
  const trackId = 'track-' + (Math.max(0, Math.min(3, track)) + 1);
  panel.press('btn-shift', true); panel.touch('master', true);
  await sleep(60);
  panel.press(trackId, true); await sleep(80); panel.press(trackId, false);
  await sleep(40);
  panel.touch('master', false); panel.press('btn-shift', false);
}
$('openBtn').addEventListener('click', openSchwung);

/* ---------------- per-track pad layout (drums / notes) ---------------- */
let curTrack = -1, curLayout = -1;
function pollTrack() {
  if (!Module?._sw_get_pad_layout) return;
  const t = Module._sw_get_track ? Module._sw_get_track() : 0;
  const l = Module._sw_get_pad_layout(t);
  if (t === curTrack && l === curLayout) return;
  curTrack = t; curLayout = l;
  $('padsBtn').textContent = `T${t + 1} pads: ${l ? 'Drums' : 'Notes'}`;
  $('padsBtn').classList.toggle('on', !!l);
}
$('padsBtn').addEventListener('click', () => {
  if (!Module?._sw_set_pad_layout || curTrack < 0) return;
  Module._sw_set_pad_layout(curTrack, curLayout ? 0 : 1);
  pollTrack();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden && actx?.state === 'suspended') actx.resume(); });

/* ---------------- BPM ---------------- */
$('bpm').addEventListener('change', (e) => {
  bpm = Math.max(20, Math.min(300, Number(e.target.value) || 120));
  e.target.value = bpm; panel.bpm = bpm;
  if (started) Module._sw_set_bpm?.(bpm);
});

/* ---------------- help ---------------- */
const help = $('help');
const toggleHelp = (on = help.classList.contains('hidden')) => help.classList.toggle('hidden', !on);
$('helpBtn').addEventListener('click', () => toggleHelp());
help.addEventListener('click', (e) => { if (e.target === help) toggleHelp(false); });

/* ---------------- keyboard ---------------- */
const PIANO = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9,
  KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17 };
const KEYMAP = {
  ArrowUp: 'btn-up', ArrowDown: 'btn-down', ArrowLeft: 'btn-left', ArrowRight: 'btn-right',
  Enter: 'jog', NumpadEnter: 'jog', Backspace: 'btn-back', Escape: 'btn-back', ShiftLeft: 'btn-shift', ShiftRight: 'btn-shift',
  Space: 'btn-play', KeyR: 'btn-rec', KeyM: 'btn-menu', KeyC: 'btn-capture', KeyB: 'btn-loop', KeyN: 'btn-mute',
  KeyV: 'btn-copy', KeyI: 'btn-sample', Delete: 'btn-delete', F1: 'track-1', F2: 'track-2', F3: 'track-3', F4: 'track-4',
};
let pianoBase = 0;                       // pad index of the A key: 0 or 12
const keyHeld = new Map();               // code -> control id (so releases match presses)
let knobKey = null;                      // control id selected by holding a digit

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '?') { toggleHelp(); e.preventDefault(); return; }
  if (e.key === 'Escape' && !help.classList.contains('hidden')) { toggleHelp(false); return; }
  if (e.repeat) { if (keyHeld.has(e.code) || PIANO[e.code] !== undefined) e.preventDefault(); return; }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') { hold(e.code, 'btn-undo'); e.preventDefault(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'KeyQ') { openSchwung(); return; }
  if (e.code === 'KeyZ') { pianoBase = Math.max(0, pianoBase - 12); return; }
  if (e.code === 'KeyX') { pianoBase = Math.min(12, pianoBase + 12); return; }
  if (e.code === 'BracketLeft') { panel.nudge('jog', -1); return; }
  if (e.code === 'BracketRight') { panel.nudge('jog', 1); return; }
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) {
    knobKey = digit[1] === '9' ? 'master' : 'knob-' + digit[1];
    keyHeld.set(e.code, knobKey); panel.touch(knobKey, true); e.preventDefault(); return;
  }
  if ((e.code === 'Minus' || e.code === 'Equal') && knobKey) { panel.turn(knobKey, e.code === 'Equal' ? 1 : -1); e.preventDefault(); return; }
  if (PIANO[e.code] !== undefined) {
    const idx = pianoBase + PIANO[e.code];
    if (idx <= 31) hold(e.code, 'pad-' + (68 + idx), 100);
    e.preventDefault(); return;
  }
  const id = KEYMAP[e.code];
  if (id) { hold(e.code, id); e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  const id = keyHeld.get(e.code);
  if (!id) return;
  keyHeld.delete(e.code);
  if (/^Digit/.test(e.code)) { panel.touch(id, false); if (knobKey === id) knobKey = null; return; }
  panel.press(id, false);
});
window.addEventListener('blur', () => {       // never leave notes stuck
  for (const [code, id] of keyHeld) { /^Digit/.test(code) ? panel.touch(id, false) : panel.press(id, false); }
  keyHeld.clear(); knobKey = null;
});
function hold(code, id, vel) { keyHeld.set(code, id); panel.press(id, true, vel); }
window.addEventListener('wheel', (e) => {
  if (!knobKey) return;
  e.preventDefault();
  panel.turn(knobKey, (e.deltaY < 0 ? 1 : -1) * Math.max(1, Math.min(10, Math.round(Math.abs(e.deltaY) / 40))));
}, { passive: false });

/* ---------------- Web MIDI (cable 2) ---------------- */
let midiAccess = null, midiOn = false;
const midiBtn = $('midiBtn');
if (!navigator.requestMIDIAccess) { midiBtn.disabled = true; midiBtn.title = 'Web MIDI is not available in this browser'; }
function onMidi(e) {
  if (!midiOn || !started) return;
  const d = e.data;
  if (!d || d.length < 1 || d[0] >= 0xf0) return;     // skip SysEx / realtime
  Module._sw_midi_in(2, d[0], d[1] ?? 0, d[2] ?? 0);
}
function attachInputs() { for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidi; }
midiBtn.addEventListener('click', async () => {
  if (!midiAccess) {
    try { midiAccess = await navigator.requestMIDIAccess({ sysex: false }); }
    catch (err) { midiBtn.title = 'MIDI access denied: ' + err.message; return; }
    midiAccess.onstatechange = attachInputs;
    attachInputs();
  }
  midiOn = !midiOn;
  midiBtn.classList.toggle('on', midiOn);
  const names = [...midiAccess.inputs.values()].map((i) => i.name);
  midiBtn.title = midiOn ? 'Forwarding: ' + (names.join(', ') || 'no inputs yet') : 'Forward Web MIDI input to the engine on cable 2';
});

/* ---------------- debug hook (smoke test, console) ---------------- */
window.swDebug = {
  panel,
  get started() { return started; },
  get engine() { return engineKind; },
  get audioState() { return actx?.state; },
  get sampleRate() { return actx?.sampleRate; },
  ctl: () => views ? [0, 1, 2, 3, 4, 5].map((i) => views.ctl(i)) : null,
  stat: (i) => Module?._sw_stat(i),
  openSchwung,
  displaySeq: () => views?.displaySeq(),
  oledLit: () => { if (!views) return 0; let n = 0; for (const b of views.display()) for (let v = b; v; v &= v - 1) n++; return n; },
  noteLed: (n) => views ? [...views.leds().subarray(n * 2, n * 2 + 2)] : null,
  ccLed: (c) => views ? [...views.leds().subarray(256 + c * 2, 256 + c * 2 + 2)] : null,
  center: (id) => (viewMode === '3d' && view3d?.active ? view3d.clientCenter(id) : panel.clientCenter(id)),
  get view() { return viewMode; },
  get view3d() { return view3d; },
  setView,
  sent: () => ({ ...panel.sent }),
};
