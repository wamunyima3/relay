import { describe, expect, it } from "vitest";
import { redactString } from "../src/redact/redact.js";
import { redactUcf } from "../src/redact/redactUcf.js";
import { UCF_VERSION, type UcfDocument } from "../src/ucf/schema.js";

describe("redactString", () => {
  it("masks an Anthropic key", () => {
    const r = redactString("key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
    expect(r.text).not.toContain("sk-ant-api03");
    expect(r.text).toContain("[REDACTED");
    expect(r.total).toBeGreaterThan(0);
  });

  it("masks a GitHub token", () => {
    const r = redactString("token ghp_0123456789012345678901234567890123456");
    expect(r.text).toContain("[REDACTED:github-token]");
  });

  it("masks a private key block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nABCDEF\n-----END RSA PRIVATE KEY-----";
    const r = redactString(pem);
    expect(r.text).toBe("[REDACTED:private-key]");
  });

  it("masks the value of a SECRET= assignment but keeps the key", () => {
    const r = redactString('DB_PASSWORD="hunter2horse"');
    expect(r.text).toContain("DB_PASSWORD");
    expect(r.text).not.toContain("hunter2horse");
  });

  it("leaves ordinary prose alone", () => {
    const text = "We ran the tests and everything passed on branch main.";
    const r = redactString(text);
    expect(r.text).toBe(text);
    expect(r.total).toBe(0);
  });
});

describe("redactUcf", () => {
  it("redacts text blocks and tool output, setting the flag", () => {
    const doc: UcfDocument = {
      ucf_version: UCF_VERSION,
      conversation_id: "c1",
      source: { tool: "codex", exported_at: "2026-01-01T00:00:00Z" },
      project: { repo: null, commit: null, cwd_hint: null, git_branch: null },
      redacted: false,
      events: [
        {
          id: "1",
          parent: null,
          role: "user",
          type: "message",
          content: [{ kind: "text", text: "use ghp_0123456789012345678901234567890123456" }],
        },
        {
          id: "2",
          parent: "1",
          role: "tool",
          type: "tool_result",
          content: [],
          ref: "x",
          output: "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz",
        },
      ],
    };
    const { doc: out, report } = redactUcf(doc);
    expect(report.total).toBeGreaterThanOrEqual(2);
    expect(out.redacted).toBe(true);
    expect(JSON.stringify(out)).not.toContain("ghp_0123456789");
    expect(JSON.stringify(out)).not.toContain("sk-proj-abcdef");
  });
});
