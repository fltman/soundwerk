// The Slicer against tracks whose every hit is known: cuts land where the hits are, slices keep the
// wall's time at any tempo, and a jump between them doesn't click.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analysis/analysis.js';
import { cutTrack, findKey } from '../src/analysis/slices.js';
import { Graph } from '../src/rack/graph.js';
import { applyOps, describePatch } from '../src/ai/ops.js';
import { parseSteps, formatSteps, parsePads } from '../src/rack/patterns.js';
import { renderPatch } from '../src/listen/render.js';
import { auditionRig } from '../src/dj/audition.js';
import { checkRig } from '../src/dj/rig.js';
import { renderModule } from './lib/dsp.mjs';

const SR = 48000;

// a four-on-the-floor loop: kick on the beat, hat between, a quiet pad underneath
function track({ bpm = 125, bars = 24, intro = 0.5 } = {}) {
  const beat = 60 / bpm, n = Math.round((intro + bars * 4 * beat + 1) * SR);
  const x = new Float32Array(n);
  const kicks = [];
  for (let b = 0; b < bars * 4; b++) {
    const t = intro + b * beat;
    kicks.push(t);
    const at = Math.round(t * SR);
    for (let i = 0; i < 0.16 * SR; i++) {
      const s = i / SR;
      x[at + i] += 0.8 * Math.sin(2 * Math.PI * (55 * s + 40 * (1 - Math.exp(-s * 40)) / 40)) * Math.exp(-s * 18);
    }
    const hat = Math.round((t + beat / 2) * SR);
    let seed = 7 + b;
    for (let i = 0; i < 0.04 * SR; i++) {
      seed = (seed * 16807) % 2147483647;
      x[hat + i] += 0.25 * (seed / 1073741823.5 - 1) * Math.exp(-(i / SR) * 90);
    }
  }
  for (let i = 0; i < n; i++) x[i] += 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR);
  return { x, kicks, beat, intro, bars };
}

// one clock of 16ths, as cables: t in seconds, swing moves every other pulse
const clock16 = (bpm, swing = 0.5) => {
  const sixteenth = 15 / bpm;
  return (t) => {
    const pair = Math.floor(t / (2 * sixteenth)), inPair = t - pair * 2 * sixteenth;
    const odd = 2 * sixteenth * swing;
    return inPair < 0.001 || (inPair >= odd && inPair < odd + 0.001) ? 10 : 0;
  };
};

const steps = (text) => parseSteps(text);
// the first sample over a volt: the pad underneath is a quarter of that
const onset = (x, from, to) => {
  for (let n = from; n < to; n++) if (Math.abs(x[n]) > 1) return n;
  return -1;
};

test('bars start on the real downbeats, and a kick stays inside its slice', () => {
  const { x, kicks, beat } = track();
  const cut = cutTrack(analyze(x, SR), x);
  assert.ok(Math.abs(cut.bpm - 125) < 0.5, `bpm ${cut.bpm}`);
  assert.equal(cut.pads.length, 8);
  for (const s of cut.pool) {
    assert.ok(s.end > s.at && s.level > 0.04, JSON.stringify(s));
    if (s.kind !== 'bar') continue;
    assert.equal(s.steps, 16);
    assert.ok(Math.abs(s.end - s.at - 4 * beat) < 0.02, `a bar lasts ${s.end - s.at}`);
    const near = Math.min(...kicks.map((t) => Math.abs(t - s.at)));
    assert.ok(near < 0.006, `bar at ${s.at} is ${(near * 1000).toFixed(1)} ms from a kick`);
    assert.equal(s.kicks.length, 4, `a bar has four kicks: ${s.kicks}`);
  }
});

test('the key of a progression comes back, in a minor key and a major one', () => {
  // the bass sits on the tonic, as it does in a track: without it Am F C G and C F G C are the
  // same notes, and relative keys can't be told apart
  const chords = (root, third) => {
    const n = 20 * SR, x = new Float32Array(n);
    const prog = third === 3 ? [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]] : [[0, 4, 7], [5, 9, 12], [7, 11, 14], [0, 4, 7]];
    for (let i = 0; i < n; i++) {
      const chord = prog[Math.floor(i / (2.5 * SR)) % 4];
      for (const k of chord) x[i] += 0.2 * Math.sin((2 * Math.PI * 220 * 2 ** ((root + k) / 12) * i) / SR);
      x[i] += 0.5 * Math.sin((2 * Math.PI * 110 * 2 ** (root / 12) * i) / SR);
    }
    return x;
  };
  // A is 110 Hz, so root 0 here is A
  assert.equal(findKey(chords(0, 3), SR), 'A minor');
  assert.equal(findKey(chords(5, 3), SR), 'D minor');
  assert.equal(findKey(chords(3, 4), SR), 'C major');
});

