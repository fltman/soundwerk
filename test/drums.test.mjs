// The drum voices against what the real machines do, measured from outside: nobody can listen
// during the build. NUMBERS=1 prints what was measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDef } from '../src/modules/index.js';
import { kick } from '../src/modules/drums.js';
import { DrumMetal } from '../src/modules/lib/index.js';
import { renderModule, fft, rms, peak, mean, db, pitchHz } from './lib/dsp.mjs';

const log = process.env.NUMBERS ? (...a) => console.log(...a) : () => {};
const cents = (a, b) => 1200 * Math.log2(a / b);
const SR = 48000;

// ── rendering ───────────────────────────────────────────
// 1 ms, 10 V pulses, the trigger the sequencers send
const pulses = (...times) => (t) => {
  for (let k = 0; k < times.length; k++) if (t >= times[k] && t < times[k] + 0.001) return 10;
  return 0;
};

// the `out` jack of a render; `r.out` itself is the map of every output
function outOf(r) {
  const x = r.out.out;
  assert.ok(x instanceof Float64Array && x.length > 0, 'the render has no `out` samples');
  return x;
}

function play(type, { times = [0.01], port = 'trig', inputs = {}, ...opts } = {}) {
  return outOf(renderModule(type, { seconds: 1, sr: SR, ...opts, inputs: { [port]: pulses(...times), ...inputs } }));
}

const reading = (type, name, v) => {
  const text = getDef(type).params.find((p) => p.name === name).format(v);
  const m = text.match(/^([\d.]+) (s|ms|Hz|kHz)$/);
  assert.ok(m, `can't read "${text}"`);
  return Number(m[1]) * { s: 1, ms: 0.001, Hz: 1, kHz: 1000 }[m[2]];
};

// ── detectors ───────────────────────────────────────────
// RMS in sliding frames, in dB re 1 V: { t: frame centres, v }
function frames(x, sr, winMs, hopMs = winMs / 4) {
  const win = Math.round((winMs * sr) / 1000), hop = Math.max(1, Math.round((hopMs * sr) / 1000));
  const t = [], v = [];
  for (let a = 0; a + win <= x.length; a += hop) { t.push((a + win / 2) / sr); v.push(db(rms(x, a, a + win))); }
  return { t, v };
}

// Reverb time of a hit at `from` seconds: from the hit until the envelope has gone 60 dB below its peak for good.
function t60(x, sr, from, winMs = 5) {
  const f = frames(x, sr, winMs);
  const top = Math.max(...f.v);
  let last = 0;
  for (let k = 0; k < f.v.length; k++) if (f.v[k] >= top - 60) last = f.t[k];
  return last - from;
}

// A centred moving average: moves no crossing, and keeps noise from adding its own
function smooth(x, n) {
  const y = new Float64Array(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] - (x[i - 2 * n - 1] ?? 0);
    if (i >= n) y[i - n] = sum / (2 * n + 1);
  }
  return y;
}

// Instantaneous frequency from every zero crossing, up and down: [{ t, hz }]
function track(x, sr, from, to) {
  const c = [];
  for (let i = Math.max(1, Math.floor(from * sr)); i < Math.min(x.length, to * sr); i++) {
    if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] > 0 && x[i] <= 0)) c.push((i - 1 + x[i - 1] / (x[i - 1] - x[i])) / sr);
  }
  const out = [];
  for (let k = 1; k < c.length; k++) out.push({ t: (c[k] + c[k - 1]) / 2, hz: 0.5 / (c[k] - c[k - 1]) });
  return out;
}

// When the track comes within `tol` of `hz` and stays there, interpolated between half cycles.
function settles(tr, hz, tol = 0.1) {
  const line = hz * (1 + tol);
  for (let k = tr.length - 1; k >= 0; k--) {
    if (tr[k].hz > line) {
      const b = tr[k + 1];
      return b ? tr[k].t + ((tr[k].hz - line) / (tr[k].hz - b.hz)) * (b.t - tr[k].t) : tr[k].t;
    }
  }
  return tr[0]?.t ?? 0;
}

// The ratio a sweep starts at, at the hit: the first half cycle has no crossing before it, so fit
// the exponential the track falls along and read it back to t = 0
function sweepStart(tr, hz) {
  const p = tr.filter((f) => f.hz > hz * 1.12).slice(0, 6);
  assert.ok(p.length >= 2, 'too few half cycles above the base to fit');
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (const f of p) { const y = Math.log(f.hz / hz - 1); st += f.t; sy += y; stt += f.t * f.t; sty += f.t * y; }
  const slope = (p.length * sty - st * sy) / (p.length * stt - st * st);
  return 1 + Math.exp((sy - slope * st) / p.length);
}

// Hann-windowed power spectrum of x[a..b]; samples outside x count as silence
function power(x, sr, a, b) {
  const len = b - a;
  let size = 2;
  while (size < len) size *= 2;
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let i = 0; i < len; i++) re[i] = (x[a + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
  fft(re, im);
  const p = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return { p, binHz: sr / size };
}
// `dur` seconds after a hit at sample n, with the window's top on the hit so the attack counts in full
const hitPower = (x, sr, n, dur) => power(x, sr, n - Math.round(dur * sr), n + Math.round(dur * sr));
function band(s, lo, hi) {
  let e = 0;
  for (let k = Math.max(1, Math.ceil(lo / s.binHz)); k < s.p.length && k * s.binHz < hi; k++) e += s.p[k];
  return e;
}
const total = (s) => band(s, 0, Infinity);
const centroid = (s) => {
  let e = 0, m = 0;
  for (let k = 1; k < s.p.length; k++) { e += s.p[k]; m += s.p[k] * k * s.binHz; }
  return m / e;
};

// Amplitude of `hz` in x[a..b], Hann-windowed.
function toneAt(x, sr, a, b, hz) {
  let re = 0, im = 0;
  const w = (2 * Math.PI * hz) / sr, len = b - a;
  for (let i = 0; i < len; i++) {
    const v = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len));
    re += v * Math.cos(w * i); im += v * Math.sin(w * i);
  }
  return (Math.hypot(re, im) * 4) / len;
}
// The strongest frequency between lo and hi, to 1 Hz
function strongest(x, sr, a, b, lo, hi) {
  let best = lo, top = 0;
  for (let hz = lo; hz <= hi; hz += 1) {
    const v = toneAt(x, sr, a, b, hz);
    if (v > top) { top = v; best = hz; }
  }
  return best;
}

// Onsets of a burst train: peaks of the smoothed envelope that stand `min` dB above the dip before them.
function onsets(env, sr, min = 3) {
  const peaks = [];
  let dip = Infinity, top = -Infinity, at = 0, armed = false;
  for (let i = 0; i < env.length; i++) {
    const v = db(env[i]);
    if (armed) {
      if (v > top) { top = v; at = i; }
      if (v < top - min) { peaks.push({ t: at / sr, db: top }); armed = false; dip = v; }
    } else {
      dip = Math.min(dip, v);
      if (v > dip + min) { armed = true; top = v; at = i; }
    }
  }
  if (armed) peaks.push({ t: at / sr, db: top });
  return peaks;
}
// Rectify and smooth, 0.4 ms
function envelope(x, sr) {
  const a = 1 - Math.exp(-1 / (0.0004 * sr));
  const y = new Float64Array(x.length);
  let z = 0;
  for (let i = 0; i < x.length; i++) { z += a * (Math.abs(x[i]) - z); y[i] = z; }
  return y;
}

