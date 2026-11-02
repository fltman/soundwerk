// The DJ panel: every group of the rig as a row of pads. The lit pad is playing, the blinking one
// lands on the next downbeat, the bar under a pad is what the model thought of it, and a struck-out
// pad failed its test. Click a pad to play it yourself.

const DARING_KEY = 'soundwerk.daring.v1';
const DRAG = 160;   // pixels for the whole sweep

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class DJPanel {
  constructor({ dj, graph, chat, wall }) {
    Object.assign(this, { dj, graph, chat, wall });
    this.panel = document.getElementById('dj');
    this.rows = document.getElementById('dj-groups');
    this.status = document.getElementById('dj-status');
    this.meta = document.getElementById('dj-meta');
    this.startBtn = document.getElementById('dj-start');
    this.btn = document.getElementById('dj-btn');
    this.pads = new Map();
    this.btn.onclick = () => this.toggle();
    document.getElementById('dj-close').onclick = () => this.toggle(false);
    document.getElementById('dj-build').onclick = () => this.build();
    this.startBtn.onclick = () => (dj.running ? dj.stop() : dj.start());
    this.knob();
    dj.addEventListener('update', () => this.refresh());
    graph.addEventListener('change', (e) => { if (e.detail.kind === 'rig' || e.detail.kind === 'load') this.render(); });
    this.render();
  }

  // Like the knobs on the wall: drag up or right, double-click for the middle, arrows when focused.
  // A setting of the performance, not the patch, so it stays when the patch changes and undo leaves it.
  knob() {
    const { dj } = this;
    const knob = document.getElementById('dj-daring'), value = document.getElementById('dj-daring-value');
    const show = () => {
      const pct = Math.round(dj.daring * 100);
      knob.style.setProperty('--v', dj.daring);
      knob.setAttribute('aria-valuenow', pct);
      value.textContent = dj.daring <= 0.25 ? 'safe' : dj.daring >= 0.75 ? 'daring' : `${pct} %`;
    };
    const set = (v) => {
      dj.daring = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
      localStorage.setItem(DARING_KEY, dj.daring);
      show();
    };
    const saved = parseFloat(localStorage.getItem(DARING_KEY));
    if (Number.isFinite(saved)) dj.daring = saved;
    show();
    let drag = null;
    knob.addEventListener('pointerdown', (e) => {
      knob.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, v: dj.daring };
    });
    knob.addEventListener('pointermove', (e) => {
      if (drag) set(drag.v + ((e.clientX - drag.x) + (drag.y - e.clientY)) / (e.shiftKey ? DRAG * 4 : DRAG));
    });
    knob.addEventListener('pointerup', () => { drag = null; });
    knob.addEventListener('dblclick', () => set(0.5));
    knob.addEventListener('keydown', (e) => {
      const step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05 }[e.key];
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();   // on the wall the arrows pan
      set(dj.daring + step);
    });
  }

  toggle(open = this.panel.classList.contains('hidden')) {
    this.panel.classList.toggle('hidden', !open);
    this.btn.classList.toggle('active', open);
    this.wall.insetBottom = open ? this.panel.offsetHeight : 0;
    this.wall.glide();
    this.wall.frameAll();
  }

  // leaves the request in the chat box, so you can say what kind of set it should be
  build() {
    this.chat.toggle(true);
    this.chat.input.value = 'Build a live DJ rig for this patch. ';
    this.chat.input.focus();
  }

  render() {
    this.rows.replaceChildren();
    this.pads.clear();
    const { rig } = this.graph;
    this.startBtn.disabled = !rig;
    if (!rig) this.rows.append(el('div', 'dj-empty', 'No rig on this patch. Ask the assistant to build one, or load the example “Acid wall”.'));
    for (const g of rig?.groups ?? []) {
      const row = el('div', 'dj-row');
      const head = el('div', 'dj-group', g.name);
      head.title = g.question;
      row.append(head);
      for (const m of g.moves) {
        const pad = el('button', 'dj-pad', m.name);
        pad.title = [m.description, m.test?.ok === false ? `Failed its test: ${m.test.why}` : m.test?.measured].filter(Boolean).join('\n');
        pad.classList.toggle('bad', m.test?.ok === false);
        pad.onclick = () => this.dj.queue(g.name, m.name);
        const odds = el('i');
        pad.append(odds);
        row.append(pad);
        this.pads.set(`${g.name}/${m.name}`, { pad, odds, group: g.name, move: m.name });
      }
      this.rows.append(row);
    }
    this.refresh();
  }

  line() {
    const { dj } = this;
    if (!dj.running || dj.played < 0) return dj.message;
    const s = dj.section(dj.played);
    const last = dj.log.at(-1);
    return [
      `bar ${dj.played + 1}`,
      `${s.name}, ${s.left} left → ${s.next}`,
      dj.testing ? `testing moves ${dj.testing.done}/${dj.testing.total}` : '',
      dj.message || (last && last.by !== 'start' ? `${last.group}: ${last.move}` : ''),
    ].filter(Boolean).join(' · ');
  }

  refresh() {
    const { dj } = this;
    this.startBtn.textContent = dj.running ? 'Stop' : 'Start';
    this.startBtn.classList.toggle('accent', !dj.running);
    this.btn.classList.toggle('live', dj.running);
    for (const { pad, odds, group, move } of this.pads.values()) {
      const g = dj.group(group);
      pad.classList.toggle('on', !!g && dj.current(g) === move);
      pad.classList.toggle('next', dj.pending.get(group)?.move.name === move);
      odds.style.width = `${Math.round((dj.odds.get(group)?.[move] ?? 0) * 100)}%`;
    }
    this.status.textContent = this.line();
    const st = dj.stats;
    this.meta.textContent = st.calls || st.fails
      ? `${st.model.replace(/-\d{8}$/, '')} · ${Math.round(st.ms)} ms · ${st.calls} answers${st.late ? `, ${st.late} late` : ''}${st.fails ? `, ${st.fails} failed` : ''} · $${st.cost.toFixed(4)}`
      : '';
  }
}
