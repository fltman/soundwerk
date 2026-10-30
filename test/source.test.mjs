// The other oscillators against what each should do, measured from outside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, pitchHz, peakHz, bandLevel, spectrum, rms, peak, mean, db, fft } from './lib/dsp.mjs';

const C4 = 261.6255653005986;
const cents = (a, b) => 1200 * Math.log2(a / b);
// A module's jack called `out` is r.out.out: r.out itself is the map of every jack, and has no length.
const outOf = (r) => { const y = r.out.out; assert.ok(y?.length > 0, 'no samples rendered'); return y; };

// worst line not on the harmonic series of f, relative to the fundamental, below `top` Hz
function aliasDb(x, sr, f, top = sr / 2) {
  const s = spectrum(x, sr);
  let w = 0;
  for (let k = 5; k < s.mag.length && k * s.binHz < top; k++) {
    const hz = k * s.binHz;
    if (Math.abs(hz / f - Math.round(hz / f)) * f > 40) w = Math.max(w, s.mag[k]);
  }
  return db(w / bandLevel(x, sr, f - 30, f + 30));
}

// Welch: mean power per bin
function psd(x, sr, size) {
  const P = new Float64Array(size / 2);
  let segs = 0;
  for (let at = 0; at + size <= x.length; at += size / 2, segs++) {
    const s = spectrum(x, sr, size, at);
    for (let k = 0; k < P.length; k++) P[k] += s.mag[k] * s.mag[k];
  }
  const binHz = sr / size;
  return { P: P.map((v) => v / segs / binHz), binHz }; // per Hz, so two FFT sizes can be compared
}
// dB per Hz in each octave band from `lo`, with the straight-line slope through them
function octaveSlope(x, sr, lo, hi) {
  const a = psd(x, sr, 65536), b = psd(x, sr, 4096);
  const bands = [];
  for (let f = lo; f * 2 <= hi; f *= 2) {
    const s = f < 400 ? a : b; // fine bins low, many averages high
    let e = 0, n = 0;
    for (let k = Math.ceil(f / s.binHz); k * s.binHz < f * 2; k++) { e += s.P[k]; n++; }
    bands.push({ oct: Math.log2(f), level: 10 * Math.log10(e / n) });
  }
  const N = bands.length, mx = bands.reduce((u, v) => u + v.oct, 0) / N, my = bands.reduce((u, v) => u + v.level, 0) / N;
  let num = 0, den = 0;
  for (const v of bands) { num += (v.oct - mx) * (v.level - my); den += (v.oct - mx) ** 2; }
  const slope = num / den;
  let worst = 0;
  for (const v of bands) worst = Math.max(worst, Math.abs(v.level - (my + slope * (v.oct - mx))));
  return { slope, worst, bands: N };
}

// ── the detectors first ──────────────────────────────────
test('the noise-slope detector reads a known spectrum correctly', () => {
  // noise shaped in the frequency domain to exactly 1/f power: nothing to do with the module
  const n = 1 << 20, re = new Float64Array(n), im = new Float64Array(n);
  let s = 12345;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let k = 1; k < n / 2; k++) {
    const g = 1 / Math.sqrt(k), a = rnd() * 2 * Math.PI * 2;
    re[k] = g * Math.cos(a); im[k] = g * Math.sin(a);
    re[n - k] = re[k]; im[n - k] = -im[k];
  }
  fft(re, im);
  const got = octaveSlope(re, 48000, 20, 16000);
  assert.ok(Math.abs(got.slope + 3.01) < 0.1, `detector reads ${got.slope.toFixed(2)} dB/oct on true pink`);
});

test('the pitch detector reads a decaying tone of known pitch to a fraction of a cent', () => {
  for (const f of [55, 220.5, 1760]) {
    const n = 96000, x = new Float64Array(n);
    for (let k = 0; k < n; k++) x[k] = Math.exp(-k / 48000) * Math.sin((2 * Math.PI * f * k) / 48000);
    assert.ok(Math.abs(cents(peakHz(x, 48000, f * 0.8, f * 1.2), f)) < 0.3, `${f}`);
  }
});

