// The Phrasebook tab of the Help dialog: the words Semaphore understands in a brief. The flags agent
// fills this in; until then it points at the brief legend.

export function Phrasebook() {
  return (
    <div className="space-y-2 text-sm text-ink-2">
      <p>Write a brief the way you would ask a colleague: a measure, how to split it, and a time window.</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <span className="font-medium text-ink">Labor cost by region for the last 12 months</span>
        </li>
        <li>
          <span className="font-medium text-ink">Monthly work orders vs last year</span>
        </li>
        <li>
          <span className="font-medium text-ink">Which site has the highest backlog? Turn red over 40</span>
        </li>
      </ul>
      <p className="text-xs text-ink-3">The colours under the brief show what Semaphore understood. A wavy underline is a word it does not know yet; select it to teach it.</p>
    </div>
  );
}
