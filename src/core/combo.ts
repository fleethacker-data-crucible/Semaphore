// How a combo flag (bars and a line, src/core/kinds.ts) draws each of its measures. Its own file so
// only the chart extras and the Look panel carry it, never the page's start.

export interface ComboRole {
  as: 'bar' | 'line';
  axis: 'left' | 'right';
}

/**
 * The first measures as bars on the left scale, the last as a line on a scale of its own on the
 * right, unless the analyst picked otherwise in the Look panel (FlagStyle.combo).
 */
export function comboRoles(metrics: readonly string[], picked: Record<string, Partial<ComboRole>> | undefined): Array<ComboRole & { metric: string }> {
  return metrics.map((metric, i) => {
    const last = metrics.length > 1 && i === metrics.length - 1;
    const p = picked?.[metric];
    return { metric, as: p?.as ?? (last ? 'line' : 'bar'), axis: p?.axis ?? (last ? 'right' : 'left') };
  });
}
