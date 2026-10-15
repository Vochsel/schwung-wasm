// 3D view of the virtual Move: the procedural model from web/move3d/move3d.js
// (Apache-2.0, from ableton-move-demo-recorder), lit like that repo's move3d
// composition (room environment, key/rim/spot lights, PCF shadows, GTAO,
// restrained bloom on LEDs, glare on the display glass).
//
// It owns no MIDI or LED logic of its own: presses, turns, touches and LED
// colours all go through the shared Panel instance (web/panel.js), so the 2D
// and 3D views send identical MIDI and show identical LEDs.
//
// Rendering is on demand: a frame is drawn only when the OLED or LEDs change,
// an LED is animating, a control moves, or the camera moves.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildMove, LAYOUT, SIZES, W as MW, D as MD, H as MH } from './move3d/move3d.js';
import { padVelocity, knobDragTicks, jogDragTicks, wheelTicks } from './panel.js';

const BUTTON_IDS = {
  back: 'btn-back', menu: 'btn-menu', play: 'btn-play', rec: 'btn-rec', capture: 'btn-capture',
  sample: 'btn-sample', loop: 'btn-loop', mute: 'btn-mute', delete: 'btn-delete', copy: 'btn-copy',
  undo: 'btn-undo', more: 'btn-shift', left: 'btn-left', right: 'btn-right', plus: 'btn-up', minus: 'btn-down',
};
const PRESS_DEPTH = { pad: 0.05, button: 0.07, track: 0.07, step: 0.06, jog: 0.05 };
const KNOB_RAD_PER_TICK = Math.PI / 32;
const JOG_RAD_PER_TICK = Math.PI / 12;           // one detent per 15 degrees, as the drag
const LED_OFF = [11, 11, 12];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class View3D {
  /**
   * @param {HTMLElement} host  element the canvas fills
   * @param {import('./panel.js').Panel} panel  shared control/LED/MIDI state
   * @param {{ onHover?: Function }} opts
   */
  constructor(host, panel, opts = {}) {
    this.host = host;
    this.panel = panel;
    this.onHover = opts.onHover || (() => {});
    this.active = false;
    this.dirty = true;
    this.shadowDirty = true;
    this.ledAnimating = false;
    this.lastRev = -1;
    this.lastDisplaySeq = -1;

    const q = new URLSearchParams(location.search);
    this.quality = { ao: q.get('ao') !== '0', bloom: q.get('bloom') !== '0' };

    /* ---------- renderer ---------- */
    const canvas = this.canvas = document.createElement('canvas');
    canvas.className = 'gl';
    canvas.setAttribute('aria-label', 'Virtual Ableton Move (3D)');
    host.prepend(canvas);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;              // only when something moves

    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0c0e);
    const pmrem = new THREE.PMREMGenerator(r);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    /* ---------- OLED: 128x64 RGBA, rows flipped (texture v=0 is the near edge) ---------- */
    this.oledData = new Uint8Array(128 * 64 * 4);
    this.oledPrev = new Uint8Array(1024);
    const ot = this.oledTex = new THREE.DataTexture(this.oledData, 128, 64, THREE.RGBAFormat);
    ot.colorSpace = THREE.SRGBColorSpace;
    ot.magFilter = THREE.NearestFilter;
    ot.minFilter = THREE.LinearFilter;           // minified on small screens: average rather than drop strokes
    ot.generateMipmaps = false;
    this._clearOled();

    /* ---------- the device ---------- */
    const move = this.move = buildMove(ot);
    scene.add(move.root);
    this._indexParts();

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    scene.add(new THREE.HemisphereLight(0xc9d6ff, 0x1a1410, 0.4));
    const key = new THREE.DirectionalLight(0xfff3e6, 2.2);
    key.position.set(-14, 26, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -20; key.shadow.camera.right = 20;
    key.shadow.camera.top = 14; key.shadow.camera.bottom = -14;
    key.shadow.radius = 4; key.shadow.bias = -0.0004;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb8ff, 1.3);
    rim.position.set(18, 10, -22);
    scene.add(rim);
    const spot = new THREE.SpotLight(0xffffff, 100, 80, 0.5, 0.8);
    spot.position.set(0, 30, 6);
    spot.target.position.set(0, 0, 0);
    scene.add(spot, spot.target);

    /* ---------- camera ---------- */
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
    this.orbit = { target: new THREE.Vector3(0, MH, 0.4), radius: 40, phi: 0.72, theta: 0 };
    this.fitRadius = 40;

    /* ---------- post ---------- */
    const rt = new THREE.WebGLRenderTarget(4, 4, { samples: 4, type: THREE.HalfFloatType });
    const composer = this.composer = new EffectComposer(r, rt);
    composer.addPass(new RenderPass(scene, this.camera));
    if (this.quality.ao) {
      const ao = this.ao = new GTAOPass(scene, this.camera, 4, 4);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.7;
      ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
      ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      composer.addPass(ao);
    }
    if (this.quality.bloom) {
      // Restrained: only the bright LED cores (above ~0.9 linear) bloom, softly.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.18, 0.25, 0.9);
      composer.addPass(this.bloom);
    }
    composer.addPass(new OutputPass());

    /* ---------- scratch (no per-frame allocation) ---------- */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._ndc = new THREE.Vector2();
    this._ray = new THREE.Raycaster();
    this._hits = [];
    this._box = new THREE.Box3(new THREE.Vector3(-MW / 2, 0, -MD / 2), new THREE.Vector3(MW / 2, MH + SIZES.knobH, MD / 2));
    this._corners = Array.from({ length: 8 }, () => new THREE.Vector3());

    this.pointers = new Map();      // pointerId -> control drag state
    this.camPointers = new Map();   // pointerId -> {x, y, button}
    this._bindInput();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(host);
  }

  /* ---------------- parts <-> panel controls ---------------- */
  _indexParts() {
    const P = this.move.parts, byId = this.parts = new Map(), hitList = this.hitList = [];
    const add = (id, part, kind) => {
      const c = this.panel.byId.get(id);
      if (!c) throw new Error('view3d: no panel control ' + id);
      part.id = id; part.c = c; part.kind = kind; part.baseY = part.group.position.y;
      byId.set(id, part);
      for (const m of part.hit) { m.userData.part = part; hitList.push(m); }
    };
    P.encoders.forEach((p, i) => add('knob-' + (i + 1), p, 'knob'));
    add('master', P.volume, 'knob');
    add('jog', P.jog, 'jog');
    for (const [icon, p] of Object.entries(P.buttons)) add(BUTTON_IDS[icon], p, 'button');
    P.tracks.forEach((p, i) => add('track-' + (i + 1), p, 'track'));
    P.pads.forEach((p) => add('pad-' + (68 + (3 - p.r) * 8 + p.c), p, 'pad'));
    P.steps.forEach((p, i) => add('step-' + (i + 1), p, 'step'));
    this.partList = [...byId.values()];
  }

  /* ---------------- lifecycle ---------------- */
  setActive(on) {
    this.active = on;
    this.host.classList.toggle('on', on);
    if (on) {
      this.lastRev = -1; this.lastDisplaySeq = -1;
      this.resize();
      this._syncOled(true);
      this._updateLeds(performance.now());
      this.dirty = true;
    } else {
      this.onHover(null);
      this._releaseAll();
    }
  }

  resize() {
    if (!this.active) return;
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === this._w && h === this._h && dpr === this._dpr) return;
    const first = this._w === undefined;
    this._w = w; this._h = h; this._dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const prevFit = this.fitRadius;
    this.fitRadius = this._fit(this.orbit.phi, this.orbit.theta);
    if (first) this.resetView(); else { this.orbit.radius *= this.fitRadius / prevFit; this._applyCamera(); }
    this.dirty = true;
  }

  /* ---------------- camera ---------------- */
  static DEFAULT = { phi: 0.66, theta: -0.1 };
  resetView() { this._setView(View3D.DEFAULT.phi, View3D.DEFAULT.theta); }
  topView() { this._setView(0.0001, 0); }
  _setView(phi, theta) {
    const o = this.orbit;
    o.phi = phi; o.theta = theta;
    o.target.set(0, MH + 0.3, 0);
    o.radius = this._fit(phi, theta);
    this.fitRadius = o.radius;
    this._applyCamera();
  }
  // Smallest camera distance at which the whole device fits with a margin.
  _fit(phi, theta) {
    const o = this.orbit, cam = this.camera, b = this._box;
    const saved = o.radius, savedT = o.target.clone(), sp = o.phi, st = o.theta;
    o.phi = phi; o.theta = theta; o.target.set(0, MH + 0.3, 0);
    let lo = 5, hi = 200;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      o.radius = mid; this._placeCamera();
      let fits = true;
      for (let k = 0; k < 8 && fits; k++) {
        const v = this._corners[k].set(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).project(cam);
        if (Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.92) fits = false;
      }
      if (fits) hi = mid; else lo = mid;
    }
    o.radius = saved; o.target.copy(savedT); o.phi = sp; o.theta = st;
    this._placeCamera();
    return hi;
  }
  _placeCamera() {
    const o = this.orbit, cam = this.camera;
    cam.position.setFromSphericalCoords(o.radius, o.phi, o.theta).add(o.target);
    // Looking straight down: keep the device's front edge at the bottom of the screen.
    cam.up.set(0, 1, 0);
    if (o.phi < 0.02) cam.up.set(Math.sin(o.theta) * -1, 0, -Math.cos(o.theta));
    cam.lookAt(o.target);
    cam.updateMatrixWorld();
  }
  _applyCamera() {
    const o = this.orbit;
    o.phi = clamp(o.phi, 0.0001, 1.35);
    o.theta = clamp(o.theta, -1.4, 1.4);
    o.radius = clamp(o.radius, 6, Math.max(60, this.fitRadius * 2.5));
    o.target.x = clamp(o.target.x, -MW / 2, MW / 2);
    o.target.z = clamp(o.target.z, -MD / 2, MD / 2);
    o.target.y = MH + 0.3;
    this._placeCamera();
    // The glare band slides across the glass with the camera's sideways position.
    const [dx, dz] = LAYOUT.display, p = this.camera.position;
    this.move.glareTex.offset.x = clamp((p.x - dx) * 0.05 + (p.z - dz) * 0.01 - 0.1, -0.7, 0.7);
    this.dirty = true;
  }
  _orbitBy(dx, dy) {
    this.orbit.theta -= dx * 0.006;
    this.orbit.phi -= dy * 0.006;
    this._applyCamera();
  }
  _panBy(dx, dy) {
    const o = this.orbit, cam = this.camera;
    const k = o.radius * Math.tan((cam.fov * Math.PI) / 360) * 2 / this._h;
    const right = this._v.setFromMatrixColumn(cam.matrixWorld, 0); right.y = 0; right.normalize();
    const fwd = this._v2.set(-Math.sin(o.theta), 0, -Math.cos(o.theta));
    o.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k / Math.max(0.35, Math.cos(o.phi)));
    this._applyCamera();
  }
  _zoomBy(f) { this.orbit.radius *= f; this._applyCamera(); }

  /* ---------------- OLED ---------------- */
  _clearOled() {
    const d = this.oledData;
    for (let i = 0; i < d.length; i += 4) { d[i] = 2; d[i + 1] = 3; d[i + 2] = 4; d[i + 3] = 255; }
    this.oledTex.needsUpdate = true;
  }
  _syncOled(force) {
    const p = this.panel;
    if (!p.oledOn) return;
    if (!force && p.lastDisplaySeq === this.lastDisplaySeq) return;
    this.lastDisplaySeq = p.lastDisplaySeq;
    const bits = p.oledBits, prev = this.oledPrev, d = this.oledData;
    // The engine bumps the sequence on every flush; skip identical frames.
    let same = !force;
    for (let i = 0; same && i < 1024; i++) if (bits[i] !== prev[i]) same = false;
    if (same) return;
    prev.set(bits);
    for (let page = 0; page < 8; page++) for (let x = 0; x < 128; x++) {
      const b = bits[page * 128 + x];
      for (let j = 0; j < 8; j++) {
        const o = ((63 - (page * 8 + j)) * 128 + x) * 4;
        if (b & (1 << j)) { d[o] = 236; d[o + 1] = 242; d[o + 2] = 252; }
        else { d[o] = 2; d[o + 1] = 3; d[o + 2] = 4; }
      }
    }
    this.oledTex.needsUpdate = true;
    this.dirty = true;
  }

  /* ---------------- LEDs (palette + animation from Panel) ---------------- */
  _updateLeds(now) {
    const p = this.panel;
    p.animating = false;
    const pads = this.move.parts.pads;
    for (let i = 0; i < pads.length; i++) {
      const part = pads[i], rgb = p.noteColor(part.c.note, now);
      if (rgb) part.mat.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      else part.mat.emissive.setRGB(0, 0, 0);
    }
    for (const part of this.move.parts.steps) {
      setLed(part.led, p.noteColor(part.c.note, now), 1.3);
      setLed(part.icon, p.ccColor(part.c.note, true, now), 1.1);   // step icon LEDs: CC 16-31, white
    }
    for (const part of this.move.parts.tracks) setLed(part.led, p.ccColor(part.c.cc, false, now), 1.5);
    for (const part of this.move.parts.encoders) setLed(part.led, p.ccColor(part.c.cc, false, now), 1.4);
    for (const icon in this.move.parts.buttons) {
      const part = this.move.parts.buttons[icon], rgb = p.ccColor(part.c.cc, part.c.white, now);
      if (rgb) part.mat.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      else part.mat.emissive.setRGB(0, 0, 0);
    }
    this.ledAnimating = p.animating;
    this.dirty = true;
  }

  /* ---------------- press / turn visuals ---------------- */
  _syncControls() {
    const p = this.panel;
    for (const part of this.partList) {
      const id = part.id;
      if (part.kind === 'knob' || part.kind === 'jog') {
        const rot = -(p.knobPos.get(id) || 0) * (part.kind === 'jog' ? JOG_RAD_PER_TICK : KNOB_RAD_PER_TICK);
        if (part.group.rotation.y !== rot) part.group.rotation.y = rot;
      }
      const depth = PRESS_DEPTH[part.kind];
      if (depth) {
        const y = part.baseY - (p.held.has(id) ? depth : 0);
        if (part.group.position.y !== y) { part.group.position.y = y; this.shadowDirty = true; }
      }
    }
    this.dirty = true;
  }

  /** Called every animation frame while active. Returns true if it rendered. */
  frame(now) {
    if (!this.active) return false;
    const f = this.panel.poll();
    if (f & 1) this._syncOled(false);
    if ((f & 2) || this.ledAnimating) this._updateLeds(now);
    if (this.panel.rev !== this.lastRev) { this.lastRev = this.panel.rev; this._syncControls(); }
    if (!this.dirty) return false;
    this.dirty = false;
    if (this.shadowDirty) { this.renderer.shadowMap.needsUpdate = true; this.shadowDirty = false; }
    this.composer.render();
    this.frames = (this.frames || 0) + 1;
    return true;
  }

  /* ---------------- picking ---------------- */
  _pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this.camera);
    this._hits.length = 0;
    this._ray.intersectObjects(this.hitList, false, this._hits);
    return this._hits.length ? this._hits[0] : null;
  }
  /** Screen position (client px) of a world point. */
  _toClient(v) {
    const rect = this.canvas.getBoundingClientRect();
    v.project(this.camera);
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height };
  }
  /** Centre of a control's top face in client px (tests, tooltips). */
  clientCenter(id) {
    const part = this.parts.get(id); if (!part) return null;
    const v = this._v; part.group.getWorldPosition(v);
    v.y += part.h || (part.kind === 'pad' ? 0.14 : 0.2);
    return this._toClient(v);
  }
  /** Client position of a point on a knob's top face at `dx` units right of centre (tests). */
  clientOn(id, dx = 0, dz = 0) {
    const part = this.parts.get(id); if (!part) return null;
    const v = this._v; part.group.getWorldPosition(v);
    v.x += dx; v.z += dz; v.y += part.h || 0.2;
    return this._toClient(v);
  }

  _bindInput() {
    const cv = this.canvas;
    cv.style.touchAction = 'none';
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => this._down(e));
    cv.addEventListener('pointermove', (e) => this._move(e));
    cv.addEventListener('pointerup', (e) => this._up(e));
    cv.addEventListener('pointercancel', (e) => this._up(e));
    cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.onHover(null); });
    cv.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    cv.addEventListener('dblclick', (e) => { if (!this._pick(e)) this.resetView(); });
  }

  _down(e) {
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    this.onHover(null);
    // Left button / touch / pen on a control interacts with it; everything else drives the camera.
    const hit = e.button === 0 && this.camPointers.size === 0 ? this._pick(e) : null;
    if (!hit) {
      this.camPointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.altKey });
      this._pinch = null;
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const part = hit.object.userData.part, c = part.c, p = this.panel;
    const st = { part, c, lastY: e.clientY, acc: 0, angle: null, click: false };
    this.pointers.set(e.pointerId, st);
    switch (part.kind) {
      case 'pad': {
        // fraction from the far (top) edge, as the 2D panel measures from the top
        const frac = (hit.point.z - (part.z - SIZES.padD / 2)) / SIZES.padD;
        p.press(c.id, true, padVelocity(e, frac));
        break;
      }
      case 'knob': p.press(c.id, true); break;
      case 'jog': {
        p.touch(c.id, true);
        part.group.getWorldPosition(this._v);
        const d = Math.hypot(hit.point.x - this._v.x, hit.point.z - this._v.z);
        if (d < part.r * 0.45) { st.click = true; p.press(c.id, true); }
        else st.angle = this._jogAngle(part, e);
        break;
      }
      default: p.press(c.id, true);
    }
  }
  // Pointer angle around the jog's projected centre (screen space, y down) and
  // its distance from the centre as a fraction of the projected radius.
  _jogAngle(part, e) {
    const v = this._v; part.group.getWorldPosition(v); v.y += part.h;
    const c = this._toClient(v);
    const v2 = this._v2; part.group.getWorldPosition(v2); v2.y += part.h; v2.x += part.r;
    const edge = this._toClient(v2);
    const rpx = Math.hypot(edge.x - c.x, edge.y - c.y) || 1;
    this._jogFrac = Math.hypot(e.clientX - c.x, e.clientY - c.y) / rpx;
    return Math.atan2(e.clientY - c.y, e.clientX - c.x);
  }

  _move(e) {
    const st = this.pointers.get(e.pointerId);
    if (st) {
      const p = this.panel, c = st.c;
      if (st.part.kind === 'knob') {
        const dy = st.lastY - e.clientY; st.lastY = e.clientY;
        const ticks = knobDragTicks(st, dy, e.shiftKey);
        if (ticks) p.turn(c.id, ticks);
      } else if (st.part.kind === 'jog' && !st.click) {
        const a = this._jogAngle(st.part, e);
        if (this._jogFrac < 0.3) { st.angle = null; return; }
        const ticks = jogDragTicks(st, a);
        if (ticks) p.turn(c.id, ticks);
      } else if (st.part.kind === 'pad' && e.pointerType !== 'mouse' && e.pressure > 0) {
        p.aftertouch(c.id, e.pressure * 127);
      }
      return;
    }
    const cp = this.camPointers.get(e.pointerId);
    if (cp) {
      const dx = e.clientX - cp.x, dy = e.clientY - cp.y;
      cp.x = e.clientX; cp.y = e.clientY;
      if (this.camPointers.size >= 2) {
        // two fingers: pinch to zoom, move together to pan
        const [a, b] = this.camPointers.values();
        const dist = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (this._pinch) {
          if (dist > 0 && this._pinch.dist > 0) this.orbit.radius *= this._pinch.dist / dist;
          this._panBy(mx - this._pinch.mx, my - this._pinch.my);
        }
        this._pinch = { dist, mx, my };
      } else if (cp.pan || e.buttons & 2 || e.buttons & 4) this._panBy(dx, dy);
      else this._orbitBy(dx, dy);
      return;
    }
    if (e.pointerType === 'mouse') {
      const hit = this._pick(e), part = hit?.object.userData.part;
      this.canvas.style.cursor = part ? (part.kind === 'knob' ? 'ns-resize' : part.kind === 'jog' ? 'grab' : 'pointer') : 'default';
      this.onHover(part ? part.c : null, e.clientX, e.clientY);
    }
  }

  _up(e) {
    const st = this.pointers.get(e.pointerId);
    if (st) {
      this.pointers.delete(e.pointerId);
      const p = this.panel, c = st.c;
      if (st.part.kind === 'jog') { if (st.click) p.press(c.id, false); p.touch(c.id, false); }
      else p.press(c.id, false);
      return;
    }
    if (this.camPointers.delete(e.pointerId)) {
      this._pinch = null;
      if (!this.camPointers.size) this.canvas.style.cursor = 'default';
    }
  }

  _releaseAll() {
    for (const [id, st] of this.pointers) {
      const p = this.panel, c = st.c;
      if (st.part.kind === 'jog') { if (st.click) p.press(c.id, false); p.touch(c.id, false); }
      else p.press(c.id, false);
      this.pointers.delete(id);
    }
    this.camPointers.clear();
  }

  _wheel(e) {
    e.preventDefault();
    const hit = this._pick(e), part = hit?.object.userData.part;
    if (part && (part.kind === 'knob' || part.kind === 'jog')) { this.panel.nudge(part.id, wheelTicks(e)); return; }
    if (e.ctrlKey) this._zoomBy(Math.exp(e.deltaY * 0.01));            // trackpad pinch
    else this._zoomBy(Math.exp(clamp(e.deltaY, -200, 200) * (e.deltaMode ? 0.05 : 0.0015)));
  }
}

function setLed(mat, rgb, gain) {
  const c = rgb || LED_OFF, k = rgb ? gain : 1;
  mat.color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace).multiplyScalar(k);
}
