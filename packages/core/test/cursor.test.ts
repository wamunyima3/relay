import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CursorAdapter } from "../src/adapters/cursor.js";
import { UCF_VERSION } from "../src/ucf/schema.js";

const require = createRequire(import.meta.url);

let work: string;
let dbPath: string;
const CID = "comp-1111";
const UNNAMED_CID = "comp-2222";
const EMPTY_CID = "comp-3333";

/** Build a tiny Cursor-shaped state.vscdb fixture. */
function buildFixtureDb(path: string): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...a: unknown[]): void };
      close(): void;
    };
  };
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  const putItem = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  putItem.run(
    "composer.composerHeaders",
    JSON.stringify({
      allComposers: [
        { composerId: CID, name: "Fix the Dockerfile", createdAt: 1, lastUpdatedAt: 2, type: "head", unifiedMode: "agent" },
        { composerId: UNNAMED_CID, createdAt: 1, lastUpdatedAt: 1, type: "head", unifiedMode: "agent" },
        { composerId: EMPTY_CID, createdAt: 1, lastUpdatedAt: 1, type: "head", unifiedMode: "agent" },
      ],
    }),
  );
  const put = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");

  // An unnamed conversation — its title must fall back to the first user prompt.
  put.run(`composerData:${UNNAMED_CID}`, JSON.stringify({
    composerId: UNNAMED_CID,
    createdAt: 1_600_000_000_000,
    lastUpdatedAt: 1_600_000_500_000,
    fullConversationHeadersOnly: [{ bubbleId: "u1", type: 1 }],
    _v: 16,
  }));
  put.run(`bubbleId:${UNNAMED_CID}:u1`, JSON.stringify({ type: 1, text: "Why is the login page slow?" }));

  // An empty shell (opened but never used) — must be hidden from listings.
  put.run(`composerData:${EMPTY_CID}`, JSON.stringify({
    composerId: EMPTY_CID,
    createdAt: 1_600_000_000_000,
    lastUpdatedAt: 1_600_000_000_000,
    fullConversationHeadersOnly: [],
    _v: 16,
  }));

  const headers = [
    { bubbleId: "b1", type: 1 },
    { bubbleId: "b2", type: 2 },
  ];
  put.run(`composerData:${CID}`, JSON.stringify({
    composerId: CID,
    name: "Fix the Dockerfile",
    createdAt: 1_700_000_000_000,
    lastUpdatedAt: 1_700_000_500_000,
    fullConversationHeadersOnly: headers,
    _v: 16,
  }));

  // user bubble
  put.run(`bubbleId:${CID}:b1`, JSON.stringify({ type: 1, text: "The Dockerfile fails to build" }));
  // assistant bubble: thinking + tool call/result + text
  put.run(`bubbleId:${CID}:b2`, JSON.stringify({
    type: 2,
    thinking: { text: "inspect the build" },
    toolFormerData: {
      name: "read_file",
      toolCallId: "tool-9",
      rawArgs: JSON.stringify({ path: "/home/me/proj/app/Dockerfile" }),
      result: "FROM node:20\nRUN npm ci",
      status: "completed",
    },
    text: "The base image flag is invalid; here is the fix.",
  }));

  db.close();
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "relay-cursor-"));
  dbPath = join(work, "state.vscdb");
  buildFixtureDb(dbPath);
  process.env.RELAY_CURSOR_DB = dbPath;
  process.env.RELAY_BACKUPS_DIR = join(work, "backups");
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.RELAY_CURSOR_DB;
  delete process.env.RELAY_BACKUPS_DIR;
});

