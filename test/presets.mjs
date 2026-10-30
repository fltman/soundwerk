// npm run presets — plays every example in real Chrome and screenshots the wall → test/out/
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { PRESETS } from '../src/presets.js';

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
await page.click('#play');
await page.waitForFunction(() => window.soundwerk.host.started);
for (let i = 0; i < PRESETS.length; i++) {
  await page.selectOption('#examples', String(i));
  await page.waitForTimeout(3500);
  const cpu = await page.evaluate(() => window.soundwerk.host.cpu);
  await page.screenshot({ path: `test/out/preset-${i}.png` });
  console.log(`${PRESETS[i].name.padEnd(20)} ${(cpu * 100).toFixed(1)} %`);
}
if (process.argv[2] === '--zoom') {
  await page.selectOption('#examples', '0');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const { wall } = window.soundwerk; wall.view = { x: -20, y: -8, zoom: 1.55 }; wall.applyView(); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test/out/zoom.png' });
}
await browser.close();
server.kill();
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