// Tones repeat sample for sample from hit to hit and noise doesn't, so the difference of two hits is
// the noise alone, however bright the tones are. In dB against the hit, over `dur` seconds.
function noiseShare(type, params, dur = 0.1) {
  const n1 = 480, n2 = n1 + 2 * SR, len = Math.round(dur * SR);
  const x = play(type, { params, times: [n1 / SR, n2 / SR], seconds: (n2 + len) / SR + 0.01 });
  assert.ok(n2 + len <= x.length, 'the render reaches the end of the second hit');
  const d = new Float64Array(len);
  for (let i = 0; i < len; i++) d[i] = x[n1 + i] - x[n2 + i];
  return db(rms(d) / Math.SQRT2) - db(rms(x, n1, n1 + len));
}

// The worst sample-to-sample jump in x[a..b]
function jump(x, a, b) {
  let w = 0;
  for (let i = Math.max(1, a); i < b; i++) w = Math.max(w, Math.abs(x[i] - x[i - 1]));
  return w;
}

// ── the detectors, against signals whose answer is known ─
test('calibration: the detectors read synthetic signals correctly', () => {
  const N = SR;
  // a decaying sine with a T60 of 0.5 s
  const decay = new Float64Array(N);
  for (let i = 0; i < N; i++) decay[i] = 5 * Math.sin((2 * Math.PI * 200 * i) / SR) * 10 ** ((-3 * i) / (0.5 * SR));
  assert.ok(Math.abs(t60(decay, SR, 0) - 0.5) < 0.02, `t60 reads ${t60(decay, SR, 0)}`);

  // a chirp with a known law: f(t) = 50 (1 + 4 e^(-t/0.011))
  const chirp = new Float64Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const f = 50 * (1 + 4 * Math.exp(-i / SR / 0.011));
    chirp[i] = Math.sin(ph);
    ph += (2 * Math.PI * f) / SR;
  }
  const tr = track(chirp, SR, 0, 0.5);
  const want = 0.011 * Math.log(40); // the time f is within 10 %
  assert.ok(Math.abs(settles(tr, 50) - want) < 0.003, `settles reads ${settles(tr, 50)}, want ${want}`);
  assert.ok(Math.abs(tr.at(-1).hz - 50) < 0.1, `track reads ${tr.at(-1).hz}`);

  // four bursts 10 ms apart
  const bursts = new Float64Array(0.1 * SR);
  for (let i = 0; i < bursts.length; i++) {
    const age = (i / SR) % 0.01;
    bursts[i] = i < 0.04 * SR ? Math.exp(-age / 0.0025) * Math.sin(i) : 0;
  }
  const on = onsets(envelope(bursts, SR), SR);
  assert.equal(on.length, 4, `found ${on.length} bursts`);
  assert.ok(Math.abs(on[3].t - on[0].t - 0.03) < 0.001);

  // a tone at 2 kHz lands in the right band and nowhere else
  const tone = new Float64Array(4096);
  for (let i = 0; i < 4096; i++) tone[i] = Math.sin((2 * Math.PI * 2000 * i) / SR);
  const s = power(tone, SR, 0, 4096);
  assert.ok(band(s, 1500, 2500) / total(s) > 0.999);
  assert.ok(Math.abs(toneAt(tone, SR, 0, 4096, 2000) - 1) < 0.01);
  assert.ok(Math.abs(strongest(tone, SR, 0, 4096, 1000, 3000) - 2000) <= 1);
});

// ── kick ────────────────────────────────────────────────
const lateTrack = (x, from = 0.15, to = 0.4) => pitchHz(x.subarray(Math.round(from * SR), Math.round(to * SR)), SR, 0);

test('kick: the pitch settles exactly on TUNE', () => {
  for (const tune of [35, 50, 65, 80]) {
    const x = play('kick', { times: [0], params: { tune, decay: 0.9 } });
    const got = lateTrack(x);
    log(`kick TUNE ${tune} Hz settles at ${got.toFixed(3)} Hz`);
    assert.ok(Math.abs(cents(got, tune)) < 3, `TUNE ${tune}: settled at ${got.toFixed(3)} Hz`);
  }
});

test('kick: the sweep starts several times up and reaches the base in 30 to 50 ms', () => {
  for (const sweep of [2, 3, 5, 7, 9]) {
    const x = play('kick', { times: [0], params: { tune: 50, sweep, attack: 0 } });
    const tr = track(x, SR, 0, 0.3);
    const took = settles(tr, 50);
    log(`kick SWEEP ${sweep}:1: starts ×${sweepStart(tr, 50).toFixed(2)}, within 10 % at ${(took * 1000).toFixed(1)} ms`);
    assert.ok(took >= 0.03 && took <= 0.05, `SWEEP ${sweep}: ${(took * 1000).toFixed(1)} ms`);
    const start = sweepStart(tr, 50);
    assert.ok(Math.abs(start / sweep - 1) < 0.1, `SWEEP ${sweep}: starts at ×${start.toFixed(2)}`);
  }
  for (const tune of [35, 80]) {
    const took = settles(track(play('kick', { times: [0], params: { tune, attack: 0 } }), SR, 0, 0.3), tune);
    log(`kick TUNE ${tune} Hz: within 10 % at ${(took * 1000).toFixed(1)} ms`);
    assert.ok(took >= 0.03 && took <= 0.05, `TUNE ${tune}: ${(took * 1000).toFixed(1)} ms`);
  }
  // the default is a real sweep, and it survives the click
  const tr = track(play('kick', { times: [0] }), SR, 0.003, 0.3);
  assert.ok(tr[0].hz > 3 * 50, `default starts at ${tr[0].hz.toFixed(0)} Hz`);
  assert.ok(tr.length > 20, 'the track saw the kick');
  for (let k = 2; k < tr.length; k++) assert.ok(tr[k].hz <= tr[k - 1].hz * 1.02, `the pitch rises at ${tr[k].t}`);
});

test('kick: the 808 mode sweeps gently, and the V/OCT jack transposes', () => {
  const tr = track(play('kick', { times: [0], params: { mode: 1, attack: 0 } }), SR, 0, 0.3);
  const start = sweepStart(tr, 50), took = settles(tr, 50);
  log(`kick 808 starts ×${start.toFixed(2)}, within 10 % at ${(took * 1000).toFixed(1)} ms`);
  assert.ok(start > 1.4 && start < 2.5, `808 starts ×${start}`);
  assert.ok(took > 0.02 && took < 0.05, `808 sweep ${took}`);
  for (const v of [-1, 1]) {
    const x = play('kick', { times: [0], inputs: { pitch: v } });
    const got = lateTrack(x);
    assert.ok(Math.abs(cents(got, 50 * 2 ** v)) < 3, `${v} V: ${got}`);
  }
});

