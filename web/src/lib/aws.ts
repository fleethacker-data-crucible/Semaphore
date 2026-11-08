// Calls for the Data panel's Amazon S3 browser and RDS help card (server/S3.ps1, server/Aws.ps1). Loaded with
// those components only, not with the page. The server holds the AWS session and the bucket allowlist; the page
// never sees a key.

import { api } from './api.ts';

export interface S3Bucket {
  bucket: string;
  region: string;
  /** Only keys under this prefix may be read ('' for the whole bucket). */
  prefix: string;
  label: string;
}

export interface S3Buckets {
  buckets: S3Bucket[];
  maxObjectMb: number;
  maxPrefixObjects: number;
  /** Settings entries the server skipped, in a sentence each. */
  problems: string[];
}

export interface S3Folder {
  prefix: string;
  name: string;
}

export interface S3Object {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  etag: string;
}

export interface S3Listing {
  bucket: string;
  prefix: string;
  /** The allowlisted prefix: the browser does not go above it. */
  root: string;
  folders: S3Folder[];
  objects: S3Object[];
  nextToken: string | null;
}

export interface S3ImportRequest {
  bucket: string;
  key?: string;
  keys?: string[];
  prefix?: string;
  table?: string;
  sheet?: string;
  replace?: boolean;
}

export interface S3Job {
  job: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  phase: string;
  what: string;
  bytes: number;
  totalBytes: number;
  objects: number;
  objectCount: number;
  table: string | null;
  rows: number | null;
  columns: unknown;
  ms: number | null;
  error: string | null;
}

export interface RdsSuggestion {
  id: string;
  label: string;
  kind: 'aws-rds';
  provider: 'odbc';
  engine: string;
  host: string;
  port: number;
  database: string;
  region: string;
  auth: 'password' | 'iam';
  user?: string;
  vault: Record<string, string>;
}

export interface RdsDatabase {
  type: 'instance' | 'cluster';
  id: string;
  engine: string;
  engineRaw: string;
  version: string;
  host: string;
  readerHost: string;
  port: number;
  database: string;
  iam: boolean;
  status: string;
  suggested: RdsSuggestion;
}

export interface RdsDiscovery {
  region: string;
  databases: RdsDatabase[];
  note: string;
}

const qs = (o: Record<string, string>): string =>
  Object.entries(o)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

export const s3Buckets = () => api<S3Buckets>('/api/s3/buckets');
export const s3List = (bucket: string, prefix: string, token = '') => api<S3Listing>('/api/s3/list?' + qs({ bucket, prefix, token }));
export const s3Import = (body: S3ImportRequest) => api<S3Job>('/api/s3/import', { json: body });
export const s3ImportStatus = (job: string) => api<S3Job>('/api/s3/import-status/' + encodeURIComponent(job));
export const rdsDiscover = (region: string) => api<RdsDiscovery>('/api/rds/discover?' + qs({ region }));

/** 1536 -> "1.5 KB"; binary units, as Windows Explorer shows them. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} bytes` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** The folders from the allowlisted root down to prefix, for the breadcrumb: [{ name, prefix }]. */
export function crumbs(root: string, prefix: string): { name: string; prefix: string }[] {
  const out = [{ name: root ? root.replace(/\/$/, '') : '(bucket)', prefix: root }];
  if (!prefix.startsWith(root)) return out;
  let at = root;
  for (const part of prefix.slice(root.length).split('/').filter(Boolean)) {
    at += `${part}/`;
    out.push({ name: part, prefix: at });
  }
  return out;
}
