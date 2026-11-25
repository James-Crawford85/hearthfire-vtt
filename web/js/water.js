// Water: oceans, lakes and rivers painted freely onto a sketch (the ground level only), over the
// painted ground and under the floors (so docks and bridges stand on it).
//
// scene.sketch.water:
//   bodies  { "1"…"8": { kind, water, shore, underlay, shore_width, depth, clarity } }
//           kind "ocean" (waves rolling in, foam along the shore), "lake" (still) or "river"
//           (running the way it was painted)
//   chunks  { "col,row": { body: amounts } }   as terrain's (terrain.js): a point is one body's
//   flow    { "col,row": vectors }   which way rivers run: FR × FR points a square, two signed
//           bytes each (x, y), stored like amounts
//   animate bool   waves and currents move (for players with animated maps on)
//
// Every chunk with water, and those round it (its shore reaches into them), is drawn into
// canvases from how far each point is from the water's edge:
//   base  the shore, the underlay showing through the shallows, the water itself, darker
//         with depth
//   fx    what moves: foam and waves rolling in, glints, streaks running downstream; FRAMES
//         frames of it, cross-faded one into the next when animated (one when still)

import { CHUNK, RES, N, chunkKey, chunkOf, chunksFor, sync, padded, valueNoise, encodeAmounts, decodeAmounts, beginStroke } from './terrain.js';

export const MAX_BODIES = 8;
export const KINDS = ['ocean', 'lake', 'river'];
// A new body's look, by kind.
export const PRESETS = {
  ocean: { water: 'water', shore: 'sand', underlay: 'sand', shore_width: 1.5, depth: 5, clarity: 0.5 },
  lake: { water: 'water', shore: 'dirt', underlay: 'dirt', shore_width: 0.5, depth: 3, clarity: 0.4 },
  river: { water: 'water', shore: 'dirt', underlay: 'dirt', shore_width: 0.4, depth: 1.5, clarity: 0.6 },
};

const REACH_SQ = 6; // how far (squares) the drawing of a chunk looks round it: shores, depth
const PADW = REACH_SQ * RES;
const P = N + 2 * PADW;
const FR = 2; // flow: points a square
const FN = CHUNK * FR;
const FPAD = REACH_SQ * FR;
const FP = FN + 2 * FPAD;
const MASK_PX = 24; // the base's masks: pixels a square
const BASE_PX = 80; // a chunk's base is drawn at most this many pixels a square
const FX_STILL = 32, FX_MOVING = 24; // and its moving part
const FRAMES = 8;
const PERIOD = 4000; // ms for the frames to come round
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ flow, as the client has it

// scene id → Map(chunk key → { src, v: Int8Array(FN * FN * 2), live, rev, reading })
const flows = new Map();
let redraw = () => {};

function flowsFor(sceneId) {
  let m = flows.get(sceneId);
  if (!m) flows.set(sceneId, (m = new Map()));
  return m;
}

function syncFlow(sceneId, stored = {}) {
  const m = flowsFor(sceneId);
  for (const [k, f] of m) if (!(k in stored) && !f.live) { m.delete(k); }
  for (const [k, v] of Object.entries(stored)) {
    let f = m.get(k);
    if (!f) m.set(k, (f = { src: null, v: new Int8Array(FN * FN * 2), live: false, rev: 0, reading: 0 }));
    if (f.live || f.src === v) continue;
    f.src = v;
    const ticket = ++f.reading;
    decodeAmounts(v, FN * FN * 2).then((b) => {
      if (f.reading !== ticket || f.live || !b) return;
      f.v = new Int8Array(b.buffer, b.byteOffset, b.length);
      f.rev++;
      redraw();
    });
  }
}

/**
 * Paint water: a stroke of body `body` (null erases), recording which way it went where `flowing`
 * (rivers). end() → { chunks, flow, used } (merge patches; null if nothing changed).
 */
