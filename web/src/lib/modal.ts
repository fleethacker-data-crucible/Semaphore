// One modal behaviour for every overlay (WAI-ARIA dialog pattern, modal): focus moves in when it opens,
// Tab and Shift+Tab stay inside, Escape closes the top-most one, the page behind is inert and hidden from
// assistive technology, and focus goes back to what opened it. The pieces that decide things are plain
// functions (tested in Node); `useModal` only wires them to the DOM.

import { type RefObject, useEffect, useRef } from 'react';

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What a key press means inside the top-most modal. `first` and `last` say which end Tab is on. */
export function modalKeyAction(key: string, shift: boolean, activeIndex: number, count: number): 'close' | 'to-first' | 'to-last' | 'to-dialog' | null {
  if (key === 'Escape') return 'close';
  if (key !== 'Tab') return null;
  if (count === 0) return 'to-dialog';
  if (activeIndex < 0) return shift ? 'to-last' : 'to-first';
  if (shift && activeIndex === 0) return 'to-last';
  if (!shift && activeIndex === count - 1) return 'to-first';
  return null;
}

// The modals that are open, oldest first. Only the last one answers Escape and Tab.
const stack: symbol[] = [];
export function pushModal(id: symbol): void {
  stack.push(id);
}
export function popModal(id: symbol): void {
  const i = stack.indexOf(id);
  if (i >= 0) stack.splice(i, 1);
}
export function isTopModal(id: symbol): boolean {
  return stack[stack.length - 1] === id;
}
export function openModalCount(): number {
  return stack.length;
}

/** The slice of an element that `isolate` needs, so it can be tested without a browser. */
export interface TreeNode {
  parentElement: TreeNode | null;
  children: ArrayLike<TreeNode>;
  tagName?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Makes everything outside `dialog` inert and aria-hidden: at each level from the dialog up to the
 * document body, every sibling of the branch that holds the dialog. Returns a function that puts the
 * attributes back exactly as they were. Scripts and styles are left alone.
 */
export function isolate(dialog: TreeNode): () => void {
  const changed: Array<{ el: TreeNode; inert: string | null; hidden: string | null }> = [];
  let node: TreeNode = dialog;
  while (node.parentElement && node.parentElement.tagName !== 'HTML') {
    const parent: TreeNode = node.parentElement;
    for (let i = 0; i < parent.children.length; i++) {
      const sib = parent.children[i]!;
      if (sib === node || sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE') continue;
      changed.push({ el: sib, inert: sib.getAttribute('inert'), hidden: sib.getAttribute('aria-hidden') });
      sib.setAttribute('inert', '');
      sib.setAttribute('aria-hidden', 'true');
    }
    node = parent;
  }
  return () => {
    for (let i = changed.length - 1; i >= 0; i--) {
      const c = changed[i]!;
      if (c.inert === null) c.el.removeAttribute('inert');
      else c.el.setAttribute('inert', c.inert);
      if (c.hidden === null) c.el.removeAttribute('aria-hidden');
      else c.el.setAttribute('aria-hidden', c.hidden);
    }
  };
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getClientRects().length > 0);
}

/**
 * Gives the dialog in `ref` the full modal behaviour while it is mounted. Put `aria-modal="true"`,
 * an accessible name and `tabIndex={-1}` on the dialog element, and `data-autofocus` on the control that
 * should take focus first (otherwise the first focusable one does).
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const id = Symbol('modal');
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pushModal(id);
    const restore = isolate(dialog as unknown as TreeNode);
    const start = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(dialog)[0] ?? dialog;
    start.focus();

    const onKey = (e: KeyboardEvent) => {
      if (!isTopModal(id) || e.defaultPrevented) return;
      const list = focusables(dialog);
      const active = document.activeElement instanceof HTMLElement ? list.indexOf(document.activeElement) : -1;
      const action = modalKeyAction(e.key, e.shiftKey, active, list.length);
      if (!action) return;
      if (action === 'close') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      e.preventDefault();
      (action === 'to-first' ? list[0] : action === 'to-last' ? list[list.length - 1] : dialog)?.focus();
    };
    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      restore();
      popModal(id);
      // Back to what opened the dialog, if it is still on the page.
      if (opener && opener.isConnected) opener.focus();
    };
    // The effect lives exactly as long as the dialog; the latest onClose is read through `close`.
  }, [ref]);
}
