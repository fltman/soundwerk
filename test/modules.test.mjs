// The checks every module on the wall has to pass, whatever it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, getDef, inputPorts, outputPorts, paramRange } from '../src/modules/index.js';
import { compileCode, forkSource } from '../src/engine/code.js';
import { layoutPanel, PANEL_H } from '../src/wall/layout.js';
import { renderModule, rms } from './lib/dsp.mjs';

// something plausible on every jack: a saw on audio (a different note per jack), a clock on
// gates, a slow sweep on CV. 24 Hz gets a sequencer through every step in the render.
function stimulus(def) {
  const inputs = {};
  inputPorts(def).forEach((p, k) => {
    if (p.param) return;
    if (p.name === 'rst') inputs[p.name] = (t) => (t < 0.01 ? 10 : 0);
    else if (p.kind === 'gate') inputs[p.name] = (t) => ((t * 24 + k * 0.13) % 1 < 0.5 ? 10 : 0);
    else if (p.kind === 'pitch') inputs[p.name] = (t) => Math.floor((t * 6) % 4) * 0.25 - 0.5;
    else if (p.kind === 'cv') inputs[p.name] = (t) => 2.5 + 2.5 * Math.sin(2 * Math.PI * 1.5 * t);
    else inputs[p.name] = (t) => 8 * (((t * 110 * (k + 1)) % 1) - 0.5);
  });
  return inputs;
}

// modules that need more than cables to make a sound: a file in the deck, a note on the keyboard
const buffer = (length) => Float32Array.from({ length }, (_, n) => 0.8 * Math.sin(n * 0.03) * Math.sin(n * 0.0007 + 0.5));
const SETUP = {
  deck: (m) => m.onMessage({ kind: 'buffer', L: buffer(48000), sr: 48000 }),
  sampler: (m) => m.onMessage({ kind: 'buffer', L: buffer(1500), sr: 48000 }),
  midi: (m) => {
    m.onMessage({ kind: 'midi', data: [0x90, 64, 100] });
    m.onMessage({ kind: 'midi', data: [0x90, 60, 100] });
    m.onMessage({ kind: 'midi', data: [0xe0, 0, 127] });
  },
};
const render = (def, opts) => renderModule(def.type, { data: def.defaultData?.(), setup: SETUP[def.type], ...opts });

const digest = (r, def) => {
  let h = 0;
  for (const o of outputPorts(def)) { const x = r.out[o.name]; for (let i = 0; i < x.length; i += 7) h += Math.abs(x[i]); }
  for (let k = 0; k < 64; k++) h += Math.abs(r.ui[k]) * 3;
  for (let k = 0; k < 256; k++) h += Math.abs(r.wave[k]);
  return h;
};
const outputsDiffer = (a, b, def) => {
  for (const o of outputPorts(def)) {
    const x = a.out[o.name], y = b.out[o.name];
    let d = 0;
    for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i]));
    if (d > 1e-3) return true;
  }
  for (let k = 0; k < 64; k++) if (Math.abs(a.ui[k] - b.ui[k]) > 1e-4) return true;
  return false;
};

