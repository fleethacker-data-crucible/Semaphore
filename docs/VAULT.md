# Secrets from Lazarette

Database passwords, AWS sessions and Foundry tokens can come from Lazarette instead of files or the environment. Semaphore reads them **by name over this computer's loopback**, the way Lazarette's `docs/TOOLS.md` describes for suite tools: it never loads the Lazarette engine, never holds the vault key, and gets only the names you shared with it. Code: `server/Vault.ps1` and `server/Lazarette.Client.ps1` (a copy of Lazarette's `tools/Lazarette.Client.ps1`; its header names the Lazarette version and commit). Tests: `tests/server/Vault.Tests.ps1`.

## Set up (once)

1. In Lazarette: **Settings > Tools**, name the tool `Semaphore`, **Pair tool**, and copy the code (`lztl1.…`). It is shown once.
2. In Semaphore: **Settings > Lazarette**, paste the code and choose **Pair**. The box does not show it, and the server neither logs it nor sends it back. Or in a console: `Semaphore-CLI.bat vault pair`, which reads it without echo (`Read-Host -AsSecureString`). Either way it is kept DPAPI-protected for your Windows account under `%LOCALAPPDATA%\Lazarette\tools\Semaphore.pairing`, exactly as the client stores it.
3. Back in Lazarette, under **Semaphore**, share each item under the variable name its source asks for (below), for example the maintenance database's item as `SMDATS_PASSWORD` and its login as `SMDATS_USER`.
4. **Settings > Lazarette** (or `Semaphore-CLI.bat vault status`) shows whether Semaphore is paired, whether Lazarette is running and unlocked, and which names are shared. Names only, never a value.

Lazarette must be running and unlocked when a flag queries a source that uses it. Semaphore itself can start hidden: nothing is asked in its console.

## sources.json

A source names one shared **variable** per role, never a secret and never an item:

```json
[
  { "id": "maint", "kind": "postgres", "provider": "odbc",
    "connection": "Driver={PostgreSQL Unicode};Server=db;Database=maint",
    "vault": { "password": "SMDATS_PASSWORD", "user": "SMDATS_USER" } },
  { "id": "parts", "kind": "access", "provider": "oledb",
    "connection": "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=D:/parts.accdb",
    "vault": { "password": "PARTS_PASSWORD" } },
  { "id": "lake", "kind": "aws-athena", "provider": "athena", "region": "us-gov-west-1",
    "database": "maint",
    "vault": { "accessKeyId": "AWS_ACCESS_KEY_ID", "secretAccessKey": "AWS_SECRET_ACCESS_KEY", "sessionToken": "AWS_SESSION_TOKEN" } }
]
```

| Provider | Roles (required unless marked) | What Semaphore does with them |
|---|---|---|
| `odbc`, `oledb` (and `synapse`, which runs as ODBC) | `password`; `user` (optional) | `PWD=` / `Password=` and `UID=` / `User ID=` in the connection string, in memory for one request. A `UID` already in the connection string wins. Synapse `SqlPassword` and `ActiveDirectoryPassword` need both. |
| `athena`, `redshift-data` | `accessKeyId`, `secretAccessKey`; `sessionToken` (optional) | the AWS session that signs the request |
| `foundry` | `token` | the bearer token |

Names follow Lazarette's rule for shares: letters, digits and `_`, not starting with a digit. Each role needs its own name. The block may hold only the roles of its provider; anything else (an unknown role, a value that is not a variable name, the retired `"item"`, `"fields"` or `"vaultItem"`) makes Semaphore skip the source and log why. `PWD=` in a connection string is still refused.

**Nothing is implicit (#64).** A role is read only when the block names it. When a named optional role has no value (not shared, or the shared item is empty), the query goes on and Semaphore leaves a note that names the share, never a value: in the log, as `notes` on the query answer, and at the end of a connect error, for example *"Lazarette has no user for source 'maint' (SMDATS_USER: it is not shared with Semaphore), so it signs in with the user in its DSN or with Windows authentication."* A required role with no value stops the request with `424 vault-not-shared`.

The `vaultItem` on a source in a **browser catalog** (`examples/fleet-maintenance/catalog.json`) is only a label for people; the server never reads it. What Semaphore reads is the `vault` block in `sources.json`. (Lazarette's `docs/FLEET-ITEMS.md` row for Semaphore should say the same: shares named per source in `sources.json`.)

## Item names and keys

| Used for | Where the name is set | What Semaphore does with it |
|---|---|---|
| Each ODBC or OLE DB data source | `vault.password` and `vault.user` of that source in `sources.json` | password and user, in memory for one request |
| Each Athena or Redshift source | `vault.accessKeyId`, `vault.secretAccessKey`, `vault.sessionToken` | the AWS session that signs the request |
| Each Foundry source | `vault.token` | the bearer token |
| Fairlead client key (AI drafting) | **not a Lazarette share**: Windows Credential Manager target `Fairlead/Semaphore`, written by Fairlead (Fairlead > Clients); `Set-SemaphoreAiKey.bat` is a manual fallback, and `SEMAPHORE_AI_KEY` is for CI | sent only to Fairlead on 127.0.0.1:8776, after it answers as Fairlead |

**AI keys never come to Semaphore.** AI provider secrets (OpenAI, Anthropic, Azure OpenAI and so on) are Lazarette items shared with Fairlead only (Lazarette `docs/FAIRLEAD.md`). Fairlead holds them in memory and calls the provider. Semaphore gets a **client token that Fairlead issues** (`fl-…`): it is scoped to Semaphore, revocable in Fairlead > Clients, and useless outside Fairlead. Semaphore refuses anything that is not in the `fl-` format (`Test-SemAiKeyShape`), so a provider key pasted by mistake is never stored or sent.

## How it works

- For each `/api/query` or `/api/profile` on a source with a `vault` block, the **worker runspace that serves the request** calls `Resolve-SemVaultSecrets` (the one seam) for the one source the request names; the main loop only hands the connection over, so a slow or locked Lazarette never holds heartbeats, static files or other flags' queries. It sends `POST /peer/tools/v1/secrets` to `127.0.0.1:8765` (or `LAZARETTE_PORT`) with `X-Fleet-Peer: lazarette-tool/1`, the source's names and the purpose `Semaphore query on source <id>`, and an HMAC-SHA256 proof over a fresh nonce keyed by the pairing secret, which never crosses the socket. Lazarette's answer is sealed (AES-256-CBC + HMAC-SHA256 under a key from the pairing secret and the nonce); the client checks the seal before reading it. Lazarette logs every read under Semaphore's name and the purpose.
- The values exist in memory in that worker for that request only: when the request ends, `Clear-SemVaultRequest` overwrites them before the runspace goes back to the pool. They are never logged, returned or written, and are scrubbed from driver, AWS and Lazarette error text (`Get-SemVaultSafeText`).
- The connection string is built in memory: ODBC `UID={..};PWD={..}` (`}` doubled), OLE DB `User ID="..";Password=".."` (`"` doubled). Values with control characters are refused.
- `GET /api/vault` (and `vault status`) reports `paired`, `running`, `locked`, which source reads which share, and which names Lazarette has (`shared`) or not (`notShared`, with the state). The tool protocol has no state-only call, so each check is a real read: Semaphore asks once for the names, drops the values at once, and keeps the states for 60 s (`cachedAt` says when it last asked; pairing or unpairing forgets them). It never returns a value.
- Without a `vault` block nothing changes: DSN or integrated authentication for databases, the environment for AWS and Foundry.

## Read-only is the database's job

Semaphore's SQL guard (`Test-SemSqlGuard`) is defence in depth, not the control: it allows one `SELECT`, refuses `;`, `--`, `/*` and `INTO`, and refuses the statement keywords `EXEC`, `EXECUTE`, `DROP`, `ALTER`, `CREATE`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `BACKUP`, `RESTORE`, `DBCC` and `GO` wherever they stand outside a quoted string or a quoted name (T-SQL needs no `;` between statements, so `SELECT 1 EXEC sp_who` is two statements). A guard on text cannot know every dialect's way of writing. **On SQL Server, Azure SQL and Synapse the login Lazarette shares with Semaphore must be read-only** (`db_datareader` only, no `EXECUTE`), and the same for any other database: `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` on PostgreSQL and `Mode=Read` / `ReadOnly=1` on Access are set by Semaphore, `ApplicationIntent=ReadOnly` on Synapse only routes to a readable secondary. The guard stops mistakes; the login stops everything else.

## Errors

Each answer carries a sentence the analyst can act on; the flag shows it.

| State | Status, code | Sentence (shortened) |
|---|---|---|
| Lazarette not running | 501 `vault-unavailable` | Lazarette is not running on this computer. Start Lazarette, unlock it, and try again. |
| Lazarette locked | 423 `vault-locked` | Lazarette is locked. Unlock Lazarette in its window and try again. |
| Not paired (no pairing file here, or Lazarette removed it) | 424 `vault-not-paired` | Pair a tool named Semaphore in Lazarette (Settings > Tools), then paste the code under Semaphore's Settings > Lazarette or run `Semaphore-CLI.bat vault pair`. (The status line in `GET /api/vault` says both; the query error names the CLI.) |
| A different program used the pairing | 424 `vault-other-program` | Pair Semaphore again from the program that should hold it. |
| A required name not shared, or empty | 424 `vault-not-shared` | Source 'maint' needs SMDATS_PASSWORD (it is not shared with Semaphore). Share the item under that name. |
| Too many failed requests, clock skew | 424 `vault-refused` | Lazarette's own sentence. |
| Anything else (a seal that does not check, a malformed answer) | 424 `vault-error` | Lazarette could not give the secrets for source 'maint': ... |

## Updating the client copy

`server/Lazarette.Client.ps1` is Lazarette's file unchanged except for three header lines naming where it came from. When Lazarette changes the client, copy it again and update those lines.

## What is tested, and what is not

Tested against a fake Lazarette on loopback that checks the header and the proof and seals its answer with the same construction: pairing stored with DPAPI and read back, the names and purpose sent, every error state and its sentence, a seal that does not check, optional roles that leave a note, redaction, status without values, the AWS session reaching the SigV4 signer (against a loopback server) and the secret key never leaving the machine, and that no file in `server/` dot-sources a Lazarette engine file.

Not tested, for Anthony to check on the target machine:

1. A real Lazarette 5.1: pair Semaphore, share an item, start Semaphore hidden (`Launch-Semaphore.bat`), run a flag on that source.
2. Each error state on the flag with a real Lazarette: stopped, locked, Semaphore removed in Settings > Tools, a name not shared.
3. The program-path pin: Semaphore's server and `Semaphore-CLI.bat` both run as `powershell.exe`, so they share the pin. A pairing first used from another program is refused until paired again.
4. A real AWS session shared from Lazarette against real Athena. Lazarette does not broker short-lived AWS sessions by itself: the item holds whatever session IT put there, and renewing it is a vault edit.
5. A Nautilus twin run with a mock Lazarette (Semaphore #63 acceptance).
