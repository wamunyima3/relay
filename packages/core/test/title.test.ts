import { describe, expect, it } from "vitest";
import { firstHumanPromptTitle, isInjectedText, toTitle } from "../src/util/title.js";

describe("isInjectedText", () => {
  it("flags injected scaffolding", () => {
    expect(isInjectedText("<environment_context>\n …")).toBe(true);
    expect(isInjectedText("# AGENTS.md instructions for /repo")).toBe(true);
    expect(isInjectedText("# Files mentioned by the user: ...")).toBe(true);
    expect(isInjectedText("<ide_opened_file>...")).toBe(true);
    expect(isInjectedText("   ")).toBe(true);
  });

  it("flags IDE context headers, aborted turns, and interruption markers", () => {
    expect(isInjectedText("# Context from my IDE setup:\n## Active file: src/app.tsx")).toBe(true);
    expect(isInjectedText("<turn_aborted> The user interrupted the previous turn on purpose.")).toBe(true);
    expect(isInjectedText("[Request interrupted by user]")).toBe(true);
  });

  it("treats a real prompt as human", () => {
    expect(isInjectedText("Fix the checkbox bug please")).toBe(false);
  });
});

describe("toTitle", () => {
  it("collapses whitespace, drops code fences, and caps length", () => {
    expect(toTitle("hello\n\n  world")).toBe("hello world");
    expect(toTitle("do this ```js\nx=1\n``` now")).toBe("do this now");
    expect(toTitle("a".repeat(200)).endsWith("…")).toBe(true);
    expect(toTitle("a".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe("firstHumanPromptTitle", () => {
  it("skips injected messages and returns the first real user prompt", () => {
    const title = firstHumanPromptTitle([
      { role: "user", text: "<environment_context>cwd=/repo</environment_context>" },
      { role: "user", text: "# AGENTS.md instructions for /repo" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "Refactor the auth module" },
    ]);
    expect(title).toBe("Refactor the auth module");
  });

  it("returns undefined when there is no human prompt", () => {
    expect(firstHumanPromptTitle([{ role: "user", text: "<permissions>...</permissions>" }])).toBeUndefined();
  });
});
