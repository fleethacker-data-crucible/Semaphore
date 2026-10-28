// Lineage: what each flag reads, back to the database. Sources hold tables; tables hold fields;
// measures aggregate fields (or count a table's rows); flags use measures and fields; joins and
// cleaning steps sit on the way. Built from the catalog and the hoist alone, never from data, so
// it answers "what breaks if this column changes?" and "where does this number come from?".

import { type Catalog, indexCatalog, metricTable } from './catalog.ts';
import { joinPath } from './joins.ts';
import type { Hoist } from './hoist.ts';

export type LineageKind = 'source' | 'table' | 'field' | 'metric' | 'flag';

export interface LineageNode {
  id: string;
  kind: LineageKind;
  label: string;
  /** Extra words: a field's cleaning, a table's links, a flag's kind. */
  detail?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  /** A join between tables, rather than containment or use. */
  join?: boolean;
}

export interface Lineage {
  nodes: LineageNode[];
  edges: LineageEdge[];
}

const id = {
  source: (s: string) => `s:${s}`,
  table: (s: string, t: string) => `t:${s}|${t}`,
  field: (k: string) => `f:${k}`,
  metric: (k: string) => `m:${k}`,
  flag: (k: string) => `g:${k}`,
};

/**
 * The graph for one hoist. Only what the hoist's flags use is included (with their tables and
 * sources), unless `all` asks for the whole catalog.
 */
export function buildLineage(catalog: Catalog, hoist: Hoist, all = false): Lineage {
  const index = indexCatalog(catalog);
  const nodes = new Map<string, LineageNode>();
  const edges: LineageEdge[] = [];
  const edgeSet = new Set<string>();
  const edge = (from: string, to: string, join = false) => {
    const k = `${from}>${to}`;
    if (edgeSet.has(k)) return;
    edgeSet.add(k);
    edges.push(join ? { from, to, join } : { from, to });
  };
  const addField = (key: string) => {
    const f = index.field(key);
    if (!f) return;
    const steps = (catalog.cleaning ?? []).filter((c) => c.field === key);
    nodes.set(id.source(f.source), { id: id.source(f.source), kind: 'source', label: index.source(f.source)?.label ?? f.source });
    nodes.set(id.table(f.source, f.table), { id: id.table(f.source, f.table), kind: 'table', label: f.table });
    nodes.set(id.field(key), { id: id.field(key), kind: 'field', label: f.label, ...(steps.length ? { detail: `cleaned: ${steps.map((s) => s.kind).join(', ')}` } : {}) });
    edge(id.source(f.source), id.table(f.source, f.table));
    edge(id.table(f.source, f.table), id.field(key));
  };
  const addMetric = (key: string) => {
    const m = index.metric(key);
    if (!m) return;
    nodes.set(id.metric(key), { id: id.metric(key), kind: 'metric', label: m.label, detail: m.agg.replace('_', ' ') });
    if (m.field) {
      addField(m.field);
      edge(id.field(m.field), id.metric(key));
    } else {
      const t = metricTable(index, m);
      if (t) {
        nodes.set(id.source(m.source), { id: id.source(m.source), kind: 'source', label: index.source(m.source)?.label ?? m.source });
        nodes.set(id.table(m.source, t), { id: id.table(m.source, t), kind: 'table', label: t });
        edge(id.source(m.source), id.table(m.source, t));
        edge(id.table(m.source, t), id.metric(key));
      }
    }
  };

  if (all) {
    for (const f of catalog.fields) addField(f.key);
    for (const m of catalog.metrics) addMetric(m.key);
  }
  for (const flag of hoist.flags) {
    if (!flag.binding) continue;
    const g = id.flag(flag.id);
    nodes.set(g, { id: g, kind: 'flag', label: flag.title || 'Untitled flag', detail: flag.kind });
    for (const m of flag.binding.metrics) {
      addMetric(m);
      if (nodes.has(id.metric(m))) edge(id.metric(m), g);
    }
    const read = [...flag.binding.dimensions.map((d) => d.field), ...flag.binding.filters.map((f) => f.field)];
    for (const k of read) {
      addField(k);
      if (nodes.has(id.field(k))) edge(id.field(k), g);
    }
    // The joins this flag goes through, every hop drawn (jobs → ships → classes).
    const first = index.metric(flag.binding.metrics[0] ?? '');
    const base = first ? metricTable(index, first) : index.field(read[0] ?? '')?.table;
    const source = first?.source ?? index.field(read[0] ?? '')?.source;
    if (base && source) {
      for (const k of read) {
        const f = index.field(k);
        if (!f || f.source !== source || f.table === base) continue;
        for (const r of joinPath(index, source, base, f.table) ?? []) {
          nodes.set(id.table(source, r.to.table), { id: id.table(source, r.to.table), kind: 'table', label: r.to.table });
          edge(id.source(source), id.table(source, r.to.table));
          edge(id.table(source, r.from.table), id.table(source, r.to.table), true);
        }
      }
    }
  }
  for (const f of hoist.filters) {
    addField(f.field);
    for (const flag of hoist.flags) if (flag.binding && !flag.behavior.ignore.includes(f.field) && nodes.has(id.flag(flag.id))) edge(id.field(f.field), id.flag(flag.id));
  }
  // Joins between tables already in the picture.
  for (const r of catalog.relationships ?? []) {
    const a = id.table(r.source, r.from.table);
    const b = id.table(r.source, r.to.table);
    if (nodes.has(a) && nodes.has(b)) edge(a, b, true);
  }
  return { nodes: [...nodes.values()], edges };
}

/** Everything a node feeds and everything that feeds it, for highlighting a path. */
export function connected(l: Lineage, nodeId: string): Set<string> {
  const out = new Set([nodeId]);
  const walk = (dir: 'down' | 'up') => {
    const queue = [nodeId];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of l.edges) {
        if (e.join) continue;
        const next = dir === 'down' ? (e.from === at ? e.to : null) : e.to === at ? e.from : null;
        if (next && !out.has(next)) {
          out.add(next);
          queue.push(next);
        }
      }
    }
  };
  walk('down');
  walk('up');
  return out;
}

export const LINEAGE_COLUMNS: LineageKind[] = ['source', 'table', 'field', 'metric', 'flag'];
