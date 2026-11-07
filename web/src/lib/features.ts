// Each person's own switches for the social and motivational features, in this browser only
// (semaphore.features). The deployment's switches (settings.json) come first: what a deployment
// turned off stays off. Each line below says exactly what its switch does. What was kept stays where
// it is, so turning a feature back on brings it back.

import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from './storage.ts';
import type { SocialSettings } from './playbook.ts';

export type FeatureKey = keyof SocialSettings;
export type PersonalFeatures = Partial<Record<FeatureKey, boolean>>;

export const FEATURE_LIST: Array<{ key: FeatureKey; label: string; detail: string }> = [
  { key: 'signalBook', label: 'Signal Book and watch log', detail: 'Your private record of what you have tried. Off also stops new entries.' },
  { key: 'impact', label: 'Impact counts', detail: 'How often your reviewed answers were shown this week. Off also stops counting the answers you view.' },
  { key: 'teamLog', label: 'This week', detail: 'The team’s weekly summary in the playbook. Off hides it for you.' },
  { key: 'showAskers', label: 'Askers’ names', detail: 'Names beside leadership questions. Off shows you only how many asked. Names stay on the questions.' },
  { key: 'bz', label: 'BZ: this helped', detail: 'Thanks on reviewed answers. Off hides the button, so you give none.' },
];

const KEY = 'semaphore.features';

/** What is on for this person: the deployment's switches, less anything they turned off. */
export function withPersonal(deployment: SocialSettings, personal: PersonalFeatures): SocialSettings {
  const out = { ...deployment };
  for (const k of Object.keys(out) as FeatureKey[]) if (personal[k] === false) out[k] = false;
  return out;
}

/** One switch as Settings shows it: locked when the deployment turned the feature off. */
export function featureState(deployment: SocialSettings, personal: PersonalFeatures, key: FeatureKey): { on: boolean; locked: boolean } {
  return { on: withPersonal(deployment, personal)[key], locked: !deployment[key] };
}

let current: PersonalFeatures = readLocal<PersonalFeatures>(KEY) ?? {};
const listeners = new Set<() => void>();

function publish(next: PersonalFeatures): void {
  current = next;
  for (const fn of listeners) fn();
}

export function setPersonalFeature(key: FeatureKey, on: boolean): void {
  const next = { ...current };
  if (on) delete next[key];
  else next[key] = false;
  writeLocal(KEY, next);
  publish(next);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== 'undefined') {
  // Another tab changed a switch.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) publish(readLocal<PersonalFeatures>(KEY) ?? {});
  });
}

export function usePersonalFeatures(): PersonalFeatures {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
