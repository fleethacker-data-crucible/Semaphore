// Stub of the shared skills module (cross-agent contract 7). The real one records, privately and
// only when enabled in settings, which parts of Semaphore an analyst has used. Until it is merged
// these are safe no-ops with the same exports, so the accept and draft paths can call them.

export type SkillKind = 'draft' | 'accept' | 'flip' | 'teach' | 'brief-hint';

export function recordSkill(_kind: SkillKind, _ref?: { hoistId?: string; flagId?: string }): void {
  /* no-op until the skills module is merged */
}

export function recordWatch(_kind: 'accept' | 'refresh' | 'answer' | 'review'): void {
  /* no-op until the skills module is merged */
}
