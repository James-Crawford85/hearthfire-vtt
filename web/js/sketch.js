// Sketched maps (GM): rooms and floors painted onto the grid, round rooms, walls, doors, windows
// and light sources. Drawn over the scene's map, under the grid.
//
// scene.sketch (positions in grid squares, so the sketch follows the grid):
//   cells   { "col,row": material }   room squares: walls along the rooms' edges
//   floor   { "col,row": material }   floor without walls (porches, paths, water)
//   edges   { "h:col,row" | "v:col,row": "wall" | "open" | "door" | "secret_door" | "window" }
//           a square's top (h) or left (v) edge, as the GM set it; "open" takes a room's wall away.
//           "d:col,row" (\) and "u:col,row" (/) are a square's diagonals (walls at 45°): a square
//           crossed by one is cut into two triangles, each floored or not (splitSquares)
//   shapes  { id: { kind: "circle", x, y, r, material, walled, openings } }   round rooms and floors;
//           openings { id: { at (degrees round, 0 = east, clockwise), width (squares), kind } }
//           are doors and windows set in a round room's curved wall
//   roofs   { id: { x, y, w, h, material, ridge, shape, cuts } }   roofs; touching ones join up,
//           `shape` ("cone", "facets", "dome") makes one round, and `cuts` { nw, ne, se, sw }
//           cuts a hipped one's corners off at 45° by so many squares (to follow diagonal walls)
//   lines   { id: { a: [x, y], b: [x, y], kind } }                walls off the grid lines
//   buildings { id: { poly: [[x, y], …], material, roof, walled, wall_style } }   buildings traced
//           from the map (sketch-trace): outlines at any angle; no material shows the map, no roof
//           has none. Their walls aren't sent as walls: buildingWalls works them out where needed
//           (sight, movement, sound), as the server does for movement
//   props   { id: { kind, x, y } }                                  light sources (torch, …)
//   outside material | null,  walls: bool (rooms get walls),  size: grid px the walls are for
//   terrain { slots, chunks }   ground textures painted freely over outside (terrain.js)
//   water   { bodies, chunks, flow, animate }   oceans, lakes and rivers over that (water.js)
// A material is a built-in texture id (sketch-textures.js) or an uploaded image's URL; a URL
// ending "#px=N" is drawn at N pixels a square (textures imported from Dungeondraft packs).
//
// The walls and lights are ordinary walls and lights with ids starting `sk-`, worked out here
// (sketchWalls, sketchLights) and sent with each change; the server only stores them:
//   sk-w-<n>  walls along rooms and round rooms   sk-e-<n>  edges set to wall   sk-x-<id>  a line
//   sk-d-<edge>  a door    sk-n-<edge>  a window    sk-p-<id>  a light source's light
//   (a door or window in a round wall has o:<shape>:<opening> for its edge)

import { texture, TILE_SQUARES, TILE_SIZE } from './sketch-textures.js';
import { isGM, mergePatch } from './store.js';
import { hooks } from './hooks.js';
import { macroOf, macroPattern } from './texture-recipes.js';
import { propDef, isLight, propOutline, drawPropAt, propLightColor } from './sketch-props.js';
import { skId, onLevel, sketchOf } from './levels.js';
import { groupRects, roofShape, ROUND_ROOFS, straightSkeleton, roofFaces } from './roof-skeleton.js';
import { drawTerrain, terrainTexturesChanged } from './terrain.js';
import { drawWater, waterTexturesChanged } from './water.js';
import { animatedMaps } from './media.js';
import { pxOfMaterial } from './dd-pack.js';

/** "col,row" → [col, row]. */
export const cellOf = (k) => k.split(',').map(Number);
export const cellKey = (c, r) => `${c},${r}`;

const MAPS = ['cells', 'floor', 'edges', 'halves', 'shapes', 'lines', 'props', 'styles', 'roofs', 'buildings'];

/** A sketch with a change applied (null erases an entry; a whole map set to null empties it). */
export function withPatch(sk, patch) {
  const out = { outside: null, walls: true, size: 0, ...(sk ?? {}) };
  for (const k of MAPS) out[k] = { ...(sk?.[k] ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (k === 'terrain' || k === 'water') { out[k] = v === null ? null : mergePatch(structuredClone(out[k] ?? {}), v); continue; }
    if (!MAPS.includes(k)) { out[k] = v; continue; }
    if (v === null) { out[k] = {}; continue; }
    for (const [id, x] of Object.entries(v)) { if (x == null) delete out[k][id]; else out[k][id] = x; }
  }
  return out;
}

// ------------------------------------------------------------------ edges

/**
 * An edge key's segment in scene pixels: "h:c,r" is square (c, r)'s top, "v:c,r" its left;
 * the diagonals across it are "d:c,r" (top left to bottom right, \) and "u:c,r" (bottom left
 * to top right, /).
 */
export function edgeSegment(edge, g) {
  const [dir, rest] = edge.split(':');
  const [c, r] = cellOf(rest);
  if (dir === 'd') return { a: [c * g, r * g], b: [(c + 1) * g, (r + 1) * g] };
  if (dir === 'u') return { a: [c * g, (r + 1) * g], b: [(c + 1) * g, r * g] };
  return dir === 'h' ? { a: [c * g, r * g], b: [(c + 1) * g, r * g] } : { a: [c * g, r * g], b: [c * g, (r + 1) * g] };
}

/** Is an edge key one of a square's diagonals? */
export const isDiagonal = (edge) => edge[0] === 'd' || edge[0] === 'u';

/**
 * The diagonal edge set in the sketch near a point (scene px), within `tol` squares of it,
 * if there is one: `want(value)` chooses which (any set diagonal by default).
 */
export function diagonalNear(sk, w, g, tol = 0.25, want = (v) => !!v && v !== 'open') {
  const c0 = Math.floor(w.x / g), r0 = Math.floor(w.y / g);
  let best = null, bestD = tol * g;
  for (let c = c0 - 1; c <= c0 + 1; c++) {
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      for (const e of [`d:${c},${r}`, `u:${c},${r}`]) {
        if (!want(sk.edges?.[e])) continue;
        const { a, b } = edgeSegment(e, g);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / (dx * dx + dy * dy)));
        const d = Math.hypot(w.x - a[0] - t * dx, w.y - a[1] - t * dy);
        if (d < bestD) { best = e; bestD = d; }
      }
    }
  }
  return best;
}

/** The grid edge nearest a point (scene px), if it's within `tol` squares of it. */
export function edgeNear(w, g, tol = 0.25) {
  const fx = w.x / g, fy = w.y / g;
  const dx = Math.abs(fx - Math.round(fx)), dy = Math.abs(fy - Math.round(fy));
  if (Math.min(dx, dy) > tol) return null;
  return dy < dx ? `h:${Math.floor(fx)},${Math.round(fy)}` : `v:${Math.round(fx)},${Math.floor(fy)}`;
}

/** The unit edges along a grid line from corner a to corner b ([col, row]), or null if it isn't along one. */
export function edgesAlong(a, b) {
  const out = [];
  if (a[1] === b[1]) for (let c = Math.min(a[0], b[0]); c < Math.max(a[0], b[0]); c++) out.push(`h:${c},${a[1]}`);
  else if (a[0] === b[0]) for (let r = Math.min(a[1], b[1]); r < Math.max(a[1], b[1]); r++) out.push(`v:${a[0]},${r}`);
  else if (Math.abs(b[0] - a[0]) === Math.abs(b[1] - a[1])) {
    // At 45°: the diagonals of the squares it crosses.
    const [p, q] = a[0] < b[0] ? [a, b] : [b, a];
    for (let i = 0; i < q[0] - p[0]; i++) out.push(q[1] > p[1] ? `d:${p[0] + i},${p[1] + i}` : `u:${p[0] + i},${p[1] - 1 - i}`);
  } else return null;
  return out;
}

/**
 * Collinear unit edges merged into runs: [[dir, line, from, to], …]. A run along a diagonal
 * has `line` c − r (d) or c + r (u), and goes from column `from` to `to`.
 */
function runs(edges) {
  const lines = new Map();
  for (const e of edges) {
    const [dir, rest] = e.split(':');
    const [c, r] = cellOf(rest);
    const line = dir === 'h' ? r : dir === 'v' ? c : dir === 'd' ? c - r : c + r;
    const key = `${dir}${line}`;
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { dir, line, at: [] }));
    l.at.push(dir === 'v' ? r : c);
  }
  const out = [];
  for (const { dir, line, at } of lines.values()) {
    at.sort((x, y) => x - y);
    let start = at[0], prev = at[0];
    for (const p of at.slice(1)) {
      if (p === prev) continue;
      if (p !== prev + 1) { out.push([dir, line, start, prev + 1]); start = p; }
      prev = p;
    }
    out.push([dir, line, start, prev + 1]);
  }
  return out;
}

const runSeg = ([dir, line, a, b], g) => {
  if (dir === 'h') return { a: [a * g, line * g], b: [b * g, line * g] };
  if (dir === 'v') return { a: [line * g, a * g], b: [line * g, b * g] };
  if (dir === 'd') return { a: [a * g, (a - line) * g], b: [b * g, (b - line) * g] };
  return { a: [a * g, (line - a + 1) * g], b: [b * g, (line - b + 1) * g] };
};
const SIDES = (c, r) => [[`h:${c},${r}`, cellKey(c, r - 1)], [`h:${c},${r + 1}`, cellKey(c, r + 1)], [`v:${c},${r}`, cellKey(c - 1, r)], [`v:${c + 1},${r}`, cellKey(c + 1, r)]];

