import { describe, expect, it } from "vitest";

import { stripScaffolding } from "../src/resume/strip.js";
import type { UcfDocument } from "../src/ucf/schema.js";
import { UCF_VERSION } from "../src/ucf/schema.js";

function doc(events: UcfDocument["events"]): UcfDocument {
  return {
    ucf_version: UCF_VERSION,
    conversation_id: "conv-1",
    title: "demo",
    source: { tool: "codex", exported_at: "2026-06-01T00:00:00Z" },
    project: { repo: null, commit: null, cwd_hint: null, git_branch: null },
    events,
    redacted: false,
  };
}

describe("stripScaffolding", () => {
  it("drops injected user/system turns and provenance.meta events, keeps real dialogue and tools", () => {
    const d = doc([
      { id: "e0", parent: null, role: "system", type: "message", content: [{ kind: "text", text: "<permissions instructions>…" }] },
      { id: "e1", parent: "e0", role: "user", type: "message", content: [{ kind: "text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>…" }] },
      { id: "e2", parent: "e1", role: "user", type: "message", content: [{ kind: "text", text: "skill body" }], provenance: { meta: true } },
      { id: "e3", parent: "e2", role: "user", type: "message", content: [{ kind: "text", text: "Fix the login bug." }] },
      { id: "e4", parent: "e3", role: "assistant", type: "tool_call", content: [], tool: "shell", input: { cmd: "ls" } },
      { id: "e5", parent: "e4", role: "tool", type: "tool_result", content: [], ref: "e4", output: "ok" },
      { id: "e6", parent: "e5", role: "assistant", type: "message", content: [{ kind: "text", text: "Done." }] },
    ]);

    const out = stripScaffolding(d);
    expect(out.events.map((e) => e.id)).toEqual(["e3", "e4", "e5", "e6"]);
    // The first surviving event is re-rooted; the rest keep their chain.
    expect(out.events[0]!.parent).toBeNull();
    expect(out.events[1]!.parent).toBe("e3");
  });

  it("remaps a child across a dropped parent to the nearest surviving ancestor", () => {
    const d = doc([
      { id: "e0", parent: null, role: "user", type: "message", content: [{ kind: "text", text: "Real question?" }] },
      { id: "e1", parent: "e0", role: "user", type: "message", content: [{ kind: "text", text: "<system-reminder>noise</system-reminder>" }] },
      { id: "e2", parent: "e1", role: "assistant", type: "message", content: [{ kind: "text", text: "Real answer." }] },
    ]);

    const out = stripScaffolding(d);
    expect(out.events.map((e) => e.id)).toEqual(["e0", "e2"]);
    expect(out.events[1]!.parent).toBe("e0");
  });

  it("never drops assistant text, even if it happens to start like scaffolding", () => {
    const d = doc([
      { id: "e0", parent: null, role: "assistant", type: "message", content: [{ kind: "text", text: "# AGENTS.md instructions — here is what that file means:" }] },
    ]);
    expect(stripScaffolding(d).events).toHaveLength(1);
  });

  it("does not mutate the input document", () => {
    const d = doc([
      { id: "e0", parent: null, role: "user", type: "message", content: [{ kind: "text", text: "<permissions instructions>…" }] },
      { id: "e1", parent: "e0", role: "user", type: "message", content: [{ kind: "text", text: "Hello" }] },
    ]);
    stripScaffolding(d);
    expect(d.events).toHaveLength(2);
    expect(d.events[1]!.parent).toBe("e0");
  });
});
