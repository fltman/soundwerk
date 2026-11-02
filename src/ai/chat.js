// The patch assistant: a chat panel that turns descriptions into patches.
// The browser runs the tool loop (it owns the graph); the server only relays to the model.
import { applyOps, describeBars, describeMark, describePatch, describeTransition } from './ops.js';
import { splitStems } from '../ui/files.js';
import { installEdit, installPlan, keepPlan, tryVersions } from '../ui/set.js';
import { planOf } from '../set/score.js';
import { NEEDED, WINDOW, addRound, describeTaste, newTaste, offerDue, scoreOf, transitionName, transitionsOf, untaught } from '../set/taste.js';

const STORE = 'soundwerk.chat.v1';
const TASTE = 'soundwerk.taste.v1';   // what hasn't reached the file on disk yet
const JSON_TYPE = { 'Content-Type': 'application/json' };
const MAX_ROUNDS = 14; // a rig takes several rounds: patch, moves, fixes
const MOST_KEPT = 400;  // characters of a tool call of an earlier turn, or of its answer
const LETTERS = 'ABC';
const WHY_PROMPT = 'Why that one? Write it here before you pick.';

// An earlier turn doesn't need its plans and renders again: the patch of this one has what's left of them
function shorter(m) {
  if (m.role === 'tool' && m.content.length > MOST_KEPT) return { ...m, content: `${m.content.slice(0, MOST_KEPT)}…` };
  if (!m.tool_calls) return m;
  return { ...m, tool_calls: m.tool_calls.map((c) => (c.function.arguments.length > MOST_KEPT ? { ...c, function: { ...c.function, arguments: '{"left_out":"sent in full at the time"}' } } : c)) };
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
// just enough markdown for chat: paragraphs, **bold**, `code`
function richText(s) {
  return escapeHtml(s.trim())
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

function smallButton(text, title, onClick) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: text, title });
  b.addEventListener('click', onClick);
  return b;
}