// ------------------------------------------------------------------ squares cut in half

// A square crossed by a diagonal set in `edges` is two triangles, each named by the corner its
// right angle is in, and each with two sides of the square (its legs).
const SIDE_OF = { t: [0, -1, 'b'], b: [0, 1, 't'], l: [-1, 0, 'r'], r: [1, 0, 'l'] }; // side → [dc, dr, the neighbour's side]
export const TRIS = { d: { ne: ['t', 'r'], sw: ['l', 'b'] }, u: { nw: ['t', 'l'], se: ['r', 'b'] } };
const sideEdge = (c, r, s) => (s === 't' ? `h:${c},${r}` : s === 'b' ? `h:${c},${r + 1}` : s === 'l' ? `v:${c},${r}` : `v:${c + 1},${r}`);
/** A triangle's corners in squares (clockwise on the map, like a rectangle, so paths add up). */
const TRI_PTS = { ne: [[0, 0], [1, 0], [1, 1]], sw: [[0, 0], [1, 1], [0, 1]], nw: [[0, 0], [1, 0], [0, 1]], se: [[1, 0], [1, 1], [0, 1]] };

/** The diagonal set across a square, 'd' or 'u', if any (railings, doors and windows too). */
export function cutOf(edges, c, r) {
  for (const d of ['d', 'u']) { const v = edges?.[`${d}:${c},${r}`]; if (v && v !== 'open') return d; }
  return null;
}

/** A painted triangle, "room:<material>" | "floor:<material>" | "none", as { room, material } or null. */
export function parseHalf(v) {
  if (!v || v === 'none') return null;
  const i = v.indexOf(':');
  return { room: v.slice(0, i) === 'room', material: v.slice(i + 1) };
}
export const halfValue = (x) => (x ? `${x.room ? 'room' : 'floor'}:${x.material}` : 'none');

/** Which triangle of a cut square a point (squares) is in. */
const triOf = (cut, fx, fy) => (cut === 'd' ? (fx > fy ? 'ne' : 'sw') : (fx + fy < 1 ? 'nw' : 'se'));

/**
 * The piece of floor under a point (scene px): "c,r" for a whole square, "c,r|t" for a
 * triangle of a square cut by a diagonal.
 */
export function pieceAt(sk, w, g) {
  const x = w.x / g, y = w.y / g, c = Math.floor(x), r = Math.floor(y);
  const cut = cutOf(sk.edges, c, r);
  return cut ? `${cellKey(c, r)}|${triOf(cut, x - c, y - r)}` : cellKey(c, r);
}

/** A piece's outline (scene px): a square's four corners, a triangle's three. */
export function pieceOutline(piece, g) {
  const [k, t] = piece.split('|');
  const [c, r] = cellOf(k);
  return (t ? TRI_PTS[t] : [[0, 0], [1, 0], [1, 1], [0, 1]]).map(([px, py]) => [(c + px) * g, (r + py) * g]);
}

/**
 * The pieces of a rectangle of squares (keys) a room or floor dragged over it fills: all of
 * them, unless diagonals cut it up; then the biggest part they leave (the room inside diagonal
 * walls, not the corners beyond them). Squares cut by a diagonal come as their triangles.
 */
export function fillPieces(sk, keys) {
  const edges = sk.edges ?? {}, inRect = new Set(keys);
  const partsOf = (k) => { const [c, r] = cellOf(k), cut = cutOf(edges, c, r); return cut ? Object.keys(TRIS[cut]).map((t) => [t, TRIS[cut][t]]) : [['', ['t', 'b', 'l', 'r']]]; };
  if (!keys.some((k) => partsOf(k)[0][0])) return keys;
  const id = (k, t) => (t ? `${k}|${t}` : k);
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const k of keys) for (const [t] of partsOf(k)) parent.set(id(k, t), id(k, t));
  for (const k of keys) {
    const [c, r] = cellOf(k);
    for (const [t, legs] of partsOf(k)) {
      for (const s of legs) {
        const [dc, dr, back] = SIDE_OF[s], n = cellKey(c + dc, r + dr);
        if (!inRect.has(n)) continue;
        const q = partsOf(n).find(([, l]) => l.includes(back));
        if (q) parent.set(find(id(k, t)), find(id(n, q[0])));
      }
    }
  }
  const area = new Map();
  for (const x of parent.keys()) { const root = find(x); area.set(root, (area.get(root) ?? 0) + (x.includes('|') ? 0.5 : 1)); }
  const best = [...area].sort((a, b) => b[1] - a[1])[0][0];
  return [...parent.keys()].filter((x) => find(x) === best);
}

/**
 * How the painted squares crossed by diagonals are cut: Map("c,r" → { cut: 'd'|'u',
 * tris: { name: { room, material } | null } }). A triangle is kept while its legs both meet
 * floor of its kind (rooms meet rooms; floor meets any floor), so a diagonal across a room's
 * corner leaves the corner outside; one dividing a room keeps both halves; and a square cut
 * off on both sides stays whole. A room's triangle cut off where floor is beyond takes that
 * floor, so a yard or a porch runs up to a diagonal wall.
 */
export function splitSquares(sk) {
  const cells = sk.cells ?? {}, floor = sk.floor ?? {}, edges = sk.edges ?? {}, halves = sk.halves ?? {};
  const out = new Map();
  for (const k of [...Object.keys(cells), ...Object.keys(floor)]) {
    if (out.has(k)) continue;
    const [c, r] = cellOf(k);
    const cut = cutOf(edges, c, r);
    if (!cut) continue;
    const room = k in cells, material = cells[k] ?? floor[k];
    // Triangles painted one at a time are as painted; the others follow the square.
    const fixed = new Set(Object.keys(TRIS[cut]).filter((t) => halves[k]?.[t] != null));
    out.set(k, { cut, room, fixed, tris: Object.fromEntries(Object.keys(TRIS[cut]).map((t) => [t, fixed.has(t) ? parseHalf(halves[k][t]) : { room, material }])) });
  }
  // Does square k have a part of this kind (rooms only, or any floor) along side s?
  const covers = (k, s, roomOnly) => {
    if (!(k in cells) && (roomOnly || !(k in floor))) return false;
    const sp = out.get(k);
    if (!sp) return true;
    return Object.entries(sp.tris).some(([t, x]) => x && (!roomOnly || x.room) && TRIS[sp.cut][t].includes(s));
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, sp] of out) {
      const [c, r] = cellOf(k);
      for (const [t, x] of Object.entries(sp.tris)) {
        if (!x || sp.fixed.has(t)) continue;
        const open =TRIS[sp.cut][t].some((s) => { const [dc, dr, back] = SIDE_OF[s]; return !covers(cellKey(c + dc, r + dr), back, x.room); });
        if (open) { sp.tris[t] = null; changed = true; }
      }
    }
  }
  for (const [k, sp] of out) {
    const [c, r] = cellOf(k);
    const names = Object.keys(sp.tris);
    // Cut off both ways: whole after all.
    if (!sp.fixed.size && names.every((t) => !sp.tris[t])) { for (const t of names) sp.tris[t] = { room: sp.room, material: cells[k] ?? floor[k] }; continue; }
    // A room's triangle left outside takes the floor beyond it, if there is some.
    for (const t of names) {
      if (sp.tris[t] || !sp.room || sp.fixed.has(t)) continue;
      for (const s of TRIS[sp.cut][t]) {
        const [dc, dr] = SIDE_OF[s], n = cellKey(c + dc, r + dr);
        if (n in floor && !out.has(n)) { sp.tris[t] = { room: false, material: floor[n] }; break; }
      }
    }
  }
  return out;
}

/**
 * A diagonal wall just drawn (`along`, its diagonal edges, already in `sk`) across a room:
 * if it cuts the room in two, the room squares on its smaller side, to be taken away, so the
 * wall cuts the corner off. Nothing if it doesn't cut the room in two, or the sides are equal.
 */
export function cornerCut(sk, along) {
  const W = sk.cells ?? {}, edges = sk.edges ?? {};
  const partsOf = (k) => { const [c, r] = cellOf(k), cut = cutOf(edges, c, r); return cut ? Object.keys(TRIS[cut]) : ['full']; };
  const legs = (k, p) => { if (p === 'full') return ['t', 'b', 'l', 'r']; const [c, r] = cellOf(k); return TRIS[cutOf(edges, c, r)][p]; };
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const k of Object.keys(W)) for (const p of partsOf(k)) parent.set(`${k}|${p}`, `${k}|${p}`);
  for (const k of Object.keys(W)) {
    const [c, r] = cellOf(k);
    for (const p of partsOf(k)) {
      for (const s of legs(k, p)) {
        const [dc, dr, back] = SIDE_OF[s], n = cellKey(c + dc, r + dr);
        if (!(n in W)) continue;
        const q = partsOf(n).find((x) => legs(n, x).includes(back));
        if (q) parent.set(find(`${k}|${p}`), find(`${n}|${q}`));
      }
    }
  }
  const sides = [new Set(), new Set()];
  for (const e of along) {
    const [dir, rest] = e.split(':');
    if (!(rest in W) || !TRIS[dir]) continue;
    Object.keys(TRIS[dir]).forEach((t, i) => sides[i].add(find(`${rest}|${t}`)));
  }
  if (!sides[0].size || [...sides[0]].some((x) => sides[1].has(x))) return [];
  const area = new Map();
  for (const x of parent.keys()) { const root = find(x); area.set(root, (area.get(root) ?? 0) + (x.endsWith('|full') ? 1 : 0.5)); }
  const sum = (set) => [...set].reduce((n, x) => n + area.get(x), 0);
  const a0 = sum(sides[0]), a1 = sum(sides[1]);
  if (a0 === a1) return [];
  const small = a0 < a1 ? sides[0] : sides[1];
  return Object.keys(W).filter((k) => partsOf(k).every((p) => small.has(find(`${k}|${p}`))));
}

