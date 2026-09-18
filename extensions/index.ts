/**
 * Pi Search Extension
 *
 * Adds web_search and web_fetch tools to pi.
 *
 * Search routing is independent of the conversation provider. Targets are
 * considered in order: a globally configured backend, the active conversation
 * LLM model when its provider has an implemented search backend, authenticated
 * non-LLM backends (ZAI MCP), then DuckDuckGo. Each attempt is target-scoped:
 * the selected backend's own credentials and endpoints are used, never the
 * conversation provider's.
 *
 * web_fetch always uses one direct HTTP implementation, regardless of the
 * conversation provider or the configured search backend.
 *
 * Usage:
 *   /search            - Configure global switches, backend, and model
 *   /search providers  - Show implemented search backends and readiness
 *   /search config     - Show session, planned target, and fallback chain
 *   /search on|off     - Quick global toggle
 *
 * Config persists in ~/.pi/agent/search-config.json
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chatgptSearch } from "./chatgpt-search.ts";
import { formatSearchResult, parseAnthropicSearch, parseGoogleSearch, parseResponsesSearch, type SearchResult } from "./search-result.ts";
import {
  loadSearchConfig,
  saveSearchConfig,
  searchBlocked,
  fetchBlocked,
  type ConfigState,
  type SearchConfig,
} from "./search-config.ts";
import {
  planSearchTargets,
  describeTarget,
  type AuthReadiness,
  type RoutingModel,
  type SearchPlan,
  type SearchTarget,
  type SkipDiagnostic,
  type TargetTier,
} from "./search-routing.ts";
import {
  SEARCH_BACKENDS,
  SEARCH_BACKEND_IDS,
  backendName,
  isLlmBackend,
  type SearchBackendId,
} from "./search-providers.ts";
import {
  getAgentDir,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
  type SelectItem,
  SelectList,
} from "@earendil-works/pi-tui";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";

const AUTOMATIC = "automatic";
const MAX_REASON_BYTES = 200;
const MAX_ATTEMPT_HISTORY = 8;
const MAX_VISIBLE_ITEMS = 16;

// ─── Credentials ─────────────────────────────────────────────────────────────

function getApiKey(provider: string): string | undefined {
  const backend = SEARCH_BACKENDS[provider as SearchBackendId];
  if (!backend?.envKey) return undefined;
  const key = process.env[backend.envKey];
  if (key) return key;
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (existsSync(authPath)) {
      const entry = JSON.parse(readFileSync(authPath, "utf-8"))[provider];
      if (entry?.type === "api_key" && entry.key && !entry.key.startsWith("!"))
        return entry.key;
    }
  } catch {}
  return undefined;
}

/** Pi-managed OAuth credentials are stored in auth.json, not this config. */
function hasOAuthEntry(provider: string): boolean {
  try {
    const authPath = join(getAgentDir(), "auth.json");
    if (!existsSync(authPath)) return false;
    const entry = JSON.parse(readFileSync(authPath, "utf-8"))[provider];
    return entry?.type === "oauth" && !!entry.refresh;
  } catch {
    return false;
  }
}

interface RegisteredModel extends RoutingModel {
  name?: string;
}

function registeredModels(backend: SearchBackendId, ctx: ExtensionContext): RegisteredModel[] {
  const all = ctx.modelRegistry?.getAll?.() ?? [];
  return all
    .filter((model) => model.provider === backend)
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.name ? { name: model.name } : {}),
    }));
}

function resolveRegisteredModel(target: SearchTarget, ctx: ExtensionContext) {
  const model = target.model;
  if (!model) return undefined;
  if (ctx.model?.provider === target.backend && ctx.model.id === model.id) return ctx.model;
  return ctx.modelRegistry?.find?.(target.backend, model.id);
}

/**
 * Credential readiness for a candidate. Codex readiness is evaluated for the
 * selected registered model; Claude Bridge has no reliable synchronous probe,
 * so its readiness is deferred until the SDK is actually invoked.
 */
function backendReadiness(
  backend: SearchBackendId,
  model: RoutingModel | undefined,
  ctx: ExtensionContext,
): AuthReadiness {
  switch (SEARCH_BACKENDS[backend].auth) {
    case "none":
      return "ready";
    case "cli-subscription":
      return "deferred";
    case "pi-oauth": {
      const resolved =
        model && ctx.model?.provider === backend && ctx.model.id === model.id
          ? ctx.model
          : model
            ? ctx.modelRegistry?.find?.(backend, model.id)
            : undefined;
      if (!resolved) return "missing";
      return ctx.modelRegistry?.hasConfiguredAuth?.(resolved) ? "ready" : "missing";
    }
    case "api-key":
      return getApiKey(backend) || hasOAuthEntry(backend) ? "ready" : "missing";
  }
}

