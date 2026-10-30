// The live DJ: what a rig may contain, how moves come and go, when things land, what it does when
// the network or the mix goes wrong. The engine parts run for real; the model and the host are stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Graph } from '../src/rack/graph.js';
import { Rack } from '../src/engine/rack.js';
import { Host } from '../src/engine/host.js';
import { atHome, checkRig, enterMove, fingerprint, leaveMove } from '../src/dj/rig.js';
import { isDue, pickMove, questionsFor, sectionAt } from '../src/dj/choose.js';
import { auditionRig } from '../src/dj/audition.js';
import { DJ } from '../src/dj/dj.js';
import { PRESETS, EMPTY } from '../src/presets.js';
import { parseRows } from '../src/rack/patterns.js';
import { applyOps } from '../src/ai/ops.js';

const acidWall = () => PRESETS.find((p) => p.name === 'Acid wall').patch();
const nodeOf = (g, type) => [...g.nodes.values()].find((n) => n.type === type);

function small() {
  const g = new Graph();
  const clock = g.addNode('clock').id, vco = g.addNode('vco').id, vca = g.addNode('mixer').id, out = g.addNode('master').id;
  g.connect(vco, 'saw', vca, 'in1');
  g.connect(vca, 'out', out, 'l');
  return { g, clock, vco, vca, out };
}

const rigFor = ({ vco, vca, out }, more = {}) => ({
  brief: 'Play it.',
  arc: [{ name: 'a', bars: 8 }, { name: 'b', bars: 8 }],
  groups: [
    { name: 'level', question: 'How loud?', every: 2, moves: [
      { name: 'home', description: 'as patched', glide: 0, ops: [{ op: 'set', id: vca, params: { l1: 0.5 } }] },
      { name: 'low', description: 'quieter', glide: 2, ops: [{ op: 'set', id: vca, params: { l1: 0.2 } }] },
    ] },
    { name: 'fx', question: 'Which effect?', every: 4, moves: [
      { name: 'clean', description: 'none', ops: [] },
      { name: 'crushed', description: 'bitcrushed', ops: [
        { op: 'add', type: 'crush', ref: 'c', params: { bits: 4 } },
        { op: 'connect', from: vca, from_port: 'out', to: 'c', to_port: 'in' },
        { op: 'connect', from: 'c', from_port: 'out', to: out, to_port: 'l' },
      ] },
    ] },
  ],
  ...more,
});

function installed() {
  const s = small();
  const { rig, problems } = checkRig(s.g, rigFor(s));
  assert.deepEqual(problems, []);
  s.g.setRig(rig);
  return { ...s, rig };
}

// ── rigs ────────────────────────────────────────────────
test('a sound rig passes, and its values are tidied', () => {
  const { rig } = installed();
  assert.equal(rig.groups[1].moves[0].ops.length, 0);
  assert.equal(rig.groups[0].every, 2);
  assert.equal(rig.arc.length, 2);
});

test('a rig without an arc gets one', () => {
  const s = small();
  const { rig, problems } = checkRig(s.g, rigFor(s, { arc: undefined }));
  assert.deepEqual(problems, []);
  assert.ok(rig.arc.length >= 2);
});

test('what a rig may not contain is reported by name', () => {
  const s = small();
  const broken = (change) => {
    const raw = structuredClone(rigFor(s));
    change(raw);
    return checkRig(s.g, raw).problems.join('\n');
  };
  assert.match(broken((r) => { r.brief = ''; }), /brief/);
  assert.match(broken((r) => { r.groups = []; }), /at least one group/);
  assert.match(broken((r) => { r.arc = [{ name: 'x', bars: 0 }]; }), /arc/);
  assert.match(broken((r) => { r.groups[0].moves.pop(); }), /at least 2 moves/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = []; }), /only a home move may be empty/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = [{ op: 'clear' }]; }), /only set, connect/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = [{ op: 'remove', id: s.vco }]; }), /only set, connect/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = [{ op: 'code', id: s.vco, code: 'x' }]; }), /only set, connect/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = [{ op: 'add', type: 'code', ref: 'x' }]; }), /Code module/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = [{ op: 'set', id: 'n999', params: {} }]; }), /no module "n999"/);
  assert.match(broken((r) => { r.groups[0].moves[1].ops = [{ op: 'set', id: s.vca, params: { nothing: 1 } }]; }), /no param "nothing"/);
  assert.match(broken((r) => { r.groups[1].moves[1].ops[2].to_port = 'nope'; }), /no input "nope"/);
  assert.match(broken((r) => { r.groups[0].moves[1].description = ''; }), /description/);
  assert.match(broken((r) => { r.groups[0].moves.push(...Array.from({ length: 30 }, (_, i) => ({ name: `m${i}`, description: 'x', ops: [{ op: 'set', id: s.vca, params: { l1: 0.1 } }] }))); }), /at most 26 moves/);
});

test('a rig needs a Clock', () => {
  const s = small();
  s.g.removeNode(s.clock);
  assert.match(checkRig(s.g, rigFor(s)).problems.join(), /Clock/);
});

test('two groups may not replug the same jack', () => {
  const s = small();
  const raw = rigFor(s);
  raw.groups[0].moves[1].ops = [{ op: 'connect', from: s.vco, from_port: 'saw', to: s.out, to_port: 'l' }];
  assert.match(checkRig(s.g, raw).problems.join(), /both level and fx replug/);
});

test('a move that forgets a knob its neighbours set gets a note, not a refusal', () => {
  const s = small();
  const raw = rigFor(s);
  raw.groups[0].moves[1].ops = [{ op: 'set', id: s.vca, params: { l2: 0.2 } }];
  const { problems, notes } = checkRig(s.g, raw);
  assert.deepEqual(problems, []);
  assert.ok(notes.some((n) => n.includes('level/low leaves')));
});

