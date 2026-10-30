// The screens and grids on the panels. Each builder returns { el, tick?, refresh? }; tick gets
// the module's shared ui and wave arrays once a frame.
import { expmap } from '../modules/lib/index.js';
import { fft, hann } from './fft.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// A canvas at twice its CSS size, so a screen stays sharp when you zoom in.
function hiDpi(w, h, scale = 2) {
  const c = el('canvas');
  c.width = w * scale;
  c.height = h * scale;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  return c;
}

const PHOSPHOR = [
  { a: [120, 255, 150], b: [120, 220, 255], bg: [4, 12, 8] },
  { a: [255, 190, 70], b: [255, 120, 60], bg: [14, 8, 3] },
  { a: [130, 190, 255], b: [210, 150, 255], bg: [4, 7, 16] },
];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// ── seven-segment display ───────────────────────────────
const SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '' };
export function drawSeg(c, text, x, y, h, color, off = 'rgba(255,60,40,0.07)') {
  const w = h * 0.52, t = h * 0.12;
  const seg = (s, on) => {
    c.fillStyle = on ? color : off;
    const H = h / 2;
    const bar = (x0, y0, len, horiz) => {
      c.beginPath();
      if (horiz) {
        c.moveTo(x0, y0); c.lineTo(x0 + t / 2, y0 - t / 2); c.lineTo(x0 + len - t / 2, y0 - t / 2);
        c.lineTo(x0 + len, y0); c.lineTo(x0 + len - t / 2, y0 + t / 2); c.lineTo(x0 + t / 2, y0 + t / 2);
      } else {
        c.moveTo(x0, y0); c.lineTo(x0 + t / 2, y0 + t / 2); c.lineTo(x0 + t / 2, y0 + len - t / 2);
        c.lineTo(x0, y0 + len); c.lineTo(x0 - t / 2, y0 + len - t / 2); c.lineTo(x0 - t / 2, y0 + t / 2);
      }
      c.closePath();
      c.fill();
    };
    const g = t * 0.2;
    if (s === 'a') bar(x + g, y, w - 2 * g, true);
    if (s === 'g') bar(x + g, y + H, w - 2 * g, true);
    if (s === 'd') bar(x + g, y + h, w - 2 * g, true);
    if (s === 'f') bar(x, y + g, H - 2 * g, false);
    if (s === 'e') bar(x, y + H + g, H - 2 * g, false);
    if (s === 'b') bar(x + w, y + g, H - 2 * g, false);
    if (s === 'c') bar(x + w, y + H + g, H - 2 * g, false);
  };
  for (const ch of String(text)) {
    if (ch === '.') {
      c.fillStyle = color;
      c.fillRect(x - w * 0.27, y + h - t / 2, t, t);
      continue;
    }
    const on = SEGS[ch] ?? '';
    for (const s of 'abcdefg') seg(s, on.includes(s));
    x += w * 1.5;
  }
}

function bpm({ node }) {
  const box = el('div', 'seg-box');
  const c = hiDpi(84, 36);
  box.append(c);
  const g = c.getContext('2d');
  let shown = '';
  const draw = () => {
    const text = node.params.bpm.toFixed(1).padStart(5, ' ');
    if (text === shown) return;
    shown = text;
    g.clearRect(0, 0, c.width, c.height);
    drawSeg(g, text, 14, 14, 44, '#ff4a2e');
  };
  draw();
  return { el: box, tick: draw, refresh: draw };
}

