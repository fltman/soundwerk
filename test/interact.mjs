// npm run interact — drives the wall with a real mouse: patching, unplugging, turning knobs,
// moving modules, adding one, undoing, and painting a sequencer.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
// never the real one, which holds what a person taught it: and inside data/, to see it isn't served
const TASTE = fileURLToPath(new URL('../data/interact-taste.json', import.meta.url));
rmSync(TASTE, { force: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT), SOUNDWERK_TASTE: TASTE }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
// a 501 is how the server says this machine has no Demucs, and the browser logs every one
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('status of 501')) problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
await page.waitForTimeout(300);

const state = () => page.evaluate(() => {
  const { graph } = window.soundwerk;
  return { nodes: graph.nodes.size, links: graph.links.size };
});
const nodeOf = (type) => page.evaluate((t) => [...window.soundwerk.graph.nodes.values()].find((n) => n.type === t)?.id, type);
const center = (sel) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const jack = (id, port) => `.jack[data-node="${id}"][data-port="${port}"]`;
const drag = async (a, b) => {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(60);
};
let failed = false;
const step = async (name, fn) => {
  try { await fn(); console.log(`✓ ${name}`); } catch (e) { failed = true; console.log(`✗ ${name}: ${e.message}`); }
};

await page.evaluate(() => {
  // a small patch of its own, so the test doesn't change when the example patches do
  const { graph, wall } = window.soundwerk;
  const J = { nodes: [], links: [] };
  const add = (id, type, row, hp, data) => J.nodes.push({ id, type, row, hp, ...(data ? { data } : {}) });
  add('n1', 'clock', 0, 0); add('n2', 'bassline', 0, 10); add('n3', 'vco', 0, 44); add('n4', 'adsr', 0, 56);
  add('n5', 'vca', 0, 66); add('n6', 'scope', 1, 0); add('n7', 'master', 1, 30);
  const wire = (id, a, ap, b, bp) => J.links.push({ id, from: a, fromPort: ap, to: b, toPort: bp });
  wire('l1', 'n1', 's16', 'n2', 'clk'); wire('l2', 'n1', 'rst', 'n2', 'rst'); wire('l3', 'n2', 'pitch', 'n3', 'pitch');
  wire('l4', 'n2', 'gate', 'n4', 'gate'); wire('l5', 'n3', 'saw', 'n5', 'in'); wire('l6', 'n4', 'env', 'n5', 'cv');
  wire('l7', 'n5', 'out', 'n7', 'l'); wire('l8', 'n5', 'out', 'n6', 'a'); wire('l9', 'n4', 'env', 'n6', 'b');
  graph.load(J);
  graph.commit();
  wall.frameAll();
});
await page.waitForTimeout(200);
const vco = await nodeOf('vco'), amp = await nodeOf('vca'), master = await nodeOf('master');

await step('a cable dragged from output to input connects', async () => {
  const before = (await state()).links;
  await drag(await center(jack(vco, 'pulse')), await center(jack(master, 'r')));
  assert.equal((await state()).links, before + 1);
});

await step('grabbing a plugged input lifts the cable, dropping it on another jack moves it', async () => {
  await drag(await center(jack(master, 'r')), await center(jack(amp, 'cv')));
  const moved = await page.evaluate((id) => window.soundwerk.graph.linkInto(id, 'cv')?.fromPort, amp);
  assert.equal(moved, 'pulse');
});

await step('undo restores the cable as it was', async () => {
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(50);
  const l = await page.evaluate((id) => window.soundwerk.graph.linkInto(id, 'r')?.fromPort, master);
  assert.equal(l, 'pulse');
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(50);
});

await step('a knob turns with the mouse and the engine hears it', async () => {
  const dial = `.mod[data-id="${amp}"] .knob .dial`;
  const before = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).params.level, amp);
  const a = await center(dial);
  await drag(a, { x: a.x, y: a.y - 60 });
  const after = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).params.level, amp);
  assert.ok(after > before + 0.2, `${before} → ${after}`);
});

await step('double-click resets a knob', async () => {
  await page.locator(`.mod[data-id="${amp}"] .knob .dial`).first().dblclick();
  assert.equal(await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).params.level, amp), 1);
});

await step('a module drags along the rail by its name and pushes its neighbour', async () => {
  const title = `.mod[data-id="${vco}"]`;
  const box = await page.locator(title).boundingBox();
  const zoom = await page.evaluate(() => window.soundwerk.wall.view.zoom);
  const a = { x: box.x + box.width / 2, y: box.y + 12 * zoom };
  const was = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).hp, vco);
  await drag(a, { x: a.x + 45 * 2 * zoom, y: a.y });
  const now = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).hp, vco);
  assert.ok(now > was, `${was} → ${now}`);
  const overlap = await page.evaluate(() => {
    const { graph, wall } = window.soundwerk;
    const rows = new Map();
    for (const n of graph.nodes.values()) { if (!rows.has(n.row)) rows.set(n.row, []); rows.get(n.row).push([n.hp, n.hp + wall.views.get(n.id).panel.hp]); }
    for (const r of rows.values()) { r.sort((p, q) => p[0] - q[0]); for (let i = 1; i < r.length; i++) if (r[i][0] < r[i - 1][1]) return true; }
    return false;
  });
  assert.equal(overlap, false, 'modules overlap');
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(50);
});

await step('double-clicking a rail opens the menu, and search + enter adds the module', async () => {
  const before = (await state()).nodes;
  await page.mouse.dblclick(1600, 950);
  await page.waitForSelector('.add-menu:not(.hidden)');
  await page.keyboard.type('reverb');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  assert.equal((await state()).nodes, before + 1);
});

await step('a double-click on a cable unplugs it, and it never blocks the jack under it', async () => {
  const before = (await state()).links;
  const mid = await page.evaluate(() => {
    const { wall } = window.soundwerk;
    const r = wall.root.getBoundingClientRect();
    // a spot on some cable with no knob or jack underneath it
    for (const cv of wall.cables.values()) {
      const len = cv.core.getTotalLength();
      for (let f = 0.2; f < 0.9; f += 0.1) {
        const p = cv.core.getPointAtLength(len * f);
        const x = r.left + wall.view.x + p.x * wall.view.zoom, y = r.top + wall.view.y + p.y * wall.view.zoom;
        if (y < r.bottom && !document.elementFromPoint(x, y)?.closest('.ctl')) return { x, y };
      }
    }
    return null;
  });
  await page.mouse.dblclick(mid.x, mid.y);
  await page.waitForTimeout(60);
  assert.equal((await state()).links, before - 1);
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(50);
});

await step('a cable dropped on empty rail offers a module and patches it', async () => {
  const before = await state();
  const empty = await page.evaluate(() => {
    for (let y = 980; y > 500; y -= 20) for (let x = 1500; x > 100; x -= 40) {
      const e = document.elementFromPoint(x, y);
      if (e && !e.closest('.mod') && e.closest('.wall')) return { x, y };
    }
    return null;
  });
  await drag(await center(jack(amp, 'out')), empty);
  await page.waitForSelector('.add-menu:not(.hidden)');
  await page.keyboard.type('vu');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  const after = await state();
  assert.equal(after.nodes, before.nodes + 1);
  assert.equal(after.links, before.links + 1);
});

await step('delete removes a module and its cables', async () => {
  const before = await state();
  const cables = await page.evaluate(() => { const { graph, wall } = window.soundwerk; return graph.linksOf([...wall.selected][0]).length; });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  const after = await state();
  assert.equal(after.nodes, before.nodes - 1);
  assert.equal(after.links, before.links - cables);
});

