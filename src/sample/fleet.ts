// Sample rows for the fleet-maintenance example catalog, so Semaphore can be tried before any
// source is connected. Generated, not real: a seeded random walk with a few patterns worth
// finding (a region whose cost is climbing, a winter backlog, one expensive ship class).
// Dates are relative to `today`, so "last 12 months" always has data.

import type { Cell } from '../core/crossfilter.ts';
import type { TableRows } from '../core/engine.ts';

const REGIONS = ['Northeast', 'Southeast', 'Gulf', 'Pacific Northwest', 'Southwest', 'Great Lakes'];
const CLASSES = ['Cutter', 'Patrol boat', 'Buoy tender', 'Icebreaker', 'Tug', 'Landing craft', 'Frigate', 'Destroyer', 'Survey vessel', 'Supply ship', 'Ferry', 'Research vessel'];
const STATUSES = ['Open', 'In progress', 'Awaiting parts', 'Closed', 'Cancelled'];
const PARTS = ['Impeller', 'Gasket set', 'Fuel injector', 'Bilge pump', 'Radar module', 'Shaft seal', 'Anode', 'Filter cartridge', 'Hydraulic hose', 'Alternator', 'Propeller', 'Battery bank'];

/** Mulberry32: small, fast and the same everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fleetSampleRows(today: Date = new Date(), count = 6000): TableRows {
  const r = rng(20261026);
  const pick = <T,>(xs: readonly T[], weights?: readonly number[]): T => {
    if (!weights) return xs[Math.floor(r() * xs.length)]!;
    const total = weights.reduce((s, w) => s + w, 0);
    let x = r() * total;
    for (let i = 0; i < xs.length; i++) if ((x -= weights[i]!) < 0) return xs[i]!;
    return xs[xs.length - 1]!;
  };
  const hulls = Array.from({ length: 180 }, (_, i) => `H-${String(100 + i)}`);
  const hullClass = new Map(hulls.map((h, i) => [h, CLASSES[i % CLASSES.length]!]));
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const spanDays = 730;

  const orders: Array<Record<string, Cell>> = [];
  for (let i = 0; i < count; i++) {
    const back = Math.floor(Math.pow(r(), 1.15) * spanDays); // more work recently
    const opened = new Date(end - back * 86_400_000);
    const month = opened.getUTCMonth();
    const winter = month === 11 || month <= 1;
    const region = pick(REGIONS, [1.3, 1.1, 0.9, 1, 0.8, winter ? 1.4 : 0.9]);
    const hull = pick(hulls);
    const shipClass = hullClass.get(hull)!;
    // The Gulf gets steadily more expensive over the two years; icebreakers are always costly.
    const trend = region === 'Gulf' ? 1 + (spanDays - back) / spanDays : 1;
    const classCost = shipClass === 'Icebreaker' ? 2.6 : shipClass === 'Destroyer' ? 1.8 : shipClass === 'Ferry' ? 0.7 : 1;
    const cost = Math.round((800 + r() * 4200) * classCost * trend * (winter ? 1.15 : 1));
    const recent = back < 45;
    const status = recent ? pick(STATUSES, [3, 3, 2, 1, 0.2]) : pick(STATUSES, [0.3, 0.3, 0.4, 8, 0.6]);
    const daysOpen = status === 'Closed' || status === 'Cancelled' ? Math.round(2 + r() * 40 * (winter ? 1.5 : 1)) : back;
    orders.push({
      region,
      ship_class: shipClass,
      status,
      opened_on: opened.toISOString().slice(0, 10),
      hull_no: hull,
      labor_cost: cost,
      days_open: daysOpen,
    });
  }
  const parts: Array<Record<string, Cell>> = PARTS.map((p, i) => ({ 'Item Name': p, QtyOnHand: Math.round(5 + r() * 400 * (i % 3 === 0 ? 0.2 : 1)) }));
  return { 'ops.work_orders': orders, Parts: parts };
}
