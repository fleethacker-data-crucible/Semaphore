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

/** Chart animation settings: off under reduced motion, otherwise at most 180 ms. */
export function chartMotion(): { animation: boolean; animationDuration?: number; animationDurationUpdate?: number } {
  return reducedMotion() ? { animation: false } : { animation: true, animationDuration: 180, animationDurationUpdate: 180 };
}
