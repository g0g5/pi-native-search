/**
 * Pure search-target planning.
 *
 * Selection is deterministic and performs no network access. The planner
 * considers, in order:
 *
 *   1. the globally configured search backend ("configured")
 *   2. the active conversation LLM provider and exact current model ("session")
 *   3. authenticated non-LLM backends, then DuckDuckGo ("fallback")
 *
 * A globally configured LLM backend MUST name a model registered for that
 * provider in Pi. A missing/blank model instead *skips* the tier. Other
 * authenticated LLM providers are never selected automatically.
 *
 * Candidates are deduplicated by backend+model identity (backend alone for
 * non-LLM backends). Skip diagnostics explain what was not used and why.
 */
import type { SearchConfig } from "./search-config.ts";
import {
  NON_LLM_FALLBACK_ORDER,
  isLlmBackend,
  type SearchBackendId,
  type SearchBackendKind,
} from "./search-providers.ts";

/** Minimal model identity used for planning; never carries credentials. */
export interface RoutingModel {
  provider: string;
  id: string;
  baseUrl?: string;
}

export type TargetTier = "configured" | "session" | "fallback";

export type AuthReadiness = "ready" | "missing" | "deferred";

export interface SearchTarget {
  backend: SearchBackendId;
  kind: SearchBackendKind;
  tier: TargetTier;
  /** Present only for LLM targets. */
  model?: RoutingModel;
  /** Short human-readable reason this target was selected. */
  reason: string;
}

export interface SkipDiagnostic {
  backend: string;
  modelId?: string;
  reason: string;
}

export interface SearchPlan {
  candidates: SearchTarget[];
  skips: SkipDiagnostic[];
  /** Configuration error that must block search before any request is sent. */
  error?: string;
}

export interface RoutingInput {
  config: SearchConfig;
  /** Active conversation model, when one is selected. */
  sessionModel?: RoutingModel;
  /** Pi-registered models per LLM backend. */
  models?: Partial<Record<string, RoutingModel[]>>;
  /**
   * Credential readiness for a candidate. "deferred" means credentials are
   * resolved only when the backend is actually invoked.
   */
  readiness: (backend: SearchBackendId, model?: RoutingModel) => AuthReadiness;
}

const MAX_SKIP_DIAGNOSTICS = 16;

function identity(backend: SearchBackendId, kind: SearchBackendKind, model?: RoutingModel): string {
  return kind === "llm" ? `llm:${backend}:${model?.id ?? ""}` : `backend:${backend}`;
}

/** Compact label for status, config, and progress output. */
export function describeTarget(target: SearchTarget): string {
  if (target.kind === "llm" && target.model) {
    const tier = target.tier === "session" ? " (session)" : "";
    return `${target.backend}/${target.model.id}${tier}`;
  }
  return target.backend === "zai" ? "zai:mcp" : target.backend;
}

export function planSearchTargets(input: RoutingInput): SearchPlan {
  const candidates: SearchTarget[] = [];
  const skips: SkipDiagnostic[] = [];
  const selected = new Set<string>();
  const reported = new Set<string>();
  const models = input.models ?? {};

  const noteSkip = (backend: string, modelId: string | undefined, reason: string) => {
    const key = `${backend}:${modelId ?? ""}`;
    if (reported.has(key) || skips.length >= MAX_SKIP_DIAGNOSTICS) return;
    reported.add(key);
    skips.push({ backend, ...(modelId ? { modelId } : {}), reason });
  };

  const add = (target: SearchTarget): boolean => {
    const key = identity(target.backend, target.kind, target.model);
    if (selected.has(key)) {
      noteSkip(target.backend, target.model?.id, "Already selected earlier in the chain.");
      return false;
    }
    selected.add(key);
    candidates.push(target);
    return true;
  };

  // Tier 1: globally configured backend.
  const pinned = input.config.searchProvider;
  if (pinned) {
    if (isLlmBackend(pinned)) {
      const modelId = input.config.searchModel?.trim();
      if (!modelId) {
        noteSkip(pinned, undefined, "No model configured for the pinned LLM backend; skipping this tier.");
      } else {
        const registered = (models[pinned] ?? []).find((model) => model.id === modelId);
        if (!registered) {
          return {
            candidates: [],
            skips,
            error: `Search model "${modelId}" is not registered for backend "${pinned}" in Pi.`,
          };
        }
        if (input.readiness(pinned, registered) === "missing") {
          noteSkip(pinned, registered.id, "No usable credentials for the configured search backend.");
        } else {
          add({
            backend: pinned,
            kind: "llm",
            tier: "configured",
            model: registered,
            reason: `Configured search target ${pinned}/${registered.id}`,
          });
        }
      }
    } else if (input.readiness(pinned) === "missing") {
      noteSkip(pinned, undefined, "No usable credentials for the configured search backend.");
    } else {
      add({
        backend: pinned,
        kind: "non-llm",
        tier: "configured",
        reason: `Configured search backend ${pinned}`,
      });
    }
  }

  // Tier 2: the active conversation model, only when its backend supports search.
  const session = input.sessionModel;
  if (!session) {
    noteSkip("conversation", undefined, "No active conversation model.");
  } else if (!isLlmBackend(session.provider)) {
    noteSkip(session.provider, undefined, "Conversation provider has no implemented search backend.");
  } else {
    const backend = session.provider as SearchBackendId;
    const model: RoutingModel = {
      provider: backend,
      id: session.id,
      ...(session.baseUrl ? { baseUrl: session.baseUrl } : {}),
    };
    if (input.readiness(backend, model) === "missing") {
      noteSkip(backend, model.id, "No usable credentials for the active model's search backend.");
    } else {
      add({
        backend,
        kind: "llm",
        tier: "session",
        model,
        reason: `Active conversation model ${backend}/${model.id}`,
      });
    }
  }

  // Tier 3: authenticated non-LLM backends, then unauthenticated DuckDuckGo.
  for (const backend of NON_LLM_FALLBACK_ORDER) {
    if (input.readiness(backend) === "missing") {
      noteSkip(backend, undefined, "No usable credentials for this search backend.");
      continue;
    }
    add({
      backend,
      kind: "non-llm",
      tier: "fallback",
      reason:
        backend === "duckduckgo"
          ? "Unauthenticated DuckDuckGo fallback"
          : `Authenticated ${backend} fallback`,
    });
  }

  return { candidates, skips };
}
