// The voices against what they should do, measured from outside: the acid box against the
// circuit's own transfer function and the hardware's published behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, pitchHz, peakHz, bandLevel, spectrum, rms, peak, mean, db } from './lib/dsp.mjs';
import { getDef } from '../src/modules/index.js';
import * as lib from '../src/modules/lib/index.js';

const C4 = 261.6255653005986, SR = 48000;
const cents = (a, b) => 1200 * Math.log2(a / b);
// A module's jack called `out` is r.out.out: r.out itself is the map of every jack, and has no length.
const outOf = (r) => { const y = r.out.out; assert.ok(y?.length > 0, 'no samples rendered'); return y; };

// ── the reference: solved by hand from the circuit, sharing nothing with the module ─────
// The ladder's four caps, the first half the size of the rest, give y4/y0 = 1 / D(p) with p = s/b:
// D(p) = p⁴/2 + 4p³ + 10p² + 8p + 1. It rings at p = j√2, where D = -17, so feedback 17 is critical.
// The feedback goes through a 150 Hz highpass and the output is 2(1 + r) y4.
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const scale = (a, s) => [a[0] * s, a[1] * s];
const horner = (c, x) => c.reduce((y, k) => add(mul(y, x), [k, 0]), [0, 0]);
const D = [0.5, 4, 10, 8, 1];
const taper = (reso) => (1 - Math.exp(-3 * reso)) / (1 - Math.exp(-3));

function ladderGain(f, fc, r, hp = 150) {
  const p = [0, (f / fc) * Math.SQRT2], j = [0, f / hp];
  const fb = scale(div(j, add(j, [1, 0])), 17 * r);
  const d = add(horner(D, p), fb);
  return (2 * (1 + r)) / Math.hypot(d[0], d[1]);
}

// Closed-loop poles by Durand-Kerner on D(p)(p + a) + 17 r p = 0, a = √2 × 150 / fc. Returns the
// strongest ring: its frequency in Hz, and its time to fall 60 dB.
function ringOf(fc, r, hp = 150) {
  const a = (Math.SQRT2 * hp) / fc, b = (2 * Math.PI * fc) / Math.SQRT2;
  const c = [1, 8 + a, 20 + 8 * a, 16 + 20 * a, 2 + 16 * a + 34 * r, 2 * a]; // doubled, so it's monic
  let z = Array.from({ length: 5 }, (_, k) => mul([0.8, 0.5], k === 0 ? [1, 0] : [Math.cos(k * 1.3), Math.sin(k * 1.3)]));
  for (let it = 0; it < 400; it++) {
    z = z.map((zi, i) => {
      let q = [1, 0];
      z.forEach((zj, j) => { if (j !== i) q = mul(q, sub(zi, zj)); });
      return sub(zi, div(horner(c, zi), q));
    });
  }
  const pole = z.filter((x) => x[1] > 0.1).sort((x, y) => y[0] - x[0])[0];
  return { hz: (pole[1] * b) / (2 * Math.PI), t60: 6.907755 / (-pole[0] * b) };
}

// The knob's real cutoff once the envelope has died: Open303's mapping, written out here
const knobV = (c) => Math.log2(313.8152786 / C4) + c * Math.log2(2394.411987 / 313.8152786);
const restingFc = (c, e = 0) => {
  const s = (1 - c) * (3.773996325 * e + 0.736965594) + c * (4.194548788 * e + 0.864344901);
  return C4 * 2 ** (knobV(c) - s * (0.048292931 * c + 0.294391201));
};

// A very low saw is a comb of harmonics of known level: H(f) read off them, 1/n undone.
function combOf(params, f0 = 20, { sr = SR, def } = {}) {
  const r = renderModule('acid', { def, sr, params: { envMod: 0, decay: 0, ...params }, inputs: { pitch: Math.log2(f0 / C4), gate: 10 }, seconds: 2.6 });
  const s = spectrum(outOf(r), sr, 65536, Math.round(0.9 * sr));
  return (hz) => {
    const n = Math.round(hz / f0), c = Math.round((n * f0) / s.binHz);
    let e = 0;
    for (let k = c - 4; k <= c + 4; k++) e += s.mag[k] * s.mag[k];
    return Math.sqrt(e / 1.5) * n;
  };
}

// where the highest point of a comb is, between its teeth
function combPeak(m, f0, lo, hi) {
  let best = Math.round(lo / f0), top = 0;
  for (let n = Math.round(lo / f0); n * f0 <= hi; n++) if (m(n * f0) > top) { top = m(n * f0); best = n; }
  const l = db(m((best - 1) * f0)), c = db(top), r = db(m((best + 1) * f0));
  return (best + (0.5 * (l - r)) / (l - 2 * c + r)) * f0;
}
const circuitPeak = (fc, r) => {
  let at = fc, top = 0;
  for (let f = fc * 0.8; f < fc * 1.3; f += 0.25) { const g = ladderGain(f, fc, r); if (g > top) { top = g; at = f; } }
  return at;
};

// The same class with the feedback saturator taken out, through the path a fork takes. The
// circuit reference is linear, so this is what it should be held against.
function linearAcid() {
  const shaped = 'const fb = k * (f - 0.1666666667 * f * f * f);';
  const source = getDef('acid').dsp.toString();
  assert.ok(source.includes(shaped), 'the feedback line moved: update this test');
  const names = Object.keys(lib);
  // eslint-disable-next-line no-new-func
  const dsp = new Function(...names, `return (${source.replace(shaped, 'const fb = k * y4;')});`)(...names.map((k) => lib[k]));
  return { ...getDef('acid'), dsp };
}

// a tone's frequency, period by period: returns { t, hz } at each rising zero crossing
function track(y, sr, from = 0, to = y.length) {
  const at = [];
  for (let k = from + 1; k < to; k++) if (y[k - 1] < 0 && y[k] >= 0) at.push(k - 1 - y[k - 1] / (y[k] - y[k - 1]));
  return at.slice(1).map((c, k) => ({ t: (c + at[k]) / 2 / sr, hz: sr / (c - at[k]) }));
}

// spectral centroid of a slice, in Hz
function centroid(y, a, n = 4096) {
  assert.equal(n & (n - 1), 0, 'the FFT needs a power of two');
  assert.ok(a + n <= y.length, 'the window runs off the end');
  const s = spectrum(y.subarray(a, a + n), SR, n, 0);
  let w = 0, e = 0;
  for (let k = 1; k < s.mag.length; k++) { w += k * s.binHz * s.mag[k]; e += s.mag[k]; }
  return w / e;
}