export function beginWaterStroke(sceneId, body, { size, flowing, bounds = null }) {
  const fm = flowsFor(sceneId);
  const touched = new Map(); // flow chunk key → { f, before }
  let last = null;
  const onDab = (x, y, r) => {
    if (!body || !flowing) return;
    const was = last;
    last = { x, y };
    if (!was) return;
    const dx = x - was.x, dy = y - was.y, len = Math.hypot(dx, dy);
    if (len < 1e-3) { last = was; return; }
    const ux = dx / len, uy = dy / len;
    const R = Math.max(0.5, r) * FR;
    const px = x * FR - 0.5, py = y * FR - 0.5;
    for (let gy = Math.floor(py - R); gy <= Math.ceil(py + R); gy++) {
      for (let gx = Math.floor(px - R); gx <= Math.ceil(px + R); gx++) {
        if (gx < 0 || gy < 0) continue;
        if (bounds && (gx >= Math.ceil(bounds.cols / CHUNK) * FN || gy >= Math.ceil(bounds.rows / CHUNK) * FN)) continue;
        const d = Math.hypot(gx - px, gy - py);
        if (d >= R) continue;
        const k = chunkKey(Math.floor(gx / FN), Math.floor(gy / FN));
        let t = touched.get(k);
        if (!t) {
          let f = fm.get(k);
          if (!f) fm.set(k, (f = { src: null, v: new Int8Array(FN * FN * 2), live: true, rev: 0, reading: 0 }));
          f.live = true;
          f.reading++;
          touched.set(k, (t = { f, before: f.v.slice() }));
        }
        const i = ((gy % FN) * FN + (gx % FN)) * 2;
        const a = 0.6 * (1 - d / R);
        const v = t.f.v;
        v[i] = Math.round(v[i] + (ux * 127 - v[i]) * a);
        v[i + 1] = Math.round(v[i + 1] + (uy * 127 - v[i + 1]) * a);
        t.f.rev++;
      }
    }
  };
  const stroke = beginStroke(sceneId, body, { size, soft: 0.25, strength: 1, layer: 'water', onDab, bounds });
  return {
    line: stroke.line,
    hold: stroke.hold,
    async end() {
      const { chunks, used } = await stroke.end();
      let flow = null;
      for (const [k, { f, before }] of touched) {
        f.live = false;
        if (f.v.every((x, i) => x === before[i])) continue;
        f.src = await encodeAmounts(new Uint8Array(f.v.buffer, f.v.byteOffset, f.v.length));
        (flow ??= {})[k] = f.src;
      }
      return { chunks, flow, used };
    },
    cancel() {
      stroke.cancel();
      for (const { f, before } of touched.values()) { f.v = before; f.live = false; f.rev++; }
    },
  };
}

/** The body of water at a point (squares), or null. */
export function bodyAt(sceneId, x, y) {
  const gx = Math.floor(x * RES), gy = Math.floor(y * RES);
  const e = chunksFor(sceneId, 'water').get(chunkKey(Math.floor(gx / N), Math.floor(gy / N)));
  if (!e) return null;
  const i = (gy - Math.floor(gy / N) * N) * N + (gx - Math.floor(gx / N) * N);
  let best = null, most = 127;
  for (const [id, b] of Object.entries(e.w)) if (b[i] > most) { most = b[i]; best = id; }
  return best;
}

// ------------------------------------------------------------------ the field round a chunk

/** Distances from sources (dist 0) over the padded grid, two passes; `label` follows the nearest. */
function chamfer(dist, label) {
  const D = Math.SQRT2;
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      const i = y * P + x;
      let v = dist[i];
      if (!v) continue;
      let from = -1;
      if (x > 0 && dist[i - 1] + 1 < v) { v = dist[i - 1] + 1; from = i - 1; }
      if (y > 0) {
        if (dist[i - P] + 1 < v) { v = dist[i - P] + 1; from = i - P; }
        if (x > 0 && dist[i - P - 1] + D < v) { v = dist[i - P - 1] + D; from = i - P - 1; }
        if (x < P - 1 && dist[i - P + 1] + D < v) { v = dist[i - P + 1] + D; from = i - P + 1; }
      }
      if (from >= 0) { dist[i] = v; if (label) label[i] = label[from]; }
    }
  }
  for (let y = P - 1; y >= 0; y--) {
    for (let x = P - 1; x >= 0; x--) {
      const i = y * P + x;
      let v = dist[i];
      if (!v) continue;
      let from = -1;
      if (x < P - 1 && dist[i + 1] + 1 < v) { v = dist[i + 1] + 1; from = i + 1; }
      if (y < P - 1) {
        if (dist[i + P] + 1 < v) { v = dist[i + P] + 1; from = i + P; }
        if (x < P - 1 && dist[i + P + 1] + D < v) { v = dist[i + P + 1] + D; from = i + P + 1; }
        if (x > 0 && dist[i + P - 1] + D < v) { v = dist[i + P - 1] + D; from = i + P - 1; }
      }
      if (from >= 0) { dist[i] = v; if (label) label[i] = label[from]; }
    }
  }
}

/** A box blur (radius r) of a P × P grid, in place. */
function blur(a, r, size = P) {
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass ? tmp : a, dst = pass ? a : tmp;
    for (let line = 0; line < size; line++) {
      let sum = 0;
      const at = (j) => src[pass ? Math.min(size - 1, Math.max(0, j)) * size + line : line * size + Math.min(size - 1, Math.max(0, j))];
      for (let j = -r; j <= r; j++) sum += at(j);
      for (let j = 0; j < size; j++) {
        dst[pass ? j * size + line : line * size + j] = sum / (2 * r + 1);
        sum += at(j + r + 1) - at(j - r);
      }
    }
  }
}

