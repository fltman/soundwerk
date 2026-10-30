// The patch model, the rail placement and the text notation for patterns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/rack/graph.js';
import { dropAt, findGap, widthOf } from '../src/rack/place.js';
import { parseNotes, formatNotes, parseRows, formatRows, noteToN } from '../src/rack/patterns.js';
import { Rack } from '../src/engine/rack.js';

test('anything patches into anything, loops included, and an input takes one cable', () => {
  const g = new Graph();
  const a = g.addNode('vco'), b = g.addNode('vca');
  assert.ok(g.connect(a.id, 'saw', b.id, 'in').ok);
  assert.ok(g.connect(b.id, 'out', a.id, 'fm').ok, 'a loop is fine');
  assert.ok(g.connect(a.id, 'pulse', b.id, 'in').ok);
  assert.equal(g.links.size, 2, 'the second cable replaced the first');
  assert.equal(g.connect(a.id, 'nope', b.id, 'in').ok, false);
});

test('undo and redo walk whole-patch snapshots', () => {
  const g = new Graph();
  const n = g.addNode('vco');
  g.commit();
  g.setParam(n.id, 'tune', 7);
  g.commit();
  g.undo();
  assert.equal(g.nodes.get(n.id).params.tune, 0);
  g.redo();
  assert.equal(g.nodes.get(n.id).params.tune, 7);
});

test('a patch survives a trip through JSON, sequencer data included', () => {
  const g = new Graph();
  const a = g.addNode('bassline', 1, 4), b = g.addNode('acid', 1, 40);
  g.connect(a.id, 'pitch', b.id, 'pitch');
  g.setData(a.id, parseNotes('C3 D#3! - G2~'));
  const h = new Graph();
  h.load(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(h.nodes.size, 2);
  assert.equal(h.links.size, 1);
  assert.equal(formatNotes(h.nodes.get(a.id).data), formatNotes(g.nodes.get(a.id).data));
  assert.equal(h.nodes.get(a.id).row, 1);
  const c = h.addNode('vco');
  assert.ok(!g.nodes.has(c.id) || c.id !== a.id, 'new ids don’t collide');
});

test('placement: gaps are found, and a drop pushes neighbours along the rail', () => {
  const g = new Graph();
  const a = g.addNode('vco', 0, 0), b = g.addNode('vco', 0, 0), c = g.addNode('vco', 0, 0);
  const w = widthOf(g, a);
  g.moveNode(b.id, 0, w);
  g.moveNode(c.id, 0, w * 2);
  const gap = findGap(g, 8);
  assert.equal(gap.row, 0);
  assert.equal(gap.hp, w * 3);
  const d = g.addNode('vco', 3, 0);
  dropAt(g, d, 0, w);
  assert.equal(g.nodes.get(d.id).hp, w);
  assert.equal(g.nodes.get(b.id).hp, w * 2);
  assert.equal(g.nodes.get(c.id).hp, w * 3);
  assert.equal(g.nodes.get(a.id).hp, 0);
});

test('note text: names, accents, slides, rests, and a clear error otherwise', () => {
  assert.equal(noteToN('C2'), 0);
  assert.equal(noteToN('Eb3'), 15);
  assert.equal(noteToN('C4'), 24);
  assert.throws(() => noteToN('H2'));
  assert.throws(() => noteToN('C7'));
  const d = parseNotes('C3! - D#3~');
  assert.deepEqual(d.steps[0], { n: 12, g: 1, a: 1, s: 0 });
  assert.equal(d.steps[1].g, 0);
  assert.equal(d.steps[2].s, 1);
  assert.equal(d.steps.length, 16);
  assert.equal(formatNotes(d).split(' ').slice(0, 3).join(' '), 'C3! - D#3~');
});

test('drum text: rows by name, untouched rows kept', () => {
  const a = parseRows({ BD: 'x...x...x...x...' });
  assert.equal(a.rows[0].reduce((s, v) => s + v, 0), 4);
  const b = parseRows({ CH: '..x.' }, a);
  assert.equal(b.rows[0][4], 1, 'BD kept');
  assert.equal(b.rows[2][2], 1);
  assert.match(formatRows(b), /BD x\.\.\.x/);
  assert.throws(() => parseRows({ ZZ: 'x' }));
});

test('the engine: a cable loop runs with one sample of delay and stays on the rails', () => {
  const r = new Rack({ sampleRate: 48000 });
  for (const [id, type] of [['a', 'mixer'], ['b', 'mixer'], ['m', 'master']]) r.apply({ t: 'add', id, type, params: { l1: 1, l2: 1, l3: 1, l4: 1, main: 1.5 } });
  r.apply({ t: 'add', id: 'o', type: 'offset', params: { o1: 1 } });
  r.apply({ t: 'links', links: [
    { from: 'o', fromPort: 'out1', to: 'a', toPort: 'in1' },
    { from: 'a', fromPort: 'out', to: 'b', toPort: 'in1' },
    { from: 'b', fromPort: 'out', to: 'a', toPort: 'in2' },
    { from: 'a', fromPort: 'out', to: 'm', toPort: 'l' },
  ] });
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let k = 0; k < 50; k++) r.process(L, R, 128);
  assert.ok(Number.isFinite(L[127]));
  const a = r.modules.get('a');
  assert.ok(Math.abs(a.i[1]) <= 12, 'the rail clamp holds a runaway loop');
});

test('the engine replaces a module that went non-finite instead of poisoning the wall', () => {
  const r = new Rack({ sampleRate: 48000 });
  r.apply({ t: 'add', id: 'v', type: 'vco' });
  const m = r.modules.get('v'), first = m.dsp;
  m.dsp.tick = (i, o) => { o[0] = NaN; };
  const L = new Float32Array(128), R = new Float32Array(128);
  r.process(L, R, 128);
  assert.notEqual(m.dsp, first);
  r.process(L, R, 128);
  assert.ok(Number.isFinite(m.o[0]));
});

test('undoing a removal brings a module back without touching the others', () => {
  const r = new Rack({ sampleRate: 48000 });
  r.apply({ t: 'add', id: 'a', type: 'vco', params: { tune: 3 } });
  r.apply({ t: 'add', id: 'b', type: 'vco' });
  r.apply({ t: 'remove', id: 'a' });
  r.apply({ t: 'add', id: 'a', type: 'vco', params: { tune: 3 } });
  assert.equal(r.modules.size, 2);
  assert.notEqual(r.modules.get('a').slot, r.modules.get('b').slot);
});
