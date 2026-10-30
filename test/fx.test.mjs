// The effects against what they claim, measured from outside: an impulse in, what comes out.
// Detectors that could flatter a module are first tried on a known-good and a known-bad signal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, fft, spectrum, rms, peak, mean, db } from './lib/dsp.mjs';
import { getDef } from '../src/modules/index.js';
import { Rng } from '../src/modules/lib/index.js';

const SR = 48000;
const impulse = (v = 1) => (t, n) => (n === 0 ? v : 0);
const report = (msg) => console.log(`    ${msg}`);
const expKnob = (v, lo, hi) => Math.log(v / lo) / Math.log(hi / lo);
const delayKnob = (ms) => expKnob(ms / 1000, 0.001, 2);
const reverbKnob = (s) => expKnob(s, 0.5, 16);
const pulses = (period, len = 96) => (t, n) => (n % period < len ? 10 : 0);
const noiseFn = (seed = 777, amp = 1) => { const g = new Rng(seed); return () => g.bipolar() * amp; };

// a loop over an empty array passes without testing anything
const has = (x, n) => { assert.ok(x?.length >= n, `expected at least ${n} samples, got ${x?.length}`); return x; };

// ── detectors ───────────────────────────────────────────────────
const argmaxAbs = (x, a = 0, b = x.length) => { let k = a; for (let i = a; i < b; i++) if (Math.abs(x[i]) > Math.abs(x[k])) k = i; return k; };
const firstAbove = (x, v, a = 0, b = x.length) => { for (let i = a; i < b; i++) if (Math.abs(x[i]) >= v) return i; return -1; };

// RT60 from the slope of the Schroeder curve between −5 and −35 dB
function rt60(x, sr = SR) {
  const n = x.length, e = new Float64Array(n);
  let s = 0;
  for (let i = n - 1; i >= 0; i--) { s += x[i] * x[i]; e[i] = s; }
  let a = -1, b = -1;
  for (let i = 0; i < n; i++) {
    const d = 10 * Math.log10(e[i] / s);
    if (a < 0 && d <= -5) a = i;
    if (d <= -35) { b = i; break; }
  }
  if (b < 0) return NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
  for (let i = a; i < b; i += 4) {
    const t = i / sr, y = 10 * Math.log10(e[i] / s);
    sx += t; sy += y; sxx += t * t; sxy += t * y; m++;
  }
  return -60 / ((m * sxy - sx * sy) / (m * sxx - sx * sx));
}

// Zero-phase band: a Gaussian on a log-frequency axis. A brickwall rings with a 1/t tail, which
// reads as reverb and invents seconds of RT60 at low settings.
function band(x, centre, sr = SR, octaves = 0.45) {
  let N = 1;
  while (N < x.length) N *= 2;
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(x);
  fft(re, im);
  for (let k = 0; k < N; k++) {
    const f = (Math.min(k, N - k) * sr) / N;
    const w = f > 0 ? Math.exp(-0.5 * (Math.log2(f / centre) / octaves) ** 2) : 0;
    re[k] *= w; im[k] *= -w;
  }
  fft(re, im);
  for (let k = 0; k < N; k++) re[k] /= N;
  return re.subarray(0, x.length);
}

// Normalised echo density (Abel & Huang 2006, Hann window): 1 once it is as dense as Gaussian noise
function echoDensity(x, sr = SR, win = 0.02, hop = 0.005) {
  const w = Math.round(win * sr), h = Math.round(hop * sr), W = new Float64Array(w), out = [];
  let sum = 0;
  for (let i = 0; i < w; i++) { W[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / w); sum += W[i]; }
  for (let a = 0; a + w <= x.length; a += h) {
    let s = 0;
    for (let i = 0; i < w; i++) s += W[i] * x[a + i] * x[a + i];
    const sd = Math.sqrt(s / sum);
    let c = 0;
    for (let i = 0; i < w; i++) if (Math.abs(x[a + i]) > sd) c += W[i];
    out.push({ t: (a + w / 2) / sr, ned: c / sum / 0.3173105 });
  }
  return out;
}
// when it first stays at `lvl` or better, for three readings running
const denseAt = (ned, lvl = 0.9) => {
  for (let k = 0; k + 3 < ned.length; k++) if (ned[k].ned >= lvl && ned[k + 1].ned >= lvl && ned[k + 2].ned >= lvl) return ned[k].t;
  return Infinity;
};

// A decaying tail with the decay taken out, for an RT60 of `rt`
const flattened = (x, start, size, rt) => {
  const y = new Float64Array(size), k = (3 * Math.LN10) / rt / SR;
  for (let i = 0; i < size; i++) y[i] = (x[start + i] ?? 0) * Math.exp(k * i);
  return y;
};

// Modes per Hz between lo and hi, and how far the tallest one stands above the median bin of
// its own third of an octave: against a global median any spectral tilt would read as a mode
function modes(x, lo = 200, hi = 4000) {
  const s = spectrum(x, SR, x.length, 0);
  const a = Math.ceil(lo / s.binHz), b = Math.floor(hi / s.binHz);
  let crest = -Infinity, count = 0;
  for (let k0 = a; k0 < b;) {
    const k1 = Math.min(b, Math.max(k0 + 8, Math.round(k0 * 2 ** (1 / 3))));
    const bins = Array.from(s.mag.subarray(k0, k1)).sort((p, q) => p - q);
    const median = bins[bins.length >> 1];
    crest = Math.max(crest, db(bins[bins.length - 1] / median));
    for (let k = k0; k < k1; k++) if (s.mag[k] > s.mag[k - 1] && s.mag[k] > s.mag[k + 1] && s.mag[k] > median * 0.5) count++;
    k0 = k1;
  }
  return { density: count / (hi - lo), crest };
}

// The same magnitude spectrum with random phases: what a perfectly mixed tail of this colour reads.
// Even this dips to 0.8 in single windows, which is why the tail is judged on its mean and 5th percentile.
function surrogate(x, seed = 1) {
  const N = x.length, re = Float64Array.from(x), im = new Float64Array(N), g = new Rng(seed);
  fft(re, im);
  for (let k = 1; k < N / 2; k++) {
    const m = Math.hypot(re[k], im[k]), ph = g.next() * 2 * Math.PI;
    re[k] = m * Math.cos(ph); im[k] = m * Math.sin(ph);
    re[N - k] = re[k]; im[N - k] = -im[k];
  }
  for (let k = 0; k < N; k++) im[k] = -im[k];
  fft(re, im);
  return re.map((v) => v / N);
}
const densityStats = (x) => {
  const v = echoDensity(x).map((p) => p.ned).sort((a, b) => a - b);
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, p5: v[Math.floor(v.length * 0.05)] };
};

// correlation of two signals, at the best lag within ±lag samples
function correlation(x, y, a, b, lag = 48) {
  let xx = 0, yy = 0, best = 0;
  for (let i = a; i < b; i++) { xx += x[i] * x[i]; yy += y[i] * y[i]; }
  for (let l = -lag; l <= lag; l += 3) {
    let xy = 0;
    for (let i = a; i < b; i++) xy += x[i] * (y[i + l] ?? 0);
    best = Math.max(best, Math.abs(xy) / Math.sqrt(xx * yy));
  }
  return best;
}

// sliding RMS over one period of a probe tone: a notch crossing it is a dip in this
function envelope(x, sr, hz) {
  const w = Math.round(sr / hz), out = new Float64Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i] * x[i] - (i >= w ? x[i - w] * x[i - w] : 0);
    out[i] = Math.sqrt(Math.max(0, s) / w);
  }
  return { env: out, lag: w / 2 };
}

// local minima of an envelope below `depth` of its peak, at least `gap` samples apart
function dips(env, depth, gap, from = 0) {
  const top = peak(env, from), out = [];
  for (let i = from + 1; i < env.length - 1; i++) {
    if (env[i] < top * depth && env[i] <= env[i - 1] && env[i] < env[i + 1]) {
      const last = out[out.length - 1];
      if (last !== undefined && i - last < gap) { if (env[i] < env[last]) out[out.length - 1] = i; } else out.push(i);
    }
  }
  return out;
}

const irSpectrum = (x, size = 1 << 16) => {
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < Math.min(size, x.length); i++) re[i] = x[i];
  fft(re, im);
  const mag = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  return { mag, binHz: SR / size };
};
const irDb = (s, hz) => db(s.mag[Math.round(hz / s.binHz)]);

// the kind of reverb these detectors must catch: a single feedback comb, and Schroeder's four
function combIR(seconds, lengths, g) {
  const n = Math.round(seconds * SR), x = new Float64Array(n);
  for (const L of lengths) {
    const c = new Float64Array(n);
    c[0] = 1;
    for (let i = L; i < n; i++) c[i] = (i === L ? 1 : 0) * g + g * c[i - L];
    for (let i = 0; i < n; i++) x[i] += c[i];
  }
  return x;
}

