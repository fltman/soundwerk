// The patch assistant: a chat panel that turns descriptions into patches.
// The browser runs the tool loop (it owns the graph); the server only relays to the model.
import { applyOps, describePatch } from './ops.js';

const STORE = 'soundwerk.chat.v1';
const MAX_ROUNDS = 14; // a rig takes several rounds: patch, moves, fixes

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

export class Chat {
  constructor({ graph, wall, host, dj, toast }) {
    Object.assign(this, { graph, wall, host, dj, toast });
    this.panel = document.getElementById('chat');
    this.log = document.getElementById('chat-log');
    this.input = document.getElementById('chat-input');
    this.sendBtn = document.getElementById('chat-send');
    this.history = [];   // what the model sees (OpenAI-style messages)
    this.items = [];     // what the panel shows
    this.refs = new Map(); // the names it gave modules, good for the whole conversation
    this.session = 0;    // New chat bumps this, so a late answer can't land in the new conversation
    this.busy = false;
    this.abort = null;

    document.getElementById('chat-form').addEventListener('submit', (e) => { e.preventDefault(); this.busy ? this.stop() : this.send(); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!this.busy) this.send(); }
      if (e.key === 'Escape') this.input.blur();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.toggle(false); }
    });
    document.getElementById('chat-new').addEventListener('click', () => this.reset());
    document.getElementById('chat-close').addEventListener('click', () => this.toggle(false));
    this.restore();
  }

  toggle(open = this.panel.classList.contains('hidden')) {
    this.panel.classList.toggle('hidden', !open);
    document.getElementById('ai-btn').classList.toggle('active', open);
    this.wall.insetRight = open ? this.panel.offsetWidth : 0;
    if (open) setTimeout(() => this.input.focus(), 0);
  }

  // ── conversation ──────────────────────────────────────
  context() {
    const clock = [...this.graph.nodes.values()].find((n) => n.type === 'clock');
    const head = `[Patch right now — ${this.host.running ? 'playing' : 'stopped'}${clock ? `, ${clock.params.bpm.toFixed(1)} BPM` : ', no clock'}]`;
    const { rig } = this.graph;
    const moves = rig ? `\nThe rig in full: ${JSON.stringify(rig, (k, v) => (k === 'test' || k === 'held' || k === 'print' ? undefined : v))}` : '';
    return `${head}\n${describePatch(this.graph, { selected: [...this.wall.selected] })}${moves}`;
  }

  async send(text = this.input.value.trim()) {
    if (!text || this.busy) return;
    const session = this.session;
    const gone = () => session !== this.session;
    this.input.value = '';
    this.history.push({ role: 'user', content: `${this.context()}\n\n${text}` });
    this.add({ kind: 'user', text });
    this.setBusy(true);
    try {
      let round = 0;
      for (; round < MAX_ROUNDS; round++) {
        const res = await this.request();
        if (gone()) return;
        if (!res) break;
        const msg = res.message;
        this.history.push(msg);
        if (msg.content?.trim()) this.add({ kind: 'assistant', text: msg.content });
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
        if (this.stopped) break;
      }
      if (round === MAX_ROUNDS) this.add({ kind: 'error', text: `Stopped after ${MAX_ROUNDS} rounds of edits. Ask it to carry on if it wasn't finished.` });
    } catch (e) {
      if (gone()) return;
      if (e.name !== 'AbortError') this.add({ kind: 'error', text: e.message });
    }
    this.setBusy(false);
    this.save();
  }

  // older spectrograms are dropped from what we resend, only the latest picture matters
  outgoing() {
    let seen = 0;
    return [...this.history].reverse().map((m) => {
      if (!Array.isArray(m.content) || !m.content.some((p) => p.type === 'image_url')) return m;
      if (seen++ === 0) return m;
      return { role: m.role, content: '[an earlier spectrogram]' };
    }).reverse();
  }

  async request() {
    this.abort = new AbortController();
    this.status(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.outgoing() }),
        signal: this.abort.signal,
      });
      const json = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
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
      const r = await this.dj.install(args);
      if (gone()) return '';
      this.add({ kind: 'ops', lines: r.lines });
      if (!r.saved) return `The rig was not saved. Fix these and send it again:\n${r.lines.join('\n')}`;
      const failed = r.lines.some((l) => l.startsWith('✗'));
      return `The rig is saved and every move was rendered. Levels are against home.\n${r.lines.join('\n')}\n\n${failed ? 'The DJ will not play the moves marked ✗. Fix them and send the whole rig again.' : 'All moves passed.'}`;
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
      worker.postMessage({ patch, seconds: (count * 240) / bpm });
    });
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

  status(on) {
    clearInterval(this.timer);
    this.statusEl?.remove();
    this.statusEl = null;
    if (!on) return;
    const el = document.createElement('div');
    el.className = 'chat-status';
    const t0 = performance.now();
    const tick = () => { el.textContent = `Thinking… ${Math.round((performance.now() - t0) / 1000)} s`; };
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
    }
    if (this.statusEl) this.log.insertBefore(el, this.statusEl);
    else this.log.append(el);
    this.scroll();
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
    this.history = [];
    this.items = [];
    this.refs.clear();
    this.log.replaceChildren();
    this.greet();
    this.save();
  }

  save() {
    // spectrograms are big; keep the text of the conversation only
    const strip = (m) => (Array.isArray(m.content) ? { ...m, content: '[a spectrogram]' } : m);
    const items = this.items.filter((i) => i.kind !== 'listen');
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
