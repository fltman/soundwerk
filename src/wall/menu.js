// Searchable "add module" popup, grouped by category.
import { MODULES, CATEGORIES, codeDef } from '../modules/index.js';

export class AddMenu {
  constructor(host) {
    this.el = document.createElement('div');
    this.el.className = 'add-menu hidden';
    this.input = document.createElement('input');
    this.input.placeholder = 'Search modules…  (acid, kick, filter, scope)';
    this.list = document.createElement('div');
    this.list.className = 'add-list';
    this.el.append(this.input, this.list);
    host.append(this.el);
    this.items = [];
    this.active = 0;

    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.items[this.active]); }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.classList.contains('hidden') && !this.el.contains(e.target)) this.close();
    }, true);
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  open({ x, y, filter = () => true, onPick }) {
    this.filter = filter;
    this.onPick = onPick;
    this.input.value = '';
    this.el.classList.remove('hidden');
    const w = 340, h = 440;
    this.el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
    this.render();
    this.input.focus(); // now, so fast typing isn't lost …
    requestAnimationFrame(() => this.input.focus()); // … and again in case the click that opened us took it back
  }

  close() {
    this.el.classList.add('hidden');
    this.onPick = null;
  }

  render() {
    const query = this.input.value.toLowerCase().trim();
    const words = query.split(/\s+/).filter(Boolean);
    const match = (d) => {
      const hay = [d.title, d.type, d.description, ...(d.tags ?? []), CATEGORIES[d.category]?.label].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    };
    // title hits first, then tag/description hits; categories in rack order
    const rank = (d) => {
      if (!query) return 0;
      const t = d.title.toLowerCase();
      return t.startsWith(query) ? 0 : t.includes(query) ? 1 : 2;
    };
    const order = Object.keys(CATEGORIES);
    this.items = [...MODULES, codeDef]
      .filter((d) => this.filter(d) && match(d))
      .sort((a, b) => rank(a) - rank(b) || order.indexOf(a.category) - order.indexOf(b.category));
    this.active = 0;
    this.list.replaceChildren();
    let lastCat = null;
    this.items.forEach((d, i) => {
      if (d.category !== lastCat && !query) {
        lastCat = d.category;
        const h = document.createElement('div');
        h.className = 'add-cat';
        h.textContent = CATEGORIES[d.category]?.label ?? d.category;
        this.list.append(h);
      }
      const row = document.createElement('div');
      row.className = 'add-item';
      row.innerHTML = '<span class="dot"></span><span class="t"></span><span class="d"></span>';
      row.querySelector('.t').textContent = d.title;
      row.querySelector('.d').textContent = d.description ?? '';
      row.addEventListener('pointerenter', () => this.setActive(i));
      row.addEventListener('click', () => this.pick(d));
      d._row = row;
      this.list.append(row);
    });
    if (!this.items.length) {
      const none = document.createElement('div');
      none.className = 'add-none';
      none.textContent = 'Nothing matches.';
      this.list.append(none);
    }
    this.setActive(0);
  }

  setActive(i) {
    this.items[this.active]?._row?.classList.remove('active');
    this.active = i;
    const row = this.items[i]?._row;
    row?.classList.add('active');
    row?.scrollIntoView({ block: 'nearest' });
  }

  move(d) {
    if (!this.items.length) return;
    this.setActive((this.active + d + this.items.length) % this.items.length);
  }

  pick(d) {
    if (!d) return;
    const cb = this.onPick;
    this.close();
    cb?.(d);
  }
}
