// The waveshapers from outside. Aliasing is measured against a naive shaper, which has to fail
// the same bar, or the bar is measuring nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModule, rms, peak, mean, spectrum, bandLevel, db } from './lib/dsp.mjs';

// r.out is the map of outputs; r.out.length is undefined and a loop over it is silently no test
const signal = (r, name = 'out') => {
  const y = r.out[name];
  assert.ok(y?.length > 0, `no output called ${name}`);
  return y;
};
const sine = (hz, level = 5) => (t) => level * Math.sin(2 * Math.PI * hz * t);

// The worst bin that is not a harmonic of f, in dB against the fundamental. Excludes 40 Hz either
// side of each harmonic, where the window's own skirts live.
function worstAlias(y, sr, f) {
  const s = spectrum(y, sr, 65536, y.length - 65536);
  let worst = 0;
  for (let k = 8; k < s.mag.length; k++) {
    const hz = k * s.binHz;
    if (Math.abs(hz / f - Math.round(hz / f)) * f > 40) worst = Math.max(worst, s.mag[k]);
  }
  return db(worst / bandLevel(y, sr, f - 30, f + 30));
}

// 3 kHz is a whole divisor of 48 kHz: every alias lands on a harmonic and vanishes from view.
// So 3 kHz at 44.1 kHz, and at 48 kHz a pitch whose aliases have nowhere to hide.
const CASES = [[44100, 3000], [48000, 3137]];
const SECONDS = 2.2;

// Harmonics of `f` from 2 up, each against the fundamental, in dB
function harmonic(y, sr, f, n) {
  return db(bandLevel(y, sr, f * n - 20, f * n + 20, 32768) / bandLevel(y, sr, f - 20, f + 20, 32768));
}

test('the alias detector fires on a naive shaper at the same drive', () => {
  for (const [sr, f] of CASES) {
    const y = new Float64Array(Math.round(SECONDS * sr));
    for (let n = 0; n < y.length; n++) y[n] = Math.tanh(30 * Math.sin((2 * Math.PI * f * n) / sr));
    const worst = worstAlias(y, sr, f);
    assert.ok(worst > -30, `naive tanh at ${sr}: only ${worst.toFixed(1)} dB, the detector sees nothing`);
  }
});

test('drive: every type, driven flat out with a 3 kHz sine, stays 45 dB clear of aliases', () => {
  for (const [sr, f] of CASES) for (const mode of [0, 1, 2]) for (const tone of [1, 0.5]) {
    const y = signal(renderModule('drive', { params: { mode, drive: 1, tone }, sr, seconds: SECONDS, inputs: { in: sine(f) } }));
    const worst = worstAlias(y, sr, f);
    assert.ok(worst < -45, `type ${mode} tone ${tone} at ${sr}: ${worst.toFixed(1)} dB`);
    assert.ok(harmonic(y, sr, f, 3) > -30, `type ${mode}: is it distorting at all?`);
  }
});

test('folder: flat out, at any symmetry, 45 dB clear of aliases', () => {
  for (const [sr, f] of CASES) for (const fold of [0.5, 0.75, 1]) for (const symmetry of [0, 0.5, -0.5, 1]) {
    const y = signal(renderModule('folder', { params: { fold, symmetry }, sr, seconds: SECONDS, inputs: { in: sine(f) } }));
    const worst = worstAlias(y, sr, f);
    assert.ok(worst < -45, `fold ${fold} sym ${symmetry} at ${sr}: ${worst.toFixed(1)} dB`);
  }
});

test('drive: a 5 V sine keeps its level at every setting of DRIVE', () => {
  const want = 5 / Math.SQRT2;
  for (const mode of [0, 1, 2]) for (const d of [0, 0.25, 0.5, 0.75, 1]) {
    const y = signal(renderModule('drive', { params: { mode, drive: d, tone: 1 }, seconds: 0.5, inputs: { in: sine(200) } }));
    const off = db(rms(y, 12000) / want);
    assert.ok(Math.abs(off) < 1.5, `type ${mode} drive ${d}: ${off.toFixed(2)} dB`);
    assert.ok(peak(y, 12000) < 7, `type ${mode} drive ${d}: peak ${peak(y, 12000).toFixed(1)}`);
  }
});

test('drive: OUTPUT is what it says, and DRIVE goes from nearly clean to very dirty', () => {
  const sr = 48000, f = 200;
  const render = (params) => signal(renderModule('drive', { params: { mode: 0, tone: 1, ...params }, sr, seconds: 0.8, inputs: { in: sine(f) } }));
  const unity = rms(render({ output: 0 }), 12000);
  for (const output of [-12, 6]) assert.ok(Math.abs(db(rms(render({ output }), 12000) / unity) - output) < 0.05, `OUTPUT ${output}`);
  const clean = harmonic(render({ drive: 0 }), sr, f, 3), dirty = harmonic(render({ drive: 1 }), sr, f, 3);
  assert.ok(clean < -28, `drive 0: third harmonic ${clean.toFixed(1)} dB`);
  assert.ok(dirty > -14, `drive 1: third harmonic ${dirty.toFixed(1)} dB`);
});

