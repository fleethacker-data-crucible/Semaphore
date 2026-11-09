// A question to ask in the Leadership view (an accepted "Ask this" card in the assistant): kept until the
// view takes it (components/AskView.tsx), so it works whether the view is open or opening. Imported only
// by lazy chunks (the assistant and the Leadership view), so it never adds to the start.

let pendingAsk: string | null = null;

export function requestAsk(question: string): void {
  pendingAsk = question;
  window.dispatchEvent(new CustomEvent('semaphore:ask'));
}

export function takePendingAsk(): string | null {
  const q = pendingAsk;
  pendingAsk = null;
  return q;
}