/**
 * How the water lies round chunk (cx, cy): `sd`, each point's distance (points) inside the water
 * (less than 0: outside it), the bodies there and how much each point is each's (`weights`, null
 * with one), and the rivers' flow. Null without water near.
 */
function field(data, fm, cx, cy, bodies, last) {
  const ids = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const e = data.get(chunkKey(cx + dx, cy + dy));
    if (e) for (const id of Object.keys(e.w)) if (bodies[id] && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return null;
  const amounts = ids.map((id) => padded(data, cx, cy, id, PADW, last));
  const inside = new Float32Array(P * P), outside = new Float32Array(P * P);
  const label = new Int8Array(P * P).fill(-1);
  let wet = 0;
  for (let i = 0; i < P * P; i++) {
    let sum = 0, best = -1, most = 0;
    for (let j = 0; j < ids.length; j++) { const v = amounts[j][i]; sum += v; if (v > most) { most = v; best = j; } }
    if (sum >= 127.5) { inside[i] = Infinity; outside[i] = 0; label[i] = best; wet++; } else { inside[i] = 0; outside[i] = Infinity; }
  }
  if (!wet) return null;
  if (wet < P * P) chamfer(inside, null); else inside.fill(1e4);
  chamfer(outside, label);
  const sd = new Float32Array(P * P);
  for (let i = 0; i < P * P; i++) sd[i] = inside[i] ? inside[i] - 0.5 : -(outside[i] - 0.5);
  // The edge is between points, square by square: smoothed, so it curves rather than steps.
  blur(sd, 2);
  let weights = null;
  if (ids.length > 1) {
    weights = ids.map((_, j) => {
      const w = new Float32Array(P * P);
      for (let i = 0; i < P * P; i++) w[i] = label[i] === j ? 1 : 0;
      blur(w, 3);
      return w;
    });
  }
  // The flow round it, smoothed.
  let flow = null;
  if (ids.some((id) => bodies[id].kind === 'river')) {
    const fx = new Float32Array(FP * FP), fy = new Float32Array(FP * FP);
    const ox = cx * FN - FPAD, oy = cy * FN - FPAD;
    for (let y = 0; y < FP; y++) {
      for (let x = 0; x < FP; x++) {
        const gx = ox + x, gy = oy + y;
        if (gx < 0 || gy < 0) continue;
        const f = fm.get(chunkKey(Math.floor(gx / FN), Math.floor(gy / FN)));
        if (!f) continue;
        const i = ((gy % FN) * FN + (gx % FN)) * 2;
        fx[y * FP + x] = f.v[i] / 127;
        fy[y * FP + x] = f.v[i + 1] / 127;
      }
    }
    blur(fx, 1, FP);
    blur(fy, 1, FP);
    flow = { fx, fy };
  }
  return { ids, sd, weights, flow };
}

/** Bilinear, on the padded grid, at a point of the chunk (its own points, fractional). */
function sample(a, x, y) {
  let tx = x - 0.5 + PADW, ty = y - 0.5 + PADW;
  if (tx < 0) tx = 0; else if (tx > P - 1.001) tx = P - 1.001;
  if (ty < 0) ty = 0; else if (ty > P - 1.001) ty = P - 1.001;
  const x0 = tx | 0, y0 = ty | 0, fx = tx - x0, fy = ty - y0, i = y0 * P + x0;
  const top = a[i] + (a[i + 1] - a[i]) * fx, bot = a[i + P] + (a[i + P + 1] - a[i + P]) * fx;
  return top + (bot - top) * fy;
}
function sampleFlow(a, x, y) { // x, y: the chunk's own squares
  let tx = x * FR - 0.5 + FPAD, ty = y * FR - 0.5 + FPAD;
  tx = Math.max(0, Math.min(FP - 1.001, tx)); ty = Math.max(0, Math.min(FP - 1.001, ty));
  const x0 = tx | 0, y0 = ty | 0, fx = tx - x0, fy = ty - y0, i = y0 * FP + x0;
  const top = a[i] + (a[i + 1] - a[i]) * fx, bot = a[i + FP] + (a[i + FP + 1] - a[i + FP]) * fx;
  return top + (bot - top) * fy;
}

// The shore's wander (squares), the same wherever it's drawn so foam meets the shore it's on.
function wander(gx, gy, out) {
  out[0] = 0.22 * valueNoise(gx * 0.9, gy * 0.9, 61) + 0.07 * valueNoise(gx * 3.1, gy * 3.1, 67);
  out[1] = 0.22 * valueNoise(gx * 0.9, gy * 0.9, 71) + 0.07 * valueNoise(gx * 3.1, gy * 3.1, 73);
}

/** Per pixel: where it is in the water. Fills `o` { s (squares in), w[] (each body's share) }. */
function locate(F, cx, cy, lx, ly, o, tmp) {
  // lx, ly: the chunk's own squares
  wander(cx * CHUNK + lx, cy * CHUNK + ly, tmp);
  const px = (lx + tmp[0]) * RES, py = (ly + tmp[1]) * RES;
  o.s = sample(F.sd, px, py) / RES;
  if (F.weights) {
    let t = 0;
    for (let j = 0; j < F.ids.length; j++) { o.w[j] = sample(F.weights[j], px, py); t += o.w[j]; }
    if (t > 0) for (let j = 0; j < F.ids.length; j++) o.w[j] /= t;
  } else o.w[0] = 1;
  o.px = px; o.py = py;
}

// ------------------------------------------------------------------ drawing a chunk

let maskCanvas = null, layerCanvas = null, tmpCanvas = null;
const canvas = (c, w, h) => { if (!c) c = document.createElement('canvas'); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } return c; };

