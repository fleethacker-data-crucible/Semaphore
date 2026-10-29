// Briefings for leadership: "what changed" as a few plain sentences, each linked to the flag it
// comes from. The facts are Semaphore's own: headline totals and the insights it already finds
// (insights.ts), computed by its code from the data. The AI may only rephrase and order them;
// a sentence it writes is kept only when it names a real flag and every number in it is a
// number that flag's facts contain. Otherwise the plain local sentence is used.

import type { CatalogIndex } from './catalog.ts';
import { formatNumber } from './describe.ts';
import type { Flag } from './hoist.ts';

export interface BriefingFact {
  flagId: string;
  flagTitle: string;
  text: string;
  /** Higher comes first: warnings and changes before plain totals. */
  weight: number;
}

export interface BriefingSentence {
  text: string;
  flagId: string;
}

export interface Briefing {
  sentences: BriefingSentence[];
  by: 'rules' | 'ai';
  /** Sentences the AI wrote that did not hold up against the facts. */
  dropped: number;
}

export const BRIEFING_MAX = 5;

/** What a page says, as facts: each KPI's headline, and each flag's insights. */
export function briefingFacts(
  flags: ReadonlyArray<{ flag: Flag; totals?: Record<string, number | null>; insights: ReadonlyArray<{ tone: string; text: string }> }>,
  index: CatalogIndex,
): BriefingFact[] {
  const facts: BriefingFact[] = [];
  for (const { flag, totals, insights } of flags) {
    const title = flag.title || 'Untitled';
    if (flag.kind === 'kpi' && totals) {
      for (const key of flag.binding?.metrics ?? []) {
        const m = index.metric(key);
        const v = totals[key];
        if (m && typeof v === 'number') facts.push({ flagId: flag.id, flagTitle: title, text: `${m.label}: ${formatNumber(v, m.format)}.`, weight: 1 });
      }
    }
    // Caveats about the chart itself ("October is still running, so it is not compared") are not news.
    for (const i of insights.filter((x) => !/\bstill running\b|\bnot compared\b/.test(x.text))) facts.push({ flagId: flag.id, flagTitle: title, text: i.text, weight: i.tone === 'bad' ? 5 : i.tone === 'warn' ? 4 : i.tone === 'good' ? 3 : 2 });
  }
  return facts.sort((a, b) => b.weight - a.weight);
}

export function localBriefing(facts: readonly BriefingFact[]): Briefing {
  const seen = new Set<string>();
  const sentences: BriefingSentence[] = [];
  for (const f of facts) {
    if (seen.has(f.text)) continue;
    seen.add(f.text);
    sentences.push({ text: f.text, flagId: f.flagId });
    if (sentences.length >= BRIEFING_MAX) break;
  }
  return { sentences, by: 'rules', dropped: 0 };
}

/** Numbers as written ("$3.24M", "12%", "1,250", "2026"), normalised for comparison. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/[$£€]?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbB](?![a-z]))?/g)].map((m) => m[0].replace(/[\s,$£€]/g, '').toLowerCase());
}

/** The AI's sentences that hold up, or null when too few do (the caller uses the local briefing). */
export function validateBriefing(raw: unknown, facts: readonly BriefingFact[]): Briefing | null {
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { sentences?: unknown }).sentences) ? ((raw as { sentences: unknown[] }).sentences) : null;
  if (!list) return null;
  const byFlag = new Map<string, BriefingFact[]>();
  for (const f of facts) byFlag.set(f.flagId, [...(byFlag.get(f.flagId) ?? []), f]);
  const sentences: BriefingSentence[] = [];
  let dropped = 0;
  for (const s of list.slice(0, BRIEFING_MAX * 2)) {
    const o = s as { text?: unknown; flag?: unknown };
    if (typeof o?.text !== 'string' || typeof o.flag !== 'string' || !byFlag.has(o.flag)) {
      dropped++;
      continue;
    }
    const text = o.text.trim().slice(0, 300);
    const known = new Set(byFlag.get(o.flag)!.flatMap((f) => numbersIn(f.text)));
    if (!text || numbersIn(text).some((n) => !known.has(n))) {
      dropped++;
      continue;
    }
    sentences.push({ text, flagId: o.flag });
    if (sentences.length >= BRIEFING_MAX) break;
  }
  if (!sentences.length) return null;
  return { sentences, by: 'ai', dropped };
}

export const BRIEFING_PROMPT = `You write a short briefing for leadership from facts about a dashboard ("page") in Semaphore, a BI tool. Each fact belongs to one flag (chart) and was computed from the data. Write at most ${BRIEFING_MAX} plain sentences, most important first: problems and changes before steady totals. Use only the facts given: do not add numbers, causes or advice that are not in them, and copy every number exactly as written in its fact. Each sentence uses facts from one flag. Return {"sentences":[{"text","flag":"<the flag id>"}]}. Answer with JSON only.`;
