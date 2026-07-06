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
import type { UcfDocument, UcfEvent } from "../ucf/schema.js";
import { UCF_VERSION } from "../ucf/schema.js";
import { readJsonl, writeJsonl } from "../util/jsonl.js";
import { reduceOutput } from "../util/text.js";
import { codexSessionsDir, codexDateDir } from "../util/paths.js";
import { firstHumanPromptTitle } from "../util/title.js";

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

/** Pull readable text out of a Codex message/reasoning content array. */
function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function walkRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkRollouts(p)));
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export class CodexAdapter implements Adapter {
  readonly tool = "codex";
  readonly label = "Codex CLI";

  async available(): Promise<boolean> {
    return existsSync(codexSessionsDir());
  }

  async list(): Promise<SessionRef[]> {
    const files = await walkRollouts(codexSessionsDir());
    // Peek all rollouts in parallel for a responsive listing.
    const settled = await Promise.all(files.map((p) => this.peek(p).catch(() => null)));
    const refs = settled.filter((r): r is SessionRef => r !== null);
    refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return refs;
  }

  private async peek(path: string): Promise<SessionRef> {
    const { objects } = await readJsonl(path);
    const lines = objects as CodexLine[];
    let id = basename(path, ".jsonl");
    let cwd: string | undefined;
    let count = 0;
    let relayed = false;
    const userMessages: { role: string | undefined; text: string }[] = [];
    for (const l of lines) {
      if (l.type === "session_meta" && l.payload) {
        id = String(l.payload.id ?? id);
        cwd = l.payload.cwd ? String(l.payload.cwd) : cwd;
        if (l.payload.originator === "relay") relayed = true;
      }
      if (l.type === "response_item" && l.payload?.type === "message") {
        count += 1;
        if (l.payload.role === "user") {
          userMessages.push({ role: "user", text: codexText(l.payload.content) });
        }
      }
    }
    // Codex stores no title; its name is the first genuine user prompt.
    const title = firstHumanPromptTitle(userMessages);
    const st = await stat(path);
    return {
      tool: this.tool,
      id,
      path,
      cwd,
      title,
      updatedAt: st.mtime.toISOString(),
      messageCount: count,
      relayed: relayed || undefined,
    };
  }

  async resolve(idOrPath: string): Promise<SessionRef> {
    if (idOrPath.endsWith(".jsonl") && (isAbsolute(idOrPath) || existsSync(idOrPath))) {
      return this.peek(idOrPath);
    }
    const all = await this.list();
    const match = all.find((s) => s.id === idOrPath || basename(s.path).includes(idOrPath));
    if (!match) throw new Error(`Codex session not found: ${idOrPath}`);
    return match;
  }

  async exportSession(ref: SessionRef, opts: ExportOptions = {}): Promise<UcfDocument> {
    const { objects } = await readJsonl(ref.path);
    const lines = objects as CodexLine[];

    let sessionId = ref.id;
    let cwd: string | undefined;
    let version: string | undefined;
    let originator: string | undefined;
    let model: string | undefined;
    let repo: string | null = null;
    let commit: string | null = null;
    let gitBranch: string | null = null;

    const events: UcfEvent[] = [];
    let prev: string | null = null;
    let n = 0;
    const push = (ev: UcfEvent) => {
      events.push(ev);
      prev = ev.id;
    };

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const l = lines[lineNo]!;
      if (l.type === "session_meta" && l.payload) {
        sessionId = String(l.payload.id ?? sessionId);
        cwd = l.payload.cwd ? String(l.payload.cwd) : cwd;
        version = l.payload.cli_version ? String(l.payload.cli_version) : version;
        originator = l.payload.originator ? String(l.payload.originator) : originator;
        // Codex records git info in session_meta — use it for free.
        const git = l.payload.git as { repository_url?: string; commit_hash?: string; branch?: string } | undefined;
        if (git) {
          repo = git.repository_url ?? repo;
          commit = git.commit_hash ?? commit;
          gitBranch = git.branch ?? gitBranch;
        }
        continue;
      }
      // Codex records the active model on turn_context lines.
      if (l.type === "turn_context" && l.payload?.model && !model) {
        model = String(l.payload.model);
        continue;
      }
      if (l.type !== "response_item" || !l.payload) continue;
      const p = l.payload;
      const ts = l.timestamp;

      switch (p.type) {
        case "message": {
          const text = codexText(p.content);
          if (!text) break;
          let role = String(p.role ?? "user") as UcfEvent["role"];
          if (role === ("developer" as UcfEvent["role"])) role = "system";
          push({
            id: `codex-${n++}`,
            parent: prev,
            role,
            type: "message",
            content: [{ kind: "text", text }],
            ts,
            provenance: { native_type: "message", line: lineNo },
          });
          break;
        }
        case "reasoning": {
          const text = codexText(p.summary ?? p.content);
          if (!text) break;
          push({
            id: `codex-${n++}`,
            parent: prev,
            role: "assistant",
            type: "message",
            content: [{ kind: "thinking", text }],
            ts,
            provenance: { native_type: "reasoning", line: lineNo },
          });
          break;
        }
        case "function_call":
        case "custom_tool_call": {
          const callId = String(p.call_id ?? `codex-${n}`);
          let input: Record<string, unknown> = {};
          if (typeof p.arguments === "string") {
            try {
              input = JSON.parse(p.arguments);
            } catch {
              input = { raw: p.arguments };
            }
          } else if (p.input && typeof p.input === "object") {
            input = p.input as Record<string, unknown>;
          }
          push({
            id: callId,
            parent: prev,
            role: "assistant",
            type: "tool_call",
            content: [],
            tool: String(p.name ?? "tool"),
            input,
            ts,
            provenance: { native_id: callId, native_type: String(p.type), line: lineNo },
          });
          n++;
          break;
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const raw =
            typeof p.output === "string" ? p.output : codexText(p.output) || JSON.stringify(p.output ?? "");
          const reduced = reduceOutput(raw, opts.maxOutputBytes);
          push({
            id: `codex-${n++}`,
            parent: prev,
            role: "tool",
            type: "tool_result",
            content: [],
            ref: String(p.call_id ?? ""),
            output: reduced.output,
            truncation: reduced.truncation,
            ts,
            provenance: { native_type: String(p.type), line: lineNo },
          });
          break;
        }
        default:
          break;
      }
    }

    return {
      ucf_version: UCF_VERSION,
      conversation_id: sessionId,
      title: ref.title ?? firstHumanPromptTitle(
        events.filter((e) => e.type === "message" && e.role === "user").map((e) => ({
          role: "user",
          text: e.content.map((b) => ("text" in b ? b.text : "")).join("\n"),
        })),
      ),
      source: {
        tool: this.tool,
        version: version ?? originator,
        model,
        exported_at: new Date().toISOString(),
        native_session_id: sessionId,
      },
      project: {
        repo,
        commit,
        cwd_hint: cwd ?? null,
        git_branch: gitBranch,
      },
      events,
      redacted: false,
    };
  }

  async importSession(doc: UcfDocument, opts: ImportOptions = {}): Promise<ImportResult> {
    const mode = opts.mode ?? "replay";
    const cwd = opts.cwd ?? doc.project.cwd_hint ?? process.cwd();
    const sessionId = randomUUID();
    const now = new Date();
    const iso = now.toISOString();
    const stamp = iso.replace(/[:.]/g, "-").replace("Z", "");
    const path = join(codexDateDir(now), `rollout-${stamp}-${sessionId}.jsonl`);

    const lines: unknown[] = [
      {
        timestamp: iso,
        type: "session_meta",
        payload: {
          id: sessionId,
          timestamp: iso,
          cwd,
          originator: "relay",
          cli_version: "relay-0.1.0",
          source: doc.source.tool,
        },
      },
    ];

    if (mode === "replay") {
      const prompt = opts.primingPrompt ?? doc.summary ?? "(empty conversation)";
      lines.push(this.messageItem("user", prompt, iso));
    } else {
      for (const ev of doc.events) {
        const ts = ev.ts ?? iso;
        if (ev.type === "message") {
          const text = ev.content
            .filter((b) => b.kind === "text" || b.kind === "code")
            .map((b) => (b as { text: string }).text)
            .join("\n");
          if (!text) continue;
          const role = ev.role === "assistant" ? "assistant" : ev.role === "system" ? "developer" : "user";
          lines.push(this.messageItem(role, text, ts));
        } else if (ev.type === "tool_call") {
          lines.push({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "function_call",
              name: ev.tool ?? "tool",
              arguments: JSON.stringify(ev.input ?? {}),
              call_id: ev.provenance?.native_id || ev.id,
            },
          });
        } else if (ev.type === "tool_result") {
          lines.push({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: ev.ref ?? "",
              output: ev.output ?? "",
            },
          });
        }
      }
    }

    await writeJsonl(path, lines);
    return {
      tool: this.tool,
      sessionId,
      path,
      resumeCommand: `cd ${cwd} && codex resume ${sessionId}`,
      mode,
    };
  }

  private messageItem(role: string, text: string, ts: string) {
    const kind = role === "assistant" ? "output_text" : "input_text";
    return {
      timestamp: ts,
      type: "response_item",
      payload: { type: "message", role, content: [{ type: kind, text }] },
    };
  }
}