/** The base: shore, underlay, depth, water. True if a texture was still loading. */
function bakeBase(v, F, cx, cy, bodies, g, fill) {
  const px = Math.min(g, BASE_PX), size = CHUNK * px;
  v.base = canvas(v.base, size, size);
  const out = v.base.getContext('2d');
  out.setTransform(1, 0, 0, 1, 0, 0);
  out.clearRect(0, 0, size, size);
  if (!F) return false;
  const M = CHUNK * MASK_PX;
  const nb = F.ids.length;
  const B = F.ids.map((id) => bodies[id]);
  const maxShore = Math.max(...B.map((b) => (b.shore ? b.shore_width ?? 0.5 : 0))) + 0.6;
  const maxDepth = Math.max(...B.map((b) => b.depth ?? 3));
  const L = { shore: [], under: [], water: [] };
  for (let j = 0; j < nb; j++) for (const k of Object.keys(L)) L[k].push(new Uint8ClampedArray(M * M * 4));
  const shade = new Uint8ClampedArray(M * M * 4), light = new Uint8ClampedArray(M * M * 4), tint = new Uint8ClampedArray(M * M * 4);
  const o = { s: 0, w: new Float32Array(nb) }, tmp = [0, 0];
  const used = { shore: new Uint8Array(nb), under: new Uint8Array(nb), water: new Uint8Array(nb) };
  for (let my = 0; my < M; my++) {
    const ly = (my + 0.5) / MASK_PX;
    for (let mx = 0; mx < M; mx++) {
      const lx = (mx + 0.5) / MASK_PX;
      // Far from any water: nothing; far out in it: the same as all round.
      const s0 = sample(F.sd, lx * RES, ly * RES) / RES;
      if (s0 < -(maxShore + 0.35)) continue;
      const deep = s0 > maxDepth + 0.6 && !F.weights;
      let n1 = 0;
      if (deep) { o.s = s0; o.w[0] = 1; } else {
        locate(F, cx, cy, lx, ly, o, tmp);
        const gx = cx * CHUNK + lx, gy = cy * CHUNK + ly;
        n1 = valueNoise(gx * 0.55, gy * 0.55, 83) * 0.7 + valueNoise(gx * 1.9, gy * 1.9, 89) * 0.3;
      }
      const s = o.s, a = (my * M + mx) * 4 + 3;
      let sh = 0, li = 0, ti = 0;
      for (let j = 0; j < nb; j++) {
        const wj = o.w[j];
        if (wj < 0.004) continue;
        const b = B[j];
        const depth = Math.max(0.5, b.depth ?? 3), clarity = clamp01(b.clarity ?? 0.5);
        if (b.shore) {
          const reach = (b.shore_width ?? 0.5) * (1 + 0.4 * n1);
          const x = smooth(-reach - 0.18, -reach + 0.18, s) * wj;
          if (x > 0) { L.shore[j][a] = x * 255; used.shore[j] = 1; }
        }
        if (b.underlay) {
          const x = (b.shore ? smooth(0.1, 0.85, s + 0.25 * n1) : smooth(-0.08, 0.06, s)) * wj;
          if (x > 0) { L.under[j][a] = x * 255; used.under[j] = 1; }
        }
        const edge = smooth(-0.04, 0.05, s);
        if (edge > 0) {
          const d = clamp01(s / depth);
          const lo = 0.12 + 0.45 * (1 - clarity), hi = 0.94 - 0.12 * clarity;
          L.water[j][a] = edge * (lo + (hi - lo) * d ** 0.8) * wj * 255;
          used.water[j] = 1;
          sh += edge * (0.5 + 0.25 * (1 - clarity)) * d ** 1.1 * wj;
          // The shallows: the water's own colour, brighter, over what shows through.
          ti += edge * (1 - d) ** 1.5 * (0.3 + 0.2 * clarity) * wj;
          // A thin bright line where it meets the shore.
          if (b.kind !== 'ocean') li += 0.22 * Math.exp(-(((s - 0.05) / 0.045) ** 2)) * wj;
        }
        // Damp ground along the edge.
        if (s < 0.05) sh += 0.26 * clamp01(1 + s / (0.25 + 0.2 * (b.shore_width ?? 0.5))) * (s > 0 ? 0.5 : 1) * wj;
      }
      shade[a] = sh * 255;
      light[a] = li * 255;
      tint[a] = ti * 255;
    }
  }
  maskCanvas = canvas(maskCanvas, M, M);
  layerCanvas = canvas(layerCanvas, size, size);
  const mc = maskCanvas.getContext('2d'), lc = layerCanvas.getContext('2d');
  const k_ = px / g;
  let waiting = false;
  const layer = (mask, paint) => {
    mc.putImageData(new ImageData(mask, M, M), 0, 0);
    lc.save();
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, size, size);
    paint();
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'destination-in';
    lc.imageSmoothingEnabled = true;
    lc.imageSmoothingQuality = 'high';
    lc.drawImage(maskCanvas, 0, 0, size, size);
    lc.restore();
    out.drawImage(layerCanvas, 0, 0);
  };
  const texture = (m) => () => {
    lc.setTransform(k_, 0, 0, k_, -cx * CHUNK * g * k_, -cy * CHUNK * g * k_);
    if (!fill(lc, m, g, { x: cx * CHUNK * g, y: cy * CHUNK * g, w: CHUNK * g, h: CHUNK * g })) waiting = true;
  };
  const flat = (c) => () => { lc.fillStyle = c; lc.fillRect(0, 0, size, size); };
  for (let j = 0; j < nb; j++) if (used.shore[j]) layer(L.shore[j], texture(B[j].shore));
  for (let j = 0; j < nb; j++) if (used.under[j]) layer(L.under[j], texture(B[j].underlay));
  const [r, gg, bb] = meanColour(B[0].water || 'water', fill, g) ?? [40, 90, 120];
  layer(tint, flat(`rgb(${Math.min(255, r * 1.15 + 28)}, ${Math.min(255, gg * 1.2 + 34)}, ${Math.min(255, bb * 1.1 + 30)})`));
  layer(shade, flat(`rgb(${r * 0.18}, ${gg * 0.22}, ${bb * 0.3})`));
  for (let j = 0; j < nb; j++) if (used.water[j]) layer(L.water[j], texture(B[j].water || 'water'));
  layer(light, flat('#e4f2f6'));
  return waiting;
}

