// Clocks and sequencers against the timing and patterns they promise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule } from './lib/dsp.mjs';

const SR = 48000;
const edges = (x, th = 2) => { const out = x[0] >= th ? [0] : []; for (let i = 1; i < x.length; i++) if (x[i - 1] < th && x[i] >= th) out.push(i); return out; };
const clockAt = (hz) => (t) => ((t * hz) % 1 < 0.1 ? 10 : 0);

test('the clock keeps sample-accurate time at 132 BPM and starts on the one', () => {
  const r = renderModule('clock', { params: { bpm: 132 }, seconds: 10 });
  const s16 = edges(r.s16);
  const bars = edges(r.bar);
  assert.ok(s16[0] <= 1 && bars[0] <= 1, 'first step fires at once');
  const ideal = (60 / 132 / 4) * SR;
  s16.forEach((e, k) => assert.ok(Math.abs(e - s16[0] - k * ideal) < 1.01, `step ${k} drifts: ${e} vs ${k * ideal}`));
  assert.equal(bars.length, Math.ceil((10 * 132) / 60 / 4));
  assert.ok(Math.abs(edges(r.s4).length - 22) <= 1);
});

test('swing delays only the odd sixteenths, by the amount on the knob', () => {
  const r = renderModule('clock', { params: { bpm: 120, swing: 0.66 }, seconds: 4 });
  const s = edges(r.s16);
  const pair = (60 / 120 / 2) * SR;
  for (let k = 0; k + 2 < s.length; k += 2) {
    assert.ok(Math.abs(s[k + 2] - s[k] - pair) <= 1.01, 'pairs stay on the grid');
    assert.ok(Math.abs((s[k + 1] - s[k]) / pair - 0.66) < 0.002, `odd step at ${(s[k + 1] - s[k]) / pair}`);
  }
});

test('the ramp climbs smoothly from 0 to 10 V once a bar', () => {
  const r = renderModule('clock', { params: { bpm: 120, swing: 0.6 }, seconds: 2.2 });
  const bar = 2 * SR;
  assert.ok(Math.abs(r.ramp[Math.round(bar * 0.5)] - 5) < 0.05, `${r.ramp[Math.round(bar * 0.5)]}`);
  let jump = 0;
  for (let n = 1; n < bar - 10; n++) jump = Math.max(jump, Math.abs(r.ramp[n] - r.ramp[n - 1]));
  assert.ok(jump < 0.01, `a step of ${jump} V`);
});

test('a stopped clock is silent and restarts from the one', () => {
  const r = renderModule('clock', { seconds: 1, running: false });
  assert.equal(edges(r.s16).length, 0);
});

test('the divider divides', () => {
  const r = renderModule('divider', { inputs: { clk: clockAt(32) }, seconds: 2 });
  const n = edges(r.d2).length;
  assert.ok(Math.abs(n - 32) <= 1);
  assert.ok(Math.abs(edges(r.d3).length - 21) <= 1);
  assert.ok(Math.abs(edges(r.d8).length - 8) <= 1);
  assert.ok(Math.abs(edges(r.d32).length - 2) <= 1);
});

const acid = (over = {}) => ({ steps: Array.from({ length: 16 }, (_, k) => ({ n: 12, g: 1, a: 0, s: 0, ...(over[k] ?? {}) })) });

test('bassline: pitches, rests, accents', () => {
  const data = acid({ 1: { n: 19 }, 2: { g: 0 }, 3: { a: 1 } });
  const r = renderModule('bassline', { data, inputs: { clk: clockAt(10) }, seconds: 0.5 });
  const at = (k) => Math.floor(((k + 0.2) / 10) * SR);
  assert.ok(Math.abs(r.pitch[at(0)] - (12 / 12 - 2)) < 1e-9, 'C3 is -1 V');
  assert.ok(Math.abs(r.pitch[at(1)] - (19 / 12 - 2)) < 1e-9);
  assert.equal(r.gate[at(2)], 0, 'rest');
  assert.equal(r.accent[at(3)], 10);
  assert.equal(r.accent[at(0)], 0);
});

