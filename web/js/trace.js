// Hearthfire — tracing buildings off a scene's map picture (the sketch-trace tool).
//
// The map is read once into a grid of lightness (each pixel's brightest channel, so a dark red
// roof isn't taken for ink). Its lightness splits three ways (the darkest
// third are lines, the lightest are streets and open ground, what's between is the buildings'
// fill); the splits are found from the picture (three-class Otsu) and can be moved.
//
//   buildings  a building is a patch of not-line pixels closed in by lines: filled from the
//              click, grown halfway into its outline (so walls sit on the middle of the line and
//              neighbours share them), its edge followed and simplified, and (straighten) its
//              sides squared to the building's own angle.
//   blocks     a block is a patch of not-street pixels: buildings and the lines between them,
//              all one shape, its walls round the outside.
//
// Outlines come back as corners in grid squares, ready for sketch.buildings.

const MAX_PIXELS = 16e6; // bigger maps are read scaled down to this
const cache = new Map(); // url → Promise of what was read

/** Read a scene's map picture: null if it has none, or it's a video. */
export function mapPixels(s) {
  const url = s?.background;
  if (!url || /\.(mp4|webm|m4v|mov|ogv)(\?|#|$)/i.test(url)) return Promise.resolve(null);
  if (!cache.has(url)) {
    cache.set(url, new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try { resolve(read(img)); } catch (e) { console.warn('trace: cannot read the map', e); resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    }));
    if (cache.size > 3) cache.delete(cache.keys().next().value);
  }
  return cache.get(url);
}

function read(img) {
  const nw = img.naturalWidth, nh = img.naturalHeight;
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (nw * nh)));
  const w = Math.max(1, Math.round(nw * k)), h = Math.max(1, Math.round(nh * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const lum = new Uint8Array(w * h);
  const sat = new Uint8Array(w * h); // how coloured: brightest channel less dullest
  const hist = new Float64Array(256);
  // In strips, so a big map doesn't need all its RGBA at once.
  const STRIP = 512;
  for (let y0 = 0; y0 < h; y0 += STRIP) {
    const sh = Math.min(STRIP, h - y0);
    const d = ctx.getImageData(0, y0, w, sh).data;
    for (let i = 0, j = y0 * w; i < d.length; i += 4, j++) {
      // Transparent counts as open ground.
      // Its brightest channel: ink is dark in all three, a red or green roof is bright in one.
      const v = d[i + 3] < 128 ? 255 : Math.max(d[i], d[i + 1], d[i + 2]);
      lum[j] = v;
      sat[j] = d[i + 3] < 128 ? 0 : v - Math.min(d[i], d[i + 1], d[i + 2]);
      hist[v]++;
    }
  }
  c.width = c.height = 0;
  const [t1, t2] = otsu3(hist);
  const px = { w, h, nw, nh, lum, sat, t1, t2 };
  px.thick = lineWidth(px, t1);
  return px;
}

/** Two thresholds splitting a histogram into three classes with the most between-class variance. */
function otsu3(hist) {
  const P = new Float64Array(257), S = new Float64Array(257);
  for (let i = 0; i < 256; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
  const part = (a, b) => { const n = P[b] - P[a]; return n > 0 ? ((S[b] - S[a]) ** 2) / n : 0; };
  let best = -1, t1 = 85, t2 = 170;
  for (let a = 1; a < 255; a++) {
    for (let b = a + 1; b < 256; b++) {
      const v = part(0, a) + part(a, b) + part(b, 256);
      if (v > best) { best = v; t1 = a; t2 = b; }
    }
  }
  // t1: the last line value; t2: the last fill value.
  return [t1 - 1, t2 - 1];
}

/** The usual width of the lines (pixels): the middle of the short dark runs along rows and columns. */
function lineWidth({ w, h, lum }, t1) {
  const counts = new Uint32Array(16);
  const stepY = Math.max(1, Math.floor(h / 400)), stepX = Math.max(1, Math.floor(w / 400));
  const run = (get, n) => {
    let len = 0, open = false;
    for (let i = 0; i < n; i++) {
      if (get(i) <= t1) len++;
      else { if (open && len > 0 && len < 16) counts[len]++; len = 0; open = true; }
    }
  };
  for (let y = 0; y < h; y += stepY) run((x) => lum[y * w + x], w);
  for (let x = 0; x < w; x += stepX) run((y) => lum[y * w + x], h);
  let total = 0;
  for (const c of counts) total += c;
  let acc = 0;
  for (let i = 1; i < 16; i++) { acc += counts[i]; if (acc >= total / 2) return i; }
  return 2;
}

/**
 * Where the picture lies on the scene: scene x = ox + ix · bx (and y) for picture pixel ix
 * (as read, scaled), as the board draws it (placed, or stretched over the scene).
 */
export function placement(s, px) {
  const f = s.background_fit;
  if (f && f.sx > 0 && f.sy > 0) return { ox: f.x, oy: f.y, bx: (f.sx * px.nw) / px.w, by: (f.sy * px.nh) / px.h };
  return { ox: 0, oy: 0, bx: s.width / px.w, by: s.height / px.h };
}

/** Is a pixel open (inside what's traced)? buildings: not a line; blocks: not street. */
const openTest = (px, mode, o) => {
  const { lum } = px;
  const t1 = o.t1 ?? px.t1, t2 = o.t2 ?? px.t2;
  return mode === 'blocks' ? (i) => lum[i] <= t2 : (i) => lum[i] > t1;
};

/**
 * Flood a region from pixel `start` within the box [x0, x1) × [y0, y1); `mark` (Int32Array of
 * w·h) gets `id` on its pixels. Stops (returns null) past `limit` pixels.
 */
function flood(px, open, mark, id, start, box, limit = Infinity) {
  const { w } = px;
  const stack = [start];
  mark[start] = id;
  const pix = [];
  let touches = false;
  while (stack.length) {
    const i = stack.pop();
    pix.push(i);
    if (pix.length > limit) return null;
    const x = i % w, y = (i - x) / w;
    if (x === box.x0 || x === box.x1 - 1 || y === box.y0 || y === box.y1 - 1) touches = true;
    if (x > box.x0) { const j = i - 1; if (!mark[j] && open(j)) { mark[j] = id; stack.push(j); } }
    if (x < box.x1 - 1) { const j = i + 1; if (!mark[j] && open(j)) { mark[j] = id; stack.push(j); } }
    if (y > box.y0) { const j = i - w; if (!mark[j] && open(j)) { mark[j] = id; stack.push(j); } }
    if (y < box.y1 - 1) { const j = i + w; if (!mark[j] && open(j)) { mark[j] = id; stack.push(j); } }
  }
  return { pix, touches };
}

/**
 * A region's outline: its pixels in a local mask (grown `grow` pixels into lines for buildings),
 * the outside edge followed, simplified and maybe squared. Corners in picture pixels.
 */
function outlineOf(px, pix, mode, o) {
  const { w, h, lum } = px;
  const t1 = o.t1 ?? px.t1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of pix) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const grow = mode === 'blocks' ? 0 : Math.max(0, Math.round(px.thick / 2));
  const pad = grow + 1;
  const lx = x0 - pad, ly = y0 - pad, mw = x1 - x0 + 1 + pad * 2, mh = y1 - y0 + 1 + pad * 2;
  const m = new Uint8Array(mw * mh);
  for (const i of pix) { const x = i % w, y = (i - x) / w; m[(y - ly) * mw + (x - lx)] = 1; }
  // Grow into the outline (line pixels only), a ring at a time.
  let ring = [];
  for (let y = 1; y < mh - 1; y++) for (let x = 1; x < mw - 1; x++) if (m[y * mw + x]) ring.push(y * mw + x);
  for (let step = 1; step <= grow; step++) {
    const next = [];
    for (const j of ring) {
      for (const d of [-1, 1, -mw, mw, -mw - 1, -mw + 1, mw - 1, mw + 1]) {
        const k = j + d;
        if (m[k]) continue;
        const kx = (k % mw) + lx, ky = Math.floor(k / mw) + ly;
        if (kx < 0 || ky < 0 || kx >= w || ky >= h || kx - lx <= 0 || ky - ly <= 0 || kx - lx >= mw - 1 || ky - ly >= mh - 1) continue;
        if (lum[ky * w + kx] > t1) continue;
        m[k] = step + 1;
        next.push(k);
      }
    }
    ring = next;
  }
  let pts = follow(m, mw, mh).map(([x, y]) => [x + lx, y + ly]);
  const eps = mode === 'blocks' ? Math.max(1.5, px.thick * 1.25) : Math.max(1.2, px.thick * 0.7);
  pts = simplify(pts, eps * (o.detail ?? 1));
  // Whether a squared-up shape keeps to its building: it may reach into the ink round it, and a
  // corner a pixel into the street, but barely onto a neighbour's roof. `loose`: allow a little more.
  const t2 = o.t2 ?? px.t2;
  const within = (poly, loose = false) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    let n = 0, street = 0, other = 0;
    for (let y = Math.floor(y0) + 0.5; y < y1; y += 0.5) {
      for (let x = Math.floor(x0) + 0.5; x < x1; x += 0.5) {
        if (!insidePoly(poly, x, y)) continue;
        n++;
        const mx = Math.floor(x) - lx, my = Math.floor(y) - ly;
        const X = Math.floor(x), Y = Math.floor(y);
        if (mx >= 0 && my >= 0 && mx < mw && my < mh && m[my * mw + mx]) continue;
        const v = X >= 0 && Y >= 0 && X < w && Y < h ? lum[Y * w + X] : 255;
        if (v <= t1) continue;
        // Grey between ink and street or roof is the line's blurred edge; a coloured pixel is a roof.
        if (v > t2) street++; else if (!px.sat || px.sat[Y * w + X] >= 28) other++;
      }
    }
    return !n || (other / n <= (loose ? 0.04 : 0.03) && street / n <= (loose ? 0.15 : 0.12));
  };
  // The box round what was traced at a turn, a few stray pixels at its edges left out.
  const extent = (c, sn) => {
    const us = [], vs = [];
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      if (!m[y * mw + x]) continue;
      const X = x + lx + 0.5, Y = y + ly + 0.5;
      us.push(X * c + Y * sn); vs.push(-X * sn + Y * c);
    }
    us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
    return [q(us, 0.015) - 0.25, q(us, 0.985) + 0.25, q(vs, 0.015) - 0.25, q(vs, 0.985) + 0.25];
  };
  if (o.straighten !== false && pts.length >= 4) pts = square(pts, eps, lineTurn(px, lx, ly, mw, mh) ?? lieOf(pts), within, extent);
  pts = tidy(pts, eps * 0.75);
  return pts.length >= 3 ? pts : null;
}

