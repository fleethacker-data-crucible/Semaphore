// Import from Qlik: paste a load script and chart expressions; Semaphore reads them (src/core/qlik.ts),
// the analyst maps each Qlik connection to a Semaphore source and picks the tables, and the import
// profiles those tables, labels their fields with Qlik's names and adds the measures. Expressions it
// cannot read become flags to draft (by the AI when it is on, or by hand).

import { useMemo, useState } from 'react';
import { ArrowRight, CircleAlert, FileCode2, Link2, Sparkles, Wand2, X } from 'lucide-react';
import { parseLoadScript, parseQlikExpression, qlikAssociations, qlikLabels, qlikMappings, type QlikScript } from '../../../src/core/qlik.ts';
import type { ServerSource } from '../lib/api.ts';

export interface QlikImportPlan {
  tables: Array<{ source: string; table: string; labels: Map<string, string> }>;
  expressions: string;
}

export interface QlikImportProps {
  sources: ServerSource[];
  busy: string | null;
  onImport: (plan: QlikImportPlan) => Promise<string[]>;
  onDraftAsFlag: (title: string, brief: string) => void;
  onClose: () => void;
}

const EXAMPLE_HINT = `LIB CONNECT TO 'Maintenance Warehouse';
WorkOrders:
LOAD wo_id AS [Work Order], region AS Region, labor_cost AS [Labor Cost];
SQL SELECT wo_id, region, labor_cost FROM work_orders;`;

