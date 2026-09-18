import assert from "node:assert/strict";
import test from "node:test";
import { chatgptSearch, codexResponsesUrl, parseSearchOutput, readSearchStream } from "../extensions/chatgpt-search.ts";

const token = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
})).toString("base64url")}.signature`;
const search = { type: "web_search_call", status: "completed", action: { sources: [
  { url: "https://pi.dev/", title: "Pi" }, { url: "https://example.com/" },
] } };
const message = { type: "message", content: [
  { type: "output_text", text: "搜索结果", annotations: [
    { type: "url_citation", url: "https://pi.dev/", title: "Pi official" },
  ] },
  { type: "output_text", text: "Second block" },
] };
function context(resolve: () => Promise<any> = async () => ({ ok: true, apiKey: token })): any {
  return {
    model: { provider: "openai-codex", id: "selected-model", baseUrl: "https://chatgpt.com/backend-api" },
    modelRegistry: { getApiKeyAndHeaders: resolve },
  };
}
function sse(events: unknown[], chunkSize = 7, separator = "\r\n", trailing = true): Response {
  const raw = events.map((e) => `event: ignored${separator}data: ${JSON.stringify(e)}`).join(separator + separator)
    + (trailing ? separator + separator : "");
  const bytes = new TextEncoder().encode(raw);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + chunkSize));
    offset += chunkSize;
  } }), { headers: { "content-type": "text/event-stream" } });
}
function completed(output = [search, message]) {
  return { type: "response.completed", response: { status: "completed", output } };
}

test("normalizes Codex URLs", () => {
  for (const base of ["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex/", "https://chatgpt.com/backend-api/codex/responses/"]) {
    assert.equal(codexResponsesUrl(base), "https://chatgpt.com/backend-api/codex/responses");
  }
});

test("uses current model, fresh Pi OAuth, Codex headers and native web_search, not public API", async () => {
  let resolutions = 0;
  const ctx = context(async () => { resolutions++; return { ok: true, apiKey: token }; });
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), `Bearer ${token}`);
    assert.equal(headers.get("chatgpt-account-id"), "test-account");
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, "selected-model");
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.tool_choice, "required");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.deepEqual(body.include, ["web_search_call.action.sources"]);
    assert.equal(body.input[0].content[0].text, "query");
    return sse([completed()]);
  };
  const result = await chatgptSearch("query", ctx, undefined, fakeFetch);
  assert.match(result.text, /搜索结果/);
  assert.match(result.text, /Second block/);
  assert.deepEqual(result.sources, [
    { title: "Pi official", url: "https://pi.dev/" },
    { title: "example.com", url: "https://example.com/" },
  ]);
  await chatgptSearch("query", ctx, undefined, fakeFetch);
  assert.equal(resolutions, 2, "must not cache access tokens in the extension");
});

test("honors Pi's resolved base URL and headers", async () => {
  const ctx = context(async () => ({ ok: true, apiKey: token, baseUrl: "https://configured.example/codex", headers: { "x-custom": "yes" } }));
  await chatgptSearch("q", ctx, undefined, async (url, init) => {
    assert.equal(url, "https://configured.example/codex/responses");
    assert.equal(new Headers(init?.headers).get("x-custom"), "yes");
    return sse([completed()]);
  });
});

test("explicit search model controls request, auth, headers and endpoint without changing session", async () => {
  const ctx = context();
  const current = ctx.model;
  const target = { ...current, id: "search-model", baseUrl: "https://search.example/codex", headers: { "x-model": "search" } };
  ctx.modelRegistry.getApiKeyAndHeaders = async (model: unknown) => {
    assert.equal(model, target);
    return { ok: true, apiKey: token, headers: { "x-resolved": "target" } };
  };
  const result = await chatgptSearch("q", ctx, undefined, async (url, init) => {
    assert.equal(url, "https://search.example/codex/responses");
    assert.equal(JSON.parse(init?.body as string).model, "search-model");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-model"), "search");
    assert.equal(headers.get("x-resolved"), "target");
    return sse([completed()]);
  }, target);
  assert.equal(result.sources.length, 2);
  assert.equal(ctx.model, current);
  assert.equal(current.id, "selected-model");
});

test("missing or invalid OAuth never sends a request or exposes credentials", async () => {
  for (const resolution of [{ ok: false, error: "secret-error" }, { ok: true }, { ok: true, apiKey: "secret-token" }]) {
    await assert.rejects(chatgptSearch("q", context(async () => resolution), undefined, async () => {
      assert.fail("must not fetch");
    }), (e: Error) => {
      assert.match(e.message, /ChatGPT/);
      assert.doesNotMatch(e.message, /secret/);
      return true;
    });
  }
});

for (const status of [400, 401, 403, 429, 500]) {
  test(`HTTP ${status} is explicit and does not leak server bodies`, async () => {
    await assert.rejects(chatgptSearch("q", context(), undefined, async () => new Response("secret-token", { status })), (e: Error) => {
      assert.match(e.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(e.message, /secret-token/);
      return true;
    });
  });
}

test("SSE handles UTF-8 byte splits, CRLF, item.done and completion without output", async () => {
  const result = await readSearchStream(sse([
    { type: "response.output_item.done", item: search },
    { type: "response.output_item.done", item: message },
    { type: "response.completed", response: { status: "completed" } },
  ], 1));
  assert.match(result.text, /搜索结果/);
  assert.equal(result.sources.length, 2);
});

test("Codex completion with empty output preserves done items; repeated final items are deduplicated", async () => {
  for (const finalItems of [[], [search, message]]) {
    const result = await readSearchStream(sse([
      { type: "response.output_item.done", item: search },
      { type: "response.output_item.done", item: message },
      completed(finalItems as any),
    ]));
    assert.equal(result.text.match(/搜索结果/g)?.length, 1);
    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0]?.title, "Pi official");
  }
});

test("auth failures are sanitized and cancellation stops waiting for refresh", async () => {
  await assert.rejects(chatgptSearch("q", context(async () => { throw new Error("secret-refresh-token"); })), /authentication unavailable/);
  const controller = new AbortController();
  const pending = chatgptSearch("q", context(() => new Promise(() => {})), controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("SSE accepts a final frame without a trailing blank line", async () => {
  assert.equal((await readSearchStream(sse([completed()], 13, "\n", false))).sources.length, 2);
});

for (const type of ["response.failed", "response.incomplete", "error"]) {
  test(`SSE rejects ${type}, even after partial text`, async () => {
    await assert.rejects(readSearchStream(sse([
      { type: "response.output_item.done", item: message },
      { type, error: { message: "secret-error" } },
    ])), (e: Error) => {
      assert.match(e.message, /failed/);
      assert.doesNotMatch(e.message, /secret-error/);
      return true;
    });
  });
}

test("SSE rejects early EOF, malformed JSON, and answers without actual search", async () => {
  await assert.rejects(readSearchStream(sse([{ type: "response.output_item.done", item: search }])), /before completion/);
  await assert.rejects(readSearchStream(new Response("data: not-json\n\n")), /Invalid/);
  await assert.rejects(readSearchStream(sse([completed([message] as any)])), /no completed web search/);
  assert.throws(() => parseSearchOutput([{ ...search, status: "failed" }, message]), /no completed/);
});

test("pre-aborted calls do not resolve auth or fetch", async () => {
  const signal = AbortSignal.abort();
  await assert.rejects(chatgptSearch("q", context(async () => assert.fail("must not resolve")), signal), { name: "AbortError" });
});

test("cancellation interrupts a stalled SSE reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = readSearchStream(response, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});