// ── supersaw ─────────────────────────────────────────────
test('supersaw: seven voices where the JP measurements put them', (t) => {
  const off = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
  // full detune is exactly 1 on the curve; look at the fundamentals of a 500 Hz note
  const f = 500, v = Math.log2(f / C4);
  const r = renderModule('supersaw', { params: { detune: 1, mix: 1, width: 0 }, inputs: { pitch: v }, seconds: 3 });
  const s = spectrum(r.l, r.sr, 131072);
  for (const o of off) {
    const want = f * (1 + o), got = peakHz(r.l, r.sr, want - 4, want + 4, 131072);
    assert.ok(Math.abs(got - want) < 1, `voice at ${want}: found ${got}`);
    assert.ok(bandLevel(r.l, r.sr, want - 2, want + 2, 131072) > 0.2, `voice at ${want} is missing`);
  }
  // and the gaps between them are empty
  let gap = 0;
  for (let k = Math.ceil((f * 0.965) / s.binHz); k * s.binHz < f * 0.973; k++) gap = Math.max(gap, s.mag[k]);
  t.diagnostic(`gap between voices ${db(gap / bandLevel(r.l, r.sr, f - 2, f + 2, 131072)).toFixed(1)} dB`);
  assert.ok(gap < 0.1 * bandLevel(r.l, r.sr, f - 2, f + 2, 131072));
});

test('supersaw: no detune is one saw, on pitch', () => {
  const r = renderModule('supersaw', { params: { detune: 0, mix: 1, width: 0 }, inputs: { pitch: -1 }, seconds: 2 });
  const got = peakHz(r.l, r.sr, 100, 160);
  assert.ok(Math.abs(cents(got, 130.8128)) < 6, `${got}`); // the curve's own floor is 0.003 of full detune
});

test('supersaw: mix moves level from the middle voice to the six around it, as measured', () => {
  const f = 500, v = Math.log2(f / C4);
  const level = (mix) => {
    const r = renderModule('supersaw', { params: { detune: 1, mix, width: 0 }, inputs: { pitch: v }, seconds: 3 });
    return bandLevel(r.l, r.sr, f - 2, f + 2, 131072) / bandLevel(r.l, r.sr, f * 1.0199 - 2, f * 1.0199 + 2, 131072);
  };
  const want = (x) => (-0.55366 * x + 0.99785) / (-0.73764 * x * x + 1.2841 * x + 0.04471);
  for (const x of [0.25, 0.5, 1]) assert.ok(Math.abs(cents(level(x), want(x)) / 1200 * 6.02) < 1.5, `mix ${x}: ${level(x)} vs ${want(x)}`);
});

test('supersaw: stereo that sums, level on target, no DC, nothing below the note', (t) => {
  const r = renderModule('supersaw', { inputs: { pitch: -2 }, seconds: 14 }); // longer than its slowest beat
  const n = r.l.length;
  let lr = 0, ll = 0, rr = 0;
  for (let k = 0; k < n; k++) { lr += r.l[k] * r.r[k]; ll += r.l[k] ** 2; rr += r.r[k] ** 2; }
  const corr = lr / Math.sqrt(ll * rr);
  t.diagnostic(`L/R correlation ${corr.toFixed(3)}, rms ${rms(r.l).toFixed(2)} ${rms(r.r).toFixed(2)} V, peak ${peak(r.l).toFixed(2)} V`);
  assert.ok(corr > 0.1 && corr < 0.8, `L/R correlation ${corr}`);
  assert.ok(Math.abs(db(rms(r.l) / rms(r.r))) < 1, 'lopsided');
  assert.ok(rms(r.l) > 2 && rms(r.l) < 3.6, `rms ${rms(r.l)}`);
  assert.ok(peak(r.l) < 11, `peak ${peak(r.l)}`);
  assert.ok(Math.abs(mean(r.l)) < 0.05, `DC ${mean(r.l)}`);
});

test('supersaw: band-limited, however high and wide', (t) => {
  const f = C4 * 2 ** 3;
  const r = renderModule('supersaw', { params: { detune: 0.5, mix: 0.6 }, inputs: { pitch: 3 }, seconds: 2 });
  // with seven voices the series is every voice's; count what lands where no voice has a harmonic
  const s = spectrum(r.l, r.sr);
  const sp = [-0.11002313, -0.06288439, -0.01952356, 0, 0.01991221, 0.06216538, 0.10745242];
  const y = 0.098; // the curve at 0.5
  let w = 0;
  for (let k = 5; k * s.binHz < 18000; k++) {
    const hz = k * s.binHz;
    let near = Infinity;
    for (const o of sp) {
      const h = f * (1 + o * y);
      near = Math.min(near, Math.abs(hz / h - Math.round(hz / h)) * h);
    }
    if (near > 45) w = Math.max(w, s.mag[k]);
  }
  const dB = db(w / Math.max(...s.mag));
  t.diagnostic(`supersaw alias ${dB.toFixed(1)} dB`);
  assert.ok(dB < -55, `${dB}`);
});

