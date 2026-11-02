// What there is to sample in a track, stem by stem: where each stem plays, the phrase it keeps
// coming back to, and the bars that happen only once. Whoever samples can't hear, so this is what
// they aim with. A bar is its spectrum, 16th by 16th, so two bars are alike when the same thing
// happens at the same place in them.
import { createFFT } from './fft.js';

const SIZE = 2048;
const BANDS = 8;
const LOW = 60, HIGH = 12000;   // Hz
const PER_DIGIT = 4;            // dB a step on the map
const FLOOR = 36;               // dB under the loudest stem that counts as nothing
const QUIET = 24;               // dB under its own loudest bar that a stem counts as resting
const ALIKE = 0.8;              // how alike two stretches must be to be the same phrase
const LENGTHS = [4, 2, 1];      // bars of a hook, longest first
const MOST_RARE = 2;

function bandsOf(sr) {
  const hz = (k) => (LOW * (HIGH / LOW) ** (k / BANDS) * SIZE) / sr;
  return Array.from({ length: BANDS }, (_, k) => [Math.max(1, Math.round(hz(k))), Math.min(SIZE / 2, Math.round(hz(k + 1)))]);
}

// One bar: BANDS log energies for every 16th, and how loud it is
function barsOf(x, grid, bars, sr) {
  const fft = createFFT(SIZE), re = new Float64Array(SIZE), im = new Float64Array(SIZE), bands = bandsOf(sr);
  const hann = Float64Array.from({ length: SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SIZE));
  const out = [];
  for (let b = 0; b < bars; b++) {
    const shape = new Float32Array(16 * BANDS);
    let sum = 0;
    for (let s = 0; s < 16; s++) {
      const at = Math.round(grid[b * 16 + s] * sr), n = Math.round((grid[b * 16 + s + 1] - grid[b * 16 + s]) * sr);
      for (let i = at; i < at + n && i < x.length; i++) if (i >= 0) sum += x[i] * x[i];
      for (let i = 0; i < SIZE; i++) { re[i] = (x[at + i] ?? 0) * hann[i]; im[i] = 0; }
      fft(re, im);
      bands.forEach(([from, to], k) => {
        let e = 0;
        for (let f = from; f < to; f++) e += re[f] * re[f] + im[f] * im[f];
        shape[s * BANDS + k] = Math.log1p(e);
      });
    }
    const length = (grid[(b + 1) * 16] - grid[b * 16]) * sr;
    out.push({ shape, db: 10 * Math.log10(sum / length + 1e-12) });
  }
  return out;
}

// How alike two stretches of `bars` bars are, from 0 up to 1
function alike(all, a, b, bars) {
  let ab = 0, aa = 0, bb = 0;
  for (let k = 0; k < bars; k++) {
    const x = all[a + k].shape, y = all[b + k].shape;
    for (let i = 0; i < x.length; i++) { ab += x[i] * y[i]; aa += x[i] * x[i]; bb += y[i] * y[i]; }
  }
  return ab / Math.sqrt(aa * bb + 1e-12);
}

// Corrected for what every bar of a stem has in common, or everything sounds like everything
function centred(bars) {
  if (!bars.length) return bars;
  const mean = new Float32Array(bars[0].shape.length);
  for (const b of bars) for (let i = 0; i < mean.length; i++) mean[i] += b.shape[i] / bars.length;
  return bars.map((b) => ({ ...b, shape: b.shape.map((v, i) => v - mean[i]) }));
}

// The stretch that returns most often, and where it does. Stretches that overlap are one return,
// and a phrase starts where the track's phrases do.
function hookOf(all, playing, phase) {
  let best = null;
  for (const length of LENGTHS) {
    for (let a = 0; a + length <= all.length; a++) {
      if (!playing[a] || (a - phase) % length) continue;
      const back = [a];
      for (let b = a + length; b + length <= all.length; b++) {
        if (!playing[b] || b < back.at(-1) + length) continue;
        if (alike(all, a, b, length) >= ALIKE) back.push(b);
      }
      if (back.length < 2) continue;
      // a long phrase is worth more than a short one that returns as often
      const worth = back.length * length;
      if (!best || worth > best.worth) best = { worth, bar: a, bars: length, back };
    }
  }
  return best && { bar: best.bar, bars: best.bars, back: best.back.slice(1) };
}

// What happens once: the bars least like any other, of those loud enough to want
function rareOf(all, playing, top) {
  const score = all.map((_, a) => {
    if (!playing[a] || all[a].db < top - QUIET / 2) return Infinity;
    let most = -1;
    for (let b = 0; b < all.length; b++) if (playing[b] && Math.abs(a - b) > 1) most = Math.max(most, alike(all, a, b, 1));
    return most;
  });
  return score.map((v, bar) => ({ v, bar })).filter((s) => s.v < ALIKE).sort((a, b) => a.v - b.v).slice(0, MOST_RARE).map((s) => s.bar).sort((a, b) => a - b);
}

// stems: { name: mono samples }; grid: the track's 16ths in seconds, as the stems have them; phase:
// the bar its phrases count from. The last bar a track is said to have may be short of a grid.
export function materialOf(stems, grid, bars, sr, phase = 0) {
  const whole = Math.min(bars, Math.floor((grid.length - 1) / 16));
  const heard = Object.entries(stems).map(([name, x]) => [name, barsOf(x, grid, whole, sr)]);
  const top = Math.max(...heard.flatMap(([, list]) => list.map((b) => b.db)));
  const out = {};
  for (const [name, list] of heard) {
    const own = Math.max(...list.map((b) => b.db));
    let map = '';
    for (let b = 0; b < list.length; b += 4) {
      const db = Math.max(...list.slice(b, b + 4).map((x) => x.db)) - top;
      map += db < -FLOOR ? '.' : String(Math.min(9, Math.floor((db + FLOOR) / PER_DIGIT)));
    }
    if (own < top - FLOOR) { out[name] = { map, hook: null, rare: [] }; continue; }
    const playing = list.map((b) => b.db > own - QUIET), all = centred(list);
    out[name] = { map, hook: hookOf(all, playing, phase), rare: rareOf(all, playing, own) };
  }
  return out;
}

// Whisper's lines as bars of the track, on the 16th before each so a sample keeps its first sound.
// What's sung again is one line with several bars.
export function wordsOf(segments, grid) {
  const stepAt = (t) => {
    let lo = 0, hi = grid.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (grid[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const lines = new Map();
  for (const s of segments) {
    const text = s.text.trim();
    if (!text) continue;
    const bar = stepAt(s.start) / 16, key = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    if (!lines.has(key)) lines.set(key, { text, bars: [], long: (stepAt(s.end) + 1) / 16 - bar });
    lines.get(key).bars.push(bar);
  }
  return [...lines.values()].sort((a, b) => a.bars[0] - b.bars[0]);
}