test('the detectors read known signals correctly', () => {
  // RT60 of exponentially decaying noise, known exactly
  for (const T of [0.5, 2, 8]) {
    const g = new Rng(11), n = Math.round(T * 1.5 * SR), x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = g.bipolar() * 10 ** ((-3 * i) / (T * SR));
    const got = rt60(x);
    assert.ok(Math.abs(got / T - 1) < 0.02, `rt60 of a ${T} s decay reads ${got.toFixed(3)}`);
  }
  // echo density: noise is dense, a comb is not
  const g = new Rng(5), noise = new Float64Array(SR);
  for (let i = 0; i < SR; i++) noise[i] = g.bipolar() + g.bipolar() + g.bipolar() + g.bipolar();
  const dense = echoDensity(noise), sparse = echoDensity(combIR(1, [1423], 0.9));
  assert.ok(dense.every((p) => p.ned > 0.85), 'noise should read dense');
  assert.ok(sparse.every((p) => p.ned < 0.5), `a comb should read sparse: ${Math.max(...sparse.map((p) => p.ned))}`);
  // modes: Gaussian noise has no tall ones, a comb and Schroeder's four combs do
  const white = new Float64Array(1 << 17), g2 = new Rng(9);
  for (let i = 0; i < white.length; i++) white[i] = g2.bipolar() + g2.bipolar() + g2.bipolar();
  const m0 = modes(white), m1 = modes(flattened(combIR(4, [1423], 0.9), 0, 1 << 17, 0.5));
  const m4 = modes(flattened(combIR(4, [1557, 1617, 1491, 1422], 0.9), 0, 1 << 17, 0.5));
  assert.ok(m0.crest < 15, `noise crest ${m0.crest.toFixed(1)} dB`);
  assert.ok(m1.density < 0.05, `one comb reads ${m1.density.toFixed(3)} modes/Hz`);
  assert.ok(m4.density < 0.3, `four combs read ${m4.density.toFixed(3)} modes/Hz`);
  assert.ok(m4.crest > 20, `four combs crest ${m4.crest.toFixed(1)} dB`);
  // correlation: a signal with itself, and with something unrelated
  assert.ok(correlation(noise, noise, 2000, 12000) > 0.99);
  assert.ok(correlation(noise, white, 2000, 12000) < 0.1);
  // the probe dips: a tone fading to nothing and back shows one dip, where it should
  const tone = Float64Array.from({ length: SR }, (_, n) => Math.abs(n / SR - 0.5) * Math.sin(2 * Math.PI * 200 * n / SR));
  const e = envelope(tone, SR, 200), d = dips(e.env, 0.2, SR / 4, 500);
  assert.equal(d.length, 1);
  assert.ok(Math.abs(d[0] - e.lag - SR / 2) < 150, `dip at ${d[0]}`);
});

// ── tape delay ──────────────────────────────────────────────────
const tape = { tone: 1, wow: 0, mix: 1, feedback: 0, mode: 0 };

test('delay: an impulse comes back exactly when the TIME knob says', () => {
  for (const sr of [22050, 44100, 48000, 96000]) {
    for (const ms of [1, 12.5, 100, 375, 1000, 2000]) {
      const want = (ms / 1000) * sr;
      const r = renderModule('delay', { sr, seconds: (ms / 1000) + 0.05, params: { ...tape, time: delayKnob(ms) }, inputs: { inL: impulse(1) } });
      for (const x of [r.outL, r.outR]) {
        const at = argmaxAbs(has(x, want + 1));
        assert.ok(Math.abs(at - want) <= 0.5, `${ms} ms at ${sr}: heard at ${at}, want ${want}`);
      }
      assert.ok(peak(r.outL, 0, Math.floor(want) - 1) < 1e-9, 'nothing before the echo');
    }
  }
  const r = renderModule('delay', { seconds: 0.2, params: { ...tape, time: delayKnob(100) }, inputs: { inL: impulse(1) } });
  assert.ok(Math.abs(r.outL[4800] - 1) < 0.01, `a clean echo at unity, got ${r.outL[4800]}`);
  report(`delay exact: 1 ms to 2 s at four sample rates, ±0.5 sample; echo gain ${r.outL[4800].toFixed(4)}`);
});

test('delay: repeats decay by exactly the feedback amount', () => {
  for (const fb of [0.3, 0.5, 0.75, 0.95]) {
    const D = 4800, burst = (t, n) => (n < 960 ? 0.3 * Math.sin((2 * Math.PI * n) / 48) * Math.sin((Math.PI * n) / 960) ** 2 : 0);
    const r = renderModule('delay', { seconds: 1, params: { ...tape, feedback: fb, time: delayKnob(100) }, inputs: { inL: burst } });
    const lvl = (k) => rms(has(r.outL, D * (k + 1)), D * k, D * k + 960);
    for (let k = 1; k < 5; k++) {
      const ratio = lvl(k + 1) / lvl(k);
      assert.ok(Math.abs(ratio / fb - 1) < 0.02, `fb ${fb}, repeat ${k}: ratio ${ratio.toFixed(4)}`);
    }
  }
});

test('delay: repeats stay on the grid, and TONE darkens each one', () => {
  const D = 4800, g = new Rng(17), raw = Float64Array.from({ length: 1 << 12 }, () => g.bipolar());
  // noise in a band around 1 kHz, where the loop is tuned, faded in and out
  const burst = band(raw, 1000, SR, 0.5).map((v, n) => v * Math.sin((Math.PI * Math.min(n, 2400)) / 2400) ** 2);
  const r = renderModule('delay', { seconds: 1.5, params: { ...tape, feedback: 0.9, tone: 0.55, time: delayKnob(100) }, inputs: { inL: (t, n) => (n < 2400 ? burst[n] : 0) } });
  const x = has(r.outL, 12 * D), lags = [];
  for (let k = 2; k <= 10; k++) {
    let best = -Infinity, at = 0;
    for (let l = -40; l <= 40; l++) {
      let c = 0;
      for (let i = 0; i < 2400; i++) c += x[D + i] * x[k * D + l + i];
      if (c > best) { best = c; at = l; }
    }
    lags.push(at);
    assert.ok(Math.abs(at) <= 1, `repeat ${k} is ${at} samples off the grid: ${lags}`);
  }
  report(`repeats 2-10 off the grid by ${lags.join(', ')} samples`);
  // brightness of each repeat of a noise burst
  const n0 = noiseFn(3);
  const r2 = renderModule('delay', { seconds: 1, params: { ...tape, feedback: 0.8, tone: 0.5, time: delayKnob(100) }, inputs: { inL: (t, n) => (n < 2400 ? 0.3 * n0() : 0) } });
  const centroid = (x, a) => {
    const s = spectrum(x, SR, 2048, a);
    let w = 0, m = 0;
    for (let k = 2; k < s.mag.length; k++) { w += k * s.binHz * s.mag[k] ** 2; m += s.mag[k] ** 2; }
    return w / m;
  };
  const c = [1, 2, 3, 4].map((k) => centroid(has(r2.outL, D * 5), D * k));
  for (let k = 1; k < c.length; k++) assert.ok(c[k] < c[k - 1] * 0.97, `centroids ${c.map((v) => v.toFixed(0))}`);
  report(`TONE: brightness of repeats 1-4: ${c.map((v) => v.toFixed(0)).join(', ')} Hz`);
});

test('delay: ping-pong alternates sides at the delay time', () => {
  const D = 4800;
  const r = renderModule('delay', { seconds: 0.5, params: { ...tape, feedback: 0.8, mode: 1, time: delayKnob(100) }, inputs: { inL: impulse(0.5) } });
  assert.equal(argmaxAbs(has(r.outL, 3 * D + 1), D - 100, D + 100), D);
  assert.equal(argmaxAbs(r.outR, 2 * D - 100, 2 * D + 100), 2 * D);
  assert.equal(argmaxAbs(r.outL, 3 * D - 100, 3 * D + 100), 3 * D);
  assert.ok(peak(r.outR, 0, 2 * D - 8) < 1e-9, 'R is silent until the second bounce');
  assert.ok(peak(r.outL, D + 300, 3 * D - 1) < 1e-3, 'L is silent between its bounces');
});

test('delay: CLK locks to the measured period; TIME is ignored', () => {
  const lockTest = (period, div, want, tol, extra = {}) => {
    const settle = 5 * SR, hit = settle + 1000;
    const r = renderModule('delay', {
      seconds: (hit + want + 2000) / SR,
      params: { ...tape, time: 0.2, div, ...extra },
      inputs: { inL: (t, n) => (n === hit ? 1 : 0), clk: extra.clkFn ?? pulses(period) },
    });
    const at = argmaxAbs(has(r.outL, hit + want + 100), hit + 200);
    assert.ok(Math.abs(at - hit - want) <= tol, `period ${period} div ${div}: ${at - hit} samples, want ${want}`);
  };
  // 120 BPM 1/16 = 6000 samples, for each DIV
  [1, 2, 3, 4, 8].forEach((mult, div) => lockTest(6000, div, 6000 * mult, 0));
  // a fractional period: 133 BPM 1/16 is 5413.53 samples, edges land on whole samples
  const frac = 5413.533834586;
  const fracClk = (t, n) => ((n % frac) < 96 ? 10 : 0);
  lockTest(0, 3, frac * 4, 1, { clkFn: fracClk });
  // swing moves every other edge, the echo stays straight
  const sw = 0.62, L = 6000 * 2 * sw;
  lockTest(0, 3, 24000, 1, { clkFn: (t, n) => { const m = n % 12000; return m < 96 || (m >= L && m < L + 96) ? 10 : 0; } });
  // a tempo that would exceed the tape folds down an octave and stays on the grid
  lockTest(12000, 4, 96000, 0);
  lockTest(13000, 4, 52000, 0);
});

test('delay and stutter lock to the wall\'s own CLOCK, swing and all', { skip: !getDef('clock') }, () => {
  const seconds = 7, hit = 6 * SR, clock = renderModule('clock', { seconds, running: true, params: { bpm: 132, swing: 0.62 } });
  const s16 = has(clock.s16, seconds * SR), pulse = (60 / 132 / 4) * SR;
  const r = renderModule('delay', { seconds, params: { ...tape, div: 2 }, inputs: { inL: (t, n) => (n === hit ? 1 : 0), clk: (t, n) => s16[n] } });
  const at = argmaxAbs(has(r.outL, seconds * SR), hit + 200) - hit;
  assert.ok(Math.abs(at - 3 * pulse) <= 1, `dotted 1/8 at 132 BPM: ${at} samples, want ${(3 * pulse).toFixed(1)}`);
  report(`CLOCK 132 BPM swing 62 %: dotted 1/8 at ${at} samples, ideal ${(3 * pulse).toFixed(1)}`);
});

