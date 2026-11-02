// What makes a plan playable, and only that: whether a transition works is for the render to show,
// and what it should be is for whoever wrote the plan. The rules here are what the machinery needs,
// plus the one a set is built on: one track at a time, and the rack in between.
import { clone, enterMove, leaveMove, LIVE_OPS, tidyOp } from '../dj/rig.js';
import { LOAD_BARS, PIECES, STEMS, lengthOf, sampleData } from './score.js';
import { parseSteps } from '../rack/patterns.js';

const NAME = /^[a-z0-9_]{1,32}$/i;
const MOST_GLIDE = 64;     // bars
const whole = (x) => Number.isInteger(x) && x >= 0;
const PLAN_OPS = [...LIVE_OPS, 'sample'];
const SAMPLE_BARS = [0.25, 0.5, 1, 2, 4, 8];
const SAMPLE_KNOBS = ['length', 'gain', 'tune'];

export const setNode = (graph) => [...graph.nodes.values()].find((n) => n.type === 'set');

function checkTracks(raw, tracks, bars, problems) {
  const list = (Array.isArray(raw) ? raw : []).map((e, i) => {
    const t = tracks[e?.track], at = `tracks[${i}]`;
    if (!t) problems.push(`${at}: there is no track ${e?.track}; the Set holds 0 to ${tracks.length - 1}`);
    else {
      if (!whole(e.at) || !whole(e.enter) || !whole(e.leave)) problems.push(`${at}: at, enter and leave are whole bars`);
      if (e.enter >= e.leave) problems.push(`${at}: it must leave after it enters`);
      if (e.leave > t.bars) problems.push(`${at}: "${t.file}" has ${t.bars} bars, so it can't leave on ${e.leave}`);
    }
    const nudge = Number(e?.nudge) || 0;
    if (Math.abs(nudge) > 0.1) problems.push(`${at}: a nudge is a hand on the record, at most 0.1 s`);
    return { track: e?.track, at: e?.at, enter: e?.enter, leave: e?.leave, ...(nudge ? { nudge } : {}) };
  }).sort((a, b) => a.at - b.at);
  if (!list.length) problems.push('a plan needs at least one track');
  list.forEach((e, i) => {
    const end = e.at + e.leave - e.enter, next = list[i + 1];
    if (next && end + LOAD_BARS + 1 > next.at) problems.push(`track ${next.track} starts on bar ${next.at}, but track ${e.track} plays until bar ${end}: only one track at a time, and the rack needs at least ${LOAD_BARS + 1} bars to itself in between`);
    if (!next && end > bars) problems.push(`track ${e.track} plays until bar ${end}, past the end of the arc on bar ${bars}`);
  });
  return list;
}

function checkSample(op, tracks, legs, move, where, problems) {
  const t = tracks[op.track];
  if (!t) { problems.push(`${where}: there is no track ${op.track} to sample`); return false; }
  const before = problems.length;
  if (!SAMPLE_BARS.includes(op.bars)) problems.push(`${where}: bars of a sample is one of ${SAMPLE_BARS.join(', ')}`);
  if (!PIECES.includes(op.pieces) || op.pieces > op.bars * 16) problems.push(`${where}: pieces of a sample is one of ${PIECES.join(', ')}, and at most one a 16th`);
  if (!Number.isInteger(op.bar * 16) || op.bar < 0 || op.bar + op.bars > t.bars) problems.push(`${where}: "${t.file}" has ${t.bars} bars, so it can't be sampled from bar ${op.bar}: a sample starts on a 16th, like 12.25`);
  if (op.stem !== undefined && !STEMS.includes(op.stem)) problems.push(`${where}: a stem is one of ${STEMS.join(', ')}`);
  else if (op.stem !== undefined && !t.stems) problems.push(`${where}: "${t.file}" was never separated, so it has no ${op.stem}`);
  if (op.steps !== undefined) { try { parseSteps(op.steps); } catch (e) { problems.push(`${where}: ${e.message}`); } }
  if (move.until === undefined) problems.push(`${where}: a sample needs an until, the bar the Slicer lets go of it`);
  // a sample is that track being heard, so the rule holds for it too
  const over = legs.find((e) => e.track !== op.track && e.at < (move.until ?? Infinity) && e.at + e.leave - e.enter > move.at);
  if (over) problems.push(`${where}: this sample of track ${op.track} would play over track ${over.track}: only one track at a time`);
  return problems.length === before;
}

