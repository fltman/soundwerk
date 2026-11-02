// A rig is a patch made to be performed. The assistant builds it and lists the moves; the live DJ
// only ever picks one of those moves, and only moves that passed a test render.
//
//   { brief, arc: [{ name, bars }],
//     groups: [{ name, question, every, on_section, ordered,
//                moves: [{ name, description, glide, ops: [...] }] }] }
//
// arc is the shape of the set and goes round and round: a wall has no track to follow, so this is
// what tells the DJ a build or a break is due. The first move of a group is its home, a state
// known to sound right. ops are edit_patch operations limited to set, connect, disconnect, pattern
// and add. Whatever a move adds or replugs belongs to it: when the group moves on, the modules go
// and the cables they replaced come back, so a move never has to write its way out.
import { Graph } from '../rack/graph.js';
import { applyOps, coerce } from '../ai/ops.js';

export const MAX_GROUPS = 8;
export const MAX_MOVES = 26; // some decision models refuse longer choices
const EVERY = [1, 2, 4, 8, 16, 32];
export const LIVE_OPS = ['set', 'connect', 'disconnect', 'pattern', 'add'];
const NAME = /^[a-z0-9_]{1,32}$/i;
const DEFAULT_ARC = [{ name: 'groove', bars: 16 }, { name: 'build', bars: 8 }, { name: 'peak', bars: 32 }, { name: 'break', bars: 8 }];

export const clone = (graph) => { const g = new Graph(); g.load(graph.toJSON()); return g; };

// Plays a move on a patch and remembers how to take it back. skip leaves ops for the caller to do.
// refs: names that outlast the move, for a plan whose later moves reach what an earlier one added.
export function enterMove(graph, move, skip = () => false, refs = new Map()) {
  const before = [...graph.links.values()].map((l) => ({ ...l }));
  const depths = new Map([...graph.nodes].map(([id, n]) => [id, { ...n.depth }]));
  const { added, log } = applyOps(graph, move.ops.filter((op) => !skip(op)), refs);
  const made = [...graph.links.keys()].filter((id) => !before.some((l) => l.id === id));
  const lost = before.filter((l) => !graph.links.has(l.id));
  // what each replugged jack's depth was, including none at all, so it goes back with the cable
  const depth = [...lost, ...made.map((id) => graph.links.get(id))]
    .filter((l) => depths.has(l.to))
    .map(({ to, toPort }) => ({ to, toPort, depth: depths.get(to)[toPort] }));
  return { move: move.name, nodes: added, made, lost, depth, log };
}

export function leaveMove(graph, held) {
  if (!held) return;
  for (const id of held.made) if (graph.links.has(id)) graph.disconnect(id);
  for (const id of held.nodes) if (graph.nodes.has(id)) graph.removeNode(id);
  for (const l of held.lost) {
    if (!graph.nodes.has(l.from) || !graph.nodes.has(l.to) || graph.linkInto(l.to, l.toPort)) continue;
    graph.connect(l.from, l.fromPort, l.to, l.toPort);
  }
  for (const { to, toPort, depth } of held.depth ?? held.lost) {   // older patches kept it on the cable
    if (depth === undefined) graph.clearDepth(to, toPort);
    else graph.setDepth(to, toPort, depth);
  }
}

// A copy of the patch with every group on its home move.
export function atHome(graph, rig) {
  const g = clone(graph);
  for (const h of Object.values(rig.held ?? {})) leaveMove(g, h);
  const held = {};
  for (const group of rig.groups) held[group.name] = enterMove(g, group.moves[0]);
  return { graph: g, held };
}

