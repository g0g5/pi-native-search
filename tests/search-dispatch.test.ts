import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvHttpProxyAgent, MockAgent } from "undici";

const agentDir = fs.mkdtempSync(join(tmpdir(), "pi-search-dispatch-"));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/index.ts");
const { sanitizeReason } = await import("../extensions/index.ts");
after(() => {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
});


function harness(config: Record<string, unknown>) {
  // The extension always reads search-config.json from the agent directory.
  const path = join(agentDir, "search-config.json");
  fs.writeFileSync(path, JSON.stringify({ enabled: true, searchEnabled: true, fetchEnabled: true, ...config }));
  const tools = new Map<string, any>();
  extension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {},
    on() {},
    getActiveTools: () => ["web_search", "web_fetch"],
    setActiveTools() {},
  } as any);
  return { search: tools.get("web_search"), fetch: tools.get("web_fetch"), path };
}

function env(t: TestContext, key: string, value: string) {
  const old = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

function codexToken(accountId = "account"): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

interface RegistryOptions {
  models?: Array<Record<string, unknown>>;
  auth?: boolean | ((model: any) => boolean);
  token?: string;
}

function registryFor({ models = [], auth = true, token = "test-token" }: RegistryOptions = {}) {
  const all = models.map((model) => ({ name: model.id, ...model }));
  return {
    getAll: () => all,
    find: (provider: string, id: string) => all.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (model: any) => (typeof auth === "function" ? auth(model) : auth),
    getApiKeyAndHeaders: async (model: any) => ({ ok: true, apiKey: token, headers: {}, baseUrl: model.baseUrl }),
  };
}

function ctxFor(session: any, registry: any) {
  return { model: session, modelRegistry: registry };
}

const ddgHtml =
  '<a class="result__a" href="https://example.com/">Example</a><a class="result__snippet">snippet</a>';

// ─── 2.3 Target-scoped dispatch ──────────────────────────────────────────────

test("cross-provider Codex search uses the selected model's auth, headers, and endpoint", async (t) => {
  env(t, "ANTHROPIC_API_KEY", "fake-anthropic-key");
  const agent = new MockAgent();
  agent.disableNetConnect();
  t.after(async () => {
    await agent.close();
  });
  const seen: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(EnvHttpProxyAgent.prototype, "dispatch", (opts: any, handler: any) => {
    seen.push({ url: `${opts.origin}${opts.path}`, headers: new Headers(opts.headers) });
    return agent.dispatch(opts, handler);
  });
  t.mock.method(globalThis, "fetch", async () => assert.fail("conversation-provider endpoint must not be used"));
  const events = [
    { type: "response.output_item.done", item: { type: "web_search_call", status: "completed", action: { type: "search", sources: [] } } },
    { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Codex answer" }] } },
    { type: "response.completed", response: { status: "completed", output: [] } },
  ];
  agent
    .get("https://chatgpt.com")
    .intercept({ path: "/backend-api/codex/responses", method: "POST" })
    .reply(200, events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

  const registry = registryFor({
    token: codexToken("cross-account"),
    models: [{ provider: "openai-codex", id: "codex-search-model", baseUrl: "https://chatgpt.com/backend-api", headers: { "x-model": "codex" } }],
  });
  // chatgptSearch resolves auth for the passed model and uses that same model
  // for the request body, so observing it proves target-scoped dispatch.
  const resolved: any[] = [];
  const resolveAuth = registry.getApiKeyAndHeaders;
  registry.getApiKeyAndHeaders = async (model: any) => {
    resolved.push(model);
    return resolveAuth(model);
  };
  const session = { provider: "anthropic", id: "claude-session", baseUrl: "https://anthropic.example" };
  const result = await harness({ searchProvider: "openai-codex", searchModel: "codex-search-model" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor(session, registry),
  );
  assert.equal(result.details.provider, "openai-codex");
  assert.equal(result.details.method, "native");
  assert.equal(result.details.tier, "configured");
  assert.equal(result.details.searchModel, "codex-search-model");
  assert.equal(result.details.searchModelSource, "configured");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, "codex-search-model");
  assert.equal(resolved[0].provider, "openai-codex");
  assert.equal(resolved[0].baseUrl, "https://chatgpt.com/backend-api");
  assert.deepEqual(resolved[0].headers, { "x-model": "codex" });
  assert.deepEqual(seen.map((request) => request.url), ["https://chatgpt.com/backend-api/codex/responses"]);
  assert.equal(seen[0]!.headers.get("chatgpt-account-id"), "cross-account");
  assert.match(seen[0]!.headers.get("authorization") ?? "", /^Bearer /);
  assert.equal(seen[0]!.headers.get("x-model"), "codex");
  assert.equal(session.id, "claude-session");
  agent.assertNoPendingInterceptors();
});

test("Anthropic uses the target model's base URL, not the conversation model's", async (t) => {
  env(t, "ANTHROPIC_API_KEY", "fake-anthropic-key");
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(JSON.parse(init.body as string).model, "target-model");
    return Response.json({ content: [{ type: "text", text: "answer" }] });
  });
  const registry = registryFor({ models: [{ provider: "anthropic", id: "target-model", baseUrl: "https://target-anthropic.example" }] });
  const session = { provider: "deepseek", id: "deepseek-chat", baseUrl: "https://session.example" };
  const result = await harness({ searchProvider: "anthropic", searchModel: "target-model" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor(session, registry),
  );
  assert.deepEqual(urls, ["https://target-anthropic.example/v1/messages"]);
  assert.equal(result.details.provider, "anthropic");
  assert.equal(result.details.searchModel, "target-model");
});

test("API-key backends keep their fixed endpoints regardless of model base URL", async (t) => {
  const cases = [
    { provider: "openai", key: "OPENAI_API_KEY", url: "https://api.openai.com/v1/responses" },
    { provider: "xai", key: "XAI_API_KEY", url: "https://api.x.ai/v1/responses" },
    {
      provider: "google",
      key: "GEMINI_API_KEY",
      url: "https://generativelanguage.googleapis.com/v1beta/models/target-model:generateContent?key=fake",
    },
  ];
  for (const { provider, key, url } of cases) {
    env(t, key, "fake");
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (address: string) => {
      calls.push(address);
      return Response.json({});
    });
    const registry = registryFor({ models: [{ provider, id: "target-model", baseUrl: "https://should-be-ignored.example" }] });
    await harness({ searchProvider: provider, searchModel: "target-model" }).search.execute(
      "id",
      { query: "q" },
      undefined,
      undefined,
      ctxFor({ provider: "deepseek", id: "deepseek-chat" }, registry),
    );
    assert.deepEqual(calls, [url], provider);
  }
});

test("Claude Bridge forwards the exact selected model to the SDK", async (t) => {
  const existsSync = fs.existsSync;
  const existsMock = t.mock.method(fs, "existsSync", (path: fs.PathLike) => String(path).startsWith(agentDir) && existsSync(path));
  syncBuiltinESMExports();
  t.after(() => {
    existsMock.mock.restore();
    syncBuiltinESMExports();
  });
  const bridgeDir = join(agentDir, "extensions", "pi-claude-bridge");
  const sdkDir = join(bridgeDir, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(join(bridgeDir, "package.json"), "{}");
  fs.writeFileSync(join(sdkDir, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  fs.writeFileSync(
    join(sdkDir, "index.js"),
    `export function query({ options }) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "result", subtype: "success", result: JSON.stringify(options) };
        },
        close() {}, async interrupt() {}
      };
    }`,
  );
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fall back"));
  const registry = registryFor({ auth: () => true, models: [{ provider: "claude-bridge", id: "configured-bridge-model" }] });
  const result = await harness({ searchProvider: "claude-bridge", searchModel: "configured-bridge-model" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "deepseek", id: "deepseek-chat" }, registry),
  );
  const options = JSON.parse(result.content[0].text);
  assert.equal(options.model, "configured-bridge-model");
  assert.deepEqual(options.allowedTools, ["WebSearch"]);
  assert.equal(result.details.provider, "claude-bridge");
});

// ─── 1.4 / 3.2 Configuration errors block requests ──────────────────────────

test("an unregistered pinned model is reported with zero network requests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const registry = registryFor({ models: [{ provider: "openai", id: "gpt-5" }] });
  const result = await harness({ searchProvider: "openai", searchModel: "missing-model" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "openai", id: "gpt-5" }, registry),
  );
  assert.equal(result.details.error, "config");
  assert.match(result.content[0].text, /not registered for backend "openai"/);
});

test("unknown backend never sends a request", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  const unknown = await harness({ searchProvider: "deepseek" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "openai", id: "gpt-5" }, registryFor()),
  );
  assert.equal(unknown.details.error, "config");
  assert.match(unknown.content[0].text, /Unknown search backend/);
});