/**
 * A block's outline(s): the buildings in it traced (and straightened) one by one, drawn into a
 * finer mask, the gaps between neighbours closed, and the outside edge of what they make
 * followed. So a block's walls follow its buildings' own straight sides, not the jagged pixels.
 * Falls back to the block's own edge if it has no buildings. Corners in picture pixels.
 */
function blockOutlines(px, pix, o) {
  const { w, lum } = px;
  const t1 = o.t1 ?? px.t1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of pix) { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // The block's pixels, and the buildings in it: patches of fill closed in by lines.
  const inBlock = new Uint8Array(bw * bh);
  for (const i of pix) { const x = i % w, y = (i - x) / w; inBlock[(y - y0) * bw + (x - x0)] = 1; }
  const seen = new Uint8Array(bw * bh);
  const polys = [];
  for (let j = 0; j < bw * bh; j++) {
    if (!inBlock[j] || seen[j]) continue;
    const jx = j % bw, jy = (j - jx) / bw;
    if (lum[(jy + y0) * w + jx + x0] <= t1) continue;
    const comp = [], stack = [j];
    seen[j] = 1;
    while (stack.length) {
      const k = stack.pop();
      const kx = k % bw, ky = (k - kx) / bw;
      comp.push((ky + y0) * w + kx + x0);
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = kx + dx, ny = ky + dy, n = ny * bw + nx;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh || seen[n] || !inBlock[n] || lum[(ny + y0) * w + nx + x0] <= t1) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    if (comp.length < 4) continue; // a speck: a letter's hole, a dot
    const pts = outlineOf(px, comp, 'buildings', o);
    if (pts) polys.push(pts);
  }
  if (!polys.length) { const pts = outlineOf(px, pix, 'blocks', o); return pts ? [pts] : []; }
  // Into a mask S times finer, with room round it.
  const S = 4, pad = Math.ceil(px.thick * 2) + 2;
  const ox = x0 - pad, oy = y0 - pad, mw = (bw + pad * 2) * S, mh = (bh + pad * 2) * S;
  const m = new Uint8Array(mw * mh);
  for (const poly of polys) fillPoly(m, mw, mh, poly.map(([x, y]) => [(x - ox) * S, (y - oy) * S]));
  // Close the gaps between neighbours (a line's width): grow, then shrink back.
  const r = Math.max(1, Math.round(px.thick * S * 0.75));
  morph(m, mw, mh, r, 1);
  morph(m, mw, mh, r, 0);
  // Each piece's outside edge.
  const out = [];
  const done = new Uint8Array(mw * mh);
  for (let j = 0; j < m.length; j++) {
    if (!m[j] || done[j]) continue;
    const piece = [], stack = [j];
    done[j] = 1;
    let a = mw, b = mh, c = -1, d = -1;
    while (stack.length) {
      const k = stack.pop();
      piece.push(k);
      const kx = k % mw, ky = (k - kx) / mw;
      a = Math.min(a, kx); b = Math.min(b, ky); c = Math.max(c, kx); d = Math.max(d, ky);
      for (const n of [k - 1, k + 1, k - mw, k + mw]) {
        if (n < 0 || n >= m.length || done[n] || !m[n]) continue;
        if ((n === k - 1 && kx === 0) || (n === k + 1 && kx === mw - 1)) continue;
        done[n] = 1;
        stack.push(n);
      }
    }
    if (piece.length < S * S * 9) continue;
    const pw = c - a + 3, ph = d - b + 3;
    const pm = new Uint8Array(pw * ph);
    for (const k of piece) { const kx = k % mw, ky = (k - kx) / mw; pm[(ky - b + 1) * pw + (kx - a + 1)] = 1; }
    let pts = follow(pm, pw, ph).map(([x, y]) => [(x + a - 1) / S + ox, (y + b - 1) / S + oy]);
    pts = simplify(pts, 0.4);
    pts = tidy(pts, 0.3);
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}

/** Fill a polygon into a mask (pixel centres inside it, even–odd). */
function fillPoly(m, mw, mh, pts) {
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(mh - 1, Math.ceil(y1)); y++) {
    const cy = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay > cy) !== (by > cy)) xs.push(ax + ((cy - ay) * (bx - ax)) / (by - ay));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(mw - 1, Math.floor(xs[k + 1] - 0.5)); x++) m[y * mw + x] = 1;
    }
  }
}