// ── the reference itself ─────────────────────────────────
test('the circuit reference is what the circuit is', () => {
  // with no feedback the poles are real and spread: -2 ± 1.848 and -2 ± 0.765
  for (const p of [-0.152241, -1.234633, -2.765367, -3.847759]) {
    const d = horner(D, [p, 0]);
    assert.ok(Math.hypot(d[0], d[1]) < 1e-3, `D(${p}) = ${d}`);
  }
  // critical feedback: D(j√2) = -17
  const d = horner(D, [0, Math.SQRT2]);
  assert.ok(Math.abs(d[0] + 17) < 1e-9 && Math.abs(d[1]) < 1e-9);
  // and the pole finder finds that ring: with no highpass, on the jω axis exactly at fc
  const r = ringOf(1000, 1, 1e-6);
  assert.ok(Math.abs(cents(r.hz, 1000)) < 0.01, `${r.hz}`);
});

// ── filter ───────────────────────────────────────────────
test('acid: the filter curve is the circuit, over 70 dB', (t) => {
  let worst = 0;
  for (const [c, reso] of [[0.3, 0], [0.3, 0.3], [0.3, 0.6], [0.3, 1], [0.9, 0.6], [0.9, 1]]) {
    const fc = restingFc(c), r = taper(reso), m = combOf({ cutoff: knobV(c), reso });
    const norm = m(fc / 2) / ladderGain(Math.round(fc / 40) * 20, fc, r);
    for (const q of [0.25, 0.5, 0.71, 0.85, 1, 1.2, 1.41, 2, 3, 4, 6, 8]) {
      const hz = Math.round((fc * q) / 20) * 20;
      const err = Math.abs(db(m(hz) / norm) - db(ladderGain(hz, fc, r)));
      if (q >= 0.5) worst = Math.max(worst, err);
      assert.ok(err < 1.8, `c ${c} reso ${reso} at ${q} fc: ${err.toFixed(2)} dB off`);
    }
  }
  t.diagnostic(`worst deviation from the circuit ${worst.toFixed(2)} dB`);
});

test('acid: about 18 dB/oct over the two octaves above cutoff', (t) => {
  const rows = [];
  for (const reso of [0, 0.15, 0.3]) {
    const fc = restingFc(0.3), m = combOf({ cutoff: knobV(0.3), reso });
    const slope = (db(m(fc)) - db(m(4 * fc))) / 2;
    rows.push(`RESO ${reso}: ${slope.toFixed(1)}`);
    assert.ok(slope > 15.5 && slope < 20.5, `RESO ${reso}: ${slope} dB/oct`);
    if (reso === 0.15) assert.ok(Math.abs(slope - 18) < 1, `${slope}`);
  }
  t.diagnostic(`dB/oct, fc to 4 fc: ${rows.join(', ')}`);
});

test('acid: cutoff is accurate: the resonant peak sits where the circuit puts it', (t) => {
  let worst = 0;
  for (const c of [0, 0.25, 0.5, 0.75, 1]) {
    const fc = restingFc(c), want = circuitPeak(fc, 1), f0 = 12;
    const got = combPeak(combOf({ cutoff: knobV(c), reso: 1 }, f0, { def: linearAcid() }), f0, want * 0.8, want * 1.25);
    const err = cents(got, want);
    if (Math.abs(err) > Math.abs(worst)) worst = err;
    t.diagnostic(`knob ${c}: fc ${fc.toFixed(0)} Hz, peak at ${got.toFixed(1)}, circuit ${want.toFixed(1)} (${err.toFixed(1)} ct)`);
    assert.ok(Math.abs(err) < 25, `knob ${c}: ${err.toFixed(1)} cents`);
  }
  // and each reset's ring sits on the closed-loop pole. That is a linear idea, so the linear core
  // has to meet it. The real one starts flat of it: while the ring is loud, the saturator in the
  // loop lowers the feedback that a pole assumes.
  const fc = restingFc(1), pole = ringOf(fc, 1);
  const ringing = (def) => {
    const y = outOf(renderModule('acid', { def, params: { cutoff: knobV(1), reso: 1, envMod: 0, decay: 0, volume: 0.5 }, inputs: { pitch: Math.log2(4 / C4), gate: 10 }, seconds: 1.6 }));
    const half = Math.round(SR / pole.hz / 2), a = Math.round(1.25 * SR) + 48;
    const flat = new Float64Array(240); // 5 ms: a third of the way to -60 dB by then
    for (let k = 0; k < 240; k++) flat[k] = y[a + k] - y[a + k + half]; // doubles the ring, flattens the ramp
    const level = mean(flat);
    for (let k = 0; k < 240; k++) flat[k] -= level;
    const ring = track(flat, SR);
    assert.ok(ring.length > 5, `only ${ring.length} cycles of ring`);
    return cents(ring.length / ring.reduce((u, q) => u + 1 / q.hz, 0), pole.hz);
  };
  const linear = ringing(linearAcid()), real = ringing();
  t.diagnostic(`ring against the pole at ${pole.hz.toFixed(0)} Hz: linear core ${linear.toFixed(1)} ct, with the saturator ${real.toFixed(1)} ct`);
  assert.ok(Math.abs(linear) < 15, `linear core ${linear}`);
  assert.ok(real < 0 && real > -100, `real ring ${real}`);
});

test('acid: the sample rate changes nothing about the filter', (t) => {
  const c = 0.6, want = circuitPeak(restingFc(c), 1), f0 = 12;
  for (const sr of [44100, 96000]) {
    const got = combPeak(combOf({ cutoff: knobV(c), reso: 1 }, f0, { sr, def: linearAcid() }), f0, want * 0.8, want * 1.25);
    t.diagnostic(`sr ${sr}: ${cents(got, want).toFixed(1)} ct`);
    assert.ok(Math.abs(cents(got, want)) < 25, `sr ${sr}: ${got} vs ${want}`);
  }
});

test('acid: resonance peak height is the circuit, grows with cutoff, and the saturator only tames it', (t) => {
  const heights = [];
  for (const c of [0.3, 0.9]) {
    const fc = restingFc(c), r = taper(1), f0 = 20;
    const height = (m) => {
      let top = 0;
      for (let hz = fc * 0.8; hz < fc * 1.25; hz += f0) top = Math.max(top, m(hz));
      return db(top / m(fc * 0.5));
    };
    let top = 0;
    for (let hz = fc * 0.8; hz < fc * 1.25; hz += f0) top = Math.max(top, ladderGain(Math.round(hz / f0) * f0, fc, r));
    const reference = db(top / ladderGain(Math.round((fc * 0.5) / f0) * f0, fc, r));
    const linear = height(combOf({ cutoff: knobV(c), reso: 1 }, f0, { def: linearAcid() }));
    const real = height(combOf({ cutoff: knobV(c), reso: 1 }, f0));
    heights.push(linear);
    t.diagnostic(`knob ${c}: circuit ${reference.toFixed(1)} dB, linear core ${linear.toFixed(1)}, with the saturator ${real.toFixed(1)}`);
    assert.ok(Math.abs(linear - reference) < 1, `linear core ${linear} vs circuit ${reference}`);
    assert.ok(real <= linear + 0.2, `the saturator raised the peak: ${real} vs ${linear}`);
    assert.ok(real > linear - 3, `the saturator flattens the peak too hard: ${real} vs ${linear}`);
  }
  assert.ok(heights[1] > heights[0] + 6, 'the resonance should thin out at low cutoff');
});