test('delay: a clock that stops is not forgotten, and restarting survives the gap', () => {
  const hit = 7 * SR, want = 12000;
  const clk = (t, n) => { if (n > 3 * SR && n < 5 * SR) return 0; return n % 6000 < 96 ? 10 : 0; };
  const r = renderModule('delay', { seconds: hit / SR + 0.5, params: { ...tape, div: 1 }, inputs: { inL: (t, n) => (n === hit ? 1 : 0), clk } });
  assert.equal(argmaxAbs(has(r.outL, hit + want + 1), hit + 200) - hit, want);
});

test('delay: a jump on TIME pitch-shifts like tape instead of clicking', () => {
  // a sine through the delay while TIME jumps both ways. Moving heads can only ever speed the
  // waveform up by the head speed (≤ 4×): anything steeper than that would be a click
  const hz = 300, slope = (2 * Math.PI * hz) / SR;
  for (const [a, b] of [[50, 700], [700, 50], [5, 2000], [2000, 5]]) {
    const steps = 3 * SR;
    const r = renderModule('delay', {
      seconds: 8, params: { ...tape, time: delayKnob(a) },
      depth: { time: delayKnob(b) - delayKnob(a) },
      inputs: { inL: (t) => Math.sin(2 * Math.PI * hz * t), time: (t, n) => (n < steps ? 0 : 10) },
    });
    let worst = 0;
    const x = has(r.outL, 8 * SR);
    for (let n = steps - 1000; n < 8 * SR; n++) worst = Math.max(worst, Math.abs(x[n] - x[n - 1]));
    assert.ok(worst < 4.2 * slope, `${a} → ${b} ms: largest step ${worst.toFixed(4)}, a clean ×4 sine is ${(4 * slope).toFixed(4)}`);
  }
  // and it does shift: during a rise in delay time the pitch falls, and it never runs backwards
  const r = renderModule('delay', {
    seconds: 4, params: { ...tape, time: delayKnob(100) }, depth: { time: delayKnob(1000) - delayKnob(100) },
    inputs: { inL: (t) => Math.sin(2 * Math.PI * 1000 * t), time: (t) => (t < 1.5 ? 0 : 10) },
  });
  const x = has(r.outL, 3 * SR), periods = [];
  let last = null;
  for (let n = 1.5 * SR; n < 3 * SR; n++) {
    if (x[n - 1] < 0 && x[n] >= 0) { if (last !== null) periods.push(n - last); last = n; }
  }
  const slowest = Math.max(...periods), fastest = Math.min(...periods);
  assert.ok(slowest > 1.9 * 48 && slowest <= 4.2 * 48, `the longest period is ${slowest} samples, 48 at rest`);
  assert.ok(fastest >= 47, `pitch never rises on the way up: shortest ${fastest}`);
  report(`TIME jump up: pitch ratio bottoms out at ${(48 / slowest).toFixed(2)} (limit 0.25)`);
});

test('delay: WOW drifts the pitch slowly, and only when asked', () => {
  const deviation = (wow) => {
    const r = renderModule('delay', { seconds: 12, params: { ...tape, wow, time: delayKnob(400) }, inputs: { inL: (t) => Math.sin(2 * Math.PI * 1000 * t) } });
    // zero crossings every 10 ms give a pitch track
    const x = has(r.outL, 12 * SR), track = [];
    let n0 = 2 * SR, t0 = null, count = 0;
    for (let n = n0; n < x.length; n++) {
      if (x[n - 1] < 0 && x[n] >= 0) {
        const t = n - 1 + -x[n - 1] / (x[n] - x[n - 1]);
        if (t0 === null) t0 = t;
        else if (++count === 40) { track.push(1200 * Math.log2((40 / (t - t0)) * 48)); t0 = t; count = 0; }
      }
    }
    let flips = 0;
    const m = track.reduce((a, b) => a + b, 0) / track.length, up = track.map((c) => c > m);
    for (let k = 1; k < up.length; k++) if (up[k] !== up[k - 1]) flips++;
    return { top: Math.max(...track.map((c) => Math.abs(c))), hz: flips / 2 / 10 };
  };
  assert.ok(deviation(0).top < 0.05, 'WOW at zero is dead straight');
  const w = deviation(1);
  assert.ok(w.top > 8 && w.top < 40, `full WOW swings ${w.top.toFixed(1)} cents`);
  assert.ok(w.hz < 2.5, `drift at ${w.hz.toFixed(2)} Hz`);
  report(`WOW: ±${w.top.toFixed(1)} cents at about ${w.hz.toFixed(2)} Hz`);
});

test('delay: above unity it self-oscillates, and settles at a sane level', () => {
  const r = renderModule('delay', { seconds: 20, params: { ...tape, feedback: 1.2, time: delayKnob(50), tone: 0.8 }, inputs: { inL: (t, n) => (n < 480 ? Math.sin(n / 10) : 0) } });
  const late = rms(has(r.outL, 20 * SR), 15 * SR, 20 * SR);
  assert.ok(late > 1, `it should sing on its own, rms ${late.toFixed(3)}`);
  assert.ok(peak(r.outL, 15 * SR, 20 * SR) <= 7.01, `peak ${peak(r.outL, 15 * SR).toFixed(2)}`);
  report(`self-oscillation: ${late.toFixed(2)} V rms, ${peak(r.outL, 15 * SR, 20 * SR).toFixed(2)} V peak`);
});

test('delay: at 1 ms the loop sings at 1 kHz, whatever TONE does', () => {
  const rows = [];
  for (const tone of [0.45, 0.55, 1]) {
    const r = renderModule('delay', { seconds: 3, params: { ...tape, feedback: 1.2, tone, time: 0 }, inputs: { inL: (t, n) => (n < 480 ? Math.sin((2 * Math.PI * 1000 * n) / SR) * 0.3 : 0) } });
    const x = has(r.outL, 3 * SR);
    let first = 0, last = 0, count = -1;
    for (let n = SR; n < x.length; n++) {
      if (x[n - 1] < 0 && x[n] >= 0) {
        const t = n - 1 + -x[n - 1] / (x[n] - x[n - 1]);
        if (count < 0) first = t;
        last = t; count++;
      }
    }
    assert.ok(count > 1000, `TONE ${tone}: it did not oscillate, ${count} cycles`);
    const hz = (count * SR) / (last - first), cents = 1200 * Math.log2(hz / 1000);
    rows.push(cents.toFixed(1));
    assert.ok(Math.abs(cents) < 15, `TONE ${tone}: ${hz.toFixed(1)} Hz, ${cents.toFixed(1)} cents off`);
  }
  report(`1 ms self-oscillation against 1 kHz: ${rows.join(', ')} cents`);
});

// ── reverb ──────────────────────────────────────────────────────
const irOf = (params, seconds, sr = SR) => renderModule('reverb', {
  sr, seconds, params: { mix: 1, predelay: 0, ...params }, inputs: { inL: impulse(1) },
});

test('reverb: RT60 from Schroeder integration matches the knob within 15 %', () => {
  const rows = [];
  // low, mid, high, the two ends of the knob, at the default DAMP and SIZE
  for (const want of [0.5, 0.75, 2, 6, 16]) {
    const r = irOf({ decay: reverbKnob(want) }, want * 1.4 + 1.2);
    const broad = rt60(has(r.outL, SR)), right = rt60(r.outR), oct1k = rt60(band(r.outL, 1000));
    rows.push(`${want} s → ${broad.toFixed(2)} / ${right.toFixed(2)} / 1k ${oct1k.toFixed(2)}`);
    for (const got of [broad, right]) assert.ok(Math.abs(got / want - 1) <= 0.15, `knob ${want} s, measured ${got.toFixed(3)} s`);
  }
  report(`RT60 knob → L / R / 1 kHz octave: ${rows.join('; ')}`);
});

test('reverb: the RT60 reading holds at other sizes, damping and sample rates', () => {
  const cases = [
    [{ size: 0.2 }, SR], [{ size: 1 }, SR], [{ damp: 0 }, SR], [{ damp: 0.7 }, SR],
    [{}, 44100], [{}, 96000],
  ];
  const rows = [];
  for (const [p, sr] of cases) {
    for (const want of [0.75, 2, 6]) {
      const r = irOf({ decay: reverbKnob(want), ...p }, want * 1.4 + 1.2, sr);
      const got = rt60(has(r.outL, sr), sr);
      rows.push(((got / want - 1) * 100).toFixed(0));
      assert.ok(Math.abs(got / want - 1) <= 0.15, `${JSON.stringify(p)} at ${sr}, ${want} s: ${got.toFixed(3)} s`);
    }
  }
  report(`RT60 error across size, damp and rate: ${Math.min(...rows)}..${Math.max(...rows)} %`);
});

test('reverb: DAMP takes the highs first', () => {
  const r = irOf({ decay: reverbKnob(6), damp: 0.7 }, 9);
  const lo = rt60(band(has(r.outL, SR), 500)), hi = rt60(band(r.outL, 4000));
  assert.ok(hi < lo * 0.6, `RT60 ${lo.toFixed(2)} s at 500 Hz, ${hi.toFixed(2)} s at 4 kHz`);
});

test('reverb: the delay lengths are the published ones, scaled by sample rate', () => {
  for (const sr of [32000, 48000, 96000]) {
    const r = renderModule('reverb', { sr, seconds: 0.01, inputs: { inL: 0 } });
    const m = r.instance, scale = expKnobInv(0.693, 0.4, 1.5);
    const table = [672, 4453, 1800, 3720, 908, 4217, 2656, 3163, 266, 2974, 1913, 1996, 1990, 187, 1066, 353, 3627, 1228, 2673, 2111, 335, 121];
    table.forEach((n, k) => assert.equal(m.cur[k], Math.max(1, Math.round((n * sr * scale) / 29761)), `entry ${k} at ${sr}`));
    assert.ok(Math.abs(scale - 1) < 0.01, 'SIZE default sits on the published plate');
  }
});
function expKnobInv(t, lo, hi) { return lo * (hi / lo) ** t; }

