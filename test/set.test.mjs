// The Set against tracks made for the test, so every answer is known: where the kicks are, what
// the tempo is, where the drop falls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, sixteenthGrid, steadyBeats, kickOffsets } from '../src/analysis/analysis.js';
import { findSections } from '../src/analysis/sections.js';
import { findKey } from '../src/analysis/slices.js';
import { materialOf, wordsOf } from '../src/analysis/material.js';
import { trackRecord, stemLag } from '../src/set/track.js';
import { eventsOf, gridOf, bpmAt, planOf, cutPiece, sampleData, lengthOf, LOAD_BARS } from '../src/set/score.js';
import { checkPlan, editedPlan, settledPlan } from '../src/set/plan.js';
import { renderStretch } from '../src/set/render.js';
import { Conductor } from '../src/set/conductor.js';
import { Host } from '../src/engine/host.js';
import { Rack } from '../src/engine/rack.js';
import { hearPlan, jobsOf, reportLine } from '../src/set/audition.js';
import { wireSet } from '../src/set/wall.js';
import { describeMark, describePatch } from '../src/ai/ops.js';
import { parseNotes, parseRows } from '../src/rack/patterns.js';
import { renderPatch } from '../src/listen/render.js';
import { Graph } from '../src/rack/graph.js';
import { renderModule } from './lib/dsp.mjs';

const SR = 48000;

// A kick a beat with a bass under it. parts: [bars, 'full' | 'bare' | 'quiet'], bare meaning no kick
function makeTrack(bpm, parts, { offset = 0.2, hz = 55, seed = 1 } = {}) {
  const beat = 60 / bpm, bars = parts.reduce((n, p) => n + p[0], 0);
  const n = Math.round((offset + (bars + 1) * 4 * beat) * SR);
  const L = new Float32Array(n);
  const noise = (i) => Math.sin(i * 12.9898 * seed) * 43758.5453 % 1;
  let bar = 0;
  const kicks = [];
  for (const [length, kind] of parts) {
    const level = kind === 'quiet' ? 0.15 : 0.5;
    for (let b = 0; b < length * 4; b++) {
      const t0 = offset + (bar * 4 + b) * beat, at = Math.round(t0 * SR);
      if (kind === 'full') {
        kicks.push(t0);
        for (let i = 0; i < 0.16 * SR; i++) {
          const t = i / SR;
          L[at + i] += 0.9 * Math.sin(2 * Math.PI * (48 * t + 22 * (1 - Math.exp(-t * 28)))) * Math.exp(-t * 11);
        }
      }
      for (let i = 0; i < beat * SR; i++) {
        const t = i / SR;
        L[at + i] += level * 0.35 * Math.sin(2 * Math.PI * hz * (at + i) / SR);
        L[at + i] += level * 0.25 * Math.sin(2 * Math.PI * hz * 8 * (at + i) / SR) * Math.exp(-t * 6);
        L[at + i] += level * 0.06 * noise(at + i) * Math.exp(-((t * 40) % 10));
      }
    }
    bar += length;
  }
  return { L, R: L, sr: SR, kicks, bars, beat, offset };
}

const record = (audio, file) => {
  const a = analyze(audio.L, SR);
  return { file, hash: file, ...trackRecord(a, audio.L, SR) };
};

// A rack of a kick and a bassline, a Set, and a DJ mixer between them and the Master
function wall(tracks, plan, bpm = 130) {
  const g = new Graph();
  const clock = g.addNode('clock', 0, 0, { params: { bpm } }), set = g.addNode('set', 0, 10), mix = g.addNode('djmix', 1, 0), master = g.addNode('master', 1, 20);
  const beats = g.addNode('drumseq', 2, 0, { data: parseRows({ BD: 'x...x...x...x...' }) }), kick = g.addNode('kick', 2, 30);
  const line = g.addNode('bassline', 3, 0, { data: parseNotes('C2 - C2 - C3 - C2 - C2 - C2 - C3 - C2 -') }), acid = g.addNode('acid', 3, 30);
  const bus = g.addNode('mixer', 4, 0);
  const wire = (...c) => { const r = g.connect(...c); assert.ok(r.ok, `${c}: ${r.reason}`); };
  for (const s of [beats.id, line.id]) wire(clock.id, 's16', s, 'clk');
  wire(clock.id, 's16', set.id, 'clk');
  wire(beats.id, 't1', kick.id, 'trig');
  for (const p of ['pitch', 'gate', 'accent', 'slide']) wire(line.id, p, acid.id, p);
  wire(kick.id, 'out', bus.id, 'in1');
  wire(acid.id, 'out', bus.id, 'in2');
  wire(bus.id, 'out', mix.id, 'aL');
  wire(set.id, 'l', mix.id, 'bL');
  wire(set.id, 'r', mix.id, 'bR');
  wire(mix.id, 'l', master.id, 'l');
  wire(mix.id, 'r', master.id, 'r');
  g.setParam(set.id, 'gain', 0.95);   // where these tracks meet this rack
  g.setData(set.id, { tracks, plan });
  return { json: g.toJSON(), g, ids: { clock: clock.id, set: set.id, mix: mix.id, line: line.id, master: master.id } };
}

const sourceOf = (audios, tracks) => ({
  track: async (t) => { const a = audios[tracks.findIndex((x) => x.file === t.file)]; return a ? { L: a.L, R: a.L, sr: a.sr } : null; },
});

// ── the analysis ────────────────────────────────────────
test('a wandering beat tracker becomes the line the track really holds', () => {
  const truth = Array.from({ length: 200 }, (_, k) => 1 + k * 0.43);
  const shaky = Float64Array.from(truth, (t, k) => t + 0.012 * Math.sin(k * 2.4));
  const fixed = steadyBeats(shaky);
  assert.ok(fixed.every((t, k) => Math.abs(t - truth[k]) < 0.003), 'off the line');
});

test('two tempos stay two tempos, with no jump where they meet', () => {
  const beats = [];
  for (let k = 0; k < 100; k++) beats.push(k * 0.44);
  for (let k = 0; k < 100; k++) beats.push(44 + k * 0.42);
  const fixed = steadyBeats(Float64Array.from(beats));
  assert.ok(Math.abs(fixed[50] - fixed[49] - 0.44) < 0.002);
  assert.ok(Math.abs(fixed[150] - fixed[149] - 0.42) < 0.002);
  const widest = Math.max(...fixed.slice(1).map((t, k) => Math.abs(t - fixed[k] - 0.43)));
  assert.ok(widest < 0.02, `a step of ${widest}`);
});

test('the grid sits on the kicks: found within 2 ms, through a bass and a late tracker', () => {
  const t = makeTrack(128, [[32, 'full']]);
  const a = analyze(t.L, SR);
  const late = [...t.kicks].map((x) => {
    const near = a.beats.reduce((m, b) => (Math.abs(b - x) < Math.abs(m - x) ? b : m), Infinity);
    return Math.abs(near - x);
  }).sort((p, q) => p - q);
  assert.ok(late[late.length >> 1] < 0.002, `${late[late.length >> 1] * 1000} ms`);
});

test('where the kicks start, the grid is on them from the first one: that is where a drop lands', () => {
  const t = makeTrack(130, [[8, 'quiet'], [32, 'full'], [8, 'bare'], [32, 'full']]);
  const grid = sixteenthGrid(Float64Array.from(analyze(t.L, SR).beats), 0);
  for (const bar of [8, 9, 48, 49]) {
    const near = t.kicks.reduce((m, k) => (Math.abs(k - grid[bar * 16]) < Math.abs(m - grid[bar * 16]) ? k : m), Infinity);
    assert.ok(Math.abs(near - grid[bar * 16]) < 0.004, `${((near - grid[bar * 16]) * 1000).toFixed(1)} ms on bar ${bar}`);
  }
});