test('kick: T60 is what the DECAY knob says; the 808 mode is three times as long', () => {
  for (const decay of [0.15, 0.52, 0.85]) {
    const x = play('kick', { seconds: 3, params: { decay } });
    const got = t60(x, SR, 0.01, 40), said = reading('kick', 'decay', decay);
    log(`kick DECAY says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.15, `says ${said}, measures ${got}`);
    const boom = t60(play('kick', { seconds: 6, params: { decay, mode: 1 } }), SR, 0.01, 40);
    log(`  808 T60 ${boom.toFixed(3)} s`);
    assert.ok(Math.abs(boom / got - 3) < 0.45, `808 ${boom} against ${got}`);
  }
  // the CV jack moves it
  const a = t60(play('kick', { seconds: 3, inputs: { decay: 0 } }), SR, 0.01, 40);
  const b = t60(play('kick', { seconds: 3, inputs: { decay: 5 } }), SR, 0.01, 40);
  assert.ok(b > a * 1.4, `CV: ${a} to ${b}`);
});

test('kick: ATTACK is a click in the first few ms; DRIVE adds harmonics, not level', () => {
  const n = Math.round(0.01 * SR);
  const hf = (attack) => {
    const x = play('kick', { params: { attack } });
    const s = power(x, SR, n - 240, n + 240);
    return db(Math.sqrt(band(s, 2000, 9000)));
  };
  log(`kick click 2-9 kHz in the first 5 ms: ATTACK 0 ${hf(0).toFixed(1)}, 0.5 ${hf(0.5).toFixed(1)}, 1 ${hf(1).toFixed(1)} dB`);
  assert.ok(hf(0.5) > hf(0) + 12, 'the default has a click');
  assert.ok(hf(1) > hf(0.5) + 3, 'and more of it at full');

  const third = (drive) => {
    const x = play('kick', { times: [0], params: { drive, decay: 0.9 } });
    const a = Math.round(0.15 * SR), b = Math.round(0.35 * SR);
    return db(toneAt(x, SR, a, b, 150) / toneAt(x, SR, a, b, 50));
  };
  const clean = third(0), dirty = third(1);
  log(`kick third harmonic: DRIVE 0 ${clean.toFixed(1)} dB, DRIVE 1 ${dirty.toFixed(1)} dB`);
  assert.ok(clean < -30, `DRIVE 0: ${clean} dB`);
  assert.ok(dirty > -16, `DRIVE 1: ${dirty} dB`);
  for (const drive of [0, 0.3, 1]) {
    const top = peak(play('kick', { params: { drive } }));
    assert.ok(top >= 5 && top <= 8.5, `DRIVE ${drive}: peak ${top.toFixed(2)} V`);
  }
});

// ── snare ───────────────────────────────────────────────
const SNARE_TONES = [180, 330];

test('snare: two tones at their frequencies, after a pitch drop', () => {
  const x = play('snare', { times: [0], params: { snappy: 0, decay: 1 } });
  const a = Math.round(0.03 * SR), b = Math.round(0.15 * SR);
  const lo = strongest(x, SR, a, b, 120, 250), hi = strongest(x, SR, a, b, 260, 450);
  log(`snare tones ${lo} Hz and ${hi} Hz`);
  assert.ok(Math.abs(lo / 180 - 1) < 0.03, `low tone ${lo}`);
  assert.ok(Math.abs(hi / 330 - 1) < 0.03, `high tone ${hi}`);
  const ratio = toneAt(x, SR, a, b, hi) / toneAt(x, SR, a, b, lo);
  assert.ok(ratio > 0.2 && ratio < 1, `the high tone sits ${db(ratio).toFixed(1)} dB under the low`);
  // crossings per second, early against settled
  const rate = (from, to) => track(x, SR, from, to).length / (to - from);
  const drop = rate(0, 0.012) / rate(0.03, 0.042);
  log(`snare pitch drop: ×${drop.toFixed(2)} in the first 12 ms`);
  assert.ok(drop > 1.2, `pitch drop ×${drop.toFixed(2)}`);
  // TUNE moves both
  const up = play('snare', { times: [0], params: { snappy: 0, decay: 1, tune: 7 } });
  const moved = strongest(up, SR, a, b, 200, 330);
  assert.ok(Math.abs(moved / (180 * 2 ** (7 / 12)) - 1) < 0.03, `TUNE +7 st: ${moved}`);
});

test('snare: the noise is highpassed and balanced against the tones; SNAPPY sets the balance', () => {
  const n = Math.round(0.01 * SR);
  const balance = (params) => {
    const s = hitPower(play('snare', { params }), SR, n, 0.17);
    return { ratio: 10 * Math.log10(band(s, 1500, 16000) / band(s, 100, 500)), low: band(s, 20, 700), all: total(s), s };
  };
  const dflt = balance({}), wet = balance({ snappy: 1 }), lit = balance({ snappy: 0.2 });
  const gone = noiseShare('snare', { snappy: 0 }), there = noiseShare('snare', {});
  log(`snare noise/tone: SNAPPY 0.2 ${lit.ratio.toFixed(1)} dB, default ${dflt.ratio.toFixed(1)} dB, SNAPPY 1 ${wet.ratio.toFixed(1)} dB; noise share default ${there.toFixed(1)} dB, SNAPPY 0 ${gone.toFixed(1)} dB`);
  assert.ok(dflt.ratio > -6 && dflt.ratio < 6, `default balance ${dflt.ratio} dB`);
  assert.ok(gone < -120, `SNAPPY 0 still has noise: ${gone.toFixed(1)} dB`);
  assert.ok(there > -12, `the default has noise: ${there.toFixed(1)} dB`);
  assert.ok(wet.ratio > dflt.ratio + 2.5 && dflt.ratio > lit.ratio + 6, `SNAPPY: ${lit.ratio}, ${dflt.ratio}, ${wet.ratio} dB`);
  const bright = hitPower(play('snare', { params: { tone: 1, snappy: 1 } }), SR, n, 0.17);
  const dark = hitPower(play('snare', { params: { tone: 0, snappy: 1 } }), SR, n, 0.17);
  log(`snare noise centroid above 1.5 kHz: TONE 0 ${centroidAbove(dark, 1500).toFixed(0)}, TONE 1 ${centroidAbove(bright, 1500).toFixed(0)} Hz`);
  assert.ok(centroidAbove(bright, 1500) > centroidAbove(dark, 1500) * 1.4, 'TONE moves the noise');
});

function centroidAbove(s, lo) {
  let e = 0, m = 0;
  for (let k = Math.ceil(lo / s.binHz); k < s.p.length; k++) { e += s.p[k]; m += s.p[k] * k * s.binHz; }
  return m / e;
}

test('snare: T60 is what DECAY says', () => {
  for (const decay of [0.2, 0.5, 0.9]) {
    const got = t60(play('snare', { seconds: 1.5, params: { decay } }), SR, 0.01), said = reading('snare', 'decay', decay);
    log(`snare DECAY says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.2, `says ${said}, measures ${got}`);
  }
});