// ── chord ────────────────────────────────────────────────
const CHORDS = { MINOR: [0, 3, 7], MIN7: [0, 3, 7, 10], MIN9: [0, 3, 7, 10, 14], MAJ7: [0, 4, 7, 11], SUS2: [0, 2, 7], SUS4: [0, 5, 7], '5TH': [0, 7, 12], M11: [0, 3, 7, 10, 14, 17] };

test('chord: every chord has its notes and nothing else near them', (t) => {
  const names = Object.keys(CHORDS);
  const f0 = 110, v = Math.log2(f0 / C4);
  names.forEach((name, kind) => {
    const r = renderModule('chord', { params: { kind, detune: 0 }, inputs: { pitch: v }, seconds: 2 });
    const y = outOf(r);
    const level = (st) => bandLevel(y, r.sr, f0 * 2 ** (st / 12) - 2, f0 * 2 ** (st / 12) + 2);
    const top = Math.max(...CHORDS[name].map(level));
    for (let st = 0; st <= 17; st++) {
      const here = level(st), inChord = CHORDS[name].includes(st);
      // a chord tone's own harmonics can fall on a semitone: only fundamentals of low notes are clean
      const harmonicOf = CHORDS[name].some((n) => { const h = 2 ** ((st - n) / 12); return st > n && Math.abs(h - Math.round(h)) < 0.02; });
      if (inChord) assert.ok(here > top * 0.35, `${name}: note +${st} too quiet (${(here / top).toFixed(3)})`);
      else if (!harmonicOf) assert.ok(here < top * 0.02, `${name}: +${st} should be silent, is ${(here / top).toFixed(3)}`);
    }
  });
  t.diagnostic(`checked ${names.length} chords over 18 semitones`);
});

test('chord: the root is exactly where the pitch says, and detune splits it symmetrically', () => {
  const f = 110, v = Math.log2(f / C4), ct = 12;
  const r = renderModule('chord', { params: { kind: 6, detune: ct }, inputs: { pitch: v }, seconds: 3 });
  const y = outOf(r);
  const up = peakHz(y, r.sr, f, f * 1.02, 131072), down = peakHz(y, r.sr, f * 0.98, f, 131072);
  assert.ok(Math.abs(cents(up, f) - ct) < 0.6, `up ${cents(up, f)}`);
  assert.ok(Math.abs(cents(down, f) + ct) < 0.6, `down ${cents(down, f)}`);
});

test('chord: every chord and wave sits at the same level', (t) => {
  const seen = [];
  for (let wave = 0; wave < 2; wave++) {
    for (let kind = 0; kind < 8; kind++) {
      const r = renderModule('chord', { params: { kind, wave }, inputs: { pitch: -1 }, seconds: 1 });
      const y = outOf(r);
      assert.ok(Math.abs(mean(y)) < 0.05, `DC ${mean(y)}`);
      assert.ok(peak(y) < 11, `peak ${peak(y)}`);
      seen.push(rms(y));
    }
  }
  const spread = db(Math.max(...seen) / Math.min(...seen));
  t.diagnostic(`rms ${Math.min(...seen).toFixed(2)}..${Math.max(...seen).toFixed(2)} V, spread ${spread.toFixed(1)} dB`);
  assert.ok(Math.min(...seen) > 1.8 && Math.max(...seen) < 5, `rms ${seen}`);
  assert.ok(spread < 3, `spread ${spread}`);
});

test('chord: inversion raises the bottom notes an octave', () => {
  const f0 = 110, v = Math.log2(f0 / C4);
  const r = renderModule('chord', { params: { kind: 0, inv: 1, detune: 0 }, inputs: { pitch: v }, seconds: 2 });
  const y = outOf(r), lvl = (hz) => bandLevel(y, r.sr, hz - 2, hz + 2);
  assert.ok(lvl(f0) < 0.02 * lvl(f0 * 2), 'the root is still at the bottom');
});