test('kick offsets read what was planted, and nothing where there is no kick', () => {
  const t = makeTrack(120, [[8, 'full']]);
  const beats = Float64Array.from(t.kicks, (x) => x + 0.03);
  const d = [...kickOffsets(beats, t.L, SR, t.kicks)].filter(Number.isFinite);
  assert.ok(d.length > 28);
  const med = [...d].sort((p, q) => p - q)[d.length >> 1];
  assert.ok(Math.abs(med + 0.03) < 0.002, `${med * 1000} ms`);
  assert.ok(kickOffsets(beats, t.L, SR, []).every(Number.isNaN));
});

const tone = (notes, seconds, hz = SR) => {
  const x = new Float32Array(seconds * hz);
  for (let i = 0; i < x.length; i++) {
    const n = notes[Math.floor((i / hz) * 2) % notes.length];
    for (const m of n) x[i] += 0.12 * Math.sin(2 * Math.PI * 261.63 * 2 ** (m / 12) * (i / hz));
  }
  return x;
};
const CHORDS = [[0, 3, 7, -12], [5, 8, 12, -7], [-5, -2, 2, -17], [0, 3, 7, -12]];    // i iv v i in C minor

test('the key does not depend on the rate of the file', () => {
  for (const hz of [44100, 48000, 22050]) assert.equal(findKey(tone(CHORDS, 24, hz), hz), 'C minor', `${hz} Hz`);
});

test('a song tuned a quarter tone off still has a key, and a transposed one moves with it', () => {
  const up = (n, by) => n.map((c) => c.map((m) => m + by));
  assert.equal(findKey(tone(up(CHORDS, 0.5), 24), SR).split(' ')[1], 'minor');
  assert.equal(findKey(tone(up(CHORDS, 3), 24), SR), 'D# minor');
  assert.equal(findKey(tone(up(CHORDS, -2), 24), SR), 'A# minor');
});

test('the shape of a track: intro, highlight, break, highlight, on the bars it was built on', () => {
  const t = makeTrack(128, [[8, 'quiet'], [16, 'full'], [8, 'bare'], [16, 'full']]);
  const { sections } = findSections(analyze(t.L, SR));
  assert.deepEqual(sections.map((s) => [s.name, s.from]), [['intro', 0], ['peak', 8], ['break', 24], ['peak', 32]]);
});

test('a stem decoded later than its mix is found to the millisecond', () => {
  const t = makeTrack(128, [[16, 'full']]);
  const late = new Float32Array(t.L.length);
  late.set(t.L.subarray(0, t.L.length - 1104), 1104);
  assert.ok(Math.abs(stemLag(t.L, late, SR) - 0.023) < 0.0015);
  assert.ok(Math.abs(stemLag(t.L, t.L, SR)) < 0.0015);
});

// ── the module ──────────────────────────────────────────
const pulses = (bpm, swing = 0.5) => {
  const every = (SR * 15) / bpm;
  return (t, i) => {
    const k = Math.floor(i / every), odd = k % 2 === 1, at = (k + (odd ? (swing - 0.5) * 2 : 0)) * every;
    return i >= at && i < at + 96 ? 10 : 0;
  };
};

const kicksOff = (out, bpm) => {
  const heard = Float32Array.from(out, (v) => v / 5);
  const clock = Float64Array.from({ length: 20 }, (_, k) => ((k + 1) * 4 * Math.ceil((SR * 15) / bpm)) / SR);
  return [...kickOffsets(clock, heard, SR, clock)].filter(Number.isFinite).map(Math.abs).sort((x, y) => x - y);
};

test('the deck plays the track at the clock: its kicks land on the pulses, whatever the tempo', () => {
  const t = makeTrack(128, [[16, 'full']]), r = record(t, 'a'), bpm = 121;
  const off = kicksOff(renderModule('set', {
    seconds: 12,
    inputs: { clk: pulses(bpm) },
    setup: (m) => m.onMessage({ kind: 'buffer', L: t.L, sr: SR, grid: gridOf(r), from: 0 }),
  }).out.l, bpm);
  assert.ok(off.length > 15);
  assert.ok(off.at(-2) < 0.003, `${off.at(-2) * 1000} ms off the beat`);
});

test('swing on the clock does not reach the track: it holds its speed, and the kicks stay on the beat', () => {
  const t = makeTrack(128, [[16, 'full']]), r = record(t, 'a');
  let deck;
  const speeds = [];
  const out = renderModule('set', {
    seconds: 12,
    inputs: {
      clk: (() => { const clk = pulses(128, 0.56); return (x, i) => { if (deck?.on && i % 480 === 0) speeds.push(deck.speed); return clk(x, i); }; })(),
    },
    setup: (m) => { deck = m; m.onMessage({ kind: 'buffer', L: t.L, sr: SR, grid: gridOf(r), from: 0 }); },
  }).out.l;
  const later = speeds.slice(100);
  assert.ok(Math.max(...later) - Math.min(...later) < 0.01, `speed from ${Math.min(...later)} to ${Math.max(...later)}`);
  assert.ok(kicksOff(out, 128).at(-2) < 0.004);
});

test('a roll loops what is playing, and letting go finds the track where it would have been', () => {
  const t = makeTrack(128, [[32, 'full']]), r = record(t, 'a'), grid = gridOf(r);
  let deck, read = 0, g = 0;
  renderModule('set', {
    seconds: 12,
    inputs: { clk: (() => { const clk = pulses(128); return (x, i) => { if (deck && i === 4 * SR) { read = deck.read; g = deck.g; } return clk(x, i); }; })() },
    params: { roll: 3 },
    setup: (m) => { deck = m; m.onMessage({ kind: 'buffer', L: t.L, sr: SR, grid, from: 0 }); },
  });
  assert.ok(g > 16, `the track went on to step ${g}`);
  assert.ok(read < 18, `while the deck kept reading one bar, step ${read} now`);
  deck.advance(0);
  assert.equal(deck.read, deck.g, 'let go, it reads where the track has got to');
  assert.ok(Math.abs(deck.pos / SR - grid[deck.g]) < 1e-9);
});

const sine = (hz, seconds) => Float32Array.from({ length: seconds * SR }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SR));
const rms = (out) => { let e = 0; for (let i = 24000; i < out.length; i++) e += out[i] * out[i]; return Math.sqrt(e / (out.length - 24000)); };

test('the DJ mixer: the fader goes from one side to the other with no dip in power', () => {
  const low = sine(440, 2), high = sine(1000, 2);
  const level = (fade) => rms(renderModule('djmix', { seconds: 2, params: { fade, lows: 0.5 }, inputs: { aL: (t, i) => low[i], bL: (t, i) => high[i] } }).out.l);
  assert.ok(Math.abs(level(0) - level(1)) < 0.005, `${level(0)} against ${level(1)}`);
  assert.ok(Math.abs(level(0.5) - level(0)) < 0.01, `${level(0.5)} in the middle`);
});

test('LOWS takes the bass out of one side and leaves the other alone', () => {
  const bass = sine(55, 2);
  const a = (lows) => rms(renderModule('djmix', { seconds: 2, params: { fade: 0, lows }, inputs: { aL: (t, i) => bass[i] } }).out.l);
  const b = (lows) => rms(renderModule('djmix', { seconds: 2, params: { fade: 1, lows }, inputs: { bL: (t, i) => bass[i] } }).out.l);
  assert.ok(a(1) < a(0) * 0.15, `side A: ${a(1)} against ${a(0)}`);
  assert.ok(b(0) < b(1) * 0.15, `side B: ${b(0)} against ${b(1)}`);
  assert.ok(Math.abs(a(0.5) - a(0)) < 1e-6 && Math.abs(b(0.5) - b(1)) < 1e-6, 'in the middle both keep theirs');
});

