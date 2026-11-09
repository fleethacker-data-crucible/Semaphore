// AI drafting through Fairlead, the Fleet's model router. The browser never holds the Fairlead key:
// it talks to this Semaphore server's /api/ai/v1 with its session token, and the server adds the key
// and forwards to Fairlead on loopback (server/Intelligence.ps1). With no server, no stored key, or
// AI switched off, local rules draft every flag, and a failing Fairlead falls back to them too.

import type { CatalogIndex } from '../../../src/core/catalog.ts';
import { type ExampleSource, type IntelligenceProvider, LocalRulesProvider } from '../../../src/core/intelligence/index.ts';
import type { FetchLike, OpenAICompatibleProvider } from '../../../src/core/intelligence/remote.ts';
import type { PlaybookEntry } from '../../../src/core/playbook.ts';
import { api, sessionToken } from './api.ts';

export interface AiStatus {
  configured: boolean;
  provider: 'fairlead';
  url: string;
  /** Fairlead route asked for: local (default), auto, smart, fast. */
  model: string;
  /** Requests carry X-Fairlead-Privacy: local, so prompts stay on this computer. */
  privacyLocal: boolean;
  keySource: 'environment' | 'credential-manager' | 'file' | 'local-token' | 'none';
  problem: string | null;
  setup: string;
  /** Something accepts connections on Fairlead's port (GET /api/ai only; who it is, the id check decides). */
  running?: boolean;
}

export interface AiCheck {
  ok: boolean;
  detail: string;
  code?: string;
  models?: string[];
}

const USE_KEY = 'semaphore.ai';
const EXAMPLES_KEY = 'semaphore.ai.examples';
/** The server gives Fairlead 180 s; the browser waits a little longer so the server's message wins. */
const DRAFT_TIMEOUT_MS = 190_000;

/** The server's AI status, or null with no server (or an older one without /api/ai). */
export async function loadAiStatus(): Promise<AiStatus | null> {
  try {
    return await api<AiStatus>('/api/ai');
  } catch {
    return null;
  }
}

export function checkAi(): Promise<AiCheck> {
  return api<AiCheck>('/api/ai/check', { json: {} });
}

/** The analyst's switch, kept per browser. On unless they turned it off. */
export function aiWanted(): boolean {
  try {
    return localStorage.getItem(USE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setAiWanted(on: boolean): void {
  try {
    localStorage.setItem(USE_KEY, on ? 'on' : 'off');
  } catch {
    /* settings are a convenience */
  }
}

/**
 * The analyst's second switch: also send reviewed examples (briefs and catalog keys and labels from
 * the playbook) with a draft request. Kept per browser and OFF unless they turned it on: the briefs
 * are the team's own words, so sharing them is a choice, even when Fairlead keeps them on this computer.
 */
export function aiExamplesWanted(): boolean {
  try {
    return localStorage.getItem(EXAMPLES_KEY) === 'on';
  } catch {
    return false;
  }
}

export function setAiExamplesWanted(on: boolean): void {
  try {
    localStorage.setItem(EXAMPLES_KEY, on ? 'on' : 'off');
  } catch {
    /* settings are a convenience */
  }
}

/**
 * What to pass to draftFlag / draftHoist as `examples`: the playbook's entries when the analyst
 * switched examples on, AI drafting is on and a Fairlead key is stored; otherwise nothing, and no
 * example is built or sent. The request still goes only through this server's relay.
 */
export function examplesFor(wanted: boolean, status: AiStatus | null, useAi: boolean, entries: readonly PlaybookEntry[], user: string): ExampleSource | undefined {
  if (!wanted || !useAi || !status?.configured) return undefined;
  return { entries, names: user ? [user] : [] };
}

export function aiLabel(status: AiStatus): string {
  return status.privacyLocal ? `Fairlead (${status.model}, on this computer)` : `Fairlead (${status.model})`;
}

/** Fairlead through this server when it is configured and wanted; local rules otherwise. */
export function draftingProvider(index: CatalogIndex, status: AiStatus | null, wanted: boolean): IntelligenceProvider {
  if (!status?.configured || !wanted) return new LocalRulesProvider(index);
  const withSession: FetchLike = (url, init) => {
    const headers: Record<string, string> = { ...init.headers };
    const token = sessionToken();
    if (token) headers['X-Semaphore-Session'] = token;
    return fetch(url, { ...init, headers, cache: 'no-store' });
  };
  const settings = { id: 'fairlead', label: aiLabel(status), url: `${location.origin}/api/ai/v1`, model: status.model, timeoutMs: DRAFT_TIMEOUT_MS, fetch: withSession };
  // The model client (remote.ts, with its prompts) loads the first time it is asked something, so a
  // page that never drafts with Fairlead does not carry it (web/size-budget.json).
  let client: Promise<OpenAICompatibleProvider> | null = null;
  const remote = () => (client ??= import('../../../src/core/intelligence/remote.ts').then((m) => new m.OpenAICompatibleProvider(settings)));
  return {
    id: settings.id,
    label: settings.label,
    local: false,
    ping: async () => (await remote()).ping(),
    listModels: async () => (await remote()).listModels(),
    draftFlag: async (r) => (await remote()).draftFlag(r),
    draftHoist: async (r) => (await remote()).draftHoist(r),
    runTask: async (r) => (await remote()).runTask(r),
  };
}