test('acid: resonance stays below self-oscillation, however high', (t) => {
  for (const c of [0.6, 1]) {
    const fc = restingFc(c), want = ringOf(fc, 1);
    const y = outOf(renderModule('acid', { params: { cutoff: knobV(c), reso: 1, envMod: 0, decay: 0, volume: 0.5 }, inputs: { pitch: Math.log2(4 / C4), gate: 10 }, seconds: 1.6 }));
    // The reset also starts the loop's slow real mode, 160 ms long at 0 Hz. Differencing half a
    // ring period apart doubles the ring and leaves that mode as a constant, which peak to peak ignores.
    const period = Math.round(SR / want.hz), half = Math.round(period / 2), a = Math.round(1.25 * SR);
    const swing = (k) => {
      let hi = -Infinity, lo = Infinity;
      for (let n = a + k; n < a + k + period; n++) { const v = y[n] - y[n + half]; hi = Math.max(hi, v); lo = Math.min(lo, v); }
      return hi - lo;
    };
    // late enough to be linear, early enough to stay above the noise of the ramp
    const from = Math.round(0.006 * SR), to = Math.round(0.016 * SR);
    const t60 = 60 / ((db(swing(from)) - db(swing(to))) / ((to - from) / SR));
    t.diagnostic(`knob ${c}: rings ${(t60 * 1000).toFixed(1)} ms to -60 dB, the pole says ${(want.t60 * 1000).toFixed(1)} ms`);
    assert.ok(t60 > 0, 'growing: it is self-oscillating');
    assert.ok(Math.abs(Math.log2(t60 / want.t60)) < 0.45, `${t60} vs ${want.t60}`);
    // and nothing of it is left by the next reset
    assert.ok(swing(Math.round(0.2 * SR)) < 0.02 * swing(from), 'still ringing 200 ms later');
  }
});

test('acid: the bass goes as resonance comes up, as it does on the real thing', (t) => {
  const c = 0.3, fc = restingFc(c), low = combOf({ cutoff: knobV(c), reso: 0 }), high = combOf({ cutoff: knobV(c), reso: 1 });
  const tilt = (m) => db(m(60)) - db(m(fc));
  const lost = tilt(high) - tilt(low), want = db(ladderGain(60, fc, 1) / ladderGain(fc, fc, 1)) - db(ladderGain(60, fc, 0) / ladderGain(fc, fc, 0));
  t.diagnostic(`bass against the cutoff, RESO 0 to 1: ${lost.toFixed(1)} dB, circuit ${want.toFixed(1)}`);
  assert.ok(lost < -8, `${lost}`);
  assert.ok(Math.abs(lost - want) < 2.5, `${lost} vs ${want}`);
});

// ── oscillator ───────────────────────────────────────────
test('acid: 1 V/oct and TUNE land where they should', () => {
  const open = { cutoff: knobV(1), envMod: 0, reso: 0, decay: 0 };
  for (const v of [-4, -3, -2, -1, 0, 1]) {
    const r = renderModule('acid', { params: open, inputs: { pitch: v, gate: 10 }, seconds: 1.2 });
    const f = C4 * 2 ** v, got = peakHz(outOf(r), SR, f * 0.8, f * 1.2);
    assert.ok(Math.abs(cents(got, f)) < 2, `${v} V: ${got}, want ${f}`);
  }
  const r = renderModule('acid', { params: { ...open, tune: 7 }, inputs: { pitch: -2, gate: 10 }, seconds: 1.2 });
  const f = C4 * 2 ** (-2 + 7 / 12);
  assert.ok(Math.abs(cents(peakHz(outOf(r), SR, f * 0.8, f * 1.2), f)) < 2);
});

test('acid: WAVE is a saw or a square: all harmonics, or odd ones', (t) => {
  const harmonics = (wave) => {
    const v = -2, f = C4 * 2 ** v;
    const r = renderModule('acid', { params: { wave, cutoff: knobV(1), reso: 0, envMod: 0, decay: 0 }, inputs: { pitch: v, gate: 10 }, seconds: 1.2 });
    const y = outOf(r), s = spectrum(y, SR, 32768, 9600);
    const lvl = (n) => { const c = Math.round((n * f) / s.binHz); let e = 0; for (let k = c - 4; k <= c + 4; k++) e += s.mag[k] ** 2; return Math.sqrt(e / 1.5); };
    return [0, lvl(1), lvl(2), lvl(3), lvl(4), lvl(5)];
  };
  const saw = harmonics(0), sq = harmonics(1);
  const a = db(saw[2] / saw[3]), b = db(sq[2] / sq[3]), want = db((1 / 2) / (1 / 3));
  t.diagnostic(`2nd over 3rd harmonic: saw ${a.toFixed(1)} dB (ideal ${want.toFixed(1)}), square ${b.toFixed(1)} dB`);
  assert.ok(Math.abs(a - want) < 1.5, `saw ${a}`);
  assert.ok(b < a - 9, `the square has too much even harmonic: ${b}`);
  // not a perfect square: one edge is soft, and its threshold is off centre
  assert.ok(sq[2] / sq[3] > 0.02, 'the square is too perfect to be this one');
});

// ── envelopes ────────────────────────────────────────────
const oneOverE = (env, from = 0) => {
  let top = 0, at = 0;
  for (let k = from; k < env.length; k++) if (env[k] > top) { top = env[k]; at = k; }
  for (let k = at; k < env.length; k++) if (env[k] < top / Math.E) return (k - at) / SR;
  return null;
};

test('acid: the main envelope decays exponentially, 200 ms to 2 s on the knob', (t) => {
  for (const [decay, want] of [[0, 0.2], [0.5, Math.sqrt(0.4)], [1, 2]]) {
    const r = renderModule('acid', { params: { decay }, inputs: { pitch: -2, gate: 10 }, seconds: 3 });
    assert.ok(Math.abs(peak(r.env) - 10) < 0.3, `env peak ${peak(r.env)}`);
    const got = oneOverE(r.env);
    t.diagnostic(`DECAY ${decay}: time constant ${(got * 1000).toFixed(0)} ms, want ${(want * 1000).toFixed(0)}`);
    assert.ok(Math.abs(got / want - 1) < 0.05, `${got} vs ${want}`);
    // and it is exponential: the same drop in dB in each stretch
    const dB = (k) => db(r.env[Math.round(k * SR)]), s = Math.min(want, 0.9); // all inside the 3 s render
    assert.ok(3 * s < 3, 'the windows run off the end');
    const first = dB(s) - dB(s * 2), second = dB(s * 2) - dB(s * 3);
    assert.ok(Math.abs(first - second) < 0.3, `${first} vs ${second}`);
  }
});