/** Grow (`on` 1) or shrink (`on` 0) a mask by a square of radius r: a pass along rows, then columns. */
function morph(m, mw, mh, r, on) {
  const pass = (n, len, get, set) => {
    const row = new Uint8Array(len);
    for (let line = 0; line < n; line++) {
      // Distance to the nearest `on` pixel along the line, both ways: within r → on.
      for (let i = 0; i < len; i++) row[i] = get(line, i);
      let last = -Infinity;
      const near = new Float64Array(len);
      for (let i = 0; i < len; i++) { if (row[i] === on) last = i; near[i] = i - last; }
      last = Infinity;
      for (let i = len - 1; i >= 0; i--) { if (row[i] === on) last = i; near[i] = Math.min(near[i], last - i); }
      for (let i = 0; i < len; i++) set(line, i, near[i] <= r ? on : row[i]);
    }
  };
  pass(mh, mw, (y, x) => m[y * mw + x], (y, x, v) => { m[y * mw + x] = v; });
  pass(mw, mh, (x, y) => m[y * mw + x], (x, y, v) => { m[y * mw + x] = v; });
}

/**
 * Follow the outside edge of the shape in a mask (cracks between pixels, inside kept on the right,
 * so clockwise on screen), from its first pixel. Corners where it turns, in mask pixel corners.
 */
