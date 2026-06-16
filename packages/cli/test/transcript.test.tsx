import { describe, expect, it } from "vitest";
import { UCF_VERSION, type UcfDocument } from "@relay/core";
import { buildTranscriptLines } from "../src/ui/transcript.js";

function doc(events: UcfDocument["events"]): UcfDocument {
  return {
    ucf_version: UCF_VERSION,
    conversation_id: "c1",
    title: "demo",
    source: { tool: "codex", exported_at: "2026-01-01T00:00:00Z" },
    project: { repo: null, commit: null, cwd_hint: null, git_branch: null },
    events,
    redacted: false,
  };
}

describe("buildTranscriptLines", () => {
  it("renders dialogue, skips injected scaffolding, and compacts tool calls", () => {
    const lines = buildTranscriptLines(
      doc([
        { id: "0", parent: null, role: "system", type: "message", content: [{ kind: "text", text: "<environment_context>cwd=/x</environment_context>" }] },
        { id: "1", parent: null, role: "user", type: "message", content: [{ kind: "text", text: "Fix the build" }] },
        { id: "2", parent: "1", role: "assistant", type: "tool_call", content: [], tool: "shell", input: { cmd: "npm test" } },
        { id: "3", parent: "2", role: "tool", type: "tool_result", content: [], ref: "x", output: "1 failing\nstack..." },
        { id: "4", parent: "3", role: "assistant", type: "message", content: [{ kind: "text", text: "Found the bug." }] },
      ]),
      100,
    );
    const text = lines.map((l) => l.text).join("\n");

    expect(text).toContain("🧑 You");
    expect(text).toContain("Fix the build");
    expect(text).toContain("🤖 Assistant");
    expect(text).toContain("Found the bug.");
    expect(text).toContain("🔧 shell(npm test)");
    expect(text).toContain("↳ 1 failing");
    // Injected scaffolding is hidden.
    expect(text).not.toContain("environment_context");
  });
});
