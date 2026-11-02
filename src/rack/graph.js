// The patch: modules on the wall, cables between jacks, and undo history.
// Emits 'change' events with detail.kind: 'structure' | 'param' | 'depth' | 'data' | 'move' | 'load'.
import { defFor, getDef, inputPorts, outputPorts, paramRange, DEFAULT_CODE } from '../modules/index.js';

export class Graph extends EventTarget {
  constructor() {
    super();
    this.nodes = new Map();
    this.links = new Map();
    this.nextId = 1;
    this.history = [];
    this.future = [];
    this.wholePatches = new Set();   // snapshots that replaced everything: going back to one rebuilds
    this.rig = null;                 // what the live DJ may do to this patch
    this.midiMap = {};               // "channel:cc" → { id, name }: controllers learned onto knobs
  }

  def(node) { return defFor(node); }

  addNode(type, row = 0, hp = 0, init = {}) {
    const base = getDef(type);
    if (!base) throw new Error(`unknown module type ${type}`);
    const id = init.id ?? `n${this.nextId++}`;
    const node = { id, type, row, hp, params: {}, depth: {}, data: null };
    if (type === 'code') node.code = init.code ?? DEFAULT_CODE;
    const def = this.def(node);
    for (const p of def.params ?? []) node.params[p.name] = paramRange(p).def;
    if (def.defaultData) node.data = def.defaultData();
    Object.assign(node.params, init.params);
    Object.assign(node.depth, init.depth);
    if (init.data !== undefined) node.data = init.data;
    this.nodes.set(id, node);
    this.changed('structure');
    return node;
  }

  removeNode(id) {
    for (const l of [...this.links.values()]) if (l.from === id || l.to === id) this.links.delete(l.id);
    this.nodes.delete(id);
    this.changed('structure');
  }

  // After a Code module's source changes its jacks may differ: drop cables to jacks that vanished.
  setCode(id, code) {
    const node = this.nodes.get(id);
    node.code = code;
    const def = this.def(node);
    for (const p of def.params ?? []) if (!(p.name in node.params)) node.params[p.name] = paramRange(p).def;
    const ins = new Set(inputPorts(def).map((p) => p.name));
    const outs = new Set(outputPorts(def).map((p) => p.name));
    for (const l of [...this.links.values()]) {
      if ((l.to === id && !ins.has(l.toPort)) || (l.from === id && !outs.has(l.fromPort))) this.links.delete(l.id);
    }
    this.changed('structure');
  }

  outPort(nodeId, port) {
    const node = this.nodes.get(nodeId);
    return node ? outputPorts(this.def(node)).find((p) => p.name === port) : null;
  }

  inPort(nodeId, port) {
    const node = this.nodes.get(nodeId);
    return node ? inputPorts(this.def(node)).find((p) => p.name === port) : null;
  }

  // Volts are volts: anything may go into anything, and loops are allowed. An input takes one cable.
  connect(from, fromPort, to, toPort) {
    if (!this.outPort(from, fromPort) || !this.inPort(to, toPort)) return { ok: false, reason: 'no such jack' };
    const existing = this.linkInto(to, toPort);
    if (existing) this.links.delete(existing.id);
    const id = `l${this.nextId++}`;
    this.links.set(id, { id, from, fromPort, to, toPort });
    this.changed('structure');
    return { ok: true, id };
  }

  disconnect(linkId) {
    if (this.links.delete(linkId)) this.changed('structure');
  }

  linkInto(nodeId, port) {
    for (const l of this.links.values()) if (l.to === nodeId && l.toPort === port) return l;
    return null;
  }

  linksOf(nodeId) {
    return [...this.links.values()].filter((l) => l.from === nodeId || l.to === nodeId);
  }

  setParam(id, name, value) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.params[name] = value;
    this.changed('param', { id, name, value });
  }

  setDepth(id, name, value) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.depth[name] = value;
    this.changed('depth', { id, name, value });
  }

  // back to the default, as if nobody had touched it
  clearDepth(id, name) {
    const node = this.nodes.get(id);
    if (!node || !(name in node.depth)) return;
    delete node.depth[name];
    this.changed('depth', { id, name, value: 0.5 });
  }

  setData(id, data) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.data = data;
    this.changed('data', { id, data });
  }

  moveNode(id, row, hp) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.row = row;
    node.hp = hp;
    this.changed('move', { id });
  }

  setRig(rig) {
    this.rig = rig;
    this.changed('rig');
  }

  masterNode() {
    for (const n of this.nodes.values()) if (n.type === 'master') return n;
    return null;
  }

  changed(kind, detail = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { kind, ...detail } }));
  }

  // ── persistence ─────────────────────────────────────────
  toJSON() {
    return {
      version: 1,
      nodes: [...this.nodes.values()].map((n) => structuredClone(n)),
      links: [...this.links.values()].map((l) => ({ ...l })),
      nextId: this.nextId,   // ids are never reused: a rig remembers the ones it added
      ...(this.rig ? { rig: structuredClone(this.rig) } : {}),
      ...(Object.keys(this.midiMap).length ? { midiMap: structuredClone(this.midiMap) } : {}),
    };
  }

  load(json) {
    this.nodes.clear();
    this.links.clear();
    let max = 0;
    const num = (id) => Number(String(id).slice(1)) || 0;
    for (const n of json.nodes ?? []) {
      if (!getDef(n.type)) continue;
      const node = { id: n.id, type: n.type, row: n.row ?? 0, hp: n.hp ?? 0, params: {}, depth: { ...n.depth }, data: null };
      if (n.type === 'code') node.code = n.code ?? DEFAULT_CODE;
      const def = this.def(node);
      for (const p of def.params ?? []) node.params[p.name] = paramRange(p).def;
      Object.assign(node.params, n.params);
      node.data = n.data !== undefined && n.data !== null ? structuredClone(n.data) : def.defaultData?.() ?? null;
      this.nodes.set(node.id, node);
      max = Math.max(max, num(node.id));
    }
    for (const l of json.links ?? []) {
      max = Math.max(max, num(l.id));
      if (!this.outPort(l.from, l.fromPort) || !this.inPort(l.to, l.toPort)) continue;
      this.links.set(l.id, { id: l.id, from: l.from, fromPort: l.fromPort, to: l.to, toPort: l.toPort });
    }
    this.nextId = Math.max(max + 1, json.nextId ?? 0);
    this.rig = json.rig ? structuredClone(json.rig) : null;
    this.midiMap = structuredClone(json.midiMap ?? {});
    this.changed('load');
  }

  // ── undo: whole-patch snapshots, pushed after each finished edit ──
  commit(wholePatch = false) {
    const snap = JSON.stringify(this.toJSON());
    if (wholePatch) this.wholePatches.add(snap);
    if (this.history[this.history.length - 1] === snap) return;
    this.history.push(snap);
    if (this.history.length > 200) this.history.shift();
    this.future = [];
    this.dispatchEvent(new CustomEvent('commit'));
  }

  undo() {
    if (this.history.length < 2) return;
    const left = this.history.pop();
    this.future.push(left);
    if (this.wholePatches.has(left)) this.dispatchEvent(new CustomEvent('rebuild'));
    this.load(JSON.parse(this.history[this.history.length - 1]));
    this.dispatchEvent(new CustomEvent('commit'));
  }

  redo() {
    if (!this.future.length) return;
    const snap = this.future.pop();
    this.history.push(snap);
    if (this.wholePatches.has(snap)) this.dispatchEvent(new CustomEvent('rebuild'));
    this.load(JSON.parse(snap));
    this.dispatchEvent(new CustomEvent('commit'));
  }
}
