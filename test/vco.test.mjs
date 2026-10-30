// The VCO against what an oscillator should do, measured from outside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, pitchHz, bandLevel, spectrum, rms, mean } from './lib/dsp.mjs';

const cents = (a, b) => 1200 * Math.log2(a / b);

test('1 V/oct: every octave lands on the right pitch', () => {
  for (const v of [-4, -3, -2, -1, 0, 1, 2, 3]) {
    const r = renderModule('vco', { inputs: { pitch: v }, seconds: 1.5 });
    const want = 261.6255653 * 2 ** v;
    const got = pitchHz(r.sine, r.sr);
    assert.ok(Math.abs(cents(got, want)) < 0.5, `${v} V: ${got.toFixed(3)} Hz, want ${want.toFixed(3)}`);
  }
});

test('the saw has the harmonic series of a saw, at the right level', () => {
  const r = renderModule('vco', { inputs: { pitch: -1 }, seconds: 2 }); // 130.8 Hz
  const f = 130.8128;
  for (const n of [1, 2, 3, 5, 8]) {
    const got = bandLevel(r.saw, r.sr, f * n - 20, f * n + 20);
    const want = (5 * 2) / (Math.PI * n);
    assert.ok(Math.abs(got / want - 1) < 0.03, `harmonic ${n}: ${got.toFixed(3)}, want ${want.toFixed(3)}`);
  }
});

test('high notes stay band-limited: alias products are far below the fundamental', () => {
  const f = 261.6255653 * 2 ** 3.5; // about 2960 Hz, where a naive saw aliases badly
  const r = renderModule('vco', { inputs: { pitch: 3.5 }, seconds: 2 });
  const s = spectrum(r.saw, r.sr);
  let worst = 0;
  for (let k = 5; k < s.mag.length; k++) {
    const hz = k * s.binHz;
    const near = Math.abs(hz / f - Math.round(hz / f)) * f;
    if (near > 40) worst = Math.max(worst, s.mag[k]);
  }
  const fund = bandLevel(r.saw, r.sr, f - 30, f + 30);
  assert.ok(20 * Math.log10(worst / fund) < -38, `worst alias ${(20 * Math.log10(worst / fund)).toFixed(1)} dB`);
});

test('pulse width sets the duty cycle, and the outputs sit on 0 V', () => {
  const r = renderModule('vco', { params: { pw: 0.25 }, seconds: 1 });
  const high = r.pulse.reduce((a, v) => a + (v > 0 ? 1 : 0), 0) / r.pulse.length;
  assert.ok(Math.abs(high - 0.25) < 0.01, `duty ${high}`);
  for (const name of ['saw', 'tri', 'sine']) assert.ok(Math.abs(mean(r[name])) < 0.05, `${name} DC`);
  assert.ok(Math.abs(rms(r.tri) - 5 / Math.sqrt(3)) < 0.25, `triangle level ${rms(r.tri)}`);
});

test('the alias bar is measured, and a naive saw fails it', (t) => {
  // the detector first: the same measurement on a naive saw has to read as bad
  const sr = 48000, f = 261.6255653 * 2 ** 3.5, n = sr * 2, naive = new Float64Array(n);
  for (let k = 0; k < n; k++) naive[k] = 5 * (2 * ((k * f / sr) % 1) - 1);
  const worst = (x) => {
    const s = spectrum(x, sr);
    let w = 0;
    for (let k = 5; k < s.mag.length; k++) {
      const hz = k * s.binHz;
      if (Math.abs(hz / f - Math.round(hz / f)) * f > 40) w = Math.max(w, s.mag[k]);
    }
    return 20 * Math.log10(w / bandLevel(x, sr, f - 30, f + 30));
  };
  const bad = worst(naive);
  assert.ok(bad > -25, `the detector missed a naive saw: ${bad.toFixed(1)} dB`);
  const r = renderModule('vco', { inputs: { pitch: 3.5 }, seconds: 2 });
  const got = { saw: worst(r.saw), pulse: worst(r.pulse), tri: worst(r.tri) };
  t.diagnostic(`alias at 2960 Hz: naive ${bad.toFixed(1)}, saw ${got.saw.toFixed(1)}, pulse ${got.pulse.toFixed(1)}, tri ${got.tri.toFixed(1)} dB`);
  assert.ok(got.saw < -38 && got.pulse < -38, JSON.stringify(got));
  assert.ok(got.tri < -60, `triangle alias ${got.tri}`);
});

test('the triangle has no DC at the start, and the shape and level of a triangle', () => {
  const r = renderModule('vco', { inputs: { pitch: -1 }, seconds: 1 }); // 130.8 Hz
  const period = Math.round(48000 / 130.8128);
  assert.ok(Math.abs(mean(r.tri, 0, period)) < 0.02, `first period DC ${mean(r.tri, 0, period)}`);
  assert.ok(Math.abs(mean(r.tri, 0, 4800)) < 0.02, `first 100 ms DC ${mean(r.tri, 0, 4800)}`);
  let hi = 0, lo = 0;
  for (let k = 0; k < r.tri.length; k++) { hi = Math.max(hi, r.tri[k]); lo = Math.min(lo, r.tri[k]); }
  assert.ok(Math.abs(hi - 5) < 0.1 && Math.abs(lo + 5) < 0.1, `triangle runs ${lo}..${hi}`);
  // harmonics of a triangle: odd only, falling as 1/n²
  const f = 130.8128, one = bandLevel(r.tri, r.sr, f - 20, f + 20);
  assert.ok(Math.abs(one - (8 * 5) / Math.PI ** 2) < 0.1, `fundamental ${one}`);
  for (const n of [3, 5, 7]) {
    const got = bandLevel(r.tri, r.sr, f * n - 20, f * n + 20) / one;
    assert.ok(Math.abs(got * n * n - 1) < 0.05, `harmonic ${n}: ${got}`);
  }
  assert.ok(bandLevel(r.tri, r.sr, 2 * f - 20, 2 * f + 20) / one < 0.002, 'even harmonic in the triangle');
});

