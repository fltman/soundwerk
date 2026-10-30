// npm run perf — what each example costs on the real engine. Rendering through an
// OfflineAudioContext in real Chrome runs the same worklet with no deadline, so the wall-clock
// time is the true DSP cost; the worklet's own clock only ticks in whole milliseconds.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { PRESETS } from '../src/presets.js';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);

let worst = 0;
for (const p of PRESETS) {
  const r = await page.evaluate(async ({ patch, seconds }) => {
    const sr = 48000;
    const ctx = new OfflineAudioContext(2, sr * seconds, sr);
    await ctx.audioWorklet.addModule('src/engine/worklet.js');
    const sab = new SharedArrayBuffer(window.soundwerk.host.telemetry.byteLength);
    const node = new AudioWorkletNode(ctx, 'soundwerk', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { sab } });
    node.connect(ctx.destination);
    for (const n of patch.nodes) node.port.postMessage({ t: 'add', id: n.id, type: n.type, params: n.params, depth: n.depth, data: n.data, code: n.code });
    node.port.postMessage({ t: 'links', links: patch.links });
    node.port.postMessage({ t: 'run', on: true });
    await new Promise((ok) => setTimeout(ok, 200));
    const t0 = performance.now();
    const buf = await ctx.startRendering();
    const took = (performance.now() - t0) / 1000;
    let peak = 0;
    const L = buf.getChannelData(0);
    for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]));
    return { took, peak };
  }, { patch: p.patch(), seconds: 12 });
  const load = r.took / 12;
  worst = Math.max(worst, load);
  console.log(`${p.name.padEnd(20)} ${p.patch().nodes.length.toString().padStart(3)} modules  ${(load * 100).toFixed(1).padStart(5)} % of real time   peak ${r.peak.toFixed(2)}`);
}
console.log(`worst ${(worst * 100).toFixed(1)} %`);

// and then the one that counts: the biggest patch, live, with the wall drawing, and no dropouts
await page.setViewportSize({ width: 1680, height: 1000 });
await page.click('#play');
await page.waitForFunction(() => window.soundwerk.host.started);
await page.waitForTimeout(1500);
const live = await page.evaluate(async () => {
  const s = window.soundwerk.host.ctx.playbackStats;
  const u0 = s.underrunEvents, t0 = s.totalDuration;
  await new Promise((r) => setTimeout(r, 15000));
  return { dropouts: s.underrunEvents - u0, seconds: s.totalDuration - t0 };
});
console.log(`live: ${live.dropouts} dropouts in ${live.seconds.toFixed(1)} s`);
await browser.close();
server.kill();
if (problems.length) console.log(problems.join('\n'));
process.exit(problems.length || worst > 0.5 || live.dropouts > 0 ? 1 : 0);
