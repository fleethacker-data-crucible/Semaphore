// The Data panel's RDS help card: how to add an Amazon RDS or Aurora database to sources.json, and "Find RDS
// databases", which lists the instances and clusters of a region with an entry to copy. Semaphore never writes
// sources.json: the administrator pastes the entry into the file in the Semaphore folder.

import { useState } from 'react';
import { Copy, Database, Search } from 'lucide-react';
import { describeError } from '../lib/api.ts';
import { type RdsDatabase, rdsDiscover } from '../lib/aws.ts';

export function RdsHelp({ home }: { home: string }) {
  const [region, setRegion] = useState('us-gov-west-1');
  const [found, setFound] = useState<RdsDatabase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const find = async () => {
    setBusy(true);
    setError(null);
    try {
      setFound((await rdsDiscover(region.trim())).databases);
    } catch (e) {
      setError(describeError(e));
      setFound(null);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setCopied(null);
    }
  };

  return (
    <section className="space-y-2 rounded-lg border border-line px-3 py-2" aria-label="Amazon RDS and Aurora" data-testid="rds-help">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-3">
        <Database size={13} /> Amazon RDS and Aurora
      </h3>
      <p className="text-[11px] leading-5 text-ink-2">
        Add an RDS or Aurora database to sources.json in {home || 'the Semaphore folder'} with "kind": "aws-rds", "provider": "odbc", its "engine" (postgres, aurora-postgresql, mysql, mariadb, aurora-mysql, sqlserver or oracle), "host", "port", "database" and "region". Semaphore builds the connection with TLS on from the ODBC driver already on this computer and says which one is missing. Sign in with "auth": "password" (the password shared from Lazarette) or "auth": "iam" (a 15-minute token signed with the AWS session; PostgreSQL, MySQL and MariaDB). See docs/CONNECTORS.md.
      </p>
      <div className="flex gap-2">
        <input value={region} onChange={(e) => setRegion(e.target.value)} aria-label="AWS region" className="w-40 rounded-md border border-line bg-panel px-2 py-1 text-xs" />
        <button type="button" disabled={busy || !region.trim()} onClick={() => void find()} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:border-accent disabled:opacity-40">
          <Search size={13} /> {busy ? 'Looking…' : 'Find RDS databases'}
        </button>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {found && found.length === 0 && <p className="text-xs text-ink-3">No RDS databases Semaphore can read were found in {region}.</p>}
      {found && found.length > 0 && (
        <>
          <p className="text-[11px] text-ink-3">Copy an entry into sources.json (Semaphore does not write the file), then rename the vault share names to the ones you share in Lazarette.</p>
          <ul className="space-y-2" aria-label="RDS databases">
            {found.map((d) => {
              const text = JSON.stringify(d.suggested, null, 2);
              return (
                <li key={`${d.type}:${d.id}`} className="space-y-1 rounded-md border border-line p-2">
                  <p className="text-xs font-medium">
                    {d.id} <span className="font-normal text-ink-3">({d.type}, {d.engineRaw} {d.version}{d.iam ? ', IAM sign-in on' : ''})</span>
                  </p>
                  <p className="truncate font-mono text-[10px] text-ink-3">
                    {d.readerHost || d.host}:{d.port}
                  </p>
                  <textarea readOnly value={text} rows={Math.min(14, text.split('\n').length)} aria-label={`sources.json entry for ${d.id}`} className="w-full rounded border border-line bg-panel-2 p-1 font-mono text-[10px]" />
                  <button type="button" onClick={() => void copy(d.id, text)} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] hover:border-accent">
                    <Copy size={12} /> {copied === d.id ? 'Copied' : 'Copy entry'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
