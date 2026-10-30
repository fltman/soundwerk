// The live DJ performs a rig. On every downbeat it asks a decision model what suits the next bar,
// and the answer lands on the next downbeat, sample-right, because the engine holds it until the
// Clock gets there. Code decides when something may change and the model decides what; a late or
// failed answer means nothing changes, and the music never waits for the network.
import { atHome, checkRig, enterMove, fingerprint, leaveMove } from './rig.js';
import { isDue, pickMove, questionsFor, sectionAt } from './choose.js';

const RECENT = 6;        // moves it remembers
const LOG = 40;
const TICK = 25;         // ms; a timer, not a frame, so a set goes on in a background tab
const LAND_AHEAD = 2;    // 16ths before the downbeat that a move leaves for the engine
const MIN_LEAD = 0.3;    // seconds; a downbeat closer than this can't be reached, so don't ask
const GIVE_UP = 4;       // failures in a row; after this it asks only every 8 bars
const FATAL = new Set([401, 402, 403]); // no use trying again: key or credit
const QUIET = 0.003;     // loudest sample of a bar (−50 dB) that counts as silence
const HOT = 0.6;         // the Master's limiter light, averaged over a bar (about −1 dB, all bar)
const BAD_BARS = 2;      // bars it must stay wrong before the DJ steps in
const RESCUE_EVERY = 8;  // bars between rescues
const BUSY = 0.7;        // share of the audio deadline above which no module may be added
const TREND = 1.5;       // dB over four bars that count as rising or falling
const FINISHED = { sub: -6, bass: -3, lowmid: -9, mid: -12, high: -15, air: -19 }; // see catalog.js

async function askServer(body, signal) {
  const r = await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || json.error) throw Object.assign(new Error(json.error || `HTTP ${r.status}`), { status: json.status ?? r.status });
  return json;
}

function auditInWorker(job, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { result, error, done, total } = e.data;
      if (done) { onProgress(done, total); return; }
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage(job);
  });
}

const round1 = (x) => +x.toFixed(1);

export class DJ extends EventTarget {
  constructor({ graph, host, decide = askServer, audit = auditInWorker, random = Math.random }) {
    super();
    Object.assign(this, { graph, host, decide, audit, random });
    this.running = false;
    this.pending = new Map();   // group → { move, by, odds }: lands on the next downbeat
    this.odds = new Map();      // group → the model's last odds
    this.changedAt = new Map(); // group → the bar it last changed
    this.glides = new Map();
    this.recent = [];
    this.log = [];
    this.bar = null;            // the Clock's bar
    this.played = -1;           // bars of this set
    this.testing = null;        // { done, total } while the moves are being tested
    this.auditions = 0;
    this.message = '';
    this.resetStats();
    graph.addEventListener('change', (e) => {
      if (this.running && (e.detail.kind === 'load' || (e.detail.kind === 'rig' && !this.rig))) this.stop('The patch changed, so the DJ stopped', false);
    });
  }

  get rig() { return this.graph.rig; }

  clock() { return [...this.graph.nodes.values()].find((n) => n.type === 'clock'); }

  group(name) { return this.rig?.groups.find((g) => g.name === name); }

  current(g) { return this.rig?.held?.[g.name]?.move; }

  // where the Clock is, in 16ths
  position() {
    const c = this.clock();
    return c ? this.host.ui(c.id)?.[3] ?? null : null;
  }

  resetStats() {
    this.stats = { calls: 0, fails: 0, late: 0, cost: 0, ms: 0, model: '', inRow: 0 };
  }

  update() { this.dispatchEvent(new Event('update')); }

  say(text) {
    this.message = text;
    this.update();
    return false;
  }

  // ── before a set ──────────────────────────────────────
  // The assistant's rig, checked and tested: the patch goes home, and every move gets a verdict.
  async install(raw) {
    const { rig, problems, notes } = checkRig(this.graph, raw);
    if (problems.length) return { saved: false, lines: problems.map((p) => `✗ ${p}`) };
    if (this.running) this.stop();
    for (const h of Object.values(this.rig?.held ?? {})) leaveMove(this.graph, h);
    rig.held = {};
    this.graph.setRig(rig);
    for (const g of rig.groups) this.fire(g, g.moves[0], { by: 'start', bars: 0 });
    await this.audition();
    this.graph.commit();
    const lines = [];
    for (const g of rig.groups) {
      for (const m of g.moves) {
        const t = m.test;
        lines.push(t.ok ? `✓ ${g.name}/${m.name}: ${t.lufs} LUFS${t.measured ? `, ${t.measured}` : ''}` : `✗ ${g.name}/${m.name}: ${t.why}`);
      }
    }
    return { saved: true, lines: [...lines, ...notes.map((n) => `⚠ ${n}`)] };
  }

