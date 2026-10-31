// The outcome of a save, kept apart from what the analyst typed: a failure is a different state from a
// success, so it can be shown, announced and retried as a failure. Plain TypeScript so it is tested in Node.

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; message: string }
  | { kind: 'failed'; message: string };

export const IDLE: SaveStatus = { kind: 'idle' };

/** Runs a save and returns how it ended. Never throws: a rejection becomes a `failed` status. */
export async function runSave(save: () => Promise<string>, describeSaved: (name: string) => string): Promise<SaveStatus> {
  try {
    return { kind: 'saved', message: describeSaved(await save()) };
  } catch (e) {
    const why = e instanceof Error && e.message ? e.message : typeof e === 'string' && e ? e : 'the file could not be written';
    return { kind: 'failed', message: why };
  }
}

export interface SavePresentation {
  /** `alert` is announced at once by assistive technology; `status` politely. */
  role: 'alert' | 'status';
  /** Text colour class from the existing tokens. Never the only cue: `label` and `mark` carry the meaning too. */
  tone: 'text-good' | 'text-bad';
  /** A word that is read and seen, so colour is not the only signal. */
  label: 'Saved' | 'Could not save';
  mark: 'ok' | 'error';
  message: string;
  /** Whether to offer the action again. */
  retry: boolean;
}

export function presentSave(status: SaveStatus): SavePresentation | null {
  if (status.kind === 'saved') return { role: 'status', tone: 'text-good', label: 'Saved', mark: 'ok', message: status.message, retry: false };
  if (status.kind === 'failed') return { role: 'alert', tone: 'text-bad', label: 'Could not save', mark: 'error', message: status.message, retry: true };
  return null;
}
