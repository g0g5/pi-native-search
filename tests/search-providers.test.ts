import assert from "node:assert/strict";
import test from "node:test";
import {
  NON_LLM_FALLBACK_ORDER,
  SEARCH_BACKENDS,
  SEARCH_BACKEND_IDS,
  backendName,
  isLlmBackend,
  isSearchBackendId,
} from "../extensions/search-providers.ts";

// Every backend with a real adapter in extensions/index.ts. Keep this list in
// sync with the dispatch switch: the registry must never advertise a backend
// the extension cannot execute, and must never omit one it can.
const IMPLEMENTED = [
  "google",
  "openai",
  "openai-codex",
  "xai",
  "anthropic",
  "claude-bridge",
  "zai",
  "duckduckgo",
];

// Conversation providers with no implemented search adapter. They stay valid
// Pi providers but must not be selectable as search targets.
const CONVERSATION_ONLY = [
  "deepseek",
  "openrouter",
  "mistral",
  "groq",
  "cerebras",
  "huggingface",
  "fireworks",
  "cloudflare",
  "amazon-bedrock",
  "azure-openai",
  "kimi",
  "minimax",
  "github-copilot",
  "vercel",
  "opencode",
  "perplexity",
];

test("registry covers every implemented search adapter and nothing else", () => {
  assert.deepEqual([...SEARCH_BACKEND_IDS].sort(), [...IMPLEMENTED].sort());
  for (const id of IMPLEMENTED) {
    assert.ok(isSearchBackendId(id), `${id} must be a selectable backend`);
    assert.ok(backendName(id as never).length > 0);
  }
  assert.equal(Object.keys(SEARCH_BACKENDS).length, IMPLEMENTED.length);
});

test("conversation-only providers are not selectable search backends", () => {
  for (const id of CONVERSATION_ONLY) {
    assert.equal(isSearchBackendId(id), false, `${id} must not be selectable`);
    assert.equal(isLlmBackend(id), false);
  }
  assert.equal(isSearchBackendId(""), false);
  assert.equal(isSearchBackendId("toString"), false); // no prototype leakage
});

test("ZAI and DuckDuckGo are non-LLM backends", () => {
  assert.equal(SEARCH_BACKENDS.zai.kind, "non-llm");
  assert.equal(SEARCH_BACKENDS.duckduckgo.kind, "non-llm");
  assert.equal(isLlmBackend("zai"), false);
  assert.equal(isLlmBackend("duckduckgo"), false);
  // A non-LLM backend never needs a model.
  assert.equal(SEARCH_BACKENDS.zai.auth, "api-key");
  assert.equal(SEARCH_BACKENDS.duckduckgo.auth, "none");
  assert.deepEqual(NON_LLM_FALLBACK_ORDER, ["zai", "duckduckgo"]);
});

test("LLM backends declare an authentication mode and required model", () => {
  for (const id of ["google", "openai", "xai", "anthropic"] as const) {
    assert.equal(SEARCH_BACKENDS[id].auth, "api-key");
    assert.ok(SEARCH_BACKENDS[id].envKey, `${id} needs an env key`);
  }
  assert.equal(SEARCH_BACKENDS["openai-codex"].auth, "pi-oauth");
  assert.equal(SEARCH_BACKENDS["claude-bridge"].auth, "cli-subscription");
  assert.equal(isLlmBackend("google"), true);
  assert.equal(isLlmBackend("claude-bridge"), true);
});

test("api-key env keys are unique and the registry has no fetch capabilities", () => {
  const keys = Object.values(SEARCH_BACKENDS)
    .map((backend) => backend.envKey)
    .filter(Boolean);
  assert.equal(new Set(keys).size, keys.length);
  for (const backend of Object.values(SEARCH_BACKENDS)) {
    assert.equal("nativeFetch" in backend, false);
    assert.equal("nativeSearch" in backend, false);
  }
});
