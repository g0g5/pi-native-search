import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SEARCH_BACKENDS, SEARCH_BACKEND_IDS } from "../extensions/search-providers.ts";
import { normalizeSearchConfig } from "../extensions/search-config.ts";

interface DocumentedBackend {
  name: string;
  kind: string;
  auth: string;
  env_key?: string;
}

function parseBackends(yaml: string): Record<string, DocumentedBackend> {
  const result: Record<string, DocumentedBackend> = {};
  let current: string | undefined;
  for (const raw of yaml.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line === "backends:") continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 2 && line.endsWith(":")) {
      current = line.slice(0, -1);
      result[current] = { name: "", kind: "", auth: "" };
      continue;
    }
    if (indent === 4 && current) {
      const separator = line.indexOf(":");
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
      (result[current] as Record<string, string>)[key] = value;
    }
  }
  return result;
}

const documented = parseBackends(readFileSync(new URL("../providers.yaml", import.meta.url), "utf-8"));

test("providers.yaml documents exactly the runtime search backends", () => {
  assert.deepEqual(Object.keys(documented).sort(), [...SEARCH_BACKEND_IDS].sort());
});

test("documented kind, auth, env key, and label match the runtime registry", () => {
  for (const id of SEARCH_BACKEND_IDS) {
    const doc = documented[id];
    const runtime = SEARCH_BACKENDS[id];
    assert.ok(doc, `${id} must be documented`);
    assert.equal(doc.kind, runtime.kind, `${id} kind`);
    assert.equal(doc.auth, runtime.auth, `${id} auth`);
    assert.equal(doc.name, runtime.name, `${id} name`);
    if (runtime.envKey) assert.equal(doc.env_key, runtime.envKey, `${id} env key`);
    else assert.equal(doc.env_key, undefined, `${id} must not document an env key`);
  }
});

test("providers.yaml does not advertise removed provider capabilities", () => {
  const yaml = readFileSync(new URL("../providers.yaml", import.meta.url), "utf-8");
  for (const removed of ["deepseek", "openrouter", "mistral", "perplexity", "native_search:", "native_fetch:"]) {
    assert.equal(yaml.includes(removed), false, `providers.yaml must not mention ${removed}`);
  }
});

test("README configuration examples are accepted by the config parser", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const configExamples = blocks
    .map((block) => {
      try {
        return JSON.parse(block);
      } catch {
        return undefined;
      }
    })
    .filter((value) => value && typeof value === "object" && "searchProvider" in value);

  assert.ok(configExamples.length >= 2, "README must document the global config shape and a migration example");
  for (const example of configExamples) {
    const state = normalizeSearchConfig(example);
    assert.equal(state.error, undefined, `README example must be valid: ${JSON.stringify(example)}`);
    assert.equal(state.config.searchProvider, example.searchProvider);
    assert.equal(state.config.searchModel, example.searchModel);
    assert.equal(state.migrationNotice, undefined);
  }
});

test("README provenance example documents the fields the tool actually emits", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
  const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const example = blocks
    .map((block) => {
      try {
        return JSON.parse(block);
      } catch {
        return undefined;
      }
    })
    .find((value) => value && typeof value === "object" && "attempts" in value && "provider" in value);
  assert.ok(example, "README must show a provenance example with attempt history");
  for (const field of ["query", "provider", "method", "tier", "sources", "apiSources", "attempts"]) {
    assert.ok(field in example, `provenance example must include ${field}`);
  }
  assert.ok(["configured", "session", "fallback"].includes(example.tier));
  assert.ok(["native", "ddg"].includes(example.method));
});
