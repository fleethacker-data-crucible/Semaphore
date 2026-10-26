# The playbook: learning from analysts, answering for leadership

**Status: design, not built yet.** Nothing in this document exists in 0.2. It is the plan for v0.3; see [ROADMAP.md](ROADMAP.md). Open decisions are listed at the end.

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

No model is needed. A question is read with the same annotation that highlights briefs today (`annotateBrief`): which measures, fields, time window, ranking, comparison and behaviour it names, plus the team's learnt synonyms. That signature is compared with every playbook entry's signature:

- same measures and fields, same window: a reviewed answer, rerun as is;
- same measures and fields, different window or ranking: the reviewed binding with the window or ranking changed, labelled as adjusted;
- anything else: a local-rules draft, labelled not reviewed.

Because matching is deterministic, every answer can say which entry it used and why.

When an approved AI gateway is configured (see [INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md)), reviewed examples are sent with the question as worked examples, so odd phrasings land better. Only briefs and catalog keys and labels are sent, never data rows, tables, columns or credentials, and the provider's output goes through the same validation as every draft.

## Where it lives

The playbook is versioned JSON in the Semaphore folder, next to hoists and the catalog (`<home>\playbook\`). Semaphore's server listens on loopback only and never accepts connections from other machines, so sharing works through the folder, not the network:

- analysts and leadership point `SEMAPHORE_HOME` at the same network folder;
- each person runs their own copy of Semaphore on their own machine;
- queries run with **that person's own** database access (their DSN or Windows login), so database permissions apply exactly as they do today. The playbook stores questions and bindings, never data.

## Open decisions

1. **Unreviewed answers for leadership. Decided (2026-10-26): shown**, always labelled "Drafted by Semaphore, not reviewed", and also queued for the analyst to review.
2. **Data access for leadership.** Confirm leadership has read access to the sources, or name an approved read-only account.
3. **Who curates.** Proposed: analysts add entries; a named owner can retire them; every entry records who and when.

## Build order

1. Playbook store, the "learn on accept" rules, and question-to-entry matching, all in `src/core` with tests.
2. The leadership view with trust labels and follow-up chips.
3. Briefing, question queue and coverage.
4. Optional AI-gateway mode, which needs the server-side relay (the page's content security policy only allows the loopback server).