// ── plans ───────────────────────────────────────────────
const A = makeTrack(130, [[8, 'quiet'], [32, 'full'], [8, 'bare'], [32, 'full']]);
const B = makeTrack(124, [[8, 'quiet'], [8, 'bare'], [32, 'full'], [8, 'bare'], [16, 'full']], { hz: 62, seed: 2 });
const records = [record(A, 'a'), record(B, 'b')];
const audios = [A, B];
const stemmed = () => records.map((t) => ({ ...t, stems: { id: 'x', lag: 0.003 } }));
const withPlan = (g, plan) => {
  const json = g.toJSON();
  json.nodes.find((n) => n.type === 'set').data = { tracks: stemmed(), plan };
  return json;
};

// Rack for 8 bars, track 0 from bar 8 of its own, rack again, the Clock to the next tempo, track 1.
// The mixer is thrown by hand: enough to give the machinery something to do.
function aPlan(ids, more = {}) {
  const fader = (at, fade, lows, glide = 0) => ({ at, glide, why: 'over', ops: [{ op: 'set', id: ids.mix, params: { fade, lows } }] });
  return {
    brief: 'a test set',
    arc: [{ name: 'groove', bars: 8 }, { name: 'transition', bars: 16 }, { name: 'groove', bars: 16 }, { name: 'transition', bars: 16 }, { name: 'groove', bars: 4 }],
    tracks: [{ track: 0, at: 8, enter: 8, leave: 24 }, { track: 1, at: 40, enter: 16, leave: 32 }],
    moves: [
      { at: 0, glide: 0, why: 'to the tempo of the first', ops: [{ op: 'set', id: ids.clock, params: { bpm: bpmAt(records[0], 8) } }] },
      fader(8, 1, 1), fader(24, 0, 0),
      { at: 24, glide: 8, why: 'on to the next', ops: [{ op: 'set', id: ids.clock, params: { bpm: bpmAt(records[1], 16) } }, { op: 'set', id: ids.line, params: { transpose: 3 } }] },
      fader(40, 1, 1), fader(56, 0, 0),
    ],
    ...more,
  };
}

const planned = (more) => {
  const { g, ids } = wall(records, null);
  const { plan, problems } = checkPlan(g, aPlan(ids, more));
  return { g, ids, plan, problems };
};

test('a plan that follows the rules passes, tidied', () => {
  const { plan, problems } = planned();
  assert.deepEqual(problems, []);
  assert.equal(plan.moves[0].at, 0);
  assert.equal(plan.arc.length, 5);
});

test('the rule a set is built on: one track at a time, with the rack in between', () => {
  const overlap = planned({ tracks: [{ track: 0, at: 8, enter: 8, leave: 24 }, { track: 1, at: 20, enter: 16, leave: 32 }] }).problems;
  assert.ok(overlap.some((p) => /only one track at a time/.test(p)), overlap.join('; '));
  const touching = planned({ tracks: [{ track: 0, at: 8, enter: 8, leave: 24 }, { track: 1, at: 24, enter: 16, leave: 32 }] }).problems;
  assert.ok(touching.some((p) => /rack needs at least/.test(p)), touching.join('; '));
});