export class Chat {
  constructor({ graph, wall, host, dj, toast }) {
    Object.assign(this, { graph, wall, host, dj, toast });
    this.panel = document.getElementById('chat');
    this.log = document.getElementById('chat-log');
    this.input = document.getElementById('chat-input');
    this.sendBtn = document.getElementById('chat-send');
    this.markBox = document.getElementById('chat-mark');
    this.prompt = this.input.placeholder;
    this.history = [];   // what the model sees (OpenAI-style messages)
    this.items = [];     // what the panel shows
    this.refs = new Map(); // the names it gave modules, good for the whole conversation
    this.session = 0;    // New chat bumps this, so a late answer can't land in the new conversation
    this.busy = false;
    this.abort = null;
    this.round = null;   // an offer in front of the user
    this.clips = [];     // the sound of the latest offer
    this.taste = this.tasteHere();
    this.writing = Promise.resolve();
    this.tasteLoaded = this.loadTaste();

    document.getElementById('chat-form').addEventListener('submit', (e) => { e.preventDefault(); this.busy ? this.stop() : this.send(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!this.busy) this.send(); }
      if (e.key === 'Escape') this.input.blur();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.toggle(false); }
    });
    document.getElementById('chat-new').addEventListener('click', () => this.reset());
    document.getElementById('chat-close').addEventListener('click', () => this.toggle(false));
    document.getElementById('chat-unmark').addEventListener('click', () => this.setMark(null));
    this.restore();
  }

  toggle(open = this.panel.classList.contains('hidden')) {
    this.panel.classList.toggle('hidden', !open);
    document.getElementById('ai-btn').classList.toggle('active', open);
    this.wall.insetRight = open ? this.panel.offsetWidth : 0;
    if (open) setTimeout(() => this.input.focus(), 0);
  }

  // A stretch of the set marked on the wall goes with the next message, and the set restarts from it
  setMark(mark) {
    const con = this.dj.conductor;
    con.mark = mark;
    if (mark) con.cursor = mark.from * 16;
    this.markBox.classList.toggle('hidden', !mark);
    this.markBox.firstElementChild.textContent = mark ? `Bars ${mark.from}–${mark.to} go with your message` : '';
    this.input.placeholder = mark ? 'What is wrong here, and what should it do instead?' : this.prompt;
    if (mark) this.toggle(true);
  }

  // ── conversation ──────────────────────────────────────
  context() {
    const clock = [...this.graph.nodes.values()].find((n) => n.type === 'clock'), con = this.dj.conductor;
    const head = `[Patch right now — ${this.host.running ? 'playing' : 'stopped'}${clock ? `, ${clock.params.bpm.toFixed(1)} BPM` : ', no clock'}${con.running ? `, the set on bar ${Math.floor(con.step / 16)}: the wall is as that bar left it, and goes back when the set stops` : ''}]`;
    const { rig } = this.graph;
    const moves = rig ? `\nThe rig in full: ${JSON.stringify(rig, (k, v) => (k === 'test' || k === 'held' || k === 'print' ? undefined : v))}` : '';
    const plan = planOf([...this.graph.nodes.values()].find((n) => n.type === 'set'));
    const taught = describeTaste(this.taste);
    return `${head}\n${describePatch(this.graph, { selected: [...this.wall.selected], pools: true })}${moves}${plan ? `\nThe plan of the set in full: ${JSON.stringify(plan, (k, v) => (k === 'home' ? undefined : v))}` : ''}${taught ? `\n\n${taught}` : ''}`;
  }

  // shown: what the panel says the user said, if not this. quick: not worth the thought of a whole set.
  async send(text = this.input.value.trim(), { shown, quick = false } = {}) {
    if (!text || this.busy) return;
    const session = this.session;
    const gone = () => session !== this.session;
    const { mark, plan, tracks } = this.dj.conductor;
    this.input.value = '';
    const marked = !!(mark && plan);
    this.mending = marked || quick;
    this.offered = false;
    this.history.push({ role: 'user', content: `${marked ? `${describeMark(plan, tracks, mark)}\n\n` : ''}${text}`, context: this.context() });
    this.add({ kind: 'user', text: shown ?? (mark ? `Bars ${mark.from}–${mark.to}: ${text}` : text) });
    this.setMark(null);
    this.setBusy(true);
    try {
      let round = 0;
      const most = this.auto ? MAX_ROUNDS * 3 : MAX_ROUNDS;   // the rest of a set takes a round each
      for (; round < most; round++) {
        const res = await this.request();
        if (gone()) return;
        if (!res) break;
        const msg = res.message;
        this.history.push(msg);
        // what comes with an offer could give away the prediction
        if (msg.content?.trim() && !msg.tool_calls?.some((c) => c.function.name === 'offer_transition' && !this.auto)) this.add({ kind: 'assistant', text: msg.content });
        if (res.finish === 'length') this.add({ kind: 'error', text: 'The answer was cut off (too long).' });
        if (!msg.tool_calls?.length) break;
        const images = [];
        for (const call of msg.tool_calls) {
          const result = await this.runTool(call, images, gone);
          if (gone()) return;
          this.history.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        if (images.length) {
          this.history.push({ role: 'user', content: [{ type: 'text', text: 'Spectrogram of that render (time across, 25 Hz to 20 kHz up, brighter is louder):' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
        }
        if (this.stopped || this.offered) break;   // an offer waits for the user, not the model
      }
      if (round === most) this.add({ kind: 'error', text: `Stopped after ${most} rounds of edits. Ask it to carry on if it wasn't finished.` });
    } catch (e) {
      if (gone()) return;
      if (e.name !== 'AbortError') this.add({ kind: 'error', text: e.message });
    }
    this.setBusy(false);
    this.save();
  }

  // What the model reads: the patch as it is now and not all the ones before it, whole tool calls
  // for this turn only, and the spectrograms of this turn with the latest one before it. What came
  // before this turn stops changing here, which keeps it cached and this turn's thinking valid.
  outgoing() {
    const pictured = (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
    const turn = this.history.findLastIndex((m) => m.role === 'user' && typeof m.content === 'string'), picture = this.history.slice(0, turn).findLast(pictured);
    return this.history.map(({ context, ...m }, i) => {
      if (i >= turn) return i === turn && context ? { ...m, content: `${context}\n\n${m.content}` } : m;
      if (pictured(m) && this.history[i] !== picture) return { role: m.role, content: '[an earlier spectrogram]' };
      const { blocks, ...rest } = m;
      return shorter(rest);
    });
  }

  async request() {
    this.abort = new AbortController();
    this.status(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // a playlist on the wall means a set to compose, worth more thought than a patch or a fix
        body: JSON.stringify({ messages: this.outgoing(), effort: !this.mending && [...this.graph.nodes.values()].some((n) => n.data?.tracks?.length) ? 'medium' : 'low' }),
        signal: this.abort.signal,
      });
      const json = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      this.spent = (this.spent ?? 0) + (json.usage?.cost ?? 0);
      return json;
    } finally {
      this.status(false);
    }
  }

  async runTool(call, images, gone) {
    let args = {};
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return 'The arguments were not valid JSON, send them again.'; }
    if (call.function.name === 'edit_patch') {
      const g = this.graph;
      const r = applyOps(g, args.operations, this.refs);
      g.commit();
      for (const id of r.touched) this.wall.refreshNode(id);
      if (r.added.length || r.cleared) this.wall.frameAll();
      this.add({ kind: 'ops', lines: r.log });
      return `${r.log.join('\n')}\n\nPatch now:\n${describePatch(g, { selected: [...this.wall.selected] })}`;
    }
    if (call.function.name === 'set_rig') {
      // a tool call must always get an answer, or the whole conversation is refused from then on
      const r = await this.dj.install(args).catch((e) => ({ saved: false, lines: [`✗ ${e.message}`] }));
      if (gone()) return '';
      this.add({ kind: 'ops', lines: r.lines });
      if (!r.saved) return `The rig was not saved. Fix these and send it again:\n${r.lines.join('\n')}`;
      const failed = r.lines.some((l) => l.startsWith('✗'));
      return `The rig is saved and every move was rendered. Levels are against home.\n${r.lines.join('\n')}\n\n${failed ? 'The DJ will not play the moves marked ✗. Fix them and send the whole rig again.' : 'All moves passed.'}`;
    }
    if (call.function.name === 'set_plan' || call.function.name === 'edit_plan') {
      // a plan is made from the wall at home, not from where a running set has it
      const con = this.dj.conductor, edit = call.function.name === 'edit_plan';
      con.stop(`The plan is changing, so the set stopped. ▶ SET plays it from bar ${con.cursor / 16}`);
      const r = await (edit ? installEdit(this.graph, args) : installPlan(this.graph, args, args.draft ? { only: { from: 0, to: 0 } } : undefined)).catch((e) => ({ saved: false, lines: [`✗ ${e.message}`] }));
      if (gone()) return '';
      if (args.draft && r.saved) return 'The draft is saved, and nothing was rendered.';
      this.add({ kind: 'ops', lines: r.lines });
      if (!r.saved) return `The plan was not saved. Fix these and send it again:\n${r.lines.join('\n')}`;
      const head = edit ? `The plan is changed. What touches bars ${r.only.from}-${r.only.to} was rendered again, and everything else stands as it was.` : 'The plan is saved, and every way in and out of a track was rendered.';
      const left = r.left?.length ? `\nStill marked ✗ from before, in bars that weren't rendered again: ${r.left.map((f) => `${f.what}, bars ${f.from}-${f.to}`).join('; ')}.` : '';
      const now = edit ? `\n\nThose bars now:\n${describeBars(r.plan, this.dj.conductor.tracks, r.only)}` : '';
      const failed = r.lines.some((l) => l.startsWith('✗'));
      return `${head}\n${r.lines.join('\n')}${left}${now}\n\n${failed ? `Fix what is marked ✗ and send it again${edit ? ' with edit_plan' : ' as the whole plan'}. If you meant a ✗ (a bar of silence before a drop, say), it can stand: tell the user why.` : 'Nothing failed. Read the numbers: whether they are what you wanted is yours to judge.'}`;
    }
    if (call.function.name === 'offer_transition') return this.offer(args, gone);
    if (call.function.name === 'split_stems') {
      try {
        const { made, skipped, seconds } = await splitStems(this.host, this.graph, args.id, this.toast);
        if (gone()) return '';
        this.wall.frameAll();
        this.add({ kind: 'ops', lines: [`✓ ${made.map((m) => `${m.stem} → ${m.id}`).join(', ')} (${seconds} s)`] });
        return `Separated. New Slicers, already on the clock, not yet patched to anything: ${made.map((m) => `${m.id} ${m.stem}`).join(', ')}.${skipped.length ? ` Nothing was in ${skipped.join(', ')}.` : ''}\n\n${describePatch(this.graph, { pools: true })}`;
      } catch (e) {
        return `Could not separate it: ${e.message}`;
      }
    }
    if (['list_plugins', 'load_plugin', 'print_plugin'].includes(call.function.name)) {
      try { return await this.plugin(call.function.name, args); } catch (e) { return `That didn't work: ${e.message}`; }
    }
    if (call.function.name === 'listen') {
      try {
        const { stats, url } = await this.listen(args.bars);
        if (gone()) return '';
        images.push(url);
        this.add({ kind: 'listen', url });
        return `Rendered ${stats.bars} bars. ${JSON.stringify(stats)}\nThe spectrogram follows in the next message.`;
      } catch (e) {
        return `Could not render: ${e.message}`;
      }
    }
    return `Unknown tool ${call.function.name}`;
  }

  // a render in a worker: the wall keeps playing while the assistant listens
  async plugin(tool, { id, plugin }) {
    const plugins = this.host.plugins;
    if (tool === 'print_plugin') {
      const { id: into, file } = await plugins.print(id, this.toast);
      this.add({ kind: 'ops', lines: [`✓ ${file}`] });
      return `Printed into ${into}, now called "${file}". ${id} is bypassed.`;
    }
    const { installed: ready, plugins: found } = await plugins.installed();
    if (!ready) return 'The plugin helper isn\'t installed: the user has to run npm run vst:setup.';
    if (tool === 'list_plugins') return found.length ? found.map((p) => `${p.path} (${p.name}, ${p.format})`).join('\n') : 'There are no plugins on this computer.';
    const chosen = found.find((p) => p.path === plugin);
    if (!chosen) return `${plugin} isn't installed.`;
    plugins.load(id, chosen.path, chosen.name);
    this.add({ kind: 'ops', lines: [`✓ ${chosen.name} on ${id}`] });
    return `${chosen.name} is on ${id}.`;
  }

  listen(bars = 4) {
    const patch = this.graph.toJSON();
    const bpm = patch.nodes.find((n) => n.type === 'clock')?.params?.bpm ?? 130;
    const count = Math.max(2, Math.min(16, Math.round(bars)));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../listen/worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        worker.terminate();
        if (e.data.error) reject(new Error(e.data.error));
        else resolve({ stats: { bars: count, ...e.data.stats }, url: e.data.url });
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
      worker.postMessage({ patch, seconds: (count * 240) / bpm, buffers: Object.fromEntries(this.host.buffers) });
    });
  }

  // ── one transition at a time ──────────────────────────
  tasteHere() {
    try { return { ...newTaste(), ...JSON.parse(localStorage.getItem(TASTE)) }; } catch { return newTaste(); }
  }

  keepHere(taste) {
    try { localStorage.setItem(TASTE, JSON.stringify(taste)); } catch { /* storage full: forget it */ }
  }

  // The file is the memory. This browser only holds what never got there: everything from before
  // there was a file, or what was learned while the server was away.
  async loadTaste() {
    const res = await fetch('/api/taste', { headers: JSON_TYPE }).catch(() => null);
    if (!res) return;
    if (!res.ok) {
      this.fileBroken = true;   // a file someone edited by hand isn't ours to write over
      this.toast((await res.json()).error);
      return;
    }
    const file = { ...newTaste(), ...(await res.json()) };
    if (this.taste.rounds.length > file.rounds.length) this.learned(this.taste);
    else this.taste = file;
  }

  learned(taste) {
    this.taste = taste;
    if (this.fileBroken) { this.keepHere(taste); return; }
    this.writing = this.writing.then(async () => {
      const res = await fetch('/api/taste', { method: 'PUT', headers: JSON_TYPE, body: JSON.stringify(taste) }).catch(() => null);
      if (res?.ok) localStorage.removeItem(TASTE);
      else { this.keepHere(taste); this.toast('Could not save what was learned to disk: it stays in this browser for now'); }
    });
  }

  teach() {
    this.toggle(true);
    if (this.busy || this.round) return;
    const con = this.dj.conductor;
    if (!con.plan) { this.send('[Teach: there is no plan yet. Make a draft with set_plan, then offer the first transition.]', { shown: 'Teach me, one transition at a time' }); return; }
    if (!untaught(con.plan).length) keepPlan(this.graph, { ...con.plan, taught: [] });
    if (offerDue(this.taste)) { this.offerTheRest(); return; }
    const next = untaught(con.plan)[0];
    this.send(`[Teach]\n\n${describeTransition(con.plan, con.tracks, next)}`, { shown: 'Teach me, one transition at a time', quick: true });
  }

  // Versions of a transition, all rendered and none kept. Handing them over shuffled means where a
  // version stands says nothing, and the prediction stays out of sight until the pick.
  async offer(args, gone) {
    const con = this.dj.conductor, { plan, tracks } = con;
    if (!plan) return 'There is no plan yet: make a draft with set_plan first.';
    const t = transitionsOf(plan).find((x) => x.leg === args.leg && x.side === args.side);
    if (!t) return `There is no way ${args.side} of tracks[${args.leg}]. Legs run from 0 to ${plan.tracks.length - 1}.`;
    const how = this.auto ? 1 : 3, options = Array.isArray(args.options) ? args.options : [];
    if (options.length !== how) return `Nothing was offered: send ${how} ${how === 1 ? 'option' : 'options'}, not ${options.length}.`;
    if (!options[args.best]) return `Nothing was offered: best is 0 to ${how - 1}, the option you predict.`;
    if (options.some((o) => !o.title?.trim() || !o.idea?.trim())) return 'Nothing was offered: every option needs a title and an idea.';
    con.stop(`The plan is changing, so the set stopped. ▶ SET plays it from bar ${con.cursor / 16}`);
    this.status(true, how === 1 ? 'Rendering' : 'Rendering all three');
    const tried = await tryVersions(this.graph, { remove: args.remove, options }, t.bar).catch((e) => options.map(() => ({ saved: false, lines: [`✗ ${e.message}`] })));
    this.status(false);
    if (gone()) return '';
    const report = tried.map((r, i) => `Option ${i}, ${options[i].title}:\n${r.lines.join('\n')}`).join('\n\n');
    if (tried.some((r) => !r.saved)) return `Nothing was offered. Fix these and send it again:\n${report}`;
    const marked = (r) => r.lines.some((l) => l.startsWith('✗'));
    // once: a ✗ the assistant means can stand, and the user is told about it on the version
    if (tried.some(marked) && this.warned !== t.key) { this.warned = t.key; return `Nothing was offered yet. A version has a ✗: fix it and send all of them again, or send them as they are if you meant it.\n${report}`; }
    if (Array.isArray(args.notes)) this.learned({ ...this.taste, notes: args.notes.map(String) });
    if (this.auto) {
      const left = untaught(this.keep(t, tried[0].plan));
      this.add({ kind: 'ops', lines: [`✓ ${transitionName(t, tracks)}: ${options[0].title}`] });
      return `Kept. ${left.length ? `Next:\n\n${describeTransition(this.dj.conductor.plan, tracks, left[0])}` : 'That was the last one. Tell the user what you made, in a few sentences.'}\n\nWhat was measured:\n${report}`;
    }
    this.show({ t, args, tried });
    this.offered = true;
    return 'The user has the three versions in front of them. Your turn is over: their pick comes in the next message.';
  }

  show({ t, args, tried }) {
    this.closeRound('A new offer took its place.');
    this.log.querySelectorAll('.offer-version audio').forEach((a) => a.remove());
    this.clips.forEach((url) => URL.revokeObjectURL(url));
    const order = [0, 1, 2];
    for (let i = 2; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [order[i], order[k]] = [order[k], order[i]]; }
    this.clips = order.map((k) => URL.createObjectURL(tried[k].wav));
    const { plan, tracks } = this.dj.conductor, done = plan.taught?.length ?? 0, all = transitionsOf(plan).length;
    const versions = order.map((k) => ({ title: args.options[k].title, idea: args.options[k].idea, flagged: tried[k].problems.join('; ') }));
    this.round = { t, args, tried, order, peeked: false };
    const name = transitionName(t, tracks);
    this.add({ kind: 'offer', heading: `${name[0].toUpperCase()}${name.slice(1)}, bar ${t.bar} · ${done + 1} of ${all}`, versions, said: '', live: this.round });
    this.input.placeholder = WHY_PROMPT;
  }

  keep(t, plan) {
    const kept = { ...plan, taught: [...new Set([...(plan.taught ?? []), t.key])] };
    keepPlan(this.graph, kept);
    this.dj.conductor.cursor = Math.max(0, t.bar - 8) * 16;
    return kept;
  }

  // Looking first means the score can't count this one
  peek() {
    const r = this.round;
    if (!r) return;
    r.peeked = true;
    this.say(r, `I think you'll pick ${LETTERS[r.order.indexOf(r.args.best)]}: ${r.args.why} This one won't count towards the score, because you looked first.`);
  }

  card(round) { return this.items.find((i) => i.live === round); }

  say(round, text) {
    const item = this.card(round);
    if (!item) return;
    item.said = text;
    item.el.querySelector('.offer-said').textContent = text;
    this.save();
  }

  closeRound(text) {
    const r = this.round, item = r && this.card(r);
    this.round = null;
    this.input.placeholder = this.prompt;
    if (!item) return;
    item.said = text;
    item.el.querySelector('.offer-said').textContent = text;
    item.live = null;
    item.el.querySelectorAll('button').forEach((b) => b.remove());
    this.save();
  }

  // index: where the version stood on the panel, or null for none of them
  pick(index) {
    const r = this.round, con = this.dj.conductor;
    if (!r || this.busy || r.done) return;
    const { t, args, tried, order, peeked } = r, item = this.card(r), chosen = index === null ? null : order[index];
    Object.assign(r, { done: true, chosen, index, why: this.input.value.trim(), plan: chosen === null ? con.plan : this.keep(t, tried[chosen].plan) });
    this.input.value = '';
    item.el.querySelectorAll('.offer-version')[index]?.classList.add('offer-picked');
    item.el.querySelectorAll('.offer-version button').forEach((b) => b.remove());
    if (chosen === null || chosen === args.best || peeked) { this.settle(r, false); return; }
    // a miss: what counts is whether it could have done this one alone
    const best = LETTERS[order.indexOf(args.best)];
    this.say(r, `I thought you'd pick ${best}: ${args.why} Would ${best} have been fine too?`);
    item.el.querySelector('.offer-foot').replaceChildren(smallButton('Yes, fine', 'It wasn\'t your pick, but you could have lived with it', () => this.settle(r, true)), smallButton('No', 'It would have been wrong here', () => this.settle(r, false)));
  }

  settle(r, fine) {
    const { t, args, order, chosen, index, why, peeked, plan } = r, { tracks } = this.dj.conductor;
    const name = transitionName(t, tracks), best = LETTERS[order.indexOf(args.best)];
    this.learned(addRound(this.taste, { transition: name, options: args.options.map(({ title, idea }) => ({ title, idea })), best: args.best, pick: chosen, why, ...(fine ? { fine } : {}), ...(peeked ? { peeked } : {}) }));
    const { hits, count } = scoreOf(this.taste);
    const score = count ? `We agree on ${hits} of the last ${count}${count < WINDOW ? `, and it takes ${NEEDED} of ${WINDOW}` : ''}.` : `No pick has counted yet: it takes ${NEEDED} of ${WINDOW} made without looking at the recommendation.`;
    const verdict = chosen === args.best ? `I thought you'd pick ${best} too: ${args.why}` : `I thought you'd pick ${best}${fine ? ', which you say would have been fine' : ''}: ${args.why}`;
    this.closeRound(`${verdict}${peeked ? ' This one doesn\'t count, because you looked first.' : ''} ${score}`);
    const saying = why ? ` They said: ${why}` : ' They gave no reason.';
    if (chosen === null) {
      this.send(`[None of them: they turned down all three versions of ${name}. You predicted option ${args.best}.${saying}]\n\nThree new ideas for it.\n\n${describeTransition(plan, tracks, t)}`, { shown: `None of them${why ? `: ${why}` : ''}`, quick: true });
      return;
    }
    const left = untaught(plan), shown = `${LETTERS[index]}: ${args.options[chosen].title}${why ? `. ${why}` : ''}`;
    if (left.length && !offerDue(this.taste)) {
      const told = chosen === args.best ? ', and you were right' : fine ? ', and they say that one would have been fine too' : ', and that one would not have done';
      this.send(`[Picked: your option ${chosen}. You predicted option ${args.best}${told}.${saying}]\n\n${describeTransition(plan, tracks, left[0])}`, { shown, quick: true });
      return;
    }
    this.add({ kind: 'user', text: shown });
    if (left.length) this.offerTheRest();
    else this.add({ kind: 'assistant', text: 'That was the last transition of this set. ▶ SET plays it from just before this one.' });
    this.save();
  }

  offerTheRest() {
    const { hits, count } = scoreOf(this.taste), left = untaught(this.dj.conductor.plan).length;
    this.add({ kind: 'trust', open: true, text: `On ${hits} of the last ${count}, what I recommended was your pick or would have been fine by you, so I think I know what you like. Shall I make the ${left} transition${left === 1 ? '' : 's'} left myself?` });
  }

  async doTheRest() {
    const { plan, tracks } = this.dj.conductor;
    this.auto = true;
    await this.send(`[Do the rest: they trust you with the transitions that are left. One version of each, one at a time.]\n\n${describeTransition(plan, tracks, untaught(plan)[0])}`, { shown: 'Do the rest', quick: true });
    this.auto = false;
  }

  keepTeaching() {
    this.learned({ ...this.taste, declined: this.taste.rounds.length });
    this.teach();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  setBusy(on) {
    this.busy = on;
    this.stopped = false;
    this.sendBtn.textContent = on ? 'Stop' : 'Send';
    this.panel.classList.toggle('busy', on);
  }

  status(on, doing = 'Thinking') {
    clearInterval(this.timer);
    this.statusEl?.remove();
    this.statusEl = null;
    if (!on) return;
    const el = document.createElement('div');
    el.className = 'chat-status';
    const t0 = performance.now();
    const tick = () => { el.textContent = `${doing}… ${Math.round((performance.now() - t0) / 1000)} s`; };
    tick();
    this.timer = setInterval(tick, 500);
    this.log.append(el);
    this.statusEl = el;
    this.scroll();
  }

  // ── display ───────────────────────────────────────────
  add(item, persist = true) {
    if (persist) this.items.push(item);
    const el = document.createElement('div');
    el.className = `chat-item ${item.kind}`;
    if (item.kind === 'user' || item.kind === 'error') el.textContent = item.text;
    else if (item.kind === 'assistant') el.innerHTML = richText(item.text);
    else if (item.kind === 'ops') {
      const lines = item.lines;
      const shown = lines.length > 10 ? [...lines.slice(0, 9), `… ${lines.length - 9} more`] : lines;
      for (const l of shown) {
        const d = document.createElement('div');
        d.className = l.startsWith('✗') ? 'bad' : '';
        d.textContent = l;
        el.append(d);
      }
    } else if (item.kind === 'listen') {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = 'What the assistant measured';
      el.append(img);
    } else if (item.kind === 'offer') this.offerCard(el, item);
    else if (item.kind === 'trust') this.trustCard(el, item);
    if (this.statusEl) this.log.insertBefore(el, this.statusEl);
    else this.log.append(el);
    this.scroll();
  }

  // Started on another version, a player carries on from the same moment, to compare the same bars
  offerCard(el, item) {
    item.el = el;
    const part = (tag, cls, text) => { const x = document.createElement(tag); x.className = cls; x.textContent = text; return x; };
    let playing = null;
    el.append(part('div', 'offer-head', item.heading));
    item.versions.forEach((v, i) => {
      const row = part('div', 'offer-version', '');
      const head = part('div', '', '');
      head.append(part('b', '', LETTERS[i]), v.title);
      row.append(head, part('p', '', v.idea));
      if (v.flagged) row.append(part('p', 'offer-flag', `The render flagged: ${v.flagged}`));
      if (item.live) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = this.clips[i];
        audio.addEventListener('play', () => {
          this.dj.conductor.stop();
          if (this.host.running) this.host.setRunning(false);
          if (playing && playing !== audio) { audio.currentTime = playing.currentTime; playing.pause(); }
          playing = audio;
        });
        row.append(audio, smallButton(`Pick ${LETTERS[i]}`, 'Keep this version', () => this.pick(i)));
      }
      el.append(row);
    });
    if (item.live) {
      const foot = part('div', 'offer-foot', '');
      foot.append(smallButton('None of them', 'Three new ideas for this transition', () => this.pick(null)));
      foot.append(smallButton('Show the recommendation', 'Sealed until you pick, so the score measures the prediction and not whether you followed it. Looking means this one doesn\'t count', () => this.peek()));
      el.append(foot);
    }
    el.append(part('div', 'offer-said', item.said || (item.live ? '' : 'The page was reloaded before a pick. TEACH offers this one again.')));
  }

  trustCard(el, item) {
    el.append(Object.assign(document.createElement('div'), { textContent: item.text }));
    if (!item.open) return;
    const foot = document.createElement('div');
    foot.className = 'offer-foot';
    const button = (text, title, fn) => smallButton(text, title, () => { foot.remove(); item.open = false; fn(); });
    foot.append(button('Do the rest', 'It makes each one that is left, and you can mark and fix them afterwards', () => this.doTheRest()), button('Keep teaching', 'Three versions of the next one, and it won\'t ask again for a while', () => this.keepTeaching()));
    el.append(foot);
  }

  scroll() { this.log.scrollTop = this.log.scrollHeight; }

  greet() {
    this.add({
      kind: 'assistant',
      text: 'Describe what you want to hear and I\'ll patch it, for example **"a squelchy acid line in F over a driving kick at 138"** or **"dub chords drowning in tape echo"**. I know every module and how they connect, and I measure what I build, though I can\'t hear it. ⌘Z undoes my last change.',
    }, false);
  }

  reset() {
    this.stop();
    this.session++;
    this.setBusy(false);
    this.closeRound('');
    this.history = [];
    this.items = [];
    this.refs.clear();
    this.log.replaceChildren();
    this.greet();
    this.save();
  }

  save() {
    // spectrograms are big; keep the text of the conversation only
    const strip = ({ context, blocks, ...m }) => (Array.isArray(m.content) ? { ...m, content: '[a spectrogram]' } : m);
    const items = this.items.filter((i) => i.kind !== 'listen').map(({ live, el, open, ...i }) => i);
    try {
      localStorage.setItem(STORE, JSON.stringify({ history: this.history.map(strip), items }));
    } catch { /* storage full: forget it */ }
  }

  restore() {
    this.greet();
    try {
      const s = JSON.parse(localStorage.getItem(STORE));
      if (!s?.history?.length) return;
      // a conversation cut off mid tool-call can't be resumed: drop the dangling tail
      let h = s.history;
      while (h.length && h[h.length - 1].role === 'assistant' && h[h.length - 1].tool_calls) h = h.slice(0, -1);
      this.history = h;
      this.items = s.items ?? [];
      for (const item of this.items) this.add(item, false);
    } catch { /* ignore */ }
  }
}
