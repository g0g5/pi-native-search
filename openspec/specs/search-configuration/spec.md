# search-configuration Specification

## Purpose

Let users configure search independently of their conversation provider while preserving global tool controls and exposing valid, understandable routing choices.

## Requirements

### Requirement: Global configuration and tool enablement
The extension SHALL persist global extension, search, and fetch switches and an optional global search backend/model in the agent-directory search configuration file. Missing fields SHALL receive defaults: all global switches enabled and no pinned search target. Tool enablement SHALL depend only on global switches, not the conversation provider or its search capability. The extension SHALL NOT store credentials in this configuration.

#### Scenario: Unsupported conversation provider
- **WHEN** the active conversation uses DeepSeek and global search is enabled
- **THEN** the search tool remains enabled and independently routes its requests

#### Scenario: Explicit global disablement
- **WHEN** the extension or search switch is disabled
- **THEN** search is unavailable and direct invocation starts no network request

#### Scenario: No configuration file
- **WHEN** the configuration file is absent
- **THEN** both tools are enabled with automatic search selection and default DuckDuckGo fallback

### Requirement: Legacy overrides do not control behavior
The extension SHALL preserve legacy global switches, ignore all legacy `providerOverrides` values, and notify users that provider overrides no longer apply and a global search target can be configured. It MUST NOT infer a global target from a legacy model override. Reading legacy configuration SHALL NOT rewrite the file automatically.

#### Scenario: Legacy provider is disabled
- **WHEN** legacy configuration disables search/fetch for a conversation provider but global switches enable them
- **THEN** both tools remain enabled and a migration notice is surfaced

#### Scenario: Legacy model override
- **WHEN** legacy configuration contains a provider-specific search model
- **THEN** that value is ignored and automatic routing remains in effect unless a new global target is explicitly configured

### Requirement: Configuration errors are not fallback conditions
Unknown or unsupported search backend IDs, invalid field types, malformed configuration, and explicitly selected LLM models not registered for the selected provider SHALL produce a clear configuration error before search sends network requests. A missing or whitespace-only global LLM model SHALL instead skip the global tier. Missing authentication and runtime model-search incompatibility SHALL be handled by search fallback, not classified as malformed configuration.

#### Scenario: Unknown backend
- **WHEN** the global backend ID is misspelled or names a provider without an implemented search backend
- **THEN** search reports the invalid configuration instead of silently invoking DuckDuckGo

#### Scenario: Unregistered model
- **WHEN** the global LLM model ID is not registered under the selected provider in Pi
- **THEN** search reports a model configuration error even if that ID exists under another provider

#### Scenario: Wrong model type
- **WHEN** the configured model value is a number rather than a string
- **THEN** search reports the invalid field rather than treating it as an omitted model

#### Scenario: Valid selection lacks authentication
- **WHEN** a registered global model is selected but its backend has no usable authentication
- **THEN** search proceeds through the remaining priority chain

### Requirement: Settings and file configuration share constraints
The `/search` settings interface SHALL expose global switches, automatic selection or an implemented search backend, and registered models for a selected LLM provider. It SHALL NOT offer arbitrary manual model IDs or conversation-provider enablement controls. Non-LLM backends SHALL NOT offer a model selector. File configuration SHALL enforce the same registered-model restriction. Changing the search target SHALL NOT mutate the conversation model.

#### Scenario: Select an LLM backend
- **WHEN** a user selects an LLM search backend in settings
- **THEN** model choices are limited to that provider's Pi-registered models and the user can leave the model unspecified to skip the pinned tier

#### Scenario: Switch to a non-LLM backend
- **WHEN** a user selects ZAI MCP or DuckDuckGo
- **THEN** settings do not require a model and stale model selection is cleared

#### Scenario: Return to automatic routing
- **WHEN** the user clears the global backend selection
- **THEN** routing begins with the active-model tier and retains the remaining fallback chain

### Requirement: Routing visibility and settings refresh
Configuration display, provider listing, and status SHALL distinguish the conversation model from the planned search target and SHALL describe only implemented search backends as selectable. Search execution SHALL report the actual successful target separately from planned selection. UI changes SHALL apply immediately; existing session-start, model-selection, session-tree, and reload flows SHALL refresh file configuration. Search-specific validation errors SHALL remain inspectable and repairable without disabling otherwise valid unified fetch behavior.

#### Scenario: Display pinned cross-provider target
- **WHEN** the conversation uses DeepSeek but search is pinned to OpenAI
- **THEN** configuration display identifies both independently and status describes the planned OpenAI search target

#### Scenario: Refresh after a file edit
- **WHEN** the user edits the search configuration and reloads the extension
- **THEN** selection and displayed configuration reflect the edited values