test('a plan out of bounds says what is wrong, in words that can be acted on', () => {
  const { ids } = wall(records, null);
  const check = (more) => planned(more).problems.join('; ');
  assert.match(check({ tracks: [{ track: 7, at: 8, enter: 0, leave: 8 }] }), /no track 7/);
  assert.match(check({ tracks: [{ track: 0, at: 8, enter: 0, leave: 999 }] }), /can't leave on 999/);
  assert.match(check({ arc: [{ name: 'x', bars: 8 }], moves: [] }), /past the end of the arc/);
  assert.match(check({ moves: [{ at: 0, ops: [{ op: 'set', id: 'n999', params: { a: 1 } }] }] }), /no module "n999"/);
  assert.match(check({ moves: [{ at: 0, ops: [{ op: 'set', id: ids.mix, params: { nope: 1 } }] }] }), /has no param "nope"/);
  assert.match(check({ moves: [{ at: 0, ops: [{ op: 'clear' }] }] }), /only set, connect/);
  assert.match(check({ moves: [{ at: 0, ops: [{ op: 'add', type: 'delay' }] }] }), /needs an until/);
});

test('a later move can reach what an earlier one added, and not once it has left', () => {
  const add = { at: 4, until: 8, ops: [{ op: 'add', type: 'djfilter', ref: 'sweep' }] };
  assert.deepEqual(planned({ moves: [add, { at: 6, glide: 2, ops: [{ op: 'set', id: 'sweep', params: { filter: 0.5 } }] }] }).problems, []);
  assert.match(planned({ moves: [add, { at: 8, ops: [{ op: 'set', id: 'sweep', params: { filter: 0.5 } }] }] }).problems.join(), /no module "sweep"/);
});

// A Slicer that stays on the wall, on the Clock and into the mixer
function withSlicer(w) {
  const chop = w.g.addNode('slicer', 5, 0), bus = [...w.g.nodes.values()].find((n) => n.type === 'mixer');
  assert.ok(w.g.connect(w.ids.clock, 's16', chop.id, 'clk').ok);
  assert.ok(w.g.connect(chop.id, 'l', bus.id, 'in3').ok);
  return { ...w, chop: chop.id };
}

test('a sample is checked like the rest, and can not play over another track', () => {
  const { g, chop } = withSlicer(wall(stemmed(), null));
  const check = (raw) => checkPlan(g, { ...aPlan(wall(stemmed(), null).ids), ...raw }).problems;
  const move = (op, more = {}) => ({ moves: [{ at: 0, until: 4, ops: [{ op: 'sample', id: chop, track: 0, bar: 20, bars: 1, pieces: 4, ...op }], ...more }] });
  assert.deepEqual(check(move({})), []);
  assert.deepEqual(check(move({ stem: 'vocals', bar: 20.25, bars: 0.5, pieces: 2, reverse: true, tune: -2 })), []);
  assert.match(check(move({ track: 9 })).join(), /no track 9/);
  assert.match(check(move({ pieces: 3 })).join(), /pieces of a sample/);
  assert.match(check(move({ bars: 0.25, pieces: 8 })).join(), /one a 16th/);
  assert.match(check(move({ bar: 999 })).join(), /can't be sampled/);
  assert.match(check(move({ bar: 20.1 })).join(), /starts on a 16th/);
  assert.match(check(move({ steps: 'xyz' })).join(), /not a pad/);
  assert.match(check(move({ stem: 'kazoo' })).join(), /a stem is one of/);
  assert.match(check(move({ id: 'n1' })).join(), /isn't one/);
  assert.match(check(move({}, { until: undefined })).join(), /needs an until/);
  assert.match(check(move({ track: 1 }, { at: 10, until: 12 })).join(), /only one track at a time/);
  const second = { at: 2, until: 6, ops: [{ op: 'sample', id: chop, track: 0, bar: 8, bars: 1, pieces: 1 }] };
  assert.match(check({ moves: [...move({}).moves, second] }).join(), /is holding another sample/);
  assert.deepEqual(check({ moves: [...move({}).moves, { ...second, at: 4, until: 6 }] }), [], 'one after the other is fine');
  assert.deepEqual(check({ moves: [...move({}).moves, { at: 2, ops: [{ op: 'pattern', id: chop, steps: 'a.a.b.b.c.c.d.d.' }] }] }), [], 'a sample can be played differently later on');
  assert.deepEqual(check({ moves: [{ at: 0, until: 4, ops: [{ op: 'add', type: 'slicer', ref: 'spare' }, { op: 'sample', id: 'spare', track: 0, bar: 20, bars: 1, pieces: 1 }] }] }), [], 'it can be on a Slicer the move adds');
  const plain = withSlicer(wall(records, null));
  assert.match(checkPlan(plain.g, { ...aPlan(plain.ids), moves: [{ at: 0, until: 4, ops: [{ op: 'sample', id: plain.chop, track: 0, stem: 'bass', bar: 20, bars: 1, pieces: 1 }] }] }).problems.join(), /never separated/);
});

// ── what there is to sample ─────────────────────────────
test('the map finds a hook and a one-off that were planted, stem by stem', () => {
  // 64 bars at 120: a phrase of 2 bars from bar 8 every 8 bars, a shout on bar 45 alone, and a stem
  // that holds nothing
  const bars = 64, sixteenth = 0.125, sr = 24000, n = Math.round((bars * 16 + 2) * sixteenth * sr), grid = Float64Array.from({ length: bars * 16 + 1 }, (_, k) => k * sixteenth);
  const vocals = new Float32Array(n), empty = new Float32Array(n);
  const note = (x, bar, step, hz, steps, level = 0.4) => {
    const at = Math.round((bar * 16 + step) * sixteenth * sr), m = Math.round(steps * sixteenth * sr);
    for (let i = 0; i < m; i++) x[at + i] += level * Math.sin((2 * Math.PI * hz * i) / sr) * Math.min(1, i / 200, (m - i) / 200);
  };
  for (let b = 8; b + 2 <= bars; b += 8) {
    note(vocals, b, 0, 330, 4); note(vocals, b, 6, 494, 3); note(vocals, b, 12, 392, 2);
    note(vocals, b + 1, 2, 587, 5); note(vocals, b + 1, 10, 262, 4);
  }
  for (const s of [0, 3, 5, 9, 11, 14]) note(vocals, 45, s, 1400 + s * 140, 1, 0.6);
  const m = materialOf({ vocals, bass: empty }, grid, bars, sr);
  assert.equal(m.vocals.map.length, 16);
  assert.equal(m.vocals.map[0], '.', 'nothing sung before the first phrase');
  assert.notEqual(m.vocals.map[2], '.');
  assert.ok(m.vocals.hook, 'there is a hook');
  assert.equal((m.vocals.hook.bar - 8) % 8, 0, `the phrase starts on a bar it was planted, not ${m.vocals.hook.bar}`);
  assert.ok(m.vocals.hook.back.length >= 5, `it was planted 7 times, found ${m.vocals.hook.back.length + 1}`);
  assert.ok(m.vocals.hook.back.every((b) => (b - 8) % 8 === 0), m.vocals.hook.back.join());
  assert.ok(m.vocals.rare.includes(45), `the shout is on bar 45, not ${m.vocals.rare}`);
  assert.equal(m.bass.map, '.'.repeat(16));
  assert.equal(m.bass.hook, null);
  const short = materialOf({ vocals }, grid.subarray(0, 60 * 16 + 9), bars, sr);
  assert.match(short.vocals.map, /^[.\d]{15}$/, 'a track said to have more bars than its grid holds');
});

test('what is sung lands on the 16ths of the track, and a line sung twice is one line', () => {
  const grid = Float64Array.from({ length: 200 }, (_, k) => 0.1 + k * 0.125);
  const lines = wordsOf([
    { start: 2.12, end: 4, text: ' If we crash' },
    { start: 8.1, end: 9, text: ' we laugh' },
    { start: 14.1, end: 16, text: ' if we crash!' },
    { start: 20, end: 21, text: '   ' },
  ], grid);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].bars, [1, 7]);
  assert.equal(lines[1].bars[0], 4);
  assert.equal(lines[0].text, 'If we crash');
  assert.equal(lines[1].long, 1 / 16 + (Math.floor((9 - 0.1) / 0.125) - Math.floor((8.1 - 0.1) / 0.125)) / 16);
});

test('the assistant reads what there is to sample', () => {
  const t = { ...records[0], material: { vocals: { map: '..88', hook: { bar: 8, bars: 2, back: [16, 24] }, rare: [45] } }, words: [{ text: 'hello', bars: [8.25, 16.25], long: 1 }], stems: { id: 'x', lag: 0 } };
  const { g } = wall([t, records[1]], null);
  const text = describePatch(g, { pools: true });
  assert.match(text, /vocals\s+\.\.88; hook bars 8-10, back on 16, 24; once only: bar 45/);
  assert.match(text, /words: 8.25, 16.25 "hello" \(1\)/);
  assert.match(text, /no stems: only the whole mix can be sampled/, 'and what it can not');
});

test('a Set that goes nowhere can not be planned', () => {
  const g = new Graph();
  g.addNode('master');
  const set = g.addNode('set', 0, 10);
  g.setData(set.id, { tracks: records, plan: null });
  wireSet(g, set.id);
  assert.ok(g.linkInto(set.id, 'clk'), 'the Clock it needs is put there');
  const { problems } = checkPlan(g, { brief: 'x', arc: [{ name: 'a', bars: 40 }], tracks: [{ track: 0, at: 0, enter: 0, leave: 16 }], moves: [] });
  assert.ok(problems.some((p) => /go nowhere/.test(p)), problems.join('; '));
});

test('the score: tracks and moves on their bars, and the next track on the deck only once the last has gone', () => {
  const { plan } = planned();
  const { legs, events } = eventsOf(plan);
  assert.deepEqual(legs.map((l) => [l.start, l.end]), [[8 * 16, 24 * 16], [40 * 16, 56 * 16]]);
  const of = (type) => events.filter((e) => e.type === type);
  assert.deepEqual(of('cue').map((e) => e.step), [8 * 16, 40 * 16]);
  assert.deepEqual(of('load').map((e) => e.step), [(24 + LOAD_BARS) * 16]);
  assert.equal(of('move').length, plan.moves.length);
  assert.equal(events.at(-1).type, 'end');
  assert.equal(events.at(-1).step, 60 * 16);
});

test('the assistant reads what the analysis found, bar by bar', () => {
  const { g } = wall(records, null);
  const text = describePatch(g, { pools: true });
  assert.match(text, /track 1: "b", 12\d\.\d BPM/);
  assert.match(text, /peak 8-40 \(level 1, kicks 4, 130\.0 BPM\)/);
});

// ── a set, through the real engine ──────────────────────
const stretch = (plan, g, opts) => renderStretch({ ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) }, { source: sourceOf(audios, records), ...opts });

test('a track starts on its bar, at the Clock, with its kicks on the rack', async () => {
  const { g, plan } = planned();
  const r = await stretch(plan, g, { at: 4 * 16, until: 16 * 16 });
  const start = r.steps.find((s) => s.step === 8 * 16).sample / SR;
  const beat = 60 / bpmAt(records[0], 8);
  const planned4 = Float64Array.from({ length: 8 }, (_, k) => start + k * beat);
  const off = [...kickOffsets(planned4, r.L, SR, planned4)];
  assert.ok(off.every((d) => Math.abs(d) < 0.005), `kicks after the start: ${off.map((d) => (d * 1000).toFixed(1))} ms`);
});

test('the moves turn the rack: the tempo and the key go where the plan says, between the tracks', async () => {
  const { g, ids, plan } = planned();
  const r = await stretch(plan, g, { at: 22 * 16, until: 36 * 16 });
  assert.ok(Math.abs(r.graph.nodes.get(ids.clock).params.bpm - bpmAt(records[1], 16)) < 0.01);
  assert.equal(r.graph.nodes.get(ids.line).params.transpose, 3);
});

test('a track started halfway plays from the right place, and the wall is as the plan would have left it', async () => {
  const { g, ids, plan } = planned();
  const r = await stretch(plan, g, { at: 12 * 16, until: 16 * 16 });
  assert.equal(r.graph.nodes.get(ids.mix).params.fade, 1, 'the fader was thrown on bar 8');
  assert.ok(r.L.some((v) => Math.abs(v) > 0.05));
});