/** Readiness used for provider listings, without a specific model selected. */
function overviewReadiness(backend: SearchBackendId, ctx: ExtensionContext): AuthReadiness {
  if (SEARCH_BACKENDS[backend].auth === "pi-oauth") {
    const models = registeredModels(backend, ctx);
    return models.some((model) => backendReadiness(backend, model, ctx) === "ready")
      ? "ready"
      : "missing";
  }
  return backendReadiness(backend, undefined, ctx);
}

function readinessLabel(readiness: AuthReadiness): string {
  switch (readiness) {
    case "ready":
      return "ready";
    case "missing":
      return "not configured";
    case "deferred":
      return "checked at call time";
  }
}

// ─── Planning ────────────────────────────────────────────────────────────────

function planFor(ctx: ExtensionContext, config: SearchConfig): SearchPlan {
  const models: Partial<Record<string, RoutingModel[]>> = {};
  for (const backend of SEARCH_BACKEND_IDS) {
    if (SEARCH_BACKENDS[backend].kind === "llm") models[backend] = registeredModels(backend, ctx);
  }
  const sessionModel: RoutingModel | undefined = ctx.model
    ? {
        provider: ctx.model.provider,
        id: ctx.model.id,
        ...(ctx.model.baseUrl ? { baseUrl: ctx.model.baseUrl } : {}),
      }
    : undefined;
  return planSearchTargets({
    config,
    sessionModel,
    models,
    readiness: (backend, model) => backendReadiness(backend, model, ctx),
  });
}

// ─── ZAI MCP Web Search ──────────────────────────────────────────────────────

const ZAI_MCP_URL = "https://api.z.ai/api/mcp/web_search_prime/mcp";

interface McpSession {
  sessionId: string;
}

async function mcpInit(apiKey: string, signal?: AbortSignal): Promise<McpSession> {
  const res = await fetch(ZAI_MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "pi-search", version: "0.1.0" },
      },
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`ZAI MCP initialize failed (HTTP ${res.status}).`);
  }
  const sessionId = res.headers.get("Mcp-Session-Id");
  if (!sessionId) throw new Error("ZAI MCP returned no session ID.");
  return { sessionId };
}

async function mcpCall<T = any>(
  session: McpSession,
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
  id: number,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(ZAI_MCP_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session.sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`ZAI MCP ${method} failed (HTTP ${res.status}).`);
  }
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = JSON.parse(line.slice(5).trim());
    if (json.error) throw new Error(`ZAI MCP returned an error: ${json.error.message}`);
    return json.result as T;
  }
  throw new Error("ZAI MCP returned no data.");
}

async function zaiSearch(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const session = await mcpInit(apiKey, signal);
  const result = (await mcpCall(
    session,
    apiKey,
    "tools/call",
    {
      name: "web_search_prime",
      arguments: { search_query: query },
    },
    2,
    signal,
  )) as any;

  const content = result?.content?.[0]?.text;
  if (!content) return "No results found.";

  let parsed: unknown = content;
  for (let i = 0; i < 3; i++) {
    if (typeof parsed !== "string") break;
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }

  if (!Array.isArray(parsed))
    return typeof parsed === "string" ? parsed : "No results found.";

  const results = parsed as {
    title: string;
    link: string;
    content: string;
    refer: string;
  }[];
  if (!results.length) return "No results found.";

  const parts: string[] = [];
  for (let i = 0; i < Math.min(results.length, 8); i++) {
    const r = results[i]!;
    parts.push(`${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.content}`);
  }
  return parts.join("\n\n");
}

// ─── Anthropic Web Search ─────────────────────────────────────────────────────

async function anthropicSearch(
  query: string,
  model: string,
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const url = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}/v1/messages`
    : "https://api.anthropic.com/v1/messages";
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Anthropic search failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as any;

  return parseAnthropicSearch(data);
}

// ─── Other Native Search ─────────────────────────────────────────────────────

async function googleSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Google search failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as any;
  return parseGoogleSearch(data);
}

async function openaiSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      input: query,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`OpenAI search failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as any;
  return parseResponsesSearch(data.output, { searchSources: true });
}

