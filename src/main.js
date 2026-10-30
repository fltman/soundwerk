// Boot: wires the patch, the wall and the audio engine together.
import { Graph } from './rack/graph.js';
import { Wall } from './wall/wall.js';
import { AddMenu } from './wall/menu.js';
import { Host } from './engine/host.js';
import { drawSeg } from './wall/widgets.js';
import { EMPTY, PRESETS } from './presets.js';
import { CodePanel } from './ui/code.js';
import { loadInto, restoreFiles } from './ui/files.js';
import { Chat } from './ai/chat.js';
import { Devices } from './ui/devices.js';
import { DJ } from './dj/dj.js';
import { DJPanel } from './ui/dj.js';

const $ = (id) => document.getElementById(id);
const PATCH_KEY = 'soundwerk.patch.v1';

const graph = new Graph();
const host = new Host(graph);
const menu = new AddMenu(document.body);
const wall = new Wall($('wall'), graph, host, menu);
const code = new CodePanel(graph, host, wall);
window.soundwerk = { graph, wall, host }; // handy in the console

// ── toast ───────────────────────────────────────────────
let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
wall.addEventListener('message', (e) => toast(e.detail.text));
const dj = new DJ({ graph, host });
const chat = new Chat({ graph, wall, host, dj, toast });
new DJPanel({ dj, graph, chat, wall });
dj.addEventListener('landed', (e) => wall.flash(e.detail.ids));
$('ai-btn').onclick = () => chat.toggle();
window.soundwerk.chat = chat;
window.soundwerk.dj = dj;
host.addEventListener('module-error', (e) => {
  const { id, text } = e.detail;
  toast(id ? `${id} stopped: ${text}` : `Engine error: ${text}`);
  code.showRuntimeError(id, text);
});
window.soundwerk.devices = new Devices(graph, host, wall, toast);
window.soundwerk.loadInto = (id, name, data) => loadInto(host, graph, id, name, data);

// ── patch persistence ───────────────────────────────────
function loadPatch(json) {
  host.forget();
  graph.load(json);
  graph.commit(true);
  requestAnimationFrame(() => wall.frameAll());
}
// undo and redo come through here too: a deck must never play a file the patch doesn't name
graph.addEventListener('change', (e) => {
  if (e.detail.kind === 'load') restoreFiles(host, graph).catch((err) => toast(err.message));
});
let saveTimer;
graph.addEventListener('commit', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => localStorage.setItem(PATCH_KEY, JSON.stringify(graph.toJSON())), 300);
});

const EXAMPLES = [EMPTY, ...PRESETS];
EXAMPLES.forEach((p, i) => $('examples').append(new Option(p.name, i)));
$('examples').prepend(new Option('Load an example…', ''));
$('examples').value = '';
$('examples').addEventListener('change', (e) => {
  const p = EXAMPLES[e.target.value];
  if (p) { loadPatch(structuredClone(p.patch())); toast(`Loaded “${p.name}” — ⌘Z to go back`); }
  e.target.value = '';
  e.target.blur();
});

