// Plays a plan and has no ideas of its own. It lives on the main thread with the DJ, and like the DJ
// it never touches the audio directly: everything it does is held by the engine until the Clock
// reaches that step, so a late timer costs nothing. The same class runs ahead of the set with no
// browser, which is how a plan gets heard before anyone else hears it. Its moves are moves in the
// DJ's sense: what one adds or replugs is its own, and leaving takes it all back.
import { enterMove, leaveMove } from '../dj/rig.js';
import { sectionAt } from '../dj/choose.js';
import { eventsOf, gridOf, legsOf, lengthOf, pieceKey, pieceOf, planOf, sampleData } from './score.js';

const TICK = 25;          // ms
const LAND_AHEAD = 8;     // 16ths before its step that an event leaves for the engine
const MOST_WAITS = 8;     // bars a late track gets
const JUMP_AHEAD = 2;     // 16ths a jump needs to reach the engine
const EVERY = { s16: 1, s8: 2, s4: 4, bar: 16 };   // 16ths between the pulses of the Clock's jacks

// How many pulses have reached a module's clk before a step of the Clock, along the cable back to
// it and through any Dividers on the way. null if they come from anywhere else.
function pulses(graph, clock, id, step, depth = 0) {
  const link = graph.linkInto(id, 'clk');
  if (!link || depth > 8) return null;
  if (link.from === clock) return EVERY[link.fromPort] ? Math.ceil(step / EVERY[link.fromPort]) : null;
  if (graph.nodes.get(link.from)?.type !== 'divider') return null;
  const n = pulses(graph, clock, link.from, step, depth + 1);
  return n === null ? null : Math.ceil(n / Number(link.fromPort.slice(1)));
}

export class Conductor extends EventTarget {
  // source.track(t) brings a track's audio: { L, R, sr }, and source.stem(t, name) one of its stems
  constructor({ graph, host, source }) {
    super();
    Object.assign(this, { graph, host, source });
    this.running = false;
    this.glides = new Map();
    this.message = '';
    this.step = 0;
    this.cursor = 0;     // the step a run starts from
    this.mark = null;    // { from, to }: the bars someone has marked to talk about
    graph.addEventListener('change', (e) => {
      if (this.running && e.detail.kind === 'load') this.stop('The patch changed, so the set stopped');
    });
  }

  get node() { return [...this.graph.nodes.values()].find((n) => n.type === 'set'); }
  get clock() { return [...this.graph.nodes.values()].find((n) => n.type === 'clock'); }
  get tracks() { return this.node?.data.tracks ?? []; }
  get plan() { return planOf(this.node); }

  say(text) {
    this.message = text;
    this.update();
    return false;
  }

  update() { this.dispatchEvent(new Event('update')); }

  position() {
    const c = this.clock;
    return c ? this.host.ui(c.id)?.[3] ?? null : null;
  }

  // The arc of the set for the live DJ, or null when no set is playing
  section(bar) {
    return this.running ? sectionAt(this.plan.arc, bar - this.base / 16) : null;
  }

  // ── getting a track onto the deck ─────────────────────
  // Decoding starts as soon as the track before it does, so there's a whole track to spare.
  prepare(leg) {
    if (!leg) return null;
    if (!this.ready.has(leg.index)) this.ready.set(leg.index, this.source.track(this.tracks[leg.track]).catch((e) => { this.failure = e.message; return null; }));
    return this.ready.get(leg.index);
  }

  async post(leg) {
    const run = this.run, audio = await this.prepare(leg);
    if (run === this.run && audio) this.deliver(leg, audio);
  }

  deliver(leg, audio) {
    const t = this.tracks[leg.track], nudge = leg.nudge ?? 0;
    this.host.post({ t: 'msg', id: this.node.id, msg: { kind: 'buffer', L: audio.L, R: audio.R, sr: audio.sr, grid: gridOf(t).map((x) => x + nudge), gain: t.gain } }, audio.R === audio.L ? [audio.L.buffer] : [audio.L.buffer, audio.R.buffer]);
    leg.posted = true;
  }

