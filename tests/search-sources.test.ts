import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvHttpProxyAgent, MockAgent } from "undici";

const agentDir = mkdtempSync(join(tmpdir(), "pi-search-sources-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  rmSync(agentDir, { recursive: true, force: true });
});
function tool() {
  let search: any;
  extension({ registerTool(value: any) { if (value.name === "web_search") search = value; }, registerCommand() {}, on() {} } as any);
  return search;
}
function env(t: TestContext, key: string) {
  const old = process.env[key];
  process.env[key] = "fake-key";
  t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
const source = { title: "Official docs", url: "https://docs.example/" };
const output = [{ type: "message", content: [
  { type: "output_text", text: "First block" },
  { type: "output_text", text: "Second block", annotations: [{ type: "url_citation", ...source }] },
] }];
const cases = [
  { provider: "openai", key: "OPENAI_API_KEY", response: { output } },
  { provider: "xai", key: "XAI_API_KEY", response: { output, citations: [source.url] } },
  { provider: "google", key: "GEMINI_API_KEY", response: { candidates: [{
    content: { parts: [{ text: "First block" }, { text: "Second block" }] },
    groundingMetadata: { groundingChunks: [{ web: { title: source.title, uri: source.url } }] },
  }] } },
  { provider: "anthropic", key: "ANTHROPIC_API_KEY", response: { content: [
    { type: "text", text: "First block" },
    { type: "text", text: "Second block", citations: [{ type: "web_search_result_location", ...source }] },
  ] } },
];
for (const { provider, key, response } of cases) {
  test(`${provider}: registered tool exposes sources in details and model-visible content`, async (t) => {
    env(t, key);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(init.body as string);
      if (provider === "openai") assert.deepEqual(body.include, ["web_search_call.action.sources"]);
      return Response.json(response);
    });
    const result = await tool().execute("id", { query: "q" }, undefined, undefined, { model: { provider, id: "model" } });
    assert.equal(calls, 1);
    assert.equal(result.details.method, "native");
    assert.equal(result.details.query, "q");
    assert.deepEqual(result.details.sources, [source]);
    assert.equal(result.details.searchModel, "model");
    assert.match(result.content[0].text, /First block\nSecond block/);
    assert.match(result.content[0].text, /## Sources:/);
    assert.ok(result.content[0].text.includes(source.url));
  });
}

test("OpenAI includes full search sources even when no annotations/text are returned", async (t) => {
  env(t, "OPENAI_API_KEY");
  t.mock.method(globalThis, "fetch", async () => Response.json({ output: [{
    type: "web_search_call", action: { type: "search", sources: [source] },
  }] }));
  const result = await tool().execute("id", { query: "q" }, undefined, undefined, { model: { provider: "openai", id: "model" } });
  assert.deepEqual(result.details.sources, [source]);
  assert.ok(result.content[0].text.includes(source.url));
  assert.doesNotMatch(result.content[0].text, /No results/);
});

test("Anthropic tool error falls back without leaking partial text/sources or affecting the next call", async (t) => {
  env(t, "ANTHROPIC_API_KEY");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    if (calls === 1) return Response.json({ content: [
      { type: "text", text: "Partial answer", citations: [{ type: "web_search_result_location", ...source }] },
      { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" } },
    ] });
    if (calls === 2) {
      assert.match(url, /duckduckgo/);
      return new Response('<a class="result__a" href="https://fallback.example/">Fallback</a>');
    }
    return Response.json({ content: [{ type: "text", text: "Next answer" }] });
  });
  const search = tool();
  const ctx = { model: { provider: "anthropic", id: "model" } };
  const result = await search.execute("id", { query: "q" }, undefined, undefined, ctx);
  assert.equal(calls, 2);
  assert.equal(result.details.method, "ddg");
  assert.deepEqual(result.details.sources, []);
  assert.match(result.content[0].text, /Search fallback: anthropic\/model failed \(Anthropic web search tool failed/);
  assert.match(result.content[0].text, /Fallback/);
  assert.doesNotMatch(result.content[0].text, /Partial answer|docs.example/);
  const next = await search.execute("next", { query: "q2" }, undefined, undefined, ctx);
  assert.deepEqual(next.details.sources, []);
  assert.equal(next.content[0].text, "Next answer");
});

test("tool output reserves sources after a long answer and retains more sources in details", async (t) => {
  env(t, "OPENAI_API_KEY");
  const sources = Array.from({ length: 12 }, (_, i) => ({ title: `Source ${i}`, url: `https://example.com/${i}` }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ output: [{ type: "message", content: [{
    type: "output_text", text: "result\n".repeat(4000), annotations: sources.map((source) => ({ type: "url_citation", ...source })),
  }] }] }));
  const result = await tool().execute("id", { query: "q" }, undefined, undefined, { model: { provider: "openai", id: "model" } });
  assert.deepEqual(result.details.sources, sources);
  const content = result.content[0].text;
  assert.ok(Buffer.byteLength(content) <= 50 * 1024);
  assert.ok(content.split("\n").length <= 2000);
  assert.match(content, /Search output truncated/);
  assert.match(content, /Showing 8 of 12/);
  for (const source of sources.slice(0, 8)) assert.ok(content.includes(source.url));
});

test("Codex registered tool propagates structured SSE sources without real OAuth/network", async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  t.after(async () => { await agent.close(); });
  t.mock.method(EnvHttpProxyAgent.prototype, "dispatch", (options: any, handler: any) => agent.dispatch(options, handler));
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fall back"));
  const searchItem = { type: "web_search_call", status: "completed", action: { type: "search", sources: [source] } };
  const events = [
    { type: "response.output_item.done", item: searchItem },
    { type: "response.output_item.done", item: output[0] },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ];
  agent.get("https://chatgpt.com").intercept({ path: "/backend-api/codex/responses", method: "POST" })
    .reply(200, events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" } })).toString("base64url")}.signature`;
  const result = await tool().execute("id", { query: "q" }, undefined, undefined, {
    model: { provider: "openai-codex", id: "model" },
    modelRegistry: { hasConfiguredAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
  });
  assert.equal(result.details.method, "native");
  assert.deepEqual(result.details.sources, [source]);
  assert.match(result.content[0].text, /First block\nSecond block/);
  assert.ok(result.content[0].text.includes(source.url));
  agent.assertNoPendingInterceptors();
});
