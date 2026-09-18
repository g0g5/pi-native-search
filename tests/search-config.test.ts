import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never read or write the user's real agent directory.
const agentDir = mkdtempSync(join(tmpdir(), "pi-search-config-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const {
  DEFAULT_SEARCH_CONFIG,
  MIGRATION_NOTICE,
  fetchBlocked,
  loadSearchConfig,
  normalizeSearchConfig,
  saveSearchConfig,
  searchBlocked,
  serializeSearchConfig,
} = await import("../extensions/search-config.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  rmSync(agentDir, { recursive: true, force: true });
});

let counter = 0;
function configPath() {
  return join(agentDir, `config-${counter++}.json`);
}
function write(value: string) {
  const path = configPath();
  writeFileSync(path, value, "utf-8");
  return path;
}

test("absent configuration defaults to enabled tools with automatic routing", () => {
  const state = loadSearchConfig(configPath());
  assert.deepEqual(state.config, DEFAULT_SEARCH_CONFIG);
  assert.deepEqual(state.config, { enabled: true, searchEnabled: true, fetchEnabled: true });
  assert.equal(state.config.searchProvider, undefined);
  assert.equal(state.config.searchModel, undefined);
  assert.equal(state.error, undefined);
  assert.equal(searchBlocked(state), false);
  assert.equal(fetchBlocked(state), false);
});

test("partial configuration keeps defaults for missing fields", () => {
  const state = loadSearchConfig(write(JSON.stringify({ enabled: false, searchProvider: "openai-codex", searchModel: "gpt-5" })));
  assert.equal(state.config.enabled, false);
  assert.equal(state.config.searchEnabled, true);
  assert.equal(state.config.fetchEnabled, true);
  assert.equal(state.config.searchProvider, "openai-codex");
  assert.equal(state.config.searchModel, "gpt-5");
  assert.equal(state.error, undefined);
});

test("malformed JSON is a structural error that blocks execution", () => {
  const state = loadSearchConfig(write("{ not json"));
  assert.equal(state.error?.scope, "structure");
  assert.match(state.error!.message, /not valid JSON/i);
  assert.deepEqual(state.config, DEFAULT_SEARCH_CONFIG);
  assert.equal(searchBlocked(state), true);
  assert.equal(fetchBlocked(state), true);
});

test("wrong switch types are structural errors, not guesses", () => {
  for (const raw of [{ enabled: "yes" }, { searchEnabled: 1 }, { fetchEnabled: "true" }]) {
    const state = normalizeSearchConfig(raw);
    assert.equal(state.error?.scope, "structure", JSON.stringify(raw));
    assert.equal(fetchBlocked(state), true);
  }
  // null is treated as omitted, matching an explicit JSON null from older tools.
  const withNull = normalizeSearchConfig({ searchProvider: null, searchModel: null });
  assert.equal(withNull.error, undefined);
  assert.equal(withNull.config.searchProvider, undefined);
});

test("unknown and non-string backends produce a search configuration error", () => {
  const unknown = normalizeSearchConfig({ searchProvider: "not-a-backend" });
  assert.equal(unknown.error?.scope, "search");
  assert.match(unknown.error!.message, /Unknown search backend/);
  assert.equal(unknown.config.searchProvider, undefined);
  // Search-target errors must not disable otherwise valid fetch.
  assert.equal(searchBlocked(unknown), true);
  assert.equal(fetchBlocked(unknown), false);

  const conversationOnly = normalizeSearchConfig({ searchProvider: "deepseek" });
  assert.equal(conversationOnly.error?.scope, "search");

  const wrongType = normalizeSearchConfig({ searchProvider: 42 });
  assert.equal(wrongType.error?.scope, "search");
});

test("a model without a backend is a configuration error", () => {
  const state = normalizeSearchConfig({ searchModel: "gpt-5" });
  assert.equal(state.error?.scope, "search");
  assert.match(state.error!.message, /without "searchProvider"/);
  assert.equal(state.config.searchModel, undefined);
});

test("wrong model types are errors rather than omitted models", () => {
  for (const searchModel of [42, false, {}, ["gpt-5"]]) {
    const state = normalizeSearchConfig({ searchProvider: "openai-codex", searchModel });
    assert.equal(state.error?.scope, "search", JSON.stringify(searchModel));
    assert.match(state.error!.message, /"searchModel" must be a string/);
  }
});