/** Is a point (squares) in a room, with the squares cut in half (`split`) taken into account? */
function inRoom(sk, split, x, y) {
  const c = Math.floor(x), r = Math.floor(y), k = cellKey(c, r);
  if (!(k in sk.cells)) return false;
  const sp = split.get(k);
  if (!sp) return true;
  const fx = x - c, fy = y - r;
  const t = sp.cut === 'd' ? (fx > fy ? 'ne' : 'sw') : (fx + fy < 1 ? 'nw' : 'se');
  return !!sp.tris[t]?.room;
}

/** Does a square have room along its side s (a whole room square, or a room triangle's leg)? */
function roomAlong(sk, split, c, r, s) {
  const k = cellKey(c, r);
  if (!(k in sk.cells)) return false;
  const sp = split.get(k);
  return !sp || Object.entries(sp.tris).some(([t, x]) => x?.room && TRIS[sp.cut][t].includes(s));
}

// ------------------------------------------------------------------ walls

/**
 * The walls for a sketch at grid size `g`, { id: wall }: along the edges of the rooms (squares
 * and round rooms, merged where they meet) except where the GM set an edge; the edges set to
 * walls, doors and windows; the lines; and round props that stand in the way.
 *
 * Each wall also says where it came from, for drawing and picking (strip these before sending):
 * `style` (how it's drawn) and `src`: { edges: [edge keys] } | { shape: id } | { line: id } |
 * { prop: id } | { opening: edge }.
 */
export function sketchWalls(sk, g, level = '') {
  sk = withPatch(sk, null);
  const W = sk.cells, edges = sk.edges;
  const base = sk.wall_style || 'ink';
  const styleOf = (e) => sk.styles[e] || base;
  const circles = Object.entries(sk.shapes).filter(([, s]) => s.walled !== false && s.r > 0);
  const split = splitSquares(sk);
  const inside = (x, y) => inRoom(sk, split, x / g, y / g)
    || circles.some(([, c]) => (x / g - c.x) ** 2 + (y / g - c.y) ** 2 < c.r * c.r);
  // A piece of wall belongs where one side is room and the other isn't. Sampled at a few points,
  // so where two shapes meet a wall runs a touch long rather than leaving a gap.
  const boundary = (p, q) => {
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    return [0.08, 0.5, 0.92].some((t) => {
      const x = p[0] + dx * t, y = p[1] + dy * t;
      return inside(x + nx * 0.5, y + ny * 0.5) !== inside(x - nx * 0.5, y - ny * 0.5);
    });
  };
  // The parts of a segment that are boundary, joined back up.
  const pieces = (a, b, out) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g / 8)));
    const at = (i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
    let start = null;
    for (let i = 0; i < n; i++) {
      const keep = boundary(at(i), at(i + 1));
      if (keep && !start) start = at(i);
      if (!keep && start) { out.push({ a: start, b: at(i) }); start = null; }
    }
    if (start) out.push({ a: start, b });
  };

  const out = {};
  let n = 0;
  const round = (p) => p.map((v) => Math.round(v * 100) / 100);
  const add = (id, seg, kind, style, src) => { id = skId(id, level); out[id] = { id, a: round(seg.a), b: round(seg.b), kind, open: false, locked: false, style, src, ...(level ? { level } : {}) }; };
  // Unit edges merged into runs, one style at a time.
  const addRuns = (prefix, list, kind = 'wall', fixed = null) => {
    const byStyle = new Map();
    for (const e of list) { const s = fixed ?? styleOf(e); if (!byStyle.has(s)) byStyle.set(s, []); byStyle.get(s).push(e); }
    for (const [style, es] of byStyle) for (const run of runs(es)) add(`${prefix}${n++}`, runSeg(run, g), kind, style, { edges: runEdges(run) });
  };

  if (sk.walls !== false) {
    const whole = [];
    const nearCircle = (seg) => circles.some(([, c]) => {
      const cx = c.x * g, cy = c.y * g, rr = c.r * g + g;
      return Math.max(seg.a[0], seg.b[0]) > cx - rr && Math.min(seg.a[0], seg.b[0]) < cx + rr
        && Math.max(seg.a[1], seg.b[1]) > cy - rr && Math.min(seg.a[1], seg.b[1]) < cy + rr;
    });
    for (const k of Object.keys(W)) {
      const [c, r] = cellOf(k);
      const sp = split.get(k);
      // A whole square's four sides; a cut one's room triangles' legs.
      const sides = sp ? [...new Set(Object.entries(sp.tris).filter(([, x]) => x?.room).flatMap(([t]) => TRIS[sp.cut][t]))] : ['t', 'b', 'l', 'r'];
      for (const s of sides) {
        const e = sideEdge(c, r, s), [dc, dr, back] = SIDE_OF[s];
        if (roomAlong(sk, split, c + dc, r + dr, back) || e in edges) continue;
        const seg = edgeSegment(e, g);
        if (!nearCircle(seg)) { whole.push(e); continue; }
        const cut = [];
        pieces(seg.a, seg.b, cut);
        for (const s of cut) add(`sk-w-${n++}`, s, 'wall', styleOf(e), { edges: [e] });
      }
    }
    addRuns('sk-w-', whole);
    for (const [id, c] of circles) {
      const sides = Math.max(16, Math.ceil(2 * Math.PI * c.r * 4));
      const pt = (a) => [(c.x + c.r * Math.cos(a)) * g, (c.y + c.r * Math.sin(a)) * g];
      // The wall runs round, broken where doors and windows are set in it.
      const ops = roundOpeningsOf(c);
      const angles = Array.from({ length: sides + 1 }, (_, i) => (i / sides) * 2 * Math.PI);
      for (const op of ops) angles.push(turn(op.a0), turn(op.a1));
      angles.sort((a, b) => a - b);
      const cut = [];
      for (let i = 0; i + 1 < angles.length; i++) {
        const a = angles[i], b = angles[i + 1];
        if (b - a < 1e-9 || ops.some((op) => within((a + b) / 2, op))) continue;
        pieces(pt(a), pt(b), cut);
      }
      for (const s of cut) add(`sk-w-${n++}`, s, 'wall', c.wall_style || base, { shape: id });
      for (const op of ops) {
        const key = `o:${id}:${op.id}`, seg = { a: pt(op.a0), b: pt(op.a1) };
        if (op.kind === 'window') add(`sk-n-${key}`, seg, 'window', null, { opening: key, shape: id });
        else add(`sk-d-${key}`, seg, op.kind, null, { opening: key, shape: id });
      }
    }
  }
  n = 0;
  addRuns('sk-e-', Object.keys(edges).filter((e) => edges[e] === 'wall'));
  // Railings: in the way, but you see (and shoot) over them.
  addRuns('sk-r-', Object.keys(edges).filter((e) => edges[e] === 'railing'), 'window', 'railing');
  for (const [e, kind] of Object.entries(edges)) {
    if (kind === 'door' || kind === 'secret_door') add(`sk-d-${e}`, edgeSegment(e, g), kind, null, { opening: e });
    else if (kind === 'window') add(`sk-n-${e}`, edgeSegment(e, g), 'window', null, { opening: e });
  }
  for (const [id, l] of Object.entries(sk.lines)) {
    if (l.a[0] !== l.b[0] || l.a[1] !== l.b[1]) add(`sk-x-${id}`, { a: [l.a[0] * g, l.a[1] * g], b: [l.b[0] * g, l.b[1] * g] }, l.style === 'railing' ? 'window' : l.kind || 'wall', l.style || base, { line: id });
  }
  // Props that stand in the way: walls round them (not drawn; the prop is).
  for (const [id, p] of Object.entries(sk.props)) {
    const def = propDef(p.kind);
    if (!p.blocks || !def.block) continue;
    const pts = propOutline(p, g);
    pts.forEach((a, i) => add(`sk-o-${id}-${i}`, { a, b: pts[(i + 1) % pts.length] }, def.block, null, { prop: id }));
  }
  return out;
}

/** A run's unit edges. */
function runEdges([dir, line, a, b]) {
  const out = [];
  for (let i = a; i < b; i++) out.push(dir === 'h' ? `h:${i},${line}` : `v:${line},${i}`);
  return out;
}

/** Walls ready to send: without the drawing details. */
export const plainWalls = (walls) => Object.fromEntries(Object.entries(walls).map(([id, w]) => [id, { id, a: w.a, b: w.b, kind: w.kind, open: w.open, locked: w.locked }]));

