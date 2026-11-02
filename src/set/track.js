// What a set needs to know about a track. `a` is what analyze() returned for these samples.
import { findKey } from '../analysis/slices.js';
import { findSections } from '../analysis/sections.js';
import { lufs } from '../listen/analyze.js';

const TARGET = -11;      // LUFS of a track's highlights, so one track's peak meets the next one's
const MOST_GAIN = 2;
const ms = (x) => Math.round(x * 10000) / 10000;

export function trackRecord(a, samples, sr) {
  const { sections, bars, phase } = findSections(a);
  const barTime = (b) => a.beats[Math.min(a.beats.length - 1, a.downbeat + 4 * b)];
  const high = sections.filter((s) => s.name === 'peak');
  const parts = (high.length ? high : sections).map((s) => samples.subarray(Math.round(barTime(s.from) * sr), Math.round(barTime(s.to) * sr)));
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const loud = lufs(all, all, sr);
  return {
    seconds: +a.duration.toFixed(1),
    bpm: +a.bpm.toFixed(2),
    key: findKey(samples, sr),
    gain: Number.isFinite(loud) ? +Math.min(MOST_GAIN, 10 ** ((TARGET - loud) / 20)).toFixed(3) : 1,
    loudness: +loud.toFixed(1),
    beats: Array.from(a.beats, ms),
    downbeat: a.downbeat,
    bars,
    phase,
    sections,
  };
}

// How much later a stem sounds than the mix at the same position: decoding a file twice doesn't
// have to come out the same. The rise of the lows of both, a millisecond at a time.
export function stemLag(mix, stem, sr) {
  const rises = (x) => {
    const hop = Math.round(sr / 1000), c = 1 - Math.exp((-2 * Math.PI * 150) / sr);
    const from = Math.max(0, (x.length >> 1) - 15 * sr), to = Math.min(x.length, from + 30 * sr);
    const e = new Float32Array(Math.ceil((to - from) / hop));
    let s1 = 0, s2 = 0;
    for (let i = from; i < to; i++) { s1 += c * (x[i] - s1); s2 += c * (s1 - s2); const k = ((i - from) / hop) | 0; e[k] = Math.max(e[k], Math.abs(s2)); }
    return e.map((v, i) => Math.max(0, v - (e[i - 1] ?? 0)));
  };
  const a = rises(mix), b = rises(stem), reach = 90;
  let lag = 0, top = -1;
  for (let d = -reach; d <= reach; d++) {
    let c = 0;
    for (let i = reach; i < a.length - reach; i++) c += a[i] * b[i + d];
    if (c > top) { top = c; lag = d; }
  }
  return lag / 1000;
}
