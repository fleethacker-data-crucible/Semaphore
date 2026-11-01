// Reading a briefing aloud. The page speaks with a voice installed on this PC and never a cloud
// voice: browsers expose online voices (some marked localService = false) that send the text to
// a vendor, so only voices that say they run locally are ever chosen. If there is none, the button
// says so and stays silent. Nothing is spoken until the analyst asks.

import type { Briefing } from './briefing.ts';

export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
  default?: boolean;
}

/** At most this many characters are spoken in one go. */
export const SPEECH_MAX_CHARS = 1200;

/** The sentences of a briefing as one spoken text: each ends in a full stop, capped at SPEECH_MAX_CHARS. */
export function speechText(briefing: Briefing): string {
  const parts: string[] = [];
  let total = 0;
  for (const s of briefing.sentences) {
    const t = s.text.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const spoken = /[.!?]$/.test(t) ? t : `${t}.`;
    if (total + spoken.length + 1 > SPEECH_MAX_CHARS) break;
    parts.push(spoken);
    total += spoken.length + 1;
  }
  return parts.join(' ');
}

/** A local voice for the page language, else any local voice, else null. Never a voice that is not local. */
export function pickLocalVoice(voices: readonly VoiceLike[], lang: string): VoiceLike | null {
  const local = voices.filter((v) => v.localService === true);
  if (local.length === 0) return null;
  const base = lang.toLowerCase().split('-')[0] ?? '';
  const exact = local.find((v) => v.lang.toLowerCase() === lang.toLowerCase());
  const same = local.find((v) => (v.lang.toLowerCase().split('-')[0] ?? '') === base);
  const dflt = local.find((v) => v.default && (v.lang.toLowerCase().split('-')[0] ?? '') === base);
  return exact ?? dflt ?? same ?? local[0] ?? null;
}
