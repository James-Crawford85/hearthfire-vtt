// The GM's sketch-map tools (board tools; sketch.js has the data and the drawing):
//   sketch-room    drag a rectangle of room: floor with walls round it (Shift erases)
//   sketch-round   drag a round room from its centre (Alt: a round floor without walls, a pond;
//                  Shift-click one to remove it)
//   sketch-floor   drag a rectangle of floor without walls: porches, paths, yards (Shift erases)
//   sketch-brush   paint floor square by square (Shift erases; [ and ] change the size); on a
//                  room it changes the floor and keeps the walls. At size 1, over a square cut by
//                  a diagonal wall, it paints (or erases) just the triangle under the pointer.
//                  Room and floor rectangles dragged over diagonal walls fill what they enclose.
//   sketch-erase   erase squares, round rooms and light sources with the brush
//   sketch-terrain paint ground textures freely (terrain.js), blended into each other and over
//                  what's outside the rooms (Shift erases back to it; [ and ] change the size)
//   sketch-water   paint water (water.js): oceans, lakes and rivers, each a body of water with
//                  its own look; rivers run the way they're painted (Shift erases; Alt-click
//                  picks the body under the pointer; [ and ] change the size)
//   sketch-wall    drag along grid lines to add walls, or at 45° for a diagonal (across a room's
//                  corner it cuts the corner off; Alt: it cuts nothing off, and goes corner to
//                  corner at any angle); Shift-drag takes walls away (rooms' walls too),
//                  Shift-click a diagonal removes it
//   sketch-door    click a grid edge or a diagonal wall: a door (Shift: secret door); again to remove
//   sketch-window  click a grid edge or a diagonal wall: a window; again to remove
//   sketch-trace   build buildings off the map picture (trace.js): click inside an outline to build
//                  it, or drag a box to trace all inside it (shown to pick from, then built);
//                  click a traced one to give it the textures chosen; Shift-click removes one
//   sketch-place   click to place the chosen prop: a light source (next to a wall it's mounted on
//                  the wall) or furniture and nature. Props are chosen in the Map props tab of the
//                  sidebar, and can be dragged from there onto the map.
// While a sketch tool is on, a bar at the top shows its options: the floor, wall and roof
// textures it uses, the brush size; with Select, what's selected.
//   sketch-select  click a prop, door, window, wall or round room: drag to move it, handles to
//                  resize and turn it, Delete removes it; a bar shows its options
// Hold Ctrl (Cmd on a Mac) to stop snapping: round rooms, walls, props and moving, turning and
// resizing in Select go exactly where the pointer is (a wall off the grid lines is free-standing).
// Ctrl+Z undoes, Esc goes back to Select. Each change is one op carrying the sketch's walls and
// lights, worked out again.
import { toast, formDialog, el } from './ui.js';
import { isGM, store } from './store.js';
import { hooks } from './hooks.js';
import { MATERIALS, WALL_STYLES, ROOF_MATERIALS, texture } from './sketch-textures.js';
import { cellKey, cellOf, withPatch, sketchWalls, plainWalls, sketchLights, sketchLinks, edgeSegment, edgeNear, edgesAlong, isDiagonal, diagonalNear, cornerCut, splitSquares, cutOf, parseHalf, halfValue, pieceAt, pieceOutline, fillPieces, TRIS as TRI_NAMES } from './sketch.js';
import { sketchOf, skId, levelsOf, levelName } from './levels.js';
import { LIGHTS, FURNITURE, PROP_GROUPS, propDef, isLight, isHex, propLightColor, drawPropAt, propThumb, propHit, propOutline } from './sketch-props.js';
import { drawRoof, roundOpening, roundOpeningsOf, roundOpeningAt, ROUND_OPENINGS, buildingAt } from './sketch.js';
import { ROUND_ROOFS, CORNERS, cutsOf, cutLoop, insideRects } from './roof-skeleton.js';
import { recipes } from './texture-recipes.js';
import { openTextureCreator } from './texture-creator.js';
import { beginStroke, onTerrainReady, forgetTerrain, MAX_SLOTS } from './terrain.js';
import { importPack, libraryTextures } from './dd-pack.js';
import { beginWaterStroke, bodyAt, forgetWater, PRESETS, KINDS, MAX_BODIES } from './water.js';
import { mapPixels, traceAt, traceBox } from './trace.js';

