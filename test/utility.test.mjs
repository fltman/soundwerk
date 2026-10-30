// The desk, the master and the small boxes, against what their panels say.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, rms, peak, bandLevel, db } from './lib/dsp.mjs';

const sine = (a, hz = 440) => (t) => a * Math.sin(2 * Math.PI * hz * t);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) < tol, `${msg ?? ''} ${a} vs ${b}`);

test('master: ±10 V is full scale and everything under the ceiling is untouched', () => {
  const r = renderModule('master', { params: { volume: 1 }, inputs: { l: sine(8) }, seconds: 1 });
  const y = r.outL;
  near(peak(y, 24000), 0.8, 0.002, 'peak');
  // no harmonics: the master is clean until a peak reaches the ceiling
  const f = 440;
  const fund = bandLevel(y, 48000, f - 20, f + 20, 32768);
  for (const n of [2, 3, 5]) {
    const h = db(bandLevel(y, 48000, f * n - 20, f * n + 20, 32768) / fund);
    assert.ok(h < -90, `harmonic ${n} at ${h.toFixed(1)} dB`);
  }
});

test('master: nothing passes the ceiling, however hot, and it recovers', () => {
  const hot = renderModule('master', { params: { volume: 1.5 }, inputs: { l: sine(12), r: sine(11, 330) }, seconds: 0.5 });
  assert.ok(peak(hot.outL) <= 0.9501 && peak(hot.outR) <= 0.9501, `${peak(hot.outL)}`);
  const burst = renderModule('master', { params: { volume: 1 }, inputs: { l: (t) => (t < 0.1 ? sine(12)(t) : sine(4)(t)) }, seconds: 0.8 });
  near(peak(burst.outL, 30000), 0.4, 0.01, 'back to unity after the burst');
});

test('master: a lone L goes to both sides', () => {
  const r = renderModule('master', { params: { volume: 1 }, inputs: { l: sine(4) }, seconds: 0.2 });
  near(rms(r.outR, 4800), rms(r.outL, 4800), 1e-6);
});

test('desk: an equal-power pan, levels, mutes, and sends that ignore the fader', () => {
  const on = (over) => renderModule('desk', { params: { lvl1: 1, ...over }, inputs: { ch1: sine(5) }, seconds: 0.2 });
  const c = on({ pan1: 0 });
  near(rms(c.l), rms(c.r), 1e-6);
  near(rms(c.l), rms(renderModule('vca', { inputs: { in: sine(5) }, seconds: 0.2 }).out.out), 0.01, 'unity at centre');
  const left = on({ pan1: -1 });
  near(rms(left.r), 0, 1e-6, 'hard left');
  near(rms(left.l) ** 2, 2 * rms(c.l) ** 2, 0.05, 'constant power');
  near(rms(on({ mute1: 1 }).l), 0, 1e-9, 'mute');
  const send = on({ a1: 1, b1: 0.5, lvl1: 0 });
  near(rms(send.l), 0, 1e-9, 'fader down');
  near(rms(send.sendA), rms(c.l), 0.01, 'pre-fader');
  near(rms(send.sendB), rms(c.l) / 2, 0.01);
});

test('desk: both returns come back, and a lone left return is mono', () => {
  const r = renderModule('desk', { params: { ret: 1, ret2: 0.5 }, inputs: { retL: sine(4), ret2L: sine(4, 700) }, seconds: 0.2 });
  near(rms(r.l), rms(r.r), 1e-6);
  near(rms(r.l) ** 2, (4 ** 2 + 2 ** 2) / 2, 0.1, 'sum of both');
});

test('vca: linear, a cable of 10 V is unity, and unpatched it is just a level knob', () => {
  const half = renderModule('vca', { inputs: { in: sine(4), cv: 5 }, seconds: 0.1 });
  near(rms(half.out.out), 2 / Math.SQRT2, 0.02);
  near(rms(renderModule('vca', { inputs: { in: sine(4) }, params: { level: 0.5 }, seconds: 0.1 }).out.out), 2 / Math.SQRT2, 0.02);
  near(peak(renderModule('vca', { inputs: { in: sine(4), cv: 0 }, seconds: 0.1 }).out.out), 0, 1e-12, 'closed');
  const exp = renderModule('vca', { inputs: { in: sine(4), cv: 5 }, params: { curve: 1 }, seconds: 0.1 });
  near(rms(exp.out.out), (4 * 0.125) / Math.SQRT2, 0.01, 'exp');
});

test('crossfade: equal power at the centre, one side at each end', () => {
  const at = (mix) => rms(renderModule('crossfade', { inputs: { a: sine(4), b: sine(4, 777) }, params: { mix }, seconds: 0.2 }).out.out);
  near(at(0), at(1), 0.02);
  near(at(0.5), at(0), 0.03, 'constant power with unrelated signals');
});

