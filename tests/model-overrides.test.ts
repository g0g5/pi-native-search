import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = fs.mkdtempSync(join(tmpdir(), "pi-search-model-test-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

function harness(providerOverrides: Record<string, unknown> = {}) {
  const configPath = join(agentDir, "search-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, providerOverrides }));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => ["web_search", "web_fetch"],
    setActiveTools() {},
  } as any);
  return { tools, commands, events, configPath };
}
function env(t: TestContext, key: string, value: string) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
const apiProviders = [
  ["openai", "OPENAI_API_KEY", "https://api.openai.com/v1/responses"],
  ["xai", "XAI_API_KEY", "https://api.x.ai/v1/responses"],
  ["anthropic", "ANTHROPIC_API_KEY", "https://session.example/v1/messages"],
  ["google", "GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/models/search-model:generateContent?key=fake"],
];
for (const [provider, key, expectedUrl] of apiProviders) {
  test(`${provider}: uses configured model without changing session or endpoint policy`, async (t) => {
    env(t, key!, "fake");
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls++;
      assert.equal(url, expectedUrl);
      const body = JSON.parse(init.body as string);
      if (provider !== "google") assert.equal(body.model, "search-model");
      return Response.json({});
    });
    const model = Object.freeze({ provider, id: "session-model", baseUrl: "https://session.example" });
    const ctx = { model };
    const { tools } = harness({ [provider!]: { model: "  search-model  " }, other: { model: "wrong" } });
    const result = await tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, ctx);
    assert.equal(result.details.method, "native");
    assert.equal(result.details.searchModel, "search-model");
    assert.equal(result.details.searchModelSource, "configured");
    assert.equal(calls, 1);
    assert.equal(ctx.model, model);
    assert.equal(model.id, "session-model");
  });
}

test("unconfigured or invalid overrides use session model; other providers do not leak", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(init.body as string).model, "session-model");
    return Response.json({});
  });
  for (const value of [undefined, "", "  ", null, 23, {}, ["wrong"]]) {
    const { tools } = harness({ openai: { model: value }, google: { model: "wrong" } });
    const result = await tools.get("web_search").execute("id", { query: "q" }, undefined, undefined,
      { model: { provider: "openai", id: "session-model" } });
    assert.equal(result.details.method, "native");
    assert.equal(result.details.searchModel, "session-model");
    assert.equal(result.details.searchModelSource, "session");
  }
});

test("failed configured model falls back once, without retrying session model", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    if (calls.length === 1) {
      assert.equal(JSON.parse(init.body as string).model, "unsupported-model");
      return new Response("unsupported", { status: 400 });
    }
    assert.match(url, /html.duckduckgo.com/);
    return new Response("");
  });
  const result = await harness({ openai: { model: "unsupported-model" } }).tools.get("web_search")
    .execute("id", { query: "q" }, undefined, undefined, { model: { provider: "openai", id: "session-model" } });
  assert.equal(calls.length, 2);
  assert.equal(result.details.method, "ddg");
  assert.equal(result.details.searchModel, "unsupported-model");
  assert.match(result.content[0].text, /Native failed/);
});

test("Codex resolves the configured model without changing the session", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(url, /html.duckduckgo.com/);
    return new Response("");
  });
  const target = Object.freeze({ provider: "openai-codex", id: "search-model" });
  const current = Object.freeze({ provider: "openai-codex", id: "session-model" });
  let resolutions = 0;
  const ctx = {
    model: current,
    modelRegistry: {
      find(provider: string, id: string) {
        assert.equal(provider, "openai-codex");
        assert.equal(id, "search-model");
        return target;
      },
      async getApiKeyAndHeaders(model: unknown) {
        resolutions++;
        assert.equal(model, target);
        return { ok: false }; // No real OAuth or network access.
      },
    },
  };
  const result = await harness({ "openai-codex": { model: "search-model" } }).tools.get("web_search")
    .execute("id", { query: "q" }, undefined, undefined, ctx);
  assert.equal(resolutions, 1);
  assert.equal(ctx.model, current);
  assert.equal(result.details.searchModel, "search-model");
  assert.equal(result.details.method, "ddg");
});

test("unregistered Codex model gives explicit fallback; cancellation bypasses lookup and fallback", async (t) => {
  let calls = 0;
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    assert.match(url, /html.duckduckgo.com/);
    return new Response("");
  });
  const ctx = {
    model: { provider: "openai-codex", id: "session-model" },
    modelRegistry: {
      find() { lookups++; return undefined; },
      getApiKeyAndHeaders() { assert.fail("must not resolve auth"); },
    },
  };
  const tool = harness({ "openai-codex": { model: "missing" } }).tools.get("web_search");
  const result = await tool.execute("id", { query: "q" }, undefined, undefined, ctx);
  assert.equal(result.details.method, "ddg");
  assert.match(result.content[0].text, /Search model not registered: openai-codex\/missing/);
  await assert.rejects(tool.execute("id", { query: "q" }, AbortSignal.abort(), undefined, ctx), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(lookups, 1);
});

