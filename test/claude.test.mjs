// The patch assistant on Anthropic's API, against a stand-in that speaks its stream: what goes out
// is what the API documents, and what comes back is what the chat already reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CLAUDE_MODEL, askClaude, fromClaude, problemOf, toClaude, toolsFor } from '../src/ai/claude.js';
import { TOOLS } from '../src/ai/catalog.js';

const usage = { input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 50000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } };
const reply = (more) => ({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage, ...more });

test('the chat runs on Sonnet 5.5', () => assert.equal(CLAUDE_MODEL, 'claude-sonnet-5-5'));

test('a conversation in the browser\'s shape becomes Claude\'s', () => {
  const said = toClaude([
    { role: 'user', content: 'make it acid' },
    { role: 'assistant', content: 'On it.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'listen', arguments: '{"bars":4}' } }, { id: 'b', type: 'function', function: { name: 'edit_patch', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'loud' },
    { role: 'tool', tool_call_id: 'b', content: 'done' },
    { role: 'user', content: [{ type: 'text', text: 'Spectrogram:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'thanks' },
  ]);
  assert.deepEqual(said.map((m) => m.role), ['user', 'assistant', 'user'], 'a tool answer and what follows it are one turn');
  assert.deepEqual(said[1].content, [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'a', name: 'listen', input: { bars: 4 } }, { type: 'tool_use', id: 'b', name: 'edit_patch', input: {} }]);
  assert.deepEqual(said[2].content.map((b) => b.type), ['tool_result', 'tool_result', 'text', 'image', 'text'], 'the answers first');
  assert.deepEqual(said[2].content[3].source, { type: 'base64', media_type: 'image/png', data: 'QUJD' });
});

test('thinking goes back exactly as it came, and the blocks a turn kept take the place of its calls', () => {
  const blocks = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'a', name: 'listen', input: {} }];
  assert.deepEqual(toClaude([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [], blocks }])[1].content, blocks);
});

test('every tool of the chat is offered in Claude\'s shape', () => {
  const tools = toolsFor(TOOLS);
  assert.equal(tools.length, TOOLS.length);
  assert.ok(tools.every((t) => t.name && t.description && t.input_schema?.type === 'object'));
  assert.ok(tools.some((t) => t.name === 'offer_transition'));
});

test('the answer reads like the ones the chat already takes, with what it cost', () => {
  const calls = fromClaude(reply({ stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Listening.' }, { type: 'tool_use', id: 'a', name: 'listen', input: { bars: 4 } }] }));
  assert.equal(calls.finish, 'tool_calls');
  assert.equal(calls.message.content, 'Listening.');
  assert.deepEqual(calls.message.tool_calls, [{ id: 'a', type: 'function', function: { name: 'listen', arguments: '{"bars":4}' } }]);
  assert.equal(calls.message.blocks.length, 3, 'kept for the next round of this turn');
  assert.equal(fromClaude(reply()).message.blocks, undefined, 'and a turn that ends needs none');
  assert.deepEqual(calls.usage.prompt_tokens_details, { cached_tokens: 50000, cache_write_tokens: 3000 });
  assert.equal(calls.usage.prompt_tokens, 53100);
  assert.ok(Math.abs(calls.usage.cost - (100 * 2 + 50000 * 0.2 + 1000 * 2.5 + 2000 * 4 + 1000 * 10) / 1e6) < 1e-9);
});

test('a tool call cut off halfway is never run, and a refusal is said out loud', () => {
  const cut = fromClaude(reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Here it comes' }, { type: 'tool_use', id: 'a', name: 'set_plan', input: { brief: 'half' } }] }));
  assert.equal(cut.finish, 'length');
  assert.equal(cut.message.tool_calls, undefined);
  assert.equal(cut.message.blocks, undefined);
  assert.throws(() => fromClaude(reply({ stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'no' }, content: [] })), /declined this \(cyber\): no/);
  assert.equal(fromClaude(reply({ stop_reason: 'tool_use', content: [{ type: 'fallback', from: {}, to: {} }, { type: 'tool_use', id: 'a', name: 'listen', input: {} }] })).message.blocks, undefined, 'after a fallback only the text and the calls go back');
});

// Speaks the Messages stream, and keeps what it was sent
function standIn(respond) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    respond(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function stream(res, blocks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 } } });
  blocks.forEach(({ start, deltas }, index) => {
    send('content_block_start', { index, content_block: start });
    for (const delta of deltas) send('content_block_delta', { index, delta });
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 50 } });
  send('message_stop', {});
  res.end();
}

test('through the real SDK: the request is what the docs ask for, and the stream comes back whole', async (t) => {
  const { server, seen, url } = await standIn((res) => stream(res, [
    { start: { type: 'thinking', thinking: '', signature: '' }, deltas: [{ type: 'signature_delta', signature: 'sealed' }] },
    { start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: 'Lis' }, { type: 'text_delta', text: 'tening.' }] },
    { start: { type: 'tool_use', id: 'toolu_1', name: 'listen', input: {} }, deltas: [{ type: 'input_json_delta', partial_json: '{"bars"' }, { type: 'input_json_delta', partial_json: ':8}' }] },
  ]));
  t.after(() => server.close());
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: url });
  const answer = await askClaude({ system: 'the guide', messages: [{ role: 'user', content: 'hello' }], tools: TOOLS, effort: 'low', room: 12000 });
  assert.equal(answer.finish, 'tool_calls');
  assert.equal(answer.message.content, 'Listening.');
  assert.deepEqual(JSON.parse(answer.message.tool_calls[0].function.arguments), { bars: 8 });
  assert.equal(answer.message.blocks[0].signature, 'sealed');
  const [{ url: path, headers, body }] = seen;
  assert.match(path, /^\/v1\/messages/);
  assert.equal(headers.authorization, 'Bearer test');
  assert.match(headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the longer one first');
  assert.equal(body.max_tokens, 12000);
  assert.equal(body.tool_choice, undefined, 'forced tool use is refused on this model');
  assert.ok(!body.tools.some((x) => x.eager_input_streaming));
});

test('a key that is refused is said in words', async (t) => {
  const { server, url } = await standIn((res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })); });
  t.after(() => server.close());
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'bad', ANTHROPIC_BASE_URL: url });
  await assert.rejects(askClaude({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], effort: 'low', room: 100 }), (e) => problemOf(e) === 'Anthropic refused ANTHROPIC_API_KEY.');
});
