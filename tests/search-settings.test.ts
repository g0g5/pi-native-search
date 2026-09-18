import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = fs.mkdtempSync(join(tmpdir(), "pi-search-settings-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
// Settings rendering needs an initialized pi theme outside a real TUI session.
initTheme("dark");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const configPath = join(agentDir, "search-config.json");
const BASE_CONFIG = { enabled: true, searchEnabled: true, fetchEnabled: true };

function writeConfig(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(configPath, JSON.stringify({ ...BASE_CONFIG, ...extra }));
}
function writeRaw(text: string) {
  fs.writeFileSync(configPath, text);
}
function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}
function env(t: TestContext, key: string, value: string) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

/** Remove ambient credentials so readiness assertions are environment-independent. */
function withoutKeys(t: TestContext, keys: string[]) {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const SEARCH_KEYS = ["GEMINI_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "ZAI_API_KEY"];

interface Options {
  session?: any;
  models?: Array<Record<string, unknown>>;
  auth?: boolean;
}

function make(extra: Record<string, unknown> = {}, options: Options = {}) {
  writeConfig(extra);
  const models = (options.models ?? []).map((model) => ({ name: model.id, ...model }));
  const registry = {
    getAll: () => models,
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => options.auth ?? true,
    getApiKeyAndHeaders: async (model: any) => ({ ok: true, apiKey: "test-token", headers: {}, baseUrl: model.baseUrl }),
  };
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  const active = ["web_search", "web_fetch"];
  const record = {
    setModel: [] as any[],
    notify: [] as string[],
    status: undefined as string | undefined,
    component: undefined as any,
  };
  const tui = { requestRender() {} };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    dim: (text: string) => text,
  };
  const ctx = {
    model: options.session,
    modelRegistry: registry,
    ui: {
      notify: (text: string) => record.notify.push(text),
      setStatus: (_key: string, text: string | undefined) => {
        record.status = text;
      },
      theme,
      custom: async (factory: any) => {
        record.component = factory(tui, theme, undefined, () => {});
        return record.component;
      },
    },
  };
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.length = 0;
      active.push(...names);
    },
    setModel: (model: any) => {
      record.setModel.push(model);
      return Promise.resolve(true);
    },
  } as any);

  const handle = (data: string) => record.component.handleInput(data);
  return {
    tools,
    commands,
    events,
    ctx,
    active,
    record,
    render: () => record.component.render(200).join("\n"),
    key: handle,
    down: (count = 1) => {
      for (let i = 0; i < count; i++) handle("\x1b[B");
    },
    enter: () => handle("\r"),
    notifyText: () => record.notify.at(-1) ?? "",
  };
}

async function openSettings(harness: ReturnType<typeof make>) {
  await harness.commands.get("search").handler("", harness.ctx);
}

// ─── 3.1 Settings: backend and registered-model selection ────────────────────

test("settings list only implemented backends, never conversation providers", async () => {
  const h = make({}, { session: { provider: "deepseek", id: "deepseek-chat" } });
  await openSettings(h);
  let out = h.render();
  assert.match(out, /Search Extension/);
  assert.match(out, /Search Backend/);
  assert.doesNotMatch(out, /DeepSeek|OpenRouter|Mistral|Hugging Face/);

  h.down(3); // enabled, search, fetch → Search Backend
  h.enter();
  out = h.render();
  assert.match(out, /Automatic/);
  assert.match(out, /Google Gemini/);
  assert.match(out, /OpenAI ChatGPT \(subscription\)/);
  assert.match(out, /ZAI Web Search MCP/);
  assert.match(out, /DuckDuckGo/);
  assert.match(out, /credentials:/);
  assert.doesNotMatch(out, /DeepSeek|OpenRouter|Mistral/);
});

test("selecting an LLM backend clears stale models and offers only that provider's registered models", async () => {
  const h = make(
    { searchProvider: "openai", searchModel: "gpt-5" },
    {
      session: { provider: "deepseek", id: "deepseek-chat" },
      models: [
        { provider: "openai", id: "gpt-5" },
        { provider: "anthropic", id: "claude-sonnet-4-5" },
      ],
    },
  );
  await openSettings(h);
  assert.match(h.render(), /Search Model/);
  assert.match(h.render(), /gpt-5/);

  h.down(3);
  h.enter(); // backend submenu, pre-selected on the configured openai backend
  h.down(3); // openai → openai-codex → xai → anthropic
  h.enter();
  const saved = readConfig();
  assert.equal(saved.searchProvider, "anthropic");
  assert.equal(saved.searchModel, undefined); // gpt-5 is not registered for anthropic

  h.down(1); // target → Search Model
  h.enter();
  const models = h.render();
  assert.match(models, /Not set/);
  assert.match(models, /claude-sonnet-4-5/);
  assert.doesNotMatch(models, /gpt-5/);
  h.down(1); // Not set → first registered model
  h.enter();
  assert.equal(readConfig().searchModel, "claude-sonnet-4-5");
  assert.equal(h.record.setModel.length, 0);
  assert.equal(h.ctx.model.id, "deepseek-chat");
});