// ── oscilloscope ────────────────────────────────────────
function scope({ node, spec }) {
  const box = el('div', 'crt');
  const c = hiDpi(spec.w, spec.h);
  const readout = el('div', 'readout');
  box.append(c, el('div', 'graticule'), el('div', 'glass'), readout);
  const g = c.getContext('2d', { alpha: false });
  const W = c.width, H = c.height;
  const X = W / 10, Y = H / 6;
  let text = '';
  const trace = (wave, base, from, to, n, gain, pos, color, bright) => {
    if (to - from < 2) return;
    g.beginPath();
    const px = W / Math.max(1, n - 1);
    for (let k = from; k < to; k++) {
      const x = k * px;
      const y0 = H / 2 - ((wave[base + k * 2] / gain + pos) * Y);
      const y1 = H / 2 - ((wave[base + k * 2 + 1] / gain + pos) * Y);
      if (k === from) g.moveTo(x, y0); else g.lineTo(x, y0);
      if (y1 !== y0) g.lineTo(x, y1);
    }
    g.strokeStyle = rgba(color, 0.16 * bright);
    g.lineWidth = 9;
    g.stroke();
    g.strokeStyle = rgba(color, 0.95 * bright);
    g.lineWidth = 2.4;
    g.stroke();
  };
  const tick = (ui, wave) => {
    const p = node.params;
    const ph = PHOSPHOR[p.phosphor] ?? PHOSPHOR[0];
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rgba(ph.bg, 0.3);
    g.fillRect(0, 0, W, H);
    // The beam draws the sweep as it happens; ahead of it the last sweep is still fading off the
    // phosphor. The slower the timebase the dimmer that is, and on a fast one you can't tell them apart.
    const n = ui[0], beam = Math.min(ui[3] | 0, n);
    if (n > 0 && wave) {
      const sweep = 10 * expmap(p.time, 0.00005, 0.2);
      const old = Math.max(0.3, Math.min(1, 0.035 / sweep));
      g.globalCompositeOperation = 'lighter';
      g.lineJoin = 'round';
      trace(wave, 0, 0, beam, n, p.gainA, p.posA, ph.a, 1);
      trace(wave, 0, beam, n, n, p.gainA, p.posA, ph.a, old);
      trace(wave, 4096, 0, beam, n, p.gainB, p.posB, ph.b, 1);
      trace(wave, 4096, beam, n, n, p.gainB, p.posB, ph.b, old);
      if (sweep > 0.1 && beam > 0 && beam < n) {
        const x = (beam / Math.max(1, n - 1)) * W;
        for (const [base, gain, pos, color] of [[0, p.gainA, p.posA, ph.a], [4096, p.gainB, p.posB, ph.b]]) {
          g.fillStyle = rgba(color, 1);
          g.beginPath();
          g.arc(x, H / 2 - ((wave[base + beam * 2 - 1] / gain + pos) * Y), 5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
    const ms = expmap(p.time, 0.00005, 0.2) * 1000;
    const t = `A ${p.gainA.toFixed(1)} V   B ${p.gainB.toFixed(1)} V   ${ms >= 10 ? ms.toFixed(0) : ms.toFixed(2)} ms/div`;
    if (t !== text) { text = t; readout.textContent = t; }
  };
  g.fillStyle = rgba(PHOSPHOR[0].bg, 1);
  g.fillRect(0, 0, W, H);
  return { el: box, tick };
}

function xy({ node, spec }) {
  const box = el('div', 'crt round');
  const c = hiDpi(spec.w, spec.h);
  box.append(c, el('div', 'graticule polar'), el('div', 'glass'));
  const g = c.getContext('2d', { alpha: false });
  const W = c.width, H = c.height;
  const tick = (ui, wave) => {
    const p = node.params;
    const ph = PHOSPHOR[p.phosphor] ?? PHOSPHOR[0];
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = rgba(ph.bg, 0.3);
    g.fillRect(0, 0, W, H);
    if (!wave) return;
    const end = ui[0] | 0, zoom = p.zoom * (W / 2) * 0.5;
    g.globalCompositeOperation = 'lighter';
    g.beginPath();
    for (let k = 1400; k > 0; k--) {
      const i = ((end - k) & 8191) * 2;
      let a = wave[i], b = wave[i + 1];
      if (p.rotate === 1) { const m = (a + b) * 0.7071, s = (b - a) * 0.7071; a = s; b = m; }
      const x = W / 2 + a * zoom, y = H / 2 - b * zoom;
      if (k === 1400) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.strokeStyle = rgba(ph.a, 0.12);
    g.lineWidth = 7;
    g.stroke();
    g.strokeStyle = rgba(ph.a, 0.8);
    g.lineWidth = 1.6;
    g.stroke();
  };
  return { el: box, tick };
}

// ── spectrum ────────────────────────────────────────────
const SIZE = 4096;
const WINDOW = hann(SIZE);

function readSpectrum(ui, wave, re, im) {
  const end = ui[0] | 0;
  for (let k = 0; k < SIZE; k++) {
    re[k] = wave[(end - SIZE + k) & 16383] * WINDOW[k];
    im[k] = 0;
  }
  fft(re, im);
}

function spectrum({ spec }) {
  const box = el('div', 'crt');
  const c = hiDpi(spec.w, spec.h);
  box.append(c, el('div', 'glass'));
  const g = c.getContext('2d', { alpha: false });
  const W = c.width, H = c.height;
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  const BARS = 96;
  const level = new Float64Array(BARS), held = new Float64Array(BARS);
  const tick = (ui, wave) => {
    if (!wave) return;
    const sr = ui[1] || 48000;
    readSpectrum(ui, wave, re, im);
    g.fillStyle = '#060a0d';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(120,200,255,0.1)';
    g.font = '18px ui-monospace, Menlo, monospace';
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = (Math.log(hz / 20) / Math.log(1000)) * W;
      g.fillRect(x, 0, 1.5, H);
      g.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 4, H - 6);
    }
    for (let b = 0; b < BARS; b++) {
      const lo = 20 * 1000 ** (b / BARS), hi = 20 * 1000 ** ((b + 1) / BARS);
      const k0 = Math.max(1, Math.floor((lo / sr) * SIZE)), k1 = Math.max(k0 + 1, Math.ceil((hi / sr) * SIZE));
      let e = 0;
      for (let k = k0; k < k1 && k < SIZE / 2; k++) e = Math.max(e, re[k] * re[k] + im[k] * im[k]);
      // 0 dB here is a 10 V sine; the bars tilt 3 dB/oct so a balanced mix reads flat
      const db = (10 * Math.log10(e / ((SIZE / 4) * (SIZE / 4) * 100) + 1e-14)) + 3 * Math.log2((lo + hi) / 2 / 1000);
      const t = Math.max(0, Math.min(1, (db + 72) / 72));
      level[b] = t > level[b] ? t : level[b] * 0.86;
      held[b] = t > held[b] ? t : Math.max(0, held[b] - 0.006);
      const x = (b / BARS) * W, w = W / BARS - 2;
      const grad = 90 + 90 * (1 - level[b]);
      g.fillStyle = `hsl(${grad}, 90%, 58%)`;
      g.fillRect(x, H - level[b] * H, w, level[b] * H);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.fillRect(x, H - held[b] * H, w, 2);
    }
  };
  return { el: box, tick };
}

function waterfall({ spec }) {
  const box = el('div', 'crt');
  const c = hiDpi(spec.w, spec.h, 1);
  box.append(c, el('div', 'glass'));
  // it scrolls onto itself every frame, which is cheap in memory and dear on the GPU
  const g = c.getContext('2d', { alpha: false, willReadFrequently: true });
  const W = c.width, H = c.height;
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  const col = g.createImageData(1, H);
  const tick = (ui, wave) => {
    if (!wave) return;
    const sr = ui[1] || 48000;
    readSpectrum(ui, wave, re, im);
    g.drawImage(c, -1, 0);
    for (let y = 0; y < H; y++) {
      const hz = 30 * 600 ** (1 - y / H);
      const k = Math.min(SIZE / 2 - 1, Math.round((hz / sr) * SIZE));
      const db = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / ((SIZE / 4) * (SIZE / 4) * 100) + 1e-14);
      const t = Math.max(0, Math.min(1, (db + 76) / 66));
      col.data[y * 4] = 255 * Math.min(1, t * 1.8);
      col.data[y * 4 + 1] = 255 * Math.max(0, t * 1.6 - 0.5);
      col.data[y * 4 + 2] = 255 * (t * t * t * 0.8 + 0.25 * Math.sin(t * 3.14));
      col.data[y * 4 + 3] = 255;
    }
    g.putImageData(col, W - 1, 0);
  };
  return { el: box, tick };
}

// ── needles ─────────────────────────────────────────────
function vu({ spec }) {
  const box = el('div', 'vu-face');
  const c = hiDpi(spec.w, spec.h);
  box.append(c);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const cx = W / 2, cy = H * 1.15, R = H * 0.98;
  const angle = (db) => -0.82 + ((db + 20) / 23) * 1.64;
  const face = hiDpi(spec.w, spec.h);
  const f = face.getContext('2d');
  f.fillStyle = '#e9dcb4';
  f.fillRect(0, 0, W, H);
  f.lineWidth = 3;
  f.strokeStyle = '#231a10';
  f.beginPath();
  f.arc(cx, cy, R, -Math.PI / 2 - 0.82, -Math.PI / 2 + angle(0));
  f.stroke();
  f.strokeStyle = '#b3201b';
  f.lineWidth = 7;
  f.beginPath();
  f.arc(cx, cy, R, -Math.PI / 2 + angle(0), -Math.PI / 2 + 0.82);
  f.stroke();
  f.font = '700 15px Helvetica, Arial, sans-serif';
  f.textAlign = 'center';
  for (const db of [-20, -10, -7, -5, -3, -1, 0, 1, 3]) {
    const a = angle(db) - Math.PI / 2;
    f.strokeStyle = db >= 0 ? '#b3201b' : '#231a10';
    f.lineWidth = 2.5;
    f.beginPath();
    f.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    f.lineTo(cx + Math.cos(a) * (R + 11), cy + Math.sin(a) * (R + 11));
    f.stroke();
    f.fillStyle = db >= 0 ? '#b3201b' : '#231a10';
    f.fillText(String(Math.abs(db)), cx + Math.cos(a) * (R + 26), cy + Math.sin(a) * (R + 26) + 5);
  }
  f.font = '700 26px Georgia, serif';
  f.fillStyle = '#231a10';
  f.fillText('VU', cx, H * 0.78);
  const channel = spec.channel ?? 0;
  let needle = -20, shown = 99;
  const tick = (ui) => {
    // 0 VU sits at about 2.5 V average, a healthy channel level
    const db = 20 * Math.log10(Math.max(ui[channel] / 2.5, 1e-3));
    needle += (Math.max(-22, Math.min(4, db)) - needle) * 0.3;
    if (Math.abs(needle - shown) < 0.08) return;
    shown = needle;
    g.clearRect(0, 0, W, H);
    g.drawImage(face, 0, 0);
    const a = angle(needle) - Math.PI / 2;
    g.strokeStyle = '#110c07';
    g.lineWidth = 2.6;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * (R + 8), cy + Math.sin(a) * (R + 8));
    g.stroke();
  };
  tick(new Float32Array(2));
  return { el: box, tick };
}

// ── acid sequencer: a note grid with accent and slide lanes ──
const NOTE_ROWS = 25;   // two octaves from C2
const NAMES = ['C', '', 'D', '', 'E', 'F', '', 'G', '', 'A', '', 'B'];

function randomAcid() {
  const scales = [[0, 3, 5, 7, 10], [0, 1, 3, 5, 7, 8, 10], [0, 2, 3, 5, 7, 10], [0, 3, 6, 7, 10]];
  const scale = scales[Math.floor(Math.random() * scales.length)];
  const root = 12;
  const pick = () => {
    const r = Math.random();
    if (r < 0.4) return root;
    const deg = scale[Math.floor(Math.random() * scale.length)];
    return root + deg + (r > 0.82 ? 12 : r < 0.5 ? -12 : 0);
  };
  return {
    steps: Array.from({ length: 16 }, () => ({
      n: Math.max(0, Math.min(24, pick())),
      g: Math.random() < 0.72 ? 1 : 0,
      a: Math.random() < 0.28 ? 1 : 0,
      s: Math.random() < 0.22 ? 1 : 0,
    })),
  };
}

function pianoroll({ node, spec, graph, host }) {
  const box = el('div', 'roll');
  const c = hiDpi(spec.w, spec.h - 24);
  const tools = el('div', 'roll-tools');
  const rnd = el('button', 'mini', 'RANDOM');
  const clr = el('button', 'mini', 'CLEAR');
  const label = el('span', 'roll-note', '');
  tools.append(rnd, clr, label);
  box.append(c, tools);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const LEFT = 44, ROW = (H - 52) / NOTE_ROWS, COL = (W - LEFT) / 16;
  const laneY = H - 48;
  let playing = -1;

  const draw = () => {
    g.fillStyle = '#16171a';
    g.fillRect(0, 0, W, H);
    for (let r = 0; r < NOTE_ROWS; r++) {
      const n = NOTE_ROWS - 1 - r, y = r * ROW, black = [1, 3, 6, 8, 10].includes(n % 12);
      g.fillStyle = black ? '#1b1c20' : '#25262b';
      g.fillRect(LEFT, y, W - LEFT, ROW - 1);
      g.fillStyle = black ? '#111' : '#d9d9d2';
      g.fillRect(0, y, LEFT - 4, ROW - 1);
      if (n % 12 === 0) {
        g.fillStyle = '#333';
        g.font = '700 11px Helvetica, Arial, sans-serif';
        g.fillText(`C${2 + n / 12}`, 3, y + ROW - 2);
      }
    }
    for (let k = 0; k <= 16; k++) {
      g.fillStyle = k % 4 === 0 ? '#50525a' : '#2c2d33';
      g.fillRect(LEFT + k * COL - 1, 0, k % 4 === 0 ? 2 : 1, H);
    }
    const steps = node.data?.steps ?? [];
    const len = node.params.length;
    if (playing >= 0) {
      g.fillStyle = 'rgba(255,255,255,0.09)';
      g.fillRect(LEFT + playing * COL, 0, COL, H);
    }
    steps.forEach((s, k) => {
      const x = LEFT + k * COL;
      const dim = k >= len;
      if (s.g) {
        const y = (NOTE_ROWS - 1 - s.n) * ROW;
        g.fillStyle = dim ? '#5a4a30' : s.a ? '#ff5a2a' : '#ffae2c';
        g.fillRect(x + 2, y, COL - (s.s ? -1 : 4), ROW - 1);
      }
      for (const [lane, on, color] of [[0, s.a, '#ff5a2a'], [1, s.s, '#3fa7ff']]) {
        g.fillStyle = on ? color : '#2c2d33';
        g.fillRect(x + 3, laneY + lane * 24, COL - 6, 20);
      }
    });
    g.fillStyle = '#d9d9d2';
    g.font = '700 15px Helvetica, Arial, sans-serif';
    g.fillText('ACC', 2, laneY + 16);
    g.fillText('SLD', 2, laneY + 40);
  };

  const edit = (fn) => {
    const data = structuredClone(node.data);
    fn(data.steps);
    graph.setData(node.id, data);
  };
  let paint = null;
  const hit = (e) => {
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    return { k: Math.floor((x - LEFT) / COL), row: Math.floor(y / ROW), y };
  };
  const apply = (e) => {
    const { k, row, y } = hit(e);
    if (k < 0 || k > 15) return;
    if (y >= laneY) {
      const lane = y < laneY + 24 ? 'a' : 's';
      if (paint.lane === undefined) { paint.lane = lane; paint.value = node.data.steps[k][lane] ? 0 : 1; }
      if (paint.lane === lane) edit((s) => { s[k][lane] = paint.value; });
      return;
    }
    const n = NOTE_ROWS - 1 - Math.max(0, Math.min(NOTE_ROWS - 1, row));
    label.textContent = `${NAMES[n % 12] || `${NAMES[(n + 11) % 12]}#`}${2 + Math.floor(n / 12)}`;
    if (paint.first) {
      paint.first = false;
      const s = node.data.steps[k];
      paint.erase = !!(s.g && s.n === n);
    }
    edit((s) => {
      if (paint.erase) s[k].g = 0;
      else { s[k].n = n; s[k].g = 1; }
    });
  };
  c.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    c.setPointerCapture(e.pointerId);
    paint = { first: true };
    apply(e);
  });
  c.addEventListener('pointermove', (e) => { if (paint) apply(e); });
  const up = () => { if (paint) { paint = null; graph.commit(); } };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  for (const b of [rnd, clr]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
  rnd.addEventListener('click', () => { graph.setData(node.id, randomAcid()); graph.commit(); });
  clr.addEventListener('click', () => { edit((s) => s.forEach((x) => { x.g = 0; x.a = 0; x.s = 0; })); graph.commit(); });
  draw();
  void host;
  return {
    el: box,
    refresh: draw,
    tick(ui) {
      const k = host.running ? ui[1] | 0 : -1;
      if (k !== playing) { playing = k; draw(); }
    },
  };
}

