// The engine: every module instance, the cables between them, and one sample at a time.
// Pure JavaScript with no browser in it, so the AudioWorklet and Node run exactly the same
// thing: the worklet for sound, Node for rendering patches and measuring them.
import { getDef, inputPorts, outputPorts, cvParams, paramRange } from '../modules/index.js';
import { RAIL } from '../modules/lib/index.js';
import { compileCode } from './code.js';

const STALE = 32;      // 16ths: nothing is ever held for more than a bar ahead

// Telemetry is one Float32Array, shared with the wall when there is a wall.
export const TEL = {
  GLOBAL: 64,      // [0] cpu, [1] [2] master peaks, [3] clipping, [4] running
  UI: 128,         // per module: 0..63 its own, 64..103 modulated params, 104..127 output peaks
  SLOTS: 256,
  WAVE: 16384,     // screens: a module with `wave: true` gets one of these
  WAVES: 16,
};
export const telemetrySize = () => TEL.GLOBAL + TEL.UI * TEL.SLOTS + TEL.WAVE * TEL.WAVES;
const UI_PARAMS = 64, UI_OUTS = 104;

const defFor = (msg) => (msg.type === 'code' ? null : getDef(msg.type));

class Instance {
  constructor(rack, id, def, slot, waveSlot) {
    this.id = id;
    this.def = def;
    this.slot = slot;
    this.ports = inputPorts(def);
    this.params = def.params ?? [];
    this.outs = outputPorts(def);
    this.i = new Float64Array(this.ports.length);
    this.o = new Float64Array(Math.max(1, this.outs.length));
    this.p = new Float64Array(this.params.length);
    this.base = new Float64Array(this.params.length);
    this.linked = new Uint8Array(this.ports.length);
    this.depth = new Float64Array(this.params.length).fill(0.5);
    this.wires = [];       // { src, from, to, peak }
    this.mods = [];        // patched params: { param, input, scale, min, max, step }
    this.fades = null;     // inputs still easing onto a new cable: { to, gap, left }
    this.ui = rack.telemetry.subarray(TEL.GLOBAL + TEL.UI * slot, TEL.GLOBAL + TEL.UI * (slot + 1));
    this.wave = waveSlot >= 0
      ? rack.telemetry.subarray(TEL.GLOBAL + TEL.UI * TEL.SLOTS + TEL.WAVE * waveSlot, TEL.GLOBAL + TEL.UI * TEL.SLOTS + TEL.WAVE * (waveSlot + 1))
      : def.wave ? new Float32Array(TEL.WAVE) : null;   // out of shared screens: blank, but the wall plays on
    this.normal = this.ports.map((p) => {   // R falls back to L while it has no cable
      const left = p.name === 'r' ? 'l' : p.name.endsWith('R') ? `${p.name.slice(0, -1)}L` : null;
      return left ? this.ports.findIndex((q) => q.name === left) : -1;
    });
    this.waveSlot = waveSlot;
    this.dsp = null;
    this.data = null;
    this.file = null;
    this.warned = false;
    this.rack = rack;
    this.fresh();
  }

  fresh() {
    const m = new this.def.dsp(this.rack.sr);
    m.linked = this.linked;
    m.ui = this.ui;
    m.wave = this.wave;
    m.rack = this.rack;
    if (this.data != null) m.onData(this.data);
    if (this.file !== null) m.onMessage(this.file);
    this.dsp = m;
  }
}

export class Rack {
  constructor({ sampleRate, telemetry } = {}) {
    this.sr = sampleRate;
    this.telemetry = telemetry ?? new Float32Array(telemetrySize());
    this.modules = new Map();
    this.order = [];
    this.ramps = [];
    this.links = [];
    this.master = null;
    this.running = false;
    this.samples = 0;     // since start: Clocks and the like may read rack.samples
    this.inL = 0;         // what the Audio In module reads
    this.inR = 0;
    this.nextSlot = 0;
    this.freeSlots = [];
    this.freeWaves = [];
    this.nextWave = 0;
    this.onError = null;  // (module id, message): a Code module threw
    this.onMidi = null;   // (module id, [[sample, ...bytes]]): what a MIDI Out has to say
    this.queued = [];     // changes waiting for a step of a Clock, in order
    this.fadeLength = Math.round(sampleRate * 0.005);
  }