test('acid: an accented note forces the envelope short, about 200 ms, whatever DECAY says', (t) => {
  const r = renderModule('acid', { params: { decay: 1 }, inputs: { pitch: -2, gate: 10, accent: 10 }, seconds: 2 });
  const got = oneOverE(r.env);
  t.diagnostic(`accented time constant ${(got * 1000).toFixed(0)} ms at DECAY 2 s`);
  assert.ok(Math.abs(got - 0.2) < 0.02, `${got}`);
});

test('acid: amp attack about 3 ms, soft; release about 16 ms when the gate drops', (t) => {
  // a held bright note at a pitch with many cycles per millisecond
  const tone = { wave: 1, cutoff: knobV(1), reso: 0, envMod: 0, decay: 0 };
  const off = 0.5;
  const r = renderModule('acid', { params: tone, inputs: { pitch: 1, gate: (x) => (x < off ? 10 : 0) }, seconds: 1 });
  const y = outOf(r), w = 48;
  const env = (k) => rms(y, k, k + w);
  // attack, against the level a little later
  const ref = env(960);
  let t10 = null, t90 = null;
  for (let k = 0; k < 960; k += 4) {
    if (t10 === null && env(k) > 0.1 * ref) t10 = k;
    if (t90 === null && env(k) > 0.9 * ref) t90 = k;
  }
  const rise = ((t90 - t10) / SR) * 1000;
  // release: from the gate falling to 20 dB down
  const a = Math.round(off * SR), before = env(a - w);
  let fall = null;
  for (let k = a; k < a + 4800; k += 4) if (env(k) < before * 0.1) { fall = ((k + w / 2 - a) / SR) * 1000; break; }
  t.diagnostic(`rise 10-90 ${rise.toFixed(1)} ms, down 20 dB in ${fall?.toFixed(1)} ms`);
  assert.ok(rise > 1.5 && rise < 6, `rise ${rise} ms`);
  assert.ok(fall > 11 && fall < 21, `release ${fall} ms`);
  // the very first samples must not click: no jump larger than the waveform's own
  assert.ok(peak(y, 0, 12) < 0.5, `click at the attack: ${peak(y, 0, 12)} V`);
});

test('acid: the amp holds a long note for seconds, then fades', (t) => {
  const r = renderModule('acid', { params: { wave: 1, cutoff: knobV(1), reso: 0, envMod: 0, decay: 0 }, inputs: { pitch: 0, gate: 10 }, seconds: 3 });
  // past 1 s, where the main envelope's small part in the VCA has gone
  const y = outOf(r), at = (s) => rms(y, s * SR, (s + 0.05) * SR);
  const dropA = db(at(1) / at(1.5)), dropB = db(at(1.5) / at(2));
  const tau = (0.5 * 8.686) / dropA;
  t.diagnostic(`amp time constant ${(tau * 1000).toFixed(0)} ms, ${(tau * 6.9).toFixed(2)} s to -60 dB`);
  assert.ok(Math.abs(dropA - dropB) < 0.5, 'not exponential');
  assert.ok(tau * 6.9 > 2 && tau * 6.9 < 4.5, `${tau}`);
});

// ── slide ────────────────────────────────────────────────
test('acid: slide glides through an RC of about 60 ms', (t) => {
  const low = { cutoff: knobV(0), reso: 0, envMod: 0, decay: 0, volume: 0.7 };
  const jump = 0.6;
  const r = renderModule('acid', { params: low, inputs: { pitch: (x) => (x < jump ? -2 : -1), gate: 10, slide: 10 }, seconds: 1.2 });
  const tr = track(outOf(r), SR);
  const b = Math.log2(C4 * 2 ** -1);
  // log distance left to go, against time: a straight line whose slope is 1/τ
  const pts = tr.filter((q) => q.t > jump + 0.03 && q.t < jump + 0.16).map((q) => [q.t - jump, Math.log(b - Math.log2(q.hz))]);
  assert.ok(pts.length > 5, `only ${pts.length} periods in the glide`);
  const n = pts.length, mx = pts.reduce((s, q) => s + q[0], 0) / n, my = pts.reduce((s, q) => s + q[1], 0) / n;
  let num = 0, den = 0;
  for (const q of pts) { num += (q[0] - mx) * (q[1] - my); den += (q[0] - mx) ** 2; }
  const tau = -den / num;
  const settled = tr.filter((q) => q.t > 1).map((q) => q.hz);
  t.diagnostic(`glide time constant ${(tau * 1000).toFixed(1)} ms`);
  assert.ok(Math.abs(tau - 0.06) < 0.01, `τ ${tau}`);
  assert.ok(Math.abs(cents(settled.at(-1), 2 ** b)) < 10, `lands at ${settled.at(-1)}`);
});

test('acid: with slide low the pitch steps at once', () => {
  const low = { cutoff: knobV(0), reso: 0, envMod: 0, decay: 0, volume: 0.7 };
  const jump = 0.6, y = outOf(renderModule('acid', { params: low, inputs: { pitch: (x) => (x < jump ? -2 : -1), gate: 10 }, seconds: 1 }));
  const after = track(y, SR).filter((q) => q.t > jump + 0.02 && q.t < jump + 0.1);
  assert.ok(after.length > 3, 'no periods after the step');
  for (const q of after) assert.ok(Math.abs(cents(q.hz, C4 / 2)) < 30, `${q.hz} at ${q.t}`);
});

test('acid: a tied note does not retrigger; a rising gate does', () => {
  // same gate all the way, pitch changes at 0.3 s
  const tied = renderModule('acid', { params: { decay: 0.5 }, inputs: { pitch: (x) => (x < 0.3 ? -2 : -1.5), gate: 10, slide: (x) => (x < 0.3 ? 0 : 10) }, seconds: 0.6 });
  assert.equal(tied.env.length, 0.6 * SR);
  let rising = 0, checked = 0;
  for (let k = Math.round(0.05 * SR); k < tied.env.length; k++, checked++) if (tied.env[k] > tied.env[k - 1] + 1e-9) rising++;
  assert.ok(checked > 20000);
  assert.equal(rising, 0, 'the envelope rose on a tied note');
  assert.ok(tied.env[Math.round(0.59 * SR)] < 5, 'the envelope should have kept falling');
  // the shortest gap the bassline sequencer makes, 8 samples, is a real retrigger
  const gap = Math.round(0.3 * SR);
  const again = renderModule('acid', { params: { decay: 0.5 }, inputs: { pitch: -2, gate: (x, n) => (n >= gap && n < gap + 8 ? 0 : 10) }, seconds: 0.6 });
  assert.ok(again.env[gap + 480] > 9, `no retrigger: env ${again.env[gap + 480]}`);
  assert.ok(again.env[gap - 1] < 7);
});