test('what a move adds is gone on its bar, and a stopped set puts the wall back', async () => {
  const { g, ids } = wall(records, null);
  const raw = aPlan(ids);
  raw.moves.push({ at: 4, until: 6, ops: [{ op: 'add', type: 'djfilter', ref: 'sweep' }, { op: 'connect', from: ids.mix, from_port: 'l', to: 'sweep', to_port: 'in' }, { op: 'connect', from: 'sweep', from_port: 'out', to: ids.master, to_port: 'l' }] });
  const { plan, problems } = checkPlan(g, raw);
  assert.deepEqual(problems, []);
  const seen = new Set(), before = g.toJSON();
  const r = await stretch(plan, g, { at: 0, until: 8 * 16, onBlock: (c, gr) => { for (const n of gr.nodes.values()) if (!before.nodes.some((b) => b.id === n.id)) seen.add(n.type); } });
  assert.deepEqual([...seen], ['djfilter']);
  assert.equal(r.graph.nodes.size, before.nodes.length, 'modules');
  assert.equal(r.graph.links.size, before.links.length, 'cables');
  const on = await stretch(plan, g, { at: 8 * 16, until: 12 * 16 });
  assert.equal(on.graph.nodes.get(ids.mix).params.fade, 1);
  on.conductor.stop();
  assert.equal(on.graph.nodes.get(ids.mix).params.fade, 0, 'the fader is back');
});

const peakIn = (x, s, e) => { let m = 0; for (let i = Math.round(s); i < e; i++) m = Math.max(m, Math.abs(x[i])); return m; };
const firstOver = (x, s, e, level) => { for (let i = Math.round(s); i < e; i++) if (Math.abs(x[i]) > level) return i; return -1; };

// a stem with one click on the first 16th of a bar, and nothing else
const clickAt = (t, bar) => {
  const x = new Float32Array(audios[0].L.length), at = Math.round(gridOf(t)[bar * 16] * SR);
  for (let i = 0; i < 300; i++) x[at + i] = 0.9 * (i % 2 ? 1 : -1);
  return { L: x, R: x, sr: SR };
};

test('a sample fills the Slicer on its bar, on the first step, and lets go on the bar it says', async () => {
  const w = withSlicer(wall(stemmed(), null));
  const raw = aPlan(w.ids);
  raw.moves.push({ at: 26, until: 30, why: 'a piece of it stays behind', ops: [{ op: 'sample', id: w.chop, track: 0, stem: 'vocals', bar: 20, bars: 1, pieces: 4, steps: 'a...............', gain: 1.5 }] });
  const { plan, problems } = checkPlan(w.g, raw);
  assert.deepEqual(problems, []);
  const seen = [];
  const r = await stretch(plan, w.g, {
    at: 24 * 16, until: 32 * 16,
    source: { ...sourceOf(audios, records), stem: async (t, name) => (name === 'vocals' ? clickAt(t, 20) : null) },
    onBlock: (c, gr) => { const n = gr.nodes.get(w.chop); seen.push(n.data.pool.length); },
  });
  assert.ok(seen.includes(4) && seen.at(-1) === 0, 'it came, and it went');
  const at = new Map(r.steps.map((x) => [x.step, x.sample]));
  assert.ok(peakIn(r.L, at.get(27 * 16 + 1), at.get(27 * 16 + 14)) < peakIn(r.L, at.get(26 * 16) - 200, at.get(26 * 16) + 2400), 'the click sits on the bar');
  assert.equal(r.graph.nodes.get(w.chop).params.gain, 1.5);
  assert.equal(r.graph.links.size, w.g.links.size, 'every cable is where it was');
});

test('a sample starts on the very bar it is due', async () => {
  // no rack and no track to hear past: only what the Slicer plays reaches the Master
  const g = new Graph();
  const clock = g.addNode('clock', 0, 0, { params: { bpm: 125 } }), set = g.addNode('set', 0, 10), master = g.addNode('master', 1, 20), chop = g.addNode('slicer', 2, 0);
  g.connect(clock.id, 's16', set.id, 'clk');
  g.connect(clock.id, 's16', chop.id, 'clk');
  g.connect(chop.id, 'l', master.id, 'l');
  const quiet = new Float32Array(audios[0].L.length), lead = 0.5;
  g.connect(set.id, 'l', g.addNode('mixer', 3, 0).id, 'in1');
  g.setData(set.id, { tracks: stemmed(), plan: null });
  const plan = { brief: 'x', arc: [{ name: 'a', bars: 8 }], tracks: [{ track: 1, at: 7, enter: 0, leave: 1 }], moves: [{ at: 5, until: 7, glide: 0, why: '', ops: [{ op: 'sample', id: chop.id, track: 0, stem: 'vocals', bar: 20, bars: 1, pieces: 1, steps: `a${'.'.repeat(31)}` }] }], home: [] };
  g.setData(set.id, { tracks: stemmed(), plan });
  const r = await renderStretch(g.toJSON(), { at: 0, until: 8 * 16, source: { track: async () => ({ L: quiet, R: quiet, sr: SR }), stem: async (t) => clickAt(t, 20) } });
  const at = new Map(r.steps.map((x) => [x.step, x.sample]));
  // two bars long and landing on an odd bar: a Slicer that kept counting would be half way through
  const hit = firstOver(r.L, at.get(4 * 16), at.get(7 * 16 - 1), 0.02);
  assert.ok(hit > 0, 'the click was heard');
  const off = ((hit - at.get(5 * 16)) / SR) * 1000;
  assert.ok(off >= -lead - 3 && off < 12, `${off.toFixed(1)} ms from the bar`);
});

test('a stem is cut where the stem has it, and backwards means backwards', () => {
  const t = stemmed()[0], x = Float32Array.from({ length: audios[0].L.length }, (_, i) => i / 1e7);
  const op = { track: 0, bar: 8, bars: 1, pieces: 1 };
  const grid = gridOf(t), first = Math.round(grid[8 * 16] * SR), last = Math.round(grid[9 * 16] * SR);
  const level = (v) => Math.fround(v * t.gain);
  assert.equal(cutPiece(t, op, { L: x, R: x, sr: SR }).L[0], level(x[first]), 'it comes at the level the track plays at');
  assert.equal(cutPiece(t, { ...op, stem: 'bass' }, { L: x, R: x, sr: SR }).L[0], level(x[first + Math.round(t.stems.lag * SR)]), 'a stem lags its mix by what was measured');
  const back = cutPiece(t, { ...op, reverse: true }, { L: x, R: x, sr: SR }).L;
  assert.equal(back.length, last - first, 'no tail');
  assert.equal(back[0], level(x[last - 1]));
  const data = sampleData(t, { ...op, bar: 8.25, bars: 0.5, pieces: 2 });
  assert.equal(data.pool.length, 2);
  assert.deepEqual(data.pads.slice(0, 4), [0, 1, 0, 1]);
});

test('stopped halfway, a Slicer gives back what it held', async () => {
  const w = withSlicer(wall(stemmed(), null));
  const raw = aPlan(w.ids);
  raw.moves.push({ at: 2, until: 30, why: '', ops: [{ op: 'sample', id: w.chop, track: 0, bar: 20, bars: 1, pieces: 2 }] });
  const { plan, problems } = checkPlan(w.g, raw);
  assert.deepEqual(problems, []);
  const r = await stretch(plan, w.g, { at: 0, until: 5 * 16 });
  assert.equal(r.graph.nodes.get(w.chop).data.pool.length, 2, 'it holds it while the set runs');
  r.conductor.stop();
  assert.equal(r.graph.nodes.get(w.chop).data.pool.length, 0);
  assert.equal(r.graph.nodes.get(w.chop).params.length, 16);
});

test('the render says what a sample adds, and says so when nothing of it arrives', async () => {
  const w = withSlicer(wall(stemmed(), null));
  const raw = aPlan(w.ids);
  raw.moves.push({ at: 26, until: 30, why: '', ops: [{ op: 'sample', id: w.chop, track: 0, bar: 20, bars: 1, pieces: 4, gain: 2 }] });
  const { plan, problems } = checkPlan(w.g, raw);
  assert.deepEqual(problems, []);
  const heard = await hearPlan(withPlan(w.g, plan), sourceOf(audios, records));
  const line = heard.passages.find((p) => p.kind === 'sample');
  assert.ok(line.level > -40 && !line.problems.length, JSON.stringify(line));
  assert.match(reportLine(line), /^✓ Sample of "a", its bar 20, set bars 26–30: -?\d+ LUFS at its loudest/);
  const dead = withPlan(w.g, plan);
  dead.links = dead.links.filter((l) => !(l.from === w.chop && l.fromPort === 'l'));
  const lost = (await hearPlan(dead, sourceOf(audios, records))).passages.find((p) => p.kind === 'sample');
  assert.match(lost.problems.join(), /nothing of it reaches the Master/);
  raw.moves.at(-1).ops[0].gain = 0.01;
  const faint = withPlan(w.g, checkPlan(w.g, raw).plan);
  const buried = (await hearPlan(faint, sourceOf(audios, records))).passages.find((p) => p.kind === 'sample');
  assert.match(buried.problems.join(), /nobody will hear it/);
});