function follow(m, mw, mh) {
  let s = -1;
  for (let i = 0; i < m.length; i++) if (m[i]) { s = i; break; }
  if (s < 0) return [];
  const sx = s % mw, sy = (s - sx) / mw;
  const inside = (x, y) => x >= 0 && y >= 0 && x < mw && y < mh && m[y * mw + x] > 0;
  // Directions E, S, W, N; the pixels ahead-left and ahead-right of a corner, facing each.
  const D = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const AL = [[0, -1], [0, 0], [-1, 0], [-1, -1]];
  const AR = [[0, 0], [-1, 0], [-1, -1], [0, -1]];
  let x = sx, y = sy, dir = 0;
  const out = [];
  const limit = m.length * 4 + 8;
  for (let n = 0; n < limit; n++) {
    x += D[dir][0]; y += D[dir][1];
    if (x === sx && y === sy && dir === 3) break;
    let nd;
    if (inside(x + AL[dir][0], y + AL[dir][1])) nd = (dir + 3) % 4;
    else if (inside(x + AR[dir][0], y + AR[dir][1])) nd = dir;
    else nd = (dir + 1) % 4;
    if (nd !== dir) out.push([x, y]);
    dir = nd;
  }
  out.unshift([sx, sy]);
  return out;
}

const segDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/** Douglas–Peucker on a closed outline. */
function simplify(pts, eps) {
  if (pts.length < 4) return pts;
  // Split at the two corners furthest apart, and simplify each half.
  const far = (from) => { let best = 0, bi = 0; pts.forEach((p, i) => { const d = Math.hypot(p[0] - from[0], p[1] - from[1]); if (d > best) { best = d; bi = i; } }); return bi; };
  const a = far(pts[0]), b = far(pts[a]);
  const [i, j] = a < b ? [a, b] : [b, a];
  const dp = (chain) => {
    if (chain.length < 3) return chain;
    let best = 0, bi = 0;
    for (let k = 1; k < chain.length - 1; k++) { const d = segDist(chain[k], chain[0], chain.at(-1)); if (d > best) { best = d; bi = k; } }
    if (best <= eps) return [chain[0], chain.at(-1)];
    const l = dp(chain.slice(0, bi + 1)), r = dp(chain.slice(bi));
    return [...l.slice(0, -1), ...r];
  };
  const one = dp(pts.slice(i, j + 1));
  const two = dp([...pts.slice(j), ...pts.slice(0, i + 1)]);
  return [...one.slice(0, -1), ...two.slice(0, -1)];
}