test('acid: the amp does not retrigger on a tied note either', (t) => {
  // the level just after the tie against a note that was on that pitch all along
  const tone = { wave: 1, cutoff: knobV(1), reso: 0, envMod: 0, decay: 0 };
  const tied = outOf(renderModule('acid', { params: tone, inputs: { pitch: (x) => (x < 0.3 ? 0 : 0.5), gate: 10 }, seconds: 0.5 }));
  const whole = outOf(renderModule('acid', { params: tone, inputs: { pitch: 0.5, gate: 10 }, seconds: 0.5 }));
  const a = rms(tied, 0.31 * SR, 0.36 * SR), b = rms(whole, 0.31 * SR, 0.36 * SR);
  t.diagnostic(`after the tie ${db(a / b).toFixed(2)} dB against an unbroken note`);
  assert.ok(Math.abs(db(a / b)) < 0.5, `${db(a / b)} dB`);
});

// ── accent ───────────────────────────────────────────────
const noteAt = (accent, params = {}) => {
  const r = renderModule('acid', { params, inputs: { pitch: -2, gate: (x) => (x < 0.12 ? 10 : 0), accent: accent ? 10 : 0 }, seconds: 0.25 });
  return outOf(r);
};

test('acid: an accented note is louder and brighter', (t) => {
  const plain = noteAt(false), hit = noteAt(true);
  const gain = db(peak(hit) / peak(plain)), body = db(rms(hit, 0, 2400) / rms(plain, 0, 2400));
  // the sweep comes through an RC, so it lands 30 to 90 ms into the note
  const bright = centroid(hit, 1440, 2048) / centroid(plain, 1440, 2048);
  t.diagnostic(`accent: peak ${gain.toFixed(1)} dB, first 50 ms ${body.toFixed(1)} dB, centroid ×${bright.toFixed(2)}`);
  assert.ok(gain > 3 && body > 3, `peak ${gain} dB, body ${body} dB`);
  assert.ok(bright > 1.15, `centroid ×${bright}`);
});

test('acid: the ACCENT knob sets how much, and at zero there is no boost', () => {
  const gain = (accentAmt) => db(rms(noteAt(true, { accentAmt, decay: 0 }), 0, 2400) / rms(noteAt(false, { accentAmt, decay: 0 }), 0, 2400));
  const none = gain(0), half = gain(0.5), full = gain(1);
  assert.ok(Math.abs(none) < 1, `at zero ${none} dB`);
  assert.ok(half > none + 2 && full > half + 1, `${none}, ${half}, ${full}`);
});

test('acid: consecutive accents stack up: the wow', (t) => {
  const step = 60 / 125 / 4;
  const run = (reso, accent) => {
    const r = renderModule('acid', {
      params: { reso, accentAmt: 1, envMod: 0.3, decay: 0.2 },
      inputs: { pitch: -2, gate: (x) => ((x % step) / step < 0.6 ? 10 : 0), accent: accent ? 10 : 0 },
      seconds: step * 8,
    });
    const y = outOf(r);
    return [0, 1, 2, 3, 4, 5].map((k) => centroid(y, Math.round(k * step * SR) + 240, 2048));
  };
  const hot = run(0.85, true), plain = run(0.85, false), dry = run(0, true);
  t.diagnostic(`centroids, Hz: accents ${hot.map((v) => v.toFixed(0))}; none ${plain.map((v) => v.toFixed(0))}; RESO 0 ${dry.map((v) => v.toFixed(0))}`);
  const lift = hot[4] / hot[0], flat = plain[4] / plain[0], thin = dry[4] / dry[0];
  t.diagnostic(`centroid note 5 / note 1: accents at high RESO ×${lift.toFixed(2)}, no accents ×${flat.toFixed(2)}, accents at RESO 0 ×${thin.toFixed(2)}`);
  assert.ok(lift > 1.12, `no build-up: ×${lift}`);
  assert.ok(lift > flat * 1.08, 'unaccented notes built up too');
  assert.ok(lift > thin, 'the wow should need resonance, the pot has two gangs');
  for (let k = 1; k < 4; k++) assert.ok(hot[k] >= hot[k - 1] * 0.98, `note ${k + 1} fell back: ${hot.map((v) => v.toFixed(0))}`);
});

test('acid: the capacitor empties again between accents', () => {
  const step = 60 / 125 / 4;
  const accent = (x) => (x < step * 2 || x > step * 10 ? 10 : 0);
  const r = renderModule('acid', { params: { reso: 0.85, accentAmt: 1 }, inputs: { pitch: -2, gate: (x) => ((x % step) / step < 0.5 ? 10 : 0), accent }, seconds: step * 11 });
  const y = outOf(r), a = centroid(y, Math.round(0 * step * SR) + 240, 2048), b = centroid(y, Math.round(10 * step * SR) + 240, 2048);
  assert.ok(Math.abs(Math.log2(a / b)) < 0.25, `first ${a}, after a rest ${b}`);
});

// ── level ────────────────────────────────────────────────
const step16 = 60 / 125 / 4;
const riff = (x) => [-2, -2, -1, -2, -2, -1.75, -2, -1.5][Math.floor(x / step16) % 8];
const gate16 = (x) => ((x % step16) / step16 < 0.5 ? 10 : 0);

test('acid: about ±5 V over the whole RESO knob, no DC', (t) => {
  const seen = [];
  for (const reso of [0, 0.3, 0.6, 0.85, 1]) {
    const y = outOf(renderModule('acid', { params: { reso }, inputs: { pitch: riff, gate: gate16 }, seconds: 3 }));
    seen.push(`${reso}: ${peak(y).toFixed(1)} V`);
    assert.ok(peak(y) > 3.5 && peak(y) < 7, `RESO ${reso}: peak ${peak(y)}`);
    assert.ok(Math.abs(mean(y)) < 0.05, `DC ${mean(y)}`);
  }
  t.diagnostic(`peaks by RESO ${seen.join(', ')}`);
});

test('acid: accents stay on the rails, however hard', () => {
  const y = outOf(renderModule('acid', { params: { reso: 1, accentAmt: 1, envMod: 1, cutoff: knobV(1), volume: 1 }, inputs: { pitch: riff, gate: gate16, accent: (x) => (Math.floor(x / step16) % 2 ? 10 : 0) }, seconds: 3 }));
  assert.ok(peak(y) < 11, `peak ${peak(y)}`);
});

