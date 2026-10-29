# Intelligence providers

Semaphore works with no model at all. **Local rules** is the default provider and the fallback for everything. An organisation with an approved AI platform can plug it in as a remote provider. This follows the same model as Shellback and Halyard.

| Provider | What it is | Leaves the workstation? |
| --- | --- | --- |
| Local rules (default) | Deterministic reading of the brief against catalog labels and synonyms | No |
| Fairlead (the UI's AI switch) | The Fleet model router on `127.0.0.1:8776`, reached through Semaphore's own server. Route `local` with `X-Fairlead-Privacy: local` by default. | No, by default (Fairlead's `local` route) |
| OpenAI-compatible gateway | Any `/v1/chat/completions` API: enterprise gateways, Azure OpenAI, Ollama, LM Studio. Semaphore writes the prompts. | Yes, to that gateway |
| Contract endpoint | A platform-side service implementing the contract below | Yes, to that endpoint |
| Databricks serving endpoint | Planned, reusing Halyard's client | Yes |

## What is sent, and what never is

| Sent | Never sent |
| --- | --- |
| The hoist brief and the flag brief | Any data row or cached result |
| The page's fixed filters (field keys and values the analyst typed) | Table or column names, source names, connection strings |
| Metric and field **keys, labels, types and synonyms** (`summarizeCatalog`), with a **set number** per source (1, 2, ...) so a model keeps a flag to one source | Credentials or vault item names |
| The flag's current kind | Anything about other people |

SQL is generated locally from the validated draft, never by the provider.

## Rules every provider's output goes through

1. Output is a **suggestion**. Applying it marks the flag `drafted`; the analyst accepts it.
2. Unknown metric or field keys are removed and listed in the flag's notes; confidence is capped at 0.4.
3. A flag reads from one source. A draft that mixes sources keeps the source most of its fields and filters come from; a metric or field from another source is swapped for the same-named one in the kept source (confidence capped at 0.7) or left out with a note (capped at 0.4).
4. A colour rule is kept only when the brief asks for one ("red", "amber", "highlight", ...). Rules the team style card adds afterwards are labelled "Team style".
5. A model's own confidence is capped at 0.8 (`MODEL_CONFIDENCE_CAP`): it has not seen the data.
6. A failure (HTTP error, timeout, non-JSON, wrong shape) falls back to local rules, and the reason is shown.
7. Requests send `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, time out after 30 s (15 s for `ping`), and never echo the token in errors.
8. Provider URLs must be HTTPS (plain HTTP only on 127.0.0.1/localhost) and may not embed credentials. Tokens come from the Lazarette vault.

## Fairlead

The browser UI drafts through [Fairlead](https://github.com/fleethacker-data-crucible/Fairlead), the Fleet's model router, whenever a Fairlead client key is stored. The page never holds the key:

```
page  --(session token)-->  Semaphore server /api/ai/v1  --(Fairlead key)-->  Fairlead 127.0.0.1:8776/v1  -->  local model
```

- **Key.** Create a client key in Fairlead > Clients and run `Set-SemaphoreAiKey.bat` (`-Check` tests it, `-Clear` removes it). New keys are stored in Windows Credential Manager under `Semaphore/FairleadClientKey`, scoped to the current Windows account. An existing DPAPI file is read only as a compatibility fallback; rerun the setup script to store the key in Credential Manager, then use `-Clear` when you intend to remove both stored copies. `SEMAPHORE_AI_KEY` (environment or `config\semaphore.env`) overrides it for CI and test machines. The key is never returned by `/api/ai`, logged, or put in an error message.
- **Route.** Requests ask for model `local` and send `X-Fairlead-Privacy: local`, so Fairlead keeps them on this computer. `SEMAPHORE_AI_MODEL` picks another Fairlead route (`auto`, `smart`, `fast`); `SEMAPHORE_AI_PRIVACY=off` drops the privacy header and lets Fairlead route by its own rules. The server refuses a request for any other model, so a page cannot choose its own route.
- **Address.** `SEMAPHORE_AI_URL` (default `http://127.0.0.1:8776/v1`) must be on this machine: Semaphore never calls a remote AI service itself; Fairlead decides.
- **Port authority.** Before the key is sent, the address must answer `GET /__fleethacker/id` as `fairlead` (edge-ops PORTS.md; the rule Lazarette uses). If another tool holds the port, for example while Fairlead is down, the key is not sent and the page says which program answered.
- **Timing.** A local model can take a while: the server waits up to 180 s and runs the call on its worker pool, so heartbeats and other requests carry on. The page shows "Drafting with Fairlead (local, on this computer)…" meanwhile.
- **Failures.** Fairlead not running, a refused key, a timeout or an answer that is not a valid draft all fall back to local rules, and the page says why. Each draft Fairlead made says so in the flag's notes.

| Route | What it does |
| --- | --- |
| `GET /api/ai` | `{ configured, url, model, privacyLocal, keySource, problem, setup }`, never the key |
| `POST /api/ai/check` | Asks Fairlead for its models with the key: `{ ok, detail, models }` |
| `POST /api/ai/v1/chat/completions` | The drafting request, forwarded to Fairlead; its JSON answer returned with `X-Fairlead-Target` |

## What local rules understand

| Phrase | Result |
| --- | --- |
| "labor cost by region and ship class", "spend across regions" | metrics and grouping fields, including synonyms and plurals |
| "monthly work orders", "orders per quarter", "trend" | the table's date field at that grain (trend → month) |
| "last 12 months", "past 2 quarters" | a relative date filter |
| "top 10 hulls by cost", "bottom 5" | limit and sort |
| "as a table", "pie", "line", "bar" | the flag kind |
| "clicking a bar filters the page", "drill into" | click behaviour |
| "ignore the region filter" | that field's selections are skipped |
| "turn red over $5M", "amber under 80%" | thresholds |
| "which ship class had the most work orders?" | a question: that field, ranked, top 5 |
| "vs last year", "compared with the previous quarter", "growth" | a comparison with an earlier window (`compare`) |
| "as a % of total", "share of" | values as a share of the total (`share`) |
| nothing about the chart | with "pick chart for me", the kind comes from the data's shape (`src/core/shape.ts`): one number is a KPI, time is a line, a few parts of a whole are a pie, more than 15 categories are cut to the top 15, two long lists are a table |

When two tables answer to the same word ("spend"), the one the rest of the brief points to wins. "Clicking a bar filters the page" sets behaviour; it does not ask for a bar chart.

## Helping the analyst while they type

`annotateBrief` (`src/core/intelligence/annotate.ts`) reads a brief back as highlighted spans: measures, fields, time, ranking, behaviour, colour rules, comparisons. A word after "by"/"per" that matches nothing is underlined, and any word within a small edit distance of a catalog name gets "did you mean". Picking a suggestion fixes the brief and calls `learnSynonym`, so the catalog answers to that word from then on (a word that already means something else is never taken over).

`describeFlag` (`src/core/describe.ts`) turns a flag back into plain English for the back of the card, and `findInsights` (`src/core/insights.ts`) finds what is worth a glance in a flag's own result: the latest move in a trend (skipping a period still running), a category that dominates, an outlier (median absolute deviation), the biggest move against the comparison window, and how many values break a red rule. None of these need a model or leave the page.

With an empty brief, or one that matches nothing, `draftHoist` returns a **starter page** read off the catalog: headline numbers, pickers for the short lists, a monthly trend on the main date, the main measure by its most useful field, and the top 10 of the longest list.

It also says what it could not match ("No field matches 'squadron'") and lowers its confidence.

## Next: learning from analysts (planned)

Local rules know the catalog; they do not yet know the team. The planned playbook ([PLAYBOOK.md](PLAYBOOK.md)) adds what analysts have reviewed:

- **Learning** comes only from accepted flags, corrected drafts, chosen synonyms and saved hoists. Unaccepted drafts and anything flagged "do not learn" are never used, and nothing about how people work is recorded.
- **Answering** matches a question's annotation signature against accepted flags. A match reruns the analyst's own binding and is labelled *reviewed*; anything else is a local-rules draft labelled *not reviewed*, or goes to the analyst's queue.
- **With a provider**, reviewed examples (briefs and catalog keys and labels only) are added to the request as worked examples. The "never sent" list above does not change, and output still passes the same validation.

## Contract (version 1)

One endpoint, `POST`, JSON in and out, `Authorization: Bearer <token>` when a token is configured.

```jsonc
// request
{ "contract": 1, "model": "optional-deployment-name", "payload": { "task": "...", ... } }
// response
{ "ok": true,  "result": { ... } }
{ "ok": false, "error": "human-readable reason (≤ 400 chars)" }
```

### `ping` → `{ "detail": "optional text" }`

### `list-models` → `{ "models": ["deployment-a", "deployment-b"] }`

### `draft-flag`

```jsonc
{
  "task": "draft-flag",
  "brief": { "hoist": "dashboard brief", "flag": "this flag's brief", "pageFilters": [ ... ], "kind": "bar" },
  "catalog": { "metrics": [{ "key", "label", "agg", "synonyms"? }], "fields": [{ "key", "label", "type", "synonyms"? }] }
}
→
{
  "kind": "bar",
  "title": "Labor cost by region",
  "binding": { "metrics": ["labor_cost"], "dimensions": [{ "field": "jobs.region" }], "filters": [], "sort": { "by": "labor_cost", "dir": "desc" } },
  "behavior": { "onClick": "filter-page", "ignore": [], "thresholds": [] },
  "confidence": 0.85,
  "notes": ["optional explanations"]
}
```

### `draft-hoist`

```jsonc
{ "task": "draft-hoist", "brief": "whole-dashboard brief", "catalog": { ... } }
→
{ "title": "...", "filters": [ ... ], "flags": [ { "kind", "title", "brief", "binding", "behavior", "confidence", "notes" } ], "notes": [] }
```

Semaphore places drafted flags on the grid itself. Formats for bindings, filters and behaviour are in [FLAG_SPEC.md](FLAG_SPEC.md).

## Smaller tasks

Besides drafting flags and pages, three smaller tasks use the same provider (`runTask` in `src/core/intelligence/contract.ts`). An OpenAI-compatible model gets Semaphore's own instructions with each; a contract endpoint receives `{ contract: 1, payload: { task, ... } }` and returns `{ ok, result }`. Every answer is validated in `src/core/intelligence/tasks.ts`, and the local rules take over when there is no model or the answer does not hold up.

| Task | What is sent | What comes back, and how it is checked |
| --- | --- | --- |
| `propose-cleaning` | One field's label and up to 300 of its distinct values with row counts, when the analyst presses the button that says so. Never rows or other fields. | `{ groups: [{ keep, merge[] }] }`. Only values from the list; each value in one group; the analyst accepts the result as a cleaning step. |
| `read-qlik-expression` | One Qlik chart expression, its name, and the catalog's field keys, labels and types. | `{ measures: [{ label, agg, field, filters[] }], explanation }`. Known aggregates and field keys only; sums and averages over numbers only; added on the analyst's say-so. |
| `write-briefing` | The page title and the facts Semaphore computed (flag ids, chart titles, sentences such as "Gulf stands out: $3.24M against a typical $1.9M."). Never rows. | `{ sentences: [{ text, flag }] }`. A sentence is kept only when it cites a real flag and every number in it appears in that flag's facts. |