test('reverb: PREDELAY delays the whole tail', () => {
  const first = (ms) => {
    const r = irOf({ predelay: expKnob(ms / 1000, 0.001, 0.25) }, 0.4);
    return firstAbove(has(r.outL, SR / 4), 1e-6);
  };
  const base = first(1);
  assert.equal(first(21) - base, 960);
  assert.equal(first(101) - base, 4800);
});

test('reverb: the tail is decorrelated between left and right', () => {
  const r = irOf({ decay: reverbKnob(3) }, 3);
  const rows = [];
  for (const [a, b] of [[0.03, 0.2], [0.2, 0.6], [0.6, 1.5]]) {
    const rho = correlation(has(r.outL, SR), r.outR, Math.round(a * SR), Math.round(b * SR));
    rows.push(rho.toFixed(3));
    assert.ok(rho < 0.3, `L/R correlation ${rho.toFixed(3)} between ${a} and ${b} s`);
  }
  report(`L/R correlation at best lag: ${rows.join(', ')} (bar 0.3)`);
});

test('reverb: echo density builds and the tail is not metallic', () => {
  const r = irOf({ decay: reverbKnob(3), damp: 0.2 }, 6);
  const x = has(r.outL, SR), ned = echoDensity(x);
  const at = (t) => ned.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best)).ned;
  assert.ok(at(0.02) < at(0.25), 'density grows');
  // density arrives when the first crossing of the figure of eight comes back: half a trip, 21589 / 2
  // samples at 29761 Hz, after the 905 of the input diffusers. A comb, whatever its length, never gets there
  const trip = (s) => (905 + 0.5 * 21589 * s) / 29761;
  const dense = denseAt(ned);
  assert.ok(dense < trip(1), `0.9 at ${dense} s, half a trip is ${trip(1).toFixed(3)} s`);
  const combs = denseAt(echoDensity(combIR(1, [1557, 1617, 1491, 1422], 0.9)));
  assert.ok(combs > 2 * trip(1), `four combs reach it at ${combs} s`);
  const small = denseAt(echoDensity(irOf({ decay: reverbKnob(3), damp: 0.2, size: 0.4 }, 1.5).outL));
  assert.ok(small < trip(0.68), `at SIZE 0.4: ${small} s, half a trip is ${trip(0.68).toFixed(3)} s`);
  // once it is there, it stays as dense as Gaussian noise of the same colour; a comb bank doesn't
  const tail = flattened(x, 0.4 * SR, 1 << 16, 3);
  const mine = densityStats(tail), ideal = densityStats(surrogate(tail));
  assert.ok(mine.mean > ideal.mean - 0.02, `tail mean ${mine.mean.toFixed(3)}, ideal ${ideal.mean.toFixed(3)}`);
  assert.ok(mine.p5 > ideal.p5 - 0.05, `tail p5 ${mine.p5.toFixed(3)}, ideal ${ideal.p5.toFixed(3)}`);
  const combTail = flattened(combIR(4, [1557, 1617, 1491, 1422], 0.9), 0.4 * SR, 1 << 16, 0.5);
  const cs = densityStats(combTail), ci = densityStats(surrogate(combTail));
  assert.ok(cs.p5 < ci.p5 - 0.3, `the comb tail should fail this: p5 ${cs.p5.toFixed(3)}, ideal ${ci.p5.toFixed(3)}`);

  const m = modes(flattened(x, 0.3 * SR, 1 << 17, 3));
  const comb = modes(flattened(combIR(4, [1557, 1617, 1491, 1422], 0.9), 0, 1 << 17, 0.5));
  assert.ok(m.density > 0.6, `${m.density.toFixed(3)} modes/Hz`);
  assert.ok(m.density > 3 * comb.density, `${m.density.toFixed(3)} against ${comb.density.toFixed(3)} for four combs`);
  assert.ok(m.crest < 16, `the tallest mode stands ${m.crest.toFixed(1)} dB above its neighbours`);
  assert.ok(comb.crest > m.crest + 8, `combs ${comb.crest.toFixed(1)} dB against ${m.crest.toFixed(1)}`);
  report(`NED 0.9 at ${(dense * 1000).toFixed(0)} ms (half trip ${(trip(1) * 1000).toFixed(0)}), SIZE 0.4 ${(small * 1000).toFixed(0)} ms (half trip ${(trip(0.68) * 1000).toFixed(0)}), combs ${combs === Infinity ? 'never' : combs}; tail mean ${mine.mean.toFixed(3)}/p5 ${mine.p5.toFixed(3)} against ideal ${ideal.mean.toFixed(3)}/${ideal.p5.toFixed(3)} (combs p5 ${cs.p5.toFixed(2)}); ${m.density.toFixed(2)} modes/Hz (combs ${comb.density.toFixed(2)}), crest ${m.crest.toFixed(1)} dB (combs ${comb.crest.toFixed(1)})`);
});

test('reverb: turning SIZE glides without clicks', () => {
  const def = getDef('reverb'), m = new def.dsp(SR);
  m.linked = new Uint8Array(2).fill(1); m.ui = new Float32Array(64); m.rack = { running: true };
  const I = new Float64Array(2), O = new Float64Array(2), P = new Float64Array(def.params.length);
  def.params.forEach((q, k) => { P[k] = q.default; });
  P[4] = 1;
  const x = new Float64Array(3 * SR), size = 3;
  for (let n = 0; n < x.length; n++) {
    if (n === SR) P[size] = 0.95;
    I[0] = I[1] = 0.5 * Math.sin(2 * Math.PI * 330 * (n / SR));
    m.tick(I, O, P);
    x[n] = O[0];
  }
  assert.ok(m.cur[1] > 4453 * (SR / 29761) * 1.3, 'the tank really did grow');
  let before = 0, during = 0;
  for (let n = 0.8 * SR; n < SR; n++) before = Math.max(before, Math.abs(x[n] - x[n - 1]));
  for (let n = SR; n < 1.2 * SR; n++) during = Math.max(during, Math.abs(x[n] - x[n - 1]));
  assert.ok(before > 0 && during < 2 * before, `step ${during.toFixed(4)} against ${before.toFixed(4)} before the move`);
});

// ── spring ──────────────────────────────────────────────────────
test('spring: the chirp: low notes arrive first', () => {
  const arrival = (params) => {
    const r = renderModule('spring', { seconds: 1, params: { mix: 1, decay: 0.2, ...params }, inputs: { inL: impulse(1) } });
    return [300, 800, 1500, 2500, 3400].map((hz) => {
      // first big arrival of a narrow band
      const b = band(has(r.outL, SR), hz, SR, hz < 1000 ? 0.3 : 0.12);
      const top = peak(b, 0, 0.12 * SR);
      return firstAbove(b, top * 0.5) / SR;
    });
  };
  const a = arrival({});
  for (let k = 1; k < a.length; k++) assert.ok(a[k] > a[k - 1], `arrivals ${a.map((v) => (v * 1000).toFixed(1))}`);
  const spread = a[a.length - 1] - a[0];
  assert.ok(spread > 0.015, `the chirp spans ${(spread * 1000).toFixed(1)} ms`);
  const wide = arrival({ boing: 1 }), narrow = arrival({ boing: 0 });
  assert.ok(wide[4] - wide[0] > narrow[4] - narrow[0] + 0.005, 'BOING widens the chirp');
  report(`chirp arrivals 300 Hz..3.4 kHz: ${a.map((v) => (v * 1000).toFixed(1)).join(', ')} ms; BOING 0/1 spans ${((narrow[4] - narrow[0]) * 1000).toFixed(1)}/${((wide[4] - wide[0]) * 1000).toFixed(1)} ms`);
});

test('spring: it repeats, and each trip disperses it further', () => {
  // three identical springs, so one set of echoes can be read off cleanly
  const def = getDef('spring'), keep = def.dsp.TD;
  def.dsp.TD = [0.04, 0.04, 0.04];
  let r;
  try { r = renderModule('spring', { seconds: 1, params: { mix: 1, decay: 1, tone: 1 }, inputs: { inL: impulse(1) } }); }
  finally { def.dsp.TD = keep; }
  // a band wide enough to pass the echoes (they are 22 Hz apart as comb teeth), narrow enough
  // to separate the chirp. The k-th arrival is k trips late, and a trip is longer the higher it goes
  const arrivals = (hz) => {
    const e = envelope(band(has(r.outL, SR), hz, SR, 120 / hz), SR, 700).env, out = [];
    let a = 0.03, b = 0.09;
    for (let k = 0; k < 3; k++) {
      let at = Math.round(a * SR);
      for (let n = at; n < b * SR; n++) if (e[n] > e[at]) at = n;
      out.push(at / SR);
      a = at / SR + 0.03;
      b = a + 0.045;
    }
    return out;
  };
  const lo = arrivals(800), hi = arrivals(3200);
  const gap = lo.map((t, k) => hi[k] - t);
  assert.ok(gap[0] > 0.008, `the first trip spreads ${gap[0]} s`);
  assert.ok(Math.abs(gap[1] / gap[0] - 2) < 0.4, `spread per trip ${gap.map((v) => (v * 1000).toFixed(1))} ms`);
  assert.ok(Math.abs(gap[2] / gap[0] - 3) < 0.6, `spread per trip ${gap.map((v) => (v * 1000).toFixed(1))} ms`);
  const period = lo[1] - lo[0];
  assert.ok(period > 0.04 && period < 0.05, `a trip takes ${period} s`);
  report(`spring echoes every ${(period * 1000).toFixed(1)} ms; 800 Hz to 3.2 kHz spread by trip: ${gap.map((v) => (v * 1000).toFixed(1)).join(', ')} ms`);
});