// ── hats ────────────────────────────────────────────────
for (const port of ['closed', 'open']) {
  test(`hats: a ${port} hit lives above 6 kHz, with nearly nothing below 1 kHz`, () => {
    const dur = port === 'closed' ? 0.1 : 0.34, n = Math.round(0.4 * SR);
    const x = play('hats', { port, times: [0.4], seconds: 1.2 });
    const s = hitPower(x, SR, n, dur);
    const high = band(s, 6000, Infinity) / total(s), low = 10 * Math.log10(band(s, 0, 1000) / total(s));
    log(`hats ${port}: ${(high * 100).toFixed(1)} % of the energy above 6 kHz, below 1 kHz ${low.toFixed(1)} dB, centroid ${centroid(s).toFixed(0)} Hz`);
    assert.ok(high > 0.85, `${(high * 100).toFixed(1)} % above 6 kHz`);
    assert.ok(low < -60, `below 1 kHz: ${low.toFixed(1)} dB`);
    assert.ok(centroid(s) > 7500 && centroid(s) < 12000, `centroid ${centroid(s).toFixed(0)} Hz`);
  });
}

// The share of the 6-14 kHz energy within 12 Hz of an odd harmonic of the six oscillators, and
// what chance alone would give: the share of the band those lines cover.
function onTheLines(x, tune = 0) {
  const hz = [205.3, 304.4, 369.6, 522.7, 540, 800].map((f) => f * 2 ** (tune / 12));
  const a = Math.round(0.2 * SR), s = power(x, SR, a, a + 65536);
  const lines = [];
  for (const f of hz) for (let n = 1; f * n < 20000; n += 2) lines.push(f * n);
  const near = (f) => lines.some((l) => Math.abs(l - f) < 12);
  let on = 0, all = 0;
  for (let k = 0; k < s.p.length; k++) {
    const f = k * s.binHz;
    if (f < 6000 || f > 14000) continue;
    all += s.p[k];
    if (near(f)) on += s.p[k];
  }
  assert.ok(all > 0, 'the band has energy');
  let cover = 0, bins = 0;
  for (let f = 6000; f < 14000; f += 2) { bins++; if (near(f)) cover++; }
  return { share: on / all, chance: cover / bins };
}

for (const tune of [0, 12]) {
  test(`hats: at TUNE ${tune} the partials are the odd harmonics of the six oscillators, not aliases`, () => {
    const x = play('hats', { port: 'open', times: [0.2], seconds: 1.8, params: { decayO: 1, tune } });
    const { share, chance } = onTheLines(x, tune);
    log(`hats TUNE ${tune}: ${(share * 100).toFixed(2)} % of the 6-14 kHz energy on the oscillators' lines (chance ${(chance * 100).toFixed(0)} %)`);
    assert.ok(share > 0.8, `only ${(share * 100).toFixed(1)} % on the lines`);
  });
}

test('hats: T60 is what the two DECAY knobs say, and TONE moves the band', () => {
  for (const decayC of [0.2, 0.5, 0.9]) {
    const got = t60(play('hats', { port: 'closed', params: { decayC } }), SR, 0.01, 2), said = reading('hats', 'decayC', decayC);
    log(`hats closed says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.2, `says ${said}, measures ${got}`);
  }
  for (const decayO of [0.2, 0.5, 0.9]) {
    const got = t60(play('hats', { port: 'open', seconds: 2, params: { decayO } }), SR, 0.01), said = reading('hats', 'decayO', decayO);
    log(`hats open says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.2, `says ${said}, measures ${got}`);
  }
  const n = Math.round(0.01 * SR);
  const c = (tone) => centroid(hitPower(play('hats', { port: 'open', params: { tone } }), SR, n, 0.17));
  log(`hats centroid: TONE 0 ${c(0).toFixed(0)} Hz, TONE 1 ${c(1).toFixed(0)} Hz`);
  assert.ok(c(1) > c(0) * 1.2, `TONE: ${c(0)} to ${c(1)}`);
});

test('hats: a closed hit silences an open one within 10 ms', () => {
  const T = 0.2, n = Math.round(T * SR), ms = (v) => n + Math.round((v * SR) / 1000);
  const both = outOf(renderModule('hats', { seconds: 0.5, sr: SR, inputs: { open: pulses(0.01), closed: pulses(T) } }));
  const alone = outOf(renderModule('hats', { seconds: 0.5, sr: SR, inputs: { closed: pulses(T) } }));
  const open = outOf(renderModule('hats', { seconds: 0.5, sr: SR, inputs: { open: pulses(0.01) } }));
  // the oscillators run free, so what's left of the open hit is the difference
  const rest = new Float64Array(both.length);
  for (let i = 0; i < rest.length; i++) rest[i] = both[i] - alone[i];
  const at = (a, b) => db(rms(rest, ms(a), ms(b))) - db(rms(open, ms(a), ms(b)));
  log(`hats choke: open hit ${at(0, 2).toFixed(1)} dB at 0-2 ms, ${at(5, 7).toFixed(1)} dB at 5-7 ms, ${at(10, 12).toFixed(1)} dB at 10-12 ms`);
  assert.ok(at(10, 12) < -50, `10 ms on, the open hit is at ${at(10, 12).toFixed(1)} dB`);
  assert.ok(at(30, 60) < -80, `later, ${at(30, 60).toFixed(1)} dB`);

  // and an open hit doesn't choke an open hit, or the closed knob the open tail
  const twice = outOf(renderModule('hats', { seconds: 0.5, sr: SR, inputs: { open: pulses(0.01, T) } }));
  assert.ok(rms(twice, ms(30), ms(60)) > rms(open, ms(30), ms(60)) * 2, 'an open hit stays open');
  // both on one sample is an open hit
  const same = outOf(renderModule('hats', { seconds: 1, sr: SR, inputs: { open: pulses(0.01), closed: pulses(0.01) } }));
  const got = t60(same, SR, 0.01), said = reading('hats', 'decayO', 0.5);
  assert.ok(Math.abs(got / said - 1) < 0.2, `both at once rings ${got} s`);
});

// ── clap ────────────────────────────────────────────────
// many claps, aligned, so the noise averages out of the envelope
function clapEnvelope(params, hits = 24) {
  const gap = 0.3, times = Array.from({ length: hits }, (_, k) => 0.01 + k * gap);
  const x = play('clap', { times, seconds: 0.01 + hits * gap, params: { decay: 0.1, ...params } });
  const env = envelope(x, SR), len = Math.round(0.07 * SR);
  const mean_ = new Float64Array(len);
  for (const t of times) {
    const a = Math.round(t * SR);
    for (let i = 0; i < len; i++) mean_[i] += env[a + i] / hits;
  }
  return mean_;
}

test('clap: four bursts ten milliseconds apart', () => {
  const on = onsets(clapEnvelope({}), SR);
  log(`clap onsets at ${on.map((b) => (b.t * 1000).toFixed(1)).join(', ')} ms`);
  assert.equal(on.length, 4, `${on.length} bursts`);
  for (let k = 1; k < on.length; k++) {
    const d = (on[k].t - on[k - 1].t) * 1000;
    assert.ok(Math.abs(d - 10) < 1, `burst ${k} is ${d.toFixed(2)} ms after the last`);
  }
});

