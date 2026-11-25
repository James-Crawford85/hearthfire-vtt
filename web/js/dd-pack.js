// Dungeondraft asset packs (.dungeondraft_pack): read in the browser, their textures imported
// for sketched maps (ground, floors, walls' bands, anything a material goes).
//
// A pack is a Godot 3 resource pack: "GDPC", the format version (1), Godot's version (3, x, y),
// 16 reserved words, the file count, then for each file: its path's length, the path
// (res://packs/<pack id>/…, padded with zeros), its offset and size (64-bit) and an MD5; then
// the files themselves. Pictures are stored as they are (PNG, WebP, JPEG), drawn at 256 pixels
// a grid square. Only the table is read up front (File.slice), so a 2 GB pack costs nothing
// until a picture in it is wanted.
//
// What's imported, as plain uploads at 128 pixels a square (like the built-in textures):
//   textures/terrain/…           ground textures
//   textures/tilesets/simple/…   floor tiles (one repeating picture each)
//   textures/patterns/normal/…   floors and paving
// Smart tilesets, walls, paths and objects aren't imported (yet).
//
// The world keeps a list of what it imported, world.settings.sketch.library:
//   { key: { id, label, pack, kind } }   id: the material (upload URL + "#px=128")
// Packs are often licensed for personal use: what's imported stays in this world's own files.

import { el, toast, openWindow } from './ui.js';
import { store } from './store.js';

const DD_PX = 256;   // Dungeondraft's pixels a square
const OUR_PX = 128;  // ours (sketch-textures.js)
const KINDS = [
  { kind: 'ground', label: 'Ground', re: /\/textures\/terrain\/[^]*\.(png|webp|jpe?g)$/i },
  { kind: 'tiles', label: 'Floor tiles', re: /\/textures\/tilesets\/simple\/[^]*\.(png|webp|jpe?g)$/i },
  { kind: 'pattern', label: 'Patterns', re: /\/textures\/patterns\/normal\/[^]*\.(png|webp|jpe?g)$/i },
];
const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** A pack's table: { name, author, id, files: [{ path, offset, size }] }. Throws if it isn't one. */
export async function readPack(file) {
  const view = async (at, n) => new DataView(await file.slice(at, at + n).arrayBuffer());
  const head = await view(0, 88);
  const magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== 'GDPC') throw new Error('This isn\'t a Dungeondraft pack (no Godot pack header).');
  const version = head.getUint32(4, true);
  if (version !== 1) throw new Error(`This pack's format (${version}) isn't one this can read yet.`);
  const count = head.getUint32(84, true);
  // The table is small next to the files: read a generous piece at once, more if needed.
  let buf = new Uint8Array(await file.slice(88, 88 + Math.min(file.size - 88, 64 + count * 400)).arrayBuffer());
  const files = [];
  const dec = new TextDecoder();
  let p = 0;
  for (let i = 0; i < count; i++) {
    const need = async (n) => {
      if (p + n <= buf.length) return;
      buf = new Uint8Array(await file.slice(88, 88 + Math.min(file.size - 88, (p + n) * 2)).arrayBuffer());
      if (p + n > buf.length) throw new Error('The pack is cut short.');
    };
    await need(4);
    const dv = () => new DataView(buf.buffer, buf.byteOffset);
    const len = dv().getUint32(p, true);
    await need(4 + len + 32);
    const path = dec.decode(buf.subarray(p + 4, p + 4 + len)).replace(/\0+$/, '');
    const d = dv();
    const offset = Number(d.getBigUint64(p + 4 + len, true));
    const size = Number(d.getBigUint64(p + 4 + len + 8, true));
    files.push({ path, offset, size });
    p += 4 + len + 32;
  }
  // pack.json: its name and author.
  let meta = {};
  const pj = files.find((f) => /\/pack\.json$/.test(f.path)) ?? files.find((f) => /^res:\/\/packs\/[^/]+\.json$/.test(f.path));
  if (pj) { try { meta = JSON.parse(await blobOf(file, pj).text()); } catch { /* no name: the file's */ } }
  return { name: meta.name || file.name.replace(/\.dungeondraft_pack$/i, ''), author: meta.author ?? '', id: meta.id ?? '', files };
}