test('offset: scale and offset, and with no cable a hand-set voltage', () => {
  const r = renderModule('offset', { inputs: { in1: 2 }, params: { s1: -0.5, o1: 3, o2: 1.25 }, seconds: 0.01 });
  near(r.out1[100], 2, 1e-9);
  near(r.out2[100], 1.25, 1e-9);
});

test('logic: the truth table', () => {
  const table = [[0, 0], [10, 0], [0, 10], [10, 10]];
  const got = table.map(([a, b]) => {
    const r = renderModule('logic', { inputs: { a, b }, seconds: 0.001 });
    return [r.and[10], r.or[10], r.xor[10], r.not[10]].map((v) => (v ? 1 : 0)).join('');
  });
  assert.deepEqual(got, ['0001', '0110', '0111', '1100']);
});

test('switch: steps through its inputs, and reset goes home', () => {
  const r = renderModule('seqswitch', { inputs: { in1: 1, in2: 2, in3: 3, in4: 4, clk: (t) => ((t * 10) % 1 < 0.1 ? 10 : 0) }, params: { steps: 3 }, seconds: 0.5 });
  const seen = [0.05, 0.15, 0.25, 0.35].map((t) => r.out.out[Math.floor(t * 48000)]);
  assert.deepEqual(seen, [2, 3, 1, 2]);
});

test('compare: a sine turns into a square at its threshold, with hysteresis against chatter', () => {
  const r = renderModule('compare', { inputs: { in: sine(5, 100) }, params: { thresh: 0 }, seconds: 0.5 });
  const on = r.gate.reduce((s, v) => s + (v > 5 ? 1 : 0), 0) / r.gate.length;
  near(on, 0.5, 0.02);
  assert.equal(r.trig.reduce((s, v, i) => s + (v > 5 && !(r.trig[i - 1] > 5) ? 1 : 0), 0), 50);
});

test('pan: equal power and hard to each side', () => {
  const c = renderModule('panner', { inputs: { in: sine(4) }, seconds: 0.1 });
  near(rms(c.l), 4 / Math.SQRT2, 0.03);
  near(rms(renderModule('panner', { inputs: { in: sine(4) }, params: { pan: -1 }, seconds: 0.1 }).r), 0, 1e-6);
});

test('mixer: sums, and INV is the same signal upside down', () => {
  const r = renderModule('mixer', { inputs: { in1: 1, in2: 2 }, params: { l1: 1, l2: 0.5, main: 1 }, seconds: 0.01 });
  near(r.out.out[10], 2, 1e-9);
  near(r.inv[10], -2, 1e-9);
});

test('audio in reads the interface, without its DC', () => {
  const r = renderModule('audioin', { seconds: 0.5 });
  assert.ok(rms(r.l, 12000) > 0.5, 'the 0.2 test tone arrives at about a volt');
});

test('scope: finishes frames, triggers on the level, holds in NORM with no signal', () => {
  const trig = renderModule('scope', { inputs: { a: sine(5, 100) }, params: { time: 0.56 }, seconds: 1 });
  assert.ok(trig.ui[2] > 5, `${trig.ui[2]} frames`);
  const none = renderModule('scope', { params: { mode: 1 }, seconds: 1 });
  assert.equal(none.ui[2], 0, 'NORM waits for a trigger');
  const auto = renderModule('scope', { params: { mode: 0 }, seconds: 1 });
  assert.ok(auto.ui[2] > 0, 'AUTO free-runs');
  // two runs of the same patch trigger at the same place on the wave: rising through 0 V
  const w = trig.wave;
  assert.ok(Math.abs(w[0]) < 0.2, `first sample ${w[0]}`);
  assert.ok(w[40] > w[0], 'rising');
});

test('switch: a reset landing on a clock starts on input 1', () => {
  const r = renderModule('seqswitch', { inputs: { in1: 1, in2: 2, in3: 3, in4: 4, clk: (t) => ((t * 10) % 1 < 0.1 ? 10 : 0), rst: (t) => (t < 0.01 ? 10 : 0) }, seconds: 0.5 });
  assert.deepEqual([0.05, 0.15, 0.25, 0.35].map((t) => r.out.out[Math.floor(t * 48000)]), [1, 2, 3, 4]);
});

test('scope: the beam position moves through a sweep, so a slow timebase is live, not late', () => {
  // 0.8 on the knob is about 38 ms/div, a 0.38 s sweep
  const seen = new Set();
  renderModule('scope', {
    inputs: { a: sine(5, 100) }, params: { time: 0.8 }, seconds: 0.3,
    onSample: (n, o, m) => { if (n % 480 === 0) seen.add(m.ui[3]); },
  });
  assert.ok(seen.size > 20, `the beam was seen in ${seen.size} places in 300 ms`);
});