// ── fm ───────────────────────────────────────────────────
// J_n(x) by its series
function bessel(n, x) {
  let sum = 0, term = (x / 2) ** n;
  for (let k = 1; k <= n; k++) term /= k;
  for (let m = 0; m < 40; m++) {
    sum += term;
    term *= -(x * x) / 4 / ((m + 1) * (m + 1 + n));
  }
  return sum;
}

test('the Bessel reference is right', () => {
  assert.ok(Math.abs(bessel(0, 1) - 0.7651976866) < 1e-9);
  assert.ok(Math.abs(bessel(1, 1) - 0.4400505857) < 1e-9);
  assert.ok(Math.abs(bessel(2, 3) - 0.4860912606) < 1e-9);
});

test('fm: the sidebands are the Bessel functions of the index', (t) => {
  let worst = 0, lines = 0;
  for (const [ratio, index] of [[2, 0.5], [2, 1], [2, 2.4], [3, 1.5], [3, 3], [1.5, 2]]) {
    const fc = 440, fm = fc * ratio, v = Math.log2(fc / C4);
    const r = renderModule('fm', { params: { ratio, index, feedback: 0 }, inputs: { pitch: v }, seconds: 2 });
    const y = outOf(r), lvl = (hz) => bandLevel(y, r.sr, Math.abs(hz) - 8, Math.abs(hz) + 8);
    for (let n = 0; n <= 3; n++) {
      const want = 5 * Math.abs(bessel(n, index));
      if (want < 0.2) continue; // too small to measure against the neighbours
      const hz = fc + n * fm;
      // mirrored sidebands land back on the upper ones at some ratios: measure only clean lines
      const clash = [-1, -2, -3, -4, -5].some((m) => Math.abs(Math.abs(fc + m * fm) - hz) < 20);
      if (clash) continue;
      const err = Math.abs(db(lvl(hz) / want));
      worst = Math.max(worst, err);
      lines++;
      assert.ok(err < 0.35, `ratio ${ratio} index ${index} J${n}: ${lvl(hz).toFixed(3)}, want ${want.toFixed(3)}`);
    }
  }
  t.diagnostic(`worst sideband error ${worst.toFixed(4)} dB against J_n, over ${lines} lines`);
  assert.ok(lines >= 10, `only ${lines} lines were checked`);
});

test('fm: no index is a pure sine at 5 V, on pitch', () => {
  const r = renderModule('fm', { params: { index: 0, feedback: 0 }, inputs: { pitch: 0 }, seconds: 1 });
  const y = outOf(r);
  assert.ok(Math.abs(cents(pitchHz(y, r.sr), C4)) < 0.5);
  assert.ok(Math.abs(rms(y) - 5 / Math.SQRT2) < 0.02);
});

test('fm: feedback turns the modulator from a sine into a saw', () => {
  // index 1 ratio 1: harmonic content must grow with feedback, and stay on the series
  const hf = (feedback) => {
    const r = renderModule('fm', { params: { ratio: 1, index: 3, feedback }, inputs: { pitch: -1 }, seconds: 1 });
    return bandLevel(outOf(r), r.sr, 1500, 8000);
  };
  assert.ok(hf(1) > hf(0) * 3, `${hf(0)} → ${hf(1)}`);
});

test('fm: feedback stays bounded and tuned at every setting', () => {
  for (const feedback of [0.3, 0.7, 1]) {
    const r = renderModule('fm', { params: { ratio: 1, index: 2, feedback }, inputs: { pitch: 0 }, seconds: 1 });
    const y = outOf(r);
    assert.ok(peak(y) <= 5.001, `peak ${peak(y)}`);
    const s = spectrum(y, r.sr);
    let off = 0;
    for (let k = 5; k * s.binHz < 20000; k++) {
      const hz = k * s.binHz;
      if (Math.abs(hz / C4 - Math.round(hz / C4)) * C4 > 30) off = Math.max(off, s.mag[k]);
    }
    assert.ok(db(off / Math.max(...s.mag)) < -60, `feedback ${feedback}: ${db(off / Math.max(...s.mag)).toFixed(1)} dB off the series`);
  }
});

