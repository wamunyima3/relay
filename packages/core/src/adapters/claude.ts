import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";

import type {
  Adapter,
  ExportOptions,
  ImportOptions,
  ImportResult,
  SessionRef,
} from "./types.js";
import type { ContentBlock, UcfDocument, UcfEvent } from "../ucf/schema.js";
import { UCF_VERSION } from "../ucf/schema.js";
import { readJsonl, writeJsonl } from "../util/jsonl.js";
import { reduceOutput } from "../util/text.js";
import { claudeProjectsDir, encodeClaudeCwd } from "../util/paths.js";
import { firstHumanPromptTitle } from "../util/title.js";

/** Minimal shape of the Claude JSONL lines we care about. */
interface ClaudeLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  /** Model-generated title, carried on `type: "ai-title"` lines. */
  aiTitle?: string;
  /** Claude's own marker for synthetic/injected turns (slash commands, skill invocations) — never a genuine human prompt. */
  isMeta?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
}

/** Pull plain text out of a Claude message content array. */
function claudeMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Derive a conversation title from Claude lines: prefer the most recent
 * model-generated `aiTitle`, else the first genuine user prompt.
 */
function deriveClaudeTitle(lines: ClaudeLine[]): string | undefined {
  let aiTitle: string | undefined;
  const userMessages: { role: string | undefined; text: string }[] = [];
  for (const l of lines) {
    if (l.type === "ai-title" && l.aiTitle) aiTitle = l.aiTitle; // keep the last one
    if (l.type === "user" && !l.isMeta && l.message?.content) {
      userMessages.push({ role: "user", text: claudeMessageText(l.message.content) });
    }
  }
  return aiTitle ?? firstHumanPromptTitle(userMessages);
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        return JSON.stringify(b);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

export class ClaudeAdapter implements Adapter {
  readonly tool = "claude";
  readonly label = "Claude Code";

  async available(): Promise<boolean> {
    return existsSync(claudeProjectsDir());
  }

  async list(): Promise<SessionRef[]> {
    if (!existsSync(claudeProjectsDir())) return [];
    const projectDirs = await readdir(claudeProjectsDir(), { withFileTypes: true });

    // Gather every session file path first, then peek them all in parallel —
    // sequential reads make listing painfully slow against large stores.
    const paths: string[] = [];
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = join(claudeProjectsDir(), dir.name);
      try {
        for (const file of await readdir(dirPath)) {
          if (file.endsWith(".jsonl")) paths.push(join(dirPath, file));
        }
      } catch {
        // unreadable project dir — skip
      }
    }

    const settled = await Promise.all(paths.map((p) => this.peek(p).catch(() => null)));
    const refs = settled.filter((r): r is SessionRef => r !== null);
    refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return refs;
  }

  /** Read just enough of a file to build a SessionRef without full parsing. */
  private async peek(path: string): Promise<SessionRef> {
    const { objects } = await readJsonl(path);
    const lines = objects as ClaudeLine[];
    let cwd: string | undefined;
    let count = 0;
    for (const l of lines) {
      if (l.cwd && !cwd) cwd = l.cwd;
      if ((l.type === "user" || l.type === "assistant") && !l.isMeta && l.message?.content) count += 1;
    }
    const title = deriveClaudeTitle(lines);
    const st = await stat(path);
    return {
      tool: this.tool,
      id: basename(path, ".jsonl"),
      path,
      cwd,
      title,
      updatedAt: st.mtime.toISOString(),
      messageCount: count,
    };
  }

  async resolve(idOrPath: string): Promise<SessionRef> {
    if (idOrPath.endsWith(".jsonl") && (isAbsolute(idOrPath) || existsSync(idOrPath))) {
      return this.peek(idOrPath);
    }
    const all = await this.list();
    const match = all.find((s) => s.id === idOrPath || s.id.startsWith(idOrPath));
    if (!match) throw new Error(`Claude session not found: ${idOrPath}`);
    return match;
  }

  async exportSession(ref: SessionRef, opts: ExportOptions = {}): Promise<UcfDocument> {
    const { objects } = await readJsonl(ref.path);
    const lines = objects as ClaudeLine[];

    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let version: string | undefined;
    let model: string | undefined;
    const title = ref.title ?? deriveClaudeTitle(lines);
    let sessionId = ref.id;

    const events: UcfEvent[] = [];
    // Map a native line uuid -> the event id at the tail of that line, so child
    // lines (which reference their parent by native uuid) chain correctly.
    const lineTail = new Map<string, string>();

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const l = lines[lineNo]!;
      if (l.cwd && !cwd) cwd = l.cwd;
      if (l.gitBranch && !gitBranch) gitBranch = l.gitBranch;
      if (l.version && !version) version = l.version;
      if (l.sessionId) sessionId = l.sessionId;
      // Skip Relay's own placeholder so round-tripped sessions don't pin it.
      if (l.message?.model && l.message.model !== "relay" && !model) model = l.message.model;

      const isMsg = l.type === "user" || l.type === "assistant" || l.type === "system";
      const rawContent = l.message?.content;
      if (!isMsg || rawContent == null) continue;
      // Claude stores plain single-line turns as a bare string rather than the
      // typed content-block array; normalize so those aren't silently dropped.
      const content = typeof rawContent === "string" ? [{ type: "text", text: rawContent }] : rawContent;
      if (!Array.isArray(content)) continue;

      const role = (l.message?.role ?? l.type) as UcfEvent["role"];
      const uuid = l.uuid ?? `line-${lineNo}`;
      const parentEventId = l.parentUuid ? lineTail.get(l.parentUuid) ?? null : null;
      let prev: string | null = parentEventId;

      content.forEach((block: unknown, i: number) => {
        const ev = this.blockToEvent(block, {
          id: `${uuid}.${i}`,
          parent: prev,
          role,
          ts: l.timestamp,
          line: lineNo,
          maxOutputBytes: opts.maxOutputBytes,
          isMeta: l.isMeta,
        });
        if (ev) {
          events.push(ev);
          prev = ev.id;
        }
      });
      lineTail.set(uuid, prev ?? parentEventId ?? uuid);
    }

    return {
      ucf_version: UCF_VERSION,
      conversation_id: sessionId,
      title,
      source: {
        tool: this.tool,
        version,
        model,
        exported_at: new Date().toISOString(),
        native_session_id: sessionId,
      },
      project: {
        repo: null,
        commit: null,
        cwd_hint: cwd ?? null,
        git_branch: gitBranch ?? null,
      },
      events,
      redacted: false,
    };
  }

  private blockToEvent(
    block: unknown,
    ctx: {
      id: string;
      parent: string | null;
      role: UcfEvent["role"];
      ts?: string;
      line: number;
      maxOutputBytes?: number;
      isMeta?: boolean;
    },
  ): UcfEvent | null {
    if (!block || typeof block !== "object") return null;
    const b = block as Record<string, unknown>;
    const base = { id: ctx.id, parent: ctx.parent, ts: ctx.ts } as const;

    switch (b.type) {
      case "text":
        return {
          ...base,
          role: ctx.role,
          type: "message",
          content: [{ kind: "text", text: String(b.text ?? "") }],
          provenance: { native_type: "text", line: ctx.line, meta: ctx.isMeta || undefined },
        };
      case "thinking":
        return {
          ...base,
          role: "assistant",
          type: "message",
          content: [{ kind: "thinking", text: String(b.thinking ?? "") }],
          provenance: { native_type: "thinking", line: ctx.line },
        };
      case "tool_use":
        return {
          ...base,
          role: "assistant",
          type: "tool_call",
          content: [],
          tool: String(b.name ?? "unknown"),
          input: (b.input as Record<string, unknown>) ?? {},
          provenance: { native_id: String(b.id ?? ""), native_type: "tool_use", line: ctx.line },
        };
      case "tool_result": {
        const raw = normalizeToolResultContent(b.content);
        const reduced = reduceOutput(raw, ctx.maxOutputBytes);
        return {
          ...base,
          role: "tool",
          type: "tool_result",
          content: [],
          ref: String(b.tool_use_id ?? ""),
          output: reduced.output,
          truncation: reduced.truncation,
          provenance: { native_type: "tool_result", line: ctx.line },
        };
      }
      case "image":
        return {
          ...base,
          role: ctx.role,
          type: "message",
          content: [{ kind: "image", placeholder: "[image]" }],
          provenance: { native_type: "image", line: ctx.line },
        };
      default:
        return null;
    }
  }

  async importSession(doc: UcfDocument, opts: ImportOptions = {}): Promise<ImportResult> {
    const mode = opts.mode ?? "replay";
    const cwd = opts.cwd ?? doc.project.cwd_hint ?? process.cwd();
    const sessionId = randomUUID();
    const dir = join(claudeProjectsDir(), encodeClaudeCwd(cwd));
    const path = join(dir, `${sessionId}.jsonl`);
    const now = new Date().toISOString();

    const lines: unknown[] =
      mode === "replay"
        ? this.buildReplayLines(doc, opts, { sessionId, cwd, now })
        : this.buildNativeLines(doc, { sessionId, cwd, now });

    // Name the staged session after the original conversation, so Claude's
    // own picker and `relay list` show the real title rather than the first
    // words of a priming prompt.
    if (doc.title) {
      lines.unshift({ type: "ai-title", aiTitle: doc.title, sessionId, timestamp: now });
    }

    await writeJsonl(path, lines);
    return {
      tool: this.tool,
      sessionId,
      path,
      resumeCommand: `cd ${cwd} && claude --resume ${sessionId}`,
      mode,
    };
  }

  private claudeUserLine(
    text: string,
    ctx: { sessionId: string; cwd: string; now: string },
    parentUuid: string | null,
  ) {
    const uuid = randomUUID();
    return {
      line: {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        version: "relay",
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
        uuid,
        timestamp: ctx.now,
      },
      uuid,
    };
  }

  private buildReplayLines(
    doc: UcfDocument,
    opts: ImportOptions,
    ctx: { sessionId: string; cwd: string; now: string },
  ): unknown[] {
    const prompt = opts.primingPrompt ?? doc.summary ?? "(empty conversation)";
    return [this.claudeUserLine(prompt, ctx, null).line];
  }

  private buildNativeLines(
    doc: UcfDocument,
    ctx: { sessionId: string; cwd: string; now: string },
  ): unknown[] {
    const out: unknown[] = [];
    let parentUuid: string | null = null;
    // Claude Code warns when it can't recognize a session's model — carry the
    // real source model through instead of a "relay" placeholder when known.
    const model = doc.source.model ?? "relay";

    for (const ev of doc.events) {
      const uuid = randomUUID();
      const ts = ev.ts ?? ctx.now;
      const common = {
        parentUuid,
        isSidechain: false,
        userType: "external" as const,
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        version: "relay",
        uuid,
        timestamp: ts,
      };

      if (ev.type === "message") {
        // Skip pure-thinking events on native import (their cryptographic
        // signatures can't be reconstructed, and Claude rejects forged ones).
        const blocks = ev.content
          .filter((b) => b.kind === "text" || b.kind === "code")
          .map((b) => ({ type: "text", text: (b as { text: string }).text }));
        if (blocks.length === 0) continue;
        const role = ev.role === "assistant" ? "assistant" : "user";
        out.push({
          ...common,
          type: role,
          message: role === "assistant"
            ? { role, model, content: blocks }
            : { role, content: blocks },
        });
        parentUuid = uuid;
      } else if (ev.type === "tool_call") {
        out.push({
          ...common,
          type: "assistant",
          message: {
            role: "assistant",
            model,
            content: [
              {
                type: "tool_use",
                id: ev.provenance?.native_id || `toolu_${uuid.slice(0, 8)}`,
                name: ev.tool ?? "unknown",
                input: ev.input ?? {},
              },
            ],
          },
        });
        parentUuid = uuid;
      } else if (ev.type === "tool_result") {
        out.push({
          ...common,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: ev.ref ?? "",
                content: ev.output ?? "",
              },
            ],
          },
        });
        parentUuid = uuid;
      }
    }

    return out;
  }
}