  // ── changing the patch: called between blocks ──────────
  apply(m) {
    switch (m.t) {
      case 'add': return this.add(m);
      case 'remove': return this.remove(m.id);
      case 'links': return this.setLinks(m.links);
      case 'param': return this.setParam(m.id, m.k, m.v);
      case 'depth': return this.setDepth(m.id, m.k, m.v);
      case 'data': return this.setData(m.id, m.data);
      case 'msg': return this.message(m.id, m.msg);
      case 'code': return this.setCode(m.id, m.code);
      case 'run': this.running = !!m.on; return undefined;
      case 'at': this.queued.push(m); return undefined;
      case 'flush': this.land(Infinity); return undefined;
      default: return undefined;
    }
  }

  // The host hands out slots so the wall knows where to read; Node leaves that to the rack.
  add({ id, type, params, depth, data, code, slot, waveSlot }) {
    const def = type === 'code' ? compileCode(code).def : defFor({ type });
    if (!def) return;
    slot ??= this.freeSlots.pop() ?? this.nextSlot++;
    if (slot >= TEL.SLOTS) throw new Error('the wall is full');
    waveSlot ??= def.wave ? (this.freeWaves.pop() ?? (this.nextWave < TEL.WAVES ? this.nextWave++ : -1)) : -1;
    const ui = this.telemetry.subarray(TEL.GLOBAL + TEL.UI * slot, TEL.GLOBAL + TEL.UI * (slot + 1));
    ui.fill(0);
    const inst = new Instance(this, id, def, slot, waveSlot);
    inst.params.forEach((p, k) => {
      const v = params?.[p.name] ?? paramRange(p).def;
      inst.base[k] = v;
      inst.p[k] = v;
      if (depth?.[p.name] !== undefined) inst.depth[k] = depth[p.name];
    });
    if (data != null) { inst.data = data; inst.dsp.onData(data); }
    this.modules.set(id, inst);
    if (type === 'master') this.master = inst;
    this.relink();
  }

  remove(id) {
    const m = this.modules.get(id);
    if (!m) return;
    this.modules.delete(id);
    this.freeSlots.push(m.slot);
    if (m.waveSlot >= 0) this.freeWaves.push(m.waveSlot);
    if (this.master === m) this.master = null;
    this.ramps = this.ramps.filter((r) => r.m !== m);
    this.relink();
  }

  message(id, msg) {
    const m = this.modules.get(id);
    if (!m) return;
    if (msg.kind === 'rewind') { m.dsp.rewind?.(); return; }
    if (msg.kind === 'advance') { m.dsp.advance?.(msg.n, m.p); return; }
    if (msg.kind === 'buffer' || msg.kind === 'bridge') m.file = msg;
    else if (msg.kind === 'clear') m.file = null;
    m.dsp.onMessage(msg);
  }

  setCode(id, code) {
    const old = this.modules.get(id);
    if (!old) return;
    const { params } = old;
    const values = Object.fromEntries(params.map((p, k) => [p.name, old.base[k]]));
    const depth = Object.fromEntries(params.map((p, k) => [p.name, old.depth[k]]));
    const { slot, waveSlot } = old;
    this.remove(id);
    if (slot >= 0) this.freeSlots.pop();
    if (waveSlot >= 0) this.freeWaves.pop();
    this.add({ id, type: 'code', code, params: values, depth, data: old.data, slot, waveSlot });
    if (old.file) this.message(id, old.file);
  }

  setLinks(links) {
    this.links = links;
    this.relink();
  }

  setParam(id, name, value) {
    const m = this.modules.get(id);
    if (!m) return;
    const k = m.params.findIndex((p) => p.name === name);
    if (k < 0) return;
    const p = m.params[k];
    const floaty = p.type === undefined && !p.step;
    if (!floaty) {
      m.base[k] = value;
      m.p[k] = value;
      return;
    }
    // knobs glide for 10 ms so turning one never clicks
    const len = Math.max(1, Math.round(this.sr * 0.01));
    const r = this.ramps.find((x) => x.m === m && x.k === k);
    const step = (value - m.base[k]) / len;
    if (r) { r.step = step; r.left = len; r.to = value; }
    else this.ramps.push({ m, k, step, left: len, to: value });
  }