test('fm: a deep index on a high note folds down gracefully, not into aliases', (t) => {
  const f = 1760, v = Math.log2(f / C4);
  const r = renderModule('fm', { params: { ratio: 4, index: 12, feedback: 0 }, inputs: { pitch: v }, seconds: 1 });
  const y = outOf(r), dB = aliasDb(y, r.sr, f);
  t.diagnostic(`worst line off the series ${dB.toFixed(1)} dB`);
  assert.ok(dB < -30, `${dB}`);
});

test('fm: with a gate, the note starts bright, darkens, and the release closes it', () => {
  const r = renderModule('fm', { params: { decay: 0.3, ratio: 2, index: 6, feedback: 0 }, inputs: { pitch: -1, gate: (t) => (t < 1 ? 10 : 0) }, seconds: 1.3 });
  const y = outOf(r), sr = r.sr;
  const hf = (a, b) => bandLevel(y.subarray(a * sr, b * sr), sr, 1500, 8000, 4096) / rms(y, a * sr, b * sr);
  assert.ok(hf(0.01, 0.1) > 4 * hf(0.6, 0.7), `${hf(0.01, 0.1)} vs ${hf(0.6, 0.7)}`);
  assert.ok(rms(y, 0.01 * sr, 0.1 * sr) > 2, 'quiet attack');
  assert.ok(rms(y, 1.25 * sr, 1.3 * sr) < 0.03, `still sounding: ${rms(y, 1.25 * sr, 1.3 * sr)}`);
});

// ── wavetable ────────────────────────────────────────────
test('wavetable: on pitch from the bottom to the top', () => {
  for (const v of [-4, -2, 0, 2, 3]) {
    const r = renderModule('wavetable', { params: { morph: 0 }, inputs: { pitch: v }, seconds: 1.5 });
    assert.ok(Math.abs(cents(pitchHz(outOf(r), r.sr), C4 * 2 ** v)) < 0.5, `${v} V`);
  }
});

test('wavetable: frame 0 is a sine, clean to below -70 dB', (t) => {
  const f = 261.6255653;
  const r = renderModule('wavetable', { params: { morph: 0 }, inputs: { pitch: 0 }, seconds: 2 });
  const y = outOf(r), s = spectrum(y, r.sr);
  let w = 0;
  for (let k = 5; k < s.mag.length; k++) if (Math.abs(k * s.binHz - f) > 40) w = Math.max(w, s.mag[k]);
  const dB = db(w / 5);
  t.diagnostic(`sine frame: worst other line ${dB.toFixed(1)} dB`);
  assert.ok(dB < -70, `${dB}`);
  assert.ok(Math.abs(peak(y) - 5) < 0.05, `peak ${peak(y)}`);
});

test('wavetable: the analog bank holds a true saw and square at their frames', () => {
  const f = 130.8128, v = -1;
  const saw = outOf(renderModule('wavetable', { params: { morph: 3 / 7 }, inputs: { pitch: v }, seconds: 2 }));
  const sq = outOf(renderModule('wavetable', { params: { morph: 4 / 7 }, inputs: { pitch: v }, seconds: 2 }));
  const lvl = (x, n) => bandLevel(x, 48000, f * n - 20, f * n + 20);
  for (const n of [2, 3, 5, 8]) assert.ok(Math.abs((lvl(saw, n) / lvl(saw, 1)) * n - 1) < 0.03, `saw harmonic ${n}`);
  for (const n of [3, 5, 7]) assert.ok(Math.abs((lvl(sq, n) / lvl(sq, 1)) * n - 1) < 0.03, `square harmonic ${n}`);
  for (const n of [2, 4, 6]) assert.ok(lvl(sq, n) / lvl(sq, 1) < 0.002, `square has even harmonic ${n}`);
});

