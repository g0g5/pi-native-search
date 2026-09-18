# pi-native-search

> **Local ChatGPT fork:** Adds `openai-codex` (OpenAI ChatGPT subscription) search,
> reusing Pi's OAuth login and token refresh. Targets Pi `@earendil-works/*` 0.85.1+.
> See [LOCAL-FORK.md](LOCAL-FORK.md) for local installation, tests, and rollback.
> The npm install command below installs upstream, **not this fork**.

[![npm version](https://img.shields.io/npm/v/pi-native-search)](https://www.npmjs.com/package/pi-native-search)
[![license](https://img.shields.io/npm/l/pi-native-search)](LICENSE)

A [pi](https://github.com/badlogic/pi-mono) extension that adds `web_search` and `web_fetch` tools.

Search routing is **independent of the conversation provider**. Each call walks a
priority chain of implemented search backends and uses the first one that
succeeds. `web_fetch` always uses a single direct HTTP implementation.

## Routing priority

Targets are considered in this order, then deduplicated by backend + model:

1. **Globally configured backend** (`searchProvider` / `searchModel`). An LLM
   backend here must name a model registered for that provider in Pi. Omitting the
   model skips this tier.
2. **Active conversation model**, when its provider has an implemented search
   backend. The exact conversation model is used (including for Claude Bridge —
   no implicit SDK default).
3. **Authenticated non-LLM backends**: ZAI Web Search Prime MCP.
4. **DuckDuckGo**, unauthenticated, always available.

Other authenticated LLM providers are **never** selected automatically. After a
failure — auth, unsupported model, rate limit, timeout, network error, or any
other backend error — the chain continues to the next distinct target. A
successful response with no results is terminal success. Exhausting the chain is
a tool error, never a fabricated empty success. Missing credentials skip
credential-dependent targets; Claude Bridge readiness is deferred until it is
actually invoked. Cancellation stops the chain immediately.

| Implemented backend | Kind | Model needed | Auth source |
|---|---|---|---|
| **openai-codex** (OpenAI ChatGPT subscription) | LLM | yes, when pinned | Pi's `/login openai-codex` OAuth credentials (auto-refreshed) |
| **claude-bridge** (Claude Code subscription) | LLM | yes, when pinned | Your `claude` CLI login |
| **anthropic** | LLM | yes, when pinned | `ANTHROPIC_API_KEY` |
| **google** (Gemini) | LLM | yes, when pinned | `GEMINI_API_KEY` |
| **openai** | LLM | yes, when pinned | `OPENAI_API_KEY` |
| **xai** (Grok) | LLM | yes, when pinned | `XAI_API_KEY` |
| **zai** (GLM) | non-LLM | no | `ZAI_API_KEY` (Web Search Prime MCP, included in Coding Plans) |
| **duckduckgo** | non-LLM | no | none |

Conversation providers without an implemented search adapter (DeepSeek,
OpenRouter, Mistral, …) remain valid Pi providers and are reported as such, but
they are not selectable search backends. `providers.yaml` documents this same
set; the runtime registry is `SEARCH_BACKENDS` in `extensions/search-providers.ts`.

## Install

```bash
pi install npm:pi-native-search
```

## Usage

Once installed, two tools become available to the model:

- `web_search { query }` — searches the web through the priority chain.
- `web_fetch { url }` — fetches and returns a page's text content over direct
  HTTP (truncated to 50 KB / 2000 lines).

Use the `/search` slash command to configure or inspect the extension:

```
/search           # settings: global switches, search backend, registered model
/search providers # implemented search backends with credential readiness
/search config    # session model, planned target, chain, and skips
/search on        # enable both tools
/search off       # disable the extension entirely
```

The status bar shows the **planned** target, e.g.:

```
search[search:openai-codex/gpt-5,fetch:http]   # pinned cross-provider target
search[search:anthropic/claude-sonnet-4-5 (session),fetch:http]
search[search:zai:mcp,fetch:http]
search[search:duckduckgo,fetch:http]
search[search:config-error,fetch:http]         # fix with /search
```

While a search runs, progress updates name the **actual attempt** (e.g.
`Searching with openai/gpt-5 (attempt 1/3)`), which can differ from the planned
target if a fallback was needed.

Only global switches control tool availability. `/search on|off` and the
settings panel enable/disable the tools regardless of which conversation
provider is active, including sessions with no selected model.

## Configuration

Configuration persists in `~/.pi/agent/search-config.json` (under `getAgentDir()`
if the agent directory is customized):

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "searchProvider": "openai-codex",
  "searchModel": "YOUR_REGISTERED_MODEL_ID"
}
```

- **Missing fields get defaults**: all switches enabled, no pinned target
  (automatic routing).
- **`searchProvider`** must be one of the implemented backends above. Omit it for
  automatic selection. `automatic` in the settings UI clears it.
- **`searchModel`** is required for a pinned LLM backend; it must be an exact ID
  registered for *that* provider in Pi. A missing or whitespace-only value skips
  the pinned tier instead of borrowing a conversation model or SDK default.
  Non-LLM backends ignore a string model value, and switching backends clears a
  stale selection. A non-string model value is a configuration error.
- No credentials are ever stored in this file.

### Configuration errors

Unknown backend IDs, invalid field types, malformed JSON, and pinned LLM models
that are not registered for the selected provider produce a clear configuration
error **before any network request**. Errors are reported by `/search config`, in
the status bar (`search:config-error`), and by the tool call, which stays
repairable:

- A search-target error blocks search but leaves enabled `web_fetch` fully working.
- A malformed or structurally invalid file blocks both tools rather than guessing
  enablement. Saving from `/search` rewrites a valid file.

Missing authentication and runtime model-search incompatibility are **not**
configuration errors; they are handled by the fallback chain.

### Migrating from provider overrides

Earlier versions enabled search/fetch per conversation provider and allowed a
per-provider `model` under `providerOverrides`. **These are removed.**

- Global switches (`enabled`, `searchEnabled`, `fetchEnabled`) are preserved.
- All legacy `providerOverrides` values are ignored. A global target is never
  inferred from a legacy model override.
- Reading legacy configuration never rewrites the file; a one-time migration
  notice points you at `/search`.
- An explicit settings save writes only the new global shape and drops the legacy
  fields.

Advice: back up `search-config.json` before your first settings save if you want
to keep the old values around.

Because override removal changes routing, replace any old override behavior with
a global target, e.g.:

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "searchProvider": "openai-codex",
  "searchModel": "YOUR_REGISTERED_MODEL_ID"
}
```

To roll back the whole extension, restore the previous extension revision and the
backed-up configuration. No credential or external data migration is involved.

## web_fetch

`web_fetch` uses one direct HTTP implementation for **every** conversation
provider and search backend. It resolves no search credentials, invokes no LLM,
and has no fallback chain; only the global extension/fetch switches control it.
Claude Bridge-specific fetching was removed, so a Claude Bridge conversation
fetches pages over HTTP rather than through the Claude SDK.

Preserved behavior:

- JSON responses are pretty-printed; plain text is returned unchanged; HTML has
  `<script>`/`<style>` content and tags removed.
- Output is limited to 50 KB / 2000 lines, with the truncation notice included in
  that budget.
- Result details report `{ url, method: "local" }` — no conversation-provider
  identity is implied.
- HTTP errors surface as tool errors, and cancellation is terminal.

## Structured search sources

Successful `web_search` results include `details.sources: { title, url }[]` and
`details.apiSources: { type: "api", name: string }[]`. Provenance identifies the
backend that actually produced the result:

```json
{
  "query": "Pi documentation",
  "provider": "openai-codex",
  "method": "native",
  "tier": "configured",
  "searchModel": "gpt-5",
  "searchModelSource": "configured",
  "sources": [{ "title": "Pi", "url": "https://pi.dev/" }],
  "apiSources": [],
  "attempts": [{ "backend": "openai-codex", "modelId": "gpt-5", "tier": "configured", "ok": true }],
  "skips": [{ "backend": "zai", "reason": "No usable credentials for this search backend." }]
}
```

- `details.provider` is the backend that succeeded, including `duckduckgo`.
- `details.method` is `native` for backend adapters and `ddg` for DuckDuckGo.
- `details.tier` is `configured`, `session`, or `fallback`.
- `details.searchModel` / `details.searchModelSource` are set **only** for a
  successful LLM target, so a DuckDuckGo result after an LLM failure carries no
  successful LLM model. Earlier failures are reported separately in
  `details.attempts` (bounded, sanitized) and in a short model-visible
  `> Search fallback:` notice.
- `details.skips` explains targets that were not attempted (missing credentials,
  duplicates, unsupported conversation provider), capped and sanitized.
- Diagnostics never include tokens, headers, or raw credential-bearing URLs.

| Native LLM backend | Source metadata used |
|---|---|
| `openai`, `openai-codex` | URL citations from all answer blocks, then `web_search_call.action.sources` |
| `xai` | URL citations from all answer blocks, then top-level `citations` |
| `google` | Selected candidate's `groundingMetadata.groundingChunks[].web` |
| `anthropic` | Text citations, then `web_search_tool_result` hits |

Sources are provider-supplied citations/search hits, not URLs guessed from answer
text, and not necessarily all cited in the answer. They are deduplicated by exact
URL, with cited sources first. HTTP/HTTPS URLs keep their query strings (including
Google grounding redirect URLs); missing titles fall back to the hostname. xAI's
numeric citation titles also fall back to the hostname.

- Metadata retains at most 64 sources and 32 KiB of serialized source data. URLs
  over 4096 UTF-8 bytes are omitted rather than shortened; titles are capped at
  512 UTF-8 bytes. Invalid URLs and malformed optional source entries are ignored.
- Responses search can also return API sources, e.g. `{ "type": "api", "name":
  "oai-weather" }` for weather queries, without URL citations. These are retained
  separately in `apiSources`, never converted to guessed URLs or vendor names.
  API metadata is deduplicated by cleaned name and limited to 16 entries / 4 KiB;
  blank, non-string or over-256-UTF-8-byte names and unknown source types are ignored.
- Model-visible text includes a Markdown `## Sources:` section, showing up to 8
  retained sources total within a 16 KiB display budget. API sources are displayed
  first with an explicit notice that the provider supplied no accessible URL.
  More sources remain in `details.sources` / `details.apiSources`; an omission
  notice identifies the displayed count.
- The complete text output, including Sources and truncation notices, stays within
  50 KiB / 2000 lines. Space is reserved for sources before truncating the answer.
- `sources: []` means no retained URL sources, not necessarily no provenance:
  check `apiSources` too. Codex answers with neither type include a
  model-visible missing-metadata notice; API-only answers remain native successes.
  Collapsed tool output shows URL/API source counts, or a missing-metadata warning
  (also for historical results lacking source fields).
- Claude Bridge, ZAI and DuckDuckGo keep their existing text output and return
  both arrays empty; their text links are not parsed into metadata.
- A failing attempt's partial sources are discarded before fallback.

## How it works

- `extensions/search-providers.ts` — the runtime search-backend registry
  (kind, auth mode, env key). Documentation-only mirror: `providers.yaml`.
- `extensions/search-config.ts` — parsing, defaults, validation, legacy handling,
  and serialization of `search-config.json`.
- `extensions/search-routing.ts` — the pure, network-free target planner:
  ordered candidates, deduplication, skip diagnostics, and pinned-model
  validation.
- `extensions/index.ts` — credential readiness, target-scoped adapters, the
  sequential fallback orchestrator, provenance, tools, settings, and status.
- `extensions/chatgpt-search.ts` — Codex OAuth transport, proxy handling, SSE
  parsing, and the 90-second deadline.
- `extensions/search-result.ts` — shared parsers, source normalization, and
  source-aware output formatting.

Each search builds a fresh plan from the current session and loaded settings, so
a saved settings change applies immediately. Planning never refreshes OAuth or
probes the network.

### claude-bridge specifics

Claude Bridge is used for **search** only. When it is selected (through the pinned
tier with a registered model, or through the active-model tier), the extension
dynamically locates `@anthropic-ai/claude-agent-sdk` (shipped inside
`pi-claude-bridge`'s own `node_modules`) and spawns a one-shot `query()` with
`allowedTools: ["WebSearch"]` and the exact selected model. This means:

- No extra dependency to install — reuses what `pi-claude-bridge` already brought in.
- Auth comes from your `claude` CLI login, not an API key.
- It uses your subscription, not API credits.

An unsuccessful SDK termination is reported as an error so the chain can advance;
it is never returned as an empty success.

## Adding a new backend

Adding a backend is a self-contained change:

**1. Register the backend** in `extensions/search-providers.ts`:

```ts
foo: {
  name: "Foo Provider",
  kind: "llm",            // or "non-llm" when no LLM/model is involved
  auth: "api-key",
  envKey: "FOO_API_KEY",
},
```

Also add it to `providers.yaml` so the documentation mirror stays in sync
(`tests/providers-doc.test.ts` enforces this).

**2. Implement a target-scoped adapter** in `extensions/index.ts`:

```ts
import { normalizeSources, type SearchResult } from "./search-result.ts";

async function fooSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const res = await fetch("https://api.foo.com/search", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, model }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Foo search failed (HTTP ${res.status}).`); // never echo the body
  }
  const data = (await res.json()) as any;
  return { text: data.text || "", sources: normalizeSources(data.results || []) };
}
```

Adapters perform exactly one attempt and throw on failure; they must not choose a
fallback themselves.

**3. Add a case to `attemptSearch`**, resolving credentials for that backend only:

```ts
case "foo": {
  const apiKey = requireApiKey("foo");
  signal?.throwIfAborted();
  return fooSearch(query, requireModelId(target), apiKey, signal);
}
```

A non-LLM backend belongs in `NON_LLM_FALLBACK_ORDER` instead of requiring a
model, and must never accept a model. The planner, settings UI, provider list, and
fallback orchestration all derive from the registry, so no additional wiring is
needed.

## Development

```bash
git clone https://github.com/smalibary/pi-native-search.git
cd pi-native-search
npm test
# Install the local package as described in LOCAL-FORK.md, then in pi: /reload
```

Pi loads `extensions/index.ts` and its helper modules at runtime — no build step
required. Tests use `node:test` with Node's native TypeScript stripping, isolate
`PI_CODING_AGENT_DIR` in a temp directory, and mock all network access:

- `search-providers.test.ts`, `providers-doc.test.ts` — registry and doc sync.
- `search-config.test.ts` — parsing, validation, legacy handling, serialization.
- `search-routing.test.ts` — the table-driven planner.
- `search-dispatch.test.ts` — target-scoped dispatch, fallback, cancellation,
  provenance.
- `search-settings.test.ts` — settings UI, activation, status.
- `web-fetch.test.ts` — unified fetch.
- `search-integration.test.ts` — end-to-end chain and persistence.
- `search-result.test.ts`, `api-sources.test.ts`, `search-sources.test.ts`,
  `chatgpt-search.test.ts`, `routing.test.ts` — parsers, source budgets, Codex
  transport, and tool registration.
- `tests/live-chatgpt.ts` — opt-in live check (`npm run test:live`), intentionally
  not part of `npm test`.

## License

MIT — see [LICENSE](LICENSE). PRs welcome, especially for new provider backends.

## Acknowledgements

- [opencode-websearch](https://github.com/emilsvennesson/opencode-websearch) — reference for separating selection from execution and for structured source extraction, URL deduplication, and xAI citation handling (reviewed at `775eac4`)

- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner — the host TUI agent
- [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson — provides the Claude Agent SDK that `claude-bridge` search reuses