await step('the note grid paints a note, and accent and slide lanes toggle', async () => {
  const seq = await nodeOf('bassline');
  const box = await page.locator(`.mod[data-id="${seq}"] .roll canvas`).boundingBox();
  const read = (k) => page.evaluate(([id, k2]) => window.soundwerk.graph.nodes.get(id).data.steps[k2], [seq, k]);
  // the second step is a rest by default
  const x = box.x + box.width * (0.0468 + (1.5 / 16) * 0.9532);
  await page.mouse.click(x, box.y + box.height * 0.3);
  const s = await read(1);
  assert.equal(s.g, 1);
  assert.ok(s.n > 12);
  await page.mouse.click(x, box.y + box.height * 0.9);
  assert.equal((await read(1)).a, 1);
});

await step('the DSP tab reads a module, and a fork takes its place and keeps its cables', async () => {
  const dbl = `.mod[data-id="${vco}"] .mod-title`;
  await page.locator(dbl).dblclick();
  await page.waitForSelector('#code:not(.hidden)');
  const text = await page.inputValue('#code-text');
  assert.match(text, /class VCO/);
  const links = await page.evaluate((id) => window.soundwerk.graph.linksOf(id).length, vco);
  await page.click('#code-fork');
  await page.waitForTimeout(100);
  const forked = await page.evaluate(() => {
    const n = [...window.soundwerk.graph.nodes.values()].find((x) => x.type === 'code');
    return n && window.soundwerk.graph.linksOf(n.id).length;
  });
  assert.equal(forked, links);
  await page.click('.tabs button[data-tab="wall"]');
});

await step('▶ makes sound, ■ silences the clocks', async () => {
  await page.click('#play');
  await page.waitForFunction(() => window.soundwerk.host.started);
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.soundwerk.host.running), true);
  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.soundwerk.host.running), false);
});

const outLevel = (type, port) => page.evaluate(async ([t, name]) => {
  const { graph, host } = window.soundwerk;
  const n = [...graph.nodes.values()].filter((x) => x.type === t).at(-1);
  const k = graph.def(n).outputs.findIndex((o) => o.name === name);
  let held = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 900) {
    held = Math.max(held, host.ui(n.id)[104 + k]);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return held;
}, [type, port]);

await step('a forked module really runs on the audio thread, compiled in the worklet', async () => {
  await page.keyboard.press('Space');
  const level = await outLevel('code', 'saw');
  assert.ok(level > 2, `the forked VCO's saw reaches ${level} V`);
});

await step('a Code module edited live changes what the wall hears', async () => {
  const id = await page.evaluate(() => {
    const { graph } = window.soundwerk;
    const n = graph.addNode('code', 3, 0, { code: '// out out "OUT"\nlet t = 0;\nfunction tick(i, o, p) { t += 440 / sr; o[0] = 7 * Math.sin(TAU * t); }' });
    const m = graph.addNode('vu', 3, 8);
    graph.connect(n.id, 'out', m.id, 'l');
    return n.id;
  });
  await page.waitForTimeout(300);
  assert.ok(Math.abs(await outLevel('code', 'out') - 7) < 0.1, 'first version');
  await page.evaluate((nid) => {
    window.soundwerk.graph.setCode(nid, '// out out "OUT"\nlet t = 0;\nfunction tick(i, o, p) { t += 440 / sr; o[0] = 3 * Math.sin(TAU * t); }');
  }, id);
  await page.waitForTimeout(300);
  const after = await outLevel('code', 'out');
  assert.ok(Math.abs(after - 3) < 0.1, `after the edit ${after}`);
});

await step('a Code module that throws stops alone: the wall keeps playing, and it can be fixed', async () => {
  const id = await page.evaluate(() => {
    const { graph } = window.soundwerk;
    const n = [...graph.nodes.values()].filter((x) => x.type === 'code').at(-1);
    graph.setCode(n.id, '// out out "OUT"\nfunction tick(i, o, p) { o[0] = nothing.here; }');
    return n.id;
  });
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('stopped'), null, { timeout: 3000 });
  assert.ok(await outLevel('adsr', 'env') > 1, 'the rest of the wall still plays');
  await page.evaluate((nid) => window.soundwerk.graph.setCode(nid, '// out out "OUT"\nlet t = 0;\nfunction tick(i, o, p) { t += 440 / sr; o[0] = 3 * Math.sin(TAU * t); }'), id);
  await page.waitForTimeout(300);
  assert.ok(Math.abs(await outLevel('code', 'out') - 3) < 0.1, 'a fix brings it back');
});

await step('a dropped audio file plays on a deck, and the beat grid comes out of its clock jack', async () => {
  const r = await page.evaluate(async () => {
    const { graph } = window.soundwerk;
    // four seconds at 120 BPM with a kick on every beat, as a real WAV file
    const sr = 44100, n = sr * 8, pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr, b = t % 0.5;
      pcm[i] = 24000 * Math.exp(-b * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-b * 40)) * b);
    }
    const head = new DataView(new ArrayBuffer(44));
    const str = (o, s) => { for (let i = 0; i < 4; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); head.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
    head.setUint32(24, sr, true); head.setUint32(28, sr * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
    str(36, 'data'); head.setUint32(40, n * 2, true);
    const file = await new Blob([head.buffer, pcm.buffer]).arrayBuffer();
    const deck = graph.addNode('deck', 3, 30);
    const seq = graph.addNode('vu', 3, 60);
    graph.connect(deck.id, 'l', seq.id, 'l');
    const buf = await window.soundwerk.loadInto(deck.id, 'test.wav', file);
    return { bpm: buf.bpm, grid: buf.grid.length, kicks: buf.kicks.length, id: deck.id };
  });
  assert.ok(Math.abs(r.bpm - 120) < 1, `heard ${r.bpm} BPM`);
  assert.ok(r.kicks >= 13, `${r.kicks} kicks`);
  assert.ok(await outLevel('deck', 'l') > 1, 'the file reaches the jack');
  assert.ok(await outLevel('deck', 's16') > -1, 'telemetry is alive');
});