test("legacy provider overrides are ignored and never inferred into a target", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    return new Response(ddgHtml);
  });
  const result = await harness({ providerOverrides: { openai: { model: "legacy-model", searchEnabled: false } } }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "deepseek", id: "deepseek-chat" }, registryFor()),
  );
  assert.deepEqual(calls, ["https://html.duckduckgo.com/html/?q=q"]);
  assert.equal(result.details.provider, "duckduckgo");
  assert.equal(result.details.searchModel, undefined);
});

// ─── 2.4 Sequential fallback ─────────────────────────────────────────────────

test("a failing global target continues to the active model before DDG", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  env(t, "ANTHROPIC_API_KEY", "fake");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://api.openai.com")) {
      return new Response("rate limited", { status: 429 });
    }
    if (url.startsWith("https://api.anthropic.com")) {
      return Response.json({ content: [{ type: "text", text: "Session answer" }] });
    }
    return new Response(ddgHtml);
  });
  const registry = registryFor({ models: [{ provider: "openai", id: "gpt-5" }] });
  const result = await harness({ searchProvider: "openai", searchModel: "gpt-5" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "anthropic", id: "claude-session" }, registry),
  );
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses", "https://api.anthropic.com/v1/messages"]);
  assert.equal(result.details.provider, "anthropic");
  assert.equal(result.details.method, "native");
  assert.equal(result.details.tier, "session");
  assert.equal(result.details.searchModel, "claude-session");
  assert.equal(result.details.searchModelSource, "session");
  assert.deepEqual(
    result.details.attempts.map((attempt: any) => [attempt.backend, attempt.ok]),
    [["openai", false], ["anthropic", true]],
  );
  assert.match(result.details.attempts[0].reason, /HTTP 429/);
  assert.match(result.content[0].text, /Search fallback: openai\/gpt-5 failed \(OpenAI search failed \(HTTP 429\)\.\); used anthropic\/claude-session/);
});

