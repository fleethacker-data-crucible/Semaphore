# GHAS alert triage (sprint 2026-11)

Open alerts from the sprint export. Nothing here was dismissed on GitHub.

| Alert | Rule / package | Path | Disposition | Reason |
| --- | --- | --- | --- | --- |
| secret-scanning 1 | Databricks API Token | tests/databricks.test.ts:16 | fixed | Synthetic fixture in the simulated-endpoint tests (a non-random placeholder, not an issued credential); the bearer is now built at runtime from a non-matching stand-in, and history was not rewritten. GitHub still reports it publicly leaked with unknown validity, so rotation at Databricks is Jeremy's decision. If he does not rotate, recommended dismissal: used in tests. |

Alert: [secret-scanning/1](https://github.com/fleethacker-data-crucible/Semaphore/security/secret-scanning/1).

## secret-scanning 1

**Assessment: synthetic test fixture.** The export locates the match at `tests/databricks.test.ts:16`. In that revision the bearer constant is the next line (the example workspace URL is line 16). It was added in `382b8bed` ("Add a Databricks serving-endpoint provider (tested against a simulated endpoint)") and unchanged since. That test drives `DatabricksProvider` with a fake `fetch`: it checks the request path, the `Authorization` header, and that error text scrubs the same string. The file header says there is no real workspace, and [DATABRICKS.md](../DATABRICKS.md) says no real workspace, token, or endpoint was used. The workspace host is the documented example host. The matched string is a hand-written placeholder (a fixed prefix plus a repeated short hexadecimal run), not a random issued token. It appears only in that test, in every commit from `382b8bed` through the parent of this change.

The constant was replaced with a stand-in assembled at runtime (`fixture-bearer-not-a-credential`). The tests still send that string as the bearer and still assert it is scrubbed from errors. Git history was not rewritten, so the old string remains in commits from `382b8bed` on.

**Rotation at Databricks is Jeremy's decision.** GitHub marks the alert publicly leaked with validity unknown. This pass does not call Databricks and does not confirm whether that placeholder was ever issued. Closing the alert needs him either to revoke it there, or to dismiss it as **used in tests** if he accepts the assessment above.