test('spring: DECAY reads true, and the top end is cut where a spring stops', () => {
  const rows = [];
  for (const want of [1, 2.5, 5]) {
    for (const tone of [0.6, 1]) {
      const r = renderModule('spring', { seconds: want * 1.4 + 1, params: { mix: 1, tone, decay: expKnob(want, 0.5, 6) }, inputs: { inL: impulse(1) } });
      const mid = rt60(band(has(r.outL, SR), 500, SR, 0.3)), broad = rt60(r.outL);
      rows.push(`${mid.toFixed(2)}/${broad.toFixed(2)}`);
      for (const got of [mid, broad]) assert.ok(Math.abs(got / want - 1) <= 0.15, `DECAY ${want} s TONE ${tone}, measured ${got.toFixed(2)} s`);
    }
  }
  report(`spring RT60 500 Hz/broadband for 1, 2.5, 5 s at TONE 0.6 and 1: ${rows.join(', ')} s (bar 15 %)`);
  const r = renderModule('spring', { seconds: 3, params: { mix: 1 }, inputs: { inL: noiseFn(5, 2) } });
  const s = spectrum(has(r.outL, 2 * SR), SR);
  const lvl = (a, b) => { let e = 0; for (let k = Math.ceil(a / s.binHz); k < b / s.binHz; k++) e += s.mag[k] ** 2; return db(Math.sqrt(e / (b - a))); };
  const gap = lvl(800, 2500) - lvl(9000, 16000);
  assert.ok(gap > 40, `only ${gap.toFixed(1)} dB between the band and the region above the chirp`);
});

// ── chorus ──────────────────────────────────────────────────────
// the delay each side has at time t, by the published mode table
const chorusDelay = (t, mode, side) => {
  const R = [0.513, 0.863, 9.75], lo = [1.54, 1.54, 3.22], hi = [5.15, 5.15, 3.56];
  const ph = (t * R[mode]) % 1, tri = 1 - 4 * Math.abs(ph - 0.5);
  return ((lo[mode] + hi[mode]) / 2 + (side * (hi[mode] - lo[mode]) * tri) / 2) / 1000;
};

test('chorus: the notch crosses a probe tone exactly when the LFO says, on both sides', () => {
  const rows = [];
  for (const hz of [125, 170, 230]) {
    const r = renderModule('chorus', { seconds: 8, params: { mode: 0, mix: 0.5 }, inputs: { inL: (t) => Math.sin(2 * Math.PI * hz * t) } });
    [[r.outL, 1], [r.outR, -1]].forEach(([x, side]) => {
      const e = envelope(has(x, 8 * SR), SR, hz), hits = dips(e.env, 0.2, 0.2 * SR, SR / 10);
      assert.ok(hits.length >= 5, `${hz} Hz: only ${hits.length} dips`);
      for (const n of hits) {
        const notch = 1 / (2 * chorusDelay((n - e.lag) / SR, 0, side));
        assert.ok(Math.abs(notch / hz - 1) < 0.05, `${hz} Hz: at ${(n / SR).toFixed(3)} s the notch should be at ${notch.toFixed(1)} Hz`);
      }
      assert.ok(Math.min(...hits.map((n) => e.env[n])) < 0.05, 'the notch is deep');
      if (side === 1) rows.push(`${hz} Hz ×${hits.length}`);
    });
  }
  report(`chorus notch dips: ${rows.join(', ')}, within 5 % of the LFO's prediction`);
});

test('chorus: modes have their rates and depths, and the two sides move in opposition', () => {
  // wet only: track the delay by matching against the input
  const track = (mode, seconds, step) => {
    const noise = new Float64Array(seconds * SR), g = new Rng(5);
    for (let i = 0; i < noise.length; i++) noise[i] = g.bipolar();
    const r = renderModule('chorus', { seconds, params: { mode, mix: 1 }, inputs: { inL: (t, n) => noise[n] } });
    const follow = (x) => {
      const out = [], W = 1024;
      for (let a = 600; a + W < x.length; a += step) {
        let best = 0, bestD = 0;
        for (let d = 50; d < 280; d++) {
          let s = 0;
          for (let i = 0; i < W; i += 4) s += x[a + i + d] * noise[a + i];
          if (s > best) { best = s; bestD = d; }
        }
        out.push(bestD);
      }
      return out;
    };
    return { l: follow(has(r.outL, seconds * SR)), r: follow(r.outR) };
  };
  const a = track(0, 4, 2400);
  const lo = Math.min(...a.l), hi = Math.max(...a.l);
  assert.ok(Math.abs(lo - 0.00154 * SR) < 8 && Math.abs(hi - 0.00515 * SR) < 8, `mode 1 sweeps ${lo}..${hi} samples`);
  const sum = a.l.map((d, k) => d + a.r[k]);
  assert.ok(Math.max(...sum) - Math.min(...sum) < 16, 'left and right move in opposition');
  report(`chorus mode 1 delay ${(lo / 48).toFixed(2)}..${(hi / 48).toFixed(2)} ms (want 1.54..5.15)`);

  // mode rates from the sine of the delay's spectrum: the envelope of a probe beats at the LFO
  [[0, 0.513], [1, 0.863], [2, 9.75]].forEach(([mode, hz]) => {
    const f = 1 / (2 * 0.00339), r = renderModule('chorus', { seconds: 12, params: { mode, mix: 0.5 }, inputs: { inL: (t) => Math.sin(2 * Math.PI * f * t) } });
    const e = envelope(has(r.outL, 12 * SR), SR, f).env;
    const s = spectrum(e, SR, 1 << 19, 1000);
    let best = 2;
    for (let k = 2; k < s.mag.length; k++) if (k * s.binHz > 0.3 && k * s.binHz < 30 && s.mag[k] > s.mag[best]) best = k;
    // the envelope dips twice a cycle in modes 1 and 2, where the delay passes the probe going each way
    const got = best * s.binHz, ok = [hz, 2 * hz].some((w) => Math.abs(got / w - 1) < 0.05);
    assert.ok(ok, `mode ${mode}: envelope at ${got.toFixed(3)} Hz, LFO should be ${hz} Hz`);
  });
});

// ── phaser ──────────────────────────────────────────────────────
const phaserNotches = (N, fb, sr = SR) => {
  // first-order allpasses: phase −2 atan(tan(πf/sr) / tan(πfb/sr)) each; notches at odd multiples of π
  const out = [], T = Math.tan((Math.PI * fb) / sr);
  for (let k = 0; 2 * k + 1 < N; k++) {
    const hz = (sr / Math.PI) * Math.atan(T * Math.tan(((2 * k + 1) * Math.PI) / (2 * N)));
    if (hz < sr * 0.45) out.push(hz);
  }
  return out;
};

test('phaser: notches sit where the allpass maths puts them, one per two stages', () => {
  const rows = [];
  [4, 6, 12].forEach((N, stages) => {
    const center = 1.5, fb = 261.6255653 * 2 ** center;
    const r = renderModule('phaser', { seconds: 1.5, params: { stages, center, depth: 0, feedback: 0, mix: 0.5 }, inputs: { inL: impulse(1) } });
    const s = irSpectrum(has(r.outL, SR), 1 << 16);
    const want = phaserNotches(N, fb);
    assert.equal(want.length, N / 2, 'one notch per pair of stages');
    for (const hz of want) {
      // the deepest bin near the prediction is on it, and it is deep
      const a = Math.round((hz * 0.9) / s.binHz), b = Math.round((hz * 1.1) / s.binHz);
      let k = a;
      for (let q = a; q <= b; q++) if (s.mag[q] < s.mag[k]) k = q;
      assert.ok(Math.abs((k * s.binHz) / hz - 1) < 0.01, `${N} stages: notch at ${(k * s.binHz).toFixed(1)}, want ${hz.toFixed(1)}`);
      assert.ok(db(s.mag[k]) < -40, `${N} stages: ${hz.toFixed(0)} Hz only ${db(s.mag[k]).toFixed(1)} dB`);
    }
    rows.push(`${N}: ${want.map((v) => v.toFixed(0)).join(' ')}`);
  });
  report(`phaser notches (Hz): ${rows.join(' | ')}`);
});

test('phaser: the LFO carries the notch through a probe on time; SPREAD offsets the right side', () => {
  const center = 1, rate = 0.5, depth = 1, oct = 2, f0 = 261.6255653 * 2 ** center;
  const probe = 200;                     // the 4-stage high notch never comes below 316 Hz
  const r = renderModule('phaser', {
    seconds: 9, params: { stages: 0, center, rate: expKnob(rate, 0.02, 8), depth, feedback: 0, spread: 1, mix: 0.5 },
    inputs: { inL: (t) => Math.sin(2 * Math.PI * probe * t) },
  });
  // the 4-stage low notch: tan(πn/sr) = tan(πfb/sr) tan(π/8): which break frequency puts it on the probe?
  const fb = (SR / Math.PI) * Math.atan(Math.tan((Math.PI * probe) / SR) / Math.tan(Math.PI / 8));
  const phi = Math.asin(Math.log2(fb / f0) / oct) / (2 * Math.PI);
  const times = (side) => {
    const out = [];
    for (let c = 0; c < 6; c++) for (const p of [phi, 0.5 - phi]) out.push((c + p + side * 0.5) / rate);
    return out.filter((t) => t > 0).sort((a, b) => a - b);
  };
  [[r.outL, 0], [r.outR, 1]].forEach(([x, side]) => {
    const e = envelope(has(x, 9 * SR), SR, probe), got = dips(e.env, 0.2, 0.1 * SR, 0.2 * SR);
    const want = times(side);
    assert.ok(got.length >= 6, `only ${got.length} dips`);
    for (const n of got) {
      const t = (n - e.lag) / SR, d = Math.min(...want.map((w) => Math.abs(w - t)));
      assert.ok(d < 0.03, `dip at ${t.toFixed(3)} s is ${(d * 1000).toFixed(0)} ms from any predicted crossing`);
    }
  });
});