// Tells apart two states of a patch by what they play: where modules sit doesn't matter.
export function fingerprint(json) {
  const text = JSON.stringify([
    json.nodes.map(({ row, hp, ...n }) => n),
    json.links.map((l) => `${l.from}.${l.fromPort}>${l.to}.${l.toPort}`).sort(),
  ]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function tidyOp(graph, op) {
  if (op.op !== 'set') return { ...op };
  const id = String(op.id).toLowerCase() === 'master' ? graph.masterNode()?.id : String(op.id);
  const node = graph.nodes.get(id);
  if (!node) return { ...op };   // a module this move adds, or a mistake the trial run will report
  const params = {};
  for (const [name, value] of Object.entries(op.params ?? {})) {
    try { params[name] = coerce(graph.def(node), name, value); } catch { params[name] = value; }
  }
  const depth = Object.fromEntries(Object.entries(op.depth ?? {}).map(([k, v]) => [k, Math.max(-1, Math.min(1, Number(v) || 0))]));
  return { op: 'set', id, params, depth };
}

function checkMove(base, group, m, first, seen, problems) {
  const where = `${group.name}/${m?.name}`;
  if (!NAME.test(m?.name ?? '')) problems.push(`${group.name}: a move needs a name of letters, digits and _ (got "${m?.name}")`);
  else if (seen.has(m.name)) problems.push(`${where}: two moves have this name`);
  seen.add(m?.name);
  if (typeof m?.description !== 'string' || !m.description.trim()) problems.push(`${where}: needs a description, it is all the DJ gets to read`);
  const list = Array.isArray(m?.ops) ? m.ops : [];
  if (!list.length && !first) problems.push(`${where}: has no ops (only a home move may be empty)`);
  const ops = [];
  list.forEach((op, i) => {
    const at = `${where} op ${i + 1}`;
    if (!LIVE_OPS.includes(op?.op)) problems.push(`${at}: during a set only ${LIVE_OPS.join(', ')} can run (got "${op?.op}")`);
    else if (op.op === 'add' && op.type === 'code') problems.push(`${at}: a Code module can't be added during a set`);
    else ops.push(tidyOp(base, op));
  });
  const glide = Number.isFinite(m?.glide) ? Math.max(0, Math.min(16, m.glide)) : 1;
  const move = { name: m?.name, description: String(m?.description ?? '').trim(), glide, ops };
  // a trial run on a copy says everything a real one would
  const trial = clone(base);
  const held = enterMove(trial, move);
  for (const line of held.log) {
    if (line.startsWith('✗')) problems.push(`${where}: ${line.replace(/^✗ #(\d+) (\w+): /, 'op $1 $2: ')}`);
    else if (line.includes('; problems: ')) problems.push(`${where}: ${line.split('; problems: ')[1]}`);   // an add that half worked
  }
  // only jacks of the patch itself: what each move adds is its own, whatever id the trial gave it
  const jacks = new Set([...held.lost, ...held.made.map((id) => trial.links.get(id))]
    .filter((l) => base.nodes.has(l.to))
    .map((l) => `${l.to}.${l.toPort}`));
  return { move, jacks };
}

// What a move writes that stays written, as "node.param" strings
function writes(base, move) {
  const out = new Set();
  for (const op of move.ops) {
    if (op.op === 'set' && base.nodes.has(op.id)) {
      for (const k of [...Object.keys(op.params), ...Object.keys(op.depth).map((d) => `${d} depth`)]) out.add(`${op.id}.${k}`);
    } else if (op.op === 'pattern') out.add(`${op.id} pattern`);
  }
  return out;
}

// Returns the rig with values tidied, `problems` that block it, and `notes` that don't.
export function checkRig(graph, raw) {
  const problems = [], notes = [];
  if (![...graph.nodes.values()].some((n) => n.type === 'clock')) problems.push('a rig needs a Clock on the wall: the DJ counts bars by it');
  const groups = Array.isArray(raw?.groups) ? raw.groups : [];
  if (!groups.length) problems.push('a rig needs at least one group');
  if (typeof raw?.brief !== 'string' || !raw.brief.trim()) problems.push('a rig needs a brief: one or two sentences on how to play it');
  if (groups.length > MAX_GROUPS) problems.push(`at most ${MAX_GROUPS} groups`);
  const arc = (Array.isArray(raw?.arc) && raw.arc.length ? raw.arc : DEFAULT_ARC).map((s) => {
    if (!NAME.test(s?.name ?? '') || !Number.isInteger(s?.bars) || s.bars < 1 || s.bars > 256) problems.push(`the arc needs sections like {"name":"build","bars":16} (got ${JSON.stringify(s)})`);
    return { name: s?.name, bars: s?.bars };
  });

  const base = clone(graph);
  for (const h of Object.values(graph.rig?.held ?? {})) leaveMove(base, h);
  const names = new Set();
  const owners = new Map();   // "n4.ch3" → the group that replugs that jack
  const tidy = groups.map((g) => {
    if (!NAME.test(g?.name ?? '')) problems.push(`a group needs a name of letters, digits and _ (got "${g?.name}")`);
    else if (names.has(g.name)) problems.push(`${g.name}: two groups have this name`);
    names.add(g?.name);
    if (typeof g?.question !== 'string' || !g.question.trim()) problems.push(`${g?.name}: needs a question for the DJ`);
    const list = Array.isArray(g?.moves) ? g.moves : [];
    if (list.length < 2) problems.push(`${g?.name}: needs at least 2 moves, or there is nothing to decide`);
    if (list.length > MAX_MOVES) problems.push(`${g?.name}: at most ${MAX_MOVES} moves`);
    const group = {
      name: g?.name,
      question: String(g?.question ?? '').trim(),
      every: EVERY.includes(g?.every) ? g.every : 8,
      on_section: !!g?.on_section,
      ordered: !!g?.ordered,
      moves: [],
    };
    const seen = new Set();
    for (const [i, m] of list.entries()) {
      const { move, jacks } = checkMove(base, group, m, i === 0, seen, problems);
      group.moves.push(move);
      for (const jack of jacks) {
        const owner = owners.get(jack);
        if (owner && owner !== group.name) problems.push(`${jack}: both ${owner} and ${group.name} replug this jack; only one group may`);
        owners.set(jack, group.name);
      }
    }
    const sets = group.moves.map((m) => writes(base, m));
    const all = new Set(sets.flatMap((s) => [...s]));
    group.moves.forEach((m, i) => {
      const missing = [...all].filter((k) => !sets[i].has(k));
      if (missing.length) notes.push(`${group.name}/${m.name} leaves ${missing.join(', ')} as the previous move left them`);
    });
    return group;
  });
  return { rig: { brief: String(raw?.brief ?? '').trim(), arc, groups: tidy }, problems, notes };
}
