// npm run smoke — boots the app headless, starts the audio, checks that sound and telemetry
// actually flow, screenshots it, and fails on console errors.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

const preset = process.argv[2];
// real Chrome, muted: headless shell has a different audio backend that stalls for seconds
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
  if (preset !== undefined) {
    await page.selectOption('#examples', preset);
    await page.waitForTimeout(300);
  }
  await page.click('#play');
  await page.waitForFunction(() => window.soundwerk.host.started);
  // the meter is per block and a block can fall in a rest, so hold the loudest over three seconds
  const info = await page.evaluate(() => new Promise((resolve) => {
    const { host, graph } = window.soundwerk;
    const held = [0, 0];
    const t0 = performance.now();
    const look = () => {
      host.peaks.forEach((p, k) => { held[k] = Math.max(held[k], p); });
      if (performance.now() - t0 < 3000) { requestAnimationFrame(look); return; }
      resolve({
        modules: graph.nodes.size, cables: graph.links.size, state: host.ctx.state, sampleRate: host.ctx.sampleRate,
        running: host.running, peaks: held.map((p) => +p.toFixed(3)), cpu: +host.cpu.toFixed(3), isolated: crossOriginIsolated,
      });
    };
    look();
  }));
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: `test/out/app${preset ?? ''}.png` });
  if (problems.length) console.log('console problems:\n' + problems.join('\n'));
  failed = problems.some((p) => !p.startsWith('warning')) || info.state !== 'running' || !(Math.max(...info.peaks) > 0.01);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);
