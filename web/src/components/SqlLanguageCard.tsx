// Settings > SQL: the SQL language this person reads and writes. Generated SQL is shown in it, and SQL
// written in the SQL desk is translated from it into each source's own dialect before it runs, so
// someone used to T-SQL can work against PostgreSQL, Oracle or Spark the same way.

import { SQL_DIALECTS } from '../../../src/core/catalog.ts';
import { DIALECT_NAMES } from '../../../src/core/sql-translate.ts';
import { setSqlPref, type SqlPref, useSqlPref } from '../lib/sql-pref.ts';

export function SqlLanguageCard() {
  const pref = useSqlPref();
  const tile = (on: boolean) => `flex min-h-10 items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm ${on ? 'border-accent bg-accent-soft' : 'border-[var(--fl-control-border)] hover:border-accent'}`;
  const choices: Array<{ id: SqlPref; label: string; hint: string }> = [
    { id: 'source', label: 'As each source speaks', hint: 'No translation: you read and write each database’s own SQL.' },
    ...SQL_DIALECTS.map((d) => ({ id: d as SqlPref, label: DIALECT_NAMES[d], hint: '' })),
  ];
  return (
    <section aria-label="SQL language" className="rounded-lg border border-line bg-panel">
      <header className="border-b border-line px-5 py-4">
        <h3 className="text-sm font-semibold tracking-[-0.01em]">Your SQL language</h3>
        <p className="mt-0.5 text-[12.5px] leading-5 text-ink-2">
          Work in the SQL you know, whatever the database. Flags show their SQL in it, and what you write in the SQL desk is translated into each source&apos;s own dialect before it runs, with the translated text shown first. For you, in this browser.
        </p>
      </header>
      <div className="grid gap-1.5 p-5" role="radiogroup" aria-label="Your SQL language">
        {choices.map((c) => (
          <button key={c.id} type="button" role="radio" aria-checked={pref === c.id} onClick={() => setSqlPref(c.id)} className={tile(pref === c.id)}>
            <span className="min-w-0">
              <span className="block font-medium">{c.label}</span>
              {c.hint && <span className="block text-[12px] text-ink-2">{c.hint}</span>}
            </span>
          </button>
        ))}
        <p className="mt-2 text-[12px] leading-5 text-ink-2">
          Translated: quoted names, row limits (TOP, LIMIT, FETCH FIRST), the current time, null fallbacks (ISNULL, IFNULL, NVL, Nz), text length, substrings, upper and lower case, date truncation, joining text, PostgreSQL&apos;s x::type casts, and true and false. Anything else is passed through, and the SQL desk says what may need a look. Generated SQL is written fresh in your language, so it is always exact.
        </p>
      </div>
    </section>
  );
}