/** The light from each light source, { id: light }, with radii in the scene's distance units. */
export function sketchLights(sk, g, distance = 5, level = '') {
  const out = {};
  for (const [id, p] of Object.entries(sk?.props ?? {})) {
    if (!isLight(p.kind)) continue;
    const def = propDef(p.kind);
    const lid = skId(`sk-p-${id}`, level);
    // Its own light if it has one (set in its light's settings), else its kind's.
    const own = p.light;
    const bright = own ? Math.max(0, Number(own.bright) || 0) : def.bright * distance;
    const dim = own ? Math.max(bright, Number(own.dim) || 0) : def.dim * distance;
    out[lid] = {
      id: lid, x: Math.round(p.x * g), y: Math.round(p.y * g), bright, dim, color: propLightColor(p), off: false,
      ...(own?.tint != null ? { tint: own.tint } : {}), ...(own?.anim ? { anim: own.anim } : {}), ...(level ? { level } : {}),
    };
  }
  return out;
}

/** The ways to other levels: each prop that leads somewhere (stairs, a ladder…), its outline. */
export function sketchLinks(sk, g, level = '') {
  const out = {};
  for (const [id, p] of Object.entries(sk?.props ?? {})) {
    if (p.to == null) continue;
    const lid = skId(`sk-l-${id}`, level);
    out[lid] = { id: lid, poly: propOutline(p, g).map((q) => q.map((v) => Math.round(v * 100) / 100)), to: p.to, ...(level ? { level } : {}) };
  }
  return out;
}

// ------------------------------------------------------------------ drawing

let rev = 0;
/** Call when a scene's sketch changed (the store merges changes into the same object). */
export function sketchChanged() { rev++; }

const caches = new Map(); // level → what to draw

/** Everything to draw for a level, worked out once per change. */
function geometry(base, draft, g, level = '') {
  const key = `${rev}|${g}|${draft ? draft.rev : '-'}`;
  const cache = caches.get(level);
  if (cache && cache.key === key && cache.base === base) return cache;
  const sk = withPatch(base, draft?.patch ?? null);
  const all = { ...sk.floor, ...sk.cells };
  // Fills by material: same-material runs along each row make few rectangles.
  const byMat = new Map(), roomRegion = new Path2D(), floorEdge = new Path2D(), seams = new Path2D();
  const mat = (m) => { let p = byMat.get(m); if (!p) byMat.set(m, (p = new Path2D())); return p; };
  const rows = new Map();
  // Squares cut by a diagonal: a triangle on each side, each with its own floor (or none).
  const split = splitSquares(sk);
  const hasAlong = (c, r, s) => {
    const k = cellKey(c, r);
    if (!(k in all)) return false;
    const sp = split.get(k);
    return !sp || Object.entries(sp.tris).some(([t, x]) => x && TRIS[sp.cut][t].includes(s));
  };
  for (const [k, sp] of split) {
    const [c, r] = cellOf(k);
    const tris = Object.entries(sp.tris);
    for (const [t, x] of tris) {
      if (!x) continue;
      const tri = new Path2D(), pts = TRI_PTS[t];
      pts.forEach(([px, py], i) => (i ? tri.lineTo((c + px) * g, (r + py) * g) : tri.moveTo((c + px) * g, (r + py) * g)));
      tri.closePath();
      mat(x.material).addPath(tri);
      if (x.room) roomRegion.addPath(tri);
      for (const s of TRIS[sp.cut][t]) {
        const [dc, dr, back] = SIDE_OF[s];
        if (!hasAlong(c + dc, r + dr, back)) { const e = edgeSegment(sideEdge(c, r, s), g); floorEdge.moveTo(...e.a); floorEdge.lineTo(...e.b); }
      }
    }
    // Floor on one side only: the diagonal is its edge.
    if (tris.some(([, x]) => !x)) { const e = edgeSegment(`${sp.cut}:${c},${r}`, g); floorEdge.moveTo(...e.a); floorEdge.lineTo(...e.b); }
  }
  for (const [k, m] of Object.entries(all)) {
    if (split.has(k)) continue;
    const [c, r] = cellOf(k);
    let row = rows.get(r);
    if (!row) rows.set(r, (row = []));
    row.push([c, m]);
    if (k in sk.cells) roomRegion.rect(c * g, r * g, g, g);
    // The soft edge of all floor, and seams where materials meet.
    for (const [i, [e, next]] of SIDES(c, r).entries()) {
      const s = edgeSegment(e, g);
      const side = 'tblr'[i], [dc, dr, back] = SIDE_OF[side];
      if (!hasAlong(c + dc, r + dr, back)) { floorEdge.moveTo(...s.a); floorEdge.lineTo(...s.b); } else if (!split.has(next) && all[next] !== m && next > k) { seams.moveTo(...s.a); seams.lineTo(...s.b); }
    }
  }
  for (const [r, row] of rows) {
    row.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < row.length;) {
      let j = i;
      while (j + 1 < row.length && row[j + 1][0] === row[j][0] + 1 && row[j + 1][1] === row[i][1]) j++;
      mat(row[i][1]).rect(row[i][0] * g, r * g, (row[j][0] - row[i][0] + 1) * g, g);
      i = j + 1;
    }
  }
  // Round rooms and floors: walled ones first, so a round pond can sit in a room.
  const shapes = Object.values(sk.shapes).filter((s) => s.r > 0)
    .sort((a, b) => (b.walled !== false) - (a.walled !== false))
    .map((shape) => {
      const path = new Path2D();
      path.arc(shape.x * g, shape.y * g, shape.r * g, 0, Math.PI * 2);
      if (shape.walled !== false) roomRegion.addPath(path); else floorEdge.addPath(path);
      return { shape, path };
    });
  // Walls to draw: all together (for shadows), and by style. Props draw their own.
  const walls = sketchWalls(sk, g, level);
  const wallPath = new Path2D(), byStyle = new Map(), railings = new Path2D();
  for (const w of Object.values(walls)) {
    if (w.style === 'railing') { railings.moveTo(w.a[0], w.a[1]); railings.lineTo(w.b[0], w.b[1]); continue; }
    if (w.kind !== 'wall' || w.src?.prop) continue;
    wallPath.moveTo(w.a[0], w.a[1]);
    wallPath.lineTo(w.b[0], w.b[1]);
    let p = byStyle.get(w.style);
    if (!p) byStyle.set(w.style, (p = new Path2D()));
    p.moveTo(w.a[0], w.a[1]);
    p.lineTo(w.b[0], w.b[1]);
  }
  // Props by layer: on the floor, standing, then above the walls (tree tops, and light sources
  // so their glow isn't shaded).
  const props = [[], [], []];
  for (const [id, pr] of Object.entries(sk.props)) {
    const def = propDef(pr.kind);
    props[def.light && def.layer ? 2 : def.layer].push([id, pr]);
  }
  const out = { key, base, sk, byMat, roomRegion, floorEdge, seams, shapes, wallPath, byStyle, props, walls, railings };
  caches.set(level, out);
  return out;
}

/** An outline (corners in squares, [x, y]) as a closed path in scene pixels. */
function polyPath(poly, g, p = new Path2D()) {
  poly.forEach(([x, y], i) => (i ? p.lineTo(x * g, y * g) : p.moveTo(x * g, y * g)));
  p.closePath();
  return p;
}

// ------------------------------------------------------------------ traced buildings

const bwalls = new Map(); // level → { key, list }

/**
 * A level's traced buildings' walls as segments in scene pixels ({ a, b } of { x, y }), for
 * sight, movement and sound. Worked out once per change.
 */
export function buildingWalls(s, level = '') {
  const sk = sketchOf(s, level);
  if (!sk?.buildings) return [];
  const g = s.grid?.size ?? 70;
  const key = `${s.id}|${rev}|${g}`;
  const c = bwalls.get(level);
  if (c?.key === key) return c.list;
  const list = [];
  for (const b of Object.values(sk.buildings)) {
    const pts = b?.poly;
    if (b?.walled === false || !(pts?.length >= 3)) continue;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], z = pts[(i + 1) % pts.length];
      if (a[0] !== z[0] || a[1] !== z[1]) list.push({ a: { x: a[0] * g, y: a[1] * g }, b: { x: z[0] * g, y: z[1] * g } });
    }
  }
  bwalls.set(level, { key, list });
  return list;
}

const boxOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
};
const insidePoly = (pts, x, y) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** The traced building at a point (squares) on a level, or null; `roofed`: only one with a roof. */
export function buildingAt(s, level, x, y, roofed = false) {
  const sk = sketchOf(s, level);
  for (const [id, b] of Object.entries(sk?.buildings ?? {})) {
    if (!(b?.poly?.length >= 3) || (roofed && !b.roof)) continue;
    const r = boxOf(b.poly);
    if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
    if (insidePoly(b.poly, x, y)) return id;
  }
  return null;
}

const shapes = new Map(); // building id → { sig, shape }: its roof's planes, worked out once

/** A traced building's roof: its outline turned clockwise, and the planes and lines over it. */
function buildingRoof(id, poly) {
  const sig = JSON.stringify(poly);
  const c = shapes.get(id);
  if (c?.sig === sig) return c.shape;
  let pts = poly.map(([x, y]) => ({ x, y }));
  let area = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
  if (area < 0) pts = pts.reverse();
  let faces = null, lines = [];
  try {
    const sk = straightSkeleton([pts]);
    faces = sk && roofFaces(sk);
    if (faces) lines = sk.arcs.map((a) => [a.a, a.b]);
  } catch { faces = null; }
  const shape = { pts, faces: faces || null, lines: faces ? lines : [] };
  shapes.set(id, { sig, shape });
  return shape;
}