// ── moves come and go ───────────────────────────────────
test('a move that adds a module takes it away again, and its cable comes back', () => {
  const { g, rig, vca, out } = installed();
  const before = JSON.stringify([...g.links.values()].map((l) => [l.from, l.fromPort, l.to, l.toPort]));
  const crushed = rig.groups[1].moves[1];
  const held = enterMove(g, crushed);
  assert.equal(g.nodes.size, 5);
  assert.equal(held.nodes.length, 1);
  assert.equal(g.linkInto(out, 'l').from, held.nodes[0]);
  assert.equal(g.linkInto(held.nodes[0], 'in').from, vca);
  leaveMove(g, held);
  assert.equal(g.nodes.size, 4);
  assert.equal(JSON.stringify([...g.links.values()].map((l) => [l.from, l.fromPort, l.to, l.toPort])), before);
});

test('leaving a move puts back the depth of the cable it replaced', () => {
  const s = small();
  const lfo = s.g.addNode('lfo').id, filter = s.g.addNode('svf').id;
  s.g.connect(lfo, 'bi', filter, 'cutoff');
  s.g.setDepth(filter, 'cutoff', 0.12);
  const held = enterMove(s.g, { name: 'x', ops: [
    { op: 'add', type: 'lfo', ref: 'l' },
    { op: 'connect', from: 'l', from_port: 'bi', to: filter, to_port: 'cutoff', mod_depth: 0.8 },
  ] });
  assert.equal(s.g.nodes.get(filter).depth.cutoff, 0.8);
  leaveMove(s.g, held);
  assert.equal(s.g.nodes.get(filter).depth.cutoff, 0.12);
  assert.equal(s.g.linkInto(filter, 'cutoff').from, lfo);
});

test('a module the user removed meanwhile does not trip the way back', () => {
  const { g, rig, vca } = installed();
  const held = enterMove(g, rig.groups[1].moves[1]);
  g.removeNode(vca);
  assert.doesNotThrow(() => leaveMove(g, held));
});

test('the fingerprint ignores where modules sit and sees what they play', () => {
  const { g } = installed();
  const a = fingerprint(g.toJSON());
  g.moveNode(nodeOf(g, 'vco').id, 3, 40);
  assert.equal(fingerprint(g.toJSON()), a);
  g.setParam(nodeOf(g, 'mixer').id, 'l1', 0.123);
  assert.notEqual(fingerprint(g.toJSON()), a);
});

test('home takes off whatever moves were on', () => {
  const { g, rig } = installed();
  rig.held = { fx: enterMove(g, rig.groups[1].moves[1]) };
  const home = atHome(g, rig).graph;
  assert.equal(home.nodes.size, 4);
  assert.equal(g.nodes.size, 5);
});

test('a rig and what it holds survive a save and a reload', () => {
  const { g, rig } = installed();
  rig.held = { fx: enterMove(g, rig.groups[1].moves[1]) };
  const g2 = new Graph();
  g2.load(JSON.parse(JSON.stringify(g.toJSON())));
  assert.equal(g2.rig.groups.length, 2);
  leaveMove(g2, g2.rig.held.fx);
  assert.equal(g2.nodes.size, 4);
});

// ── landing on the step ─────────────────────────────────
function clocked(bpm = 120) {
  const rack = new Rack({ sampleRate: 48000 });
  rack.apply({ t: 'add', id: 'c', type: 'clock', params: { bpm } });
  rack.apply({ t: 'add', id: 'm', type: 'master' });
  rack.apply({ t: 'add', id: 'o', type: 'offset', params: { o1: 0 } });
  rack.apply({ t: 'links', links: [] });
  return rack;
}
const blocks = (rack, n) => { const a = new Float32Array(128), b = new Float32Array(128); for (let i = 0; i < n; i++) rack.process(a, b, 128); };

test('the Clock reports its position in 16ths, steady through swing', () => {
  const rack = clocked(120);
  rack.apply({ t: 'param', id: 'c', k: 'swing', v: 0.62 });
  rack.running = true;
  const clock = rack.modules.get('c');
  let last = -1;
  for (let i = 0; i < 2000; i++) {
    blocks(rack, 1);
    const p = clock.ui[3];
    assert.ok(p >= last, `went back from ${last} to ${p}`);
    last = p;
  }
  // 120 BPM is 8 sixteenths a second
  assert.ok(Math.abs(last - (2000 * 128 / 48000) * 8) < 0.01, `at ${last}`);
});

test('a held change lands in the block that reaches its step, and no earlier', () => {
  const rack = clocked(120);
  rack.running = true;
  blocks(rack, 2);
  rack.apply({ t: 'at', clock: 'c', step: 16, msgs: [{ t: 'param', id: 'o', k: 'o1', v: 3 }] });
  const inst = rack.modules.get('o'), k = inst.params.findIndex((p) => p.name === 'o1');
  const clock = rack.modules.get('c');
  let landedAt = null;
  for (let i = 0; i < 40000 && landedAt === null; i++) {
    blocks(rack, 1);
    if (rack.queued.length === 0) landedAt = clock.ui[3];
  }
  const block = (128 / 48000) * 8;   // one block, in 16ths at 120 BPM
  assert.ok(landedAt >= 16 - block && landedAt <= 16 + block * 1.01, `landed at ${landedAt}`);
  blocks(rack, 100);
  assert.ok(Math.abs(inst.base[k] - 3) < 1e-6, `value ${inst.base[k]}`);
});

