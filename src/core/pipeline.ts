// Data-prep pipelines: an ordered list of steps that rebuilds tidy tables in the local database
// (server/Pipeline.ps1 runs them; docs/PIPELINES.md). This module holds the shape, the same validation
// rules as the server (Test-SemPipeline), the schedule arithmetic for "next run" and the tables a
// pipeline builds. The server checks every pipeline again when it is saved and when it runs.

export type StepKind = 'import' | 'script' | 'pull' | 'publish';

export interface ImportStep {
  id: string;
  kind: 'import';
  name?: string;
  table: string;
  /** A file path on this computer or an allowed share; or an upload kept in <home>\local\sources; or an S3 object or prefix. */
  path?: string;
  upload?: string;
  s3?: { bucket: string; key?: string; prefix?: string };
  sheet?: string;
  /** Import even when the source has not changed. */
  force?: boolean;
}
export interface ScriptStep {
  id: string;
  kind: 'script';
  name?: string;
  /** A saved script's id. */
  script: string;
}
export interface PullStep {
  id: string;
  kind: 'pull';
  name?: string;
  source: string;
  sql: string;
  table: string;
  mode?: 'replace' | 'append';
}
export interface PublishStep {
  id: string;
  kind: 'publish';
  name?: string;
  /** Default: every table the pipeline builds. */
  tables?: string[];
}
export type PipelineStep = ImportStep | ScriptStep | PullStep | PublishStep;

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface Schedule {
  every: 'off' | 'hourly' | 'daily' | 'weekly';
  /** Hourly: the minute past the hour. */
  minute?: number;
  /** Daily and weekly: HH:mm, local time. */
  time?: string;
  days?: Weekday[];
  /** Run once at start-up for a time missed while Semaphore was not running. */
  catchUp?: boolean;
}

export interface Pipeline {
  version: 1;
  name: string;
  steps: PipelineStep[];
  schedule?: Schedule;
}

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'not run' | 'kept';

export interface StepLog {
  id: string;
  kind: StepKind;
  name: string;
  state: StepState;
  rows: number | null;
  ms: number | null;
  warnings: string[];
  error: string | null;
  tables: string[];
}

export interface PipelineRun {
  version: 1;
  run: string;
  pipeline: string;
  name: string;
  trigger: string;
  from: string;
  force: boolean;
  started: string;
  finished: string | null;
  state: 'running' | 'done' | 'failed';
  error: string | null;
  ms: number;
  outputs: string[];
  steps: StepLog[];
}

