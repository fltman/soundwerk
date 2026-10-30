// Static server (no build step) + /api/chat, which forwards the patch assistant's
// conversation to OpenRouter (the API key stays here; the browser never sees it),
// + /api/decide, which does the same for the live DJ's decisions.
// The two Cross-Origin headers give the page SharedArrayBuffer, which is how the audio
// thread hands meters, LEDs and scope traces to the wall without allocating.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8280;
const HOST = process.env.HOST || '127.0.0.1'; // local only: /api/chat spends your OpenRouter credit
const MODEL = process.env.SOUNDWERK_MODEL || 'anthropic/claude-sonnet-5.5';
const DJ_MODEL = process.env.SOUNDWERK_DJ_MODEL || 'inception/mercury-decide';
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const LOCAL = HOST === '127.0.0.1' || HOST === 'localhost';
const LOCAL_NAMES = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const PRIVATE = new Set(['vault', 'node_modules']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.md': 'text/markdown; charset=utf-8',
};

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

async function openrouter(system, messages, tools, reasoning) {
  const body = {
    model: MODEL,
    max_tokens: 12000,
    // the long, unchanging system prompt is cached between turns
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
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: { message: text.slice(0, 300) } }; }
  return { status: res.status, json };
}

// /api/chat spends real money, so only this app's own page may call it. A cross-site form can't
// send application/json, and a page elsewhere always shows up in Origin.
function sameSite(req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim();
  const origin = req.headers.origin;
  return type === 'application/json' && (!origin || origin === `http://${req.headers.host}`);
}

async function chat(req, res) {
  if (!sameSite(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not from this page' }));
    return;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OPENROUTER_API_KEY is not set in the environment that runs npm start.' }));
    return;
  }
  const { messages } = await readJson(req);
  const { systemPrompt, TOOLS } = await import('./src/ai/catalog.js');
  // a little thinking helps it design; some endpoints refuse a reasoning setting, so retry without
  let r = await openrouter(systemPrompt(), messages, TOOLS, { effort: 'low' });
  if (r.status === 400 && /reason/i.test(JSON.stringify(r.json))) r = await openrouter(systemPrompt(), messages, TOOLS, null);
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
server.listen(PORT, HOST, () => console.log(`Soundwerk → http://localhost:${PORT}  (assistant: ${MODEL}, DJ: ${DJ_MODEL})`));
