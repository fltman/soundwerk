// npm run remix -- demo/track.mp3 [seconds] — a track all the way through, in the real app, in real
// Chrome, muted: cut, separated by Demucs, rigged by the assistant, played by the live DJ and
// recorded. Spends some OpenRouter credit. Writes demo/<track>-remix.json and .wav, then opens the
// patch again in a browser that has never seen the track, to see it play from what the server keeps.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const file = process.argv[2];
const SECONDS = Number(process.argv[3]) || 120;
if (!file) { console.log('npm run remix -- demo/track.mp3 [seconds]'); process.exit(2); }
if (!process.env.OPENROUTER_API_KEY) { console.log('OPENROUTER_API_KEY is not set'); process.exit(2); }
const name = basename(file, extname(file));
mkdirSync('demo', { recursive: true });
if (resolve(file) !== resolve(`demo/${basename(file)}`)) copyFileSync(file, `demo/${basename(file)}`);

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

async function open(url) {
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  page.problems = [];
  page.on('console', (m) => { if (m.type() === 'error') page.problems.push(m.text()); });
  page.on('pageerror', (e) => page.problems.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
  return page;
}

let failed = false;
const check = (what, ok, more = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${what}${more ? ` — ${more}` : ''}`);
  if (!ok) failed = true;
};

const page = await open(`http://localhost:${PORT}/`);
await page.selectOption('#examples', { label: 'Empty wall' });
const spent = { calls: 0, input: 0, output: 0, cost: 0 };
page.on('response', async (r) => {
  if (!r.url().endsWith('/api/chat')) return;
  const u = (await r.json().catch(() => ({}))).usage;
  spent.calls++;
  spent.input += u?.prompt_tokens ?? 0;
  spent.output += u?.completion_tokens ?? 0;
  spent.cost += u?.cost ?? 0;
});

const track = await page.evaluate(async (url) => {
  const { graph, wall, host } = window.soundwerk;
  const clock = graph.addNode('clock', 0, 0);
  const slicer = graph.addNode('slicer', 0, 10);
  graph.connect(clock.id, 's16', slicer.id, 'clk');
  graph.connect(clock.id, 'rst', slicer.id, 'rst');
  graph.commit();
  const buf = await window.soundwerk.loadInto(slicer.id, url.split('/').pop(), await (await fetch(url)).arrayBuffer());
  graph.setParam(clock.id, 'bpm', buf.bpm);
  graph.commit();
  wall.frameAll();
  return { id: slicer.id, bpm: buf.bpm, slices: buf.slices, key: graph.nodes.get(slicer.id).data.key };
}, `/demo/${basename(file)}`);
console.log(`     ${basename(file)}: ${track.bpm} BPM, ${track.key}, ${track.slices} slices`);

const PROMPT = `This is my track, on the slicer. Split it into stems, then make something new out of it rather than a loop of the original: take slices from different parts of the track for each stem, run the stems through a desk with some delay and reverb, and build a live DJ rig whose moves chop and recombine them. Give it an arc with a groove, a long build, a peak and a break. Keep it at the track's tempo.`;
const t0 = Date.now();
const said = await page.evaluate(async (prompt) => {
  const { chat } = window.soundwerk;
  const before = chat.items.length;
  await chat.send(prompt);
  const items = chat.items.slice(before);
  return {
    said: items.filter((i) => i.kind === 'assistant').map((i) => i.text).join('\n'),
    errors: items.filter((i) => i.kind === 'error').map((i) => i.text),
    bad: items.filter((i) => i.kind === 'ops').flatMap((i) => i.lines).filter((l) => l.startsWith('✗')),
  };
}, PROMPT);
console.log(`     the assistant took ${((Date.now() - t0) / 1000).toFixed(0)} s:\n${said.said}`);
check('it finished without an error', !said.errors.length, said.errors.join('; '));
if (said.bad.length) console.log(`     refused along the way:\n       ${said.bad.join('\n       ')}`);
await page.screenshot({ path: 'test/out/remix-wall.png' });

const rig = await page.evaluate(() => {
  const { graph } = window.soundwerk;
  const slicers = [...graph.nodes.values()].filter((n) => n.type === 'slicer');
  return graph.rig && {
    arc: graph.rig.arc.map((s) => `${s.name} ${s.bars}`).join(', '),
    stems: slicers.map((n) => `${n.id} ${n.data.stem ?? 'mix'}: ${graph.linksOf(n.id).length} cables, ${n.data.steps.map((p) => 'abcdefgh'[p] ?? '.').join('')}`),
    moves: graph.rig.groups.flatMap((g) => g.moves.map((m) => `${m.test?.ok ? 'ok ' : 'BAD'} ${g.name}/${m.name}: ${m.test?.why ?? m.test?.measured}`)),
  };
});
console.log(JSON.stringify(rig, null, 1));
check('there is a rig', !!rig);
check('every move passed its render', !!rig && !rig.moves.some((m) => m.startsWith('BAD')));

await page.click('#dj-btn');
await page.click('#rec');
await page.click('#dj-start');
await page.waitForFunction(() => window.soundwerk.dj.running);
await page.waitForTimeout(SECONDS * 1000);
await page.screenshot({ path: 'test/out/remix-live.png' });
const set = await page.evaluate(() => {
  const { dj, host } = window.soundwerk;
  return {
    log: dj.log.map((l) => `${l.bar} ${l.group}:${l.move}${l.odds !== undefined ? ` ${(l.odds * 100).toFixed(0)}%` : ''}${l.by !== 'dj' ? ` (${l.by})` : ''}`),
    stats: dj.stats, played: dj.played, message: dj.message,
    drops: host.ctx.playbackStats?.underrunEvents ?? null, cpu: host.cpu,
  };
});
const download = page.waitForEvent('download');
await page.click('#rec');
await (await download).saveAs(`demo/${name}-remix.wav`);
await page.evaluate(() => window.soundwerk.dj.stop());
console.log(`     ${set.played + 1} bars, ${JSON.stringify(set.stats)}, DSP ${(set.cpu * 100).toFixed(0)} %, ${set.drops} dropouts`);
console.log(`     ${set.log.join(' · ')}`);
check('the DJ played moves', set.log.filter((l) => !l.includes('(start)')).length > 3);
check('no dropouts', !set.drops);
check('nothing failed', set.stats.fails === 0, set.message ?? '');

const patch = await page.evaluate((source) => {
  const json = window.soundwerk.graph.toJSON();
  for (const n of json.nodes) if (n.type === 'slicer' && !n.data.stem) n.data.source = source;
  return json;
}, `/demo/${basename(file)}`);
writeFileSync(`demo/${name}-remix.json`, JSON.stringify(patch));
const ebu = execFileSync('ffmpeg', ['-nostats', '-hide_banner', '-i', `demo/${name}-remix.wav`, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).toString();
console.log(`     spent: ${JSON.stringify(spent)}`);
console.log(ebu.slice(-200));
check('the page stayed quiet', !page.problems.length, page.problems.slice(0, 3).join(' | '));

// a browser with nothing in it: everything has to come from the server
const fresh = await open(`http://localhost:${PORT}/?patch=/demo/${name}-remix.json`);
await fresh.waitForFunction((n) => window.soundwerk.host.buffers.size >= n, patch.nodes.filter((x) => x.type === 'slicer').length, { timeout: 120000 });
await fresh.click('#dj-btn');
await fresh.click('#dj-start');
await fresh.waitForFunction(() => window.soundwerk.dj.running);
await fresh.waitForTimeout(12000);
const again = await fresh.evaluate(() => {
  const { dj, host } = window.soundwerk;
  return { peaks: host.peaks, played: dj.played, message: dj.message };
});
check('the saved patch plays in a fresh browser', again.played > 0 && Math.max(...again.peaks) > 0.01, JSON.stringify(again));
await fresh.screenshot({ path: 'test/out/remix-fresh.png' });

await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