/** One file of a pack, as a Blob. */
export function blobOf(file, f) {
  const ext = f.path.split('.').pop().toLowerCase();
  return file.slice(f.offset, f.offset + f.size, MIME[ext] ?? 'application/octet-stream');
}

/** The textures in a pack that can be imported: [{ kind, label, file }]. */
export function texturesIn(pack) {
  const out = [];
  for (const f of pack.files) {
    const k = KINDS.find((x) => x.re.test(f.path));
    if (!k) continue;
    const name = f.path.split('/').pop().replace(/\.[^.]+$/, '');
    out.push({ kind: k.kind, label: tidy(name), file: f });
  }
  return out.sort((a, b) => KINDS.findIndex((k) => k.kind === a.kind) - KINDS.findIndex((k) => k.kind === b.kind) || a.label.localeCompare(b.label));
}
/** "tilinggrass_tiling grass texture green, dense" → "Tiling grass texture green, dense". */
function tidy(name) {
  let s = name.replace(/^[a-z0-9]+_(?=[a-z])/i, (m) => (/[A-Z]/.test(name[0]) ? m : '')).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A picture from a pack, made ready to upload: scaled to our pixels a square, as WebP. */
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const w = Math.max(1, Math.round((bmp.width * OUR_PX) / DD_PX));
  const h = Math.max(1, Math.round((bmp.height * OUR_PX) / DD_PX));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('Could not convert the picture.'))), 'image/webp', 0.9));
}

/** The world's imported textures, as material choices: [{ id, label, pack, kind }]. */
export function libraryTextures() {
  return Object.values(store.world?.settings?.sketch?.library ?? {}).filter((x) => x?.id);
}

/** A material's pixels a grid square, when its id says (`…#px=128`). */
export function pxOfMaterial(id) {
  const m = /#px=(\d+(?:\.\d+)?)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
}

/** Choose a pack, pick its textures, import them. `done()` runs after an import. */
export function importPack(api, done = () => {}) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.dungeondraft_pack' });
  input.onchange = () => { if (input.files[0]) importPackFile(api, input.files[0], done); };
  input.click();
}

/** Import from a pack file already in hand (chosen, or dropped on the page). */
export async function importPackFile(api, file, done = () => {}) {
  {
    let pack;
    try { pack = await readPack(file); } catch (err) { toast(err.message ?? String(err), 'error'); return; }
    const list = texturesIn(pack);
    if (!list.length) { toast(`${pack.name} has no ground, floor or pattern textures to import (its props, walls and paths can't be imported yet).`); return; }
    showPicker(api, file, pack, list, done);
  }
}

