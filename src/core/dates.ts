// One reading of a date cell for the whole core. A cell that reads as a calendar date or
// date-time ("2026-03-01", "2026-03-01T22:00:00", "2026-03-01 22:00:00+05:00") means the day it
// is written as: the calendar text wins, whatever zone the text carries or the browser runs in.
// Filters, period buckets, selection matching and comparison shifts all read a cell through
// calendarDay(), so a row a filter keeps lands in the bucket that filter named. This is also what
// a database's date_trunc does: it works in the column's own clock, never the client's.
//
// Anything else (a number, an unusual text) falls back to Date.parse and is read as UTC.

import type { Cell } from './crossfilter.ts';

const YMD = /^\d{4}-\d{2}-\d{2}(?:$|[T ])/;

/** The calendar day a cell names, as YYYY-MM-DD, or null when it is not a date. */
export function calendarDay(v: Cell | undefined): string | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const s = String(v);
  if (YMD.test(s)) {
    const day = s.slice(0, 10);
    return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? null : day;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Midnight UTC of the day a cell names, or null. Period arithmetic starts from here. */
export function dayStart(v: Cell | undefined): Date | null {
  const day = calendarDay(v);
  return day === null ? null : new Date(`${day}T00:00:00Z`);
}
