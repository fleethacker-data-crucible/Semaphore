# The playbook: learning from analysts, answering for leadership

**Status: built in 0.3 (engineering preview)**, except the IT-approved refresher and the AI-gateway mode; see [Build order](#build-order). Code: `src/core/playbook.ts`, `src/core/snapshot.ts`, `web/src/components/AskView.tsx`, `web/src/components/PlaybookPanel.tsx`.

## The idea

Semaphore has two kinds of user:

- **Analysts** build hoists: they write briefs, check drafts, fix them and accept them.
- **Leadership** wants answers: they ask a question and expect a number or a chart they can trust.

Every flag an analyst accepts is a reviewed pair: a question in plain English, and the exact measures, fields, filters, time window and colour rules that answer it. Today that knowledge stays inside one hoist. The **playbook** collects it, so that:

1. leadership gets a simple screen where they ask and Semaphore answers with the analysts' own reviewed work, and
2. when an analyst is out sick or on leave, Semaphore can stand in for them: answer the familiar questions, brief leadership on what changed, and hold anything new until the analyst is back.

Semaphore does not become an analyst. It replays and recombines what analysts have reviewed, says plainly when it is guessing, and hands anything new back to a person.

## What it learns from, and what it never does

It learns only from finished, accepted work. It does not track keystrokes, clicks, time spent or anything else about how people work.

| Analyst action | What the playbook keeps |
| --- | --- |
| Accepts a flag | The brief, the binding (measures, fields, filters, window, sort, limit, comparison, share), thresholds, who accepted it, when, and which hoist it came from |
| Corrects a draft before accepting it | The correction, so the same wording drafts correctly next time |
| Picks a "did you mean" or edits synonyms | Team vocabulary ("backlog" means open work orders) |
| Saves a hoist | The team's standard windows (last 12 months) and what counts as red |
| Edits the catalog | Official names and formats |

- Drafts nobody accepted are never learned from.
- An analyst can mark any flag **do not learn**.
- Every entry records who added it and when, and can be retired. Retired entries stop being used but stay in the history.

## The leadership view

A separate, simplified page: one question box, answer cards, no grid, palette or SQL in sight (the SQL is still a click away for anyone who asks).

Every answer carries a trust label, so nobody mistakes a guess for reviewed work:

| Label | When | What Semaphore does |
| --- | --- | --- |
| **Reviewed: built by Dana, accepted 12 Oct** | The question matches a playbook entry | Reruns that exact binding on today's data |
| **Drafted by Semaphore, not reviewed** | The question uses known measures and fields in a new combination | Drafts it with local rules, clearly labelled |
| **Can't answer yet** | Nothing in the catalog fits | Explains what it did and did not understand, and puts the question in the analyst's queue |

Each answer offers follow-up chips ("by region", "vs last year", "top 10"), the plain-English readback that is already on the back of every flag, and its "worth a look" insights.

## Standing in for an absent analyst

- **Briefing.** Reruns every accepted flag and reports what changed: values breaking a red rule, the biggest moves against the previous period, new outliers. Built from the existing insights (`src/core/insights.ts`), so no new judgement is invented.
- **Question queue.** Questions Semaphore could not answer, or answered without review, wait for the analyst with what was understood. Accepting or correcting one adds it to the playbook.
- **Coverage.** Which measures and fields have reviewed answers, and where Semaphore would be guessing, so a team can see the gaps before someone goes on leave.

## How matching works

No model is needed (`answerQuestion` in `src/core/playbook.ts`). In order:

1. **Same words.** A question asked in the words of an accepted flag's brief, or of a question an analyst has since answered with it, is that entry: **reviewed**.
2. **Same meaning.** Otherwise local rules read the question into a binding (with the team's learnt synonyms). Same measures, fields, filters and comparison as an entry, and the same window or none named: **reviewed**, rerun with the entry's own window and colour rules.
3. **Re-addable.** The measures and fields asked for are among an entry's own, or among its snapshot's pre-split fields, under the same window: **worked out from a reviewed flag**. A value picked out of a field ("for icebreakers") becomes a selection. Distinct counts are never re-added.
4. **Drafted.** Anything else that fits the catalog is a local-rules draft, labelled **not reviewed**, using the team's usual window for that data, and queued for the analysts.
5. **None.** Nothing fits: **can't answer yet**, queued with what was and was not understood.

Questions with the same words are compared case- and punctuation-blind.

Because matching is deterministic, every answer can say which entry it used and why.

When an approved AI gateway is configured (see [INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md)), reviewed examples are sent with the question as worked examples, so odd phrasings land better. Only briefs and catalog keys and labels are sent, never data rows, tables, columns or credentials, and the provider's output goes through the same validation as every draft.

## Where it lives

The playbook is versioned JSON in the Semaphore folder, next to hoists and the catalog (`<home>\playbook\`). Semaphore's server listens on loopback only and never accepts connections from other machines, so sharing works through the folder, not the network: analysts and leadership point `SEMAPHORE_HOME` at the same network folder, and each person runs their own copy of Semaphore on their own machine.

## Leadership never touches a database: snapshots

Leaders should not need a DSN, a login or an IT ticket. They read **snapshots** instead of querying sources:

- When Semaphore reruns the playbook's accepted flags, it saves each result to `<home>\snapshots\`: the small, already-aggregated rows the planner asks for (typically a few hundred), each stamped with its source, binding and "data as of" time. Never raw rows.
- Each snapshot is pre-split by the fields leaders filter on, the same way flags are today (`planner.ts`). Because the partials re-add exactly (`crossfilter.ts`), one snapshot answers more than its own question: "labor cost by region and ship class" also answers "labor cost by region", "labor cost for icebreakers" and the headline total. That is how a leader's new question gets a real answer without a new query.
- Every answer shows its freshness ("data as of 06:00 today"). A question no snapshot can answer is labelled and goes to the analyst's queue.
- Distinct counts cannot be re-added; a question that needs one is answered only from a snapshot built for exactly that question.

**Keeping snapshots fresh.** Snapshots are refreshed by whoever has database access:

1. **Now (no IT work):** whenever any analyst runs Semaphore, it refreshes stale snapshots in the background. While every analyst is out, answers keep working and say how old they are.
2. **With IT's approval:** a refresher on an always-on machine keeps snapshots current while analysts are away. `Launch-Semaphore.bat --refresh` starts the server, opens the page in a headless Edge or Chrome with its own profile folder, refreshes every snapshot that computer can reach, writes a report, and stops (at most `refreshTimeoutMin` minutes, default 30). If someone is already using Semaphore on that computer it does nothing, because that copy refreshes stale snapshots itself. The suite conventions do not allow scheduled tasks, so running it each morning is IT's decision, recorded as an exception; see [Setting up the refresher](#setting-up-the-refresher-it). Until then, option 1 stands on its own.

The Ask view's data date shows when the oldest answer was read, and its tooltip names the last full refresh and how many snapshots failed. Failures are also in the refresher's log.

**Who can see snapshots.** Anyone who can read the snapshot folder can see the aggregated numbers in it. The folder's Windows permissions are therefore the access control: limit it to the people allowed to see those figures. Snapshots can additionally be encrypted with a key held in the Lazarette vault if the data calls for it.

## Looking after the playbook

The playbook is the list of answers leadership trusts, so someone has to notice when one goes wrong (an analyst accepted a mistake, "backlog" was redefined, a measure was renamed). No admin role is needed:

- **Adding is automatic:** accepting a flag adds it, with who and when.
- **Any analyst can retire an entry,** with a one-line reason; it stays in the history.
- **Semaphore flags problems itself:** an entry is marked **needs review** when it stops running, when a measure or field it uses changes in the catalog, or when nobody has used it for six months. Needs-review entries are still answered, labelled as such.
- **One named reviewer** (`playbookReviewer` in settings, by default the lead analyst) sees the needs-review list first, so it cannot fall between the cracks.

## Decisions (2026-10-26)

1. **Unreviewed answers for leadership: shown**, always labelled "Drafted by Semaphore, not reviewed", and also queued for the analyst to review.
2. **Data access for leadership: snapshots.** Leaders never connect to a database. Snapshots refresh whenever an analyst runs Semaphore; an IT-approved refresher on an always-on machine with a read-only service account is the next step for the vacation case.
3. **Looking after the playbook:** automatic adding, any analyst retires with a reason, automatic "needs review" flags, and one named reviewer (the lead analyst by default).

## Using it

- **Leadership:** double-click `Ask-Semaphore.bat` (or set `"view": "ask"` in `config\settings.local.json` on that computer). The page opens on the question box, the reviewed headline numbers, and what changed. Every answer shows its trust label, its data date and "Why this answer?".
- **Analysts:** nothing new to do. Accepting a flag adds it to the playbook (untick "Leadership can ask for this once accepted" to keep one out). The **Playbook** button shows leadership's questions ("Build the answer" turns one into a flag), the answers in use, those that need review and why, and coverage.
- **Sharing:** point `SEMAPHORE_HOME` (or `"home"` in settings) at the same network folder on every computer. Without a server, the playbook stays in that browser only.
- **Reviewer:** set `"playbookReviewer"` in settings; the Playbook panel names them.

## Build order

1. Done: playbook store, learn on accept, needs-review checks, question-to-entry matching (`src/core/playbook.ts`, tested).
2. Done: snapshots, refreshed in the background by whoever can reach the source; answers re-add their partials (`src/core/snapshot.ts`, tested).
3. Done: the leadership view with trust labels, data dates, follow-up chips, headline numbers and what changed.
4. Done: question queue with "Build the answer", answers in use, needs review with reasons, retire and restore, coverage.
5. Done: the `--refresh` mode. Scheduling it is IT's call (below).

## Setting up the refresher (IT)

Only with IT's approval, recorded as an exception to the suite's "no scheduled tasks" rule.

1. An always-on Windows machine with Windows PowerShell 5.1 and Edge or Chrome.
2. A dedicated, **read-only** service account with access to the sources, and the same `sources.json` (DSNs or Windows authentication) as the analysts use.
3. `SEMAPHORE_HOME` (or `"home"` in `config\settings.local.json`) pointing at the shared Semaphore folder.
4. A scheduled run each morning, as that account, of:
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <Semaphore>\server\Start-Semaphore.ps1 --refresh`
5. Check `logs\Semaphore_*.log` on that machine after the first run: one "Snapshots refreshed: n done" line per run, and a "Snapshot failed" line for each failure.

Anyone who can read the shared folder can read the snapshots, so its Windows permissions are the access control.
6. Optional AI-gateway mode, which needs the server-side relay (the page's content security policy only allows the loopback server).
