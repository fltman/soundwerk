// Computes every module's panel from its definition: where each knob, switch, jack and screen
// goes, and how wide the panel must be. Pure, so the tests can check that everything fits.
import { inputPorts, outputPorts } from '../modules/index.js';

export const HP = 15;
export const PANEL_H = 380;
const HEAD = 30, FOOT = 14, MARGIN = 6;
const JACK = { w: 30, h: 42 }, CV_JACK = { w: 30, h: 60 };

const CELL = {
  L: { w: 62, h: 78 },
  M: { w: 46, h: 60 },
  S: { w: 36, h: 46 },
  T: { w: 36, h: 38 },
  F: { w: 38, h: 136 },
  f: { w: 36, h: 96 },
};

function paramCell(p) {
  if (p.type === 'select') {
    if (p.options.length <= 5) {
      const chars = Math.max((p.label ?? '').length, ...p.options.map((o) => o.length));
      return { kind: 'switch', w: Math.max(36, 18 + chars * 5.6), h: 14 + p.options.length * 12 };
    }
    return { kind: 'stepper', w: 66, h: 40 };
  }
  if (p.type === 'toggle') return { kind: 'toggle', w: 36, h: 36 };
  if (p.type === 'button') return { kind: 'button', w: 36, h: 40 };
  const c = CELL[p.size ?? 'M'];
  return { kind: p.size === 'F' || p.size === 'f' ? 'fader' : 'knob', size: p.size ?? 'M', w: c.w, h: c.h };
}

function tryLayout(def, hp) {
  const W = hp * HP, inner = W - MARGIN * 2;
  const items = [];
  let y = HEAD;

  for (const w of def.widgets ?? []) {
    if (w.w > inner) return null;
    items.push({ kind: 'widget', ui: w.ui, spec: w, x: (W - w.w) / 2, y, w: w.w, h: w.h });
    y += w.h + 6;
  }

  // knobs and switches flow into rows
  const rows = [];
  let row = null;
  const place = (cell) => {
    if (cell.w > inner) return false;
    if (!row || cell.br || row.w + cell.w > inner || (def.cols && row.cells.length >= def.cols)) {
      row = { cells: [], w: 0, h: 0 };
      rows.push(row);
    }
    row.cells.push(cell);
    row.w += cell.w;
    row.h = Math.max(row.h, cell.h);
    return true;
  };
  for (const p of def.params ?? []) if (!place({ ...paramCell(p), name: p.name, param: p, br: p.br })) return null;
  for (const l of def.lights ?? []) if (!place({ kind: 'light', name: l.name, light: l, w: 30, h: 24 })) return null;

  // jacks fill from the bottom: inputs, then outputs on their own contrasting plate
  const cols = Math.floor(inner / JACK.w);
  if (cols < 1) return null;
  const ins = inputPorts(def), outs = outputPorts(def);
  const jackRows = [];
  const chunk = (list, dir) => {
    for (let k = 0; k < list.length; k += cols) jackRows.push({ dir, ports: list.slice(k, k + cols) });
  };
  const oneRow = ins.length + outs.length <= cols;
  if (oneRow) jackRows.push({ dir: 'both', ports: ins, outs });
  else { chunk(ins, 'in'); chunk(outs, 'out'); }
  const rowH = (r) => (r.ports.some((p) => p.param) ? CV_JACK.h : JACK.h);
  const jackH = jackRows.reduce((sum, r) => sum + rowH(r), 0);

  const knobH = rows.reduce((sum, r) => sum + r.h, 0);
  const bottom = PANEL_H - FOOT - jackH;
  const spare = bottom - y - knobH;
  if (spare < 0) return null;

  const gap = Math.min(16, spare / (rows.length + 1));
  y += gap;
  for (const r of rows) {
    const free = (inner - r.w) / (r.cells.length + 1);
    const step = Math.min(free, 20);
    let x = MARGIN + (inner - r.w - step * (r.cells.length - 1)) / 2;
    for (const c of r.cells) {
      items.push({ ...c, x, y: y + (r.h - c.h) / 2 });
      x += c.w + step;
    }
    y += r.h + gap;
  }

  let jy = bottom, plate = null;
  const addJack = (port, dir, x, h) => {
    items.push({ kind: 'jack', name: port.name, port, dir, x, y: jy + (h - (port.param ? CV_JACK.h : JACK.h)), w: JACK.w, h: port.param ? CV_JACK.h : JACK.h });
  };
  const growPlate = (x0, x1, y0, y1) => {
    plate = plate
      ? { x0: Math.min(plate.x0, x0), x1: Math.max(plate.x1, x1), y0: Math.min(plate.y0, y0), y1: Math.max(plate.y1, y1) }
      : { x0, x1, y0, y1 };
  };
  for (const r of jackRows) {
    const h = rowH(r);
    if (r.dir === 'both') {
      r.ports.forEach((p, k) => addJack(p, 'in', MARGIN + k * JACK.w, h));
      r.outs.forEach((p, k) => addJack(p, 'out', W - MARGIN - (r.outs.length - k) * JACK.w, h));
      if (r.outs.length) growPlate(W - MARGIN - r.outs.length * JACK.w - 2, W - MARGIN + 2, jy + h - JACK.h - 2, jy + h + 1);
    } else {
      const left = MARGIN + (inner - r.ports.length * JACK.w) / 2;
      r.ports.forEach((p, k) => addJack(p, r.dir, left + k * JACK.w, h));
      if (r.dir === 'out') growPlate(left - 2, left + r.ports.length * JACK.w + 2, jy - 1, jy + h + 1);
    }
    jy += h;
  }
  return {
    hp, w: W, items,
    plate: plate && { x: plate.x0, y: plate.y0, w: plate.x1 - plate.x0, h: plate.y1 - plate.y0 },
  };
}

export function layoutPanel(def) {
  const title = Math.ceil(((def.title ?? '').length * 8.4 + 24) / HP);
  const start = Math.max(4, def.hp ?? 0, title);
  for (let hp = start + (start % 2); hp <= 160; hp += 2) {
    const r = tryLayout(def, hp);
    if (r) return r;
  }
  throw new Error(`${def.type}: the panel doesn't fit in 160 HP`);
}
