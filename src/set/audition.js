// A plan through the real engine before the set, around every place a track comes in or goes out.
// It measures and reports, for whoever wrote the plan to act on, and only marks what can't be right.
// Each stretch is rendered twice, the second time with silence on the deck, which leaves the rack
// and the track apart to compare.
import { kickOffsets } from '../analysis/analysis.js';
import { lufs } from '../listen/analyze.js';
import { bpmAt, legsOf, lengthOf, pieceOf } from './score.js';
import { renderStretch } from './render.js';

const BEFORE = 4;       // bars heard before a track starts, or after it stops
const WITHIN = 24;      // bars heard after it starts, or before it stops
const SILENT = -36;     // LUFS, a bar
const NOTHING = -50;    // LUFS, a layer in a bar that isn't there at all
const JUMP = 3;         // dB between the far side of a passage and the near side: rack and track must meet
const SAG = 4;          // dB the whole may fall under both sides while the two are being mixed
const HOLE = 2;         // dB a bar may fall under the bars around it, where a track starts or stops
const HOT = 0.3;        // the Master's limiter light, averaged over a bar (about −0.4 dB, all bar)
const APART = 14;       // ms between the kicks of two layers: past this they're two kicks
const AUDIBLE = 12;     // dB under the louder layer that a layer still counts as heard
const PITCHED = 0.03;   // a share of its own speed that a track is audibly another song at

const MOST_HEARD = 8;   // bars of a sample that get heard
const AROUND = 2;       // bars heard on each side of a change that touches no way in or out of a track
const LEAD = 4;         // bars of a clip on each side of what changes
const MOST_CLIP = 32;   // bars of a clip on each side of where the track starts or stops
const BURIED = 10;      // dB under what's around it: a sample that nobody will notice
const LOUD = -8;        // LUFS, a bar: past this it's pressed against the Master, whatever the light says
const SURGE = 3;        // dB a bar may stand over the bars on both sides of it
const REACH = 8;        // bars looked at on each side
const SAME = (a, b) => a.track === b.track && a.stem === b.stem && a.bar === b.bar && a.bars === b.bars && !a.reverse === !b.reverse;

const median = (x) => [...x].sort((a, b) => a - b)[x.length >> 1];

function barLevels(r, from, to) {
  const at = new Map(r.steps.map((s) => [s.step, s.sample])), out = [];
  for (let b = from; b + 16 <= to; b += 16) {
    const [p, q] = [at.get(b), at.get(b + 16)];
    if (p === undefined || q === undefined) continue;
    out.push({ bar: b / 16, lufs: lufs(r.L.subarray(p, q), r.R.subarray(p, q), r.sampleRate), p, q });
  }
  return out;
}

// The two layers apart, bar by bar: the rack as it was rendered, the track as what's left of the whole
function layersOf(whole, rack, bars) {
  const n = Math.min(whole.L.length, rack.L.length), sr = whole.sampleRate;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = whole.L[i] - rack.L[i]; R[i] = whole.R[i] - rack.R[i]; }
  const level = (a, b, s) => lufs(a.subarray(s.p, Math.min(s.q, n)), b.subarray(s.p, Math.min(s.q, n)), sr);
  const per = bars.map((s) => ({ ...s, rack: level(rack.L, rack.R, s), track: level(L, R, s) }));
  return { L, R, n, per, both: per.filter((s) => s.rack > NOTHING && s.track > NOTHING && Math.abs(s.rack - s.track) < AUDIBLE) };
}

// Whether the kicks of the two layers land together, where both can be heard. Positive: the track's
// come after the rack's. null: nowhere to compare.
function kicksApart(rack, layers, sr) {
  const { L, R, n, both } = layers;
  const a = Float32Array.from({ length: n }, (_, i) => (rack.L[i] + rack.R[i]) / 2);
  const b = Float32Array.from({ length: n }, (_, i) => (L[i] + R[i]) / 2);
  const beats = both.flatMap((s) => Array.from({ length: 4 }, (_, k) => (s.p + (k * (s.q - s.p)) / 4) / sr));
  if (beats.length < 8) return null;
  const list = Float64Array.from(beats);
  const track = [...kickOffsets(list, b, sr, list)].filter(Number.isFinite), ours = [...kickOffsets(list, a, sr, list)].filter(Number.isFinite);
  if (track.length < 8 || ours.length < 8) return null;
  return +((median(track) - median(ours)) * 1000).toFixed(1);
}

const whole1 = (x) => (Number.isFinite(x) && x > NOTHING ? Math.round(x) : '.');

const quiet = (a) => a && { L: new Float32Array(a.L.length), R: new Float32Array(a.L.length), sr: a.sr };

// silence on the deck, not a knob turned down: the plan may turn that knob itself
const silenced = (source) => ({
  track: async (x) => quiet(await source.track(x)),
  piece: async (t, op, nudge) => quiet(await pieceOf(source, t, op, nudge)),
});