async function xaiSearch(
  query: string,
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult> {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      tools: [{ type: "web_search" }],
      input: query,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`xAI search failed (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as any;
  return parseResponsesSearch(data.output, { citations: data.citations, numericTitles: true });
}

// ─── Claude Code (via claude-agent-sdk) ─────────────────────────────────────
//
// Delegates web_search to a one-shot Claude Code query with WebSearch enabled.
// Reuses the SDK that ships inside pi-claude-bridge so we don't need a separate
// install. Auth comes from the `claude` CLI's own subscription credentials.

let cachedSdkModule: any = null;

async function loadClaudeAgentSdk(): Promise<any> {
  if (cachedSdkModule) return cachedSdkModule;
  const candidates = [
    // Windows global npm
    join(
      homedir(),
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "pi-claude-bridge",
      "package.json",
    ),
    // Unix global npm
    "/usr/local/lib/node_modules/pi-claude-bridge/package.json",
    "/usr/lib/node_modules/pi-claude-bridge/package.json",
    join(
      homedir(),
      ".npm-global",
      "lib",
      "node_modules",
      "pi-claude-bridge",
      "package.json",
    ),
    // Pi's own extensions dir if user installed locally
    join(getAgentDir(), "extensions", "pi-claude-bridge", "package.json"),
  ];
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    try {
      const req = createRequire(cand);
      const sdkPath = req.resolve("@anthropic-ai/claude-agent-sdk");
      cachedSdkModule = await import(pathToFileURL(sdkPath).href);
      return cachedSdkModule;
    } catch {}
  }
  throw new Error(
    "Could not locate @anthropic-ai/claude-agent-sdk. Is pi-claude-bridge installed?",
  );
}

async function claudeBridgeSearch(
  query: string,
  signal?: AbortSignal,
  model?: string,
): Promise<string> {
  const sdk = await loadClaudeAgentSdk();
  const sdkQuery = sdk.query({
    prompt:
      `Search the web for: ${query}\n\n` +
      "Use the WebSearch tool. Report results as a numbered list with title, " +
      "URL, and a brief snippet from each result. Do not add commentary beyond " +
      "what the search returned.",
    options: {
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      allowedTools: ["WebSearch"],
      ...(model ? { model } : {}),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: [],
    },
  });

  const onAbort = () => {
    sdkQuery.interrupt().catch(() => {});
    try {
      sdkQuery.close();
    } catch {}
  };
  if (signal?.aborted) {
    onAbort();
    throw new Error("Aborted");
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  let responseText = "";
  let failure: string | undefined;
  try {
    for await (const message of sdkQuery) {
      signal?.throwIfAborted();
      if (message.type !== "result") continue;
      if (message.subtype === "success") {
        if (typeof message.result === "string" && message.result.trim()) {
          responseText = message.result;
        }
      } else {
        // Unsuccessful SDK termination is an error, never an empty success.
        failure = `Claude Bridge search failed (${message.subtype ?? "error"}).`;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      sdkQuery.close();
    } catch {}
  }
  if (signal?.aborted) signal.throwIfAborted();
  if (responseText) return responseText;
  throw new Error(failure ?? "Claude Bridge search returned no content.");
}

// ─── DuckDuckGo Fallback ─────────────────────────────────────────────────────

function extractDdgUrl(raw: string): string {
  const uddg = raw.match(/[?&]uddg=([^&]+)/)?.[1];
  if (uddg) {
    try {
      return decodeURIComponent(uddg);
    } catch {}
  }
  if (raw.startsWith("//")) return `https:${raw}`;
  return raw;
}

async function ddgSearch(query: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)" },
    },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`DuckDuckGo search failed (HTTP ${res.status}).`);
  }
  const html = await res.text();
  const titles: { url: string; title: string }[] = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  const tr = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = tr.exec(html)) && titles.length < 8)
    titles.push({
      url: extractDdgUrl(m[1]!),
      title: m[2]!.replace(/<[^>]+>/g, "").trim(),
    });
  const sr = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = sr.exec(html)) && snippets.length < 8)
    snippets.push(m[1]!.replace(/<[^>]+>/g, "").trim());
  const results: string[] = [];
  for (let i = 0; i < titles.length; i++) {
    results.push(
      `${i + 1}. **${titles[i]!.title}**\n   ${titles[i]!.url}${snippets[i] ? `\n   ${snippets[i]}` : ""}`,
    );
  }
  return results.join("\n\n") || `No results found for "${query}".`;
}

// ─── Web Fetch ────────────────────────────────────────────────────────────────
// One direct HTTP implementation for every conversation provider and search
// backend. It resolves no search credentials and never invokes an LLM.

async function httpFetch(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PiSearch/1.0)",
      Accept: "text/html,text/plain,application/json",
    },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Fetch ${res.status} ${res.statusText}`);
  }
  const ct = res.headers.get("content-type") || "";
  let text = ct.includes("application/json")
    ? JSON.stringify(await res.json(), null, 2)
    : await res.text();
  if (ct.includes("text/html"))
    text = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const first = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!first.truncated) return text;
  // Reserve room for the notice so total output stays inside the documented limits.
  const notice = `\n\n[Truncated: ${first.outputLines}/${first.totalLines} lines]`;
  const bounded = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice),
    maxLines: DEFAULT_MAX_LINES - (notice.split("\n").length - 1),
  });
  return bounded.content + notice;
}

