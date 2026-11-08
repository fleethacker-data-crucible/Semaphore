// Reading a dbt project: dbt_project.yml for its name, the models' YAML for tables and columns, the
// dbt Semantic Layer (MetricFlow) semantic_models and metrics, and the legacy metrics blocks of dbt
// before 1.6. Everything is read with yaml.ts (no package) into a ModelRead (model-import.ts):
//
//   semantic model        -> a table (its model's relation name), with its dimensions as columns
//   entity primary/unique -> the one side of a link; foreign -> the many side, matched by entity name
//   dimension             -> a column (expr or name), time dimensions keep their granularity
//   measure               -> sum, count, count_distinct, average, min, max; sum_boolean, median,
//                            percentile and SQL expressions are warnings
//   metric simple         -> its measure, named as the metric
//   metric ratio          -> numerator / denominator (a calculated measure)
//   metric derived        -> its expr over other metrics, when it is only + - * / and parentheses
//   metric cumulative, conversion, offsets and filters -> warnings with the definition
//   legacy metric         -> calculation_method + expression; derived ones through {{ metric('x') }}
//
// Jinja that cannot be resolved without dbt ({{ ... }} in an expression) is a warning; ref('x') is read.

import type { FieldType } from './catalog.ts';
import { emptyRead, humanize, MODEL_LIMITS, parseFormula, shown, type Formula, type ModelFile, type ModelMeasure, type ModelRead, type ModelTable } from './model-import.ts';
import { parseYaml, type YamlValue } from './yaml.ts';

type Obj = { [key: string]: YamlValue };

const isObj = (v: YamlValue | undefined): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : []);
const str = (v: YamlValue | undefined): string | undefined => (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined);

/** Folders dbt writes or installs into, and the connection profile, which is never read. */
const SKIP = /(^|\/)(target|dbt_packages|dbt_modules|logs|node_modules|\.git|\.venv|venv)\//i;
const PROFILE = /(^|\/)profiles\.ya?ml$/i;

