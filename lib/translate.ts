// Wire adapters share an OpenAI-shaped intermediate representation. All IDs and
// timestamps come from upstream or fixed constants, making replay deterministic.
import { openAIToAnthropic, sseEvent } from './wire.ts';
import type { Json } from './providers.ts';

const text = (v: any): string => typeof v === 'string' ? v : (v ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
const args = (v: any): any => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? {}; } catch { return {}; } };
const finish = (v: any): string => ({ end_turn: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' }[v] ?? v ?? 'stop');

export function toAnthropic(body: any, model: string): Json {
  const messages: any[] = [];
  const systems: string[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') { systems.push(text(m.content)); continue; }
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' };
      if (messages.at(-1)?.role === 'user') messages.at(-1).content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    const content: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? []).map((p: any) => {
      if (p.type !== 'image_url') return p;
      const url = p.image_url.url;
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      return { type: 'image', source: match ? { type: 'base64', media_type: match[1], data: match[2] } : { type: 'url', url } };
    });
    for (const c of m.tool_calls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: args(c.function.arguments) });
    messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  const out: any = { model, messages, stream: body.stream === true, max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024 };
  if (systems.length) out.system = systems.join('\n');
  if (body.stop !== undefined) out.stop_sequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  for (const k of ['temperature', 'top_p']) if (body[k] !== undefined) out[k] = body[k];
  if (body.tools) out.tools = body.tools.map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
  if (body.tool_choice) out.tool_choice = typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.function.name } : { type: body.tool_choice === 'required' ? 'any' : body.tool_choice };
  return out;
}

export function toGemini(body: any): Json {
  const systems: any[] = [];
  const names = new Map<string, string>();
  const contents: any[] = [];
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') { systems.push({ text: text(m.content) }); continue; }
    const parts: any[] = [];
    if (m.role === 'tool') parts.push({ functionResponse: { id: m.tool_call_id, name: names.get(m.tool_call_id) ?? m.name ?? m.tool_call_id, response: { result: m.content } } });
    else {
      for (const p of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? []) {
        if (p.type === 'text') parts.push({ text: p.text });
        if (p.type === 'image_url') {
          const url = p.image_url.url;
          const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
          parts.push(match ? { inlineData: { mimeType: match[1], data: match[2] } } : { fileData: { fileUri: url } });
        }
      }
      for (const c of m.tool_calls ?? []) { names.set(c.id, c.function.name); parts.push({ functionCall: { id: c.id, name: c.function.name, args: args(c.function.arguments) } }); }
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  const generationConfig: any = {};
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) generationConfig.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;
  if (body.stop !== undefined) generationConfig.stopSequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    if (body.response_format.json_schema?.schema) generationConfig.responseSchema = body.response_format.json_schema.schema;
  }
  const out: any = { contents, generationConfig };
  if (systems.length) out.systemInstruction = { parts: systems };
  if (body.tools?.length) out.tools = [{ functionDeclarations: body.tools.map((t: any) => ({ name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? {} })) }];
  if (body.tool_choice) out.toolConfig = { functionCallingConfig: typeof body.tool_choice === 'object' ? { mode: 'ANY', allowedFunctionNames: [body.tool_choice.function.name] } : { mode: body.tool_choice === 'required' ? 'ANY' : body.tool_choice === 'none' ? 'NONE' : 'AUTO' } };
  return out;
}

function completion(model: string, message: any, reason: string, input: number, output: number, id = 'chatcmpl-aggregate'): any {
  return { id, object: 'chat.completion', created: 1767225600, model, choices: [{ index: 0, message, finish_reason: reason }], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } };
}
function fromAnthropic(b: any): any {
  const calls = (b.content ?? []).filter((p: any) => p.type === 'tool_use').map((p: any) => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input) } }));
  return { ...completion(b.model, { role: 'assistant', content: text(b.content), ...(calls.length ? { tool_calls: calls } : {}) }, finish(b.stop_reason), b.usage?.input_tokens ?? 0, b.usage?.output_tokens ?? 0, b.id), stop_sequence: b.stop_sequence ?? null };
}
function fromGemini(b: any, model: string): any {
  const c = b.candidates?.[0] ?? {};
  const parts = c.content?.parts ?? [];
  const calls = parts.filter((p: any) => p.functionCall).map((p: any, i: number) => ({ id: p.functionCall.id ?? `call_${i}`, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }));
  return completion(model, { role: 'assistant', content: parts.map((p: any) => p.text ?? '').join(''), ...(calls.length ? { tool_calls: calls } : {}) }, calls.length ? 'tool_calls' : finish(c.finishReason), b.usageMetadata?.promptTokenCount ?? 0, b.usageMetadata?.candidatesTokenCount ?? 0);
}