// What one sample adds to the whole: the same bars with it, and with silence on its Slicer
async function hearSample(patch, node, { move, op, at, until }, source) {
  const t = node.data.tracks[op.track];
  const without = { track: source.track, piece: async (x, o, nudge) => { const a = await pieceOf(source, x, o, nudge); return SAME(o, op) ? quiet(a) : a; } };
  const [whole, rest] = [await renderStretch(patch, { at, until, source }), await renderStretch(patch, { at, until, source: without })];
  const layers = layersOf(whole, rest, barLevels(whole, at, until));
  const peakOf = (key) => Math.max(...layers.per.map((s) => s[key]));
  const report = {
    kind: 'sample',
    what: `Sample of "${t.file.replace(/\.\w+$/, '')}"${op.stem ? `, ${op.stem}` : ''}, its bar ${op.bar}${op.reverse ? ', backwards' : ''}`,
    at: move.at, until: move.until,
    level: whole1(peakOf('track')), rest: whole1(peakOf('rack')),
    problems: [],
  };
  if (!(peakOf('track') > NOTHING)) report.problems.push('nothing of it reaches the Master: check its stem has something on those bars, its clk and its cables');
  else if (peakOf('track') < peakOf('rack') - BURIED) report.problems.push(`it is ${(peakOf('rack') - peakOf('track')).toFixed(0)} dB under what's around it, and nobody will hear it: raise its gain, or take the rest down while it plays`);
  return report;
}

// A way in or out of a track, or with no leg, some bars of the set as they are
async function hearPassage(patch, node, { leg, side, at, until }, source) {
  const t = leg && node.data.tracks[leg.track], master = patch.nodes.find((n) => n.type === 'master')?.id;
  const notes = patch.nodes.filter((n) => n.type === 'bassline').map((n) => n.id);
  const hot = new Map();   // bar → [the limiter light added up, how many times]
  let heard = null;        // the Clock against the track, and the rack's notes, the last time it played
  const whole = await renderStretch(patch, {
    at, until, source,
    onBlock: (c, g) => {
      const bar = Math.floor(c.step / 16), h = hot.get(bar) ?? [0, 0];
      h[0] += c.host.ui(master)?.[0] ?? 0;
      h[1]++;
      hot.set(bar, h);
      if (!leg || c.step < leg.start || c.step >= leg.end) return;
      heard = { bar: leg.enter + Math.floor((c.step - leg.start) / 16), bpm: g.nodes.get(c.clock.id).params.bpm, transpose: notes.map((id) => g.nodes.get(id).params.transpose) };
    },
  });
  const rack = await renderStretch(patch, { at, until, source: silenced(source) });
  const bars = barLevels(whole, at, until), levels = bars.map((b) => b.lufs), layers = layersOf(whole, rack, bars);
  const peak = whole.L.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const report = {
    what: leg ? `"${t.file.replace(/\.\w+$/, '')}" ${side === 'in' ? 'comes in' : 'goes out'}` : 'The bars that changed',
    from: at / 16, to: until / 16, edge: leg ? (side === 'in' ? leg.start : leg.end) / 16 : null,
    lufs: levels.map(whole1),
    rack: layers.per.map((b) => whole1(b.rack)),
    track: layers.per.map((b) => whole1(b.track)),
    together: layers.both.length,
    peak: +peak.toFixed(2),
    speed: heard ? +(heard.bpm / bpmAt(t, heard.bar)).toFixed(4) : 1,
    transpose: heard?.transpose ?? [],
    apart: kicksApart(rack, layers, whole.sampleRate),
    problems: [],
  };
  const silent = bars.find((b) => !(b.lufs > SILENT));
  if (silent) report.problems.push(`bar ${silent.bar} is silent`);
  if (bars.length >= 4) {
    const near = median(levels.slice(0, 2)), far = median(levels.slice(-2));
    if (Math.abs(far - near) > JUMP) report.problems.push(`it ends ${(far - near).toFixed(1)} dB from where it began: rack and track don't meet`);
    const mixing = layers.per.filter((x) => x.rack > NOTHING && x.track > NOTHING);
    const lowest = mixing.reduce((m, x) => (x.lufs < m.lufs ? x : m), { lufs: Infinity });
    const sag = Math.min(near, far) - lowest.lufs;
    if (mixing.length && sag > SAG) report.problems.push(`the mix sags ${sag.toFixed(1)} dB on bar ${lowest.bar}: neither side is carrying it there`);
  }
  // lower than what came before it and lower than what follows: a step up or down is no hole
  if (leg) {
    const levelOf = (from, to) => { const x = bars.filter((b) => b.bar >= report.edge + from && b.bar < report.edge + to).map((b) => b.lufs); return x.length ? median(x) : Infinity; };
    const low = bars.filter((b) => Math.abs(b.bar + 0.5 - report.edge) <= 1.5).reduce((m, b) => (b.lufs < m.lufs ? b : m), { lufs: Infinity });
    const fall = Math.min(levelOf(-4, -2), levelOf(2, 4)) - low.lufs;
    if (Number.isFinite(fall) && fall > HOLE) report.problems.push(`bar ${low.bar} falls ${fall.toFixed(1)} dB under the bars around it: a hole`);
  }
  const over = bars.filter((b) => b.lufs > LOUD);
  if (over.length) report.problems.push(`bars ${over[0].bar}–${over.at(-1).bar} reach ${Math.max(...over.map((b) => b.lufs)).toFixed(1)} LUFS: too loud, keep every bar under ${LOUD}`);
  // over what comes before it and over what comes after it: a step up or down is no surge
  const sideOf = (from, to) => (to > Math.max(0, from) ? median(levels.slice(Math.max(0, from), to)) : Infinity);
  const raised = bars.filter((b, k) => b.lufs > Math.max(sideOf(k - REACH, k), sideOf(k + 1, k + 1 + REACH)) + SURGE);
  if (raised.length) report.problems.push(`bars ${raised[0].bar}–${raised.at(-1).bar} surge over the bars around them: a sample in time with its own track adds up to it, so take one down while the other plays`);
  const pressed = [...hot].filter(([, [sum, n]]) => sum / n > HOT).map(([bar]) => bar);
  if (pressed.length >= 2) report.problems.push(`the Master's limiter works hard on bars ${pressed[0]}–${pressed.at(-1)}: too loud`);
  if (report.apart !== null && Math.abs(report.apart) > APART) report.problems.push(`the track's kicks land ${report.apart} ms from the rack's`);
  if (Math.abs(report.speed - 1) > PITCHED) report.problems.push(`the track plays at ${(report.speed * 100).toFixed(1)} % of its own speed, because the Clock isn't at its tempo`);
  return report;
}

