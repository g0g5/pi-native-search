## Project Overview
Pi extension (`pi-native-search`) that adds `web_search` and `web_fetch` tools routing each request to the active provider's native search backend, written in ESM TypeScript run directly by Node's native type stripping (no build step). This checkout is a local fork adding an `openai-codex` ChatGPT-subscription backend.

## Tech Stack
- Language: TypeScript (ESM, `"type": "module"`, relative imports carry `.ts` extensions)
- Runtime / Framework: Node.js `>=20.18.1` (native type stripping; `undici ^7.16.0` for HTTP), Pi extension API (`@earendil-works/pi-coding-agent` `>=0.85.1`, `@earendil-works/pi-tui`, `typebox`)
- Key Dependencies: optional peer `pi-claude-bridge`; no bundler, transpiler, test framework, or linter dependency
- Package Manager: npm

## Structural Map
```
pi-native-search/
|- package.json          # Manifest; `pi.extensions` points at ./extensions/index.ts; test scripts live here
|- providers.yaml        # Descriptive provider capability registry (documentation only — runtime uses PROVIDERS in index.ts)
|- README.md             # Upstream usage and architecture docs
|- LOCAL-FORK.md         # Fork rationale, install/rollback steps, changed-file list
|- extensions/
|  |- index.ts           # Entrypoint: PROVIDERS registry, doSearch dispatcher, search config, /search command, web_search/web_fetch tool registration
|  |- chatgpt-search.ts  # openai-codex backend: OAuth Codex endpoint, SSE parsing, proxy handling, 90s deadline
|  |- search-result.ts   # Shared types, per-provider response parsers, source normalization/output formatter
|  \- search-model.ts    # LLM_SEARCH_PROVIDERS set and per-provider search-model override resolution
\- tests/                # node:test suites run via Node type stripping
   |- routing.test.ts, model-overrides.test.ts, search-model.test.ts      # Config loading and search-model selection
   |- chatgpt-search.test.ts, search-result.test.ts                       # Codex SSE parsing, result formatting/truncation
   |- api-sources.test.ts, search-sources.test.ts                         # Registered-tool output and provider source extraction
   \- live-chatgpt.ts    # Opt-in live integration check; intentionally NOT matched by `*.test.ts`
```

## Development Guide
### Commands
```
# Install dependencies (Node >=20.18.1; peers resolve from the global Pi install)
npm install --ignore-scripts

# Run all unit tests (node:test + native TS stripping)
npm test

# Run a single test file
node --experimental-strip-types --test tests/routing.test.ts

# Opt-in live integration check (real openai-codex OAuth + network; fails if it falls back to DuckDuckGo)
npm run test:live
npm run test:live -- YOUR_MODEL_ID
```
No build, typecheck, or lint command is configured (no tsconfig, eslint, or biome). Treat `npm test` (84 tests) as the verification loop.

### Workflows
[No content yet.]

## Notes
- ESM-only and loaded in place: edit `extensions/*.ts` and run `/reload` in Pi; there is nothing to compile or install after a change.
- Keep only one copy of this package enabled in Pi's `packages` config (e.g. the local path) — a local path plus the published `npm:pi-native-search` yields duplicate `web_search`/`web_fetch` tools.
- `providers.yaml` must stay in sync with the `PROVIDERS` map in `extensions/index.ts`; the YAML is not read at runtime.
- Tests need Node with native type stripping (22.18+/24) and use `node:test`; they point the config dir (honoring `PI_CODING_AGENT_DIR`) at a temp directory so real `auth.json` is never read.
- `tests/live-chatgpt.ts` is excluded from `npm test` on purpose — it requires a live ChatGPT subscription and network access.
- Imports were migrated from upstream `@mariozechner/*` to `@earendil-works/*`; keep new code on the `@earendil-works` packages.
- `node_modules` peer packages are gitignored symlinks into the global Pi install; only `undici` is a real local dependency.
- Git: work on `main`; the fork work lives on branch `local/openai-chatgpt` with an `upstream` remote for syncing.
