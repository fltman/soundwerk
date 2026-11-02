// Does it learn at all? Stand-ins with a taste the assistant isn't told, judging versions by what
// they say, against the same assistant with no memory of them. Spends a few dollars of Anthropic credit.
// It only reads what a version says, so it's a best case: the number that counts is a real person's.
//
//   npm run taste -- [rounds]
import { readFileSync } from 'node:fs';
import { GUIDE } from '../src/ai/catalog.js';
import { askClaude } from '../src/ai/claude.js';
import { addRound, describeTaste, newTaste, scoreOf, transitionName, transitionsOf } from '../src/set/taste.js';

if (!process.env.ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY is not set'); process.exit(1); }

const ROUNDS = Number(process.argv[2] ?? 20);
const NOISE = 0.15;   // how often a person picks something else than they would have
const BLOCK = 5;      // rounds a row of the report adds up
const FINE = 7;       // of 10: what someone would call fine
const TEACHING = GUIDE.slice(GUIDE.indexOf('A plan can also be taught'), GUIDE.indexOf('A message can start with [Marked'));

const PEOPLE = {
  words: 'You love transitions built on sung words and vocal fragments you can recognise, and hard cuts and moments of silence. You dislike filter sweeps and long smooth blends.',
  drift: 'You want it slow and hypnotic: long blends, echoes, filters, nothing sudden. You dislike stutters, chops, hard cuts and anything that draws attention to itself.',
};
const ARMS = { 'no memory': { memory: false }, 'picks': { memory: true }, 'picks and reasons': { memory: true, reasons: true } };

const set = JSON.parse(readFileSync(new URL('../demo/set.json', import.meta.url))).nodes.find((n) => n.type === 'set').data;
const transitions = transitionsOf(set.plan);
const about = set.tracks.map((t, i) => `Track ${i}, ${t.file}: ${t.bpm.toFixed(0)} BPM, ${t.key}${t.words?.length ? `, sung: ${t.words.slice(0, 12).map((w) => `"${w.text}"`).join(' ')}` : ', no words'}`).join('\n');

let spent = 0;
const broken = [];
async function ask(request) {
  for (let tries = 0; ; tries++) {
    try {
      const { message, usage } = await askClaude({ effort: 'low', tools: [], ...request });
      spent += usage.cost;
      return message;
    } catch (e) {
      if (tries === 3) throw e;
    }
  }
}

const OFFER = { type: 'function', function: { name: 'offer_transition', description: 'Offer three versions', parameters: { type: 'object', properties: {
  options: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, idea: { type: 'string' } }, required: ['title', 'idea'] } },
  best: { type: 'integer' }, why: { type: 'string' }, notes: { type: 'array', items: { type: 'string' } },
}, required: ['options', 'best', 'why', 'notes'] } } };

async function offerFor(t, taste, memory) {
  const said = memory ? describeTaste(taste) : '';
  const msg = await ask({
    room: 6000,
    tools: [OFFER],
    system: `You plan transitions in a DJ set of mp3s mixed into a rack that plays throughout, sampling the tracks. Here you only describe versions, in title and idea; leave out moves.\n\n${TEACHING}`,
    messages: [{ role: 'user', content: `${about}\n\n${said}\n\n[Teach] ${transitionName(t, set.tracks)}, on set bar ${t.bar}. Call offer_transition.` }],
  });
  const raw = msg.tool_calls?.[0]?.function.arguments ?? '{"options":[]}';
  try { return JSON.parse(raw); } catch (e) { broken.push(raw); return { options: [] }; }
}

async function judge(person, shown) {
  const msg = await ask({
    room: 2000,
    system: `You are judging transitions in a DJ set. ${person} Answer on two lines, nothing else:\nscores: three numbers from 1 to 10, one for each version in order\nreason: why, in a few words, the way a person would say it, without saying what your taste is in general`,
    messages: [{ role: 'user', content: shown.map((o, i) => `${i + 1}. ${o.title}: ${o.idea}`).join('\n') }],
  });
  const scores = (/scores:\s*([\d.,\s]+)/i.exec(msg.content)?.[1] ?? '').match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (scores.length !== 3) throw new Error(`no scores in: ${msg.content}`);
  return { scores, reason: /reason:\s*(.+)/i.exec(msg.content)?.[1]?.trim() ?? '' };
}

async function run(name, person, arm) {
  let taste = newTaste();
  const log = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t = transitions[i % transitions.length], offer = await offerFor(t, taste, arm.memory);
    if (offer.options.length !== 3 || !offer.options[offer.best]) { i--; continue; }
    const order = [0, 1, 2].sort(() => Math.random() - 0.5), { scores, reason } = await judge(person, order.map((k) => offer.options[k]));
    const top = scores.indexOf(Math.max(...scores)), pick = Math.random() < NOISE ? order[Math.floor(Math.random() * 3)] : order[top];
    const ranked = [...scores].sort((a, b) => b - a);
    const liked = scores[order.indexOf(offer.best)], fine = pick !== offer.best && liked >= FINE;
    log.push({ same: pick === offer.best, agreed: pick === offer.best || fine, liked, gap: ranked[0] - ranked[1] });
    taste = { ...addRound(taste, { transition: transitionName(t, set.tracks), options: offer.options.map(({ title, idea }) => ({ title, idea })), best: offer.best, pick, why: arm.reasons ? reason : '', ...(fine ? { fine } : {}) }), notes: offer.notes };
  }
  return { name, log, notes: taste.notes, score: scoreOf(taste) };
}

const runs = await Promise.all(Object.entries(PEOPLE).flatMap(([who, person]) => Object.entries(ARMS).map(([arm, how]) => run(`${who}, ${arm}`, person, how).catch((e) => ({ name: `${who}, ${arm}`, error: e.message })))));
const rate = (rows, key) => rows.reduce((n, r) => n + +r[key], 0) / rows.length;
const row = (blocks, key, digits = 1) => blocks.map((b) => rate(b, key).toFixed(digits)).join(' ');
for (const r of runs) {
  if (r.error) { console.log(`${r.name}: failed, ${r.error}`); continue; }
  const blocks = Array.from({ length: Math.ceil(ROUNDS / BLOCK) }, (_, k) => r.log.slice(k * BLOCK, (k + 1) * BLOCK));
  console.log(`${r.name.padEnd(28)} same pick ${blocks.map((b) => `${b.filter((x) => x.same).length}/${b.length}`).join(' ')}  agreed ${blocks.map((b) => `${b.filter((x) => x.agreed).length}/${b.length}`).join(' ')}  last ${r.score.count}: ${r.score.hits}   what it recommended scored ${row(blocks, 'liked')}   lead over the runner-up ${row(blocks, 'gap')}`);
}
console.log(`\nspent $${spent.toFixed(2)}, ${broken.length} answers that weren't JSON${broken[0] ? `, like:\n${broken[0]}` : ''}`);
for (const r of runs) if (r.notes?.length && r.name.endsWith('picks')) console.log(`\n${r.name}, its notes:\n${r.notes.map((n) => `  ${n}`).join('\n')}`);
