// The wall: rails, modules as DOM, cables as SVG, pan/zoom, drag-to-patch.
import { CATEGORIES, inputPorts, outputPorts, cvParams, paramRange, getDef } from '../modules/index.js';
import { layoutPanel, HP, PANEL_H } from './layout.js';
import { WALL_HP, dropAt, findGap, rowsUsed, widthOf } from '../rack/place.js';
import { buildWidget } from './widgets.js';

export const ROW_H = PANEL_H + 34;
const CHEEK = 34;      // the wooden sides of the rack
const SVGNS = 'http://www.w3.org/2000/svg';
const DEFAULT_DEPTH = 0.5;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svg = (tag, cls) => {
  const e = document.createElementNS(SVGNS, tag);
  if (cls) e.setAttribute('class', cls);
  return e;
};

export function fmtValue(p, v) {
  if (p.type === 'select') return p.options[Math.round(v)] ?? '';
  if (p.type === 'toggle') return v > 0.5 ? 'ON' : 'OFF';
  if (p.format) return p.format(v);
  if (p.step >= 1) return String(Math.round(v));
  const a = Math.abs(v);
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

// Real patch leads: bright, a few colours per kind of signal, each one a little different.
const CABLES = {
  audio: ['#f2c230', '#f0a12b', '#e9d24a'],
  pitch: ['#3f9bf0', '#2fc4e8', '#5b7bf5'],
  gate: ['#ef4b52', '#f0577f', '#e8703a'],
  cv: ['#4fd18b', '#a874ef', '#35c9a8'],
};
const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

export function cablePath(a, b, slack = 1, sway = 0) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const sag = Math.min(170, 26 + len * 0.17) * slack;
  const c1x = a.x + dx * 0.25 + sway, c2x = a.x + dx * 0.75 + sway * 0.8;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} C${c1x.toFixed(1)},${(a.y + sag + dy * 0.12).toFixed(1)} ${c2x.toFixed(1)},${(b.y + sag - dy * 0.12).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

export class Wall extends EventTarget {
  constructor(root, graph, host, menu) {
    super();
    Object.assign(this, { root, graph, host, menu });
    this.view = { x: 20, y: 20, zoom: 0.8 };
    this.views = new Map();      // module id → view refs
    this.cables = new Map();     // link id → view refs
    this.selected = new Set();
    this.pointer = { x: 200, y: 200 };
    this.cableMode = 0;
    this.frame = 0;

    root.classList.add('wall');
    this.world = el('div', 'world');
    this.rails = el('div', 'rails');
    this.mods = el('div', 'mods');
    this.svg = svg('svg', 'cable-layer');
    this.linkLayer = svg('g');
    this.dragPath = svg('path', 'drag-cable');
    this.svg.append(this.linkLayer, this.dragPath);
    this.world.append(this.rails, this.mods, this.svg);
    this.tip = el('div', 'tip hidden');
    this.hint = el('div', 'wall-hint', 'Double-click a module to zoom in on it · + and − zoom · drag a module by its name to move it · Tab adds a module');
    root.append(this.world, this.hint);
    document.body.append(this.tip);

    graph.addEventListener('change', (e) => {
      const { kind, id } = e.detail;
      if (kind === 'load') this.rebuild();
      else if (kind === 'structure') this.sync();
      else if (kind === 'move') this.position(id);
      else if (kind === 'param' || kind === 'depth') this.refreshParam(e.detail);
      else if (kind === 'data') this.views.get(id)?.widgets.forEach((w) => w.refresh?.());
    });
    this.bindEvents();
    this.rebuild();
  }

  // ── view ──────────────────────────────────────────────
  applyView() {
    const { x, y, zoom } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.root.classList.toggle('zoomed-out', zoom < 0.5);
    this.dispatchEvent(new CustomEvent('view', { detail: { zoom } }));
  }

  // buttons and keys glide, so you keep your bearings; a pinch follows the fingers
  glide() {
    this.world.classList.add('gliding');
    clearTimeout(this.glideTimer);
    this.glideTimer = setTimeout(() => this.world.classList.remove('gliding'), 240);
  }

  zoomStep(factor) {
    const r = this.root.getBoundingClientRect();
    this.focused = null;
    this.glide();
    this.zoomAt(r.left + (r.width - (this.insetRight ?? 0)) / 2, r.top + r.height / 2, factor);
  }

  zoomReset() {
    this.focused = null;
    this.glide();
    const r = this.root.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / this.view.zoom);
  }

  panBy(dx, dy) {
    this.focused = null;
    this.glide();
    this.view.x += dx;
    this.view.y += dy;
    this.applyView();
  }

  // one module, as large as the window allows; the same module again goes back to the whole wall
  focus(id) {
    const v = this.views.get(id);
    if (!v) return;
    if (this.focused === id) { this.focused = null; this.glide(); this.frameAll(); return; }
    const r = this.root.getBoundingClientRect();
    const w = r.width - (this.insetRight ?? 0);
    const z = Math.min(2.4, Math.min((w - 60) / v.panel.w, (r.height - 40) / PANEL_H));
    this.glide();
    this.view.zoom = z;
    this.view.x = (w - v.panel.w * z) / 2 - v.x * z;
    this.view.y = (r.height - PANEL_H * z) / 2 - v.y * z;
    this.focused = id;
    this.applyView();
  }

  toWorld(clientX, clientY) {
    const r = this.root.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.zoom, y: (clientY - r.top - this.view.y) / this.view.zoom };
  }

  zoomAt(clientX, clientY, factor) {
    const r = this.root.getBoundingClientRect();
    const z = Math.min(3, Math.max(0.15, this.view.zoom * factor));
    const px = clientX - r.left, py = clientY - r.top;
    this.view.x = px - ((px - this.view.x) * z) / this.view.zoom;
    this.view.y = py - ((py - this.view.y) * z) / this.view.zoom;
    this.view.zoom = z;
    this.applyView();
  }

  // the modules a DJ move just touched light up for a moment
  flash(ids) {
    for (const id of ids) {
      const c = this.views.get(id)?.el.classList;
      if (!c) continue;
      c.remove('dj-lit');
      void this.views.get(id).el.offsetWidth;   // restarts the animation
      c.add('dj-lit');
    }
  }

  frameAll() {
    const r = this.root.getBoundingClientRect();
    if (!this.views.size || !r.width) return;
    this.focused = null;
    let y1 = 0;
    for (const v of this.views.values()) y1 = Math.max(y1, v.y + PANEL_H);
    const x1 = this.rackHp * HP + CHEEK * 2;
    y1 += 24;
    const w = r.width - (this.insetRight ?? 0), h = r.height - (this.insetBottom ?? 0);
    const z = Math.min(1.1, Math.max(0.15, Math.min((w - 24) / x1, (h - 24) / y1)));
    this.view.zoom = z;
    this.view.x = Math.max(12, (w - x1 * z) / 2);
    this.view.y = Math.max(12, (h - y1 * z) / 2);
    this.applyView();
  }

  // ── the rack itself ───────────────────────────────────
  drawRails() {
    const rows = Math.max(1, rowsUsed(this.graph)) + 1;
    // the rack ends a little past the last module, with room to grow
    let used = 0;
    for (const n of this.graph.nodes.values()) used = Math.max(used, n.hp + widthOf(this.graph, n));
    const hp = Math.min(WALL_HP, Math.max(100, Math.ceil((used + 6) / 10) * 10));
    if (this.rowCount === rows && this.rackHp === hp) return;
    this.rowCount = rows;
    this.rackHp = hp;
    this.rails.replaceChildren();
    const width = hp * HP + CHEEK * 2;
    this.rails.style.width = `${width}px`;
    this.rails.style.height = `${rows * ROW_H}px`;
    this.world.style.width = `${width}px`;
    this.world.style.height = `${rows * ROW_H}px`;
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('height', rows * ROW_H + 240);
    this.rails.append(el('div', 'cheek left'), el('div', 'cheek right'));
    for (let r = 0; r < rows; r++) {
      const row = el('div', 'rail-row');
      row.style.top = `${r * ROW_H}px`;
      row.append(el('div', 'rail top'), el('div', 'rail bottom'));
      this.rails.append(row);
    }
  }

  // ── building DOM ──────────────────────────────────────
  rebuild() {
    for (const v of this.views.values()) v.el.remove();
    this.views.clear();
    for (const cv of this.cables.values()) cv.g.remove();
    this.cables.clear();
    for (const id of [...this.selected]) if (!this.graph.nodes.has(id)) this.selected.delete(id);
    this.rowCount = -1;
    for (const node of this.graph.nodes.values()) this.buildModule(node);
    this.sync();
    this.applyView();
  }

  sync() {
    const g = this.graph;
    this.drawRails();
    for (const [id, v] of this.views) {
      if (!g.nodes.has(id)) { v.el.remove(); this.views.delete(id); this.selected.delete(id); }
    }
    for (const node of g.nodes.values()) {
      const v = this.views.get(node.id);
      // a Code module whose source changed gets a new panel
      if (v && node.type === 'code' && v.code !== node.code) { v.el.remove(); this.views.delete(node.id); }
      if (!this.views.has(node.id)) this.buildModule(node);
    }
    this.drawRails();
    for (const [id, cv] of this.cables) if (!g.links.has(id)) { cv.g.remove(); this.cables.delete(id); }
    for (const l of g.links.values()) if (!this.cables.has(l.id)) this.buildCable(l);
    for (const [id, v] of this.views) {
      for (const [name, j] of v.jacks) {
        const on = j.dir === 'in' ? !!g.linkInto(id, name) : [...g.links.values()].some((l) => l.from === id && l.fromPort === name);
        j.el.classList.toggle('plugged', on);
      }
    }
    this.updateCables();
    this.root.classList.toggle('empty', g.nodes.size === 0);
  }

  position(id) {
    const v = this.views.get(id);
    if (!v) return;
    v.x = CHEEK + v.node.hp * HP;
    v.y = 17 + v.node.row * ROW_H;
    v.el.style.left = `${v.x}px`;
    v.el.style.top = `${v.y}px`;
    this.updateCables(id);
    this.drawRails();
  }

  buildModule(node) {
    const def = this.graph.def(node);
    const panel = layoutPanel(def);
    const theme = def.theme ?? CATEGORIES[def.category]?.theme ?? 'black';
    const root = el('div', `mod theme-${theme}`);
    root.dataset.id = node.id;
    root.style.width = `${panel.w}px`;
    root.style.height = `${PANEL_H}px`;
    if (this.selected.has(node.id)) root.classList.add('selected');
    root.append(el('div', 'mod-title', def.title), el('div', 'mod-foot', panel.hp >= 10 ? 'SOUNDWERK' : 'SW'));
    for (const c of ['tl', 'tr', 'bl', 'br']) root.append(el('i', `screw ${c}`));
    if (panel.plate) {
      const plate = el('div', 'plate');
      for (const k of ['x', 'y', 'w', 'h']) plate.style[{ x: 'left', y: 'top', w: 'width', h: 'height' }[k]] = `${panel.plate[k]}px`;
      root.append(plate);
    }
    const v = {
      el: root, node, def, panel, code: node.code,
      x: 0, y: 0, jacks: new Map(), knobs: new Map(), lights: [], mods: [], widgets: [],
    };
    this.views.set(node.id, v);
    const cvs = cvParams(def);
    for (const it of panel.items) {
      const box = this.buildItem(v, it, cvs);
      if (!box) continue;
      box.style.left = `${it.x}px`;
      box.style.top = `${it.y}px`;
      box.style.width = `${it.w}px`;
      box.style.height = `${it.h}px`;
      root.append(box);
    }
    this.mods.append(root);
    this.position(node.id);
    return v;
  }

  buildItem(v, it, cvs) {
    switch (it.kind) {
      case 'knob': return this.makeKnob(v, it.param, it.size, cvs);
      case 'fader': return this.makeFader(v, it.param);
      case 'switch': return this.makeSwitch(v, it.param);
      case 'stepper': return this.makeStepper(v, it.param);
      case 'toggle': return this.makeToggle(v, it.param);
      case 'button': return this.makeButton(v, it.param);
      case 'light': {
        const box = el('div', 'ctl lightbox');
        const led = el('i', `led led-${it.light.color ?? 'red'}`);
        box.append(led);
        if (it.light.label) box.append(el('span', 'lbl', it.light.label));
        v.lights.push({ led, k: (v.def.lights ?? []).indexOf(it.light) });
        return box;
      }
      case 'jack': return this.makeJack(v, it);
      case 'widget': {
        const w = buildWidget(it.ui, { node: v.node, def: v.def, spec: it.spec, wall: this, host: this.host, graph: this.graph });
        v.widgets.push(w);
        w.el.classList.add('ctl');
        return w.el;
      }
      default: return null;
    }
  }

  // Drag up or to the right to raise. Shift is fine control, double-click resets, right-click types.
  bindDrag(target, { get, set, min, max, step = 0, reset, label, format }) {
    const g = this.graph;
    let drag = null;
    const apply = (raw) => {
      let v = step ? Math.round(raw / step) * step : raw;
      v = Math.min(max, Math.max(min, v));
      set(v);
      this.showTip(target, `${label} ${format(v)}`);
    };
    target.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      target.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, v: get() };
      this.showTip(target, `${label} ${format(get())}`);
    });
    target.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const px = e.clientX - drag.x - (e.clientY - drag.y);
      apply(drag.v + (px / 220) * (max - min) * (e.shiftKey ? 0.1 : 1));
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.hideTip();
      g.commit();
    };
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('pointerenter', () => { if (!drag) this.showTip(target, `${label} ${format(get())}`); });
    target.addEventListener('pointerleave', () => { if (!drag) this.hideTip(); });
    target.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      set(reset);
      g.commit();
    });
    target.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = el('input', 'value-input');
      input.value = String(+get().toFixed(4));
      input.style.left = `${e.clientX}px`;
      input.style.top = `${e.clientY}px`;
      document.body.append(input);
      input.select();
      let closed = false;
      const done = (ok) => {
        if (closed) return;
        closed = true;
        if (ok && input.value.trim() !== '' && Number.isFinite(Number(input.value))) { apply(Number(input.value)); this.hideTip(); g.commit(); }
        input.remove();
      };
      input.addEventListener('keydown', (k) => { k.stopPropagation(); if (k.key === 'Enter') done(true); if (k.key === 'Escape') done(false); });
      input.addEventListener('blur', () => done(true));
    });
  }

  makeKnob(v, p, size, cvs) {
    const node = v.node, g = this.graph;
    const box = el('div', `ctl knob k-${size}`);
    const dial = el('div', 'dial');
    const cap = el('div', 'cap');
    cap.append(el('i', 'ptr'));
    const dot = el('i', 'mod-dot');
    dial.append(el('i', 'ticks'), cap, dot);
    box.append(dial, el('span', 'lbl', p.label ?? p.name));
    const angle = (val) => -135 + 270 * Math.max(0, Math.min(1, (val - p.min) / (p.max - p.min)));
    const show = (val) => { cap.style.transform = `rotate(${angle(val)}deg)`; };
    show(node.params[p.name]);
    this.bindDrag(dial, {
      get: () => node.params[p.name], set: (val) => g.setParam(node.id, p.name, val),
      min: p.min, max: p.max, step: p.step, reset: p.default, label: `${v.def.title} · ${p.label ?? p.name}`, format: (val) => fmtValue(p, val),
    });
    v.knobs.set(p.name, { p, show });
    const k = cvs.indexOf(p);
    if (k >= 0) v.mods.push({ name: p.name, k, dot, angle });
    return box;
  }

  makeFader(v, p) {
    const node = v.node, g = this.graph;
    const box = el('div', 'ctl fader');
    const track = el('div', 'track');
    const thumb = el('i', 'thumb');
    track.append(thumb);
    box.append(track, el('span', 'lbl', p.label ?? p.name));
    const show = (val) => { thumb.style.top = `${(1 - (val - p.min) / (p.max - p.min)) * 100}%`; };
    show(node.params[p.name]);
    this.bindDrag(track, {
      get: () => node.params[p.name], set: (val) => g.setParam(node.id, p.name, val),
      min: p.min, max: p.max, step: p.step, reset: p.default, label: `${v.def.title} · ${p.label ?? p.name}`, format: (val) => fmtValue(p, val),
    });
    v.knobs.set(p.name, { p, show });
    return box;
  }

  makeSwitch(v, p) {
    const node = v.node, g = this.graph;
    const box = el('div', 'ctl switch');
    box.append(el('span', 'lbl', p.label ?? p.name));
    const rows = p.options.map((o, k) => {
      const row = el('div', 'opt');
      row.append(el('i', 'led led-red'), el('span', '', o));
      row.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        g.setParam(node.id, p.name, k);
        g.commit();
      });
      box.append(row);
      return row;
    });
    const show = (val) => rows.forEach((r, k) => r.classList.toggle('on', k === Math.round(val)));
    show(node.params[p.name]);
    v.knobs.set(p.name, { p, show });
    return box;
  }

  makeStepper(v, p) {
    const node = v.node, g = this.graph;
    const box = el('div', 'ctl stepper');
    box.append(el('span', 'lbl', p.label ?? p.name));
    const sel = el('select', 'lcd');
    p.options.forEach((o, k) => sel.append(new Option(o, k)));
    sel.value = node.params[p.name];
    sel.addEventListener('pointerdown', (e) => e.stopPropagation());
    sel.addEventListener('change', () => { g.setParam(node.id, p.name, Number(sel.value)); g.commit(); sel.blur(); });
    box.append(sel);
    v.knobs.set(p.name, { p, show: (val) => { sel.value = String(Math.round(val)); } });
    return box;
  }

  makeToggle(v, p) {
    const node = v.node, g = this.graph;
    const box = el('div', 'ctl toggle');
    const btn = el('button', 'push');
    btn.tabIndex = -1;
    btn.append(el('i', 'led led-red'));
    box.append(btn, el('span', 'lbl', p.label ?? p.name));
    const show = (val) => btn.classList.toggle('on', val > 0.5);
    show(node.params[p.name]);
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      g.setParam(node.id, p.name, node.params[p.name] > 0.5 ? 0 : 1);
      g.commit();
    });
    v.knobs.set(p.name, { p, show });
    return box;
  }

  makeButton(v, p) {
    const node = v.node, g = this.graph;
    const box = el('div', 'ctl toggle');
    const btn = el('button', 'push');
    btn.tabIndex = -1;
    box.append(btn, el('span', 'lbl', p.label ?? p.name));
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('on');
      g.setParam(node.id, p.name, 1);
    });
    const up = () => { btn.classList.remove('on'); g.setParam(node.id, p.name, 0); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    v.knobs.set(p.name, { p, show: () => {} });
    return box;
  }

  makeJack(v, it) {
    const { port, dir } = it;
    const node = v.node, g = this.graph;
    const box = el('div', `ctl jackbox ${dir}${port.param ? ' cv' : ''}`);
    if (port.param) {
      const p = v.def.params.find((q) => q.name === port.name);
      const trim = el('div', 'trim');
      const cap = el('div', 'cap');
      cap.append(el('i', 'ptr'));
      trim.append(cap);
      const show = () => { cap.style.transform = `rotate(${(node.depth[p.name] ?? DEFAULT_DEPTH) * 135}deg)`; };
      show();
      this.bindDrag(trim, {
        get: () => node.depth[p.name] ?? DEFAULT_DEPTH, set: (val) => { g.setDepth(node.id, p.name, val); },
        min: -1, max: 1, reset: DEFAULT_DEPTH, label: `${v.def.title} · ${p.label ?? p.name} CV`, format: (val) => `${val >= 0 ? '+' : ''}${Math.round(val * 100)} %`,
      });
      v.knobs.set(`depth:${p.name}`, { p, show });
      box.append(trim);
    }
    const jack = el('div', `jack ${dir}`);
    jack.dataset.node = node.id;
    jack.dataset.port = port.name;
    jack.dataset.dir = dir;
    jack.dataset.kind = port.kind ?? 'audio';
    jack.title = '';
    jack.addEventListener('pointerenter', () => this.hoverJack(jack, port, dir, true, v.def.title));
    jack.addEventListener('pointerleave', () => this.hoverJack(jack, port, dir, false));
    const label = port.label ?? port.name;
    box.append(jack, el('span', label.length > 5 ? 'lbl tight' : 'lbl', label));
    const cy = it.y + (port.param ? 34 : 15);
    v.jacks.set(port.name, { el: jack, dir, x: it.x + it.w / 2, y: cy, port });
    return box;
  }

  hoverJack(jack, port, dir, on, title = '') {
    const { node } = jack.dataset;
    for (const cv of this.cables.values()) {
      const l = cv.link;
      if ((dir === 'out' && l.from === node && l.fromPort === port.name) || (dir === 'in' && l.to === node && l.toPort === port.name)) cv.g.classList.toggle('hover', on);
    }
    if (on) this.showTip(jack, `${title} · ${port.label ?? port.name} ${dir === 'out' ? 'out' : 'in'}${port.kind ? ` · ${port.kind}` : ''}`);
    else this.hideTip();
  }

  showTip(target, text) {
    const r = target.getBoundingClientRect();
    this.tip.textContent = text;
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${r.left + r.width / 2}px`;
    this.tip.style.top = `${r.top - 6}px`;
  }

  hideTip() { this.tip.classList.add('hidden'); }

  // ── cables ─────────────────────────────────────────────
  buildCable(l) {
    const kind = this.graph.outPort(l.from, l.fromPort)?.kind ?? 'audio';
    const h = hash(l.id);
    const pal = CABLES[kind] ?? CABLES.audio;
    const gEl = svg('g', 'cable');
    gEl.style.setProperty('--c', pal[h % pal.length]);
    const shadow = svg('path', 'shadow');
    const core = svg('path', 'core');
    const shine = svg('path', 'shine');
    const light = svg('path', 'light');
    const hit = svg('path', 'hit');
    const plugA = svg('circle', 'plug');
    const plugB = svg('circle', 'plug');
    for (const p of [plugA, plugB]) p.setAttribute('r', 8.5);
    gEl.append(shadow, core, shine, light, plugA, plugB, hit);
    this.linkLayer.append(gEl);
    const cv = { g: gEl, shadow, core, shine, light, hit, plugA, plugB, link: l, slack: 0.82 + ((h >> 4) % 45) / 100, sway: ((h >> 8) % 5) - 2, swayV: 0, restSway: ((h >> 8) % 41) - 20 };
    cv.sway = cv.restSway;
    this.cables.set(l.id, cv);
    this.drawCable(cv);
  }

  // Cables lie on top of everything but must never get in the way of a knob or a jack, so
  // they take no pointer events: a click on one is worked out from the geometry instead.
  cableAt(e) {
    const p = this.toWorld(e.clientX, e.clientY);
    const pt = this.svg.createSVGPoint();
    pt.x = p.x;
    pt.y = p.y;
    for (const cv of this.cables.values()) if (cv.hit.isPointInStroke(pt)) return cv;
    return null;
  }

  jackPos(id, port) {
    const v = this.views.get(id), j = v?.jacks.get(port);
    return j ? { x: v.x + j.x, y: v.y + j.y } : null;
  }

  drawCable(cv) {
    const a = this.jackPos(cv.link.from, cv.link.fromPort), b = this.jackPos(cv.link.to, cv.link.toPort);
    if (!a || !b) return;
    const d = cablePath(a, b, cv.slack, cv.sway);
    cv.core.setAttribute('d', d);
    cv.shadow.setAttribute('d', d);
    cv.shine.setAttribute('d', d);
    cv.light.setAttribute('d', d);
    cv.hit.setAttribute('d', d);
    cv.plugA.setAttribute('cx', a.x);
    cv.plugA.setAttribute('cy', a.y);
    cv.plugB.setAttribute('cx', b.x);
    cv.plugB.setAttribute('cy', b.y);
  }

  updateCables(only) {
    for (const cv of this.cables.values()) {
      if (only && cv.link.from !== only && cv.link.to !== only) continue;
      this.drawCable(cv);
    }
  }

  // cables are heavy: drag a module and they swing, then settle
  shake(id, vx) {
    for (const cv of this.cables.values()) {
      if (cv.link.from === id || cv.link.to === id) { cv.swayV += vx * 0.6; this.swinging = true; }
    }
  }

  swing(dt) {
    let moving = false;
    for (const cv of this.cables.values()) {
      const off = cv.sway - cv.restSway;
      if (Math.abs(off) < 0.05 && Math.abs(cv.swayV) < 0.05) continue;
      cv.swayV += (-90 * off - 3.2 * cv.swayV) * dt;
      cv.sway += cv.swayV * dt;
      this.drawCable(cv);
      moving = true;
    }
    this.swinging = moving;
  }

  setCableMode(mode) {
    this.cableMode = mode;
    this.root.dataset.cables = ['solid', 'faint', 'hidden'][mode];
  }

  // ── adding and removing ────────────────────────────────
  select(id, additive = false) {
    if (!additive) this.selected.clear();
    if (id) {
      if (additive && this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
    }
    for (const [nid, v] of this.views) v.el.classList.toggle('selected', this.selected.has(nid));
    this.dispatchEvent(new CustomEvent('select', { detail: { ids: [...this.selected] } }));
  }

  openAdd(clientX, clientY, from = null) {
    const g = this.graph;
    const pos = this.toWorld(clientX, clientY);
    const hasMaster = !!g.masterNode();
    this.menu.open({
      x: clientX,
      y: clientY,
      filter: (d) => {
        if (d.type === 'master' && hasMaster) return false;
        if (!from) return true;
        return from.dir === 'out' ? inputPorts(d.type === 'code' ? { inputs: [] } : d).length > 0 : outputPorts(d).length > 0;
      },
      onPick: (d) => {
        const node = g.addNode(d.type, 0, 0);
        this.placeNear(node, pos);
        if (from) {
          const full = g.def(node);
          if (from.dir === 'out') {
            const ins = inputPorts(full);
            const target = ins.find((p) => p.kind === from.kind && !g.linkInto(node.id, p.name)) ?? ins[0];
            if (target) g.connect(from.node, from.port, node.id, target.name);
          } else {
            const outs = outputPorts(full);
            const src = outs.find((p) => p.kind === from.kind) ?? outs[0];
            if (src) g.connect(node.id, src.name, from.node, from.port);
          }
        }
        g.commit();
        this.select(node.id);
      },
    });
  }

  placeNear(node, pos) {
    const g = this.graph;
    const width = widthOf(g, node);
    const row = Math.max(0, Math.floor(pos.y / ROW_H));
    const hp = Math.max(0, Math.round((pos.x - CHEEK) / HP));
    const overlaps = [...g.nodes.values()].some((n) => n !== node && n.row === row && n.hp < hp + width && n.hp + widthOf(g, n) > hp);
    const at = overlaps || hp + width > WALL_HP ? findGap(g, width, { startRow: row, skip: new Set([node.id]) }) : { row, hp };
    g.moveNode(node.id, at.row, at.hp);
  }

  deleteSelected() {
    if (!this.selected.size) return;
    for (const id of this.selected) this.graph.removeNode(id);
    this.selected.clear();
    this.graph.commit();
  }

  duplicateSelected() {
    const g = this.graph;
    const fresh = [];
    for (const id of this.selected) {
      const n = g.nodes.get(id);
      if (!n || n.type === 'master') continue;
      const copy = g.addNode(n.type, n.row, n.hp, { params: { ...n.params }, depth: { ...n.depth }, data: structuredClone(n.data), code: n.code });
      const at = findGap(g, widthOf(g, copy), { startRow: n.row, skip: new Set([copy.id]) });
      g.moveNode(copy.id, at.row, at.hp);
      const buf = this.host.buffers.get(n.id);
      if (buf) this.host.setBuffer(copy.id, buf);
      fresh.push(copy.id);
    }
    if (!fresh.length) return;
    g.commit();
    this.selected = new Set(fresh);
    this.select(null, true);
  }

  // ── events ────────────────────────────────────────────
  bindEvents() {
    const root = this.root;
    let pan = null, move = null, cable = null;

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.focused = null;
      if (e.ctrlKey || e.metaKey) this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.applyView(); }
    }, { passive: false });

    root.addEventListener('pointerdown', (e) => {
      if (!e.altKey) return;
      const cv = this.cableAt(e);
      if (!cv) return;
      e.stopPropagation();
      this.graph.disconnect(cv.link.id);
      this.graph.commit();
    }, true);

    root.addEventListener('pointerdown', (e) => {
      const jack = e.target.closest('.jack');
      const mod = e.target.closest('.mod');
      if (jack) {
        e.preventDefault();
        root.setPointerCapture(e.pointerId);
        cable = this.startCable(jack);
        this.updateDragCable(cable, e);
        return;
      }
      if (mod && e.button === 0) {
        const id = mod.dataset.id;
        if (e.shiftKey) this.select(id, true);
        else if (!this.selected.has(id)) this.select(id);
        root.setPointerCapture(e.pointerId);
        // a module moves by its name; dragging the rest of the panel moves the view, so a hand
        // that misses a knob can't shift a module, and a zoomed-in wall can still be pushed around
        if (e.target.closest('.mod-title')) {
          move = {
            x: e.clientX, y: e.clientY, lastX: e.clientX, moved: false,
            start: [...this.selected].map((nid) => ({ id: nid, row: this.graph.nodes.get(nid).row, hp: this.graph.nodes.get(nid).hp })),
          };
        } else pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, onModule: true };
        return;
      }
      if (e.button === 0 || e.button === 1) {
        root.setPointerCapture(e.pointerId);
        pan = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      }
    });

    root.addEventListener('pointermove', (e) => {
      this.pointer = { x: e.clientX, y: e.clientY };
      if (pan) {
        this.view.x = pan.vx + e.clientX - pan.x;
        this.view.y = pan.vy + e.clientY - pan.y;
        if (Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 3) { pan.moved = true; this.focused = null; }
        this.applyView();
      } else if (move) {
        const dx = (e.clientX - move.x) / this.view.zoom, dy = (e.clientY - move.y) / this.view.zoom;
        if (Math.abs(dx) + Math.abs(dy) > 3) move.moved = true;
        if (!move.moved) return;
        for (const s of move.start) {
          const v = this.views.get(s.id);
          if (!v) continue;      // deleted mid-drag
          s.toRow = Math.max(0, Math.round(s.row + dy / ROW_H));
          s.toHp = Math.max(0, Math.min(WALL_HP - v.panel.hp, Math.round(s.hp + dx / HP)));
          v.x = CHEEK + s.toHp * HP;
          v.y = 17 + s.toRow * ROW_H;
          v.el.style.left = `${v.x}px`;
          v.el.style.top = `${v.y}px`;
          v.el.classList.add('lifted');
          this.updateCables(s.id);
          this.shake(s.id, e.clientX - move.lastX);
        }
        move.lastX = e.clientX;
      } else if (cable) this.updateDragCable(cable, e);
    });

    const end = (e) => {
      if (pan) {
        if (!pan.moved && e.button === 0 && !pan.onModule) this.select(null);
        pan = null;
      }
      if (move) {
        if (move.moved) {
          for (const s of move.start) {
            const node = this.graph.nodes.get(s.id);    // it may have been deleted mid-drag
            if (!node) continue;
            this.views.get(s.id)?.el.classList.remove('lifted');
            dropAt(this.graph, node, s.toRow, s.toHp);
          }
          this.graph.commit();
        }
        move = null;
      }
      if (cable) {
        this.finishCable(cable, e);
        cable = null;
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    // pointer capture retargets click events to the root, so look at what's under the pointer
    const under = (e) => document.elementFromPoint(e.clientX, e.clientY) ?? e.target;
    root.addEventListener('dblclick', (e) => {
      const hit = under(e);
      if (hit.closest('.ctl')) return;
      const cv = this.cableAt(e);
      if (cv) {
        this.graph.disconnect(cv.link.id);
        this.graph.commit();
        return;
      }
      const mod = hit.closest('.mod');
      if (mod) {
        if (hit.closest('.mod-title')) this.dispatchEvent(new CustomEvent('open-code', { detail: { id: mod.dataset.id } }));
        else this.focus(mod.dataset.id);
        return;
      }
      this.openAdd(e.clientX, e.clientY);
    });
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!under(e).closest('.mod')) this.openAdd(e.clientX, e.clientY);
    });
  }

  startCable(jack) {
    const { node, port, dir, kind } = jack.dataset;
    this.root.classList.add('patching', `patching-from-${dir}`);
    if (dir === 'in') {
      // grabbing a plugged input lifts that cable off and carries it
      const existing = this.graph.linkInto(node, port);
      if (existing) {
        this.graph.disconnect(existing.id);
        this.root.classList.replace('patching-from-in', 'patching-from-out');
        return { node: existing.from, port: existing.fromPort, dir: 'out', kind, lifted: true };
      }
    }
    return { node, port, dir, kind };
  }

  updateDragCable(c, e) {
    const a = this.jackPos(c.node, c.port);
    const b = this.toWorld(e.clientX, e.clientY);
    this.dragPath.setAttribute('d', c.dir === 'out' ? cablePath(a, b) : cablePath(b, a));
  }

  finishCable(c, e) {
    this.dragPath.setAttribute('d', '');
    this.root.classList.remove('patching', 'patching-from-in', 'patching-from-out');
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const target = under?.closest('.jack');
    const g = this.graph;
    if (target && target.dataset.dir !== c.dir) {
      const res = c.dir === 'out'
        ? g.connect(c.node, c.port, target.dataset.node, target.dataset.port)
        : g.connect(target.dataset.node, target.dataset.port, c.node, c.port);
      if (!res.ok) this.dispatchEvent(new CustomEvent('message', { detail: { text: `Can't patch that: ${res.reason}` } }));
      g.commit();
      return;
    }
    if (c.lifted) { g.commit(); return; }
    if (!target && !under?.closest('.mod')) this.openAdd(e.clientX, e.clientY, c);
  }

  // ── per-frame ─────────────────────────────────────────
  visible(v) {
    const r = this.rect;
    const { x, y, zoom } = this.view;
    const sx = x + v.x * zoom, sy = y + v.y * zoom;
    return !(sx + v.panel.w * zoom < 0 || sy + PANEL_H * zoom < 0 || sx > r.width || sy > r.height);
  }

  tick(now, dt) {
    if (this.swinging) this.swing(Math.min(dt, 0.03));
    this.frame++;
    this.rect = this.root.getBoundingClientRect();
    if (!this.rect.width) return;
    const host = this.host;
    for (const [id, v] of this.views) {
      if (!this.visible(v)) continue;
      const ui = host.ui(id);
      if (!ui) continue;
      for (let k = 0; k < v.lights.length; k++) {
        const l = v.lights[k];
        const on = Math.round(ui[l.k] * 10);    // a tenth is all an LED can show, and repaints aren't free
        if (on !== l.on) { l.on = on; l.led.style.setProperty('--on', on / 10); }
      }
      for (let k = 0; k < v.mods.length; k++) {
        const m = v.mods[k];
        const a = this.graph.linkInto(id, m.name) ? Math.round(m.angle(ui[64 + m.k])) : null;
        if (a === m.shown) continue;
        if ((a === null) !== (m.shown === null || m.shown === undefined)) m.dot.classList.toggle('on', a !== null);
        m.shown = a;
        if (a !== null) m.dot.style.transform = `rotate(${a}deg)`;
      }
      for (let k = 0; k < v.widgets.length; k++) v.widgets[k].tick?.(ui, host.wave(id), now);
    }
    // cables light up with what they carry; a long one repaints half the wall, so only when it shows
    if (this.frame % 4 === 0 && this.cableMode !== 2) {
      for (const cv of this.cables.values()) {
        const v = this.views.get(cv.link.from);
        const ui = v && host.ui(cv.link.from);
        if (!ui) continue;
        const k = v.def.outputs.findIndex((o) => o.name === cv.link.fromPort);
        const level = Math.round(Math.min(1, ui[104 + k] * 0.16) * 5);
        if (level !== cv.level) { cv.level = level; cv.light.style.opacity = level / 5; }
      }
    }
  }

  // Show values changed from code (the assistant, undo).
  refreshParam({ id, name }) {
    const v = this.views.get(id);
    const knob = v?.knobs.get(name);
    if (knob && v.node.params[name] !== undefined) knob.show(v.node.params[name]);
    v?.knobs.get(`depth:${name}`)?.show();
  }

  refreshNode(id) {
    const v = this.views.get(id);
    if (!v) return;
    for (const [name, k] of v.knobs) {
      if (name.startsWith('depth:')) k.show();
      else if (v.node.params[name] !== undefined) k.show(v.node.params[name]);
    }
    v.widgets.forEach((w) => w.refresh?.());
  }
}

export { getDef, paramRange };