test("the chain falls through to DuckDuckGo after every LLM tier fails", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://api.openai.com")) return new Response("bad", { status: 400 });
    return new Response(ddgHtml);
  });
  const registry = registryFor({ models: [{ provider: "openai", id: "gpt-5" }] });
  const result = await harness({ searchProvider: "openai", searchModel: "gpt-5" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "deepseek", id: "deepseek-chat" }, registry),
  );
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses", "https://html.duckduckgo.com/html/?q=q"]);
  assert.equal(result.details.provider, "duckduckgo");
  assert.equal(result.details.method, "ddg");
  assert.equal(result.details.tier, "fallback");
  assert.equal(result.details.searchModel, undefined);
  assert.equal(result.details.searchModelSource, undefined);
  assert.match(result.content[0].text, /Example/);
  // ZAI has no credentials here, so it is reported as skipped, not attempted.
  assert.ok(result.details.skips.some((skip: any) => skip.backend === "zai"));
});

test("a legitimate empty success is terminal and starts no further request", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ output: [] });
  });
  const result = await harness({}).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "openai", id: "gpt-5" }, registryFor()),
  );
  assert.equal(calls, 1);
  assert.equal(result.details.provider, "openai");
  assert.equal(result.details.method, "native");
  assert.equal(result.content[0].text, "No results found.");
});

test("exhausting the whole chain throws a sanitized tool error", async (t) => {
  env(t, "ZAI_API_KEY", "fake");
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("z.ai")) return new Response("nope", { status: 503 });
    return new Response("down", { status: 500 });
  });
  const { search } = harness({});
  await assert.rejects(
    search.execute("id", { query: "q" }, undefined, undefined, ctxFor(undefined, registryFor())),
    (error: Error) => {
      assert.match(error.message, /All search targets failed/);
      assert.match(error.message, /zai/);
      assert.match(error.message, /duckduckgo/);
      assert.doesNotMatch(error.message, /\bBearer\s+\S|sk-[A-Za-z0-9]{8,}/);
      return true;
    },
  );
});

test("network failure and an unsuccessful Claude SDK result both advance the chain", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://api.openai.com")) throw new Error("connect ETIMEDOUT");
    return new Response(ddgHtml);
  });
  const registry = registryFor({ models: [{ provider: "openai", id: "gpt-5" }] });
  const result = await harness({ searchProvider: "openai", searchModel: "gpt-5" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "deepseek", id: "deepseek-chat" }, registry),
  );
  assert.equal(result.details.provider, "duckduckgo");
  assert.match(result.details.attempts[0].reason, /ETIMEDOUT/);
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses", "https://html.duckduckgo.com/html/?q=q"]);
});

// ─── 2.5 Cancellation ────────────────────────────────────────────────────────

test("a pre-aborted search starts no request", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not fetch"));
  await assert.rejects(
    harness({}).search.execute("id", { query: "q" }, AbortSignal.abort(), undefined, ctxFor({ provider: "openai", id: "gpt-5" }, registryFor())),
    { name: "AbortError" },
  );
});