await step('a track dropped on a Slicer is cut, and its grid plays by mouse', async () => {
  const r = await page.evaluate(async () => {
    const { graph, wall } = window.soundwerk;
    const sr = 44100, n = sr * 12, pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr, b = t % 0.5;
      pcm[i] = 24000 * Math.exp(-b * 18) * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-b * 40)) * b);
    }
    const head = new DataView(new ArrayBuffer(44));
    const str = (o, s) => { for (let i = 0; i < 4; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); head.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
    head.setUint32(24, sr, true); head.setUint32(28, sr * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
    str(36, 'data'); head.setUint32(40, n * 2, true);
    const node = graph.addNode('slicer', 4, 40);
    graph.commit();
    wall.frameAll();
    await new Promise((r) => setTimeout(r, 50));
    const box = document.querySelector(`.mod[data-id="${node.id}"]`).getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(new File([head.buffer, pcm.buffer], 'drop.wav', { type: 'audio/wav' }));
    const before = graph.nodes.size;
    // the same event the Finder sends, at the panel
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    return { id: node.id, before, at: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('.mod')?.dataset.id };
  });
  await page.waitForFunction((id) => window.soundwerk.host.buffers.has(id), r.id, { timeout: 15000 });
  await page.waitForFunction((id) => window.soundwerk.graph.nodes.get(id).data.pool.length > 0, r.id);
  const state = () => page.evaluate((id) => {
    const { graph, host } = window.soundwerk;
    const n = graph.nodes.get(id);
    return { size: graph.nodes.size, file: n.data.file, pool: n.data.pool.length, pads: [...n.data.pads], steps: [...n.data.steps], buffered: host.buffers.has(id) };
  }, r.id);
  const first = await state();
  assert.equal(r.at, r.id, 'the drop point is on the panel');
  assert.equal(first.size, r.before, 'no Track Deck appeared');
  assert.equal(first.file, 'drop.wav');
  assert.ok(first.pool > 8, `${first.pool} slices`);
  assert.equal(first.steps[0], 0, 'it starts on a bar');
  // a real click on row b, step 5, and on the label of row a
  await page.evaluate((id) => window.soundwerk.wall.select(id), r.id);
  const box = await page.locator(`.mod[data-id="${r.id}"] canvas.grid-canvas`).boundingBox();
  const LEFT = (75 / 470) * box.width, COL = (box.width - LEFT) / 16, ROW = box.height / 8;
  await page.mouse.click(box.x + LEFT + 4.5 * COL, box.y + 1.5 * ROW);
  const clicked = await state();
  assert.equal(clicked.steps[4], 1, 'row b, step 5');
  await page.mouse.click(box.x + 20, box.y + ROW * 0.5);
  const moved = await state();
  assert.notEqual(moved.pads[0], clicked.pads[0], 'the label moves the pad on');
  const pool = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).data.pool.map((s) => s.kind), r.id);
  assert.equal(pool[moved.pads[0]], pool[clicked.pads[0]], 'to a slice of the same kind');
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  const back = await state();
  assert.deepEqual([back.pads, back.steps], [first.pads, first.steps], 'undo takes both back');
  assert.ok(back.buffered, 'and keeps the file');
  await page.waitForTimeout(200);
  assert.ok(await page.isVisible(`.mod[data-id="${r.id}"] .wave-btn`), 'STEMS is on offer');
  await page.evaluate((id) => {
    const { graph, wall } = window.soundwerk;
    graph.removeNode(id);
    graph.commit();
    wall.select(null);
    wall.frameAll();
  }, r.id);
});

await step('the computer keyboard plays a selected MIDI module', async () => {
  const id = await page.evaluate(() => {
    const { graph, wall } = window.soundwerk;
    const n = graph.addNode('midi', 3, 80);
    const m = graph.addNode('vu', 3, 96);
    graph.connect(n.id, 'gate', m.id, 'l');
    wall.select(n.id);
    return n.id;
  });
  await page.waitForTimeout(200);
  await page.keyboard.down('a');
  const held = await outLevel('midi', 'gate');
  await page.keyboard.up('a');
  assert.equal(held, 10, 'gate high while the key is down');
  await page.evaluate(() => window.soundwerk.wall.select(null));
  void id;
});

await step('an Audio In module opens the input and the signal arrives', async () => {
  await page.evaluate(() => {
    const { graph } = window.soundwerk;
    const n = graph.addNode('audioin', 3, 110);
    const m = graph.addNode('vu', 3, 120);
    graph.connect(n.id, 'l', m.id, 'l');
  });
  await page.waitForFunction(() => window.soundwerk.host.micStream, null, { timeout: 5000 });
  await page.waitForTimeout(400);
  assert.ok(await outLevel('audioin', 'l') > 0.01, 'the fake microphone beeps');
});

await step('REC writes a real WAV of what is playing', async () => {
  const r = await page.evaluate(async () => {
    const { host } = window.soundwerk;
    host.startRecording();
    await new Promise((ok) => setTimeout(ok, 700));
    const blob = await host.stopRecording();
    const buf = await blob.arrayBuffer();
    const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
    const ctx = new OfflineAudioContext(2, 1, 48000);
    const decoded = await ctx.decodeAudioData(buf);
    return { head, seconds: decoded.duration, peak: Math.max(...decoded.getChannelData(0).subarray(0, 20000).map(Math.abs)) };
  });
  assert.equal(r.head, 'RIFF');
  assert.ok(r.seconds > 0.5 && r.seconds < 1.2, `${r.seconds} s`);
  assert.ok(r.peak > 0.01, `peak ${r.peak}`);
});

// ── getting close enough to read a panel ──

await page.evaluate(() => window.soundwerk.graph.commit());   // so the ⌘Z below only undoes its own drag
const view = () => page.evaluate(() => ({ ...window.soundwerk.wall.view }));
const nodePos = (id) => page.evaluate((nid) => { const n = window.soundwerk.graph.nodes.get(nid); return `${n.row}:${n.hp}`; }, id);
const scopeId = await nodeOf('scope');

await step('the + and − buttons zoom, and the readout follows', async () => {
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const a = await view();
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await page.waitForTimeout(300);
  const b = await view();
  assert.ok(b.zoom > a.zoom * 1.6, `${a.zoom} → ${b.zoom}`);
  assert.equal(await page.textContent('#zoom-level'), `${Math.round(b.zoom * 100)} %`);
  await page.click('#zoom-out');
  await page.waitForTimeout(300);
  assert.ok((await view()).zoom < b.zoom);
});

await step('+, −, ⌘+ and ⌘− on the keyboard zoom the wall, not the page', async () => {
  await page.mouse.click(5, 500);
  for (const [key, up] of [['+', true], ['-', false], ['Meta+=', true], ['Meta+-', false]]) {
    const before = (await view()).zoom;
    await page.keyboard.press(key);
    await page.waitForTimeout(40);
    const after = (await view()).zoom;
    assert.ok(up ? after > before : after < before, `${key}: ${before} → ${after}`);
  }
  assert.equal(await page.evaluate(() => window.visualViewport.scale), 1);
});

await step('pinch and ⌘-scroll zoom around the pointer', async () => {
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  for (const mod of ['Control', 'Meta']) {
    const a = await view();
    await page.mouse.move(700, 450);
    await page.keyboard.down(mod);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(80);
    await page.keyboard.up(mod);
    const b = await view();
    assert.ok(b.zoom > a.zoom, `${mod}: ${a.zoom} → ${b.zoom}`);
    // the point under the pointer stays put
    const ax = (700 - a.x) / a.zoom, bx = (700 - b.x) / b.zoom;
    assert.ok(Math.abs(ax - bx) < 1, `${ax} vs ${bx}`);
  }
});

await step('double-clicking a panel fills the screen with it, and again goes back', async () => {
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const wholeWall = await view();
  const box = await page.locator(`.mod[data-id="${scopeId}"]`).boundingBox();
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.62);
  await page.waitForTimeout(350);
  const close = await view();
  assert.ok(close.zoom > wholeWall.zoom * 1.5, `${wholeWall.zoom} → ${close.zoom}`);
  const inside = await page.locator(`.mod[data-id="${scopeId}"]`).boundingBox();
  assert.ok(inside.x >= 0 && inside.x + inside.width <= 1680 && inside.y >= 48 && inside.y + inside.height <= 1000, JSON.stringify(inside));
  // a label this close is big enough to read
  const px = await page.locator(`.mod[data-id="${scopeId}"] .knob .lbl`).first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize) * window.soundwerk.wall.view.zoom);
  assert.ok(px >= 11, `labels are ${px.toFixed(1)} px`);
  await page.mouse.dblclick(840, 780);
  await page.waitForTimeout(350);
  assert.ok(Math.abs((await view()).zoom - wholeWall.zoom) < 0.01, 'back to the whole wall');
});