test('with the wall stopped a held change goes straight in', () => {
  const rack = clocked();
  rack.apply({ t: 'at', clock: 'c', step: 1600, msgs: [{ t: 'param', id: 'o', k: 'o1', v: 2 }] });
  blocks(rack, 1);
  assert.equal(rack.queued.length, 0);
});

test('a held change for a Clock that is gone goes straight in', () => {
  const rack = clocked();
  rack.running = true;
  rack.apply({ t: 'at', clock: 'nobody', step: 1600, msgs: [{ t: 'param', id: 'o', k: 'o1', v: 2 }] });
  blocks(rack, 1);
  assert.equal(rack.queued.length, 0);
});

test('flush puts in what was held, now', () => {
  const rack = clocked();
  rack.running = true;
  blocks(rack, 1);
  rack.apply({ t: 'at', clock: 'c', step: 16, msgs: [{ t: 'remove', id: 'o' }] });
  assert.ok(rack.modules.has('o'));
  rack.apply({ t: 'flush' });
  assert.ok(!rack.modules.has('o'));
  assert.equal(rack.queued.length, 0);
});

test('a change held for a step the Clock has since left behind goes straight in', () => {
  const rack = clocked();
  rack.running = true;
  blocks(rack, 1);
  rack.apply({ t: 'at', clock: 'c', step: 336, msgs: [{ t: 'param', id: 'o', k: 'o1', v: 2 }] });
  rack.apply({ t: 'at', clock: 'c', step: 16, msgs: [{ t: 'param', id: 'o', k: 'o2', v: 3 }] });
  blocks(rack, 1);
  assert.equal(rack.queued.length, 1, 'and it must not hold up what comes after it');
  assert.equal(rack.queued[0].step, 16);
});

// Plays bar 1 with a silent pattern and sends the kick pattern `after` samples past the top of the
// bar's last block, or held for the downbeat. Returns the positions, in 16ths, where BD fired.
function kicksWith(send) {
  const rack = clocked(120);
  const silent = parseRows({ BD: '................' }, new Graph().addNode('drumseq').data);
  rack.apply({ t: 'add', id: 's', type: 'drumseq', data: silent });
  rack.apply({ t: 'add', id: 'e', type: 'decay', params: { a: 0, d: 0.1 } });
  rack.apply({ t: 'links', links: [
    { from: 'c', fromPort: 's16', to: 's', toPort: 'clk' },
    { from: 'c', fromPort: 'rst', to: 's', toPort: 'rst' },
    { from: 's', fromPort: 't1', to: 'e', toPort: 'trig' },
  ] });
  rack.running = true;
  // a trigger is shorter than a block, so hits are read off an envelope it starts
  const env = rack.modules.get('e'), clock = rack.modules.get('c');
  const hits = [];
  let was = 0;
  const pattern = parseRows({ BD: 'x...x...x...x...' }, silent);
  for (let i = 0; i < 16000; i++) {
    send(rack, clock, pattern);
    blocks(rack, 1);
    const now = env.o[0];
    if (now > was + 0.5) hits.push(clock.ui[3]);
    was = now;
  }
  return hits;
}

test('a pattern held for the downbeat is what the downbeat plays', () => {
  let sent = false;
  const hits = kicksWith((rack, clock, pattern) => {
    if (sent || clock.ui[3] < 8) return;
    sent = true;
    rack.apply({ t: 'at', clock: 'c', step: 16, msgs: [{ t: 'data', id: 's', data: pattern }] });
  });
  assert.ok(hits.length >= 2);
  assert.ok(Math.abs(hits[0] - 16) < 0.05, `first kick at ${hits[0]}`);
});

test('without the hold, a change one block late misses that downbeat', () => {
  let sent = false;
  const hits = kicksWith((rack, clock, pattern) => {
    if (sent || clock.ui[3] < 16.03) return;
    sent = true;
    rack.apply({ t: 'data', id: 's', data: pattern });
  });
  assert.ok(hits[0] > 19, `first kick at ${hits[0]}`);
});

// A held tone, a cable pulled or swapped mid-wave. raw is the rack without the easing.
function cutTone(links, raw) {
  const rack = new Rack({ sampleRate: 48000 });
  if (raw) rack.easeInputs = (m) => { m.i.fill(0); m.fades = null; };
  rack.apply({ t: 'add', id: 'a', type: 'vco', params: { tune: 0 } });
  rack.apply({ t: 'add', id: 'b', type: 'offset', params: { o1: -5 } });
  rack.apply({ t: 'add', id: 'm', type: 'master', params: { volume: 0.5 } });
  rack.apply({ t: 'links', links: [{ from: 'a', fromPort: 'sine', to: 'm', toPort: 'l' }] });
  const a = new Float32Array(128), b = new Float32Array(128), out = [];
  for (let i = 0; i < 400; i++) {
    rack.process(a, b, 128);
    out.push(...a);
    // cut on the crest of the wave, where the jump would be largest
    if (i > 200 && i < 400 && rack.links.length === 1 && Math.abs(a[127]) > 0.2 && !rack.cut) { rack.cut = true; rack.apply({ t: 'links', links }); }
  }
  let worst = 0;
  for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
  return { worst, input: rack.modules.get('m').i[0] };
}

test('pulling a cable from a held tone doesn\'t click, and the control does', () => {
  const eased = cutTone([]).worst, raw = cutTone([], true).worst;
  assert.ok(raw > 0.15, `the raw cut only jumped ${raw}`);
  assert.ok(eased < raw / 8, `eased ${eased}, raw ${raw}`);
});

