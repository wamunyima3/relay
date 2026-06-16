import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { exportToUcf, resumeIntoTool } from "../src/core.js";
import { parseUcf } from "../src/ucf/schema.js";
import { buildPrimingPrompt, renderMarkdown } from "../src/resume/render.js";
import { readJsonl } from "../src/util/jsonl.js";

let work: string;

const CODEX_FIXTURE = [
  { timestamp: "2026-03-31T07:00:00Z", type: "session_meta", payload: { id: "33333333-3333-3333-3333-333333333333", cwd: "/repo/app", cli_version: "0.118.0" } },
  { timestamp: "2026-03-31T07:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Refactor the auth module. My key is sk-ant-api03-SECRETSECRETSECRETSECRET00." }] } },
  { timestamp: "2026-03-31T07:00:04Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"grep -r auth ."}', call_id: "call_9" } },
  { timestamp: "2026-03-31T07:00:05Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_9", output: "auth.ts:1" } },
  { timestamp: "2026-03-31T07:00:06Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found it in auth.ts." }] } },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "relay-pipe-"));
  process.env.RELAY_CLAUDE_DIR = join(work, "claude");
  process.env.RELAY_CODEX_DIR = join(work, "codex");
  const dir = join(work, "codex", "2026", "03", "31");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-2026-03-31T07-00-00-33333333.jsonl"), CODEX_FIXTURE);
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.RELAY_CLAUDE_DIR;
  delete process.env.RELAY_CODEX_DIR;
});

describe("end-to-end Codex → Claude", () => {
  it("exports, redacts, summarizes, and validates against the UCF schema", async () => {
    const { doc, redaction } = await exportToUcf("codex");
    // Secret in the user message must be gone, and flagged.
    expect(JSON.stringify(doc)).not.toContain("sk-ant-api03-SECRET");
    expect(doc.redacted).toBe(true);
    expect(redaction!.total).toBeGreaterThan(0);
    // Summary is generated.
    expect(doc.summary).toContain("Refactor the auth module");
    // The document is schema-valid.
    expect(() => parseUcf(doc)).not.toThrow();
  });

  it("stages a replay resume into Claude with a priming prompt", async () => {
    const { doc } = await exportToUcf("codex");
    const result = await resumeIntoTool("claude", doc, { mode: "replay", cwd: "/repo/app" });
    expect(result.tool).toBe("claude");
    const { objects } = await readJsonl(result.path);
    expect(objects.length).toBe(1);
    const line = objects[0] as { message: { content: { text: string }[] } };
    expect(line.message.content[0]!.text).toContain("resuming a coding conversation");
    expect(line.message.content[0]!.text).toContain("Codex");
  });

  it("renders a readable markdown transcript and priming prompt", async () => {
    const { doc } = await exportToUcf("codex");
    const md = renderMarkdown(doc);
    expect(md).toContain("# Conversation");
    expect(md).toContain("🧑 User");
    const prompt = buildPrimingPrompt(doc, "Claude Code");
    expect(prompt).toContain("## Recap");
    expect(prompt).toContain("## Full prior transcript");
  });
});