/** Buffer the upstream SSE so complete tool arguments and final usage survive translation. */
export async function readAnswer(response: Response, wire: string, model: string, stream: boolean): Promise<any> {
  if (!stream) {
    const b = await response.json();
    return wire === 'openai' ? b : wire === 'anthropic' ? fromAnthropic(b) : fromGemini(b, model);
  }
  const raw = await response.text();
  const frames = raw.replace(/\r\n/g, '\n').split('\n\n').flatMap(f => {
    const data = f.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
  });
  if (wire === 'anthropic') {
    const b: any = { model, content: [], usage: {} };
    const partials = new Map<number, string>();
    for (const f of frames) {
      if (f.type === 'message_start') Object.assign(b, f.message);
      if (f.type === 'content_block_start') b.content[f.index] = { ...f.content_block };
      if (f.type === 'content_block_delta') {
        if (f.delta.type === 'text_delta') b.content[f.index].text += f.delta.text;
        if (f.delta.type === 'input_json_delta') partials.set(f.index, (partials.get(f.index) ?? '') + f.delta.partial_json);
      }
      if (f.type === 'message_delta') { Object.assign(b, f.delta); Object.assign(b.usage, f.usage); }
    }
    for (const [i, s] of partials) b.content[i].input = args(s);
    return fromAnthropic(b);
  }
  if (wire === 'gemini') {
    const b: any = { candidates: [{ content: { parts: [] } }] };
    for (const f of frames) {
      const c = f.candidates?.[0];
      if (c) { b.candidates[0].content.parts.push(...(c.content?.parts ?? [])); if (c.finishReason) b.candidates[0].finishReason = c.finishReason; }
      if (f.usageMetadata) b.usageMetadata = f.usageMetadata;
    }
    return fromGemini(b, model);
  }
  const message: any = { role: 'assistant', content: '' };
  const calls: any[] = [];
  const b = completion(model, message, 'stop', 0, 0);
  for (const f of frames) {
    if (f.id) b.id = f.id;
    if (f.usage) b.usage = f.usage;
    const c = f.choices?.[0];
    if (!c) continue;
    if (c.finish_reason) b.choices[0].finish_reason = c.finish_reason;
    message.content += c.delta?.content ?? '';
    for (const t of c.delta?.tool_calls ?? []) {
      const a = calls[t.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (t.id) a.id = t.id;
      a.function.name += t.function?.name ?? '';
      a.function.arguments += t.function?.arguments ?? '';
    }
  }
  if (calls.length) message.tool_calls = calls;
  return b;
}

export function streamAnswer(b: any, api: string): string {
  if (api === 'anthropic') {
    const a: any = openAIToAnthropic(b, b.model);
    let out = sseEvent('message_start', { type: 'message_start', message: { ...a, content: [], stop_reason: null, usage: { input_tokens: a.usage.input_tokens, output_tokens: 0 } } });
    a.content.forEach((c: any, index: number) => {
      out += sseEvent('content_block_start', { type: 'content_block_start', index, content_block: c.type === 'text' ? { type: 'text', text: '' } : { ...c, input: {} } });
      out += sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: c.type === 'text' ? { type: 'text_delta', text: c.text } : { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
      out += sseEvent('content_block_stop', { type: 'content_block_stop', index });
    });
    return out + sseEvent('message_delta', { type: 'message_delta', delta: { stop_reason: a.stop_reason, stop_sequence: a.stop_sequence }, usage: { output_tokens: a.usage.output_tokens } }) + sseEvent('message_stop', { type: 'message_stop' });
  }
  const c = b.choices[0];
  const chunk = (delta: any, reason: any) => sseEvent(null, { id: b.id, object: 'chat.completion.chunk', created: b.created, model: b.model, choices: [{ index: 0, delta, finish_reason: reason }] });
  let out = chunk({ role: 'assistant', content: '' }, null);
  if (c.message.content) out += chunk({ content: c.message.content }, null);
  if (c.message.tool_calls) out += chunk({ tool_calls: c.message.tool_calls.map((t: any, index: number) => ({ index, ...t })) }, null);
  return out + chunk({}, c.finish_reason) + sseEvent(null, { id: b.id, object: 'chat.completion.chunk', created: b.created, model: b.model, choices: [], usage: b.usage }) + 'data: [DONE]\n\n';
}
