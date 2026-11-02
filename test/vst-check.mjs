// npm run vst:check — a plugin all the way through the real page: Chrome, the audio thread, the worker,
// the server and the host, muted. Without arguments a built-in effect stands in for the plugin.
// `npm run vst:check -- /path/to/Plugin.vst3` does it with a real one, which is the only way to
// know that file works here, and opens its window for you to close.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { chromium } from 'playwright';

const real = process.argv[2];
const PORT = 20000 + Math.floor(Math.random() * 20000);
const env = { ...process.env, PORT: String(PORT), SOUNDWERK_TASTE: `${process.cwd()}/test/out/vst-taste.json`, SOUNDWERK_VST_STAND_INS: '1', ...(real ? { SOUNDWERK_VST_PATH: dirname(real) } : {}) };
const server = spawn(process.execPath, ['server.mjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));
let failed = false;
const step = async (name, fn) => {
  try { const said = await fn(); console.log(`✓ ${name}${said ? `: ${said}` : ''}`); } catch (e) { failed = true; console.log(`✗ ${name}: ${e.message}`); }
};
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);

// Pulses on the left go straight to the master and on the right through the plugin, which also
// gets them as notes: an effect ignores those, and an instrument has nothing else to play
await page.evaluate(() => {
  const { graph } = window.soundwerk;
  const n = (id, type, params = {}, hp = 0) => ({ id, type, row: 0, hp, params });
  const l = (id, from, fromPort, to, toPort) => ({ id, from, fromPort, to, toPort });
  graph.load({ version: 1, nodes: [n('n1', 'clock', { bpm: 120 }), n('n2', 'vst', {}, 12), n('n3', 'master', {}, 30)], links: [l('n4', 'n1', 's4', 'n3', 'l'), l('n5', 'n1', 's4', 'n2', 'inL'), l('n6', 'n2', 'l', 'n3', 'r'), l('n7', 'n1', 's4', 'n2', 'gate')], nextId: 8 });
  graph.commit(true);
});
const plugin = real ?? 'builtin:Distortion';
await step('the panel finds the plugin folders', async () => {
  const { installed, plugins } = await page.evaluate(() => window.soundwerk.plugins.installed());
  assert.ok(installed, 'run npm run vst:setup');
  assert.ok(plugins.some((p) => p.path === plugin), `${plugin} is not among ${plugins.map((p) => p.path)}`);
  return `${plugins.length} plugins`;
});
await page.evaluate(async (path) => {
  const { host, plugins } = window.soundwerk;
  await host.start();
  host.setRunning(true);
  plugins.load('n2', path, path.split('/').pop());
}, plugin);
const live = () => page.evaluate(() => { const { name, number, error, instrument, window: w, latency } = window.soundwerk.plugins.open.get('n2') ?? {}; return { name, number, error, instrument, window: w, latency }; });
await step('the plugin opens in the host', async () => {
  await page.waitForFunction(() => { const p = window.soundwerk.plugins.open.get('n2'); return p && (p.error || p.window !== undefined); }, null, { timeout: 60000 });
  const info = await live();
  assert.equal(info.error, undefined);
  return `${info.name}, ${info.instrument ? 'an instrument' : 'an effect'}, reports ${info.latency} samples of latency, ${info.window ? 'has a window' : 'no window'}`;
});
await step('its module is on the line', async () => {
  await page.waitForFunction(() => window.soundwerk.host.ui('n2')?.[0] === 1, null, { timeout: 10000 });
});

const lates = () => page.evaluate(() => window.soundwerk.host.ui('n2')[2]);
await step('how late the plugin is, measured on the recording', async () => {
  const offsets = await page.evaluate(async () => {
    const { host } = window.soundwerk;
    host.startRecording();
    await new Promise((r) => setTimeout(r, 3000));
    const bytes = new Float32Array((await (await host.stopRecording()).arrayBuffer()).slice(44));
    const rises = (ch) => { const at = []; for (let i = 2; i < bytes.length / 2; i++) if (Math.abs(bytes[i * 2 + ch]) > 0.05 && Math.abs(bytes[(i - 1) * 2 + ch]) <= 0.05) at.push(i); return at; };
    return { left: rises(0), right: rises(1), sr: host.sampleRate };
  });
  const { left, right, sr } = offsets;
  assert.ok(left.length >= 4 && right.length >= 4, `${left.length} and ${right.length} pulses`);
  const late = left.map((t) => right.find((u) => u >= t) - t).filter(Number.isFinite);
  const ms = (x) => ((x / sr) * 1000).toFixed(1);
  return `${ms(Math.min(...late))} to ${ms(Math.max(...late))} ms, over ${late.length} pulses`;
});
await step('20 s under a busy main thread, with no block late', async () => {
  const before = await lates();
  await page.evaluate(() => new Promise((resolve) => {
    const end = performance.now() + 20000;
    const hog = () => {
      const t = performance.now();
      while (performance.now() - t < 40);   // the wall having a bad time drawing
      if (performance.now() < end) setTimeout(hog, 5); else resolve();
    };
    hog();
  }));
  const blocks = (await lates()) - before;
  assert.ok(blocks <= 2, `${blocks} blocks came late`);
  return blocks ? `${blocks} late` : '0 late';
});

await step('undo and redo leave it on the line', async () => {
  await page.evaluate(async () => {
    const { graph } = window.soundwerk;
    graph.undo();
    await new Promise((r) => setTimeout(r, 300));
    graph.redo();
  });
  await page.waitForFunction(() => window.soundwerk.host.ui('n2')?.[0] === 1, null, { timeout: 15000 });
});

await step('PRINT burns the effect into a Sampler, keeps its length, and undo gets the old file back', async () => {
  const info = await live();
  if (info.instrument) return 'skipped: an instrument';
  const r = await page.evaluate(async () => {
    const { graph, host, plugins } = window.soundwerk;
    const s = graph.addNode('sampler', 2, 0);
    const frames = 24000, L = Float32Array.from({ length: frames }, (_, k) => 0.5 * Math.sin(k * 0.05));
    const { encodeWav } = await import('/src/engine/host.js');
    const { loadInto, hashOf } = await import('/src/ui/files.js');
    const bytes = await encodeWav([{ L, R: L }], 48000).arrayBuffer();
    await loadInto(host, graph, s.id, 'tone.wav', bytes.slice(0));
    const before = graph.nodes.get(s.id).data.hash;
    graph.disconnect('n5');
    graph.connect(s.id, 'out', 'n2', 'inL');
    graph.commit();
    const was = host.buffers.get(s.id);
    await plugins.print('n2');
    const now = host.buffers.get(s.id);
    let moved = 0;
    for (let k = 0; k < frames; k++) moved = Math.max(moved, Math.abs(now.L[k] - was.L[k]));
    const after = graph.nodes.get(s.id).data;
    graph.undo();
    return { frames: now.L.length, wanted: was.L.length, moved, bypass: 0 + graph.nodes.get('n2').params.bypass, hash: after.hash !== before, file: after.file, undone: graph.nodes.get(s.id).data.hash === before };
  });
  assert.equal(r.frames, r.wanted);
  assert.ok(r.moved > 0.01, 'the sound did not change');
  assert.ok(r.hash);
  assert.ok(r.undone);
  return `${r.file}, moved by ${r.moved.toFixed(2)}`;
});

await step('a plugin outside the plugin folders is refused', async () => {
  const said = await page.evaluate(() => window.soundwerk.plugins.ask({ op: 'open', id: 99, path: '/tmp/x.vst3', sr: 48000 }).then(() => 'opened', (e) => e.message));
  assert.match(said, /not in a plugin folder/);
});
await step('another site can not reach the line', async () => {
  const other = await browser.newPage();
  await other.goto('data:text/html,<p>elsewhere');
  const said = await other.evaluate((port) => new Promise((resolve) => {
    const s = new WebSocket(`ws://localhost:${port}/api/vst`);
    s.onopen = () => resolve('open');
    s.onclose = () => resolve('closed');
  }), PORT);
  await other.close();
  assert.equal(said, 'closed');
});

if (real) {
  await step('the window opens: close it to go on', async () => {
    const info = await live();
    if (!info.window) return 'it has none';
    await page.evaluate(() => window.soundwerk.plugins.showWindow('n2'));
    return `settings kept: ${await page.evaluate(() => !!window.soundwerk.graph.nodes.get('n2').data.state)}`;
  });
}

await step('when the host crashes the rack plays on', async () => {
  await page.evaluate(() => window.soundwerk.plugins.ask({ op: 'crash' }).catch(() => {}));
  await page.waitForFunction(() => window.soundwerk.host.ui('n2')?.[0] === 0, null, { timeout: 5000 });
  const error = (await live()).error;
  assert.match(error, /stopped/);
  const ok = await page.evaluate(() => new Promise((r) => { const a = window.soundwerk.host.telemetry[7]; setTimeout(() => r(window.soundwerk.host.telemetry[7] !== a), 200); }));
  assert.ok(ok, 'the audio thread stopped');
  problems.splice(0);
  return error;
});

assert.deepEqual(problems, []);
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