test("ZAI MCP and DDG ignore configured models", async (t) => {
  env(t, "ZAI_API_KEY", "fake");
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.doesNotMatch(url, /ignored-model/);
    if (url.includes("duckduckgo")) return new Response("");
    const body = JSON.parse(init.body as string);
    assert.doesNotMatch(init.body as string, /ignored-model/);
    if (body.method === "initialize") return new Response("", { headers: { "Mcp-Session-Id": "fake-session" } });
    assert.deepEqual(body.params.arguments, { search_query: "q" });
    return new Response('data: {"result":{"content":[{"text":"MCP results"}]}}\n');
  });
  for (const provider of ["zai", "deepseek", "unknown"]) {
    const result = await harness({ [provider]: { model: "ignored-model" } }).tools.get("web_search")
      .execute("id", { query: "q" }, undefined, undefined, { model: { provider, id: "session-model" } });
    assert.equal(result.details.method, provider === "zai" ? "native" : "ddg");
    assert.deepEqual(result.details.sources, []);
    assert.equal(result.details.searchModel, undefined);
  }
});

test("web_fetch ignores search model and does not resolve Codex models", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("page"));
  const result = await harness({ "openai-codex": { model: "missing" } }).tools.get("web_fetch")
    .execute("id", { url: "https://example.com" }, undefined, undefined, {
      model: { provider: "openai-codex", id: "session-model" },
      modelRegistry: { find() { assert.fail("must not resolve search model"); } },
    });
  assert.equal(result.details.method, "local");
  assert.equal(result.content[0].text, "page");
});

test("display, saved toggles and reload preserve search model selection", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const { commands, events, configPath } = harness({ openai: { model: "search-model", searchEnabled: true } });
  let notification = "";
  let status = "";
  const ctx = {
    model: { provider: "openai", id: "session-model" },
    ui: {
      notify(text: string) { notification = text; },
      setStatus(_name: string, text: string) { status = text; },
      theme: { fg: (_color: string, text: string) => text },
    },
  };
  await commands.get("search").handler("config", ctx);
  assert.match(notification, /Session model: session-model/);
  assert.match(notification, /Search model: search-model \(configured\)/);
  await events.get("session_start")({}, ctx);
  assert.match(status, /search-model \(configured\)/);
  for (const command of ["off", "on"]) {
    await commands.get("search").handler(command, ctx);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).providerOverrides.openai.model, "search-model");
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.providerOverrides.openai.model = "reloaded-model";
  fs.writeFileSync(configPath, JSON.stringify(config));
  await events.get("session_start")({ reason: "reload" }, ctx);
  assert.match(status, /reloaded-model/);
  await commands.get("search").handler("config", { ...ctx, model: { provider: "zai", id: "session-model" } });
  assert.match(notification, /Search model: not applicable/);
});

test("Claude Bridge passes search model to SDK only; default search and fetch retain SDK default", async (t) => {
  // Hide all globally installed SDKs: this test can only load its local fake package.
  const existsSync = fs.existsSync;
  const existsMock = t.mock.method(fs, "existsSync", (path: fs.PathLike) =>
    String(path).startsWith(agentDir) && existsSync(path));
  syncBuiltinESMExports();
  t.after(() => { existsMock.mock.restore(); syncBuiltinESMExports(); });
  const bridgeDir = join(agentDir, "extensions", "pi-claude-bridge");
  const sdkDir = join(bridgeDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(join(bridgeDir, "package.json"), '{}');
  fs.writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  fs.writeFileSync(join(sdkDir, "index.js"), `
    export function query({ options }) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: JSON.stringify(options) };
        },
        close() {}, async interrupt() {}
      };
    }
  `);
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fall back"));
  const ctx = { model: { provider: "claude-bridge", id: "session-model" } };
  for (const configured of [undefined, "search-model"]) {
    const { tools } = harness({ "claude-bridge": { model: configured } });
    const searchResult = await tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, ctx);
    assert.equal(searchResult.details.method, "native");
    assert.deepEqual(searchResult.details.sources, []);
    const options = JSON.parse(searchResult.content[0].text);
    assert.equal(options.model, configured);
    assert.deepEqual(options.allowedTools, ["WebSearch"]);
    const fetchResult = await tools.get("web_fetch").execute("id", { url: "https://example.com" }, undefined, undefined, ctx);
    const fetchOptions = JSON.parse(fetchResult.content[0].text);
    assert.equal(fetchOptions.model, undefined);
    assert.deepEqual(fetchOptions.allowedTools, ["WebFetch"]);
  }
});
