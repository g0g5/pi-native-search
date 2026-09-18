# Local fork: OpenAI ChatGPT native search

Based on smalibary/pi-native-search commit `4b1a106cf4df264ce6d3aac56991a2a4c89b5b15`
(the installed 0.1.0 extension matches this upstream version).
Local branch: `local/openai-chatgpt`. No remote fork or push is required.

## Behavior

- Provider ID: **`openai-codex`**. UI name: **OpenAI ChatGPT (subscription)**.
  This is not a new Pi model provider; it adds a search backend for Pi's existing one.
- Select a model from that provider in `/model`. Search follows the current model
  unless `providerOverrides["openai-codex"].model` is set in
  `~/.pi/agent/search-config.json`. The override must be an exact ID in Pi's model
  catalog; it changes only search, not the conversation model or provider. Run
  `/reload` after editing. There is no hardcoded model or separate
  `openai-chatgpt` provider ID. See [README.md](README.md#per-provider-search-models)
  for the full configuration, other supported LLM backends, and ignored backends.
- Auth comes from `ctx.modelRegistry.getApiKeyAndHeaders(searchModel)`. Pi owns OAuth
  refresh, locking, and credential persistence. This backend neither reads nor writes
  `auth.json`, copies tokens to another file, nor logs tokens/account IDs.
- Calls `https://chatgpt.com/backend-api/codex/responses` (or the explicitly configured
  model/resolved base URL) with the OAuth access token and account header, `store:false`,
  `stream:true`, and a required native `web_search` tool.
- Parses SSE output items, citations and search sources. Codex can return an empty
  final `response.output`; already-completed items must be preserved. A response
  without a completed `web_search_call` is **not** reported as a native search success.
- Supports proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and
  lowercase forms), including Pi provider-scoped overrides, via a per-call Undici
  dispatcher. Does not modify the process-global dispatcher.
- 90-second deadline; cancellation does not start a DDG fallback. Waiting for Pi's
  shared refresh can be cancelled without cancelling the shared refresh itself.
- Native failures use the existing DuckDuckGo fallback with an explicit warning and
  `details.method = "ddg"`. No retry loop or silent model substitution.
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
- Native Google, OpenAI, Codex, xAI and Anthropic searches now expose structured
  `details.sources` (`{ title, url }[]`) as well as model-visible Markdown sources.
  Citations take precedence over search hits; sources are URL-deduplicated and
  bounded to 64 entries / 32 KiB of metadata. The text shows up to 8 sources within
  a 16 KiB display budget, with space reserved before answer truncation.
  See [README.md](README.md#structured-search-sources) for validation and size limits.
- Claude Bridge, ZAI and DDG keep their existing text output and return
  `sources: [], apiSources: []`; no sources are inferred from model-generated prose. Native
  fallback discards partial sources. Anthropic server-tool errors explicitly fall
  back instead of failing to iterate an error object.
- **`openai` still uses `OPENAI_API_KEY` and the public API**, now requesting full
  search sources in addition to answer citations. Its auth/routing is unchanged.
  `web_fetch` remains the local HTTP
  fetcher for ChatGPT; it is not a ChatGPT browser fetch.
- Requests consume the ChatGPT/Codex subscription's applicable usage allowance.
  Model/tool availability and account limits still apply. No public OpenAI API key is used.

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
`details.method === "native"`; a successful DuckDuckGo fallback fails the test.
The test requires search to be enabled in the extension configuration.

On this machine the fork has been tested with Pi 0.85.1 and the user's selected
`gpt-6-astra` model. Native web search and source citations were returned successfully.
The initial `gpt-5.4` probe was rejected as unsupported for this account, which is
why the backend defaults to the selected model instead of assuming a fixed model name.
A search override is subject to the same account/model/tool availability limits;
an unregistered override or rejected request explicitly falls back to DuckDuckGo,
without silently retrying the conversation model.

For development on this machine, the peer packages in `node_modules` are symlinked
to the installed Pi host. `undici` is installed locally and locked in `package-lock.json`.
These local dependency symlinks are ignored by Git.

## Rollback

Replace the local path in `~/.pi/agent/settings.json` with `"npm:pi-native-search"`,
then `/reload` or restart Pi. The original npm package is left untouched.
No credential migration or restoration is necessary.

## Changed files

- `extensions/chatgpt-search.ts`: OAuth-resolved Codex request, proxy and SSE handling;
  returns structured search results without changing stream completion safeguards.
- `extensions/search-result.ts`: shared result types, provider response parsers,
  source normalization/limits and source-aware output formatting. Inspired by
  `emilsvennesson/opencode-websearch` at commit `775eac4`; keeps this fork's
  stricter Codex SSE validation and adds Google grounding support.
- `extensions/index.ts`: provider entry, dispatch, auth/status UI, output limits and
  compatibility with the current Pi tool-result types/error signaling.
- `providers.yaml`: descriptive provider entry (runtime uses the map in `index.ts`).
- `tests/`: isolated request/parser/routing tests and an opt-in live tool test.
  `search-result.test.ts` covers extraction, malformed metadata and budgets;
  `api-sources.test.ts` covers API-only weather SSE, mixed/unknown source types,
  metadata/output bounds, tool propagation, rendering and fallback isolation.
  `search-sources.test.ts` checks registered tool output for all five supported
  native LLM backends (Codex uses a network-disabled Undici mock).
- `package.json`, `package-lock.json`: current host peers and Undici dependency.
