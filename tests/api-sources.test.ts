import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvHttpProxyAgent, MockAgent } from "undici";
import {
  formatSearchResult, normalizeApiSources, parseResponsesSearch,
  MAX_API_SOURCES, MAX_API_SOURCE_BYTES,
} from "../extensions/search-result.ts";
import { parseSearchOutput, readSearchStream } from "../extensions/chatgpt-search.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-api-sources-"));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
after(() => {
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldDir;
  rmSync(agentDir, { recursive: true, force: true });
});
function tool() {
  let search: any;
  extension({ registerTool(t: any) { if (t.name === "web_search") search = t; }, registerCommand() {}, on() {} } as any);
  return search;
}
const api = { type: "api" as const, name: "oai-weather" };
const url = { title: "Forecast", url: "https://weather.example/" };
const call = (sources: unknown[]) => ({ type: "web_search_call", status: "completed", action: { type: "search", sources } });
const answer = { type: "message", content: [{ type: "output_text", text: "Sunny", annotations: [] }] };
const events = (items: unknown[], terminal = "response.completed") => [
  ...items.map((item) => ({ type: "response.output_item.done", item })),
  { type: terminal, response: { status: "completed", output: [] } },
].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

test("API normalization validates types, cleans names and deduplicates without inferring URLs", () => {
  assert.deepEqual(normalizeApiSources([
    null, {}, 4, "oai-weather", { type: "api" }, { type: "api", name: 3 },
    { type: "api", name: "\n\t" }, { type: "unknown", name: "ignore" },
    { type: "url", name: "ignore" }, api, { ...api, name: " oai-weather\n" },
    { type: "api", name: "another\nsource\u009b" },
  ]), [api, { type: "api", name: "another source" }]);
});

test("API normalization bounds count, UTF-8 name size and serialized bytes", () => {
  assert.equal(normalizeApiSources(Array.from({ length: 100 }, (_, i) => ({ type: "api", name: `api-${i}` }))).length, MAX_API_SOURCES);
  assert.deepEqual(normalizeApiSources([{ type: "api", name: "源".repeat(86) }, api]), [api]);
  const bounded = normalizeApiSources(Array.from({ length: 100 }, (_, i) => ({ type: "api", name: `${i}${"源".repeat(84)}` })));
  assert.ok(bounded.length > 0 && bounded.length < MAX_API_SOURCES);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MAX_API_SOURCE_BYTES);
  assert.ok(bounded.every((s) => Buffer.byteLength(s.name) <= 256 && !s.name.includes("\ufffd")));
});

test("Responses keeps API and URL sources separate and ignores unknown source types", () => {
  const result = parseResponsesSearch([
    call([api, { type: "url", ...url }, api, { type: "other", ...url, url: "https://ignore.example" }]),
    { type: "web_search_call", action: { type: "open_page", sources: [{ type: "api", name: "ignore" }] } },
    answer,
  ], { searchSources: true });
  assert.deepEqual(result, { text: "Sunny", sources: [url], apiSources: [api] });
  assert.deepEqual(parseResponsesSearch([call([api]), answer]), { text: "Sunny", sources: [] });
});

test("Codex weather SSE preserves API-only attribution with empty annotations and final output", async () => {
  const result = await readSearchStream(new Response(events([call([api]), answer])));
  assert.deepEqual(result, { text: "Sunny", sources: [], apiSources: [api] });
  assert.deepEqual(parseSearchOutput([call([api])]), { text: "", sources: [], apiSources: [api] });
  const content = formatSearchResult({ text: "", sources: [], apiSources: [api] });
  assert.match(content, /## Sources:\n- API source: oai-weather/);
  assert.match(content, /no accessible URL/);
  assert.doesNotMatch(content, /No results|https?:/);
  assert.throws(() => parseSearchOutput([answer]), /no completed web search/);
});

test("mixed-source formatting escapes names, preserves metadata and reserves bounded output", () => {
  const result = {
    text: "结果\n".repeat(40_000),
    sources: Array.from({ length: 12 }, (_, i) => ({ ...url, url: `${url.url}${i}` })),
    apiSources: [{ type: "api" as const, name: "[api]*_<tag>`\\" }],
  };
  const before = structuredClone(result);
  const text = formatSearchResult(result);
  assert.ok(text.includes("API source: \\[api\\]\\*\\_\\<tag\\>\\`\\\\"));
  assert.match(text, /Showing 8 of 13/);
  assert.match(text, /Search output truncated/);
  assert.equal(text.match(/^- /gm)?.length, 8);
  assert.ok(Buffer.byteLength(text) <= 50 * 1024);
  assert.ok(text.split("\n").length <= 2000);
  assert.deepEqual(result, before);
});

for (const scenario of ["api", "mixed", "missing", "failed"] as const) {
  test(`registered Codex tool: ${scenario} sources, display and fallback isolation`, async (t) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    t.after(async () => { await agent.close(); });
    t.mock.method(EnvHttpProxyAgent.prototype, "dispatch", (opts: any, handler: any) => agent.dispatch(opts, handler));
    let fallbackCalls = 0;
    t.mock.method(globalThis, "fetch", async (address: string) => {
      assert.equal(scenario, "failed", "unexpected DDG fallback");
      assert.match(address, /duckduckgo/);
      fallbackCalls++;
      return new Response('<a class="result__a" href="https://fallback.example/">Fallback</a>');
    });
    const sources = scenario === "missing" ? [] : scenario === "mixed" ? [api, url] : [api];
    agent.get("https://chatgpt.com").intercept({ path: "/backend-api/codex/responses", method: "POST" })
      .reply(200, events([call(sources), answer], scenario === "failed" ? "response.failed" : "response.completed"));
    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fake" } })).toString("base64url")}.signature`;
    const search = tool();
    const result = await search.execute("id", { query: "weather" }, undefined, undefined, {
      model: { provider: "openai-codex", id: "model" },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) },
    });
    const hasApi = scenario === "api" || scenario === "mixed";
    assert.deepEqual(result.details.apiSources, hasApi ? [api] : []);
    assert.deepEqual(result.details.sources, scenario === "mixed" ? [url] : []);
    assert.equal(result.details.method, scenario === "failed" ? "ddg" : "native");
    assert.equal(fallbackCalls, scenario === "failed" ? 1 : 0);
    const text = result.content[0].text;
    if (hasApi) assert.match(text, /API source: oai-weather/);
    else assert.doesNotMatch(text, /oai-weather/);
    if (scenario === "missing") assert.match(text, /No structured source metadata/);
    if (scenario === "failed") assert.doesNotMatch(text, /Sunny/);
    const theme = { fg: (_color: string, text: string) => text };
    const collapsed = search.renderResult(result, {}, theme, {}).render(200).join("\n");
    assert.match(collapsed, hasApi ? /1 API sources/ : /no structured source metadata/);
    const expanded = search.renderResult(result, { expanded: true }, theme, {}).render(200).join("\n");
    if (hasApi) assert.match(expanded, /oai-weather/);
    agent.assertNoPendingInterceptors();
  });
}

test("rendering tolerates historical details, partial results and errors", () => {
  const search = tool();
  const theme = { fg: (_color: string, text: string) => text };
  const result = { content: [{ type: "text", text: "Old answer" }], details: {} };
  assert.match(search.renderResult(result, {}, theme, {}).render(200).join("\n"), /no structured source metadata/);
  assert.match(search.renderResult(result, { isPartial: true }, theme, {}).render(200).join("\n"), /Searching/);
  assert.equal(search.renderResult(result, {}, theme, { isError: true }).render(200).join("\n").trimEnd(), "Old answer");
});