await step('dragging a panel moves the view, not the module; dragging its name moves the module', async () => {
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  const box = await page.locator(`.mod[data-id="${scopeId}"]`).boundingBox();
  const before = await nodePos(scopeId), a = await view();
  await drag({ x: box.x + box.width * 0.5, y: box.y + box.height * 0.62 }, { x: box.x + box.width * 0.5 - 160, y: box.y + box.height * 0.62 - 60 });
  const b = await view();
  assert.equal(await nodePos(scopeId), before, 'the module stayed where it was');
  assert.ok(Math.abs(b.x - a.x + 160) < 2 && Math.abs(b.y - a.y + 60) < 2, 'the view followed');
  assert.ok(await page.evaluate((id) => window.soundwerk.wall.selected.has(id), scopeId), 'a panel you touch stays selected');
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  const moved = await page.locator(`.mod[data-id="${scopeId}"]`).boundingBox();
  const z = (await view()).zoom;
  await drag({ x: moved.x + moved.width / 2, y: moved.y + 14 * z }, { x: moved.x + moved.width / 2 + 120 * z, y: moved.y + 14 * z });
  assert.notEqual(await nodePos(scopeId), before, 'by its name it moves');
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(60);
});

await step('arrow keys walk along the wall', async () => {
  const a = await view();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(40);
  const b = await view();
  assert.ok(b.x < a.x && b.y < a.y);
});

await step('hovering a knob names the module and the knob, from any distance', async () => {
  await page.keyboard.press('f');
  await page.waitForTimeout(300);
  await page.locator(`.mod[data-id="${amp}"] .knob .dial`).first().hover({ force: true });
  await page.waitForTimeout(60);
  assert.match(await page.textContent('.tip'), /^VCA · LEVEL /);
  await page.mouse.move(5, 500);
});

// ── regressions from the independent review ──

await step('Escape leaves a typed value alone, and Enter applies it once without an error', async () => {
  const dial = `.mod[data-id="${amp}"] .knob .dial`;
  const read = () => page.evaluate((id) => window.soundwerk.graph.nodes.get(id).params.level, amp);
  const before = await read();
  await page.locator(dial).first().click({ button: 'right' });
  await page.keyboard.type('0.25');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(40);
  assert.equal(await read(), before);
  await page.locator(dial).first().click({ button: 'right' });
  await page.keyboard.type('0.25');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(40);
  assert.equal(await read(), 0.25);
});

await step('a key released after the MIDI module lost its selection still ends its note', async () => {
  await page.evaluate(() => { const { graph, wall } = window.soundwerk; wall.select([...graph.nodes.values()].find((n) => n.type === 'midi').id); });
  await page.keyboard.down('s');
  await page.evaluate(() => window.soundwerk.wall.select(null));
  await page.keyboard.up('s');
  assert.equal(await page.evaluate(() => window.soundwerk.devices.held.size), 0);
});

await step('dragging above the note grid stays on the grid', async () => {
  const seq = await nodeOf('bassline');
  const box = await page.locator(`.mod[data-id="${seq}"] .roll canvas`).boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y - 200, { steps: 4 });
  await page.mouse.up();
  const steps = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).data.steps.map((x) => x.n), seq);
  assert.ok(steps.every((n) => n >= 0 && n <= 24), steps.join(' '));
});

await step('undo updates the DSP editor, and focusing it does not bring the undone edit back', async () => {
  const id = await page.evaluate(() => {
    const { graph, wall } = window.soundwerk;
    const n = [...graph.nodes.values()].filter((x) => x.type === 'code').at(-1);
    graph.setCode(n.id, '// out out "OUT"\nfunction tick(i, o) { o[0] = 1; }');
    graph.commit();
    wall.select(n.id);
    return n.id;
  });
  await page.click('.tabs button[data-tab="code"]');
  await page.fill('#code-text', '// out out "OUT"\nfunction tick(i, o) { o[0] = 2; }');
  await page.locator('#code-text').blur();
  await page.waitForTimeout(450);
  await page.evaluate(() => window.soundwerk.graph.undo());
  await page.waitForTimeout(60);
  const shown = await page.inputValue('#code-text');
  assert.match(shown, /o\[0\] = 1/);
  await page.focus('#code-text');
  await page.locator('#code-text').blur();
  await page.waitForTimeout(60);
  const code = await page.evaluate((nid) => window.soundwerk.graph.nodes.get(nid).code, id);
  assert.match(code, /o\[0\] = 1/);
  await page.click('.tabs button[data-tab="wall"]');
});

await step('Master has no Fork button', async () => {
  await page.evaluate(() => { const { graph, wall } = window.soundwerk; wall.select(graph.masterNode().id); });
  await page.click('.tabs button[data-tab="code"]');
  assert.equal(await page.locator('#code-fork').isVisible(), false);
  await page.click('.tabs button[data-tab="wall"]');
});

await step('two files called kick.wav stay two files, and undo brings back the right one', async () => {
  const r = await page.evaluate(async () => {
    const { graph, host, loadInto } = window.soundwerk;
    const wav = (hz) => {
      const sr = 48000, n = sr / 4, pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = 20000 * Math.sin((2 * Math.PI * hz * i) / sr);
      const h = new DataView(new ArrayBuffer(44));
      const str = (o, x) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, x.charCodeAt(i)); };
      str(0, 'RIFF'); h.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); h.setUint32(16, 16, true);
      h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, sr, true); h.setUint32(28, sr * 2, true);
      h.setUint16(32, 2, true); h.setUint16(34, 16, true); str(36, 'data'); h.setUint32(40, n * 2, true);
      return new Blob([h.buffer, pcm.buffer]).arrayBuffer();
    };
    // rising zero crossings in a quarter of a second, to the nearest hundred hertz
    const pitch = (buf) => { let c = 0; for (let i = 1; i < buf.L.length; i++) if (buf.L[i - 1] < 0 && buf.L[i] >= 0) c++; return Math.round((c * 4) / 100) * 100; };
    const a = graph.addNode('sampler', 4, 0), b = graph.addNode('sampler', 4, 20);
    await loadInto(a.id, 'kick.wav', await wav(100));
    await loadInto(b.id, 'kick.wav', await wav(800));
    graph.commit();
    const first = [pitch(host.buffers.get(a.id)), pitch(host.buffers.get(b.id))];
    await loadInto(a.id, 'snare.wav', await wav(400));
    graph.commit();
    const swapped = pitch(host.buffers.get(a.id));
    graph.undo();
    await new Promise((ok) => setTimeout(ok, 400));
    const back = [pitch(host.buffers.get(a.id)), pitch(host.buffers.get(b.id))];
    return { first, swapped, back };
  });
  assert.deepEqual(r.first, [100, 800]);
  assert.equal(r.swapped, 400);
  assert.deepEqual(r.back, [100, 800], 'undo restores the file by content');
});

await step('a duplicated sampler keeps its sound', async () => {
  const has = await page.evaluate(async () => {
    const { graph, host, wall } = window.soundwerk;
    const s = [...graph.nodes.values()].filter((n) => n.type === 'sampler')[0];
    wall.select(s.id);
    wall.duplicateSelected();
    const copy = [...wall.selected][0];
    return host.buffers.has(copy) && copy !== s.id;
  });
  assert.ok(has);
});

