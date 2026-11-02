// The shape of a track, in bars: where it changes, what each part is, and which parts are the
// highlights a dance floor waits for. Dance music changes on phrase lines, so the changes vote for
// where those lines fall, and a change near one is moved onto it.
// Pure JS, runs in the analysis worker and in Node for the tests.

const FEEL = 2;          // bars either side of a line that are compared
const PHRASE = 8;        // bars
const MIN_SECTION = 4;   // bars
const SNAP = 1;          // bars a change may move to reach a phrase line
const CHANGE = 2.2;      // a change is this many medians above what a bar line usually shows
const PEAK = 0.7;        // of the way from the quietest part of the track to the loudest
const BREAK = 0.4;       // same scale
const KICKS = 1.5;       // kicks a bar for a part to have a floor under it
const RISING = 0.08;     // level gained from a part's first bars to its last, for it to be going somewhere

const mean = (x, a, b) => {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i < Math.min(x.length, b); i++) { s += x[i]; n++; }
  return n ? s / n : 0;
};
const round2 = (x) => Math.round(x * 100) / 100;

// What each bar sounds like. `a` is what analyze() returned.
export function measureBars(a) {
  const { beats, downbeat, frameRate: fr, level, bands, onsets } = a;
  const bars = [];
  let k = 0;
  const kicks = onsets.kick.times;
  for (let i = downbeat; i + 4 < beats.length; i += 4) {
    const [from, to] = [beats[i], beats[i + 4]];
    const [f0, f1] = [from * fr, to * fr].map(Math.round);
    while (k < kicks.length && kicks[k] < from - 0.03) k++;
    let hits = 0;
    for (let j = k; j < kicks.length && kicks[j] < to - 0.03; j++) hits++;
    bars.push({ t: from, level: mean(level, f0, f1), low: mean(bands.bass, f0, f1), mid: (mean(bands.lowmid, f0, f1) + mean(bands.mid, f0, f1)) / 2, high: (mean(bands.high, f0, f1) + mean(bands.treble, f0, f1)) / 2, kicks: hits });
  }
  return bars;
}

// How much each bar line changes the sound: the bars after it against the bars before it
function changes(bars) {
  const keys = ['level', 'low', 'mid', 'high'];
  const series = keys.map((k) => bars.map((b) => b[k]));
  series.push(bars.map((b) => Math.min(4, b.kicks) / 4));
  return bars.map((_, i) => {
    if (i === 0) return 0;
    let d = 0;
    for (const x of series) d += Math.abs(mean(x, i, i + FEEL) - mean(x, i - FEEL, i));
    return d;
  });
}

// Which of the eight bar lines a phrase starts on: the one the biggest changes keep landing on
function phrasePhase(change) {
  const score = new Float64Array(PHRASE);
  change.forEach((c, i) => { score[i % PHRASE] += c * c; });
  let best = 0;
  score.forEach((s, k) => { if (s > score[best]) best = k; });
  return best;
}

function findCuts(bars) {
  const change = changes(bars);
  const sorted = [...change].sort((x, y) => x - y), typical = sorted[sorted.length >> 1] || 1e-6;
  const phase = phrasePhase(change);
  const cuts = [];
  change.forEach((c, i) => {
    if (i === 0 || c < typical * CHANGE) return;
    if (c < change[i - 1] || c < (change[i + 1] ?? 0)) return;
    const onLine = ((i - phase) % PHRASE + PHRASE) % PHRASE;
    const near = onLine <= SNAP ? i - onLine : PHRASE - onLine <= SNAP ? i + PHRASE - onLine : i;
    cuts.push({ bar: near, size: c });
  });
  // strongest first: a smaller change right next to a bigger one is the same change
  const kept = [];
  for (const c of [...cuts].sort((x, y) => y.size - x.size)) {
    if (c.bar <= 0 || c.bar >= bars.length) continue;
    if (kept.every((k) => Math.abs(k - c.bar) >= MIN_SECTION)) kept.push(c.bar);
  }
  return { cuts: kept.sort((x, y) => x - y), phase };
}

function name(part, i, parts, range) {
  const rel = (part.level - range.lo) / (range.hi - range.lo || 1);
  part.rel = rel;
  const floor = part.kicks >= KICKS;
  if (rel >= PEAK && floor) return 'peak';
  if (parts.length === 1) return 'groove';
  if (i === 0) return 'intro';
  if (!floor) return part.rise > RISING ? 'build' : 'break';
  if (i === parts.length - 1 && rel < PEAK) return 'outro';
  return rel <= BREAK ? 'break' : part.rise > RISING ? 'build' : 'groove';
}

// bars and what they are: [{ name, from, to, level, kicks }], `to` being the bar after the last
export function findSections(a) {
  const bars = measureBars(a);
  if (bars.length < 8) return { bars: bars.length, phase: 0, sections: [{ name: 'groove', from: 0, to: bars.length, level: 1, kicks: 4 }] };
  const { cuts, phase } = findCuts(bars);
  const edges = [0, ...cuts, bars.length];
  const parts = [];
  for (let e = 0; e + 1 < edges.length; e++) {
    const from = edges[e], to = edges[e + 1];
    const levels = bars.map((b) => b.level), quarter = Math.max(1, (to - from) >> 2);
    parts.push({ from, to, level: mean(levels, from, to), kicks: mean(bars.map((b) => b.kicks), from, to), rise: mean(levels, to - quarter, to) - mean(levels, from, from + quarter) });
  }
  const lvls = parts.map((p) => p.level);
  const range = { lo: Math.min(...lvls), hi: Math.max(...lvls) };
  const sections = parts.map((p, i, all) => ({ name: name(p, i, all, range), from: p.from, to: p.to, level: round2(p.rel ?? (p.level - range.lo) / (range.hi - range.lo || 1)), kicks: round2(p.kicks) }));
  return { bars: bars.length, phase, sections };
}