test('the registry is coherent', () => {
  const types = MODULES.map((d) => d.type);
  assert.equal(new Set(types).size, types.length, 'duplicate type');
  for (const d of MODULES) {
    const names = [...(d.inputs ?? []), ...(d.outputs ?? []), ...(d.params ?? [])].map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${d.type}: a name is used twice`);
    assert.ok(d.title && d.description && d.category, `${d.type}: missing title, description or category`);
    for (const p of d.params ?? []) {
      const r = paramRange(p);
      assert.ok(r.def >= r.min && r.def <= r.max, `${d.type}.${p.name}: default outside its range`);
    }
  }
});

// ONLY=filter,kick narrows the per-module checks to some categories or types
const only = process.env.ONLY?.split(',');
const chosen = only ? MODULES.filter((d) => only.includes(d.category) || only.includes(d.type)) : MODULES;

for (const def of chosen) {
  test(`${def.type}: survives defaults and every extreme`, () => {
    const check = (r, what) => {
      for (const o of outputPorts(def)) {
        const x = r.out[o.name];
        for (let i = 0; i < x.length; i++) assert.ok(Number.isFinite(x[i]), `${def.type}.${o.name} not finite at ${i}, ${what}`);
      }
    };
    check(render(def, { seconds: 0.3, inputs: stimulus(def) }), 'defaults');
    for (const sr of [22050, 48000, 96000]) {
      let seed = 1;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let round = 0; round < 6; round++) {
        const params = {};
        for (const p of def.params ?? []) {
          const r = paramRange(p);
          const v = round === 0 ? r.min : round === 1 ? r.max : r.min + rnd() * (r.max - r.min);
          params[p.name] = r.step ? Math.round(v / r.step) * r.step : v;
        }
        // full-scale garbage on every jack, including sudden jumps between the rails
        const inputs = {};
        let held = 0;
        for (const port of inputPorts(def)) {
          const bias = round === 0 ? 12 : round === 1 ? -12 : 0;
          inputs[port.name] = (t, n) => { if (n % 11 === 0) held = rnd() * 24 - 12; return bias || held; };
        }
        check(render(def, { params, inputs, seconds: 0.08, sr }), `fuzz sr=${sr} round=${round} ${JSON.stringify(params)}`);
      }
    }
  });

  test(`${def.type}: no dead knobs`, () => {
    const seconds = 1;
    // a knob is alive if the middle or either end makes a difference, patched or with no cables
    // at all (a clocked LFO ignores RATE, and it's right to)
    for (const p of def.params ?? []) {
      if (p.display || p.type === 'button') continue;
      const r = paramRange(p);
      const mid = r.step ? Math.round((r.min + r.max) / 2 / r.step) * r.step : (r.min + r.max) / 2;
      const alive = [stimulus(def), {}].some((inputs) => {
        // `needs`: a knob that only acts with another one turned, as RES on a flat DJ filter
        const [a, b, c] = [r.min, r.max, mid].map((v) => render(def, { seconds, inputs, params: { ...p.needs, [p.name]: v } }));
        return outputsDiffer(a, b, def) || outputsDiffer(a, c, def);
      });
      assert.ok(alive, `${def.type}.${p.name}: nothing changes between ${r.min} and ${r.max}`);
    }
  });

  test(`${def.type}: forks into a Code module that behaves identically`, () => {
    const code = forkSource(def);
    const fork = compileCode(code).def;
    const opts = { seconds: 0.1, inputs: stimulus(def) };
    const a = render(def, opts);
    const b = render(def, { ...opts, def: fork, setup: (m) => { if (SETUP[def.type]) { m.adoptLater = SETUP[def.type]; } } });
    for (const o of outputPorts(def)) {
      const x = a.out[o.name], y = b.out[o.name];
      for (let i = 0; i < x.length; i++) assert.equal(y[i], x[i], `${def.type}.${o.name} differs at sample ${i}`);
    }
  });

  test(`${def.type}: fits on a panel, and stays under the time budget`, () => {
    const panel = layoutPanel(def);
    for (const it of panel.items) {
      assert.ok(it.x >= 0 && it.x + it.w <= panel.w + 0.01, `${it.name ?? it.ui} runs off the side`);
      assert.ok(it.y >= 0 && it.y + it.h <= PANEL_H, `${it.name ?? it.ui} runs off the panel`);
    }
    // warm up, then time 100 ms of audio
    const inputs = stimulus(def);
    render(def, { seconds: 0.5, inputs });
    const t0 = performance.now();
    render(def, { seconds: 0.5, inputs });
    const ns = ((performance.now() - t0) * 1e6) / (0.5 * 48000);
    const budget = def.category === 'fx' ? 6000 : 3000; // harness overhead included
    assert.ok(ns < budget, `${def.type}: ${ns.toFixed(0)} ns per sample`);
    def.timedNs = ns;
  });
}

test('time per module, slowest first', { skip: !process.env.TIMES }, () => {
  const rows = chosen.map((d) => [d.type, Math.round(d.timedNs)]).sort((a, b) => b[1] - a[1]);
  console.table(rows.slice(0, 20));
});

test('getDef finds every module', () => assert.ok(MODULES.every((d) => getDef(d.type) === d)));