/**
 * Which way the map's lines run round a building (radians, -45° to 45°): the picture's edges
 * (Sobel) in the box round it, their directions times four averaged, weighted by strength
 * squared. Null if there are no edges to go by.
 */
function lineTurn(px, lx, ly, mw, mh) {
  const { w, h, lum } = px;
  let sx = 0, sy = 0, total = 0;
  for (let y = Math.max(1, ly); y < Math.min(h - 1, ly + mh); y++) {
    for (let x = Math.max(1, lx); x < Math.min(w - 1, lx + mw); x++) {
      const i = y * w + x;
      const gx = lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1];
      const gy = lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1];
      const m2 = gx * gx + gy * gy;
      if (!m2) continue;
      const t = Math.atan2(gy, gx) * 4;
      sx += Math.cos(t) * m2; sy += Math.sin(t) * m2; total += m2;
    }
  }
  if (!total || Math.hypot(sx, sy) < total * 0.15) return null;
  return Math.atan2(sy, sx) / 4;
}

/** The turn (radians, -45° to 45°) of the smallest rectangle round some points: one of the convex hull's sides. */
function lieOf(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q); }
  const hull = [...lo.slice(0, -1), ...hi.slice(0, -1)];
  let best = Infinity, turn = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const t = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(t), s = Math.sin(t);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) { const u = x * c + y * s, v = -x * s + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best - 1e-9) { best = area; turn = t; }
  }
  return turn - Math.round(turn / (Math.PI / 2)) * (Math.PI / 2);
}

/**
 * Square a building up: sides within 15° of its main direction (or square to it) are turned to
 * it exactly, runs of sides the same way become one, and the corners are where the sides meet.
 */
