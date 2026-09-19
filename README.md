# pi-native-search

A [Pi](https://pi.dev/) extension that adds `web_search` and `web_fetch` tools.

> **About this fork:**
> - Supports `openai-codex` as a search backend using your ChatGPT subscription.
> - Lets you choose a global preferred search backend and model, independently of your conversation model.
>
> Based on [smalibary/pi-native-search](https://github.com/smalibary/pi-native-search).
> The npm package `pi-native-search` installs upstream, **not this fork**.

## Install

Requires **Pi 0.85.1+**. Node **22.18+ or 24** is recommended.

```bash
git clone https://github.com/g0g5/pi-native-search.git
cd pi-native-search
npm install --ignore-scripts
```

Add the checkout's absolute path to the `packages` array in
`~/.pi/agent/settings.json`:

```json
{
  "packages": ["/absolute/path/to/pi-native-search"]
}
```

Keep your other settings and packages. If `npm:pi-native-search` is already
listed, replace it with the local path. Enable only one copy to avoid duplicate
tools and commands.

Restart Pi or run `/reload`. The local checkout is loaded in place;
`pi update` will not update it. To update this fork, pull the latest changes,
run `npm install --ignore-scripts`, and reload Pi.

## Quick start

Ask Pi to search the web or read a URL. The model can use:

- **`web_search`** — searches the web, with automatic fallback if a backend fails.
- **`web_fetch`** — reads a page directly over HTTP, without an LLM or search credentials.

To use your ChatGPT subscription for search:

1. Log in with `/login openai-codex` if you haven't already. Existing Pi login is reused.
2. Open `/search`, choose `openai-codex`, and select a model available in Pi.
3. Ask a question that needs a web search.

This changes only the search backend, not your conversation model. Search uses
your subscription's applicable allowance; account limits and model/tool
availability still apply. No OpenAI API key is needed for `openai-codex`.
The separate `openai` backend uses the public API and an API key.

## Settings and commands

Use `/search` to choose a preferred backend and model, or select **automatic**
to follow your conversation model when supported. You can also enable or disable
search and fetch separately. Settings apply globally across conversation providers.

| Command | Purpose |
|---|---|
| `/search` | Open settings |
| `/search providers` | List supported search backends and authentication status |
| `/search config` | Inspect settings and the planned fallback order |
| `/search on` | Enable both tools |
| `/search off` | Disable both tools |

The status bar shows the planned search backend. During a search, progress
updates show the backend actually being tried; it may change if a fallback is needed.

## Supported backends

| Backend | Authentication |
|---|---|
| **openai-codex** — ChatGPT subscription | Pi's `/login openai-codex` |
| **claude-bridge** — Claude Code subscription | Install `pi-claude-bridge` and log in to the `claude` CLI |
| **anthropic** — Claude API | `ANTHROPIC_API_KEY` |
| **google** — Gemini | `GEMINI_API_KEY` |
| **openai** — OpenAI API | `OPENAI_API_KEY` |
| **xai** — Grok | `XAI_API_KEY` |
| **zai** — Web Search Prime | `ZAI_API_KEY` (included in Coding Plans) |
| **duckduckgo** | None |

When choosing a preferred LLM backend, also select a model registered for that
provider in Pi. ZAI and DuckDuckGo don't need a model.

You can keep using any conversation provider, including DeepSeek, OpenRouter,
or Mistral, even if it isn't supported as a search backend.

## Search fallback order

Search tries these options in order:

1. Your global preferred backend and model, if configured.
2. Your active conversation model, if its provider supports search.
3. ZAI Web Search Prime, if authenticated.
4. DuckDuckGo, which needs no login.

Duplicate backend/model combinations and backends without credentials are
skipped. If a preferred LLM backend has no model selected, its step is skipped.
Other logged-in LLM providers are not automatically tried.

If a request fails—for example due to a rate limit or unsupported model—search
moves to the next option and reports the fallback. A successful search with no
results does not trigger fallback. If every option fails, the tool reports an
error. Cancelling stops the search rather than trying another backend.

## Results and page fetching

Search results show source links when supplied by the backend. Some providers
return data sources without accessible URLs; these are labeled accordingly.
A missing-source warning means source metadata wasn't supplied, not that the
answer was independently verified.

`web_fetch` returns readable text from HTML, plain text, or formatted JSON.
It does not use a browser or execute JavaScript, so pages that require client-side
rendering may not return useful content. Fetching works the same way regardless
of your conversation model or search backend.

Search and fetch output is limited to approximately **50 KB / 2,000 lines**.

## Configuration file

Settings are saved in `~/.pi/agent/search-config.json` (or your customized Pi
agent directory). Prefer `/search` for editing, or use this example:

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "searchProvider": "openai-codex",
  "searchModel": "YOUR_REGISTERED_MODEL_ID"
}
```

- Tools are enabled by default.
- Omit `searchProvider` and `searchModel` for automatic selection.
- For an LLM backend, use an exact model ID registered for that provider in Pi.
- Credentials are not stored in this file.

### Troubleshooting

- **Configuration error:** run `/search config`, then use `/search` to correct
  the backend/model selection or save a valid configuration. An invalid search
  target blocks search only; a malformed configuration file can block both tools.
- **Unexpected fallback:** check `/search providers` for authentication and
  `/search config` for the planned order. A model listed in Pi may still lack
  search support or be unavailable to your account.
- **ChatGPT connection issues:** check your Pi login and network/proxy settings.
  The ChatGPT backend supports `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.

### Upgrading from per-provider settings

Legacy `providerOverrides` settings are no longer used. Global enable/disable
settings are preserved, but you need to choose your preferred backend and model
again in `/search`.

Back up `search-config.json` before saving settings if you may want to roll back.
Saving removes the legacy fields. To return to a previous revision, restore that
revision and your configuration backup. To return to upstream, replace the local
package path with `npm:pi-native-search` and reload Pi. No credential migration is
needed.

## Development

```bash
npm test                  # offline tests; no real credentials or network access
npm run test:live         # optional live ChatGPT search; uses your subscription
npm run test:live -- YOUR_MODEL_ID
```

The live check requires a Pi ChatGPT login and search enabled. Use automatic
search selection for this check; it reads your real search configuration and
fails if search falls back to another backend.

There is no build step. After editing the extension, run `/reload` in Pi.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [smalibary/pi-native-search](https://github.com/smalibary/pi-native-search) — the upstream project
- [Pi](https://pi.dev/) by Mario Zechner — the host agent
- [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson — Claude subscription search support
- [opencode-websearch](https://github.com/emilsvennesson/opencode-websearch) — inspiration for search routing and source handling
