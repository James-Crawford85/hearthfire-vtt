// Terrain: ground textures painted freely onto a sketch (the ground level only), blended over
// the sketch's `outside`, under the floors.
//
// scene.sketch.terrain:
//   slots  { "1"…"8": { material, scale (1 = as on floors), edge (0 soft … 1 ragged) } }
//   chunks { "col,row": { slot: amounts } }   chunks of CHUNK × CHUNK squares
// A chunk's amounts for a slot are RES × RES points a square (N × N for the chunk), one byte
// each (0 none … 255 all of it), deflated and base64 encoded ("z:…", or "r:…" undeflated). A
// point's slots add up to at most 255; what's left is `outside` (or the map, without one).
//
// Each chunk is drawn once into a canvas (again when it changes): every slot's texture, cut by
// its amounts, added together. Amounts are smoothed between the points and given a ragged edge
// from noise, so a stroke of grass into dirt looks grown rather than airbrushed.

export const CHUNK = 16;
export const RES = 8;
export const N = CHUNK * RES;
export const MAX_SLOTS = 8;
const UP = 4; // mask pixels per point
const M = N * UP;
const MAX_PX = 80; // a chunk is drawn at most this many pixels a square

export const chunkKey = (cx, cy) => `${cx},${cy}`;
export const chunkOf = (k) => k.split(',').map(Number);

// ------------------------------------------------------------------ encoding

const canDeflate = typeof CompressionStream === 'function';

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buf);
}

/** A slot's amounts (N × N bytes) as stored. */
export async function encodeAmounts(bytes) {
  if (!canDeflate) return `r:${toBase64(bytes)}`;
  return `z:${toBase64(await pipe(bytes, new CompressionStream('deflate-raw')))}`;
}

/** Stored amounts back to N × N bytes (`len` bytes; null if they can't be read). */
export async function decodeAmounts(s, len = N * N) {
  try {
    let bytes = fromBase64(s.slice(2));
    if (s.startsWith('z:')) bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    if (bytes.length !== len) return null;
    return bytes;
  } catch { return null; }
}

// ------------------------------------------------------------------ the chunks as the client has them

// "layer|scene id" → Map(chunk key → { src: { slot: stored }, w: { slot: Uint8Array }, canvas,
//   dirty, sig, live, rev, before })   `live`: painted here and not sent yet (kept though the
//   scene doesn't have it); `rev` counts changes; `before`: its amounts before the stroke
//   being painted. The layers: "terrain", and "water" (water.js, which draws its own).
const scenes = new Map();
let invalidate = () => {};
/** What to call when a chunk is ready to draw again. */
export function onTerrainReady(fn) { invalidate = fn; }

export function chunksFor(sceneId, layer = 'terrain') {
  const key = `${layer}|${sceneId}`;
  let m = scenes.get(key);
  if (!m) scenes.set(key, (m = new Map()));
  return m;
}

/** Bring a layer's chunks up to date with the scene's (`{ chunks }`): read what changed, drop what went. */
export function sync(sceneId, terrain, layer = 'terrain') {
  const chunks = chunksFor(sceneId, layer);
  const stored = terrain?.chunks ?? {};
  for (const [k, e] of chunks) {
    if (!(k in stored) && !e.live) { chunks.delete(k); markAround(chunks, k); }
  }
  for (const [k, slots] of Object.entries(stored)) {
    let e = chunks.get(k);
    if (!e) chunks.set(k, (e = { src: {}, w: {}, canvas: null, dirty: true, sig: '', live: false, reading: 0, rev: 0 }));
    if (e.live) continue;
    const want = slots ?? {};
    const same = Object.keys(want).length === Object.keys(e.src).length && Object.entries(want).every(([s, v]) => e.src[s] === v);
    if (same) continue;
    e.src = { ...want };
    const ticket = ++e.reading;
    Promise.all(Object.entries(want).map(async ([s, v]) => [s, await decodeAmounts(v)])).then((list) => {
      if (e.reading !== ticket || e.live) return;
      e.w = Object.fromEntries(list.filter(([, b]) => b));
      e.dirty = true; e.rect = null; e.rev++;
      markAround(chunks, k);
      invalidate();
    });
  }
}