test('phaser: feedback sharpens the peaks between the notches', () => {
  const peakAt = (feedback) => {
    const r = renderModule('phaser', { seconds: 1, params: { stages: 2, center: 2, depth: 0, feedback, mix: 0.5 }, inputs: { inL: impulse(1) } });
    return Math.max(...irSpectrum(has(r.outL, SR)).mag.subarray(50, 12000));
  };
  assert.ok(db(peakAt(0.8) / peakAt(0)) > 8, `${db(peakAt(0.8) / peakAt(0)).toFixed(1)} dB`);
});

// ── flanger ─────────────────────────────────────────────────────
test('flanger: the comb is the one the feedback sign says, by the formula', () => {
  const ms = 4, base = 1000 / ms, mix = Math.SQRT1_2;
  // dry + wet at equal power, wet = z / (1 − fb z), with z = ±1 on the teeth and between them
  const theory = (fb, z) => db(mix * Math.abs(1 + z / (1 - fb * z)));
  const mags = (feedback) => {
    const r = renderModule('flanger', { seconds: 1.5, params: { time: expKnob(ms / 1000, 0.0005, 0.012), depth: 0, feedback, mix: 0.5 }, inputs: { inL: impulse(0.5) } });
    return irSpectrum(has(r.outL, SR).map((v) => v * 2));
  };
  const plus = mags(0.8), minus = mags(-0.8), flat = mags(0);
  for (const k of [1, 2, 3, 5]) {
    const f = k * base, mid = (k + 0.5) * base;
    assert.ok(Math.abs(irDb(plus, f) - theory(0.8, 1)) < 0.5, `+fb tooth ${f} Hz: ${irDb(plus, f).toFixed(2)} dB, want ${theory(0.8, 1).toFixed(2)}`);
    assert.ok(Math.abs(irDb(plus, mid) - theory(0.8, -1)) < 0.5, `+fb gap ${mid} Hz: ${irDb(plus, mid).toFixed(2)} dB`);
    assert.ok(Math.abs(irDb(minus, mid) - theory(-0.8, -1)) < 0.5, `−fb tooth ${mid} Hz: ${irDb(minus, mid).toFixed(2)} dB, want ${theory(-0.8, -1).toFixed(2)}`);
    assert.ok(Math.abs(irDb(minus, f) - theory(-0.8, 1)) < 0.5, `−fb gap ${f} Hz: ${irDb(minus, f).toFixed(2)} dB`);
    assert.ok(irDb(flat, mid) < -40, `no feedback: notch at ${mid} Hz is ${irDb(flat, mid).toFixed(1)} dB`);
  }
});

test('flanger: the notch sweeps the range DEPTH and TIME say, the sides in quadrature', () => {
  const ms = 3, depth = 0.8, rate = 0.4, swing = 0.85 * depth;
  const probe = 1000 / (2 * ms);          // on the first notch at the centre of the sweep
  const r = renderModule('flanger', {
    seconds: 10, params: { time: expKnob(ms / 1000, 0.0005, 0.012), depth, rate: expKnob(rate, 0.02, 5), feedback: 0, mix: 0.5 },
    inputs: { inL: (t) => Math.sin(2 * Math.PI * probe * t) },
  });
  // sin(2π·rate·t) = 0 twice a cycle on the left, cos on the right: a quarter cycle apart
  const crossings = (x) => {
    const e = envelope(has(x, 10 * SR), SR, probe);
    return dips(e.env, 0.05, 0.3 * SR, SR / 10).map((n) => (n - e.lag) / SR);
  };
  const l = crossings(r.outL), r2 = crossings(r.outR);
  assert.ok(l.length >= 5 && r2.length >= 5, `${l.length} and ${r2.length} dips`);
  for (const t of l) {
    const ph = (t * rate * 2) % 1, off = Math.min(ph, 1 - ph);
    assert.ok(off < 0.03, `left dip at ${t.toFixed(3)} s, phase ${ph.toFixed(3)}`);
  }
  for (const t of r2) {
    const ph = (t * rate * 2 + 0.5) % 1, off = Math.min(ph, 1 - ph);
    assert.ok(off < 0.03, `right dip at ${t.toFixed(3)} s, phase ${ph.toFixed(3)}`);
  }
  // the extremes of the sweep: a probe beyond them is never nulled, one just inside is
  const inside = 1000 / (2 * ms * (1 + swing * 0.92)), outside = 1000 / (2 * ms * (1 + swing * 1.15));
  const nulled = (hz) => {
    const q = renderModule('flanger', {
      seconds: 6, params: { time: expKnob(ms / 1000, 0.0005, 0.012), depth, rate: expKnob(rate, 0.02, 5), feedback: 0, mix: 0.5 },
      inputs: { inL: (t) => Math.sin(2 * Math.PI * hz * t) },
    });
    const e = envelope(has(q.outL, 6 * SR), SR, hz).env;
    let lo = 9;
    for (let n = SR; n < e.length; n++) lo = Math.min(lo, e[n]);
    return lo;
  };
  assert.ok(nulled(inside) < 0.05, `inside the sweep: ${nulled(inside).toFixed(3)}`);
  assert.ok(nulled(outside) > 0.03, `outside the sweep: ${nulled(outside).toFixed(3)}`);
});

// ── compressor ──────────────────────────────────────────────────
const softCurve = (x, T, R, W = 6) => {
  const o = x - T;
  if (2 * o < -W) return x;
  if (2 * Math.abs(o) <= W) return x + ((1 / R - 1) * (o + W / 2) ** 2) / (2 * W);
  return T + o / R;
};

test('comp: the static curve matches THRESH, RATIO and the soft knee within 1 dB', () => {
  const rows = [];
  for (const [thresh, ratio, makeup] of [[-20, 4, 0], [-30, 10, 6], [-10, 2, 0], [-24, 20, 12]]) {
    let worst = 0;
    for (const hz of [1000, 100]) {
      for (let lvl = -50; lvl <= 0; lvl += 2.5) {
        const A = 10 * 10 ** (lvl / 20);
        const r = renderModule('comp', {
          seconds: 1, params: { thresh, ratio, makeup, attack: 0.5, release: 0.6 },
          inputs: { inL: (t) => A * Math.sin(2 * Math.PI * hz * t) },
        });
        const x = has(r.outL, SR), period = Math.round(SR / hz), a = SR / 2, b = a + Math.floor((SR / 2) / period) * period;
        const got = 20 * Math.log10((rms(x, a, b) * Math.SQRT2) / 10);
        const want = softCurve(lvl, thresh, ratio) + makeup;
        worst = Math.max(worst, Math.abs(got - want));
        assert.ok(Math.abs(got - want) < 1, `T ${thresh} R ${ratio} at ${lvl} dB, ${hz} Hz: ${got.toFixed(2)} dB, want ${want.toFixed(2)}`);
      }
    }
    rows.push(`T${thresh}/${ratio}:1 ±${worst.toFixed(2)}`);
  }
  report(`comp static curve, worst error in dB: ${rows.join(', ')} (bar 1)`);
});

// gain over time, read by putting a constant through and keying with a constant step
const gainTrace = (key, params, seconds) => {
  const r = renderModule('comp', { seconds, params: { makeup: 0, ...params }, inputs: { inL: 1, side: key } });
  return has(r.outL, 100).map((v) => -20 * Math.log10(v));
};

test('comp: attack and release run at their settings', () => {
  const rows = [];
  for (const [atk, rel] of [[0.002, 0.05], [0.01, 0.2], [0.05, 1], [0.0005, 0.5]]) {
    const on = 0.5, off = on + Math.max(0.5, atk * 12);
    const tr = gainTrace((t) => (t >= on && t < off ? 10 : 0), { thresh: -30, ratio: 8, attack: expKnob(atk, 0.0001, 0.1), release: expKnob(rel, 0.01, 2) }, off + rel * 8);
    const full = (30 - 0) * (1 - 1 / 8);
    assert.ok(Math.abs(tr[Math.round(off * SR) - 2] - full) < 0.2, `settles at ${tr[Math.round(off * SR) - 2].toFixed(2)} dB, want ${full}`);
    const tOf = (start, test2) => { for (let n = Math.round(start * SR); n < tr.length; n++) if (test2(tr[n])) return n / SR - start; return NaN; };
    const a = tOf(on, (v) => v >= full * (1 - Math.exp(-1)));
    const b = tOf(off, (v) => v <= full * Math.exp(-1));
    assert.ok(Math.abs(a / atk - 1) < 0.1, `attack ${atk}: ${(a * 1000).toFixed(2)} ms`);
    assert.ok(Math.abs(b / rel - 1) < 0.1, `release ${rel}: ${(b * 1000).toFixed(1)} ms`);
    rows.push(`${atk * 1000}/${rel * 1000} → ${(a * 1000).toFixed(2)}/${(b * 1000).toFixed(1)}`);
  }
  report(`comp attack/release ms, set → measured: ${rows.join('; ')} (bar 10 %)`);
});