function square(pts, eps, turn, within = () => true, extent = null) {
  const n = pts.length;
  const edges = pts.map((a, i) => { const b = pts[(i + 1) % n]; return { a, b, dx: b[0] - a[0], dy: b[1] - a[1], len: Math.hypot(b[0] - a[0], b[1] - a[1]) }; });
  // The way it lies (modulo 90°): the turn of the smallest box that fits round it, which the
  // pixel steps at its corners don't sway.
  let main = turn;
  // Within a few degrees of square to the map: square to it (a pixel's slant isn't a turn).
  if (Math.abs(main) < (4 * Math.PI) / 180) main = 0;
  // Nearly filling the box round it at that turn: a plain rectangle (most buildings are; a small
  // one's pixels can't say better).
  {
    const c = Math.cos(main), sn = Math.sin(main);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of pts) { const u = x * c + y * sn, v = -x * sn + y * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    // (Too small for a wing or a notch to be real: looser.)
    const fill = Math.min(u1 - u0, v1 - v0) < eps * 9 ? 0.6 : 0.84;
    if (area(pts) >= fill * (u1 - u0) * (v1 - v0)) {
      const at = (u, v) => [u * c - v * sn, u * sn + v * c];
      const [a0, a1, b0, b1] = extent ? extent(c, sn) : [u0, u1, v0, v1];
      const rect = [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)];
      if (within(rect)) return rect;
    }
  }
  const lines = edges.map((e) => {
    const ang = Math.atan2(e.dy, e.dx);
    const q = Math.round((ang - main) / (Math.PI / 2));
    const off = ang - main - q * (Math.PI / 2);
    const snapped = Math.abs(off) <= (15 * Math.PI) / 180;
    const t = snapped ? main + q * (Math.PI / 2) : ang;
    return { p: [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], d: [Math.cos(t), Math.sin(t)], key: snapped ? ((q % 4) + 4) % 4 : null, len: e.len };
  });
  // Short sides that aren't square to it are a corner's pixel steps: drop them, so the sides either
  // side meet in a corner.
  const longest = Math.max(...lines.map((l) => l.len));
  for (let i = lines.length - 1; i >= 0 && lines.length > 3; i--) if (lines[i].key === null && lines[i].len < Math.max(eps * 2.5, longest * 0.3)) lines.splice(i, 1);
  // Neighbouring sides the same way: one side, through their length-weighted middle.
  const merged = [];
  for (const l of lines) {
    const last = merged.at(-1);
    if (last && l.key !== null && last.key === l.key) {
      const t = last.len + l.len;
      last.p = [(last.p[0] * last.len + l.p[0] * l.len) / t, (last.p[1] * last.len + l.p[1] * l.len) / t];
      last.len = t;
    } else merged.push({ ...l });
  }
  if (merged.length > 1 && merged[0].key !== null && merged[0].key === merged.at(-1).key) {
    const f = merged.shift(), l = merged.at(-1), t = f.len + l.len;
    l.p = [(f.p[0] * f.len + l.p[0] * l.len) / t, (f.p[1] * f.len + l.p[1] * l.len) / t];
    l.len = t;
  }
  if (merged.length < 3) return pts;
  const out = [];
  for (let i = 0; i < merged.length; i++) {
    const A = merged[(i + merged.length - 1) % merged.length], B = merged[i];
    const den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (Math.abs(den) < 0.2) continue; // nearly parallel: no corner between them
    const t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / den;
    out.push([A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t]);
  }
  if (out.length < 3) return pts;
  // A corner flung far off (a sliver of a side) means squaring went wrong: keep it as it was.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const slack = Math.max(eps * 3, 2);
  if (out.some(([x, y]) => x < x0 - slack || x > x1 + slack || y < y0 - slack || y > y1 + slack)) return pts;
  return within(out, true) ? out : pts;
}

/** Drop corners closer than `near` to the last, and corners in a straight line. */
function tidy(pts, near) {
  let out = [];
  for (const p of pts) { const q = out.at(-1); if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= near) out.push(p); }
  while (out.length > 3 && Math.hypot(out[0][0] - out.at(-1)[0], out[0][1] - out.at(-1)[1]) < near) out.pop();
  for (let changed = true; changed && out.length > 3;) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      if (segDist(b, a, c) < near * 0.5) { out.splice(i, 1); changed = true; i--; }
    }
  }
  return out;
}

const insidePoly = (poly, x, y) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };

/** Picture corners → grid squares. */
const toSquares = (pts, pl, g) => pts.map(([x, y]) => [Math.round(((pl.ox + x * pl.bx) / g) * 1000) / 1000, Math.round(((pl.oy + y * pl.by) / g) * 1000) / 1000]);