// material → its average colour [r, g, b]
const means = new Map();
function meanColour(m, fill, g) {
  if (means.has(m)) return means.get(m);
  const c = canvas(null, 32, 32), cc = c.getContext('2d', { willReadFrequently: true });
  cc.setTransform(16 / g, 0, 0, 16 / g, 0, 0);
  if (!fill(cc, m, g, { x: 0, y: 0, w: 2 * g, h: 2 * g })) return null;
  const d = cc.getImageData(0, 0, 32, 32).data;
  const out = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { out[0] += d[i]; out[1] += d[i + 1]; out[2] += d[i + 2]; }
  const res = out.map((x) => x / (d.length / 4));
  means.set(m, res);
  return res;
}

/** One frame of what moves (phase 0 … 1 round the cycle), as RGBA at `fpx` pixels a square. */
function bakeFx(F, cx, cy, bodies, fpx, phase) {
  const S = CHUNK * fpx;
  const img = new Uint8ClampedArray(S * S * 4);
  const nb = F.ids.length, B = F.ids.map((id) => bodies[id]);
  const maxDepth = Math.max(...B.map((b) => Math.min(REACH_SQ, b.depth ?? 3)));
  const o = { s: 0, w: new Float32Array(nb) }, tmp = [0, 0];
  const TAU = Math.PI * 2;
  const swash = 0.5 - 0.5 * Math.cos(TAU * phase);
  const t1 = phase, t2 = (phase + 0.5) % 1;
  const w1 = 1 - Math.abs(2 * t1 - 1), w2 = 1 - w1;
  const drift = [0.12 * Math.cos(TAU * phase), 0.12 * Math.sin(TAU * phase)];
  const lake = B.some((b) => b.kind === 'lake'), river = B.some((b) => b.kind === 'river');
  let any = false;
  for (let y = 0; y < S; y++) {
    const ly = (y + 0.5) / fpx;
    for (let x = 0; x < S; x++) {
      const lx = (x + 0.5) / fpx;
      const s0 = sample(F.sd, lx * RES, ly * RES) / RES;
      if (s0 < -0.7) continue;
      if (s0 > maxDepth + 0.8 && !lake && !river) continue;
      locate(F, cx, cy, lx, ly, o, tmp);
      const s = o.s;
      if (s < -0.4) continue;
      const gx = cx * CHUNK + lx, gy = cy * CHUNK + ly;
      let white = 0, dark = 0;
      for (let j = 0; j < nb; j++) {
        const wj = o.w[j];
        if (wj < 0.01) continue;
        const b = B[j];
        let wh = 0, dk = 0;
        if (b.kind === 'ocean') {
          const depth = Math.min(REACH_SQ, Math.max(1.5, b.depth ?? 5));
          // The wash: up the beach and back, foaming.
          const edge = 0.04 - 0.3 * swash;
          const band = smooth(edge - 0.05, edge + 0.02, s) * (1 - smooth(edge + 0.12, edge + 0.45 + 0.2 * swash, s));
          if (band > 0) {
            const bub = smooth(-0.35, 0.45, valueNoise(gx * 3.5, gy * 3.5, 17) + 0.5 * valueNoise(gx * 6.5, gy * 6.5, 19));
            wh = band * (0.4 + 0.55 * bub);
          }
          // Wet sand the wash left.
          if (s < edge && s > -0.35) dk = Math.max(dk, 0.14 * (1 - swash * 0.6) * smooth(-0.35, -0.1, s));
          // Waves rolling in: crests, foaming as they near the shore, broken along their length.
          if (s > 0.2 && s < depth) {
            const u = s / 0.95 + phase + 0.3 * valueNoise(gx * 0.7, gy * 0.7, 23);
            const f = u - Math.floor(u);
            const amp = smooth(0.2, 0.75, s) * (1 - smooth(depth * 0.55, depth, s));
            const brk = smooth(-0.25, 0.45, valueNoise(gx * 1.4, gy * 1.4, 29) + 0.4 * valueNoise(gx * 4, gy * 4, 31));
            const crest = Math.exp(-(((f - 0.5) / 0.075) ** 2));
            const trough = Math.exp(-(((f - 0.64) / 0.12) ** 2));
            wh = Math.max(wh, crest * amp * brk * (0.3 + 0.45 * (1 - s / depth)));
            dk = Math.max(dk, trough * amp * 0.13);
          }
        } else if (b.kind === 'river') {
          if (s < -0.05) continue;
          let dx = 0, dy = 0;
          if (F.flow) { dx = sampleFlow(F.flow.fx, lx, ly); dy = sampleFlow(F.flow.fy, lx, ly); }
          let len = Math.hypot(dx, dy);
          if (len < 0.05) {
            // Not painted with a way: along the banks.
            const e = 0.5;
            const gxs = sample(F.sd, o.px + e, o.py) - sample(F.sd, o.px - e, o.py);
            const gys = sample(F.sd, o.px, o.py + e) - sample(F.sd, o.px, o.py - e);
            dx = -gys; dy = gxs;
            if (dx + 0.3 * dy < 0) { dx = -dx; dy = -dy; }
            len = Math.hypot(dx, dy) || 1;
          }
          dx /= len; dy /= len;
          const sp = smooth(0.02, 0.7, s);
          const travel = 1.7 * (0.35 + 0.65 * sp);
          // Streaks carried downstream: noise drawn out along the flow, shifted along it in two
          // phases, each faded out as it starts again.
          const streak = (t, ox, oy) => {
            const qx = gx - dx * travel * (t - 0.5) + ox, qy = gy - dy * travel * (t - 0.5) + oy;
            let n = 0;
            for (let k = -4; k <= 4; k++) n += valueNoise((qx + dx * k * 0.14) * 4, (qy + dy * k * 0.14) * 4, 37);
            return n / 9;
          };
          const n = (streak(t1, 0, 0) * w1 + streak(t2, 31.7, 17.3) * w2) * 2.4;
          wh = smooth(0.34, 0.75, n) * 0.3 * sp;
          dk = smooth(-0.25, -0.65, n) * 0.14 * sp;
          // Ripples along the banks, running with it.
          const bank = Math.exp(-(((s - 0.13) / 0.045) ** 2));
          if (bank > 0.02) {
            const qx = gx - dx * travel * (t1 - 0.5), qy = gy - dy * travel * (t1 - 0.5);
            const qx2 = gx - dx * travel * (t2 - 0.5) + 9.1, qy2 = gy - dy * travel * (t2 - 0.5) + 4.7;
            const dash = smooth(-0.05, 0.4, valueNoise(qx * 3.5, qy * 3.5, 47)) * w1 + smooth(-0.05, 0.4, valueNoise(qx2 * 3.5, qy2 * 3.5, 47)) * w2;
            wh = Math.max(wh, bank * dash * 0.4);
          }
        } else {
          // Still water: a few soft glints shifting about, a faint ring along the shore.
          if (s < -0.05) continue;
          const n = valueNoise((gx + drift[0]) * 3, (gy + drift[1]) * 3, 41) * 0.65 + valueNoise((gx - drift[1]) * 7, (gy + drift[0]) * 7, 43) * 0.35;
          wh = smooth(0.5, 0.78, n) * 0.22 * smooth(0.25, 1.2, s);
          const ring = Math.exp(-(((s - 0.16 - 0.04 * Math.sin(TAU * phase + gx * 0.8 + gy * 0.5)) / 0.04) ** 2));
          wh = Math.max(wh, ring * 0.16 * smooth(-0.1, 0.4, valueNoise(gx * 2, gy * 2, 53)));
        }
        white += wh * wj;
        dark += dk * wj;
      }
      if (white < 0.004 && dark < 0.004) continue;
      white = clamp01(white); dark = clamp01(dark);
      const A = white + dark * (1 - white);
      const i = (y * S + x) * 4;
      img[i] = (white * 238 + dark * (1 - white) * 4) / A;
      img[i + 1] = (white * 246 + dark * (1 - white) * 22) / A;
      img[i + 2] = (white * 250 + dark * (1 - white) * 34) / A;
      img[i + 3] = A * 255;
      any = true;
    }
  }
  if (!any) return null;
  const c = canvas(null, S, S);
  c.getContext('2d').putImageData(new ImageData(img, S, S), 0, 0);
  return c;
}

