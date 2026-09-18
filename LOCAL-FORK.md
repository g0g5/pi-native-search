# Local fork: OpenAI ChatGPT native search

Based on smalibary/pi-native-search commit `4b1a106cf4df264ce6d3aac56991a2a4c89b5b15`
(the installed 0.1.0 extension matches this upstream version).
Local branch: `local/openai-chatgpt`. No remote fork or push is required.

## Behavior

- Provider ID: **`openai-codex`**. UI name: **OpenAI ChatGPT (subscription)**.
  This is not a new Pi model provider; it adds a search backend for Pi's existing one.
- Search routing is **independent of the conversation provider**. Each call walks:
  the globally configured backend, the active conversation LLM model, authenticated
  ZAI Web Search Prime MCP, then DuckDuckGo. See
  [README.md](README.md#routing-priority) for the exact rules.
- To pin Codex globally, set `searchProvider` to `openai-codex` and `searchModel`
  to an exact ID in Pi's model catalog in `~/.pi/agent/search-config.json`, or use
  `/search`. The pinned model changes only search, never the conversation model or
  provider. Without a pinned target, the active `openai-codex` model is used
  through the second tier. There is no hardcoded model or separate
  `openai-chatgpt` provider ID.
- A pinned LLM model must be registered for that provider in Pi, otherwise search
  reports a configuration error **before any request**. A missing/blank model
  skips the pinned tier instead.
- Auth comes from `ctx.modelRegistry.getApiKeyAndHeaders(searchModel)`. Pi owns OAuth
  refresh, locking, and credential persistence. This backend neither reads nor writes
  `auth.json`, copies tokens to another file, nor logs tokens/account IDs.
- Calls `https://chatgpt.com/backend-api/codex/responses` (or the selected model's
  resolved base URL) with the OAuth access token and account header, `store:false`,
  `stream:true`, and a required native `web_search` tool.
- Parses SSE output items, citations and search sources. Codex can return an empty
  final `response.output`; already-completed items must be preserved. A response
  without a completed `web_search_call` is **not** reported as a native search success.
- Supports proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and
  lowercase forms), including Pi provider-scoped overrides, via a per-call Undici
  dispatcher. Does not modify the process-global dispatcher.
- 90-second deadline; cancellation stops the chain immediately and never starts
  another backend request, including during credential resolution.
- A Codex failure advances to the next distinct target (for example the active
  model, then ZAI, then DuckDuckGo) and records a sanitized reason in
  `details.attempts`. No retry loop and no silent model substitution.
- Search output, including Sources and truncation notices, is limited to 50 KiB /
  2000 lines. SSE input is bounded at 8 MiB.
- Codex/OpenAI Responses API sources without URLs (e.g. `oai-weather`) are
  preserved separately as `details.apiSources: { type: "api", name: string }[]`.
  Names are validated, cleaned and deduplicated; API metadata is bounded to
  16 entries / 4 KiB with a 256-byte name limit. API entries appear first in the
  shared 8-source display budget, explicitly marked as having no accessible URL.
  API-only answers remain native successes; no vendor identity or URL is guessed.
  Codex answers with no retained URL or API metadata carry a visible warning.
  Collapsed results show URL/API counts or a missing-metadata warning.