// ─── Target-scoped dispatch ──────────────────────────────────────────────────

function requireApiKey(backend: SearchBackendId): string {
  const key = getApiKey(backend);
  if (!key) throw new Error(`${backendName(backend)} credentials are not configured.`);
  return key;
}

function requireModelId(target: SearchTarget): string {
  const id = target.model?.id;
  if (!id) throw new Error(`No model is selected for ${target.backend}.`);
  return id;
}

/**
 * Perform exactly one attempt for one target. Adapters throw on failure and
 * never choose a fallback themselves. Every request input is derived from the
 * target, never from the unrelated conversation provider.
 */
async function attemptSearch(
  query: string,
  target: SearchTarget,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SearchResult> {
  signal?.throwIfAborted();
  switch (target.backend) {
    case "zai": {
      const apiKey = requireApiKey("zai");
      signal?.throwIfAborted();
      return { text: await zaiSearch(query, apiKey, signal), sources: [] };
    }
    case "duckduckgo":
      return { text: await ddgSearch(query, signal), sources: [] };
    case "google": {
      const apiKey = requireApiKey("google");
      signal?.throwIfAborted();
      return googleSearch(query, requireModelId(target), apiKey, signal);
    }
    case "openai": {
      const apiKey = requireApiKey("openai");
      signal?.throwIfAborted();
      return openaiSearch(query, requireModelId(target), apiKey, signal);
    }
    case "xai": {
      const apiKey = requireApiKey("xai");
      signal?.throwIfAborted();
      return xaiSearch(query, requireModelId(target), apiKey, signal);
    }
    case "anthropic": {
      const apiKey = requireApiKey("anthropic");
      signal?.throwIfAborted();
      // Base URL belongs to the selected target model, not the session model.
      return anthropicSearch(
        query,
        requireModelId(target),
        apiKey,
        target.model?.baseUrl ?? "",
        signal,
      );
    }
    case "openai-codex": {
      const model = resolveRegisteredModel(target, ctx);
      if (!model) {
        throw new Error(
          `Search model is not registered: ${target.backend}/${target.model?.id ?? "?"}.`,
        );
      }
      signal?.throwIfAborted();
      return chatgptSearch(query, ctx, signal, undefined, model);
    }
    case "claude-bridge":
      signal?.throwIfAborted();
      return { text: await claudeBridgeSearch(query, signal, target.model?.id), sources: [] };
  }
}

// ─── Fallback orchestration ─────────────────────────────────────────────────

export interface AttemptRecord {
  backend: string;
  modelId?: string;
  tier: TargetTier;
  ok: boolean;
  reason?: string;
}

/** Keep tokens, headers, and credential-bearing URLs out of diagnostics. */
export function sanitizeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+[^\s,;)]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|api|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/([?&](?:key|api_?key|access_?token|token|password)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON_BYTES);
}