test("non-LLM backends clear stale model selection and offer no model selector", async () => {
  const h = make(
    { searchProvider: "openai", searchModel: "gpt-5" },
    { models: [{ provider: "openai", id: "gpt-5" }] },
  );
  await openSettings(h);
  h.down(3);
  h.enter();
  h.down(6); // openai → openai-codex → xai → anthropic → claude-bridge → zai → duckduckgo
  h.enter();
  const saved = readConfig();
  assert.equal(saved.searchProvider, "duckduckgo");
  assert.equal("searchModel" in saved, false);
  assert.doesNotMatch(h.render(), /Search Model/);
});

test("the model selector accepts only registered ids, not arbitrary input", async () => {
  const h = make(
    { searchProvider: "anthropic" },
    { models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }] },
  );
  await openSettings(h);
  h.down(4); // enabled, search, fetch, backend → Search Model
  h.enter();
  assert.match(h.render(), /claude-sonnet-4-5/);
  // The selector offers only registered ids: typing cannot create a model.
  for (const character of "custom-model") h.key(character);
  const afterTyping = h.render();
  assert.doesNotMatch(afterTyping, /custom-model/);
  assert.match(afterTyping, /claude-sonnet-4-5/);
  assert.match(afterTyping, /Not set/);
  assert.equal(readConfig().searchModel, undefined);
  h.enter(); // "Not set" keeps the pinned tier skipped
  assert.equal(readConfig().searchModel, undefined);
  assert.equal(h.record.setModel.length, 0);
});

test("settings never mutate the conversation model", async () => {
  const session = { provider: "anthropic", id: "claude-session" };
  const h = make({}, { session });
  await openSettings(h);
  h.down(3);
  h.enter();
  h.down(1); // automatic → google
  h.enter();
  assert.equal(readConfig().searchProvider, "google");
  assert.deepEqual(h.record.setModel, []);
  assert.equal(h.ctx.model, session);
});

// ─── 3.2 Global-switch-only activation ───────────────────────────────────────

test("tool activation depends only on global switches", async () => {
  const cases: Array<[Record<string, unknown>, string[]]> = [
    [{}, ["web_search", "web_fetch"]],
    [{ enabled: false }, []],
    [{ searchEnabled: false }, ["web_fetch"]],
    [{ fetchEnabled: false }, ["web_search"]],
  ];
  for (const [config, expected] of cases) {
    for (const session of [{ provider: "deepseek", id: "deepseek-chat" }, undefined]) {
      const h = make(config, { session });
      await h.events.get("session_start")({ reason: "startup" }, h.ctx);
      assert.deepEqual(h.active, expected, `${JSON.stringify(config)} session=${session ? "set" : "none"}`);
    }
  }
});

test("/search on and /search off toggle global switches and persist them", async () => {
  const h = make({ enabled: false });
  await h.commands.get("search").handler("on", h.ctx);
  assert.deepEqual(h.active, ["web_search", "web_fetch"]);
  assert.deepEqual(readConfig(), { enabled: true, searchEnabled: true, fetchEnabled: true });

  await h.commands.get("search").handler("off", h.ctx);
  assert.deepEqual(h.active, []);
  assert.deepEqual(readConfig(), { enabled: false, searchEnabled: true, fetchEnabled: true });
});

test("a search target error keeps both tools active and fetch working", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response("page");
  });
  const h = make({ searchProvider: "deepseek" }, { session: undefined });
  await h.events.get("session_start")({ reason: "startup" }, h.ctx);
  assert.deepEqual(h.active, ["web_search", "web_fetch"]);

  const search = await h.tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, h.ctx);
  assert.equal(search.details.error, "config");
  assert.match(search.content[0].text, /Unknown search backend/);

  const fetched = await h.tools.get("web_fetch").execute("id", { url: "https://example.com/" }, undefined, undefined, h.ctx);
  assert.equal(fetched.details.method, "local");
  assert.equal(fetched.content[0].text, "page");
  assert.deepEqual(calls, ["https://example.com/"]);
});

test("a malformed configuration blocks both tools without network requests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const h = make({}, { session: undefined });
  writeRaw("{ not json");
  await h.events.get("session_start")({ reason: "startup" }, h.ctx);
  assert.deepEqual(h.active, ["web_search", "web_fetch"]);

  const search = await h.tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, h.ctx);
  assert.equal(search.details.error, "config");
  assert.match(search.content[0].text, /not valid JSON/);
  const fetched = await h.tools.get("web_fetch").execute("id", { url: "https://example.com/" }, undefined, undefined, h.ctx);
  assert.equal(fetched.details.error, "config");
});

test("legacy overrides surface one migration notice per session", async () => {
  const h = make({ providerOverrides: { openai: { model: "legacy-model", searchEnabled: false } } });
  await h.events.get("session_start")({ reason: "startup" }, h.ctx);
  await h.events.get("session_start")({ reason: "reload" }, h.ctx);
  await h.events.get("model_select")({}, h.ctx);
  // Legacy per-provider disablement cannot disable globally enabled tools.
  assert.deepEqual(h.active, ["web_search", "web_fetch"]);
  const warnings = h.record.notify.filter((text) => /overrides are no longer supported/.test(text));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Configure a global search target/);
});

