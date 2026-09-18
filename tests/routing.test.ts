import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Unit tests never read the user's auth.json or search settings.
const agentDir = mkdtempSync(join(tmpdir(), "pi-search-test-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  rmSync(agentDir, { recursive: true, force: true });
});

/** Registered tools under a fresh global configuration. */
function tools(config: Record<string, unknown> = {}) {
  writeFileSync(
    join(agentDir, "search-config.json"),
    JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, ...config }),
  );
  const registered = new Map<string, any>();
  extension({ registerTool: (tool: any) => registered.set(tool.name, tool), registerCommand() {}, on() {} } as any);
  return registered;
}

const ddgHtml = '<a class="result__a" href="https://example.com/">Example</a><a class="result__snippet">snippet</a>';

/** A live-looking codex session whose OAuth resolution fails. */
const noOAuth: any = {
  model: { provider: "openai-codex", id: "selected-model" },
  modelRegistry: {
    getAll: () => [{ provider: "openai-codex", id: "selected-model", name: "selected-model" }],
    find: (provider: string, id: string) =>
      provider === "openai-codex" && id === "selected-model" ? { provider, id } : undefined,
    hasConfiguredAuth: () => true,
    getApiKeyAndHeaders: async () => ({ ok: false, error: "not logged in" }),
  },
};

test("ChatGPT auth failure takes DDG fallback and is labeled truthfully", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(ddgHtml);
  });
  const result = await tools().get("web_search").execute("id", { query: "query" }, undefined, undefined, noOAuth);
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ["html.duckduckgo.com"]);
  assert.equal(result.details.method, "ddg");
  assert.equal(result.details.provider, "duckduckgo");
  assert.equal(result.details.searchModel, undefined);
  assert.deepEqual(result.details.sources, []);
  assert.match(
    result.content[0].text,
    /Search fallback: openai-codex\/selected-model failed \(ChatGPT authentication unavailable/,
  );
  assert.match(result.content[0].text, /used duckduckgo/);
  assert.match(result.content[0].text, /Example/);
});

test("cancelling ChatGPT search never initiates DuckDuckGo fallback", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  await assert.rejects(
    tools().get("web_search").execute("id", { query: "q" }, AbortSignal.abort(), undefined, noOAuth),
    { name: "AbortError" },
  );
});

test("openai still uses OPENAI_API_KEY and api.openai.com, not ChatGPT OAuth", async (t) => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-public-api-key";
  t.after(() => {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-public-api-key");
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "API result" }] }] });
  });
  const result = await tools().get("web_search").execute("id", { query: "q" }, undefined, undefined, {
    model: { provider: "openai", id: "api-model" },
    modelRegistry: { getApiKeyAndHeaders: () => assert.fail("must not use ChatGPT resolver") },
  });
  assert.equal(result.details.method, "native");
  assert.equal(result.details.provider, "openai");
  assert.equal(result.content[0].text, "API result");
});

test("ChatGPT web_fetch stays local HTTP without OAuth", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://example.com/");
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return new Response("Page text");
  });
  const result = await tools().get("web_fetch").execute("id", { url: "https://example.com/" }, undefined, undefined, noOAuth);
  assert.equal(result.details.method, "local");
  assert.equal("provider" in result.details, false);
  assert.equal(result.content[0].text, "Page text");
});

test("global disablement stops search without network requests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const result = await tools({ searchEnabled: false })
    .get("web_search")
    .execute("id", { query: "q" }, undefined, undefined, noOAuth);
  assert.equal(result.details.error, "disabled");
});

test("search results are truncated to protect agent context", async (t) => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fake";
  t.after(() => {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "a".repeat(100_000) }] }] }),
  );
  const result = await tools().get("web_search").execute("id", { query: "q" }, undefined, undefined, {
    model: { provider: "openai", id: "model" },
  });
  assert.ok(result.content[0].text.length < 52_000);
  assert.match(result.content[0].text, /Search output truncated/);
});
