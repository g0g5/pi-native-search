import assert from "node:assert/strict";
import test from "node:test";
import {
  describeTarget,
  planSearchTargets,
  type AuthReadiness,
  type RoutingInput,
  type RoutingModel,
} from "../extensions/search-routing.ts";

const BASE = { enabled: true, searchEnabled: true, fetchEnabled: true };

function model(provider: string, id: string, baseUrl?: string): RoutingModel {
  return { provider, id, ...(baseUrl ? { baseUrl } : {}) };
}

interface Options {
  config?: Record<string, unknown>;
  sessionModel?: RoutingModel;
  models?: Partial<Record<string, RoutingModel[]>>;
  readiness?: (backend: string, model?: RoutingModel) => AuthReadiness;
}

function plan(options: Options = {}) {
  const input: RoutingInput = {
    config: { ...BASE, ...(options.config ?? {}) } as RoutingInput["config"],
    sessionModel: options.sessionModel,
    models: options.models ?? {},
    readiness: (options.readiness ?? (() => "ready")) as RoutingInput["readiness"],
  };
  return planSearchTargets(input);
}

/** Compact "backend/model:tier" labels for order assertions. */
function labels(result: ReturnType<typeof planSearchTargets>): string[] {
  return result.candidates.map(
    (target) => `${target.backend}${target.model ? `/${target.model.id}` : ""}:${target.tier}`,
  );
}

test("no active model falls back to ZAI then DuckDuckGo", () => {
  const result = plan();
  assert.deepEqual(labels(result), ["zai:fallback", "duckduckgo:fallback"]);
  assert.equal(result.error, undefined);
  assert.ok(result.skips.some((skip) => skip.reason.includes("No active conversation model")));
});

test("authenticated non-LLM backends precede DuckDuckGo for any conversation provider", () => {
  for (const provider of ["deepseek", "openrouter", "mistral"]) {
    const result = plan({ sessionModel: model(provider, "chat-model") });
    assert.deepEqual(labels(result), ["zai:fallback", "duckduckgo:fallback"], provider);
  }
});

test("missing ZAI credentials skip that backend", () => {
  const result = plan({ readiness: (backend) => (backend === "zai" ? "missing" : "ready") });
  assert.deepEqual(labels(result), ["duckduckgo:fallback"]);
  assert.ok(result.skips.some((skip) => skip.backend === "zai" && skip.reason.includes("credentials")));
});

test("global target wins across providers without touching the conversation model", () => {
  const sessionModel = model("deepseek", "deepseek-chat");
  const result = plan({
    config: { searchProvider: "openai", searchModel: "gpt-5" },
    sessionModel,
    models: { openai: [model("openai", "gpt-5")] },
  });
  assert.deepEqual(labels(result), ["openai/gpt-5:configured", "zai:fallback", "duckduckgo:fallback"]);
  assert.equal(sessionModel.id, "deepseek-chat");
});

test("a missing global model skips the pinned tier and uses the session model", () => {
  const result = plan({
    config: { searchProvider: "openai" },
    sessionModel: model("anthropic", "claude-sonnet-4-5", "https://anthropic.example"),
    models: { openai: [model("openai", "gpt-5")] },
  });
  assert.deepEqual(labels(result), ["anthropic/claude-sonnet-4-5:session", "zai:fallback", "duckduckgo:fallback"]);
  assert.ok(result.skips.some((skip) => skip.backend === "openai" && skip.reason.includes("No model configured")));
});

test("a blank global model is treated as omitted", () => {
  const result = plan({
    config: { searchProvider: "openai", searchModel: "   " },
    sessionModel: model("openai", "session-model"),
    models: { openai: [model("openai", "session-model")] },
  });
  assert.deepEqual(labels(result), ["openai/session-model:session", "zai:fallback", "duckduckgo:fallback"]);
});

test("an unregistered pinned model is a configuration error before any attempt", () => {
  const result = plan({
    config: { searchProvider: "openai", searchModel: "gpt-unknown" },
    sessionModel: model("openai", "gpt-5"),
    models: { openai: [model("openai", "gpt-5")] },
  });
  assert.match(result.error!, /not registered for backend "openai"/);
  assert.deepEqual(result.candidates, []);
});

test("a model registered under another provider is rejected", () => {
  const result = plan({
    config: { searchProvider: "openai", searchModel: "claude-sonnet-4-5" },
    models: { anthropic: [model("anthropic", "claude-sonnet-4-5")] },
  });
  assert.match(result.error!, /not registered for backend "openai"/);
  assert.deepEqual(result.candidates, []);
});

test("a pinned non-LLM backend is selected first and never repeated", () => {
  // Pinning DuckDuckGo makes it the first target; ZAI stays eligible after it,
  // and DuckDuckGo itself is not retried later in the chain.
  const duck = plan({ config: { searchProvider: "duckduckgo" } });
  assert.deepEqual(labels(duck), ["duckduckgo:configured", "zai:fallback"]);
  assert.equal(duck.candidates.filter((target) => target.backend === "duckduckgo").length, 1);
  const zai = plan({ config: { searchProvider: "zai" } });
  assert.deepEqual(labels(zai), ["zai:configured", "duckduckgo:fallback"]);
  assert.equal(zai.candidates.filter((target) => target.backend === "zai").length, 1);
  assert.ok(zai.skips.some((skip) => skip.backend === "zai" && skip.reason.includes("Already selected")));
});