test('the sub is a square one octave down, in phase with the saw', () => {
  const r = renderModule('vco', { inputs: { pitch: -1 }, seconds: 2 });
  const f = 130.8128 / 2, got = pitchHz(r.sub, r.sr);
  assert.ok(Math.abs(cents(got, f)) < 0.5, `sub at ${got} Hz`);
  assert.ok(Math.abs(rms(r.sub) - 5) < 0.2, `sub level ${rms(r.sub)}`);
  assert.ok(Math.abs(mean(r.sub)) < 0.05, `sub DC ${mean(r.sub)}`);
  const one = bandLevel(r.sub, r.sr, f - 15, f + 15);
  assert.ok(Math.abs(one - 20 / Math.PI) < 0.15, `sub fundamental ${one}`);
  assert.ok(bandLevel(r.sub, r.sr, f * 3 - 15, f * 3 + 15) / one > 0.3, 'not square: no third harmonic');
  assert.ok(bandLevel(r.sub, r.sr, f * 2 - 15, f * 2 + 15) / one < 0.01, 'not square: even harmonic');
});

test('FM is exponential: 1 V at full amount is exactly one octave up, and never below zero Hz', () => {
  const r = renderModule('vco', { params: { fmAmt: 1 }, inputs: { pitch: -1, fm: 1 }, seconds: 1 });
  assert.ok(Math.abs(cents(pitchHz(r.sine, r.sr), 261.6255653)) < 0.5);
  // a big negative FM swing only slows it down: between wraps the saw only ever rises
  const s = renderModule('vco', { params: { fmAmt: 1 }, inputs: { pitch: -1, fm: (t) => 4 * Math.sin(2 * Math.PI * 3 * t) }, seconds: 0.5 });
  const near = new Uint8Array(s.saw.length);
  let edges = 0;
  for (let k = 4; k < s.saw.length; k++) {
    if (s.saw[k] - s.saw[k - 4] < -3) { edges++; near.fill(1, Math.max(0, k - 24), k + 24); }
  }
  assert.ok(edges > 10, `only ${edges} wraps in the test`);
  let backwards = 0, checked = 0;
  for (let k = 1; k < s.saw.length; k++) {
    if (near[k]) continue;
    checked++;
    if (s.saw[k] < s.saw[k - 1] - 1e-9) backwards++;
  }
  assert.ok(checked > 5000, `only ${checked} samples checked`);
  assert.equal(backwards, 0);
});

test('hard sync locks to a real master and stays band-limited', (t) => {
  const master = 261.6255653, sr = 48000;
  // a band-limited master, as it would be on the wall. A naive gate has no timing between samples.
  const lead = renderModule('vco', { seconds: 1.5 }).pulse;
  assert.equal(lead.length, 72000);
  const r = renderModule('vco', { params: { tune: 7, fine: 0.3 }, inputs: { pitch: 0, sync: (x, n) => lead[n] }, seconds: 1.5 });
  const s = spectrum(r.saw, sr);
  // every line must sit on a harmonic of the master, whatever the slave's own pitch
  let off = 0;
  for (let k = 5; k * s.binHz < 18000; k++) {
    const hz = k * s.binHz;
    if (Math.abs(hz / master - Math.round(hz / master)) * master > 25) off = Math.max(off, s.mag[k]);
  }
  const dB = 20 * Math.log10(off / Math.max(...s.mag));
  t.diagnostic(`sync: strongest line off the master's series ${dB.toFixed(1)} dB`);
  assert.ok(dB < -50, `${dB}`);
});

test('PWM from an LFO leaves no DC thump on the pulse', () => {
  const r = renderModule('vco', { inputs: { pitch: -1, pw: (t) => 4 * Math.sin(2 * Math.PI * 2 * t) }, depth: { pw: 1 }, seconds: 2 });
  assert.ok(bandLevel(r.pulse, r.sr, 1, 8) < 0.1, `PWM thump ${bandLevel(r.pulse, r.sr, 1, 8)}`);
});

test('the VCO runs at every sample rate, on pitch', () => {
  for (const sr of [22050, 44100, 96000]) {
    const r = renderModule('vco', { inputs: { pitch: 1 }, seconds: 1, sr });
    assert.ok(Math.abs(cents(pitchHz(r.sine, sr), 523.2511306)) < 0.5, `sr ${sr}`);
    assert.ok(Math.abs(mean(r.saw)) < 0.05, `saw DC at ${sr}: ${mean(r.saw)}`);
  }
});