test("non-LLM backends ignore string models and blank models are skipped", () => {
  for (const searchProvider of ["zai", "duckduckgo"]) {
    const state = normalizeSearchConfig({ searchProvider, searchModel: "ignored-model" });
    assert.equal(state.error, undefined, searchProvider);
    assert.equal(state.config.searchModel, undefined);
  }
  const blank = normalizeSearchConfig({ searchProvider: "openai-codex", searchModel: "   " });
  assert.equal(blank.error, undefined);
  assert.equal(blank.config.searchModel, undefined);
  const blankProvider = normalizeSearchConfig({ searchProvider: "  " });
  assert.equal(blankProvider.error, undefined);
  assert.equal(blankProvider.config.searchProvider, undefined);
});

test("provided model values are trimmed", () => {
  const state = normalizeSearchConfig({ searchProvider: "openai", searchModel: "  gpt-5  " });
  assert.equal(state.config.searchModel, "gpt-5");
});

// ─── Legacy overrides ────────────────────────────────────────────────────────

test("legacy provider overrides are ignored and surfaced once", () => {
  const state = loadSearchConfig(write(JSON.stringify({
    enabled: true,
    searchEnabled: true,
    fetchEnabled: true,
    providerOverrides: {
      openai: { model: "legacy-model", searchEnabled: false },
      "claude-bridge": { fetchEnabled: false },
    },
  })));
  assert.equal(state.error, undefined);
  // Legacy models/toggles are discarded, not inferred into a global target.
  assert.equal(state.config.searchProvider, undefined);
  assert.equal(state.config.searchModel, undefined);
  assert.equal("providerOverrides" in state.config, false);
  assert.equal(state.migrationNotice, MIGRATION_NOTICE);
  assert.ok(state.legacySignature);
});

test("legacy global disablement is preserved", () => {
  const state = loadSearchConfig(write(JSON.stringify({
    enabled: false,
    searchEnabled: false,
    fetchEnabled: false,
    providerOverrides: { openai: { searchEnabled: false } },
  })));
  assert.equal(state.config.enabled, false);
  assert.equal(state.config.searchEnabled, false);
  assert.equal(state.config.fetchEnabled, false);
  assert.ok(state.migrationNotice);
});

test("empty or absent provider overrides produce no migration notice", () => {
  for (const raw of [{}, { providerOverrides: {} }, { providerOverrides: { openai: {} } }, { providerOverrides: [] }]) {
    const state = normalizeSearchConfig(raw);
    assert.equal(state.migrationNotice, undefined, JSON.stringify(raw));
    assert.equal(state.legacySignature, undefined);
  }
});

test("reading legacy configuration never mutates the file", () => {
  const body = JSON.stringify({ enabled: true, providerOverrides: { openai: { model: "legacy-model" } } }, null, 2);
  const path = write(body);
  const before = statSync(path).mtimeMs;
  const state = loadSearchConfig(path);
  assert.ok(state.migrationNotice);
  assert.equal(readFileSync(path, "utf-8"), body);
  assert.equal(statSync(path).mtimeMs, before);
});

test("serialization emits only the new global shape", () => {
  const serialized = serializeSearchConfig({
    enabled: true,
    searchEnabled: false,
    fetchEnabled: true,
    searchProvider: "openai-codex",
    searchModel: "gpt-5",
  });
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, {
    enabled: true,
    searchEnabled: false,
    fetchEnabled: true,
    searchProvider: "openai-codex",
    searchModel: "gpt-5",
  });
  assert.doesNotMatch(serialized, /providerOverrides/);

  // A non-LLM backend never serializes a stale model.
  const nonLlm = JSON.parse(serializeSearchConfig({
    enabled: true,
    searchEnabled: true,
    fetchEnabled: true,
    searchProvider: "duckduckgo",
    searchModel: "stale",
  }));
  assert.equal(nonLlm.searchModel, undefined);
  assert.equal(nonLlm.searchProvider, "duckduckgo");
});

test("an explicit save writes the new shape and removes legacy fields", () => {
  const path = write(JSON.stringify({ enabled: true, providerOverrides: { openai: { model: "legacy-model" } } }));
  loadSearchConfig(path);
  saveSearchConfig(
    { enabled: true, searchEnabled: true, fetchEnabled: true, searchProvider: "openai", searchModel: "gpt-5" },
    path,
  );
  const saved = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(saved, {
    enabled: true,
    searchEnabled: true,
    fetchEnabled: true,
    searchProvider: "openai",
    searchModel: "gpt-5",
  });
  const reloaded = loadSearchConfig(path);
  assert.equal(reloaded.migrationNotice, undefined);
});