const TILE = 16; // squares
const btiles = new Map(); // level → { key, tiles }

/**
 * A level's traced buildings in tiles of 16 × 16 squares (a building goes in the tile its middle
 * is in), each with the paths to draw it, so only those on screen are drawn: a city has thousands.
 * { sig (what's in it, as text), x0, y0, x1, y1 (scene pixels round its buildings), floor
 * (material → path), edge, wall, room, byStyle (wall style → path), roofs [{ id, material, poly }],
 * roofPaths }
 */
function buildingTiles(s, level, g) {
  const sk = sketchOf(s, level);
  if (!sk?.buildings) return [];
  const key = `${s.id}|${rev}|${g}`;
  const c = btiles.get(level);
  if (c?.key === key) return c.tiles;
  const own = sk.wall_style || 'ink';
  const byKey = new Map();
  const add = (map, k, path) => { let x = map.get(k); if (!x) map.set(k, (x = new Path2D())); x.addPath(path); };
  for (const [id, b] of Object.entries(sk.buildings)) {
    if (!(b?.poly?.length >= 3)) continue;
    const r = boxOf(b.poly);
    const k = `${Math.floor((r.x0 + r.x1) / 2 / TILE)},${Math.floor((r.y0 + r.y1) / 2 / TILE)}`;
    let t = byKey.get(k);
    if (!t) byKey.set(k, (t = { sig: `${g}|${own}`, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, floor: new Map(), edge: new Path2D(), wall: new Path2D(), room: new Path2D(), byStyle: new Map(), roofs: [], roofPaths: null }));
    t.sig += `|${id}:${JSON.stringify(b)}`;
    t.x0 = Math.min(t.x0, r.x0 * g); t.y0 = Math.min(t.y0, r.y0 * g); t.x1 = Math.max(t.x1, r.x1 * g); t.y1 = Math.max(t.y1, r.y1 * g);
    const path = polyPath(b.poly, g);
    if (b.material) add(t.floor, b.material, path);
    if (b.walled === false) { if (b.material) t.edge.addPath(path); } else {
      t.room.addPath(path);
      t.wall.addPath(path);
      add(t.byStyle, b.wall_style || own, path);
    }
    if (b.roof) t.roofs.push({ id, material: b.roof, poly: b.poly });
  }
  const tiles = [...byKey.values()];
  btiles.set(level, { key, tiles });
  return tiles;
}

/** What of the scene a context shows: its box in scene pixels, and its scale (device pixels a scene pixel). */
function viewOf(ctx) {
  const m = ctx.getTransform(), inv = m.inverse();
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => inv.transformPoint({ x, y }));
  return { x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)), scale: Math.hypot(m.a, m.b) };
}

const BAKE_MAX = 64; // device pixels a square: closer than this, tiles are drawn as paths
/**
 * The tiles on screen; `bake`: the pixels a square their pictures are made at (0: closer in than
 * pictures are made for); `far`: too small on screen for the fine detail.
 */
function tilesOnView(tiles, ctx, g) {
  const v = viewOf(ctx), m = g, pps = g * v.scale;
  const vis = tiles.filter((t) => t.x1 + m >= v.x0 && t.x0 - m <= v.x1 && t.y1 + m >= v.y0 && t.y0 - m <= v.y1);
  return { vis, far: pps < 10, bake: pps > BAKE_MAX ? 0 : Math.max(4, 2 ** Math.ceil(Math.log2(pps))) };
}

// Tiles' pictures, made once at a zoom and drawn while panning (paths for a city are too slow).
// Most recently used last; the oldest go past BAKED_BYTES.
const baked = new Map(); // key → { canvas, x, y, w, h, bytes, stale, retry }
let bakedBytes = 0;
const BAKED_BYTES = 192e6;
let frameAt = null, budgetEnd = 0;
/** Time left this frame for making pictures (10 ms a frame). */
function bakeTime() {
  const f = document.timeline?.currentTime ?? 0;
  if (f !== frameAt) { frameAt = f; budgetEnd = performance.now() + 10; }
  return performance.now() < budgetEnd;
}
hooks.on('textures:changed', () => { baked.clear(); bakedBytes = 0; });

/**
 * A tile's picture at `pps` pixels a square, made by `paint(c, fill)` (fill: a material's fill;
 * one not loaded yet makes the picture stale, to be made again). Null if it isn't made yet (no
 * time left this frame: `board` is asked for another).
 */
function tilePicture(key, t, g, pps, paint, board) {
  let e = baked.get(key);
  const fresh = e && (!e.stale || performance.now() < e.retry);
  if (e) { baked.delete(key); baked.set(key, e); }
  if (fresh) return e;
  if (!bakeTime()) { board?.invalidate(); return e ?? null; }
  const pad = g, sc = pps / g;
  const w = Math.max(1, Math.ceil((t.x1 - t.x0 + pad * 2) * sc)), h = Math.max(1, Math.ceil((t.y1 - t.y0 + pad * 2) * sc));
  const canvas = e?.canvas.width === w && e.canvas.height === h ? e.canvas : document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext('2d');
  c.setTransform(sc, 0, 0, sc, -(t.x0 - pad) * sc, -(t.y0 - pad) * sc);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  let ok = true;
  const fill = (m, u) => { const f = fillFor(c, m, u, board); if (typeof f === 'string') ok = false; return f; };
  paint(c, fill);
  if (e) bakedBytes -= e.bytes;
  e = { canvas, x: t.x0 - pad, y: t.y0 - pad, w: w / sc, h: h / sc, bytes: w * h * 4, stale: !ok, retry: performance.now() + 400 };
  if (!ok) board?.invalidate();
  baked.set(key, e);
  bakedBytes += e.bytes;
  for (const [k, x] of baked) { if (bakedBytes <= BAKED_BYTES || k === key) break; baked.delete(k); bakedBytes -= x.bytes; }
  return e;
}

/** A tile's floors, walls (their shadow outside, shade inside, ink) as one picture. */
function paintTileWalls(c, t, g, fill) {
  c.save();
  c.strokeStyle = 'rgba(0,0,0,0.3)';
  c.lineWidth = g * 0.6;
  c.stroke(t.wall);
  c.strokeStyle = 'rgba(0,0,0,0.35)';
  c.lineWidth = g * 0.3;
  c.stroke(t.wall);
  c.globalCompositeOperation = 'destination-out';
  c.fill(t.room);
  c.restore();
  c.strokeStyle = 'rgba(0,0,0,0.4)';
  c.lineWidth = g * 0.12;
  c.stroke(t.edge);
  for (const [m, path] of t.floor) { c.fillStyle = fill(m, g); c.fill(path); vary(c, m, g, () => c.fill(path)); }
  c.save();
  c.clip(t.room);
  c.strokeStyle = 'rgba(0,0,0,0.3)';
  c.lineWidth = g * 0.22;
  c.stroke(t.wall);
  c.restore();
  inkWalls(c, t.byStyle, g, fill);
}

/** Walls in ink; textured ones as a band of texture edged in ink (all the edges first). */
function inkWalls(c, byStyle, g, fill) {
  const band = g * 0.24, edge = Math.max(1.5, g * 0.03);
  for (const [style, path] of byStyle) {
    c.strokeStyle = INK;
    if (style === 'ink' || !style) { c.lineCap = 'round'; c.lineWidth = Math.max(2, g * 0.08); } else { c.lineCap = 'square'; c.lineWidth = band + edge * 2; }
    c.stroke(path);
  }
  c.lineCap = 'square';
  for (const [style, path] of byStyle) {
    if (style === 'ink' || !style) continue;
    c.strokeStyle = fill(style, g * 0.6);
    c.lineWidth = band;
    c.stroke(path);
  }
  c.lineCap = 'round';
}

/** A tile's roofs (but `hidden`'s): planes by material, shaded by slope, ridges and eaves inked. */
function paintTileRoofs(c, t, g, hidden, hk, fill, far = false) {
  let P = t.roofPaths;
  if (!P || P.hk !== hk) {
    P = t.roofPaths = { hk, all: new Path2D(), byMat: new Map(), shade: Array.from({ length: 11 }, () => new Path2D()), lines: new Path2D() };
    const pt = (q) => [q.x * g, q.y * g];
    const poly = (pts, p) => { pts.forEach((q, i) => (i ? p.lineTo(...pt(q)) : p.moveTo(...pt(q)))); p.closePath(); };
    for (const r of t.roofs) {
      if (hidden?.has(r.id)) continue;
      const shape = buildingRoof(r.id, r.poly);
      const out = new Path2D();
      poly(shape.pts, out);
      P.all.addPath(out);
      if (!P.byMat.has(r.material)) P.byMat.set(r.material, new Path2D());
      P.byMat.get(r.material).addPath(out);
      for (const f of shape.faces ?? []) {
        const lit = -(f.n.x * LIGHT.x + f.n.y * LIGHT.y);
        poly(f.poly, P.shade[Math.round((lit + 1) * 5)]);
      }
      for (const [a, b] of shape.lines) { P.lines.moveTo(...pt(a)); P.lines.lineTo(...pt(b)); }
    }
  }
  c.save();
  c.strokeStyle = INK;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.save();
  c.translate(g * 0.12, g * 0.12);
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fill(P.all);
  c.restore();
  for (const [m, path] of P.byMat) { c.fillStyle = fill(m, g * 0.8); c.fill(path); }
  if (!far) {
    P.shade.forEach((path, i) => {
      const lit = i / 5 - 1;
      if (Math.abs(lit) < 0.05) return;
      c.fillStyle = lit > 0 ? `rgba(255,255,255,${(0.12 * lit).toFixed(3)})` : `rgba(0,0,0,${(0.28 * -lit).toFixed(3)})`;
      c.fill(path);
    });
    c.lineWidth = Math.max(1, g * 0.035);
    c.stroke(P.lines);
  }
  c.lineWidth = Math.max(1.5, g * 0.06);
  c.stroke(P.all);
  c.restore();
}