// ── drum grid ───────────────────────────────────────────
const PAD = ['#d8452f', '#d8452f', '#d8452f', '#d8452f', '#e88a2d', '#e88a2d', '#e88a2d', '#e88a2d', '#e6c63a', '#e6c63a', '#e6c63a', '#e6c63a', '#ece9dc', '#ece9dc', '#ece9dc', '#ece9dc'];

function stepgrid({ node, spec, graph, host }) {
  const c = hiDpi(spec.w, spec.h);
  c.className = 'grid-canvas';
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const labels = spec.rows;
  const LEFT = 56, COL = (W - LEFT) / 16, ROW = H / labels.length;
  let playing = -1;
  const draw = () => {
    g.clearRect(0, 0, W, H);
    g.font = '800 17px Helvetica, Arial, sans-serif';
    labels.forEach((name, r) => {
      g.fillStyle = r === 8 ? '#ffd9b0' : '#fff';
      g.fillText(name, 6, r * ROW + ROW * 0.68);
      for (let k = 0; k < 16; k++) {
        const on = node.data?.rows?.[r]?.[k];
        const x = LEFT + k * COL + 2, y = r * ROW + 2;
        g.fillStyle = on ? PAD[k] : '#35373b';
        g.fillRect(x, y, COL - 4, ROW - 4);
        if (on) {
          g.fillStyle = 'rgba(255,255,255,0.35)';
          g.fillRect(x, y, COL - 4, 3);
        }
        if (k === playing) {
          g.fillStyle = 'rgba(255,255,255,0.28)';
          g.fillRect(x, y, COL - 4, ROW - 4);
        }
      }
    });
  };
  let paint = null;
  const apply = (e) => {
    const b = c.getBoundingClientRect();
    const x = ((e.clientX - b.left) / b.width) * W, y = ((e.clientY - b.top) / b.height) * H;
    const k = Math.floor((x - LEFT) / COL), r = Math.floor(y / ROW);
    if (k < 0 || k > 15 || r < 0 || r >= labels.length) return;
    const rows = structuredClone(node.data.rows);
    if (paint.value === undefined) paint.value = rows[r][k] ? 0 : 1;
    if (rows[r][k] === paint.value) return;
    rows[r][k] = paint.value;
    graph.setData(node.id, { rows });
  };
  c.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    c.setPointerCapture(e.pointerId);
    paint = {};
    apply(e);
  });
  c.addEventListener('pointermove', (e) => { if (paint) apply(e); });
  const up = () => { if (paint) { paint = null; graph.commit(); } };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  draw();
  return {
    el: c,
    refresh: draw,
    tick(ui) {
      const k = host.running ? ui[0] | 0 : -1;
      if (k !== playing) { playing = k; draw(); }
    },
  };
}