/** The chunks round this one draw their edges from it: draw them again too. */
function markAround(chunks, k) {
  const [cx, cy] = chunkOf(k);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const n = chunks.get(chunkKey(cx + dx, cy + dy));
    if (n) { n.dirty = true; n.rect = null; }
  }
}

/**
 * Points gx0…gx1, gy0…gy1 (the whole scene's) changed: every chunk whose drawing reaches them
 * draws that part again (e.rect, its points; e.dirty without a rect: all of it).
 */
function markRegion(chunks, gx0, gy0, gx1, gy1, m = REACH) {
  for (let cy = Math.floor((gy0 - m) / N); cy <= Math.floor((gy1 + m) / N); cy++) {
    for (let cx = Math.floor((gx0 - m) / N); cx <= Math.floor((gx1 + m) / N); cx++) {
      const e = chunks.get(chunkKey(cx, cy));
      if (!e) continue;
      const x0 = Math.max(0, gx0 - m - cx * N), x1 = Math.min(N - 1, gx1 + m - cx * N);
      const y0 = Math.max(0, gy0 - m - cy * N), y1 = Math.min(N - 1, gy1 + m - cy * N);
      if (x0 > x1 || y0 > y1) continue;
      if (e.dirty && !e.rect) continue; // all of it already
      e.rect = e.dirty ? [Math.min(e.rect[0], x0), Math.min(e.rect[1], y0), Math.max(e.rect[2], x1), Math.max(e.rect[3], y1)] : [x0, y0, x1, y1];
      e.dirty = true;
    }
  }
}

// ------------------------------------------------------------------ painting

/**
 * A stroke being painted: paints into the chunks here (shown at once) and, when it ends, gives
 * the change to send. `slot`: the slot painted, or null to erase (back to outside). `layer`:
 * whose chunks; `onDab(x, y, radius)` (squares) is told of each dab; `bounds` { cols, rows }:
 * the scene's size in squares (chunks wholly off it aren't painted).
 */