function slicerOn(x, { bpm, swing, step = 'a...............', seconds = 6, params = {}, pool, running = true, pitch }) {
  const inputs = { clk: clock16(bpm, swing), rst: (t) => (t < 0.001 ? 10 : 0), ...(pitch === undefined ? {} : { pitch }) };
  return renderModule('slicer', {
    inputs, seconds, params, running,
    data: { pool, pads: [0, 1, 0, 1, 0, 1, 0, 1], steps: steps(step) },
    setup: (m) => m.onMessage({ kind: 'buffer', L: x, sr: SR }),
  });
}

test('the rack can play a sample: a volt on the pitch jack is an octave', () => {
  const hz = 440, x = Float32Array.from({ length: SR * 2 }, (_, i) => 0.8 * Math.sin((2 * Math.PI * hz * i) / SR));
  const pool = [{ at: 0, end: 1.92, steps: 16 }];
  const heard = (pitch, params) => {
    const r = slicerOn(x, { bpm: 125, pool, seconds: 0.5, pitch, params });
    const a = r.l.subarray(4800, 19200);
    let cross = 0;
    for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) cross++;
    return (cross * SR) / a.length;
  };
  assert.ok(Math.abs(heard(undefined) - hz) < 8, `${heard(undefined)} Hz untouched`);
  assert.ok(Math.abs(heard(1) - hz * 2) < 12, `${heard(1)} Hz a volt up`);
  assert.ok(Math.abs(heard(-1, { tune: 12 }) - hz) < 8, 'and tune takes it back');
});

for (const bpm of [125, 131, 119]) {
  test(`a bar cut at 125 keeps time on a wall at ${bpm}`, () => {
    const { x, kicks, beat } = track();
    const pool = [{ kind: 'bar', at: kicks[8], end: kicks[12], steps: 16, kicks: [] }];
    const r = slicerOn(x, { bpm, pool, seconds: (8 * 240) / bpm });
    const bar = Math.round((240 / bpm) * SR), wallBeat = bar / 4;
    let worst = 0;
    // leave the first bar: the rate is only known once the second pulse has come in
    for (let b = 1; b < 7; b++) {
      for (let q = 0; q < 4; q++) {
        const want = b * bar + q * wallBeat;
        const got = onset(r.out.l, Math.round(want - 0.02 * SR), Math.round(want + 0.03 * SR));
        assert.ok(got > 0, `no kick near bar ${b}.${q}`);
        worst = Math.max(worst, Math.abs(got - want));
      }
    }
    assert.ok(worst < 0.002 * SR, `${((worst / SR) * 1000).toFixed(2)} ms off (beat of the file ${beat})`);
  });
}

test('swing on the clock leaves the speed alone', () => {
  const { x, kicks } = track();
  const pool = [{ kind: 'bar', at: kicks[8], end: kicks[12], steps: 16, kicks: [] }];
  const straight = slicerOn(x, { bpm: 125, pool, seconds: 4 });
  const swung = slicerOn(x, { bpm: 125, swing: 0.66, pool, seconds: 4 });
  const bar = Math.round((240 / 125) * SR);
  const a = onset(straight.out.l, bar + 0.25 * bar - 960, bar + 0.25 * bar + 960);
  const b = onset(swung.out.l, bar + 0.25 * bar - 960, bar + 0.25 * bar + 960);
  assert.ok(Math.abs(a - b) < 24, `${a} against ${b}`);
});

test('a slice of a sine, tempo up by a twelfth of an octave, comes out that much higher', () => {
  const x = Float32Array.from({ length: 4 * SR }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / SR));
  const pool = [{ kind: 'bar', at: 0, end: 2, steps: 16 }];
  const bpm = 120 * 2 ** (1 / 12);
  const r = slicerOn(x, { bpm, pool, seconds: 3 });
  let crossings = 0;
  const from = SR, to = 2 * SR;
  for (let n = from; n < to; n++) if (r.out.l[n - 1] < 0 && r.out.l[n] >= 0) crossings++;
  assert.ok(Math.abs(crossings - 440 * 2 ** (1 / 12)) < 2, `${crossings} Hz`);
});

