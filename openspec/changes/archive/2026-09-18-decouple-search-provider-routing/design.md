## Context

See proposal.md for motivation and the three capability specs for acceptance behavior. This design is necessary because target selection, credential handling, configuration migration, UI state, and request execution change together.

Observed implementation:
- `extensions/index.ts` owns configuration, a registry mixing supported backends and unrelated conversation providers, backend functions, `doSearch`, settings, status, and tool registration.
- `doSearch` catches native errors and immediately invokes DDG; it cannot express a multi-target chain. The caller derives the endpoint from the conversation model.
- `extensions/search-model.ts` selects per-provider overrides or a session model, with a Claude Bridge SDK-default exception.
- Codex already accepts an explicit registered target model and resolves target-specific auth/headers/endpoints. Other backend functions have existing provider-specific credential and endpoint policies.
- Fetch uses Claude Bridge for bridge conversations, otherwise `httpFetch`.
- `loadConfig` accepts unchecked JSON. Existing tests isolate the agent directory, mock network requests, and exercise tool registration. `providers.yaml` is documentation only and currently disagrees with runtime capabilities.

## Goals / Non-Goals

**Goals:**
- Make selection deterministic and testable without network access; keep credentials out of persistent config and diagnostics.
- Use the same validated target plan for UI preview and execution, while acknowledging that authentication or search support can still fail at runtime.
- Keep backend protocol/parsing changes minimal and preserve Codex-specific transport protections.

**Non-Goals:**
- New search services, custom provider alias discovery, provider-wide authentication redesign, browser rendering, article extraction libraries, or configurable fallback ordering.
- Guaranteeing every registered LLM model supports its provider's search API.
- Retaining old override semantics or Claude Bridge fetch compatibility.

## Decisions

### 1. Registry describes search backends, not conversation providers

Introduce a small search-backend registry (proposed `extensions/search-providers.ts`) containing backend ID, label, kind (`llm` or `non-llm`), and authentication mode. LLM entries are Google, OpenAI, Codex, xAI, Anthropic, and Claude Bridge. Non-LLM entries are ZAI MCP and `duckduckgo`. ZAI's company also supplies models, but this adapter does not invoke one and belongs in tier three unless explicitly pinned.

Remove inert DeepSeek/OpenRouter/etc. entries from selectable search configuration. They remain valid conversation providers and require no plugin configuration. Replace fetch capability flags with a single HTTP fetch path. Keep `providers.yaml` synchronized as documentation, not runtime input.

Alternative: retain the old all-provider registry with more flags. Rejected because it preserves the coupling the change removes.

### 2. Validated global configuration replaces per-provider overrides

Proposed persisted shape (field names are design choices):

```json
{
  "enabled": true,
  "searchEnabled": true,
  "fetchEnabled": true,
  "searchProvider": "openai-codex",
  "searchModel": "REGISTERED_MODEL_ID"
}
```

Omitted `searchProvider` means automatic selection. Omitted or trimmed-empty `searchModel` skips a pinned LLM tier. Explicit model strings are trimmed and validated using the selected provider's registry entry, not any provider with a matching model ID. Only Pi-registered models are accepted for pinned LLM targets. A nonempty model without a provider is a configuration error. Non-LLM targets ignore a string model value, and the settings UI clears it on backend changes; non-string model values remain type errors.

Extract parsing/defaulting/serialization into proposed `extensions/search-config.ts`. Keep global defaults for missing fields, but return explicit diagnostics for malformed JSON, invalid types, or invalid new fields rather than silently replacing bad configuration. Represent load/validation errors as state rather than crashing extension initialization, so settings remain repairable. Search-target errors block search but not valid fetch settings; an unreadable or structurally invalid config blocks execution rather than guessing enablement.

Ignore legacy `providerOverrides` entirely, preserve global switches, and surface a migration notice once per distinct loaded legacy configuration per session. Loading never writes. An explicit settings save emits the new shape and removes ignored legacy fields. Do not infer which old model the user wanted globally.

Alternative: migrate the first override into a global target. Rejected because this invents user intent and changes routing unpredictably.

### 3. Build a target plan before dispatch

Replace the single-model resolver with a pure candidate planner (proposed `extensions/search-routing.ts`; retire or repurpose `search-model.ts`). Inputs are validated config, the current model, the registered-model catalog, and backend readiness facts. Output includes ordered candidates and selection-skip diagnostics.

Each LLM candidate carries its backend, exact model object/ID, and tier (`configured`, `session`, `fallback`). Non-LLM candidates carry no model. Deduplicate by backend/model ID, or backend alone for non-LLM. With this change's backend set, the fixed non-LLM fallback order is ZAI then DDG. An explicitly pinned DDG remains first and is not retried later if it fails. Do not auto-select unused authenticated LLMs.

Construct a fresh plan for each search invocation using the current conversation context and loaded settings. Preserve existing configuration refresh events and `/reload`; saving in settings updates the loaded configuration immediately. Preview planning does not refresh OAuth or issue network probes.

