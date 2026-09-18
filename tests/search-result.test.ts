import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
  formatSearchResult, MAX_SOURCES, MAX_SOURCE_BYTES, normalizeSources,
  parseAnthropicSearch, parseGoogleSearch, parseResponsesSearch,
} from "../extensions/search-result.ts";
import { parseSearchOutput } from "../extensions/chatgpt-search.ts";

const cited = { title: "Cited", url: "https://example.com/?q=1&utm_source=search" };
const other = { title: "Other", url: "https://other.example/" };
const annotation = { type: "url_citation", ...cited };

test("normalization validates URL types, deduplicates exactly, and does not rewrite query strings", () => {
  assert.deepEqual(normalizeSources([
    null, 1, "https://not-a-source.example", {},
    { url: 42 }, { url: "javascript:alert(1)" }, { url: "https://" },
    { url: "https://bad host/" }, { url: "https://bad.example/\nfoo" },
    cited, { ...cited, title: "Duplicate" }, { url: other.url, title: " \n\t " },
    { url: "https://example.com/?q=2&utm_source=search", title: "Different query" },
  ]), [cited, { ...other, title: "other.example" },
    { url: "https://example.com/?q=2&utm_source=search", title: "Different query" }]);
});

test("normalization bounds source count, title bytes and serialized metadata, without cutting URLs", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ title: "源".repeat(1000), url: `https://example.com/${i}` }));
  const result = normalizeSources(many);
  assert.ok(result.length <= MAX_SOURCES);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_SOURCE_BYTES);
  assert.ok(result.every((source) => Buffer.byteLength(source.title) <= 512 && !source.title.includes("\ufffd")));
  assert.equal(normalizeSources(Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${i}` }))).length, MAX_SOURCES);
  const long = normalizeSources(Array.from({ length: 64 }, (_, i) => ({ url: `https://example.com/${i}?q=${"x".repeat(3800)}` })));
  assert.ok(long.length < 64 && long.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= MAX_SOURCE_BYTES);
  assert.deepEqual(normalizeSources([{ url: `https://example.com/${"x".repeat(5000)}` }, other]), [other]);
});

test("Responses collects every output block/message, prioritizes citations over search hits", () => {
  const result = parseResponsesSearch([
    { type: "web_search_call", action: { type: "search", sources: [{ ...cited, title: "Search title" }, other] } },
    { type: "message", content: [
      { type: "output_text", text: "First", annotations: [annotation] },
      { type: "output_text", text: "Second", annotations: [annotation, null] },
      { type: "refusal", text: "Not output text", annotations: [{ type: "url_citation", url: "https://ignore.example" }] },
    ] },
    { type: "message", content: [{ type: "output_text", text: "Third" }] },
    { type: "web_search_call", action: { type: "open_page", sources: [{ url: "https://ignore.example" }] } },
  ], { searchSources: true });
  assert.deepEqual(result, { text: "First\nSecond\nThird", sources: [cited, other] });
});

test("xAI merges annotations/top-level citations and normalizes numeric titles only for xAI", () => {
  const output = [{ type: "message", content: [{ type: "output_text", text: "Answer", annotations: [
    { ...annotation, title: " 12 " }, { type: "url_citation", ...other },
  ] }] }];
  const result = parseResponsesSearch(output, { numericTitles: true, citations: [cited.url, "https://extra.example", null, {}, 12] });
  assert.deepEqual(result.sources, [{ ...cited, title: "example.com" }, other, { url: "https://extra.example", title: "extra.example" }]);
  assert.equal(parseResponsesSearch(output).sources[0]?.title, "12");
  assert.equal(parseResponsesSearch(output, { citations: {} }).sources.length, 2);
});