test('cutting into a held tone, and starting on its peak, stays well under a click', () => {
  // a long slice broken off mid-wave by one that starts at the top of the sine: without the fades
  // this jumps by volts, where the wave itself only moves 0.07 V a sample
  const x = Float32Array.from({ length: 6 * SR }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 220 * n) / SR));
  const pool = [{ kind: 'bar', at: 0.1, end: 2.1, steps: 16 }, { kind: 'bar', at: 1.0011, end: 3.0011, steps: 16 }];
  const r = slicerOn(x, { bpm: 120, pool, step: 'a..b...a.b..a..b', seconds: 4 });
  const biggest = (y, from, to) => { let d = 0; for (let n = from + 1; n < to; n++) d = Math.max(d, Math.abs(y[n] - y[n - 1])); return d; };
  const held = biggest(r.out.l, 0.02 * SR, 0.3 * SR);    // the wave's own steepest, for scale
  const jumps = biggest(r.out.l, 0.3 * SR, 4 * SR);
  assert.ok(held > 0.05, 'the control heard a tone');
  assert.ok(jumps < held * 2, `the steepest step is ${jumps.toFixed(3)} against ${held.toFixed(3)} in the held tone`);
});

test('a stopped wall goes quiet and a step with no pad lets the slice ring on', () => {
  const { x, kicks } = track();
  const pool = [{ kind: 'bar', at: kicks[8], end: kicks[12], steps: 16, kicks: [] }];
  const stopped = slicerOn(x, { bpm: 125, pool, running: false, seconds: 1 });
  assert.ok(Math.max(...stopped.out.l.map(Math.abs)) === 0);
  const ring = slicerOn(x, { bpm: 125, pool, step: 'a', params: { length: 16 }, seconds: 2 });
  let tail = 0;
  for (let n = 1.2 * SR; n < 1.8 * SR; n++) tail = Math.max(tail, Math.abs(ring.out.l[n]));
  assert.ok(tail > 0.5, 'the slice carried on past the empty steps');
});

test('the kick jack fires on the kicks of the slice being played', () => {
  const { x, kicks } = track();
  const pool = [{ kind: 'bar', at: kicks[8], end: kicks[12], steps: 16, kicks: [0, 0.48, 0.96, 1.44] }];
  const r = slicerOn(x, { bpm: 125, pool, seconds: 1.92 * 3 + 0.05 });
  let pulses = 0, last = 0;
  for (const v of r.out.kick) { if (v > 2 && last <= 2) pulses++; last = v; }
  assert.equal(pulses, 13, 'four kicks in three bars, and the fourth bar beginning');
});

test('CHOP leaves the pattern alone at zero and is the same every render', () => {
  const { x, kicks } = track();
  const pool = [{ kind: 'beat', at: kicks[8], end: kicks[9], steps: 4 }, { kind: 'beat', at: kicks[9] + 0.24, end: kicks[10] + 0.24, steps: 4 }];
  const a = slicerOn(x, { bpm: 125, pool, step: 'a...a...a...a...', seconds: 3, params: { chop: 0.5 } });
  const b = slicerOn(x, { bpm: 125, pool, step: 'a...a...a...a...', seconds: 3, params: { chop: 0.5 } });
  const c = slicerOn(x, { bpm: 125, pool, step: 'a...a...a...a...', seconds: 3 });
  let same = true, differ = false;
  for (let n = 0; n < a.out.l.length; n++) { if (a.out.l[n] !== b.out.l[n]) same = false; if (a.out.l[n] !== c.out.l[n]) differ = true; }
  assert.ok(same, 'deterministic');
  assert.ok(differ, 'it does something');
});

