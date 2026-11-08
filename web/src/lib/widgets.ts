// The team widget library: custom widgets saved to SEMAPHORE_HOME\widgets on the server
// (server/Routes.ps1), so anyone on the team can insert them into a page.

import { type LibraryWidget, parseLibraryWidget } from '../../../src/core/widget-library.ts';
import { api } from './api.ts';

export interface LibraryEntry {
  id: string;
  name: string;
  description: string;
  by: string;
  updated: string;
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  const raw = await api<unknown>('/api/widgets');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && typeof (e as { id?: unknown }).id === 'string')
    .map((e) => ({ id: String(e.id), name: String(e.name ?? e.id), description: typeof e.description === 'string' ? e.description : '', by: typeof e.by === 'string' ? e.by : '', updated: typeof e.updated === 'string' ? e.updated : '' }));
}

export async function loadLibraryWidget(id: string): Promise<LibraryWidget> {
  const raw = await api<unknown>(`/api/widgets/${encodeURIComponent(id)}`);
  const problems: string[] = [];
  const w = parseLibraryWidget(raw, problems);
  if (!w) throw new Error(`That library widget could not be read: ${problems.join(' ')}`);
  return w;
}

/** Saves a new library widget, or replaces one when `id` is given. The server picks the id from the name. */
export async function saveLibraryWidget(w: { id?: string; name: string; description?: string; code: string; css?: string }): Promise<LibraryWidget> {
  const raw = await api<{ ok: boolean; widget: unknown }>('/api/widgets', { json: w });
  const problems: string[] = [];
  const saved = parseLibraryWidget(raw?.widget, problems);
  if (!saved) throw new Error(`The server did not return the saved widget: ${problems.join(' ')}`);
  return saved;
}

export const deleteLibraryWidget = (id: string) => api<{ ok: boolean }>(`/api/widgets/${encodeURIComponent(id)}`, { method: 'DELETE' });
