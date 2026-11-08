// Numbers in a model's sentences and stats, formatted the way the rest of Semaphore formats them
// (describe.ts formatNumber), copied here so the predict worker does not pull in the planner.

import type { ValueFormat } from './types.ts';

function round(n: number): string {
  const a = Math.abs(n);
  const s = a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : n.toFixed(2);
  return s.replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

/** As describe.formatNumber, plus integer, decimal and days. `metric` uses `metricFormat`. */
export function fmt(n: number | null | undefined, format: ValueFormat = 'number', metricFormat?: 'number' | 'currency' | 'percent'): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const f = format === 'metric' ? (metricFormat ?? 'number') : format;
  if (f === 'percent') return `${round(n * 100)}%`;
  if (f === 'integer') return Math.round(n).toLocaleString('en-US');
  if (f === 'decimal') return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : Number(n.toPrecision(3)).toString();
  if (f === 'days') return `${round(n)} day${Math.abs(n) === 1 ? '' : 's'}`;
  const abs = Math.abs(n);
  const unit: [string, number] = abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e4 ? ['K', 1e3] : ['', 1];
  const body = unit[0] ? `${round(n / unit[1])}${unit[0]}` : abs >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString('en-US') : round(n);
  return f === 'currency' ? (n < 0 ? `-$${body.replace('-', '')}` : `$${body}`) : body;
}

/** "62%" from 0.62. */
export const pct = (p: number) => fmt(p, 'percent');

/** "a" or "an" before a number as written: an 8%, an 11%, an 18%, an 80.9%, but a 12%. */
export function article(text: string): 'a' | 'an' {
  return /^(8|11(?![\d])|11\.|18(?![\d])|18\.)/.test(text) ? 'an' : 'a';
}