  tested() {
    return this.rig.print === fingerprint(atHome(this.graph, this.rig).graph.toJSON());
  }

  // Every move through the real engine, in a worker. Only moves that passed are ever played.
  async audition() {
    const { rig, graph, host } = this;
    const run = ++this.auditions;
    this.testing = { done: 0, total: rig.groups.reduce((s, g) => s + g.moves.length - 1, 0) };
    this.update();
    try {
      const res = await this.audit({ patch: graph.toJSON(), rig, buffers: Object.fromEntries(host.buffers ?? []) }, (done, total) => {
        this.testing = { done, total };
        this.update();
      });
      if (graph.rig !== rig) return;   // the patch was replaced meanwhile
      for (const g of rig.groups) for (const m of g.moves) m.test = res.moves[`${g.name}/${m.name}`];
      rig.print = res.print;
      graph.changed('rig');
    } catch (e) {
      this.say(`Couldn't test the moves: ${e.message}`);
    } finally {
      if (run === this.auditions) this.testing = null;
      this.update();
    }
  }

  // ── a set ─────────────────────────────────────────────
  async start() {
    const { graph, host, rig } = this;
    if (this.running || this.starting) return false;
    if (!rig) return this.say('This patch has no rig yet');
    if (!this.clock()) return this.say('The DJ needs a Clock on the wall');
    const { problems } = checkRig(graph, rig);
    if (problems.length) return this.say(`The rig no longer fits the patch: ${problems[0]}`);
    this.starting = true;
    await host.start().finally(() => { this.starting = false; });
    this.resetStats();
    this.pending.clear();
    this.recent = [];
    this.log = [];
    this.bar = null;
    this.played = -1;
    this.levels = [];
    this.heard = { peak: 0, limit: 0, n: 0 };
    this.quietBars = 0;
    this.hotBars = 0;
    this.rescuedAt = -Infinity;
    this.message = '';
    this.running = true;
    if (host.running) for (const g of rig.groups) this.pending.set(g.name, { move: g.moves[0], by: 'start', bars: 0 });
    else {
      for (const g of rig.groups) this.fire(g, g.moves[0], { by: 'start', bars: 0 });
      host.setRunning(true);
    }
    this.timer = setInterval(() => this.tick(), TICK);
    // the music can start now; nothing untested gets played while this runs
    if (!this.tested()) {
      for (const g of rig.groups) for (const m of g.moves) delete m.test;
      this.audition();
    }
    this.update();
    return true;
  }

  stop(message = '', commit = true) {
    this.running = false;
    clearInterval(this.timer);
    this.abort?.abort();
    this.pending.clear();
    this.finishGlides();
    this.message = message;
    if (commit) this.graph.commit();
    this.update();
  }

  // Your own pick: lands on the next downbeat, or right away with the wall stopped.
  queue(groupName, moveName) {
    const g = this.group(groupName);
    const move = g?.moves.find((m) => m.name === moveName);
    if (!move) return;
    if (this.running) this.pending.set(g.name, { move, by: 'you' });
    else {
      const pos = this.host.running ? this.position() : null;
      if (pos === null) this.fire(g, move, { by: 'you', bars: 0 });
      else this.host.at(this.clock().id, (Math.floor(pos / 16) + 1) * 16, () => this.fire(g, move, { by: 'you', bars: 0 }));
      this.graph.commit();
    }
    this.update();
  }

  // ── all the time ──────────────────────────────────────
  tick() {
    if (!this.running) return;
    const pos = this.position();
    if (pos === null) { this.stop('The Clock is gone, so the DJ stopped'); return; }
    this.stepGlides(pos);
    if (!this.host.running) return;
    this.listen();
    const bar = Math.floor(pos / 16);
    if (bar !== this.bar) this.newBar(bar);
    if (this.pending.size && (bar + 1) * 16 - pos <= LAND_AHEAD) this.land((bar + 1) * 16);
  }