test('swapping to a far-off voltage doesn\'t click either, and the new voltage is there afterwards', () => {
  const links = [{ from: 'b', fromPort: 'out1', to: 'm', toPort: 'l' }];
  const eased = cutTone(links), raw = cutTone(links, true);
  assert.ok(raw.worst > 0.3, `the raw swap only jumped ${raw.worst}`);
  assert.ok(eased.worst < raw.worst / 8, `eased ${eased.worst}, raw ${raw.worst}`);
  assert.equal(eased.input, -5);
});

test('an unplugged input settles at exactly 0 V', () => {
  const rack = clocked();
  rack.apply({ t: 'add', id: 'd', type: 'decay', params: {} });
  rack.apply({ t: 'links', links: [{ from: 'o', fromPort: 'out1', to: 'd', toPort: 'trig' }] });
  rack.apply({ t: 'param', id: 'o', k: 'o1', v: 4 });
  blocks(rack, 20);
  const d = rack.modules.get('d');
  assert.ok(d.i[0] > 1);
  rack.apply({ t: 'links', links: [] });
  blocks(rack, 20);
  assert.equal(d.i[0], 0);
  assert.equal(d.fades, null);
});

test('moving a module around doesn\'t disturb its cables', () => {
  const rack = clocked();
  rack.apply({ t: 'add', id: 'd', type: 'decay', params: {} });
  rack.apply({ t: 'links', links: [{ from: 'o', fromPort: 'out1', to: 'd', toPort: 'trig' }] });
  rack.apply({ t: 'param', id: 'o', k: 'o1', v: 4 });
  blocks(rack, 20);
  rack.apply({ t: 'links', links: [{ from: 'o', fromPort: 'out1', to: 'd', toPort: 'trig' }] });
  assert.equal(rack.modules.get('d').fades, null);
});

// ── choosing ────────────────────────────────────────────
test('the arc goes round and says what comes next', () => {
  const arc = [{ name: 'a', bars: 4 }, { name: 'b', bars: 2 }];
  assert.deepEqual(sectionAt(arc, 0), { name: 'a', into: 0, left: 4, next: 'b' });
  assert.deepEqual(sectionAt(arc, 5), { name: 'b', into: 1, left: 1, next: 'a' });
  assert.deepEqual(sectionAt(arc, 6), { name: 'a', into: 0, left: 4, next: 'b' });
});

test('a group is due on its phrase, and at a section start when it asks to be', () => {
  const g = { every: 8, on_section: true }, h = { every: 8, on_section: false };
  assert.ok(isDue(g, { into: 0 }));
  assert.ok(isDue(g, { into: 8 }));
  assert.ok(!isDue(g, { into: 3 }));
  assert.ok(isDue(h, { into: 16 }));
});

test('questions carry what the render measured', () => {
  const q = questionsFor([{ name: 'x', question: 'Which?', ordered: false, moves: [
    { name: 'a', description: 'dark', test: { measured: 'level −2 dB' } },
    { name: 'b', description: 'bright' },
  ] }]);
  assert.equal(q.x.type, 'choice');
  assert.match(q.x.criteria.a, /Measured against home: level −2 dB/);
  assert.equal(q.x.criteria.b, 'bright');
});

test('the choice is drawn from the odds, and a move held long loses out', () => {
  const group = { every: 8, moves: [{ name: 'a' }, { name: 'b' }] };
  const answer = { probabilities: { a: 0.9, b: 0.1 } };
  assert.equal(pickMove(group, answer, { current: 'b', random: () => 0 }).move.name, 'a');
  assert.equal(pickMove(group, answer, { current: 'a', random: () => 0 }).move, null);
  const leaves = (held) => {
    let n = 0;
    for (let i = 0; i < 1000; i++) if (pickMove(group, answer, { current: 'a', heldBars: held, random: () => i / 1000 }).move) n++;
    return n;
  };
  assert.ok(leaves(64) > leaves(0) + 300);
});