test('comp: a kick on SIDE ducks the bass, and only then', () => {
  const bass = (t) => 3 * Math.sin(2 * Math.PI * 55 * t);
  const kick = (t) => { const p = t % 0.5; return 9 * Math.exp(-p / 0.05) * Math.sin(2 * Math.PI * 70 * p); };
  const params = { thresh: -24, ratio: 8, attack: expKnob(0.001, 0.0001, 0.1), release: expKnob(0.15, 0.01, 2), makeup: 0 };
  const keyed = renderModule('comp', { seconds: 2, params, inputs: { inL: bass, side: kick } });
  const open = renderModule('comp', { seconds: 2, params: { ...params, thresh: 0 }, inputs: { inL: bass } });
  const lvl = (x, t) => rms(x, Math.round(t * SR), Math.round((t + 0.018) * SR));
  const ducked = db(lvl(has(keyed.outL, SR), 1.03) / lvl(has(open.outL, SR), 1.03));
  const recovered = db(lvl(keyed.outL, 1.47) / lvl(open.outL, 1.47));
  assert.ok(ducked < -9, `ducked by ${ducked.toFixed(1)} dB`);
  assert.ok(recovered > ducked + 5, `recovered to ${recovered.toFixed(1)} dB`);
  // the same bass with nothing on SIDE and the key patched at zero: no ducking at all
  const silent = renderModule('comp', { seconds: 1, params, inputs: { inL: bass, side: 0 } });
  assert.ok(Math.abs(db(rms(has(silent.outL, SR)) / rms(open.outL, 0, SR))) < 0.01, 'a silent key leaves the signal alone');
  report(`sidechain: bass ducks ${ducked.toFixed(1)} dB on the kick, back to ${recovered.toFixed(1)} dB before the next`);
});

test('comp: the GR light reads 1 at 20 dB of reduction, and both sides move together', () => {
  // 30 dB over at 3:1 is exactly 20 dB; 15 dB over at 3:1 is 10
  const a = renderModule('comp', { seconds: 0.5, params: { thresh: -30, ratio: 3, attack: 0, release: 0.9 }, inputs: { inL: 10 } });
  assert.ok(Math.abs(a.ui[0] - 1) < 0.01, `GR light ${a.ui[0]}`);
  const b = renderModule('comp', { seconds: 0.5, params: { thresh: -15, ratio: 3, attack: 0, release: 0.9 }, inputs: { inL: 10 } });
  assert.ok(Math.abs(b.ui[0] - 0.5) < 0.01, `GR light ${b.ui[0]}`);
  const c = renderModule('comp', { seconds: 0.5, params: { thresh: -30, ratio: 3, attack: 0, release: 0.9, makeup: 0 }, inputs: { inL: 10, inR: 0.1 } });
  assert.ok(Math.abs(c.outL[SR / 4] / 10 - c.outR[SR / 4] / 0.1) < 1e-6, 'one gain for both sides');
  // MIX is parallel compression: dry under the compressed signal
  const d = renderModule('comp', { seconds: 0.5, params: { thresh: -30, ratio: 3, attack: 0, release: 0.9, makeup: 0, mix: 0.5 }, inputs: { inL: 10 } });
  assert.ok(Math.abs(d.outL[SR / 4] - (10 + 1) / 2) < 0.02, `${d.outL[SR / 4]}`);
});

// ── eq3 ─────────────────────────────────────────────────────────
const eqIR = (params = {}, sr = SR) => renderModule('eq3', { sr, seconds: (1 << 16) / sr + 0.01, params, inputs: { inL: impulse(1) } });

test('eq3: flat within 0.5 dB with every band at 0 dB', () => {
  let worst = 0;
  for (const sr of [44100, 48000, 96000]) {
    const r = eqIR({}, sr);
    const s = irSpectrum(has(r.outL, 1 << 16), 1 << 16), bin = sr / (1 << 16);
    for (let k = Math.ceil(20 / bin); k < 20000 / bin; k++) worst = Math.max(worst, Math.abs(db(s.mag[k])));
  }
  assert.ok(worst < 0.5, `${worst.toFixed(3)} dB off`);
  // and with a real sine, not just the impulse response
  for (const hz of [60, 250, 790, 2500, 9000]) {
    const r = renderModule('eq3', { seconds: 0.5, inputs: { inL: (t) => Math.sin(2 * Math.PI * hz * t) } });
    const g = db(rms(has(r.outL, SR / 2), SR / 4) * Math.SQRT2);
    assert.ok(Math.abs(g) < 0.5, `${hz} Hz: ${g.toFixed(2)} dB`);
  }
  report(`eq3 flatness: ${worst.toExponential(2)} dB, 20 Hz to 20 kHz (bar 0.5)`);
});

test('eq3: each kill takes its band down at least 40 dB', () => {
  const rows = [];
  const check = (params, name, probes) => {
    const s = irSpectrum(has(eqIR(params).outL, 1 << 16), 1 << 16);
    for (const hz of probes) {
      assert.ok(irDb(s, hz) < -40, `${name} at ${hz} Hz: ${irDb(s, hz).toFixed(1)} dB`);
      rows.push(`${name} ${hz} Hz ${irDb(s, hz).toFixed(0)}`);
    }
    return s;
  };
  check({ low: -1 }, 'LOW', [30, 60, 110]);
  check({ mid: -1 }, 'MID', [500, 790, 1200]);
  check({ high: -1 }, 'HIGH', [5500, 8000, 14000]);
  report(`kill depths dB: ${rows.join(', ')}`);
  const none = eqIR({ low: -1, mid: -1, high: -1 });
  assert.ok(peak(has(none.outL, SR), 2000) < 1e-9, 'all three killed is silence');
});

test('eq3: crossovers land near 250 Hz and 2.5 kHz, and knobs boost +6 dB', () => {
  // with its neighbour killed, each band is −6 dB at the crossover
  const lowOnly = irSpectrum(has(eqIR({ mid: -1, high: -1 }).outL, 1 << 16), 1 << 16);
  assert.ok(Math.abs(irDb(lowOnly, 250) + 6) < 0.5, `LOW at 250 Hz: ${irDb(lowOnly, 250).toFixed(2)} dB`);
  const highOnly = irSpectrum(has(eqIR({ low: -1, mid: -1 }).outL, 1 << 16), 1 << 16);
  assert.ok(Math.abs(irDb(highOnly, 2500) + 6) < 0.5, `HIGH at 2.5 kHz: ${irDb(highOnly, 2500).toFixed(2)} dB`);
  for (const [name, hz] of [['low', 60], ['mid', 790], ['high', 9000]]) {
    const s = irSpectrum(has(eqIR({ [name]: 1 }).outL, 1 << 16), 1 << 16);
    assert.ok(Math.abs(irDb(s, hz) - 6) < 0.5, `${name} boost at ${hz} Hz: ${irDb(s, hz).toFixed(2)} dB`);
    const half = irSpectrum(has(eqIR({ [name]: -0.5 }).outL, 1 << 16), 1 << 16);
    assert.ok(Math.abs(irDb(half, hz) + 12) < 0.5, `halfway down reads -12 dB, got ${irDb(half, hz).toFixed(2)}`);
  }
});

test('eq3: throwing a kill does not click', () => {
  const r = renderModule('eq3', {
    seconds: 1, depth: { low: 1 },
    inputs: { inL: (t) => 5 * Math.sin(2 * Math.PI * 60 * t), low: (t) => (t < 0.5 ? 0 : -10) },
  });
  const x = has(r.outL, SR), clean = (2 * Math.PI * 60 * 5) / SR;
  assert.ok(rms(x, 0.9 * SR) < 0.01, 'the kill landed');
  let worst = 0;
  for (let n = 0.4 * SR; n < 0.7 * SR; n++) worst = Math.max(worst, Math.abs(x[n] - x[n - 1]));
  assert.ok(worst < 2.5 * clean, `largest step ${worst.toFixed(4)}, the sine's own ${clean.toFixed(4)}`);
});

// ── stutter ─────────────────────────────────────────────────────
function runStutter({ div = 2, on = 60000, off = 180000, period = 6000, seconds = 5, input, mix = 1, clk = true } = {}) {
  const src = new Float64Array(Math.round(seconds * SR)), g = new Rng(41);
  for (let i = 0; i < src.length; i++) src[i] = input ? input(i / SR, i) : g.bipolar();
  const inputs = { inL: (t, n) => src[n], gate: (t, n) => (n >= on && n < off ? 10 : 0) };
  if (clk) inputs.clk = pulses(period);
  return { r: renderModule('stutter', { seconds, params: { div, mix }, inputs }), src };
}

test('stutter: while the gate is high the output loops with exactly the clocked length', () => {
  const rows = [];
  [[0, 4], [1, 2], [2, 1], [3, 0.5]].forEach(([div, mult]) => {
    const N = 6000 * mult, on = 60000, off = on + 8 * N + 777;
    const { r, src } = runStutter({ div, on, off, seconds: off / SR + 0.2 });
    const x = has(r.outL, off);
    // before the gate and through the first pass it is the live input, up to the seam
    for (let n = on - 500; n < on + N - 400; n++) assert.equal(x[n], src[n], `live at ${n}`);
    // after that, periodic to the sample
    for (let n = on + N; n < off - N - 10; n++) assert.ok(Math.abs(x[n] - x[n + N]) < 1e-12, `not periodic with ${N} at ${n}`);
    // and no shorter period hides in there
    let shorter = 0;
    for (let n = on + N; n < on + 2 * N; n++) shorter += Math.abs(x[n] - x[n + N - 1]);
    assert.ok(shorter > N * 0.1, 'a period one sample shorter does not fit');
    // and what repeats is the slice that started at the gate
    for (let k = 0; k < N - 400; k++) assert.equal(x[on + N + k], src[on + k], `slice sample ${k}`);
    rows.push(`${N}`);
  });
  report(`stutter loop lengths exact to the sample: ${rows.join(', ')} samples for 1/4..1/32 at a 6000-sample clock`);
});

test('stutter: both channels loop together; MIX is how much of the loop you hear', () => {
  const on = 60000, off = 110000, N = 6000;
  const src = (t, n) => Math.sin(n * 0.01);
  const r = renderModule('stutter', {
    seconds: 3, params: { div: 2 },
    inputs: { inL: src, inR: (t, n) => -2 * Math.sin(n * 0.01), gate: (t, n) => (n >= on && n < off ? 10 : 0), clk: pulses(6000) },
  });
  for (let n = on + N; n < off - 2 * N; n += 13) assert.ok(Math.abs(r.outR[n] + 2 * r.outL[n]) < 1e-9, `at ${n}`);
  const { r: q, src: s } = runStutter({ mix: 0 });
  for (let n = 0; n < 200000; n++) assert.equal(has(q.outL, 200000)[n], s[n]);
});