  setDepth(id, name, value) {
    const m = this.modules.get(id);
    if (!m) return;
    const k = m.params.findIndex((p) => p.name === name);
    if (k < 0) return;
    m.depth[k] = value;
    for (const c of m.mods) if (c.param === k) c.scale = (value * c.range) / 10;
  }

  setData(id, data) {
    const m = this.modules.get(id);
    if (!m) return;
    m.data = data;
    m.dsp.onData(data);
  }

  // Rebuild wires and the running order. Cables that close a loop read the value their
  // source wrote one sample ago, exactly like a real loop, only shorter.
  relink() {
    const old = new Map();
    for (const m of this.modules.values()) {
      old.set(m, m.wires);
      m.wires = [];
      m.mods = [];
      m.linked.fill(0);
    }
    const next = new Map([...this.modules.keys()].map((id) => [id, []]));
    for (const l of this.links) {
      const src = this.modules.get(l.from), dst = this.modules.get(l.to);
      if (!src || !dst) continue;
      const from = src.outs.findIndex((p) => p.name === l.fromPort);
      const to = dst.ports.findIndex((p) => p.name === l.toPort);
      if (from < 0 || to < 0) continue;
      dst.linked[to] = 1;
      dst.wires.push({ src, from, to, peak: 0 });
      next.get(l.from).push(l.to);
      const port = dst.ports[to];
      if (port.param) {
        const k = dst.params.findIndex((p) => p.name === port.name);
        const r = paramRange(dst.params[k]);
        const range = r.span ?? r.max - r.min;
        dst.mods.push({ param: k, input: to, range, scale: (dst.depth[k] * range) / 10, min: r.lo ?? r.min, max: r.hi ?? r.max, step: r.step, ui: cvParams(dst.def).indexOf(dst.params[k]) });
      }
    }
    // depth-first postorder, reversed: sources before what they feed
    const seen = new Set(), post = [];
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const n of next.get(id)) visit(n);
      post.push(id);
    };
    for (const id of this.modules.keys()) visit(id);
    this.order = post.reverse().map((id) => this.modules.get(id));
    for (const m of this.modules.values()) {
      this.easeInputs(m, old.get(m));
      m.params.forEach((p, k) => { if (!m.mods.some((c) => c.param === k)) m.p[k] = m.base[k]; });
    }
  }

  // Replugging a cable would jump the input from one voltage to another, and that is a click. An
  // input that changed source carries the gap and bleeds it off; unplugged, it goes to 0 V that way.
  easeInputs(m, wires) {
    for (let k = 0; k < m.i.length; k++) {
      const was = wires.find((w) => w.to === k), now = m.wires.find((w) => w.to === k);
      if (was?.src === now?.src && was?.from === now?.from) continue;
      let target = now ? now.src.o[now.from] : 0;
      if (!(target === target)) target = 0;
      target = Math.max(-RAIL, Math.min(RAIL, target));
      // plugging an R that was following L: what it was putting out is L
      const have = !was && now && m.normal[k] >= 0 ? m.i[m.normal[k]] : m.i[k];
      const gap = have - target;
      m.fades = m.fades?.filter((f) => f.to !== k) ?? null;
      if (!(Math.abs(gap) > 1e-4)) { m.i[k] = target; continue; }
      (m.fades ??= []).push({ to: k, gap, left: this.fadeLength });
    }
    if (m.fades && !m.fades.length) m.fades = null;
  }

  fade(m) {
    const fades = m.fades, I = m.i, linked = m.linked, length = this.fadeLength;
    for (let k = fades.length - 1; k >= 0; k--) {
      const f = fades[k];
      I[f.to] = (linked[f.to] ? I[f.to] : 0) + (f.gap * f.left) / length;
      if (--f.left <= 0) {
        if (!linked[f.to]) I[f.to] = 0;
        fades.splice(k, 1);
      }
    }
    if (!fades.length) m.fades = null;
  }

  // Changes held back for a step of a Clock go in with the block that reaches it, so a pattern or a
  // cable changes on the beat, not whenever the main thread got round to it.
  land(n) {
    while (this.queued.length) {
      const q = this.queued[0], c = this.modules.get(q.clock);
      // + 1: rounding must not lose the race. Far ahead means the Clock started over since.
      if (c && this.running && q.step - c.dsp.position() <= STALE && c.dsp.samplesTo(q.step) > n + 1) return;
      this.queued.shift();
      for (const m of q.msgs) this.apply(m);
    }
  }

  // ── running ─────────────────────────────────────────────
  process(outL, outR, n, inL, inR) {
    if (this.queued.length) this.land(n);
    const order = this.order, count = order.length, ramps = this.ramps;
    let peakL = 0, peakR = 0;
    for (let s = 0; s < n; s++) {
      if (inL !== undefined) { this.inL = inL[s]; this.inR = inR[s]; }
      for (let r = ramps.length - 1; r >= 0; r--) {
        const ramp = ramps[r], m = ramp.m, k = ramp.k;
        if (--ramp.left <= 0) { m.base[k] = ramp.to; ramps.splice(r, 1); }
        else m.base[k] += ramp.step;
        m.p[k] = m.base[k];
      }
      for (let j = 0; j < count; j++) {
        const m = order[j], I = m.i, P = m.p, wires = m.wires, mods = m.mods;
        for (let w = 0; w < wires.length; w++) {
          const c = wires[w];
          let v = c.src.o[c.from];
          if (!(v === v)) v = 0;   // NaN on a cable would poison everything downstream
          if (v > RAIL) v = RAIL; else if (v < -RAIL) v = -RAIL;
          I[c.to] = v;
          if (v < 0) v = -v;
          if (v > c.peak) c.peak = v;
        }
        if (m.fades !== null) this.fade(m);
        for (let q = 0; q < mods.length; q++) {
          const c = mods[q];
          let v = m.base[c.param] + I[c.input] * c.scale;
          if (c.step) v = Math.round(v / c.step) * c.step;
          if (v < c.min) v = c.min; else if (v > c.max) v = c.max;
          P[c.param] = v;
        }
        m.dsp.tick(I, m.o, P);
      }
      this.samples++;
      const master = this.master;
      let L = 0, R = 0;
      if (master !== null) { L = master.o[0]; R = master.o[1]; }
      if (!(L === L)) L = 0;
      if (!(R === R)) R = 0;
      outL[s] = L;
      outR[s] = R;
      if (L < 0) L = -L;
      if (R < 0) R = -R;
      if (L > peakL) peakL = L;
      if (R > peakR) peakR = R;
    }
    this.report(peakL, peakR);
  }

  // Once per block: what the wall shows, and repairing anything that has gone non-finite.
  report(peakL, peakR) {
    const T = this.telemetry;
    T[1] = peakL;
    T[2] = peakR;
    T[4] = this.running ? 1 : 0;
    for (let j = 0; j < this.order.length; j++) {
      const m = this.order[j], ui = m.ui;
      if (m.dsp.errorText) {
        this.onError?.(m.id, m.dsp.errorText);
        m.dsp.errorText = null;
      }
      if (m.dsp.outgoing?.length) {
        this.onMidi?.(m.id, m.dsp.outgoing);
        m.dsp.outgoing = [];
      }
      for (let w = 0; w < m.wires.length; w++) {
        const c = m.wires[w];
        c.src.ui[UI_OUTS + c.from] = c.peak;
        c.peak = 0;
      }
      for (let q = 0; q < m.mods.length; q++) {
        const c = m.mods[q];
        ui[UI_PARAMS + c.ui] = m.p[c.param];
      }
      for (let k = 0; k < m.o.length; k++) {
        if (!Number.isFinite(m.o[k])) {
          // recompiling live code every block would only hide the bug, and stutter
          if (m.def.type === 'code') {
            if (!m.warned) this.onError?.(m.id, 'its output is not a number');
            m.warned = true;
          } else m.fresh();
          m.o.fill(0);
          break;
        }
      }
    }
  }
}
