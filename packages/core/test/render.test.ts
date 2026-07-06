import { describe, expect, it } from "vitest";

import { buildPrimingPrompt } from "../src/resume/render.js";
import type { UcfDocument } from "../src/ucf/schema.js";
import { UCF_VERSION } from "../src/ucf/schema.js";

function bigDoc(turns: number, textSize: number): UcfDocument {
  const events: UcfDocument["events"] = [];
  for (let i = 0; i < turns; i++) {
    events.push({
      id: `e${i}`,
      parent: i === 0 ? null : `e${i - 1}`,
      role: i % 2 === 0 ? "user" : "assistant",
      type: "message",
      content: [{ kind: "text", text: `turn ${i} ` + "x".repeat(textSize) }],
    });
  }
  return {
    ucf_version: UCF_VERSION,
    conversation_id: "conv-1",
    title: "big session",
    source: { tool: "codex", exported_at: "2026-06-01T00:00:00Z" },
    project: { repo: null, commit: null, cwd_hint: null, git_branch: null },
    events,
    redacted: false,
    summary: "recap text",
  };
}

describe("buildPrimingPrompt", () => {
  it("keeps small sessions whole, with no elision note", () => {
    const prompt = buildPrimingPrompt(bigDoc(4, 100), "Claude Code");
    expect(prompt).toContain("## Full prior transcript");
    expect(prompt).toContain("turn 0");
    expect(prompt).toContain("turn 3");
    expect(prompt).not.toContain("elided");
  });

  it("elides the oldest events of a huge session and says so, keeping the recent tail", () => {
    // 100 turns × ~5KB each ≈ 500KB of transcript against a 50KB budget.
    const prompt = buildPrimingPrompt(bigDoc(100, 5_000), "Claude Code", { maxTranscriptChars: 50_000 });
    expect(prompt.length).toBeLessThan(80_000);
    expect(prompt).toContain("elided to fit your context");
    expect(prompt).toContain("turn 99"); // newest survives
    expect(prompt).not.toContain("turn 0 "); // oldest falls off
    expect(prompt).toContain("recap text"); // recap always present
  });

  it("always keeps at least the most recent event, even over budget", () => {
    const prompt = buildPrimingPrompt(bigDoc(3, 10_000), "Codex", { maxTranscriptChars: 100 });
    expect(prompt).toContain("turn 2");
  });
});