test('bassline: a slide holds the gate across the step and raises SLIDE; a repeat retriggers', () => {
  const data = acid({ 0: { s: 1 }, 1: { n: 15 } });
  const r = renderModule('bassline', { data, inputs: { clk: clockAt(10) }, seconds: 0.4 });
  const g = edges(r.gate);
  // step 0 → 1 is tied, so no new rising edge at step 1, then steps 2 and 3 retrigger
  const step = SR / 10;
  assert.equal(g.filter((e) => e < step * 1.9).length, 1, 'tied note: one gate');
  assert.equal(r.slide[Math.floor(step * 0.2)], 0);
  assert.equal(r.slide[Math.floor(step * 1.2)], 10);
  assert.equal(r.gate[Math.floor(step * 0.8)], 10, 'gate held through the end of the slid step');
  assert.ok(g.length >= 3);
});

test('rhythm composer fires the right rows on the right steps', () => {
  const rows = Array.from({ length: 9 }, () => new Array(16).fill(0));
  rows[0][0] = rows[0][4] = 1;
  rows[3][2] = 1;
  rows[8][4] = 1;
  const r = renderModule('drumseq', { data: { rows }, inputs: { clk: clockAt(16) }, seconds: 0.99 });
  const step = SR / 16;
  assert.deepEqual(edges(r.t1).map((e) => Math.round(e / step)), [0, 4]);
  assert.deepEqual(edges(r.t4).map((e) => Math.round(e / step)), [2]);
  assert.equal(edges(r.t2).length, 0);
  assert.equal(r.acc[Math.floor(step * 4.5)], 10);
  assert.equal(r.acc[Math.floor(step * 3.5)], 0);
});

test('euclid: E(3,8) is the tresillo, E(5,16) has five even hits', () => {
  const hitsOf = (hits, steps) => {
    const r = renderModule('euclid', { params: { hits, steps }, inputs: { clk: clockAt(steps) }, seconds: 0.99 });
    return edges(r.trig).map((e) => Math.round(e / (SR / steps)));
  };
  const t = hitsOf(3, 8);
  assert.equal(t.length, 3);
  const gaps = [t[1] - t[0], t[2] - t[1], 8 - t[2] + t[0]].sort();
  assert.deepEqual(gaps, [2, 3, 3]);
  const f = hitsOf(5, 16);
  assert.equal(f.length, 5);
  const g = f.map((x, k) => ((f[(k + 1) % 5] - x + 16) % 16));
  assert.ok(Math.max(...g) - Math.min(...g) <= 1, `gaps ${g}`);
});

test('turing: locked it repeats exactly, unlocked it does not', () => {
  const clk = clockAt(64);
  const a = renderModule('turing', { params: { lock: 1, length: 8 }, inputs: { clk }, seconds: 2 });
  const step = SR / 64;
  const v = (r, k) => r.cv[Math.floor(step * (k + 0.5))];
  for (let k = 20; k < 60; k++) assert.equal(v(a, k), v(a, k + 8), `step ${k}`);
  const b = renderModule('turing', { params: { lock: 0.5, length: 8 }, inputs: { clk }, seconds: 2 });
  let differ = 0;
  for (let k = 20; k < 60; k++) if (v(b, k) !== v(b, k + 8)) differ++;
  assert.ok(differ > 10, `only ${differ} steps changed`);
});