test('clap: the bursts are distinct, and SPREAD moves them', () => {
  const env = clapEnvelope({});
  const on = onsets(env, SR);
  const a = Math.round(on[0].t * SR), b = Math.round(on[1].t * SR);
  let dip = Infinity;
  for (let i = a; i < b; i++) dip = Math.min(dip, db(env[i]));
  log(`clap dip between bursts ${(on[0].db - dip).toFixed(1)} dB`);
  assert.ok(on[0].db - dip > 8, `only ${(on[0].db - dip).toFixed(1)} dB between bursts`);
  for (const spread of [0.25, 0.8]) {
    const got = onsets(clapEnvelope({ spread }), SR);
    const said = reading('clap', 'spread', spread);
    const each = (got[3].t - got[0].t) / 3;
    log(`clap SPREAD says ${(said * 1000).toFixed(1)} ms, spacing ${(each * 1000).toFixed(1)} ms`);
    assert.equal(got.length, 4);
    assert.ok(Math.abs(each / said - 1) < 0.12, `says ${said}, spacing ${each}`);
  }
});

test('clap: the tail is noise in a band near 1 kHz, with the T60 DECAY says', () => {
  const n = Math.round(0.01 * SR);
  const x = play('clap', {});
  const s = hitPower(x, SR, n, 0.34);
  const inBand = band(s, 500, 2000) / total(s), c = centroid(s);
  log(`clap: ${(inBand * 100).toFixed(1)} % of the energy in 500-2000 Hz, centroid ${c.toFixed(0)} Hz`);
  assert.ok(inBand > 0.6, `${(inBand * 100).toFixed(1)} % in band`);
  assert.ok(c > 800 && c < 1800, `centroid ${c}`);
  for (const decay of [0.2, 0.5, 0.9]) {
    const got = t60(play('clap', { seconds: 1.8, params: { decay } }), SR, 0.04, 10), said = reading('clap', 'decay', decay); // the tail opens at the fourth burst
    log(`clap DECAY says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.2, `says ${said}, measures ${got}`);
  }
  const bright = centroid(hitPower(play('clap', { params: { tone: 1 } }), SR, n, 0.17));
  const dark = centroid(hitPower(play('clap', { params: { tone: 0 } }), SR, n, 0.17));
  log(`clap centroid: TONE 0 ${dark.toFixed(0)} Hz, TONE 1 ${bright.toFixed(0)} Hz`);
  assert.ok(bright > dark * 2, `TONE: ${dark} to ${bright}`);
});

// ── tom ─────────────────────────────────────────────────
test('tom: settles on TUNE after a sweep, with a hint of noise', () => {
  for (const tune of [0.2, 0.42, 0.8]) {
    const x = play('tom', { times: [0], params: { tune, decay: 1 } });
    const said = reading('tom', 'tune', tune);
    const got = pitchHz(x.subarray(Math.round(0.2 * SR), Math.round(0.5 * SR)), SR, 0);
    log(`tom TUNE says ${said.toFixed(1)} Hz, settles at ${got.toFixed(1)} Hz`);
    assert.ok(Math.abs(cents(got, said)) < 25, `says ${said}, settles at ${got}`); // the reading has 3 digits
  }
  const base = 60 * (320 / 60) ** 0.42;
  const tr = track(smooth(play('tom', { times: [0], params: { sweep: 2, decay: 1 } }), 12), SR, 0, 0.3);
  const start = sweepStart(tr, base);
  log(`tom SWEEP 2: starts ×${start.toFixed(2)} the base`);
  assert.ok(Math.abs(start / 2 - 1) < 0.1, `starts ×${start}`);
  const flat = track(smooth(play('tom', { times: [0], params: { sweep: 1, decay: 1 } }), 12), SR, 0.02, 0.2);
  assert.ok(flat.length > 20, 'the track saw the tom');
  assert.ok(flat.every((f) => Math.abs(cents(f.hz, base)) < 30), 'SWEEP 1 stays on pitch');

  // the noise: well under the tone, and gone quickly
  const early = noiseShare('tom', {}, 0.04), late = noiseShare('tom', {}, 0.3);
  log(`tom noise: ${early.toFixed(1)} dB over the first 40 ms, ${late.toFixed(1)} dB over 300 ms`);
  assert.ok(early > -40 && early < -20, `a hint of noise, ${early.toFixed(1)} dB`);
  assert.ok(late < early, 'and it goes');
});

test('tom: T60 is what DECAY says; the conga is higher, shorter and clean', () => {
  for (const decay of [0.2, 0.5, 0.9]) {
    const got = t60(play('tom', { seconds: 2, params: { decay } }), SR, 0.01, 20), said = reading('tom', 'decay', decay);
    log(`tom DECAY says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.15, `says ${said}, measures ${got}`);
  }
  const conga = play('tom', { times: [0], seconds: 2, params: { mode: 1, decay: 1 } });
  const tom_ = play('tom', { times: [0], seconds: 2, params: { mode: 0, decay: 1 } });
  const pitch = (x) => pitchHz(x.subarray(Math.round(0.15 * SR), Math.round(0.4 * SR)), SR, 0);
  const ratio = pitch(conga) / pitch(tom_), shorter = t60(tom_, SR, 0, 20) / t60(conga, SR, 0, 20);
  log(`conga: pitch ×${ratio.toFixed(2)}, T60 ÷${shorter.toFixed(2)}`);
  assert.ok(ratio > 1.7 && ratio < 2.1, `pitch ×${ratio}`);
  assert.ok(shorter > 2 && shorter < 3, `T60 ÷${shorter}`);
  const noise = noiseShare('tom', { mode: 1 }, 0.04);
  log(`conga noise in the first 40 ms: ${noise.toFixed(1)} dB`);
  assert.ok(noise < -120, `the conga has noise: ${noise.toFixed(1)} dB`);
});

// ── perc ────────────────────────────────────────────────
const RIM = 0, BELL = 1, CLAVE = 2, SHAKE = 3;

test('perc: the cowbell is two squares at 540 and 800 Hz through a bandpass', () => {
  const x = play('perc', { params: { mode: BELL } });
  const a = Math.round(0.02 * SR), b = Math.round(0.34 * SR);
  const low = strongest(x, SR, a, b, 450, 650), high = strongest(x, SR, a, b, 700, 950);
  log(`cowbell ${low} Hz and ${high} Hz`);
  assert.ok(Math.abs(low / 540 - 1) < 0.01, `low ${low}`);
  assert.ok(Math.abs(high / 800 - 1) < 0.01, `high ${high}`);
  // squares: only odd harmonics
  assert.ok(toneAt(x, SR, a, b, 1620) > toneAt(x, SR, a, b, 1080) * 10, 'a square has no second harmonic');
  const up = play('perc', { params: { mode: BELL, tune: 12 } });
  assert.ok(Math.abs(strongest(up, SR, a, b, 1400, 1800) / 1600 - 1) < 0.01, 'TUNE +12 st doubles it');
  // a hit, then a ring
  const f = frames(x, SR, 5, 1);
  const level = (t) => f.v[f.t.findIndex((c) => c >= t + 0.01)]; // t after the hit
  const fast = (level(0.006) - level(0.03)) / 0.024, slow = (level(0.12) - level(0.3)) / 0.18;
  log(`cowbell falls ${fast.toFixed(0)} dB/s, then ${slow.toFixed(0)} dB/s`);
  assert.ok(fast > slow * 2, `first stage ${fast} dB/s, second ${slow} dB/s`);
});

