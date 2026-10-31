# Databricks serving endpoint provider

**Status: written to Databricks' documented serving API and tested against a simulated endpoint only.** No real Databricks workspace, token or endpoint was used. Request paths, headers and bodies, answer parsing, error and timeout mapping, URL rules and the fall-back to local rules are covered by `tests/databricks.test.ts` with a fake `fetch`. Whether a real workspace accepts exactly these requests and answers in exactly this shape is **not verified**; see [To validate](#to-validate-against-a-real-workspace).

It sits next to the other remote providers in [INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md). Everything there still applies: the output is a suggestion, it goes through the same validation against the catalog, a model's confidence is capped at 0.8, and any failure falls back to local rules with the reason shown.

## What it is

`DatabricksProvider` (`src/core/intelligence/remote.ts`) is an OpenAI-compatible chat provider with Databricks' routes and error format. It needs:

| Setting | What |
| --- | --- |
| `url` | The workspace URL, for example `https://adb-1234567890123456.7.azuredatabricks.net`. A pasted route, query or fragment is dropped; a path prefix (a proxy in front of the workspace) is kept. |
| `endpoint` | The serving endpoint's name (letters, digits, `.`, `_`, `-`; up to 128 characters). It is encoded into the path, so it cannot change the route. |
| `token` | A bearer token (personal access token or OAuth token) for a service principal that may query that endpoint. Supplied by the caller; never stored by the provider, never in an error message. |
| `route` | `invocations` (default) or `chat-completions`, below. |
| `maxTokens`, `jsonMode` | Optional. `maxTokens` caps the answer. `jsonMode` adds `response_format: {"type":"json_object"}`; it is off by default because not every Databricks endpoint accepts it, and the prompt already asks for JSON only. |

### Routes

| `route` | Request | Body |
| --- | --- | --- |
| `invocations` (default) | `POST <workspace>/serving-endpoints/<endpoint>/invocations` | `messages`, `temperature: 0` |
| `chat-completions` | `POST <workspace>/serving-endpoints/chat/completions` | the same, plus `"model": "<endpoint>"` (the route the OpenAI client library uses against Databricks) |

Both send `Authorization: Bearer <token>`, `Accept` and `Content-Type: application/json`, `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, and time out after 30 s unless `timeoutMs` says otherwise.

The answer is read from `choices[0].message.content`. Endpoints for models that think first return that field as a list of content parts; the `text` parts are joined and the reasoning parts are ignored. A Markdown code fence around the JSON is removed. A model that refuses `temperature: 0` is asked again with its default, as with other OpenAI-compatible providers.

`ping()` reads `GET <workspace>/api/2.0/serving-endpoints/<endpoint>` and reports its `state.ready`; `listModels()` lists endpoint names from `GET <workspace>/api/2.0/serving-endpoints`.

### Errors

Databricks' `{ "error_code", "message" }` body is shown (shortened, with the token scrubbed). A hint follows for the usual causes:

| Status | Hint |
| --- | --- |
| 401, 403 | The token is invalid or may not query this endpoint |
| 404 | Check the workspace URL and the endpoint name |
| 429 | Rate limited; try again shortly |
| 503 | The endpoint may be starting up (scale to zero); try again in a minute |

A timeout, a network failure, an answer over 2,000,000 characters, a non-JSON body and an answer that is not a draft are errors too. In the app each of them falls back to local rules and the page says why.

## URL rules

The same rules as every provider (`safeUrl`):

- HTTPS only. Plain HTTP is accepted only for `127.0.0.1`, `localhost` and `[::1]`, which is how a simulated endpoint is reached.
- No user name or password in the URL. The token never goes in the URL.
- The endpoint name is checked separately (above).

## Where the token lives

Never in the browser. The page has no way to build this provider with a token, and the browser's AI provider is the Semaphore server's relay.

Semaphore's server relay is unchanged by this provider: it still talks **only to Fairlead on this computer** (`SEMAPHORE_AI_URL` must be loopback, the address must identify as `fairlead` before the key is sent; see [INTELLIGENCE_PROVIDERS.md](INTELLIGENCE_PROVIDERS.md#fairlead)). To use a Databricks endpoint from the app, route to it **through Fairlead**:

1. Add the Databricks workspace, endpoint and token to Fairlead as a provider (Fairlead holds the Databricks token, as it holds every provider credential). That is a Fairlead task and is not covered by Semaphore's tests.
2. Set `SEMAPHORE_AI_MODEL` to the Fairlead route that points at it. Semaphore accepts route names made of letters, digits and `. _ : / -`, and the page cannot choose a route itself.
3. Set `SEMAPHORE_AI_PRIVACY=off`. By default Semaphore sends `X-Fairlead-Privacy: local`, which keeps prompts on this computer, so Fairlead will not send them to Databricks. Turning that off is a deliberate decision for an organisation whose Databricks workspace is approved for these prompts: the prompts then carry briefs, catalog keys and labels (and reviewed examples when the analyst has switched those on), as described in "What each AI feature sends".

No server code was added for a direct Semaphore-to-Databricks relay. That would make the server call a non-loopback address with a bearer token, a change to the relay's core safety rule ("Semaphore never calls a remote AI service itself; Fairlead decides") that should be a separate, reviewed decision. `DatabricksProvider` is for callers that already hold the token on the server side (a Node host or a future relay mode) and are happy with the rules above.

## What it sends

Exactly what the OpenAI-compatible provider sends: the brief, the catalog's keys, labels, types and synonyms, the team style card, and (only when the analyst switched them on) reviewed examples. Never rows, connection strings or credentials. The Databricks workspace sees those prompts, so use it only when it is approved for them.

## To validate against a real workspace

These need a real Databricks workspace, an endpoint and a token, so they are for Anthony or whoever owns the workspace, not for the simulated tests:

1. **Validate against a real Databricks workspace.** With a throwaway endpoint (a pay-per-token foundation model endpoint is enough) and a token for a service principal, run `new DatabricksProvider({...}).ping()`, then a `draftFlag` and a `draftHoist` for the example catalog. Confirm the route, the body and the answer shape below.
2. Confirm `invocations` and `chat-completions` both work for the model in use; remove the route that does not.
3. Confirm whether the endpoint accepts `temperature: 0` and `response_format: json_object` (`jsonMode`), and what its 4xx message looks like if not (the temperature retry looks for the word "temperature" in the error).
4. Confirm the error bodies for 401, 403, 404, 429 and a cold start (503) match the shapes in `tests/databricks.test.ts`.
5. Confirm how a reasoning model's `content` parts look (the parser expects `{ "type": "text", "text": "..." }` parts and ignores the rest).
6. Decide whether a direct Semaphore-to-Databricks relay is wanted (token in Credential Manager, a host allow-list, port authority does not apply to a remote host), or whether routing through Fairlead is enough.
7. Confirm the Fairlead route configuration for Databricks, and that the privacy header behaves as described.