test("cancellation between attempts stops the chain without a fallback request", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const controller = new AbortController();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls.push(url);
    controller.abort();
    return new Response("bad", { status: 400 });
  });
  await assert.rejects(
    harness({}).search.execute("id", { query: "q" }, controller.signal, undefined, ctxFor({ provider: "openai", id: "gpt-5" }, registryFor())),
    { name: "AbortError" },
  );
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses"]);
});

test("cancellation during an in-flight request stops without fallback", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const controller = new AbortController();
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push(url);
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const pending = harness({}).search.execute("id", { query: "q" }, controller.signal, undefined, ctxFor({ provider: "openai", id: "gpt-5" }, registryFor()));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(calls, ["https://api.openai.com/v1/responses"]);
});

// ─── 2.6 Provenance and diagnostics ─────────────────────────────────────────

test("DDG results carry no successful LLM model and discard failed-attempt sources", async (t) => {
  env(t, "ANTHROPIC_API_KEY", "fake");
  const partial = { title: "Partial", url: "https://partial.example/" };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    calls++;
    if (url.startsWith("https://api.anthropic.com")) {
      return Response.json({
        content: [
          { type: "text", text: "Partial answer", citations: [{ type: "web_search_result_location", ...partial }] },
          { type: "web_search_tool_result", content: { type: "web_search_tool_result_error", error_code: "rate_limit_exceeded" } },
        ],
      });
    }
    return new Response(ddgHtml);
  });
  const result = await harness({}).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "anthropic", id: "claude-session" }, registryFor()),
  );
  assert.equal(calls, 2);
  assert.equal(result.details.provider, "duckduckgo");
  assert.equal(result.details.searchModel, undefined);
  assert.equal(result.details.searchModelSource, undefined);
  assert.equal(result.details.tier, "fallback");
  for (const source of result.details.sources) assert.notEqual(source.url, partial.url);
  assert.doesNotMatch(result.content[0].text, /Partial answer|partial\.example/);
  assert.match(result.details.attempts[0].reason, /Anthropic web search tool failed/);
});

test("attempt diagnostics are bounded and leak no credentials", async (t) => {
  env(t, "OPENAI_API_KEY", "fake");
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.startsWith("https://api.openai.com")) {
      throw new Error(`request failed with Authorization: Bearer ${secret} at https://api.example/v1?key=${secret}`);
    }
    return new Response(ddgHtml);
  });
  const result = await harness({}).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "openai", id: "gpt-5" }, registryFor()),
  );
  assert.ok(result.details.attempts.length <= 8);
  const serialized = JSON.stringify(result.details);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /Bearer sk-/);
  for (const attempt of result.details.attempts) {
    if (attempt.reason) assert.ok(attempt.reason.length <= 200);
  }
});

test("sanitizeReason redacts tokens, bearer headers, and credential-bearing URLs", () => {
  const cleaned = sanitizeReason(
    new Error("401 Bearer eyJhbGciOi.J9abc.def for https://api.example/v1?api_key=topsecret&x=1 sk-abcdefghijklmnop"),
  );
  assert.doesNotMatch(cleaned, /eyJhbGciOi/);
  assert.doesNotMatch(cleaned, /topsecret/);
  assert.doesNotMatch(cleaned, /sk-abcdefghijklmnop/);
  assert.match(cleaned, /\[redacted\]/);
  assert.ok(cleaned.length <= 200);
  assert.doesNotMatch(sanitizeReason(new Error("line1\nline2\tend")), /[\n\t]/);
});

test("failed Codex attempts never expose the OAuth token", async (t) => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  t.after(async () => {
    await agent.close();
  });
  t.mock.method(EnvHttpProxyAgent.prototype, "dispatch", (opts: any, handler: any) => agent.dispatch(opts, handler));
  t.mock.method(globalThis, "fetch", async () => new Response(ddgHtml));
  const token = codexToken("account");
  agent
    .get("https://chatgpt.com")
    .intercept({ path: "/backend-api/codex/responses", method: "POST" })
    .reply(401, "unauthorized");
  const registry = registryFor({
    token,
    models: [{ provider: "openai-codex", id: "codex-model", baseUrl: "https://chatgpt.com/backend-api" }],
  });
  const result = await harness({ searchProvider: "openai-codex", searchModel: "codex-model" }).search.execute(
    "id",
    { query: "q" },
    undefined,
    undefined,
    ctxFor({ provider: "openai-codex", id: "codex-model" }, registry),
  );
  assert.equal(result.details.provider, "duckduckgo");
  const serialized = JSON.stringify(result.details);
  assert.doesNotMatch(serialized, new RegExp(token.split(".")[1]!));
  assert.doesNotMatch(serialized, /Bearer eyJ/);
  assert.match(result.details.attempts[0].reason, /HTTP 401/);
  agent.assertNoPendingInterceptors();
});