  // ── a set ─────────────────────────────────────────────
  // at: the step of the set to start from, on a bar. manual: no timer, the caller calls tick().
  async start({ at = this.cursor, manual = false } = {}) {
    const { host, plan, node, clock } = this;
    if (this.running || this.starting) return false;
    if (!node) return this.say('There is no Set on the wall');
    if (!plan) return this.say('The set has no plan yet: ask the assistant, or press PLAN');
    if (!clock) return this.say('A set needs a Clock on the wall');
    this.starting = true;
    this.message = '';
    try {
      await host.start?.();
      const from = Math.min(at, this.lastBar(plan)), audio = await this.gather(plan, from).catch((e) => this.say(e.message));
      if (audio === false) return false;
      const pos = host.running ? this.position() : null;
      if (pos === null) {
        this.base = -from;
        this.begin(plan, from, audio);
        if (from) host.send(clock.id, { kind: 'located' });
        // nothing is moving yet, so what happens on the first step can happen now
        while (this.events[0]?.step === from) this.land(this.events.shift());
        host.setRunning(true);
      } else this.landing(pos, plan, from, audio);
      this.running = true;
      if (!manual) this.timer = setInterval(() => this.tick(), TICK);
    } finally {
      this.starting = false;
    }
    this.update();
    return true;
  }

  // Goes to a step of the set. What's playing plays on until the place it's going to is ready, and
  // then all of it changes on one bar. Stopped, it only says where the next run starts.
  async seek(at) {
    const plan = this.plan;
    if (!plan) return;
    const to = (this.cursor = Math.min(at, this.lastBar(plan))), run = this.run;
    if (!this.running) return;
    const audio = await this.gather(plan, to, true).catch((e) => this.say(e.message));
    // the last hand on the chart wins
    if (audio === false || to !== this.cursor || run !== this.run || !this.running) return;
    this.landing(this.position(), plan, to, audio);
  }

  lastBar(plan) { return (lengthOf(plan) - 1) * 16; }

  // On the next bar of the Clock. A plan's events are all on bars, so that's after whatever has
  // already left for the engine, or with it.
  landing(pos, plan, at, audio) {
    const bar = Math.ceil((pos + JUMP_AHEAD) / 16) * 16;
    this.base = bar - at;
    this.host.at(this.clock.id, bar, () => {
      if (this.running) this.undo();
      this.begin(plan, at, audio);
    });
    this.step = pos - this.base;
  }

  // What a run from step `at` needs from outside, and nothing on the wall changes while it's fetched.
  // A track that is playing already has to be here; the rack doesn't wait for one that isn't due,
  // unless the deck is in use (`all`): what lands there early would cut off what it's playing.
  async gather(plan, at, all) {
    if (this.cutFrom !== plan) { this.clips = await this.cut(plan); this.cutFrom = plan; }
    const leg = legsOf(plan).find((l) => at < l.end);
    return leg && (all || at >= leg.start) ? this.source.track(this.tracks[leg.track]) : null;
  }

  // The wall as the plan would have left it on step `at`, and the score from there on
  begin(plan, at, audio) {
    const { graph, node } = this, score = eventsOf(plan);
    this.run = (this.run ?? 0) + 1;
    this.at = this.step = at;
    this.legs = score.legs;
    this.ready = new Map();
    this.failure = null;
    this.waited = 0;
    this.refs = new Map();     // names a move gave what it added, for the moves after it
    this.held = new Map();     // move → what it changed
    this.before = new Map();   // what the plan has written over, to put back
    this.rewind();
    for (const [id, field, name, v] of plan.home ?? []) if (graph.nodes.has(id)) this.write(id, field, name, v);
    const first = this.legs.find((l) => at < l.end);
    if (first && audio) this.deliver(first, audio);
    else if (first) this.post(first);
    this.prepare(this.legs[(first?.index ?? -1) + 1]);
    // whatever the set would have done by now, with the knobs that are on their way still on it
    for (const e of score.events) {
      if (e.step >= at) break;
      this.stepGlides(e.step);
      if (e.type === 'move') this.replay(plan.moves[e.move], e);
      else if (e.type === 'leave') this.leave(e);
    }
    this.stepGlides(at);
    for (const id of this.counted.keys()) this.count(id, at);
    this.events = score.events.filter((e) => e.step >= at && !(e.type === 'load' && e.leg === first?.index));
    this.legIndex = first?.index ?? 0;
    if (first && at > first.start) this.host.send(node.id, { kind: 'cue', from: first.enter * 16 + at - first.start });
  }

  replay(move, e) {
    for (const op of move.ops) this.count(this.idOf(op), e.step);
    const held = this.enter(move, e.step);
    for (const id of held.nodes) this.counted.set(id, e.step);
    this.held.set(e.move, held);
  }

  // Sequencers count pulses, and a run that starts late hasn't given them any. They're sent back to
  // the top and told what they missed, as if it had gone by without a sound, in order with the moves
  // because where a pattern wraps can change on the way. A run always hears the rack the same way.
  rewind() {
    this.counted = new Map();   // id → the step it has been told about
    for (const id of this.graph.nodes.keys()) {
      if (pulses(this.graph, this.clock.id, id, 0) === null) continue;
      this.counted.set(id, 0);
      this.host.send(id, { kind: 'rewind' });
    }
  }