test('a knob thrown on the bar a glide ends stays thrown: a tape stop must not hold the Clock down', async () => {
  const { g, ids } = wall(records, null);
  const raw = aPlan(ids);
  raw.moves.push({ at: 2, glide: 2, why: 'tape stop', ops: [{ op: 'set', id: ids.clock, params: { bpm: 60 } }] }, { at: 4, glide: 0, why: 'back up', ops: [{ op: 'set', id: ids.clock, params: { bpm: 126 } }] });
  const { plan, problems } = checkPlan(g, raw);
  assert.deepEqual(problems, []);
  const r = await stretch(plan, g, { at: 0, until: 7 * 16 });
  assert.equal(r.graph.nodes.get(ids.clock).params.bpm, 126);
});

test('every run starts from where the plan was made, whatever the last one left behind', async () => {
  const { g, ids, plan } = planned();
  assert.ok(plan.home.some(([id, , name, v]) => id === ids.line && name === 'transpose' && v === 0), JSON.stringify(plan.home));
  const left = g.toJSON();
  left.nodes.find((n) => n.id === ids.line).params.transpose = 3;
  left.nodes.find((n) => n.id === ids.mix).params.fade = 1;
  const again = await renderStretch({ ...left, nodes: left.nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) }, { at: 0, until: 4 * 16, source: sourceOf(audios, records) });
  assert.equal(again.graph.nodes.get(ids.line).params.transpose, 0);
  assert.equal(again.graph.nodes.get(ids.mix).params.fade, 0);
});

test('a late track makes the rack play on, and the plan moves with it', async () => {
  const { g, plan } = planned();
  const source = sourceOf(audios, records), honest = source.track;
  let release;
  const gate = new Promise((r) => { release = r; });
  source.track = async (t) => { if (t.file === 'b') await gate; return honest(t); };
  const r = await renderStretch({ ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) }, {
    at: 24 * 16, until: 43 * 16, source,
    onBlock: (c) => { if (c.step > 42 * 16) release(); },
  });
  assert.match(r.conductor.message, /late/);
  assert.ok(r.conductor.legs[1].start > 40 * 16, 'the track went later');
  assert.ok(r.conductor.running, 'and the set goes on');
});

test('the plan is heard first, and what is measured comes back in numbers', async () => {
  const { g, plan } = planned();
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) };
  const r = await hearPlan(patch, sourceOf(audios, records));
  assert.equal(r.passages.length, 4);
  assert.ok(r.ok, r.passages.map(reportLine).join('\n'));
  const line = reportLine(r.passages[0]);
  assert.match(line, /^✓ "a" comes in, set bars 4–.*the track starts on 8/);
  assert.match(line, /LUFS by bar/);
  assert.ok(r.passages.every((p) => Math.abs(p.speed - 1) < 0.01), 'every track at its own speed');
});

test('and it can fail: silence is reported', async () => {
  const { g, plan } = planned();
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) };
  const source = sourceOf(audios, records), honest = source.track;
  source.track = async (t) => { const a = await honest(t); return t.file === 'b' ? { ...a, L: new Float32Array(a.L.length), R: new Float32Array(a.L.length) } : a; };
  const r = await hearPlan(patch, source);
  assert.equal(r.ok, false);
  assert.match(r.passages[2].problems.join(), /silent/);
});

test('a track played at the wrong speed is reported, and so are two kicks that miss', async () => {
  const { g, plan } = planned();
  const wrong = structuredClone(plan);
  wrong.moves[0].ops[0].params.bpm = 110;
  wrong.moves[3].ops[0].params.bpm = 140;
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan: wrong } } : n)) };
  const r = await hearPlan(patch, sourceOf(audios, records));
  assert.match(r.passages[0].problems.join(), /% of its own speed/);
  const both = structuredClone(plan);
  both.tracks[0].nudge = 0.04;
  both.moves[1].ops[0].params = { fade: 0.5, lows: 0.5 };
  const late = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan: both } } : n)) };
  const off = await hearPlan(late, sourceOf(audios, records));
  assert.ok(off.passages[0].apart !== null, 'the kicks of both could be found');
  assert.ok(Math.abs(off.passages[0].apart + 40) < 8, `${off.passages[0].apart} ms`);
  assert.match(off.passages[0].problems.join(), /ms from the rack/);
});

test('rack and track come back apart, and a blend shows up as bars heard together', async () => {
  const { g, plan } = planned();
  const blended = structuredClone(plan);
  blended.moves[1].ops[0].params = { fade: 0.5, lows: 0.5 };
  blended.moves.splice(2, 0, { at: 12, glide: 0, why: '', ops: [{ op: 'set', id: blended.moves[1].ops[0].id, params: { fade: 1, lows: 1 } }] });
  const patch = (p) => ({ ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan: p } } : n)) });
  const cut = (await hearPlan(patch(plan), sourceOf(audios, records))).passages[0];
  const mix = (await hearPlan(patch(blended), sourceOf(audios, records))).passages[0];
  assert.ok(cut.together <= 1, `a cut: ${cut.together} bars together, and that's the rack's last ring`);
  assert.ok(mix.together >= 3, `${mix.together} bars together`);
  assert.equal(cut.track[0], '.', 'no track before it starts');
  assert.ok(Number.isFinite(cut.rack[0]) && cut.rack.at(-1) === '.', `the rack, then none: ${cut.rack.join(' ')}`);
  assert.equal(mix.rack[5] - cut.rack[0] < 0, true, 'the fader took the rack down');
});

test('rack and track stay apart when the plan itself turns the Set up and down', async () => {
  const { g, ids, plan } = planned();
  const turned = structuredClone(plan);
  turned.moves.splice(1, 0, { at: 6, glide: 0, why: '', ops: [{ op: 'set', id: ids.set, params: { gain: 1 } }] });
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan: turned } } : n)) };
  const heard = (await hearPlan(patch, sourceOf(audios, records))).passages[0];
  assert.ok(heard.track.at(-1) !== '.' && heard.rack.at(-1) === '.', reportLine(heard));
});

test('a fader thrown before the track has started shows up as a hole', async () => {
  const { g, plan } = planned();
  const early = structuredClone(plan);
  early.moves[1].at = 7;
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan: early } } : n)) };
  const r = await hearPlan(patch, sourceOf(audios, records));
  assert.match(r.passages[0].problems.join(), /bar 7 is silent|a hole/);
});

test('a track that misses the level of the rack is reported, and so is a mix that sags', async () => {
  const { g, ids, plan } = planned();
  const low = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, params: { gain: 0.4 }, data: { tracks: records, plan } } : n)) };
  assert.match((await hearPlan(low, sourceOf(audios, records))).passages[0].problems.join(), /don't meet/);
  const sagging = structuredClone(plan);
  sagging.moves[1].ops[0].params = { fade: 0.5, lows: 0.5 };
  sagging.moves.splice(2, 0, { at: 10, glide: 0, why: '', ops: [{ op: 'set', id: ids.mix, params: { fade: 0.9, lows: 0 } }, { op: 'set', id: ids.set, params: { gain: 0.2 } }] }, { at: 14, glide: 0, why: '', ops: [{ op: 'set', id: ids.mix, params: { fade: 1, lows: 1 } }, { op: 'set', id: ids.set, params: { gain: 0.95 } }] });
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan: sagging } } : n)) };
  const heard = (await hearPlan(patch, sourceOf(audios, records))).passages[0];
  assert.match(heard.problems.join(), /sags/, reportLine(heard));
});