Alternative: nested conditionals in `doSearch`. Rejected because display and execution would continue to duplicate selection logic and drift.

### 4. Separate backend attempts from chain orchestration

Backend adapters perform one target attempt and throw on failure; they do not invoke DDG themselves. An outer orchestrator walks the deduplicated plan, checks cancellation before and after asynchronous work, records sanitized failures, and continues. The first successful response, including a valid empty result, ends the chain. Exhaustion throws a tool error summarizing failures; disabled-tool behavior remains a separate guard.

Normalize Claude Bridge unsuccessful SDK termination as an error rather than returning an empty-success placeholder. Audit existing adapter error envelopes as part of this boundary so explicit backend errors do not masquerade as no results. Keep existing successful-output formatting/parsers otherwise unchanged.

Known absent API keys skip candidates. Codex readiness uses the selected registered model, while actual auth resolution remains inside its existing backend. Claude Bridge has no reliable synchronous credential probe: mark readiness as deferred, invoke its SDK when selected, and let failure advance the chain. Do not describe deferred readiness as verified credentials.

Alternative: fail immediately, or always jump directly to DDG. Both conflict with the confirmed continue-through-priority-chain policy.

### 5. Resolve target identity before credentials and endpoints

Codex receives the target model directly, not `ctx.model` selected via a model-source heuristic. It retains Pi-managed refresh, headers, proxy behavior, deadline, and endpoint handling. API-key backends retain their existing environment/auth-file policy; this change does not add new auth formats. Google/OpenAI/xAI retain their current fixed endpoint policy. Anthropic receives the selected target model's base URL rather than the unrelated conversation model's base URL. ZAI retains its MCP endpoint. Claude Bridge receives an explicit model in both configured and session tiers.

Alternative: pass the conversation context's endpoint to every backend. Rejected because a pinned cross-provider request could send credentials to the wrong service.

### 6. Provenance separates result identity from attempt history

Keep `details.query`, `sources`, `apiSources`, and `method`, but make `details.provider` identify the successful backend, including `duckduckgo`. Set `searchModel` and `searchModelSource` only for the successful LLM target. Add selection tier and bounded, sanitized attempt/skip diagnostics; earlier model IDs belong in that history, not in DDG's successful-result fields. Preserve source isolation and `formatSearchResult` limits. Render a concise degradation notice when an earlier request failed; expose selection skips without overwhelming normal successful output.

The status bar and `/search config` show the planned target, not an assertion that it will succeed. Progress updates identify the actual current attempt. Error messages omit tokens, headers, and raw credential-bearing URLs; prefer backend/status/reason summaries over unfiltered response bodies.

Alternative: preserve the old attempted-provider metadata even after DDG succeeds. Rejected because it becomes more misleading with a multi-backend chain. Document this metadata compatibility change.

### 7. UI configures the search capability; fetch is independent

Keep `/search on`, `/search off`, global toggles, `/search config`, and `/search providers`. Replace provider-specific toggles with automatic/backend selection plus registered-model selection for LLMs. Display backend choices even when credentials are missing, with truthful readiness labels, allowing users to configure before login. Changing backend clears stale model selection. No free-form model entry is offered.

For fetch, reuse `httpFetch` extraction and truncation as-is, remove `claudeBridgeFetch`, and report `method: local` without a misleading conversation-provider identity. Do not load the bridge SDK or search credentials for fetch. Global switches alone govern activation, including sessions with no selected model.

Alternative: keep a native fetch optimization. Rejected by the user's explicit request for one global implementation.

## Risks / Trade-offs

- [Fallback can increase latency and send a query to multiple services] -> Keep a finite, deduplicated chain, preserve cancellation and existing timeouts, and document the confirmed fallback policy. A new chain-wide timeout is out of scope.
- [Registered does not mean search-capable] -> Label the picker accordingly and handle backend rejection through normal fallback rather than maintain an inaccurate static model allowlist.
- [Claude Bridge may accept different model naming than Pi] -> Pass the exact selected ID as required, preserve visible errors, and test SDK argument forwarding; do not silently substitute a model.
- [Legacy override removal changes behavior] -> Preserve global disablement, warn, never auto-write on load, and document a new explicit configuration example.
- [Unified HTTP extraction is less capable than SDK fetch] -> Explicitly document no JavaScript rendering or semantic extraction in this scope.
- [Source or credential leakage across attempts] -> Retain only successful sources, resolve target-scoped request inputs, sanitize diagnostics, and test cross-provider endpoint isolation.

## Migration Plan

1. Implement configuration normalization, registry, planner, orchestrator, settings, and unified fetch with isolated tests before rollout.
2. Replace old behavior assertions rather than retaining incompatible override/SDK-fetch expectations; preserve Codex transport and formatting regression coverage.
3. Update usage/config examples, metadata compatibility notes, registry documentation, and fork notes. Advise users to back up `search-config.json` before their first settings save.
4. Deploy by reloading the local extension. Legacy configuration is interpreted in memory with a notice; only an explicit save writes the new representation.
5. Roll back by restoring the previous extension revision and backed-up configuration. No credential or external data migration is required.
