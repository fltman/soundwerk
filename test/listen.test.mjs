// The measuring tools against signals with a known answer, including ones that must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lufs, tonalBalance, analyzeRender } from '../src/listen/analyze.js';
import { sixteenthGrid } from '../src/analysis/analysis.js';

const SR = 48000;
const sine = (hz, db, seconds = 6) => Float32Array.from({ length: seconds * SR }, (_, n) => 10 ** (db / 20) * Math.sin((2 * Math.PI * hz * n) / SR));

test('LUFS: a 997 Hz stereo sine at −23 dBFS reads −23.0 LUFS, the EBU reference', () => {
  const x = sine(997, -23);
  const v = lufs(x, x, SR);
  assert.ok(Math.abs(v + 23) < 0.1, `${v}`);
});

test('LUFS: a mono-in-one-channel signal is 3 dB quieter; low rumble barely counts', () => {
  const x = sine(997, -23), z = new Float32Array(x.length);
  assert.ok(Math.abs(lufs(x, z, SR) + 26) < 0.15);
  const low = sine(30, -23);
  assert.ok(lufs(low, low, SR) < -31, 'K-weighting rolls off the lows');
});

test('LUFS: the gate ignores silence between loud parts', () => {
  const x = sine(997, -23, 12);
  x.fill(0, 4 * SR, 8 * SR);
  const v = lufs(x, x, SR);
  assert.ok(Math.abs(v + 23) < 0.25, `${v}`);
});

test('tonal balance puts a sine in its own band and nowhere else', () => {
  const b = tonalBalance(sine(1000, -12), SR);
  assert.ok(b.mid > -0.5, JSON.stringify(b));
  assert.ok(b.sub < -60 && b.air < -60, JSON.stringify(b));
});

test('stereo correlation: identical is 1, inverted is −1', () => {
  const x = sine(440, -12), y = x.map((v) => -v);
  assert.equal(analyzeRender({ L: x, R: x, sampleRate: SR }).stereoCorrelation, 1);
  assert.equal(analyzeRender({ L: x, R: y, sampleRate: SR }).stereoCorrelation, -1);
});

test('silence measures as silence, with no tempo invented', () => {
  const z = new Float32Array(6 * SR);
  const a = analyzeRender({ L: z, R: z, sampleRate: SR });
  assert.equal(a.lufs, -Infinity);
  assert.equal(a.bpm, undefined);
});

test('the sixteenth grid follows the tracked beats from the downbeat on', () => {
  const beats = [0.1, 0.6, 1.1, 1.6, 2.1];
  const g = sixteenthGrid(beats, 1);
  assert.equal(g[0], 0.6);
  assert.ok(Math.abs(g[1] - 0.725) < 1e-9);
  assert.equal(g[4], 1.1);
  assert.equal(g.length, 12);
});
