## 1. Backend registry and configuration

- [x] 1.1 Extract the implemented search-backend registry from `extensions/index.ts`, classify ZAI/DDG as non-LLM, and remove inert conversation-provider/fetch capability entries; verify registry tests cover every existing search adapter and exclude unsupported providers from selectable backends.
- [x] 1.2 Add validated global config parsing/defaulting/serialization for `searchProvider` and `searchModel`, preserving global switches; verify tests for absent/partial config, malformed JSON, wrong types, unknown backends, model without provider, and non-LLM model handling.
- [x] 1.3 Ignore legacy `providerOverrides`, emit a migration notice without load-time writes, and serialize only the new shape on explicit save; verify tests preserve global disablement, discard legacy models/toggles, and observe no file mutation on read.
- [x] 1.4 Validate pinned LLM models against the selected provider's Pi registry entries while treating absent/blank models as a skipped tier; verify registered, unregistered, wrong-provider, and missing-model cases with no network requests on configuration errors.

## 2. Candidate planning and request execution

- [x] 2.1 Replace or repurpose `extensions/search-model.ts` with a pure ordered target planner using global target, active LLM model, authenticated ZAI, and DDG; verify a table-driven routing suite including no active model, unsupported conversation provider, non-LLM pinning, and no automatic use of other authenticated LLMs.
- [x] 2.2 Deduplicate targets by backend/model identity and expose selection reasons and skip diagnostics; verify identical targets run once, distinct models remain candidates, and pinned ZAI/DDG are not repeated in fallback tiers.
- [x] 2.3 Refactor backend dispatch to accept an explicit target with target-scoped inputs; verify cross-provider Codex auth/header/endpoint resolution, Anthropic target base URL isolation, fixed API endpoint preservation, and exact Claude Bridge model forwarding.
- [x] 2.4 Move fallback out of individual adapters into sequential orchestration, normalize explicit backend error envelopes and unsuccessful Claude SDK termination as errors, and preserve legitimate empty successes; verify mocked auth, unsupported model, rate-limit, timeout, SDK failure, and DDG exhaustion cases in priority order.
- [x] 2.5 Enforce cancellation before/after credential resolution and backend attempts; verify pre-aborted, in-flight, and between-attempt cancellation starts no later request and retains existing Codex cancellation coverage.
- [x] 2.6 Separate successful target metadata from bounded sanitized attempt history and isolate successful sources; verify DDG results contain no successful LLM model, failures leak no credentials, failed sources are discarded, and existing formatting/truncation tests pass.

## 3. Settings, status, and enablement

- [x] 3.1 Replace provider-specific settings toggles with global backend and Pi-registered model selection, including automatic/unset choices and stale-model clearing; verify UI tests disallow arbitrary model input and do not mutate the conversation model.
- [x] 3.2 Make tool activation depend only on global switches, keep search validation errors repairable, and preserve valid fetch operation when only search target configuration is invalid; verify unsupported/no-model sessions, global disabling, `/search on|off`, and error-state tests.
- [x] 3.3 Update `/search providers`, `/search config`, status, and attempt progress to distinguish session, planned target, actual attempt, and deferred credential readiness; verify display tests and existing configuration-refresh event tests.

## 4. Unified web fetch

- [x] 4.1 Remove `claudeBridgeFetch` and route every enabled fetch through the existing HTTP implementation without search credentials or backend selection; verify Claude Bridge, Codex, unsupported-provider, and no-active-model sessions all make only the page request.
- [x] 4.2 Preserve JSON/plain-text/HTML handling, output truncation, HTTP errors, and cancellation with truthful local-method metadata; verify dedicated fetch tests cover script/style stripping, both output limits, disabled fetch, failed responses, and no fallback on cancellation.

## 5. Documentation and integration verification

- [x] 5.1 Update `README.md`, `LOCAL-FORK.md`, and `providers.yaml` for the new configuration, backend priority, runtime fallback, registered-model constraint, migration/rollback, provenance changes, and unified HTTP fetch; verify documentation examples match parser tests and the documented registry matches runtime backends.
- [x] 5.2 Replace obsolete override/SDK-default/native-fetch assertions in existing tests and adapt live-check configuration assumptions without running authenticated checks by default; verify `npm test` passes with isolated auth/config directories and mocked network requests.
- [x] 5.3 Exercise the integrated priority chain and settings persistence in mocked tool-level tests, including global failure to active success, complete fallback to DDG, total failure, invalid configuration with zero requests, and fetch independence; verify each of the three capability specs has corresponding acceptance coverage.
