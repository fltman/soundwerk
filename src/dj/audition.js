// Every move of a rig goes through the real engine, faster than real time, before the DJ is
// allowed near it. What fails here can't be played; what passes goes to the model with its numbers.
import { Graph } from '../rack/graph.js';
import { renderPatch } from '../listen/render.js';
import { BANDS, lufs, tonalBalance } from '../listen/analyze.js';
import { atHome, enterMove, fingerprint, leaveMove } from './rig.js';

const BARS = 4;        // the first half fills the echoes and the reverbs, the second is measured
const SILENT = -40;    // LUFS
const TOO_LOUD = 3;    // dB over home
const SAME = 0.01;     // what a move changes, as a share of the signal: below this it did nothing

function measure(json, seconds, buffers) {
  const r = renderPatch(json, { seconds, buffers });
  const half = r.L.length >> 1;
  const L = r.L.subarray(half), R = r.R.subarray(half);
  const mono = new Float32Array(L.length);
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    mono[i] = (L[i] + R[i]) / 2;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  return { L, R, peak, lufs: lufs(L, R, r.sampleRate), balance: tonalBalance(mono, r.sampleRate) };
}

// How much of b is not a. The renders are deterministic, so a move that does nothing reads zero.
function difference(a, b) {
  let gone = 0, all = 1e-12;
  for (let i = 0; i < a.L.length; i++) {
    const dl = a.L[i] - b.L[i], dr = a.R[i] - b.R[i];
    gone += dl * dl + dr * dr;
    all += a.L[i] * a.L[i] + a.R[i] * a.R[i];
  }
  return Math.sqrt(gone / all);
}

const signed = (db) => `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(0)} dB`;

// Band by band: sub and bass trade places when the kick goes, so a sum of the two would hide it.
function describe(m, home) {
  const level = m.lufs - home.lufs;
  const moved = BANDS.map(([name]) => [name, m.balance[name] - home.balance[name]])
    .filter(([, d]) => Math.abs(d) >= 2)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3);
  const parts = moved.map(([name, d]) => `${name} ${signed(d)}`);
  if (Math.abs(level) >= 1) parts.unshift(`level ${signed(level)}`);
  return parts.join(', ') || 'same level and balance';
}

function judge(m, home) {
  const level = +(m.lufs - home.lufs).toFixed(1);
  const test = { ok: true, level, lufs: +m.lufs.toFixed(1), peak: +m.peak.toFixed(2), measured: describe(m, home) };
  if (!(m.lufs > SILENT)) return { ...test, ok: false, why: 'silent' };
  if (level > TOO_LOUD) return { ...test, ok: false, why: `${level} dB louder than home` };
  if (difference(home, m) < SAME) return { ...test, ok: false, why: 'no audible difference from home' };
  return test;
}

export function auditionRig(json, rig, { buffers, onProgress } = {}) {
  const g = new Graph();
  g.load(json);
  const home = atHome(g, rig);
  const patch = home.graph.toJSON();
  const bpm = patch.nodes.find((n) => n.type === 'clock')?.params.bpm ?? 130;
  const seconds = (BARS * 240) / bpm;
  const base = measure(patch, seconds, buffers);
  const silent = !(base.lufs > SILENT);
  const total = rig.groups.reduce((s, x) => s + x.moves.length - 1, 0);
  const moves = {};
  let done = 0;
  for (const group of rig.groups) {
    group.moves.forEach((m, i) => {
      const key = `${group.name}/${m.name}`;
      if (i === 0) {
        moves[key] = { ok: !silent, level: 0, lufs: +base.lufs.toFixed(1), peak: +base.peak.toFixed(2), measured: '', ...(silent ? { why: 'silent' } : {}) };
        return;
      }
      const t = new Graph();
      t.load(patch);
      leaveMove(t, home.held[group.name]);
      enterMove(t, m);
      moves[key] = judge(measure(t.toJSON(), seconds, buffers), base);
      onProgress?.(++done, total);
    });
  }
  return { print: fingerprint(patch), moves };
}
