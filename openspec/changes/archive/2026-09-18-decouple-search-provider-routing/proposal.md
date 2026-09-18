## Why

Search currently follows the conversation provider, mixes backend selection with DuckDuckGo error recovery, and exposes provider-specific enablement switches even for providers without search capabilities. Users need an independent global search target with predictable fallback while retaining the active model as a zero-configuration option.

## What Changes

- Select search targets in order: globally configured backend; active conversation LLM provider/model when search is supported; authenticated non-LLM search backends (currently ZAI MCP); unauthenticated DuckDuckGo.
- Require an explicit model for a globally configured LLM target. A missing model skips that tier; global model IDs must be registered for that provider in Pi.
- Continue through remaining targets after request failures, deduplicate targets, stop on cancellation, and report failure when the chain is exhausted.
- **BREAKING**: Remove conversation-provider search/fetch enablement and model overrides. Preserve global switches, ignore legacy `providerOverrides`, and notify users to reconfigure their search target.
- Add global backend/model selection to the configuration file and `/search` settings, with consistent validation and observable routing diagnostics. Invalid configuration produces a configuration error rather than silent fallback.
- **BREAKING**: Use the existing direct HTTP implementation for all `web_fetch` requests and remove Claude Bridge-specific fetching. Claude Bridge search remains supported.

## Capabilities

### New Capabilities

- `search-routing`: Independent search target selection, ordered execution fallback, cancellation, and truthful result provenance.
- `search-configuration`: Global settings, registered-model selection, validation, legacy configuration handling, and settings/status presentation.
- `web-fetch`: Provider-independent direct HTTP page retrieval with existing extraction and output limits.

### Modified Capabilities

None. The project has no existing durable OpenSpec capability specs.

## Impact

- Refactor `extensions/index.ts` configuration, provider registry, dispatch, command UI, status reporting, and fetch execution; replace the current assumptions in `extensions/search-model.ts` with explicit target resolution.
- Preserve backend response parsing and Codex credential/endpoint handling in `extensions/chatgpt-search.ts` and `extensions/search-result.ts`.
- Update routing, model-selection, UI/configuration, source-provenance, and fetch tests; retain isolated credentials and mocked network behavior.
- Update `README.md`, `LOCAL-FORK.md`, and `providers.yaml` to describe actual supported search backends and unified fetching.
- No new search services, browser rendering, extraction dependency, or credential storage system is introduced. Reference inspiration: https://github.com/emilsvennesson/opencode-websearch (selection separated from execution, not its exact fallback policy).
