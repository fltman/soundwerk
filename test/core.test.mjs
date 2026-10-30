// The small helpers everything else leans on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { softclip, tanh, polyblep, Trigger, Pulse, Rng, DelayLine, OnePole, vToHz, hzToV, expmap } from '../src/modules/lib/index.js';

test('softclip and tanh are monotonic and continuous over the whole rail', () => {
  for (const f of [softclip, tanh]) {
    let last = f(-13);
    for (let x = -13; x <= 13; x += 0.001) {
      const y = f(x);
      assert.ok(y >= last - 1e-12, `${f.name} falls at ${x}`);
      assert.ok(y - last < 0.01, `${f.name} jumps at ${x}`);
      last = y;
    }
    assert.ok(Math.abs(f(0.05) - 0.05) < 1e-3, 'small signals pass untouched');
  }
});

test('volts and hertz are inverses, and expmap hits both ends', () => {
  assert.ok(Math.abs(vToHz(0) - 261.6256) < 1e-3);
  assert.ok(Math.abs(hzToV(vToHz(1.37)) - 1.37) < 1e-12);
  assert.ok(Math.abs(expmap(0, 0.1, 10) - 0.1) < 1e-12);
  assert.ok(Math.abs(expmap(1, 0.1, 10) - 10) < 1e-12);
});

test('a Schmitt trigger needs a real fall before it fires again', () => {
  const t = new Trigger();
  const seq = [0, 1, 3, 1, 0.8, 3, 0.2, 2, 2];
  assert.deepEqual(seq.map((v) => t.tick(v)), [false, false, true, false, false, false, false, true, false]);
});

test('pulses last their length, and Rng is the same every time', () => {
  const p = new Pulse(48000, 1);
  p.fire();
  let n = 0;
  while (p.tick() > 0) n++;
  assert.equal(n, 48);
  const a = new Rng(5), b = new Rng(5);
  for (let k = 0; k < 100; k++) assert.equal(a.next(), b.next());
});

test('a delay line delays by exactly d, fractions by interpolation', () => {
  const d = new DelayLine(100);
  for (let k = 0; k < 50; k++) { d.write(k); }
  assert.equal(d.read(1), 49);
  assert.equal(d.read(10), 40);
  assert.equal(d.read(10.5), 39.5);
});

test('polyBLEP only touches the samples next to the wrap', () => {
  assert.equal(polyblep(0.5, 0.01), 0);
  assert.ok(polyblep(0.001, 0.01) < 0);
  assert.ok(polyblep(0.999, 0.01) > 0);
});

test('a one-pole lowpass is at −3 dB at its cutoff', () => {
  const f = new OnePole(48000, 1000);
  let peak = 0;
  for (let n = 0; n < 48000; n++) {
    const y = f.tick(Math.sin((2 * Math.PI * 1000 * n) / 48000));
    if (n > 24000) peak = Math.max(peak, Math.abs(y));
  }
  assert.ok(Math.abs(20 * Math.log10(peak) + 3) < 0.4, `${20 * Math.log10(peak)}`);
});
