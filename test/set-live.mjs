// npm run set -- a.mp3 b.mp3 c.mp3 [--seconds 300] — a playlist all the way through, in the real app,
// in real Chrome, muted: measured, set up and planned by the real assistant on the Acid wall, every
// way in and out of a track heard, played with the live DJ on top and recorded. Spends some
// OpenRouter credit. Writes demo/set.json and .wav, then opens the patch in a browser that has never
// seen the tracks.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2), flag = (name, or) => { const i = args.indexOf(`--${name}`); return i < 0 ? or : Number(args.splice(i, 2)[1]); };
const SECONDS = flag('seconds', 0);
const revising = args.indexOf('--revise');   // --revise "what to change": the last set, given back to the assistant
const REVISE = revising < 0 ? null : args.splice(revising, 2)[1];
const files = args;
if (files.length < 2 && !REVISE) { console.log('npm run set -- a.mp3 b.mp3 [c.mp3 …] [--seconds 300] [--revise "what to change"]'); process.exit(2); }
if (!process.env.OPENROUTER_API_KEY) { console.log('OPENROUTER_API_KEY is not set'); process.exit(2); }
mkdirSync('demo', { recursive: true });
const names = files.map((f, i) => {
  const name = /^set-\d+-/.test(basename(f)) ? basename(f) : `set-${i + 1}-${basename(f).replace(/[^\w.-]+/g, '-')}`;
  if (resolve(f) !== resolve(`demo/${name}`)) copyFileSync(f, `demo/${name}`);
  return name;
});

const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill());   // whatever goes wrong below
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

