// Remote providers. Same two shapes as Shellback: an OpenAI-compatible gateway (most enterprise
// gateways, Azure OpenAI, Ollama and LM Studio speak it) or a platform-owned endpoint that
// implements the Semaphore contract. Vendor-specific adapters belong on the server side.
//
// Requests omit credentials and referrer, time out, and return raw JSON for the caller to
// validate. The bearer token is passed in by the caller after it is unlocked from the vault;
// this module never stores it.

import {
  CONTRACT_VERSION,
  type DraftFlagRequest,
  type DraftHoistRequest,
  IntelligenceError,
  type IntelligenceProvider,
  type TaskRequest,
} from './contract.ts';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; credentials: 'omit'; referrerPolicy: 'no-referrer' }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface RemoteSettings {
  id: string;
  label: string;
  /** Contract endpoint URL, or an OpenAI-compatible API base ending in /v1. */
  url: string;
  model?: string;
  token?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

const DEFAULT_TIMEOUT = 30_000;
/** Largest response body accepted from a provider. */
export const MAX_RESPONSE_CHARS = 2_000_000;
const PING_TIMEOUT = 15_000;

abstract class RemoteBase {
  readonly local = false;
  readonly id: string;
  readonly label: string;
  protected readonly s: RemoteSettings;
  protected readonly fetcher: FetchLike;

  constructor(settings: RemoteSettings) {
    const u = safeUrl(settings.url);
    this.s = { ...settings, url: u };
    this.id = settings.id;
    this.label = settings.label;
    const f = settings.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new IntelligenceError('No fetch implementation is available.');
    this.fetcher = f;
  }

  protected async call(url: string, method: 'GET' | 'POST', body: unknown, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.s.token) headers.Authorization = `Bearer ${this.s.token}`;
    try {
      const res = await this.fetcher(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      const text = await res.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new IntelligenceError(`${this.label} sent an answer larger than Semaphore accepts.`);
      if (!res.ok) throw new IntelligenceError(`${this.label} answered HTTP ${res.status}${detail(text)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new IntelligenceError(`${this.label} did not return JSON.`);
      }
    } catch (e) {
      if (e instanceof IntelligenceError) throw e;
      if (controller.signal.aborted) throw new IntelligenceError(`${this.label} did not answer within ${Math.round(timeoutMs / 1000)} s.`);
      throw new IntelligenceError(`${this.label} could not be reached: ${scrub((e as Error).message, this.s.token)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A platform-side endpoint implementing contract v1 (see docs/INTELLIGENCE_PROVIDERS.md). */
export class ContractProvider extends RemoteBase implements IntelligenceProvider {
  private async task(payload: Record<string, unknown>, timeout = this.s.timeoutMs ?? DEFAULT_TIMEOUT): Promise<unknown> {
    const out = await this.call(this.s.url, 'POST', { contract: CONTRACT_VERSION, ...(this.s.model ? { model: this.s.model } : {}), payload }, timeout);
    if (!isObject(out)) throw new IntelligenceError(`${this.label} returned an unexpected shape.`);
    if (out.ok !== true) throw new IntelligenceError(`${this.label}: ${typeof out.error === 'string' ? out.error.slice(0, 400) : 'request failed'}`);
    return out.result;
  }
  async ping(): Promise<string> {
    const r = await this.task({ task: 'ping' }, PING_TIMEOUT);
    return isObject(r) && typeof r.detail === 'string' ? r.detail.slice(0, 200) : `${this.label} is reachable.`;
  }
  async listModels(): Promise<string[]> {
    const r = await this.task({ task: 'list-models' }, PING_TIMEOUT);
    return isObject(r) && Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === 'string').slice(0, 200) : [];
  }
  draftFlag(request: DraftFlagRequest): Promise<unknown> {
    return this.task({ ...request });
  }
  draftHoist(request: DraftHoistRequest): Promise<unknown> {
    return this.task({ ...request });
  }
  runTask(request: TaskRequest): Promise<unknown> {
    return this.task({ task: request.task, ...request.payload });
  }
}

/** Any OpenAI-compatible chat completions API. Semaphore writes the prompts. */
export class OpenAICompatibleProvider extends RemoteBase implements IntelligenceProvider {
  private get base(): string {
    return this.s.url.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  }
  async ping(): Promise<string> {
    const models = await this.listModels();
    return models.length ? `${this.label} is reachable; ${models.length} models available.` : `${this.label} is reachable.`;
  }
  async listModels(): Promise<string[]> {
    const r = await this.call(`${this.base}/models`, 'GET', undefined, PING_TIMEOUT);
    if (!isObject(r) || !Array.isArray(r.data)) return [];
    return r.data.map((m) => (isObject(m) && typeof m.id === 'string' ? m.id : null)).filter((m): m is string => !!m).slice(0, 200);
  }
  draftFlag(request: DraftFlagRequest): Promise<unknown> {
    return this.complete(FLAG_PROMPT, request);
  }
  draftHoist(request: DraftHoistRequest): Promise<unknown> {
    return this.complete(HOIST_PROMPT, request);
  }
  runTask(request: TaskRequest): Promise<unknown> {
    return this.complete(request.system, { task: request.task, ...request.payload });
  }
  /** Set once a model has refused temperature 0 (GPT-5 and o-series take only the default). */
  private defaultTemperature = false;
  private async complete(system: string, request: unknown): Promise<unknown> {
    const body = (steady: boolean) => ({
      ...(this.s.model ? { model: this.s.model } : {}),
      ...(steady ? { temperature: 0 } : {}),
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(request) },
      ],
    });
    const url = `${this.base}/chat/completions`;
    const timeout = this.s.timeoutMs ?? DEFAULT_TIMEOUT;
    let r: unknown;
    try {
      r = await this.call(url, 'POST', body(!this.defaultTemperature), timeout);
    } catch (e) {
      // A model that refuses temperature 0 is asked again with its default, and from then on.
      if (this.defaultTemperature || !(e instanceof IntelligenceError) || !/HTTP 4\d\d.*temperature/is.test(e.message)) throw e;
      this.defaultTemperature = true;
      r = await this.call(url, 'POST', body(false), timeout);
    }
    const content = isObject(r) && Array.isArray(r.choices) && isObject(r.choices[0]) && isObject(r.choices[0].message) ? r.choices[0].message.content : null;
    if (typeof content !== 'string') throw new IntelligenceError(`${this.label} returned no message.`);
    try {
      return JSON.parse(stripFence(content));
    } catch {
      throw new IntelligenceError(`${this.label} did not answer in JSON.`);
    }
  }
}

const SHARED_RULES = `Use only keys from "catalog". Metric keys go in "metrics"; field keys go in "dimensions", "filters", "ignore" and sorts. A date dimension may have "grain": day|week|month|quarter|year, and its sort key is "<field>@<grain>". Filter ops: in, eq, gte, lte, between (two values), last (one whole number plus "unit"). Kinds: kpi (no dimensions), bar, line, area, pie (one dimension), table, filter (one dimension, no metrics, onClick "filter-page"), text. onClick: filter-page | drill | none. Thresholds: {metric, op: lt|lte|gt|gte, value, tone: good|warn|bad}. Every metric and field has a "set": one flag uses keys from one set only: choose the set that has everything the brief names, even when another set has a metric with the same label. Use only the metrics the brief asks for, usually one or two. Add thresholds only when the brief asks for a colour rule. If something the analyst asked for is not in the catalog, say so in "notes" and leave it out. Never invent keys. If "teamStyle" is given, it says how this team builds flags: follow it wherever the brief does not say otherwise. Answer with JSON only.`;

const FLAG_PROMPT = `You configure one dashboard block ("flag") in Semaphore, a BI tool. The request has the dashboard brief ("brief.hoist"), this block's brief ("brief.flag", which wins where they disagree), page filters, the block's current kind and a catalog of metrics and fields. If "brief.auto" is true the analyst left the kind to you: pick the kind that fits what the brief asks for (a breakdown by a field is a bar or table, a trend is a line). Otherwise keep the current kind unless the brief names another. Return {"kind","title","binding":{"metrics":[],"dimensions":[{"field","grain"?}],"filters":[],"sort"?:{"by","dir"},"limit"?},"behavior":{"onClick","ignore":[],"thresholds":[]},"confidence":0..1,"notes":[]}. ${SHARED_RULES}`;

const HOIST_PROMPT = `You lay out a whole dashboard ("hoist") in Semaphore, a BI tool, from the analyst's brief and a catalog of metrics and fields. Return {"title","filters":[],"flags":[{"kind","title","brief","binding","behavior","confidence","notes"}],"notes":[]} with at most 12 flags: headline KPIs first, then charts, then any filter flags the brief asks for. Each flag's "brief" is one plain sentence the analyst can edit later. ${SHARED_RULES}`;

export function safeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new IntelligenceError('The provider URL is not a valid URL.');
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new IntelligenceError('Providers must use HTTPS (plain HTTP is allowed only on this computer).');
  }
  if (u.username || u.password) throw new IntelligenceError('Put the token in the vault, not in the URL.');
  return u.toString();
}

/** Remove a Markdown code fence around a JSON answer. No regex: provider text is untrusted. */
export function stripFence(s: string): string {
  let t = s.trim();
  if (!t.startsWith('```')) return t;
  const nl = t.indexOf('\n');
  t = nl === -1 ? t.slice(3) : t.slice(nl + 1);
  t = t.trimEnd();
  if (t.endsWith('```')) t = t.slice(0, -3);
  return t.trim();
}

function detail(text: string): string {
  try {
    const j = JSON.parse(text);
    const msg = isObject(j) ? (isObject(j.error) ? j.error.message : j.error) : null;
    return typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : '.';
  } catch {
    return '.';
  }
}

function scrub(message: string, token?: string): string {
  return token ? message.split(token).join('[token]') : message;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