test('acid: VOLUME is a clean gain below the saturator, which is subtle at full level', (t) => {
  // scale a quiet render up and subtract it from the loud one: what is left is the saturator alone
  const go = (volume) => outOf(renderModule('acid', { params: { volume }, inputs: { pitch: riff, gate: gate16 }, seconds: 1 }));
  const quiet = go(0.2), mid = go(0.8), loud = go(1);
  const residue = (a, b, gain) => { let e = 0; for (let k = 0; k < a.length; k++) e += (a[k] - b[k] * gain) ** 2; return Math.sqrt(e / a.length) / rms(a); };
  assert.equal(quiet.length, 48000);
  const atDefault = residue(mid, quiet, 16), atFull = residue(loud, quiet, 25);
  t.diagnostic(`distortion residue: ${(atDefault * 100).toFixed(2)} % at the default VOLUME (peak ${peak(mid).toFixed(1)} V), ${(atFull * 100).toFixed(2)} % at full (peak ${peak(loud).toFixed(1)} V)`);
  assert.ok(atFull > atDefault, 'the saturator should grow with level');
  assert.ok(atDefault > 0.0005 && atDefault < 0.02, `${atDefault}`);
  assert.ok(atFull < 0.05, `${atFull}`);
  // and quiet is simply quiet: a clean square law
  const a = rms(quiet), b = rms(go(0.1));
  assert.ok(Math.abs(db(a / b) - 12.04) < 0.05, `${db(a / b)}`);
});

test('acid: silent without a gate', () => {
  assert.ok(peak(outOf(renderModule('acid', { inputs: { pitch: 0 }, seconds: 0.2 }))) < 1e-6);
});

test('acid: band-limited to the top of its range', (t) => {
  const v = 1.5, f = C4 * 2 ** v;
  const y = outOf(renderModule('acid', { params: { wave: 0, cutoff: knobV(1), envMod: 0, decay: 0, reso: 0 }, inputs: { pitch: v, gate: 10 }, seconds: 1.2 }));
  const s = spectrum(y, SR, 32768, 9600);
  let w = 0;
  for (let k = 5; k * s.binHz < 20000; k++) {
    const hz = k * s.binHz;
    if (Math.abs(hz / f - Math.round(hz / f)) * f > 40) w = Math.max(w, s.mag[k]);
  }
  const dB = db(w / Math.max(...s.mag));
  t.diagnostic(`alias at ${f.toFixed(0)} Hz ${dB.toFixed(1)} dB`);
  assert.ok(dB < -60, `${dB}`);
});

// ── the real thing: the wall's own sequencer playing it ──
test('acid: the bassline sequencer plays it: ties slide, rests close, repeats retrigger, accents hit', (t) => {
  const bpm = 125, sixteenth = 60 / bpm / 4, per = Math.round(sixteenth * SR);
  const N = (n, s = 0, a = 0) => ({ n, g: 1, a, s });
  const rest = { n: 12, g: 0, a: 0, s: 0 };
  // 0 repeats 1, 2 ties into 3, then an accent, then a rest
  const steps = [N(12), N(12), N(12, 1), N(24), N(12, 0, 1), rest, N(12), rest];
  const clk = (x, n) => (n % per < 48 ? 10 : 0);
  const seq = renderModule('bassline', { data: { steps }, params: { length: 8, gatelen: 0.5 }, inputs: { clk }, seconds: sixteenth * 8 });
  assert.equal(seq.gate.length, Math.round(sixteenth * 8 * SR));
  const from = (x) => (_, n) => x[n];
  const r = renderModule('acid', { inputs: { pitch: from(seq.pitch), gate: from(seq.gate), accent: from(seq.accent), slide: from(seq.slide) }, seconds: sixteenth * 8 });
  const y = outOf(r), start = (k) => Math.round(k * per) + 2; // the first clock lands on sample 0
  // repeats retrigger
  assert.ok(r.env[start(1) + 480] > 9, `step 1 did not retrigger: ${r.env[start(1) + 480]}`);
  // the tie does not
  const before = r.env[start(3) - 2], after = r.env[start(3) + 480];
  t.diagnostic(`env over the tie ${before.toFixed(2)} → ${after.toFixed(2)} V, then ${r.env[start(4) + 480].toFixed(2)} V on the accent`);
  assert.ok(after < before, 'the tied note retriggered');
  // it glides: the same run through a dark, plain patch, so a zero crossing is one period.
  // The sequencer's C3 to C4 through a 60 ms RC is at -1 + (1 - e^(-t/τ)) volts, t after the step.
  const plain = renderModule('acid', { params: { reso: 0, envMod: 0, decay: 0, cutoff: knobV(0) }, inputs: { pitch: from(seq.pitch), gate: from(seq.gate), accent: from(seq.accent), slide: from(seq.slide) }, seconds: sixteenth * 8 });
  const gliding = track(outOf(plain), SR, start(3), start(4)).filter((q) => q.t - start(3) / SR > 0.02 && q.t - start(3) / SR < 0.06);
  assert.ok(gliding.length >= 2, `only ${gliding.length} periods in the glide`);
  for (const q of gliding) {
    const want = C4 * 2 ** (-1 + 1 - Math.exp(-(q.t - start(3) / SR) / 0.06));
    assert.ok(Math.abs(cents(q.hz, want)) < 80, `${q.hz.toFixed(1)} Hz at ${(q.t - start(3) / SR).toFixed(3)} s, want ${want.toFixed(1)}`);
  }
  assert.ok(r.env[start(4) + 480] > 9, 'the accented step did not retrigger');
  // a rest is silent, however the note before it ended
  assert.ok(rms(y, start(5) + 2400, start(6) - 240) < 0.02 * rms(y, start(4), start(4) + 2400), 'the rest is not silent');
  // the accent is louder than the note before
  assert.ok(peak(y, start(4), start(5)) > 1.3 * peak(y, start(1), start(2)), 'the accent does not stand out');
});

// ── the mono synth ───────────────────────────────────────
const held = { attack: 0, dec: 0, sustain: 1, release: 0, envAmt: 0, kbd: 0, sub: 0, pulse: 0, noise: 0, drive: 0, reso: 0 };

function monoComb(params, f0 = 20) {
  // a quiet saw, so the input stage stays linear
  const r = renderModule('mono', { params: { ...held, saw: 0.25, ...params }, inputs: { pitch: Math.log2(f0 / C4), gate: 10 }, seconds: 1.6 });
  const s = spectrum(outOf(r), SR, 65536, 9600);
  return (hz) => {
    const n = Math.round(hz / f0), c = Math.round((n * f0) / s.binHz);
    let e = 0;
    for (let k = c - 4; k <= c + 4; k++) e += s.mag[k] * s.mag[k];
    return Math.sqrt(e / 1.5) * n;
  };
}