// ------------------------------------------------------------------ drawing the water

// scene id → Map(chunk key → { sig, base, fx: [], fxSig, F, wait })
const views = new Map();
let texturesRev = 0;
let ticking = false;

/**
 * Draw a scene's water (scene coordinates), like drawTerrain: `fill(ctx, material, g, rect)`
 * paints a material over a rect (false: not loaded yet); `again()` asks for another frame;
 * `animate`: waves and currents move.
 */
export function drawWater(ctx, s, water, g, fill, again, animate) {
  redraw = again;
  sync(s.id, water, 'water');
  syncFlow(s.id, water?.flow);
  const data = chunksFor(s.id, 'water');
  let vm = views.get(s.id);
  if (!vm) views.set(s.id, (vm = new Map()));
  const bodies = water?.bodies ?? {};
  // The chunks to draw: those with water, and round them.
  const want = new Set();
  for (const [k, e] of data) {
    if (!Object.keys(e.w).length) continue;
    const [cx, cy] = chunkOf(k);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cx + dx >= 0 && cy + dy >= 0) want.add(chunkKey(cx + dx, cy + dy));
  }
  for (const k of vm.keys()) if (!want.has(k)) vm.delete(k);
  if (!want.size) return;
  const fm = flowsFor(s.id);
  const last = [Math.ceil((s.width / g) * RES) - 1, Math.ceil((s.height / g) * RES) - 1]; // the scene's last point
  const all = `${g}|${last}|${JSON.stringify(bodies)}|${texturesRev}`;
  const moving = !!animate;
  const fpx = Math.min(g, moving ? FX_MOVING : FX_STILL), frames = moving ? FRAMES : 1;
  const now = performance.now();
  const t0 = now;
  const busy = () => performance.now() - t0 > 12;
  let pending = false;
  // Changed chunks first (their base, then their first frame), then the rest of the frames.
  const order = [];
  for (const k of want) {
    let v = vm.get(k);
    if (!v) vm.set(k, (v = { sig: null, base: null, fx: [], fxSig: null, F: null, wait: 0 }));
    const [cx, cy] = chunkOf(k);
    let sig = all, live = false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const e = data.get(chunkKey(cx + dx, cy + dy));
      const f = fm.get(chunkKey(cx + dx, cy + dy));
      if (e?.live) live = true;
      sig += `|${e ? e.rev : '-'}:${f ? f.rev : '-'}`;
    }
    v.live = live;
    // Its own water changed (not just a neighbour's): drawn again first.
    const own = data.get(k)?.rev ?? -1;
    order.push([k, v, cx, cy, sig, own !== v.own]);
    v.ownNow = own;
  }
  order.sort((a, b) => b[5] - a[5]);
  for (const [, v, cx, cy, sig] of order) {
    if (v.live || v.sig === sig || v.wait > now) continue;
    if (busy() && v.base) { pending = true; continue; }
    v.F = field(data, fm, cx, cy, bodies, last);
    v.sig = sig;
    v.own = v.ownNow;
    v.fx = [];
    v.fxSig = null;
    if (bakeBase(v, v.F, cx, cy, bodies, g, fill)) { v.sig = null; v.wait = now + 400; setTimeout(again, 450); }
  }
  const fxSig = `${fpx}|${frames}`;
  for (const [, v, cx, cy, sig] of order) {
    if (v.live || !v.base) continue;
    if (v.fxSig !== fxSig) { v.fx = []; v.fxSig = fxSig; }
    if (v.fx.length >= frames) { v.F = null; continue; }
    if (v.sig !== sig) continue;
    if (busy()) { pending = true; continue; }
    if (!v.F) v.F = field(data, fm, cx, cy, bodies, last);
    while (v.fx.length < frames && !busy()) {
      v.fx.push(v.F ? bakeFx(v.F, cx, cy, bodies, fpx, v.fx.length / frames) : null);
    }
    if (v.fx.length < frames) pending = true; else v.F = null;
  }
  // Which frames show now, and how much of the next.
  const at = ((performance.now() % PERIOD) / PERIOD) * frames;
  const f0 = Math.floor(at) % frames, f1 = (f0 + 1) % frames, mix = at - Math.floor(at);
  let shown = false;
  for (const [k, v, cx, cy] of order) {
    if (v.live && !v.base) v.base = canvas(null, CHUNK * Math.min(g, BASE_PX), CHUNK * Math.min(g, BASE_PX));
    if (!v.base) continue;
    const X = cx * CHUNK * g, Y = cy * CHUNK * g, W = CHUNK * g;
    if (v.live) { drawLive(ctx, v, data.get(k), X, Y, W); continue; }
    ctx.drawImage(v.base, X, Y, W, W);
    if (v.fx.length >= frames && frames > 1) {
      const a = v.fx[f0], b = v.fx[f1];
      const keep = ctx.globalAlpha;
      if (a) { ctx.globalAlpha = keep * (1 - mix); ctx.drawImage(a, X, Y, W, W); }
      if (b) { ctx.globalAlpha = keep * mix; ctx.drawImage(b, X, Y, W, W); }
      ctx.globalAlpha = keep;
      if (a || b) shown = true;
    } else if (v.fx[0]) ctx.drawImage(v.fx[0], X, Y, W, W);
  }
  if (pending) again();
  // Moving water: about 15 frames a second is plenty.
  if (shown && !ticking) { ticking = true; setTimeout(() => { ticking = false; again(); }, 66); }
}

