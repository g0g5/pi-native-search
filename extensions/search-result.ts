import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";

export interface SearchSource {
  title: string;
  url: string;
}

export interface ApiSearchSource {
  type: "api";
  name: string;
}

export interface SearchResult {
  text: string;
  sources: SearchSource[];
  /** Optional for compatibility with text-only and URL-only backends. */
  apiSources?: ApiSearchSource[];
}

export const MAX_SOURCES = 64;
export const MAX_SOURCE_BYTES = 32 * 1024;
export const MAX_API_SOURCES = 16;
export const MAX_API_SOURCE_BYTES = 4 * 1024;
const MAX_API_NAME_BYTES = 256;
const MAX_URL_BYTES = 4096;
const MAX_TITLE_BYTES = 512;
const MAX_DISPLAY_SOURCES = 8;
const MAX_DISPLAY_BYTES = 16 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Keep URLs intact, including query strings/redirect URLs; never infer them from prose. */
export function normalizeSources(values: unknown[], numericTitles = false): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();
  let bytes = 2; // JSON array brackets
  for (const value of values) {
    const source = object(value);
    const url = text(source.url).trim();
    if (!/^https?:\/\//i.test(url) || /[\s\x00-\x1f\x7f\\]/.test(url) || Buffer.byteLength(url) > MAX_URL_BYTES) continue;
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (!parsed.hostname || seen.has(url)) continue;
    let title = text(source.title).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
    if (!title || (numericTitles && /^\d+$/.test(title))) title = parsed.hostname;
    // Limit metadata without cutting a UTF-8 code point or changing a URL.
    if (Buffer.byteLength(title) > MAX_TITLE_BYTES) {
      let clipped = "";
      let size = 0;
      for (const char of title) {
        size += Buffer.byteLength(char);
        if (size > MAX_TITLE_BYTES - 3) break;
        clipped += char;
      }
      title = clipped + "…";
    }
    const hit = { title, url };
    const size = Buffer.byteLength(JSON.stringify(hit)) + (sources.length ? 1 : 0);
    if (bytes + size > MAX_SOURCE_BYTES) continue;
    seen.add(url);
    sources.push(hit);
    bytes += size;
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

/** API names are provider identifiers, not URLs or inferred vendor identities. */
export function normalizeApiSources(values: unknown[]): ApiSearchSource[] {
  const sources: ApiSearchSource[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  for (const value of values) {
    const source = object(value);
    if (source.type !== "api" || typeof source.name !== "string") continue;
    const name = source.name.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    // Do not truncate identifiers into misleading names.
    if (!name || Buffer.byteLength(name) > MAX_API_NAME_BYTES || seen.has(name)) continue;
    const hit: ApiSearchSource = { type: "api", name };
    const size = Buffer.byteLength(JSON.stringify(hit)) + (sources.length ? 1 : 0);
    if (bytes + size > MAX_API_SOURCE_BYTES) continue;
    sources.push(hit);
    seen.add(name);
    bytes += size;
    if (sources.length >= MAX_API_SOURCES) break;
  }
  return sources;
}

/** Responses API: answer citations first, then optional full search sources/citations. */
export function parseResponsesSearch(
  output: unknown,
  options: { searchSources?: boolean; citations?: unknown; numericTitles?: boolean } = {},
): SearchResult {
  const parts: string[] = [];
  const sources: unknown[] = [];
  const apiCandidates: unknown[] = [];
  const items = array(output).map(object);
  for (const item of items) {
    if (item.type !== "message") continue;
    for (const value of array(item.content)) {
      const block = object(value);
      if (block.type !== "output_text") continue;
      if (text(block.text).trim()) parts.push(text(block.text));
      for (const value of array(block.annotations)) {
        const annotation = object(value);
        if (annotation.type === "url_citation") sources.push(annotation);
      }
    }
  }
  if (options.searchSources) {
    for (const item of items) {
      if (item.type !== "web_search_call") continue;
      const action = object(item.action);
      // Some Codex responses omit action.type. Explicit non-search actions are not hits.
      if (action.type !== undefined && action.type !== "search") continue;
      for (const source of array(action.sources)) {
        const type = object(source).type;
        if (type === "api") apiCandidates.push(source);
        else if (type === undefined || type === "url") sources.push(source);
      }
    }
  }
  for (const url of array(options.citations)) {
    if (typeof url === "string") sources.push({ url });
  }
  const apiSources = normalizeApiSources(apiCandidates);
  return {
    text: parts.join("\n"), sources: normalizeSources(sources, options.numericTitles),
    ...(apiSources.length ? { apiSources } : {}),
  };
}

export function parseGoogleSearch(data: unknown): SearchResult {
  // Other candidates are alternative answers, not continuations of this one.
  const candidate = object(array(object(data).candidates)[0]);
  const parts = array(object(candidate.content).parts).map(object)
    .filter((part) => part.thought !== true).map((part) => text(part.text)).filter(Boolean);
  const sources = array(object(candidate.groundingMetadata).groundingChunks).map((chunk) => {
    const web = object(object(chunk).web);
    return { title: web.title, url: web.uri };
  });
  return { text: parts.join("\n"), sources: normalizeSources(sources) };
}

export function parseAnthropicSearch(data: unknown): SearchResult {
  const parts: string[] = [];
  const citations: unknown[] = [];
  const hits: unknown[] = [];
  for (const value of array(object(data).content)) {
    const block = object(value);
    if (block.type === "text") {
      if (text(block.text).trim()) parts.push(text(block.text));
      for (const value of array(block.citations)) {
        const citation = object(value);
        if (citation.type === "web_search_result_location") citations.push(citation);
      }
    } else if (block.type === "web_search_tool_result") {
      if (!Array.isArray(block.content)) {
        // A server-tool error is not a successful search (even with HTTP 200).
        // Throw so the existing dispatcher can fall back, without leaking partial sources.
        if (object(block.content).type === "web_search_tool_result_error") {
          throw new Error("Anthropic web search tool failed.");
        }
        continue;
      }
      for (const value of block.content) {
        const hit = object(value);
        if (hit.type === "web_search_result") hits.push(hit);
      }
    }
  }
  return { text: parts.join("\n"), sources: normalizeSources([...citations, ...hits]) };
}

/** Sources stay in model-visible content as well as structured tool details. */
export function formatSearchResult(result: SearchResult): string {
  const lines: string[] = [];
  let displayBytes = 0;
  const apiSources = result.apiSources ?? [];
  const escape = (value: string) => value.replace(/[\\[\]`*_<>]/g, "\\$&");
  // API sources first so a full URL list cannot hide a weather/API attribution.
  const candidates = [
    ...apiSources.map((source) => `- API source: ${escape(source.name)} (provider supplied no accessible URL)`),
    ...result.sources.map((source) => {
      const url = source.url.replace(/[<>]/g, (char) => char === "<" ? "%3C" : "%3E");
      return `- [${escape(source.title)}](<${url}>)`;
    }),
  ];
  for (const line of candidates.slice(0, MAX_DISPLAY_SOURCES)) {
    const size = Buffer.byteLength(line) + 1;
    if (displayBytes + size > MAX_DISPLAY_BYTES) break;
    lines.push(line);
    displayBytes += size;
  }
  if (lines.length < candidates.length) lines.push(`[Showing ${lines.length} of ${candidates.length} retained sources]`);
  const suffix = lines.length ? `${result.text ? "\n\n" : ""}## Sources:\n${lines.join("\n")}` : "";
  const body = result.text || (candidates.length ? "" : "No results found.");
  const full = body + suffix;
  if (Buffer.byteLength(full) <= DEFAULT_MAX_BYTES && full.split("\n").length <= DEFAULT_MAX_LINES) return full;

  const notice = "\n\n[Search output truncated]";
  const reserved = notice + suffix;
  const truncated = truncateHead(body, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(reserved),
    maxLines: DEFAULT_MAX_LINES - (reserved.split("\n").length - 1),
  });
  return truncated.content + reserved;
}