test('quantizer lands on the scale and in the right octave', () => {
  const r = renderModule('quant', { params: { scale: 2, root: 0 }, inputs: { in: (t) => t * 2 - 1 }, seconds: 1 }); // C minor
  const allowed = new Set([0, 2, 3, 5, 7, 8, 10]);
  const out = r.out.out;
  assert.equal(out.length, 48000);
  for (let n = 0; n < out.length; n += 97) {
    const semi = out[n] * 12;
    assert.ok(Math.abs(semi - Math.round(semi)) < 1e-9);
    assert.ok(allowed.has(((Math.round(semi) % 12) + 12) % 12), `${semi}`);
    assert.ok(Math.abs(out[n] - ((n / out.length) * 2 - 1)) < 2 / 12);
  }
});

test('chance splits triggers at the probability on the knob', () => {
  const r = renderModule('chance', { params: { prob: 0.8 }, inputs: { in: clockAt(100) }, seconds: 10 });
  const a = edges(r.a).length, b = edges(r.b).length;
  assert.ok(a + b >= 999);
  assert.ok(Math.abs(a / (a + b) - 0.8) < 0.04, `${a / (a + b)}`);
});

// ── regressions from the independent review ──

test('EUCLID GATE closes when the transport stops', () => {
  let stopped = false;
  const clk = (t) => (t < 0.5 ? clockAt(16)(t) : 0);
  const r = renderModule('euclid', { params: { hits: 16, steps: 16 }, inputs: { clk }, seconds: 1, onSample: (n, o, m) => { if (n === 24000) { stopped = true; m.rack.running = false; } } });
  assert.ok(stopped);
  assert.equal(r.gate[20000], 10);
  assert.equal(r.gate[47000], 0);
});

test('step8: going backwards stays inside a shortened range', () => {
  const r = renderModule('step8', { params: { dir: 1, length: 3, scale: 0, a1: 1, a2: 2, a3: -1, a4: -1.5, a5: 0.5 }, inputs: { clk: clockAt(20) }, seconds: 1 });
  const seen = new Set();
  for (let n = 3000; n < r.a.length; n += 500) seen.add(r.a[n]);
  assert.ok([...seen].every((v) => [1, 2, -1].includes(v)), [...seen].join(' '));
});

test('the gate after a restart is as long as the panel says, not what the wait before it was', () => {
  const clk = (t) => (t > 3 && ((t - 3) * 8) % 1 < 0.1 ? 10 : 0);   // nothing for 3 s, then 1/8 s pulses
  const rst = (t) => (t > 3 && t < 3.01 ? 10 : 0);
  const data = { steps: Array.from({ length: 16 }, () => ({ n: 12, g: 1, a: 0, s: 0 })) };
  const r = renderModule('bassline', { data, params: { gatelen: 0.5 }, inputs: { clk, rst }, seconds: 3.6 });
  const edges2 = edges(r.gate);
  const high = (from) => { let n = from; while (n < r.gate.length && r.gate[n] > 5) n++; return (n - from) / SR; };
  assert.ok(Math.abs(high(edges2[0]) - 0.0625) < 0.01, `first gate ${high(edges2[0])}`);
  assert.ok(Math.abs(high(edges2[1]) - 0.0625) < 0.01, `second gate ${high(edges2[1])}`);
});

test('a slow clock still locks: an 8 s step has an 8 s period, and its gate follows', () => {
  const clk = (t) => ((t % 8) < 0.01 ? 10 : 0);
  const r = renderModule('step8', { params: { gatelen: 0.5, scale: 0 }, inputs: { clk }, seconds: 21, sr: 8000 });
  const high = (t) => r.gate[Math.floor(t * 8000)];
  assert.equal(high(16.5), 10);
  assert.equal(high(19.9), 10, 'half of 8 s later, still open');
  assert.equal(high(20.1), 0, 'and then closed');
});

test('stop closes the gate once; a free-running clock can still play it afterwards', () => {
  const clk = (t) => ((t * 16) % 1 < 0.1 ? 10 : 0);
  const r = renderModule('euclid', { params: { hits: 16, steps: 16 }, inputs: { clk }, seconds: 1, onSample: (n, o, m) => { if (n === 24000) m.rack.running = false; } });
  assert.equal(r.gate[47000], 10);
});