test('wavetable: band-limited on every bank, every frame, every note', (t) => {
  let worst = -200, where = '';
  for (let bank = 0; bank < 4; bank++) {
    for (const morph of [0.2, 0.5, 0.8, 1]) {
      for (const v of [0.3, 1.5, 2.6, 3.4]) {
        const f = C4 * 2 ** v;
        const r = renderModule('wavetable', { params: { bank, morph }, inputs: { pitch: v }, seconds: 1 });
        const y = outOf(r), s = spectrum(y, r.sr);
        let w = 0;
        for (let k = 5; k * s.binHz < 20000; k++) {
          const hz = k * s.binHz;
          if (Math.abs(hz / f - Math.round(hz / f)) * f > 40) w = Math.max(w, s.mag[k]);
        }
        const dB = db(w / Math.max(...s.mag));
        if (dB > worst) { worst = dB; where = `bank ${bank} morph ${morph} v ${v}`; }
      }
    }
  }
  t.diagnostic(`worst alias below 20 kHz ${worst.toFixed(1)} dB at ${where}`);
  assert.ok(worst < -60, `${worst} at ${where}`);
});

test('wavetable: climbing the keyboard crosses mips with no step in level or tone', (t) => {
  // a slow pitch ramp over the saw frame: the RMS must follow smoothly. Each window holds many
  // cycles, or the reading jitters with where the cycle was cut.
  const r = renderModule('wavetable', { params: { morph: 3 / 7 }, inputs: { pitch: (x) => 0 + x * 1.2 }, seconds: 3 });
  const y = outOf(r), w = 4800;
  let worst = 0, prev = rms(y, 0, w);
  for (let a = w; a + w <= y.length; a += w) {
    const here = rms(y, a, a + w);
    worst = Math.max(worst, Math.abs(db(here / prev)));
    prev = here;
  }
  t.diagnostic(`biggest step between 50 ms windows ${worst.toFixed(2)} dB`);
  assert.ok(worst < 0.4, `${worst}`);
});

test('wavetable: morph changes the tone smoothly, in every bank', () => {
  for (let bank = 0; bank < 4; bank++) {
    const r = renderModule('wavetable', { params: { bank, morph: 0.5 }, inputs: { pitch: -1, morph: (t) => 10 * (t - 0.5) }, depth: { morph: 0.1 }, seconds: 1 });
    const y = outOf(r);
    let jump = 0;
    for (let k = 1; k < y.length; k++) jump = Math.max(jump, Math.abs(y[k] - y[k - 1]));
    assert.ok(jump < 6, `bank ${bank}: jump of ${jump} V`);
  }
  // the banks differ from each other
  const hf = (bank) => { const r = renderModule('wavetable', { params: { bank, morph: 0.7 }, inputs: { pitch: -1 }, seconds: 1 }); return bandLevel(outOf(r), r.sr, 500, 4000); };
  assert.ok(new Set([0, 1, 2, 3].map((b) => hf(b).toFixed(2))).size === 4);
});

test('wavetable: every frame in every bank is near full scale, at 0 V DC', (t) => {
  let lo = 99;
  for (let bank = 0; bank < 4; bank++) {
    for (let k = 0; k < 8; k++) {
      const r = renderModule('wavetable', { params: { bank, morph: k / 7 }, inputs: { pitch: -2 }, seconds: 0.5 });
      const y = outOf(r), p = peak(y);
      lo = Math.min(lo, rms(y));
      assert.ok(p > 3.5 && p < 7, `bank ${bank} frame ${k}: peak ${p}`);
      assert.ok(Math.abs(mean(y)) < 0.05, `bank ${bank} frame ${k}: DC ${mean(y)}`);
    }
  }
  t.diagnostic(`quietest frame ${lo.toFixed(2)} V rms`);
  assert.ok(lo > 1, `${lo}`);
});

// ── noise ────────────────────────────────────────────────
test('noise: pink falls 3 dB/oct, brown 6, white stays flat', (t) => {
  for (const sr of [44100, 48000, 96000]) {
    const r = renderModule('noise', { seconds: 24, sr });
    const w = octaveSlope(r.white, sr, 40, 16000), p = octaveSlope(r.pink, sr, 20, 16000), b = octaveSlope(r.brown, sr, 40, 16000);
    t.diagnostic(`sr ${sr}: white ${w.slope.toFixed(2)}, pink ${p.slope.toFixed(2)} ±${p.worst.toFixed(2)}, brown ${b.slope.toFixed(2)} dB/oct ±${b.worst.toFixed(2)}`);
    assert.ok(Math.abs(w.slope) < 0.1, `white ${w.slope}`);
    assert.ok(Math.abs(p.slope + 3.01) < 0.15, `pink ${p.slope}`);
    assert.ok(p.worst < 0.5, `pink wanders ${p.worst} dB from the line`);
    assert.ok(Math.abs(b.slope + 6.02) < 0.25, `brown ${b.slope}`);
  }
});