test('perc: rimshot and clave ring where they should, briefly', () => {
  const rim = play('perc', { params: { mode: RIM } });
  const a = Math.round(0.01 * SR), b = Math.round(0.05 * SR);
  const high = strongest(rim, SR, a, b, 1300, 2100), low = strongest(rim, SR, a, b, 350, 600);
  const clave = play('perc', { params: { mode: CLAVE } });
  const cl = strongest(clave, SR, a, b, 1800, 3200);
  const tRim = t60(rim, SR, 0.01, 2), tCl = t60(clave, SR, 0.01, 2);
  log(`rimshot ${high} and ${low} Hz, T60 ${(tRim * 1000).toFixed(0)} ms; clave ${cl} Hz, T60 ${(tCl * 1000).toFixed(0)} ms`);
  assert.ok(Math.abs(high / 1700 - 1) < 0.03, `rimshot high ${high}`);
  assert.ok(Math.abs(low / 460 - 1) < 0.05, `rimshot low ${low}`);
  assert.ok(Math.abs(cl / 2500 - 1) < 0.02, `clave ${cl}`);
  assert.ok(tRim < 0.08 && tRim > 0.02, `rimshot T60 ${tRim}`);
  assert.ok(tCl < 0.09 && tCl > 0.03, `clave T60 ${tCl}`);
  const longer = t60(play('perc', { params: { mode: CLAVE, decay: 1 } }), SR, 0.01, 2);
  assert.ok(longer > tCl * 2, `DECAY: ${tCl} to ${longer}`);
});

test('perc: the shaker is high noise that swells in', () => {
  const n = Math.round(0.01 * SR);
  const x = play('perc', { params: { mode: SHAKE } });
  const s = hitPower(x, SR, n, 0.17);
  const high = band(s, 4000, Infinity) / total(s);
  const f = frames(x, SR, 2, 0.5);
  let top = 0;
  for (let k = 0; k < f.v.length; k++) if (f.v[k] > f.v[top]) top = k;
  const tTop = f.t[top] - 0.01, tEnd = t60(x, SR, 0.01, 2);
  log(`shaker: ${(high * 100).toFixed(1)} % above 4 kHz, peak at ${(tTop * 1000).toFixed(1)} ms, T60 ${(tEnd * 1000).toFixed(0)} ms`);
  assert.ok(high > 0.9, `${(high * 100).toFixed(1)} % above 4 kHz`);
  assert.ok(tTop > 0.002 && tTop < 0.03, `peaks at ${tTop}`);
  assert.ok(tEnd > 0.06 && tEnd < 0.25, `T60 ${tEnd}`);
  const up = centroid(hitPower(play('perc', { params: { mode: SHAKE, tune: 12 } }), SR, n, 0.17));
  assert.ok(up > centroid(s) * 1.2, `TUNE moves the band: ${centroid(s)} to ${up}`);
});

// ── ride ────────────────────────────────────────────────
test('ride: a long metal cymbal; the crash is longer and more noise', () => {
  for (const decay of [0.2, 0.5, 0.9]) {
    const got = t60(play('ride', { seconds: 7, params: { decay } }), SR, 0.01, 20), said = reading('ride', 'decay', decay);
    log(`ride DECAY says ${said.toFixed(3)} s, T60 ${got.toFixed(3)} s`);
    assert.ok(Math.abs(got / said - 1) < 0.2, `says ${said}, measures ${got}`);
  }
  const ride_ = play('ride', { seconds: 6, times: [0.5] });
  const crash = play('ride', { seconds: 8, times: [0.5], params: { mode: 1 } });
  const tr = t60(ride_, SR, 0.5, 20), tc = t60(crash, SR, 0.5, 20);
  log(`ride T60 ${tr.toFixed(2)} s, crash T60 ${tc.toFixed(2)} s`);
  assert.ok(tr > 1, `ride ${tr}`);
  assert.ok(tc / tr > 1.3 && tc / tr < 1.7, `crash ÷ ride ${tc / tr}`);

  const n = Math.round(0.5 * SR);
  for (const [name, x] of [['ride', ride_], ['crash', crash]]) {
    const s = hitPower(x, SR, n, 0.34);
    const high = band(s, 2500, Infinity) / total(s), low = 10 * Math.log10(band(s, 0, 500) / total(s));
    log(`${name}: ${(high * 100).toFixed(1)} % above 2.5 kHz, below 500 Hz ${low.toFixed(1)} dB, centroid ${centroid(s).toFixed(0)} Hz`);
    assert.ok(high > 0.9, `${name}: ${(high * 100).toFixed(1)} %`);
    assert.ok(low < -50, `${name}: below 500 Hz ${low.toFixed(1)} dB`);
  }
});

test('ride: the wash fills in between the partials; TONE moves it', () => {
  // the crash's extra noise: the floor between the lines rises against the ride's
  const n = Math.round(0.5 * SR);
  const floor = (mode) => {
    const x = play('ride', { seconds: 3, times: [0.5], params: { mode } });
    const s = power(x, SR, n + 4800, n + 4800 + 16384);
    const v = [];
    for (let k = Math.round(5000 / s.binHz); k < Math.round(11000 / s.binHz); k++) v.push(s.p[k]);
    v.sort((a, b) => a - b);
    return 10 * Math.log10(v[Math.floor(v.length / 2)] / v[Math.floor(v.length * 0.98)]); // median against the peaks
  };
  log(`cymbal floor under the peaks: ride ${floor(0).toFixed(1)} dB, crash ${floor(1).toFixed(1)} dB`);
  assert.ok(floor(1) > floor(0) + 3, `crash floor ${floor(1)}, ride floor ${floor(0)}`);
  const s = (tone) => centroid(hitPower(play('ride', { seconds: 1.5, times: [0.5], params: { tone } }), SR, n, 0.34));
  log(`ride centroid: TONE 0 ${s(0).toFixed(0)} Hz, TONE 1 ${s(1).toFixed(0)} Hz`);
  assert.ok(s(1) > s(0) * 1.25, `TONE: ${s(0)} to ${s(1)}`);
});

// ── every voice ─────────────────────────────────────────
// A hit of every voice and mode, and how long its tail is at default.
const VOICES = [
  { name: 'kick', type: 'kick', top: [5, 8], tail: 0.5 },
  { name: 'kick 808', type: 'kick', params: { mode: 1 }, top: [5, 8], tail: 1.4 },
  { name: 'snare', type: 'snare', top: [3.5, 7], tail: 0.25, noisy: true },
  { name: 'closed hat', type: 'hats', port: 'closed', top: [2, 6], tail: 0.1, noisy: true },
  { name: 'open hat', type: 'hats', port: 'open', top: [2, 6], tail: 0.42, noisy: true },
  { name: 'clap', type: 'clap', top: [3.5, 7], tail: 0.3, noisy: true, onset: 0.035 },
  { name: 'tom', type: 'tom', top: [3.5, 7], tail: 0.4, noisy: true },
  { name: 'conga', type: 'tom', params: { mode: 1 }, top: [3.5, 7], tail: 0.2 },
  { name: 'rimshot', type: 'perc', params: { mode: RIM }, top: [2.5, 6.5], tail: 0.06 },
  { name: 'cowbell', type: 'perc', params: { mode: BELL }, top: [2.5, 6.5], tail: 0.45, noisy: true },
  { name: 'clave', type: 'perc', params: { mode: CLAVE }, top: [2.5, 6.5], tail: 0.07 },
  { name: 'shaker', type: 'perc', params: { mode: SHAKE }, top: [2.5, 6.5], tail: 0.13, noisy: true, onset: 0.015 },
  { name: 'ride', type: 'ride', top: [1.5, 6], tail: 1.8, noisy: true },
  { name: 'crash', type: 'ride', params: { mode: 1 }, top: [1.5, 6], tail: 2.7, noisy: true },
];

