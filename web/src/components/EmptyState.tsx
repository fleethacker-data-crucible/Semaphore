// The Fleet empty state (UNIFIED-UI 6, .fl-empty): line-art icon, a display-serif headline, a
// line of what to do next, and at most one primary action. An empty state is an onboarding
// moment, so it always says how to fill it; a zero-problem state ("nothing messy found") is good
// news and uses the success tone.

import type { ComponentType, ReactNode } from 'react';

export interface EmptyAction {
  label: string;
  onClick: () => void;
  icon?: ComponentType<{ size?: number; className?: string }>;
}

export interface EmptyStateProps {
  /** A Lucide icon (drawn as line art) or any node. */
  icon: ComponentType<{ size?: number; className?: string; strokeWidth?: number }> | ReactNode;
  headline: string;
  body?: ReactNode;
  /** The one primary action, or a node such as a file-picker label styled with emptyActionClass. */
  action?: EmptyAction | ReactNode;
  /** A quieter second way in (shown as a secondary button). */
  secondary?: EmptyAction | ReactNode;
  tone?: 'neutral' | 'success';
  /** Smaller padding for use inside a tab or a card. */
  compact?: boolean;
  className?: string;
}

export const emptyActionClass = 'inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-panel hover:opacity-90';
export const emptySecondaryClass = 'inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-3 py-1.5 text-sm text-ink hover:border-accent';

function isAction(a: unknown): a is EmptyAction {
  return !!a && typeof a === 'object' && 'label' in a && 'onClick' in a;
}

function Button({ a, primary }: { a: EmptyAction; primary: boolean }) {
  const Icon = a.icon;
  return (
    <button type="button" onClick={a.onClick} className={primary ? emptyActionClass : emptySecondaryClass}>
      {Icon && <Icon size={15} />}
      {a.label}
    </button>
  );
}

export function EmptyState({ icon, headline, body, action, secondary, tone = 'neutral', compact, className }: EmptyStateProps) {
  const Icon = typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon && !('props' in icon)) ? (icon as ComponentType<{ size?: number; strokeWidth?: number }>) : null;
  const tile = tone === 'success' ? 'border-good/30 bg-good-soft text-good' : 'border-line bg-panel-2 text-brass';
  return (
    <div role={tone === 'success' ? 'status' : undefined} className={`fl-empty mx-auto max-w-sm px-4 ${compact ? 'py-6' : 'py-10'} ${className ?? ''}`}>
      <div className={`grid size-14 place-items-center rounded-2xl border ${tile}`} aria-hidden="true">
        {Icon ? <Icon size={24} strokeWidth={1.75} /> : (icon as ReactNode)}
      </div>
      <h3 className={`font-display font-semibold leading-tight text-ink ${compact ? 'text-lg' : 'text-xl'}`}>{headline}</h3>
      {body && <p className="-mt-1 text-[13px] leading-5 text-ink-2">{body}</p>}
      {(action || secondary) && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {isAction(action) ? <Button a={action} primary /> : action}
          {isAction(secondary) ? <Button a={secondary} primary={false} /> : secondary}
        </div>
      )}
    </div>
  );
}
