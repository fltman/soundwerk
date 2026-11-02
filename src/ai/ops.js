// Applies the assistant's edit operations to the patch, validating each one and
// reporting back in words the model can act on.
import { getDef, inputPorts, outputPorts, paramRange } from '../modules/index.js';
import { dropAt, findGap, widthOf } from '../rack/place.js';
import { checkCode } from '../engine/code.js';
import { parseNotes, parseRows, parseSteps, parsePads, formatNotes, formatRows, formatSteps, formatPool } from '../rack/patterns.js';
import { bpmAt, legsOf } from '../set/score.js';
import { transitionName, transitionsOf } from '../set/taste.js';

const list = (xs) => xs.join(', ') || '(none)';

export function coerce(def, name, value) {
  const p = def.params?.find((q) => q.name === name);
  if (!p) throw new Error(`${def.type} has no param "${name}" (params: ${list((def.params ?? []).map((q) => q.name))})`);
  if (p.type === 'select') {
    if (typeof value === 'number') return Math.max(0, Math.min(p.options.length - 1, Math.round(value)));
    const s = String(value).toLowerCase();
    let i = p.options.findIndex((o) => o.toLowerCase() === s);
    if (i < 0) i = p.options.findIndex((o) => o.toLowerCase().startsWith(s));
    if (i < 0) throw new Error(`${def.type}.${name} has no option "${value}" (options: ${list(p.options)})`);
    return i;
  }
  if (p.type === 'toggle' || p.type === 'button') {
    const on = value === true || value === 1 || /^(on|true|1)$/i.test(String(value));
    return on ? 1 : 0;
  }
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`${def.type}.${name} needs a number, got "${value}"`);
  const r = paramRange(p);
  const c = Math.min(r.max, Math.max(r.min, v));
  return r.step ? Math.round(c / r.step) * r.step : c;
}

