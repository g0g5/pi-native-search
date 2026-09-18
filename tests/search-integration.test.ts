/**
 * Integrated, tool-level acceptance coverage across the three capability specs:
 *
 * - search-routing: ordered targets, continue-after-failure, cancellation,
 *   target isolation, truthful provenance.
 * - search-configuration: global switches, validation, legacy handling,
 *   settings/file agreement, routing visibility.
 * - web-fetch: one provider-independent retrieval path with preserved limits.
 *
 * These tests drive the registered tools exactly like the agent would and
 * assert on real request order with mocked network/auth.
 */
import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pi-search-integration-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const configPath = join(agentDir, "search-config.json");

function env(t: TestContext, key: string, value: string) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

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

function harness(config: Record<string, unknown> = {}, registry: any = {}) {
  writeFileSync(configPath, JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, ...config }));
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const active = ["web_search", "web_fetch"];
  const record = { status: undefined as string | undefined, notify: [] as string[] };
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active.length = 0;
      active.push(...names);
    },
  } as any);
  const ctx = {
    ...registry,
    ui: {
      notify: (text: string) => record.notify.push(text),
      setStatus: (_key: string, text: string | undefined) => {
        record.status = text;
      },
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    },
  };
  return { tools, events, ctx, active, record };
}

const ddgHtml = '<a class="result__a" href="https://final.example/">Final</a>';

test("the full priority chain is attempted in order until one target succeeds", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  env(t, "ANTHROPIC_API_KEY", "fake");
  env(t, "ZAI_API_KEY", "fake");
  const order: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.startsWith("https://api.openai.com")) {
      order.push("openai");
      return new Response("rate limited", { status: 429 });
    }
    if (url.startsWith("https://api.anthropic.com")) {
      order.push("anthropic");
      return new Response("overloaded", { status: 529 });
    }
    if (url.startsWith("https://api.z.ai")) {
      order.push("zai");
      return new Response("mcp down", { status: 503 });
    }
    order.push("duckduckgo");
    return new Response(ddgHtml);
  });
  const registry = {
    model: { provider: "anthropic", id: "claude-session" },
    modelRegistry: {
      getAll: () => [{ provider: "openai", id: "gpt-5", name: "gpt-5" }],
      find: (provider: string, id: string) => (provider === "openai" && id === "gpt-5" ? { provider, id } : undefined),
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "t", headers: {} }),
    },
  };
  const h = harness({ searchProvider: "openai", searchModel: "gpt-5" }, registry);
  const result = await h.tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, h.ctx);

  assert.deepEqual(order, ["openai", "anthropic", "zai", "duckduckgo"]);
  assert.equal(result.details.provider, "duckduckgo");
  assert.equal(result.details.method, "ddg");
  assert.deepEqual(
    result.details.attempts.map((attempt: any) => [attempt.backend, attempt.ok]),
    [
      ["openai", false],
      ["anthropic", false],
      ["zai", false],
      ["duckduckgo", true],
    ],
  );
  assert.match(result.details.attempts[0].reason, /HTTP 429/);
  assert.match(result.details.attempts[1].reason, /HTTP 529/);
  assert.match(result.details.attempts[2].reason, /HTTP 503/);
  assert.equal(result.details.searchModel, undefined);
  assert.match(result.content[0].text, /Final/);
  assert.match(result.content[0].text, /used duckduckgo/);
});

test("a saved configuration survives a reload and drives the next search", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "pinned answer" }] }] });
  });
  const registry = {
    model: { provider: "deepseek", id: "deepseek-chat" },
    modelRegistry: {
      getAll: () => [{ provider: "openai", id: "gpt-5", name: "gpt-5" }],
      find: (provider: string, id: string) => (provider === "openai" && id === "gpt-5" ? { provider, id } : undefined),
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "t", headers: {} }),
    },
  };
  const h = harness({ searchProvider: "openai", searchModel: "gpt-5" }, registry);
  await h.events.get("session_start")({ reason: "startup" }, h.ctx);
  assert.match(h.record.status!, /search:openai\/gpt-5/);

  // An explicit settings save writes only the global shape.
  h.record.notify.length = 0;
  writeFileSync(
    configPath,
    JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, searchProvider: "openai", searchModel: "gpt-5" }),
  );
  await h.events.get("session_start")({ reason: "reload" }, h.ctx);
  assert.match(h.record.status!, /search:openai\/gpt-5/);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf-8")), {
    enabled: true,
    searchEnabled: true,
    fetchEnabled: true,
    searchProvider: "openai",
    searchModel: "gpt-5",
  });

  const result = await h.tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, h.ctx);
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses"]);
  assert.equal(result.details.provider, "openai");
  assert.equal(result.details.tier, "configured");
  assert.equal(result.details.searchModel, "gpt-5");
  assert.equal(result.details.searchModelSource, "configured");
});

test("cross-provider sessions keep search, fetch, and credentials isolated", async (t) => {
  withoutKeys(t, ["GEMINI_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "ANTHROPIC_API_KEY", "ZAI_API_KEY"]);
  const calls: Array<{ url: string; auth: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("Authorization") });
    if (url.startsWith("https://html.duckduckgo.com")) return new Response(ddgHtml);
    return new Response("fetched page");
  });
  const registry = {
    model: { provider: "claude-bridge", id: "claude-session" },
    modelRegistry: {
      getAll: () => [],
      find: () => assert.fail("search must not resolve models with no configured target"),
      hasConfiguredAuth: () => false,
      getApiKeyAndHeaders: () => assert.fail("fetch must not resolve search credentials"),
    },
  };
  const h = harness({}, registry);
  const search = await h.tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, h.ctx);
  const fetched = await h.tools.get("web_fetch").execute("id", { url: "https://example.com/" }, undefined, undefined, h.ctx);

  assert.equal(search.details.provider, "duckduckgo");
  assert.equal(fetched.details.method, "local");
  assert.equal(fetched.content[0].text, "fetched page");
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), ["html.duckduckgo.com", "example.com"]);
  assert.ok(calls.every((call) => call.auth === null), "no search credentials may reach fetch");
});

test("an invalid configuration sends zero requests while fetch stays independent", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response("page");
  });
  const h = harness({ searchProvider: "deepseek" }, { model: { provider: "deepseek", id: "deepseek-chat" }, modelRegistry: {} });
  const search = await h.tools.get("web_search").execute("id", { query: "q" }, undefined, undefined, h.ctx);
  assert.equal(search.details.error, "config");
  assert.deepEqual(calls, []);
  const fetched = await h.tools.get("web_fetch").execute("id", { url: "https://example.com/" }, undefined, undefined, h.ctx);
  assert.equal(fetched.content[0].text, "page");
  assert.deepEqual(calls, ["https://example.com/"]);
});

test("global disablement removes both tools regardless of the conversation provider", async () => {
  for (const provider of ["deepseek", "claude-bridge", "openai"]) {
    const h = harness({ enabled: false }, { model: { provider, id: "model" }, modelRegistry: {} });
    await h.events.get("session_start")({ reason: "startup" }, h.ctx);
    assert.deepEqual(h.active, [], provider);
  }
});