test('mono: 1 V/oct, TUNE, and the sub an octave down', () => {
  for (const v of [-3, -2, -1, 0, 1, 2]) {
    const y = outOf(renderModule('mono', { params: { ...held, saw: 1, cutoff: 5 }, inputs: { pitch: v, gate: 10 }, seconds: 1 }));
    const f = C4 * 2 ** v, got = pitchHz(y, SR);
    assert.ok(Math.abs(cents(got, f)) < 1, `${v} V: ${got}, want ${f}`);
  }
  const y = outOf(renderModule('mono', { params: { ...held, saw: 0, sub: 1, cutoff: 5 }, inputs: { pitch: 0, gate: 10 }, seconds: 1 }));
  assert.ok(Math.abs(cents(peakHz(y, SR, 80, 200), C4 / 2)) < 1);
});

test('mono: a true 4-pole: -12 dB at cutoff and 24 dB/oct below it', (t) => {
  for (const cutoff of [-1, 0.5, 1.5]) {
    const fc = C4 * 2 ** cutoff, m = monoComb({ cutoff }, fc / 16); // so that fc is exactly a tooth
    const pass = m(fc / 8), atFc = db(m(fc) / pass), slope = (db(m(2.8 * fc)) - db(m(11.3 * fc))) / 2;
    t.diagnostic(`fc ${fc.toFixed(0)} Hz: ${atFc.toFixed(1)} dB at fc, ${slope.toFixed(1)} dB/oct`);
    assert.ok(Math.abs(atFc + 12.04) < 1, `${atFc} dB at fc`);
    assert.ok(Math.abs(slope - 24) < 1.5, `${slope} dB/oct`);
  }
});

test('mono: at full resonance it sings at the cutoff, tracking 1 V/oct', (t) => {
  let worst = 0;
  for (const cutoff of [-1, 0, 1, 2, 3]) {
    const r = renderModule('mono', { params: { ...held, saw: 0, reso: 1, cutoff }, inputs: { pitch: 0, gate: 10 }, seconds: 2 });
    const y = outOf(r), fc = C4 * 2 ** cutoff, got = pitchHz(y, SR, SR);
    const err = cents(got, fc);
    if (Math.abs(err) > Math.abs(worst)) worst = err;
    assert.ok(rms(y, SR) > 0.5, `no self-oscillation at ${fc}: ${rms(y, SR)}`);
    assert.ok(peak(y) < 11, `${peak(y)}`);
    assert.ok(Math.abs(err) < 30, `${fc} Hz: sings at ${got}, ${err.toFixed(1)} ct`);
  }
  t.diagnostic(`worst self-oscillation tuning ${worst.toFixed(1)} cents`);
});

test('mono: the resonance rises towards the top of the knob', (t) => {
  const fc = 500, cutoff = Math.log2(fc / C4);
  const height = (reso) => { const m = monoComb({ cutoff, reso }); return db(m(fc) / m(fc / 8)); };
  const a = height(0), b = height(0.5), c = height(0.85);
  t.diagnostic(`at fc: ${a.toFixed(1)}, ${b.toFixed(1)}, ${c.toFixed(1)} dB for RESO 0, 0.5, 0.85`);
  assert.ok(a < b && b < c && c > 6, `${a}, ${b}, ${c}`);
});

test('mono: resonance does not gut the level', (t) => {
  const lvl = (reso) => rms(outOf(renderModule('mono', { params: { ...held, saw: 0.8, reso, cutoff: 1 }, inputs: { pitch: -2, gate: 10 }, seconds: 1 })), 9600);
  const drop = db(lvl(0.9) / lvl(0));
  t.diagnostic(`RESO 0 to 0.9: ${drop.toFixed(1)} dB`);
  assert.ok(Math.abs(drop) < 6, `${drop}`);
});

test('mono: DRIVE leans on the wave, not on the level', (t) => {
  const go = (drive) => {
    const y = outOf(renderModule('mono', { params: { ...held, saw: 0.5, drive, cutoff: 5 }, inputs: { pitch: -1, gate: 10 }, seconds: 1 }));
    const f = C4 / 2, lvl = (n) => bandLevel(y, SR, f * n - 15, f * n + 15);
    return { level: rms(y, 9600), even: lvl(2) / lvl(3) };
  };
  const a = go(0), b = go(1);
  // a saw has 3 dB more in its 2nd harmonic than its 3rd: a saw pushed into tanh turns square, which has none
  t.diagnostic(`DRIVE 0 to 1: 2nd over 3rd ${db(a.even).toFixed(1)} to ${db(b.even).toFixed(1)} dB, level ${db(b.level / a.level).toFixed(1)} dB`);
  assert.ok(db(a.even) > 2.5, 'not a saw going in');
  assert.ok(db(b.even) < db(a.even) - 3, `${db(a.even)} → ${db(b.even)}`);
  for (const mix of [{ saw: 0, sub: 1 }, { saw: 0.3, sub: 0.3 }, { saw: 0.8, pulse: 0.3, sub: 0.5 }]) {
    const lvl = (drive) => rms(outOf(renderModule('mono', { params: { ...held, ...mix, drive, cutoff: 0.2 }, inputs: { pitch: -1, gate: 10 }, seconds: 1 })), 9600);
    assert.ok(Math.abs(db(lvl(1) / lvl(0))) < 5, `${JSON.stringify(mix)}: ${db(lvl(1) / lvl(0))} dB`);
  }
});

test('mono: ADSR times are what the panel says', (t) => {
  const tone = { ...held, saw: 1, cutoff: 5 };
  const env = (y, k, w = 240) => rms(y, Math.max(0, k - w / 2), k + w / 2);
  // attack to the top
  const attack = 0.5, wantA = 0.001 * 4000 ** attack;
  const a = outOf(renderModule('mono', { params: { ...tone, attack }, inputs: { pitch: 1, gate: 10 }, seconds: 0.5 }));
  const top = env(a, 0.4 * SR);
  let up = null;
  for (let k = 0; k < a.length; k += 8) if (env(a, k) > 0.97 * top) { up = k / SR; break; }
  // decay down to sustain
  const dec = 0.5, wantD = 0.005 * 800 ** dec, sustain = 0.25;
  const b = outOf(renderModule('mono', { params: { ...tone, dec, sustain }, inputs: { pitch: 1, gate: 10 }, seconds: 2 }));
  const peakLevel = env(b, 0.006 * SR), sus = env(b, 1.8 * SR);
  let down = null;
  for (let k = Math.round(0.006 * SR); k < b.length; k += 8) if (env(b, k) < sus + 0.05 * (peakLevel - sus)) { down = k / SR; break; }
  // release
  const release = 0.5, wantR = 0.005 * 1200 ** release, off = 0.3;
  const c = outOf(renderModule('mono', { params: { ...tone, release }, inputs: { pitch: 1, gate: (x) => (x < off ? 10 : 0) }, seconds: 1.5 }));
  const before = env(c, off * SR - 480);
  let gone = null;
  for (let k = Math.round(off * SR); k < c.length; k += 8) if (env(c, k) < 0.05 * before) { gone = k / SR - off; break; }
  t.diagnostic(`A ${(up * 1000).toFixed(0)}/${(wantA * 1000).toFixed(0)} ms, D ${(down * 1000).toFixed(0)}/${(wantD * 1000).toFixed(0)} ms, R ${(gone * 1000).toFixed(0)}/${(wantR * 1000).toFixed(0)} ms, S ${(sus / peakLevel).toFixed(3)}`);
  assert.ok(Math.abs(up / wantA - 1) < 0.2, `attack ${up}`);
  assert.ok(Math.abs(down / wantD - 1) < 0.2, `decay ${down}`);
  assert.ok(Math.abs(gone / wantR - 1) < 0.2, `release ${gone}`);
  assert.ok(Math.abs(sus / peakLevel - sustain) < 0.03, `sustain ${sus / peakLevel}`);
});