// A trial run on a copy, in the order the set will do it, says everything the real one would
function checkMoves(graph, raw, bars, tracks, legs, problems) {
  const trial = clone(graph), refs = new Map(), staying = [], holding = new Map();
  const list = (Array.isArray(raw) ? raw : [])
    .map((m, i) => ({ ...m, was: i }))
    .sort((a, b) => a.at - b.at)
    .map((m) => {
      const where = `move ${m.was}, bar ${m.at}`;
      if (!whole(m.at) || m.at >= bars) problems.push(`${where}: at is a whole bar inside the set, which has ${bars}`);
      const until = m.until ?? undefined;
      if (until !== undefined && (!whole(until) || until <= m.at || until > bars)) problems.push(`${where}: until must be a later bar of the set`);
      const given = Array.isArray(m.ops) ? m.ops : [];
      if (!given.length) problems.push(`${where}: has no ops`);
      for (const op of given) {
        if (!PLAN_OPS.includes(op?.op)) problems.push(`${where}: during a set only ${PLAN_OPS.join(', ')} can run (got "${op?.op}")`);
        else if (op.op === 'add' && op.type === 'code') problems.push(`${where}: a Code module can't be added during a set`);
      }
      const glide = Number.isFinite(m.glide) ? Math.max(0, Math.min(MOST_GLIDE, m.glide)) : 0;
      const ops = given.filter((op) => PLAN_OPS.includes(op?.op)).map((op) => (op.op === 'sample' ? op : tidyOp(trial, op)));
      const move = { at: m.at, glide, ...(until !== undefined ? { until } : {}), why: String(m.why ?? '').trim(), ops };
      for (let k = staying.length - 1; k >= 0; k--) {
        if (staying[k].until > m.at) continue;
        for (const id of staying[k].slicers) { const node = trial.nodes.get(id); if (node) trial.setData(id, trial.def(node).defaultData()); }
        leaveMove(trial, staying[k].held);
        staying.splice(k, 1);
      }
      const held = enterMove(trial, { ...move, ops: ops.filter((op) => op.op !== 'sample') }, () => false, refs);
      const slicers = [];
      for (const op of ops) {
        if (op.op !== 'sample' || !checkSample(op, tracks, legs, move, where, problems)) continue;
        const id = refs.get(op.id) ?? op.id, node = trial.nodes.get(id);
        if (node?.type !== 'slicer') { problems.push(`${where}: a sample goes on a Slicer, and ${op.id} isn't one: add it first with edit_patch, or in this move`); continue; }
        if (holding.get(id) > m.at) problems.push(`${where}: ${op.id} is holding another sample until bar ${holding.get(id)}`);
        holding.set(id, until ?? Infinity);
        trial.setData(id, sampleData(tracks[op.track], op));
        trial.setParam(id, 'length', trial.nodes.get(id).data.steps.length);
        slicers.push(id);
      }
      for (const line of held.log) {
        if (line.startsWith('✗')) problems.push(`${where}: ${line.replace(/^✗ #(\d+) (\w+): /, 'op $1 $2: ')}`);
        else if (line.includes('; problems: ')) problems.push(`${where}: ${line.split('; problems: ')[1]}`);
      }
      if ((held.nodes.length || held.made.length || held.lost.length) && until === undefined) problems.push(`${where}: what it adds or replugs needs an until, so the set leaves the wall as it found it. Lasting cables belong in edit_patch`);
      staying.push({ until: until ?? Infinity, held, slicers });
      return move;
    });
  return list;
}

// What the moves turn, as it stands now
function homeOf(graph, moves) {
  const home = new Map();
  const keep = (id, field, name, v) => { if (!home.has(`${id}|${field}|${name}`)) home.set(`${id}|${field}|${name}`, [id, field, name, v]); };
  for (const op of moves.flatMap((m) => m.ops)) {
    const node = graph.nodes.get(op.id);
    if (!node) continue;
    if (op.op === 'pattern' || op.op === 'sample') keep(op.id, 'data', '', structuredClone(node.data));
    if (op.op === 'sample') for (const name of SAMPLE_KNOBS) keep(op.id, 'params', name, node.params[name]);
    if (op.op !== 'set') continue;
    for (const name of Object.keys(op.params ?? {})) keep(op.id, 'params', name, node.params[name]);
    for (const name of Object.keys(op.depth ?? {})) keep(op.id, 'depth', name, node.depth[name] ?? 0.5);
  }
  return [...home.values()];
}

