# pi-native-search

> **Local ChatGPT fork:** Adds `openai-codex` (OpenAI ChatGPT subscription) search,
> reusing Pi's OAuth login and token refresh. Targets Pi `@earendil-works/*` 0.85.1+.
> See [LOCAL-FORK.md](LOCAL-FORK.md) for local installation, tests, and rollback.
> The npm install command below installs upstream, **not this fork**.

[![npm version](https://img.shields.io/npm/v/pi-native-search)](https://www.npmjs.com/package/pi-native-search)
[![license](https://img.shields.io/npm/l/pi-native-search)](LICENSE)

A [pi](https://github.com/badlogic/pi-mono) extension that adds `web_search` and `web_fetch` tools, routing each call through the **active provider's own native search backend** when available, and falling back to DuckDuckGo HTML scraping otherwise.

The headline feature: when you're using your **Claude Code subscription via [pi-claude-bridge](https://www.npmjs.com/package/pi-claude-bridge)**, search and fetch are delegated to Claude Code's actual `WebSearch` and `WebFetch` tools — the same ones you get in Zed, Claude Desktop, or the Claude Code CLI. No separate API key required.

## Why

Pi ships with provider plumbing but no built-in search. Most extensions either (a) hard-code DuckDuckGo, or (b) require you to wire up your own paid search API. This extension uses what each provider already gives you for free.

| Provider | Native backend | Auth source |
|---|---|---|
| **claude-bridge** (Claude Code subscription) | Claude Code's `WebSearch` / `WebFetch` (via `@anthropic-ai/claude-agent-sdk`) | Your `claude` CLI login |
| **zai** (GLM) | ZAI MCP `web_search_prime` (included in Coding Plans, *not* the separate paid Web Search API) | `ZAI_API_KEY` |
| **anthropic** | `web_search_20250305` server tool | `ANTHROPIC_API_KEY` |
| **google** (Gemini) | `google_search` grounding tool | `GEMINI_API_KEY` |
| **openai** | Responses API `web_search` tool | `OPENAI_API_KEY` |
| **openai-codex** (OpenAI ChatGPT subscription) | Codex Responses `web_search` tool | Pi's `/login openai-codex` OAuth credentials (auto-refreshed) |
| **xai** (Grok) | Responses API `web_search` tool | `XAI_API_KEY` |
| All other providers | DuckDuckGo HTML fallback | none |

`web_fetch` uses the same routing — currently only `claude-bridge` has a native backend; everything else uses a built-in HTTP fetcher.

## Install

```bash
pi install npm:pi-native-search
```

The extension auto-detects your active provider via pi's `ctx.model.provider` and picks the right backend on every call.

## Usage

Once installed, two tools become available to the model:

- `web_search { query }` — searches the web and returns ranked results.
- `web_fetch { url }` — fetches and returns a page's text content (truncated to 50 KB / 2000 lines).

The model decides when to use them; you don't need to do anything else. To configure or inspect the extension, use the `/search` slash command:

```
/search           # open the settings panel (configured providers only)
/search providers # show ALL providers and their capabilities
/search config    # print current config (active provider, native vs. ddg, etc.)
/search on        # enable both tools
/search off       # disable the extension entirely
```

The bottom status bar shows the active backend per call, e.g.:

```
search[search:native:SDK default,fetch:cc-sdk] # claude-bridge route
search[search:native:mcp,fetch]               # ZAI route
search[search:ddg,fetch]                      # DDG fallback
```

Configuration persists in `~/.pi/agent/search-config.json` (under `getAgentDir()` if the agent directory is customized).

### Per-provider search models

Add `model` to an existing provider override to use a different model for search,
without changing the active provider or the conversation model:

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "providerOverrides": {
    "openai-codex": { "model": "YOUR_CODEX_MODEL_ID" },
    "google": { "searchEnabled": true, "model": "YOUR_GEMINI_MODEL_ID" }
  }
}
```

- Supported LLM search backends: `google`, `openai`, `openai-codex`, `xai`,
  `anthropic`, and `claude-bridge`.
- ZAI Web Search Prime MCP and DuckDuckGo (including other providers routed to
  DuckDuckGo) **ignore** `model`. This field does not enable a new native backend.
- Missing, empty/whitespace-only, or non-string values preserve the default:
  the current session model for API/Codex backends, or the SDK default for
  Claude Bridge. Leading/trailing whitespace is trimmed.
- Only the active provider's entry is used. `web_fetch` is unaffected.
- `openai-codex` requires an exact model ID registered in Pi's model catalog.
  Authentication, headers, and base URL are resolved for that target model.
  Other API backends accept model IDs directly and keep their existing endpoint
  and credential behavior; Claude Bridge passes the ID to its SDK.
- Unknown Codex models or rejected native requests produce the existing explicit
  DuckDuckGo fallback warning. There is no retry with the conversation model;
  cancellation does not initiate fallback.
- After editing, run `/reload`. `/search config` distinguishes the session model
  from the search model; the provider list and status bar identify configured
  versus default models. Search result `details.searchModel` and
  `details.searchModelSource` record the selected native LLM model, including on
  fallback (`details.method` remains `ddg`). SDK-default and non-LLM searches omit
  these fields. Settings toggles preserve the model override.

### Structured search sources

Successful `web_search` results now include `details.sources: { title: string;
url: string }[]` and `details.apiSources: { type: "api"; name: string }[]`.
Existing query, provider, method, and search-model fields are unchanged. For example:

```json
{
  "query": "Pi documentation",
  "provider": "openai-codex",
  "method": "native",
  "sources": [{ "title": "Pi", "url": "https://pi.dev/" }],
  "apiSources": []
}
```

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
- `sources: []` means no retained URL sources, not necessarily no provenance or
  results: check `apiSources` too. Codex answers with neither type include a
  model-visible missing-metadata notice; API-only answers remain native successes.
  Collapsed tool output shows URL/API source counts, or a missing-metadata warning
  (also for historical results lacking source fields).
  Claude Bridge, ZAI and DuckDuckGo keep their existing text output and return
  both arrays empty; their text links are not parsed into metadata.
- Native failure discards any partial sources before DuckDuckGo fallback.
  Anthropic server-tool errors also trigger fallback. `web_fetch` is unchanged.

## How it works

`doSearch` in `extensions/index.ts` selects the backend from the active provider,
credentials, and search-model selection. It returns `{ text, sources, apiSources?, nativeError? }`.
The parsers and shared formatter in `extensions/search-result.ts` keep source
extraction separate from presentation. The registered tool exposes the sources in
`details` and formats/truncates the model-visible text once at the output boundary.

If the native call throws, the result is replaced by the DDG fallback with a
`> Native failed (...)` prefix. Cancellation propagates without starting fallback.

### claude-bridge specifics

When the active provider is `claude-bridge`, the extension dynamically locates `@anthropic-ai/claude-agent-sdk` (shipped inside `pi-claude-bridge`'s own `node_modules`) and spawns a one-shot `query()` with `allowedTools: ["WebSearch"]` (or `["WebFetch"]`). The result text is captured and returned as the tool output. This means:

- No extra dependency to install — reuses what `pi-claude-bridge` already brought in.
- Auth comes from your `claude` CLI login, not an API key.
- It uses your subscription, not API credits.

## Adding a new provider

The extension is structured so that adding a backend is a self-contained change. To add provider `foo`:

**1. Add an entry to the `PROVIDERS` map** at the top of `extensions/index.ts`:

```ts
foo: {
  name: "Foo Provider",
  nativeSearch: true,
  nativeFetch: false,
  envKey: "FOO_API_KEY",
},
```

**2. Implement the search function**:

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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, model }),
  });
  if (!res.ok)
    throw new Error(`Foo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  // Extract provider metadata; the tool boundary formats the Sources section.
  return {
    text: data.text || "",
    sources: normalizeSources(data.results || []),
  };
}
```

**3. Add a case to `doSearch`**:

```ts
case "foo":
  return await fooSearch(query, model, apiKey, signal);
```

For an LLM search backend, also add its provider ID to `LLM_SEARCH_PROVIDERS` in
`extensions/search-model.ts` to enable model overrides. Leave non-LLM search
backends out of that set. The settings UI and fallback handling use `PROVIDERS`.

If the provider doesn't use a standard `Bearer` API key (e.g. OAuth, MCP session, or an SDK that handles auth itself like `claude-bridge`), see `claudeBridgeSearch` for how to special-case the auth check in `hasCredentials` and `canUseNativeSearch`.

## Development

```bash
git clone https://github.com/smalibary/pi-native-search.git
cd pi-native-search
npm test
# Install the local package as described in LOCAL-FORK.md, then in pi: /reload
```

Pi loads `extensions/index.ts` and its helper modules at runtime — no build step required.

## License

MIT — see [LICENSE](LICENSE). PRs welcome, especially for new provider backends.

## Acknowledgements

- [opencode-websearch](https://github.com/emilsvennesson/opencode-websearch) — reference for structured source extraction, URL deduplication and xAI citation handling (reviewed at `775eac4`)

- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner — the host TUI agent
- [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson — provides the Claude Agent SDK that `claude-bridge` mode reuses