/**
 * Draw a level's traced buildings' roofs (those on screen), from each tile's picture (close in:
 * as paths). `hidden`: ids not drawn (a player's token is inside).
 */
export function drawBuildingRoofs(ctx, s, level, board, { hidden = null, alpha = 1 } = {}) {
  const g = s.grid?.size ?? 70;
  const { vis, far, bake } = tilesOnView(buildingTiles(s, level, g), ctx, g);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const t of vis) {
    if (!t.roofs.length) continue;
    const hk = hidden?.size ? t.roofs.filter((r) => hidden.has(r.id)).map((r) => r.id).join(',') : '';
    if (bake) {
      const e = tilePicture(`r|${level}|${bake}|${hk}|${t.sig}`, t, g, bake, (c, fill) => paintTileRoofs(c, t, g, hidden, hk, fill), board);
      if (e) { ctx.drawImage(e.canvas, e.x, e.y, e.w, e.h); continue; }
    }
    paintTileRoofs(ctx, t, g, hidden, hk, (m, u) => fillFor(ctx, m, u, board), far);
  }
  ctx.restore();
}

let patterns = new WeakMap(); // ctx → Map(material → { pat, span })
// A texture made in the texture creator changed (or its picture arrived): make its pattern again.
hooks.on('textures:changed', () => { patterns = new WeakMap(); terrainTexturesChanged(); waterTexturesChanged(); });

/** A fill for a material: a repeating pattern scaled to the grid, or a flat colour while it loads. */
/** A made texture's map-wide light and dark, over what `fill` just painted with it. */
function vary(ctx, m, g, fill) {
  const mv = macroOf(m);
  if (!mv) return;
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = mv.amount * 0.75;
  ctx.fillStyle = macroPattern(ctx, g, mv.size, m);
  fill();
  ctx.restore();
}

function fillFor(ctx, m, g, board, turn = null) {
  let pats = patterns.get(ctx);
  if (!pats) patterns.set(ctx, (pats = new Map()));
  let entry = pats.get(m);
  if (!entry) {
    const tex = texture(m);
    // The texture creator's: drawn once its sources have loaded.
    if (!tex && m?.startsWith?.('tex:')) return '#6b6359';
    const src = tex ?? board.image(m);
    if (!src) return '#6b6359';
    // Built-ins cover 2 × 2 squares; an uploaded texture covers 4 squares across, unless its
    // URL says how many pixels make a square.
    entry = { pat: ctx.createPattern(src, 'repeat'), span: tex ? TILE_SIZE / TILE_SQUARES : pxOfMaterial(m) ?? (src.naturalWidth || 256) / 4 };
    pats.set(m, entry);
  }
  // `turn`: { x, y, deg } — the pattern turned about a point (a roof plane's rows along its eave).
  const mat = turn ? new DOMMatrix().translate(turn.x, turn.y).rotate(turn.deg) : new DOMMatrix();
  entry.pat.setTransform(mat.scale(g / entry.span));
  return entry.pat;
}

const INK = '#17120e';
let layer = null; // offscreen: the walls' shadow, cut out of the rooms

/**
 * Draw the scene's sketch (scene coordinates). `draft`: a change being made right now,
 * { patch, rev }, shown before it's sent.
 */
export function drawSketch(ctx, s, board, { level = '', draft = null } = {}) {
  const base = sketchOf(s, level);
  if (!base && !draft) return;
  const g = s.grid?.size ?? 70;
  const geo = geometry(base, draft, g, level);
  const sk = geo.sk;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, s.width, s.height);
  ctx.clip();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (sk.outside) {
    ctx.fillStyle = fillFor(ctx, sk.outside, g, board);
    ctx.fillRect(0, 0, s.width, s.height);
    vary(ctx, sk.outside, g, () => ctx.fillRect(0, 0, s.width, s.height));
  }
  // Painted ground, over what's outside, then water (the ground level only).
  const fill = (c, m, gg, r) => {
    const f = fillFor(c, m, gg, board);
    c.fillStyle = f;
    c.fillRect(r.x, r.y, r.w, r.h);
    vary(c, m, gg, () => c.fillRect(r.x, r.y, r.w, r.h));
    return typeof f !== 'string';
  };
  if (!level && sk.terrain) drawTerrain(ctx, s, sk.terrain, g, fill, () => board?.invalidate());
  if (!level && sk.water) drawWater(ctx, s, sk.water, g, fill, () => board?.invalidate(), !!board && sk.water.animate !== false && animatedMaps());
  // A soft edge round every floor, then the floors.
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = g * 0.12;
  ctx.stroke(geo.floorEdge);
  for (const [m, path] of geo.byMat) { ctx.fillStyle = fillFor(ctx, m, g, board); ctx.fill(path); vary(ctx, m, g, () => ctx.fill(path)); }
  // Traced buildings on screen (a whole city drawn at once would be slow): each tile as a picture
  // made at this zoom, or close in (or until its picture is made) as paths, floors first.
  const { vis, far, bake } = tilesOnView(buildingTiles(s, level, g), ctx, g);
  const tiles = [];
  for (const t of vis) {
    const e = bake ? tilePicture(`w|${level}|${bake}|${t.sig}`, t, g, bake, (c, fill) => paintTileWalls(c, t, g, fill), board) : null;
    if (e) ctx.drawImage(e.canvas, e.x, e.y, e.w, e.h); else tiles.push(t);
  }
  for (const t of tiles) {
    if (!far) { ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = g * 0.12; ctx.stroke(t.edge); }
    for (const [m, path] of t.floor) { ctx.fillStyle = fillFor(ctx, m, g, board); ctx.fill(path); if (!far) vary(ctx, m, g, () => ctx.fill(path)); }
  }
  for (const { shape, path } of geo.shapes) { ctx.fillStyle = fillFor(ctx, shape.material, g, board); ctx.fill(path); vary(ctx, shape.material, g, () => ctx.fill(path)); }
  ctx.strokeStyle = 'rgba(20, 15, 10, 0.55)';
  ctx.lineWidth = Math.max(1, g * 0.03);
  ctx.stroke(geo.seams);
  for (const { shape, path } of geo.shapes) if (shape.walled === false) ctx.stroke(path);
  const texFill = (c, m, u) => fillFor(c, m, u, board);
  const drawProps = (list) => { for (const [id, p] of list) drawPropAt(ctx, p, g, { seed: id, lit: !s.lights?.[skId(`sk-p-${id}`, level)]?.off, texFill }); };
  drawProps(geo.props[0]);
  drawProps(geo.props[1]);

  // The walls' shadow on whatever is outside the rooms: drawn apart, cut out of the rooms.
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  if (!layer) layer = document.createElement('canvas');
  if (layer.width !== cw || layer.height !== ch) { layer.width = cw; layer.height = ch; }
  const lc = layer.getContext('2d');
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.clearRect(0, 0, cw, ch);
  lc.setTransform(ctx.getTransform());
  lc.lineCap = 'round';
  lc.lineJoin = 'round';
  lc.strokeStyle = 'rgba(0,0,0,0.3)';
  lc.lineWidth = g * 0.6;
  lc.stroke(geo.wallPath);
  if (!far) for (const t of tiles) lc.stroke(t.wall);
  lc.strokeStyle = 'rgba(0,0,0,0.35)';
  lc.lineWidth = g * 0.3;
  lc.stroke(geo.wallPath);
  if (!far) for (const t of tiles) lc.stroke(t.wall);
  lc.globalCompositeOperation = 'destination-out';
  lc.fill(geo.roomRegion);
  if (!far) for (const t of tiles) lc.fill(t.room);
  lc.globalCompositeOperation = 'source-over';
  const t = ctx.getTransform();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(layer, 0, 0);
  ctx.setTransform(t);
  // Shade just inside the walls, then the ink.
  ctx.save();
  ctx.clip(geo.roomRegion);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = g * 0.22;
  ctx.stroke(geo.wallPath);
  ctx.restore();
  if (!far) {
    for (const t of tiles) {
      ctx.save();
      ctx.clip(t.room);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = g * 0.22;
      ctx.stroke(t.wall);
      ctx.restore();
    }
  }
  // Ink lines; textured walls as a band of texture edged in ink (all the edges first, so where
  // two styles meet neither's edge crosses the other's band).
  const wallFill = (m, u) => fillFor(ctx, m, u, board);
  inkWalls(ctx, geo.byStyle, g, wallFill);
  for (const t of tiles) inkWalls(ctx, t.byStyle, g, wallFill);
  drawRailings(ctx, geo.railings, g);

  drawOpenings(ctx, s, g, level, board ? board.gmView : isGM(), sk);
  drawProps(geo.props[2]);
  ctx.restore();
}