for (const v of VOICES) {
  const opts = (more = {}) => ({ port: v.port, ...more, params: { ...v.params, ...more.params } });

  test(`${v.name}: nothing without a trigger`, () => {
    const x = play(v.type, opts({ times: [], seconds: 0.2 }));
    assert.ok(x.every((s) => s === 0), 'a voice at rest is silent');
  });

  test(`${v.name}: hits at a sensible level and falls to silence`, () => {
    const seconds = Math.max(1, v.tail * 2.4);
    const x = play(v.type, opts({ seconds }));
    const top = peak(x);
    log(`${v.name}: peak ${top.toFixed(2)} V`);
    assert.ok(top >= v.top[0] && top <= v.top[1], `peak ${top.toFixed(2)} V, want ${v.top}`);
    const after = Math.round(v.tail * 2 * SR);
    assert.ok(after + 4800 < x.length, 'the render reaches past the tail');
    const rest = db(rms(x, after)) - db(top);
    assert.ok(rest < -90, `after the tail: ${rest.toFixed(1)} dB`);
    assert.ok(Math.abs(mean(x, after)) < 1e-4 * top, `DC after the tail: ${mean(x, after)} V`);
    assert.ok(Math.abs(mean(x)) < 0.05, `DC over the hit: ${mean(x)} V`);
  });

  test(`${v.name}: a retrigger is no worse a click than the attack itself`, () => {
    const hit = 0.01, n0 = Math.round(hit * SR), win = Math.round((v.onset ?? 0.002) * SR), HITS = 16;
    // as many hits from silence as retriggers, so a noisy voice is compared like against like
    const gap = Math.max(0.3, v.tail * 2.2), own = [];
    const alone = play(v.type, opts({ seconds: gap * HITS, times: Array.from({ length: HITS }, (_, k) => hit + k * gap) }));
    for (let k = 0; k < HITS; k++) {
      const a = Math.round((hit + k * gap) * SR);
      own.push(jump(alone, a - 1, a + win));
    }
    // across the tail, at offsets that fall on every phase of the tone
    const seconds = hit + 0.15 + v.tail * 0.6 + (v.onset ?? 0);
    const cut = [];
    for (let k = 0; k < HITS; k++) {
      const delay = 0.012 + (k / HITS) * (0.11 + v.tail * 0.6) + k * 0.00017;
      const x = play(v.type, opts({ seconds, times: [hit, hit + delay] }));
      const a = n0 + Math.round(delay * SR);
      cut.push(jump(x, a - 1, a + win));
    }
    assert.equal(own.length, HITS);
    assert.equal(cut.length, HITS);
    const med = (l) => [...l].sort((p, q) => p - q)[l.length >> 1];
    const attack = Math.max(...own), worst = Math.max(...cut);
    assert.ok(attack > 0, 'the attack was measured');
    log(`${v.name}: attack jump ${med(own).toFixed(3)} / ${attack.toFixed(3)} V, retrigger ${med(cut).toFixed(3)} / ${worst.toFixed(3)} V (median / worst)`);
    if (v.noisy) {
      // the tallest of 16 random jumps is a coin toss either way: the middle of the two sets says more
      assert.ok(med(cut) <= med(own) * 1.1, `retrigger median ${med(cut).toFixed(3)} V, attack ${med(own).toFixed(3)} V`);
      assert.ok(worst <= attack * 1.25, `retrigger worst ${worst.toFixed(3)} V, attack ${attack.toFixed(3)} V`);
    } else {
      assert.ok(worst <= attack * 1.02, `retrigger jumps ${worst.toFixed(3)} V, the attack ${attack.toFixed(3)} V`);
    }
  });

  test(`${v.name}: accent raises the level by a set amount, 0 V changes nothing`, () => {
    const level = (accent) => {
      const inputs = accent === undefined ? {} : { accent };
      const x = play(v.type, opts({ seconds: 0.4, inputs }));
      return db(rms(x, 0, Math.round(0.1 * SR)));
    };
    const off = level(undefined), zero = level(0), half = level(5), hard = level(10), below = level(-8);
    const top = peak(play(v.type, opts({ seconds: 0.4, inputs: { accent: 10 } })));
    log(`${v.name}: accent 5 V +${(half - off).toFixed(2)} dB, 10 V +${(hard - off).toFixed(2)} dB, peak ${top.toFixed(2)} V`);
    assert.equal(zero, off, 'accent at 0 V is no accent');
    assert.equal(below, off, 'accent only raises');
    assert.ok(hard - off >= 3 && hard - off <= 7, `10 V: +${(hard - off).toFixed(2)} dB`);
    assert.ok(half - off > 1 && half < hard, `5 V: +${(half - off).toFixed(2)} dB`);
    assert.ok(top < 12, `accented peak ${top.toFixed(2)} V reaches the rail`);
  });

  test(`${v.name}: the same drum at 44.1 and 96 kHz`, () => {
    const seconds = Math.max(0.6, v.tail * 1.8), HITS = 12, gap = 0.25;
    const render = (sr, times, secs) => outOf(renderModule(v.type, { sr, seconds: secs, params: v.params, inputs: { [v.port ?? 'trig']: pulses(...times) } }));
    const win = v.type === 'kick' ? 40 : 10;
    const ta = t60(render(44100, [0.01], seconds), 44100, 0.01, win), tb = t60(render(96000, [0.01], seconds), 96000, 0.01, win);
    // what's heard, 20 Hz to 16 kHz: a 96 kHz render has plenty above that
    const times = Array.from({ length: HITS }, (_, k) => 0.01 + k * gap);
    const heard = (sr) => {
      const x = render(sr, times, HITS * gap + 0.1);
      let e = 0, seen = 0;
      for (const t of times) {
        const s = hitPower(x, sr, Math.round(t * sr), 0.1);
        e += band(s, 20, 16000) / (s.p.length * sr);
        seen++;
      }
      assert.equal(seen, HITS);
      return 10 * Math.log10(e / HITS);
    };
    const la = heard(44100), lb = heard(96000);
    log(`${v.name}: T60 ${ta.toFixed(3)} / ${tb.toFixed(3)} s, level ${la.toFixed(2)} / ${lb.toFixed(2)} dB`);
    assert.ok(Math.abs(ta / tb - 1) < 0.1, `T60 ${ta} against ${tb}`);
    assert.ok(Math.abs(la - lb) < 1, `level ${la} against ${lb}`);
  });
}

