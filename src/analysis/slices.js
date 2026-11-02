// Cuts a track into slices for the Slicer: whole bars, single beats and the drum hits in it, each
// measured, and the most different ones kept. Starts snap to the attack, so a hit keeps its front.
// Pure JS, runs in the analysis worker and in Node for the tests.
import { createFFT } from './fft.js';
import { sixteenthGrid } from './analysis.js';

const KEEP = { bar: 16, beat: 16, kick: 6, snare: 5, hat: 5 };
const KEEP_STEM = { bar: 8, beat: 8, kick: 3, snare: 3, hat: 2 };   // four of these reach the assistant at once
const HIT_STEPS = { kick: 2, snare: 2, hat: 1 };
const QUIET = 0.04;       // a slice under this level, as a share of the track's top, is not worth having
const SNAP = 0.025;       // seconds either way an attack may pull a start
export const PADS = 8;

const round = (x, by = 1000) => Math.round(x * by) / by;

// The biggest jump in loudness near t, a millisecond before it so the attack stays whole
function attack(samples, sr, t) {
  const size = Math.round(sr * 0.001);
  const from = Math.round((t - SNAP) * sr), count = Math.round((2 * SNAP * sr) / size);
  let best = 0, at = -1, last = 0;
  for (let w = 0; w < count; w++) {
    let e = 0;
    for (let i = 0; i < size; i++) { const s = samples[from + w * size + i] ?? 0; e += s * s; }
    const rise = e - last;
    if (w > 0 && rise > best) { best = rise; at = w; }
    last = e;
  }
  return at < 0 ? t : Math.max(0, (from + at * size) / sr - 0.001);
}

function mean(x, a, b) {
  const n = Math.max(1, b - a);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] ?? 0;
  return s / n;
}

function within(times, at, end) {
  const out = [];
  for (const t of times) if (t >= at && t < end) out.push(t);
  return out;
}

function measure(a, slice) {
  const fr = a.frameRate, from = Math.floor(slice.at * fr), to = Math.ceil(slice.end * fr);
  const { bands, level, onsets } = a;
  const kicks = within(onsets.kick.times, slice.at - 0.02, slice.end - 0.02);
  const others = within(onsets.snare.times, slice.at, slice.end).length + within(onsets.hat.times, slice.at, slice.end).length;
  return {
    ...slice,
    level: round(mean(level, from, to), 100),
    low: round(mean(bands.bass, from, to), 100),
    mid: round((mean(bands.lowmid, from, to) + mean(bands.mid, from, to)) / 2, 100),
    high: round((mean(bands.high, from, to) + mean(bands.treble, from, to)) / 2, 100),
    busy: round((kicks.length + others) / slice.steps, 100),
    kicks: kicks.map((t) => round(Math.max(0, t - slice.at))),
  };
}

// Farthest first: start from the loudest, then keep taking whatever is least like what's taken
function mostDifferent(list, n) {
  if (!list.length) return [];
  const keys = ['level', 'low', 'mid', 'high', 'busy'];
  const near = new Float64Array(list.length).fill(Infinity);
  let pick = list.reduce((best, s, i) => (s.level > list[best].level ? i : best), 0);
  const out = [];
  while (out.length < Math.min(n, list.length)) {
    out.push(list[pick]);
    near[pick] = -1;
    let far = -1, next = -1;
    list.forEach((s, i) => {
      if (near[i] < 0) return;
      const d = Math.hypot(...keys.map((k) => s[k] - list[pick][k]));
      if (d < near[i]) near[i] = d;
      if (near[i] > far) { far = near[i]; next = i; }
    });
    pick = next;
  }
  return out;
}

// Sha'ath's key profiles: Krumhansl and Kessler's, retuned on dance music
const MAJOR = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
const MINOR = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_RATE = 11025;   // plenty for the notes that decide a key, and the answer can't depend on the file's own rate
const KEY_SPAN = [55, 880];
const KEY_FLOOR = 0.1;    // a peak under this share of its moment's loudest is noise