export function beginStroke(sceneId, slot, { size, soft, strength, layer = 'terrain', onDab = null, bounds = null }) {
  const chunks = chunksFor(sceneId, layer);
  const touched = new Map(); // chunk key → { before: { slot: Uint8Array }, cover: Float32Array }
  const radius = Math.max(0.25, size / 2) * RES; // in points
  const inner = radius * (1 - Math.min(0.95, Math.max(0, soft)));
  // Each dab lays down a little; a pass of the brush (about 8 dabs over a point) lays down
  // `strength`, and holding it there or going over again lays down more.
  const amount = Math.max(0.02, Math.min(1, strength));
  const perDab = amount >= 1 ? 1 : 1 - (1 - amount) ** (1 / 8);

  function touch(k) {
    let t = touched.get(k);
    if (t) return t;
    let e = chunks.get(k);
    if (!e) chunks.set(k, (e = { src: {}, w: {}, canvas: null, dirty: true, sig: '', live: true, reading: 0, rev: 0 }));
    e.live = true;
    e.reading++; // what's being read for it now is out of date
    const before = {};
    for (const [s, b] of Object.entries(e.w)) before[s] = b.slice();
    e.before = before;
    t = { before, cover: new Float32Array(N * N), e };
    touched.set(k, t);
    return t;
  }

  /** Paint a dab at (x, y), in squares. */
  function dab(x, y) {
    const px = x * RES - 0.5, py = y * RES - 0.5; // the point grid's own coordinates
    const x0 = Math.floor(px - radius), x1 = Math.ceil(px + radius);
    const y0 = Math.floor(py - radius), y1 = Math.ceil(py + radius);
    for (let cy = Math.floor(y0 / N); cy <= Math.floor(y1 / N); cy++) {
      for (let cx = Math.floor(x0 / N); cx <= Math.floor(x1 / N); cx++) {
        if (cx < 0 || cy < 0) continue;
        if (bounds && (cx * CHUNK >= bounds.cols || cy * CHUNK >= bounds.rows)) continue;
        const k = chunkKey(cx, cy);
        const t = touch(k);
        const ox = cx * N, oy = cy * N;
        let any = false;
        const lx0 = Math.max(x0, ox) - ox, lx1 = Math.min(x1, ox + N - 1) - ox;
        const ly0 = Math.max(y0, oy) - oy, ly1 = Math.min(y1, oy + N - 1) - oy;
        for (let gy = ly0 + oy; gy <= ly1 + oy; gy++) {
          for (let gx = lx0 + ox; gx <= lx1 + ox; gx++) {
            const d = Math.hypot(gx - px, gy - py);
            if (d >= radius) continue;
            let f = d <= inner ? 1 : 1 - (d - inner) / (radius - inner);
            f = f * f * (3 - 2 * f);
            const i = (gy - oy) * N + (gx - ox);
            const c = f * perDab;
            if (c > 0) { t.cover[i] += (1 - t.cover[i]) * c; any = true; }
          }
        }
        if (any) { apply(t, lx0, ly0, lx1, ly1); t.e.rev++; }
      }
    }
    markRegion(chunks, x0, y0, x1, y1);
    onDab?.(x, y, radius / RES);
  }

  /**
   * Points of a chunk (x0…x1, y0…y1, its own), from how they were before the stroke and how
   * much the stroke covers them.
   */
  function apply(t, x0, y0, x1, y1) {
    const { before, cover, e } = t;
    if (slot && !e.w[slot]) e.w[slot] = new Uint8Array(N * N);
    const list = Object.values(e.w);
    for (const [s, out] of Object.entries(e.w)) {
      const was = before[s];
      const mine = s === slot;
      for (let y = y0; y <= y1; y++) {
        for (let i = y * N + x0, end = y * N + x1; i <= end; i++) {
          const c = cover[i];
          if (!c) continue;
          const w = was ? was[i] : 0;
          out[i] = Math.round(w * (1 - c) + (mine ? 255 * c : 0));
        }
      }
    }
    // Rounding mustn't take a point over the top.
    if (list.length > 1) {
      for (let y = y0; y <= y1; y++) {
        for (let i = y * N + x0, end = y * N + x1; i <= end; i++) {
          let sum = 0;
          for (const b of list) sum += b[i];
          if (sum > 255) for (const b of list) { if (b[i]) { const cut = Math.min(b[i], sum - 255); b[i] -= cut; sum -= cut; if (sum <= 255) break; } }
        }
      }
    }
  }

  /** Paint along from a to b (squares), a dab every so often so there are no gaps. */
  function line(a, b) {
    const step = Math.max(0.05, size / 8);
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let i = a === b ? n : 1; i <= n; i++) dab(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
    invalidate();
  }

  /**
   * The stroke is done: { chunks } — the merge patch for terrain.chunks (null for what's gone),
   * and `used`: the slots any chunk of the scene still has. Null if nothing changed.
   */
  async function end() {
    const patch = {};
    for (const [k, { e, before }] of touched) {
      e.live = false;
      e.before = null;
      e.rev++;
      const had = Object.keys(e.src).length > 0;
      for (const [s, b] of Object.entries(e.w)) if (!b.some((v) => v)) delete e.w[s];
      const out = {};
      for (const s of new Set([...Object.keys(e.src), ...Object.keys(e.w)])) {
        const b = e.w[s];
        if (!b) { out[s] = null; continue; }
        const was = before[s];
        if (s in e.src && was && was.every((v, i) => v === b[i])) continue;
        out[s] = await encodeAmounts(b);
      }
      if (!Object.keys(e.w).length) {
        if (had) patch[k] = null;
        chunks.delete(k);
        markAround(chunks, k);
        continue;
      }
      for (const [s, v] of Object.entries(out)) { if (v == null) delete e.src[s]; else e.src[s] = v; }
      if (Object.keys(out).length) patch[k] = had ? out : { ...e.src };
    }
    const used = new Set();
    for (const e of chunks.values()) for (const s of Object.keys(e.w)) used.add(s);
    invalidate();
    return { chunks: Object.keys(patch).length ? patch : null, used };
  }

  /** Put the chunks back as they were (the stroke was abandoned). */
  function cancel() {
    for (const [k, { e, before }] of touched) {
      e.w = before;
      e.live = false;
      e.before = null;
      e.rev++;
      e.dirty = true; e.rect = null;
      if (!Object.keys(before).length && !Object.keys(e.src).length) chunks.delete(k);
    }
    invalidate();
  }

  /** Another dab where the brush is held still (paint builds up while the button is down). */
  function hold(p) { dab(p.x, p.y); invalidate(); }

  return { line, hold, end, cancel };
}

