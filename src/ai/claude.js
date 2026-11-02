// The patch assistant on Anthropic's API, for the server. The browser keeps its conversation as the
// OpenAI-style messages OpenRouter takes, so this turns them into Claude's and the answer back.
//
// Thinking is only passed back within a turn. chat.js shortens earlier turns once a new one starts,
// and a thinking block is bound to everything before it, so those turns go without theirs.
//
// eager_input_streaming stays off: nobody watches this stream, and buffering gets the API to check
// a tool's arguments, which a plan of 20 000 tokens needs more than it needs them early.
import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = process.env.SOUNDWERK_CLAUDE_MODEL || 'claude-sonnet-5-5';

const PRICES = { 'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2, write5m: 2.5, write1h: 4 } };   // dollars a million tokens
const FINISH = { end_turn: 'stop', tool_use: 'tool_calls', max_tokens: 'length' };

export const toolsFor = (tools) => tools.map(({ function: f }) => ({ name: f.name, description: f.description, input_schema: f.parameters }));

function partOf(p) {
  if (p.type !== 'image_url') return p;
  const [, media_type, data] = /^data:(.+?);base64,(.*)$/s.exec(p.image_url.url);
  return { type: 'image', source: { type: 'base64', media_type, data } };
}

const assistantBlocks = (m) => m.blocks ?? [
  ...(m.content?.trim() ? [{ type: 'text', text: m.content }] : []),
  ...(m.tool_calls ?? []).map((c) => ({ type: 'tool_use', id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || '{}') })),
];

// Tool answers and whatever follows them are one user turn, with the answers first
export function toClaude(messages) {
  const out = [];
  const fromUser = (blocks) => {
    const last = out.at(-1);
    if (last?.role === 'user') last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'tool') fromUser([{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.role === 'user') fromUser(typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map(partOf));
    else {
      const content = assistantBlocks(m);
      if (content.length) out.push({ role: 'assistant', content });
    }
  }
  return out;
}

function usageOf(u, model) {
  const read = u.cache_read_input_tokens ?? 0, written = u.cache_creation_input_tokens ?? 0;
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0, p = PRICES[model];
  const cost = p && (u.input_tokens * p.input + read * p.read + (written - hour) * p.write5m + hour * p.write1h + u.output_tokens * p.output) / 1e6;
  return { prompt_tokens: u.input_tokens + read + written, completion_tokens: u.output_tokens, prompt_tokens_details: { cached_tokens: read, cache_write_tokens: written }, cost };
}

// A tool call cut off by max_tokens may parse and still be half of what was meant, so it's left out.
// A fallback mid-answer has its own rules for what goes back, and the plain text and calls obey them.
export function fromClaude(reply) {
  if (reply.stop_reason === 'refusal') throw new Error(`Claude declined this${reply.stop_details?.category ? ` (${reply.stop_details.category})` : ''}: ${reply.stop_details?.explanation ?? 'no reason given'}`);
  const cut = reply.stop_reason === 'max_tokens', content = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const calls = cut ? [] : reply.content.filter((b) => b.type === 'tool_use');
  const tool_calls = calls.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  const blocks = calls.length && !reply.content.some((b) => b.type === 'fallback') ? reply.content : null;
  return {
    message: { role: 'assistant', content, ...(calls.length ? { tool_calls } : {}), ...(blocks ? { blocks } : {}) },
    finish: FINISH[reply.stop_reason] ?? reply.stop_reason,
    usage: usageOf(reply.usage, reply.model),
    model: reply.model,
  };
}

// The rules of the set are long and don't change, and a person teaching it can listen for minutes
// between two messages, so they stay cached for an hour and the conversation for the usual five.
export async function askClaude({ system, messages, tools, effort, room }) {
  const stream = new Anthropic().beta.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: room,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort },
    cache_control: { type: 'ephemeral' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: toClaude(messages),
    tools: toolsFor(tools),
  });
  return fromClaude(await stream.finalMessage());
}

// What to tell the user. The SDK has already retried what can be retried.
export function problemOf(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Anthropic refused ANTHROPIC_API_KEY.';
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic is rate limiting this key: give it a minute.';
  if (e instanceof Anthropic.APIConnectionError) return `Could not reach Anthropic: ${e.message}`;
  return e.message;
}