- Native Google, OpenAI, Codex, xAI and Anthropic searches expose structured
  `details.sources` (`{ title, url }[]`) as well as model-visible Markdown sources.
  Citations take precedence over search hits; sources are URL-deduplicated and
  bounded to 64 entries / 32 KiB of metadata. The text shows up to 8 sources within
  a 16 KiB display budget, with space reserved before answer truncation.
  See [README.md](README.md#structured-search-sources) for validation and size limits.
- Claude Bridge, ZAI and DDG keep their existing text output and return
  `sources: [], apiSources: []`; no sources are inferred from model-generated prose.
  A failing attempt's partial sources are discarded before fallback. Anthropic
  server-tool errors explicitly fail over instead of failing to iterate an error object.
- **Provenance changes:** `details.provider` now names the backend that actually
  succeeded (including `duckduckgo`), `details.method` is `native`/`ddg`,
  `details.tier` is `configured`/`session`/`fallback`, and `searchModel` /
  `searchModelSource` are set only for a successful LLM target. Earlier failures
  live in bounded, sanitized `details.attempts`, not in the successful result's
  model fields.
- **`openai` still uses `OPENAI_API_KEY` and the public API**, now requesting full
  search sources in addition to answer citations. Its auth/routing is unchanged.
- Requests consume the ChatGPT/Codex subscription's applicable usage allowance.
  Model/tool availability and account limits still apply. No public OpenAI API key is used.

## Configuration and migration

The persisted shape is now global:

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "searchProvider": "openai-codex",
  "searchModel": "YOUR_REGISTERED_MODEL_ID"
}
```

- `providerOverrides` (per-provider `searchEnabled`/`fetchEnabled`/`model`) is
  **removed**. Global switches are preserved; overrides are ignored; no global
  target is inferred from a legacy model. Reading never rewrites the file, and a
  one-time notice points at `/search`. An explicit settings save writes only the
  new shape. Back up `search-config.json` before that first save if you want the
  old values.
- Unknown backends, wrong field types, malformed JSON, and pinned models that are
  not registered for their provider are configuration errors reported before any
  network request. A search-target error blocks search but leaves valid
  `web_fetch` working; a malformed file blocks both.
- Rollback: restore the previous extension revision and the backed-up
  configuration. No credential or external data migration is required.

## Unified web fetch

`web_fetch` no longer has a Claude Bridge-specific path. Every enabled fetch uses
one direct HTTP implementation regardless of conversation provider or configured
search backend: no bridge SDK, no LLM, no search credentials, no fallback chain.
Extraction (JSON pretty-print, plain text, HTML script/style/tag stripping),
50 KB / 2000-line limits, HTTP errors, and terminal cancellation are preserved,
and detail metadata is `{ url, method: "local" }` with no provider identity.

## Local installation

This fork targets **Pi 0.85.1+ (`@earendil-works/*`)** and Node >=20.18.1.
It migrates the upstream extension's old `@mariozechner/*` and TypeBox imports to
this host version. Older Pi releases are not a supported target of this local fork.

```bash
cd /path/to/pi-native-search-chatgpt
npm install --ignore-scripts
```

Replace `"npm:pi-native-search"` in `~/.pi/agent/settings.json`'s `packages` array with
`"/absolute/path/to/pi-native-search-chatgpt"`. Keep only one copy enabled to avoid
registering `web_search`, `web_fetch`, and `/search` twice. Keep other settings intact.
A local package path is loaded in place, so `pi update` will not overwrite the fork.

Then in Pi:

```text
/reload
/search config
/search providers
```

Existing ChatGPT login is reused. If needed, run `/login openai-codex`, then select an
`openai-codex` model. No login is needed again merely to activate the fork.

## Tests

Offline tests use fake credentials and never load the user's auth file:

```bash
# Node 22.18+ / 24 (native TypeScript stripping)
npm test
```

Optional real integration test (uses the existing subscription and sends one search):

```bash
npm run test:live                    # Pi's default model ID
npm run test:live -- YOUR_MODEL_ID   # explicit openai-codex model
```

This invokes the **registered `web_search` tool**, not just the helper, and asserts
`details.method === "native"`, `details.provider === "openai-codex"`, and a
successful tier with the exact search model; a successful DuckDuckGo fallback
fails the test. It reads the real `search-config.json`, so automatic routing (no
pinned backend) is recommended. The test requires search to be enabled in the
extension configuration.

On this machine the fork has been tested with Pi 0.85.1 and the user's selected
`gpt-6-astra` model. Native web search and source citations were returned successfully.
The initial `gpt-5.4` probe was rejected as unsupported for this account, which is
why the backend defaults to the selected model instead of assuming a fixed model name.
A pinned model is subject to the same account/model/tool availability limits; an
unregistered pin is a configuration error, and a rejected request advances the
fallback chain without silently retrying a different model.

For development on this machine, the peer packages in `node_modules` are symlinked
to the installed Pi host. `undici` is installed locally and locked in `package-lock.json`.
These local dependency symlinks are ignored by Git.

## Rollback

Replace the local path in `~/.pi/agent/settings.json` with `"npm:pi-native-search"`,
then `/reload` or restart Pi. The original npm package is left untouched.
No credential migration or restoration is necessary.

## Changed files

- `extensions/search-providers.ts` (new): runtime search-backend registry
  (`kind`, auth mode, env key). Replaces the old all-provider capability map.
- `extensions/search-config.ts` (new): parsing, defaults, validation, legacy
  `providerOverrides` handling, and serialization of the global config shape.
- `extensions/search-routing.ts` (new): pure, network-free ordered target planner
  with deduplication, skip diagnostics, and pinned-model validation. Replaces
  `search-model.ts`, which only resolved per-provider overrides.
- `extensions/search-model.ts`: **deleted** (superseded by the planner).
- `extensions/index.ts`: target-scoped adapters, sequential fallback
  orchestration, cancellation checks, bounded sanitized diagnostics, truthful
  provenance, global settings/status UI, and a single direct-HTTP `web_fetch`
  (`claudeBridgeFetch` removed).
- `extensions/chatgpt-search.ts`: OAuth-resolved Codex request, proxy and SSE handling;
  unchanged in this change except that it receives an explicit target model
  (built on the upstream `4b1a106` fork work).
- `extensions/search-result.ts`: shared result types, provider response parsers,
  source normalization/limits and source-aware output formatting. Inspired by
  `emilsvennesson/opencode-websearch` at commit `775eac4`; keeps this fork's
  stricter Codex SSE validation and adds Google grounding support.
- `providers.yaml`: documentation-only mirror of the runtime backend registry,
  enforced by `tests/providers-doc.test.ts`.
- `tests/`: isolated request/parser/routing/config/settings/fetch tests plus an
  opt-in live tool test. `search-providers.test.ts` and `providers-doc.test.ts`
  cover registry/doc sync; `search-config.test.ts` covers validation and legacy
  handling; `search-routing.test.ts` covers the planner; `search-dispatch.test.ts`
  covers dispatch, fallback, cancellation, and provenance;
  `search-settings.test.ts` covers the settings UI and activation;
  `web-fetch.test.ts` covers unified fetch; `search-integration.test.ts` covers
  the end-to-end chain and persistence; `search-result.test.ts`,
  `api-sources.test.ts` and `search-sources.test.ts` keep parser, source-budget,
  and registered-tool coverage (Codex uses a network-disabled Undici mock).
- `README.md`, `LOCAL-FORK.md`: new configuration, priority, fallback,
  registered-model constraint, migration/rollback, provenance, and unified fetch.
- `package.json`, `package-lock.json`: current host peers and Undici dependency.
