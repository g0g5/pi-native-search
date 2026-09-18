# web-fetch Specification

## Purpose

Retrieve readable page content through one provider-independent HTTP path without relying on conversation-model subscriptions or search-backend routing.

## Requirements

### Requirement: Unified provider-independent retrieval
Enabled `web_fetch` calls SHALL retrieve the requested URL using direct HTTP regardless of the conversation provider or globally selected search backend. Fetch SHALL NOT invoke Claude Bridge, an LLM, or a search fallback chain and MUST NOT attach search-provider credentials to page requests. Only global extension/fetch switches SHALL control availability.

#### Scenario: Claude Bridge conversation
- **WHEN** a conversation using Claude Bridge invokes `web_fetch`
- **THEN** the requested page is retrieved by direct HTTP without invoking the Claude SDK

#### Scenario: Pinned search backend
- **WHEN** search is pinned to an authenticated LLM provider and fetch is enabled
- **THEN** fetching a page neither resolves that provider's credentials nor invokes its search endpoint

#### Scenario: Globally disabled fetch
- **WHEN** the extension or fetch switch is disabled
- **THEN** a fetch invocation starts no network request

### Requirement: Preserve extraction and output limits
The unified fetch path SHALL preserve existing behavior for JSON formatting, plain text, and basic HTML text extraction, including removing script/style content and HTML tags. Output SHALL remain limited to 50 KB or 2000 lines with a truncation notice when applicable. Results SHALL identify the HTTP/local retrieval method without implying a conversation-provider backend.

#### Scenario: HTML page
- **WHEN** the requested page returns HTML containing scripts, styles, and text
- **THEN** the result contains extracted text without script/style content or HTML tags

#### Scenario: Large response
- **WHEN** extracted content exceeds the output limit
- **THEN** the returned content is truncated and includes a truncation notice

### Requirement: Fetch errors and cancellation are terminal
HTTP errors and network failures SHALL surface as tool errors. Cancellation SHALL terminate retrieval and MUST NOT start an alternate fetch request.

#### Scenario: Page cannot be retrieved
- **WHEN** the HTTP server returns an unsuccessful status
- **THEN** fetch reports an error without invoking Claude Bridge or any search backend

#### Scenario: Cancelled retrieval
- **WHEN** the caller cancels retrieval
- **THEN** the operation stops without fallback