const HOVER = 'rgba(255, 190, 40, 0.95)';
const ERASE = 'rgba(255, 90, 70, 0.95)';
const MAPS = ['cells', 'floor', 'edges', 'halves', 'shapes', 'lines', 'props', 'styles', 'roofs', 'buildings'];
const PAINT_TOOLS = ['sketch-room', 'sketch-floor', 'sketch-brush', 'sketch-round'];
const newId = () => Math.random().toString(36).slice(2, 10);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function registerSketch(api) {
  const board = api.board;
  const st = {
    material: 'stone',
    wallStyle: null, // walls drawn from now on: a WALL_STYLES id, or null for the sketch's own
    prop: 'torch',
    brush: 1,
    undo: [],     // [{ sceneId, patch }]: the change that puts things back
    hover: null,  // the world point under the mouse
    drag: null,
    mods: {},     // shiftKey, altKey, free (Ctrl or Cmd: no snapping) as last seen
    // Painting ground: the texture, the brush's width (squares), how soft its edge is and how
    // much one stroke lays down (0–1); a new texture's tile size and how ragged its edges are.
    terrain: { material: 'grass', size: 3, soft: 0.4, strength: 1, scale: 1, edge: 0.6 },
    // Painting water: the body painted (null: a new one, with this look), the brush's width.
    water: { body: null, kind: 'lake', ...PRESETS.lake, size: 3 },
  };
  api.sketch = st;

  const scene = () => board.scene;
  const g = () => board.grid;
  // The sketch of the level the board shows.
  const current = () => withPatch(sketchOf(scene(), board.level), null);
  const cellAt = (w) => [Math.floor(w.x / g()), Math.floor(w.y / g())];
  const cornerAt = (w) => [Math.round(w.x / g()), Math.round(w.y / g())];
  const inScene = (c, r) => { const s = scene(); return c >= 0 && r >= 0 && c * g() < s.width && r * g() < s.height; };

  // ---------------------------------------------------------------- changes

  const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  /**
   * A merge patch that turns `from` into `to`: a copy of `to`, with null for each key `from`
   * has and `to` doesn't (inside plain objects too).
   */
  function replacing(from, to) {
    if (!plain(from) || !plain(to)) return structuredClone(to);
    const out = {};
    for (const [key, v] of Object.entries(to)) out[key] = plain(v) && plain(from[key]) ? replacing(from[key], v) : structuredClone(v);
    for (const key of Object.keys(from)) if (!(key in to)) out[key] = null;
    return out;
  }

  /** The merge patch that undoes `patch` merged into `from`. */
  function unmerging(from, patch) {
    if (!plain(patch)) return from === undefined ? null : structuredClone(from);
    const out = {};
    for (const [k, v] of Object.entries(patch)) out[k] = plain(v) && plain(from?.[k]) ? unmerging(from[k], v) : from?.[k] === undefined ? null : structuredClone(from[k]);
    return out;
  }

  /** Send a change to the sketch (maps of entries, null erasing one), with its walls and lights. */
  function commit(patch, { record = true } = {}) {
    const s = scene();
    if (!s) return false;
    const before = current();
    const clean = {}, inverse = {};
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      // Painted ground merges in, key by key (its chunks are big: only what changed is sent).
      if (k === 'terrain' || k === 'water') {
        if (v === null ? before[k] == null : plain(v) && !Object.keys(v).length) continue;
        clean[k] = v;
        inverse[k] = v === null ? before[k] ?? null : before[k] == null ? null : unmerging(before[k], v);
        changed = true;
        continue;
      }
      if (!MAPS.includes(k)) {
        if (!same(before[k], v)) { clean[k] = v; inverse[k] = before[k]; changed = true; }
        continue;
      }
      for (const [id, x] of Object.entries(v ?? {})) {
        const was = before[k][id] ?? null;
        if (same(was, x)) continue;
        // Changes merge into what's there, so whatever an entry no longer has is sent as null
        // (a prop's colours taken off), both ways.
        (clean[k] ??= {})[id] = x == null ? null : replacing(was, x);
        // A copy: the store updates entries in place, which would change the undo too.
        (inverse[k] ??= {})[id] = was === null ? null : replacing(x, was);
        changed = true;
      }
    }
    if (!changed) return false;
    if (record) {
      st.undo.push({ sceneId: s.id, level: board.level, patch: inverse });
      if (st.undo.length > 100) st.undo.shift();
    }
    // A first sketch on an empty scene gets rock around it; on a map, the map shows around it.
    // Other levels have nothing round them (what's below shows).
    if (!sketchOf(s, board.level)) { clean.outside ??= board.level || s.background ? null : 'rock'; clean.walls ??= true; }
    clean.size = g();
    send(s, clean);
    return true;
  }

  function send(s, patch) {
    const level = board.level;
    const next = withPatch(sketchOf(s, level), patch);
    api.op({
      op: 'sketch_update', scene_id: s.id, ...(level ? { level } : {}), patch,
      walls: plainWalls(sketchWalls(next, g(), level)), lights: sketchLights(next, g(), s.grid?.distance ?? 5, level), links: sketchLinks(next, g(), level),
    });
  }

  function undo() {
    const last = st.undo.at(-1);
    if (!last || last.sceneId !== scene()?.id) { toast('Nothing to undo on this scene.'); return; }
    st.undo.pop();
    // Undo on the level where the change was made.
    if ((last.level ?? '') !== board.level) { board.setLevel(last.level ?? ''); toast(`Undone on ${levelName(scene(), last.level)}.`); }
    commit(last.patch, { record: false });
  }

  // What painting does to squares, against the sketch as it is.
  // A key is a whole square ("c,r") or one triangle of a square cut by a diagonal ("c,r|t"),
  // which is painted on its own (sketch.halves), leaving the other triangle as it was.
  const halves = (sk, out, fn) => {
    const split = splitSquares(sk), entries = new Map();
    const tri = (piece, value) => {
      const [k, t] = piece.split('|');
      if (!entries.has(k)) {
        const [c, r] = cellOf(k), cut = cutOf(sk.edges, c, r), sp = split.get(k);
        entries.set(k, Object.fromEntries(Object.keys(TRI_NAMES[cut]).map((x) => [x, sp ? halfValue(sp.tris[x]) : 'none'])));
      }
      const e = entries.get(k);
      e[t] = halfValue(value(parseHalf(e[t])));
    };
    fn(tri);
    // The square as a whole: a room if either triangle is, else floor if either is, else nothing.
    for (const [k, e] of entries) {
      const xs = Object.values(e).map(parseHalf).filter(Boolean);
      const room = xs.find((x) => x.room), any = room ?? xs[0];
      (out.cells ??= {})[k] = room ? room.material : null;
      (out.floor ??= {})[k] = !room && any ? any.material : null;
      (out.halves ??= {})[k] = any ? e : null;
    }
    return out;
  };
  /** Whole squares cut by a diagonal, as their two triangles. */
  const pieces = (sk, keys) => keys.flatMap((k) => {
    if (k.includes('|')) return [k];
    const [c, r] = cellOf(k), cut = cutOf(sk.edges, c, r);
    return cut ? Object.keys(TRI_NAMES[cut]).map((t) => `${k}|${t}`) : [k];
  });
  const paint = {
    room(keys, m, out = {}) {
      const sk = current();
      for (const k of keys) if (!k.includes('|')) { (out.cells ??= {})[k] = m; (out.floor ??= {})[k] = null; if (sk.halves[k]) (out.halves ??= {})[k] = null; }
      return halves(sk, out, (tri) => { for (const p of keys) if (p.includes('|')) tri(p, () => ({ room: true, material: m })); });
    },
    floor(keys, m, out = {}) {
      const sk = current();
      const all = pieces(sk, keys);
      for (const k of all) if (!k.includes('|')) { if (k in sk.cells) (out.cells ??= {})[k] = m; else (out.floor ??= {})[k] = m; }
      // A triangle of room keeps its walls and takes the new floor.
      return halves(sk, out, (tri) => { for (const p of all) if (p.includes('|')) tri(p, (x) => ({ room: !!x?.room, material: m })); });
    },
    erase(keys, out = {}) {
      const sk = current();
      const set = new Set(keys);
      for (const k of keys) if (!k.includes('|')) { (out.cells ??= {})[k] = null; (out.floor ??= {})[k] = null; if (sk.halves[k]) (out.halves ??= {})[k] = null; }
      halves(sk, out, (tri) => { for (const p of keys) if (p.includes('|')) tri(p, () => null); });
      for (const [id, sh] of Object.entries(sk.shapes)) if (set.has(cellKey(Math.floor(sh.x), Math.floor(sh.y)))) (out.shapes ??= {})[id] = null;
      for (const [id, p] of Object.entries(sk.props)) if (set.has(cellKey(Math.floor(p.x), Math.floor(p.y)))) (out.props ??= {})[id] = null;
      return out;
    },
  };

  // The draft shown while dragging.
  function setDraft(patch) {
    board.sketchDraft = patch ? { patch, rev: (board.sketchDraft?.rev ?? 0) + 1 } : null;
    board.invalidate();
  }

  /**
   * The squares under a brush centred on a world point. The smallest brush over a square cut
   * by a diagonal paints just the triangle under it.
   */
  function brushCells(w) {
    if (st.brush === 1) return inScene(...cellAt(w)) ? [pieceAt(current(), w, g())] : [];
    const [c0, r0] = cellAt(w);
    const n = st.brush, lo = -Math.floor((n - 1) / 2);
    const out = [];
    for (let dc = lo; dc < lo + n; dc++) for (let dr = lo; dr < lo + n; dr++) if (inScene(c0 + dc, r0 + dr)) out.push(cellKey(c0 + dc, r0 + dr));
    return out;
  }

  function rectCells(a, b) {
    const out = [];
    for (let c = Math.min(a[0], b[0]); c <= Math.max(a[0], b[0]); c++) {
      for (let r = Math.min(a[1], b[1]); r <= Math.max(a[1], b[1]); r++) if (inScene(c, r)) out.push(cellKey(c, r));
    }
    return out;
  }

  const outline = (ctx, color, draw) => { ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2 / board.cam.z; draw(); ctx.restore(); };
  const label = (ctx, text, x, y) => {
    ctx.save();
    ctx.font = `${14 / board.cam.z}px system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 3 / board.cam.z;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  /** Ctrl (Cmd on a Mac) held: don't snap. */
  const free = (e) => !!(e?.ctrlKey || e?.metaKey);
  const mods = (e) => ({ shiftKey: !!e.shiftKey, altKey: !!e.altKey, free: free(e) });
  const track = (w, e) => { st.hover = w; st.mods = mods(e); };
  const fine = (v) => Math.round(v * 100) / 100; // squares, to a hundredth
  // Show the change as soon as a key goes down or up, without waiting for the mouse to move.
  for (const type of ['keydown', 'keyup']) {
    addEventListener(type, (e) => {
      if (!board.tool.startsWith('sketch-') || !['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) return;
      st.mods = mods(e);
      if (st.drag && st.hover) board.toolHandlers[board.tool]?.move?.(st.hover, e); else board.invalidate();
    });
  }
  const base = (extra) => ({
    key: keys,
    leave() { st.hover = null; st.drag = null; setDraft(null); },
    ...extra,
  });

  // ---------------------------------------------------------------- rectangles: room and floor

  const rectTool = (kind) => base({
    cursor: 'crosshair',
    down(w, e) { const c = cellAt(w); st.drag = { a: c, b: c, erase: e.shiftKey }; this.move(w, e); },
    move(w, e) {
      track(w, e);
      if (!st.drag) { board.invalidate(); return; }
      st.drag.b = cellAt(w);
      const keys_ = rectCells(st.drag.a, st.drag.b);
      // Over diagonal walls it fills what they enclose, not the corners beyond them.
      const patch = st.drag.erase ? paint.erase(keys_) : paint[kind](fillPieces(current(), keys_), st.material);
      if (kind === 'room' && !st.drag.erase && st.wallStyle) patch.styles = { ...patch.styles, ...cellEdgeStyles(keys_) };
      setDraft(patch);
    },
    up() {
      if (!st.drag) return;
      const patch = board.sketchDraft?.patch;
      st.drag = null;
      setDraft(null);
      if (patch) commit(patch);
    },
    draw(ctx) {
      if (st.drag) {
        const { a, b, erase } = st.drag;
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(a[0] - b[0]) + 1, h = Math.abs(a[1] - b[1]) + 1;
        outline(ctx, erase ? ERASE : HOVER, () => ctx.strokeRect(x * g(), y * g(), w * g(), h * g()));
        label(ctx, `${w} × ${h}`, x * g() + 4 / board.cam.z, y * g() - 6 / board.cam.z);
      } else if (st.hover) {
        const [c, r] = cellAt(st.hover);
        outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => ctx.strokeRect(c * g(), r * g(), g(), g()));
      }
    },
  });
  /** The chosen wall texture on every side of these squares (only their outside ones are walls). */
  function cellEdgeStyles(keys_) {
    const out = {};
    for (const k of keys_) {
      const [c, r] = cellOf(k);
      for (const e of [`h:${c},${r}`, `h:${c},${r + 1}`, `v:${c},${r}`, `v:${c + 1},${r}`]) out[e] = st.wallStyle;
    }
    return out;
  }
  board.registerTool('sketch-room', rectTool('room'));
  board.registerTool('sketch-floor', rectTool('floor'));

  // ---------------------------------------------------------------- brushes

  const brushTool = (eraser) => base({
    cursor: 'crosshair',
    down(w, e) { st.drag = { erase: eraser || e.shiftKey, keys: new Set(), last: null }; this.move(w, e); },
    move(w, e) {
      track(w, e);
      if (!st.drag) { board.invalidate(); return; }
      // Fill in between pointer events, so a quick stroke leaves no gaps.
      const from = st.drag.last ?? w;
      const steps = Math.max(1, Math.ceil(Math.hypot(w.x - from.x, w.y - from.y) / (g() / 3)));
      for (let i = 1; i <= steps; i++) {
        for (const k of brushCells({ x: from.x + ((w.x - from.x) * i) / steps, y: from.y + ((w.y - from.y) * i) / steps })) st.drag.keys.add(k);
      }
      st.drag.last = w;
      setDraft(st.drag.erase ? paint.erase([...st.drag.keys]) : paint.floor([...st.drag.keys], st.material));
    },
    up() {
      if (!st.drag) return;
      const patch = board.sketchDraft?.patch;
      st.drag = null;
      setDraft(null);
      if (patch) commit(patch);
    },
    draw(ctx) {
      if (!st.hover || st.drag) return;
      outline(ctx, eraser || st.mods.shiftKey ? ERASE : HOVER, () => {
        for (const k of brushCells(st.hover)) {
          ctx.beginPath();
          pieceOutline(k, g()).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.stroke();
        }
      });
    },
  });
  board.registerTool('sketch-brush', brushTool(false));
  board.registerTool('sketch-erase', brushTool(true));

  // ---------------------------------------------------------------- painted ground

  onTerrainReady(() => board.invalidate());
  const inSquares = (w) => ({ x: w.x / g(), y: w.y / g() });
  /** The ground slot painted with a material: [id, slot], or [null] for none yet. */
  const slotOf = (m) => Object.entries(current().terrain?.slots ?? {}).find(([, x]) => x.material === m) ?? [null, null];

  function endTerrainStroke() {
    const d = st.drag;
    if (!d?.stroke) return;
    clearInterval(d.timer);
    st.drag = null;
    const s = scene();
    d.stroke.end().then(({ chunks, used }) => {
      if (scene()?.id !== s?.id) return;
      const slots = {};
      const have = current().terrain?.slots ?? {};
      if (d.slot && !have[d.slot] && used.has(d.slot)) slots[d.slot] = { material: d.material, scale: st.terrain.scale, edge: st.terrain.edge };
      for (const id of Object.keys(have)) if (!used.has(id)) slots[id] = null; // a texture painted out everywhere
      const patch = {};
      if (chunks) patch.chunks = chunks;
      if (Object.keys(slots).length) patch.slots = slots;
      if (Object.keys(patch).length) commit({ terrain: patch });
    });
  }

  board.registerTool('sketch-terrain', base({
    cursor: 'crosshair',
    down(w, e) {
      const s = scene();
      if (!s || board.level) { if (board.level) toast('Ground is painted on the ground level.'); return; }
      const erase = !!e.shiftKey;
      const m = st.terrain.material;
      let [slot] = slotOf(m);
      if (!erase && !slot) {
        const taken = new Set(Object.keys(current().terrain?.slots ?? {}));
        slot = Array.from({ length: MAX_SLOTS }, (_, i) => String(i + 1)).find((id) => !taken.has(id)) ?? null;
        if (!slot) { toast(`A map can have ${MAX_SLOTS} ground textures. Paint one out (Shift erases) to use another.`, 'error'); return; }
      }
      const p = inSquares(w);
      const d = (st.drag = { stroke: beginStroke(s.id, erase ? null : slot, { ...st.terrain, bounds: { cols: s.width / g(), rows: s.height / g() } }), slot: erase ? null : slot, material: m, last: p, erase, at: performance.now() });
      d.stroke.line(p, p);
      // Held still, the brush keeps laying paint down (a low strength builds up).
      d.timer = setInterval(() => {
        if (st.drag !== d) { clearInterval(d.timer); return; }
        if (performance.now() - d.at >= 60) { d.stroke.hold(d.last); d.at = performance.now(); }
      }, 60);
      track(w, e);
    },
    move(w, e) {
      track(w, e);
      if (!st.drag?.stroke) { board.invalidate(); return; }
      const p = inSquares(w);
      st.drag.stroke.line(st.drag.last, p);
      st.drag.last = p;
      st.drag.at = performance.now();
    },
    up() { endTerrainStroke(); },
    leave() { endTerrainStroke(); st.hover = null; board.invalidate(); },
    draw(ctx) {
      if (!st.hover) return;
      const r = (st.terrain.size / 2) * g();
      const erase = st.drag ? st.drag.erase : st.mods.shiftKey;
      outline(ctx, erase ? ERASE : HOVER, () => {
        ctx.beginPath();
        ctx.arc(st.hover.x, st.hover.y, r, 0, Math.PI * 2);
        ctx.stroke();
      });
      if (st.terrain.soft > 0.05) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([4 / board.cam.z, 4 / board.cam.z]);
        outline(ctx, erase ? ERASE : HOVER, () => {
          ctx.beginPath();
          ctx.arc(st.hover.x, st.hover.y, r * (1 - Math.min(0.95, st.terrain.soft)), 0, Math.PI * 2);
          ctx.stroke();
        });
        ctx.restore();
      }
    },
  }));

  // ---------------------------------------------------------------- water

  const KIND_NAMES = { ocean: 'Ocean', lake: 'Lake', river: 'River' };
  const LOOK = ['kind', 'water', 'shore', 'underlay', 'shore_width', 'depth', 'clarity'];
  const bodiesNow = () => current().water?.bodies ?? {};
  /** The look being painted: the chosen body's, or the new one's. */
  const waterLook = () => bodiesNow()[st.water.body] ?? st.water;
  /** Change the look: the chosen body's (for all of it on the map), or the next new one's. */
  function setWater(key, v) {
    const id = st.water.body;
    if (id && bodiesNow()[id]) commit({ water: { bodies: { [id]: { [key]: v } } } });
    else st.water[key] = v;
    renderBar();
    board.invalidate();
  }

  function endWaterStroke() {
    const d = st.drag;
    if (!d?.water) return;
    st.drag = null;
    const s = scene();
    d.stroke.end().then(({ chunks, flow, used }) => {
      if (scene()?.id !== s?.id) return;
      const have = bodiesNow();
      const bodies = {};
      if (d.body && !have[d.body] && used.has(d.body)) {
        bodies[d.body] = Object.fromEntries(LOOK.map((k) => [k, d.look[k]]).filter(([, v]) => v != null));
      }
      for (const id of Object.keys(have)) if (!used.has(id)) bodies[id] = null; // painted out everywhere
      const patch = {};
      if (chunks) patch.chunks = chunks;
      if (flow) patch.flow = flow;
      if (Object.keys(bodies).length) patch.bodies = bodies;
      if (Object.keys(patch).length) commit({ water: patch });
      // Go on painting the body just made; one painted out is gone.
      if (d.body && used.has(d.body)) st.water.body = d.body;
      if (st.water.body && !used.has(st.water.body)) st.water.body = null;
      renderBar();
    });
  }

  board.registerTool('sketch-water', base({
    cursor: 'crosshair',
    down(w, e) {
      const s = scene();
      if (!s || board.level) { if (board.level) toast('Water is painted on the ground level.'); return; }
      const p = inSquares(w);
      if (e.altKey) {
        const id = bodyAt(s.id, p.x, p.y);
        if (id && bodiesNow()[id]) { st.water.body = id; renderBar(); toast(`Painting ${KIND_NAMES[bodiesNow()[id].kind] ?? 'Water'} ${id}`); }
        return;
      }
      const erase = !!e.shiftKey;
      let id = st.water.body && bodiesNow()[st.water.body] ? st.water.body : null;
      if (!erase && !id) {
        const taken = new Set(Object.keys(bodiesNow()));
        id = Array.from({ length: MAX_BODIES }, (_, i) => String(i + 1)).find((x) => !taken.has(x)) ?? null;
        if (!id) { toast(`A map can have ${MAX_BODIES} bodies of water. Pick one to go on painting (Alt-click it), or paint one out.`, 'error'); return; }
      }
      const look = { ...waterLook() };
      const stroke = beginWaterStroke(s.id, erase ? null : id, { size: st.water.size, flowing: look.kind === 'river', bounds: { cols: s.width / g(), rows: s.height / g() } });
      st.drag = { water: true, stroke, body: erase ? null : id, look, last: p, erase };
      stroke.line(p, p);
      track(w, e);
    },
    move(w, e) {
      track(w, e);
      if (!st.drag?.water) { board.invalidate(); return; }
      const p = inSquares(w);
      st.drag.stroke.line(st.drag.last, p);
      st.drag.last = p;
    },
    up() { endWaterStroke(); },
    leave() { endWaterStroke(); st.hover = null; board.invalidate(); },
    draw(ctx) {
      if (!st.hover) return;
      const r = (st.water.size / 2) * g();
      const erase = st.drag ? st.drag.erase : st.mods.shiftKey;
      outline(ctx, erase ? ERASE : HOVER, () => {
        ctx.beginPath();
        ctx.arc(st.hover.x, st.hover.y, r, 0, Math.PI * 2);
        ctx.stroke();
      });
    },
  }));

  // ---------------------------------------------------------------- tracing buildings off the map

  // Tracing: buildings (each outlined shape) or blocks (what's between the streets); what a new
  // one gets (floor: none shows the map; roof: none, none); the picture's line and street
  // lightness (null: as worked out from it); squaring sides up; the biggest shape traced.
  // `found`: what a dragged box found, shown to pick from before it's built.
  st.trace = { mode: 'buildings', floor: null, roof: null, walls: true, straighten: true, skipGrey: true, t1: null, t2: null, max: 400, found: null, px: null, busy: false };

  /** The scene's map picture, read once for tracing; null if there's none it can trace. */
  async function tracePixels() {
    const s = scene();
    if (!s?.background) { toast('Tracing needs a map picture on the scene (its Map, in the scene\'s settings).', 'error'); return null; }
    const t = st.trace;
    if (t.px?.url === s.background) return t.px.px;
    if (t.busy) return null;
    t.busy = true;
    const slow = setTimeout(() => toast('Reading the map…'), 250);
    const px = await mapPixels(s);
    clearTimeout(slow);
    t.busy = false;
    if (!px) { toast('This map can\'t be traced (it\'s a video, or the picture didn\'t load).', 'error'); return null; }
    t.px = { url: s.background, px };
    renderBar();
    return px;
  }
  const traceOpts = () => { const t = st.trace; return { t1: t.t1 ?? undefined, t2: t.t2 ?? undefined, straighten: t.straighten, skipGrey: t.skipGrey, maxSquares: t.max }; };
  /** A new building, with the chosen textures. */
  const newBuilding = (poly) => {
    const t = st.trace, b = { poly };
    if (t.floor) b.material = t.floor;
    if (t.roof) b.roof = t.roof;
    if (!t.walls) b.walled = false;
    if (st.wallStyle) b.wall_style = st.wallStyle;
    return b;
  };
  const traceNoun = (n) => `${st.trace.mode === 'blocks' ? 'block' : 'building'}${n === 1 ? '' : 's'}`;
  const polyCentre = (poly) => poly.reduce((a, [x, y]) => [a[0] + x / poly.length, a[1] + y / poly.length], [0, 0]);
  const insidePoly = (poly, x, y) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const tracePath = (ctx, poly) => { ctx.beginPath(); poly.forEach(([x, y], i) => (i ? ctx.lineTo(x * g(), y * g()) : ctx.moveTo(x * g(), y * g()))); ctx.closePath(); };

  /** Build what the box found (those still ticked). */
  function buildFound() {
    const t = st.trace;
    const list = (t.found ?? []).filter((f) => f.on);
    t.found = null;
    if (list.length) {
      commit({ buildings: Object.fromEntries(list.map((f) => [newId(), newBuilding(f.poly)])) });
      toast(`Built ${list.length} ${traceNoun(list.length)}. Ctrl+Z undoes.`);
    }
    renderBar();
    board.invalidate();
  }
  function dropFound() { st.trace.found = null; renderBar(); board.invalidate(); }

  /** A click: the shape under it, built at once; on a traced building, it takes the textures chosen. */
  async function traceClick(w, e) {
    const s = scene();
    const p = inSquares(w);
    const hit = buildingAt(s, board.level, p.x, p.y);
    if (e.shiftKey) {
      if (hit) commit({ buildings: { [hit]: null } }); else toast('Shift-click a traced building to remove it.');
      return;
    }
    if (hit) {
      const { poly } = buildingsNow()[hit];
      commit({ buildings: { [hit]: newBuilding(poly) } });
      toast('Changed to the textures chosen.');
      return;
    }
    const px = await tracePixels();
    if (!px || scene() !== s) return;
    const r = traceAt(s, px, w, st.trace.mode, traceOpts());
    if (r.error) { toast(r.error, 'error'); return; }
    commit({ buildings: Object.fromEntries(r.polys.map((poly) => [newId(), newBuilding(poly)])) });
  }

  /** A box: every shape wholly inside it, shown to pick from. */
  async function traceArea(a, b) {
    const s = scene();
    const px = await tracePixels();
    if (!px || scene() !== s) return;
    const rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
    const t0 = performance.now();
    const polys = traceBox(s, px, rect, st.trace.mode, traceOpts());
    // Not over what's traced already.
    const fresh = polys.filter((poly) => { const [x, y] = polyCentre(poly); return !buildingAt(s, board.level, x, y); });
    console.debug(`trace: ${fresh.length} of ${polys.length} in ${Math.round(performance.now() - t0)} ms`);
    if (!fresh.length) { toast(polys.length ? 'All of those are traced already.' : `No ${traceNoun(2)} wholly inside that box (those crossing its edge are left out).`); return; }
    st.trace.found = fresh.map((poly) => ({ poly, on: true }));
    renderBar();
    board.invalidate();
  }

  const buildingsNow = () => current().buildings ?? {};

  board.registerTool('sketch-trace', base({
    cursor: 'crosshair',
    enter() { api.sketchRefit(); tracePixels(); },
    leave() { st.hover = null; st.drag = null; st.trace.found = null; },
    down(w, e) {
      if (!scene()) return;
      const found = st.trace.found;
      if (found) {
        // Picking from what a box found: a click ticks one off or on.
        const p = inSquares(w);
        const f = found.find((x) => insidePoly(x.poly, p.x, p.y));
        if (f) { f.on = !f.on; renderBar(); board.invalidate(); }
        return;
      }
      st.drag = { trace: true, a: w, b: w, sx: e.clientX, sy: e.clientY, far: false };
      track(w, e);
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (d?.trace) {
        d.b = w;
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) d.far = true;
      }
      board.invalidate();
    },
    up(w, e) {
      const d = st.drag;
      if (!d?.trace) return;
      st.drag = null;
      board.invalidate();
      if (d.far) traceArea(d.a, w); else traceClick(d.a, e);
    },
    key(e) {
      if (st.trace.found && e.key === 'Enter') { buildFound(); return true; }
      if (st.trace.found && e.key === 'Escape') { dropFound(); return true; }
      return keys(e);
    },
    draw(ctx) {
      const found = st.trace.found;
      if (found) {
        for (const f of found) {
          outline(ctx, f.on ? HOVER : ERASE, () => {
            tracePath(ctx, f.poly);
            ctx.globalAlpha = f.on ? 0.18 : 0.08;
            ctx.fill();
            ctx.globalAlpha = 1;
            if (!f.on) ctx.setLineDash([6 / board.cam.z, 4 / board.cam.z]);
            ctx.stroke();
          });
        }
        return;
      }
      const d = st.drag;
      if (d?.trace && d.far) {
        outline(ctx, HOVER, () => {
          ctx.setLineDash([8 / board.cam.z, 5 / board.cam.z]);
          ctx.strokeRect(Math.min(d.a.x, d.b.x), Math.min(d.a.y, d.b.y), Math.abs(d.b.x - d.a.x), Math.abs(d.b.y - d.a.y));
        });
        return;
      }
      // The traced building under the pointer.
      if (!st.hover) return;
      const p = inSquares(st.hover);
      const hit = buildingAt(scene(), board.level, p.x, p.y);
      if (hit) outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => { tracePath(ctx, buildingsNow()[hit].poly); ctx.stroke(); });
    },
  }));

  // ---------------------------------------------------------------- round rooms

  const half = (v) => Math.round(v * 2) / 2; // to the nearest half square
  board.registerTool('sketch-round', base({
    cursor: 'crosshair',
    down(w, e) {
      if (e.shiftKey) {
        // Remove the smallest round room or floor under the pointer.
        const p = { x: w.x / g(), y: w.y / g() };
        const hit = Object.entries(current().shapes).filter(([, s]) => (p.x - s.x) ** 2 + (p.y - s.y) ** 2 <= s.r * s.r).sort((a, b) => a[1].r - b[1].r)[0];
        if (hit) commit({ shapes: { [hit[0]]: null } }); else toast('Shift-click a round room to remove it.');
        return;
      }
      const snap = free(e) ? fine : half;
      st.drag = { c: { x: snap(w.x / g()), y: snap(w.y / g()) }, r: 0, walled: !e.altKey, id: newId() };
      this.move(w, e);
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (!d) { board.invalidate(); return; }
      const r = Math.hypot(w.x / g() - d.c.x, w.y / g() - d.c.y);
      d.r = free(e) ? Math.max(0.1, fine(r)) : Math.max(0.5, half(r));
      d.walled = !e.altKey;
      setDraft({ shapes: { [d.id]: { kind: 'circle', x: d.c.x, y: d.c.y, r: d.r, material: st.material, walled: d.walled, ...(d.walled && st.wallStyle ? { wall_style: st.wallStyle } : {}) } } });
    },
    up() {
      const d = st.drag;
      if (!d) return;
      const patch = board.sketchDraft?.patch;
      st.drag = null;
      setDraft(null);
      if (patch && d.r > 0) commit(patch);
    },
    draw(ctx) {
      const d = st.drag;
      if (d) {
        outline(ctx, HOVER, () => { ctx.beginPath(); ctx.arc(d.c.x * g(), d.c.y * g(), 3 / board.cam.z, 0, Math.PI * 2); ctx.fill(); });
        label(ctx, `${d.r * 2} across${d.walled ? '' : ', no walls'}`, (d.c.x + d.r) * g() + 6 / board.cam.z, d.c.y * g());
      } else if (st.hover) {
        const snap = st.mods.free ? fine : half;
        const x = snap(st.hover.x / g()) * g(), y = snap(st.hover.y / g()) * g();
        outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => { ctx.beginPath(); ctx.arc(x, y, 4 / board.cam.z, 0, Math.PI * 2); ctx.fill(); });
      }
    },
  }));

  // ---------------------------------------------------------------- walls

  /** Is this edge one of a room square's own (room on one side only)? */
  const roomEdge = (e, sk) => {
    if (isDiagonal(e)) return false;
    const [dir, rest] = e.split(':');
    const [c, r] = cellOf(rest);
    const other = dir === 'h' ? cellKey(c, r - 1) : cellKey(c - 1, r);
    return (cellKey(c, r) in sk.cells) !== (other in sk.cells);
  };

  const wallTool = (railing) => base({
    cursor: 'crosshair',
    down(w, e) { const a = endAt(w, e); st.drag = { a, b: a, remove: e.shiftKey, any: e.altKey }; this.move(w, e); },
    move(w, e) {
      track(w, e);
      if (st.drag) { st.drag.any = !!e.altKey; st.drag.b = endAt(w, e, st.drag.a); }
      board.invalidate();
    },
    up(w) {
      const d = st.drag;
      st.drag = null;
      if (!d) return;
      const sk = current();
      if (d.a[0] === d.b[0] && d.a[1] === d.b[1]) {
        if (!d.remove) return;
        // Shift-click: remove the diagonal wall under the pointer.
        const hit = lineAt(w, sk);
        if (hit) { commit({ lines: { [hit]: null } }); return; }
        const diag = diagonalNear(sk, w, g());
        if (diag) commit({ edges: { [diag]: null } });
        return;
      }
      const onGrid = d.a.concat(d.b).every(Number.isInteger);
      const along = onGrid ? edgesAlong(d.a, d.b) : null;
      if (along && railing) {
        // A railing on an edge (taking the place of a room's wall there); Shift takes it away.
        const edges = {};
        for (const e of along) edges[e] = d.remove ? (sk.edges[e] === 'railing' ? null : sk.edges[e] ?? null) : 'railing';
        commit({ edges });
      } else if (!along && railing && !d.remove) {
        commit({ lines: { [newId()]: { a: d.a, b: d.b, kind: 'window', style: 'railing' } } });
      } else if (along) {
        // A room's own wall needs nothing set (clearing "open" or a door brings it back); taking
        // it away sets "open". Elsewhere an edge is a wall or nothing.
        const own = (e) => sk.walls !== false && roomEdge(e, sk);
        const edges = {};
        for (const e of along) edges[e] = d.remove ? (own(e) ? 'open' : null) : (own(e) ? null : 'wall');
        const styles = !d.remove && st.wallStyle ? Object.fromEntries(along.map((e) => [e, st.wallStyle])) : null;
        const patch = styles ? { edges, styles } : { edges };
        if (!d.remove && isDiagonal(along[0])) {
          // One diagonal to a square: a wall the other way across it goes.
          for (const e of along) { const other = `${e[0] === 'd' ? 'u' : 'd'}${e.slice(1)}`; if (sk.edges[other]) edges[other] = null; }
          // Across a room's corner it cuts the corner off (Alt: a wall in the room, cutting nothing off).
          if (!d.any) {
            const cut = cornerCut(withPatch(sk, { edges }), along);
            if (cut.length) {
              patch.cells = Object.fromEntries(cut.map((k) => [k, null]));
              const painted = cut.filter((k) => sk.halves[k]);
              if (painted.length) patch.halves = Object.fromEntries(painted.map((k) => [k, null]));
            }
          }
        }
        commit(patch);
      } else if (!d.remove) {
        commit({ lines: { [newId()]: { a: d.a, b: d.b, kind: 'wall', ...(st.wallStyle ? { style: st.wallStyle } : {}) } } });
      }
    },
    draw(ctx) {
      const d = st.drag;
      const z = board.cam.z;
      if (d) {
        outline(ctx, d.remove ? ERASE : HOVER, () => {
          ctx.lineWidth = 5 / z;
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(d.a[0] * g(), d.a[1] * g()); ctx.lineTo(d.b[0] * g(), d.b[1] * g()); ctx.stroke();
        });
        const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        const n45 = Math.abs(d.b[0] - d.a[0]);
        const at45 = n45 && n45 === Math.abs(d.b[1] - d.a[1]) && d.a.concat(d.b).every(Number.isInteger);
        if (len) label(ctx, at45 ? `${n45} square${n45 > 1 ? 's' : ''} at 45°` : `${Math.round(len * 10) / 10} squares`, d.b[0] * g() + 8 / z, d.b[1] * g());
      } else if (st.hover) {
        const [c, r] = endAt(st.hover, st.mods);
        outline(ctx, st.mods.shiftKey ? ERASE : HOVER, () => { ctx.beginPath(); ctx.arc(c * g(), r * g(), 4 / z, 0, Math.PI * 2); ctx.fill(); });
        if (st.mods.shiftKey) {
          const hit = lineAt(st.hover, current());
          const l = hit && current().lines[hit];
          if (l) outline(ctx, ERASE, () => { ctx.lineWidth = 6 / z; ctx.beginPath(); ctx.moveTo(l.a[0] * g(), l.a[1] * g()); ctx.lineTo(l.b[0] * g(), l.b[1] * g()); ctx.stroke(); });
        }
      }
    },
  });

  /**
   * A wall's end: the nearest grid corner, or (Ctrl) right where the pointer is. In squares.
   * Dragged from `from`, it keeps to the grid lines and the diagonals at 45° (Alt: any corner).
   */
  function endAt(w, e, from = null) {
    if (free(e) || e?.free) return [fine(w.x / g()), fine(w.y / g())];
    if (!from || e?.altKey || !from.every(Number.isInteger)) return cornerAt(w);
    const dx = w.x / g() - from[0], dy = w.y / g() - from[1];
    const turn = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
    const ux = Math.round(Math.cos(turn)), uy = Math.round(Math.sin(turn));
    // How far that way: the nearest whole step to the pointer.
    const n = Math.max(0, Math.round((dx * ux + dy * uy) / (ux * ux + uy * uy)));
    return [from[0] + ux * n, from[1] + uy * n];
  }

  board.registerTool('sketch-wall', wallTool(false));
  board.registerTool('sketch-railing', wallTool(true));

  // ---------------------------------------------------------------- roofs

  const isRound = (r) => ROUND_ROOFS.includes(r.shape);
  const underRoof = (r, w) => {
    const x = w.x / g(), y = w.y / g();
    if (isRound(r)) return ((x - r.x - r.w / 2) / (r.w / 2)) ** 2 + ((y - r.y - r.h / 2) / (r.h / 2)) ** 2 <= 1;
    return insideRects([r], x, y);
  };
  const roofAt = (w, sk) => Object.entries(sk.roofs).filter(([, r]) => underRoof(r, w)).sort((a, b) => a[1].w * a[1].h - b[1].w * b[1].h)[0]?.[0] ?? null;
  const roofOutline = (ctx, r) => {
    if (isRound(r)) ctx.ellipse((r.x + r.w / 2) * g(), (r.y + r.h / 2) * g(), (r.w / 2) * g(), (r.h / 2) * g(), 0, 0, Math.PI * 2);
    else { cutLoop(r).forEach((p, i) => (i ? ctx.lineTo(p.x * g(), p.y * g()) : ctx.moveTo(p.x * g(), p.y * g()))); ctx.closePath(); }
  };
  /**
   * The 45° corner cuts a roof rectangle needs to follow diagonal walls across its corners:
   * { nw, ne, se, sw } (the ones it has), or undefined.
   */
  const wallCuts = (r, sk) => {
    const has = (t, c, rr) => sk.edges[`${t}:${c},${rr}`] != null;
    const { x, y, w, h } = r;
    const along = {
      nw: (k, i) => has('u', x + k - 1 - i, y + i),
      ne: (k, i) => has('d', x + w - k + i, y + i),
      se: (k, i) => has('u', x + w - 1 - i, y + h - k + i),
      sw: (k, i) => has('d', x + i, y + h - k + i),
    };
    const cuts = {};
    for (const corner of CORNERS) {
      for (let k = Math.min(w, h); k >= 1; k--) {
        if (Array.from({ length: k }, (_, i) => along[corner](k, i)).every(Boolean)) { cuts[corner] = k; break; }
      }
    }
    const fit = cutsOf({ ...r, cuts });
    return fit ? Object.fromEntries(Object.entries(fit).filter(([, k]) => k > 0)) : undefined;
  };
  /** The walled round room under a point, smallest first. */
  const roundRoomAt = (w, sk) => Object.entries(sk.shapes).filter(([, s]) => s.walled !== false && s.r > 0 && (w.x / g() - s.x) ** 2 + (w.y / g() - s.y) ** 2 <= s.r * s.r).sort((a, b) => a[1].r - b[1].r)[0] ?? null;
  // A round roof over a round room reaches a little past its wall (the eaves).
  const EAVES = 0.25;
  /** What a roof is shaped like: hipped (rectangles that join up) or round. */
  const roofShapeSelect = (value, set) => el('select', { title: 'The roof\'s shape', on: { change: (e) => set(e.target.value || null) } },
    ...[['', 'Hipped'], ['cone', 'Round: cone'], ['facets', 'Round: faceted'], ['dome', 'Round: dome']].map(([v, t]) => el('option', { value: v, text: t, selected: (value ?? '') === v })));

  board.registerTool('sketch-roof', base({
    cursor: 'crosshair',
    enter() { api.sketchRefit(); api.controls?.render(); },
    down(w, e) {
      if (e.shiftKey) {
        const hit = roofAt(w, current());
        if (hit) commit({ roofs: { [hit]: null } }); else toast('Shift-click a roof to remove it.');
        return;
      }
      if (st.roofShape) {
        // Round: dragged out from the middle (a click on a round room roofs it).
        const snap = free(e) ? fine : half;
        st.drag = { c: { x: snap(w.x / g()), y: snap(w.y / g()) }, r: 0, start: w };
        this.move(w, e);
        return;
      }
      const c = cellAt(w);
      st.drag = { a: c, b: c };
      this.move(w, e);
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (!d) { board.invalidate(); return; }
      if (d.c) {
        const r = Math.hypot(w.x / g() - d.c.x, w.y / g() - d.c.y);
        d.r = Math.hypot(w.x - d.start.x, w.y - d.start.y) < 6 / board.cam.z ? 0 : free(e) ? Math.max(0.25, fine(r)) : Math.max(0.5, half(r));
        d.roof = d.r > 0 ? { x: d.c.x - d.r, y: d.c.y - d.r, w: d.r * 2, h: d.r * 2, material: st.roof, shape: st.roofShape } : null;
        board.invalidate();
        return;
      }
      d.b = cellAt(w);
      const x = Math.min(d.a[0], d.b[0]), y = Math.min(d.a[1], d.b[1]);
      d.roof = { x, y, w: Math.abs(d.a[0] - d.b[0]) + 1, h: Math.abs(d.a[1] - d.b[1]) + 1, material: st.roof };
      // Diagonal walls across its corners: the roof's corners are cut to follow them.
      const cuts = wallCuts(d.roof, current());
      if (cuts) d.roof.cuts = cuts;
      board.invalidate();
    },
    up(w) {
      const d = st.drag;
      st.drag = null;
      if (d?.c && !d.roof) {
        // A click: roof the round room under it.
        const room = roundRoomAt(w ?? d.start, current());
        if (!room) { toast('Drag out a round roof from its middle, or click a round room to roof it.'); board.invalidate(); return; }
        const [, s] = room, R = s.r + EAVES;
        commit({ roofs: { [newId()]: { x: fine(s.x - R), y: fine(s.y - R), w: fine(R * 2), h: fine(R * 2), material: st.roof, shape: st.roofShape } } });
        return;
      }
      if (d?.roof) commit({ roofs: { [newId()]: d.roof } });
    },
    draw(ctx) {
      const d = st.drag;
      if (d?.roof) {
        drawRoof(ctx, d.roof, g(), board, 0.8);
        label(ctx, isRound(d.roof) ? `${d.roof.w} across` : `${d.roof.w} × ${d.roof.h}${d.roof.cuts ? ', corners at 45°' : ''}`, d.roof.x * g() + 4 / board.cam.z, d.roof.y * g() - 6 / board.cam.z);
      } else if (st.hover) {
        const hit = st.mods.shiftKey && roofAt(st.hover, current());
        if (hit) { const r = current().roofs[hit]; outline(ctx, ERASE, () => { ctx.beginPath(); roofOutline(ctx, r); ctx.stroke(); }); return; }
        if (st.roofShape) {
          // Over a round room: the roof a click would give it.
          const room = roundRoomAt(st.hover, current());
          if (room) { const s = room[1]; outline(ctx, HOVER, () => { ctx.beginPath(); ctx.arc(s.x * g(), s.y * g(), (s.r + EAVES) * g(), 0, Math.PI * 2); ctx.stroke(); }); }
          return;
        }
        const [c, r] = cellAt(st.hover);
        outline(ctx, HOVER, () => ctx.strokeRect(c * g(), r * g(), g(), g()));
      }
    },
  }));

  /** The diagonal wall within a few pixels of a point, if any. */
  function lineAt(w, sk) {
    const tol = 8 / board.cam.z;
    let best = null, bestD = tol;
    for (const [id, l] of Object.entries(sk.lines)) {
      const ax = l.a[0] * g(), ay = l.a[1] * g(), dx = l.b[0] * g() - ax, dy = l.b[1] * g() - ay;
      const t = Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const dist = Math.hypot(w.x - (ax + t * dx), w.y - (ay + t * dy));
      if (dist < bestD) { best = id; bestD = dist; }
    }
    return best;
  }

  // ---------------------------------------------------------------- doors and windows

  /**
   * The round room wall near a point: { id, shape, a (radians round it), stands (there's wall
   * or an opening there, not a stretch taken away where it meets another room) }, or null.
   */
  function roundWallAt(w, sk, tol = 0.3) {
    const p = { x: w.x / g(), y: w.y / g() };
    let best = null, bestD = tol;
    for (const [id, s] of Object.entries(sk.shapes)) {
      if (s.walled === false || !(s.r > 0)) continue;
      const d = Math.abs(Math.hypot(p.x - s.x, p.y - s.y) - s.r);
      if (d < bestD) { best = { id, shape: s, a: Math.atan2(p.y - s.y, p.x - s.x) }; bestD = d; }
    }
    if (!best) return null;
    const s = best.shape, on = [(s.x + s.r * Math.cos(best.a)) * g(), (s.y + s.r * Math.sin(best.a)) * g()];
    best.stands = !!roundOpeningAt(s, best.a) || Object.values(sketchWalls(sk, g())).some((x) => x.src?.shape === best.id && segDist({ x: on[0], y: on[1] }, x.a, x.b) < g() * 0.1);
    return best;
  }
  /**
   * An angle round a round room, in degrees, snapped to about a quarter square along its wall
   * (steps that go evenly round, through north, east, south and west).
   */
  const roundAngle = (a, shape, e) => {
    const deg = (a * 180) / Math.PI;
    const step = free(e) ? 0.1 : 360 / Math.max(4, Math.round((2 * Math.PI * shape.r) / 0.25 / 4) * 4);
    return Math.round(((Math.round(deg / step) * step) % 360 + 360) % 360 * 100) / 100;
  };
  /** Would an opening overlap another in the same round wall (but `skip`)? */
  const roundClash = (shape, op, skip = null) => {
    const me = roundOpening(shape, op);
    return roundOpeningsOf(shape).some((o) => {
      if (o.id === skip) return false;
      const d = Math.abs((((o.mid - me.mid) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      return d < (o.a1 - o.a0) / 2 + (me.a1 - me.a0) / 2;
    });
  };
  const strokeArc = (ctx, s, a0, a1) => { ctx.lineWidth = 6 / board.cam.z; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(s.x * g(), s.y * g(), s.r * g(), a0, a1); ctx.stroke(); };

  const openingTool = (kind) => base({
    cursor: 'pointer',
    down(w, e) {
      const k = kind === 'door' && e.shiftKey ? 'secret_door' : kind;
      const sk = current();
      // A round room's wall: the opening follows its curve.
      const rw = roundWallAt(w, sk);
      if (rw) {
        const copy = structuredClone(rw.shape);
        copy.openings ??= {};
        const hit = roundOpeningAt(rw.shape, rw.a);
        if (hit) {
          if (copy.openings[hit].kind === k) delete copy.openings[hit]; else copy.openings[hit].kind = k;
        } else {
          if (!rw.stands) { toast('There\'s no wall there to set it in.'); return; }
          const op = { at: roundAngle(rw.a, rw.shape, e), width: 1, kind: k };
          if (roundClash(rw.shape, op)) { toast('Too close to another door or window.'); return; }
          copy.openings[newId()] = op;
        }
        commit({ shapes: { [rw.id]: copy } });
        return;
      }
      // A diagonal wall: the opening goes across its square (taken out again, the wall is back).
      const diag = diagonalNear(sk, w, g());
      if (diag) { commit({ edges: { [diag]: sk.edges[diag] === k ? 'wall' : k } }); return; }
      const edge = edgeNear(w, g());
      if (!edge) return;
      commit({ edges: { [edge]: sk.edges[edge] === k ? null : k } });
    },
    move(w, e) { track(w, e); board.invalidate(); },
    draw(ctx) {
      const rw = st.hover && roundWallAt(st.hover, current());
      if (rw) {
        const hit = roundOpeningAt(rw.shape, rw.a);
        const op = hit ? rw.shape.openings[hit] : { at: roundAngle(rw.a, rw.shape, st.mods), width: 1 };
        const { a0, a1 } = roundOpening(rw.shape, op);
        if (hit || rw.stands) outline(ctx, hit ? ERASE : HOVER, () => strokeArc(ctx, rw.shape, a0, a1));
        return;
      }
      const edge = st.hover && (diagonalNear(current(), st.hover, g()) ?? edgeNear(st.hover, g()));
      if (!edge) return;
      const { a, b } = edgeSegment(edge, g());
      const set = ['door', 'secret_door', 'window'].includes(current().edges[edge]);
      outline(ctx, set ? ERASE : HOVER, () => {
        ctx.lineWidth = 6 / board.cam.z;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      });
    },
  });
  board.registerTool('sketch-door', openingTool('door'));
  board.registerTool('sketch-window', openingTool('window'));

  // ---------------------------------------------------------------- props: place

  /**
   * Where a new prop goes (squares). A light source next to a wall is mounted on it; other props
   * snap to half squares. With Ctrl (or Cmd): exactly where the pointer is.
   */
  function propSpot(w, exact) {
    const x = w.x / g(), y = w.y / g();
    if (exact) return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    // Small light sources go on walls; a magic circle lies on the floor like furniture.
    if (isLight(st.prop) && propDef(st.prop).w < 1) {
      const edge = edgeNear(w, g(), 0.22);
      if (edge) {
        const [dir, rest] = edge.split(':');
        const [c, r] = cellOf(rest);
        // On the edge's middle, nudged off the wall to the pointer's side.
        return dir === 'h' ? { x: c + 0.5, y: r + (y < r ? -0.2 : 0.2) } : { x: c + (x < c ? -0.2 : 0.2), y: r + 0.5 };
      }
      return { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 };
    }
    // Snap the prop's corner to the grid when its size is whole squares, else its middle.
    const def = propDef(st.prop);
    const snap = (v, size) => (Number.isInteger(size) && size % 2 === 0 ? Math.round(v) : Math.floor(v) + 0.5);
    return { x: snap(x, def.w), y: snap(y, def.h) };
  }

  board.registerTool('sketch-place', base({
    cursor: 'crosshair',
    enter() { api.sketchRefit(); openPropPalette(); },
    down(w, e) { placeProp(w, free(e)); },
    // Shift+wheel: the next prop's size (Ctrl: finer); Alt+wheel: its turn (Shift+Alt: finer).
    // Right-click: stop placing, and select props instead.
    rightClick() { board.setTool('sketch-select'); return true; },
    wheel(w, e) {
      if (!e.shiftKey && !e.altKey) return false;
      const up = (e.deltaY || e.deltaX) < 0;
      if (e.altKey) st.placeRot = turnBy(st.placeRot ?? 0, up, e.shiftKey);
      else st.placeScale = sizeBy(st.placeScale ?? 1, up, free(e));
      track(w, e);
      board.invalidate();
      renderBar();
      return true;
    },
    move(w, e) { track(w, e); board.invalidate(); },
    draw(ctx) {
      if (!st.hover) return;
      ctx.save();
      ctx.globalAlpha = 0.6;
      drawPropAt(ctx, { kind: st.prop, ...propSpot(st.hover, st.mods.free), rot: st.placeRot ?? 0, scale: st.placeScale ?? 1 }, g(), { seed: 'preview' });
      ctx.restore();
    },
  }));

  /** A size after one wheel notch: 10% (Ctrl: 2%), between a quarter and 8 times. */
  function sizeBy(v, up, fine) {
    const f = fine ? 1.02 : 1.1;
    const next = up ? v * f : v / f;
    return Math.max(0.25, Math.min(8, Math.round(next * 100) / 100));
  }
  /** A turn after one wheel notch: 10° (fine: 1°). */
  function turnBy(v, up, fine) {
    const step = fine ? 1 : 10;
    const next = fine ? v + (up ? -step : step) : Math.round((v + (up ? -step : step)) / step) * step;
    return ((next % 360) + 360) % 360;
  }

  /** Put the chosen prop down at a point (exact: where it is, without snapping). */
  function placeProp(w, exact) {
    const def = propDef(st.prop);
    commit({ props: { [newId()]: { kind: st.prop, ...propSpot(w, exact), rot: st.placeRot ?? 0, scale: st.placeScale ?? 1, blocks: !!def.blocks } } });
    const s = scene();
    if (def.light && (s.darkness ?? 0) < 0.5 && !st.toldDark) {
      st.toldDark = true;
      toast('Light sources light the map once it\'s dark: Lighting → Day / night, or raise the darkness in the scene settings.');
    }
  }

  /** The Map props tab in the sidebar: a search box, then each group of props. */
  function renderPropsPanel(panel) {
    const pick = (p) => el('button', {
      class: st.prop === p.id && board.tool === 'sketch-place' ? 'prop-pick active' : 'prop-pick', title: `${p.label}: click, then click the map; or drag it onto the map`, type: 'button',
      draggable: 'true', 'data-name': p.label.toLowerCase(),
      on: {
        click: () => st.chooseProp(p.id),
        dragstart: (e) => { e.dataTransfer.setData('application/x-hearth-prop', p.id); e.dataTransfer.effectAllowed = 'copy'; },
      },
    }, el('img', { src: propThumb(p.id), alt: '', draggable: 'false' }), el('span', { text: p.label }));
    const all = [...LIGHTS, ...FURNITURE];
    const sections = PROP_GROUPS.map((gr) => {
      const list = all.filter((p) => p.group === gr.id);
      return el('div.prop-section', {}, el('div.small.muted', { text: gr.label, style: 'margin: 8px 0 4px' }), el('div.prop-grid', {}, ...list.map(pick)));
    });
    const none = el('p.small.muted', { text: 'No props match.', hidden: true });
    const filter = (q) => {
      q = q.trim().toLowerCase();
      st.propSearch = q;
      let any = false;
      for (const sec of sections) {
        let shown = 0;
        for (const b of sec.querySelectorAll('.prop-pick')) { const ok = !q || b.dataset.name.includes(q); b.hidden = !ok; if (ok) shown++; }
        sec.hidden = !shown;
        if (shown) any = true;
      }
      none.hidden = any;
    };
    const search = el('input.prop-search', { type: 'search', placeholder: 'Find a prop…', value: st.propSearch ?? '', on: { input: (e) => filter(e.target.value) } });
    panel.replaceChildren(
      el('p.small.muted', { text: 'Click a prop, then click the map to place it, or drag it onto the map. Light sources next to a wall go on the wall. Hold Ctrl (Cmd on a Mac) to place it exactly, without snapping. Move, turn, resize and recolour props with Sketch → Select.' }),
      search, none, ...sections,
    );
    if (st.propSearch) filter(st.propSearch);
  }
  hooks.on('ready', () => {
    if (st.tabAdded || !api.sidebar) return;
    st.tabAdded = true;
    api.sidebar.addTab({ id: 'props', label: 'Map props', icon: 'sketch-place', gmOnly: true, render: renderPropsPanel });
  });
  /** Show the props in the sidebar. */
  function openPropPalette() {
    if (!api.sidebar?.tabs.has('props')) return;
    if (api.sidebar.current !== 'props' || api.sidebar.collapsed) api.sidebar.select('props', { toggle: false });
    else api.sidebar.refresh('props');
  }
  st.openPropPalette = openPropPalette;

  // Drag a prop from the sidebar onto the map.
  board.canvas.addEventListener('dragover', (e) => {
    if (isGM() && e.dataTransfer.types.includes('application/x-hearth-prop')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  board.canvas.addEventListener('drop', (e) => {
    const kind = e.dataTransfer.getData('application/x-hearth-prop');
    if (!kind || !isGM() || !scene()) return;
    e.preventDefault();
    st.prop = kind;
    placeProp(board.toWorld(e.offsetX, e.offsetY), free(e));
    if (board.tool !== 'sketch-place') board.setTool('sketch-place'); else openPropPalette();
  });

  // ---------------------------------------------------------------- select: move, resize, turn, remove

  const PAD = () => 6 / board.cam.z;
  const HANDLE = () => 7 / board.cam.z;
  const segDist = (w, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((w.x - a[0]) * dx + (w.y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(w.x - (a[0] + t * dx), w.y - (a[1] + t * dy));
  };
  const OPENINGS = ['door', 'secret_door', 'window'];

  /** What's under a point, topmost first: a prop, a door or window, a wall, a round room. */
  function pick(w, sk) {
    const area = (p) => { const d = propDef(p.kind); return d.w * d.h * (p.scale ?? 1) ** 2; };
    const props = Object.entries(sk.props).filter(([, p]) => propHit(p, g(), w, PAD())).sort((a, b) => area(a[1]) - area(b[1]));
    if (props.length) return { type: 'prop', id: props[0][0] };
    const rw = roundWallAt(w, sk, 0.25);
    const rop = rw && roundOpeningAt(rw.shape, rw.a);
    if (rop) return { type: 'ropening', id: rw.id, oid: rop };
    const edge = diagonalNear(sk, w, g(), 0.2, (v) => OPENINGS.includes(v)) ?? edgeNear(w, g(), 0.2);
    if (edge && OPENINGS.includes(sk.edges[edge])) return { type: 'opening', id: edge };
    let best = null, bestD = PAD() + 2;
    for (const wall of Object.values(sketchWalls(sk, g()))) {
      if (wall.src?.prop || wall.src?.opening) continue;
      const d = segDist(w, wall.a, wall.b);
      if (d < bestD) { best = wall; bestD = d; }
    }
    if (best?.src?.line) return { type: 'line', id: best.src.line };
    if (best?.src?.shape) return { type: 'shape', id: best.src.shape };
    if (best?.src?.edges) return { type: 'wall', edges: best.src.edges };
    const shapes = Object.entries(sk.shapes).filter(([, s]) => (w.x / g() - s.x) ** 2 + (w.y / g() - s.y) ** 2 <= s.r * s.r).sort((a, b) => a[1].r - b[1].r);
    if (shapes.length) return { type: 'shape', id: shapes[0][0] };
    const roof = roofAt(w, sk);
    if (roof) return { type: 'roof', id: roof };
    return null;
  }

  const itemOf = (sel, sk) => {
    if (!sel) return null;
    if (sel.type === 'prop') return sk.props[sel.id];
    if (sel.type === 'shape') return sk.shapes[sel.id];
    if (sel.type === 'line') return sk.lines[sel.id];
    if (sel.type === 'roof') return sk.roofs[sel.id];
    if (sel.type === 'opening') return OPENINGS.includes(sk.edges[sel.id]) ? { kind: sk.edges[sel.id] } : null;
    if (sel.type === 'ropening') { const o = sk.shapes[sel.id]?.openings?.[sel.oid]; return o && ROUND_OPENINGS.includes(o.kind) ? o : null; }
    if (sel.type === 'wall') return sel.edges?.length ? {} : null;
    return null;
  };

  /** The selection's handles (scene px): resize, turn, or a line's ends. */
  function handlesOf(sel, sk) {
    const it = itemOf(sel, sk);
    if (!it) return [];
    if (sel.type === 'prop') {
      const def = propDef(it.kind), sc = it.scale ?? 1, a = ((it.rot ?? 0) * Math.PI) / 180;
      const hw = (def.w * sc * g()) / 2, hh = (def.h * sc * g()) / 2;
      const at = (lx, ly) => ({ x: it.x * g() + lx * Math.cos(a) - ly * Math.sin(a), y: it.y * g() + lx * Math.sin(a) + ly * Math.cos(a) });
      return [{ kind: 'resize', ...at(hw, hh) }, { kind: 'rotate', ...at(0, -hh - 0.35 * g()) }];
    }
    if (sel.type === 'shape') return [{ kind: 'resize', x: (it.x + it.r) * g(), y: it.y * g() }];
    if (sel.type === 'roof') return [{ kind: 'resize', x: (it.x + it.w) * g(), y: (it.y + it.h) * g() }];
    if (sel.type === 'line') return [{ kind: 'a', x: it.a[0] * g(), y: it.a[1] * g() }, { kind: 'b', x: it.b[0] * g(), y: it.b[1] * g() }];
    return [];
  }

  /** Take the selection away. */
  function removeSelected() {
    const sel = st.sel, sk = current();
    if (!itemOf(sel, sk)) return;
    if (sel.type === 'prop') commit({ props: { [sel.id]: null } });
    else if (sel.type === 'shape') commit({ shapes: { [sel.id]: null } });
    else if (sel.type === 'line') commit({ lines: { [sel.id]: null } });
    else if (sel.type === 'roof') commit({ roofs: { [sel.id]: null } });
    else if (sel.type === 'opening') commit({ edges: { [sel.id]: isDiagonal(sel.id) ? 'wall' : null } });
    else if (sel.type === 'ropening') {
      const copy = structuredClone(sk.shapes[sel.id]);
      delete copy.openings[sel.oid];
      commit({ shapes: { [sel.id]: copy } });
    } else if (sel.type === 'wall') {
      const edges = {};
      for (const e of sel.edges) edges[e] = sk.edges[e] === 'wall' ? null : 'open';
      commit({ edges });
    }
    select(null);
  }

  /** Change the selected item: `fn(copy)` edits a copy, which is sent. */
  function editSelected(fn) {
    const sel = st.sel, sk = current();
    const it = itemOf(sel, sk);
    if (!it) return;
    const copy = structuredClone(it);
    fn(copy);
    if (sel.type === 'ropening') {
      const shape = structuredClone(sk.shapes[sel.id]);
      shape.openings[sel.oid] = copy;
      commit({ shapes: { [sel.id]: shape } });
      return;
    }
    const map ={ prop: 'props', shape: 'shapes', line: 'lines', roof: 'roofs' }[sel.type];
    if (map) commit({ [map]: { [sel.id]: copy } });
  }

  function select(sel) {
    st.sel = sel;
    renderBar();
    board.invalidate();
  }

  const snapTo = (v, step) => Math.round(Math.round(v / step) * step * 10000) / 10000;

  board.registerTool('sketch-select', base({
    cursor: 'default',
    enter() { api.sketchRefit(); renderBar(); },
    // Shift+wheel: the size of the prop under the pointer (or the selected one; Ctrl: finer);
    // Alt+wheel: its turn, 10° (Shift+Alt: 1°). Shown at once, sent once the wheel stops.
    wheel(w, e) {
      if (!e.shiftKey && !e.altKey) return false;
      const sk = current();
      // The prop under the pointer (the smallest, if they overlap), else the selected one.
      const under = Object.entries(sk.props).filter(([, p]) => propHit(p, g(), w)).sort((a, b) => (a[1].scale ?? 1) * propDef(a[1].kind).w - (b[1].scale ?? 1) * propDef(b[1].kind).w)[0];
      const id = st.wheel?.id && sk.props[st.wheel.id] ? st.wheel.id : under?.[0] ?? (st.sel?.type === 'prop' && sk.props[st.sel.id] ? st.sel.id : null);
      if (!id) return true;
      if (st.sel?.id !== id) select({ type: 'prop', id });
      const wh = st.wheel?.id === id ? st.wheel : (st.wheel = { id, copy: structuredClone(sk.props[id]), timer: null });
      const up = (e.deltaY || e.deltaX) < 0;
      if (e.altKey) wh.copy.rot = turnBy(wh.copy.rot ?? 0, up, e.shiftKey);
      else wh.copy.scale = sizeBy(wh.copy.scale ?? 1, up, free(e));
      setDraft({ props: { [id]: wh.copy } });
      clearTimeout(wh.timer);
      wh.timer = setTimeout(() => {
        st.wheel = null;
        setDraft(null);
        commit({ props: { [id]: wh.copy } });
      }, 350);
      return true;
    },
    leave() { st.hover = null; st.drag = null; setDraft(null); renderBar(); },
    down(w) {
      const sk = current();
      const h = handlesOf(st.sel, sk).find((x) => Math.hypot(x.x - w.x, x.y - w.y) <= HANDLE() * 1.6);
      if (h) { st.drag = { mode: h.kind, start: w, orig: structuredClone(itemOf(st.sel, sk)), moved: false }; return; }
      const hit = pick(w, sk);
      select(hit);
      if (hit && hit.type !== 'wall') st.drag = { mode: 'move', start: w, orig: structuredClone(itemOf(hit, sk)), moved: false };
    },
    move(w, e) {
      track(w, e);
      const d = st.drag;
      if (!d) { board.invalidate(); return; }
      if (!d.moved && Math.hypot(w.x - d.start.x, w.y - d.start.y) < 4 / board.cam.z) return;
      d.moved = true;
      const sel = st.sel, o = d.orig, G = g();
      const dx = (w.x - d.start.x) / G, dy = (w.y - d.start.y) / G;
      let patch = null;
      if (sel.type === 'prop') {
        const p = { ...o };
        if (d.mode === 'move') {
          const step = free(e) ? 0.01 : 0.25;
          p.x = snapTo(o.x + dx, step); p.y = snapTo(o.y + dy, step);
        } else if (d.mode === 'rotate') {
          const ang = (Math.atan2(w.y - o.y * G, w.x - o.x * G) * 180) / Math.PI + 90;
          p.rot = ((free(e) ? Math.round(ang) : snapTo(ang, 15)) + 360) % 360;
        } else if (d.mode === 'resize') {
          const d0 = Math.hypot(d.start.x - o.x * G, d.start.y - o.y * G) || 1;
          const d1 = Math.hypot(w.x - o.x * G, w.y - o.y * G);
          const sc = (o.scale ?? 1) * (d1 / d0);
          p.scale = Math.max(0.1, Math.min(8, free(e) ? Math.round(sc * 100) / 100 : snapTo(sc, 0.25)));
        }
        patch = { props: { [sel.id]: p } };
      } else if (sel.type === 'shape') {
        const s = { ...o };
        const step = free(e) ? 0.01 : 0.5;
        if (d.mode === 'move') { s.x = snapTo(o.x + dx, step); s.y = snapTo(o.y + dy, step); } else { s.r = Math.max(free(e) ? 0.1 : 0.5, snapTo(Math.hypot(w.x / G - o.x, w.y / G - o.y), step)); }
        patch = { shapes: { [sel.id]: s } };
      } else if (sel.type === 'line') {
        const l = { ...o };
        if (d.mode === 'move') { const mx = free(e) ? fine(dx) : Math.round(dx), my = free(e) ? fine(dy) : Math.round(dy); l.a = [fine(o.a[0] + mx), fine(o.a[1] + my)]; l.b = [fine(o.b[0] + mx), fine(o.b[1] + my)]; } else l[d.mode] = endAt(w, e);
        patch = { lines: { [sel.id]: l } };
      } else if (sel.type === 'roof') {
        const r = { ...o };
        if (isRound(o)) {
          // Round: moved by half squares, sized from its middle (and kept round).
          const step = free(e) ? 0.01 : 0.5, cx = o.x + o.w / 2, cy = o.y + o.h / 2;
          if (d.mode === 'move') { r.x = fine(o.x + snapTo(dx, step)); r.y = fine(o.y + snapTo(dy, step)); } else {
            const rad = Math.max(0.5, snapTo(Math.hypot(w.x / G - cx, w.y / G - cy) / Math.SQRT2, step / 2));
            r.x = fine(cx - rad); r.y = fine(cy - rad); r.w = r.h = fine(rad * 2);
          }
        } else if (d.mode === 'move') { r.x = o.x + Math.round(dx); r.y = o.y + Math.round(dy); } else { r.w = Math.max(1, Math.round(w.x / G - o.x)); r.h = Math.max(1, Math.round(w.y / G - o.y)); }
        patch = { roofs: { [sel.id]: r } };
      } else if (sel.type === 'ropening') {
        // Round the wall it's in.
        const shape = current().shapes[sel.id];
        const op = { ...o, at: roundAngle(Math.atan2(w.y / G - shape.y, w.x / G - shape.x), shape, e) };
        patch = roundClash(shape, op, sel.oid) ? null : { shapes: { [sel.id]: { ...shape, openings: { ...shape.openings, [sel.oid]: op } } } };
      } else if (sel.type === 'opening') {
        // Along a diagonal wall, to another square of diagonal wall; else to another grid edge.
        const sk = current();
        const target = isDiagonal(sel.id) ? diagonalNear(sk, w, G, 0.5, (v) => v === 'wall') : edgeNear(w, G, 0.5);
        d.target = target && target !== sel.id && !OPENINGS.includes(sk.edges[target]) ? target : null;
        patch = d.target ? { edges: { [sel.id]: isDiagonal(sel.id) ? 'wall' : null, [d.target]: o.kind } } : null;
      }
      setDraft(patch);
    },
    up() {
      const d = st.drag;
      st.drag = null;
      const patch = board.sketchDraft?.patch;
      setDraft(null);
      if (!d?.moved || !patch) return;
      if (commit(patch) && st.sel.type === 'opening' && d.target) st.sel = { type: 'opening', id: d.target };
      renderBar();
    },
    key(e) {
      const sel = st.sel;
      if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { removeSelected(); return true; }
      if (sel && e.key === 'Escape') { select(null); return true; }
      if (sel?.type === 'prop' && e.key.toLowerCase() === 'r') { editSelected((p) => { p.rot = (((p.rot ?? 0) + (e.shiftKey ? -45 : 45)) % 360 + 360) % 360; }); return true; }
      if (sel && (e.key === '+' || e.key === '=' || e.key === '-')) {
        const up = e.key !== '-';
        if (sel.type === 'prop') editSelected((p) => { p.scale = Math.max(0.25, Math.min(8, (p.scale ?? 1) + (up ? 0.25 : -0.25))); });
        if (sel.type === 'shape') editSelected((s) => { s.r = Math.max(0.5, s.r + (up ? 0.5 : -0.5)); });
        return true;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (sel && arrows[e.key] && ['prop', 'shape', 'line'].includes(sel.type)) {
        const [ax, ay] = arrows[e.key];
        const step = free(e) ? 0.05 : sel.type === 'line' ? 1 : 0.5;
        editSelected((it) => {
          if (sel.type === 'line') { it.a = [fine(it.a[0] + ax * step), fine(it.a[1] + ay * step)]; it.b = [fine(it.b[0] + ax * step), fine(it.b[1] + ay * step)]; } else { it.x = Math.round((it.x + ax * step) * 100) / 100; it.y = Math.round((it.y + ay * step) * 100) / 100; }
        });
        return true;
      }
      return keys(e);
    },
    draw(ctx) {
      const sk = withPatch(scene()?.sketch, board.sketchDraft?.patch);
      const z = board.cam.z;
      const mark = (sel, color, dashed) => {
        const it = itemOf(sel, sk);
        if (!it) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 / z;
        if (dashed) ctx.setLineDash([6 / z, 4 / z]);
        ctx.beginPath();
        if (sel.type === 'roof') {
          roofOutline(ctx, it);
        } else if (sel.type === 'prop') {
          const pts = propOutline(it, g());
          pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
          ctx.closePath();
        } else if (sel.type === 'shape') {
          ctx.arc(it.x * g(), it.y * g(), it.r * g(), 0, Math.PI * 2);
        } else if (sel.type === 'line') {
          ctx.lineWidth = 6 / z;
          ctx.moveTo(it.a[0] * g(), it.a[1] * g()); ctx.lineTo(it.b[0] * g(), it.b[1] * g());
        } else if (sel.type === 'ropening') {
          const s = sk.shapes[sel.id], { a0, a1 } = roundOpening(s, it);
          ctx.lineWidth = 6 / z;
          ctx.arc(s.x * g(), s.y * g(), s.r * g(), a0, a1);
        } else {
          ctx.lineWidth = 6 / z;
          for (const e of sel.type === 'wall' ? sel.edges : [st.drag?.target ?? sel.id]) { const s = edgeSegment(e, g()); ctx.moveTo(...s.a); ctx.lineTo(...s.b); }
        }
        ctx.stroke();
        ctx.restore();
      };
      if (st.hover && !st.drag) {
        const h = pick(st.hover, sk);
        if (h && JSON.stringify(h) !== JSON.stringify(st.sel)) mark(h, 'rgba(255, 190, 40, 0.5)', true);
      }
      if (st.sel) {
        mark(st.sel, HOVER, false);
        for (const h of handlesOf(st.sel, sk)) {
          ctx.save();
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5 / z;
          ctx.beginPath();
          if (h.kind === 'rotate') ctx.arc(h.x, h.y, HANDLE() * 0.8, 0, Math.PI * 2); else ctx.rect(h.x - HANDLE() / 2, h.y - HANDLE() / 2, HANDLE(), HANDLE());
          ctx.fill(); ctx.stroke();
          ctx.restore();
        }
      }
    },
  }));

  // ---------------------------------------------------------------- the selection bar

  const bar = el('div.sketch-bar', { hidden: true });
  document.getElementById('app')?.append(bar);
  hooks.on('op:sketch_update', () => renderBar());
  hooks.on('op:light_update', () => renderBar());
  hooks.on('op:world_update', (op) => { if (op.patch?.settings?.sketch) { swatches.clear(); renderBar(); } });
  hooks.on('board:tool', () => renderBar());

  function renderBar() {
    const sk = current();
    const show = board.tool.startsWith('sketch-') && isGM() && !!scene();
    bar.hidden = !show;
    if (!show) { st.pick = null; return; }
    if (board.tool !== 'sketch-select') { bar.replaceChildren(...toolOptions(sk)); return; }
    if (st.sel && !itemOf(st.sel, sk)) st.sel = null;
    const sel = st.sel;
    const btn = (text, title, fn, cls = '') => el('button', { type: 'button', class: cls, title, text, on: { click: fn } });
    const styleSelect = (value, set) => el('select', { title: 'How the wall is drawn', on: { change: (e) => set(e.target.value || null) } },
      el('option', { value: '', text: `Style: default (${WALL_STYLES.find((x) => x.id === (sk.wall_style || 'ink'))?.label})`, selected: !value }),
      ...[...WALL_STYLES, ...made()].map((x) => el('option', { value: x.id, text: x.label, selected: value === x.id })));
    const del = btn('Delete', 'Remove it (Delete)', removeSelected, 'danger');
    let items;
    if (!sel) {
      items = [el('span.muted', { text: 'Click a prop, door, window, wall, round room or roof to select it. Drag to move; handles resize and turn.' })];
    } else if (sel.type === 'prop') {
      const p = sk.props[sel.id], def = propDef(p.kind);
      items = [
        el('b', { text: def.label }),
        btn('⟲', 'Turn left (Shift+R)', () => editSelected((x) => { x.rot = (((x.rot ?? 0) - 45) % 360 + 360) % 360; })),
        btn('⟳', 'Turn right (R)', () => editSelected((x) => { x.rot = ((x.rot ?? 0) + 45) % 360; })),
        btn('−', 'Smaller (-)', () => editSelected((x) => { x.scale = Math.max(0.25, (x.scale ?? 1) - 0.25); })),
        el('span.muted', { text: `${Math.round((p.scale ?? 1) * 100)}%` }),
        btn('+', 'Bigger (+)', () => editSelected((x) => { x.scale = Math.min(8, (x.scale ?? 1) + 0.25); })),
      ];
      if (def.block) {
        items.push(el('label.check', {}, el('input', { type: 'checkbox', checked: !!p.blocks, on: { change: (e) => editSelected((x) => { x.blocks = e.target.checked; }) } }),
          def.block === 'wall' ? ' Blocks movement and sight' : ' Blocks movement'));
      }
      if (def.light) {
        const lid = skId(`sk-p-${sel.id}`, board.level);
        const light = scene().lights?.[lid];
        items.push(el('label.check', {}, el('input', { type: 'checkbox', checked: !light?.off, on: { change: (e) => api.op({ op: 'light_update', scene_id: scene().id, id: lid, patch: { off: !e.target.checked } }) } }), ' Lit'));
        if (light) items.push(btn('Light…', 'Its light: how far it reaches, its colour and how it moves', () => board.configureLight(light)));
      }
      if (def.link) {
        // Stairs, ladders: the level they lead to.
        const others = levelsOf(scene()).filter((l) => l.id !== board.level);
        items.push(el('select', { title: 'Where it leads: a token that steps onto it goes to that level', on: { change: (e) => editSelected((x) => { x.to = e.target.value === '-' ? null : e.target.value; }) } },
          el('option', { value: '-', text: others.length ? 'Leads nowhere' : 'Leads nowhere (add levels first)', selected: p.to == null }),
          ...[...others].reverse().map((l) => el('option', { value: l.id, text: `Leads to ${l.name}`, selected: p.to === l.id }))));
      }
      if (def.parts?.length) {
        const open = st.partsOpen === sel.id;
        items.push(btn(open ? 'Colours ▴' : 'Colours ▾', 'Recolour its parts, or give them a texture', () => { st.partsOpen = open ? null : sel.id; renderBar(); }, open ? 'open' : ''));
        if (open) items.push(partsPanel(sel.id, p, def));
      }
      items.push(del);
    } else if (sel.type === 'shape') {
      const s = sk.shapes[sel.id];
      items = [
        el('b', { text: s.walled !== false ? 'Round room' : 'Round floor' }),
        btn('−', 'Smaller (-)', () => editSelected((x) => { x.r = Math.max(0.5, x.r - 0.5); })),
        el('span.muted', { text: `${s.r * 2} across` }),
        btn('+', 'Bigger (+)', () => editSelected((x) => { x.r += 0.5; })),
        el('label.check', {}, el('input', { type: 'checkbox', checked: s.walled !== false, on: { change: (e) => editSelected((x) => { x.walled = e.target.checked; }) } }), ' Walls'),
      ];
      if (s.walled !== false) items.push(styleSelect(s.wall_style, (v) => editSelected((x) => { x.wall_style = v; })));
      items.push(del);
    } else if (sel.type === 'line') {
      const l = sk.lines[sel.id];
      items = [el('b', { text: 'Diagonal wall' }), styleSelect(l.style, (v) => editSelected((x) => { x.style = v; })), del];
    } else if (sel.type === 'wall') {
      const style = sk.styles[sel.edges[0]] ?? null;
      items = [
        el('b', { text: `Wall, ${sel.edges.length} square${sel.edges.length > 1 ? 's' : ''}` }),
        styleSelect(style, (v) => commit({ styles: Object.fromEntries(sel.edges.map((e) => [e, v])) })),
        btn('Remove', 'Take this stretch of wall away (Delete)', removeSelected, 'danger'),
      ];
    } else if (sel.type === 'roof') {
      const r = sk.roofs[sel.id];
      items = [
        el('b', { text: isRound(r) ? `Round roof, ${r.w} across` : `Roof, ${r.w} × ${r.h}` }),
        el('select', { title: 'What it\'s made of', on: { change: (e) => editSelected((x) => { x.material = e.target.value; }) } },
          ...[...ROOF_MATERIALS, ...made()].map((m) => el('option', { value: m.id, text: m.label, selected: r.material === m.id }))),
        roofShapeSelect(r.shape, (v) => editSelected((x) => {
          if (v) {
            // Round: a circle over the middle of what it covered.
            const d = Math.max(x.w, x.h);
            if (x.w !== x.h) { x.x = fine(x.x + (x.w - d) / 2); x.y = fine(x.y + (x.h - d) / 2); x.w = x.h = d; }
            x.shape = v;
            delete x.ridge;
            delete x.cuts;
          } else {
            // Hipped again: back on whole squares.
            x.x = Math.floor(x.x); x.y = Math.floor(x.y); x.w = Math.max(1, Math.round(x.w)); x.h = Math.max(1, Math.round(x.h));
            delete x.shape;
          }
        })),
      ];
      if (!isRound(r)) {
        // Each corner cut off at 45° by so many squares (to follow diagonal walls).
        const cuts = cutsOf(r) ?? {};
        const setCut = (corner, v) => editSelected((x) => {
          x.cuts = { ...(x.cuts ?? {}), [corner]: Math.max(0, Math.round(Number(v) || 0)) };
          const fit = cutsOf(x);
          if (fit) x.cuts = Object.fromEntries(Object.entries(fit).filter(([, k]) => k > 0)); else delete x.cuts;
        });
        const row = 'display:inline-flex;align-items:center;gap:4px;white-space:nowrap';
        items.push(el('span', { style: row, title: 'Cut a corner off at 45° by so many squares, to follow diagonal walls' }, el('span.muted', { text: 'Corners at 45°' }),
          ...CORNERS.map((corner) => el('span', { style: row, title: `The ${corner.toUpperCase()} corner cut off by so many squares` }, el('span.muted', { text: corner.toUpperCase() }),
            el('input', { type: 'number', min: '0', max: String(Math.min(r.w, r.h)), step: '1', value: String(cuts[corner] ?? 0), style: 'width:3.2em', 'aria-label': `${corner.toUpperCase()} corner cut`, on: { change: (e) => setCut(corner, e.target.value) } })))),
          btn('Fit to the walls', 'Cut the corners to follow the diagonal walls across them', () => {
            const fit = wallCuts(r, current());
            if (!fit && !r.cuts) { toast('No diagonal walls run across this roof’s corners.'); return; }
            editSelected((x) => { if (fit) x.cuts = fit; else delete x.cuts; });
          }));
      }
      if (!isRound(r) && !cutsOf(r)) items.push(btn('Turn the ridge', 'The ridge runs the other way (a roof on its own; joined roofs follow the building)', () => editSelected((x) => { x.ridge = (x.ridge ?? (x.w >= x.h ? 'h' : 'v')) === 'h' ? 'v' : 'h'; })));
      items.push(del);
    } else if (sel.type === 'opening') {
      const kind = sk.edges[sel.id];
      items = [
        el('select', { title: 'What it is', on: { change: (e) => commit({ edges: { [sel.id]: e.target.value } }) } },
          ...[['door', 'Door'], ['secret_door', 'Secret door'], ['window', 'Window'], ['railing', 'Railing']].map(([v, t]) => el('option', { value: v, text: t, selected: kind === v }))),
        el('span.muted', { text: 'Drag it to another edge.' }),
        del,
      ];
    } else if (sel.type === 'ropening') {
      const s = sk.shapes[sel.id], o = s.openings[sel.oid], wide = o.width ?? 1;
      // As wide as fits: up to most of the room across, short of the doors and windows beside it.
      const widen = (d) => editSelected((x) => {
        const next = Math.max(0.5, Math.min(Math.floor(s.r * 1.8 * 2) / 2, wide + d));
        if (d > 0 && roundClash(s, { ...x, width: next }, sel.oid)) { toast('No room: another door or window is in the way.'); return; }
        x.width = next;
      });
      items = [
        el('select', { title: 'What it is', on: { change: (e) => editSelected((x) => { x.kind = e.target.value; }) } },
          ...[['door', 'Door'], ['secret_door', 'Secret door'], ['window', 'Window']].map(([v, t]) => el('option', { value: v, text: t, selected: o.kind === v }))),
        btn('−', 'Narrower', () => widen(-0.5)),
        el('span.muted', { text: `${wide} wide` }),
        btn('+', 'Wider', () => widen(0.5)),
        el('span.muted', { text: 'Drag it round the wall.' }),
        del,
      ];
    }
    bar.replaceChildren(...items);
  }
  st.renderBar = renderBar;

  /** The light source on this level whose light this is: { id, label }. */
  st.propOfLight = (lid) => {
    for (const [id, p] of Object.entries(current().props)) if (skId(`sk-p-${id}`, board.level) === lid) return { id, label: propDef(p.kind).label };
    return null;
  };
  /** Give a light source its own light (radii, colour strength, animation); its colour is its glow. */
  st.setPropLight = (id, look) => {
    const p = current().props[id];
    if (!p) return;
    const copy = structuredClone(p);
    copy.light = { bright: look.bright, dim: look.dim, ...(look.tint != null ? { tint: look.tint } : {}), ...(look.anim ? { anim: look.anim } : {}) };
    if (look.color && look.color !== propLightColor(p)) copy.colors = { ...(copy.colors ?? {}), glow: look.color };
    commit({ props: { [id]: copy } });
  };

  /** A prop's parts: a colour each, or a texture, and back to its own look. */
  function partsPanel(id, p, def) {
    const textures = [...floorChoices(), ...WALL_STYLES.filter((w) => texture(w.id) && !MATERIALS.some((m) => m.id === w.id)), ...ROOF_MATERIALS];
    const set = (partId, value, live = false) => {
      const copy = structuredClone(current().props[id] ?? p);
      const colors = { ...(copy.colors ?? {}) };
      if (value == null) delete colors[partId]; else colors[partId] = value;
      if (Object.keys(colors).length) copy.colors = colors; else delete copy.colors;
      if (live) { setDraft({ props: { [id]: copy } }); return; }
      setDraft(null);
      commit({ props: { [id]: copy } });
    };
    const rows = def.parts.map((pt) => {
      const v = p.colors?.[pt.id];
      const hex = isHex(v) ? v : pt.color;
      const tex = v && !isHex(v) ? v : '';
      return el('div.part-row', {},
        el('span', { text: pt.label }),
        el('input', { type: 'color', value: hex, title: `${pt.label}: its colour`, on: { input: (e) => set(pt.id, e.target.value, true), change: (e) => set(pt.id, e.target.value) } }),
        pt.id === 'glow' ? el('span.muted.small', { text: 'its light too' }) : el('select', { title: `${pt.label}: or a texture`, on: { change: (e) => set(pt.id, e.target.value || hex) } },
          el('option', { value: '', text: 'Plain colour', selected: !tex }),
          ...textures.map((m) => el('option', { value: m.id, text: m.label, selected: m.id === tex }))),
        el('button', { type: 'button', text: '↺', title: 'Back to its own look', disabled: !v, on: { click: () => set(pt.id, null) } }));
    });
    return el('div.opt-pop.parts-pop', {}, el('div.small.muted', { text: `${def.label}: its parts` }), ...rows,
      Object.keys(p.colors ?? {}).length ? el('button', { type: 'button', text: 'All back to its own look', on: { click: () => { const copy = structuredClone(p); delete copy.colors; commit({ props: { [id]: copy } }); } } }) : null);
  }

  // ---------------------------------------------------------------- tool options

  const swatches = new Map();
  /** A picture of a texture for its button: built-ins drawn once, uploads as they are. */
  function swatchUrl(id) {
    if (!id) return null;
    if (!swatches.has(id) || (!swatches.get(id) && id.startsWith('tex:'))) {
      const t = texture(id);
      let url = /^(\/|https?:|data:)/.test(id) ? id : null;
      if (t) {
        // Two squares' worth, so every swatch shows its texture at the same scale.
        const c = document.createElement('canvas');
        c.width = c.height = 256;
        c.getContext('2d').drawImage(t, 0, 0, 256, 256, 0, 0, 256, 256);
        url = c.toDataURL();
      }
      swatches.set(id, url);
    }
    return swatches.get(id);
  }
  /** Textures made in the texture creator, as choices. */
  const made = () => recipes().map((t) => ({ id: `tex:${t.id}`, label: t.name, made: t.id }));
  const floorChoices = () => {
    const uploaded = new Set();
    for (const sc of Object.values(store.world?.scenes ?? {})) {
      for (const sk of [sc.sketch, ...Object.values(sc.level_sketches ?? {})]) {
        if (!sk) continue;
        for (const m of [...Object.values(sk.cells ?? {}), ...Object.values(sk.floor ?? {}), ...Object.values(sk.halves ?? {}).flatMap((e) => Object.values(e).map((v) => v.slice(v.indexOf(':') + 1))), ...Object.values(sk.shapes ?? {}).map((x) => x.material), ...Object.values(sk.buildings ?? {}).map((x) => x.material), sk.outside]) {
          if (m && !texture(m) && !m.startsWith('tex:')) uploaded.add(m);
        }
      }
    }
    for (const m of st.extra ?? []) uploaded.add(m.id);
    // Imported from Dungeondraft packs: by name, after the world's own.
    const lib = libraryTextures();
    for (const m of lib) uploaded.delete(m.id);
    return [...MATERIALS, ...made(), ...[...uploaded].map((url) => ({ id: url, label: st.extra?.find((m) => m.id === url)?.label ?? url.split('/').pop() })),
      ...lib.map((m) => ({ id: m.id, label: m.label, pack: m.pack }))];
  };
  /** What each picker offers, what's chosen, and how to choose. */
  const PICKERS = {
    floor: { title: 'Floor', list: floorChoices, get: () => st.material, set: (id) => { st.material = id; } },
    walls: {
      title: 'Walls',
      list: () => { const own = current().wall_style || 'ink'; return [{ id: null, swatch: own, label: `Default (${WALL_STYLES.find((x) => x.id === own)?.label ?? made().find((x) => x.id === own)?.label ?? own})` }, ...WALL_STYLES, ...made()]; },
      get: () => st.wallStyle, set: (id) => { st.wallStyle = id; },
    },
    roof: { title: 'Roof', list: () => [...ROOF_MATERIALS, ...made()], get: () => st.roof, set: (id) => { st.roof = id; } },
    terrain: { title: 'Paint', list: floorChoices, get: () => st.terrain.material, set: (id) => { st.terrain.material = id; } },
    'water-surface': { title: 'Water', list: floorChoices, get: () => waterLook().water ?? 'water', set: (id) => setWater('water', id) },
    'water-shore': { title: 'Shore', list: () => [{ id: null, label: 'None' }, ...floorChoices()], get: () => waterLook().shore ?? null, set: (id) => setWater('shore', id) },
    'water-under': { title: 'Underlay', list: () => [{ id: null, label: 'None: what\'s beneath' }, ...floorChoices()], get: () => waterLook().underlay ?? null, set: (id) => setWater('underlay', id) },
    'trace-floor': { title: 'Floor', list: () => [{ id: null, label: 'None: the map' }, ...floorChoices()], get: () => st.trace.floor, set: (id) => { st.trace.floor = id; } },
    'trace-roof': { title: 'Roof', list: () => [{ id: null, label: 'None' }, ...ROOF_MATERIALS, ...made()], get: () => st.trace.roof, set: (id) => { st.trace.roof = id; } },
    ground: {
      title: 'Ground', list: () => [{ id: null, label: 'Nothing: the map' }, ...floorChoices()],
      get: () => current().outside ?? null, set: (id) => { commit({ outside: id }); },
    },
  };
  // Which tools offer which pickers.
  const OPTIONS = {
    'sketch-room': ['floor', 'walls'],
    'sketch-round': ['floor', 'walls'],
    'sketch-floor': ['floor'],
    'sketch-brush': ['floor', 'brush'],
    'sketch-erase': ['brush'],
    'sketch-terrain': ['terrain', 'terrain-brush', 'terrain-look', 'ground'],
    'sketch-water': ['water-body', 'water-surface', 'water-shore', 'water-under', 'water-look'],
    'sketch-wall': ['walls'],
    'sketch-roof': ['roof', 'roof-shape', 'roofs-shown'],
    'sketch-place': ['prop'],
    'sketch-trace': ['trace-mode', 'trace-floor', 'walls', 'trace-roof', 'trace-look', 'roofs-shown'],
  };
  const HINTS = {
    'sketch-room': 'Shift erases · inside diagonal walls it fills only what they enclose',
    'sketch-round': 'Alt: no walls · Shift-click removes',
    'sketch-floor': 'No walls · Shift erases',
    'sketch-brush': 'Shift erases · [ ] size · size 1 paints one triangle of a square cut by a diagonal',
    'sketch-erase': '[ ] size · size 1 erases one triangle of a square cut by a diagonal',
    'sketch-terrain': 'Shift erases back to the ground · [ ] size · hold still to build paint up · up to 8 textures a map',
    'sketch-water': 'Paint rivers the way they run (paint over to turn them) · Shift erases · Alt-click picks a body of water · [ ] size',
    'sketch-wall': 'Straight or at 45° (a diagonal across a room\'s corner cuts it off) · Alt: any angle, cuts nothing off · Shift-drag removes · Ctrl: no snapping',
    'sketch-railing': 'Railing: blocks movement, not sight · Shift-drag removes',
    'sketch-door': 'Door: click a grid edge, a diagonal wall or a round wall · Shift: secret door · click again to remove',
    'sketch-window': 'Window: click a grid edge, a diagonal wall or a round wall · click again to remove',
    'sketch-roof': 'Shift-click removes · over diagonal walls the corners are cut at 45° · round roofs: drag from the middle, or click a round room',
    'sketch-trace': 'Click inside an outline to build it · drag a box to trace everything inside it · click a traced building to give it these textures · Shift-click removes one',
    'sketch-place': 'Shift+wheel: size · Alt+wheel: turn (Shift+Alt: 1°) · Ctrl: no snapping · right-click: done',
  };

  function toolOptions() {
    const tool = board.tool;
    const items = [];
    if (tool === 'sketch-trace' && st.trace.found) {
      // What a box found: tick off what isn't wanted, then build the rest.
      const n = st.trace.found.filter((f) => f.on).length;
      return [el('b', { text: `Found ${st.trace.found.length} ${traceNoun(st.trace.found.length)}` }),
        el('span.muted', { text: n === st.trace.found.length ? 'Click one to leave it out.' : `${n} to build; click one to leave it out or put it back.` }),
        el('button', { type: 'button', class: 'primary', text: `Build ${n}`, disabled: !n, title: 'Build them with the textures chosen (Enter)', on: { click: buildFound } }),
        el('button', { type: 'button', text: 'Cancel', title: 'Build none of them (Esc)', on: { click: dropFound } })];
    }
    for (const opt of OPTIONS[tool] ?? []) {
      if (PICKERS[opt]) {
        const pk = PICKERS[opt];
        const cur = pk.list().find((m) => m.id === pk.get()) ?? { id: pk.get(), label: String(pk.get()) };
        const url = swatchUrl(cur.swatch ?? cur.id);
        items.push(el('button.opt-pick', {
          type: 'button', title: `${pk.title}: ${cur.label} (click to choose another)`, 'aria-expanded': String(st.pick === opt),
          class: st.pick === opt ? 'opt-pick open' : 'opt-pick',
          on: { click: () => { st.pick = st.pick === opt ? null : opt; renderBar(); } },
        }, el('span.opt-swatch', { class: url ? 'opt-swatch' : 'opt-swatch ink', style: url ? `background-image: url("${url}")` : '' }),
        el('span', { text: `${pk.title}: ${cur.label}` }), el('span.muted', { text: '▾' })));
      } else if (opt === 'brush') {
        const size = (d) => { st.brush = Math.max(1, Math.min(9, st.brush + d)); board.invalidate(); renderBar(); };
        items.push(el('span.muted', { text: 'Size' }),
          el('button', { type: 'button', text: '−', title: 'Smaller ([)', on: { click: () => size(-1) } }),
          el('span', { text: `${st.brush} × ${st.brush}` }),
          el('button', { type: 'button', text: '+', title: 'Bigger (])', on: { click: () => size(1) } }));
      } else if (opt === 'terrain-brush') {
        const t = st.terrain;
        const size = (d) => { t.size = terrainSize(t.size, d); board.invalidate(); renderBar(); };
        items.push(el('span.muted', { text: 'Size' }),
          el('button', { type: 'button', text: '−', title: 'Smaller ([)', on: { click: () => size(-1) } }),
          el('span', { text: `${t.size}` }),
          el('button', { type: 'button', text: '+', title: 'Bigger (])', on: { click: () => size(1) } }),
          slider('Soft', 'How soft the brush\'s edge is', t.soft, (v) => { t.soft = v; board.invalidate(); }),
          slider('Strength', 'How much one pass of the brush lays down (low: build it up by going over it, or holding the button)', t.strength, (v) => { t.strength = Math.max(0.05, v); }));
      } else if (opt === 'terrain-look') {
        // The texture's own look, for all of it on the map (or for the first stroke of it).
        const [id, slot] = slotOf(st.terrain.material);
        const set = (key, v) => {
          st.terrain[key] = v;
          if (id) commit({ terrain: { slots: { [id]: { [key]: v } } } });
        };
        items.push(slider('Ragged', 'Its edges: 0 blends softly, more makes them rough and sharp', slot?.edge ?? st.terrain.edge, (v) => set('edge', v), true),
          el('select', { title: 'How big its tile is drawn', on: { change: (e) => set('scale', Number(e.target.value)) } },
            ...[0.5, 1, 1.5, 2, 3, 4].map((x) => el('option', { value: x, text: `Tile ${x}×`, selected: (slot?.scale ?? st.terrain.scale) === x }))));
      } else if (opt === 'water-body') {
        const bodies = bodiesNow();
        const id = st.water.body && bodies[st.water.body] ? st.water.body : '';
        items.push(el('select', { title: 'Which body of water you paint: one on the map (its look changes all of it), or a new one', on: { change: (e) => { st.water.body = e.target.value || null; renderBar(); } } },
          el('option', { value: '', text: 'New water', selected: !id }),
          ...Object.entries(bodies).map(([b, x]) => el('option', { value: b, text: `${KIND_NAMES[x.kind] ?? 'Water'} ${b}`, selected: b === id }))));
        const look = waterLook();
        items.push(el('select', { title: 'Ocean: waves and foam roll in along the shore · Lake: still · River: runs the way you paint it', on: { change: (e) => {
          const kind = e.target.value;
          // A new body takes the kind's usual look; one on the map keeps its own.
          if (!id) Object.assign(st.water, PRESETS[kind]);
          setWater('kind', kind);
        } } }, ...KINDS.map((k) => el('option', { value: k, text: KIND_NAMES[k], selected: (look.kind ?? 'lake') === k }))));
        const t = st.water;
        const size = (d) => { t.size = terrainSize(t.size, d); board.invalidate(); renderBar(); };
        items.push(el('span.muted', { text: 'Size' }),
          el('button', { type: 'button', text: '−', title: 'Smaller ([)', on: { click: () => size(-1) } }),
          el('span', { text: `${t.size}` }),
          el('button', { type: 'button', text: '+', title: 'Bigger (])', on: { click: () => size(1) } }));
      } else if (opt === 'water-look') {
        const look = waterLook();
        items.push(slider('Shore', 'How far the shore reaches out from the water (up to 3 squares)', (look.shore_width ?? 0.5) / 3, (v) => setWater('shore_width', Math.round(v * 30) / 10), true),
          slider('Depth', 'How far out it gets deep and dark: low, it drops off at once; high, the shallows go a long way out', ((look.depth ?? 3) - 1) / 5, (v) => setWater('depth', Math.round((1 + v * 5) * 10) / 10), true),
          slider('Clarity', 'How much of the underlay shows through: low is murky, high is clear', look.clarity ?? 0.5, (v) => setWater('clarity', v), true),
          el('label.check', { title: 'Waves roll in and rivers run, for players who have animated maps on (a still picture otherwise)' },
            el('input', { type: 'checkbox', checked: current().water?.animate !== false, on: { change: (e) => { commit({ water: { animate: e.target.checked } }); board.invalidate(); } } }), ' Moving'));
      } else if (opt === 'trace-mode') {
        items.push(el('select', { title: 'Buildings: each outlined shape is one building · Blocks: what\'s between the streets, the buildings in it as one (far fewer walls, for a big city)', on: { change: (e) => { st.trace.mode = e.target.value; renderBar(); } } },
          el('option', { value: 'buildings', text: 'Trace: buildings', selected: st.trace.mode === 'buildings' }),
          el('option', { value: 'blocks', text: 'Trace: city blocks', selected: st.trace.mode === 'blocks' })));
      } else if (opt === 'trace-look') {
        const t = st.trace, px = t.px?.url === scene()?.background ? t.px.px : null;
        items.push(el('label.check', { title: 'Walls round what\'s traced (they block sight and movement)' },
          el('input', { type: 'checkbox', checked: t.walls, on: { change: (e) => { t.walls = e.target.checked; } } }), ' Walls'));
        items.push(el('label.check', { title: 'Square the sides up to the building\'s own angle (off: follow the outline as drawn)' },
          el('input', { type: 'checkbox', checked: t.straighten, on: { change: (e) => { t.straighten = e.target.checked; } } }), ' Straighten'));
        items.push(el('label.check', { title: 'A dragged box leaves out grey shapes (water, roads, yards, a graveyard), for a map whose buildings are coloured. Untick it if the roofs are grey' },
          el('input', { type: 'checkbox', checked: t.skipGrey, on: { change: (e) => { t.skipGrey = e.target.checked; } } }), ' Skip grey'));
        if (px) {
          items.push(slider('Lines', `How dark the map's outlines are: raise it if outlines leak (gaps in them), lower it if dark roofs count as outline (worked out: ${px.t1})`, (t.t1 ?? px.t1) / 255, (v) => { t.t1 = Math.round(v * 255); }, true, 1 / 255));
          if (t.mode === 'blocks') items.push(slider('Streets', `How light the streets are: lower it if pale roofs count as street (worked out: ${px.t2})`, (t.t2 ?? px.t2) / 255, (v) => { t.t2 = Math.round(v * 255); }, true, 1 / 255));
          if (t.t1 != null || t.t2 != null) items.push(el('button', { type: 'button', text: '↺', title: 'Back to what was worked out from the map', on: { click: () => { t.t1 = t.t2 = null; renderBar(); } } }));
        }
        items.push(el('select', { title: 'The biggest shape traced (squares): bigger ones are taken as streets, squares and parks', on: { change: (e) => { t.max = Number(e.target.value); } } },
          ...[25, 50, 100, 200, 400, 1000, 4000, 20000].map((x) => el('option', { value: x, text: `Up to ${x} sq`, selected: t.max === x }))));
      } else if (opt === 'roof-shape') {
        items.push(roofShapeSelect(st.roofShape ?? null, (v) => { st.roofShape = v; renderBar(); board.invalidate(); }));
      } else if (opt === 'roofs-shown') {
        items.push(el('label.check', { title: 'Roofs show faintly for you; untick to hide them while you work' },
          el('input', { type: 'checkbox', checked: board.showRoofs, on: { change: (e) => { board.showRoofs = e.target.checked; board.invalidate(); } } }), ' Show roofs'));
      } else if (opt === 'prop') {
        const def = propDef(st.prop);
        items.push(el('button.opt-pick', { type: 'button', title: 'Choose another prop in the Map props tab', on: { click: () => openPropPalette() } },
          el('span.opt-swatch', { style: `background-image: url("${propThumb(def.id)}"); background-size: contain; background-repeat: no-repeat` }),
          el('span', { text: `Prop: ${def.label}` }), el('span.muted', { text: '▸' })));
        if ((st.placeScale ?? 1) !== 1 || (st.placeRot ?? 0) !== 0) {
          items.push(el('span.muted', { text: `${Math.round((st.placeScale ?? 1) * 100)}% · ${st.placeRot ?? 0}°` }),
            el('button', { type: 'button', text: '↺', title: 'Back to its usual size, unturned', on: { click: () => { st.placeScale = 1; st.placeRot = 0; renderBar(); board.invalidate(); } } }));
        }
      }
    }
    if (HINTS[tool]) items.push(el('span.muted.small', { text: HINTS[tool] }));
    if (st.pick && (OPTIONS[tool] ?? []).includes(st.pick)) items.push(pickerPop(st.pick));
    else st.pick = null;
    return items;
  }

  /** A brush size, one step bigger or smaller. */
  function terrainSize(v, d) {
    const steps = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20];
    const i = steps.findIndex((x) => x >= v);
    return steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? steps.length - 1 : i) + d))];
  }
  /** A labelled 0–1 slider; `commitOnly`: tell only when let go. */
  function slider(label, title, value, set, commitOnly = false, step = 0.05) {
    return el('label.opt-slider', { title }, el('span.muted', { text: label }),
      el('input', { type: 'range', min: 0, max: 1, step, value, on: commitOnly ? { change: (e) => set(Number(e.target.value)) } : { input: (e) => set(Number(e.target.value)) } }));
  }

  /** The open picker: a grid of textures under the bar. */
  function pickerPop(opt) {
    const pk = PICKERS[opt];
    const choose = (id) => { pk.set(id); st.pick = null; renderBar(); board.invalidate(); };
    const tiles = pk.list().map((m) => {
      const url = swatchUrl(m.swatch ?? m.id);
      const on = m.id === pk.get();
      return el('button.opt-tile', { type: 'button', title: m.made ? `${m.label} (made in the texture creator)` : m.pack ? `${m.label} (from ${m.pack})` : m.label, class: on ? 'opt-tile active' : 'opt-tile', on: { click: () => choose(m.id) } },
        el('span.opt-swatch', { class: url ? 'opt-swatch' : 'opt-swatch ink', style: url ? `background-image: url("${url}")` : '' }),
        el('span', { text: m.label }),
        m.made ? el('span.opt-edit', {
          role: 'button', tabindex: '0', title: `Change ${m.label} in the texture creator`, text: '✎',
          on: { click: (e) => { e.stopPropagation(); st.pick = null; renderBar(); openTextureCreator(api, { id: m.made }); } },
        }) : null);
    });
    tiles.push(el('button.opt-tile', { type: 'button', title: 'Make a texture of your own: mix textures and pictures, change their colours, hide the repeat', on: { click: () => { st.pick = null; renderBar(); openTextureCreator(api, { onSaved: (id) => choose(`tex:${id}`) }); } } },
      el('span.opt-swatch.upload', { text: '✦' }), el('span', { text: 'New texture…' })));
    if (opt === 'floor' || opt === 'terrain' || opt === 'ground' || opt === 'trace-floor' || opt.startsWith('water-')) {
      tiles.push(el('button.opt-tile', { type: 'button', title: 'Add your own texture: an image that repeats', on: { click: () => { st.pick = null; st.uploadTexture(); } } },
        el('span.opt-swatch.upload', { text: '+' }), el('span', { text: 'Upload a picture…' })));
      tiles.push(el('button.opt-tile', { type: 'button', title: 'Import ground, floor and pattern textures from a Dungeondraft asset pack (.dungeondraft_pack)', on: { click: () => { st.pick = null; renderBar(); importPack(api, () => { st.pick = opt; renderBar(); }); } } },
        el('span.opt-swatch.upload', { text: '⇪' }), el('span', { text: 'Dungeondraft pack…' })));
    }
    return el('div.opt-pop', { role: 'listbox', 'aria-label': pk.title }, ...tiles);
  }
  // A texture made in the creator changed, or a picture arrived: new swatches, redraw.
  hooks.on('textures:changed', () => { swatches.clear(); renderBar(); board.invalidate(); });
  // A click elsewhere closes the picker.
  addEventListener('pointerdown', (e) => { if (st.pick && !bar.contains(e.target)) { st.pick = null; renderBar(); } }, true);

  // ---------------------------------------------------------------- keys, refit

  function keys(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { undo(); return true; }
    if ((e.key === '[' || e.key === ']') && board.tool === 'sketch-water') {
      st.water.size = terrainSize(st.water.size, e.key === ']' ? 1 : -1);
      toast(`Brush: ${st.water.size} squares across`);
      board.invalidate();
      renderBar();
      return true;
    }
    if ((e.key === '[' || e.key === ']') && board.tool === 'sketch-terrain') {
      st.terrain.size = terrainSize(st.terrain.size, e.key === ']' ? 1 : -1);
      toast(`Brush: ${st.terrain.size} squares across`);
      board.invalidate();
      renderBar();
      return true;
    }
    if (e.key === '[' || e.key === ']') {
      st.brush = Math.max(1, Math.min(9, st.brush + (e.key === ']' ? 1 : -1)));
      toast(`Brush: ${st.brush} × ${st.brush} squares`);
      board.invalidate();
      renderBar();
      return true;
    }
    if (e.key === 'Escape') { board.setTool('select'); return true; }
    return false;
  }

  // When the grid's size changed since the walls were worked out, work them out again.
  api.sketchRefit = () => {
    const s = scene();
    const sk = sketchOf(s, board.level);
    if (!sk || !isGM() || sk.size === g()) return;
    send(s, { size: g() });
  };
  for (const id of ['sketch-room', 'sketch-round', 'sketch-floor', 'sketch-brush', 'sketch-erase', 'sketch-terrain', 'sketch-water', 'sketch-wall', 'sketch-railing', 'sketch-door', 'sketch-window']) {
    const t = board.toolHandlers[id];
    t.enter = () => api.sketchRefit();
  }

  // ---------------------------------------------------------------- palette and settings

  /** Materials for the palette: the built-ins, then uploaded textures used on any scene. */
  st.materials = floorChoices;
  /** The texture creator, on the world's first texture (or a new one if there are none). */
  st.openTextures = () => openTextureCreator(api, { id: recipes()[0]?.id ?? null });
  st.props = () => [...LIGHTS, ...FURNITURE];

  st.roof = 'shingles';
  st.choose = (id) => {
    if (board.tool === 'sketch-roof') { st.roof = id; return; }
    st.material = id;
    if (!PAINT_TOOLS.includes(board.tool)) board.setTool('sketch-room');
  };
  /** Which swatch is chosen: the roof's while roofing, else the floor's. */
  st.chosen = () => (board.tool === 'sketch-roof' ? st.roof : st.material);
  st.chooseProp = (id) => {
    st.prop = id;
    if (board.tool !== 'sketch-place') board.setTool('sketch-place');
    api.sidebar?.refresh('props');
    renderBar();
  };

  st.uploadTexture = () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      try {
        const url = await api.upload(f);
        st.extra = [...(st.extra ?? []), { id: url, label: f.name }];
        st.material = url;
        renderBar();
        toast(`${f.name} is ready: paint with it (it repeats every four squares).`);
      } catch (err) { toast(`Upload failed: ${err.message ?? err}`, 'error'); }
    };
    input.click();
  };

  st.settings = async () => {
    const s = scene();
    if (!s) return;
    const sk = sketchOf(s, board.level) ?? { outside: board.level || s.background ? null : 'rock', walls: true };
    const out = await formDialog({
      title: 'Sketch settings',
      fields: [
        { name: 'outside', label: 'Around the floor', type: 'select', value: sk.outside ?? '', options: [['', 'Nothing: show the map underneath'], ...st.materials().map((m) => [m.id, m.label])] },
        { name: 'wall_style', label: 'Walls look like', type: 'select', value: sk.wall_style ?? 'ink', options: WALL_STYLES.map((x) => [x.id, x.label]) },
        { name: 'walls', label: 'Walls round the rooms (they block sight and movement)', type: 'checkbox', value: sk.walls ?? true },
      ],
    });
    if (out) commit({ outside: out.outside || null, walls: !!out.walls, wall_style: out.wall_style === 'ink' ? null : out.wall_style });
  };

  /**
   * Copy the level below's walls up to this level (a hall two storeys tall, a tower): its rooms'
   * walls, doors and windows become plain walls here, and its diagonals come too. Round rooms'
   * walls aren't copied.
   */
  st.copyWallsBelow = () => {
    const s = scene();
    const below = s && levelsOf(s).filter((l) => l.elevation < (levelsOf(s).find((x) => x.id === board.level)?.elevation ?? 0)).at(-1);
    if (!below) { toast('There is no level below this one.'); return; }
    const sk = current();
    const edges = {}, lines = {};
    let round = 0;
    for (const w of Object.values(sketchWalls(sketchOf(s, below.id), g(), below.id))) {
      if (w.src?.edges && w.kind === 'wall') for (const e of w.src.edges) { if (!(e in sk.edges)) edges[e] = 'wall'; }
      else if (w.src?.opening && !(w.src.opening in sk.edges)) edges[w.src.opening] = 'wall';
      else if (w.src?.line) { const l = sketchOf(s, below.id).lines[w.src.line]; lines[newId()] = { a: l.a, b: l.b, kind: 'wall', ...(l.style ? { style: l.style } : {}) }; }
      else if (w.src?.shape) round++;
    }
    const n = Object.keys(edges).length + Object.keys(lines).length;
    if (!n) { toast(`${below.name} has no walls to copy.`); return; }
    commit({ edges, lines });
    toast(`Copied ${below.name}'s walls up${round ? ' (round rooms\' walls aren\'t copied)' : ''}.`);
  };

  st.clear = () => {
    const s = scene();
    const sk = sketchOf(s, board.level);
    if (!sk || (!MAPS.some((k) => Object.keys(sk[k] ?? {}).length) && !sk.terrain && !sk.water)) { toast('There is no sketch here.'); return; }
    if (!confirm(`Erase the sketched map on ${levelsOf(s).length > 1 ? levelName(s, board.level) : 'this scene'}, with its walls, doors, windows, props and roofs?`)) return;
    st.undo = st.undo.filter((u) => u.sceneId !== s.id || (u.level ?? '') !== board.level);
    api.op({ op: 'sketch_update', scene_id: s.id, ...(board.level ? { level: board.level } : {}), patch: { ...Object.fromEntries(MAPS.map((k) => [k, null])), ...(board.level ? {} : { terrain: null, water: null }) }, walls: {}, lights: {}, links: {} });
    if (!board.level) { forgetTerrain(s.id); forgetTerrain(s.id, 'water'); forgetWater(s.id); st.water.body = null; }
  };
}