// The peaks of the spectrum over time, each at its real frequency, so a note counts as that note
// wherever the FFT's bins happen to fall. Peaks and not bins, because a kick has no pitch and a
// peak is what a held note looks like in a window this long.
function notesHeard(samples, sr) {
  const by = Math.max(1, Math.round(sr / KEY_RATE)), rate = sr / by;
  const low = new Float64Array(Math.floor(samples.length / by));
  for (let i = 0; i < low.length; i++) {
    let s = 0;
    for (let j = 0; j < by; j++) s += samples[i * by + j];
    low[i] = s / by;
  }
  const size = 2 ** Math.round(Math.log2(rate * 0.74));   // 0.7 s: bins finer than a semitone at the bottom
  const fft = createFFT(size);
  const re = new Float64Array(size), im = new Float64Array(size), win = new Float64Array(size), mag = new Float64Array(size >> 1);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const binHz = rate / size, lo = Math.max(2, Math.floor(KEY_SPAN[0] / binHz)), hi = Math.ceil(KEY_SPAN[1] / binHz);
  const frames = [];
  for (let at = 0; at + size <= low.length; at += size >> 1) {
    for (let i = 0; i < size; i++) { re[i] = low[at + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = lo - 1; k <= hi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    const peaks = [];
    let top = 0;
    for (let k = lo; k <= hi; k++) {
      if (mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(mag[k] + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const d = a - 2 * b + c;
      peaks.push({ hz: (k + (d ? (0.5 * (a - c)) / d : 0)) * binHz, mag: mag[k] });
      top = Math.max(top, mag[k]);
    }
    frames.push(peaks.filter((p) => p.mag >= top * KEY_FLOOR));
  }
  return frames;
}

// The notes the track spends its time on, against those two profiles in all twelve keys. Tuned to
// the track first: a song a quarter tone off A 440 would otherwise fall between every pair of notes.
// Every moment counts the same, so the loudest chorus doesn't get to outvote the rest of the song.
export function findKey(samples, sr) {
  const frames = notesHeard(samples, sr);
  let x = 0, y = 0;
  for (const peaks of frames) {
    for (const p of peaks) {
      p.semi = 12 * Math.log2(p.hz / 261.63);
      x += p.mag * Math.cos(2 * Math.PI * p.semi);
      y += p.mag * Math.sin(2 * Math.PI * p.semi);
    }
  }
  const tuning = Math.atan2(y, x) / (2 * Math.PI);
  const chroma = new Float64Array(12), moment = new Float64Array(12);
  for (const peaks of frames) {
    moment.fill(0);
    for (const p of peaks) {
      const t = p.semi - tuning, near = Math.round(t), off = Math.abs(t - near);
      if (off < 0.4) moment[((near % 12) + 12) % 12] += p.mag * Math.cos(Math.PI * off) ** 2;
    }
    const sum = moment.reduce((s, v) => s + v, 0) || 1;
    for (let n = 0; n < 12; n++) chroma[n] += moment[n] / sum;
  }
  const correlate = (profile, root) => {
    const mx = chroma.reduce((s, v) => s + v, 0) / 12, my = profile.reduce((s, v) => s + v, 0) / 12;
    let xy = 0, xx = 0, yy = 0;
    for (let n = 0; n < 12; n++) {
      const u = chroma[(n + root) % 12] - mx, v = profile[n] - my;
      xy += u * v; xx += u * u; yy += v * v;
    }
    return xy / Math.sqrt(xx * yy || 1);
  };
  let best = { fit: -2 };
  for (let root = 0; root < 12; root++) {
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const fit = correlate(profile, root);
      if (fit > best.fit) best = { fit, name: `${NOTE[root]} ${mode}` };
    }
  }
  return best.name;
}

// `a` is what analyze() returned for these samples. A stem comes with `mix`, the whole track's beat
// and key: a bass on its own has no snare to count by. On anything but drums a hit is just a note.
export function cutTrack(a, samples, { stem = null, mix = null } = {}) {
  if (mix) a = { ...a, bpm: mix.bpm, beats: mix.beats, downbeat: mix.downbeat };
  const sr = a.sampleRate;
  const hitName = (kind) => (stem && stem !== 'drums' ? 'note' : kind);
  const grid = sixteenthGrid(a.beats, a.downbeat);
  const near = (t, list) => list.some((x) => Math.abs(x - t) < SNAP);
  const drums = [...a.onsets.kick.times, ...a.onsets.snare.times];
  const start = (t) => (near(t, drums) ? attack(samples, sr, t) : t);

  const stretch = (kind, every) => {
    const out = [];
    for (let k = 0; (k + 1) * every < grid.length; k++) {
      out.push({ kind, at: round(start(grid[k * every])), end: round(start(grid[(k + 1) * every])), steps: every });
    }
    return out;
  };
  const gaps = Array.from(grid.slice(1), (t, k) => t - grid[k]).sort((x, y) => x - y);
  const sixteenth = gaps[gaps.length >> 1] ?? 0.1;
  const hits = (kind) => Array.from(a.onsets[kind].times, (t) => {
    const at = attack(samples, sr, t);
    return { kind: hitName(kind), at: round(at), end: round(at + HIT_STEPS[kind] * sixteenth), steps: HIT_STEPS[kind] };
  }).filter((s) => s.end < a.duration);

  const pool = [];
  for (const [kind, n] of Object.entries(stem ? KEEP_STEM : KEEP)) {
    const list = (kind === 'bar' ? stretch('bar', 16) : kind === 'beat' ? stretch('beat', 4) : hits(kind))
      .map((s) => measure(a, s))
      .filter((s) => s.level > QUIET);
    pool.push(...mostDifferent(list, n));
  }
  const first = (kind, n) => pool.flatMap((s, i) => (s.kind === kind ? [i] : [])).slice(0, n);
  const pads = [...first('bar', 3), ...first('beat', 2), ...first('kick', 1), ...first('snare', 1), ...first('hat', 1), ...first('note', 3)].slice(0, PADS);
  while (pads.length < PADS) pads.push(pads.length % Math.max(1, pool.length));
  return { bpm: round(a.bpm, 10), key: mix?.key ?? findKey(samples, sr), ...(stem ? { stem } : {}), pool, pads, steps: [0, ...new Array(15).fill(-1)] };
}
