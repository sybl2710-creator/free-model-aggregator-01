// Deterministic free-model gateway. Catalogs are probed once; routing uses only
// brief data, observed call counts, and provider responses.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  capabilitiesOf,
  isRecord,
  joinBase,
  meetsRequirements,
  modelFree,
  probeProvider,
  ratingOfModel,
  readBrief,
  type CatalogReport,
  type Json,
  type Probe,
  type ProbedModel,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIModelList,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

import { toAnthropic, toGemini, readAnswer, streamAnswer } from './lib/translate.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** How long one provider's catalog probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 5000;
/** The most bytes of one client request body the server reads. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
/** How many client API requests have arrived: the manifest is in arrival order, one request at a time. */
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** Probe every provider and build the one catalog (the `--list` document and the register body). */
async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(ENV_URL, probes, brief.ratings);
}

const byId = (a: ProbedModel, b: ProbedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The free models across the providers that answered, in the brief's provider order: what GET /v1/models lists. */
function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

interface Route {
  probe: Probe;
  model: ProbedModel;
}

// Permanently exhausted tiers are retired; transient refusals only skip the
// provider for the current request, so later calls can recover.
const unavailable = new Set<string>();
const calls = new Map<string, number>();
function routesFor(requires: Requirement): Route[] {
  const routes: Route[] = [];
  for (const probe of probes) {
    if (!probe.ok || unavailable.has(probe.provider.id)) continue;
    // Anthropic Messages has no response_format. JSON requests must use a wire
    // that can preserve it, even if an Anthropic model advertises JSON ability.
    if (requires.json && probe.provider.wire === 'anthropic') continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (modelFree(model, row) && meetsRequirements(requires, capabilitiesOf(model, row))) routes.push({ probe, model });
    }
  }
  return routes.sort((a, b) => {
    const ar = ratingOfModel(brief.ratings, a.probe.provider.id, a.model.id)?.rating_milli ?? 0;
    const br = ratingOfModel(brief.ratings, b.probe.provider.id, b.model.id)?.rating_milli ?? 0;
    return br - ar || (calls.get(a.probe.provider.id) ?? 0) - (calls.get(b.probe.provider.id) ?? 0) ||
      a.probe.provider.id.localeCompare(b.probe.provider.id) || byId(a.model, b.model);
  });
}

/** The requirements of the request now arriving: the manifest's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  // Without a manifest, derive the capabilities that the body explicitly needs.
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** Translate to the provider's actual wire, preserving the streaming request. */
async function callProvider(route: Route, body: Json, version: string, originalAnthropic?: Json): Promise<Response> {
  const p = route.probe.provider;
  const base = joinBase(ENV_URL, p.base);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(p.auth, process.env[p.key_env] ?? p.key) };
  let upstream: Json = { ...body, model: route.model.id };
  let path = '/v1/chat/completions';
  if (p.wire === 'anthropic') {
    headers['anthropic-version'] = version;
    path = '/v1/messages';
    upstream = originalAnthropic ? { ...originalAnthropic, model: route.model.id } : toAnthropic(upstream, route.model.id);
  } else if (p.wire === 'gemini') {
    path = `/v1beta/models/${encodeURIComponent(route.model.id)}:${body.stream === true ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    upstream = toGemini(upstream);
  } else if (body.stream === true) upstream.stream_options = { include_usage: true };
  return fetch(base + path, { method: 'POST', headers, body: JSON.stringify(upstream), signal: AbortSignal.timeout(15000) });
}

async function serve(req: IncomingMessage, res: ServerResponse, api: 'openai' | 'anthropic'): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, api, 400, 'invalid_request_error', 'expected a JSON object');
  const requires = { ...requirementsFor(body), ...Object.fromEntries(Object.entries(requirementsFromBody(body)).filter(([, v]) => v === true)) };
  const normalized = api === 'anthropic' ? anthropicToOpenAI(body, 'auto') : body;
  const attempted = new Set<string>();
  for (const route of routesFor(requires)) {
    const p = route.probe.provider;
    if (attempted.has(p.id)) continue;
    attempted.add(p.id);
    calls.set(p.id, (calls.get(p.id) ?? 0) + 1);
    let upstream: Response;
    try {
      upstream = await callProvider(route, normalized, String(req.headers['anthropic-version'] ?? '2023-06-01'), api === 'anthropic' ? body : undefined);
    } catch {
      unavailable.add(p.id);
      continue;
    }
    if (!upstream.ok) {
      const errorText = await upstream.text();
      if (upstream.status === 402 || upstream.status === 429 || upstream.status >= 500) {
        if (/budget is spent|\bis out\b|exhausted|quota.*exceeded/i.test(errorText)) unavailable.add(p.id);
        continue;
      }
      return sendError(res, api, upstream.status, 'upstream_error', `provider returned HTTP ${upstream.status}`);
    }
    const answer = await readAnswer(upstream, p.wire, route.model.id, body.stream === true);
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(streamAnswer(answer, api));
    } else sendJson(res, 200, api === 'anthropic' ? openAIToAnthropic(answer, route.model.id) : answer);
    return;
  }
  sendError(res, api, 503, 'overloaded_error', 'no available free model meets the request');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await serve(req, res, 'openai');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await serve(req, res, 'anthropic');
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the workload's size. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} answered providers and ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
