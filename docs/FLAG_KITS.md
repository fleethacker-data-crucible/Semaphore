# Flag kits: saved flag sets that remap to a new catalog

**Status: built (engineering preview).** Code: `src/core/kits.ts` (pure core), `web/src/lib/kits.ts` (storage), `web/src/components/KitsPanel.tsx` (UI). Tests: `tests/kits.test.ts`.

## The idea

A hoist is wired to one catalog by key: `labor_cost`, `jobs.region`. Move it to another catalog (another team's warehouse, a renamed CSV) and every flag breaks. A **kit** is a set of flags taken from a hoist and stored by what its references *mean*, so it can be flown on a different catalog: Semaphore wires each flag to the closest matching metric and field, tells you what it matched and how, tells you what it could not match, and never guesses.

## What a kit holds

For each flag you pick: kind, title, brief, optional size and position, binding (metrics, fields with grain, filters, sort, limit, comparison, share), behaviour (click action, ignored fields, colour rules), and whether it was accepted. For the page: optionally its fixed filters.

Every metric and field a flag uses is saved as a reference with its **key, label, type** (field type, or aggregate and format for a metric) and **synonyms** as they were in the source catalog. A kit never holds data rows, connection details, vault item names, flag ids or provider confidence. Fixed filter values (`region = East`) are saved as written; they are not checked against the new data.

A kit is plain JSON:

```json
{ "version": 1, "kind": "flag-kit", "id": "kit-maintenance-overview", "name": "Maintenance overview",
  "description": "", "created": "2026-10-30T12:00:00.000Z", "from": { "hoist": "fleet-maintenance", "title": "..." },
  "cols": 12, "filters": [], "flags": [ { "kind": "kpi", "title": "Labor cost", "binding": { "metrics": [
    { "key": "labor_cost", "label": "Labor cost", "agg": "sum", "format": "currency", "synonyms": ["cost", "spend"] } ],
    "dimensions": [], "filters": [] }, "...": "..." } ] }
```

## How a reference is matched

Each metric or field is looked up in the new catalog in this order. The first tier with a result decides.

| Tier | Rule | Flag arrives as |
| --- | --- | --- |
| exact | Same key, and the same kind of thing | as saved (ready if it was ready) |
| label | Same label, ignoring case, punctuation and plurals | draft, 90% |
| synonym | A synonym or the key's column name equals a label or synonym | draft, 80% |
| similar | The words overlap by at least half (Jaccard), and the best match is clear | draft, 50%; **off by default** |

**The same kind of thing** means: for a field, the same type (a date stays a date; "Opened" as text is refused, not forced); for a metric, the same aggregate (`avg` is not `max`) and, when both say, the same format (currency is not percent).

Rules that keep it honest:

- **No ambiguity is guessed.** A tier with two candidates is reported as unmatched, listing them (a candidate in the same table prefix as the original wins a tie).
- **Only real keys.** The target is always an existing metric or field of the new catalog; nothing is made up.
- **Close matches are suggestions.** A "similar" match is only used when you tick "Also use close matches". Otherwise it is listed as the closest candidate.
- **All or nothing for what a flag shows.** If any metric or field a flag displays has no match, the flag is not half-bound: it arrives with its title and brief and **no binding** (status empty), with a note saying why, so you can draft it again from the brief.
- **Extras follow when they can.** Filters, "ignore this filter" rules, colour rules, and sort order that cannot be remapped are left out and listed ("partly" outcome, draft). A year-on-year or previous-period comparison is dropped if there is no "last N" date window left to compare against, on the flag or the page.
- **Reviewed work is not faked.** Only flags whose references all matched by exact key keep "ready". Any other remap arrives as a draft, so the playbook (which learns only from accepted flags) never learns from an unchecked remap.

The result is run through `parseHoist` against the target catalog before it is returned; a warning from it is shown in the report. The tests assert there are none, and that every key in the output exists in the target catalog.

## Using it

The Kits button (box icon) in the header opens the panel. It is a dialog: Tab and Shift+Tab move through it, Enter and Space act, Escape closes and returns focus to the button, and every control shows the 2px brass focus ring.

- **Save a kit:** name it, tick the flags (all wired flags are ticked), choose whether to keep sizes and positions and the page's fixed filters, Save.
- **Fly a kit:** pick a kit. The panel shows exactly what will happen on this page: for each flag, "As saved", "Remapped: check it", "Partly: check it" or "Not wired", each remapped name as *old → new (how it matched)*, each failure with its reason and the closest candidates. Nothing changes until you press "Add N flags to this page". The flags are added below what is already there (keeping the kit's arrangement, or default sizes if it was saved without), with new ids; Undo removes them as one step. Applying twice adds two copies.
- **Export / import:** "Export a file" saves `<id>.kit.json`; "Import a kit file" reads one. Importing is strict (below) and gives the kit a fresh id if one with that name exists.

## Limits and import validation

`parseKitText` rejects, with a reason, and keeps nothing from, a kit file that:

- is longer than 1,000,000 characters or is not JSON;
- lacks `"kind": "flag-kit"` or `"version": 1` (a higher version is reported as made by a newer Semaphore);
- has no name, an unsafe id (anything outside `A-Za-z0-9_-`, 64 characters), a name over 80 characters, a description over 1,000, or a grid width outside 4 to 24;
- has no flags or more than 200, an unknown flag kind, a bad layout, a brief over 4,000 characters;
- has an unknown field type, aggregate, format, grain, operator or tone, wrong filter arity, a bad `last` filter, a sort that points outside the flag, a limit over 10,000, more than 20 synonyms on a reference, or more than the hoist limits for metrics, fields, filters, filter values, ignored fields or colour rules (`LIMITS` in `src/core/hoist.ts`).

Unknown properties are dropped (the kit is rebuilt field by field, so a hostile `__proto__` or extra property is never copied). The web app keeps at most 100 kits.

## Storage

No server change. A kit is a small document with `"version": 1` and an id of the form `kit-<name>`, so it is stored through the existing `team` document store (`/api/team/<id>`: atomic write, 2 MB cap, delete moves to `.trash`), next to away notices and report schedules, which ignore it. Everyone using the shared Semaphore folder sees the same kits. Without the server (page opened from disk) kits live in this browser's `localStorage` (`semaphore.team`, the same place the playbook keeps team notes), with the export file as the way to move them. Both paths re-validate every kit when it is read.

## Not covered yet

- Per-reference choice: the preview lets you turn close matches on or off for the whole kit; you cannot pick a suggested candidate for one reference. Re-draft an unwired flag from its brief instead.
- Matching never looks at data values or at relationships between tables, only at names, types and aggregates. Two catalogs that use the same word for different things will match; the draft status and the report are the check.
- Filter values and thresholds are copied as written. A colour rule on dollars is not rescaled for a catalog in thousands.
- A kit does not create catalog entries (metrics or fields); that is by design.
- Not run against the live PowerShell server in this change; the stored document shape follows the rules in `server/Routes.ps1` (`Test-SemDocId`, `Test-SemDocBody`).
