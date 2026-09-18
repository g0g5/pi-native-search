/** Only backends that actually invoke an LLM accept a search model override. */
const LLM_SEARCH_PROVIDERS = new Set([
  "google", "openai", "openai-codex", "xai", "anthropic", "claude-bridge",
]);

export interface SearchModelSelection {
  id?: string;
  source: "configured" | "session" | "sdk" | "none";
}

export function resolveSearchModel(
  provider: string,
  configured: unknown,
  currentModelId?: string,
): SearchModelSelection {
  if (!LLM_SEARCH_PROVIDERS.has(provider)) return { source: "none" };
  const id = typeof configured === "string" ? configured.trim() : "";
  if (id) return { id, source: "configured" };
  if (provider === "claude-bridge") return { source: "sdk" };
  return { id: currentModelId || undefined, source: "session" };
}

export function describeSearchModel(selection: SearchModelSelection): string {
  switch (selection.source) {
    case "none": return "not applicable";
    case "sdk": return "SDK default";
    case "configured": return `${selection.id} (configured)`;
    case "session": return `${selection.id ?? "?"} (session default)`;
  }
}