// Returns the plan with values tidied, and `problems` that keep it from being played
export function checkPlan(graph, raw) {
  const problems = [], node = setNode(graph);
  if (!node) return { plan: null, problems: ['there is no Set on the wall'] };
  if (!node.data.tracks.length) problems.push('the Set has no tracks yet');
  if (![...graph.nodes.values()].some((n) => n.type === 'clock')) problems.push('a set needs a Clock on the wall');
  if (!graph.linkInto(node.id, 'clk')) problems.push(`nothing is patched into ${node.id}.clk: the deck follows the Clock's 1/16`);
  if (![...graph.links.values()].some((l) => l.from === node.id)) problems.push(`${node.id}.l and .r go nowhere: patch them into the rack first, with edit_patch`);
  if (typeof raw?.brief !== 'string' || !raw.brief.trim()) problems.push('a plan needs a brief: one sentence on the shape of this set');
  const arc = (Array.isArray(raw?.arc) ? raw.arc : []).map((s) => {
    if (!NAME.test(s?.name ?? '') || !Number.isInteger(s?.bars) || s.bars < 1) problems.push(`the arc needs parts like {"name":"build","bars":16} (got ${JSON.stringify(s)})`);
    return { name: s?.name, bars: s?.bars };
  });
  if (!arc.length) problems.push('a plan needs an arc: the parts of the set, which add up to its length');
  const bars = lengthOf({ arc });
  const tracks = checkTracks(raw?.tracks, node.data.tracks, bars, problems);
  const moves = checkMoves(graph, raw?.moves, bars, node.data.tracks, tracks, problems);
  return { plan: { brief: String(raw?.brief ?? '').trim(), arc, tracks, moves, home: homeOf(graph, moves) }, problems };
}

const spanOf = (m) => [m.at, Math.max(m.until ?? 0, m.at + (m.glide ?? 0), m.at + 1)];
const sameLeg = (a, b) => ['track', 'at', 'enter', 'leave', 'nudge'].every((k) => (a[k] ?? 0) === (b[k] ?? 0));

// A change to a saved plan: which moves go, which come, and the whole list of tracks or the arc if
// those change. Gives the plan as raw as one from the assistant, and the bars that are different.
export function editedPlan(plan, { remove = [], add = [], tracks, arc, brief }) {
  const problems = remove.filter((i) => !plan.moves[i]).map((i) => `there is no moves[${i}]: the plan has 0 to ${plan.moves.length - 1}`);
  const spans = [...plan.moves.filter((_, i) => remove.includes(i)), ...add].map(spanOf);
  const moved = (a, b) => a.filter((x) => !b.some((y) => sameLeg(x, y)));
  if (tracks) for (const e of [...moved(plan.tracks, tracks), ...moved(tracks, plan.tracks)]) spans.push([e.at, e.at + e.leave - e.enter]);
  const raw = { brief: brief ?? plan.brief, arc: arc ?? plan.arc, tracks: tracks ?? plan.tracks, moves: [...plan.moves.filter((_, i) => !remove.includes(i)), ...add] };
  return { raw, problems, only: spans.length ? { from: Math.min(...spans.map((x) => x[0])), to: Math.max(...spans.map((x) => x[1])) } : { from: 0, to: 0 } };
}

// A plan with what was heard of it. An edit is only heard around what changed, so what the plan
// before it found at home stays, and so does what failed in bars that weren't heard again.
export function settledPlan(plan, passages, before, only) {
  const failed = passages.filter((p) => p.problems.length).map((p) => ({ what: p.what, from: p.from ?? p.at, to: p.to ?? p.until }));
  if (!before) return { plan: { ...plan, ok: !failed.length, failed }, left: [] };
  const known = (h) => before.home.some((x) => x[0] === h[0] && x[1] === h[1] && x[2] === h[2]);
  // a plan from before this was kept says only that something failed, not where
  const earlier = before.failed ?? (before.ok === false ? [{ what: 'something from an earlier render', from: -1, to: -1 }] : []);
  const left = earlier.filter((f) => !(f.from < only.to && f.to > only.from));
  const all = [...left, ...failed];
  return { plan: { ...plan, home: [...before.home, ...plan.home.filter((h) => !known(h))], ok: !all.length, failed: all, ...(before.taught ? { taught: before.taught } : {}) }, left };
}