test('the notation reads, writes and refuses', () => {
  assert.equal(formatSteps({ steps: parseSteps('a...b...a.c.h...') }), 'a...b...a.c.h...');
  assert.throws(() => parseSteps('a...z'), /not a pad/);
  assert.throws(() => parseSteps('a'.repeat(65)), /at most 64/);
  const data = { pool: [{}, {}, {}], pads: [0, 0, 0, 0, 0, 0, 0, 0] };
  assert.deepEqual(parsePads({ b: 2 }, data), [0, 2, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => parsePads({ b: 9 }, data), /no slice 9/);
  assert.throws(() => parsePads({ z: 1 }, data), /no pad/);
});

function wall(x, cut) {
  const g = new Graph();
  const clock = g.addNode('clock', 0, 0, { params: { bpm: 125 } });
  const slicer = g.addNode('slicer', 0, 8, { data: { file: 't.wav', hash: 'x', ...cut } });
  const master = g.addNode('master', 1, 0);
  g.connect(clock.id, 's16', slicer.id, 'clk');
  g.connect(clock.id, 'rst', slicer.id, 'rst');
  g.connect(slicer.id, 'l', master.id, 'l');
  g.connect(slicer.id, 'r', master.id, 'r');
  return { g, slicer, buffers: { [slicer.id]: { L: x, R: x, sr: SR } } };
}

test('the assistant reads the pool and writes pads and steps', () => {
  const { x } = track();
  const cut = cutTrack(analyze(x, SR), x);
  const { g, slicer } = wall(x, cut);
  const text = describePatch(g, { pools: true });
  assert.match(text, /pool of n2/);
  assert.match(text, /#0 bar /);
  assert.doesNotMatch(describePatch(g), /pool of/, 'a tool result stays short');
  const r = applyOps(g, [{ op: 'pattern', id: slicer.id, pads: { b: 5 }, names: { b: 'quiet bar' }, steps: 'a...b...a...b...' }]);
  assert.ok(!r.log[0].startsWith('✗'), r.log[0]);
  assert.equal(g.nodes.get(slicer.id).data.pads[1], 5);
  assert.equal(g.nodes.get(slicer.id).data.names.b, 'quiet bar');
  assert.ok(g.nodes.get(slicer.id).data.pool.length, 'the pattern leaves the pool in place');
  const empty = new Graph();
  const s = empty.addNode('slicer');
  assert.match(applyOps(empty, [{ op: 'pattern', id: s.id, steps: 'a' }]).log[0], /drop an audio file/);
});

test('the DJ hears a slicer: a rig renders from the track, and silently without it', () => {
  const { x } = track();
  const cut = cutTrack(analyze(x, SR), x);
  const { g, slicer, buffers } = wall(x, cut);
  const raw = {
    brief: 'Chop the loop.',
    arc: [{ name: 'groove', bars: 8 }],
    groups: [{
      name: 'chop', question: 'Which chop?', every: 4,
      moves: [
        { name: 'home', description: 'The bar as it is.', ops: [{ op: 'pattern', id: slicer.id, steps: 'a...............' }] },
        { name: 'beats', description: 'Single beats, shuffled.', glide: 0, ops: [{ op: 'pattern', id: slicer.id, steps: 'd...e...d.e.e...' }] },
        { name: 'nothing', description: 'A pad that plays nothing at all, to prove the test can fail.', glide: 0, ops: [{ op: 'pattern', id: slicer.id, steps: '................' }] },
      ],
    }],
  };
  const { rig, problems } = checkRig(g, raw);
  assert.deepEqual(problems, []);
  const heard = auditionRig(g.toJSON(), rig, { buffers });
  assert.equal(heard.moves['chop/home'].ok, true, JSON.stringify(heard.moves['chop/home']));
  assert.equal(heard.moves['chop/beats'].ok, true, JSON.stringify(heard.moves['chop/beats']));
  assert.equal(heard.moves['chop/nothing'].ok, false);
  const deaf = auditionRig(g.toJSON(), rig, {});
  assert.equal(deaf.moves['chop/home'].ok, false, 'without the file the same rig is silent');
});

test('a stem takes the beat and the key of the whole track, and calls its hits notes', () => {
  const { x } = track();
  const a = analyze(x, SR);
  // a beat grid off by exactly one beat shows up in every bar
  const mix = { bpm: a.bpm, beats: a.beats, downbeat: (a.downbeat + 1) % 4, key: 'D minor' };
  const plain = cutTrack(a, x);
  const stem = cutTrack(a, x, { stem: 'bass', mix });
  assert.equal(stem.key, 'D minor');
  assert.equal(stem.stem, 'bass');
  assert.ok(stem.pool.length <= 24, `${stem.pool.length} slices`);
  assert.ok(stem.pool.some((s) => s.kind === 'note'));
  assert.ok(!stem.pool.some((s) => ['kick', 'snare', 'hat'].includes(s.kind)));
  const starts = (c) => new Set(c.pool.filter((s) => s.kind === 'bar').map((s) => s.at));
  const shared = [...starts(stem)].filter((t) => starts(plain).has(t));
  assert.equal(shared.length, 0, 'its bars follow the mix it was given, not its own grid');
});

test('the wall and the Slicer render the same twice', () => {
  const { x } = track({ bars: 8 });
  const cut = cutTrack(analyze(x, SR), x);
  const { g, buffers } = wall(x, cut);
  const a = renderPatch(g.toJSON(), { seconds: 3, buffers }), b = renderPatch(g.toJSON(), { seconds: 3, buffers });
  assert.deepEqual(a.L, b.L);
  assert.ok(a.L.some((v) => Math.abs(v) > 0.05), 'and it is not silence');
});