// ------------------------------------------------------------------ drawing

// Smooth value noise in [-1, 1], from a position in squares and a seed.
export function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1;
}
export function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a + (a - b + d - c) * sx) * sy;
}
export const noise = (x, y, seed) => valueNoise(x * 0.7, y * 0.7, seed) * 0.5 + valueNoise(x * 2.1, y * 2.1, seed + 7) * 0.32 + valueNoise(x * 6, y * 6, seed + 13) * 0.18;

// Points of padding round a chunk's amounts: enough for the edges' wobble (WARP squares at
// most) and the smoothing between points.
const WARP = 0.5;
const PAD = Math.ceil(WARP * RES) + 2;
const PAD_ = PAD;
const FS = 2; // noise worked out this many times a point, across
// How far (in points) a change shows in the drawing: the wobble, the smoothing, a margin.
const REACH = Math.ceil(WARP * RES) + 2;

/**
 * A slot's amounts with PAD points round the edge from the chunks next door. Off the scene's
 * edge (`last`: its last point [x, y], if given; before 0 always): the nearest point on it.
 */
export function padded(chunks, cx, cy, slot, PAD = PAD_, last = null) {
  const P = N + 2 * PAD;
  const out = new Float32Array(P * P);
  const own = chunks.get(chunkKey(cx, cy))?.w[slot];
  const near = new Map();
  const at = (gx, gy) => {
    const ccx = Math.floor(gx / N), ccy = Math.floor(gy / N);
    if (ccx === cx && ccy === cy) return own ? own[(gy - cy * N) * N + (gx - cx * N)] : 0;
    // Off the scene's edge: the nearest point on it.
    if (gx < 0 || gy < 0) return at(Math.max(0, gx), Math.max(0, gy));
    if (last && (gx > last[0] || gy > last[1])) return at(Math.min(gx, last[0]), Math.min(gy, last[1]));
    const k = chunkKey(ccx, ccy);
    if (!near.has(k)) near.set(k, chunks.get(k)?.w[slot] ?? null);
    const b = near.get(k);
    return b ? b[(gy - ccy * N) * N + (gx - ccx * N)] : 0;
  };
  const ox = cx * N - PAD, oy = cy * N - PAD;
  for (let y = 0; y < P; y++) {
    const edgeRow = y < PAD || y >= P - PAD;
    for (let x = 0; x < P; x++) {
      if (!edgeRow && x >= PAD && x < P - PAD) out[y * P + x] = own ? own[(y - PAD) * N + (x - PAD)] : 0;
      else out[y * P + x] = at(ox + x, oy + y);
    }
  }
  return out;
}

let maskCanvas = null, layerCanvas = null;
const SEEDS = { 0: 101, 1: 211, 2: 307, 3: 401, 4: 503, 5: 601, 6: 701, 7: 809, 8: 907 };

/**
 * Draw one chunk into its canvas: each slot's texture, cut by its amounts, added together.
 * True if a texture was still loading.
 */