test("a pinned non-LLM backend without credentials falls through", () => {
  const result = plan({
    config: { searchProvider: "zai" },
    readiness: (backend) => (backend === "zai" ? "missing" : "ready"),
  });
  assert.deepEqual(labels(result), ["duckduckgo:fallback"]);
  assert.equal(result.skips.filter((skip) => skip.backend === "zai").length, 1);
});

test("an explicitly pinned non-LLM backend does not require a model", () => {
  const result = plan({ config: { searchProvider: "duckduckgo", searchModel: undefined } });
  assert.equal(result.candidates[0]?.model, undefined);
  assert.equal(result.candidates[0]?.kind, "non-llm");
});

test("identical configured and session targets are attempted once", () => {
  const shared = model("openai", "gpt-5");
  const result = plan({
    config: { searchProvider: "openai", searchModel: "gpt-5" },
    sessionModel: shared,
    models: { openai: [shared] },
  });
  assert.deepEqual(labels(result), ["openai/gpt-5:configured", "zai:fallback", "duckduckgo:fallback"]);
  assert.equal(result.candidates.filter((target) => target.backend === "openai").length, 1);
  assert.ok(result.skips.some((skip) => skip.reason.includes("Already selected")));
});

test("distinct models on the same provider both remain candidates", () => {
  const result = plan({
    config: { searchProvider: "openai", searchModel: "gpt-5" },
    sessionModel: model("openai", "gpt-4o"),
    models: { openai: [model("openai", "gpt-5"), model("openai", "gpt-4o")] },
  });
  assert.deepEqual(labels(result), [
    "openai/gpt-5:configured",
    "openai/gpt-4o:session",
    "zai:fallback",
    "duckduckgo:fallback",
  ]);
});

test("other authenticated LLM providers are never selected automatically", () => {
  const result = plan({
    sessionModel: model("deepseek", "deepseek-chat"),
    models: {
      openai: [model("openai", "gpt-5")],
      anthropic: [model("anthropic", "claude-sonnet-4-5")],
      google: [model("google", "gemini-2.5-pro")],
    },
    readiness: () => "ready",
  });
  assert.deepEqual(labels(result), ["zai:fallback", "duckduckgo:fallback"]);
  assert.equal(result.candidates.some((target) => target.kind === "llm"), false);
});

test("a conversation provider without an implemented backend is reported as skipped", () => {
  const result = plan({ sessionModel: model("deepseek", "deepseek-chat") });
  assert.ok(
    result.skips.some(
      (skip) => skip.backend === "deepseek" && skip.reason.includes("no implemented search backend"),
    ),
  );
});

test("an active Claude Bridge model is used with its exact conversation model", () => {
  const result = plan({
    sessionModel: model("claude-bridge", "claude-sonnet-4-5"),
    readiness: (_backend, target) => (target ? "deferred" : "ready"),
  });
  assert.equal(result.candidates[0]?.backend, "claude-bridge");
  assert.equal(result.candidates[0]?.model?.id, "claude-sonnet-4-5");
  assert.equal(result.candidates[0]?.tier, "session");
  assert.deepEqual(labels(result), [
    "claude-bridge/claude-sonnet-4-5:session",
    "zai:fallback",
    "duckduckgo:fallback",
  ]);
});

test("an active model without credentials is skipped, not attempted", () => {
  const result = plan({
    sessionModel: model("openai", "gpt-5"),
    readiness: (backend) => (backend === "openai" ? "missing" : "ready"),
  });
  assert.deepEqual(labels(result), ["zai:fallback", "duckduckgo:fallback"]);
  assert.ok(result.skips.some((skip) => skip.backend === "openai" && skip.modelId === "gpt-5"));
});

test("every skip diagnostic carries a non-empty reason and no credentials", () => {
  const result = plan({
    config: { searchProvider: "openai" },
    sessionModel: model("deepseek", "deepseek-chat"),
    readiness: (backend) => (backend === "zai" ? "missing" : "ready"),
  });
  assert.ok(result.skips.length > 0);
  for (const skip of result.skips) {
    assert.equal(typeof skip.reason, "string");
    assert.ok(skip.reason.length > 0);
    assert.doesNotMatch(skip.reason, /\bsk-[A-Za-z0-9]|Bearer\s+[A-Za-z0-9]/);
  }
});

test("describeTarget distinguishes configured, session, MCP, and DuckDuckGo targets", () => {
  const [configured] = plan({
    config: { searchProvider: "openai", searchModel: "gpt-5" },
    models: { openai: [model("openai", "gpt-5")] },
  }).candidates;
  const [session] = plan({ sessionModel: model("openai", "gpt-5") }).candidates;
  const [mcp] = plan({ config: { searchProvider: "zai" } }).candidates;
  const [duck] = plan({ config: { searchProvider: "duckduckgo" } }).candidates;
  assert.equal(describeTarget(configured!), "openai/gpt-5");
  assert.equal(describeTarget(session!), "openai/gpt-5 (session)");
  assert.equal(describeTarget(mcp!), "zai:mcp");
  assert.equal(describeTarget(duck!), "duckduckgo");
});