test("Google merges parts from the selected candidate and filters non-web grounding chunks", () => {
  const result = parseGoogleSearch({ candidates: [
    { content: { parts: [{ text: "First" }, { text: "Hidden thought", thought: true }, { text: "Second" }] },
      groundingMetadata: { groundingChunks: [null, { retrievedContext: { uri: other.url } },
        { web: { title: cited.title, uri: cited.url } }, { web: { title: "Duplicate", uri: cited.url } }] } },
    { content: { parts: [{ text: "Alternative answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: other.url } }] } },
  ] });
  assert.deepEqual(result, { text: "First\nSecond", sources: [cited] });
});

test("Anthropic reads text citations and search hits, prioritizing cited titles", () => {
  const result = parseAnthropicSearch({ content: [
    { type: "web_search_tool_result", content: [{ type: "web_search_result", ...other }, { type: "web_search_result", ...cited, title: "Hit" }] },
    { type: "text", text: "First", citations: [{ type: "web_search_result_location", ...cited }] },
    { type: "text", text: "Second", citations: [{ type: "web_search_result_location", ...cited }] },
  ] });
  assert.deepEqual(result, { text: "First\nSecond", sources: [cited, other] });
  assert.throws(() => parseAnthropicSearch({ content: [{ type: "web_search_tool_result", content: {
    type: "web_search_tool_result_error", error_code: "rate_limit_exceeded",
  } }] }), /Anthropic web search tool failed/);
});

test("missing/malformed optional metadata does not fail a successful answer", () => {
  for (const value of [null, {}, 42, "bad", []]) {
    assert.deepEqual(parseResponsesSearch(value), { text: "", sources: [] });
    assert.deepEqual(parseGoogleSearch(value), { text: "", sources: [] });
    assert.deepEqual(parseAnthropicSearch(value), { text: "", sources: [] });
  }
  assert.deepEqual(parseResponsesSearch([{ type: "message", content: [null, { type: "output_text", text: "Answer", annotations: {} }] }]),
    { text: "Answer", sources: [] });
  assert.equal(formatSearchResult({ text: "", sources: [] }), "No results found.");
  assert.equal(formatSearchResult({ text: "Answer https://not-a-citation.example", sources: [] }), "Answer https://not-a-citation.example");
});

test("source-only results are useful, including Codex; completed empty Codex results still fail", () => {
  const result = parseSearchOutput([{ type: "web_search_call", status: "completed", action: { sources: [cited] } }]);
  assert.deepEqual(result, { text: "", sources: [cited] });
  assert.match(formatSearchResult(result), /## Sources:/);
  assert.doesNotMatch(formatSearchResult(result), /No results/);
  assert.throws(() => parseSearchOutput([{ type: "web_search_call", status: "completed" }]), /no text or sources/);
});

test("formatting retains up to eight sources, safely escapes Markdown, and preserves details", () => {
  const sources = normalizeSources(Array.from({ length: 10 }, (_, i) => ({ title: "[Doc]", url: `https://example.com/a(${i})` })));
  const result = { text: "Answer", sources };
  const before = structuredClone(result);
  const output = formatSearchResult(result);
  assert.equal(output.match(/^- /gm)?.length, 8);
  assert.ok(output.includes("[\\[Doc\\]](<https://example.com/a(0)>)"));
  assert.match(output, /Showing 8 of 10/);
  assert.deepEqual(result, before);
});

test("text-only results preserve whitespace and exact output-limit boundaries", () => {
  for (const body of ["  Indented answer\n", "a".repeat(DEFAULT_MAX_BYTES), Array(2000).fill("x").join("\n")]) {
    assert.equal(formatSearchResult({ text: body, sources: [] }), body);
  }
});

test("byte/line truncation reserves complete sources and notice inside the output budget", () => {
  for (const body of ["结果\n".repeat(3000), "a".repeat(100_000), "结果 ".repeat(40_000), "x\n".repeat(1999)]) {
    const output = formatSearchResult({ text: body, sources: [cited, other] });
    assert.ok(Buffer.byteLength(output) <= DEFAULT_MAX_BYTES);
    assert.ok(output.split("\n").length <= DEFAULT_MAX_LINES);
    assert.match(output, /Search output truncated/);
    assert.ok(output.includes(cited.url));
    assert.ok(output.includes(other.url));
    assert.doesNotMatch(output, /\ufffd/);
  }
  const sources = normalizeSources(Array.from({ length: 8 }, (_, i) => ({ url: `https://example.com/${i}?q=${"<".repeat(3900)}` })));
  const output = formatSearchResult({ text: "a\n".repeat(50_000), sources });
  assert.ok(Buffer.byteLength(output) <= DEFAULT_MAX_BYTES);
  assert.ok(output.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(output, /## Sources/);
  assert.match(output, /Showing/);
});
