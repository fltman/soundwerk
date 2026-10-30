// The main thread and the engine staying in step: the Host talks to a real Rack, as it does to
// the worklet. Each of these was a real bug that an independent review found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/rack/graph.js';
import { Host } from '../src/engine/host.js';
import { Rack, TEL, telemetrySize } from '../src/engine/rack.js';
import { parseHeader, forkSource, compileCode } from '../src/engine/code.js';
import { getDef } from '../src/modules/index.js';
import { renderModule, peak } from './lib/dsp.mjs';
import { dropAt, widthOf } from '../src/rack/place.js';
import { WALL_HP } from '../src/rack/place.js';

function connected() {
  const graph = new Graph();
  const host = new Host(graph);
  const rack = new Rack({ sampleRate: 48000, telemetry: host.telemetry });
  host.node = { port: { postMessage: (m) => rack.apply(m) } };
  return { graph, host, rack };
}
const run = (rack, blocks = 20) => {
  const L = new Float32Array(128), R = new Float32Array(128);
  let top = 0;
  for (let k = 0; k < blocks; k++) { rack.process(L, R, 128); top = Math.max(top, peak(L)); }
  return top;
};

test('undo puts a CV depth back in the engine, not just on the panel', () => {
  const { graph, rack } = connected();
  const lfo = graph.addNode('lfo'), v = graph.addNode('vco');
  graph.connect(lfo.id, 'bi', v.id, 'pw');
  graph.commit();
  graph.setDepth(v.id, 'pw', 1);
  graph.commit();
  graph.undo();
  const m = rack.modules.get(v.id);
  assert.equal(m.depth[m.params.findIndex((p) => p.name === 'pw')], 0.5);
  assert.ok(Math.abs(m.mods[0].scale - (0.5 * 0.9) / 10) < 1e-9);
});

test('a screen too many stays blank, and the wall keeps playing', () => {
  const { graph, rack } = connected();
  const osc = graph.addNode('vco'), out = graph.addNode('master');
  graph.connect(osc.id, 'saw', out.id, 'l');
  for (let k = 0; k < TEL.WAVES + 2; k++) graph.addNode('scope');
  assert.ok(run(rack) > 0.1, 'still sound');
});

test('a forked sequencer keeps its pattern and its file when its source changes', () => {
  const { graph, rack } = connected();
  const def = getDef('bassline');
  const data = { steps: Array.from({ length: 16 }, () => ({ n: 12, g: 1, a: 0, s: 0 })) };
  const n = graph.addNode('code', 0, 0, { code: forkSource(def), data });
  graph.setCode(n.id, `// a new comment\n${n.code}`);
  assert.equal(rack.modules.get(n.id).data, data);
});

test('nothing that is not a number reaches a cable: one bad module stays one bad module', () => {
  const { graph, rack } = connected();
  const bad = graph.addNode('code', 0, 0, { code: '// out out "OUT"\nfunction tick(i, o) { o[0] = NaN; }' });
  const verb = graph.addNode('reverb'), vu = graph.addNode('vu'), out = graph.addNode('master');
  graph.connect(bad.id, 'out', verb.id, 'inL');
  graph.connect(bad.id, 'out', vu.id, 'l');
  graph.connect(verb.id, 'outL', out.id, 'l');
  const before = rack.modules.get(verb.id).dsp;
  const errors = [];
  rack.onError = (id, text) => errors.push(text);
  run(rack, 30);
  assert.equal(rack.modules.get(verb.id).dsp, before, 'the reverb was left alone');
  assert.ok(Number.isFinite(rack.modules.get(vu.id).dsp.l));
  assert.equal(errors.length, 1, 'the user hears about it once');
});

test('a rebuilt module keeps its file', () => {
  const r = new Rack({ sampleRate: 48000 });
  r.apply({ t: 'add', id: 's', type: 'sampler' });
  const L = new Float32Array(1000).fill(0.5);
  r.apply({ t: 'msg', id: 's', msg: { kind: 'buffer', L, sr: 48000 } });
  r.modules.get('s').fresh();
  assert.equal(r.modules.get('s').dsp.L, L);
  r.apply({ t: 'msg', id: 's', msg: { kind: 'clear' } });
  r.modules.get('s').fresh();
  assert.equal(r.modules.get('s').dsp.L, null);
});

test('forget() really starts over: the next sync rebuilds every module, so clocks fire their reset', () => {
  const { graph, host, rack } = connected();
  const c = graph.addNode('clock');
  const first = rack.modules.get(c.id).dsp;
  host.forget();
  assert.equal(rack.modules.size, 0);
  host.sync();
  assert.notEqual(rack.modules.get(c.id).dsp, first);
});

test('undoing across a whole-patch load rebuilds, so a clock restarts and fires its reset', () => {
  const { graph, rack } = connected();
  const c = graph.addNode('clock');
  graph.commit();
  const first = rack.modules.get(c.id).dsp;
  const next = graph.toJSON();
  next.nodes[0].params.swing = 0.6;   // the patch being loaded differs from the one before it
  graph.load(next);
  graph.commit(true);
  graph.setParam(c.id, 'bpm', 120);
  graph.commit();
  graph.undo();
  assert.equal(rack.modules.get(c.id).dsp, first, 'an ordinary undo leaves the clock running');
  graph.undo();
  assert.notEqual(rack.modules.get(c.id).dsp, first, 'going back across the load rebuilds it');
});

test('a fork keeps the reach of its cv jacks', () => {
  const fork = compileCode(forkSource(getDef('acid'))).def;
  const p = fork.params.find((q) => q.name === 'cutoff');
  assert.deepEqual([p.cvSpan, p.cvMin, p.cvMax], [10, -2, 5]);
});

test('only a module with a screen gets screen memory', () => {
  const { graph, rack } = connected();
  const v = graph.addNode('vco');
  assert.equal(rack.modules.get(v.id).wave, null);
});

test('a removed module frees its audio, and a new one on the same id does not inherit it', () => {
  const { graph, host } = connected();
  const s = graph.addNode('sampler');
  graph.setData(s.id, { file: 'a.wav', hash: 'aaa' });
  host.setBuffer(s.id, { L: new Float32Array(10), sr: 48000, name: 'a.wav', hash: 'aaa' });
  graph.removeNode(s.id);
  assert.equal(host.buffers.size, 0);
});

test('comments inside the code are not jacks', () => {
  const h = parseHeader('// in a "A"\n// out b "B"\nfunction tick(i, o) {\n  // in the feedback path\n  // out of range\n  o[0] = i[0];\n}');
  assert.deepEqual(h.inputs.map((p) => p.name), ['a']);
  assert.deepEqual(h.outputs.map((p) => p.name), ['b']);
  assert.ok(compileCode('// wave\nfunction tick() {}').def.wave);
});

test('a module cannot be dropped off the end of the rail, nor pushed off it', () => {
  const g = new Graph();
  const a = g.addNode('scope', 0, 0);
  dropAt(g, a, 0, 9999);
  assert.equal(a.hp + widthOf(g, a), WALL_HP);
  const b = g.addNode('scope', 0, 0);
  dropAt(g, b, 0, WALL_HP - widthOf(g, b));
  assert.ok(a.row === 1 || a.hp + widthOf(g, a) <= b.hp, `${a.row}:${a.hp}`);
});

test('telemetry stays the size the engine and the host agreed on', () => {
  assert.equal(new Host(new Graph()).telemetry.length, telemetrySize());
});
void renderModule;