test('a sample that doubles its own track shows up as a surge, and a bar past the ceiling as too loud', async () => {
  const w = withSlicer(wall(stemmed(), null));
  const raw = aPlan(w.ids);
  // the same bars as the deck is playing, in time with it, right where the track stops
  const end = raw.tracks[0].at + raw.tracks[0].leave - raw.tracks[0].enter, enter = raw.tracks[0].leave - 4;
  // a Slicer on the side the fader has open while the track plays
  assert.ok(w.g.connect(w.chop, 'l', w.ids.master, 'l').ok);
  raw.moves.push({ at: end - 4, until: end, why: '', ops: [{ op: 'sample', id: w.chop, track: 0, bar: enter, bars: 4, pieces: 1, steps: `a${'.'.repeat(63)}`, gain: 4 }] });
  const { plan, problems } = checkPlan(w.g, raw);
  assert.deepEqual(problems, []);
  const heard = await hearPlan(withPlan(w.g, plan), sourceOf(audios, records));
  const out = heard.passages.find((p) => p.what?.endsWith('goes out') && p.edge === end);
  assert.match(out.problems.join(), /surge over the bars around them/, JSON.stringify(out));
  const calm = await hearPlan(wall(records, aPlan(w.ids) && checkPlan(wall(records, null).g, aPlan(wall(records, null).ids)).plan).json, sourceOf(audios, records));
  assert.ok(!calm.passages.some((p) => p.problems.join().includes('surge')), 'and nothing is said of a plan without one');
});

test('too much level is reported at the limiter', async () => {
  const { g, plan } = planned();
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, params: { gain: 4 }, data: { tracks: records, plan } } : n.type === 'master' ? { ...n, params: { volume: 1.5 } } : n)) };
  const r = await hearPlan(patch, sourceOf(audios, records));
  assert.match(r.passages[0].problems.join(), /limiter works hard/);
});

test('a plan saved in the shape from before counts as no plan, and the patch still loads', () => {
  const { g, ids } = wall(records, { legs: [{ track: 0, enter: 0, leave: 16 }], joins: [] });
  assert.equal(planOf(g.nodes.get(ids.set)), null);
  const again = new Graph();
  again.load(g.toJSON());
  assert.equal(planOf(again.nodes.get(ids.set)), null);
});

test('a rack with a Set in it sounds as it did, with no track on the deck', () => {
  const { json } = wall(records, null);
  const r = renderPatch(json, { seconds: 2 });
  assert.ok(r.L.reduce((m, v) => Math.max(m, Math.abs(v)), 0) > 0.05, 'silent at the Master');
});

// ── going to a bar while it plays ───────────────────────
test('a set started halfway through a glide has the knob halfway there, from where the glide before left it', async () => {
  const { g, ids } = wall(records, null);
  const raw = aPlan(ids);
  raw.moves.push({ at: 30, glide: 2, ops: [{ op: 'set', id: ids.set, params: { gain: 2 } }] }, { at: 34, glide: 4, ops: [{ op: 'set', id: ids.set, params: { gain: 1 } }] });
  const { plan, problems } = checkPlan(g, raw);
  assert.deepEqual(problems, []);
  const r = await stretch(plan, g, { at: 36 * 16, until: 36 * 16 + 2 });
  const now = r.graph.nodes.get(ids.set).params.gain;
  assert.ok(Math.abs(now - 1.5) < 0.1, `gain ${now}, between the 2 of the first glide and the 1 of the second`);
});

test('a jump lands on a bar of the Clock, with the wall and the track as a start from there would have them', async () => {
  const { g, ids, plan } = planned();
  const target = 12 * 16;
  const r = await stretch(plan, g, { at: 0, until: 20 * 16, onBlock: (c) => { if (c.step >= 20 && !c.jumped) { c.jumped = true; c.seek(target); } } });
  const landed = r.steps.find((s) => s.step === target);
  assert.ok(landed, 'it got there');
  assert.equal(r.conductor.at, target);
  assert.equal(Math.abs(r.conductor.base % 16), 0, 'bars of the set are bars of the Clock');
  assert.equal(r.graph.nodes.get(ids.mix).params.fade, 1, 'the fader was thrown on bar 8');
  const beat = 60 / bpmAt(records[0], 8), grid = Float64Array.from({ length: 8 }, (_, k) => landed.sample / SR + k * beat);
  const off = [...kickOffsets(grid, r.L, SR, grid)];
  assert.ok(off.every((d) => Math.abs(d) < 0.005), `kicks after the jump: ${off.map((d) => (d * 1000).toFixed(1))} ms`);
});

test('a jump backwards takes back what the set has done since', async () => {
  const { g, ids } = wall(records, null);
  const raw = aPlan(ids);
  raw.moves.push({ at: 7, until: 30, ops: [{ op: 'add', type: 'djfilter', ref: 'sweep' }, { op: 'connect', from: ids.mix, from_port: 'l', to: 'sweep', to_port: 'in' }, { op: 'connect', from: 'sweep', from_port: 'out', to: ids.master, to_port: 'l' }] });
  const { plan, problems } = checkPlan(g, raw);
  assert.deepEqual(problems, []);
  const size = g.nodes.size, links = g.links.size;
  let most = 0, found = null;
  await stretch(plan, g, {
    at: 6 * 16, until: 40 * 16,
    onBlock: (c, gr) => {
      most = Math.max(most, gr.nodes.size);
      if (c.step >= 8 * 16 + 4 && !c.jumped) { c.jumped = true; c.seek(2 * 16); }
      if (c.at === 2 * 16 && c.step >= 3 * 16) { found = { nodes: gr.nodes.size, links: gr.links.size, fade: gr.nodes.get(ids.mix).params.fade }; c.stop(); }
    },
  });
  assert.equal(most, size + 1, 'the filter was there');
  assert.deepEqual(found, { nodes: size, links, fade: 0 });
});

test('of two jumps in a row, only the last one happens', async () => {
  const { g, plan } = planned();
  const r = await stretch(plan, g, {
    at: 0, until: 16 * 16,
    onBlock: (c) => { if (c.step >= 20 && !c.jumped) { c.jumped = true; c.seek(10 * 16); c.seek(14 * 16); } },
  });
  assert.equal(r.conductor.at, 14 * 16);
  assert.ok(!r.steps.some((s) => s.step === 10 * 16), 'bar 10 was never played');
});

test('a run starts from the cursor, and a finished set goes back to the top', async () => {
  const { g, ids, plan } = planned();
  const graph = new Graph(), host = new Host(graph), rack = new Rack({ sampleRate: SR, telemetry: host.telemetry });
  host.node = { port: { postMessage: (m) => rack.apply(m) } };
  host.start = async () => {};
  graph.load({ ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) });
  const c = new Conductor({ graph, host, source: sourceOf(audios, records) });
  await c.seek(12 * 16);
  assert.equal(c.cursor, 12 * 16);
  assert.equal(c.running, false, 'stopped, it only says where the next run starts');
  assert.equal(graph.nodes.get(ids.mix).params.fade, 0, 'and nothing on the wall moved');
  await c.start({ manual: true });
  assert.equal(c.at, 12 * 16);
  assert.equal(graph.nodes.get(ids.mix).params.fade, 1);
  c.finish();
  assert.equal(c.cursor, 0);
  await c.seek(9999 * 16);
  assert.equal(c.cursor, (lengthOf(plan) - 1) * 16, 'no further than the last bar');
});