function showPicker(api, file, pack, list, done) {
  const win = openWindow({ id: 'dd-import', title: `Import from ${pack.name}`, width: 640, height: 560 });
  win.body.replaceChildren();
  const have = new Set(libraryTextures().map((x) => `${x.pack}|${x.label}`));
  const chosen = new Set(list.filter((t) => !have.has(`${pack.name}|${t.label}`)));
  const urls = [];
  win.onClose(() => urls.forEach((u) => URL.revokeObjectURL(u)));
  const count = el('span.muted');
  const go = el('button.primary', { type: 'button' });
  const refresh = () => {
    count.textContent = `${chosen.size} of ${list.length} chosen`;
    go.textContent = chosen.size ? `Import ${chosen.size}` : 'Import';
    go.disabled = !chosen.size;
  };
  // Thumbnails, small, a few at a time (some pictures are huge).
  const queue = [];
  let busy = 0;
  const pump = () => {
    while (busy < 3 && queue.length) {
      const [t, img] = queue.shift();
      busy++;
      createImageBitmap(blobOf(file, t.file), { resizeWidth: 112, resizeQuality: 'medium' })
        .then((bmp) => {
          const c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          bmp.close?.();
          return new Promise((ok) => c.toBlob(ok, 'image/webp', 0.8));
        })
        .then((b) => { if (b) { const u = URL.createObjectURL(b); urls.push(u); img.style.backgroundImage = `url("${u}")`; } })
        .catch(() => img.classList.add('broken'))
        .finally(() => { busy--; pump(); });
    }
  };
  const groups = [];
  for (const k of KINDS) {
    const items = list.filter((t) => t.kind === k.kind);
    if (!items.length) continue;
    const tiles = items.map((t) => {
      const img = el('span.dd-thumb');
      queue.push([t, img]);
      const box = el('input', { type: 'checkbox', checked: chosen.has(t), on: { change: (e) => { if (e.target.checked) chosen.add(t); else chosen.delete(t); refresh(); } } });
      const already = have.has(`${pack.name}|${t.label}`);
      return el('label.dd-tile', { title: `${t.label}${already ? ' (already imported)' : ''}` }, img, el('span.dd-name', {}, box, ` ${t.label}`), already ? el('span.muted.small', { text: 'imported' }) : null);
    });
    const all = el('button', { type: 'button', text: 'All', on: { click: () => { items.forEach((t) => chosen.add(t)); tiles.forEach((x) => { x.querySelector('input').checked = true; }); refresh(); } } });
    const none = el('button', { type: 'button', text: 'None', on: { click: () => { items.forEach((t) => chosen.delete(t)); tiles.forEach((x) => { x.querySelector('input').checked = false; }); refresh(); } } });
    groups.push(el('div.dd-group', {}, el('div.dd-head', {}, el('strong', { text: `${k.label} (${items.length})` }), all, none), el('div.dd-grid', {}, ...tiles)));
  }
  const note = el('p.muted.small', { text: `${pack.author ? `By ${pack.author}. ` : ''}Imported textures are copied into this world only, at half Dungeondraft's resolution (128 pixels a square, like the built-in ones). Check the pack's licence before sharing maps made with it.` });
  const status = el('span.muted.small');
  go.addEventListener('click', async () => {
    go.disabled = true;
    const todo = [...chosen];
    const library = {};
    let n = 0, failed = 0;
    for (const t of todo) {
      status.textContent = `Importing ${++n} of ${todo.length}: ${t.label}…`;
      try {
        const blob = await prepare(blobOf(file, t.file));
        const url = await api.upload(new File([blob], `${t.file.path.split('/').pop().replace(/\.[^.]+$/, '')}.webp`, { type: 'image/webp' }));
        const key = `${pack.id || pack.name}-${t.file.path.split('/').slice(3).join('/')}`.replace(/[^\w.-]+/g, '_').slice(0, 120);
        library[key] = { id: `${url}#px=${OUR_PX}`, label: t.label, pack: pack.name, kind: t.kind };
      } catch (err) { failed++; console.warn('import', t.file.path, err); }
      // Send as we go, a few at a time, so a long import isn't lost half way.
      if (Object.keys(library).length >= 8) { api.settings.set('sketch', 'library', { ...library }); for (const k of Object.keys(library)) delete library[k]; }
    }
    if (Object.keys(library).length) api.settings.set('sketch', 'library', library);
    const ok = todo.length - failed;
    toast(`Imported ${ok} texture${ok === 1 ? '' : 's'} from ${pack.name}${failed ? ` (${failed} failed)` : ''}. They're in the texture pickers.`, failed ? 'error' : 'info');
    win.close();
    done();
  });
  win.body.append(el('div.dd-import', {}, note, ...groups, el('div.dd-foot', {}, count, status, go)));
  refresh();
  pump();
}
