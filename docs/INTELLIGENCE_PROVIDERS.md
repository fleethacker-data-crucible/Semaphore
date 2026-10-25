# Intelligence providers

Semaphore works with no model at all. **Local rules** is the default provider and the fallback for everything. An organisation with an approved AI platform can plug it in as a remote provider. This follows the same model as Shellback and Halyard.

| Provider | What it is | Leaves the workstation? |
| --- | --- | --- |
| Local rules (default) | Deterministic reading of the brief against catalog labels and synonyms | No |
| OpenAI-compatible gateway | Any `/v1/chat/completions` API: enterprise gateways, Azure OpenAI, Ollama, LM Studio. Semaphore writes the prompts. | Yes, to that gateway |
| Contract endpoint | A platform-side service implementing the contract below | Yes, to that endpoint |
| Databricks serving endpoint | Planned, reusing Halyard's client | Yes |

## What is sent, and what never is

| Sent | Never sent |
| --- | --- |
| The hoist brief and the flag brief | Any data row or cached result |
| The page's fixed filters (field keys and values the analyst typed) | Table or column names, source names, connection strings |
| Metric and field **keys, labels, types and synonyms** (`summarizeCatalog`) | Credentials or vault item names |
| The flag's current kind | Anything about other people |

SQL is generated locally from the validated draft, never by the provider.

## Rules every provider's output goes through

1. Output is a **suggestion**. Applying it marks the flag `drafted`; the analyst accepts it.
2. Unknown metric or field keys are removed and listed in the flag's notes; confidence is capped at 0.4.
3. A failure (HTTP error, timeout, non-JSON, wrong shape) falls back to local rules, and the reason is shown.
4. Requests send `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, time out after 30 s (15 s for `ping`), and never echo the token in errors.
5. Provider URLs must be HTTPS (plain HTTP only on 127.0.0.1/localhost) and may not embed credentials. Tokens come from the Lazarette vault.

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

It also says what it could not match ("No field matches 'squadron'") and lowers its confidence.

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