// Every kind of sequencer on one Clock, all with something to lose: patterns of odd lengths, slower
// pulses, a Divider, a pattern that gets longer on the way, and the reset patched
function counters() {
  const w = withSlicer(wall(records, null)), { g, ids } = w;
  const add = (type, more) => g.addNode(type, 6, 0, more).id;
  const wire = (...c) => assert.ok(g.connect(...c).ok, c.join());
  const drums = add('drumseq', { params: { length: 13 } }), bass = add('bassline', { params: { length: 15 } });
  const steps = add('step8', { params: { length: 5, dir: 1 } }), pend = add('step8', { params: { length: 7, dir: 2 } });
  const euclid = add('euclid', { params: { steps: 11 } }), lfo = add('lfo', { params: { div: 3 } }), turn = add('seqswitch', { params: { steps: 3 } }), div = add('divider'), late = add('drumseq', { params: { length: 7 } });
  for (const id of [drums, bass, euclid, turn, div, w.chop]) wire(ids.clock, 's16', id, 'clk');
  wire(ids.clock, 's8', steps, 'clk');
  wire(ids.clock, 's4', pend, 'clk');
  wire(ids.clock, 's4', lfo, 'clk');
  wire(div, 'd3', late, 'clk');
  for (const id of [drums, bass, steps, euclid, lfo, turn, div, w.chop]) wire(ids.clock, 'rst', id, 'rst');
  return { ...w, seen: { drums, bass, steps, pend, euclid, lfo, turn, div, late, chop: w.chop } };
}

const whereTheyAre = (r, seen) => Object.fromEntries(Object.entries(seen).map(([name, id]) => {
  const { k, n, count } = r.rack.modules.get(id).dsp;
  return [name, count ?? k ?? n];
}));

test('a set started halfway finds every sequencer where a whole run would have it', async () => {
  const w = counters();
  const raw = aPlan(w.ids);
  raw.moves.push(
    { at: 3, ops: [{ op: 'set', id: w.seen.drums, params: { length: 15 } }] },
    { at: 5, until: 9, ops: [{ op: 'sample', id: w.chop, track: 0, bar: 20, bars: 1, pieces: 4, steps: `a${'.'.repeat(15)}b${'.'.repeat(15)}` }] },
  );
  const { plan, problems } = checkPlan(w.g, raw);
  assert.deepEqual(problems, []);
  const at = 6 * 16, whole = await stretch(plan, w.g, { at: 0, until: at + 1 });
  const part = await stretch(plan, w.g, { at, until: at + 1 });
  const want = whereTheyAre(whole, w.seen), got = whereTheyAre(part, w.seen);
  assert.deepEqual(got, want);
  assert.ok(want.chop >= 16, `on the second bar of the sample's pattern, step ${want.chop}`);
});

test('a jump puts every sequencer where a whole run would have it', async () => {
  const w = counters();
  const { plan, problems } = checkPlan(w.g, aPlan(w.ids));
  assert.deepEqual(problems, []);
  const at = 11 * 16, whole = await stretch(plan, w.g, { at: 0, until: at + 1 });
  const jump = await stretch(plan, w.g, { at: 3 * 16, until: at + 1, onBlock: (c) => { if (c.step >= 3 * 16 + 37 && !c.jumped) { c.jumped = true; c.seek(at); } } });
  assert.deepEqual(whereTheyAre(jump, w.seen), whereTheyAre(whole, w.seen));
});

test('a marked stretch says what is in it, by the numbers the plan uses', () => {
  const { plan } = planned();
  const text = describeMark(plan, records, { from: 10, to: 26 });
  assert.match(text, /^\[Marked: bars 10-26 of the set/);
  assert.match(text, /Part of the arc: transition, bars 8-24/);
  assert.match(text, /Track 0 "a": its bars 10-24 are heard here/);
  assert.match(text, /moves\[\d+\], bar 24: on to the next/);
  assert.doesNotMatch(text, /Track 1/);
  assert.doesNotMatch(describeMark(plan, records, { from: 36, to: 38 }), /bar 0:/);
});

// ── changing a saved plan ───────────────────────────────
test('an edit takes moves out, puts new ones in, and knows which bars are different', () => {
  const { plan } = planned();
  const edit = editedPlan(plan, { remove: [2], add: [{ at: 26, glide: 2, until: 30, why: 'new', ops: [] }] });
  assert.deepEqual(edit.problems, []);
  assert.deepEqual(edit.only, { from: 24, to: 30 });
  assert.equal(edit.raw.moves.length, plan.moves.length);
  assert.ok(edit.raw.moves.some((m) => m.why === 'new'));
  assert.equal(edit.raw.brief, plan.brief);
  assert.match(editedPlan(plan, { remove: [99] }).problems.join(), /no moves\[99\]/);
  const moved = editedPlan(plan, { tracks: plan.tracks.map((e) => (e.track === 1 ? { ...e, at: 42 } : e)) });
  assert.deepEqual(moved.only, { from: 40, to: 58 });
  assert.deepEqual(editedPlan(plan, { arc: plan.arc }).only, { from: 0, to: 0 });
});

test('an edit is heard only where it touches: a way in or out, its samples, or those bars themselves', () => {
  const w = withSlicer(wall(records, null));
  const raw = aPlan(w.ids);
  raw.moves.push({ at: 30, until: 34, ops: [{ op: 'sample', id: w.chop, track: 0, bar: 20, bars: 1, pieces: 1 }] });
  const { plan, problems } = checkPlan(w.g, raw);
  assert.deepEqual(problems, []);
  assert.equal(jobsOf(plan).length, 5, 'without an edit, all of it');
  const near = jobsOf(plan, { from: 24, to: 26 });
  assert.deepEqual(near.map((j) => [j.leg?.track, j.side]), [[0, 'out']]);
  const between = jobsOf(plan, { from: 31, to: 33 });
  assert.deepEqual(between.map((j) => [j.at / 16, j.until / 16]), [[29, 35], [30, 34]]);
  assert.equal(between[0].leg, undefined);
  assert.ok(between[1].op);
  assert.deepEqual(jobsOf(plan, { from: 0, to: 0 }), []);
});

test('bars that touch no way in or out are rendered and measured on their own', async () => {
  const { g, plan } = planned();
  const patch = { ...g.toJSON(), nodes: g.toJSON().nodes.map((n) => (n.type === 'set' ? { ...n, data: { tracks: records, plan } } : n)) };
  const { passages } = await hearPlan(patch, sourceOf(audios, records), { from: 31, to: 33 });
  assert.equal(passages.length, 1);
  assert.equal(passages[0].edge, null);
  assert.equal(passages[0].lufs.length, 6);
  assert.match(reportLine(passages[0]), /^. The bars that changed, set bars 29–35\. LUFS by bar/);
});

test('what an edit keeps: the home of the plan before it, and what failed in bars nobody heard again', () => {
  const { plan } = planned();
  const fine = { what: 'x', problems: [], from: 30, to: 34 }, bad = { what: 'y', problems: ['no'], at: 30, until: 34 };
  assert.deepEqual(settledPlan(plan, [bad], null).plan.failed, [{ what: 'y', from: 30, to: 34 }]);
  const before = { ...plan, ok: false, failed: [{ what: 'old', from: 10, to: 20 }], home: [['a', 'params', 'b', 1]] };
  const elsewhere = settledPlan({ ...plan, home: [['a', 'params', 'b', 9], ['c', 'params', 'd', 2]] }, [fine], before, { from: 30, to: 34 });
  assert.equal(elsewhere.plan.ok, false);
  assert.deepEqual(elsewhere.left, before.failed);
  assert.deepEqual(elsewhere.plan.home, [['a', 'params', 'b', 1], ['c', 'params', 'd', 2]]);
  const mended = settledPlan({ ...plan, home: [] }, [fine], before, { from: 12, to: 14 });
  assert.equal(mended.plan.ok, true);
  const older = settledPlan({ ...plan, home: [] }, [fine], { ...plan, ok: false, failed: undefined, home: [] }, { from: 0, to: 60 });
  assert.equal(older.plan.ok, false, 'a plan that never said where it failed stays failed until it is heard whole');
});