test('stutter: the loop seam and the exit do not click', () => {
  // 55.5 cycles to the slice: a bare loop would jump from one peak to the other
  const hz = 444, on = 60000, off = 120000;
  const input = (t) => Math.cos(2 * Math.PI * hz * (t - on / SR));
  const { r, src } = runStutter({ input, div: 2, on, off, seconds: 4 });
  const x = has(r.outL, 4 * SR), clean = (2 * Math.PI * hz) / SR;
  let worst = 0;
  for (let n = 1000; n < 4 * SR; n++) worst = Math.max(worst, Math.abs(x[n] - x[n - 1]));
  assert.ok(worst < 2 * clean, `largest step ${worst.toFixed(4)}, the sine's own ${clean.toFixed(4)}`);
  // a plain loop at this length would jump by this much:
  const jump = Math.abs(src[on + 6000 - 1] - src[on]);
  assert.ok(jump > 10 * clean, `test setup: the seam should be a real discontinuity, ${jump}`);
  // once the fade is over the output is the live input again
  const after = off + Math.round(0.0055 * SR);
  for (let n = after; n < after + 2000; n++) assert.equal(x[n], src[n], `live at ${n}`);
  report(`stutter seam: largest step ${worst.toFixed(4)} against ${clean.toFixed(4)} for the sine and ${jump.toFixed(3)} for a bare loop`);
});

test('stutter: without a clock it falls back to 120 BPM; a new DIV mid-roll takes effect', () => {
  const on = 20000, N = 6000, off = on + 6 * N;
  const { r } = runStutter({ clk: false, on, off, seconds: 2 });
  const x = has(r.outL, off);
  for (let n = on + N; n < off - N - 10; n++) assert.ok(Math.abs(x[n] - x[n + N]) < 1e-12, `not periodic at ${n}`);

  const roll = 200000, m = 3000, g = new Rng(8);
  const y = renderModule('stutter', {
    seconds: 6, params: { div: 2 }, depth: { div: 0.34 },
    inputs: { inL: () => g.bipolar(), gate: (t, n) => (n >= 60000 ? 10 : 0), clk: pulses(6000), div: (t, n) => (n < roll ? 0 : 10) },
  });
  const z = has(y.outL, 6 * SR);
  for (let n = roll + 400; n < roll + 40000; n++) assert.ok(Math.abs(z[n] - z[n + m]) < 1e-12, `not looping at ${m} at ${n}`);
});

test('stutter: a gate shorter than the slice leaves the signal alone', () => {
  const { r, src } = runStutter({ div: 0, on: 60000, off: 60000 + 6000 });
  const x = has(r.outL, 70000);
  for (let n = 59000; n < 70000; n++) assert.ok(Math.abs(x[n] - src[n]) < 1e-12, `changed at ${n}`);
});

// ── everything ──────────────────────────────────────────────────
test('every feedback path stays bounded at max settings for 60 s of hot input', () => {
  const seconds = 60, cases = [
    ['delay', { time: 0, feedback: 1.2, tone: 1, wow: 1, mix: 1, mode: 0 }],
    ['delay', { time: 0, feedback: 1.2, tone: 1, wow: 1, mix: 1, mode: 1 }],
    ['delay', { time: 1, feedback: 1.2, tone: 1, wow: 1, mix: 1, mode: 1 }],
    ['reverb', { decay: 1, damp: 0, size: 1, mix: 1, predelay: 0 }],
    ['reverb', { decay: 1, damp: 1, size: 0, mix: 1, predelay: 0 }],
    ['spring', { decay: 1, boing: 1, tone: 1, mix: 1 }],
    ['chorus', { mode: 2, mix: 1 }],
    ['phaser', { stages: 2, feedback: 0.9, depth: 1, rate: 1, mix: 1 }],
    ['phaser', { stages: 0, feedback: -0.9, depth: 1, rate: 0, mix: 1 }],
    ['flanger', { time: 0, feedback: 0.95, depth: 1, rate: 1, mix: 1 }],
    ['flanger', { time: 1, feedback: -0.95, depth: 1, rate: 0, mix: 1 }],
  ];
  const rows = [];
  for (const [type, params] of cases) {
    const n1 = noiseFn(13, 12), n2 = noiseFn(29, 12);
    // noise for half a minute, then a rail-to-rail square at a loop resonance
    const hot = (f) => (t) => (t < 30 ? f() : (t * 55) % 1 < 0.5 ? 12 : -12);
    let top = 0, topFirst = 0, topLast = 0, bad = 0;
    const N = seconds * SR;
    renderModule(type, {
      seconds, params, inputs: { inL: hot(n1), inR: hot(n2) },
      onSample: (n, O) => {
        const a = Math.abs(O[0]), b = Math.abs(O[1]), v = a > b ? a : b;
        if (!(v < 1e6)) bad++;
        if (v > top) top = v;
        if (n < 10 * SR) { if (v > topFirst) topFirst = v; } else if (n > N - 10 * SR && v > topLast) topLast = v;
      },
    });
    assert.equal(bad, 0, `${type}: blew up`);
    assert.ok(top < 12, `${type} ${JSON.stringify(params)}: peak ${top.toFixed(2)} V, the rails are at 12`);
    assert.ok(topLast <= topFirst * 1.25 + 0.5 || params.feedback >= 1, `${type} ${JSON.stringify(params)}: still growing, ${topFirst.toFixed(2)} then ${topLast.toFixed(2)} V`);
    rows.push(`${type} ${top.toFixed(1)}`);
  }
  report(`peak volts over 60 s: ${rows.join(', ')}`);
});

test('tails die away to silence, no denormal drip and no stuck DC', () => {
  for (const type of ['delay', 'reverb', 'spring', 'chorus', 'phaser', 'flanger', 'stutter']) {
    const on = (t) => (t < 0.5 ? 5 * Math.sin(2 * Math.PI * 110 * t) : 0);
    const params = { mix: 1 };
    if (type === 'delay') Object.assign(params, { time: 0.5, feedback: 0.4 });
    if (type === 'reverb') params.decay = 0.2;
    if (type === 'spring') params.decay = 0.1;
    const r = renderModule(type, { seconds: 7, params, inputs: { inL: on } });
    const tail = rms(has(r.outL, 7 * SR), 6.5 * SR, 7 * SR);
    assert.ok(tail < 1e-4, `${type} rings on at ${tail.toExponential(2)} V`);
  }
});

test('defaults on an acid line: level near unity, no DC, nothing near the rails', () => {
  // a 16th-note saw line through a decaying envelope: what these sit behind most of the time
  const notes = [0, 0, 12, 0, 3, 0, 7, 15];
  const acid = (t) => {
    const step = Math.floor(t * 8.8), f = 55 * 2 ** (notes[step % 8] / 12), p = t * 8.8 - step;
    return 5 * Math.exp(-p * 2.5) * (((t * f) % 1) * 2 - 1);
  };
  const rows = [];
  for (const type of ['delay', 'reverb', 'spring', 'chorus', 'phaser', 'flanger', 'comp', 'eq3']) {
    const r = renderModule(type, { seconds: 6, inputs: { inL: acid } });
    const y = new Float64Array(6 * SR).map((_, n) => acid(n / SR));
    const gain = db(rms(has(r.outL, 6 * SR), 3 * SR) / rms(y, 3 * SR));
    const dc = Math.abs(mean(r.outL, 3 * SR)) - Math.abs(mean(y, 3 * SR)), top = peak(r.outL, 3 * SR);
    rows.push(`${type} ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}`);
    assert.ok(Math.abs(gain) < 5, `${type}: ${gain.toFixed(1)} dB`);
    assert.ok(dc < 0.05, `${type}: adds ${dc.toFixed(3)} V of DC`);
    assert.ok(top < 9, `${type}: peak ${top.toFixed(2)} V`);
    assert.ok(correlation(r.outL, r.outR, 3 * SR, 3.5 * SR, 0) > 0.2 || type === 'delay', `${type}: the sides fell apart`);
  }
  report(`default level on an acid line, dB: ${rows.join(', ')}`);
});

test('an unpatched right input follows the left', () => {
  for (const type of ['delay', 'reverb', 'spring', 'chorus', 'phaser', 'flanger', 'comp', 'eq3', 'stutter']) {
    const f = (t) => 2 * Math.sin(2 * Math.PI * 220 * t);
    const mono = renderModule(type, { seconds: 0.2, params: { mix: 0 }, inputs: { inL: f } });
    if (type === 'eq3') {
      const eq = renderModule(type, { seconds: 0.2, inputs: { inL: f } });
      assert.equal(eq.outL[9000], eq.outR[9000]);
    } else {
      assert.ok(Math.abs(mono.outR[9000] - f(9000 / SR)) < 1e-9, `${type}: R is not L at MIX 0`);
    }
  }
});

test('memory is sized from the sample rate, not fixed', () => {
  const words = (o) => {
    let n = 0;
    const seen = new Set();
    const walk = (v) => {
      if (!v || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (ArrayBuffer.isView(v)) { n += v.length; return; }
      for (const k of Object.keys(v)) if (k !== 'ui' && k !== 'wave' && k !== 'linked' && k !== 'rack') walk(v[k]);
    };
    walk(o);
    return n;
  };
  for (const type of ['delay', 'reverb', 'chorus', 'flanger', 'stutter', 'spring']) {
    const a = words(renderModule(type, { seconds: 0.001, sr: 24000 }).instance);
    const b = words(renderModule(type, { seconds: 0.001, sr: 96000 }).instance);
    assert.ok(b / a > 2 && b / a < 8, `${type}: ${a} → ${b} words`);
  }
});
