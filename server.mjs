// Static server (no build step) + /api/chat, which forwards the patch assistant's conversation to
// Anthropic, or to OpenRouter if there's no ANTHROPIC_API_KEY (the keys stay here; the browser never
// sees them), + /api/decide, which sends the live DJ's decisions to OpenRouter, + /api/stems, which runs Demucs
// on this machine, so a track never leaves it, + /api/vst, a line to the plugins of this computer.
// The two Cross-Origin headers give the page SharedArrayBuffer, which is how the audio
// thread hands meters, LEDs and scope traces to the wall without allocating.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8280;
const HOST = process.env.HOST || '127.0.0.1'; // local only: /api/chat spends your API credit
const MODEL = process.env.SOUNDWERK_MODEL || 'anthropic/claude-sonnet-5.5';
const DJ_MODEL = process.env.SOUNDWERK_DJ_MODEL || 'inception/mercury-decide';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const LOCAL = HOST === '127.0.0.1' || HOST === 'localhost';
const LOCAL_NAMES = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const PRIVATE = new Set(['vault', 'node_modules', 'data']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.md': 'text/markdown; charset=utf-8',
};
const STEMS = ['drums', 'bass', 'vocals', 'other'];
const STEM_MODEL = 'htdemucs';
const STEM_PYTHON = process.env.SOUNDWERK_STEM_PYTHON || join(ROOT, 'tools/stems/.venv/bin/python');
const STEM_CACHE = join(ROOT, 'tools/stems/.cache');
const STEM_DEVICE = process.platform === 'darwin' && process.arch === 'arm64' ? 'mps' : 'cpu';
const WHISPER = process.env.SOUNDWERK_WHISPER || join(ROOT, 'tools/words/whisper-cli');
const WHISPER_MODEL = process.env.SOUNDWERK_WHISPER_MODEL || join(ROOT, 'tools/words/model.bin');
const WHISPER_DTW = process.env.SOUNDWERK_WHISPER_DTW || 'large.v3.turbo';   // the model's name, as DTW knows it
const TASTE_FILE = process.env.SOUNDWERK_TASTE || join(ROOT, 'data/taste.json');
const VST_PYTHON = process.env.SOUNDWERK_VST_PYTHON || join(ROOT, 'tools/vst/.venv/bin/python');
const PLUGIN_FOLDERS = [
  ...(process.env.SOUNDWERK_VST_PATH?.split(delimiter) ?? []),
  ...({
    darwin: [join(homedir(), 'Library/Audio/Plug-Ins/VST3'), '/Library/Audio/Plug-Ins/VST3', join(homedir(), 'Library/Audio/Plug-Ins/Components'), '/Library/Audio/Plug-Ins/Components'],
    linux: [join(homedir(), '.vst3'), '/usr/lib/vst3', '/usr/local/lib/vst3'],
    win32: [join(process.env.COMMONPROGRAMFILES ?? 'C:\\Program Files\\Common Files', 'VST3')],
  }[process.platform] ?? []),
];
const STAND_INS = process.env.SOUNDWERK_VST_STAND_INS ? ['Reverb', 'Delay', 'Distortion'].map((name) => ({ path: `builtin:${name}`, name, format: 'Stand-in' })) : [];

async function readJson(req, limit = 8e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function openrouter(system, messages, tools, reasoning, room = 12000) {
  const body = {
    model: MODEL,
    max_tokens: room,
    usage: { include: true },
    // the long, unchanging system prompt is cached between turns, and the conversation between the
    // rounds of a turn, where every round would otherwise pay for all of it again
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'system', content: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }, ...messages],
    tools,
    tool_choice: 'auto',
  };
  if (reasoning) body.reasoning = reasoning;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': `http://localhost:${PORT}`,
      'X-Title': 'Soundwerk',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(room > 12000 ? 600000 : 180000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 300) } }; }
  return { status: res.status, json };
}

// /api/chat spends real money, so only this app's own page may call it. A cross-site form can't
// send application/json, and a page elsewhere always shows up in Origin.
function sameSite(req, expected = 'application/json') {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  const origin = req.headers.origin;
  return type === expected && (!origin || origin === `http://${req.headers.host}`);
}

