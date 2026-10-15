// The virtual Ableton Move front panel: drawing, LED/OLED rendering, and
// pointer/wheel input translated to Move surface MIDI (cable 0).
//
// Derived from schwung-manager/static/mirror.html (Schwung, MIT): the device
// arrangement, the 128-entry LED palette with its white-LED balance column,
// the LED animation-by-channel interpretation and the button glyphs. Those in
// turn follow move_midi_emulator.html from Cycling '74's rnbo.move.templates:
//   The MIT License. Copyright 2026, Cycling '74. All rights reserved.
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software ... (full text in
//   third_party/schwung/THIRD_PARTY_LICENSES.md).

/* ---------------- palette (Cycling '74, MIT -- see header) ---------------- */
const COLOR_TABLE = [
  [0x000000,0],[0xFF4032,2],[0x800400,4],[0xC93C00,6],[0xAC1F00,8],
  [0x8C5018,10],[0x491804,12],[0xFADC3B,14],[0xFFC516,16],[0xB6FF0E,18],
  [0x79FF18,20],[0x34C216,22],[0x4F8A04,24],[0x62FF55,26],[0x297D53,28],
  [0x269E72,30],[0x31ADFF,32],[0x3663FC,34],[0x1A34FF,36],[0x1C0CE6,38],
  [0x153999,40],[0x3937FF,42],[0x5722FF,44],[0x972BFF,46],[0x852178,48],
  [0xFF1032,50],[0xFF2BD4,52],[0xA63421,54],[0x995628,56],[0x876700,58],
  [0x90821F,60],[0x4A8700,62],[0x007F12,64],[0x1853B2,66],[0x624BAD,68],
  [0x733A67,70],[0xF8BCAF,72],[0xFF9B76,74],[0xFFBF5F,76],[0xD9AF71,78],
  [0xFFF480,80],[0xBFBA69,80],[0xBCCC88,81],[0xAEFF99,81],[0x7CDD9F,82],
  [0x89B47D,82],[0x80F3FF,83],[0x7ACEFC,83],[0x68A1D3,84],[0x858FC2,85],
  [0xBBAAF2,85],[0xCDBBE4,86],[0xEF8BB0,86],[0x859D8C,87],[0x6B756E,87],
  [0x84909B,88],[0x6A7075,88],[0x88859D,89],[0x6C6A75,90],[0x9D859C,90],
  [0x746A74,91],[0x9C9D85,91],[0x74756A,92],[0x9D8484,92],[0x756A6A,93],
  [0x661914,93],[0x210806,94],[0x460300,94],[0x280000,95],[0x5D1700,96],
  [0x200D00,96],[0x470C00,97],[0x1C0800,97],[0x3B2B14,98],[0x1C130A,98],
  [0x250E05,99],[0x0D0602,99],[0x645817,100],[0x201C07,101],[0x664E08,101],
  [0x211902,102],[0x486605,102],[0x172101,103],[0x306609,103],[0x0F2103,104],
  [0x144D08,104],[0x061902,105],[0x1F3701,106],[0x0A1100,106],[0x276622,107],
  [0x0C210B,107],[0x143E29,108],[0x081910,108],[0x004D36,109],[0x00180E,109],
  [0x134566,110],[0x061621,110],[0x152764,111],[0x070C20,112],[0x0A1466,112],
  [0x030621,113],[0x0B045C,113],[0x03011D,114],[0x0A1C4C,114],[0x040B1E,115],
  [0x161666,115],[0x070721,116],[0x220D66,117],[0x0B0421,117],[0x3C1166,118],
  [0x130521,118],[0x350D30,119],[0x11040F,119],[0x660614,120],[0x210206,120],
  [0x661154,121],[0x21051B,122],[0x000000,122],[0x595959,123],[0x1A1A1A,123],
  [0xFFFFFF,124],[0x595959,124],[0xCCCCCC,125],[0x404040,125],[0x141414,126],
  [0x0000FF,126],[0x00FF00,127],[0xFF0000,127],
];
// Precomputed (shared, treat as read-only) so LED polling allocates nothing.
const PAL = COLOR_TABLE.map(([h]) => Object.freeze([(h >> 16) & 255, (h >> 8) & 255, h & 255]));
const WHITE = COLOR_TABLE.map(([, w]) => { const b = Math.round(w / 127 * 255); return Object.freeze([b, b, b]); });
export const palette = (v) => (v <= 0 || v > 127 ? null : PAL[v]);
export const white = (v) => (v <= 0 || v > 127 ? null : WHITE[v]);

/* ---------------- geometry (logical units, after mirror.html) ---------------- */
export const W = 920;
const P = 20, GAP = 12;
const COL_L = 150, COL_T = 30, COL_F = 112;
const PAD_X = P + COL_L + GAP + COL_T + GAP;
const PAD_W = W - PAD_X - GAP - COL_F - P;
const PAD_GAP = 7, PAD_CW = (PAD_W - 7 * PAD_GAP) / 8, PAD_CH = Math.round(PAD_CW * 0.82);
const TOP_H = 88, TOP_Y = P;
const PADS_Y = TOP_Y + TOP_H + GAP;
const PADS_H = 4 * PAD_CH + 3 * PAD_GAP;
const STEP_Y = PADS_Y + PADS_H + GAP + 24;
const ICON_Y = STEP_Y + 22;
export const H = ICON_Y + 8 + P;
const FUNC_X = W - P - COL_F;
const padCx = (c) => PAD_X + c * (PAD_CW + PAD_GAP) + PAD_CW / 2;
const rowCy = (r) => PADS_Y + r * (PAD_CH + PAD_GAP) + PAD_CH / 2;
const OLED = { w: 128 * 1.08, h: 64 * 1.08 };
OLED.x = P + (COL_L - OLED.w) / 2 - 4; OLED.y = TOP_Y + (TOP_H - OLED.h) / 2;

const ICONS = {  /* 16x16 SVG path data, from the emulator's button glyphs */
  back: 'M10,4 L6,8 L10,12',
  menu: 'M2,3.5 L14,3.5 M2,8 L14,8 M2,12.5 L14,12.5',
  play: 'M3,1 L14,8 L3,15 Z',
  rec: 'M15,8 A7,7 0 1,1 1,8 A7,7 0 1,1 15,8',
  capture: 'M1,4 L1,1 L4,1 M12,1 L15,1 L15,4 M15,12 L15,15 L12,15 M4,15 L1,15 L1,12',
  loop: 'M4,3 L12,3 A3.5,3.5 0 0,1 12,13 L4,13 A3.5,3.5 0 0,1 4,3 M9,15.5 L6,13 L9,10.5',
  mute: 'M3,13 L3,3 L8,10 L13,3 L13,13',
  delete: 'M2.3,2.3 L13.7,13.7 M13.7,2.3 L2.3,13.7',
  copy: 'M2,5 h7 v7 h-7 Z M6,1.5 h7 v7 h-7',
  undo: 'M5,4.5 L3,7 L5,9.5 M3,7 L11,7 A3.5,3.5 0 0,1 11,13 L9,13',
  up: 'M4,10.5 L8,6 L12,10.5',
  down: 'M4,6 L8,10.5 L12,6',
  left: 'M10,4 L6,8 L10,12',
  right: 'M6,4 L10,8 L6,12',
};
const path2d = {};
for (const [k, d] of Object.entries(ICONS)) path2d[k] = new Path2D(d);

/* ---------------- controls ---------------- */
// kind: pad | step | button | track | knob | jog. Keyboard hints in `key`.
function buildControls() {
  const C = [];
  const add = (c) => { C.push(c); return c; };
  for (let i = 0; i < 8; i++)
    add({ id: 'knob-' + (i + 1), kind: 'knob', name: 'Knob ' + (i + 1), cc: 71 + i, touch: i,
          cx: padCx(i), cy: TOP_Y + TOP_H / 2, r: 17, key: 'hold ' + (i + 1) + ' + wheel / - =' });
  add({ id: 'master', kind: 'knob', name: 'Master volume', cc: 79, touch: 8,
        cx: FUNC_X + COL_F * 0.62, cy: TOP_Y + TOP_H / 2, r: 23, key: 'hold 9 + wheel / - =' });
  const wx = P + COL_L / 2, wy = (rowCy(0) + rowCy(1)) / 2;
  add({ id: 'jog', kind: 'jog', name: 'Jog wheel (turn / click)', cc: 14, click: 3, touch: 9,
        cx: wx, cy: wy, r: 36, key: '[ ] turn, Enter click' });
  const btn = (id, name, cc, cx, cy, r, glyph, isWhite, key) =>
    add({ id: 'btn-' + id, kind: 'button', name, cc, cx, cy, r, glyph, white: isWhite, key });
  btn('back', 'Back', 51, wx - 24, rowCy(2) + 4, 16, 'back', true, 'Backspace / Esc');
  btn('menu', 'Menu', 50, wx + 24, rowCy(2) + 4, 16, 'menu', true, 'M');
  for (let r = 0; r < 4; r++)
    add({ id: 'track-' + (r + 1), kind: 'track', name: 'Track ' + (r + 1), cc: 43 - r,
          x: P + COL_L + GAP + (COL_T - 16) / 2, y: rowCy(r) - PAD_CH / 2, w: 16, h: PAD_CH, key: 'F' + (r + 1) });
  for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) {
    const n = 68 + (3 - r) * 8 + c;
    add({ id: 'pad-' + n, kind: 'pad', name: 'Pad ' + (n - 67) + ' (note ' + n + ')', note: n,
          x: PAD_X + c * (PAD_CW + PAD_GAP), y: PADS_Y + r * (PAD_CH + PAD_GAP), w: PAD_CW, h: PAD_CH });
  }
  const FUNCS = [
    ['capture', 'Capture', 52, true, 'C'], ['sample', 'Sample', 118, false, ''],
    ['loop', 'Loop', 58, true, 'L'], ['mute', 'Mute', 88, true, 'N'],
    ['delete', 'Delete', 119, true, 'Delete'], ['copy', 'Copy', 60, true, 'V'],
    ['undo', 'Undo', 56, true, 'Z'], ['shift', 'Shift', 49, true, 'Shift'],
  ];
  FUNCS.forEach(([g, name, cc, isWhite, key], i) =>
    btn(g, name, cc, FUNC_X + COL_F * (i % 2 ? 0.75 : 0.25), rowCy(Math.floor(i / 2)), 17, g, isWhite, key));
  btn('play', 'Play', 85, wx - 24, STEP_Y, 16, 'play', false, 'Space');
  btn('rec', 'Record', 86, wx + 24, STEP_Y, 16, 'rec', false, 'R');
  const stepPitch = PAD_W / 16;
  for (let i = 0; i < 16; i++)
    add({ id: 'step-' + (i + 1), kind: 'step', name: 'Step ' + (i + 1), note: 16 + i,
          cx: PAD_X + stepPitch * (i + 0.5), cy: STEP_Y, r: Math.min(11, stepPitch * 0.34) });
  const nx = FUNC_X + COL_F / 2, ny = STEP_Y + 2;
  btn('up', 'Up', 55, nx, ny - 13, 11, 'up', true, '↑');
  btn('down', 'Down', 54, nx, ny + 13, 11, 'down', true, '↓');
  btn('left', 'Left', 62, nx - 28, ny, 11, 'left', true, '←');
  btn('right', 'Right', 63, nx + 28, ny, 11, 'right', true, '→');
  return C;
}

