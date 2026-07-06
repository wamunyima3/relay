import { describe, expect, it } from "vitest";

import { buildSummary } from "../src/resume/summary.js";
import type { UcfDocument } from "../src/ucf/schema.js";
import { UCF_VERSION } from "../src/ucf/schema.js";

function doc(events: UcfDocument["events"]): UcfDocument {
  return {
    ucf_version: UCF_VERSION,
    conversation_id: "conv-1",
    title: "Untitled",
    source: { tool: "claude", exported_at: "2026-06-01T00:00:00Z" },
    project: { repo: null, commit: null, cwd_hint: "/repo/app", git_branch: null },
    events,
    redacted: false,
  };
}

describe("buildSummary", () => {
  it("skips provenance.meta turns when picking the opening/most-recent request", () => {
    const d = doc([
      {
        id: "e0",
        parent: null,
        role: "user",
        type: "message",
        content: [{ kind: "text", text: "Base directory for this skill: ...boilerplate..." }],
        provenance: { meta: true },
      },
      {
        id: "e1",
        parent: "e0",
        role: "user",
        type: "message",
        content: [{ kind: "text", text: "Please fix the login bug." }],
      },
      {
        id: "e2",
        parent: "e1",
        role: "assistant",
        type: "message",
        content: [{ kind: "text", text: "Sure, looking now." }],
      },
    ]);

    const summary = buildSummary(d);
    expect(summary).toContain("Opening request:\nPlease fix the login bug.");
    expect(summary).not.toContain("Base directory for this skill");
  });

  it("skips slash-command scaffolding (no provenance.meta flag, but text-recognizable) too", () => {
    const d = doc([
      {
        id: "e0",
        parent: null,
        role: "user",
        type: "message",
        content: [{ kind: "text", text: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" }],
      },
      {
        id: "e1",
        parent: "e0",
        role: "user",
        type: "message",
        content: [{ kind: "text", text: "How do I test the new feature?" }],
      },
    ]);

    const summary = buildSummary(d);
    expect(summary).toContain("Opening request:\nHow do I test the new feature?");
    expect(summary).not.toContain("command-name");
  });
});