function bake(e, k, chunks, slots, g, fill, warp, rect = null) {
  const [cx, cy] = chunkOf(k);
  const px = Math.min(g, MAX_PX);
  const size = CHUNK * px;
  if (!e.canvas) { e.canvas = document.createElement('canvas'); rect = null; }
  if (e.canvas.width !== size) { e.canvas.width = size; e.canvas.height = size; rect = null; }
  const out = e.canvas.getContext('2d');
  out.setTransform(1, 0, 0, 1, 0, 0);
  // Just `rect` (points, its own; all of it without one), worked out with a point's margin so
  // its edge smooths into what's there; the pixels it covers are cleared and drawn again.
  const [rx0, ry0, rx1, ry1] = rect ?? [0, 0, N - 1, N - 1];
  const cellPx = size / N;
  const X = Math.floor(rx0 * cellPx), Y = Math.floor(ry0 * cellPx);
  const W = Math.ceil((rx1 + 1) * cellPx) - X, H = Math.ceil((ry1 + 1) * cellPx) - Y;
  out.save();
  out.beginPath();
  out.rect(X, Y, W, H);
  out.clip();
  out.clearRect(X, Y, W, H);
  try { return bakeIn(); } finally { out.restore(); }

  function bakeIn() {
  const ids = Object.keys(e.w).filter((s) => slots[s]);
  // The neighbours' too: a slot that's only next door still blends across the edge.
  for (const dk of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const n = chunks.get(chunkKey(cx + dk[0], cy + dk[1]));
    if (n) for (const s of Object.keys(n.w)) if (slots[s] && !ids.includes(s)) ids.push(s);
  }
  if (!ids.length) return false;

  const P = N + 2 * PAD;
  const amounts = ids.map((s) => padded(chunks, cx, cy, s));
  const wob = warp * RES; // in points
  const amp = ids.map((s) => 0.6 * clamp01(slots[s].edge ?? 0));
  const pow = ids.map((s) => 1 + 11 * clamp01(slots[s].edge ?? 0));
  const seeds = ids.map((s) => SEEDS[s] ?? 97 * Number(s));
  const mx0 = Math.max(0, rx0 - 1) * UP, mx1 = Math.min(N, rx1 + 2) * UP; // pixels of the mask
  const my0 = Math.max(0, ry0 - 1) * UP, my1 = Math.min(N, ry1 + 2) * UP;
  const mw = mx1 - mx0, mh = my1 - my0;
  const masks = ids.map(() => new Uint8ClampedArray(mw * mh * 4));
  const w = new Float32Array(ids.length);
  const p = new Float32Array(ids.length);
  // Noise is worked out on a grid FS to a point and smoothed between (it's smooth anyway, and
  // working it out for every pixel is most of the cost).
  // Each field is worked out where it's first wanted (most of a chunk is one texture or none,
  // and needs none of it).
  const F = N * FS + 1;
  const field = (seed) => ({ seed, v: new Float32Array(F * F).fill(NaN) });
  const wx = wob ? field(991) : null, wy = wob ? field(997) : null;
  const slotNoise = ids.map((_, j) => (amp[j] ? field(seeds[j]) : null));
  const baseNoise = amp.some((a) => a) ? field(53) : null;
  let fi = 0, ffx = 0, ffy = 0;
  const val = (f, i) => {
    let x = f.v[i];
    if (x !== x) x = f.v[i] = noise(cx * CHUNK + (i % F) / (RES * FS), cy * CHUNK + Math.floor(i / F) / (RES * FS), f.seed);
    return x;
  };
  const at = (f) => {
    const a0 = val(f, fi), a1 = val(f, fi + 1), b0 = val(f, fi + F), b1 = val(f, fi + F + 1);
    const a = a0 + (a1 - a0) * ffx, b = b0 + (b1 - b0) * ffx;
    return a + (b - a) * ffy;
  };

  // Which squares of points are all one texture, or empty, as far as any pixel in them can
  // reach (the wobble, and the smoothing's next point): those are filled without the sums.
  const reach = Math.ceil(wob) + 1;
  const sat = ids.map((_, j) => {
    // Summed counts over the padded grid: points with all of slot j, and points with any.
    const full = new Int32Array((P + 1) * (P + 1)), some = new Int32Array((P + 1) * (P + 1));
    const a = amounts[j];
    for (let y = 0; y < P; y++) {
      let rf = 0, rs = 0;
      for (let x = 0; x < P; x++) {
        const v = a[y * P + x];
        rf += v === 255 ? 1 : 0;
        rs += v > 0 ? 1 : 0;
        full[(y + 1) * (P + 1) + x + 1] = full[y * (P + 1) + x + 1] + rf;
        some[(y + 1) * (P + 1) + x + 1] = some[y * (P + 1) + x + 1] + rs;
      }
    }
    return { full, some };
  });
  const box = (t, x0, y0, x1, y1) => t[(y1 + 1) * (P + 1) + x1 + 1] - t[y0 * (P + 1) + x1 + 1] - t[(y1 + 1) * (P + 1) + x0] + t[y0 * (P + 1) + x0];
  const kind = new Int8Array(N * N); // -1 empty, j + 1 all slot j, 0 mixed
  for (let cy_ = my0 / UP; cy_ < my1 / UP; cy_++) {
    for (let cx_ = mx0 / UP; cx_ < mx1 / UP; cx_++) {
      const x0 = Math.max(0, cx_ + PAD - reach), x1 = Math.min(P - 1, cx_ + PAD + reach);
      const y0 = Math.max(0, cy_ + PAD - reach), y1 = Math.min(P - 1, cy_ + PAD + reach);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      let k = -1;
      for (let j = 0; j < ids.length; j++) {
        const n = box(sat[j].some, x0, y0, x1, y1);
        if (!n) continue;
        k = n === area && box(sat[j].full, x0, y0, x1, y1) === area && k === -1 ? j + 1 : 0;
        if (k === 0) break;
      }
      kind[cy_ * N + cx_] = k;
    }
  }
  const used = new Uint8Array(ids.length); // which slots show at all in this chunk

  for (let my = my0; my < my1; my++) {
    const mrow = (my - my0) * mw - mx0;
    const gy = ((my + 0.5) / UP) * FS;
    const gy0 = Math.min(F - 2, Math.floor(gy));
    const krow = Math.floor(my / UP) * N;
    for (let mx = mx0; mx < mx1; mx++) {
      const kd = kind[krow + Math.floor(mx / UP)];
      if (kd === -1) continue;
      if (kd > 0) { masks[kd - 1][(mrow + mx) * 4 + 3] = 255; used[kd - 1] = 1; continue; }
      const gx = ((mx + 0.5) / UP) * FS;
      const gx0 = Math.min(F - 2, Math.floor(gx));
      fi = gy0 * F + gx0; ffx = gx - gx0; ffy = gy - gy0;
      // This pixel's place among the points (the padded grid: point 0 is at PAD), nudged by
      // noise so edges wander however hard the brush was.
      let tx = (mx + 0.5) / UP - 0.5 + PAD, ty = (my + 0.5) / UP - 0.5 + PAD;
      if (wob) { tx += wob * at(wx); ty += wob * at(wy); }
      const x0 = Math.floor(tx), fx = tx - x0;
      const y0 = Math.floor(ty), fy = ty - y0;
      const i00 = y0 * P + x0;
      let sum = 0;
      for (let j = 0; j < ids.length; j++) {
        const a = amounts[j];
        const top = a[i00] + (a[i00 + 1] - a[i00]) * fx;
        const bot = a[i00 + P] + (a[i00 + P + 1] - a[i00 + P]) * fx;
        w[j] = (top + (bot - top) * fy) / 255;
        sum += w[j];
      }
      if (sum <= 0.002) continue;
      // Outside's share competes too, with the roughest edge of the slots here.
      let base = Math.max(0, 1 - sum), bAmp = 0, bPow = 1, total = 0;
      for (let j = 0; j < ids.length; j++) {
        if (w[j] > 0.002) { if (amp[j] > bAmp) bAmp = amp[j]; if (pow[j] > bPow) bPow = pow[j]; }
        const x = w[j] > 0.002 ? w[j] + (amp[j] ? amp[j] * at(slotNoise[j]) : 0) : 0;
        p[j] = x > 0 ? (pow[j] === 1 ? x : x ** pow[j]) : 0;
        total += p[j];
      }
      if (base > 0) {
        const x = base + (bAmp ? bAmp * at(baseNoise) : 0);
        base = x > 0 ? (bPow === 1 ? x : x ** bPow) : 0;
      }
      total += base;
      if (total <= 0) continue;
      const o = (mrow + mx) * 4 + 3;
      for (let j = 0; j < ids.length; j++) if (p[j]) { masks[j][o] = (p[j] / total) * 255; used[j] = 1; }
    }
  }

  if (!maskCanvas) { maskCanvas = document.createElement('canvas'); maskCanvas.width = maskCanvas.height = M; }
  if (!layerCanvas) layerCanvas = document.createElement('canvas');
  if (layerCanvas.width !== size) { layerCanvas.width = size; layerCanvas.height = size; }
  const mc = maskCanvas.getContext('2d');
  const lc = layerCanvas.getContext('2d');
  let waiting = false; // a texture still loading: drawn as a flat colour for now
  // The layer is drawn in scene pixels (so textures line up from chunk to chunk), shrunk to fit.
  const k_ = px / g;
  out.globalCompositeOperation = 'lighter';
  const sc = size / M;
  for (let j = 0; j < ids.length; j++) {
    if (!used[j]) continue;
    mc.putImageData(new ImageData(masks[j], mw, mh), mx0, my0);
    const slot = slots[ids[j]];
    lc.save();
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.beginPath();
    lc.rect(X, Y, W, H);
    lc.clip();
    lc.clearRect(X, Y, W, H);
    lc.setTransform(k_, 0, 0, k_, -cx * CHUNK * g * k_, -cy * CHUNK * g * k_);
    if (!fill(lc, slot.material, g * (slot.scale || 1), { x: cx * CHUNK * g + X / k_, y: cy * CHUNK * g + Y / k_, w: W / k_, h: H / k_ })) waiting = true;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.globalCompositeOperation = 'destination-in';
    lc.imageSmoothingEnabled = true;
    lc.imageSmoothingQuality = 'high';
    lc.drawImage(maskCanvas, mx0, my0, mw, mh, mx0 * sc, my0 * sc, mw * sc, mh * sc);
    lc.restore();
    out.drawImage(layerCanvas, X, Y, W, H, X, Y, W, H);
  }
  out.globalCompositeOperation = 'source-over';
  return waiting;
  }
}
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/**
 * Draw a scene's terrain (scene coordinates). `fill(ctx, material, g, rect)` paints a material
 * over a rect of the scene, its pattern placed by the scene's origin (false: not loaded yet). Chunks that changed are
 * drawn again, a few a frame; `again()` asks for another frame when some are left.
 */