// What there is to hear of a plan: each way in and out of a track, and each sample. With `only`,
// bars of the set that were changed, just what touches them, and if no way in or out does, those
// bars themselves.
export function jobsOf(plan, only) {
  const total = lengthOf(plan) * 16, jobs = [];
  for (const leg of legsOf(plan)) {
    const [start, end] = [leg.start - BEFORE * 16, Math.min(leg.end, leg.start + WITHIN * 16)], [from, to] = [Math.max(leg.start, leg.end - WITHIN * 16), leg.end + BEFORE * 16];
    jobs.push({ leg, side: 'in', at: Math.max(0, start), until: Math.min(total, end) }, { leg, side: 'out', at: Math.max(0, from), until: Math.min(total, to) });
  }
  for (const move of plan.moves) {
    for (const op of move.ops) if (op.op === 'sample') jobs.push({ move, op, at: move.at * 16, until: Math.min(move.until, move.at + MOST_HEARD) * 16 });
  }
  if (!only) return jobs;
  if (only.to <= only.from) return [];
  const touched = jobs.filter((j) => j.at < only.to * 16 && (j.move?.until * 16 || j.until) > only.from * 16);
  if (touched.some((j) => j.leg)) return touched;
  return [{ at: Math.max(0, (only.from - AROUND) * 16), until: Math.min(total, (only.to + AROUND) * 16) }, ...touched];
}

// The bars to play of a transition on `bar`: whatever its versions change, and some on each side.
// The same bars for all of them, so they can be compared at the same moment.
export function clipOf(plan, bar, spans) {
  const real = spans.filter((s) => s.to > s.from);
  const from = Math.max(bar - MOST_CLIP, Math.min(bar, ...real.map((s) => s.from)));
  const to = Math.min(bar + MOST_CLIP, Math.max(bar + 1, ...real.map((s) => s.to)));
  return { at: Math.max(0, from - LEAD) * 16, until: Math.min(lengthOf(plan), to + LEAD) * 16 };
}

// passages: one report for each job, in that order
export async function hearPlan(patch, source, only) {
  const node = patch.nodes.find((x) => x.type === 'set'), passages = [];
  for (const job of jobsOf(node.data.plan, only)) passages.push(await (job.op ? hearSample : hearPassage)(patch, node, job, source));
  return { ok: passages.every((p) => !p.problems.length), passages };
}

// One line for each, for the assistant
export function reportLine(p) {
  const row = (x) => x.join(' ');
  if (p.kind === 'sample') return `${p.problems.length ? '✗' : '✓'} ${p.what}, set bars ${p.at}–${p.until}: ${p.level} LUFS at its loudest, with ${p.rest} LUFS around it${p.problems.length ? `. ${p.problems.join('; ')}` : ''}`;
  return `${p.problems.length ? '✗' : '✓'} ${p.what}, set bars ${p.from}–${p.to}${p.edge === null ? '' : `, the track ${p.what.endsWith('in') ? 'starts' : 'stops'} on ${p.edge}`}. LUFS by bar ${row(p.lufs)}. Rack alone ${row(p.rack)}. Track alone ${row(p.track)}. Heard together for ${p.together} bars${p.apart === null ? '' : `, its kicks ${p.apart} ms after the rack's`}. Peak ${p.peak}, the track at ${(p.speed * 100).toFixed(1)} % of its speed${p.transpose.length ? `, rack transposed ${p.transpose.join(', ')}` : ''}${p.problems.length ? `. ${p.problems.join('; ')}` : ''}`;
}