// `refs` lasts as long as the conversation, so a module named in one call can be named in the next.
export function applyOps(graph, ops, refs = new Map()) {
  const added = [];
  const touched = new Set();
  const log = [];
  let cleared = false;

  const resolve = (x, what = 'module') => {
    if (x === undefined || x === null || x === '') throw new Error(`missing ${what}`);
    const name = String(x);
    let id = graph.nodes.has(name) ? name : refs.get(name) ?? null;
    if (name.toLowerCase() === 'master') id = graph.masterNode()?.id ?? null;
    if (id && !graph.nodes.has(id)) id = null;
    if (!id) throw new Error(`no module "${x}" (ids: ${list([...graph.nodes.keys(), ...refs.keys()])})`);
    return id;
  };
  const label = (id) => `${id} (${graph.nodes.get(id)?.type})`;

  const setValues = (id, params = {}, depth = {}) => {
    const node = graph.nodes.get(id);
    const def = graph.def(node);
    const notes = [];
    for (const [name, value] of Object.entries(params ?? {})) {
      try { graph.setParam(id, name, coerce(def, name, value)); } catch (e) { notes.push(e.message); }
    }
    for (const [name, value] of Object.entries(depth ?? {})) {
      const p = def.params?.find((q) => q.name === name);
      if (!p?.cv) { notes.push(`${def.type}.${name} has no cv jack`); continue; }
      graph.setDepth(id, name, Math.max(-1, Math.min(1, Number(value) || 0)));
    }
    return notes;
  };

  const run = (op) => {
    switch (op.op) {
      case 'clear': {
        for (const n of [...graph.nodes.values()]) if (n.type !== 'master') graph.removeNode(n.id);
        if (!graph.masterNode()) graph.addNode('master');
        if (graph.rig) graph.setRig(null);   // its moves point at modules that are gone
        refs.clear();
        cleared = true;
        return 'cleared (Master kept)';
      }
      case 'add': {
        if (!getDef(op.type)) throw new Error(`unknown module type "${op.type}"`);
        if (op.type === 'master' && graph.masterNode()) throw new Error(`there is already a Master (${graph.masterNode().id})`);
        const node = graph.addNode(op.type, 0, 0);
        const at = findGap(graph, widthOf(graph, node), { skip: new Set([node.id]) });
        graph.moveNode(node.id, at.row, at.hp);
        if (op.ref) refs.set(String(op.ref), node.id);
        added.push(node.id);
        touched.add(node.id);
        const notes = setValues(node.id, op.params, op.depth);
        return `added ${op.type} → ${node.id}${op.ref ? ` (ref ${op.ref})` : ''}${notes.length ? `; problems: ${notes.join('; ')}` : ''}`;
      }
      case 'remove': {
        const id = resolve(op.id);
        if (graph.nodes.get(id).type === 'master') throw new Error('keep the Master: disconnect it instead');
        graph.removeNode(id);
        return `removed ${id}`;
      }
      case 'set': {
        const id = resolve(op.id);
        touched.add(id);
        const notes = setValues(id, op.params, op.depth);
        if (notes.length) throw new Error(notes.join('; '));
        return `set ${label(id)}`;
      }
      case 'connect': {
        const from = resolve(op.from, 'from');
        const to = resolve(op.to, 'to');
        const fromDef = graph.def(graph.nodes.get(from));
        const toDef = graph.def(graph.nodes.get(to));
        const outs = outputPorts(fromDef), ins = inputPorts(toDef);
        const fromPort = op.from_port || (outs.length === 1 ? outs[0].name : null);
        if (!outs.some((o) => o.name === fromPort)) throw new Error(`say which output of ${label(from)} (outputs: ${list(outs.map((o) => o.name))})`);
        const toPort = op.to_port || (ins.length === 1 ? ins[0].name : null);
        if (!ins.some((p) => p.name === toPort)) throw new Error(`${label(to)} has no input "${toPort ?? ''}" (inputs: ${list(ins.map((p) => p.name))})`);
        const replaced = graph.linkInto(to, toPort);
        const res = graph.connect(from, fromPort, to, toPort);
        if (!res.ok) throw new Error(res.reason);
        touched.add(to);
        if (op.mod_depth !== undefined) {
          const notes = setValues(to, {}, { [toPort]: op.mod_depth });
          if (notes.length) throw new Error(notes.join('; '));
        }
        return `${from}.${fromPort} → ${to}.${toPort}${replaced ? ` (replaced the cable from ${replaced.from}.${replaced.fromPort})` : ''}`;
      }
      case 'disconnect': {
        const to = resolve(op.to, 'to');
        const l = graph.linkInto(to, op.to_port);
        if (!l) throw new Error(`nothing is plugged into ${to}.${op.to_port}`);
        graph.disconnect(l.id);
        return `unplugged ${l.from}.${l.fromPort} → ${to}.${op.to_port}`;
      }
      case 'pattern': {
        const id = resolve(op.id);
        const node = graph.nodes.get(id);
        touched.add(id);
        if (node.type === 'bassline') {
          if (op.notes === undefined) throw new Error('a bassline pattern needs notes');
          graph.setData(id, parseNotes(op.notes));
          return `pattern on ${id}: ${formatNotes(node.data)}`;
        }
        if (node.type === 'drumseq') {
          if (!op.rows) throw new Error('a drumseq pattern needs rows');
          graph.setData(id, parseRows(op.rows, node.data));
          return `pattern on ${id}: ${formatRows(node.data)}`;
        }
        if (node.type === 'slicer') {
          if (!node.data.pool.length) throw new Error(`${label(id)} has no track yet: the user must drop an audio file on it`);
          if (op.steps === undefined && !op.pads) throw new Error('a slicer pattern needs steps, pads or both');
          const data = { ...node.data };
          if (op.pads) data.pads = parsePads(op.pads, data);
          if (op.names) data.names = { ...data.names, ...op.names };
          if (op.steps !== undefined) data.steps = parseSteps(op.steps);
          graph.setData(id, data);
          if (data.steps.length > 16 || data.steps.length < node.params.length) graph.setParam(id, 'length', data.steps.length);
          return `pattern on ${id}: ${formatSteps(data)} pads ${data.pads.join(' ')}`;
        }
        throw new Error(`${label(id)} has no pattern; only bassline, drumseq and slicer do`);
      }
      case 'code': {
        const id = resolve(op.id);
        if (graph.nodes.get(id).type !== 'code') throw new Error(`${label(id)} is not a code module`);
        if (typeof op.code !== 'string' || !/function\s+tick\s*\(/.test(op.code)) throw new Error('code must define function tick(i, o, p)');
        const err = checkCode(op.code);
        if (err) throw new Error(`that doesn't compile: ${err}`);
        graph.setCode(id, op.code);
        dropAt(graph, graph.nodes.get(id), graph.nodes.get(id).row, graph.nodes.get(id).hp);
        touched.add(id);
        const ports = inputPorts(graph.def(graph.nodes.get(id))).map((p) => p.name);
        return `code set on ${id} (inputs now: ${list(ports)})`;
      }
      default:
        throw new Error(`unknown op "${op.op}"`);
    }
  };

  (Array.isArray(ops) ? ops : []).forEach((op, i) => {
    try { log.push(`✓ ${run(op ?? {})}`); } catch (e) { log.push(`✗ #${i + 1} ${op?.op ?? '?'}: ${e.message}`); }
  });
  return { log, added: added.filter((id) => graph.nodes.has(id)), touched: [...touched].filter((id) => graph.nodes.has(id)), cleared };
}

// A track on a Set as the assistant reads it: what the analysis found, bar by bar
// What there is to sample, by the stem
function formatMaterial(t) {
  const lines = [];
  for (const [stem, m] of Object.entries(t.material ?? {})) {
    const hook = m.hook ? `; hook bars ${m.hook.bar}-${m.hook.bar + m.hook.bars}, back on ${m.hook.back.slice(0, 8).join(', ')}${m.hook.back.length > 8 ? ` and ${m.hook.back.length - 8} more` : ''}` : '';
    lines.push(`    ${stem.padEnd(6)} ${m.map}${hook}${m.rare.length ? `; once only: bar ${m.rare.join(', ')}` : ''}`);
  }
  if (t.words?.length) lines.push(`    words: ${t.words.map((w) => `${w.bars.slice(0, 4).join(', ')}${w.bars.length > 4 ? ' …' : ''} "${w.text}" (${w.long})`).join(' | ')}`);
  return lines.length ? `\n    stems, a digit for every 4 bars from . (nothing) to 9 (the loudest):\n${lines.join('\n')}` : '\n    no stems: only the whole mix can be sampled';
}

function formatTrack(t, i) {
  const part = (s) => `${s.name} ${s.from}-${s.to} (level ${s.level}, kicks ${s.kicks}, ${bpmAt(t, s.from).toFixed(1)} BPM)`;
  return `  track ${i}: "${t.file}", ${t.bpm.toFixed(1)} BPM, ${t.key}, ${t.bars} bars, ${Math.round(t.seconds)} s, highlights at ${t.loudness} LUFS before its own gain of ${t.gain}\n    parts: ${t.sections.map(part).join('; ')}${formatMaterial(t)}`;
}

// The patch as the assistant sees it: ids, non-default params, patterns, cables with depths.
// What's in some bars of a set, by the numbers the plan uses
export function describeBars(plan, tracks, { from, to }) {
  const lines = [];
  let bar = 0;
  for (const part of plan.arc) {
    if (bar < to && bar + part.bars > from) lines.push(`Part of the arc: ${part.name}, bars ${bar}-${bar + part.bars}.`);
    bar += part.bars;
  }
  for (const leg of legsOf(plan)) {
    const a = Math.max(from, leg.at), b = Math.min(to, leg.end / 16);
    if (a < b) lines.push(`Track ${leg.track} "${tracks[leg.track].file}": its bars ${leg.enter + a - leg.at}-${leg.enter + b - leg.at} are heard here. tracks[${leg.index}] plays bars ${leg.at}-${leg.end / 16} of the set.`);
  }
  plan.moves.forEach((m, i) => {
    if (m.at < to && Math.max(m.until ?? 0, m.at + m.glide, m.at + 1) > from) lines.push(`moves[${i}], bar ${m.at}${m.until === undefined ? '' : ` until ${m.until}`}: ${m.why || m.ops.map((op) => op.op).join(', ')}.`);
  });
  return lines.join('\n');
}

// A stretch of a set someone has marked, so an answer can start from there
export const describeMark = (plan, tracks, mark) => `[Marked: bars ${mark.from}-${mark.to} of the set. The user has listened to them, and this is the stretch they mean.\n${describeBars(plan, tracks, mark)}]`;

// One transition of a set and what is around it, by the numbers an offer uses
const NEARBY = 32;   // bars on each side
export function describeTransition(plan, tracks, t) {
  const all = transitionsOf(plan);
  return `Transition ${all.findIndex((x) => x.key === t.key) + 1} of ${all.length}: ${transitionName(t, tracks)}, leg ${t.leg}, side ${t.side}. The track ${t.side === 'in' ? 'starts' : 'stops'} on set bar ${t.bar}.\n${describeBars(plan, tracks, { from: Math.max(0, t.bar - NEARBY), to: t.bar + NEARBY })}`;
}

export function describePatch(graph, { selected = [], pools = false } = {}) {
  const lines = [];
  for (const n of graph.nodes.values()) {
    const def = graph.def(n);
    const vals = [];
    for (const p of def.params ?? []) {
      const v = n.params[p.name];
      if (v === paramRange(p).def) continue;
      if (p.type === 'select') vals.push(`${p.name}=${p.options[v]}`);
      else vals.push(`${p.name}=${+Number(v).toFixed(3)}`);
    }
    if (n.type === 'bassline') vals.push(`notes="${formatNotes(n.data)}"`);
    if (n.type === 'drumseq') vals.push(`rows="${formatRows(n.data)}"`);
    if (n.type === 'slicer') {
      if (n.data.file) vals.push(`file="${n.data.file}"`, `bpm=${n.data.bpm}`, `key="${n.data.key}"`);
      if (n.data.stem) vals.push(`stem=${n.data.stem}`);
      vals.push(`steps="${formatSteps(n.data)}"`, `pads=${n.data.pads.join(',')}`);
    }
    if (n.type === 'set') vals.push(`tracks=${n.data.tracks.length}`, n.data.plan ? 'planned' : 'no plan yet');
    lines.push(`${n.id} ${n.type}${vals.length ? ' ' + vals.join(' ') : ''}${selected.includes(n.id) ? '  ← selected' : ''}`);
    if (pools && n.type === 'slicer' && n.data.pool.length) lines.push(`  pool of ${n.id}:`, formatPool(n.data));
    if (pools && n.type === 'set') lines.push(...n.data.tracks.map(formatTrack));
  }
  const cables = [...graph.links.values()].map((l) => {
    const to = graph.nodes.get(l.to);
    const p = graph.def(to).params?.find((q) => q.name === l.toPort);
    const d = p?.cv ? ` depth ${+(to.depth[l.toPort] ?? 0.5).toFixed(2)}` : '';
    return `${l.from}.${l.fromPort} → ${l.to}.${l.toPort}${d}`;
  });
  return `modules:\n${lines.join('\n') || '(none)'}\ncables:\n${cables.join('\n') || '(none)'}`;
}