const page = await open(`http://localhost:${PORT}/${REVISE ? '?patch=/demo/set.json' : ''}`);
if (!REVISE) {
  await page.selectOption('#examples', { label: 'Acid wall' });
  await page.waitForFunction(() => window.soundwerk.graph.rig);
}
const t0 = Date.now();
const id = await page.evaluate(async ({ names, revise }) => {
  const { graph, wall, addTracks } = window.soundwerk;
  if (revise) return [...graph.nodes.values()].find((n) => n.type === 'set').id;
  const set = graph.addNode('set', 4, 0);
  graph.commit();
  const files = await Promise.all(names.map(async (name) => ({ name, source: `/demo/${name}`, data: await (await fetch(`/demo/${name}`)).arrayBuffer() })));
  await addTracks(set.id, files);
  wall.frameAll();
  return set.id;
}, { names, revise: !!REVISE });
const measured = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).data.tracks.map((t) => ({ file: t.file, bpm: t.bpm, key: t.key, gain: t.gain, bars: t.bars, lines: t.words?.length ?? 0, parts: t.sections.map((s) => `${s.name} ${s.from}-${s.to}`).join(', '), map: Object.entries(t.material ?? {}).map(([k, m]) => `\n       ${k.padEnd(6)} ${m.map}`).join('') })), id);
for (const t of measured) console.log(`     ${t.file}: ${t.bpm} BPM, ${t.key}, ${t.bars} bars, gain ${t.gain}, ${t.lines} lines of words\n       ${t.parts}${t.map}`);
console.log(`     measured in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const t1 = Date.now();
const before = await page.evaluate(() => window.soundwerk.graph.toJSON().links.length);
const said = await page.evaluate(async ({ id, revise }) => {
  const { host, chat } = window.soundwerk;
  if (revise) chat.send(revise);
  else host.dispatchEvent(new CustomEvent('set-plan', { detail: { id } }));
  await new Promise((r) => setTimeout(r, 200));
  while (chat.busy) await new Promise((r) => setTimeout(r, 300));
  const tool = chat.history.filter((m) => m.role === 'tool').map((m) => m.content);
  return {
    calls: chat.history.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name),
    last: chat.history.at(-1)?.content,
    heard: tool.filter((t) => t.includes('LUFS by bar')).at(-1) ?? tool.at(-1),
    errors: chat.items.filter((i) => i.kind === 'error').map((i) => i.text),
    spent: chat.spent ?? 0,
  };
}, { id, revise: REVISE });
console.log(`     planned in ${((Date.now() - t1) / 1000).toFixed(0)} s for $${said.spent.toFixed(3)}, by ${said.calls.join(', ')}`);
if (said.errors.length) console.log(`     chat: ${said.errors.join(' | ')}`);
console.log(`     the assistant: ${said.last}`);
console.log(said.heard);
const { plan, tracks } = await page.evaluate((id) => window.soundwerk.graph.nodes.get(id).data, id);
if (!plan) { console.log('FAIL  there is no plan'); await browser.close(); server.kill(); process.exit(1); }
writeFileSync('demo/set-plan.json', JSON.stringify(plan, null, 1));
console.log(`     "${plan.brief}"`);
const bars = plan.arc.reduce((n, s) => n + s.bars, 0);
console.log(`     arc: ${plan.arc.map((s) => `${s.name} ${s.bars}`).join(', ')}; ${plan.moves.length} moves`);
for (const e of plan.tracks) console.log(`     bar ${e.at}: ${tracks[e.track].file}, its bars ${e.enter}-${e.leave}${e.nudge ? `, nudged ${e.nudge} s` : ''}`);
for (const m of plan.moves) for (const op of m.ops) if (op.op === 'sample') console.log(`     sample, bars ${m.at}-${m.until}: track ${op.track} ${op.stem ?? 'mix'} bar ${op.bar}, ${op.bars} long in ${op.pieces}${op.reverse ? ', backwards' : ''}, ${op.steps ?? ''}. ${m.why}`);
console.log(`     ${plan.ok ? 'nothing marked as failed in the render' : 'the assistant left marks in the render: see its answer above'}`);
if (!REVISE) check('the assistant changed the wiring', (await page.evaluate(() => window.soundwerk.graph.toJSON().links.length)) !== before);
await page.screenshot({ path: 'demo/set-planned.png' });

const bpm = await page.evaluate(() => [...window.soundwerk.graph.nodes.values()].find((n) => n.type === 'clock').params.bpm);
const playFor = SECONDS || Math.ceil((bars * 240) / Math.min(bpm, 90)) + 20;   // tempo moves, and the set says when it's over
console.log(`     ${bars} bars, recording until the set is over, at most ${playFor} s`);
await page.evaluate(async () => { await window.soundwerk.host.start(); window.soundwerk.host.startRecording(); });
const started = await page.evaluate(async () => { await window.soundwerk.dj.start(); return { running: window.soundwerk.dj.running, set: window.soundwerk.conductor.running, msg: window.soundwerk.dj.message }; });
check('the DJ and the set started', started.running && started.set, JSON.stringify(started));

const seen = new Set();
let dropped = 0;
const end = Date.now() + playFor * 1000;
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, 1000));
  const now = await page.evaluate(() => {
    const { conductor, dj } = window.soundwerk;
    return { leg: conductor.legIndex, running: conductor.running, section: dj.running && dj.rig ? dj.section(dj.played)?.name : null, step: Math.round(conductor.step), drops: window.soundwerk.host.ctx?.playbackStats?.underrunEvents ?? 0 };
  });
  if (now.drops > dropped) { console.log(`     step ${now.step}: ${now.drops - dropped} dropout(s), ${now.section}`); dropped = now.drops; }
  if (!seen.has(now.leg)) { seen.add(now.leg); console.log(`     step ${now.step}: track ${now.leg + 1}, ${now.section}`); }
  if (!now.running) break;
}
const stats = await page.evaluate(() => {
  const { dj, host, conductor } = window.soundwerk;
  return { ...dj.stats, log: dj.log.length, dropouts: host.ctx?.playbackStats?.underrunEvents ?? null, cpu: host.cpu, moves: dj.log.slice(-6).map((l) => `${l.bar} ${l.group}/${l.move} (${l.by})`), message: conductor.message };
});
check('every track played', plan.tracks.every((_, i) => seen.has(i)));
check('the set played to its end', stats.message === 'The set is over', stats.message);
const lastBpm = plan.moves.flatMap((m) => m.ops).filter((op) => op.op === 'set' && op.params?.bpm !== undefined).at(-1)?.params.bpm;
const endBpm = await page.evaluate(() => [...window.soundwerk.graph.nodes.values()].find((n) => n.type === 'clock').params.bpm);
check('the Clock ended where the plan left it', !lastBpm || Math.abs(endBpm - lastBpm) < 0.01, `${endBpm} BPM, the plan's last is ${lastBpm}`);
console.log(`     DJ: ${stats.calls} decisions, ${stats.fails} failed, ${stats.late} late, $${stats.cost.toFixed(5)}; dropouts ${stats.dropouts}, CPU ${(stats.cpu * 100).toFixed(0)} %`);
console.log(`     last moves: ${stats.moves.join('; ')}`);
const blob = await page.evaluate(async () => {
  const wav = await window.soundwerk.host.stopRecording();
  const bytes = new Uint8Array(await wav.arrayBuffer());
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(chunks.join(''));
});
const name = 'demo/set';
writeFileSync(`${name}.wav`, Buffer.from(blob, 'base64'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${name}.wav`, '-b:a', '192k', `${name}.mp3`]);
const report = spawnSync('ffmpeg', ['-hide_banner', '-i', `${name}.wav`, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 2 ** 28 }).stderr;
const loudness = Number(/I:\s+(-?[\d.]+) LUFS/.exec(report.slice(report.lastIndexOf('Summary')))?.[1]);
check('the recording has sound in it', loudness > -30, `${loudness} LUFS`);
const patch = await page.evaluate(() => window.soundwerk.graph.toJSON());
writeFileSync(`${name}.json`, JSON.stringify(patch));
console.log(`     ${name}.mp3`);
await page.evaluate(() => { window.soundwerk.dj.stop(); window.soundwerk.host.setRunning(false); });
check('nothing went wrong in the page', !page.problems.length, page.problems.slice(0, 3).join(' | '));

// in a browser that has never seen any of it
const fresh = await open(`http://localhost:${PORT}/?patch=/demo/set.json`);
const again = await fresh.evaluate(async () => {
  const { conductor, host } = window.soundwerk;
  await conductor.start();
  await new Promise((r) => setTimeout(r, 4000));
  const peaks = host.peaks;
  return { running: conductor.running, peak: Math.max(...peaks), message: conductor.message };
});
check('the saved set plays from what the server keeps', again.running && again.peak > 0.01, JSON.stringify(again));

await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
