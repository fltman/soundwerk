// The filters against what they claim, from outside: single sines in, level out. Each bar that
// could pass by accident has a control beside it that has to fail it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, gainAt, rms, peak, mean, pitchHz, bandLevel, db } from './lib/dsp.mjs';
import { vToHz, fmtVHz, tanh, filterSolve, Module, Rng } from '../src/modules/lib/index.js';
import { getDef, paramRange } from '../src/modules/index.js';

const SRS = [44100, 48000];
const cents = (a, b) => 1200 * Math.log2(a / b);
const pct = (a, b) => 100 * (a / b - 1);
// r.out is the map of outputs: a typo here would be an empty loop, and a test that always passes
const signal = (r, name) => {
  const y = r.out[name];
  assert.ok(y?.length > 0, `no output called ${name}`);
  return y;
};

// gainAt over a whole number of periods, so the rms reads true at any frequency
function tone(type, hz, opts = {}) {
  const periods = Math.ceil(0.2 * hz);
  return gainAt(type, hz, { ...opts, seconds: Math.max((2 * periods) / hz, opts.seconds ?? 0) });
}

// Where `gain(hz)` crosses ref − 3 dB: falling for a lowpass, rising for a highpass
function corner(gain, fc, ref, rising = false) {
  let lo = fc / 4, hi = fc * 4;
  for (let i = 0; i < 16; i++) {
    const mid = Math.sqrt(lo * hi);
    if ((gain(mid) > ref * Math.SQRT1_2) !== rising) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// The strongest response between lo and hi, at a level low enough to be linear
function peakOf(type, lo, hi, opts = {}) {
  let best = 0, at = 0;
  for (let f = lo; f < hi; f *= 1.012) {
    const g = gainAt(type, f, { level: 0.02, seconds: 0.5, ...opts });
    if (g > best) { best = g; at = f; }
  }
  return { gain: best, hz: at };
}

// Harmonics 2..7 against the fundamental
function thd(y, sr, f) {
  const a = bandLevel(y, sr, f - 20, f + 20, 32768);
  let e = 0;
  for (let n = 2; n < 8; n++) e += bandLevel(y, sr, f * n - 20, f * n + 20, 32768) ** 2;
  return db(Math.sqrt(e) / a);
}

const sine = (hz, level) => (t) => level * Math.sin(2 * Math.PI * hz * t);
const saw = (hz, level) => (t) => 2 * level * (((t * hz) % 1) - 0.5);

// A TPT lowpass with one line wrong: no prewarp. What the warping bar has to catch.
const unwarped = {
  type: 'unwarped', inputs: [{ name: 'in', kind: 'audio' }], outputs: [{ name: 'lp', kind: 'audio' }],
  params: [{ name: 'cutoff', min: -5, max: 5, default: 0 }],
  dsp: class extends Module {
    constructor(sr) { super(sr); this.z1 = 0; this.z2 = 0; }
    tick(i, o, p) {
      const g = (Math.PI * vToHz(p[0])) / this.sr, k = 1.4142135623730951;
      const v1 = (this.z1 + g * (i[0] - this.z2)) / (1 + g * (g + k)), v2 = this.z2 + g * v1;
      this.z1 = 2 * v1 - this.z1; this.z2 = 2 * v2 - this.z2;
      o[0] = v2;
    }
  },
};

test('the detectors: corner() reads a known response, and the warping bar can fail', () => {
  const rc = (hz) => 1 / Math.hypot(1, hz / 1000);
  assert.ok(Math.abs(pct(corner(rc, 1000, 1), 1000)) < 0.1, 'corner() misreads a known RC');
  const v = 4.9, fc = vToHz(v), sr = 44100;
  const gain = (hz) => {
    const r = renderModule('unwarped', { def: unwarped, params: { cutoff: v }, sr, seconds: 0.2, inputs: { in: sine(hz, 1) } });
    const y = signal(r, 'lp');
    return rms(y, y.length >> 1) * Math.SQRT2;
  };
  const off = pct(corner(gain, fc, gain(fc / 16)), fc);
  assert.ok(off < -8, `no prewarp should land more than 8 % flat, reads ${off.toFixed(1)} %`);
});

test('the solver around the tanh lands within -60 dB of the true answer', () => {
  // what matters is tanh(w), the value the stages get. b is 2.08 at most, on a diode at 22 kHz.
  const truth = (a, b) => {
    let lo = -40, hi = 40;
    for (let n = 0; n < 60; n++) {
      const mid = (lo + hi) / 2;
      if (mid + b * tanh(mid) < a) lo = mid; else hi = mid;
    }
    return tanh(lo);
  };
  let worst = 0;
  for (let b = 0; b <= 3; b += 0.1) for (let a = -14; a <= 14; a += 0.05) {
    worst = Math.max(worst, Math.abs(tanh(filterSolve(a, b)) - truth(a, b)));
  }
  assert.ok(worst > 0 && db(worst) < -60, `error ${db(worst).toFixed(1)} dB`);
});

// ── ladder ────────────────────────────────────────────────
test('ladder: -3 dB within 8 % of the knob across the range', () => {
  for (const sr of SRS) for (const res of [0, 0.1, 0.2]) for (const v of [-3.6, -1, 1, 3, 4, 4.5, 5]) {
    const fc = vToHz(v), params = { cutoff: v, res, drive: 0 };
    const got = corner((hz) => tone('ladder', hz, { params, sr }), fc, tone('ladder', fc / 16, { params, sr }));
    assert.ok(Math.abs(pct(got, fc)) < 8, `sr ${sr} res ${res} ${fc.toFixed(0)} Hz: reads ${got.toFixed(0)}, ${pct(got, fc).toFixed(1)} %`);
  }
});

test('ladder: 24 dB/oct, unity passband at low resonance', () => {
  for (const res of [0, 0.1, 0.2]) {
    const params = { cutoff: -1.5, res, drive: 0 }, fc = vToHz(-1.5);
    const slope = db(tone('ladder', fc * 8, { params }) / tone('ladder', fc * 32, { params })) / 2;
    assert.ok(Math.abs(slope - 24) < 1.5, `res ${res}: ${slope.toFixed(1)} dB/oct`);
    const pass = db(tone('ladder', fc / 16, { params }));
    assert.ok(Math.abs(pass) < 1.5, `res ${res}: passband ${pass.toFixed(2)} dB`);
  }
});

test('ladder: the peak rises with RES, stays near the knob, and stops short of oscillating', () => {
  const v = 1, fc = vToHz(v);
  const want = { 0.7: 8, 0.8: 13, 0.9: 24 };
  let last = -Infinity;
  for (const res of [0.7, 0.8, 0.9]) {
    const params = { cutoff: v, res, drive: 0 };
    const p = peakOf('ladder', fc * 0.6, fc * 1.3, { params });
    const height = db(p.gain / tone('ladder', fc / 16, { params, level: 0.02 }));
    assert.ok(height >= want[res] && height < 45, `res ${res}: ${height.toFixed(1)} dB above the passband`);
    assert.ok(height > last, `res ${res}: peak fell`);
    assert.ok(Math.abs(pct(p.hz, fc)) < 16, `res ${res}: peak at ${p.hz.toFixed(0)} Hz`);
    last = height;
  }
});

test('ladder: self-oscillates as a tuned sine, 1 V/oct through the CV at depth 1.0', () => {
  for (const sr of SRS) {
    const volts = [-2, -1, 0, 1, 2, 3];
    const hz = volts.map((v) => {
      const r = renderModule('ladder', { params: { cutoff: 0, res: 1, drive: 0 }, depth: { cutoff: 1 }, inputs: { cutoff: v }, seconds: v < 0 ? 3 : 1.5, sr });
      const y = signal(r, 'lp'), f = pitchHz(y, sr, Math.floor(y.length * 0.7));
      const c = cents(f, vToHz(v));
      assert.ok(Math.abs(c) < 10, `sr ${sr} ${v} V: ${c.toFixed(1)} cents off the cutoff`);
      assert.ok(thd(y, sr, f) < -40, `sr ${sr} ${v} V: not a sine, thd ${thd(y, sr, f).toFixed(1)} dB`);
      const level = peak(y, y.length >> 1);
      assert.ok(level > 4 && level < 8, `sr ${sr} ${v} V: level ${level.toFixed(1)} V`);
      return f;
    });
    for (let k = 1; k < hz.length; k++) {
      const octave = cents(hz[k], hz[k - 1]) - 1200;
      assert.ok(Math.abs(octave) < 5, `sr ${sr}: octave ${k} off by ${octave.toFixed(2)} cents`);
    }
  }
});

test('ladder: zero-delay feedback keeps it in tune at the top of the knob, at any sample rate', () => {
  // up here the instantaneous path is big: one sample of delay in the loop would go flat by a lot
  for (const sr of [22050, 44100, 48000, 96000]) for (const v of [4, 4.5, 5]) {
    const y = signal(renderModule('ladder', { params: { cutoff: v, res: 1, drive: 0 }, seconds: 0.6, sr }), 'lp');
    const c = cents(pitchHz(y, sr, y.length >> 1), vToHz(v));
    assert.ok(Math.abs(c) < 10, `sr ${sr} ${v} V: ${c.toFixed(1)} cents off the cutoff`);
  }
});

test('ladder: the exact solve around the tanh makes the oscillation level independent of sample rate', () => {
  const level = (sr, v) => {
    const y = signal(renderModule('ladder', { params: { cutoff: v, res: 1, drive: 0 }, seconds: 0.6, sr }), 'lp');
    return peak(y, y.length >> 1);
  };
  for (const v of [4, 5]) {
    const truth = level(192000, v); // the instantaneous path is tiny up there, so this needs no solving
    for (const sr of [22050, 44100, 48000]) {
      const off = pct(level(sr, v), truth);
      assert.ok(Math.abs(off) < 3, `sr ${sr} ${v} V: ${off.toFixed(1)} % off the 192 kHz level`);
    }
  }
});

test('ladder: DRIVE distorts more, without running into the rails', () => {
  const sr = 48000, f = 200;
  const render = (drive) => signal(renderModule('ladder', { params: { cutoff: 3, res: 0, drive }, sr, seconds: 1, inputs: { in: sine(f, 5) } }), 'lp');
  const clean = thd(render(0), sr, f), hot = thd(render(1), sr, f);
  assert.ok(clean < -30, `drive 0: ${clean.toFixed(1)} dB`);
  assert.ok(hot > clean + 15, `drive 1: ${hot.toFixed(1)} dB against ${clean.toFixed(1)} dB`);
  assert.ok(peak(render(1)) < 9, 'drive 1 runs off into the rails');
});

// ── diode ─────────────────────────────────────────────────
test('diode: -3 dB within 8 % of the knob, unity passband at low resonance', () => {
  for (const sr of SRS) for (const res of [0, 0.1]) for (const v of [-3, -1, 1, 3, 4, 4.5, 5]) {
    const fc = vToHz(v), params = { cutoff: v, res }, level = 0.25;
    // against unity itself: at 33 Hz nothing lies between the corner and the DC blocker to read
    const got = corner((hz) => tone('diode', hz, { params, sr, level }), fc, 1);
    assert.ok(Math.abs(pct(got, fc)) < 8, `sr ${sr} res ${res} ${fc.toFixed(0)} Hz: reads ${got.toFixed(0)}, ${pct(got, fc).toFixed(1)} %`);
    if (v < -1) continue;
    const pass = db(tone('diode', fc / 5, { params, sr, level }));
    assert.ok(Math.abs(pass) < 1.5, `sr ${sr} res ${res} ${fc.toFixed(0)} Hz: passband ${pass.toFixed(2)} dB`);
  }
});

test('diode: 18 dB/oct', () => {
  for (const res of [0, 0.1, 0.3, 0.5, 0.7]) {
    const params = { cutoff: -1, res }, fc = vToHz(-1);
    const slope = db(tone('diode', fc * 8, { params }) / tone('diode', fc * 32, { params })) / 2;
    assert.ok(Math.abs(slope - 18) < 2, `res ${res}: ${slope.toFixed(1)} dB/oct`);
  }
});

test('diode: the peak rises with RES and sits on the knob', () => {
  const v = 2, fc = vToHz(v);
  const want = { 0.7: 4, 0.8: 8, 0.9: 13, 1: 22 };
  let last = -Infinity;
  for (const res of [0.7, 0.8, 0.9, 1]) {
    const params = { cutoff: v, res };
    const p = peakOf('diode', fc * 0.6, fc * 1.5, { params, seconds: 0.8 });
    const height = db(p.gain / tone('diode', fc / 5, { params, level: 0.02 }));
    assert.ok(height >= want[res], `res ${res}: ${height.toFixed(1)} dB above the passband`);
    assert.ok(height > last, `res ${res}: peak fell`);
    assert.ok(Math.abs(pct(p.hz, fc)) < 10, `res ${res}: peak at ${p.hz.toFixed(0)} Hz`);
    last = height;
  }
});

test('diode: the highpass in the loop keeps the bass when the mids go', () => {
  const params = { cutoff: 3, res: 0.9 };
  const lost = (hz) => db(gainAt('diode', hz, { params, level: 0.1 }) / gainAt('diode', hz, { params: { ...params, res: 0 }, level: 0.1 }));
  const bass = lost(45), mids = lost(400);
  assert.ok(bass > mids + 3, `resonance costs the bass ${bass.toFixed(1)} dB, the mids ${mids.toFixed(1)} dB`);
});

test('diode: input level drives it into distortion', () => {
  const sr = 48000, f = 300;
  const at = (level) => thd(signal(renderModule('diode', { params: { cutoff: 3, res: 0 }, sr, seconds: 1, inputs: { in: sine(f, level) } }), 'lp'), sr, f);
  const quiet = at(0.5), nominal = at(5);
  assert.ok(quiet < -45, `0.5 V: ${quiet.toFixed(1)} dB`);
  assert.ok(nominal > -22, `5 V: only ${nominal.toFixed(1)} dB`);
});

test('diode: a hot signal closes the stages, beyond what clipping the input alone would do', () => {
  const f = 1046, level = 5, small = 0.02, params = { cutoff: 0, res: 0 }; // an octave over the knob
  // clip it the way the input stage does, then filter it too quietly for the stages to saturate
  const clipped = (t) => (small * tanh(0.35 * sine(f, level)(t))) / 0.35;
  const out = (input) => { const y = signal(renderModule('diode', { params, seconds: 0.5, inputs: { in: input } }), 'lp'); return rms(y, y.length >> 1); };
  const closed = db((out(clipped) / small) / out(sine(f, level)));
  assert.ok(closed > 0.6, `the stages only take ${closed.toFixed(2)} dB more off`);
});

test('diode: a loud saw keeps its level as RES comes up', () => {
  const levels = [0, 0.5, 0.7, 0.8, 0.9].map((res) => {
    const y = signal(renderModule('diode', { params: { cutoff: 1, res }, seconds: 1, inputs: { in: saw(55, 4) } }), 'lp');
    assert.ok(peak(y) < 12, `res ${res}: peak ${peak(y).toFixed(1)}`);
    return rms(y, 12000);
  });
  assert.ok(Math.max(...levels) / Math.min(...levels) < 2, `levels ${levels.map((l) => l.toFixed(2))}`);
});

// ── svf ───────────────────────────────────────────────────
const Q707 = 1 - (1.4642 / 2.05) ** (2 / 3); // RES for Q = 0.707: Butterworth, where a corner means -3 dB

test('svf: lowpass and highpass are -3 dB exactly on the knob at Q 0.707', () => {
  for (const sr of SRS) for (const v of [-3, -1, 1, 3, 4, 5]) {
    const fc = vToHz(v), params = { cutoff: v, res: Q707 };
    const lp = corner((hz) => tone('svf', hz, { params, sr, output: 'lp' }), fc, tone('svf', fc / 16, { params, sr, output: 'lp' }));
    const hp = corner((hz) => tone('svf', hz, { params, sr, output: 'hp' }), fc, tone('svf', Math.min(fc * 16, 19000), { params, sr, output: 'hp' }), true);
    assert.ok(Math.abs(pct(lp, fc)) < 1, `sr ${sr} lp at ${fc.toFixed(0)}: ${pct(lp, fc).toFixed(2)} %`);
    assert.ok(Math.abs(pct(hp, fc)) < 1, `sr ${sr} hp at ${fc.toFixed(0)}: ${pct(hp, fc).toFixed(2)} %`);
  }
});

test('svf: 12 dB/oct both ways, a real notch, and the outputs add up', () => {
  const params = { cutoff: -1.5, res: Q707 }, fc = vToHz(-1.5);
  const lp = db(tone('svf', fc * 8, { params, output: 'lp' }) / tone('svf', fc * 32, { params, output: 'lp' })) / 2;
  assert.ok(Math.abs(lp - 12) < 0.5, `lp ${lp.toFixed(2)} dB/oct`);
  const up = { cutoff: 3.5, res: Q707 }, fh = vToHz(3.5);
  const hp = db(tone('svf', fh / 8, { params: up, output: 'hp' }) / tone('svf', fh / 32, { params: up, output: 'hp' })) / 2;
  assert.ok(Math.abs(hp - 12) < 0.5, `hp ${hp.toFixed(2)} dB/oct`);
  const notch = db(tone('svf', vToHz(1), { params: { cutoff: 1, res: 0.5 }, output: 'notch' }));
  assert.ok(notch < -60, `notch only ${notch.toFixed(1)} dB deep`);
  assert.ok(Math.abs(db(tone('svf', vToHz(1), { params: { cutoff: 1, res: Q707 }, output: 'bp' })) + 3.01) < 0.1, 'bp at the centre is Q');
  const r = renderModule('svf', { seconds: 0.2, inputs: { in: saw(110, 4) } });
  const a = signal(r, 'lp'), b = signal(r, 'hp'), n = signal(r, 'notch');
  for (let i = 0; i < n.length; i++) assert.ok(Math.abs(a[i] + b[i] - n[i]) < 1e-9, `notch is not lp + hp at ${i}`);
});

test('svf: Q runs from 0.5 and the peak height is Q, to the dB', () => {
  for (const res of [0, 0.5, 0.7, 0.8, 0.85, 0.88]) {
    const q = 1 / (2.05 * (1 - res) ** 1.5 - 0.05), params = { cutoff: 1, res };
    const got = db(gainAt('svf', vToHz(1), { params, output: 'lp', level: 0.02, seconds: 1 }));
    assert.ok(Math.abs(got - db(q)) < 0.25, `Q ${q.toFixed(2)}: ${got.toFixed(2)} dB, want ${db(q).toFixed(2)}`);
  }
});

test('svf: self-oscillates in tune, at a sane level', () => {
  for (const sr of SRS) for (const v of [-2, 0, 2, 4, 5]) {
    const y = signal(renderModule('svf', { params: { cutoff: v, res: 1 }, seconds: 2, sr }), 'bp');
    const f = pitchHz(y, sr, y.length >> 1), c = cents(f, vToHz(v));
    assert.ok(Math.abs(c) < 3, `sr ${sr} ${v} V: ${c.toFixed(2)} cents`);
    const level = peak(y, y.length >> 1);
    assert.ok(level > 4 && level < 7, `sr ${sr} ${v} V: level ${level.toFixed(1)} V`);
  }
});

// ── everything with a cutoff ──────────────────────────────
test('audio-rate cutoff modulation stays stable, even self-oscillating', () => {
  for (const [type, out, params] of [['ladder', 'lp', { res: 0.95 }], ['ladder', 'lp', { res: 1 }], ['diode', 'lp', { res: 1 }], ['svf', 'lp', { res: 0.9 }], ['svf', 'bp', { res: 1 }]]) {
    for (const sr of [22050, 48000, 96000]) for (const fm of [1000, 11000]) {
      const r = renderModule(type, { params: { cutoff: 1, ...params }, sr, seconds: 0.5, depth: { cutoff: 1 }, inputs: { in: sine(220, 4), cutoff: sine(fm, 5) } });
      const y = signal(r, out), n = y.length;
      const what = `${type}.${out} ${JSON.stringify(params)} sr ${sr} fm ${fm}`;
      assert.ok(peak(y) < 18, `${what}: peak ${peak(y).toFixed(1)}`);
      const early = rms(y, n >> 2, n >> 1), late = rms(y, n >> 1);
      assert.ok(late < early * 1.3 + 0.01, `${what}: growing, ${early.toFixed(2)} to ${late.toFixed(2)}`);
    }
  }
});

test('sweeping any knob makes no zipper noise, and a stepped control proves it would show', () => {
  const sr = 48000, seconds = 1;
  const hiss = (y) => db(bandLevel(y, sr, 12000, 20000, 32768) / bandLevel(y, sr, 50, 4000, 32768));
  for (const [type, out, name, base] of [
    ['ladder', 'lp', 'cutoff', { res: 0.5 }], ['ladder', 'lp', 'res', { cutoff: 1 }],
    ['diode', 'lp', 'cutoff', { res: 0.7 }], ['diode', 'lp', 'res', { cutoff: 1 }],
    ['svf', 'lp', 'cutoff', { res: 0.6 }], ['svf', 'hp', 'cutoff', { res: 0.6 }], ['svf', 'lp', 'res', { cutoff: 1 }],
    ['comb', 'out', 'fb', { freq: -1 }], ['comb', 'out', 'damp', { freq: -1 }],
    ['formant', 'out', 'vowel', {}], ['djfilter', 'out', 'filter', {}],
  ]) {
    const range = paramRange(getDef(type).params.find((p) => p.name === name));
    const render = (cv) => signal(renderModule(type, { params: { ...base, [name]: (range.min + range.max) / 2 }, depth: { [name]: 1 }, sr, seconds, inputs: { in: sine(110, 2), [name]: cv } }), out);
    const sweep = (t) => 6 * t - 3; // 60 % of the knob, in a second
    const smooth = hiss(render(sweep)), stepped = hiss(render((t, n) => sweep(Math.floor(n / 512) * (512 / sr))));
    const what = `${type}.${out} ${name}`;
    assert.ok(smooth < -100, `${what}: ${smooth.toFixed(1)} dB of hiss`);
    assert.ok(stepped > smooth + 20, `${what}: stepped control ${stepped.toFixed(1)} dB, smooth ${smooth.toFixed(1)} dB`);
  }
});

test('a knob at rest costs no tan(), and a moving cutoff does', () => {
  const real = Math.tan;
  let calls = 0;
  Math.tan = (x) => { calls++; return real(x); };
  try {
    for (const [type, cv] of [['ladder', 'cutoff'], ['diode', 'cutoff'], ['svf', 'cutoff'], ['formant', 'vowel'], ['djfilter', 'filter']]) {
      const n = 4800;
      calls = 0;
      renderModule(type, { seconds: n / 48000, inputs: { in: saw(110, 4) } });
      assert.ok(calls < 8, `${type} calls tan ${calls} times with nothing moving`);
      calls = 0;
      renderModule(type, { seconds: n / 48000, inputs: { in: saw(110, 4), [cv]: sine(500, 4) } });
      assert.ok(calls >= n * 0.99, `${type}: only ${calls} tans with a moving CV, is the cache stale?`);
    }
  } finally { Math.tan = real; }
});

test('1 V/oct at depth 1.0 needs a 10 V knob: every cutoff has one', () => {
  for (const [type, name] of [['ladder', 'cutoff'], ['diode', 'cutoff'], ['svf', 'cutoff'], ['comb', 'freq']]) {
    const p = getDef(type).params.find((q) => q.name === name);
    assert.equal(p.max - p.min, 10, `${type}.${name}: ten volts of knob, so depth 1.0 is 1 V/oct`);
    assert.equal(p.cv, true);
    assert.ok(vToHz(p.max) > 8000, `${type}.${name} opens up`);
    assert.equal(p.format(0), fmtVHz(0), `${type}.${name} reads ${p.format(0)} at 0 V`);
  }
});

test('every cv param swept end to end at every rate, on a loud saw: nothing blows up', () => {
  for (const [type, out] of [['ladder', 'lp'], ['diode', 'lp'], ['svf', 'lp'], ['svf', 'bp'], ['comb', 'out'], ['formant', 'out'], ['djfilter', 'out']]) {
    for (const p of getDef(type).params.filter((q) => q.cv)) {
      const range = paramRange(p), mid = (range.min + range.max) / 2;
      for (const sr of [22050, 48000, 96000]) {
        const r = renderModule(type, { params: { [p.name]: mid }, depth: { [p.name]: 1 }, sr, seconds: 0.25, inputs: { in: saw(110, 8), [p.name]: (t) => 20 * t - 5 } });
        const y = signal(r, out);
        for (let i = 0; i < y.length; i++) assert.ok(Number.isFinite(y[i]), `${type}.${p.name} sr ${sr}: not finite at ${i}`);
        assert.ok(peak(y) < 16, `${type}.${p.name} sr ${sr}: peak ${peak(y).toFixed(1)}`);
      }
    }
  }
});

test('with nothing patched in, they are silent, unless told to oscillate', () => {
  for (const [type, out] of [['ladder', 'lp'], ['diode', 'lp'], ['svf', 'lp'], ['comb', 'out'], ['formant', 'out'], ['djfilter', 'out']]) {
    assert.ok(peak(signal(renderModule(type, { seconds: 0.2 }), out)) < 1e-9, `${type} makes a sound by itself`);
  }
});

test('loud saws at the defaults come out at a useful level, on 0 V', () => {
  for (const [type, out] of [['ladder', 'lp'], ['diode', 'lp'], ['svf', 'lp'], ['comb', 'out'], ['formant', 'out'], ['djfilter', 'out']]) {
    const y = signal(renderModule(type, { seconds: 1, inputs: { in: saw(110, 4) } }), out);
    const level = rms(y, 12000);
    assert.ok(level > 0.7 && level < 5, `${type}: rms ${level.toFixed(2)} V`);
    assert.ok(peak(y, 12000) < 11, `${type}: peak ${peak(y, 12000).toFixed(1)} V`);
    assert.ok(Math.abs(mean(y, 12000)) < 0.2, `${type}: DC ${mean(y, 12000).toFixed(3)} V`);
  }
});

// ── comb ──────────────────────────────────────────────────
// The tooth nearest `want`: three sines around it and the top of the parabola through their logs
function tooth(want, params, sr) {
  const seconds = Math.max(0.4, 140 / want), spread = 5;
  const at = (c) => Math.log(gainAt('comb', want * 2 ** (c / 1200), { params, sr, level: 0.1, seconds }));
  let centre = 0;
  for (let i = 0; i < 8; i++) { // walk onto the top first
    const l = at(centre - spread), m = at(centre), r = at(centre + spread);
    if (m >= l && m >= r) return centre + (0.5 * spread * (l - r)) / (l - 2 * m + r);
    centre += l > r ? -spread : spread;
  }
  return centre;
}

test('comb: tuned to the cent on 1 V/oct, fractional delay right up the range', () => {
  for (const sr of SRS) for (const damp of [0, 0.25]) for (const v of [-2, 0, 2, 3, 4, 5]) {
    const c = tooth(vToHz(v), { freq: v, fb: 0.9, damp }, sr);
    assert.ok(Math.abs(c) < 5, `sr ${sr} damp ${damp} ${v} V: tooth ${c.toFixed(1)} cents off`);
  }
});

test('comb: positive feedback peaks on the harmonics, negative between them', () => {
  const v = 1, f = vToHz(v), seconds = 0.8;
  const at = (hz, fb) => gainAt('comb', hz, { params: { freq: v, fb, damp: 0 }, level: 0.1, seconds });
  const plus = db(at(f * 2, 0.9) / at(f * 2.5, 0.9)), minus = db(at(f * 2.5, -0.9) / at(f * 2, -0.9));
  const want = db(1.9 / 0.1); // (1 + fb) / (1 - fb)
  assert.ok(Math.abs(plus - want) < 1, `+0.9: ${plus.toFixed(1)} dB, want ${want.toFixed(1)}`);
  assert.ok(Math.abs(minus - want) < 1, `-0.9: ${minus.toFixed(1)} dB, want ${want.toFixed(1)}`);
});

test('comb: DAMP eats the high teeth first', () => {
  const v = 0, f = vToHz(v), seconds = 0.8;
  const lost = (hz) => db(gainAt('comb', hz, { params: { freq: v, fb: 0.9, damp: 0 }, level: 0.1, seconds }) / gainAt('comb', hz, { params: { freq: v, fb: 0.9, damp: 0.6 }, level: 0.1, seconds }));
  const low = lost(f), high = lost(f * 20);
  assert.ok(high > low + 6, `lost ${low.toFixed(1)} dB at the bottom, ${high.toFixed(1)} dB at the top`);
});

test('comb: full feedback on a loud on-pitch tone hits the ceiling, not the rails', () => {
  for (const fb of [0.99, -0.99]) {
    const y = signal(renderModule('comb', { params: { freq: 0, fb, damp: 0 }, seconds: 1, inputs: { in: sine(fb > 0 ? vToHz(0) : vToHz(-1), 10) } }), 'out');
    assert.ok(peak(y) < 12.5, `fb ${fb}: peak ${peak(y).toFixed(1)}`);
    assert.ok(rms(y, 24000) > 3, `fb ${fb}: rms ${rms(y, 24000).toFixed(1)}`);
  }
});

// ── formant ───────────────────────────────────────────────
const VOWELS = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [270, 2290, 3010], o: [570, 840, 2410], u: [300, 870, 2240] }; // Peterson & Barney 1952

// Peaks that stand out from their surroundings: a flat valley ripples by a hundredth of a dB, and
// where F1's skirt cancels F2 and F3, as in any parallel formant bank, a notch leaves a hump behind
// it, 40 dB down. The weakest real formant, F3 of /u/, is 24 dB down.
function formants(params) {
  const f = [], g = [];
  for (let hz = 170; hz < 3600; hz *= 1.008) { f.push(hz); g.push(gainAt('formant', hz, { params, level: 0.1, seconds: 0.25 })); }
  const around = 12, floor = Math.max(...g) * 10 ** (-30 / 20); // 10 % either side, in steps of the grid
  return f.filter((_, k) => k >= around && k < f.length - around && g[k] > g[k - 1] && g[k] > g[k + 1]
    && g[k] > floor && g[k] > 1.2 * Math.max(g[k - around], g[k + around]));
}

test('formant: every vowel has its three formants, at the real frequencies', () => {
  Object.values(VOWELS).forEach((want, v) => {
    const got = formants({ vowel: v, res: 0.5 });
    assert.equal(got.length, 3, `vowel ${v}: peaks at ${got.map((x) => x.toFixed(0))}`);
    want.forEach((hz, k) => assert.ok(Math.abs(pct(got[k], hz)) < 5, `vowel ${v} F${k + 1}: ${got[k].toFixed(0)} Hz, want ${hz}`));
  });
});

test('formant: the VOWEL CV morphs, and halfway is halfway', () => {
  const y = (v) => signal(renderModule('formant', { params: { vowel: 0 }, depth: { vowel: 1 }, seconds: 0.4, inputs: { in: saw(110, 4), vowel: v } }), 'out');
  // 2.5 V at depth 1.0 is 25 % of a 0..4 knob: one vowel along, and the sound must be that vowel
  const viaCable = y(2.5), onKnob = signal(renderModule('formant', { params: { vowel: 1 }, seconds: 0.4, inputs: { in: saw(110, 4) } }), 'out');
  for (let i = 0; i < onKnob.length; i++) assert.ok(Math.abs(viaCable[i] - onKnob[i]) < 1e-9, 'cable and knob disagree');
  const f = formants({ vowel: 0.5, res: 0.5 });
  assert.ok(f[0] > 590 && f[0] < 670, `F1 between a and e: ${f[0].toFixed(0)}`);
  assert.ok(f[1] > 1250 && f[1] < 1620, `F2 between a and e: ${f[1].toFixed(0)}`);
});

test('formant: RES narrows the bands', () => {
  const width = (res) => {
    const top = gainAt('formant', 730, { params: { vowel: 0, res }, level: 0.1, seconds: 0.4 });
    return gainAt('formant', 640, { params: { vowel: 0, res }, level: 0.1, seconds: 0.4 }) / top;
  };
  assert.ok(width(1) < width(0) * 0.6, `skirt ${width(0).toFixed(3)} to ${width(1).toFixed(3)}`);
});

// ── dj filter ─────────────────────────────────────────────
const claimedHz = (pos) => {
  const m = getDef('djfilter').params[0].format(pos).match(/([\d.]+) (k?)Hz/);
  return Number(m[1]) * (m[2] ? 1000 : 1);
};

test('djfilter: the centre is a wire, to the last bit', () => {
  for (const filter of [0, 0.02, -0.02]) {
    const input = saw(110, 4);
    const y = signal(renderModule('djfilter', { params: { filter, res: 1 }, seconds: 0.3, inputs: { in: input } }), 'out');
    for (let i = 0; i < y.length; i++) assert.equal(y[i], input(i / 48000), `differs at ${i}`);
  }
  assert.equal(getDef('djfilter').params[0].format(0), 'FLAT');
});

test('djfilter: left is a lowpass, right a highpass, at the frequency the panel reads', () => {
  for (const sr of SRS) {
    for (const filter of [-0.9, -0.7, -0.5, -0.3]) {
      const fc = claimedHz(filter), params = { filter, res: 0 };
      const got = corner((hz) => tone('djfilter', hz, { params, sr }), fc, tone('djfilter', fc / 16, { params, sr }));
      assert.ok(Math.abs(pct(got, fc)) < 8, `sr ${sr} ${filter}: reads ${got.toFixed(0)}, panel says ${fc}`);
    }
    for (const filter of [0.3, 0.5, 0.7, 0.9]) {
      const fc = claimedHz(filter), params = { filter, res: 0 };
      const got = corner((hz) => tone('djfilter', hz, { params, sr }), fc, tone('djfilter', Math.min(fc * 16, 19000), { params, sr }), true);
      assert.ok(Math.abs(pct(got, fc)) < 8, `sr ${sr} ${filter}: reads ${got.toFixed(0)}, panel says ${fc}`);
    }
  }
  const slope = (filter, a, b) => db(tone('djfilter', a, { params: { filter, res: 0 } }) / tone('djfilter', b, { params: { filter, res: 0 } })) / 2;
  assert.ok(Math.abs(slope(-0.8, 1000, 4000) - 12) < 0.5, 'lowpass slope');
  assert.ok(Math.abs(slope(0.8, 700, 175) - 12) < 0.5, 'highpass slope');
});

test('djfilter: RES peaks at the corner', () => {
  const pos = -0.5, fc = claimedHz(pos);
  const up = db(gainAt('djfilter', fc, { params: { filter: pos, res: 1 }, level: 0.1 }));
  assert.ok(Math.abs(up - db(8.707)) < 0.25, `+${up.toFixed(1)} dB`);
});

test('djfilter: a fast sweep through the centre does not click', () => {
  // a slow sine moves at most 0.02 V a sample: anything much more is a click
  const y = signal(renderModule('djfilter', { params: { filter: 0, res: 0.5 }, depth: { filter: 1 }, seconds: 0.4, inputs: { in: sine(30, 4), filter: (t) => (t < 0.2 ? -2 : 2) * Math.min(1, Math.abs(t - 0.2) * 50) } }), 'out');
  let jump = 0;
  for (let i = 1; i < y.length; i++) jump = Math.max(jump, Math.abs(y[i] - y[i - 1]));
  assert.ok(jump < 0.05, `jumps ${jump.toFixed(3)} V in a sample`);
});

test('deterministic: the same render twice', () => {
  const rng = new Rng(3), noise = Array.from({ length: 4800 }, () => rng.bipolar());
  for (const [type, out] of [['ladder', 'lp'], ['diode', 'lp'], ['comb', 'out']]) {
    const render = () => signal(renderModule(type, { seconds: 0.1, inputs: { in: (t, n) => noise[n] } }), out);
    assert.deepEqual(render(), render());
  }
});