/** Railings: a light wooden rail between dark edges, with posts. */
function drawRailings(ctx, path, g) {
  ctx.save();
  ctx.lineCap = 'square';
  ctx.strokeStyle = INK;
  ctx.lineWidth = g * 0.11;
  ctx.stroke(path);
  ctx.strokeStyle = '#a7743f';
  ctx.lineWidth = g * 0.06;
  ctx.stroke(path);
  ctx.strokeStyle = INK;
  ctx.lineWidth = g * 0.12;
  ctx.setLineDash([g * 0.04, g * 0.46]);
  ctx.lineDashOffset = g * 0.02;
  ctx.stroke(path);
  ctx.restore();
}

/**
 * The floor of the level above that overhangs this one (walkways and balconies: its floor
 * without walls), seen from below. `holes`: points (scene px) to leave clear, so a token
 * standing under it is still seen; `alpha`: how solid it looks.
 */
export function drawOverhang(ctx, s, board, level, { holes = [], alpha = 0.9, darkness = 0 } = {}) {
  const sk = withPatch(sketchOf(s, level), null);
  const g = s.grid?.size ?? 70;
  const floors = new Map(), outline = new Path2D();
  const all = sk.floor;
  for (const [k, m] of Object.entries(all)) {
    const [c, r] = cellOf(k);
    if (!floors.has(m)) floors.set(m, new Path2D());
    floors.get(m).rect(c * g, r * g, g, g);
    for (const [e, next] of SIDES(c, r)) {
      if (next in all) continue;
      const seg = edgeSegment(e, g);
      outline.moveTo(...seg.a); outline.lineTo(...seg.b);
    }
  }
  const round = Object.values(sk.shapes).filter((x) => x.walled === false && x.r > 0);
  if (!floors.size && !round.length) return false;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, s.width, s.height);
  for (const h of holes) { ctx.moveTo(h.x + h.r, h.y); ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2); }
  ctx.clip('evenodd');
  ctx.globalAlpha = alpha;
  // Its shadow on the floor below, then the floor and its edge.
  ctx.save();
  ctx.translate(g * 0.12, g * 0.12);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (const path of floors.values()) ctx.fill(path);
  for (const x of round) { ctx.beginPath(); ctx.arc(x.x * g, x.y * g, x.r * g, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
  for (const [m, path] of floors) { ctx.fillStyle = fillFor(ctx, m, g, board); ctx.fill(path); vary(ctx, m, g, () => ctx.fill(path)); }
  for (const x of round) { ctx.fillStyle = fillFor(ctx, x.material, g, board); ctx.beginPath(); ctx.arc(x.x * g, x.y * g, x.r * g, 0, Math.PI * 2); ctx.fill(); }
  // Drawn over the level's lighting, so it takes the night's darkness itself.
  if (darkness > 0.01) {
    ctx.fillStyle = `rgba(4, 6, 18, ${darkness * (board.gmView ? 0.7 : 0.85)})`;
    for (const path of floors.values()) ctx.fill(path);
    for (const x of round) { ctx.beginPath(); ctx.arc(x.x * g, x.y * g, x.r * g, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1.5, g * 0.05);
  ctx.stroke(outline);
  const geo = geometry(sketchOf(s, level), null, g, level);
  drawRailings(ctx, geo.railings, g);
  ctx.restore();
  return true;
}

/** Is a point (scene px) on the overhanging floor of a level (its floor without walls)? */
export function onOverhang(s, level, pt) {
  const sk = sketchOf(s, level);
  if (!sk) return false;
  const g = s.grid?.size ?? 70;
  if (cellKey(Math.floor(pt.x / g), Math.floor(pt.y / g)) in (sk.floor ?? {})) return true;
  return Object.values(sk.shapes ?? {}).some((x) => x.walled === false && (pt.x / g - x.x) ** 2 + (pt.y / g - x.y) ** 2 <= x.r * x.r);
}

/** What can be set in a round room's wall. */
export const ROUND_OPENINGS = ['door', 'secret_door', 'window'];
const TAU = Math.PI * 2;
/** An angle (radians) brought into 0 … 2π. */
const turn = (a) => ((a % TAU) + TAU) % TAU;
/** Is an angle inside an opening's arc? */
const within = (a, op) => turn(a - op.a0) < op.a1 - op.a0;

/**
 * Where a door or window sits in a round room's wall: the arc it fills, from `a0` to `a1`
 * (radians, clockwise on the map), centred on `mid`.
 */
export function roundOpening(shape, op) {
  const mid = ((op.at ?? 0) * Math.PI) / 180;
  const half = Math.asin(Math.min(1, (op.width ?? 1) / 2 / Math.max(shape.r, 0.01)));
  return { a0: mid - half, a1: mid + half, mid };
}

/** A round room's doors and windows: [{ id, kind, at, width, a0, a1, mid }]. */
export function roundOpeningsOf(shape) {
  if (shape.walled === false) return [];
  return Object.entries(shape.openings ?? {})
    .filter(([, o]) => o && ROUND_OPENINGS.includes(o.kind))
    .map(([id, o]) => ({ id, ...o, ...roundOpening(shape, o) }));
}

/** Is an angle (radians) inside one of a round room's openings? Its id if so. */
export function roundOpeningAt(shape, a) {
  return roundOpeningsOf(shape).find((op) => within(a, op))?.id ?? null;
}

/** Every roof on the scene: [{ id, level, roof }] (roofs live in the levels' sketches). */
export function roofsOf(s, levels) {
  const out = [];
  for (const l of levels) for (const [id, roof] of Object.entries(sketchOf(s, l.id)?.roofs ?? {})) out.push({ id, level: l.id, roof });
  return out;
}

/**
 * The scene's roofs as buildings: roof rectangles on one level, of one material, that overlap
 * or share an edge make one roof; round roofs come after them, each on its own.
 * [{ level, ids, rects, material, ridge, round }]
 */
export function roofGroupsOf(s, levels) {
  const out = [];
  for (const l of levels) {
    const byMat = new Map(), round = [];
    for (const [id, roof] of Object.entries(sketchOf(s, l.id)?.roofs ?? {})) {
      if (!(roof?.w > 0 && roof?.h > 0)) continue;
      // A round roof stands on its own (a tower's, above the roofs round it).
      if (ROUND_ROOFS.includes(roof.shape)) { round.push({ level: l.id, ids: [id], rects: [{ ...roof, id }], material: roof.material, round: roof.shape }); continue; }
      if (!byMat.has(roof.material)) byMat.set(roof.material, []);
      byMat.get(roof.material).push({ ...roof, id });
    }
    for (const [material, rects] of byMat) {
      for (const group of groupRects(rects)) {
        out.push({ level: l.id, ids: group.map((r) => r.id), rects: group, material, ridge: group.length === 1 ? group[0].ridge : undefined });
      }
    }
    out.push(...round);
  }
  return out;
}

// Light falls from the top left: planes facing it are lit, planes facing away shaded.
const LIGHT = (() => { const x = -0.45, y = -1, l = Math.hypot(x, y); return { x: x / l, y: y / l }; })();

/** Draw a roof rectangle on its own (as while dragging one out). */
export function drawRoof(ctx, roof, g, board, alpha = 1) {
  drawRoofGroup(ctx, { rects: [roof], material: roof.material, ridge: roof.ridge, round: ROUND_ROOFS.includes(roof.shape) ? roof.shape : null }, g, board, alpha);
}

/**
 * Draw a building's roof (from `roofGroupsOf`): one roof over the whole footprint, each plane
 * in the material with its rows along its eave and shaded by which way it slopes; ridges,
 * hips and valleys inked where planes meet, and an ink edge round the eaves.
 */
export function drawRoofGroup(ctx, group, g, board, alpha = 1) {
  const shape = roofShape(group.rects, group.ridge, group.round);
  const path = (pts, dx = 0, dy = 0, p = new Path2D()) => {
    pts.forEach((q, i) => (i ? p.lineTo(q.x * g + dx, q.y * g + dy) : p.moveTo(q.x * g + dx, q.y * g + dy)));
    p.closePath();
    return p;
  };
  const whole = (dx = 0, dy = 0) => { const p = new Path2D(); for (const l of shape.loops) path(l, dx, dy, p); return p; };
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill(whole(g * 0.15, g * 0.15), 'evenodd');
  if (shape.dome) {
    drawDome(ctx, shape.dome, whole(), group.material, g, board);
  } else if (!shape.faces) {
    // An outline the roof can't be worked out for: covered flat.
    ctx.fillStyle = fillFor(ctx, group.material, g * 0.8, board);
    ctx.fill(whole(), 'evenodd');
  } else {
    // Whole first, so the planes' clipped edges leave no hairline gaps.
    ctx.fillStyle = fillFor(ctx, group.material, g * 0.8, board);
    ctx.fill(whole(), 'evenodd');
    for (const f of shape.faces) {
      const p = path(f.poly);
      const down = { x: -f.n.x, y: -f.n.y }; // which way the plane slopes
      const a = f.poly[0];
      ctx.save();
      ctx.clip(p);
      ctx.fillStyle = fillFor(ctx, group.material, g * 0.8, board, { x: a.x * g, y: a.y * g, deg: (Math.atan2(-down.x, down.y) * 180) / Math.PI });
      ctx.fill(p);
      const lit = down.x * LIGHT.x + down.y * LIGHT.y;
      ctx.fillStyle = lit >= 0 ? `rgba(255,255,255,${(0.1 * lit).toFixed(3)})` : `rgba(0,0,0,${(0.26 * -lit).toFixed(3)})`;
      ctx.fill(p);
      // A little shade along the eave and light up at the ridge, so each plane reads as a slope.
      const depth = Math.max(...f.poly.map((q) => (q.x - a.x) * f.n.x + (q.y - a.y) * f.n.y)) * g;
      if (depth > 0) {
        const grad = ctx.createLinearGradient(a.x * g, a.y * g, a.x * g + f.n.x * depth, a.y * g + f.n.y * depth);
        grad.addColorStop(0, 'rgba(0,0,0,0.12)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill(p);
      }
      ctx.restore();
    }
  }
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.5, g * 0.05);
  ctx.beginPath();
  for (const [a, b] of shape.lines) { ctx.moveTo(a.x * g, a.y * g); ctx.lineTo(b.x * g, b.y * g); }
  ctx.stroke();
  ctx.lineWidth = Math.max(2, g * 0.08);
  ctx.lineJoin = 'round';
  ctx.stroke(whole());
  if (shape.peak) {
    // A finial at the top of a round roof.
    const px = shape.peak.x * g, py = shape.peak.y * g, pr = Math.max(3, g * 0.12);
    const shine = ctx.createRadialGradient(px - pr * 0.4, py - pr * 0.4, 0, px, py, pr);
    shine.addColorStop(0, '#9a8f80');
    shine.addColorStop(1, '#2e2925');
    ctx.fillStyle = shine;
    ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = Math.max(1, g * 0.03);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * A dome seen from above: courses of the material in rings (closer together towards the rim,
 * where the dome is steep), ribs up to the top, and lit like a ball from the top left.
 */
function drawDome(ctx, { c, rx, ry }, outline, material, g, board) {
  const cx = c.x * g, cy = c.y * g, RX = rx * g, RY = ry * g, R = Math.max(RX, RY);
  ctx.save();
  ctx.clip(outline);
  ctx.fillStyle = fillFor(ctx, material, g * 0.6, board);
  ctx.fill(outline);
  ctx.strokeStyle = 'rgba(20, 15, 10, 0.45)';
  ctx.lineWidth = Math.max(1, g * 0.025);
  const courses = Math.max(3, Math.round(Math.min(rx, ry) * 2.5));
  ctx.beginPath();
  for (let k = 1; k < courses; k++) {
    const f = Math.cos(((k / courses) * Math.PI) / 2);
    ctx.moveTo(cx + RX * f, cy);
    ctx.ellipse(cx, cy, RX * f, RY * f, 0, 0, Math.PI * 2);
  }
  const ribs = Math.min(rx, ry) < 1.5 ? 8 : 12;
  for (let i = 0; i < ribs; i++) {
    const a = (i / ribs) * Math.PI * 2;
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + RX * Math.cos(a), cy + RY * Math.sin(a));
  }
  ctx.stroke();
  const ball = ctx.createRadialGradient(cx + LIGHT.x * R * 0.4, cy + LIGHT.y * R * 0.4, 0, cx + LIGHT.x * R * 0.15, cy + LIGHT.y * R * 0.15, R * 1.15);
  ball.addColorStop(0, 'rgba(255,255,255,0.22)');
  ball.addColorStop(0.45, 'rgba(255,255,255,0)');
  ball.addColorStop(0.75, 'rgba(0,0,0,0.12)');
  ball.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = ball;
  ctx.fill(outline);
  ctx.restore();
}

/**
 * Doors (in their frames, swung open when open) and windows, from the scene's walls; those
 * in round rooms' walls from the sketch (`sk`), following the curve.
 */
function drawOpenings(ctx, s, g, level, gm, sk) {
  for (const [sid, shape] of Object.entries(sk?.shapes ?? {})) {
    if (!(shape.r > 0)) continue;
    for (const op of roundOpeningsOf(shape)) {
      const key = `o:${sid}:${op.id}`;
      const win = op.kind === 'window';
      const w = s.walls?.[skId(`${win ? 'sk-n-' : 'sk-d-'}${key}`, level)];
      drawRoundOpening(ctx, shape, op, g, gm, !win && !!w?.open);
    }
  }
  for (const [id, w] of Object.entries(s.walls ?? {})) {
    const win = id.startsWith('sk-n-');
    if ((!win && !id.startsWith('sk-d-')) || !onLevel(w, level)) continue;
    if (id.startsWith('o:', 5)) continue; // in a round wall: drawn above
    const ax = w.a[0], ay = w.a[1], bx = w.b[0], by = w.b[1];
    const len = Math.hypot(bx - ax, by - ay);
    ctx.strokeStyle = INK;
    if (w.kind === 'secret_door' && !gm && !w.open) {
      // A plain wall to players.
      ctx.lineWidth = Math.max(2, g * 0.08);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      continue;
    }
    const t = g * 0.16, post = g * 0.12, span = len - post * 2;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(Math.atan2(by - ay, bx - ax));
    ctx.fillStyle = INK;
    ctx.fillRect(-1, -t * 0.75, post, t * 1.5);
    ctx.fillRect(len - post + 1, -t * 0.75, post, t * 1.5);
    ctx.lineWidth = Math.max(1, g * 0.03);
    if (win) {
      // Glass in a thin frame, with a mullion.
      ctx.fillStyle = 'rgba(170, 215, 235, 0.9)';
      ctx.fillRect(post, -t * 0.3, span, t * 0.6);
      ctx.strokeRect(post, -t * 0.3, span, t * 0.6);
      ctx.beginPath(); ctx.moveTo(post + span / 2, -t * 0.3); ctx.lineTo(post + span / 2, t * 0.3); ctx.stroke();
    } else {
      ctx.translate(post, 0);
      if (w.open) ctx.rotate(-Math.PI * 0.45);
      ctx.fillStyle = w.kind === 'secret_door' ? '#5a4a6e' : '#8a5a2e';
      ctx.fillRect(0, -t / 2, span, t);
      ctx.strokeRect(0, -t / 2, span, t);
    }
    ctx.restore();
  }
}

/**
 * A door or window in a round room's wall, bent to the wall's curve between posts. An open
 * door swings in, straight, from its first post.
 */
function drawRoundOpening(ctx, shape, op, g, gm, open) {
  const cx = shape.x * g, cy = shape.y * g, R = shape.r * g;
  const t = g * 0.16, post = g * 0.12;
  const dp = Math.min(post / R, (op.a1 - op.a0) / 4); // a post's share of the arc
  const b0 = op.a0 + dp, b1 = op.a1 - dp;
  const at = (a, r = R) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const band = (w) => {
    ctx.beginPath();
    ctx.arc(cx, cy, R + w / 2, b0, b1);
    ctx.arc(cx, cy, Math.max(0, R - w / 2), b1, b0, true);
    ctx.closePath();
  };
  ctx.save();
  ctx.strokeStyle = INK;
  if (op.kind === 'secret_door' && !gm && !open) {
    // A plain wall to players.
    ctx.lineWidth = Math.max(2, g * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, R, op.a0, op.a1); ctx.stroke();
    ctx.restore();
    return;
  }
  // Posts, square to the wall.
  ctx.fillStyle = INK;
  for (const [a, back] of [[op.a0, false], [op.a1, true]]) {
    ctx.save();
    ctx.translate(...at(a));
    ctx.rotate(a + Math.PI / 2);
    ctx.fillRect(back ? -post + 1 : -1, -t * 0.75, post, t * 1.5);
    ctx.restore();
  }
  ctx.lineWidth = Math.max(1, g * 0.03);
  if (op.kind === 'window') {
    // Curved glass in a thin frame, with a mullion.
    band(t * 0.6);
    ctx.fillStyle = 'rgba(170, 215, 235, 0.9)';
    ctx.fill();
    ctx.stroke();
    const mid = (b0 + b1) / 2;
    ctx.beginPath(); ctx.moveTo(...at(mid, R - t * 0.3)); ctx.lineTo(...at(mid, R + t * 0.3)); ctx.stroke();
  } else if (!open) {
    band(t);
    ctx.fillStyle = op.kind === 'secret_door' ? '#5a4a6e' : '#8a5a2e';
    ctx.fill();
    ctx.stroke();
  } else {
    // Swung into the room: a straight leaf as long as the gap, from the first post.
    const [hx, hy] = at(b0), [ex, ey] = at(b1);
    const span = Math.hypot(ex - hx, ey - hy);
    ctx.translate(hx, hy);
    ctx.rotate(Math.atan2(ey - hy, ex - hx) + Math.PI * 0.45);
    ctx.fillStyle = op.kind === 'secret_door' ? '#5a4a6e' : '#8a5a2e';
    ctx.fillRect(0, -t / 2, span, t);
    ctx.strokeRect(0, -t / 2, span, t);
  }
  ctx.restore();
}