// ── euclid's ring ───────────────────────────────────────
function ring({ spec }) {
  const c = hiDpi(spec.w, spec.h);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  let key = '';
  const tick = (ui) => {
    const at = ui[0], hits = ui[1], steps = ui[2] || 16, rot = ui[3];
    const k = `${at}/${hits}/${steps}/${rot}`;
    if (k === key) return;
    key = k;
    g.clearRect(0, 0, W, H);
    const R = W * 0.42;
    for (let n = 0; n < steps; n++) {
      const a = (n / steps) * Math.PI * 2 - Math.PI / 2;
      const on = hits > 0 && ((n + rot) * hits) % steps < hits;
      g.beginPath();
      g.arc(W / 2 + Math.cos(a) * R, H / 2 + Math.sin(a) * R, Math.max(3, 70 / steps), 0, Math.PI * 2);
      g.fillStyle = n === at ? '#fff' : on ? '#ff5a2a' : 'rgba(255,255,255,0.14)';
      g.fill();
    }
  };
  return { el: c, tick };
}

// ── a file's waveform ───────────────────────────────────
function waveform({ node, spec, host }) {
  const box = el('div', 'wavebox');
  const c = hiDpi(spec.w, spec.h);
  const name = el('div', 'wave-name', 'DROP A FILE HERE');
  box.append(c, name);
  box.dataset.dropTarget = node.id;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  let drawn = null;
  const still = hiDpi(spec.w, spec.h);
  const tick = (ui) => {
    const buf = host.buffers.get(node.id);
    if (!buf && drawn) {
      drawn = null;
      name.textContent = 'DROP A FILE HERE';
      still.getContext('2d').clearRect(0, 0, W, H);
    }
    if (buf && buf !== drawn) {
      drawn = buf;
      name.textContent = buf.name ?? '';
      const s = still.getContext('2d');
      s.clearRect(0, 0, W, H);
      s.fillStyle = '#7fd0ff';
      const step = buf.L.length / W;
      for (let x = 0; x < W; x++) {
        let m = 0;
        for (let i = Math.floor(x * step); i < (x + 1) * step; i += 4) m = Math.max(m, Math.abs(buf.L[i] ?? 0));
        s.fillRect(x, H / 2 - (m * H) / 2, 1, m * H);
      }
    }
    g.clearRect(0, 0, W, H);
    g.drawImage(still, 0, 0);
    if (buf) {
      g.fillStyle = '#fff';
      g.fillRect(ui[0] * W, 0, 2, H);
    }
  };
  return { el: box, tick };
}