  listen() {
    const { heard, host, graph } = this;
    heard.peak = Math.max(heard.peak, ...host.peaks);
    heard.limit += host.ui(graph.masterNode()?.id)?.[0] ?? 0;
    heard.n++;
    host.ear?.sample();
  }

  newBar(bar) {
    const jumped = this.bar !== null && bar !== this.bar + 1;
    if (this.bar !== null && this.pending.size) {
      // a bar went by before they could leave: those were meant for another moment
      this.stats.late += this.pending.size;
      this.pending.clear();
    }
    this.bar = bar;
    this.played++;
    if (!jumped) this.watch();
    this.heard = { peak: 0, limit: 0, n: 0 };
    const level = this.host.ear?.take();
    if (level) this.levels = [...this.levels, level].slice(-5);
    const bpm = this.clock().params.bpm;
    if ((240 / bpm) * (1 - (this.position() % 16) / 16) >= MIN_LEAD) this.ask(this.played + 1);
    this.update();
  }

  land(step) {
    const lit = new Set(), landing = [...this.pending];
    this.pending.clear();
    this.host.at(this.clock().id, step, () => {
      for (const [name, { move, by, odds, bars }] of landing) {
        for (const id of this.fire(this.group(name), move, { by, odds, bars, step })) lit.add(id);
      }
    });
    this.dispatchEvent(new CustomEvent('landed', { detail: { ids: [...lit] } }));
    this.update();
  }

  // ── asking ────────────────────────────────────────────
  ask(bar) {
    if (this.stats.inRow >= GIVE_UP && bar % 8) return;
    const section = sectionAt(this.rig.arc, bar);
    const due = this.rig.groups
      .filter((g) => !this.pending.has(g.name) && isDue(g, section))
      .map((g) => this.usable(g))
      .filter((g) => g.moves.length > 1);
    if (!due.length) return;
    this.abort?.abort(); // anything still on its way is too late now
    const abort = (this.abort = new AbortController());
    const t0 = performance.now();
    this.decide({ state: this.moment(bar, section), questions: questionsFor(due) }, abort.signal).then(
      (res) => this.answered(bar, due, res, performance.now() - t0),
      (e) => this.failed(e),
    );
  }

  // Only what has passed its test, and nothing new while the audio thread has no room for it
  usable(g) {
    const busy = this.host.cpu > BUSY;
    const current = this.current(g);
    return { ...g, moves: g.moves.filter((m) => m.name === current || (m.test?.ok && !(busy && m.ops.some((op) => op.op === 'add')))) };
  }

  // What the model gets to see. Nothing about the patch: the moves say what they do.
  moment(bar, section) {
    const now = {}, held = {};
    for (const g of this.rig.groups) {
      now[g.name] = this.current(g);
      held[g.name] = Math.max(0, bar - (this.changedAt.get(g.name) ?? bar));
    }
    const level = this.levels.at(-1), was = this.levels[0];
    const change = level && was ? level.db - was.db : 0;
    return {
      direction: this.rig.brief || undefined,
      music: {
        bpm: Math.round(this.clock().params.bpm),
        bars_played: bar,
        section: section.name,
        bars_into_section: section.into,
        bars_left_in_section: section.left,
        next_section: section.next,
        level_trend: change > TREND ? 'rising' : change < -TREND ? 'falling' : 'steady',
        bands_against_a_finished_track_db: level
          ? Object.fromEntries(Object.entries(level.balance).map(([k, v]) => [k, round1(v - FINISHED[k])]))
          : undefined,
      },
      playing_now: now,
      bars_held: held,
      recent_moves: this.recent,
    };
  }

  answered(bar, due, res, ms) {
    const s = this.stats;
    s.calls++;
    if (s.inRow) this.message = '';   // the error it was showing is over
    s.inRow = 0;
    s.cost += res.usage?.cost ?? 0;
    s.ms = ms;
    s.model = res.model ?? s.model;
    if (!this.running) return;
    if (this.played !== bar - 1) { s.late++; this.update(); return; }
    for (const g of due) {
      if (this.pending.has(g.name) || !res.answers?.[g.name]) continue;
      const { move, odds } = pickMove(g, res.answers[g.name], {
        current: this.current(g),
        heldBars: bar - (this.changedAt.get(g.name) ?? bar),
        recent: this.recent.filter((r) => r.startsWith(`${g.name}:`)).map((r) => r.slice(g.name.length + 1)),
        random: this.random,
      });
      this.odds.set(g.name, odds);
      if (move) this.pending.set(g.name, { move, by: 'dj', odds });
    }
    this.update();
  }

