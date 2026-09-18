// Opt-in: sends one query using your existing Pi ChatGPT subscription.
// No prompt is sent to the outer agent; this invokes the registered tool directly.
//
// This check exercises the openai-codex backend through the normal routing
// pipeline, so it reads the real search-config.json in the agent directory.
// Automatic routing (no pinned backend) is recommended; pinning a different
// backend would legitimately route this query elsewhere and fail the check.
import assert from "node:assert/strict";
import { ModelRuntime, ModelRegistry, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

const registry = new ModelRegistry(await ModelRuntime.create());
const modelId = process.argv[2] || SettingsManager.create(process.cwd()).getDefaultModel();
if (!modelId) throw new Error("Pass an openai-codex model id or configure Pi's default model.");
const model = registry.find("openai-codex", modelId);
if (!model) throw new Error("Selected openai-codex model is not in Pi's catalog.");
let search: any;
extension({
  registerTool(tool: any) {
    if (tool.name === "web_search") search = tool;
  },
  registerCommand() {},
  on() {},
} as any);
const result = await search.execute(
  "live-test",
  {
    query: "Find the official Pi coding agent website and its official GitHub repository. Provide source URLs.",
  },
  AbortSignal.timeout(100_000),
  undefined,
  { model, modelRegistry: registry },
);
console.log(JSON.stringify(result, null, 2));
assert.equal(result.details?.method, "native", "DuckDuckGo fallback is not a passing native-search test");
assert.equal(result.details?.provider, "openai-codex", "live check targets the openai-codex backend");
assert.match(result.content[0].text, /https?:\/\//);
assert.ok(result.details.sources.length > 0, "native search must expose structured sources");
assert.ok(["configured", "session", "fallback"].includes(result.details.tier), "successful target must report a selection tier");
assert.equal(result.details.searchModel, model.id, "the successful LLM target must be identified by its exact model");
assert.deepEqual(result.attempts.map((attempt: any) => attempt.ok), [true]);
for (const source of result.details.sources) {
  assert.equal(typeof source.title, "string");
  assert.match(source.url, /^https?:\/\//);
}