/** Which picked files the dbt reader will look at. */
export function isDbtFile(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  return /\.ya?ml$/i.test(p) && !SKIP.test(p) && !PROFILE.test(p);
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const JINJA = /\{\{|\{%|\{#/;

/** ref('orders'), {{ ref("orders") }}, ref('package', 'orders') -> orders; source('raw', 'orders') -> raw.orders. */
export function refName(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const ref = /^ref\(\s*(?:['"][^'"]+['"]\s*,\s*)?['"]([^'"]+)['"]\s*(?:,\s*v(?:ersion)?\s*=\s*[^)]*)?\)$/.exec(s);
  if (ref) return ref[1];
  const src = /^source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)$/.exec(s);
  if (src) return `${src[1]}.${src[2]}`;
  return IDENT.test(s) ? s : undefined;
}

const TYPES: Array<[RegExp, FieldType]> = [
  [/^(int|integer|bigint|smallint|tinyint|number|numeric|decimal|float|double|real|money|int64|float64)/i, 'number'],
  [/^(date|datetime|timestamp|time)/i, 'date'],
  [/^(bool|boolean|bit)/i, 'boolean'],
  [/^(varchar|char|text|string|nvarchar|nchar|character)/i, 'string'],
];
function fieldType(t: string | undefined): FieldType | undefined {
  if (!t) return undefined;
  return TYPES.find(([re]) => re.test(t.trim()))?.[1];
}

const MEASURE_AGG: Record<string, 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct'> = { sum: 'sum', count: 'count', count_distinct: 'count_distinct', average: 'avg', avg: 'avg', min: 'min', max: 'max' };

interface DbtMeasure {
  name: string;
  semantic: string;
  label?: string;
  agg: string;
  expr: string;
  description?: string;
}

/** Reads the picked dbt files (any subset of a project) into a model for review. */
export function readDbt(files: readonly ModelFile[]): ModelRead {
  const read = emptyRead('dbt', 'dbt project');
  const warn = (w: string) => read.warnings.length < 500 && read.warnings.push(w);
  const models = new Map<string, { relation: string; description?: string; columns: Map<string, { type?: FieldType; description?: string }> }>();
  const semantic: Obj[] = [];
  const metrics: Array<{ m: Obj; file: string }> = [];
  for (const f of files) {
    if (!isDbtFile(f.path)) continue;
    read.files.push(f.path);
    const y = parseYaml(f.text);
    for (const w of y.warnings) warn(`${f.path}: ${w}`);
    for (const doc of y.documents) {
      if (!isObj(doc)) continue;
      if (/(^|\/)dbt_project\.ya?ml$/i.test(f.path.replace(/\\/g, '/'))) {
        const name = str(doc['name']);
        if (name) read.name = name;
        continue;
      }
      for (const m of list(doc['models'])) {
        if (!isObj(m) || !str(m['name'])) continue;
        const name = str(m['name'])!;
        const config = isObj(m['config']) ? m['config'] : {};
        const relation = str(config['alias']) ?? str(m['alias']) ?? name;
        const columns = new Map<string, { type?: FieldType; description?: string }>();
        for (const c of list(m['columns'])) {
          if (!isObj(c) || !str(c['name'])) continue;
          const type = fieldType(str(c['data_type']) ?? str(c['type']));
          const description = str(c['description']);
          columns.set(str(c['name'])!, { ...(type ? { type } : {}), ...(description ? { description } : {}) });
        }
        const description = str(m['description']);
        models.set(name, { relation, ...(description ? { description } : {}), columns });
      }
      for (const s of list(doc['semantic_models'])) if (isObj(s)) semantic.push(s);
      for (const m of list(doc['metrics'])) if (isObj(m)) metrics.push({ m, file: f.path });
      // Saved queries, exposures, sources and the like are not part of the model Semaphore needs.
    }
  }

  const tables = new Map<string, ModelTable>();
  const byModel = new Map<string, string>();
  const tableFor = (modelName: string, semanticName: string, description?: string): ModelTable => {
    const known = models.get(modelName);
    // One table per dbt model: a legacy metric on a model a semantic model covers shares its table.
    let t = tables.get(semanticName) ?? tables.get(byModel.get(modelName) ?? '');
    if (!t) {
      t = { name: semanticName, relation: known?.relation ?? modelName, columns: [], ...(description ?? known?.description ? { description: (description ?? known?.description)! } : {}) };
      tables.set(semanticName, t);
      byModel.set(modelName, semanticName);
    }
    return t;
  };
  const addColumn = (t: ModelTable, modelName: string, name: string, column: string, extra: { label?: string; grain?: string; description?: string } = {}) => {
    if (t.columns.some((c) => c.name === name || c.column === column)) return;
    const declared = models.get(modelName)?.columns.get(column);
    const type = extra.grain ? 'date' : declared?.type;
    const description = extra.description ?? declared?.description;
    t.columns.push({ name, column, ...(extra.label ? { label: extra.label } : {}), ...(type ? { type } : {}), ...(extra.grain ? { grain: extra.grain } : {}), ...(description ? { description } : {}) });
  };

  // Semantic models: tables, dimensions, entities and measures.
  const measures = new Map<string, DbtMeasure>();
  const entities: Array<{ entity: string; type: string; table: string; column: string }> = [];
  for (const s of semantic) {
    const name = str(s['name']);
    const model = refName(str(s['model']));
    if (!name || !model) {
      warn(`A semantic model ${name ? `"${name}" ` : ''}has no model: ref('...'); it was skipped.`);
      continue;
    }
    const t = tableFor(model, name, str(s['description']));
    for (const e of list(s['entities'])) {
      if (!isObj(e) || !str(e['name'])) continue;
      const ename = str(e['name'])!;
      const expr = str(e['expr']) ?? ename;
      if (!IDENT.test(expr)) {
        warn(`${name}: the entity ${ename} is an expression (${shown(expr)}); links on it were not read.`);
        continue;
      }
      const type = (str(e['type']) ?? '').toLowerCase();
      entities.push({ entity: ename, type, table: name, column: expr });
      addColumn(t, model, ename, expr, { label: str(e['label']) ?? humanize(ename) });
    }
    for (const d of list(s['dimensions'])) {
      if (!isObj(d) || !str(d['name'])) continue;
      const dname = str(d['name'])!;
      const expr = str(d['expr']) ?? dname;
      if (JINJA.test(expr) || !IDENT.test(expr)) {
        warn(`${name}: the dimension ${dname} is calculated (${shown(expr)}); add it as a field in the database or a cleaning step.`);
        continue;
      }
      const params = isObj(d['type_params']) ? d['type_params'] : {};
      const grain = (str(d['type']) ?? '').toLowerCase() === 'time' ? (str(params['time_granularity']) ?? 'day') : undefined;
      addColumn(t, model, dname, expr, { label: str(d['label']) ?? humanize(dname), ...(grain ? { grain } : {}), ...(str(d['description']) ? { description: str(d['description'])! } : {}) });
    }
    for (const m of list(s['measures'])) {
      if (!isObj(m) || !str(m['name'])) continue;
      const mname = str(m['name'])!;
      if (measures.has(mname)) warn(`The measure ${mname} is defined twice; the first is used.`);
      else measures.set(mname, { name: mname, semantic: name, agg: (str(m['agg']) ?? '').toLowerCase(), expr: str(m['expr']) ?? mname, ...(str(m['label']) ? { label: str(m['label'])! } : {}), ...(str(m['description']) ? { description: str(m['description'])! } : {}) });
      if (isObj(m['non_additive_dimension'])) warn(`${name}: the measure ${mname} is semi-additive (non_additive_dimension); Semaphore adds it like any other measure, so check its totals over time.`);
    }
  }

  // Links: a foreign entity points at the semantic model whose primary (or unique) entity has the same name.
  for (const fk of entities.filter((e) => e.type === 'foreign')) {
    const pk = entities.filter((e) => (e.type === 'primary' || e.type === 'unique' || e.type === 'natural') && e.entity === fk.entity && e.table !== fk.table);
    if (pk.length === 1) read.relationships.push({ from: { table: fk.table, column: fk.column }, to: { table: pk[0]!.table, column: pk[0]!.column } });
    else if (pk.length > 1) warn(`The entity ${fk.entity} is primary in more than one semantic model (${pk.map((p) => p.table).join(', ')}); the link from ${fk.table} was not guessed.`);
  }
  for (const e of entities.filter((x) => x.type === 'natural')) warn(`${e.table}: the entity ${e.entity} is natural (a slowly changing dimension); links to it ignore its validity window.`);

  // Measures into model measures. A measure's own name is its key; a simple metric over it renames it.
  const out = new Map<string, ModelMeasure>();
  const measureOut = (m: DbtMeasure, as?: { name: string; label?: string; description?: string }): ModelMeasure | null => {
    const label = as?.label ?? m.label ?? humanize(as?.name ?? m.name);
    const name = as?.name ?? m.name;
    const expression = `${m.agg}(${m.expr})`;
    const agg = MEASURE_AGG[m.agg];
    if (!agg) {
      const why: Record<string, string> = {
        sum_boolean: 'sum_boolean counts true values; Semaphore sums numbers, so add a 0/1 column in the model and sum that',
        median: 'Semaphore has no median measure yet',
        percentile: 'Semaphore has no percentile measure yet',
      };
      warn(`Not imported, ${label}: ${why[m.agg] ?? `the aggregation "${m.agg}" is not one Semaphore has`} (${m.semantic}: ${shown(expression)}).`);
      return null;
    }
    if (JINJA.test(m.expr)) {
      warn(`Not imported, ${label}: its expression uses Jinja, which needs dbt to resolve (${m.semantic}: ${shown(expression)}).`);
      return null;
    }
    const description = as?.description ?? m.description;
    // expr: 1 is a row count, whatever the aggregation says (count or sum of 1).
    if (m.expr === '1' && (agg === 'sum' || agg === 'count')) return { kind: 'agg', name, label, agg: 'count', table: m.semantic, expression, ...(description ? { description } : {}) };
    if (!IDENT.test(m.expr)) {
      warn(`Not imported, ${label}: it aggregates a SQL expression, not a column; add the column in the dbt model and point the measure at it (${m.semantic}: ${shown(expression)}).`);
      return null;
    }
    const t = tables.get(m.semantic);
    if (t && !t.columns.some((c) => c.column === m.expr)) {
      const modelName = semantic.find((s) => str(s['name']) === m.semantic);
      addColumn(t, refName(str(modelName?.['model'])) ?? m.semantic, m.expr, m.expr);
    }
    return { kind: 'agg', name, label, agg, table: m.semantic, column: m.expr, expression, ...(description ? { description } : {}) };
  };

  const metricNames = new Set(metrics.map(({ m }) => str(m['name'])).filter((n): n is string => !!n));
  const isLegacy = (m: Obj) => m['calculation_method'] !== undefined || m['sql'] !== undefined || m['expression'] !== undefined || (m['model'] !== undefined && m['type_params'] === undefined);
  /** Measure name -> the simple metric that exposes it. */
  const exposedAs = new Map<string, string>();
  const derived: Array<{ name: string; label: string; formula: Formula; expression: string; description?: string }> = [];

  // Which name a metric reference resolves to: a metric, or a measure dbt allows directly.
  const refTo = (word: string, aliases: Map<string, string> = new Map()) => aliases.get(word) ?? (metricNames.has(word) || measures.has(word) ? word : null);

  for (const { m, file } of metrics) {
    const name = str(m['name']);
    if (!name) continue;
    const label = str(m['label']) ?? humanize(name);
    const description = str(m['description']);
    const desc = description ? { description } : {};
    if (isLegacy(m)) {
      legacyMetric(m, name, label, file, desc);
      continue;
    }
    const type = (str(m['type']) ?? '').toLowerCase();
    const params = isObj(m['type_params']) ? m['type_params'] : {};
    const filter = m['filter'];
    if (filter !== undefined && filter !== null) {
      warn(`Not imported, ${label}: it has a filter (${shown(JSON.stringify(filter))}); Semaphore measures do not carry a fixed filter, so add the filter to the flags that use ${humanize(name)}.`);
      continue;
    }
    if (type === 'simple') {
      const ref = isObj(params['measure']) ? str(params['measure']['name']) : str(params['measure']);
      const mm = ref ? measures.get(ref) : undefined;
      if (isObj(params['measure']) && (params['measure']['filter'] || params['measure']['fill_nulls_with'] !== undefined || params['measure']['join_to_timespine'])) {
        warn(`Not imported, ${label}: its measure has a filter or fills nulls (${shown(JSON.stringify(params['measure']))}).`);
        continue;
      }
      if (!mm) {
        warn(`Not imported, ${label}: its measure ${ref ?? '(none)'} is not in the semantic models read.`);
        continue;
      }
      const made = measureOut(mm, { name, label, ...desc });
      if (made) {
        out.set(name, made);
        if (!exposedAs.has(mm.name)) exposedAs.set(mm.name, name);
      }
      continue;
    }
    if (type === 'ratio') {
      const part = (v: YamlValue | undefined): string | null => {
        if (isObj(v)) {
          if (v['filter'] || v['offset_window'] || v['offset_to_grain']) return null;
          return str(v['name']) ?? null;
        }
        return str(v) ?? null;
      };
      const num = part(params['numerator']);
      const den = part(params['denominator']);
      if (!num || !den) {
        warn(`Not imported, ${label}: its numerator or denominator has a filter or offset (${shown(JSON.stringify(params))}).`);
        continue;
      }
      derived.push({ name, label, formula: { op: '/', a: { ref: num }, b: { ref: den } }, expression: `${num} / ${den}`, ...desc });
      continue;
    }
    if (type === 'derived') {
      const expr = str(params['expr']) ?? '';
      const aliases = new Map<string, string>();
      let blocked: string | null = null;
      for (const r of list(params['metrics'])) {
        const rn = isObj(r) ? str(r['name']) : str(r);
        if (!rn) continue;
        if (isObj(r)) {
          if (r['offset_window'] || r['offset_to_grain']) blocked = `${rn} is offset in time (${shown(str(r['offset_window']) ?? str(r['offset_to_grain']) ?? '')}); Semaphore's comparisons (previous period, previous year) show that on a flag`;
          else if (r['filter']) blocked = `${rn} has a filter`;
          const alias = str(r['alias']);
          if (alias) aliases.set(alias, rn);
        }
        aliases.set(rn, rn);
      }
      if (blocked) {
        warn(`Not imported, ${label}: ${blocked} (${shown(expr)}).`);
        continue;
      }
      const f = parseFormula(expr, (w) => refTo(w, aliases));
      if (!f.ok) {
        warn(`Not imported, ${label}: ${f.reason} (${shown(expr)}).`);
        continue;
      }
      derived.push({ name, label, formula: f.formula, expression: expr, ...desc });
      continue;
    }
    if (type === 'cumulative') {
      warn(`Not imported, ${label}: cumulative metrics (running totals${params['window'] ? `, window ${str(params['window'])}` : ''}${params['grain_to_date'] ? `, ${str(params['grain_to_date'])} to date` : ''}) are not a Semaphore measure; use the measure itself and a running total on the flag.`);
      continue;
    }
    if (type === 'conversion') {
      warn(`Not imported, ${label}: conversion metrics (a funnel between two events) are not a Semaphore measure.`);
      continue;
    }
    warn(`Not imported, ${label}: the metric type "${type || '(none)'}" is not one Semaphore reads.`);
  }

  // Legacy metrics (dbt 1.0 to 1.5): calculation_method (or type) and expression (or sql) on a model.
  function legacyMetric(m: Obj, name: string, label: string, file: string, desc: { description?: string }) {
    const method = (str(m['calculation_method']) ?? str(m['type']) ?? '').toLowerCase();
    const expr = str(m['expression']) ?? str(m['sql']) ?? '';
    const filters = list(m['filters']);
    if (filters.length) {
      warn(`Not imported, ${label}: it has filters (${shown(filters.map((x) => (isObj(x) ? `${str(x['field'])} ${str(x['operator'])} ${str(x['value'])}` : String(x))).join(' and '))}); Semaphore measures do not carry a fixed filter, so add them to the flags that use it.`);
      return;
    }
    if (m['window']) {
      warn(`Not imported, ${label}: it is windowed (${shown(JSON.stringify(m['window']))}); use a running total on the flag.`);
      return;
    }
    if (method === 'derived' || method === 'expression') {
      // {{ metric('revenue') }} -> revenue; anything else in Jinja stops it.
      const text = expr.replace(/\{\{\s*metric\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)\s*\}\}/g, '$1');
      if (JINJA.test(text)) {
        warn(`Not imported, ${label}: its expression uses Jinja other than metric('...') (${shown(expr)}).`);
        return;
      }
      const f = parseFormula(text, (w) => refTo(w));
      if (!f.ok) {
        warn(`Not imported, ${label}: ${f.reason} (${shown(expr)}).`);
        return;
      }
      derived.push({ name, label, formula: f.formula, expression: expr, ...desc });
      return;
    }
    const model = refName(str(m['model']));
    if (!model) {
      warn(`Not imported, ${label}: it names no model (${file}).`);
      return;
    }
    const t = tableFor(model, model);
    const ts = str(m['timestamp']);
    const grains = list(m['time_grains']).map((g) => str(g)).filter(Boolean);
    if (ts && IDENT.test(ts)) addColumn(t, model, ts, ts, { label: humanize(ts), grain: grains[0] ?? 'day' });
    for (const d of list(m['dimensions'])) {
      const dn = str(d);
      if (dn && IDENT.test(dn)) addColumn(t, model, dn, dn, { label: humanize(dn) });
    }
    const agg = MEASURE_AGG[method];
    if (!agg) {
      warn(`Not imported, ${label}: the calculation method "${method || '(none)'}" is not one Semaphore has (${shown(`${method}(${expr})`)}).`);
      return;
    }
    if (JINJA.test(expr)) {
      warn(`Not imported, ${label}: its expression uses Jinja, which needs dbt to resolve (${shown(expr)}).`);
      return;
    }
    if ((expr === '*' || expr === '1') && agg === 'count') {
      out.set(name, { kind: 'agg', name, label, agg: 'count', table: t.name, expression: `${method}(${expr})`, ...desc });
      return;
    }
    if (!IDENT.test(expr)) {
      warn(`Not imported, ${label}: it aggregates a SQL expression, not a column (${shown(`${method}(${expr})`)}).`);
      return;
    }
    addColumn(t, model, expr, expr);
    out.set(name, { kind: 'agg', name, label, agg, table: t.name, column: expr, expression: `${method}(${expr})`, ...desc });
  }

  // Measures no simple metric exposes are still measures (and ratio or derived metrics may use them).
  for (const m of measures.values()) {
    if (exposedAs.has(m.name) || out.has(m.name)) continue;
    const made = measureOut(m);
    if (made) out.set(m.name, made);
  }
  // A formula may name a measure that a simple metric exposes under the metric's name.
  const rename = (f: Formula): Formula => ('ref' in f ? { ref: out.has(f.ref) ? f.ref : (exposedAs.get(f.ref) ?? f.ref) } : 'neg' in f ? { neg: rename(f.neg) } : 'op' in f ? { op: f.op, a: rename(f.a), b: rename(f.b) } : f);
  for (const d of derived) out.set(d.name, { kind: 'formula', name: d.name, label: d.label, formula: rename(d.formula), expression: d.expression, ...(d.description ? { description: d.description } : {}) });

  read.measures = [...out.values()].slice(0, MODEL_LIMITS.measures);
  read.tables = [...tables.values()];
  if (!semantic.length && !metrics.length) {
    // A project with only model YAML: its models are the tables, for their names and descriptions.
    for (const [name, m] of models) read.tables.push({ name, relation: m.relation, ...(m.description ? { description: m.description } : {}), columns: [...m.columns.entries()].map(([c, v]) => ({ name: c, column: c, ...(v.type ? { type: v.type } : {}), ...(v.description ? { description: v.description } : {}) })) });
    if (read.files.length) warn('No semantic models or metrics in these files: only the models and their columns were read.');
  }
  if (!read.files.length) warn('No dbt YAML files were picked (dbt_project.yml, models/**/*.yml).');
  return read;
}
