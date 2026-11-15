import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, openAIToAnthropic, sseEvent } from '../lib/wire.ts';
import { toAnthropic, toGemini, readAnswer, streamAnswer } from '../lib/translate.ts';

const request = {
  model: 'auto', system: [{ type: 'text', text: 'Keep all fields.' }], max_tokens: 87,
  stop_sequences: ['END'], tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Find this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: '雪' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
  ],
};

test('tool history, image bytes, system, and limits survive upstream translations', () => {
  const o: any = anthropicToOpenAI(request, 'chosen');
  const a: any = toAnthropic(o, 'chosen');
  assert.equal(a.system, 'Keep all fields.');
  assert.equal(a.max_tokens, 87);
  assert.deepEqual(a.stop_sequences, ['END']);
  assert.equal(a.messages[0].content[1].source.data, 'AQID');
  assert.deepEqual(a.messages[1].content[0].input, { q: '雪' });
  assert.equal(a.messages[2].content[0].tool_use_id, 'call_1');
  const g: any = toGemini(o);
  assert.deepEqual(g.contents[0].parts[1].inlineData, { mimeType: 'image/png', data: 'AQID' });
  assert.equal(g.contents[1].parts[0].functionCall.name, 'lookup');
  assert.equal(g.contents[2].parts[0].functionResponse.name, 'lookup');
  assert.equal(g.contents[2].parts[0].functionResponse.response.result, 'found');
});

test('fragmented OpenAI SSE retains tool JSON, finish reason, and late usage', async () => {
  const chunks = [
    { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"q":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"雪"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 23, completion_tokens: 11, total_tokens: 34 } },
  ];
  const encoded = new TextEncoder().encode(chunks.map(c => sseEvent(null, c)).join('') + 'data: [DONE]\n\n');
  const response = new Response(new ReadableStream({ start(c) { for (const byte of encoded) c.enqueue(new Uint8Array([byte])); c.close(); } }));
  const answer = await readAnswer(response, 'openai', 'chosen', true);
  const a: any = openAIToAnthropic(answer, 'chosen');
  assert.equal(a.stop_reason, 'tool_use');
  assert.deepEqual(a.content[0].input, { q: '雪' });
  assert.deepEqual(a.usage, { input_tokens: 23, output_tokens: 11 });
  const stream = streamAnswer(answer, 'anthropic');
  assert.ok(stream.indexOf('content_block_stop') < stream.indexOf('message_delta'));
  assert.ok(stream.endsWith(sseEvent('message_stop', { type: 'message_stop' })));
});

test('Anthropic SSE preserves tool input, refusal/length reasons, and both usage counts', async () => {
  const frames = [
    ['message_start', { message: { id: 'm', model: 'chosen', content: [], usage: { input_tokens: 17, output_tokens: 0 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: 'lookup', input: {} } }],
    ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"snow"}' } }],
    ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }],
  ];
  const wire = frames.map(([type, value]: any) => sseEvent(type, { type, ...value })).join('');
  const a = await readAnswer(new Response(wire), 'anthropic', 'chosen', true);
  assert.equal(a.choices[0].finish_reason, 'tool_calls');
  assert.equal(a.usage.prompt_tokens, 17);
  assert.equal(a.usage.completion_tokens, 9);
  assert.deepEqual(JSON.parse(a.choices[0].message.tool_calls[0].function.arguments), { q: 'snow' });
  for (const [reason, expected] of [['max_tokens', 'length'], ['refusal', 'content_filter'], ['end_turn', 'stop']]) {
    const b = await readAnswer(Response.json({ model: 'chosen', content: [], stop_reason: reason, usage: { input_tokens: 1, output_tokens: 2 } }), 'anthropic', 'chosen', false);
    assert.equal(b.choices[0].finish_reason, expected);
  }
});