test('noise: levels on target at every sample rate, independent of each other', (t) => {
  for (const sr of [22050, 48000, 96000]) {
    const r = renderModule('noise', { seconds: 8, sr });
    t.diagnostic(`sr ${sr}: white ${rms(r.white).toFixed(2)} pink ${rms(r.pink).toFixed(2)} brown ${rms(r.brown).toFixed(2)} V rms, peaks ${peak(r.white).toFixed(1)} ${peak(r.pink).toFixed(1)} ${peak(r.brown).toFixed(1)}`);
    assert.ok(Math.abs(rms(r.white) - 5 / Math.sqrt(3)) < 0.05);
    assert.ok(rms(r.pink) > 1.3 && rms(r.pink) < 2.2, `pink ${rms(r.pink)}`);
    assert.ok(rms(r.brown) > 1.3 && rms(r.brown) < 2.2, `brown ${rms(r.brown)}`);
    assert.ok(peak(r.pink) < 10 && peak(r.brown) < 10);
    assert.ok(Math.abs(mean(r.pink)) < 0.1 && Math.abs(mean(r.white)) < 0.02);
  }
});

test('noise: crackle comes at the density the knob says, at random', (t) => {
  for (const density of [0, 0.3, 0.6, 1]) {
    const want = 0.5 * (300 / 0.5) ** density;
    const r = renderModule('noise', { params: { density }, seconds: 40 });
    const x = r.crackle, sr = r.sr;
    const hits = [];
    for (let k = 1; k < x.length; k++) if (Math.abs(x[k] - x[k - 1] * Math.exp(-1 / sr / 0.00025)) > 1) hits.push(k);
    const rate = hits.length / 40;
    assert.ok(Math.abs(rate / want - 1) < (density === 0 ? 0.5 : 0.15), `density ${density}: ${rate.toFixed(1)}/s, want ${want.toFixed(1)}/s`);
    if (density > 0.5) {
      // Poisson: gaps have a standard deviation about equal to their mean
      const gaps = hits.slice(1).map((h, k) => h - hits[k]), m = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - m) ** 2, 0) / gaps.length);
      t.diagnostic(`density ${density}: ${rate.toFixed(1)}/s (want ${want.toFixed(1)}), gap CV ${(sd / m).toFixed(2)}`);
      assert.ok(Math.abs(sd / m - 1) < 0.15, `CV ${sd / m}`);
    }
  }
});

test('noise: crackle is sparse, sits on 0 V and goes in both directions', () => {
  const r = renderModule('noise', { params: { density: 0.45 }, seconds: 10 });
  const x = r.crackle;
  let quiet = 0, up = 0, down = 0;
  for (let k = 0; k < x.length; k++) {
    if (Math.abs(x[k]) < 0.01) quiet++;
    if (x[k] > 1) up++;
    if (x[k] < -1) down++;
  }
  assert.ok(quiet / x.length > 0.9, `silent ${(quiet / x.length).toFixed(3)} of the time`);
  assert.ok(up > 0 && down > 0 && Math.abs(Math.log2(up / down)) < 1, `up ${up} down ${down}`);
  assert.ok(peak(x) < 11 && peak(x) > 3, `peak ${peak(x)}`);
  assert.ok(Math.abs(mean(x)) < 0.02, `DC ${mean(x)}`);
});

// ── pluck ────────────────────────────────────────────────
const plucked = (v, opts = {}) => renderModule('pluck', { params: { decay: 0.8, damp: 0.5, ...opts.params }, sr: opts.sr, inputs: { pitch: v, trig: (t) => (t < 0.005 ? 10 : 0) }, seconds: opts.seconds ?? 3 });

test('pluck: in tune to within 3 cents from 55 Hz to 1760 Hz', (t) => {
  for (const sr of [44100, 48000, 96000]) {
    let worst = 0, at = 0;
    // every note of five octaves, and the fractions between them where a loop usually rounds
    for (let st = 0; st <= 60; st += 1.37) {
      const f = 55 * 2 ** (st / 12), v = Math.log2(f / C4);
      const r = plucked(v, { sr, seconds: 2.5 });
      const y = outOf(r), got = peakHz(y, sr, f * 0.93, f * 1.07, 131072), err = cents(got, f);
      if (Math.abs(err) > Math.abs(worst)) { worst = err; at = f; }
    }
    t.diagnostic(`sr ${sr}: worst tuning error ${worst.toFixed(2)} cents at ${at.toFixed(1)} Hz`);
    assert.ok(Math.abs(worst) < 3, `${worst} cents at ${at} Hz, sr ${sr}`);
  }
});