test('drive: tube and fuzz are lopsided, tape is not', () => {
  const sr = 48000, f = 200;
  const second = (mode) => harmonic(signal(renderModule('drive', { params: { mode, drive: 0.6, tone: 1 }, sr, seconds: 0.8, inputs: { in: sine(f) } })), sr, f, 2);
  assert.ok(second(1) < -60, `tape: second harmonic ${second(1).toFixed(1)} dB`);
  assert.ok(second(0) > -35, `tube: second harmonic ${second(0).toFixed(1)} dB`);
  assert.ok(second(2) > -35, `fuzz: second harmonic ${second(2).toFixed(1)} dB`);
});

test('drive: TONE takes the top off', () => {
  const sr = 48000, f = 200;
  const seventh = (tone) => harmonic(signal(renderModule('drive', { params: { mode: 2, drive: 0.8, tone }, sr, seconds: 0.8, inputs: { in: sine(f) } })), sr, f, 7);
  assert.ok(seventh(0) < seventh(1) - 6, `${seventh(0).toFixed(1)} against ${seventh(1).toFixed(1)} dB`);
});

test('folder: FOLD adds brightness steadily, without changing the level much', () => {
  const sr = 48000, f = 200;
  const render = (fold) => signal(renderModule('folder', { params: { fold }, sr, seconds: 0.8, inputs: { in: sine(f) } }));
  const top = (y) => bandLevel(y, sr, 1500, 20000, 32768);
  let last = 0;
  for (const fold of [0, 0.3, 0.6, 1]) {
    const y = render(fold), bright = top(y);
    assert.ok(bright > last, `fold ${fold}: no brighter, ${bright.toFixed(3)} after ${last.toFixed(3)}`);
    last = bright;
    assert.ok(Math.abs(db(rms(y, 12000) / (5 / Math.SQRT2))) < 3.5, `fold ${fold}: rms ${rms(y, 12000).toFixed(2)}`);
    assert.ok(peak(y, 12000) < 7, `fold ${fold}: peak ${peak(y, 12000).toFixed(1)}`);
  }
  // a Bessel-like pattern would have one strong partial; a folder has many
  const many = [3, 5, 7, 9, 11, 13].filter((n) => harmonic(render(1), sr, f, n) > -30).length;
  assert.ok(many >= 4, `only ${many} strong harmonics`);
});

test('folder: SYMMETRY brings the even harmonics in, and no DC with them', () => {
  const sr = 48000, f = 200;
  const render = (symmetry) => signal(renderModule('folder', { params: { fold: 0.6, symmetry }, sr, seconds: 0.8, inputs: { in: sine(f) } }));
  assert.ok(harmonic(render(0), sr, f, 2) < -60, `centred: second harmonic ${harmonic(render(0), sr, f, 2).toFixed(1)} dB`);
  const y = render(0.6);
  assert.ok(harmonic(y, sr, f, 2) > -30, `offset: second harmonic ${harmonic(y, sr, f, 2).toFixed(1)} dB`);
  assert.ok(Math.abs(mean(y, 24000)) < 0.02, `DC ${mean(y, 24000).toFixed(3)} V`);
});

test('crush: BITS sets the number of levels, and silence stays silent', () => {
  for (const bits of [1, 2, 3, 4, 5]) {
    const y = signal(renderModule('crush', { params: { bits, rate: 1 }, seconds: 0.2, inputs: { in: sine(100.3) } }));
    const levels = new Set(Array.from(y, (v) => v.toFixed(6))).size;
    assert.equal(levels, 2 ** bits + 1, `${bits} bits: ${levels} levels across ±5 V`); // mid-tread: a level at 0 V
  }
  assert.equal(peak(signal(renderModule('crush', { params: { bits: 3, rate: 0.3 }, seconds: 0.2, inputs: { in: 0 } }))), 0);
});

test('crush: RATE holds each sample for as long as the panel says', () => {
  for (const [rate, sr] of [[0.5, 48000], [0.5, 44100], [0.25, 48000], [0.8, 96000]]) {
    const hz = 100 * 480 ** rate;
    const y = signal(renderModule('crush', { params: { bits: 16, rate }, sr, seconds: 0.5, inputs: { in: sine(47) } }));
    let changes = 0;
    for (let i = 1; i < y.length; i++) if (y[i] !== y[i - 1]) changes++;
    const got = changes / 0.5;
    assert.ok(Math.abs(got / hz - 1) < 0.02, `rate ${rate} at ${sr}: ${got.toFixed(0)} Hz, want ${hz.toFixed(0)}`);
  }
});

