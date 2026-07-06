import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { readJsonl } from "../src/util/jsonl.js";

let work: string;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "relay-test-"));
  process.env.RELAY_CLAUDE_DIR = join(work, "claude");
  process.env.RELAY_CODEX_DIR = join(work, "codex");
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.RELAY_CLAUDE_DIR;
  delete process.env.RELAY_CODEX_DIR;
});

/** A small but representative Claude session, mirroring the real JSONL shape. */
function claudeFixture(): string {
  const sid = "11111111-1111-1111-1111-111111111111";
  const lines = [
    { type: "ai-title", aiTitle: "Fix the checkbox bug" },
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: sid,
      cwd: "/repo/app",
      gitBranch: "main",
      version: "1.0.0",
      timestamp: "2026-06-01T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "The checkbox does not toggle." }] },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: sid,
      timestamp: "2026-06-01T10:00:05Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "look at the handler", signature: "sig" },
          { type: "text", text: "Let me read the file." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/app/cb.tsx" } },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: sid,
      timestamp: "2026-06-01T10:00:06Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "export const CB = () => {}" }],
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** A small Codex rollout, mirroring the real response_item shape. */
function codexFixture(): string {
  const sid = "22222222-2222-2222-2222-222222222222";
  const lines = [
    { timestamp: "2026-03-31T07:00:00Z", type: "session_meta", payload: { id: sid, cwd: "/repo/app", cli_version: "0.118.0", originator: "codex_cli" } },
    { timestamp: "2026-03-31T07:00:01Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-03-31T07:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "list the services" }] } },
    { timestamp: "2026-03-31T07:00:03Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "I will grep" }] } },
    { timestamp: "2026-03-31T07:00:04Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "call_1" } },
    { timestamp: "2026-03-31T07:00:05Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "service-a\nservice-b" } },
    { timestamp: "2026-03-31T07:00:06Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "There are two services." }] } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("ClaudeAdapter", () => {
  it("exports a native session to UCF preserving the parent chain and tools", async () => {
    const dir = join(work, "claude", "-repo-app");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
    await writeFile(path, claudeFixture());

    const adapter = new ClaudeAdapter();
    const ref = await adapter.resolve(path);
    expect(ref.title).toBe("Fix the checkbox bug");

    const doc = await adapter.exportSession(ref);
    expect(doc.source.tool).toBe("claude");
    expect(doc.project.cwd_hint).toBe("/repo/app");
    expect(doc.project.git_branch).toBe("main");

    const types = doc.events.map((e) => e.type);
    expect(types).toContain("message");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");

    const toolCall = doc.events.find((e) => e.type === "tool_call");
    expect(toolCall?.tool).toBe("Read");
    expect(toolCall?.input).toEqual({ file_path: "/repo/app/cb.tsx" });

    const toolResult = doc.events.find((e) => e.type === "tool_result");
    expect(toolResult?.ref).toBe("toolu_1");
    expect(toolResult?.output).toContain("export const CB");

    // The root user message has no parent; everything else chains.
    const root = doc.events[0]!;
    expect(root.parent).toBeNull();
    for (const ev of doc.events.slice(1)) expect(ev.parent).not.toBeNull();
  });

  it("round-trips through native import into valid resumable JSONL", async () => {
    const adapter = new ClaudeAdapter();
    const srcDir = join(work, "claude", "-repo-app");
    const srcPath = join(srcDir, "11111111-1111-1111-1111-111111111111.jsonl");
    const doc = await adapter.exportSession(await adapter.resolve(srcPath));

    const result = await adapter.importSession(doc, { mode: "native", cwd: "/repo/app" });
    expect(result.resumeCommand).toContain("claude --resume");
    const { objects } = await readJsonl(result.path);
    expect(objects.length).toBeGreaterThan(0);
    // First emitted line is the opening user message with no parent.
    const first = objects[0] as { type: string; parentUuid: unknown };
    expect(first.type).toBe("user");
    expect(first.parentUuid).toBeNull();
  });

  it("resolves a session by its short id prefix, matching how `relay list` displays it", async () => {
    const adapter = new ClaudeAdapter();
    const fullId = "11111111-1111-1111-1111-111111111111";
    const ref = await adapter.resolve(fullId.slice(0, 8));
    expect(ref.id).toBe(fullId);
  });

  it("exports user/assistant turns whose message.content is a bare string, not a block array", async () => {
    const sid = "44444444-4444-4444-4444-444444444444";
    const lines = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: sid,
        cwd: "/repo/app",
        timestamp: "2026-06-01T09:00:00Z",
        message: { role: "user", content: "quick question, is this complete?" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        timestamp: "2026-06-01T09:00:01Z",
        message: { role: "assistant", content: "Let me check." },
      },
    ];
    const dir = join(work, "claude", "-repo-app3");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sid}.jsonl`);
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const adapter = new ClaudeAdapter();
    const ref = await adapter.resolve(path);
    const doc = await adapter.exportSession(ref);
    expect(doc.events).toHaveLength(2);
    expect(doc.events[0]?.content).toEqual([{ kind: "text", text: "quick question, is this complete?" }]);
    expect(doc.events[1]?.content).toEqual([{ kind: "text", text: "Let me check." }]);
  });

  it("does not treat isMeta lines (skill/slash-command bodies) as the genuine first prompt", async () => {
    const sid = "33333333-3333-3333-3333-333333333333";
    const lines = [
      {
        type: "user",
        uuid: "u0",
        parentUuid: null,
        sessionId: sid,
        cwd: "/repo/app",
        timestamp: "2026-06-01T09:00:00Z",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /some/skill/path\n\nLots of injected boilerplate." }] },
      },
      {
        type: "user",
        uuid: "u1",
        parentUuid: "u0",
        sessionId: sid,
        timestamp: "2026-06-01T09:00:01Z",
        message: { role: "user", content: [{ type: "text", text: "Please fix the login bug." }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        sessionId: sid,
        timestamp: "2026-06-01T09:00:02Z",
        message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Sure, looking now." }] },
      },
    ];
    const dir = join(work, "claude", "-repo-app2");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${sid}.jsonl`);
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const adapter = new ClaudeAdapter();
    const ref = await adapter.resolve(path);
    expect(ref.title).toBe("Please fix the login bug.");
    // The isMeta line shouldn't count toward the displayed message count either.
    expect(ref.messageCount).toBe(2);

    const doc = await adapter.exportSession(ref);
    const metaEvent = doc.events.find((e) => e.provenance?.meta === true);
    expect(metaEvent).toBeTruthy();
    const genuineEvent = doc.events.find((e) => e.content.some((b) => b.kind === "text" && b.text === "Please fix the login bug."));
    expect(genuineEvent?.provenance?.meta).toBeFalsy();
  });

  it("packages a replay session as a single priming message", async () => {
    const adapter = new ClaudeAdapter();
    const srcPath = join(work, "claude", "-repo-app", "11111111-1111-1111-1111-111111111111.jsonl");
    const doc = await adapter.exportSession(await adapter.resolve(srcPath));
    const result = await adapter.importSession(doc, {
      mode: "replay",
      cwd: "/repo/app",
      primingPrompt: "RESUME-ME",
    });
    const { objects } = await readJsonl(result.path);
    expect(objects.length).toBe(1);
    const line = objects[0] as { message: { content: { text: string }[] } };
    expect(line.message.content[0]!.text).toBe("RESUME-ME");
  });
});

describe("CodexAdapter", () => {
  it("exports a rollout to UCF mapping messages, reasoning, and tool calls", async () => {
    const dir = join(work, "codex", "2026", "03", "31");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "rollout-2026-03-31T07-00-00-22222222.jsonl");
    await writeFile(path, codexFixture());

    const adapter = new CodexAdapter();
    const ref = await adapter.resolve(path);
    const doc = await adapter.exportSession(ref);

    expect(doc.source.tool).toBe("codex");
    expect(doc.project.cwd_hint).toBe("/repo/app");

    const toolCall = doc.events.find((e) => e.type === "tool_call");
    expect(toolCall?.tool).toBe("exec_command");
    expect(toolCall?.input).toEqual({ cmd: "ls" });

    const toolResult = doc.events.find((e) => e.type === "tool_result");
    expect(toolResult?.ref).toBe("call_1");
    expect(toolResult?.output).toContain("service-a");

    const thinking = doc.events.find((e) => e.content.some((b) => b.kind === "thinking"));
    expect(thinking).toBeTruthy();
  });

  it("imports UCF into a native rollout with a session_meta header", async () => {
    const adapter = new CodexAdapter();
    const claude = new ClaudeAdapter();
    const srcPath = join(work, "claude", "-repo-app", "11111111-1111-1111-1111-111111111111.jsonl");
    const doc = await claude.exportSession(await claude.resolve(srcPath));

    const result = await adapter.importSession(doc, { mode: "native", cwd: "/repo/app" });
    expect(result.resumeCommand).toContain("codex resume");
    const { objects } = await readJsonl(result.path);
    const meta = objects[0] as { type: string; payload: { id: string } };
    expect(meta.type).toBe("session_meta");
    expect(meta.payload.id).toBe(result.sessionId);
  });
});
