// The assistant's operations: what it can do, and the errors it gets back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/rack/graph.js';
import { applyOps, describePatch } from '../src/ai/ops.js';
import { catalogue, systemPrompt, TOOLS, describeParam } from '../src/ai/catalog.js';
import { MODULES } from '../src/modules/index.js';

const fresh = () => { const g = new Graph(); g.addNode('master'); return g; };

test('builds a small patch with refs in one call, placing modules without overlap', () => {
  const g = fresh();
  const r = applyOps(g, [
    { op: 'add', type: 'clock', ref: 'clk', params: { bpm: 138 } },
    { op: 'add', type: 'bassline', ref: 'seq' },
    { op: 'add', type: 'vco', ref: 'osc' },
    { op: 'connect', from: 'clk', from_port: 's16', to: 'seq', to_port: 'clk' },
    { op: 'connect', from: 'seq', from_port: 'pitch', to: 'osc', to_port: 'pitch' },
    { op: 'pattern', id: 'seq', notes: 'C3 C3! - D#3~ G2' },
  ]);
  assert.deepEqual(r.log.filter((l) => l.startsWith('✗')), []);
  assert.equal(g.nodes.size, 4);
  assert.equal(g.links.size, 2);
  const placed = [...g.nodes.values()].map((n) => `${n.row}:${n.hp}`);
  assert.equal(new Set(placed).size, placed.length);
});

test('errors name what exists, so the model can fix itself', () => {
  const g = fresh();
  const r = applyOps(g, [
    { op: 'add', type: 'vcoo' },
    { op: 'add', type: 'vco', ref: 'v', params: { nonsense: 1 } },
    { op: 'connect', from: 'v', to: 'nowhere' },
    { op: 'connect', from: 'v', from_port: 'saw', to: 'v', to_port: 'nope' },
    { op: 'pattern', id: 'v', notes: 'C3' },
    { op: 'remove', id: [...g.nodes.keys()][0] },
  ]);
  const bad = r.log.filter((l) => l.startsWith('✗') || l.includes('problems'));
  assert.equal(bad.length, 6, r.log.join('\n'));
  assert.match(r.log[1], /has no param "nonsense".*tune/);
  assert.match(r.log[3], /has no input "nope".*pitch/);
  assert.match(r.log[5], /keep the Master/);
});

test('switches take option names, toggles take words, numbers are clamped', () => {
  const g = fresh();
  applyOps(g, [{ op: 'add', type: 'lfo', ref: 'l', params: { shape: 'tri', rate: 7 } }]);
  const n = [...g.nodes.values()].find((x) => x.type === 'lfo');
  assert.equal(n.params.shape, 1);
  assert.equal(n.params.rate, 1);
});

test('a cv cable takes a depth; a plain jack refuses one', () => {
  const g = fresh();
  const r = applyOps(g, [
    { op: 'add', type: 'lfo', ref: 'l' }, { op: 'add', type: 'vco', ref: 'v' },
    { op: 'connect', from: 'l', from_port: 'bi', to: 'v', to_port: 'pw', mod_depth: -0.25 },
    { op: 'connect', from: 'l', from_port: 'bi', to: 'v', to_port: 'fm', mod_depth: 0.5 },
  ]);
  const v = [...g.nodes.values()].find((x) => x.type === 'vco');
  assert.equal(v.depth.pw, -0.25);
  assert.match(r.log[3], /no cv jack/);
});

test('clear keeps the Master; the description shows patterns and depths', () => {
  const g = fresh();
  applyOps(g, [{ op: 'add', type: 'vco' }, { op: 'add', type: 'drumseq', ref: 'd' }, { op: 'pattern', id: 'd', rows: { BD: 'x...x...x...x...' } }]);
  assert.match(describePatch(g), /BD x\.\.\.x\.\.\.x/);
  applyOps(g, [{ op: 'clear' }]);
  assert.equal(g.nodes.size, 1);
  assert.ok(g.masterNode());
});

test('a code module gets checked, and its panel follows its source', () => {
  const g = fresh();
  const bad = applyOps(g, [{ op: 'add', type: 'code', ref: 'c' }, { op: 'code', id: 'c', code: 'function tick(i, o, p) { o[0] = ; }' }]);
  assert.match(bad.log[1], /doesn't compile/);
  const id = [...g.nodes.values()].find((n) => n.type === 'code').id;
  const ok = applyOps(g, [{ op: 'code', id, code: '// in a "A"\n// out b "B"\nfunction tick(i, o) { o[0] = i[0]; }' }]);
  assert.match(ok.log[0], /inputs now: a/);
});

test('the catalogue names every module and reads values in real units', () => {
  const text = catalogue();
  for (const d of MODULES) assert.ok(text.includes(`${d.type} — `), d.type);
  const lfo = MODULES.find((d) => d.type === 'lfo');
  assert.match(describeParam(lfo.params[0]), /Hz/);
  assert.ok(systemPrompt().length > 4000);
  assert.deepEqual(TOOLS.map((t) => t.function.name), ['edit_patch', 'listen', 'split_stems', 'list_plugins', 'load_plugin', 'print_plugin', 'set_rig', 'set_plan', 'edit_plan', 'offer_transition']);
});

test('a ref from an earlier call still works, and the Master is always called master', () => {
  const g = fresh();
  const refs = new Map();
  applyOps(g, [{ op: 'add', type: 'vco', ref: 'osc' }], refs);
  const r = applyOps(g, [{ op: 'connect', from: 'osc', from_port: 'saw', to: 'master', to_port: 'l' }], refs);
  assert.deepEqual(r.log.filter((l) => l.startsWith('✗')), []);
  assert.equal(g.links.size, 1);
  applyOps(g, [{ op: 'clear' }], refs);
  assert.match(applyOps(g, [{ op: 'set', id: 'osc', params: {} }], refs).log[0], /no module "osc"/);
});