describe("CursorAdapter", () => {
  it("lists conversations from the fast index (titles; counts omitted for speed)", async () => {
    const adapter = new CursorAdapter();
    expect(await adapter.available()).toBe(true);
    const sessions = await adapter.list();
    expect(sessions).toHaveLength(2);
    const named = sessions.find((s) => s.id === CID)!;
    expect(named.title).toBe("Fix the Dockerfile");
    expect(named.messageCount).toBeUndefined(); // index has no count
    expect(named.tool).toBe("cursor");
  });

  it("falls back to the first user prompt for unnamed conversations", async () => {
    const adapter = new CursorAdapter();
    const sessions = await adapter.list();
    const unnamed = sessions.find((s) => s.id === UNNAMED_CID)!;
    expect(unnamed.title).toBe("Why is the login page slow?");
  });

  it("hides empty conversation shells (opened but never used)", async () => {
    const adapter = new CursorAdapter();
    const sessions = await adapter.list();
    expect(sessions.some((s) => s.id === EMPTY_CID)).toBe(false);
  });

  it("exports bubbles to UCF: message, thinking, tool_call + result", async () => {
    const adapter = new CursorAdapter();
    const ref = await adapter.resolve(CID);
    const doc = await adapter.exportSession(ref);

    expect(doc.source.tool).toBe("cursor");
    expect(doc.title).toBe("Fix the Dockerfile");

    const types = doc.events.map((e) => e.type);
    expect(types).toEqual(["message", "message", "tool_call", "tool_result", "message"]);

    const userMsg = doc.events[0]!;
    expect(userMsg.role).toBe("user");
    expect(userMsg.content[0]).toMatchObject({ kind: "text", text: "The Dockerfile fails to build" });

    const thinking = doc.events[1]!;
    expect(thinking.content[0]!.kind).toBe("thinking");

    const toolCall = doc.events.find((e) => e.type === "tool_call")!;
    expect(toolCall.tool).toBe("read_file");
    expect(toolCall.input).toEqual({ path: "/home/me/proj/app/Dockerfile" });

    const toolResult = doc.events.find((e) => e.type === "tool_result")!;
    expect(toolResult.ref).toBe("tool-9");
    expect(toolResult.output).toContain("FROM node:20");

    // cwd is inferred from the referenced file path.
    expect(doc.project.cwd_hint).toBe("/home/me/proj/app");
  });

  it("injects a conversation as a new chat at the top of the index", async () => {
    const adapter = new CursorAdapter();
    const doc = {
      ucf_version: UCF_VERSION,
      conversation_id: "src",
      title: "Resumed from Codex",
      source: { tool: "codex", exported_at: "2026-01-01T00:00:00Z" },
      project: { repo: null, commit: null, cwd_hint: null, git_branch: null },
      redacted: false,
      events: [
        { id: "1", parent: null, role: "user", type: "message", content: [{ kind: "text", text: "continue here" }] },
        { id: "2", parent: "1", role: "assistant", type: "message", content: [{ kind: "text", text: "sure thing" }] },
      ],
    } as const;

    const result = await adapter.importSession(doc as unknown as Parameters<typeof adapter.importSession>[0], {
      mode: "native",
    });
    expect(result.tool).toBe("cursor");
    expect(result.resumeCommand).toBe(""); // GUI-only, no terminal command
    expect(result.note).toMatch(/Cursor/);
    expect(result.backupPath).toBeTruthy();

    // It shows up in the listing, at the top (newest), and re-exports its messages.
    const sessions = await adapter.list();
    expect(sessions[0]!.id).toBe(result.sessionId);
    expect(sessions[0]!.title).toBe("Resumed from Codex");

    const reexported = await adapter.exportSession(sessions[0]!);
    const texts = reexported.events.map((e) => (e.content[0] as { text?: string })?.text);
    expect(texts).toContain("continue here");
    expect(texts).toContain("sure thing");

    // The original index entry is preserved (not clobbered).
    expect(sessions.some((s) => s.id === CID)).toBe(true);
  });
});

describe("CursorAdapter on a machine without Cursor installed", () => {
  it("importSession fails with a clear message instead of a raw SQLite error", async () => {
    const missingDbDir = await mkdtemp(join(tmpdir(), "relay-no-cursor-"));
    const prevDb = process.env.RELAY_CURSOR_DB;
    process.env.RELAY_CURSOR_DB = join(missingDbDir, "state.vscdb"); // never created
    try {
      const adapter = new CursorAdapter();
      expect(await adapter.available()).toBe(false);
      const doc = {
        ucf_version: UCF_VERSION,
        conversation_id: "src",
        title: "Resumed from Codex",
        source: { tool: "codex", exported_at: "2026-01-01T00:00:00Z" },
        project: { repo: null, commit: null, cwd_hint: null, git_branch: null },
        redacted: false,
        events: [],
      } as const;
      await expect(
        adapter.importSession(doc as unknown as Parameters<typeof adapter.importSession>[0], { mode: "replay" }),
      ).rejects.toThrow("Cursor storage not found on this machine.");
    } finally {
      process.env.RELAY_CURSOR_DB = prevDb;
      await rm(missingDbDir, { recursive: true, force: true });
    }
  });
});