// What the assistant has learned about this person, as a file they can read, back up or delete.
// Written to the side first: a crash halfway must not cost them all they taught it.
async function taste(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req)) return send(403, { error: 'not from this page' });
  if (req.method === 'GET') {
    const text = await readFile(TASTE_FILE, 'utf8').catch((e) => { if (e.code === 'ENOENT') return '{"notes":[],"rounds":[]}'; throw e; });
    try { return send(200, JSON.parse(text)); } catch (e) { return send(500, { error: `${TASTE_FILE} is not valid JSON: ${e.message}` }); }
  }
  const body = await readJson(req);
  if (!Array.isArray(body?.notes) || !Array.isArray(body?.rounds)) return send(400, { error: 'needs notes and rounds' });
  await mkdir(dirname(TASTE_FILE), { recursive: true });
  await writeFile(`${TASTE_FILE}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
  await rename(`${TASTE_FILE}.tmp`, TASTE_FILE);
  return send(200, { saved: true });
}

async function chat(req, res) {
  if (!sameSite(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not from this page' }));
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set in the environment that runs npm start.' }));
    return;
  }
  const { messages: asked, effort } = await readJson(req);
  const { systemPrompt, TOOLS } = await import('./src/ai/catalog.js');
  const room = effort === 'medium' ? 48000 : 12000;   // high thought through 32000 tokens and never answered
  if (process.env.ANTHROPIC_API_KEY) {
    const { askClaude, problemOf } = await import('./src/ai/claude.js');
    const answer = await askClaude({ system: systemPrompt(), messages: asked, tools: TOOLS, effort: effort === 'medium' ? 'medium' : 'low', room }).catch((e) => ({ error: problemOf(e) }));
    res.writeHead(answer.error ? 502 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
    return;
  }
  // a little thinking helps it design, and a set is worth a lot of it; some endpoints refuse a
  // reasoning setting, so retry without
  const messages = asked.map(({ blocks, ...m }) => m);   // Claude's own, from a chat that began on Anthropic
  let r = await openrouter(systemPrompt(), messages, TOOLS, { effort: effort === 'medium' ? 'medium' : 'low' }, room);
  if (r.status === 400 && /reason/i.test(JSON.stringify(r.json))) r = await openrouter(systemPrompt(), messages, TOOLS, null, room);
  const choice = r.json.choices?.[0];
  if (r.status !== 200 || !choice) {
    const msg = r.json.error?.metadata?.raw || r.json.error?.message || `OpenRouter answered ${r.status}`;
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(msg).slice(0, 500) }));
    return;
  }
  const { role, content, tool_calls } = choice.message;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: { role, content: content ?? '', ...(tool_calls?.length ? { tool_calls } : {}) }, finish: choice.finish_reason, usage: r.json.usage, model: r.json.model }));
}

// One decision for the live DJ. It has about a bar to arrive; after that nobody wants it.
async function decide(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req)) return send(403, { error: 'not from this page', status: 403 });
  if (!process.env.OPENROUTER_API_KEY) return send(500, { error: 'OPENROUTER_API_KEY is not set in the environment that runs npm start.', status: 401 });
  const { state, questions } = await readJson(req, 1e5);
  const r = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: DJ_MODEL, state, questions }),
    signal: AbortSignal.timeout(5000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) return send(502, { error: String(json.error?.message ?? `OpenRouter answered ${r.status}`).slice(0, 300), status: r.status });
  return send(200, { answers: json.answers, usage: json.usage, model: json.model });
}

async function readBody(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('that file is too large to separate');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const exists = (file) => access(file).then(() => true, () => false);
let separating = Promise.resolve();   // one at a time: it takes the whole GPU and several GB

async function runDemucs(id, track) {
  const dir = join(STEM_CACHE, id);
  if (await exists(join(dir, 'other.wav'))) return;
  const work = `${dir}.work`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const input = join(work, 'track');
  await writeFile(input, track);
  await new Promise((resolve, reject) => {
    execFile(STEM_PYTHON, ['-m', 'demucs', '-n', STEM_MODEL, '-d', STEM_DEVICE, '-o', work, input], { timeout: 900000, maxBuffer: 1 << 24 }, (e, out, err) => {
      if (e) reject(new Error(String(err || e.message).trim().split('\n').pop().slice(0, 300)));
      else resolve();
    });
  });
  await rm(dir, { recursive: true, force: true });
  await rename(join(work, STEM_MODEL, 'track'), dir);
  await rm(work, { recursive: true, force: true });
}

// The track comes in once and goes through Demucs once; the same bytes find the same stems.
async function stems(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req, 'application/octet-stream')) return send(403, { error: 'not from this page' });
  if (!(await exists(STEM_PYTHON))) return send(501, { error: 'Demucs is not installed: run npm run stems:setup' });
  const track = await readBody(req, 5e8);
  const id = createHash('sha256').update(track).digest('hex');
  const t0 = performance.now();
  const job = separating.then(() => runDemucs(id, track));
  separating = job.catch(() => {});
  await job;
  return send(200, { id, stems: STEMS, seconds: Math.round((performance.now() - t0) / 1000) });
}

async function stemFile(res, id, stem) {
  const body = await readFile(join(STEM_CACHE, id, `${stem}.wav`));
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
  res.end(body);
}

// What's sung in a track, read off its vocals once by whisper.cpp and put back together at the
// commas: a phrase is what someone wants to sample. Its segment times can be 15 s out where a stem
// goes quiet; the DTW times of its tokens were 0.1 to 0.3 s from phrases planted at known times.
const LONGEST_LINE = 8;   // words
const PAUSE = 0.6;        // seconds of nothing that end a line
const MIDDLE = 0.1;       // seconds: a DTW time is the middle of a word, not its start
const CHUNK = [25, 35];   // seconds: left alone with nothing to hear, it says the same thing every 30

function phrases(transcription) {
  const words = [];
  for (const { text, t_dtw: t } of transcription.flatMap((s) => s.tokens)) {
    if (text.startsWith('[_') || t < 0) continue;
    if (text.startsWith(' ') || !words.length) words.push({ text: text.trim(), t: t / 100 });
    else words.at(-1).text += text;
  }
  const lines = [];
  let line = null;
  for (const { text, t } of words) {
    const word = text.replace(/["“”]/g, '');
    if (!word || /^[[(♪]/.test(word)) continue;
    if (!line || t - line.end > PAUSE || line.count >= LONGEST_LINE) lines.push(line = { start: Math.max(0, t - MIDDLE), end: t, text: word, count: 1 });
    else { line.text += ` ${word}`; line.end = t; line.count++; }
    if (/[,.!?;:]$/.test(word)) line = null;
  }
  const seen = Map.groupBy(lines, (l) => l.text.toLowerCase());
  const invented = (same) => same.length > 2 && same.slice(1).every((l, i) => l.start - same[i].start > CHUNK[0] && l.start - same[i].start < CHUNK[1]);
  return lines.filter((l) => !invented(seen.get(l.text.toLowerCase()))).map(({ start, end, text }) => ({ start, end: end + MIDDLE, text: text.replace(/[,;:]$/, '') }));
}

async function runWhisper(id) {
  const file = join(STEM_CACHE, id, 'words.json');
  if (await exists(file)) return JSON.parse(await readFile(file, 'utf8'));
  if (!(await exists(WHISPER)) || !(await exists(WHISPER_MODEL))) return { segments: [] };
  const work = join(STEM_CACHE, `${id}.words`);
  const run = (bin, args) => new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 900000, maxBuffer: 1 << 24 }, (e, out, err) => {
      if (e) reject(new Error(String(err || e.message).trim().split('\n').pop().slice(0, 300)));
      else resolve();
    });
  });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-y', '-i', join(STEM_CACHE, id, 'vocals.wav'), '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', join(work, 'vocals.wav')]);
  await run(WHISPER, ['-m', WHISPER_MODEL, '-f', join(work, 'vocals.wav'), '-ojf', '-of', join(work, 'vocals'), '-l', 'auto', '-np', '-dtw', WHISPER_DTW]);
  const { transcription } = JSON.parse(await readFile(join(work, 'vocals.json'), 'utf8'));
  const heard = { segments: phrases(transcription) };
  await writeFile(file, JSON.stringify(heard));
  await rm(work, { recursive: true, force: true });
  return heard;
}

async function words(req, res, id) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req)) return send(403, { error: 'not from this page' });
  if (!(await exists(join(STEM_CACHE, id, 'vocals.wav')))) return send(404, { error: 'separate the track first' });
  const job = separating.then(() => runWhisper(id));
  separating = job.catch(() => {});
  return send(200, await job.catch((e) => ({ segments: [], error: e.message })));
}

// A plugin is a file or a bundle, and a folder that isn't one may hold more of them
async function pluginsIn(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const path = join(folder, entry.name);
    if (/\.(vst3|component)$/.test(entry.name)) found.push({ path, name: entry.name.replace(/\.\w+$/, ''), format: entry.name.endsWith('.vst3') ? 'VST3' : 'Audio Unit' });
    else if (entry.isDirectory()) found.push(...await pluginsIn(path));
  }
  return found;
}

async function plugins(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req)) return send(403, { error: 'not from this page' });
  const found = (await Promise.all(PLUGIN_FOLDERS.map(pluginsIn))).flat();
  return send(200, { installed: await exists(VST_PYTHON), folders: PLUGIN_FOLDERS, plugins: [...STAND_INS, ...found].sort((a, b) => a.name.localeCompare(b.name)) });
}

// One host per page, gone with the page. Frames arrive from it in whatever pieces the pipe makes of
// them, and a printed track is a lot of pieces, so they're only joined once there's a whole frame.
function hostPlugins(socket) {
  const host = spawn(VST_PYTHON, [join(ROOT, 'tools/vst/host.py'), ...PLUGIN_FOLDERS], { stdio: ['pipe', 'pipe', 'inherit'] });
  let parts = [], have = 0;
  host.stdout.on('data', (chunk) => {
    parts.push(chunk);
    have += chunk.length;
    while (have >= 4) {
      if (parts[0].length < 4) parts = [Buffer.concat(parts)];
      const end = 4 + parts[0].readUInt32LE(0);
      if (have < end) return;
      if (parts.length > 1) parts = [Buffer.concat(parts)];
      socket.send(parts[0].subarray(4, end));
      parts = have > end ? [parts[0].subarray(end)] : [];
      have -= end;
    }
  });
  socket.on('message', (data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(data.length);
    host.stdin.write(length);
    host.stdin.write(data);
  });
  host.stdin.on('error', () => {});   // it crashed: the exit below says so
  host.on('error', () => socket.close(1011, 'the plugin host would not start: run npm run vst:setup'));
  host.on('exit', () => socket.close(1011, 'the plugin host stopped'));
  socket.on('close', () => host.kill());
}

const server = createServer(async (req, res) => {
  try {
    // a website that points its own name at 127.0.0.1 must not reach this server
    if (LOCAL && !LOCAL_NAMES.has(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return undefined;
    }
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/api/chat' && req.method === 'POST') return await chat(req, res);
    if (path === '/api/decide' && req.method === 'POST') return await decide(req, res);
    if (path === '/api/taste' && (req.method === 'GET' || req.method === 'PUT')) return await taste(req, res);
    if (path === '/api/stems' && req.method === 'POST') return await stems(req, res);
    if (path === '/api/vst/plugins' && req.method === 'GET') return await plugins(req, res);
    const sung = /^\/api\/words\/([0-9a-f]{64})$/.exec(path);
    if (sung && req.method === 'POST') return await words(req, res, sung[1]);
    const stem = /^\/api\/stems\/([0-9a-f]{64})\/(\w+)$/.exec(path);
    if (stem && STEMS.includes(stem[2]) && req.method === 'GET') return await stemFile(res, stem[1], stem[2]);
    const parts = path.split('/');
    if (parts.some((p) => p.startsWith('.') || PRIVATE.has(p.toLowerCase()))) throw new Error('bad path');   // macOS ignores case
    let file = join(ROOT, path);
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(body);
  } catch (e) {
    if (!res.headersSent) {
      const api = req.url.startsWith('/api/');
      res.writeHead(api ? 500 : 404, { 'Content-Type': api ? 'application/json' : 'text/plain' });
      res.end(api ? JSON.stringify({ error: e.message }) : 'not found');
    }
  }
});
// Opening a plugin runs what's in it, and a WebSocket has no same-origin rule of its own
const pluginLine = new WebSocketServer({ noServer: true, maxPayload: 2 ** 31 });
server.on('upgrade', (req, socket, head) => {
  const ours = LOCAL && LOCAL_NAMES.has(req.headers.host) && req.headers.origin === `http://${req.headers.host}` && req.url === '/api/vst';
  if (ours) pluginLine.handleUpgrade(req, socket, head, hostPlugins);
  else socket.destroy();
});

server.listen(PORT, HOST, () => console.log(`Soundwerk → http://localhost:${PORT}  (assistant: ${MODEL}, DJ: ${DJ_MODEL})`));
