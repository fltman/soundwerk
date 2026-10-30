// npm run dj — a set in the real app, in real Chrome, muted: Start, the moves get tested, they land,
// modules come and go, nothing drops out. The model is a stand-in that always wants a change.
// npm run dj -- --real plays against the real decision model, for less than a cent.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const REAL = process.argv.includes('--real');
const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a))) || 60;
if (REAL && !process.env.OPENROUTER_API_KEY) { console.log('OPENROUTER_API_KEY is not set'); process.exit(2); }
const PORT = 20000 + Math.floor(Math.random() * 20000);
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'] });
await new Promise((r) => server.stdout.once('data', r));
mkdirSync('test/out', { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));

const asked = [];
if (!REAL) {
  let turn = 0;
  await page.route('**/api/decide', async (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    const answers = {};
    turn++;
    for (const [name, q] of Object.entries(body.questions)) {
      if (q.type === 'score') {
        const top = q.criteria.length - 1, score = turn % (top + 1);
        answers[name] = { score, probabilities: q.criteria.map((_, i) => (i === score ? 1 : 0)) };
      } else {
        // whatever isn't playing, so something always changes
        const keys = Object.keys(q.criteria).filter((k) => k !== body.state.playing_now[name]);
        const pick = keys[turn % keys.length];
        answers[name] = { probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === pick ? 1 : 0])) };
      }
    }
    await new Promise((r) => setTimeout(r, 120));
    await route.fulfill({ json: { answers, usage: { cost: 0.00004 }, model: 'stand-in' } });
  });
}

await page.goto(`http://localhost:${PORT}/`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.soundwerk?.graph.nodes.size > 0);
await page.waitForTimeout(300);

let failed = false;
const check = (name, ok, more = '') => {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${name}${more ? ` — ${more}` : ''}`);
  if (!ok) failed = true;
};

// the empty wall is in the list, and leaves one Master
await page.selectOption('#examples', { label: 'Empty wall' });
await page.waitForTimeout(200);
check('Empty wall leaves only the Master', await page.evaluate(() => {
  const { graph } = window.soundwerk;
  return graph.nodes.size === 1 && !!graph.masterNode() && graph.links.size === 0;
}));
await page.screenshot({ path: 'test/out/dj-empty.png' });
await page.selectOption('#examples', { label: 'Acid wall' });
await page.waitForTimeout(300);

await page.click('#dj-btn');
await page.waitForTimeout(500);
check('the panel shows the rig', (await page.locator('.dj-row').count()) === 5, `${await page.locator('.dj-pad').count()} pads`);
await page.screenshot({ path: 'test/out/dj-panel.png' });

// from here on: how long landings take on the main thread, and what got added
await page.evaluate(() => {
  const { dj, graph } = window.soundwerk;
  window.seen = { land: [], added: new Set(), most: graph.nodes.size };
  const land = dj.land.bind(dj);
  dj.land = (s) => { const t0 = performance.now(); land(s); window.seen.land.push(performance.now() - t0); };
  graph.addEventListener('change', (e) => {
    if (e.detail.kind !== 'structure') return;
    window.seen.most = Math.max(window.seen.most, graph.nodes.size);
    for (const n of graph.nodes.values()) if (['phaser', 'flanger', 'crush'].includes(n.type) || (n.type === 'lfo' && n.id !== dj.rig.groups[0].moves[0].id)) window.seen.added.add(n.type);
  });
});
const nodesBefore = await page.evaluate(() => window.soundwerk.graph.nodes.size);
const t0 = Date.now();
await page.click('#dj-start');
await page.waitForFunction(() => window.soundwerk.dj.running);
check('Start starts the wall', await page.evaluate(() => window.soundwerk.host.running));
await page.waitForFunction(() => !window.soundwerk.dj.testing && window.soundwerk.dj.rig.groups.every((g) => g.moves.every((m) => m.test)), null, { timeout: 60000 });
console.log(`     moves tested in ${((Date.now() - t0) / 1000).toFixed(1)} s, with the wall playing`);
const verdicts = await page.evaluate(() => window.soundwerk.dj.rig.groups.flatMap((g) => g.moves.filter((m) => !m.test.ok).map((m) => `${g.name}/${m.name}: ${m.test.why}`)));
check('every move passed', verdicts.length === 0, verdicts.join('; '));

await page.waitForTimeout(Math.max(0, SECONDS * 1000 - (Date.now() - t0)));
await page.screenshot({ path: 'test/out/dj-live.png' });
const r = await page.evaluate(() => {
  const { dj, host, graph } = window.soundwerk;
  return {
    log: dj.log.map((l) => `${l.bar} ${l.group}:${l.move}${l.odds !== undefined ? ` ${(l.odds * 100).toFixed(0)}%` : ''}${l.by !== 'dj' ? ` (${l.by})` : ''}`),
    stats: dj.stats, played: dj.played, levels: dj.levels.length, message: dj.message,
    drops: host.ctx.playbackStats?.underrunEvents ?? null, cpu: host.cpu,
    land: { n: window.seen.land.length, worst: Math.max(0, ...window.seen.land) },
    added: [...window.seen.added], most: window.seen.most, now: graph.nodes.size,
    onWall: [...graph.nodes.keys()].every((id) => document.querySelector(`.mod[data-id="${id}"]`)),
  };
});
console.log(`     ${r.played + 1} bars, ${r.log.length} moves in the log, ${JSON.stringify(r.stats)}`);
console.log(`     ${r.log.slice(-14).join(' · ')}`);
console.log(`     landings: ${r.land.n}, worst ${r.land.worst.toFixed(1)} ms on the main thread; DSP ${(r.cpu * 100).toFixed(0)} %`);
check('moves landed', r.log.filter((l) => !l.includes('(start)')).length > 3);
check('nothing failed', r.stats.fails === 0);
check('nothing dropped out', r.drops === 0, `${r.drops} underruns`);
check('the ear hears the wall', r.levels > 0);
check('every module is on the wall', r.onWall);
if (!REAL) {
  check('the DJ added modules and took them away', r.added.length >= 2 && r.most > nodesBefore, `${r.added.join(', ')}; up to ${r.most} modules from ${nodesBefore}`);
  check('answers were in time', r.stats.late === 0, `${r.stats.late} late`);
  const m = asked.at(-1).state.music;
  check('the model is told the arc and the mix', !!m.section && !!m.bands_against_a_finished_track_db, JSON.stringify(m));
}

// clicking a pad queues it, Stop leaves one undo step, and home restores the wall
await page.click('#dj-start');
await page.waitForFunction(() => !window.soundwerk.dj.running);
const atStop = await page.evaluate(() => window.soundwerk.graph.nodes.size);
await page.evaluate(() => window.soundwerk.dj.rig.groups.forEach((g) => window.soundwerk.dj.queue(g.name, g.moves[0].name)));
await page.waitForTimeout(2500);
const back = await page.evaluate(() => {
  const { graph, dj } = window.soundwerk;
  return { nodes: graph.nodes.size, home: dj.rig.groups.every((g) => dj.current(g) === g.moves[0].name) };
});
check('home takes away what the DJ added', back.home && back.nodes === nodesBefore, `${atStop} → ${back.nodes} modules`);
await page.evaluate(() => window.soundwerk.host.setRunning(false));
await page.waitForTimeout(500);
check('no errors on the page', problems.length === 0, problems.slice(0, 3).join(' | '));
await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