async function runSearchChain(
  query: string,
  plan: SearchPlan,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  onAttempt?: (target: SearchTarget, index: number) => void,
): Promise<{ result: SearchResult; target: SearchTarget; attempts: AttemptRecord[] }> {
  const attempts: AttemptRecord[] = [];
  for (let index = 0; index < plan.candidates.length; index++) {
    const target = plan.candidates[index]!;
    signal?.throwIfAborted(); // Never start a request after cancellation.
    onAttempt?.(target, index);
    const record: AttemptRecord = {
      backend: target.backend,
      ...(target.model ? { modelId: target.model.id } : {}),
      tier: target.tier,
      ok: false,
    };
    try {
      const result = await attemptSearch(query, target, ctx, signal);
      signal?.throwIfAborted();
      record.ok = true;
      attempts.push(record);
      return { result, target, attempts: attempts.slice(-MAX_ATTEMPT_HISTORY) };
    } catch (error) {
      // A cancelled attempt terminates the chain instead of advancing it.
      signal?.throwIfAborted();
      record.reason = sanitizeReason(error);
      attempts.push(record);
    }
  }
  const failures = attempts
    .filter((attempt) => !attempt.ok)
    .map((attempt) => `${attempt.backend}${attempt.modelId ? `/${attempt.modelId}` : ""}: ${attempt.reason ?? "failed"}`)
    .join("; ");
  throw new Error(
    failures
      ? `All search targets failed. ${failures}`
      : "No search target was available.",
  );
}