$('undo').onclick = () => graph.undo();
$('redo').onclick = () => graph.redo();
$('save').onclick = () => {
  const blob = new Blob([JSON.stringify(graph.toJSON(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `soundwerk-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('open').onclick = () => $('open-file').click();
$('open-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { loadPatch(JSON.parse(await f.text())); toast(`Opened ${f.name}`); } catch (err) { toast(`Couldn't open that: ${err.message}`); }
  e.target.value = '';
};

// ── tabs ────────────────────────────────────────────────
let tab = 'wall';
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $('code').classList.toggle('hidden', t !== 'code');
  if (t === 'code') code.show([...wall.selected][0] ?? null);
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
wall.addEventListener('open-code', (e) => { wall.select(e.detail.id); setTab('code'); });
wall.addEventListener('select', (e) => { if (tab === 'code') code.show(e.detail.ids[0] ?? null); });

$('add-btn').onclick = () => {
  setTab('wall');
  const r = $('wall').getBoundingClientRect();
  wall.openAdd(r.left + r.width / 2 - 170, r.top + 80);
};

const CABLE_MODES = ['Cables', 'Cables: faint', 'Cables: off'];
function cycleCables() {
  const m = (wall.cableMode + 1) % 3;
  wall.setCableMode(m);
  $('cables-btn').textContent = CABLE_MODES[m];
}
$('cables-btn').onclick = cycleCables;

// ── zoom ────────────────────────────────────────────────
const ZOOM_STEP = 1.3;
$('zoom-in').onclick = () => wall.zoomStep(ZOOM_STEP);
$('zoom-out').onclick = () => wall.zoomStep(1 / ZOOM_STEP);
$('zoom-level').onclick = () => { wall.glide(); wall.frameAll(); };
wall.addEventListener('view', (e) => { $('zoom-level').textContent = `${Math.round(e.detail.zoom * 100)} %`; });

// ── transport ───────────────────────────────────────────
async function togglePlay() {
  await host.start();
  host.setRunning(!host.running);
}
$('play').onclick = togglePlay;
host.addEventListener('transport', () => {
  $('play').textContent = host.running ? '■' : '▶';
  $('play').classList.toggle('playing', host.running);
});

// the tempo display drives the first Clock on the wall
const clockNode = () => [...graph.nodes.values()].find((n) => n.type === 'clock');
const tempo = $('tempo'), tc = tempo.getContext('2d');
let shownTempo = '';
function drawTempo() {
  const c = clockNode();
  const text = c ? c.params.bpm.toFixed(1).padStart(5, ' ') : '  ---';
  if (text === shownTempo) return;
  shownTempo = text;
  tc.clearRect(0, 0, tempo.width, tempo.height);
  drawSeg(tc, text, 16, 12, 36, '#ff4a2e');
}
let tempoDrag = null;
tempo.addEventListener('pointerdown', (e) => {
  const c = clockNode();
  if (!c) return;
  tempo.setPointerCapture(e.pointerId);
  tempoDrag = { y: e.clientY, bpm: c.params.bpm, c };
});
tempo.addEventListener('pointermove', (e) => {
  if (!tempoDrag) return;
  const bpm = Math.max(40, Math.min(240, tempoDrag.bpm + (tempoDrag.y - e.clientY) * (e.shiftKey ? 0.02 : 0.25)));
  graph.setParam(tempoDrag.c.id, 'bpm', Math.round(bpm * 10) / 10);
});
tempo.addEventListener('pointerup', () => { if (tempoDrag) { tempoDrag = null; graph.commit(); } });

// ── recording ───────────────────────────────────────────
let recStart = 0;
$('rec').onclick = async () => {
  if (host.recording) {
    const blob = await host.stopRecording();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `soundwerk-${Date.now()}.wav`;
    a.click();
    $('rec').classList.remove('recording');
    $('rec-time').classList.add('hidden');
    toast('Recording saved');
    return;
  }
  await host.start();
  host.startRecording();
  recStart = performance.now();
  $('rec').classList.add('recording');
  $('rec-time').classList.remove('hidden');
};

// ── files: dropped on a deck or sampler it goes there; anywhere else it gets a new deck ──
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('drop').classList.remove('hidden'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.add('hidden');
  const f = [...e.dataTransfer.files][0];
  if (!f) return;
  if (f.name.endsWith('.json')) { loadPatch(JSON.parse(await f.text())); return; }
  const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.mod');
  let node = under && graph.nodes.get(under.dataset.id);
  if (node?.type !== 'deck' && node?.type !== 'sampler') {
    node = graph.addNode('deck', 0, 0);
    wall.placeNear(node, wall.toWorld(e.clientX, e.clientY));
    graph.commit();
  }
  toast(`Loading ${f.name}…`);
  try {
    const buf = await loadInto(host, graph, node.id, f.name, await f.arrayBuffer());
    graph.commit();
    toast(buf.bpm ? `${f.name}: ${buf.bpm.toFixed(1)} BPM, the deck's 1/16 out follows its beat` : `${f.name} loaded`);
  } catch (err) { toast(`Couldn't load ${f.name}: ${err.message}`); }
});

// ── keyboard ────────────────────────────────────────────
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || menu.isOpen) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); chat.toggle(); }
  // ⌘+ and ⌘− would scale the whole page; on the wall they mean the wall
  else if (tab === 'wall' && (e.key === '+' || e.key === '=')) { e.preventDefault(); wall.zoomStep(ZOOM_STEP); }
  else if (tab === 'wall' && (e.key === '-' || e.key === '−')) { e.preventDefault(); wall.zoomStep(1 / ZOOM_STEP); }
  else if (tab === 'wall' && e.key === '0') { e.preventDefault(); wall.glide(); wall.frameAll(); }
  else if (tab === 'wall' && e.key === '1') { e.preventDefault(); wall.zoomReset(); }
  else if (tab === 'wall' && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const d = e.shiftKey ? 400 : 140;
    wall.panBy({ ArrowLeft: d, ArrowRight: -d }[e.key] ?? 0, { ArrowUp: d, ArrowDown: -d }[e.key] ?? 0);
  }
  else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? graph.redo() : graph.undo(); }
  else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); wall.duplicateSelected(); }
  else if (tab !== 'wall') return;
  else if (e.key === 'Tab') { e.preventDefault(); wall.openAdd(wall.pointer.x, wall.pointer.y); }
  else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); wall.deleteSelected(); }
  else if (e.key === 'f' || e.key === 'F') wall.frameAll();
  else if (e.key === 'c' || e.key === 'C') cycleCables();
  else if (e.key === 'Escape') wall.select(null);
});