test('an ordered group stays put near where it is', () => {
  const group = { ordered: true, every: 4, moves: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  assert.equal(pickMove(group, { score: 1.3, probabilities: [0, 1, 0] }, { current: 'b' }).move, null);
  assert.equal(pickMove(group, { score: 2, probabilities: [0, 0, 1] }, { current: 'b' }).move.name, 'c');
  assert.equal(pickMove(group, { score: 2.4, probabilities: [0, 0, 1] }, { current: 'a' }).move.name, 'c');
});

// ── a set, against a stand-in host and model ────────────
class FakeHost {
  constructor(graph) {
    this.graph = graph;
    this.running = false;
    this.pos = 0;
    this.cpu = 0.1;
    this.peaks = [0.5, 0.5];
    this.limit = 0;
    this.ats = [];
    this.buffers = new Map();
    this.ear = null;
  }
  async start() {}
  setRunning(on) { this.running = on; }
  ui(id) {
    const out = new Float32Array(8);
    if (this.graph.nodes.get(id)?.type === 'clock') out[3] = this.pos;
    if (this.graph.nodes.get(id)?.type === 'master') out[0] = this.limit;
    return out;
  }
  at(clock, step, fn) { this.ats.push(step); fn(); }
}

const passAll = (rig) => { for (const g of rig.groups) for (const m of g.moves) m.test = { ok: true, measured: '' }; };

async function aSet({ decide, setup } = {}) {
  const s = installed();
  passAll(s.rig);
  const host = new FakeHost(s.g);
  const asks = [];
  const dj = new DJ({
    graph: s.g, host,
    decide: decide ?? (async (body) => {
      asks.push(body);
      const answers = {};
      for (const [name, q] of Object.entries(body.questions)) {
        const keys = Object.keys(q.criteria);
        answers[name] = { probabilities: Object.fromEntries(keys.map((k, i) => [k, i === keys.length - 1 ? 1 : 0])) };
      }
      return { answers, usage: { cost: 0.00004 }, model: 'stand-in' };
    }),
    audit: async () => ({ print: 0, moves: {} }),
    random: () => 0.999,
  });
  s.rig.print = fingerprint(atHome(s.g, s.rig).graph.toJSON());
  setup?.({ ...s, host, dj });
  await dj.start();
  clearInterval(dj.timer);   // this test drives time by hand
  return { ...s, host, dj, asks };
}

const settle = () => new Promise((r) => setImmediate(r));
async function play(dj, host, to, step = 1) {
  while (host.pos < to) {
    host.pos += step;
    dj.tick();
    await settle();
  }
}

test('Start plays the rig from home and asks about the next bar', async () => {
  const { dj, host, asks, rig } = await aSet();
  assert.ok(host.running);
  assert.equal(dj.current(rig.groups[0]), 'home');
  await play(dj, host, 17);   // level decides every 2 bars, so bar 1 asks about bar 2
  assert.equal(asks.length, 1);
  assert.deepEqual(Object.keys(asks[0].questions), ['level']);
  assert.equal(asks[0].state.music.section, 'a');
  assert.equal(asks[0].state.direction, 'Play it.');
  dj.stop();
});

test('an answer lands on the next downbeat, not when it arrives', async () => {
  const { dj, host, rig, g, out } = await aSet();
  await play(dj, host, 16 * 3 + 8);   // fx decides every 4 bars
  assert.equal(dj.current(rig.groups[1]), 'clean');
  assert.equal(dj.pending.get('fx').move.name, 'crushed');
  await play(dj, host, 16 * 4 - 2);
  assert.equal(dj.current(rig.groups[1]), 'crushed');
  assert.equal(host.ats.at(-1), 64);
  assert.equal(nodeOf(g, 'crush').id, g.linkInto(out, 'l').from);
  dj.stop();
});

test('knobs glide over the bars the move asks for, from its downbeat', async () => {
  const { dj, host, g } = await aSet();
  const mixer = nodeOf(g, 'mixer');
  await play(dj, host, 31);          // landed, but its downbeat is at 32
  assert.equal(mixer.params.l1, 0.5);
  await play(dj, host, 32 + 16);
  assert.ok(mixer.params.l1 < 0.5 && mixer.params.l1 > 0.2, `at ${mixer.params.l1}`);
  await play(dj, host, 32 + 32);
  assert.equal(mixer.params.l1, 0.2);
  dj.stop();
});

test('Stop finishes what is gliding', async () => {
  const { dj, host, g } = await aSet();
  await play(dj, host, 36);
  dj.stop();
  assert.equal(nodeOf(g, 'mixer').params.l1, 0.2);
  assert.equal(dj.glides.size, 0);
});

test('a late answer changes nothing', async () => {
  const waiting = [];
  const { dj, host, rig } = await aSet({ decide: () => new Promise((r) => {
    waiting.push(() => r({ answers: { level: { probabilities: { home: 0, low: 1 } } } }));
  }) });
  await play(dj, host, 17);
  assert.equal(waiting.length, 1);
  await play(dj, host, 33);   // the bar it was meant for has begun
  waiting[0]();
  await settle();
  await play(dj, host, 40);
  assert.equal(dj.current(rig.groups[0]), 'home');
  assert.ok(dj.stats.late > 0);
  dj.stop();
});

test('a move that failed its test is never offered, and never played', async () => {
  const { dj, host, asks, rig } = await aSet({ setup: ({ rig: r }) => { r.groups[1].moves[1].test = { ok: false, why: 'silent' }; } });
  await play(dj, host, 64);
  assert.ok(asks.length > 0);
  for (const a of asks) assert.equal(a.questions.fx, undefined);
  assert.equal(dj.current(rig.groups[1]), 'clean');
  dj.stop();
});

test('untested moves sit out until the test is done', async () => {
  const { dj, host, asks } = await aSet({ setup: ({ rig }) => { for (const g of rig.groups) for (const m of g.moves) delete m.test; } });
  await play(dj, host, 64);
  assert.equal(asks.length, 0);
  dj.stop();
});

test('nothing new gets added while the audio thread has no room', async () => {
  const { dj, host, asks, rig } = await aSet({ setup: ({ host: h }) => { h.cpu = 0.8; } });
  await play(dj, host, 64);
  for (const a of asks) assert.equal(a.questions.fx, undefined);
  assert.equal(dj.current(rig.groups[1]), 'clean');
  dj.stop();
});

test('a silent wall goes back home, on a downbeat', async () => {
  const { dj, host, rig } = await aSet();
  await play(dj, host, 70);
  assert.equal(dj.current(rig.groups[1]), 'crushed');
  dj.decide = async () => ({ answers: {} });
  host.peaks = [0, 0];
  await play(dj, host, 150);
  assert.equal(dj.current(rig.groups[1]), 'clean');
  assert.match(dj.message, /silent/);
  assert.equal(dj.log.at(-1).by, 'safety');
  dj.stop();
});

test('a limiter working hard for two bars goes back home', async () => {
  const { dj, host, rig } = await aSet();
  await play(dj, host, 70);
  dj.decide = async () => ({ answers: {} });
  host.limit = 0.9;
  await play(dj, host, 150);
  assert.equal(dj.current(rig.groups[1]), 'clean');
  assert.match(dj.message, /limiter/);
  dj.stop();
});

test('a key or credit problem stops the set; anything else it rides out', async () => {
  const fail = (status) => async () => { throw Object.assign(new Error(`nope ${status}`), { status }); };
  const a = await aSet({ decide: fail(402) });
  await play(a.dj, a.host, 17);
  assert.equal(a.dj.running, false);
  assert.match(a.dj.message, /nope 402/);
  const b = await aSet({ decide: fail(529) });
  await play(b.dj, b.host, 17);
  assert.equal(b.dj.running, true);
  assert.equal(b.dj.stats.fails, 1);
  b.dj.stop();
});

test('an error goes off the screen once answers come back', async () => {
  let broken = true;
  const { dj, host } = await aSet({ decide: async () => {
    if (broken) throw Object.assign(new Error('the server is old'), { status: 500 });
    return { answers: {} };
  } });
  await play(dj, host, 17);
  assert.match(dj.message, /server is old/);
  broken = false;
  await play(dj, host, 49);
  assert.equal(dj.message, '');
  dj.stop();
});

test('after four failures in a row it asks only every eight bars', async () => {
  let calls = 0;
  const { dj, host } = await aSet({ decide: async () => { calls++; throw Object.assign(new Error('x'), { status: 529 }); } });
  await play(dj, host, 16 * 12);
  const soFar = calls;
  await play(dj, host, 16 * 12 + 16 * 3);
  assert.ok(soFar >= 4);
  assert.ok(calls - soFar <= 1, `${calls - soFar} more calls`);
  dj.stop();
});

test('loading another patch stops the set', async () => {
  const { dj, g } = await aSet();
  g.load(EMPTY.patch());
  assert.equal(dj.running, false);
  assert.match(dj.message, /patch changed/);
});

test('clearing the wall drops the rig with it, and stops the set', async () => {
  const { dj, g } = await aSet();
  applyOps(g, [{ op: 'clear' }]);
  assert.equal(g.rig, null);
  assert.equal(dj.running, false);
});

test('removing the Clock stops the set', async () => {
  const { dj, g, clock } = await aSet();
  g.removeNode(clock);
  dj.tick();
  assert.equal(dj.running, false);
});

test('your own pick lands on the next downbeat too', async () => {
  const { dj, host, rig } = await aSet({ decide: async () => ({ answers: {} }) });
  await play(dj, host, 3);
  dj.queue('fx', 'crushed');
  assert.equal(dj.current(rig.groups[1]), 'clean');
  await play(dj, host, 15);
  assert.equal(dj.current(rig.groups[1]), 'crushed');
  assert.equal(dj.log.at(-1).by, 'you');
  dj.stop();
});

test('the model sees the arc, what is on, and for how long', async () => {
  const { dj, host, asks } = await aSet();
  await play(dj, host, 16 * 9);
  const last = asks.at(-1);
  assert.ok(['a', 'b'].includes(last.state.music.section));
  assert.ok(Number.isInteger(last.state.music.bars_left_in_section));
  assert.ok('fx' in last.state.playing_now);
  assert.ok('fx' in last.state.bars_held);
  dj.stop();
});

// ── what the independent review found ───────────────────
// The real Host talking to the real Rack, with the wall left out.
function wired() {
  const g = new Graph();
  const host = new Host(g);
  const rack = new Rack({ sampleRate: 48000, telemetry: host.telemetry });
  host.node = { port: { postMessage: (m) => rack.apply(m) } };
  const clock = g.addNode('clock').id, vco = g.addNode('vco').id, mix = g.addNode('mixer').id, out = g.addNode('master').id;
  g.connect(vco, 'saw', mix, 'in1');
  g.connect(mix, 'out', out, 'l');
  rack.running = true;
  host.running = true;
  blocks(rack, 2);
  return { g, rack, host, clock, vco, mix, out };
}
const inEngine = (rack) => rack.links.map((l) => `${l.from}.${l.fromPort}>${l.to}.${l.toPort}`).sort();
const inGraph = (g) => [...g.links.values()].map((l) => `${l.from}.${l.fromPort}>${l.to}.${l.toPort}`).sort();
const insert = (s) => ({ name: 'on', ops: [
  { op: 'add', type: 'crush', ref: 'c' },
  { op: 'connect', from: s.mix, from_port: 'out', to: 'c', to_port: 'in' },
  { op: 'connect', from: 'c', from_port: 'out', to: s.out, to_port: 'l' },
] });

test('undo while a move is held doesn\'t let it land afterwards', () => {
  const s = wired();
  s.g.commit();
  s.host.at(s.clock, 16, () => enterMove(s.g, insert(s)));
  s.g.commit();
  s.g.undo();
  blocks(s.rack, 2);
  assert.deepEqual(inEngine(s.rack), inGraph(s.g));
  assert.equal(s.rack.queued.length, 0);
  assert.deepEqual([...s.rack.modules.keys()].sort(), [...s.g.nodes.keys()].sort(), 'no ghost modules');
});

test('a cable you plug while a move is held stays plugged when it lands', () => {
  const s = wired();
  const extra = s.g.addNode('vco').id;
  s.host.at(s.clock, 16, () => enterMove(s.g, insert(s)));
  s.g.connect(extra, 'saw', s.mix, 'in2');
  blocks(s.rack, 800);   // well past the downbeat it was held for
  assert.deepEqual(inEngine(s.rack), inGraph(s.g));
  assert.ok(inEngine(s.rack).some((l) => l.endsWith('in2')));
});

test('two groups may each put an effect in their own place', () => {
  const s = small();
  const other = s.g.addNode('vco').id, m2 = s.g.addNode('mixer').id;
  s.g.connect(other, 'saw', m2, 'in1');
  s.g.connect(m2, 'out', s.out, 'r');
  const raw = rigFor(s);
  raw.groups[0] = { name: 'right', question: 'q', moves: [
    { name: 'clean', description: 'd', ops: [] },
    { name: 'crushed', description: 'd', ops: [
      { op: 'add', type: 'phaser', ref: 'p' },
      { op: 'connect', from: m2, from_port: 'out', to: 'p', to_port: 'inL' },
      { op: 'connect', from: 'p', from_port: 'outL', to: s.out, to_port: 'r' },
    ] },
  ] };
  raw.groups[1].moves[1].ops = [
    { op: 'add', type: 'phaser', ref: 'p' },
    { op: 'connect', from: s.vca, from_port: 'out', to: 'p', to_port: 'inL' },
    { op: 'connect', from: 'p', from_port: 'outL', to: s.out, to_port: 'l' },
  ];
  assert.deepEqual(checkRig(s.g, raw).problems, []);
});

test('undo in the middle of a glide leaves the restored patch exactly as it was', async () => {
  const { dj, host, g } = await aSet();
  const mixer = nodeOf(g, 'mixer');
  g.commit();
  const saved = JSON.stringify(g.toJSON());
  await play(dj, host, 40);
  assert.ok(dj.glides.size > 0);
  g.load(JSON.parse(saved));
  assert.equal(dj.running, false);
  assert.equal(g.nodes.get(mixer.id).params.l1, 0.5);
  assert.equal(dj.glides.size, 0);
});

test('a rig the patch moved away from during its test answers, and doesn\'t throw', async () => {
  const s = small();
  const dj = new DJ({ graph: s.g, host: new FakeHost(s.g), decide: async () => ({}), audit: async () => { s.g.load(EMPTY.patch()); return { print: 0, moves: {} }; } });
  const r = await dj.install(rigFor(s));
  assert.equal(r.saved, false);
  assert.match(r.lines[0], /patch changed/);
});

test('a failed test is reported move by move', async () => {
  const s = small();
  const dj = new DJ({ graph: s.g, host: new FakeHost(s.g), decide: async () => ({}), audit: async () => { throw new Error('worker died'); } });
  const r = await dj.install(rigFor(s));
  assert.equal(r.saved, true);
  assert.ok(r.lines.every((l) => l.startsWith('✗')));
  assert.match(r.lines[0], /worker died/);
});

test('a move that cuts wins over a glide still heading for the same knob', async () => {
  const { dj, g, rig, vca } = await aSet({ decide: async () => ({ answers: {} }) });
  const low = rig.groups[0].moves[1], home = rig.groups[0].moves[0];
  dj.fire(rig.groups[0], low, { bars: 4, step: 0 });
  assert.equal(dj.glides.size, 1);
  dj.fire(rig.groups[0], { ...home, ops: [{ op: 'set', id: vca, params: { l1: 0.9 }, depth: {} }] }, { bars: 0 });
  assert.equal(dj.glides.size, 0);
  assert.equal(g.nodes.get(vca).params.l1, 0.9);
  dj.stop();
});

test('a jack that had no depth has none again when its cable comes back', () => {
  const s = small();
  const lfo = s.g.addNode('lfo').id, filter = s.g.addNode('svf').id;
  s.g.connect(lfo, 'bi', filter, 'cutoff');
  const before = JSON.stringify(s.g.nodes.get(filter).depth);
  const held = enterMove(s.g, { name: 'x', ops: [
    { op: 'add', type: 'lfo', ref: 'l' },
    { op: 'connect', from: 'l', from_port: 'bi', to: filter, to_port: 'cutoff', mod_depth: 0.8 },
  ] });
  leaveMove(s.g, held);
  assert.equal(JSON.stringify(s.g.nodes.get(filter).depth), before);
});

test('a patch saved before moves remembered depths still leaves them cleanly', async () => {
  const s = small();
  const lfo = s.g.addNode('lfo').id, filter = s.g.addNode('svf').id;
  s.g.connect(lfo, 'bi', filter, 'cutoff');
  s.g.setDepth(filter, 'cutoff', 0.12);
  const { rig } = checkRig(s.g, rigFor(s));
  s.g.setRig(rig);
  // as it was saved: the depth on each lost cable, no list of its own
  const { depth, lost, ...held } = enterMove(s.g, { name: 'crushed', ops: [
    { op: 'add', type: 'lfo', ref: 'l' },
    { op: 'connect', from: 'l', from_port: 'bi', to: filter, to_port: 'cutoff', mod_depth: 0.8 },
  ] });
  rig.held = { fx: { ...held, lost: lost.map((l) => ({ ...l, depth: 0.12 })) } };
  const saved = JSON.parse(JSON.stringify(s.g.toJSON()));
  const g2 = new Graph();
  g2.load(saved);
  const dj = new DJ({ graph: g2, host: new FakeHost(g2), decide: async () => ({}), audit: async () => ({ print: 0, moves: {} }) });
  const r = await dj.install(rigFor(s));
  assert.equal(r.saved, true);
  assert.equal(g2.linkInto(filter, 'cutoff').from, lfo);
  assert.equal(g2.nodes.get(filter).depth.cutoff, 0.12);
  assert.equal(g2.nodes.size, s.g.nodes.size - 1);
});

test('a jack that was empty loses the depth the move gave it, too', () => {
  const s = small();
  const filter = s.g.addNode('svf').id;
  const held = enterMove(s.g, { name: 'x', ops: [
    { op: 'add', type: 'lfo', ref: 'l' },
    { op: 'connect', from: 'l', from_port: 'bi', to: filter, to_port: 'cutoff', mod_depth: 0.8 },
  ] });
  leaveMove(s.g, held);
  assert.deepEqual(s.g.nodes.get(filter).depth, {});
});

test('your hand on a knob stops the DJ\'s glide on it, and only that one', async () => {
  const { dj, host, g, vca } = await aSet();
  await play(dj, host, 40);
  assert.equal(dj.glides.size, 1);
  g.setParam(vca, 'l2', 1);
  assert.equal(dj.glides.size, 1);
  g.setParam(vca, 'l1', 1);
  assert.equal(dj.glides.size, 0);
  await play(dj, host, 60);
  assert.equal(g.nodes.get(vca).params.l1, 1);
  dj.stop();
});

test('an id is never reused, even across a reload, so a rig can\'t take your module for its own', () => {
  const { g, rig } = installed();
  const held = enterMove(g, rig.groups[1].moves[1]);
  rig.held = { fx: held };
  const theirs = held.nodes[0];
  g.removeNode(theirs);
  const g2 = new Graph();
  g2.load(JSON.parse(JSON.stringify(g.toJSON())));
  const yours = [g2.addNode('vco').id, g2.addNode('vco').id];
  assert.ok(!yours.includes(theirs));
  leaveMove(g2, g2.rig.held.fx);
  assert.ok(yours.every((id) => g2.nodes.has(id)));
});

test('a depth outside the range is clamped before a glide can play it', () => {
  const s = small();
  const filter = s.g.addNode('svf').id;
  const raw = rigFor(s);
  raw.groups[0].moves[1].ops = [{ op: 'set', id: filter, params: {}, depth: { cutoff: 5 } }];
  raw.groups[0].moves[0].ops = [{ op: 'set', id: filter, params: {}, depth: { cutoff: 0.5 } }];
  assert.equal(checkRig(s.g, raw).rig.groups[0].moves[1].ops[0].depth.cutoff, 1);
});

test('a typo in an added module\'s params is a problem, not a silent default', () => {
  const s = small();
  const raw = rigFor(s);
  raw.groups[1].moves[1].ops[0].params = { bitz: 4 };
  assert.match(checkRig(s.g, raw).problems.join(), /no param "bitz"/);
});

test('plugging R carries on from what L was putting there, without a click', () => {
  const rack = new Rack({ sampleRate: 48000 });
  rack.apply({ t: 'add', id: 'a', type: 'vco', params: { tune: 0 } });
  rack.apply({ t: 'add', id: 'm', type: 'master', params: { volume: 0.5 } });
  rack.apply({ t: 'links', links: [{ from: 'a', fromPort: 'sine', to: 'm', toPort: 'l' }] });
  const a = new Float32Array(128), b = new Float32Array(128), right = [];
  for (let i = 0; i < 300; i++) {
    rack.process(a, b, 128);
    right.push(...b);
    if (i === 250) rack.apply({ t: 'links', links: [{ from: 'a', fromPort: 'sine', to: 'm', toPort: 'l' }, { from: 'a', fromPort: 'sine', to: 'm', toPort: 'r' }] });
  }
  let worst = 0;
  for (let i = 1; i < right.length; i++) worst = Math.max(worst, Math.abs(right[i] - right[i - 1]));
  assert.ok(worst < 0.02, `jumped ${worst}`);
});

// ── the audition ────────────────────────────────────────
function audible() {
  const g = new Graph();
  const clock = g.addNode('clock', 0, 0, { params: { bpm: 200 } }).id;
  const vco = g.addNode('vco').id, level = g.addNode('mixer', 0, 0, { params: { l1: 0.5 } }).id, out = g.addNode('master').id;
  g.connect(vco, 'saw', level, 'in1');
  g.connect(level, 'out', out, 'l');
  return { g, clock, vco, level, out };
}
const judged = (s, moves) => {
  const { rig, problems } = checkRig(s.g, { brief: 'x', arc: [{ name: 'a', bars: 4 }], groups: [{ name: 'g', question: 'q', moves: [{ name: 'home', description: 'd', ops: [] }, ...moves] }] });
  assert.deepEqual(problems, []);
  return auditionRig(s.g.toJSON(), rig).moves;
};

test('the audition fails what is silent, too loud, or changes nothing, and passes the rest', () => {
  const s = audible();
  const set = (name, l1) => ({ name, description: 'd', ops: [{ op: 'set', id: s.level, params: { l1 } }] });
  const m = judged(s, [
    set('mute', 0), set('blast', 1.5), set('same', 0.5), set('softer', 0.3),
    { name: 'unplug', description: 'd', ops: [{ op: 'disconnect', to: s.out, to_port: 'l' }] },
  ]);
  assert.equal(m['g/home'].ok, true);
  assert.equal(m['g/mute'].ok, false);
  assert.equal(m['g/mute'].why, 'silent');
  assert.equal(m['g/unplug'].why, 'silent');
  assert.equal(m['g/blast'].ok, false);
  assert.match(m['g/blast'].why, /louder than home/);
  assert.equal(m['g/same'].ok, false);
  assert.match(m['g/same'].why, /no audible difference/);
  assert.equal(m['g/softer'].ok, true);
  assert.match(m['g/softer'].measured, /level −\d dB/);
});

test('a silent home is reported as such', () => {
  const s = audible();
  s.g.setParam(s.level, 'l1', 0);
  const m = judged(s, [{ name: 'on', description: 'd', ops: [{ op: 'set', id: s.level, params: { l1: 0.5 } }] }]);
  assert.equal(m['g/home'].ok, false);
});

test('the Acid wall ships with a rig that fits its patch', () => {
  const json = acidWall();
  const g = new Graph();
  g.load(json);
  const { problems, rig, notes } = checkRig(g, json.rig);
  assert.deepEqual(problems, []);
  assert.equal(rig.groups.length, 5);
  assert.deepEqual(notes, []);
  for (const group of rig.groups) assert.ok(group.moves.length >= 4 && group.moves.length <= 26);
});
