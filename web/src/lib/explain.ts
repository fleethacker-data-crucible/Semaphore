// explainError (#69): a flag whose query failed says why in plain words and offers exactly one next
// move. FlagCard (the flags agent's) renders `text` and a button for `action`; what the button does
// is the caller's: retry the query, open Data, redraft, show the flag as a table, open Clean, run a
// held lake query, or nothing more than a retry after unlocking Lazarette.
//
//   explainError(e: unknown): ExplainedError
//   ExplainedError = { text: string; action: { kind: FlagErrorActionKind; label: string } }

import { ApiError, describeError } from './api.ts';

export type FlagErrorActionKind = 'retry' | 'open-data' | 'redraft' | 'table' | 'clean' | 'approve';

export interface ExplainedError {
  /** What went wrong, for the analyst. */
  text: string;
  /** The one next move. */
  action: { kind: FlagErrorActionKind; label: string };
}

const ACTION_LABEL: Record<FlagErrorActionKind, string> = {
  retry: 'Try again',
  'open-data': 'Open Data',
  redraft: 'Redraft',
  table: 'Show as table',
  clean: 'Clean the data',
  approve: 'Run it',
};

function act(kind: FlagErrorActionKind, text: string): ExplainedError {
  return { text, action: { kind, label: ACTION_LABEL[kind] } };
}

const RULES: Array<{ test: RegExp; kind: FlagErrorActionKind; lead?: string }> = [
  // The source is not reachable from this computer, or has no rows loaded.
  { test: /is not set up on this computer|needs the semaphore server|no rows are loaded|unknown source|unsupported sql dialect/i, kind: 'open-data', lead: 'This flag’s source is not available here.' },
  // The catalog changed under the flag: a field or measure it names is gone or out of reach.
  { test: /unknown field|is not in .* or a table joined|is not read by this query|cannot be turned into sql|no longer plans|nothing to select|needs a field|has no count\(distinct/i, kind: 'redraft', lead: 'This flag asks for something the catalog no longer has.' },
  // Too many rows or bars to draw as a chart.
  { test: /row cap|too many rows|too many (bars|categories|points)|truncated|more than [\d,]+ rows/i, kind: 'table', lead: 'There is more here than a chart can show.' },
  // A value in the data could not be read as the type the catalog expects.
  { test: /is not a (number|date)|is not true or false|could not be (read|parsed)|conversion failed|invalid (date|number)|cannot convert/i, kind: 'clean', lead: 'Some values in the data could not be read.' },
  // The database refused the SQL (a renamed column, a typo the catalog carried in).
  { test: /invalid column|invalid object name|no such column|syntax error|ambiguous column|does not exist/i, kind: 'redraft', lead: 'The database did not accept this flag’s query.' },
];

export function explainError(e: unknown): ExplainedError {
  // A lake query held by the cost guard (lib/data.ts ApprovalNeeded, or the server's 409).
  if ((e instanceof Error && e.name === 'ApprovalNeeded') || (e instanceof ApiError && e.code === 'lake-approval')) return act('approve', describeError(e));
  if (e instanceof ApiError) {
    if (e.code === 'network' || e.status === 0) return act('retry', describeError(e));
    if (e.code === 'vault-locked') return act('retry', describeError(e));
    if (e.code === 'vault-item') return act('open-data', describeError(e));
    if (e.code === 'lake-daily-limit') return act('redraft', `${describeError(e)} Redraft with a shorter time window.`);
    if (e.code === 'session') return act('retry', describeError(e));
  }
  const text = describeError(e);
  for (const r of RULES) {
    if (r.test.test(text)) return act(r.kind, r.lead && !text.startsWith(r.lead) ? `${r.lead} ${text}` : text);
  }
  return act('retry', text);
}
