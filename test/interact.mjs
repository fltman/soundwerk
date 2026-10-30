// npm run interact — drives the wall with a real mouse: patching, unplugging, turning knobs,
// moving modules, adding one, undoing, and painting a sequencer.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
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

await step('the server refuses a foreign Host, a cross-site chat call, and private folders', async () => {
  const base = `http://localhost:${PORT}`;
  const json = { 'Content-Type': 'application/json' };
  const chat = (headers) => fetch(`${base}/api/chat`, { method: 'POST', headers, body: '{"messages":[]}' }).then((r) => r.status);
  assert.equal(await chat({ 'Content-Type': 'text/plain' }), 403);
  assert.equal(await chat({ ...json, Origin: 'https://evil.example' }), 403);
  for (const path of ['/.git/HEAD', '/.gitignore', '/vault/Home.md', '/VAULT/Home.md', '/node_modules/playwright/package.json', '/NODE_MODULES/playwright/package.json']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
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
