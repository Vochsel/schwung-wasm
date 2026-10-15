/* move3d.js — a procedural Ableton Move.
 *
 * Adapted from compositions/flat/lib/move3d.js in ableton-move-demo-recorder
 * (https://github.com/Vochsel/ableton-move-demo-recorder, same author):
 *   Copyright the ableton-move-demo-recorder authors. Licensed under the Apache License, Version 2.0
 *   (http://www.apache.org/licenses/LICENSE-2.0). Distributed on an "AS IS"
 *   BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
 * Changes for schwung-wasm: every control is returned as an addressable part
 * (movable group + hit meshes + LED materials) so the page can drive LEDs from
 * the engine and press/turn controls; button icons light from an emissive mask;
 * encoders/jog carry a faint position mark; step icon LEDs added; the OLED is a
 * caller-supplied texture.
 *
 * Built from Ableton's official dimension drawing. Units are centimetres
 * (1 unit = 10 mm); x right, y up, z toward the player.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { toCreasedNormals } from "three/addons/utils/BufferGeometryUtils.js";

/* Official Ableton dimension drawing: top view spans px 56..1838 x 150..982
 * for 313.5 x 146.3 mm (0.1759 mm/px). Side view: a 13.5 mm slab on a 4.7 mm
 * base plate inset 5 mm, 14 mm encoders, 34 mm overall. */
const MM_PER_PX = 313.5 / (1838 - 56);
const CX = (56 + 1838) / 2, CY = (150 + 982) / 2;
const PX = (n) => (n * MM_PER_PX) / 10;                 // drawing px -> units
export const W = 31.35, D = 14.63;
export const BASE = 0.47, SLAB = 1.35, H = BASE + SLAB;
const TOP = H;
const P = (px, py) => [((px - CX) * MM_PER_PX) / 10, ((py - CY) * MM_PER_PX) / 10];
const COLS = [457, 608, 759, 909, 1060, 1211, 1361, 1512];

export const LAYOUT = {
  display: P(194, 256),
  encoders: COLS.map((x) => P(x, 233)),
  encoderLeds: COLS.map((x) => P(x, 299)),
  volume: P(1755, 244),
  mic: P(1630, 232),
  jog: P(189, 455),
  back: P(138, 628), menu: P(240, 628), play: P(138, 877), rec: P(240, 877),
  right: [[1653, 398, "capture"], [1755, 398, "sample"], [1653, 513, "loop"], [1755, 513, "mute"],
          [1653, 628, "delete"], [1755, 628, "copy"], [1653, 743, "undo"], [1755, 743, "more"]]
          .map(([x, y, icon]) => ({ p: P(x, y), icon })),
  tracks: [398, 513, 628, 743].map((y) => P(335, y)),
  padCols: COLS,
  padRows: [398, 513, 628, 743],
  steps: [420, 495, 570, 645, 720, 796, 871, 947, 1022, 1098, 1173, 1248, 1324, 1399, 1474, 1550].map((x) => P(x, 877)),
  small: [[1640, 877, "left"], [1770, 877, "right"], [1704, 842, "plus"], [1704, 912, "minus"]]
          .map(([x, y, icon]) => ({ p: P(x, y), icon })),
};
export const SIZES = {
  encoderR: PX(31.5), volumeR: PX(41.5), jogR: PX(74), knobH: 1.4, jogH: 0.83,
  padW: PX(128), padD: PX(92), buttonR: PX(38.5), smallR: PX(26), stepR: PX(26),
  oledW: 2.96, oledH: 1.48,
};

/* ---------- textures ---------- */
/* One icon drawn twice: a dim print on the cap (map) and a white mask that the
 * LED colour lights through (emissiveMap). */