function degradedNotice(target: SearchTarget, attempts: AttemptRecord[]): string | undefined {
  const failed = attempts.filter((attempt) => !attempt.ok);
  if (!failed.length) return undefined;
  const summary = failed
    .map((attempt) => `${attempt.backend}${attempt.modelId ? `/${attempt.modelId}` : ""} failed (${attempt.reason ?? "unknown error"})`)
    .join("; ");
  return `> Search fallback: ${summary}; used ${describeTarget(target)}.`;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function searchExtension(pi: ExtensionAPI) {
  let configState: ConfigState = loadSearchConfig();
  /** Legacy configurations already announced during this session. */
  const announcedLegacy = new Set<string>();

  function commitConfig(next: SearchConfig) {
    // An explicit save writes the current shape and repairs any load error.
    configState = { config: next };
    saveSearchConfig(next);
    applyToolsConfig();
  }

  function announceMigration(ctx: ExtensionContext) {
    const signature = configState.legacySignature;
    if (!signature || announcedLegacy.has(signature)) return;
    announcedLegacy.add(signature);
    ctx.ui.notify(configState.migrationNotice ?? "Legacy search overrides were ignored.", "warning");
  }

  function refresh(ctx: ExtensionContext) {
    configState = loadSearchConfig();
    announceMigration(ctx);
    applyToolsConfig();
    updateStatus(ctx);
  }

  // ─── web_search ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web. Uses the configured search backend, the active model's backend, ZAI MCP, or DuckDuckGo. Output limited to 50KB / 2000 lines.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!configState.config.enabled || !configState.config.searchEnabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Web search disabled. Use /search to enable.",
            },
          ],
          details: { error: "disabled" },
        };
      }
      if (searchBlocked(configState)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Web search configuration error: ${configState.error!.message} Use /search to fix it.`,
            },
          ],
          details: { error: "config", query: params.query },
        };
      }
      const plan = planFor(ctx, configState.config);
      if (plan.error || !plan.candidates.length) {
        const message = plan.error ?? "No usable search target is configured.";
        return {
          content: [
            {
              type: "text" as const,
              text: `Web search configuration error: ${message} Use /search to fix it.`,
            },
          ],
          details: { error: "config", query: params.query },
        };
      }
      onUpdate?.({
        details: {},
        content: [
          {
            type: "text" as const,
            text: `Searching with ${describeTarget(plan.candidates[0]!)}: "${params.query}"...`,
          },
        ],
      });
      try {
        const { result, target, attempts } = await runSearchChain(
          params.query,
          plan,
          ctx,
          signal,
          (attempt, index) => {
            onUpdate?.({
              details: { provider: attempt.backend, tier: attempt.tier },
              content: [
                {
                  type: "text" as const,
                  text: `Searching with ${describeTarget(attempt)} (attempt ${index + 1}/${plan.candidates.length}): "${params.query}"...`,
                },
              ],
            });
          },
        );
        const notice = degradedNotice(target, attempts);
        const noMetadata =
          target.backend === "openai-codex" &&
          !result.sources.length &&
          !(result.apiSources?.length ?? 0);
        const prefix = [notice, noMetadata ? "> No structured source metadata was supplied by the provider." : undefined]
          .filter(Boolean)
          .join("\n");
        const text = prefix ? `${prefix}\n\n${result.text}` : result.text;
        return {
          content: [
            {
              type: "text" as const,
              text: formatSearchResult({ text, sources: result.sources, apiSources: result.apiSources ?? [] }),
            },
          ],
          details: {
            query: params.query,
            sources: result.sources,
            apiSources: result.apiSources ?? [],
            provider: target.backend,
            method: target.backend === "duckduckgo" ? "ddg" : "native",
            tier: target.tier,
            // Only the successful LLM target carries a model identity.
            ...(target.kind === "llm" && target.model
              ? { searchModel: target.model.id, searchModelSource: target.tier }
              : {}),
            ...(attempts.length ? { attempts } : {}),
            ...(plan.skips.length ? { skips: plan.skips } : {}),
          },
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw error; // Pi marks thrown tool errors as isError.
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("web_search ")) + t.fg("muted", `"${a.query}"`),
        0,
        0,
      );
    },
    renderResult(r, { expanded, isPartial }, t, context) {
      if (isPartial) return new Text(t.fg("warning", "Searching..."), 0, 0);
      const text = r.content[0]?.type === "text" ? r.content[0].text : "";
      if (expanded) return new Text(text, 0, 0);
      if (context?.isError || r.details?.error) return new Text(t.fg("error", text || "Search failed"), 0, 0);
      const urls = r.details?.sources?.length ?? 0;
      const apis = r.details?.apiSources?.length ?? 0;
      const status = urls || apis
        ? `Found results (${urls} URL, ${apis} API sources)`
        : "Results returned — no structured source metadata";
      return new Text(
        t.fg(urls || apis ? "success" : "warning", status)
          + t.fg("dim", ` (${text.split("\n").length} lines)`), 0, 0,
      );
    },
  });

  // ─── web_fetch ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page's text content. Truncated to 50KB / 2000 lines.",
    parameters: Type.Object({ url: Type.String({ description: "URL" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!configState.config.enabled || !configState.config.fetchEnabled) {
        return { content: [{ type: "text" as const, text: "Web fetch disabled." }], details: { error: "disabled" } };
      }
      if (fetchBlocked(configState)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Web fetch configuration error: ${configState.error!.message} Use /search to fix it.`,
            },
          ],
          details: { error: "config", url: params.url },
        };
      }
      onUpdate?.({
        details: {},
        content: [{ type: "text" as const, text: `Fetching ${params.url}...` }],
      });
      try {
        const text = await httpFetch(params.url, signal);
        signal?.throwIfAborted();
        return {
          content: [{ type: "text" as const, text }],
          details: { url: params.url, method: "local" },
        };
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    },
    renderCall(a, t) {
      return new Text(
        t.fg("toolTitle", t.bold("web_fetch ")) + t.fg("muted", a.url),
        0,
        0,
      );
    },
    renderResult(r, { expanded, isPartial }, t) {
      if (isPartial) return new Text(t.fg("warning", "Fetching..."), 0, 0);
      const text = r.content[0]?.type === "text" ? r.content[0].text : "",
        lines = text.split("\n").length;
      return expanded
        ? new Text(text, 0, 0)
        : new Text(
            t.fg("success", "Fetched") + t.fg("dim", ` (${lines} lines)`),
            0,
            0,
          );
    },
  });

  // ─── Commands ───────────────────────────────────────────────────────────

  pi.registerCommand("search", {
    description: "Configure web search & fetch tools",
    getArgumentCompletions(p) {
      return ["on", "off", "providers", "config"]
        .filter((c) => c.startsWith(p))
        .map((c) => ({ value: c, label: c }));
    },
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase();
      if (sub === "providers") {
        await showProviders(ctx);
        return;
      }
      if (sub === "config") {
        showConfig(ctx);
        return;
      }
      if (sub === "on") {
        commitConfig({ ...configState.config, enabled: true, searchEnabled: true, fetchEnabled: true });
        updateStatus(ctx);
        ctx.ui.notify("Search enabled", "info");
        return;
      }
      if (sub === "off") {
        commitConfig({ ...configState.config, enabled: false });
        updateStatus(ctx);
        ctx.ui.notify("Search disabled", "info");
        return;
      }
      await showSearchSettings(ctx);
    },
  });

  // ─── Settings ───────────────────────────────────────────────────────────

  function selectTheme(theme: any) {
    return {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
  }

  async function showSearchSettings(ctx: ExtensionContext) {
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const themeKit = selectTheme(theme);

      const submenu = (heading: string, list: SelectList, hint: string) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold(heading))));
        container.addChild(new Text(theme.fg("dim", hint)));
        container.addChild(new Text(""));
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ select • enter confirm • esc back")));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      };

      const backendSubmenu = (currentValue: string, close: (value?: string) => void) => {
        const items: SelectItem[] = [
          {
            value: AUTOMATIC,
            label: "Automatic",
            description: "Start with the active conversation model, then fall back.",
          },
          ...SEARCH_BACKEND_IDS.map((id) => ({
            value: id,
            label: SEARCH_BACKENDS[id].name,
            description: `${SEARCH_BACKENDS[id].kind === "llm" ? "LLM search (requires a registered model)" : "Non-LLM search"} | credentials: ${readinessLabel(overviewReadiness(id, ctx))}`,
          })),
        ];
        const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE_ITEMS), themeKit);
        list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === currentValue)));
        list.onSelect = (item) => close(item.value);
        list.onCancel = () => close();
        return submenu("Search Backend", list, "Only implemented search backends are listed");
      };

      const modelSubmenu = (backend: SearchBackendId, currentValue: string, close: (value?: string) => void) => {
        const models = registeredModels(backend, ctx);
        const items: SelectItem[] = [
          {
            value: AUTOMATIC,
            label: "Not set",
            description: "Skip the pinned tier and continue with the fallback chain.",
          },
          ...models.map((model) => ({
            value: model.id,
            label: model.name ? `${model.name} (${model.id})` : model.id,
            description: "Pi-registered model for this backend",
          })),
        ];
        const list = new SelectList(items, Math.min(items.length, MAX_VISIBLE_ITEMS), themeKit);
        list.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === currentValue)));
        list.onSelect = (item) => close(item.value);
        list.onCancel = () => close();
        return submenu(
          `${backendName(backend)} Search Model`,
          list,
          models.length
            ? "Only Pi-registered models for this backend are listed"
            : "No models are registered for this backend in Pi",
        );
      };

      const buildItems = (): SettingItem[] => {
        const config = configState.config;
        const items: SettingItem[] = [
          {
            id: "enabled",
            label: "Search Extension",
            currentValue: config.enabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "search",
            label: "Web Search",
            currentValue: config.searchEnabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "fetch",
            label: "Web Fetch",
            currentValue: config.fetchEnabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "target",
            label: "Search Backend",
            description: "Global search target; automatic starts with the active conversation model.",
            currentValue: config.searchProvider ?? AUTOMATIC,
            submenu: (current, close) => backendSubmenu(current, close),
          },
        ];
        if (config.searchProvider && isLlmBackend(config.searchProvider)) {
          items.push({
            id: "model",
            label: "Search Model",
            description: "Pi-registered models only; leaving this unset skips the pinned tier.",
            currentValue: config.searchModel ?? AUTOMATIC,
            submenu: (current, close) => modelSubmenu(config.searchProvider!, current, close),
          });
        }
        return items;
      };

      const onChange = (id: string, value: string) => {
        const next: SearchConfig = { ...configState.config };
        if (id === "enabled") next.enabled = value === "enabled";
        else if (id === "search") next.searchEnabled = value === "enabled";
        else if (id === "fetch") next.fetchEnabled = value === "enabled";
        else if (id === "target") {
          next.searchProvider = value === AUTOMATIC ? undefined : (value as SearchBackendId);
          if (!next.searchProvider || !isLlmBackend(next.searchProvider)) {
            next.searchModel = undefined; // Non-LLM backends take no model.
          } else if (
            next.searchModel &&
            !registeredModels(next.searchProvider, ctx).some((model) => model.id === next.searchModel)
          ) {
            next.searchModel = undefined; // Stale selection cleared on backend change.
          }
        } else if (id === "model") {
          next.searchModel = value === AUTOMATIC ? undefined : value;
        }
        commitConfig(next);
        updateStatus(ctx);
        list = createList();
        list.selectItem(id);
        tui.requestRender();
      };

      const createList = () =>
        new SettingsList(buildItems(), MAX_VISIBLE_ITEMS, getSettingsListTheme(), onChange, () => done(undefined));

      let list = createList();
      const host = {
        render: (width: number) => list.render(width),
        invalidate: () => list.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Search Settings"))));
      container.addChild(new Text(theme.fg("dim", "Global search target • /search providers for backend details")));
      if (configState.error) {
        container.addChild(new Text(theme.fg("error", `Configuration error: ${configState.error.message}`)));
      }
      container.addChild(new Text(""));
      container.addChild(host);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter/space change • esc close")));
      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          host.handleInput(data);
        },
      };
    });
  }

  // ─── Implemented backends view ──────────────────────────────────────────

  async function showProviders(ctx: ExtensionContext) {
    const configured = configState.config.searchProvider;
    const items: SelectItem[] = SEARCH_BACKEND_IDS.map((id) => {
      const backend = SEARCH_BACKENDS[id];
      const models = backend.kind === "llm" ? registeredModels(id, ctx) : [];
      const kind =
        backend.kind === "llm"
          ? `LLM search • ${models.length} registered model${models.length === 1 ? "" : "s"}`
          : "non-LLM search";
      return {
        value: id,
        label: `${backend.name}${configured === id ? " ← configured" : ""}`,
        description: `${kind} | credentials: ${readinessLabel(overviewReadiness(id, ctx))}`,
      };
    });

    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Implemented Search Backends"))));
      container.addChild(new Text(theme.fg("dim", "Only these backends are selectable; provider-specific toggles were removed.")));
      container.addChild(new Text(""));
      const list = new SelectList(items, MAX_VISIBLE_ITEMS, selectTheme(theme));
      list.onSelect = () => {};
      list.onCancel = () => done(undefined);
      container.addChild(list);
      container.addChild(new Text(theme.fg("dim", "esc close")));
      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  // ─── Config display ─────────────────────────────────────────────────────

  function showConfig(ctx: ExtensionContext) {
    const config = configState.config;
    const sessionProvider = ctx.model?.provider ?? "?";
    const sessionModel = ctx.model?.id ?? "?";
    const lines = [
      `Extension: ${config.enabled ? "enabled" : "disabled"}`,
      `Search: ${config.searchEnabled ? "enabled" : "disabled"} | Fetch: ${config.fetchEnabled ? "enabled" : "disabled"}`,
    ];
    if (configState.error) {
      lines.push(`Configuration error (${configState.error.scope}): ${configState.error.message}`);
    }
    lines.push("");
    lines.push(`Session model: ${sessionModel} (${sessionProvider})`);
    lines.push(
      `Session search support: ${isLlmBackend(sessionProvider) ? "yes" : "no implemented search backend"}`,
    );
    lines.push(`Configured backend: ${config.searchProvider ?? "automatic"}`);
    lines.push(
      `Configured model: ${config.searchModel ?? "not set (pinned LLM tier skipped)"}`,
    );
    lines.push("");
    if (searchBlocked(configState)) {
      lines.push("Planned search target: unavailable until the configuration error is fixed");
    } else {
      const plan = planFor(ctx, config);
      if (plan.error) {
        lines.push(`Planned search target: unavailable (${plan.error})`);
      } else if (!plan.candidates.length) {
        lines.push("Planned search target: none");
      } else {
        lines.push(`Planned search target: ${describeTarget(plan.candidates[0]!)}`);
        lines.push(`Fallback chain: ${plan.candidates.map(describeTarget).join(" → ")}`);
        if (plan.skips.length) {
          lines.push(
            `Skipped: ${plan.skips
              .map((skip) => `${skip.backend}${skip.modelId ? `/${skip.modelId}` : ""} (${skip.reason})`)
              .join("; ")}`,
          );
        }
      }
    }
    lines.push("");
    lines.push("Fetch: direct HTTP (no search credentials or backend routing)");
    ctx.ui.notify(lines.join("\n"), "info");
  }

  // ─── Tool activation and status ─────────────────────────────────────────

  function applyToolsConfig() {
    const active = pi
      .getActiveTools()
      .filter((tool) => tool !== "web_search" && tool !== "web_fetch");
    // Only global switches govern availability, never the conversation provider.
    if (configState.config.enabled && configState.config.searchEnabled) active.push("web_search");
    if (configState.config.enabled && configState.config.fetchEnabled) active.push("web_fetch");
    pi.setActiveTools(active);
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!configState.config.enabled) {
      ctx.ui.setStatus("search", undefined);
      return;
    }
    const parts: string[] = [];
    if (configState.config.searchEnabled) {
      let label = "config-error";
      if (!searchBlocked(configState)) {
        const plan = planFor(ctx, configState.config);
        label = plan.error
          ? "config-error"
          : plan.candidates.length
            ? describeTarget(plan.candidates[0]!)
            : "none";
      }
      parts.push(`search:${label}`);
    }
    if (configState.config.fetchEnabled) parts.push("fetch:http");
    ctx.ui.setStatus(
      "search",
      parts.length ? ctx.ui.theme.fg("accent", `search[${parts.join(",")}]`) : undefined,
    );
  }

  pi.on("session_start", async (_, ctx) => refresh(ctx));
  pi.on("model_select", async (_, ctx) => refresh(ctx));
  pi.on("session_tree", async (_, ctx) => refresh(ctx));
}
