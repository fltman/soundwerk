// The DSP tab: read any module's source, edit Code modules live, fork built-ins.
import { checkCode, forkSource } from '../engine/code.js';
import { CATEGORIES } from '../modules/index.js';
import { dropAt } from '../rack/place.js';

export class CodePanel {
  constructor(graph, host, wall) {
    this.graph = graph;
    this.host = host;
    this.wall = wall;
    this.id = null;
    this.title = document.getElementById('code-title');
    this.text = document.getElementById('code-text');
    this.gutter = document.getElementById('code-gutter');
    this.errors = document.getElementById('code-errors');
    this.forkBtn = document.getElementById('code-fork');

    let timer = null;
    this.text.addEventListener('input', () => {
      this.dirty = true;
      this.updateGutter();
      clearTimeout(timer);
      timer = setTimeout(() => this.apply(), 350);
    });
    this.text.addEventListener('blur', () => { clearTimeout(timer); this.apply(true); });
    this.text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.text;
        this.text.value = value.slice(0, a) + '  ' + value.slice(b);
        this.text.selectionStart = this.text.selectionEnd = a + 2;
        this.text.dispatchEvent(new Event('input'));
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { clearTimeout(timer); this.apply(true); }
    });
    this.text.addEventListener('scroll', () => { this.gutter.scrollTop = this.text.scrollTop; });
    this.forkBtn.addEventListener('click', () => this.fork());
    graph.addEventListener('change', (e) => {
      if (e.detail.kind !== 'load' && e.detail.kind !== 'structure') return;
      if (this.id && !graph.nodes.has(this.id)) { this.show(null); return; }
      // undo and the assistant change code too: show what the module is really running
      const node = this.id && graph.nodes.get(this.id);
      if (node?.type === 'code' && node.code !== this.text.value && document.activeElement !== this.text) this.show(this.id);
    });
  }

  show(id) {
    this.id = id;
    this.dirty = false;
    const node = id ? this.graph.nodes.get(id) : null;
    this.errors.textContent = '';
    if (!node) {
      this.title.textContent = 'Select a module to read its source, or add a Code module to write your own';
      this.text.value = '';
      this.text.readOnly = true;
      this.forkBtn.classList.add('hidden');
      this.updateGutter();
      return;
    }
    const def = this.graph.def(node);
    if (node.type === 'code') {
      this.title.textContent = `Code module ${node.id} — live: edits run as you type (⌘↵ to apply now)`;
      this.text.readOnly = false;
      this.text.value = node.code;
      this.forkBtn.classList.add('hidden');
      this.check();
    } else {
      this.title.textContent = `${def.title} · ${CATEGORIES[def.category]?.label ?? ''} · built-in (read-only)`;
      this.text.readOnly = true;
      this.text.value = forkSource(def);
      // the engine listens to the module called master, so that one can't become code
      this.forkBtn.classList.toggle('hidden', node.type === 'master');
    }
    this.updateGutter();
  }

  check() {
    const err = checkCode(this.text.value);
    this.errors.replaceChildren();
    const d = document.createElement('div');
    if (err) d.textContent = err;
    else { d.className = 'ok'; d.textContent = '✓ running'; }
    this.errors.append(d);
    return !err;
  }

  showRuntimeError(id, text) {
    if (id !== this.id) return;
    this.errors.replaceChildren();
    const d = document.createElement('div');
    d.textContent = `stopped while running: ${text}`;
    this.errors.append(d);
  }

  apply(commit = false) {
    const node = this.id && this.graph.nodes.get(this.id);
    if (!node || node.type !== 'code' || this.text.readOnly || !this.dirty) return;
    if (!this.check()) return;
    if (node.code !== this.text.value) {
      this.graph.setCode(node.id, this.text.value);
      dropAt(this.graph, node, node.row, node.hp);   // new jacks can make the panel wider
    }
    if (commit) { this.dirty = false; this.graph.commit(); }
  }

  // the Code module takes the original's place on the rail and its cables
  fork() {
    const g = this.graph;
    const node = g.nodes.get(this.id);
    if (!node) return;
    const def = g.def(node);
    const links = g.linksOf(node.id);
    const { row, hp, params, depth, data } = node;
    g.removeNode(node.id);
    const copy = g.addNode('code', row, hp, { code: forkSource(def), params: { ...params }, depth: { ...depth }, data });
    dropAt(g, copy, row, hp);
    for (const l of links) {
      if (l.to === node.id) g.connect(l.from, l.fromPort, copy.id, l.toPort);
      else g.connect(copy.id, l.fromPort, l.to, l.toPort);
    }
    g.commit();
    this.wall.select(copy.id);
    this.show(copy.id);
  }

  updateGutter() {
    const n = this.text.value.split('\n').length;
    this.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    this.gutter.scrollTop = this.text.scrollTop;
  }
}