function iconCanvas(kind, fg, bg) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = g.fillStyle = fg;
  g.lineWidth = 7; g.lineCap = "round"; g.lineJoin = "round";
  g.translate(128, 128); g.scale(1.6, 1.6); g.translate(-64, -64);
  const L = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); };
  switch (kind) {
    case "back": case "left": L([[70, 52], [58, 64], [70, 76]]); break;
    case "right": L([[58, 52], [70, 64], [58, 76]]); break;
    case "menu": L([[52, 54], [76, 54]]); L([[52, 64], [76, 64]]); L([[52, 74], [76, 74]]); break;
    case "play": L([[56, 51], [78, 64], [56, 77], [56, 51]]); break;
    case "rec": g.beginPath(); g.arc(64, 64, 12, 0, Math.PI * 2); g.stroke(); break;
    case "sample": g.beginPath(); g.arc(64, 64, 6, 0, Math.PI * 2); g.fill(); break;
    case "capture": L([[52, 59], [52, 52], [59, 52]]); L([[69, 52], [76, 52], [76, 59]]); L([[76, 69], [76, 76], [69, 76]]); L([[59, 76], [52, 76], [52, 69]]); break;
    case "loop": g.beginPath(); g.arc(64, 64, 12, Math.PI * 0.2, Math.PI * 1.8); g.stroke(); L([[73, 51], [76, 58], [69, 59]]); break;
    case "mute": g.font = "600 28px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("M", 64, 66); break;
    case "delete": L([[54, 54], [74, 74]]); L([[74, 54], [54, 74]]); break;
    case "copy": g.strokeRect(60, 60, 17, 17); L([[54, 71], [54, 54], [71, 54]]); break;
    case "undo": L([[58, 55], [52, 62], [58, 69]]); g.beginPath(); g.moveTo(52, 62); g.lineTo(70, 62); g.arc(70, 69, 7, -Math.PI / 2, Math.PI / 2); g.stroke(); break;
    case "more": [55, 64, 73].forEach((x) => { g.beginPath(); g.arc(x, 64, 3, 0, Math.PI * 2); g.fill(); }); break;
    case "plus": L([[64, 54], [64, 74]]); L([[54, 64], [74, 64]]); break;
    case "minus": L([[54, 64], [74, 64]]); break;
  }
  return c;
}
function canvasTex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.center.set(0.5, 0.5);
  t.rotation = Math.PI / 2;
  return t;
}

/* the frosted pad's light: bright in the middle, falling off to the edges */
function padGlowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 6, 64, 64, 80);
  r.addColorStop(0, "#ffffff");
  r.addColorStop(0.55, "#b4b4b4");
  r.addColorStop(1, "#505050");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* a slab with near-vertical sides and a small fillet */
function slab(w, d, h, r, bevel) {
  const s = new THREE.Shape();
  const x = -w / 2 + bevel, z = -d / 2 + bevel, ww = w - 2 * bevel, dd = d - 2 * bevel, rr = Math.max(0.01, r - bevel);
  s.moveTo(x + rr, z);
  s.lineTo(x + ww - rr, z); s.quadraticCurveTo(x + ww, z, x + ww, z + rr);
  s.lineTo(x + ww, z + dd - rr); s.quadraticCurveTo(x + ww, z + dd, x + ww - rr, z + dd);
  s.lineTo(x + rr, z + dd); s.quadraticCurveTo(x, z + dd, x, z + dd - rr);
  s.lineTo(x, z + rr); s.quadraticCurveTo(x, z, x + rr, z);
  const g = new THREE.ExtrudeGeometry(s, { depth: h - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 12, curveSegments: 40 });
  g.rotateX(-Math.PI / 2);          // extrude upward: shape y -> -z
  g.translate(0, bevel, 0);
  /* smooth across the bevel and round corners (keeps ExtrudeGeometry's groups:
   * 0 = top/bottom caps, 1 = sides + bevel) */
  return toCreasedNormals(g, Math.PI / 2.5);
}

/* ---------- builder ----------
 * Returns { root, glareTex, parts } where parts.* are
 *   { group, hit: Mesh[], ... } — `group` is what moves when pressed/turned,
 *   `hit` the meshes to raycast. LED handles:
 *     pads[i].mat (emissive), steps[i].led / .icon (MeshBasic colour),
 *     tracks[i].led, encoders[i].led, buttons[name].mat (emissive icon). */
