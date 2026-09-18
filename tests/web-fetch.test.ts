import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = fs.mkdtempSync(join(tmpdir(), "pi-web-fetch-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

const configPath = join(agentDir, "search-config.json");

function harness(config: Record<string, unknown> = {}, session: any = undefined, registry: any = authenticatedRegistry()) {
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, ...config }));
  const tools = new Map<string, any>();
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    on() {},
    getActiveTools: () => ["web_search", "web_fetch"],
    setActiveTools() {},
  } as any);
  return { fetch: tools.get("web_fetch"), search: tools.get("web_search"), ctx: { model: session, modelRegistry: registry } };
}

function authenticatedRegistry(): any {
  const models = [{ name: "gpt-5", provider: "openai-codex", id: "gpt-5" }];
  return {
    getAll: () => models,
    find: () => assert.fail("fetch must not resolve search models"),
    hasConfiguredAuth: () => assert.fail("fetch must not probe search credentials"),
    getApiKeyAndHeaders: () => assert.fail("fetch must not resolve search credentials"),
  };
}

test("fetch uses direct HTTP for every conversation provider and search backend", async (t) => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return new Response("Page text", { headers: { "content-type": "text/plain" } });
  });
  const sessions = [
    { provider: "claude-bridge", id: "claude-sonnet-4-5" },
    { provider: "openai-codex", id: "gpt-5" },
    { provider: "deepseek", id: "deepseek-chat" },
    undefined,
  ];
  for (const session of sessions) {
    for (const config of [{}, { searchProvider: "openai-codex", searchModel: "gpt-5" }, { searchProvider: "duckduckgo" }]) {
      calls.length = 0;
      const result = await harness(config, session).fetch.execute(
        "id",
        { url: "https://example.com/" },
        undefined,
        undefined,
        { model: session, modelRegistry: authenticatedRegistry() },
      );
      assert.equal(calls.length, 1, `${session?.provider ?? "no model"} must make one request`);
      assert.equal(calls[0]!.url, "https://example.com/");
      assert.equal(calls[0]!.headers.has("Authorization"), false);
      assert.equal(result.content[0].text, "Page text");
      assert.deepEqual(result.details, { url: "https://example.com/", method: "local" });
    }
  }
});

test("fetch never resolves search credentials or a search model", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("page"));
  const result = await harness({ searchProvider: "openai-codex", searchModel: "gpt-5" }).fetch.execute(
    "id",
    { url: "https://example.com/" },
    undefined,
    undefined,
    { model: { provider: "openai-codex", id: "gpt-5" }, modelRegistry: authenticatedRegistry() },
  );
  assert.equal(result.details.method, "local");
});

test("HTML extraction removes scripts, styles, and tags", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(
      "<html><head><style>body{color:red}</style></head><body><script>alert('x')</script><h1>Title</h1><p>Body text</p></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ),
  );
  const result = await harness().fetch.execute("id", { url: "https://example.com/" }, undefined, undefined, harness().ctx);
  const text = result.content[0].text;
  assert.match(text, /Title/);
  assert.match(text, /Body text/);
  assert.doesNotMatch(text, /alert|<script|<style|color:red|<h1>|<\/?p>/i);
});

test("JSON responses are formatted and plain text is preserved", async (t) => {
  const responses = [
    { contentType: "application/json", body: JSON.stringify({ a: 1, b: [2, 3] }), check: (text: string) => assert.equal(text, JSON.stringify({ a: 1, b: [2, 3] }, null, 2)) },
    { contentType: "text/plain", body: "  spaced\nlines  ", check: (text: string) => assert.equal(text, "  spaced\nlines  ") },
  ];
  for (const response of responses) {
    t.mock.method(globalThis, "fetch", async () => new Response(response.body, { headers: { "content-type": response.contentType } }));
    const result = await harness().fetch.execute("id", { url: "https://example.com/" }, undefined, undefined, undefined);
    response.check(result.content[0].text);
  }
});

test("both output limits are enforced with a truncation notice", async (t) => {
  const cases = [
    { label: "bytes", body: "a".repeat(120_000) },
    { label: "lines", body: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") },
  ];
  for (const scenario of cases) {
    t.mock.method(globalThis, "fetch", async () => new Response(scenario.body, { headers: { "content-type": "text/plain" } }));
    const result = await harness().fetch.execute("id", { url: "https://example.com/" }, undefined, undefined, undefined);
    const text = result.content[0].text;
    assert.match(text, /\[Truncated: \d+\/\d+ lines\]/, scenario.label);
    assert.ok(Buffer.byteLength(text) <= 50 * 1024, `${scenario.label} exceeded 50KB: ${Buffer.byteLength(text)}`);
    assert.ok(text.split("\n").length <= 2000, `${scenario.label} exceeded 2000 lines`);
  }
});

test("globally disabled fetch starts no network request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  for (const config of [{ enabled: false }, { fetchEnabled: false }]) {
    const result = await harness(config).fetch.execute("id", { url: "https://example.com/" }, undefined, undefined, undefined);
    assert.equal(result.details.error, "disabled");
  }
});

test("HTTP errors are terminal tool errors with no alternate fetch", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response("server error", { status: 503, statusText: "Service Unavailable" });
  });
  await assert.rejects(
    harness().fetch.execute("id", { url: "https://example.com/" }, undefined, undefined, undefined),
    /Fetch 503 Service Unavailable/,
  );
  assert.deepEqual(calls, ["https://example.com/"]);
});

test("cancellation is terminal and never starts another fetch", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  await assert.rejects(
    harness().fetch.execute("id", { url: "https://example.com/" }, AbortSignal.abort(), undefined, undefined),
    { name: "AbortError" },
  );

  const controller = new AbortController();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    return await new Promise<Response>((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener("abort", () => reject((init.signal as AbortSignal).reason), { once: true });
    });
  });
  const pending = harness().fetch.execute("id", { url: "https://example.com/" }, controller.signal, undefined, undefined);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(calls, ["https://example.com/"]);
});

test("a search-target configuration error leaves fetch fully operational", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response("page");
  });
  const h = harness({ searchProvider: "not-a-backend" });
  const result = await h.fetch.execute("id", { url: "https://example.com/" }, undefined, undefined, h.ctx);
  assert.equal(result.content[0].text, "page");
  assert.deepEqual(calls, ["https://example.com/"]);
});