  count(id, step) {
    const from = this.counted.get(id);
    if (from === undefined) return;
    const clock = this.clock.id, had = pulses(this.graph, clock, id, from), has = pulses(this.graph, clock, id, step);
    if (had !== null && has > had) this.host.send(id, { kind: 'advance', n: has - had });
    this.counted.set(id, step);
  }

  // Stopped halfway, the wall goes back to what it was
  stop(message = '') {
    if (!this.running) return;
    this.running = false;
    this.run++;
    clearInterval(this.timer);
    this.undo();
    this.message = message;
    this.update();
  }

  undo() {
    this.glides.clear();
    for (const move of [...this.held.keys()]) this.leave({ move });
    for (const [key, v] of this.before) {
      const [id, field, name] = key.split('|');
      if (this.graph.nodes.has(id)) this.write(id, field, name, v);
    }
    if (this.host.running) this.host.send(this.node?.id, { kind: 'clear' });
  }

  // Played to the end, the rack carries on from wherever the plan left it
  finish() {
    this.running = false;
    this.run++;
    clearInterval(this.timer);
    this.finishGlides();
    if (this.host.running) this.host.send(this.node?.id, { kind: 'clear' });
    this.cursor = 0;
    this.say('The set is over');
  }

  tick() {
    if (!this.running) return;
    const pos = this.position();
    if (pos === null) { this.stop('The Clock is gone, so the set stopped'); return; }
    if (!this.host.running) { this.stop(); return; }
    const step = pos - this.base;
    this.step = step;
    this.stepGlides(step);
    while (this.events.length && this.events[0].step - step <= LAND_AHEAD) {
      const e = this.events.shift();
      if (e.type === 'end') { this.events.unshift(e); if (step >= e.step) this.finish(); return; }
      this.fire(e);
    }
  }

  fire(e) {
    if (e.type === 'load') { this.post(this.legs[e.leg]); return; }
    if (e.type === 'cue' && !this.legs[e.leg].posted) {
      // it never got here in time: the rack plays on until it has
      if (++this.waited > MOST_WAITS || this.failure) { this.stop(this.failure ?? 'The next track never arrived, so the set stopped'); return; }
      this.say('The next track was late, so the rack plays on for a bar');
      this.delay(e, 16);
      return;
    }
    const lit = [];
    this.host.at(this.clock.id, e.step + this.base, () => lit.push(...this.land(e)));
    if (lit.length) this.dispatchEvent(new CustomEvent('landed', { detail: { ids: lit } }));
    if (e.type === 'cue') this.prepare(this.legs[e.leg + 1]);
  }

  // what an event does, on its step
  land(e) {
    const id = this.node.id;
    if (e.type === 'cue') {
      const leg = this.legs[e.leg];
      this.host.send(id, { kind: 'cue', from: leg.enter * 16 });
      this.legIndex = e.leg;
    } else if (e.type === 'stop') this.host.send(id, { kind: 'stop' });
    else if (e.type === 'leave') this.leave(e);
    else if (e.type === 'move') {
      const move = this.plan.moves[e.move], held = this.enter(move, e.step);
      this.held.set(e.move, held);
      return [...held.nodes, ...move.ops.flatMap((op) => [this.idOf(op), op.to])].filter(Boolean);
    }
    return [];
  }

  delay(e, steps) {
    e.step += steps;
    for (const x of this.events) x.step += steps;
    for (const l of this.legs) if (l.index >= e.leg) { l.start += steps; l.end += steps; }
    this.events.unshift(e);
  }

  // ── moves ─────────────────────────────────────────────
  idOf(op) { return this.refs.get(op.id) ?? op.id; }

  // What a plan samples is cut from its tracks before the set, so a move only has to place it. A plan
  // that was only changed in places keeps what it had.
  async cut(plan) {
    const clips = new Map(), pieces = new Map();
    for (const op of plan.moves.flatMap((m) => m.ops)) {
      if (op.op !== 'sample') continue;
      const t = this.tracks[op.track], data = sampleData(t, op), nudge = plan.tracks.find((e) => e.track === op.track)?.nudge;
      const key = `${pieceKey(t, op)}/${nudge}`;
      if (!pieces.has(key)) pieces.set(key, this.pieces?.get(key) ?? await pieceOf(this.source, t, op, nudge).catch(() => null));
      if (pieces.get(key)) clips.set(op, { data, audio: { ...pieces.get(key), hash: data.hash, name: t.file } });
    }
    this.pieces = pieces;
    return clips;
  }