test('crush: wide open it is nearly transparent; both CVs work through their jacks', () => {
  const input = sine(440);
  const y = signal(renderModule('crush', { params: { bits: 16, rate: 1 }, seconds: 0.1, inputs: { in: input } }));
  for (let i = 0; i < y.length; i++) assert.ok(Math.abs(y[i] - input(i / 48000)) < 1e-3, `off at ${i}`);
  const noise = (y2) => rms(y2.map((v, i) => v - input(i / 48000)));
  const bitsCv = signal(renderModule('crush', { params: { bits: 16, rate: 1 }, depth: { bits: 1 }, seconds: 0.1, inputs: { in: input, bits: -8 } }));
  assert.ok(noise(bitsCv) > 0.1, `BITS CV: error ${noise(bitsCv).toFixed(4)}`);
  const rateCv = signal(renderModule('crush', { params: { bits: 16, rate: 1 }, depth: { rate: 1 }, seconds: 0.1, inputs: { in: input, rate: -8 } }));
  assert.ok(noise(rateCv) > 0.1, `RATE CV: error ${noise(rateCv).toFixed(4)}`);
});

test('ringmod: 5 V times 5 V is 5 V, all of it in the sum and the difference', () => {
  const sr = 48000, a = 1000, b = 300;
  const y = signal(renderModule('ringmod', { sr, seconds: 1, inputs: { in: sine(a), mod: sine(b) } }));
  for (const hz of [a + b, a - b]) {
    const got = bandLevel(y, sr, hz - 20, hz + 20, 32768);
    assert.ok(Math.abs(got - 2.5) < 0.05, `${hz} Hz: ${got.toFixed(3)} V, want 2.5`);
  }
  for (const hz of [a, b]) assert.ok(db(bandLevel(y, sr, hz - 20, hz + 20, 32768) / 2.5) < -60, `${hz} Hz leaks through`);
});

test('ringmod: carrier leakage below -60 dB with either input at 0 V', () => {
  for (const inputs of [{ in: sine(1000), mod: 0 }, { in: 0, mod: sine(1000) }]) {
    const y = signal(renderModule('ringmod', { seconds: 0.5, inputs }));
    assert.ok(db(peak(y) / 5) < -60, `${db(peak(y) / 5).toFixed(1)} dB`);
  }
});

test('ringmod: MIX crossfades to the dry signal at full level', () => {
  const y = signal(renderModule('ringmod', { params: { mix: 0 }, seconds: 0.5, inputs: { in: sine(1000), mod: sine(300) } }));
  assert.ok(Math.abs(db(rms(y, 12000) / (5 / Math.SQRT2))) < 0.1, `dry level ${rms(y, 12000).toFixed(3)}`);
});

test('ringmod: a sum above Nyquist is gone, where a plain multiply folds it straight back', () => {
  const sr = 48000, a = 15000, b = 14000, alias = sr - (a + b); // 19 kHz
  const y = signal(renderModule('ringmod', { sr, seconds: 1, inputs: { in: sine(a), mod: sine(b) } }));
  const plain = new Float64Array(sr);
  for (let n = 0; n < sr; n++) plain[n] = sine(a)(n / sr) * sine(b)(n / sr) * 0.2;
  const level = (x) => db(bandLevel(x, sr, alias - 20, alias + 20, 32768) / bandLevel(x, sr, a - b - 20, a - b + 20, 32768));
  assert.ok(level(plain) > -1, `the plain multiply should alias, reads ${level(plain).toFixed(1)} dB`);
  assert.ok(level(y) < -60, `${level(y).toFixed(1)} dB of alias`);
});

test('every cv param swept end to end at every rate, on a loud input: nothing blows up', () => {
  for (const [type, ports] of [['drive', ['drive']], ['folder', ['fold', 'symmetry']], ['crush', ['bits', 'rate']], ['ringmod', ['mix']]]) {
    for (const port of ports) for (const sr of [22050, 48000, 96000]) {
      const r = renderModule(type, { depth: { [port]: 1 }, sr, seconds: 0.25, inputs: { in: sine(440, 10), mod: sine(90, 10), [port]: (t) => 40 * t - 5 } });
      const y = signal(r);
      for (let i = 0; i < y.length; i++) assert.ok(Number.isFinite(y[i]), `${type}.${port} sr ${sr}: not finite at ${i}`);
      assert.ok(peak(y) < 22, `${type}.${port} sr ${sr}: peak ${peak(y).toFixed(1)}`);
    }
  }
});

test('with nothing patched in, they are silent', () => {
  for (const type of ['drive', 'folder', 'crush', 'ringmod']) {
    assert.ok(peak(signal(renderModule(type, { seconds: 0.3 }))) < 1e-6, `${type} makes a sound by itself`);
  }
});

test('the defaults do something, at a useful level', () => {
  const saw = (t) => 8 * (((t * 110) % 1) - 0.5);
  for (const type of ['drive', 'folder', 'crush']) {
    const y = signal(renderModule(type, { seconds: 0.6, inputs: { in: saw } }));
    assert.ok(rms(y, 12000) > 1 && peak(y, 12000) < 10, `${type}: rms ${rms(y, 12000).toFixed(2)}, peak ${peak(y, 12000).toFixed(1)}`);
    assert.ok(Math.abs(mean(y, 12000)) < 0.05, `${type}: DC ${mean(y, 12000).toFixed(3)}`);
    let differs = 0;
    for (let i = 12000; i < y.length; i++) differs = Math.max(differs, Math.abs(y[i] - saw(i / 48000)));
    assert.ok(differs > 0.05, `${type}: the default changes nothing`);
  }
});
