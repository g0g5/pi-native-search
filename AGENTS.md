## Project Overview
Pi extension (`pi-native-search`) that adds `web_search` and `web_fetch` tools routing each request to a configured search backend (independently of the active conversation provider), written in ESM TypeScript run directly by Node's native type stripping (no build step). This checkout is a local fork adding an `openai-codex` ChatGPT-subscription backend and decoupling search routing from the conversation provider.

## Tech Stack
- Language: TypeScript (ESM, `"type": "module"`, relative imports carry `.ts` extensions)
- Runtime / Framework: Node.js `>=20.18.1` (native type stripping; `undici ^7.16.0` for HTTP), Pi extension API (`@earendil-works/pi-coding-agent` `>=0.85.1`, `@earendil-works/pi-tui`, `typebox`)
- Key Dependencies: optional peer `pi-claude-bridge`; no bundler, transpiler, test framework, or linter dependency
- Package Manager: npm

## Structural Map
```
pi-native-search/
|- package.json            # Manifest, scripts, and `pi.extensions` → ./extensions/index.ts
|- providers.yaml          # Documentation mirror of the runtime backend registry (not read at runtime; kept in sync by providers-doc.test.ts)
|- README.md               # Usage/architecture docs: routing priority, config, web_fetch, adding a backend
|- LOCAL-FORK.md           # Fork rationale, config/migration, install and rollback steps, changed-file list
|- extensions/
|  |- index.ts             # Entrypoint: search dispatch with tiered fallback, /search settings UI, web_search/web_fetch registration
|  |- search-providers.ts  # SEARCH_BACKENDS registry — backend ids, kind (llm/non-llm), auth mode, env var key
|  |- search-config.ts     # Global search/fetch config: parsing, defaults, validation, legacy handling, serialization
|  |- search-routing.ts    # Pure planner: target ordering, dedup, and skip diagnostics
|  |- search-result.ts     # Shared types, per-provider response parsers, source normalization/output formatting
|  \- chatgpt-search.ts    # openai-codex backend: OAuth Codex endpoint, SSE parsing, proxy handling, 90s deadline
|- openspec/               # Spec-driven change tracking: specs/ (current) and changes/ (proposals + archive/)
\- tests/                  # node:test suites run via Node type stripping: 13 *.test.ts plus opt-in live-chatgpt.ts
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
No build, typecheck, or lint command is configured (no tsconfig, eslint, or biome). Treat `npm test` (147 tests, ~1s) as the verification loop. `tests/providers-doc.test.ts` fails if `providers.yaml` drifts from `SEARCH_BACKENDS`, so update both together.

### Workflows
[No content yet.]

## Notes
- ESM-only and loaded in place: edit `extensions/*.ts` and run `/reload` in Pi; there is nothing to compile or install after a change.
- Keep only one copy of this package enabled in Pi's `packages` config (e.g. the local path) — a local path plus the published `npm:pi-native-search` yields duplicate `web_search`/`web_fetch` tools.
- `extensions/search-providers.ts` is the runtime source of truth for selectable backends; `providers.yaml` only documents it. Conversation providers without an implemented adapter are deliberately absent from both.
- Global config keys are `searchEnabled`, `fetchEnabled`, `searchProvider`, and `searchModel` (plus legacy `enabled`); legacy `providerOverrides` values are ignored entirely, never migrated.
- Tests need Node with native type stripping (22.18+/24) and use `node:test`; they point the config dir (honoring `PI_CODING_AGENT_DIR`) at a temp directory so real `auth.json` is never read, and they mock all network access.
- `tests/live-chatgpt.ts` is excluded from `npm test` on purpose — it requires a live ChatGPT subscription and network access.
- Imports were migrated from upstream `@mariozechner/*` to `@earendil-works/*`; keep new code on the `@earendil-works` packages.
- `node_modules` peer packages are gitignored symlinks into the global Pi install; only `undici` is a real local dependency.
- Specs and change proposals live in `openspec/`; the `openspec` CLI and the `.pi/skills/openspec-*` skills (with `.pi/prompts/opsx-*.md`) drive the propose/apply/archive flow. `.pi/` is gitignored, so skills are local-machine state, not committed.
- Git: `origin` is the personal fork (`g0g5/pi-native-search`), `upstream` is the original (`smalibary/pi-native-search`). Work on `main`; the earlier `local/openai-chatgpt` scratch branch is behind `main`, since the ChatGPT-subscription and provider-decoupling work has landed there.
