# The Lazarette vault bridge

Database secrets and AWS sessions can come from the Lazarette vault instead of files or the environment. Code: `server/Vault.ps1`. Tests: `tests/server/Vault.Tests.ps1`.

## Setup

In `<home>\sources.json` a source names a vault **item**, never a secret:

```json
[
  { "id": "maint", "kind": "postgres", "provider": "odbc",
    "connection": "Driver={PostgreSQL Unicode};Server=db;Database=maint",
    "vault": { "item": "maint-db" } },
  { "id": "parts", "kind": "access", "provider": "oledb",
    "connection": "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=D:/parts.accdb",
    "vaultItem": "parts-tracker" },
  { "id": "lake", "kind": "aws-athena", "provider": "athena", "region": "us-gov-west-1",
    "database": "maint", "vault": { "item": "aws-semaphore" } }
]
```

`"vaultItem": "name"` is the short form of `"vault": { "item": "name" }` (the field name Lazarette's item table gives for Semaphore). Give one or the other; both together is refused. The `vaultItem` on a source in a browser catalog (`examples/fleet-maintenance/catalog.json`) is only a label for people: the server reads `sources.json`.

## Item names

Lazarette keeps one table of the vault item each Fleet app reads (its `docs/FLEET-ITEMS.md`). For Semaphore it is:

| Used for | Default item | Where the name is set | What Semaphore does with it |
|---|---|---|---|
| Each ODBC or OLE DB data source | none: named per source | `vault.item` or `vaultItem` of that source in `sources.json` | the item's secret becomes the password (`PWD=` / `Password=`), its field `Username` the user, both in memory for one request |
| Each Athena or Redshift source | none: named per source | the same | fields `AccessKeyId`, `SecretAccessKey` and optional `SessionToken` become the AWS session that signs the request |
| Each Foundry source | none: named per source | the same | the item's secret is the bearer token |
| Fairlead client key (AI drafting) | **not a Lazarette item**: Windows Credential Manager target `Fairlead/Semaphore`, written by Fairlead | Fairlead > Clients (install for Semaphore); `Set-SemaphoreAiKey.bat` is a manual fallback, and `SEMAPHORE_AI_KEY` is for CI | sent only to Fairlead on 127.0.0.1:8776, after it answers as Fairlead |

The Fairlead key is the one place the Fleet's "one vault" contract is not yet followed: Semaphore keeps it in Credential Manager, not Lazarette, because the server reads it at every draft without anyone unlocking a vault. Moving it is a decision for the team, not done here.

| Provider | Roles read from the item |
|---|---|
| odbc, oledb | `password` = the item's secret; `user` = field `Username` (optional, used only when the connection string has no UID) |
| athena | `accessKeyId` = field `AccessKeyId`, `secretAccessKey` = `SecretAccessKey`, `sessionToken` = `SessionToken` (optional) |

`"fields": { "user": "Login" }` renames a role's field. Any other key in the block, or a secret in it, makes Semaphore skip the source and log why. `PWD=` in a connection string is still refused.

## How it works

- Lazarette's contract (its `docs/INTEGRATION.md`): `lib\Lazarette.ps1` is loaded once per process and `Get-LazaretteSecret` reads the item. Semaphore finds it through `LAZARETTE_PATH`, a `Lazarette` folder next to the Semaphore folder, or `%USERPROFILE%\Projects\Lazarette`.
- Unlocking is interactive by design. Start with `Launch-Semaphore.bat --console`; Lazarette asks for the passphrase and authenticator code in that console, never in the browser. Started hidden, vault sources answer `423 vault-locked` and say how to unlock.
- The vault is open only in the main runspace, so the main loop reads the secrets for the one source a request names and hands them to the worker with that request. They exist in memory for that request, are never logged, returned or written, and are scrubbed from driver and AWS error text.
- The connection string is built in memory: ODBC `UID={..};PWD={..}` (`}` doubled), OLE DB `User ID="..";Password=".."` (`"` doubled). Values with control characters are refused.
- `GET /api/vault` reports whether Lazarette was found and is open, and which source uses which item. It never returns a value.
- Without a `vault` block nothing changes: DSN or integrated authentication for databases, the environment for AWS.

## What is tested, and what is not

Tested against a fake Lazarette that follows the contract: finding it, locked and open states, missing items and fields, optional fields, escaping, redaction, the AWS session reaching the SigV4 signer (against a loopback server) and the secret key never leaving the machine.

Not tested, for Anthony to check on the target machine:

1. A real Lazarette vault: `Launch-Semaphore.bat --console`, unlock, run a query on a vault source.
2. That `Get-LazaretteSecret -Service <item> -Field <name>` returns custom fields as Lazarette 5 documents (the fake follows the docs).
3. A real AWS session held in a vault item against real Athena.
4. Lazarette does not broker short-lived AWS sessions by itself: the item holds whatever session IT put there. Renewing it is a vault edit.