export const PIPELINE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED = /^(sqlite_|_semaphore)/i;
export const PIPELINE_MAX_STEPS = 50;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** null when the pipeline is valid, else the first problem in words (the server's wording). */
export function validatePipeline(doc: unknown): string | null {
  if (!isObj(doc)) return 'A pipeline is a JSON object.';
  if (doc.version !== 1) return 'A pipeline has "version": 1.';
  const name = doc.name;
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\x00-\x1f]/.test(name)) return 'A pipeline has a name of 1 to 100 characters.';
  const steps = doc.steps;
  if (!Array.isArray(steps) || steps.length === 0) return 'A pipeline has at least one step.';
  if (steps.length > PIPELINE_MAX_STEPS) return `A pipeline has at most ${PIPELINE_MAX_STEPS} steps.`;
  const ids = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as unknown;
    const where = `Step ${i + 1}`;
    if (!isObj(s)) return `${where} is not an object.`;
    if (typeof s.id !== 'string' || !PIPELINE_ID.test(s.id)) return `${where}: an id has lower-case letters, digits, _ and - (1 to 64).`;
    if (ids.has(s.id)) return `${where}: the id "${s.id}" is used twice.`;
    ids.add(s.id);
    if (!['import', 'script', 'pull', 'publish'].includes(String(s.kind))) return `${where}: kind is import, script, pull or publish.`;
    if (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 100)) return `${where}: name is text of at most 100 characters.`;
    if ((s.kind === 'import' || s.kind === 'pull') && (typeof s.table !== 'string' || !TABLE.test(s.table) || RESERVED.test(s.table))) return `${where}: table has letters, digits and _ (not starting with sqlite_ or _semaphore).`;
    if (s.kind === 'import') {
      const given = [s.path, s.upload, s.s3].filter((x) => x !== undefined && x !== null && x !== '').length;
      if (given !== 1) return `${where}: an import reads one of path, upload or s3.`;
      if (s.path !== undefined && s.path !== '' && (typeof s.path !== 'string' || s.path.length > 1024 || /[\x00-\x1f]/.test(s.path))) return `${where}: path is the file path as text.`;
      if (s.upload !== undefined && s.upload !== '' && (typeof s.upload !== 'string' || /[\\/:\x00-\x1f]/.test(s.upload) || s.upload.length > 200)) return `${where}: upload is the name of a file in the local sources folder.`;
      if (s.s3 !== undefined) {
        if (!isObj(s.s3)) return `${where}: s3 is { bucket, key } or { bucket, prefix }.`;
        if (typeof s.s3.bucket !== 'string' || !s.s3.bucket) return `${where}: s3 names the bucket.`;
        if ([s.s3.key, s.s3.prefix].filter((x) => x !== undefined && x !== null).length !== 1) return `${where}: s3 has a key or a prefix, not both.`;
      }
      if (s.force !== undefined && typeof s.force !== 'boolean') return `${where}: force is true or false.`;
    }
    if (s.kind === 'script' && (typeof s.script !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s.script))) return `${where}: script is the id of a saved script.`;
    if (s.kind === 'pull') {
      if (typeof s.source !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.source) || s.source === 'local') return `${where}: source is the id of a live source.`;
      if (typeof s.sql !== 'string' || !s.sql.trim()) return `${where}: sql is the SELECT to run on the source.`;
      if (!/^\s*select\b/i.test(s.sql) || s.sql.includes(';')) return `${where}: Only a single SELECT statement is allowed.`;
      if (s.mode !== undefined && s.mode !== 'replace' && s.mode !== 'append') return `${where}: mode is replace or append.`;
    }
    if (s.kind === 'publish' && s.tables !== undefined && (!Array.isArray(s.tables) || s.tables.some((t) => typeof t !== 'string' || !TABLE.test(t)))) return `${where}: tables lists table names.`;
  }
  if (doc.schedule !== undefined) {
    const sch = doc.schedule;
    if (!isObj(sch)) return 'schedule is an object.';
    if (!['off', 'hourly', 'daily', 'weekly'].includes(String(sch.every))) return 'schedule.every is off, hourly, daily or weekly.';
    if (sch.every === 'hourly' && sch.minute !== undefined && (!Number.isInteger(sch.minute) || (sch.minute as number) < 0 || (sch.minute as number) > 59)) return 'schedule.minute is 0 to 59.';
    if ((sch.every === 'daily' || sch.every === 'weekly') && (typeof sch.time !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(sch.time))) return 'schedule.time is HH:mm (24 hours).';
    if (sch.every === 'weekly') {
      if (!Array.isArray(sch.days) || sch.days.length === 0) return 'A weekly schedule names its days.';
      if (sch.days.some((d) => !WEEKDAYS.includes(d as Weekday))) return 'schedule.days are mon, tue, wed, thu, fri, sat, sun.';
    }
    if (sch.catchUp !== undefined && typeof sch.catchUp !== 'boolean') return 'schedule.catchUp is true or false.';
  }
  return null;
}

/** The next scheduled time after `now` (local time), or null when there is no schedule. */
export function nextRun(schedule: Schedule | undefined, now: Date = new Date()): Date | null {
  if (!schedule || schedule.every === 'off') return null;
  if (schedule.every === 'hourly') {
    const t = new Date(now);
    t.setMinutes(schedule.minute ?? 0, 0, 0);
    if (t <= now) t.setHours(t.getHours() + 1);
    return t;
  }
  const [h, m] = (schedule.time ?? '').split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null;
  for (let d = 0; d <= 7; d++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m, 0, 0);
    if (t <= now) continue;
    if (schedule.every === 'weekly' && !(schedule.days ?? []).includes(WEEKDAYS[t.getDay()]!)) continue;
    return t;
  }
  return null;
}

/** "Every day at 06:00", for the page. */
export function describeSchedule(s: Schedule | undefined): string {
  if (!s || s.every === 'off') return 'Not scheduled';
  if (s.every === 'hourly') return `Every hour at :${String(s.minute ?? 0).padStart(2, '0')}`;
  if (s.every === 'daily') return `Every day at ${s.time}`;
  const names: Record<Weekday, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
  return `${(s.days ?? []).map((d) => names[d]).join(', ')} at ${s.time}`;
}

/** The tables a pipeline's import and pull steps build (scripts add theirs when they run). */
export function pipelineOutputs(p: Pipeline): string[] {
  const out: string[] = [];
  for (const s of p.steps) if ((s.kind === 'import' || s.kind === 'pull') && !out.includes(s.table)) out.push(s.table);
  return out;
}

/** A free step id like import-2. */
export function newStepId(p: Pipeline, kind: StepKind): string {
  for (let i = 1; ; i++) {
    const id = `${kind}-${i}`;
    if (!p.steps.some((s) => s.id === id)) return id;
  }
}

/** A pipeline id from its name. */
export function pipelineId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64) || 'pipeline';
}