  // Fills a Slicer. It's a held message like the rest of the move, so it lands on the step, and its
  // pattern starts over.
  load(op) {
    const { graph } = this, id = this.idOf(op), clip = this.clips.get(op);
    if (!clip || !graph.nodes.has(id)) return;
    graph.setData(id, clip.data);
    graph.setParam(id, 'length', clip.data.steps.length);
    graph.setParam(id, 'gain', op.gain ?? 1);
    graph.setParam(id, 'tune', op.tune ?? 0);
    this.host.setBuffer(id, clip.audio);
  }

  empty(op) {
    const { graph } = this, id = this.idOf(op), node = graph.nodes.get(id);
    if (!node) return;
    this.host.clearBuffer(id);
    graph.setData(id, graph.def(node).defaultData());
  }

  // Plays a move, with its knobs on their way from step `from`
  enter(move, from) {
    const { graph } = this, length = move.glide * 16;
    const gliding = (op) => length > 0 && op.op === 'set' && graph.nodes.has(this.idOf(op));
    for (const op of move.ops) {
      this.remember(op);
      if (op.op !== 'set') continue;
      // whatever was heading for these knobs doesn't get to finish, or it lands on top of this
      const id = this.idOf(op);
      for (const name of Object.keys(op.params ?? {})) this.glides.delete(`${id}.params.${name}`);
      for (const name of Object.keys(op.depth ?? {})) this.glides.delete(`${id}.depth.${name}`);
    }
    const held = enterMove(graph, { ...move, ops: move.ops.filter((op) => op.op !== 'sample') }, gliding, this.refs);
    for (const op of move.ops) if (op.op === 'sample' && move.until * 16 > this.at) this.load(op);
    for (const op of move.ops) {
      if (!gliding(op)) continue;
      const id = this.idOf(op);
      for (const [name, v] of Object.entries(op.params ?? {})) this.glideTo(id, 'params', name, v, from, length);
      for (const [name, v] of Object.entries(op.depth ?? {})) this.glideTo(id, 'depth', name, v, from, length);
    }
    return held;
  }

  leave(e) {
    for (const op of this.plan.moves[e.move].ops) if (op.op === 'sample') this.empty(op);
    leaveMove(this.graph, this.held.get(e.move));
    this.held.delete(e.move);
  }

  remember(op) {
    const id = this.idOf(op), node = this.graph.nodes.get(id);
    if (!node) return;
    const keep = (field, name, v) => { const key = `${id}|${field}|${name}`; if (!this.before.has(key)) this.before.set(key, v); };
    if (op.op === 'pattern' || op.op === 'sample') keep('data', '', structuredClone(node.data));
    if (op.op === 'sample') for (const name of ['length', 'gain', 'tune']) keep('params', name, node.params[name]);
    if (op.op !== 'set') return;
    for (const name of Object.keys(op.params ?? {})) keep('params', name, node.params[name]);
    for (const name of Object.keys(op.depth ?? {})) keep('depth', name, node.depth[name] ?? 0.5);
  }

  // ── knobs on their way somewhere ──────────────────────
  glideTo(id, field, name, value, from, length) {
    const node = this.graph.nodes.get(id);
    const p = this.graph.def(node).params?.find((q) => q.name === name);
    const key = `${id}.${field}.${name}`;
    this.glides.delete(key);
    const was = field === 'depth' ? node.depth[name] ?? 0.5 : node.params[name];
    if (!p || p.type || was === value) { this.write(id, field, name, value); return; }
    this.glides.set(key, { id, field, name, to: value, from: null, s0: from, s1: from + length, step: p.step });
  }

  write(id, field, name, value) {
    if (field === 'depth') this.graph.setDepth(id, name, value);
    else if (field === 'data') this.graph.setData(id, value);
    else this.graph.setParam(id, name, value);
  }

  stepGlides(step) {
    for (const [key, g] of this.glides) {
      if (step < g.s0) continue;
      const node = this.graph.nodes.get(g.id);
      if (!node) { this.glides.delete(key); continue; }
      g.from ??= g.field === 'depth' ? node.depth[g.name] ?? 0.5 : node.params[g.name];
      const t = Math.min(1, (step - g.s0) / (g.s1 - g.s0));
      let v = g.from + (g.to - g.from) * t * t * (3 - 2 * t);
      if (g.step) v = Math.round(v / g.step) * g.step;
      this.write(g.id, g.field, g.name, t >= 1 ? g.to : v);
      if (t >= 1) this.glides.delete(key);
    }
  }

  finishGlides() {
    for (const g of this.glides.values()) if (this.graph.nodes.has(g.id)) this.write(g.id, g.field, g.name, g.to);
    this.glides.clear();
  }
}