// ── a small keyboard, played with the mouse ─────────────
function keys({ node, spec, host }) {
  const c = hiDpi(spec.w, spec.h);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const LOW = 48, WHITES = 15;
  const whiteOf = [0, 2, 4, 5, 7, 9, 11];
  const noteAt = (x, y) => {
    const kw = W / WHITES, i = Math.floor(x / kw), oct = Math.floor(i / 7), n = LOW + oct * 12 + whiteOf[i % 7];
    if (y < H * 0.6) {
      const r = x / kw - i;
      if (r < 0.3 && ![0, 3].includes(i % 7)) return n - 1;
      if (r > 0.7 && ![2, 6].includes(i % 7)) return n + 1;
    }
    return n;
  };
  const draw = (held = -1) => {
    const kw = W / WHITES;
    g.fillStyle = '#efefe8';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < WHITES; i++) {
      const n = LOW + Math.floor(i / 7) * 12 + whiteOf[i % 7];
      if (n === held) { g.fillStyle = '#ffae2c'; g.fillRect(i * kw, 0, kw, H); }
      g.fillStyle = '#333';
      g.fillRect(i * kw, 0, 1, H);
      if (![2, 6].includes(i % 7) && i < WHITES - 1) {
        g.fillStyle = n + 1 === held ? '#ffae2c' : '#15151a';
        g.fillRect((i + 0.68) * kw, 0, kw * 0.64, H * 0.6);
      }
    }
  };
  let on = -1;
  const press = (e) => {
    const r = c.getBoundingClientRect();
    const x = Math.max(0, Math.min(W - 1, ((e.clientX - r.left) / r.width) * W));
    const n = noteAt(x, ((e.clientY - r.top) / r.height) * H);
    if (n === on) return;
    if (on >= 0) host.send(node.id, { kind: 'midi', data: [0x80, on, 0] });
    host.send(node.id, { kind: 'midi', data: [0x90, n, 100] });
    on = n;
    draw(n);
  };
  c.addEventListener('pointerdown', (e) => { e.stopPropagation(); c.setPointerCapture(e.pointerId); press(e); });
  c.addEventListener('pointermove', (e) => { if (on >= 0) press(e); });
  const up = () => { if (on >= 0) host.send(node.id, { kind: 'midi', data: [0x80, on, 0] }); on = -1; draw(); };
  c.addEventListener('pointerup', up);
  c.addEventListener('pointercancel', up);
  draw();
  return { el: c };
}

const BUILDERS = { bpm, scope, xy, spectrum, waterfall, vu, pianoroll, stepgrid, ring, waveform, keys };

export function buildWidget(ui, ctx) {
  const make = BUILDERS[ui];
  if (!make) throw new Error(`no widget "${ui}"`);
  return make(ctx);
}