export function drawTerrain(ctx, s, terrain, g, fill, again) {
  sync(s.id, terrain);
  const chunks = chunksFor(s.id);
  if (!chunks.size) return;
  const slots = terrain?.slots ?? {};
  const sig = `${g}|${JSON.stringify(slots)}|${texturesRev}`;
  // How far edges wander: the most ragged texture's say (one amount for the whole map, so
  // chunks meet without a seam).
  const warp = WARP * Math.max(0, ...Object.values(slots).map((x) => clamp01(x.edge)));
  let budget = 6;
  const now = performance.now();
  for (const [k, e] of chunks) {
    if (e.sig !== sig) { e.sig = sig; e.dirty = true; e.rect = null; }
    if (e.dirty && budget > 0 && !(e.wait > now)) {
      const rect = e.rect;
      e.dirty = false;
      e.rect = null;
      budget--;
      // A texture still loading: try again in a moment.
      if (bake(e, k, chunks, slots, g, fill, warp, rect)) { e.dirty = true; e.wait = now + 400; setTimeout(again, 450); }
    } else if (e.dirty && !(e.wait > now)) again();
    if (!e.canvas) continue;
    const [cx, cy] = chunkOf(k);
    ctx.drawImage(e.canvas, cx * CHUNK * g, cy * CHUNK * g, CHUNK * g, CHUNK * g);
  }
}

let texturesRev = 0;
/** A texture changed or its picture arrived: draw every chunk again. */
export function terrainTexturesChanged() { texturesRev++; }

/** Forget a scene's chunks (its terrain, or another layer, was erased). */
export function forgetTerrain(sceneId, layer = 'terrain') { scenes.delete(`${layer}|${sceneId}`); }