test('pluck: the top note itself, 1760 Hz, measured by zero crossings too', () => {
  const r = plucked(Math.log2(1760 / C4), { params: { decay: 0.9, damp: 0.5 }, seconds: 1 });
  const y = outOf(r);
  assert.ok(Math.abs(cents(pitchHz(y, r.sr, 9600), 1760)) < 3, `${pitchHz(y, r.sr, 9600)}`);
});

test('pluck: decay is what the knob says', (t) => {
  for (const [knob, f] of [[0.5, 110], [0.75, 110], [0.5, 880]]) {
    const claimed = 0.1 * 120 ** knob, v = Math.log2(f / C4);
    const r = plucked(v, { params: { decay: knob, damp: 0.6 }, seconds: Math.min(claimed * 1.2, 10) });
    const y = outOf(r), sr = r.sr;
    // the fundamental's own envelope, from two windows late in the note: partials have gone
    const size = 1 << 14;
    const a = Math.round(sr * 0.25), b = Math.round(sr * claimed * 0.6);
    const lvl = (at) => bandLevel(y.subarray(at, at + size), sr, f * 0.9, f * 1.1, size);
    const rate = (db(lvl(a)) - db(lvl(b))) / ((b - a) / sr);
    const t60 = 60 / rate;
    t.diagnostic(`knob ${knob} at ${f} Hz: claims ${claimed.toFixed(2)} s, measures ${t60.toFixed(2)} s`);
    assert.ok(Math.abs(Math.log2(t60 / claimed)) < 0.2, `${t60} vs ${claimed}`);
  }
});

test('pluck: DAMP takes the top off first, like a string', () => {
  const hf = (damp, a, b) => {
    const r = plucked(-2, { params: { damp } });
    const y = outOf(r);
    return bandLevel(y.subarray(a, b), r.sr, 1500, 8000, 8192) / bandLevel(y.subarray(a, b), r.sr, 50, 400, 8192);
  };
  assert.ok(hf(0.1, 4000, 12192) > 3 * hf(0.9, 4000, 12192));
  // and within one note the top decays faster than the fundamental
  assert.ok(hf(0.6, 500, 8692) > 2 * hf(0.6, 40000, 48192));
});

test('pluck: starts at once, peaks near 5 V, stays on 0 V, retriggers, and is silent until hit', (t) => {
  const r = plucked(-1);
  const y = outOf(r);
  t.diagnostic(`peak ${peak(y).toFixed(2)} V`);
  assert.ok(peak(y) > 3 && peak(y) < 9, `peak ${peak(y)}`);
  assert.ok(peak(y, 0, 96) > 1, 'slow onset');
  assert.ok(Math.abs(mean(y)) < 0.05, `DC ${mean(y)}`);
  const silent = renderModule('pluck', { inputs: { pitch: 0 }, seconds: 0.3 });
  assert.ok(peak(outOf(silent)) < 1e-9, `${peak(outOf(silent))}`);
  const twice = renderModule('pluck', { params: { decay: 0.2 }, inputs: { pitch: -1, trig: (x) => (x % 0.5 < 0.005 ? 10 : 0) }, seconds: 1 });
  const z = outOf(twice);
  assert.ok(rms(z, 24000, 26400) > 3 * rms(z, 21600, 24000), 'the second trigger did nothing');
});

test('pluck: every sound is a different pluck, and the same render every time', () => {
  const opts = { inputs: { pitch: -1, trig: (x) => (x % 0.25 < 0.005 ? 10 : 0) }, seconds: 0.5 };
  const a = outOf(renderModule('pluck', opts)), b = outOf(renderModule('pluck', opts));
  assert.deepEqual(a, b);
  let d = 0;
  for (let k = 0; k < 2000; k++) d = Math.max(d, Math.abs(a[k + 200] - a[k + 12000 + 200]));
  assert.ok(d > 0.1, 'two plucks came out identical');
});