test("returning to automatic routing clears the pinned target and keeps the chain", async (t) => {
  env(t, "ANTHROPIC_API_KEY", "fake");
  const h = make(
    { searchProvider: "anthropic", searchModel: "claude-sonnet-4-5" },
    {
      session: { provider: "anthropic", id: "claude-session" },
      models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
    },
  );
  await h.events.get("session_start")({ reason: "startup" }, h.ctx);
  assert.match(h.record.status!, /search:anthropic\/claude-sonnet-4-5,/);

  await openSettings(h);
  h.down(3);
  h.enter(); // backend submenu, pre-selected on anthropic
  h.down(4); // anthropic → claude-bridge → zai → duckduckgo → automatic
  h.enter();

  const saved = readConfig();
  assert.equal("searchProvider" in saved, false);
  assert.equal("searchModel" in saved, false);
  await h.events.get("session_start")({ reason: "reload" }, h.ctx);
  // Routing now begins with the active-model tier and keeps the fallback chain.
  assert.match(h.record.status!, /search:anthropic\/claude-session/);
});

// ─── 3.3 Routing visibility ──────────────────────────────────────────────────

test("/search config separates session model, planned target, and chain", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const h = make(
    { searchProvider: "openai", searchModel: "gpt-5" },
    { session: { provider: "deepseek", id: "deepseek-chat" }, models: [{ provider: "openai", id: "gpt-5" }] },
  );
  await h.commands.get("search").handler("config", h.ctx);
  const text = h.notifyText();
  assert.match(text, /Session model: deepseek-chat \(deepseek\)/);
  assert.match(text, /Session search support: no implemented search backend/);
  assert.match(text, /Configured backend: openai/);
  assert.match(text, /Planned search target: openai\/gpt-5/);
  assert.match(text, /Fallback chain: openai\/gpt-5 → duckduckgo/);
  assert.match(text, /Skipped:.*zai/);
  assert.match(text, /Fetch: direct HTTP/);
});

test("/search providers lists implemented backends with truthful readiness", async (t) => {
  withoutKeys(t, SEARCH_KEYS);
  const h = make({}, { session: undefined, models: [{ provider: "anthropic", id: "claude-sonnet-4-5" }] });
  await h.commands.get("search").handler("providers", h.ctx);
  const out = h.render();
  assert.match(out, /Implemented Search Backends/);
  assert.match(out, /Claude Code \(subscription\)/);
  assert.match(out, /checked at call time/); // Claude Bridge readiness is deferred
  assert.match(out, /not configured/); // no API keys in this environment
  assert.match(out, /ready/); // DuckDuckGo needs no credentials
  assert.doesNotMatch(out, /DeepSeek|OpenRouter/);
});

test("status shows the planned target and defers to configuration errors", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const h = make(
    { searchProvider: "openai", searchModel: "gpt-5" },
    {
      session: { provider: "anthropic", id: "claude-session" },
      models: [{ provider: "openai", id: "gpt-5" }, { provider: "claude-bridge", id: "claude-sonnet-4-5" }],
    },
  );
  await h.events.get("session_start")({ reason: "startup" }, h.ctx);
  assert.match(h.record.status!, /search:openai\/gpt-5/);
  assert.match(h.record.status!, /fetch:http/);

  // A file edit plus reload is reflected immediately.
  writeConfig({ searchProvider: "duckduckgo" });
  await h.events.get("session_start")({ reason: "reload" }, h.ctx);
  assert.match(h.record.status!, /search:duckduckgo/);

  // Deferred readiness is shown as the planned target, not as verified auth.
  writeConfig({ searchProvider: "claude-bridge", searchModel: "claude-sonnet-4-5" });
  h.ctx.model = { provider: "claude-bridge", id: "claude-sonnet-4-5" };
  await h.events.get("model_select")({}, h.ctx);
  assert.match(h.record.status!, /search:claude-bridge\/claude-sonnet-4-5/);

  writeRaw("{ broken");
  await h.events.get("session_tree")({}, h.ctx);
  assert.match(h.record.status!, /search:config-error/);
});

test("progress updates name the actual attempt, not just the plan", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  env(t, "ANTHROPIC_API_KEY", "fake");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.startsWith("https://api.openai.com")) return new Response("rate limited", { status: 429 });
    return Response.json({ content: [{ type: "text", text: "Session answer" }] });
  });
  const h = make(
    { searchProvider: "openai", searchModel: "gpt-5" },
    { session: { provider: "anthropic", id: "claude-session" }, models: [{ provider: "openai", id: "gpt-5" }] },
  );
  const progress: string[] = [];
  const result = await h.tools.get("web_search").execute(
    "id",
    { query: "q" },
    undefined,
    (update: any) => progress.push(update.content[0].text),
    h.ctx,
  );
  assert.ok(progress.some((text) => /openai\/gpt-5/.test(text)), progress.join("\n"));
  assert.ok(progress.some((text) => /anthropic\/claude-session/.test(text)), progress.join("\n"));
  assert.equal(result.details.provider, "anthropic");
});