export function QlikImport({ sources, busy, onImport, onDraftAsFlag, onClose }: QlikImportProps) {
  const [script, setScript] = useState('');
  const [expressions, setExpressions] = useState('');
  const [read, setRead] = useState<QlikScript | null>(null);
  const [connMap, setConnMap] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<string[] | null>(null);

  const labels = useMemo(() => (read ? qlikLabels(read) : new Map<string, Map<string, string>>()), [read]);
  const associations = useMemo(() => (read ? qlikAssociations(read) : []), [read]);
  const mappings = useMemo(() => (read ? qlikMappings(read) : []), [read]);
  const exprs = useMemo(
    () =>
      expressions
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 200)
        .map((line) => {
          const m = /^([^:(){}=]{1,80}):\s*(.+)$/.exec(line);
          const expression = m ? m[2]!.trim() : line;
          return { line, label: m ? m[1]!.trim() : expression.slice(0, 60), expression, parsed: parseQlikExpression(expression) };
        }),
    [expressions],
  );
  const importable = (read?.tables ?? []).filter((t) => t.kind === 'sql' && t.from);
  const files = (read?.tables ?? []).filter((t) => t.kind === 'file');

  const readScript = () => {
    const s = parseLoadScript(script);
    setRead(s);
    setResult(null);
    // A connection whose name matches a source label is mapped already.
    const next: Record<string, string> = {};
    for (const c of s.connections) {
      const hit = sources.find((src) => src.label.toLowerCase() === c.toLowerCase() || c.toLowerCase().includes(src.label.toLowerCase()) || src.label.toLowerCase().includes(c.toLowerCase()));
      next[c] = hit?.id ?? (sources.length === 1 ? sources[0]!.id : '');
    }
    setConnMap(next);
    setPicked(Object.fromEntries(s.tables.filter((t) => t.kind === 'sql' && t.from).map((t) => [t.label, true])));
  };

  const sourceFor = (connection?: string) => (connection ? connMap[connection] : sources.length === 1 ? sources[0]!.id : '') || '';

  const run = async () => {
    const tables = importable
      .filter((t) => picked[t.label] && sourceFor(t.connection))
      .map((t) => ({ source: sourceFor(t.connection), table: t.from!.split('.').pop()!, labels: labels.get(t.from!) ?? new Map<string, string>() }));
    setResult(await onImport({ tables, expressions }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/30 p-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-label="Import from Qlik" className="w-[760px] max-w-full rounded-lg border border-line bg-panel shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FileCode2 size={16} className="text-brass" />
          <h2 className="flex-1 text-base font-semibold">Import from Qlik</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-3 hover:bg-panel-2">
            <X size={16} />
          </button>
        </header>
        <div className="space-y-4 p-4">
          <p className="text-xs text-ink-2">
            Paste the app's load script (Data load editor) and, optionally, its chart expressions, one per line as <code>Label: expression</code>. Semaphore reads them without a model, profiles the real tables for types, and uses Qlik's names as the labels. You review everything before it is added.
          </p>
          <label className="block text-xs font-semibold">
            Load script
            <textarea id="qlik-script" value={script} onChange={(e) => setScript(e.target.value.slice(0, 500_000))} rows={8} placeholder={EXAMPLE_HINT} className="mt-1 block w-full rounded-md border border-line bg-panel-2 p-2 font-mono text-xs font-normal" />
          </label>
          <label className="block text-xs font-semibold">
            Chart expressions (optional)
            <textarea id="qlik-expressions" value={expressions} onChange={(e) => setExpressions(e.target.value.slice(0, 50_000))} rows={4} placeholder={"Labor cost: Sum([Labor Cost])\nHulls affected: Count(DISTINCT HullNo)\nGulf labor: Sum({<Region={'Gulf'}>} [Labor Cost])"} className="mt-1 block w-full rounded-md border border-line bg-panel-2 p-2 font-mono text-xs font-normal" />
          </label>
          <button type="button" onClick={readScript} disabled={!script.trim() && !expressions.trim()} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
            <Wand2 size={14} /> Read it
          </button>

          {read && (
            <div className="space-y-4">
              {read.connections.length > 0 && (
                <div className="space-y-1.5">
                  <h3 className="text-sm font-semibold">Connections</h3>
                  {read.connections.map((c) => (
                    <div key={c} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{c}</span>
                      <ArrowRight size={14} className="text-ink-3" />
                      <select aria-label={`Semaphore source for ${c}`} value={connMap[c] ?? ''} onChange={(e) => setConnMap((m) => ({ ...m, [c]: e.target.value }))} className="rounded-md border border-line bg-panel px-2 py-1 text-xs">
                        <option value="">Choose a source…</option>
                        {sources.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {sources.length === 0 && <p className="text-xs text-warn">No database sources: start Semaphore with its server and list your databases in sources.json.</p>}
                </div>
              )}

              <div className="space-y-1.5">
                <h3 className="text-sm font-semibold">Tables to bring across</h3>
                {importable.length === 0 && <p className="text-xs text-ink-3">No SQL tables in the script.</p>}
                {importable.map((t) => {
                  const src = sourceFor(t.connection);
                  const renamed = [...(labels.get(t.from!)?.entries() ?? [])].filter(([col, name]) => col !== name.toLowerCase()).length;
                  return (
                    <label key={t.label} className={`flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm ${src ? '' : 'opacity-60'}`}>
                      <input type="checkbox" checked={!!picked[t.label] && !!src} disabled={!src} onChange={(e) => setPicked((p) => ({ ...p, [t.label]: e.target.checked }))} />
                      <span className="min-w-0 flex-1">
                        <b>{t.label}</b> <span className="font-mono text-xs text-ink-3">{t.from}</span>
                        <span className="block text-[11px] text-ink-3">
                          {t.star ? 'all columns' : `${t.fields.length} fields`}
                          {renamed ? `, ${renamed} renamed for analysts` : ''}
                          {t.fields.some((f) => f.expression && !f.mapping) ? `, ${t.fields.filter((f) => f.expression && !f.mapping).length} calculated (not imported)` : ''}
                          {src ? '' : ' · map its connection first'}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {files.length > 0 && <p className="text-[11px] text-ink-3">{files.length} file or QVD load{files.length === 1 ? '' : 's'} ({files.map((f) => f.label).join(', ')}): QVDs are Qlik's own format; export them to CSV and add them under Data.</p>}
              </div>

              {associations.length > 0 && (
                <div className="space-y-1">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Link2 size={14} /> Links Qlik was making</h3>
                  <ul className="space-y-0.5 text-xs text-ink-2">
                    {associations.map((a) => (
                      <li key={a.field}>
                        <b>{a.field}</b> links {a.tables.map((t) => t.label).join(', ')}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-ink-3">Recorded as proposed joins; flags read one table until catalog relationships arrive.</p>
                </div>
              )}

              {mappings.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">Cleaning Qlik was doing</h3>
                  <ul className="space-y-0.5 text-xs text-ink-2">
                    {mappings.map((m) => (
                      <li key={m.name}>
                        <b>{m.name}</b>: {m.pairs.slice(0, 4).map(([a, b]) => `"${a}" → "${b}"`).join(', ')}
                        {m.pairs.length > 4 ? ` and ${m.pairs.length - 4} more` : ''}
                        {m.usedBy.length ? ` (used by ${m.usedBy.join(', ')})` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-ink-3">Kept as proposed cleaning steps; Semaphore applies them once cleaning steps ship.</p>
                </div>
              )}

              {read.warnings.length > 0 && (
                <ul className="space-y-0.5 text-[11px] text-ink-3">
                  {read.warnings.slice(0, 8).map((w) => (
                    <li key={w} className="flex gap-1"><CircleAlert size={12} className="mt-0.5 shrink-0" /> {w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {exprs.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold">Measures</h3>
              <ul className="space-y-1">
                {exprs.map((e) => (
                  <li key={e.line} className="flex items-center gap-2 text-xs">
                    <span className={`min-w-0 flex-1 truncate ${e.parsed.ok ? '' : 'text-ink-2'}`} title={e.line}>
                      <b>{e.label}</b> <span className="font-mono text-ink-3">{e.expression}</span>
                      {!e.parsed.ok && <span className="block text-[11px] text-warn">{e.parsed.reason}</span>}
                    </span>
                    {e.parsed.ok ? (
                      <span className="text-good">will be added</span>
                    ) : (
                      <button type="button" onClick={() => onDraftAsFlag(e.label, `${e.label}. In Qlik this was: ${e.expression}`)} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 hover:border-accent">
                        <Sparkles size={12} /> Draft as a flag
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(read || exprs.length > 0) && (
            <div className="flex items-center gap-2 border-t border-line pt-3">
              <button type="button" onClick={run} disabled={!!busy} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel disabled:opacity-40">
                {busy ?? 'Import into the catalog'}
              </button>
              <span className="text-xs text-ink-3">Tables are profiled for types first, so this asks each database once.</span>
            </div>
          )}

          {result && (
            <ul className="space-y-1 rounded-md bg-panel-2 p-3 text-xs">
              {result.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