/**
 * The building (or block) under a scene point: { polys } in squares (a block can come out in
 * pieces), or { error }.
 * Options: { t1, t2 (thresholds), straighten, detail, maxSquares (biggest area) }.
 */
export function traceAt(s, px, pt, mode, o = {}) {
  const pl = placement(s, px), g = s.grid?.size ?? 70;
  const ix = Math.floor((pt.x - pl.ox) / pl.bx), iy = Math.floor((pt.y - pl.oy) / pl.by);
  if (ix < 0 || iy < 0 || ix >= px.w || iy >= px.h) return { error: 'That\'s off the map picture.' };
  const open = openTest(px, mode, o);
  let start = iy * px.w + ix;
  if (!open(start)) {
    // On a line: the nearest open pixel within the line's width.
    const r = px.thick + 1;
    let best = null;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = ix + dx, y = iy + dy;
      if (x < 0 || y < 0 || x >= px.w || y >= px.h || !open(y * px.w + x)) continue;
      const d = dx * dx + dy * dy;
      if (!best || d < best.d) best = { d, i: y * px.w + x };
    }
    if (!best) return { error: mode === 'blocks' ? 'That\'s street: click a block.' : 'That\'s a line: click inside a building.' };
    start = best.i;
  }
  const sqPx = (g * g) / (pl.bx * pl.by); // picture pixels in a square
  const maxSq = o.maxSquares ?? 400;
  const mark = new Int32Array(px.w * px.h);
  const r = flood(px, open, mark, 1, start, { x0: 0, y0: 0, x1: px.w, y1: px.h }, Math.ceil(maxSq * sqPx));
  if (!r || r.touches) return { error: `That isn't closed in (or is bigger than ${maxSq} squares): ${mode === 'blocks' ? 'blocks are what\'s between the streets' : 'click inside a building\'s outline'}.` };
  const polys = mode === 'blocks' ? blockOutlines(px, r.pix, o) : [outlineOf(px, r.pix, mode, o)].filter(Boolean);
  if (!polys.length) return { error: 'Too small to trace.' };
  return { polys: polys.map((pts) => toSquares(pts, pl, g)) };
}

/**
 * Every building (or block) wholly inside a scene rectangle { x0, y0, x1, y1 }: [poly] in
 * squares. Those touching the rectangle's edge are left out (they go on past it), as are
 * specks (smaller than `minSquares`) and anything bigger than `maxSquares`; `skipGrey`: grey
 * patches too (buildings coloured, water and roads grey).
 */
export function traceBox(s, px, rect, mode, o = {}) {
  const pl = placement(s, px), g = s.grid?.size ?? 70;
  const box = {
    x0: Math.max(0, Math.floor((rect.x0 - pl.ox) / pl.bx)), y0: Math.max(0, Math.floor((rect.y0 - pl.oy) / pl.by)),
    x1: Math.min(px.w, Math.ceil((rect.x1 - pl.ox) / pl.bx)), y1: Math.min(px.h, Math.ceil((rect.y1 - pl.oy) / pl.by)),
  };
  if (box.x1 - box.x0 < 3 || box.y1 - box.y0 < 3) return [];
  const open = openTest(px, mode, o);
  const sqPx = (g * g) / (pl.bx * pl.by);
  const maxPix = (o.maxSquares ?? 400) * sqPx;
  const minPix = Math.max(9, (o.minSquares ?? 0.15) * sqPx, (px.thick * 2.5) ** 2);
  const mark = new Int32Array(px.w * px.h);
  const out = [];
  let id = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = y * px.w + x;
      if (mark[i] || !open(i)) continue;
      const r = flood(px, open, mark, ++id, i, box);
      if (r.touches || r.pix.length < minPix || r.pix.length > maxPix) continue;
      // Grey (water, roads, yards, a graveyard) when buildings are coloured: left out.
      if (o.skipGrey && px.sat) {
        let sum = 0;
        for (const k of r.pix) sum += px.sat[k];
        if (sum / r.pix.length < 28) continue;
      }
      const polys = mode === 'blocks' ? blockOutlines(px, r.pix, o) : [outlineOf(px, r.pix, mode, o)].filter(Boolean);
      for (const pts of polys) if (area(pts) >= minPix * 0.5) out.push(toSquares(pts, pl, g));
    }
  }
  return out;
}