// ── the loop ────────────────────────────────────────────
const mm = $('master-meter'), mc = mm.getContext('2d');
let hold = [0, 0];
function drawMeter() {
  const peaks = host.peaks;
  mc.clearRect(0, 0, mm.width, mm.height);
  for (let ch = 0; ch < 2; ch++) {
    const db = 20 * Math.log10(Math.max(peaks[ch], 1e-5));
    const t = Math.max(0, (db + 48) / 48);
    hold[ch] = Math.max(t, hold[ch] - 0.006);
    const y = 2 + ch * 17, h = 14;
    const W = mm.width;
    const g = mc.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#2fa84a'); g.addColorStop(0.75, '#a7c93a'); g.addColorStop(0.9, '#f0a12b'); g.addColorStop(1, '#ef4b52');
    mc.fillStyle = g;
    mc.fillRect(0, y, t * W, h);
    mc.fillStyle = '#fff';
    mc.fillRect(hold[ch] * W - 2, y, 2, h);
  }
}

let last = performance.now(), frames = 0, loadAt = last;
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  wall.tick(now, dt);
  drawTempo();
  drawMeter();
  if (host.recording) {
    const s = (now - recStart) / 1000;
    $('rec-time').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
  frames++;
  if (now - loadAt > 500) {
    const cpu = host.cpu * 100;
    const drops = host.ctx?.playbackStats?.underrunEvents ?? 0;
    const el = $('load');
    el.textContent = host.started ? `DSP ${cpu.toFixed(0)} %${drops ? ` · ${drops} drop${drops > 1 ? 's' : ''}` : ''}` : '';
    el.classList.toggle('warn', cpu > 50);
    el.classList.toggle('bad', cpu > 80 || drops > 0);
    frames = 0;
    loadAt = now;
  }
  requestAnimationFrame(loop);
}

// ── boot ────────────────────────────────────────────────
let saved = null;
try { saved = JSON.parse(localStorage.getItem(PATCH_KEY)); } catch { /* ignore */ }
loadPatch(saved?.nodes?.length ? saved : structuredClone(PRESETS[0].patch()));
requestAnimationFrame(loop);
