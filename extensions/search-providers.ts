/**
 * Search backends implemented by this extension.
 *
 * This registry is the runtime source of truth for selectable search backends.
 * Conversation providers without an implemented search adapter are deliberately
 * absent: they remain valid Pi providers, but cannot be selected as search
 * targets. `providers.yaml` documents the same set; it is not read at runtime.
 *
 * ZAI's company also supplies models, but the ZAI adapter here only calls the
 * Web Search Prime MCP endpoint and invokes no LLM, so it is a non-LLM backend.
 */

export type SearchBackendKind = "llm" | "non-llm";

/** How a backend obtains credentials. */
export type SearchAuthMode =
  | "api-key"
  | "pi-oauth"
  | "cli-subscription"
  | "none";

export type SearchBackendId =
  | "google"
  | "openai"
  | "openai-codex"
  | "xai"
  | "anthropic"
  | "claude-bridge"
  | "zai"
  | "duckduckgo";

export interface SearchBackend {
  name: string;
  kind: SearchBackendKind;
  auth: SearchAuthMode;
  /** Environment variable consulted for api-key backends. */
  envKey?: string;
}

export const SEARCH_BACKENDS: Record<SearchBackendId, SearchBackend> = {
  google: {
    name: "Google Gemini",
    kind: "llm",
    auth: "api-key",
    envKey: "GEMINI_API_KEY",
  },
  openai: {
    name: "OpenAI",
    kind: "llm",
    auth: "api-key",
    envKey: "OPENAI_API_KEY",
  },
  "openai-codex": {
    name: "OpenAI ChatGPT (subscription)",
    kind: "llm",
    auth: "pi-oauth",
  },
  xai: {
    name: "xAI (Grok)",
    kind: "llm",
    auth: "api-key",
    envKey: "XAI_API_KEY",
  },
  anthropic: {
    name: "Anthropic",
    kind: "llm",
    auth: "api-key",
    envKey: "ANTHROPIC_API_KEY",
  },
  "claude-bridge": {
    name: "Claude Code (subscription)",
    kind: "llm",
    auth: "cli-subscription",
  },
  zai: {
    name: "ZAI Web Search MCP (GLM)",
    kind: "non-llm",
    auth: "api-key",
    envKey: "ZAI_API_KEY",
  },
  duckduckgo: {
    name: "DuckDuckGo",
    kind: "non-llm",
    auth: "none",
  },
};

/** Fixed priority of unauthenticated/non-LLM backends after the LLM tiers. */
export const NON_LLM_FALLBACK_ORDER: SearchBackendId[] = ["zai", "duckduckgo"];

export const SEARCH_BACKEND_IDS = Object.keys(SEARCH_BACKENDS) as SearchBackendId[];

export function isSearchBackendId(value: string): value is SearchBackendId {
  return Object.prototype.hasOwnProperty.call(SEARCH_BACKENDS, value);
}

/** Whether a backend invokes an LLM (and therefore needs a model). */
export function isLlmBackend(value: string): boolean {
  return isSearchBackendId(value) && SEARCH_BACKENDS[value].kind === "llm";
}

export function backendName(id: SearchBackendId): string {
  return SEARCH_BACKENDS[id].name;
}