await step('a playlist dropped on a Set is measured, planned by the assistant, heard and played from its panel', async () => {
  // a machine without Demucs: the set still works, with samples of the whole mix
  await page.route('**/api/stems', (route) => route.fulfill({ status: 501, json: { error: 'Demucs is not installed' } }));
  // a stand-in for the assistant: it wires the Set into the rack, then sends a plan, then says it's done
  let rounds = 0, asked = '', answered = '', fix = null, later = null;
  await page.route('**/api/chat', async (route) => {
    const call = (name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [{ id: `c${rounds}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish: 'tool_calls' });
    const { clock, set, out } = await page.evaluate(() => {
      const { graph } = window.soundwerk, of = (t) => [...graph.nodes.values()].find((n) => n.type === t)?.id;
      return { clock: of('clock'), set: of('set'), out: of('master') };
    });
    rounds++;
    if (rounds === 1) return route.fulfill({ json: call('edit_patch', { operations: [{ op: 'add', type: 'djmix', ref: 'mix' }, { op: 'connect', from: set, from_port: 'l', to: 'mix', to_port: 'bL' }, { op: 'connect', from: set, from_port: 'r', to: 'mix', to_port: 'bR' }, { op: 'set', id: 'mix', params: { fade: 1, lows: 1 } }, { op: 'connect', from: 'mix', from_port: 'l', to: out, to_port: 'l' }, { op: 'connect', from: 'mix', from_port: 'r', to: out, to_port: 'r' }] }) });
    if (rounds === 2) return route.fulfill({ json: call('set_plan', { brief: 'a test set', arc: [{ name: 'transition', bars: 44 }], tracks: [{ track: 0, at: 0, enter: 8, leave: 24 }, { track: 1, at: 20, enter: 8, leave: 24 }], moves: [{ at: 0, ops: [{ op: 'set', id: clock, params: { bpm: 120 } }] }, { at: 16, glide: 4, why: 'on to the next tempo', ops: [{ op: 'set', id: clock, params: { bpm: 124 } }] }] }) });
    if (rounds === 4) {
      fix = route.request().postDataJSON();
      asked = fix.messages.at(-1).content;
      return route.fulfill({ json: call('edit_plan', { remove: [1], add: [{ at: 26, glide: 2, why: 'quicker', ops: [{ op: 'set', id: clock, params: { bpm: 124 } }] }], brief: 'the same set, mended' }) });
    }
    if (rounds === 5) answered = route.request().postDataJSON().messages.at(-1).content;
    if (rounds === 6) later = route.request().postDataJSON();
    return route.fulfill({ json: { message: { role: 'assistant', content: 'The set is planned.' }, finish: 'stop' } });
  });
  await page.selectOption('#examples', { label: 'Empty wall' });
  await page.waitForFunction(() => window.soundwerk.graph.nodes.size === 1);
  const id = await page.evaluate(async () => {
    const { graph, wall } = window.soundwerk;
    const wav = (name, bpm) => {
      const sr = 44100, n = sr * 70, pcm = new Int16Array(n), beat = 60 / bpm;
      for (let i = 0; i < n; i++) {
        const t = i / sr, b = t % beat, gone = t > 32 * beat && t < 48 * beat;   // a break to give it a shape
        pcm[i] = (gone ? 0 : 20000 * Math.exp(-b * 14) * Math.sin(2 * Math.PI * (50 + 150 * Math.exp(-b * 45)) * b)) + 4000 * Math.sin(2 * Math.PI * 110 * t);
      }
      const head = new DataView(new ArrayBuffer(44));
      const str = (o, s) => { for (let i = 0; i < 4; i++) head.setUint8(o + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); head.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
      head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true);
      head.setUint32(24, sr, true); head.setUint32(28, sr * 2, true); head.setUint16(32, 2, true); head.setUint16(34, 16, true);
      str(36, 'data'); head.setUint32(40, n * 2, true);
      return new File([head.buffer, pcm.buffer], name, { type: 'audio/wav' });
    };
    const node = graph.addNode('set', 1, 0);
    graph.commit();
    wall.frameAll();
    await new Promise((r) => setTimeout(r, 50));
    const box = document.querySelector(`.mod[data-id="${node.id}"]`).getBoundingClientRect();
    const transfer = new DataTransfer();
    transfer.items.add(wav('2 second.wav', 124));   // out of order, as a Finder selection can be
    transfer.items.add(wav('1 first.wav', 120));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    return node.id;
  });
  const read = () => page.evaluate((x) => {
    const { graph, conductor, host } = window.soundwerk, d = graph.nodes.get(x).data;
    return { files: d.tracks.map((t) => t.file), bpm: d.tracks.map((t) => t.bpm), plan: d.plan, set: conductor.running, running: host.running };
  }, id);
  await page.waitForFunction((x) => window.soundwerk.graph.nodes.get(x).data.tracks.length === 2, id, { timeout: 30000 });
  const dropped = await read();
  assert.deepEqual(dropped.files, ['1 first.wav', '2 second.wav'], 'in the order of their names');
  assert.ok(Math.abs(dropped.bpm[0] - 120) < 1 && Math.abs(dropped.bpm[1] - 124) < 1, dropped.bpm.join());
  assert.equal(await page.locator(`.mod[data-id="${id}"] .set-play`).isVisible(), false, 'nothing to play before there is a plan');
  await page.evaluate((x) => window.soundwerk.wall.select(x), id);
  await page.locator(`.mod[data-id="${id}"] .set-plan`).click();
  await page.waitForFunction((x) => window.soundwerk.graph.nodes.get(x).data.plan && !window.soundwerk.chat.busy, id, { timeout: 60000 });
  const planned = await read();
  assert.equal(planned.plan.brief, 'a test set');
  assert.equal(rounds, 3, 'the assistant was asked, and it read the answer of the render');
  assert.ok(await page.evaluate(() => window.soundwerk.chat.history.some((m) => m.role === 'tool' && /LUFS by bar/.test(m.content))), 'what was measured went back to it');
  await page.locator(`.mod[data-id="${id}"] .set-play`).click();
  await page.waitForFunction(() => window.soundwerk.conductor.running && window.soundwerk.conductor.step > 8, null, { timeout: 15000 });
  assert.ok((await page.evaluate(() => Math.max(...window.soundwerk.host.peaks))) > 0.01, 'it can be heard');
  // the chart: a click goes to a bar, and the set plays on from there
  await page.evaluate(() => window.soundwerk.wall.frameAll());
  await page.waitForTimeout(400);
  const chart = page.locator(`.mod[data-id="${id}"] canvas`).first();
  const box = await chart.boundingBox(), side = 16 / (await chart.evaluate((c) => c.width));
  const xOf = (bar) => box.x + box.width * (side + (bar / 44) * (1 - 2 * side)), y = box.y + box.height * 0.3;
  await page.mouse.click(xOf(30), y);
  await page.waitForFunction(() => window.soundwerk.conductor.at === 30 * 16 && window.soundwerk.conductor.step >= 30 * 16, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => Math.abs(window.soundwerk.conductor.base % 16)), 0, 'it landed on a bar');
  assert.equal(await page.evaluate((x) => window.soundwerk.host.ui(x)[0], id), 1, 'the track it landed in plays');
  // a drag marks a stretch: it opens the chat and leaves the music alone
  await page.mouse.move(xOf(22), y);
  await page.mouse.down();
  await page.mouse.move(xOf(24), y, { steps: 4 });
  await page.mouse.move(xOf(26), y, { steps: 4 });
  await page.mouse.up();
  const marked = () => page.evaluate(() => { const { conductor } = window.soundwerk; return { mark: conductor.mark, cursor: conductor.cursor, at: conductor.at, running: conductor.running }; });
  const hold = await marked();
  assert.deepEqual(hold.mark, { from: 22, to: 26 });
  assert.equal(hold.at, 30 * 16, 'the set stayed where it was');
  assert.equal(hold.running, true);
  assert.match(await page.locator('#chat-mark').textContent(), /Bars 22–26/);
  await page.fill('#chat-input', 'the hats are too loud here');
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction((x) => window.soundwerk.graph.nodes.get(x).data.plan.brief === 'the same set, mended' && !window.soundwerk.chat.busy, id, { timeout: 60000 });
  assert.match(asked, /\[Marked: bars 22-26 of the set/);
  assert.match(asked, /Track 1 "2 second\.wav"/);
  assert.match(asked, /the set on bar \d+/);
  assert.match(asked, /the hats are too loud here$/);
  assert.equal(fix.effort, 'low', 'a fix is a small job');
  assert.match(answered, /What touches bars 16-28 was rendered again/);
  assert.equal(await page.evaluate((x) => window.soundwerk.graph.nodes.get(x).data.plan.moves.length, id), 2, 'one out, one in');
  assert.ok(!(await page.evaluate((x) => window.soundwerk.graph.nodes.get(x).data.plan.home.some((h) => h[3] === undefined), id)), 'home stays whole');
  const after = await marked();
  assert.equal(after.mark, null);
  assert.equal(after.running, false, 'a new plan is made from the wall at home');
  assert.equal(after.cursor, 22 * 16);
  assert.equal(await page.locator('#chat-mark').isVisible(), false);
  // ▶ SET goes back to the stretch that was mended
  await page.locator(`.mod[data-id="${id}"] .set-play`).click();
  await page.waitForFunction(() => window.soundwerk.conductor.running && window.soundwerk.conductor.at === 22 * 16 && window.soundwerk.conductor.step >= 22 * 16, null, { timeout: 15000 });
  await page.locator(`.mod[data-id="${id}"] .set-play`).click();
  await page.waitForFunction(() => !window.soundwerk.conductor.running, null, { timeout: 5000 });
  assert.equal((await read()).running, false);
  // the next message doesn't pay for the last one again
  await page.fill('#chat-input', 'thanks');
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => !window.soundwerk.chat.busy, null, { timeout: 15000 });
  const strings = later.messages.map((m) => (typeof m.content === 'string' ? m.content : ''));
  assert.equal(strings.filter((c) => c.includes('The plan of the set in full')).length, 1, 'one patch, the latest');
  assert.ok(later.messages.at(-1).content.includes('The plan of the set in full'));
  assert.ok(strings.filter((_, i) => later.messages[i].role === 'tool').every((c) => c.length < 410), 'old answers are short');
  assert.ok(later.messages.flatMap((m) => m.tool_calls ?? []).every((c) => c.function.arguments.length < 410), 'and so are old calls');
  assert.equal(later.effort, 'medium');
  await page.unroute('**/api/chat');
  // teaching: three versions as sound, the prediction sealed, and what was picked goes in the plan
  let asks = [], bad = true, most = 3;
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON(), last = body.messages.at(-1).content;
    asks.push(body);
    const turn = /^Nothing was offered/.test(last) ? body.messages.findLast((m) => m.role === 'user').content : last;
    const name = /leg (\d+), side (in|out)/.exec(turn);
    const reply = (m) => route.fulfill({ json: { message: { role: 'assistant', ...m }, finish: m.tool_calls ? 'tool_calls' : 'stop', usage: { cost: 0 } } });
    if (!name) return reply({ content: 'All of it is done.' });
    const { mix } = await page.evaluate(() => ({ mix: [...window.soundwerk.graph.nodes.values()].find((n) => n.type === 'djmix').id }));
    const bar = { '0:in': 1, '0:out': 14, '1:in': 22, '1:out': 34 }[`${name[1]}:${name[2]}`];
    const options = [0.2, 0.5, 0.9].slice(0, most).map((fade, i) => ({ title: `version ${i}`, idea: `the fader at ${fade}`, add: [{ at: bad ? 9999 : bar, glide: 0, why: `v${i}`, ops: [{ op: 'set', id: mix, params: { fade } }] }] }));
    bad = false;
    return reply({ content: 'I would go for the second one.', blocks: [{ type: 'thinking', thinking: '', signature: 'sealed' }], tool_calls: [{ id: `o${asks.length}`, type: 'function', function: { name: 'offer_transition', arguments: JSON.stringify({ leg: +name[1], side: name[2], options, best: most === 1 ? 0 : 1, why: 'they like it in the middle', notes: ['likes the middle'] }) } }] });
  });
  const card = () => page.locator('.chat-item.offer').last();
  const offered = (n) => page.waitForFunction((k) => !window.soundwerk.chat.busy && document.querySelectorAll('.chat-item.offer').length === k, n, { timeout: 60000 });
  const teaching = () => page.evaluate((x) => { const { graph, chat } = window.soundwerk, plan = graph.nodes.get(x).data.plan; return { taught: plan.taught ?? [], moves: plan.moves.map((m) => m.why), rounds: chat.taste.rounds, notes: chat.taste.notes, order: chat.round?.order }; }, id);
  await page.locator(`.mod[data-id="${id}"] .set-teach`).click();
  await offered(1);
  assert.equal(asks.length, 3, 'what could not be played never reached the user, and what measured wrong went back once');
  assert.match(asks[1].messages.at(-1).content, /Nothing was offered\. Fix these/);
  assert.match(asks[2].messages.at(-1).content, /Nothing was offered yet\. A version has a ✗/);
  assert.match(await card().locator('.offer-flag').first().textContent(), /^The render flagged: .*(silent|hole|meet)/, 'and what the assistant let stand says what it was, on the version');
  assert.equal(asks[0].effort, 'low');
  assert.equal(await card().locator('audio').count(), 3);
  assert.doesNotMatch(await page.locator('#chat-log').textContent(), /second one|in the middle/, 'the prediction stays sealed');
  const clips = await card().evaluate(async (el) => Promise.all([...el.querySelectorAll('audio')].map(async (a) => {
    const bytes = await (await fetch(a.src)).arrayBuffer(), pcm = new Float32Array(bytes, 44);
    await new Promise((r) => { if (a.readyState >= 1) r(); else a.addEventListener('loadedmetadata', r, { once: true }); });
    return { seconds: a.duration, peak: pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0), sum: pcm.reduce((m, v) => m + Math.abs(v), 0) };
  })));
  assert.ok(clips.every((c) => c.seconds > 5 && c.peak > 0.01), JSON.stringify(clips));
  assert.ok(new Set(clips.map((c) => c.seconds.toFixed(3))).size === 1, 'the same bars of each');
  assert.ok(new Set(clips.map((c) => c.sum.toFixed(0))).size === 3, 'and they sound different');
  // the second player takes over from the same moment, and the set stops for it
  await page.evaluate(() => window.soundwerk.host.setRunning(true));
  const moved = await card().evaluate(async (el) => {
    const [a, b] = el.querySelectorAll('audio');
    await a.play();
    a.currentTime = 3;
    await new Promise((r) => setTimeout(r, 300));
    await b.play();
    await new Promise((r) => setTimeout(r, 100));
    const out = { a: a.paused, at: b.currentTime };
    b.pause();
    return out;
  });
  assert.equal(moved.a, true, 'one at a time');
  assert.ok(moved.at >= 3, `it went on from ${moved.at}`);
  assert.equal((await read()).running, false, 'the rack stops to let it be heard');
  // a pick with a reason: it goes in the plan, the prediction opens, and the next transition comes
  const first = await teaching(), letter = first.order.indexOf(2);
  await page.fill('#chat-input', 'more of it');
  await card().getByRole('button', { name: `Pick ${'ABC'[letter]}` }).click();
  await page.waitForFunction(() => document.querySelector('.offer-said')?.textContent.includes('have been fine too'));
  assert.equal(await card().getByRole('button', { name: /^Pick/ }).count(), 0, 'it can only be picked once');
  assert.match(await card().textContent(), /they like it in the middle/, 'the prediction opens with the pick');
  assert.equal((await teaching()).rounds.length, 0, 'and nothing is scored until they have said if it would have done');
  await card().getByRole('button', { name: 'No' }).click();
  await offered(2);
  const picked = await teaching();
  assert.deepEqual(picked.taught, ['0:in']);
  assert.ok(picked.moves.includes('v2'));
  assert.deepEqual(picked.notes, ['likes the middle']);
  assert.deepEqual([picked.rounds[0].pick, picked.rounds[0].best, picked.rounds[0].why], [2, 1, 'more of it']);
  const opened = await page.locator('.chat-item.offer').first().textContent();
  assert.match(opened, /they like it in the middle/);
  assert.match(opened, /We agree on 0 of the last 1, and it takes 18 of 20/);
  assert.equal(await page.locator('.chat-item.offer').first().getByRole('button').count(), 0, 'and it can only be picked once');
  const said = () => asks.at(-1).messages.findLast((m) => m.role === 'user').content;
  const told = said();
  assert.match(told, /\[Picked: your option 2\. You predicted option 1, and that one would not have done\. They said: more of it\]/);
  assert.match(told, /What this user has taught you, from 1 picks/);
  assert.ok(asks[2].messages.some((m) => m.blocks), 'thinking goes back within a turn');
  const newest = asks.at(-1).messages, turn = newest.findLastIndex((m) => m.role === 'user');
  assert.ok(!newest.slice(0, turn).some((m) => m.blocks), 'and not into the next one, where the turn before has been shortened');
  assert.match(told, /Transition 2 of 4: the way out of "1 first", leg 0, side out/);
  // looked at first, it doesn't count
  await card().getByRole('button', { name: 'Show the recommendation' }).click();
  assert.match(await card().textContent(), /they like it in the middle.*won't count/);
  await card().getByRole('button', { name: `Pick ${'ABC'[(await teaching()).order.indexOf(1)]}` }).click();
  await offered(3);
  const looked = await teaching();
  assert.equal(looked.rounds[1].peeked, true);
  assert.match(await page.locator('.chat-item.offer').nth(1).textContent(), /doesn't count, because you looked first\. We agree on 0 of the last 1/);
  assert.equal(await page.evaluate(() => window.soundwerk.chat.taste.rounds.filter((r) => !r.peeked).length), 1);
  // none of them: the plan stays, and the same transition comes again
  await page.fill('#chat-input', 'too polite');
  await card().getByRole('button', { name: 'None of them' }).click();
  await offered(4);
  const none = await teaching();
  assert.deepEqual(none.taught, looked.taught);
  assert.deepEqual(none.moves, looked.moves);
  assert.equal(none.rounds[2].pick, null);
  assert.match(said(), /\[None of them: they turned down all three versions of the way into "2 second"\. You predicted option 1\. They said: too polite\]/);
  assert.match(said(), /Transition 3 of 4/);
  // eighteen of twenty: it offers to do the rest instead of asking, and only then
  await page.evaluate(() => { const { chat } = window.soundwerk, r = chat.taste.rounds[0]; chat.learned({ ...chat.taste, rounds: Array.from({ length: 20 }, (_, k) => ({ ...r, pick: k === 5 ? 2 : 1 })) }); });
  const waited = asks.length;
  most = 3;
  await card().getByRole('button', { name: `Pick ${'ABC'[(await teaching()).order.indexOf(0)]}` }).click();
  await card().getByRole('button', { name: 'Yes, fine' }).click();
  await page.waitForSelector('.chat-item.trust');
  assert.equal((await teaching()).rounds.at(-1).fine, true);
  assert.equal(asks.length, waited, 'no call to the assistant until the user has said');
  assert.match(await page.locator('.chat-item.trust').textContent(), /19 of the last 20.*1 transition left/);
  most = 1;
  await page.getByRole('button', { name: 'Do the rest' }).click();
  await page.waitForFunction(() => !window.soundwerk.chat.busy, null, { timeout: 60000 });
  const done = await teaching();
  assert.deepEqual(done.taught, ['0:in', '0:out', '1:in', '1:out'], 'every transition has been made');
  assert.equal(await page.locator('.chat-item.offer').count(), 4, 'with nothing to pick from');
  assert.match(await page.locator('#chat-log').textContent(), /All of it is done/);
  await page.evaluate(() => window.soundwerk.chat.writing);
  assert.equal(JSON.parse(readFileSync(TASTE, 'utf8')).rounds.length, 21, 'every pick is on disk');
  await page.unroute('**/api/chat');
  await page.unroute('**/api/stems');
  await page.evaluate(() => { const { chat } = window.soundwerk; chat.reset(); chat.learned({ notes: [], rounds: [] }); });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('soundwerk.chat.v1')).items.length), 0);
});

await step('a MIDI control learned onto a knob turns it, and a MIDI Out plays through the port with the time of the sound', async () => {
  const sent = await page.evaluate(async () => {
    const { graph, host, devices } = window.soundwerk;
    const heard = [], port = { name: 'Fake Port', send: (data, when) => heard.push({ data, when, now: performance.now() }) };
    devices.midi = { inputs: new Map(), outputs: new Map([['p', port]]) };
    devices.asked = Promise.resolve();
    window.fakeMidi = heard;
    await host.start();
    host.setRunning(true);
    const clock = [...graph.nodes.values()].find((n) => n.type === 'clock');
    const out = graph.addNode('midiout', 3, 0);
    graph.connect(clock.id, 's16', out.id, 'clk');
    graph.connect(clock.id, 's16', out.id, 'gate');
    graph.commit();
    return out.id;
  });
  await page.waitForFunction(() => window.fakeMidi.length > 12);
  const out = await page.evaluate(() => window.fakeMidi.slice(0, 40).map(({ data, when, now }) => ({ status: data[0], ahead: when - now })));
  assert.ok(out.some((e) => e.status === 0xf8), 'no clock');
  assert.ok(out.some((e) => e.status === 0x90), 'no note');
  assert.ok(out.every((e) => e.ahead > -50 && e.ahead < 250), `stamped ${out.map((e) => Math.round(e.ahead))} ms ahead`);
  await page.evaluate(() => window.soundwerk.host.setRunning(false));

  const master = await page.evaluate(() => [...window.soundwerk.graph.nodes.values()].find((n) => n.type === 'master').id);
  await page.locator(`.mod[data-id="${master}"] .dial`).first().click({ button: 'right' });
  await page.locator('.value-learn').click();
  await page.waitForFunction(() => window.soundwerk.devices.learning);
  const moved = await page.evaluate((id) => {
    const { graph, devices } = window.soundwerk;
    devices.heard('Fake Port', [0xb0, 21, 127]);
    const key = Object.keys(graph.midiMap)[0], { name } = graph.midiMap[key];
    devices.heard('Fake Port', [0xb0, 21, 0]);
    const low = graph.nodes.get(id).params[name];
    devices.heard('Fake Port', [0xb0, 21, 127]);
    return { key, low, high: graph.nodes.get(id).params[name], saved: graph.toJSON().midiMap[key].name === name };
  }, master);
  assert.equal(moved.key, '0:21');
  assert.ok(moved.high > moved.low, 'the knob did not follow');
  assert.ok(moved.saved, 'it is not in the patch');
  await page.evaluate((id) => {
    const { graph, devices } = window.soundwerk;
    graph.removeNode(id);
    graph.midiMap = {};
    graph.commit();
    devices.midi = null;
    devices.asked = null;
  }, sent);
});

await step('what it learned is a file on disk, that any browser reads and nothing else writes over', async () => {
  const onDisk = () => JSON.parse(readFileSync(TASTE, 'utf8'));
  const loaded = async (p = page) => { await p.waitForFunction(() => window.soundwerk?.chat?.tasteLoaded); await p.evaluate(async () => { await window.soundwerk.chat.tasteLoaded; await window.soundwerk.chat.writing; }); };
  const round = { transition: 'the way into "x"', options: [{ title: 'a', idea: 'b' }], best: 0, pick: 0, why: '' }, noted = problems.length;
  // what was taught before there was a file moves there, and leaves the browser
  rmSync(TASTE);
  await page.evaluate((r) => localStorage.setItem('soundwerk.taste.v1', JSON.stringify({ notes: ['from before'], rounds: [r] })), round);
  await page.reload();
  await loaded();
  assert.deepEqual(onDisk().notes, ['from before']);
  assert.equal(onDisk().rounds.length, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('soundwerk.taste.v1')), null);
  assert.match(readFileSync(TASTE, 'utf8'), /\n {2}"notes"/, 'readable');
  // another browser, at the other address, knows it too
  const other = await browser.newPage();
  await other.goto(`http://127.0.0.1:${PORT}/`);
  await loaded(other);
  assert.deepEqual(await other.evaluate(() => window.soundwerk.chat.taste.notes), ['from before']);
  await other.close();
  // a file that was deleted stays deleted: nothing in the browser brings it back
  rmSync(TASTE);
  await page.reload();
  await loaded();
  assert.equal(await page.evaluate(() => window.soundwerk.chat.taste.rounds.length), 0);
  assert.equal(existsSync(TASTE), false);
  // the server is away: the browser holds on to it, and hands it over later
  await page.route('**/api/taste', (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()));
  await page.evaluate((r) => window.soundwerk.chat.learned({ notes: ['held'], rounds: [r] }), round);
  await page.evaluate(() => window.soundwerk.chat.writing);
  assert.equal(existsSync(TASTE), false);
  await page.unroute('**/api/taste');
  await page.reload();
  await loaded();
  assert.deepEqual(onDisk().notes, ['held']);
  // a file someone broke by hand is left alone
  writeFileSync(TASTE, '{ my own notes');
  await page.reload();
  await loaded();
  assert.match(await page.locator('#toast').textContent(), /not valid JSON/);
  await page.evaluate((r) => window.soundwerk.chat.learned({ notes: ['later'], rounds: [r, r] }), round);
  await page.evaluate(() => window.soundwerk.chat.writing);
  assert.equal(readFileSync(TASTE, 'utf8'), '{ my own notes');
  await page.evaluate(() => localStorage.removeItem('soundwerk.taste.v1'));
  rmSync(TASTE);
  await page.reload();
  await loaded();
  const caused = problems.splice(noted);
  assert.equal(caused.length, 2, caused.join());
  assert.match(caused[0], /ERR_FAILED/, 'the save that was blocked');
  assert.match(caused[1], /status of 500/, 'and the file that was broken');
});

await step('a demo opened by link leaves the saved wall alone', async () => {
  await page.waitForTimeout(500);   // the wall's own save
  const mine = await page.evaluate(() => localStorage.getItem('soundwerk.patch.v1'));
  assert.ok(mine, 'there is a saved wall to lose');
  await page.route((url) => url.pathname === '/demo/fixture.json', (route) => route.fulfill({ json: { version: 1, nodes: [{ id: 'n1', type: 'master' }, { id: 'n2', type: 'clock' }], links: [] } }));
  await page.goto(`http://localhost:${PORT}/?patch=/demo/fixture.json`);
  await page.waitForFunction(() => window.soundwerk?.graph.nodes.size === 2);
  await page.evaluate(() => { const { graph } = window.soundwerk; graph.addNode('lfo'); graph.commit(); });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => localStorage.getItem('soundwerk.patch.v1')), mine);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
  assert.equal(await page.evaluate(() => JSON.stringify(window.soundwerk.graph.toJSON().nodes.map((n) => n.id))), JSON.stringify(JSON.parse(mine).nodes.map((n) => n.id)), 'and it comes back');
});

await step('the server refuses a foreign Host, a cross-site chat call, and private folders', async () => {
  const base = `http://localhost:${PORT}`;
  const json = { 'Content-Type': 'application/json' };
  const chat = (headers) => fetch(`${base}/api/chat`, { method: 'POST', headers, body: '{"messages":[]}' }).then((r) => r.status);
  assert.equal(await chat({ 'Content-Type': 'text/plain' }), 403);
  assert.equal(await chat({ ...json, Origin: 'https://evil.example' }), 403);
  // stems start a Python process, so a page elsewhere must not reach them either
  const stems = (headers) => fetch(`${base}/api/stems`, { method: 'POST', headers, body: 'x' }).then((r) => r.status);
  assert.equal(await stems({ 'Content-Type': 'text/plain' }), 403);
  assert.equal(await stems({ 'Content-Type': 'application/octet-stream', Origin: 'https://evil.example' }), 403);
  for (const path of ['/api/stems/..%2f..%2fserver.mjs', `/api/stems/${'a'.repeat(64)}/secrets`, `/api/stems/${'a'.repeat(64)}/drums`, '/tools/stems/.cache/x', '/tools/stems/.venv/pyvenv.cfg']) {
    assert.notEqual((await fetch(base + path)).status, 200, path);
  }
  writeFileSync(TASTE, '{"notes":[],"rounds":[]}');
  for (const path of ['/.git/HEAD', '/.gitignore', '/vault/Home.md', '/VAULT/Home.md', '/node_modules/playwright/package.json', '/NODE_MODULES/playwright/package.json', '/data/interact-taste.json', '/DATA/interact-taste.json']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const put = (headers, body = '{"notes":[],"rounds":[]}') => fetch(`${base}/api/taste`, { method: 'PUT', headers, body }).then((r) => r.status);
  assert.equal(await put({ 'Content-Type': 'text/plain' }), 403);
  assert.equal(await put({ ...json, Origin: 'https://evil.example' }), 403);
  assert.equal(await put(json, '{"notes":"x"}'), 400);
  assert.equal(await put(json), 200);
  rmSync(TASTE);
  assert.equal((await fetch(`${base}/src/main.js`)).status, 200);
  const raw = await new Promise((ok) => {
    import('node:net').then(({ connect }) => {
      const c = connect(PORT, '127.0.0.1', () => c.write('GET / HTTP/1.1\r\nHost: attacker.example\r\nConnection: close\r\n\r\n'));
      let d = '';
      c.on('data', (b) => { d += b; });
      c.on('end', () => ok(d));
    });
  });
  assert.match(raw, /^HTTP\/1\.1 403/);
});

await page.screenshot({ path: 'test/out/interact.png' });
if (problems.length) { failed = true; console.log('console problems:\n' + problems.join('\n')); }
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
