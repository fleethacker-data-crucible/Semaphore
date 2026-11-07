// Motion rules (UNIFIED-UI 7): 200 ms or less, and none at all when the person prefers reduced motion.

/** Whether the person asked the system for less motion. False where it cannot be read. */
export function reducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The scroll behaviour to use: instant under reduced motion, smooth otherwise. */
export function scrollBehavior(): ScrollBehavior {
  return reducedMotion() ? 'auto' : 'smooth';
}

/**
 * Chart animation for a look: off under reduced motion or 'none'. 'calm' moves everything for 180 ms.
 * 'lively' lets marks arrive one after another, but no single mark moves for over 200 ms (UNIFIED-UI 7).
 */
export function chartMotion(level: 'none' | 'calm' | 'lively' = 'calm'): Record<string, unknown> {
  if (level === 'none' || reducedMotion()) return { animation: false };
  if (level === 'lively') return { animation: true, animationDuration: 200, animationEasing: 'cubicOut', animationDelay: (i: number) => Math.min(i * 40, 480), animationDurationUpdate: 180 };
  return { animation: true, animationDuration: 180, animationDurationUpdate: 180 };
}