// ── the bars can fail ───────────────────────────────────
// a planted fault has to trip each detector, or a pass says nothing
test('control: a kick that cuts its tail on a retrigger fails the click bar', () => {
  class Naive extends kick.dsp {
    constructor(sr) {
      super(sr);
      this.fix = { arm() {}, tick: (x) => x, clear() {} };
    }
  }
  const def = { ...kick, dsp: Naive };
  const hit = 0.01, n0 = Math.round(hit * SR), win = Math.round(0.002 * SR);
  const opts = { sr: SR, params: { attack: 0 } };
  const first = outOf(renderModule('kick', { ...opts, def, seconds: 0.2, inputs: { trig: pulses(hit) } }));
  const attack = jump(first, n0 - 1, n0 + win);
  let worst = 0, fixed = 0;
  for (let k = 0; k < 24; k++) {
    const delay = 0.012 + k * 0.0023;
    const a = n0 + Math.round(delay * SR);
    const inputs = { trig: pulses(hit, hit + delay) };
    worst = Math.max(worst, jump(outOf(renderModule('kick', { ...opts, def, seconds: 0.2, inputs })), a - 1, a + win));
    fixed = Math.max(fixed, jump(outOf(renderModule('kick', { ...opts, seconds: 0.2, inputs })), a - 1, a + win));
  }
  log(`no declick: attack ${attack.toFixed(3)} V, cut ${worst.toFixed(3)} V; with it ${fixed.toFixed(3)} V`);
  assert.ok(worst > attack * 5, `the cut reads ${worst.toFixed(3)} V against ${attack.toFixed(3)} V`);
  assert.ok(fixed <= attack * 1.02, `with no click to hide in, a retrigger jumps ${fixed.toFixed(3)} V, the attack ${attack.toFixed(3)} V`);
});

test('control: hats tuned a little off fail the partials bar', () => {
  const hats = getDef('hats');
  class Off extends hats.dsp {
    constructor(sr) { super(sr); this.metal = new DrumMetal(sr, hats.dsp.HZ.map((f) => f * 1.017)); }
  }
  const def = { ...hats, dsp: Off };
  const x = outOf(renderModule('hats', { def, seconds: 1.8, sr: SR, params: { decayO: 1 }, inputs: { open: pulses(0.2) } }));
  const { share, chance } = onTheLines(x);
  log(`hats 30 cents sharp: ${(share * 100).toFixed(1)} % on the lines (chance ${(chance * 100).toFixed(0)} %)`);
  assert.ok(share < 0.5, `a detuned bank still reads ${(share * 100).toFixed(1)} %`);
});

test('control: hats with no choke fail the choke bar', () => {
  const hats = getDef('hats');
  class Free extends hats.dsp {
    constructor(sr) { super(sr); this.chokeK = 0.99995; }
  }
  const def = { ...hats, dsp: Free };
  const T = 0.2, n = Math.round(T * SR), a = n + Math.round(0.01 * SR), b = n + Math.round(0.012 * SR);
  const both = outOf(renderModule('hats', { def, seconds: 0.5, sr: SR, inputs: { open: pulses(0.01), closed: pulses(T) } }));
  const alone = outOf(renderModule('hats', { def, seconds: 0.5, sr: SR, inputs: { closed: pulses(T) } }));
  const open = outOf(renderModule('hats', { def, seconds: 0.5, sr: SR, inputs: { open: pulses(0.01) } }));
  const rest = both.map((s, i) => s - alone[i]);
  const left = db(rms(rest, a, b)) - db(rms(open, a, b));
  log(`no choke: the open hit is at ${left.toFixed(1)} dB`);
  assert.ok(left > -3, `the bar can't see an unchoked hit: ${left.toFixed(1)} dB`);
});

// ── a kit ───────────────────────────────────────────────
test('kit: the defaults sit together at 130 BPM', () => {
  const beat = 60 / 130, step = beat / 4;
  const loud = (x) => db(rms(x, 0, Math.round(0.1 * SR))); // the first 100 ms, what the ear weighs
  const of = (type, more = {}) => loud(play(type, { times: [0.001], seconds: 0.2, ...more }));
  const k = of('kick'), s = of('snare'), c = of('clap'), ch = of('hats', { port: 'closed' }), oh = of('hats', { port: 'open' }), r = of('ride');
  log(`kit, RMS against the kick: snare ${(s - k).toFixed(1)}, clap ${(c - k).toFixed(1)}, closed hat ${(ch - k).toFixed(1)}, open hat ${(oh - k).toFixed(1)}, ride ${(r - k).toFixed(1)} dB`);
  assert.ok(s < k && s > k - 9, `snare ${s - k} dB against the kick`);
  assert.ok(c < k && c > k - 9, `clap ${c - k} dB`);
  assert.ok(ch < s - 3 && ch > k - 20, `closed hat ${ch - k} dB`);
  assert.ok(oh < s && oh > k - 16, `open hat ${oh - k} dB`);
  assert.ok(r < s && r > k - 22, `ride ${r - k} dB`);

  // tails against the grid
  const tk = t60(play('kick', { seconds: 1 }), SR, 0.01, 40);
  const tc = t60(play('hats', { port: 'closed', seconds: 0.5 }), SR, 0.01, 2);
  const to = t60(play('hats', { port: 'open', seconds: 1 }), SR, 0.01);
  log(`kit tails: kick ${(tk / beat).toFixed(2)} beats, closed hat ${(tc / step).toFixed(2)} steps, open hat ${(to / beat).toFixed(2)} beats`);
  assert.ok(tk < beat * 1.15 && tk > beat * 0.65, `the kick rings ${(tk / beat).toFixed(2)} beats`);
  assert.ok(tc < step * 1.1, `the closed hat rings ${(tc / step).toFixed(2)} steps`);
  assert.ok(to > beat * 0.5 && to < beat * 1.2, `the open hat rings ${(to / beat).toFixed(2)} beats`);

  // four on the floor, offbeat hats, a clap on two and four: no cable near the rails
  const times = (fn, bars = 2) => { const t = []; for (let n = 0; n < bars * 16; n++) if (fn(n)) t.push(n * step + 0.001); return t; };
  const seconds = 2 * 4 * beat;
  const bus = new Float64Array(Math.round(seconds * SR));
  const add = (x, gain = 1) => { assert.equal(x.length, bus.length); for (let i = 0; i < x.length; i++) bus[i] += x[i] * gain; };
  add(play('kick', { seconds, times: times((n) => n % 4 === 0) }));
  add(play('clap', { seconds, times: times((n) => n % 8 === 4) }));
  add(outOf(renderModule('hats', { seconds, sr: SR, inputs: { closed: pulses(...times((n) => n % 2 === 1)), open: pulses(...times((n) => n % 4 === 2)) } })));
  const top = peak(bus);
  log(`kit on one bus: peak ${top.toFixed(2)} V, RMS ${rms(bus).toFixed(2)} V, crest ${(db(top) - db(rms(bus))).toFixed(1)} dB`);
  assert.ok(top < 14, `the kit peaks at ${top.toFixed(2)} V on one bus`);
  assert.ok(db(top) - db(rms(bus)) > 6 && db(top) - db(rms(bus)) < 20, 'a kit has punch: a crest between 6 and 20 dB');
});