export function buildMove(oledTex) {
  const root = new THREE.Group();

  /* a fine, even micro-texture: diffuse overall, with a little sheen on the peaks */
  const grain = (() => {
    const N = 256;
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d"), img = g.createImageData(N, N);
    let h = 0x9e3779b9;
    const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
    const n = new Float32Array(N * N);
    for (let i = 0; i < n.length; i++) n[i] = rnd();
    const M = N - 1;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {   // soften to a slightly rounded grain
      let v = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) v += n[((y + oy) & M) * N + ((x + ox) & M)];
      const k = Math.round((v / 9) * 255);
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = k; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3.2, 3.2);
    t.anisotropy = 8;
    return t;
  })();
  const body = new THREE.MeshPhysicalMaterial({
    color: 0x1d1e21, roughness: 0.58, roughnessMap: grain, metalness: 0,
    bumpMap: grain, bumpScale: 0.4,
    clearcoat: 0.22, clearcoatRoughness: 0.42,
    sheen: 0.2, sheenRoughness: 0.7, sheenColor: 0x3a3d44,
  });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x141517, roughness: 0.62, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.5 });
  const ledMat = (c) => new THREE.MeshBasicMaterial({ color: c, toneMapped: false });
  const LED_OFF = 0x0b0b0c;

  /* caps flat-shaded so the long cap triangles never pick up the bevel's normals */
  const bodyCap = body.clone(); bodyCap.flatShading = true;
  const slabMesh = new THREE.Mesh(slab(W, D, SLAB, PX(15), 0.07), [bodyCap, body]);   // near-rectangular: ~2.6 mm corners, tight bevel
  slabMesh.position.y = BASE;
  slabMesh.castShadow = true; slabMesh.receiveShadow = true;
  root.add(slabMesh);
  const plate = new THREE.Mesh(slab(W - 1.0, D - 1.0, BASE, PX(15), 0.05),
    new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.8 }));
  plate.castShadow = true;
  root.add(plate);

  /* display: a recessed black glass window, the OLED behind it, glare on top */
  const [dx, dz] = LAYOUT.display;
  const well = new THREE.Mesh(new RoundedBoxGeometry(PX(192), 0.04, PX(98), 2, 0.015), new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.9 }));
  well.position.set(dx, TOP - 0.01, dz);
  root.add(well);
  const oled = new THREE.Mesh(new THREE.PlaneGeometry(SIZES.oledW, SIZES.oledH), new THREE.MeshBasicMaterial({ map: oledTex, toneMapped: false }));
  oled.rotation.x = -Math.PI / 2;
  oled.position.set(dx, TOP + 0.014, dz);
  root.add(oled);
  /* glass glare: a soft diagonal band of reflected light, added over the OLED.
   * The caller slides glareTex.offset.x with the camera. */
  const gc = document.createElement("canvas");
  gc.width = 1024; gc.height = 256;
  const gg = gc.getContext("2d");
  gg.fillStyle = "#000"; gg.fillRect(0, 0, 1024, 256);
  const band = gg.createLinearGradient(0, 0, 1024, 0);
  band.addColorStop(0.0, "rgba(255,255,255,0)");
  band.addColorStop(0.40, "rgba(255,255,255,0)");
  band.addColorStop(0.47, "rgba(255,255,255,0.06)");
  band.addColorStop(0.50, "rgba(255,255,255,0.13)");
  band.addColorStop(0.535, "rgba(255,255,255,0.05)");
  band.addColorStop(0.58, "rgba(255,255,255,0.02)");
  band.addColorStop(0.66, "rgba(255,255,255,0)");
  gg.save(); gg.translate(512, 128); gg.transform(1, 0, -0.55, 1, 0, 0); gg.translate(-512, -128);
  gg.fillStyle = band; gg.fillRect(-400, 0, 1824, 256); gg.restore();
  const glareTex = new THREE.CanvasTexture(gc);
  glareTex.colorSpace = THREE.SRGBColorSpace;
  glareTex.wrapS = THREE.ClampToEdgeWrapping;
  const glare = new THREE.Mesh(new THREE.PlaneGeometry(PX(186), PX(92)), new THREE.MeshBasicMaterial({
    map: glareTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
  glare.rotation.x = -Math.PI / 2;
  glare.position.set(dx, TOP + 0.03, dz);
  root.add(glare);

  /* encoders: tall, slim, plain — with a faint mark so turning shows */
  const markMat = new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.5 });
  function knob(r, h, x, z, mark = true) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.965, r, h - 0.06, 64), black);   // a slight taper, per the side view
    m.position.y = (h - 0.06) / 2;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.965 - 0.04, r * 0.965, 0.06, 64), black);
    cap.position.y = h - 0.03;
    m.castShadow = true; cap.castShadow = true;
    g.add(m, cap);
    if (mark) {
      const len = r * 0.55;
      const mk = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.012, len), markMat);
      mk.position.set(0, h + 0.004, -(r * 0.9 - 0.04 - len / 2));
      g.add(mk);
    }
    g.position.set(x, TOP, z);
    root.add(g);
    return { group: g, hit: [m, cap], r, h };
  }
  const encoders = LAYOUT.encoders.map(([x, z], i) => {
    const k = knob(SIZES.encoderR, SIZES.knobH, x, z);
    const [lx, lz] = LAYOUT.encoderLeds[i];
    const led = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), ledMat(LED_OFF));
    led.rotation.x = -Math.PI / 2; led.position.set(lx, TOP + 0.003, lz); root.add(led);
    k.led = led.material;
    return k;
  });
  const volume = knob(SIZES.volumeR, SIZES.knobH, ...LAYOUT.volume);
  const jog = knob(SIZES.jogR, SIZES.jogH, ...LAYOUT.jog, false);
  { /* a shallow dimple on the jog, off-centre, to show its rotation */
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.11, 24), markMat);
    d.rotation.x = -Math.PI / 2; d.position.set(0, SIZES.jogH + 0.003, -SIZES.jogR * 0.62);
    jog.group.add(d);
  }
  const mic = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  mic.rotation.x = -Math.PI / 2; mic.position.set(LAYOUT.mic[0], TOP + 0.003, LAYOUT.mic[1]); root.add(mic);

  /* round buttons: low black domes with a printed icon that the LED lights */
  const iconCache = {};
  const buttons = {};
  function button(r, x, z, icon, h = 0.22) {
    const tex = iconCache[icon] || (iconCache[icon] = {
      map: canvasTex(iconCanvas(icon, "#9a9da2", "#151618")),
      mask: canvasTex(iconCanvas(icon, "#ffffff", "#000000")),
    });
    const top = new THREE.MeshStandardMaterial({ map: tex.map, emissiveMap: tex.mask, emissive: 0x000000, emissiveIntensity: 1, roughness: 0.6 });
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.97, r, h, 48), [black, top, black]);
    m.position.y = h / 2;
    m.castShadow = true;
    const g = new THREE.Group();
    g.position.set(x, TOP, z);
    g.add(m); root.add(g);
    buttons[icon] = { group: g, hit: [m], mat: top };
  }
  const BR = SIZES.buttonR, SR = SIZES.smallR;
  button(BR, ...LAYOUT.back, "back");
  button(BR, ...LAYOUT.menu, "menu");
  button(BR, ...LAYOUT.play, "play");
  button(BR, ...LAYOUT.rec, "rec");
  LAYOUT.right.forEach(({ p, icon }) => button(BR, p[0], p[1], icon));
  LAYOUT.small.forEach(({ p, icon }) => button(SR, p[0], p[1], icon, 0.16));

  /* track buttons: a black pill with a thin LED line */
  const pillGeo = new RoundedBoxGeometry(PX(44), 0.22, PX(96), 6, PX(21));
  const lineGeo = new RoundedBoxGeometry(0.1, 0.04, PX(62), 3, 0.045);
  const tracks = LAYOUT.tracks.map(([x, z]) => {
    const g = new THREE.Group();
    g.position.set(x, TOP, z);
    const pill = new THREE.Mesh(pillGeo, black);
    pill.position.y = 0.11; pill.castShadow = true;
    const line = new THREE.Mesh(lineGeo, ledMat(LED_OFF));
    line.position.y = 0.225;
    g.add(pill, line); root.add(g);
    return { group: g, hit: [pill, line], led: line.material };
  });

  /* pads: frosted silicone, lit from below */
  const padGeo = new RoundedBoxGeometry(SIZES.padW, 0.16, SIZES.padD, 2, 0.025);   // near-square corners
  const glowTex = padGlowTexture();
  const pads = [];
  LAYOUT.padRows.forEach((py, r) => LAYOUT.padCols.forEach((px, c) => {
    const [x, z] = P(px, py);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x2b2c30, roughness: 0.7, metalness: 0, sheen: 0.3, sheenRoughness: 0.5, sheenColor: 0xffffff,
      emissive: new THREE.Color(0x000000), emissiveMap: glowTex, emissiveIntensity: 1.0,
    });
    const m = new THREE.Mesh(padGeo, mat);
    m.position.y = 0.06;
    m.receiveShadow = true;
    const g = new THREE.Group();
    g.position.set(x, TOP, z);
    g.add(m); root.add(g);
    pads.push({ group: g, hit: [m], mat, r, c, x, z });
  }));

  /* step buttons with an LED dot, and a small icon LED above each */
  const stepGeo = new THREE.CylinderGeometry(PX(25), PX(26), 0.17, 40);
  const dotGeo = new THREE.CircleGeometry(0.07, 16);
  const iconGeo = new THREE.PlaneGeometry(0.2, 0.035);
  const steps = LAYOUT.steps.map(([x, z]) => {
    const g = new THREE.Group();
    g.position.set(x, TOP, z);
    const m = new THREE.Mesh(stepGeo, black);
    m.position.y = 0.085; m.castShadow = true;
    const led = new THREE.Mesh(dotGeo, ledMat(LED_OFF));
    led.rotation.x = -Math.PI / 2; led.position.y = 0.172;
    g.add(m, led); root.add(g);
    const icon = new THREE.Mesh(iconGeo, ledMat(LED_OFF));
    icon.rotation.x = -Math.PI / 2; icon.position.set(x, TOP + 0.003, z - PX(26) - 0.18); root.add(icon);
    return { group: g, hit: [m, led], led: led.material, icon: icon.material };
  });

  return { root, glareTex, oled, parts: { encoders, volume, jog, buttons, tracks, pads, steps } };
}
