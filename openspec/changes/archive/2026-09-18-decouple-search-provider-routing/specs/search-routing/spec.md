## Purpose

Provide independent, predictable web search routing with ordered fallback and accurate attribution of the backend that produced each result.

## ADDED Requirements

### Requirement: Ordered search targets
For an enabled search with valid configuration, the system SHALL consider targets in this order: the globally selected search backend; the active conversation LLM provider and exact current model if that backend supports search; authenticated non-LLM search backends; DuckDuckGo. A global LLM target MUST specify a model. Missing or whitespace-only model selection SHALL skip the global tier, not borrow a conversation model or SDK default. Non-LLM targets SHALL NOT require a model. Other authenticated LLM providers SHALL NOT be automatically selected.

#### Scenario: Global target wins across providers
- **WHEN** the conversation uses DeepSeek and a usable registered OpenAI model is globally selected for search
- **THEN** search uses the selected OpenAI model without changing the conversation model

#### Scenario: Missing global model falls through
- **WHEN** a global LLM backend has no explicit model and the active conversation model supports search
- **THEN** the active provider and exact conversation model are selected through the second tier

#### Scenario: Active Claude Bridge model
- **WHEN** Claude Bridge is selected through the active conversation tier
- **THEN** its exact conversation model is used rather than an implicit SDK default

#### Scenario: Authenticated non-LLM service precedes DDG
- **WHEN** neither LLM tier is usable and ZAI MCP credentials are configured
- **THEN** ZAI MCP is selected before DuckDuckGo regardless of the conversation provider

#### Scenario: Default unauthenticated fallback
- **WHEN** no earlier target is usable, including when there is no active conversation model
- **THEN** DuckDuckGo is attempted without authentication or explicit enablement

#### Scenario: Explicit non-LLM target
- **WHEN** DuckDuckGo or usable ZAI MCP is globally selected
- **THEN** that backend is selected in the first tier without a model

### Requirement: Continue after backend failures
The system SHALL continue to the next distinct eligible target after an authentication failure, unsupported-model response, rate limit, timeout, network failure, or other backend execution error. Targets SHALL be deduplicated by backend and model identity; non-LLM targets SHALL be deduplicated by backend. Missing credentials SHALL skip credential-dependent targets. Exhaustion SHALL produce a tool error, never a fabricated successful empty result. A successful response with no search results SHALL be terminal success.

#### Scenario: Global request fails
- **WHEN** the global target fails and the active model is a distinct eligible target
- **THEN** the active model is attempted before authenticated non-LLM backends and DuckDuckGo

#### Scenario: Duplicate target is attempted once
- **WHEN** the global and active targets have the same provider and model and their request fails
- **THEN** the second occurrence is skipped and fallback continues

#### Scenario: Different models on the same provider
- **WHEN** global and active targets share a provider but have different model IDs
- **THEN** failure of the global target does not prevent trying the active target

#### Scenario: Final backend fails
- **WHEN** no earlier target succeeds and DuckDuckGo fails
- **THEN** search returns a tool error explaining chain exhaustion with sanitized failure reasons

#### Scenario: Legitimate empty result
- **WHEN** a backend successfully returns no search results
- **THEN** search reports that outcome without starting another backend request

### Requirement: Cancellation stops the chain
The system MUST propagate cancellation and MUST NOT initiate further backend requests after cancellation, including cancellation during credential resolution or between attempts.

#### Scenario: Cancellation during a failing request
- **WHEN** the active request terminates because the caller cancelled
- **THEN** search terminates as cancelled without contacting a fallback backend

### Requirement: Target isolation and truthful provenance
Each attempt MUST use its selected backend/model and that backend's authentication and endpoint policy, never unrelated conversation-provider credentials or endpoints. Successful results SHALL identify the actual backend, model when applicable, and selection tier. Earlier failures and selection skips SHALL be available as sanitized diagnostics. Results SHALL contain only the successful attempt's content and structured sources, within existing output limits.

#### Scenario: Cross-provider Codex search
- **WHEN** the conversation is on another provider and a registered Codex search model is selected
- **THEN** Codex authentication, headers, and endpoint are resolved for that selected model

#### Scenario: DDG succeeds after an LLM failure
- **WHEN** DuckDuckGo produces the final result after an LLM attempt fails
- **THEN** result metadata identifies DuckDuckGo with no successful LLM model, reports the earlier failure separately, and excludes partial sources from failed attempts
