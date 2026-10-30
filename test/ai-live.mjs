// npm run ai-live — the assistant against the real model, driving the real app. Spends a few
// cents of OpenRouter credit, and fails if it can't build something that measures like music.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

if (!process.env.OPENROUTER_API_KEY) { console.log('OPENROUTER_API_KEY is not set'); process.exit(2); }
const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);

const PROMPTS = [
  'Clear the wall and build a dark acid track at 138 BPM: kick, offbeat hats, clap, a squelchy acid line with slides, tape delay, and scopes.',
  'Make the acid line more aggressive and duck it hard from the kick.',
  'Build a live DJ rig for this patch: a dark set with long builds. Let it bring effects in and out.',
];
let failed = false;
for (const [k, prompt] of PROMPTS.entries()) {
  const t0 = Date.now();
  const r = await page.evaluate(async (p) => {
    const { chat, graph } = window.soundwerk;
    const before = chat.items.length;
    await chat.send(p);
    const items = chat.items.slice(before);
    const ops = items.filter((i) => i.kind === 'ops').flatMap((i) => i.lines);
    return {
      modules: graph.nodes.size, cables: graph.links.size,
      said: items.filter((i) => i.kind === 'assistant').map((i) => i.text).join(' / '),
      errors: items.filter((i) => i.kind === 'error').map((i) => i.text),
      badOps: ops.filter((l) => l.startsWith('✗')), ops: ops.length,
      listened: items.some((i) => i.kind === 'listen'),
    };
  }, prompt);
  console.log(`\n── ${prompt}\n${JSON.stringify(r, null, 1)}\n${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (r.errors.length || !r.ops || !r.listened) failed = true;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test/out/ai-${k}.png` });
}
const verdict = await page.evaluate(async () => (await window.soundwerk.chat.listen(8)).stats);
console.log('\nfinal measurement', JSON.stringify(verdict));
if (!(verdict.lufs > -24 && verdict.lufs < -6) || verdict.deadCables.length) failed = true;
const rig = await page.evaluate(() => {
  const { graph } = window.soundwerk;
  return graph.rig && {
    arc: graph.rig.arc,
    moves: graph.rig.groups.flatMap((g) => g.moves.map((m) => `${m.test?.ok ? 'ok ' : 'BAD'} ${g.name}/${m.name}: ${m.test?.why ?? m.test?.measured}`)),
    adds: graph.rig.groups.flatMap((g) => g.moves).filter((m) => m.ops.some((op) => op.op === 'add')).length,
  };
});
console.log('\nrig', JSON.stringify(rig, null, 1));
if (!rig || rig.moves.some((m) => m.startsWith('BAD'))) failed = true;
if (rig) {
  await page.click('#dj-btn');
  await page.click('#dj-start');
  await page.waitForTimeout(50000);
  const set = await page.evaluate(() => {
    const { dj, host } = window.soundwerk;
    return { log: dj.log.filter((l) => l.by !== 'start').map((l) => `${l.bar} ${l.group}:${l.move}`), stats: dj.stats, message: dj.message, drops: host.ctx.playbackStats?.underrunEvents };
  });
  console.log('\nset', JSON.stringify(set));
  await page.screenshot({ path: 'test/out/ai-dj.png' });
  if (!set.log.length || set.stats.fails || set.drops) failed = true;
}
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