/** A chunk being painted: what was there, less what's painted out, and the new water, flat. */
function drawLive(ctx, v, e, X, Y, W) {
  const size = v.base.width;
  tmpCanvas = canvas(tmpCanvas, size, size);
  const tc = tmpCanvas.getContext('2d');
  tc.setTransform(1, 0, 0, 1, 0, 0);
  tc.globalCompositeOperation = 'source-over';
  tc.clearRect(0, 0, size, size);
  tc.drawImage(v.base, 0, 0);
  if (v.fx[0]) tc.drawImage(v.fx[0], 0, 0, size, size);
  if (e) {
    const before = e.before ?? e.w;
    const cut = new Uint8ClampedArray(N * N * 4), add = new Uint8ClampedArray(N * N * 4);
    let anyCut = false, anyAdd = false;
    const now = Object.values(e.w), was = Object.values(before);
    for (let i = 0; i < N * N; i++) {
      let a = 0, b = 0;
      for (const x of now) a += x[i];
      for (const x of was) b += x[i];
      const A = a >= 128 ? 1 : 0, Bw = b >= 128 ? 1 : 0;
      if (Bw && !A) { cut[i * 4 + 3] = 255; anyCut = true; }
      if (A && !Bw) { add[i * 4 + 3] = 255; anyAdd = true; }
    }
    maskCanvas = canvas(maskCanvas, N, N);
    const mc = maskCanvas.getContext('2d');
    tc.imageSmoothingEnabled = true;
    if (anyCut) {
      mc.putImageData(new ImageData(cut, N, N), 0, 0);
      tc.globalCompositeOperation = 'destination-out';
      tc.drawImage(maskCanvas, 0, 0, size, size);
    }
    if (anyAdd) {
      mc.putImageData(new ImageData(add, N, N), 0, 0);
      mc.globalCompositeOperation = 'source-in';
      mc.fillStyle = 'rgba(38, 92, 122, 0.82)';
      mc.fillRect(0, 0, N, N);
      mc.globalCompositeOperation = 'source-over';
      tc.globalCompositeOperation = 'source-over';
      tc.drawImage(maskCanvas, 0, 0, size, size);
    }
  }
  ctx.drawImage(tmpCanvas, X, Y, W, W);
}

/** A texture changed or its picture arrived: draw the water again. */
export function waterTexturesChanged() { texturesRev++; means.clear(); }

/** Forget a scene's water (it was erased). */
export function forgetWater(sceneId) { views.delete(sceneId); flows.delete(sceneId); }
