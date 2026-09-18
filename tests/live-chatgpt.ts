// Opt-in: sends one query using your existing Pi ChatGPT subscription.
// No prompt is sent to the outer agent; this invokes the registered tool directly.
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
  registerTool(tool: any) { if (tool.name === "web_search") search = tool; },
  registerCommand() {},
  on() {},
} as any);
const result = await search.execute("live-test", {
  query: "Find the official Pi coding agent website and its official GitHub repository. Provide source URLs.",
}, AbortSignal.timeout(100_000), undefined, { model, modelRegistry: registry });
console.log(JSON.stringify(result, null, 2));
assert.equal(result.details?.method, "native", "DuckDuckGo fallback is not a passing native-search test");
assert.match(result.content[0].text, /https?:\/\//);
assert.ok(result.details.sources.length > 0, "native search must expose structured sources");
for (const source of result.details.sources) {
  assert.equal(typeof source.title, "string");
  assert.match(source.url, /^https?:\/\//);
}
