/**
 * Search configuration: parsing, defaults, validation, and serialization.
 *
 * The persisted shape is global:
 *
 *   {
 *     "enabled": true,
 *     "searchEnabled": true,
 *     "fetchEnabled": true,
 *     "searchProvider": "openai-codex",   // optional; omitted means automatic
 *     "searchModel": "REGISTERED_MODEL_ID" // optional; only for LLM backends
 *   }
 *
 * Loading never writes and never throws: load/validation problems are returned
 * as state so the extension can start and the settings UI stays repairable.
 *
 * Error scopes:
 * - "structure": the file is unreadable or a global switch has the wrong type.
 *   Execution is blocked rather than guessing enablement.
 * - "search": the search target itself is invalid. Search is blocked, but
 *   enabled fetch behavior is unaffected.
 *
 * Legacy `providerOverrides` values are ignored entirely. They are never
 * inferred into a global target and never rewritten on read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isLlmBackend, isSearchBackendId, type SearchBackendId } from "./search-providers.ts";

export interface SearchConfig {
  enabled: boolean;
  searchEnabled: boolean;
  fetchEnabled: boolean;
  /** Global search backend. Omitted means automatic selection. */
  searchProvider?: SearchBackendId;
  /** Pinned model for an LLM backend. Omitted/blank skips the pinned tier. */
  searchModel?: string;
}

export type ConfigErrorScope = "structure" | "search";

export interface ConfigError {
  scope: ConfigErrorScope;
  message: string;
}

export interface ConfigState {
  /** Best-effort normalized configuration. Safe to display and repair. */
  config: SearchConfig;
  /** Present when the loaded configuration is unusable as written. */
  error?: ConfigError;
  /** Present when legacy provider overrides were found and ignored. */
  migrationNotice?: string;
  /** Stable identity of the ignored legacy configuration, for once-per-session notices. */
  legacySignature?: string;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  enabled: true,
  searchEnabled: true,
  fetchEnabled: true,
};

export const MIGRATION_NOTICE =
  "Provider-specific search overrides are no longer supported and were ignored. " +
  "Configure a global search target with /search.";

export function getSearchConfigPath(): string {
  return join(getAgentDir(), "search-config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Identity of legacy provider overrides, or undefined when there is nothing to
 * migrate. Empty per-provider objects are treated as absent so old default
 * files do not produce a spurious notice.
 */
function providerOverridesSignature(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter(([, entry]) => isRecord(entry) && Object.keys(entry).length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return undefined;
  return JSON.stringify(entries);
}

/** Normalize an already-parsed JSON value. Never throws. */
export function normalizeSearchConfig(raw: unknown): ConfigState {
  const config: SearchConfig = { ...DEFAULT_SEARCH_CONFIG };
  if (!isRecord(raw)) {
    return {
      config,
      error: {
        scope: "structure",
        message: "Search configuration must be a JSON object.",
      },
    };
  }

  let structureError: string | undefined;
  let searchError: string | undefined;

  const readSwitch = (key: "enabled" | "searchEnabled" | "fetchEnabled") => {
    const value = raw[key];
    if (value === undefined || value === null) return;
    if (typeof value !== "boolean") {
      structureError ??= `Search configuration field "${key}" must be true or false.`;
      return;
    }
    config[key] = value;
  };
  readSwitch("enabled");
  readSwitch("searchEnabled");
  readSwitch("fetchEnabled");

  let provider: SearchBackendId | undefined;
  const rawProvider = raw.searchProvider;
  if (rawProvider !== undefined && rawProvider !== null) {
    if (typeof rawProvider !== "string") {
      searchError ??= 'Search configuration field "searchProvider" must be a backend id string.';
    } else {
      const trimmed = rawProvider.trim();
      if (trimmed) {
        if (!isSearchBackendId(trimmed)) {
          searchError ??=
            `Unknown search backend "${trimmed}". Implemented backends: see /search providers.`;
        } else {
          provider = trimmed;
        }
      }
    }
  }

  let model: string | undefined;
  const rawModel = raw.searchModel;
  if (rawModel !== undefined && rawModel !== null) {
    if (typeof rawModel !== "string") {
      searchError ??= 'Search configuration field "searchModel" must be a string.';
    } else {
      model = rawModel.trim() || undefined;
    }
  }

  if (model && !provider) {
    searchError ??=
      'Search configuration sets "searchModel" without "searchProvider"; configure a backend or remove the model.';
  }
  // Non-LLM backends take no model. String models are ignored rather than stored.
  if (provider && !isLlmBackend(provider)) model = undefined;

  config.searchProvider = provider;
  // A model is only meaningful together with an LLM backend.
  config.searchModel = provider ? model : undefined;

  const signature = providerOverridesSignature(raw.providerOverrides);
  return {
    config,
    ...(structureError || searchError
      ? { error: { scope: structureError ? "structure" : "search", message: (structureError ?? searchError)! } }
      : {}),
    ...(signature
      ? { migrationNotice: MIGRATION_NOTICE, legacySignature: signature }
      : {}),
  };
}

/** Read and normalize the persisted configuration. Never writes. */
export function loadSearchConfig(path = getSearchConfigPath()): ConfigState {
  let text: string;
  try {
    if (!existsSync(path)) return { config: { ...DEFAULT_SEARCH_CONFIG } };
    text = readFileSync(path, "utf-8");
  } catch {
    return {
      config: { ...DEFAULT_SEARCH_CONFIG },
      error: { scope: "structure", message: "Search configuration could not be read." },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      config: { ...DEFAULT_SEARCH_CONFIG },
      error: { scope: "structure", message: "Search configuration is not valid JSON." },
    };
  }
  return normalizeSearchConfig(raw);
}

/** Serialize only the current global shape; legacy fields are never emitted. */
export function serializeSearchConfig(config: SearchConfig): string {
  const out: Record<string, unknown> = {
    enabled: config.enabled,
    searchEnabled: config.searchEnabled,
    fetchEnabled: config.fetchEnabled,
  };
  if (config.searchProvider) {
    out.searchProvider = config.searchProvider;
    if (isLlmBackend(config.searchProvider) && config.searchModel) {
      out.searchModel = config.searchModel;
    }
  }
  return JSON.stringify(out, null, 2);
}

/** Persist an explicit user change. */
export function saveSearchConfig(config: SearchConfig, path = getSearchConfigPath()): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, serializeSearchConfig(config), "utf-8");
}

/** Structural errors block search execution. */
export function searchBlocked(state: ConfigState): boolean {
  return state.error !== undefined;
}

/** Only structural errors block fetch; search-target errors do not. */
export function fetchBlocked(state: ConfigState): boolean {
  return state.error?.scope === "structure";
}