  failed(e) {
    if (e.name === 'AbortError') {
      if (this.running) this.stats.late++;
      return;
    }
    this.stats.fails++;
    this.stats.inRow++;
    if (FATAL.has(e.status)) this.stop(`The DJ stopped: ${e.message}`);
    else this.say(e.message);
  }

  // A silent or overloaded wall is for code to catch: back to the moves known to sound right.
  watch() {
    const { peak, limit, n } = this.heard;
    if (!n) return;
    this.quietBars = peak < QUIET ? this.quietBars + 1 : 0;
    this.hotBars = limit / n > HOT ? this.hotBars + 1 : 0;
    const why = this.quietBars >= BAD_BARS ? 'It went silent' : this.hotBars >= BAD_BARS ? 'The limiter was working too hard' : '';
    if (!why || this.played - this.rescuedAt < RESCUE_EVERY) return;
    this.rescuedAt = this.played;
    for (const g of this.rig.groups) {
      if (this.current(g) !== g.moves[0].name) this.pending.set(g.name, { move: g.moves[0], by: 'safety' });
    }
    this.say(`${why}, so everything went back home`);
  }

  // ── moves ─────────────────────────────────────────────
  // Plays a move now. bars: how long its knobs take. step: the 16th it counts from. Returns the
  // modules it touched.
  fire(group, move, { by = 'dj', bars = move.glide, odds, step } = {}) {
    const { graph, rig } = this;
    rig.held ??= {};
    const was = this.current(group);
    leaveMove(graph, rig.held[group.name]);
    const from = step ?? this.position() ?? 0;
    const length = (bars ?? 0) * 16;
    const gliding = (op) => length > 0 && op.op === 'set' && graph.nodes.has(op.id);
    const { log, ...held } = enterMove(graph, move, gliding);
    rig.held[group.name] = held;
    for (const op of move.ops) {
      if (!gliding(op)) continue;
      for (const [name, v] of Object.entries(op.params)) this.glideTo(op.id, 'params', name, v, from, length);
      for (const [name, v] of Object.entries(op.depth)) this.glideTo(op.id, 'depth', name, v, from, length);
    }
    if (was && was !== move.name) this.recent = [...this.recent, `${group.name}:${was}`].slice(-RECENT);
    const bar = this.played + 1;
    this.changedAt.set(group.name, bar);
    this.log = [...this.log, { bar, group: group.name, move: move.name, by, odds: odds?.[move.name] }].slice(-LOG);
    return [...held.nodes, ...move.ops.flatMap((op) => [op.id, op.to])].filter(Boolean);
  }

  glideTo(id, field, name, value, from, length) {
    const node = this.graph.nodes.get(id);
    const p = this.graph.def(node).params?.find((q) => q.name === name);
    const key = `${id}.${field}.${name}`;
    const was = field === 'depth' ? node.depth[name] ?? 0.5 : node.params[name];
    this.glides.delete(key);
    if (!p || p.type || was === value) { this.write(id, field, name, value); return; }
    this.glides.set(key, { id, field, name, from: was, to: value, p0: from, p1: from + length, step: p.step });
  }

  write(id, field, name, value) {
    if (field === 'depth') this.graph.setDepth(id, name, value);
    else this.graph.setParam(id, name, value);
  }

  stepGlides(pos) {
    for (const [key, g] of this.glides) {
      if (pos < g.p0 && pos > g.p0 - 32) continue;   // waiting for its downbeat
      // far before its start means the Clock started over: finish it
      const t = pos < g.p0 ? 1 : Math.min(1, (pos - g.p0) / (g.p1 - g.p0));
      const e = t * t * (3 - 2 * t);
      let v = g.from + (g.to - g.from) * e;
      if (g.step) v = Math.round(v / g.step) * g.step;
      this.write(g.id, g.field, g.name, t >= 1 ? g.to : v);
      if (t >= 1) this.glides.delete(key);
    }
  }

  finishGlides() {
    for (const g of this.glides.values()) this.write(g.id, g.field, g.name, g.to);
    this.glides.clear();
  }
}