test('mono: the filter envelope sweeps up by ENV and back down by F.DEC', (t) => {
  const go = (envAmt) => outOf(renderModule('mono', { params: { ...held, saw: 1, cutoff: -0.5, envAmt, fDec: 0.5 }, inputs: { pitch: -2, gate: 10 }, seconds: 1 }));
  const up = go(5), down = go(-3), flat = go(0);
  const early = (y) => centroid(y, 240, 2048), late = (y) => centroid(y, 36000, 2048);
  t.diagnostic(`centroid early/late: up ${early(up).toFixed(0)}/${late(up).toFixed(0)}, flat ${early(flat).toFixed(0)}/${late(flat).toFixed(0)}, down ${early(down).toFixed(0)}/${late(down).toFixed(0)}`);
  assert.ok(early(up) > 1.5 * late(up), 'no sweep down');
  assert.ok(early(down) < late(down), 'a negative envelope should start dark');
  assert.ok(Math.abs(Math.log2(early(flat) / late(flat))) < 0.1, 'moved with no envelope');
});

test('mono: GLIDE takes the time it says, and none when at zero', (t) => {
  const glide = 0.7, tauWant = 0.002 * 500 ** glide, jump = 0.5;
  const base = { ...held, saw: 0, sub: 0, pulse: 0.6, pw: 0.5, cutoff: -0.3 };
  const y = outOf(renderModule('mono', { params: { ...base, glide }, inputs: { pitch: (x) => (x < jump ? -1 : 0), gate: 10 }, seconds: 1.2 }));
  const tr = track(y, SR);
  let at = null;
  const mid = Math.log2(C4 * 2 ** -1) + 1 - 1 / Math.E;
  for (const q of tr) if (q.t > jump && Math.log2(q.hz) >= mid) { at = q.t - jump; break; }
  t.diagnostic(`GLIDE: 63 % of the way in ${(at * 1000).toFixed(0)} ms, want ${(tauWant * 1000).toFixed(0)}`);
  assert.ok(Math.abs(at / tauWant - 1) < 0.2, `${at}`);
  const z = outOf(renderModule('mono', { params: { ...base, glide: 0 }, inputs: { pitch: (x) => (x < jump ? -1 : 0), gate: 10 }, seconds: 1.2 }));
  const after = track(z, SR).filter((q) => q.t > jump + 0.02 && q.t < jump + 0.1);
  assert.ok(after.length > 3, 'no periods after the step');
  for (const q of after) assert.ok(Math.abs(cents(q.hz, C4)) < 30, `${q.hz}`);
});

test('mono: PW and the mixer do what they say', () => {
  const y = outOf(renderModule('mono', { params: { ...held, saw: 0, pulse: 1, pw: 0.5, cutoff: 5 }, inputs: { pitch: -2, gate: 10 }, seconds: 1 }));
  const f = C4 / 4, lvl = (n) => bandLevel(y, SR, f * n - 15, f * n + 15);
  assert.ok(lvl(2) / lvl(1) < 0.03 && lvl(3) / lvl(1) > 0.2, 'a 50 % pulse should be odd harmonics only');
  const w = outOf(renderModule('mono', { params: { ...held, saw: 0, noise: 1, cutoff: 5 }, inputs: { pitch: -2, gate: 10 }, seconds: 1 }));
  assert.ok(rms(w, 9600) > 0.3 && bandLevel(w, SR, 4000, 12000) > 0.1, `noise ${rms(w, 9600)}`);
});

test('mono: default patch plays at about ±5 V, no DC, silent when the gate is off', (t) => {
  const y = outOf(renderModule('mono', { inputs: { pitch: riff, gate: gate16 }, seconds: 3 }));
  t.diagnostic(`default riff: peak ${peak(y).toFixed(2)} V, rms ${rms(y).toFixed(2)} V`);
  assert.ok(peak(y) > 3.5 && peak(y) < 7, `peak ${peak(y)}`);
  assert.ok(Math.abs(mean(y)) < 0.05, `DC ${mean(y)}`);
  assert.ok(peak(outOf(renderModule('mono', { inputs: { pitch: 0 }, seconds: 0.2 }))) < 1e-4);
});

test('mono: stays on pitch and on the same cutoff at every sample rate', () => {
  for (const sr of [44100, 96000]) {
    const r = renderModule('mono', { sr, params: { ...held, saw: 0, reso: 1, cutoff: 1 }, inputs: { pitch: 0, gate: 10 }, seconds: 2 });
    const y = outOf(r), got = pitchHz(y, sr, sr);
    assert.ok(Math.abs(cents(got, C4 * 2)) < 30, `sr ${sr}: ${got}`);
  }
});

test('acid: the cutoff jack tracks 1 V/oct at depth 1, far past the ends of the knob', () => {
  const ring = (cv) => {
    const r = renderModule('acid', { params: { reso: 0.95, envMod: 0, decay: 1, volume: 1, cutoff: 1 }, depth: { cutoff: 1 }, inputs: { pitch: -2, gate: 10, cutoff: cv }, seconds: 1 });
    return spectrum(r.out.out, r.sr, 32768, 24000);
  };
  const peakOf = (s) => {
    // above the saw's strong low harmonics, the resonance stands out
    const from = Math.round(300 / s.binHz);
    let best = from;
    for (let k = from; k < s.mag.length; k++) if (s.mag[k] > s.mag[best]) best = k;
    return best * s.binHz;
  };
  const a = peakOf(ring(0)), b = peakOf(ring(1)), c = peakOf(ring(2.5));
  assert.ok(b / a > 1.75 && b / a < 2.25, `1 V moved it ×${(b / a).toFixed(2)}`);
  assert.ok(c > 3000, `2.5 V reaches ${c.toFixed(0)} Hz, beyond the knob's 2394 Hz`);
});
