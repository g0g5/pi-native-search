import assert from "node:assert/strict";
import test from "node:test";
import { describeSearchModel, resolveSearchModel } from "../extensions/search-model.ts";

for (const provider of ["openai", "openai-codex", "google", "xai", "anthropic", "claude-bridge"]) {
  test(`${provider}: accepts a trimmed model override`, () => {
    const selected = resolveSearchModel(provider, "  search-model  ", "session-model");
    assert.deepEqual(selected, { id: "search-model", source: "configured" });
    assert.equal(describeSearchModel(selected), "search-model (configured)");
  });
  test(`${provider}: empty and malformed values preserve defaults`, () => {
    for (const value of [undefined, null, "", " \t\n", false, 42, {}, ["search-model"]]) {
      assert.deepEqual(resolveSearchModel(provider, value, "session-model"),
        provider === "claude-bridge" ? { source: "sdk" } : { id: "session-model", source: "session" });
    }
  });
}

for (const provider of ["zai", "deepseek", "openrouter", "duckduckgo", "unknown"]) {
  test(`${provider}: ignores model overrides`, () => {
    const selected = resolveSearchModel(provider, "ignored-model", "session-model");
    assert.deepEqual(selected, { source: "none" });
    assert.equal(describeSearchModel(selected), "not applicable");
  });
}