/* ---------------- helpers ---------------- */
const css = (c, a = 1) => (c ? (a === 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`) : null);
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const ANIM_MS_120 = [500 / 6, 125, 250, 500, 1000];   // 24th 16th 8th 4th half @120

/* ---------------- shared input gestures (2D panel and 3D view) ----------------
 * Both views feed these the same pointer data so they send identical MIDI. */
/** Pad velocity: real pen/touch pressure when present, else from where the pad
 *  was hit (`frac` 0 = top edge -> 127, 0.5 = centre -> 100, 1 = bottom -> 73). */
export function padVelocity(e, frac) {
  if (e.pointerType !== 'mouse' && e.pressure > 0 && e.pressure !== 0.5) return Math.round(20 + e.pressure * 107);
  return Math.round(127 - Math.max(0, Math.min(1, frac)) * 54);
}
/** Vertical knob drag: `dy` px upward since the last move. Accelerates with
 *  speed, `fine` (Shift) = quarter speed. Returns whole ticks to send. */
export function knobDragTicks(st, dy, fine) {
  const accel = 1 + Math.min(4, Math.abs(dy) / 5);
  st.acc += dy * accel * (fine ? 0.25 : 1);
  const ticks = Math.trunc(st.acc / 3);
  st.acc -= ticks * 3;
  return ticks;
}
/** Jog drag around the rim: `a` = pointer angle around the centre (screen
 *  space, y down, so clockwise is positive). One detent per 15 degrees. */
export function jogDragTicks(st, a) {
  if (st.angle === null) { st.angle = a; return 0; }
  let da = a - st.angle;
  if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
  st.angle = a;
  st.acc += da;
  const STEP = Math.PI / 12;
  const ticks = Math.trunc(st.acc / STEP);
  st.acc -= ticks * STEP;
  return ticks;
}
/** Wheel event -> signed ticks (up = clockwise). */
export const wheelTicks = (e) => (e.deltaY < 0 ? 1 : -1) * Math.max(1, Math.min(10, Math.round(Math.abs(e.deltaY) / (e.deltaMode ? 1 : 40))));

/* ================================================================ Panel */
export class Panel {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{send:(cable:number,b0:number,b1:number,b2:number)=>void, onHover?:Function}} io
   */
  constructor(canvas, io) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.io = io;
    this.controls = buildControls();
    this.byId = new Map(this.controls.map((c) => [c.id, c]));
    this.src = null;             // engine views (setSource)
    this.bpm = 120;
    this.scale = 1; this.dpr = 1;
    this.held = new Map();       // control id -> { vel, at }
    this.pointers = new Map();   // pointerId -> drag state
    this.knobPos = new Map();    // control id -> visual rotation ticks
    this.wheelTimers = new Map();
    this.dirty = true;
    this.rev = 0;                // bumps on every held/turn change (the 3D view watches it)
    this.hidden = false;         // true while the 3D view is shown: skip 2D OLED rendering
    this.lastDisplaySeq = -1; this.lastLedSeq = -1;
    this.oled = document.createElement('canvas');
    this.oledImg = null;
    this.oledBits = new Uint8Array(1024);
    this.oledOn = false;
    this.sent = { notes: 0, cc: 0, last: '' };
    this.chassis = null;
    this._bindInput();
  }

  setSource(src) { this.src = src; this.dirty = true; this.lastDisplaySeq = -1; this.lastLedSeq = -1; }

  /* ---------- sizing ---------- */
  resize(cssWidth) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const cssW = Math.max(240, Math.floor(cssWidth));
    const cssH = Math.round(cssW * H / W);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.dpr = dpr; this.scale = cssW / W;
    this.chassis = null;
    this._renderOled(true);
    this.dirty = true;
  }

  /* ---------- MIDI out ---------- */
  _send(b0, b1, b2) {
    this.io.send(0, b0, b1, b2);
    if ((b0 & 0xf0) === 0xb0) this.sent.cc++; else this.sent.notes++;
    this.sent.last = [b0, b1, b2].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  }
  _rel(d) { return d >= 0 ? Math.min(63, d) : 128 + Math.max(-63, d); }

  /** Press/release a control by id (used by pointer and keyboard paths). */
  press(id, down, vel = 100) {
    const c = this.byId.get(id); if (!c) return;
    const isDown = this.held.has(id);
    if (down === isDown) return;
    if (down) this.held.set(id, { vel, at: 0 }); else this.held.delete(id);
    this.dirty = true; this.rev++;
    switch (c.kind) {
      case 'pad': down ? this._send(0x90, c.note, Math.max(1, Math.min(127, vel | 0))) : this._send(0x80, c.note, 0); break;
      case 'step': down ? this._send(0x90, c.note, 127) : this._send(0x80, c.note, 0); break;
      case 'button': case 'track': this._send(0xb0, c.cc, down ? 127 : 0); break;
      case 'knob': down ? this._send(0x90, c.touch, 127) : this._send(0x80, c.touch, 0); break;
      case 'jog': this._send(0xb0, c.click, down ? 127 : 0); break;
    }
  }
  touch(id, down) {
    const c = this.byId.get(id); if (!c || c.touch === undefined) return;
    const key = id + ':touch';
    if (down === this.held.has(key)) return;
    if (down) this.held.set(key, {}); else this.held.delete(key);
    down ? this._send(0x90, c.touch, 127) : this._send(0x80, c.touch, 0);
    this.dirty = true; this.rev++;
  }
  /** Turn a knob / the jog by relative ticks (+ = clockwise). */
  turn(id, ticks) {
    const c = this.byId.get(id); if (!c || !ticks) return;
    let t = Math.round(ticks);
    this.knobPos.set(id, (this.knobPos.get(id) || 0) + t);
    while (t !== 0) { const s = Math.max(-63, Math.min(63, t)); this._send(0xb0, c.cc, this._rel(s)); t -= s; }
    this.dirty = true; this.rev++;
  }
  /** Wheel-style turn: touch on, turn, touch off after idle. */
  nudge(id, ticks) {
    const c = this.byId.get(id); if (!c) return;
    this.touch(id, true);
    this.turn(id, ticks);
    clearTimeout(this.wheelTimers.get(id));
    this.wheelTimers.set(id, setTimeout(() => this.touch(id, false), 350));
  }
  aftertouch(id, value) {
    const c = this.byId.get(id), h = this.held.get(id);
    if (!c || c.kind !== 'pad' || !h) return;
    const v = Math.max(0, Math.min(127, value | 0));
    if (v === h.at) return;
    h.at = v; this._send(0xa0, c.note, v); this.dirty = true;
  }

  /* ---------- hit testing ---------- */
  toLogical(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }
  hit(x, y) {
    let best = null, bestD = Infinity;
    for (const c of this.controls) {
      if (c.r !== undefined) {
        const d = Math.hypot(x - c.cx, y - c.cy);
        const reach = c.r + (c.kind === 'step' ? 7 : 5);
        if (d <= reach && d < bestD) { best = c; bestD = d; }
      } else if (x >= c.x - 3 && x <= c.x + c.w + 3 && y >= c.y - 3 && y <= c.y + c.h + 3) {
        return c;
      }
    }
    return best;
  }
  /** Centre of a control in client (CSS) pixels; for tests and tooltips. */
  clientCenter(id) {
    const c = this.byId.get(id); if (!c) return null;
    const r = this.canvas.getBoundingClientRect();
    const lx = c.cx ?? c.x + c.w / 2, ly = c.cy ?? c.y + c.h / 2;
    return { x: r.left + lx * this.scale, y: r.top + ly * this.scale };
  }

  _bindInput() {
    const cv = this.canvas;
    cv.style.touchAction = 'none';
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      const p = this.toLogical(e), c = this.hit(p.x, p.y);
      if (!c) return;
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch {}
      const st = { c, lastY: e.clientY, acc: 0, angle: null };
      this.pointers.set(e.pointerId, st);
      this.io.onHover?.(null);
      if (c.kind === 'pad') {
        this.press(c.id, true, padVelocity(e, (p.y - c.y) / c.h));
      } else if (c.kind === 'knob') {
        this.press(c.id, true);
      } else if (c.kind === 'jog') {
        this.touch(c.id, true);
        const d = Math.hypot(p.x - c.cx, p.y - c.cy);
        if (d < c.r * 0.45) { st.click = true; this.press(c.id, true); }
        else st.angle = Math.atan2(p.y - c.cy, p.x - c.cx);
      } else this.press(c.id, true);
    });
    cv.addEventListener('pointermove', (e) => {
      const st = this.pointers.get(e.pointerId);
      if (!st) {
        if (e.pointerType === 'mouse' && this.io.onHover) {
          const p = this.toLogical(e), c = this.hit(p.x, p.y);
          cv.style.cursor = c ? (c.kind === 'knob' ? 'ns-resize' : c.kind === 'jog' ? 'grab' : 'pointer') : 'default';
          this.io.onHover(c, e.clientX, e.clientY);
        }
        return;
      }
      const c = st.c;
      if (c.kind === 'knob') {
        const dy = st.lastY - e.clientY; st.lastY = e.clientY;
        const ticks = knobDragTicks(st, dy, e.shiftKey);
        if (ticks) this.turn(c.id, ticks);
      } else if (c.kind === 'jog') {
        const p = this.toLogical(e);
        if (Math.hypot(p.x - c.cx, p.y - c.cy) < c.r * 0.3) { st.angle = null; return; }
        const ticks = jogDragTicks(st, Math.atan2(p.y - c.cy, p.x - c.cx));
        if (ticks) this.turn(c.id, ticks);
      } else if (c.kind === 'pad' && e.pointerType !== 'mouse' && e.pressure > 0) {
        this.aftertouch(c.id, e.pressure * 127);
      }
    });
    const up = (e) => {
      const st = this.pointers.get(e.pointerId);
      if (!st) return;
      this.pointers.delete(e.pointerId);
      const c = st.c;
      if (c.kind === 'jog') { if (st.click) this.press(c.id, false); this.touch(c.id, false); }
      else this.press(c.id, false);
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.io.onHover?.(null); });
    cv.addEventListener('wheel', (e) => {
      const p = this.toLogical(e), c = this.hit(p.x, p.y);
      if (!c || (c.kind !== 'knob' && c.kind !== 'jog')) return;
      e.preventDefault();
      this.nudge(c.id, wheelTicks(e));
    }, { passive: false });
  }

  /* ---------- LEDs ---------- */
  _animate(rgb, ch, now) {
    if (!rgb || ch < 6 || ch > 14) return rgb;     // 0 solid, 1-5 transition (solid), 15 = normal
    this.animating = true;
    const ms = ANIM_MS_120[(ch - 6) % 5] * 120 / (this.bpm || 120);
    const ph = (now % (ms * 2)) / (ms * 2);
    if (ch >= 11) return ph < 0.5 ? rgb : null;                       // blink
    const k = 0.3 + 0.7 * (0.5 + 0.5 * Math.cos(ph * 2 * Math.PI));  // pulse
    return rgb.map((x) => Math.round(x * k));
  }
  _rgbOverride(bank, idx) {
    const rgb = this.src?.ledRgb?.();
    if (!rgb) return null;
    const o = (bank * 128 + idx) * 4;
    return rgb[o + 3] ? [rgb[o], rgb[o + 1], rgb[o + 2]] : null;
  }
  noteColor(n, now) {
    const o = this._rgbOverride(0, n); if (o) return o;
    const L = this.src?.leds?.(); if (!L) return null;
    return this._animate(palette(L[n * 2]), L[n * 2 + 1] & 15, now);
  }
  ccColor(cc, isWhite, now) {
    const o = this._rgbOverride(1, cc); if (o) return o;
    const L = this.src?.leds?.(); if (!L) return null;
    const v = L[256 + cc * 2];
    return this._animate(isWhite ? white(v) : palette(v), L[256 + cc * 2 + 1] & 15, now);
  }

  /* ---------- OLED ---------- */
  _pollDisplay() {
    const src = this.src; if (!src?.display) return false;
    const seq = src.displaySeq();
    if (seq === this.lastDisplaySeq) return false;
    this.lastDisplaySeq = seq;
    this.oledBits.set(src.display());
    this.oledOn = true;
    if (!this.hidden) this._renderOled(false);
    return true;
  }
  // Render the 128x64 frame into a device-pixel canvas, one crisp block per
  // OLED pixel with boundaries snapped to whole device pixels.
  _renderOled(resized) {
    const s = this.scale * this.dpr;
    const w = Math.round(OLED.w * s), h = Math.round(OLED.h * s);
    if (resized || this.oled.width !== w || this.oled.height !== h) { this.oled.width = w; this.oled.height = h; }
    const g = this.oled.getContext('2d');
    g.fillStyle = '#020304'; g.fillRect(0, 0, w, h);
    if (!this.oledOn) return;
    const xs = new Int32Array(129), ys = new Int32Array(65);
    for (let i = 0; i <= 128; i++) xs[i] = Math.round(i * w / 128);
    for (let j = 0; j <= 64; j++) ys[j] = Math.round(j * h / 64);
    const gapX = w / 128 >= 4 ? 1 : 0;
    g.fillStyle = '#eef4ff';
    const bits = this.oledBits;
    for (let page = 0; page < 8; page++) for (let x = 0; x < 128; x++) {
      const b = bits[page * 128 + x];
      if (!b) continue;
      for (let j = 0; j < 8; j++) if (b & (1 << j)) {
        const y = page * 8 + j;
        g.fillRect(xs[x], ys[y], xs[x + 1] - xs[x] - gapX, ys[y + 1] - ys[y] - gapX);
      }
    }
  }
  oledLitPixels() { let n = 0; for (const b of this.oledBits) for (let v = b; v; v &= v - 1) n++; return n; }

  /* ---------- drawing ---------- */
  _drawChassis() {
    const s = this.scale * this.dpr;
    const cv = document.createElement('canvas');
    cv.width = this.canvas.width; cv.height = this.canvas.height;
    const ctx = cv.getContext('2d');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    // body with a soft top-light gradient and bevel
    roundRect(ctx, 1, 1, W - 2, H - 2, 18);
    const body = ctx.createLinearGradient(0, 0, 0, H);
    body.addColorStop(0, '#3a3a3d'); body.addColorStop(0.5, '#323235'); body.addColorStop(1, '#2a2a2d');
    ctx.fillStyle = body; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#4a4a4e'; ctx.stroke();
    roundRect(ctx, 5, 5, W - 10, H - 10, 14);
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke();
    // OLED bezel
    roundRect(ctx, OLED.x - 7, OLED.y - 7, OLED.w + 14, OLED.h + 14, 5);
    ctx.fillStyle = '#121214'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.stroke();
    // pad well
    roundRect(ctx, PAD_X - 8, PADS_Y - 8, PAD_W + 16, PADS_H + 16, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fill();
    // step group ticks and icon slots
    const stepPitch = PAD_W / 16;
    for (let i = 0; i < 16; i += 4) {
      ctx.fillStyle = 'rgba(255,255,255,0.09)';
      ctx.fillRect(PAD_X + stepPitch * i + 4, STEP_Y - 20, stepPitch * 4 - 8, 1.5);
    }
    // jog well
    const j = this.byId.get('jog');
    ctx.beginPath(); ctx.arc(j.cx, j.cy, j.r + 6, 0, 7);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fill();
    // wordmark
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.font = '600 9px ui-sans-serif, system-ui, -apple-system, Helvetica, Arial';
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('schwung', P + 6, H - 10);
    this.chassis = cv;
  }

  _glyph(ctx, name, cx, cy, size, color) {
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 16, size / 16);
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (name === 'sample') { ctx.beginPath(); ctx.arc(8, 8, 4.5, 0, 7); ctx.fill(); }
    else if (name === 'shift') { for (const x of [3, 8, 13]) { ctx.beginPath(); ctx.arc(x, 8, 1.5, 0, 7); ctx.fill(); } }
    else if (name === 'play' || name === 'rec') ctx.fill(path2d[name]);
    else ctx.stroke(path2d[name]);
    ctx.restore();
  }

  _button(ctx, c, led, held) {
    const { cx, cy, r } = c;
    const grd = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.4, r * 0.1, cx, cy, r);
    grd.addColorStop(0, held ? '#4a4a4e' : '#2c2c2f'); grd.addColorStop(1, held ? '#333336' : '#1c1c1e');
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7);
    ctx.fillStyle = grd; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
    if (held) { ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.arc(cx, cy, r + 2.5, 0, 7); ctx.stroke(); }
    if (c.glyph) {
      const col = led ? css(led) : '#5c5c60';
      if (led) { ctx.save(); ctx.shadowColor = css(led); ctx.shadowBlur = 8; this._glyph(ctx, c.glyph, cx, cy, r * 0.95, col); ctx.restore(); }
      else this._glyph(ctx, c.glyph, cx, cy, r * 0.95, col);
    }
  }

  _knob(ctx, c, led, touched, pos) {
    const { cx, cy, r } = c;
    // LED arc
    ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0.75 * Math.PI, 2.25 * Math.PI);
    if (led) { ctx.save(); ctx.strokeStyle = css(led); ctx.shadowColor = css(led); ctx.shadowBlur = 8; ctx.stroke(); ctx.restore(); }
    else { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.stroke(); }
    // shadow + cap
    ctx.beginPath(); ctx.arc(cx, cy + 1.5, r, 0, 7); ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fill();
    const grd = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, r * 0.1, cx, cy, r);
    grd.addColorStop(0, touched ? '#3d4650' : '#2f2f32'); grd.addColorStop(1, touched ? '#1d242b' : '#141416');
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fillStyle = grd; ctx.fill();
    // knurling
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.stroke(); }
    ctx.restore();
    ctx.lineWidth = touched ? 1.5 : 1; ctx.strokeStyle = touched ? '#7fb2e0' : 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    // pointer notch
    const a = pos * (Math.PI / 16) - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r * 0.35, cy + Math.sin(a) * r * 0.35);
    ctx.lineTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#d6d6d6'; ctx.stroke();
  }

  draw(now = performance.now()) {
    const ctx = this.ctx, s = this.scale * this.dpr;
    this.animating = false;
    if (!this.chassis) this._drawChassis();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.chassis, 0, 0);
    ctx.setTransform(s, 0, 0, s, 0, 0);

    // OLED: blit snapped to device pixels, then a faint glow
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const ox = Math.round(OLED.x * s), oy = Math.round(OLED.y * s);
    ctx.drawImage(this.oled, ox, oy);
    if (this.oledOn) {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22;
      ctx.filter = `blur(${Math.max(1, s * 1.2).toFixed(1)}px)`;
      ctx.drawImage(this.oled, ox, oy);
    }
    ctx.restore();

    for (const c of this.controls) {
      const held = this.held.has(c.id);
      switch (c.kind) {
        case 'knob': {
          this._knob(ctx, c, this.ccColor(c.cc, false, now), held || this.held.has(c.id + ':touch'), this.knobPos.get(c.id) || 0);
          break;
        }
        case 'jog': {
          const touched = this.held.has(c.id + ':touch');
          this._knob(ctx, c, null, touched, this.knobPos.get(c.id) || 0);
          ctx.beginPath(); ctx.arc(c.cx, c.cy, c.r * 0.42, 0, 7);
          ctx.fillStyle = held ? '#4a4a4e' : '#1f1f22'; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.stroke();
          break;
        }
        case 'button': this._button(ctx, c, this.ccColor(c.cc, c.white, now), held); break;
        case 'track': {
          roundRect(ctx, c.x, c.y, c.w, c.h, 7);
          ctx.fillStyle = held ? '#4a4a4e' : '#1f1f22'; ctx.fill();
          ctx.lineWidth = held ? 1.5 : 1; ctx.strokeStyle = held ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.6)'; ctx.stroke();
          const led = this.ccColor(c.cc, false, now);
          roundRect(ctx, c.x + 6, c.y + c.h * 0.2, 4, c.h * 0.6, 2);
          if (led) { ctx.save(); ctx.fillStyle = css(led); ctx.shadowColor = css(led); ctx.shadowBlur = 8; ctx.fill(); ctx.restore(); }
          else { ctx.fillStyle = '#3a3a3e'; ctx.fill(); }
          break;
        }
        case 'pad': {
          const led = this.noteColor(c.note, now);
          roundRect(ctx, c.x, c.y, c.w, c.h, 5);
          if (led) {
            ctx.save(); ctx.shadowColor = css(led, 0.8); ctx.shadowBlur = 14; ctx.fillStyle = css(led); ctx.fill(); ctx.restore();
            const sheen = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
            sheen.addColorStop(0, 'rgba(255,255,255,0.18)'); sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
            roundRect(ctx, c.x, c.y, c.w, c.h, 5); ctx.fillStyle = sheen; ctx.fill();
          } else {
            const g = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
            g.addColorStop(0, '#2b2b2e'); g.addColorStop(1, '#232326');
            ctx.fillStyle = g; ctx.fill();
            ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
          }
          const h = this.held.get(c.id);
          if (h) {
            roundRect(ctx, c.x + 1.5, c.y + 1.5, c.w - 3, c.h - 3, 4);
            ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            if (h.at) ctx.fillRect(c.x + 6, c.y + c.h - 8, (c.w - 12) * (h.at / 127), 2.5);
            ctx.fillRect(c.x + 6 + (c.w - 12) * (h.vel / 127) - 1, c.y + c.h - 11, 2, 8);
          }
          break;
        }
        case 'step': {
          const led = this.noteColor(c.note, now);
          const x = c.cx - c.r, y = c.cy - c.r * 0.8, w = c.r * 2, hgt = c.r * 1.6;
          roundRect(ctx, x, y, w, hgt, 3);
          if (led) { ctx.save(); ctx.fillStyle = css(led); ctx.shadowColor = css(led); ctx.shadowBlur = 10; ctx.fill(); ctx.restore(); }
          else { ctx.fillStyle = '#1f1f22'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke(); }
          if (held) { roundRect(ctx, x - 2, y - 2, w + 4, hgt + 4, 4); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.stroke(); }
          const icon = this.ccColor(c.note, true, now);       // step icon LEDs: CC 16-31, white
          ctx.fillStyle = icon ? css(icon) : 'rgba(0,0,0,0.35)';
          ctx.fillRect(c.cx - 4, ICON_Y, 8, 2);
          break;
        }
      }
    }
  }

  /** Called every animation frame. Returns true if it redrew. */
  /** Poll the engine: bit 1 = new OLED frame (in oledBits), bit 2 = LEDs changed. */
  poll() {
    if (!this.src) return 0;
    let r = this._pollDisplay() ? 1 : 0;
    const ls = this.src.ledsSeq?.();
    if (ls !== undefined && ls !== this.lastLedSeq) { this.lastLedSeq = ls; r |= 2; }
    return r;
  }

  frame(now) {
    if (this.poll()) this.dirty = true;
    if (!this.dirty && !this.animating) return false;
    this.dirty = false;
    this.draw(now);
    return true;
  }
}
