// The Voice list in Settings > AI drafting > Spoken answers, as in Lazarette (PR 144): the voices
// installed in TalkForge (GET /api/voice/voices), TalkForge's default first, each marked by quality.
// Medium and low quality start speaking much sooner than high (measured about 8 times faster on a
// workstation CPU). Pure, so tests/talkforge-voices.test.ts can check the labels.

export interface TalkForgeVoice {
  id: string;
  quality: string;
  speakers: number;
  dataset: string;
  language: string;
  default: boolean;
}

export interface TalkForgeVoices {
  found: boolean;
  default: string;
  voices: TalkForgeVoice[];
  message: string;
}

export interface VoiceOption {
  value: string;
  label: string;
}

/** The options for the Voice select: '' (TalkForge's default) first, then each installed voice. */
export function voiceOptions(list: TalkForgeVoices | null, current: string): VoiceOption[] {
  const def = list?.default;
  const opts: VoiceOption[] = [{ value: '', label: def ? `TalkForge default (${def})` : 'TalkForge default' }];
  for (const v of list?.voices ?? []) {
    const fast = !!v.quality && v.quality !== 'high' && v.quality !== 'x_high';
    const bits = [v.quality ? `${v.quality} quality` : '', fast ? 'starts quickly' : v.quality ? 'slower to start' : '', v.speakers > 1 ? `${v.speakers} speakers` : ''].filter(Boolean);
    opts.push({ value: v.id, label: `${v.id}${bits.length ? ` (${bits.join(', ')})` : ''}` });
  }
  if (current && !opts.some((o) => o.value === current)) opts.push({ value: current, label: `${current} (not installed)` });
  return opts;
}
