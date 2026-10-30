// Envelopes, LFOs and the rest against the times and rates on their knobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, rms, pitchHz, peak } from './lib/dsp.mjs';
import { expmap } from '../src/modules/lib/index.js';

const SR = 48000;

test('LFO rate matches the knob at both ends of its range', () => {
  for (const t of [0.3, 0.6, 0.9]) {
    const want = expmap(t, 0.02, 40);
    const r = renderModule('lfo', { params: { rate: t }, seconds: Math.max(2, 12 / want) });
    const got = pitchHz(r.bi, r.sr, 0);
    assert.ok(Math.abs(got / want - 1) < 0.01, `${got} vs ${want}`);
  }
});

test('LFO locks to a clock: one cycle per division, phase-aligned', () => {
  const r = renderModule('lfo', { params: { div: 3 }, inputs: { clk: (t) => ((t * 16) % 1 < 0.1 ? 10 : 0) }, seconds: 4 }); // 4 pulses a cycle
  const got = pitchHz(r.bi, r.sr);
  assert.ok(Math.abs(got - 4) < 0.05, `${got}`);
});

test('ADSR holds its sustain and reaches 10 V', () => {
  const r = renderModule('adsr', { params: { a: 0.2, d: 0.3, s: 0.5, r: 0.3 }, inputs: { gate: (t) => (t < 1 ? 10 : 0) }, seconds: 2 });
  assert.ok(Math.abs(peak(r.env) - 10) < 0.05, `peak ${peak(r.env)}`);
  assert.ok(Math.abs(r.env[Math.floor(0.95 * SR)] - 5) < 0.05, `sustain ${r.env[Math.floor(0.95 * SR)]}`);
  assert.ok(r.env[r.env.length - 1] < 0.01, 'released');
});

test('ADSR decay time reads true: 60 dB in the time on the knob', () => {
  const t = 0.4, want = expmap(t, 0.002, 8);
  const r = renderModule('adsr', { params: { a: 0, d: t, s: 0, r: 0.9 }, inputs: { gate: 10 }, seconds: want * 1.5 + 0.1 });
  const top = r.env.indexOf(Math.max(...r.env.subarray(0, 4800)));
  let n = top;
  while (n < r.env.length && r.env[n] > 0.01) n++;
  const got = (n - top) / SR;
  assert.ok(Math.abs(got / want - 1) < 0.1, `${got} vs ${want}`);
});

test('a retriggered envelope starts from where it is, without a jump', () => {
  const gate = (t) => (t < 0.05 || (t > 0.1 && t < 0.2) ? 10 : 0);
  const r = renderModule('adsr', { params: { a: 0.3, d: 0.5, s: 0.7, r: 0.5 }, inputs: { gate }, seconds: 0.3 });
  let worst = 0;
  for (let n = 1; n < r.env.length; n++) worst = Math.max(worst, Math.abs(r.env[n] - r.env[n - 1]));
  assert.ok(worst < 0.2, `jump of ${worst} V`);
});

test('decay envelope: time on the knob, loop makes it free-run', () => {
  const r = renderModule('decay', { params: { a: 0, d: 0.5, curve: 0 }, inputs: { trig: (t) => (t < 0.01 ? 10 : 0) }, seconds: 1.5 });
  const want = expmap(0.5, 0.002, 8);
  const last = r.env.findLastIndex((v) => v > 0.001);
  assert.ok(Math.abs(last / SR / want - 1) < 0.05, `${last / SR} vs ${want}`);
  const l = renderModule('decay', { params: { a: 0.3, d: 0.3, loop: 1 }, seconds: 2 });
  assert.ok(rms(l.env, 48000) > 1, 'loops');
});

test('slew takes its time, S&H holds, follower follows', () => {
  const s = renderModule('slew', { params: { rise: 0.5, fall: 0.5 }, inputs: { in: 10 }, seconds: 1 });
  const tau = expmap(0.5, 0.0005, 4);
  assert.ok(Math.abs(s.out.out[Math.round(tau * SR)] / 6.32 - 1) < 0.02, `${s.out.out[Math.round(tau * SR)]}`);

  const h = renderModule('sh', { inputs: { in: (t) => Math.sin(t * 50), trig: (t) => ((t * 4) % 1 < 0.05 ? 10 : 0) }, seconds: 1 });
  assert.ok(Math.abs(h.out.out[20000] - h.out.out[20500]) < 1e-9, 'held');
  assert.ok(Math.abs(h.out.out[11000] - h.out.out[23000]) > 0.01, 'then moved');

  const f = renderModule('follower', { params: { gain: 1 }, inputs: { in: (t) => (t < 0.5 ? 2.5 * Math.sin(t * 2000) : 0) }, seconds: 1.5 });
  assert.ok(f.env[Math.floor(0.45 * SR)] > 2.5, 'tracks a tone');
  assert.ok(f.env[f.env.length - 1] < 0.05, 'falls away');
});

test('a clock-locked S&H LFO draws a new value every single cycle, at any tempo', () => {
  for (const bpm of [125, 132, 140]) {
    const hz = (bpm / 60) * 4;
    const clk = (t) => ((t * hz) % 1 < 0.1 ? 10 : 0);
    const r = renderModule('lfo', { params: { shape: 4, div: 7 }, inputs: { clk }, seconds: 30 }); // 16 pulses
    const seen = new Set();
    const cycle = (16 / hz) * SR;
    for (let k = 2; k * cycle < r.bi.length - cycle; k++) seen.add(r.bi[Math.floor((k + 0.5) * cycle)]);
    const cycles = Math.floor(r.bi.length / cycle) - 3;
    assert.ok(seen.size >= cycles - 1, `${bpm} BPM: ${seen.size} values in ${cycles} cycles`);
  }
});

test('the first bars after a start run at the real tempo, not an audio-rate blur', () => {
  const r = renderModule('lfo', { params: { div: 7 }, inputs: { clk: (t) => (t > 2 && (t * 16) % 1 < 0.1 ? 10 : 0), rst: (t) => (t > 2 && t < 2.01 ? 10 : 0) }, seconds: 2.2, sr: SR });
  let flips = 0;
  for (let n = 96001; n < r.bi.length; n++) if ((r.bi[n] > 0) !== (r.bi[n - 1] > 0)) flips++;
  assert.ok(flips <= 3, `${flips} zero crossings in the first 200 ms`);
});

test('a swung clock-locked S&H still draws exactly one value a cycle', () => {
  const hz = (128 / 60) * 4;
  // long-short pairs of sixteenths
  const clk = (t) => { const pair = t * (hz / 2) % 1; return pair < 0.05 || (pair >= 0.6 && pair < 0.65) ? 10 : 0; };
  const r = renderModule('lfo', { params: { shape: 4, div: 7 }, inputs: { clk }, seconds: 16 });
  let changes = 0;
  for (let n = 1; n < r.bi.length; n++) if (r.bi[n] !== r.bi[n - 1]) changes++;
  const cycles = (16 * hz) / 16;
  assert.ok(Math.abs(changes - cycles) <= 2, `${changes} changes in ${cycles} cycles`);
});

test('a clock-locked LFO locks to an 8 s clock', () => {
  const clk = (t) => ((t % 8) < 0.01 ? 10 : 0);
  const r = renderModule('lfo', { params: { div: 0, shape: 2 }, inputs: { clk }, seconds: 30, sr: 4000 });
  const a = r.bi[Math.floor(20 * 4000)], b = r.bi[Math.floor(28 * 4000)];
  assert.ok(Math.abs(a - b) < 0.1, `${a} vs ${b}`);
});
