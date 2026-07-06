import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Adapter, ExportOptions, ImportOptions, ImportResult, SessionRef } from "./types.js";
import type { UcfDocument, UcfEvent } from "../ucf/schema.js";
import { UCF_VERSION } from "../ucf/schema.js";
import { reduceOutput } from "../util/text.js";
import { cursorGlobalDb, relayBackupsDir } from "../util/paths.js";
import { openReadOnly, openWritable, type SqliteDb } from "../util/sqlite.js";
import { firstHumanPromptTitle } from "../util/title.js";

/**
 * Cursor adapter.
 *
 * Cursor keeps conversations in a single global SQLite DB (`state.vscdb`). A
 * conversation is a `composerData:<id>` row; its messages ("bubbles") live in
 * separate `bubbleId:<composerId>:<bubbleId>` rows, ordered by the composer's
 * `fullConversationHeadersOnly` list. Bubble `type` 1 = user, 2 = assistant; an
 * assistant bubble may bundle reasoning (`thinking`), a tool call+result
 * (`toolFormerData`), and text together. The conversation list shown in the UI
 * comes from a `composer.composerHeaders` index in `ItemTable`.
 *
 * Reads are defensive (the schema is undocumented and changes across releases).
 * Writing back (`importSession`) is **experimental**: it only ever INSERTs a new
 * conversation (never edits existing chats) and backs up the index before
 * touching it. Cursor should be restarted to pick up the new conversation.
 */

type Json = Record<string, unknown>;

const BUBBLE_USER = 1;
const BUBBLE_ASSISTANT = 2;

function parseJsonValue(value: unknown): Json | null {
  try {
    if (typeof value === "string") return JSON.parse(value) as Json;
    if (value instanceof Uint8Array) return JSON.parse(Buffer.from(value).toString("utf8")) as Json;
  } catch {
    /* fall through */
  }
  return null;
}

/** Collect absolute-looking file paths from a JSON-ish string. */
function extractPaths(text: string): string[] {
  const out: string[] = [];
  const re = /(?:\/[\w.\-]+){2,}|[A-Za-z]:\\(?:[\w.\-]+\\?)+/g;
  for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

/**
 * Infer the project root from a set of referenced file paths. A plain common
 * prefix collapses to "/" as soon as one outlier path appears (build logs,
 * /usr/…), so instead we pick the *deepest* ancestor directory that still covers
 * a majority of the paths.
 */
function inferRoot(paths: string[]): string | undefined {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length === 0) return undefined;
  const threshold = Math.max(1, Math.ceil(abs.length * 0.4));

  const counts = new Map<string, number>();
  for (const p of abs) {
    const segs = p.split("/"); // ["", "Users", "me", "proj", "file"]
    // Count every ancestor directory at least 3 segments deep (/a/b/c …),
    // excluding the file name itself.
    for (let i = 3; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }

  let best: string | undefined;
  let bestDepth = 0;
  for (const [dir, count] of counts) {
    if (count < threshold) continue;
    const depth = dir.split("/").length;
    if (depth > bestDepth) {
      best = dir;
      bestDepth = depth;
    }
  }
  return best;
}

export class CursorAdapter implements Adapter {
  readonly tool = "cursor";
  readonly label = "Cursor";

  async available(): Promise<boolean> {
    return existsSync(cursorGlobalDb());
  }

  private open(): SqliteDb {
    return openReadOnly(cursorGlobalDb());
  }

  async list(): Promise<SessionRef[]> {
    if (!existsSync(cursorGlobalDb())) return [];
    const db = this.open();
    try {
      let refs = this.listFromIndex(db) ?? this.listFromBlobs(db);
      refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      // Cursor's index keeps entries for conversations that were opened but
      // never used (zero bubbles) — hide those, and give the remaining unnamed
      // ones a title from their first user prompt (like Codex). Bounded so a
      // huge history can't slow the listing.
      let peeks = 25;
      const empty = new Set<string>();
      for (const ref of refs) {
        if (ref.title || peeks <= 0) continue;
        peeks -= 1;
        const peeked = this.peekComposer(db, ref.id);
        if (peeked.empty) empty.add(ref.id);
        else ref.title = peeked.title;
      }
      if (empty.size > 0) refs = refs.filter((r) => !empty.has(r.id));
      return refs;
    } finally {
      db.close();
    }
  }

  /**
   * Cheap look inside a composer blob: is it an empty shell, and if not, what
   * would its first-user-prompt title be? A missing/unreadable blob is treated
   * as non-empty (defensive: never hide something we couldn't inspect).
   */
  private peekComposer(db: SqliteDb, composerId: string): { title?: string; empty: boolean } {
    try {
      const row = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
      const composer = row ? parseJsonValue(row.value) : null;
      if (!composer) return { empty: false };
      const headers = (composer.fullConversationHeadersOnly as { bubbleId: string; type: number }[]) ?? [];
      if (headers.length === 0) return { empty: true };
      const userMessages: { role: string; text: string }[] = [];
      for (const h of headers) {
        if (h.type !== BUBBLE_USER || userMessages.length >= 5) continue;
        const brow = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`bubbleId:${composerId}:${h.bubbleId}`);
        const bubble = brow ? parseJsonValue(brow.value) : null;
        const text = String(bubble?.text ?? "").trim();
        if (text) userMessages.push({ role: "user", text });
      }
      return { title: firstHumanPromptTitle(userMessages), empty: false };
    } catch {
      return { empty: false };
    }
  }

  /**
   * Fast path: Cursor keeps a compact index of all conversations in a single
   * `composer.composerHeaders` row, which reads in milliseconds instead of
   * scanning every (large) composer blob. Returns null if the index is absent
   * (older Cursor versions), so the caller can fall back.
   */
  private listFromIndex(db: SqliteDb): SessionRef[] | null {
    let row: Record<string, unknown> | undefined;
    try {
      row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
    } catch {
      return null; // no ItemTable (old/synthetic DB) — use the fallback
    }
    if (!row) return null;
    const parsed = parseJsonValue(row.value);
    const all = parsed?.allComposers as Json[] | undefined;
    if (!Array.isArray(all)) return null;

    const refs: SessionRef[] = [];
    for (const c of all) {
      if (c.isDraft === true || c.isBestOfNSubcomposer === true) continue;
      const id = String(c.composerId ?? "");
      if (!id) continue;
      const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : undefined;
      const updated = (typeof c.lastUpdatedAt === "number" ? c.lastUpdatedAt : undefined) ??
        (typeof c.createdAt === "number" ? c.createdAt : undefined);
      refs.push({
        tool: this.tool,
        id,
        path: cursorGlobalDb(),
        title: name,
        updatedAt: updated ? new Date(updated).toISOString() : undefined,
      });
    }
    return refs;
  }

  /** Defensive fallback: derive the list by scanning composer blobs directly. */
  private listFromBlobs(db: SqliteDb): SessionRef[] {
    const rows = db
      .prepare(
        `SELECT substr(key, 14) AS id,
                json_extract(value, '$.name') AS name,
                json_extract(value, '$.lastUpdatedAt') AS updated,
                json_array_length(value, '$.fullConversationHeadersOnly') AS n
         FROM cursorDiskKV
         WHERE key LIKE 'composerData:%'
           AND json_array_length(value, '$.fullConversationHeadersOnly') > 0`,
      )
      .all();
    return rows.map((r) => {
      const updated = typeof r.updated === "number" ? r.updated : undefined;
      const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : undefined;
      return {
        tool: this.tool,
        id: String(r.id),
        path: cursorGlobalDb(),
        title: name,
        updatedAt: updated ? new Date(updated).toISOString() : undefined,
        messageCount: typeof r.n === "number" ? r.n : undefined,
      } satisfies SessionRef;
    });
  }

  async resolve(idOrPath: string): Promise<SessionRef> {
    const all = await this.list();
    const match = all.find((s) => s.id === idOrPath || s.id.startsWith(idOrPath));
    if (!match) throw new Error(`Cursor conversation not found: ${idOrPath}`);
    return match;
  }

  async exportSession(ref: SessionRef, opts: ExportOptions = {}): Promise<UcfDocument> {
    const db = this.open();
    try {
      const row = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
        .get(`composerData:${ref.id}`);
      const composer = row ? parseJsonValue(row.value) : null;
      if (!composer) throw new Error(`Cursor conversation not found: ${ref.id}`);

      const headers = (composer.fullConversationHeadersOnly as { bubbleId: string; type: number }[]) ?? [];
      const getBubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");

      const events: UcfEvent[] = [];
      const filePaths: string[] = [];
      let prev: string | null = null;
      let n = 0;
      const push = (ev: UcfEvent) => {
        events.push(ev);
        prev = ev.id;
      };

      for (const header of headers) {
        const brow = getBubble.get(`bubbleId:${ref.id}:${header.bubbleId}`);
        const bubble = brow ? parseJsonValue(brow.value) : null;
        if (!bubble) continue;
        const ts = undefined;

        if (header.type === BUBBLE_USER) {
          const text = String(bubble.text ?? "").trim();
          if (text) {
            push({
              id: `cursor-${n++}`,
              parent: prev,
              role: "user",
              type: "message",
              content: [{ kind: "text", text }],
              ts,
              provenance: { native_id: header.bubbleId, native_type: "bubble:user" },
            });
          }
          continue;
        }

        if (header.type === BUBBLE_ASSISTANT) {
          // 1) reasoning
          const thinking = bubble.thinking as { text?: string } | undefined;
          if (thinking?.text) {
            push({
              id: `cursor-${n++}`,
              parent: prev,
              role: "assistant",
              type: "message",
              content: [{ kind: "thinking", text: String(thinking.text) }],
              ts,
              provenance: { native_id: header.bubbleId, native_type: "bubble:thinking" },
            });
          }

          // 2) tool call + result (Cursor bundles them in one bubble)
          const tfd = bubble.toolFormerData as Json | undefined;
          if (tfd && (tfd.name || tfd.rawArgs)) {
            const callId = String(tfd.toolCallId ?? `cursor-tool-${n}`);
            let input: Json = {};
            if (typeof tfd.rawArgs === "string") {
              try {
                input = JSON.parse(tfd.rawArgs) as Json;
              } catch {
                input = { raw: tfd.rawArgs };
              }
            }
            for (const p of extractPaths(JSON.stringify(input))) filePaths.push(p);
            push({
              id: callId,
              parent: prev,
              role: "assistant",
              type: "tool_call",
              content: [],
              tool: String(tfd.name ?? "tool"),
              input,
              ts,
              provenance: { native_id: header.bubbleId, native_type: "bubble:tool_call" },
            });
            n++;

            const resultRaw =
              typeof tfd.result === "string" ? tfd.result : tfd.result != null ? JSON.stringify(tfd.result) : "";
            if (resultRaw) {
              const reduced = reduceOutput(resultRaw, opts.maxOutputBytes);
              push({
                id: `cursor-${n++}`,
                parent: prev,
                role: "tool",
                type: "tool_result",
                content: [],
                ref: callId,
                output: reduced.output,
                truncation: reduced.truncation,
                ts,
                provenance: { native_id: header.bubbleId, native_type: "bubble:tool_result" },
              });
            }
          }

          // 3) assistant text
          const text = String(bubble.text ?? "").trim();
          if (text) {
            push({
              id: `cursor-${n++}`,
              parent: prev,
              role: "assistant",
              type: "message",
              content: [{ kind: "text", text }],
              ts,
              provenance: { native_id: header.bubbleId, native_type: "bubble:assistant" },
            });
          }
        }
      }

      const cwd = inferRoot(filePaths);

      return {
        ucf_version: UCF_VERSION,
        conversation_id: ref.id,
        title: ref.title ?? (typeof composer.name === "string" ? composer.name : undefined),
        source: {
          tool: this.tool,
          version: typeof composer._v === "number" ? String(composer._v) : undefined,
          exported_at: new Date().toISOString(),
          native_session_id: ref.id,
        },
        project: {
          repo: null,
          commit: null,
          cwd_hint: cwd ?? null,
          git_branch: null,
        },
        events,
        redacted: false,
      };
    } finally {
      db.close();
    }
  }

  /**
   * EXPERIMENTAL: inject a conversation into Cursor as a new chat. Only INSERTs
   * new rows (a fresh composerId, never editing an existing chat) and prepends an
   * entry to the `composer.composerHeaders` index after backing it up, so the
   * conversation appears at the top of Cursor's history. Cursor must be
   * restarted to see it.
   */
  async importSession(doc: UcfDocument, opts: ImportOptions = {}): Promise<ImportResult> {
    // Unlike Claude/Codex (which happily create their session directory on
    // first write), Cursor's DB must already exist with its real schema —
    // there's no sensible "create a fresh Cursor DB from scratch". Without
    // this check, INSERTing into a missing/empty file surfaces a raw
    // "no such table: cursorDiskKV" instead of a clear message.
    if (!(await this.available())) {
      throw new Error(`${this.label} storage not found on this machine.`);
    }
    const mode = opts.mode ?? "replay";
    const composerId = randomUUID();
    const now = Date.now();
    const name = doc.title?.slice(0, 80) || `Relay: resumed ${doc.source.tool} chat`;

    const { headers, bubbles } = this.buildBubbles(doc, mode, opts.primingPrompt);

    const db = openWritable(cursorGlobalDb());
    try {
      const put = db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");

      // 1) message bubbles
      for (const b of bubbles) {
        put.run(`bubbleId:${composerId}:${b.bubbleId}`, JSON.stringify(b));
      }

      // 2) the composer record
      const composerData = this.buildComposerData(composerId, name, now, headers);
      put.run(`composerData:${composerId}`, JSON.stringify(composerData));

      // 3) prepend to the conversation index (with a safety backup first)
      const backupPath = this.prependToIndex(db, composerId, name, now);

      return {
        tool: this.tool,
        sessionId: composerId,
        path: cursorGlobalDb(),
        resumeCommand: "",
        mode,
        note: "Fully quit and reopen Cursor — the conversation is at the top of your chat history.",
        backupPath,
      };
    } finally {
      db.close();
    }
  }

  private buildBubbles(
    doc: UcfDocument,
    mode: "replay" | "native",
    primingPrompt?: string,
  ): { headers: { bubbleId: string; type: number }[]; bubbles: Json[] } {
    const headers: { bubbleId: string; type: number }[] = [];
    const bubbles: Json[] = [];
    const add = (type: number, text: string) => {
      const bubbleId = randomUUID();
      headers.push({ bubbleId, type });
      bubbles.push({ _v: 2, type, bubbleId, text });
    };

    if (mode === "replay") {
      add(BUBBLE_USER, primingPrompt ?? doc.summary ?? "(empty conversation)");
      return { headers, bubbles };
    }

    // native: reconstruct a readable thread of user/assistant text bubbles.
    for (const ev of doc.events) {
      if (ev.type === "message") {
        const text = ev.content
          .filter((b) => b.kind === "text" || b.kind === "code")
          .map((b) => (b as { text: string }).text)
          .join("\n")
          .trim();
        if (!text) continue;
        add(ev.role === "user" ? BUBBLE_USER : BUBBLE_ASSISTANT, text);
      } else if (ev.type === "tool_call") {
        add(BUBBLE_ASSISTANT, `🔧 ${ev.tool}(${JSON.stringify(ev.input ?? {}).slice(0, 200)})`);
      } else if (ev.type === "tool_result") {
        const first = (ev.output ?? "").split("\n").find((l) => l.trim()) ?? "";
        if (first) add(BUBBLE_ASSISTANT, `↳ ${first.slice(0, 200)}`);
      }
    }
    if (headers.length === 0) add(BUBBLE_USER, doc.summary ?? "(empty conversation)");
    return { headers, bubbles };
  }

  private buildComposerData(
    composerId: string,
    name: string,
    now: number,
    headers: { bubbleId: string; type: number }[],
  ): Json {
    return {
      _v: 16,
      composerId,
      name,
      createdAt: now,
      lastUpdatedAt: now,
      unifiedMode: "agent",
      forceMode: "edit",
      hasLoaded: true,
      status: "completed",
      subtitle: "",
      text: "",
      richText: "",
      conversationMap: {},
      generatingBubbleIds: [],
      fullConversationHeadersOnly: headers,
      context: {
        composers: [],
        quotes: [],
        selectedCommits: [],
        selectedPullRequests: [],
        selectedImages: [],
        folderSelections: [],
        fileSelections: [],
        selections: [],
        terminalSelections: [],
        notepads: [],
        cursorRules: [],
        mentions: {},
      },
    };
  }

  /** Prepend a header to composer.composerHeaders, backing up the original. */
  private prependToIndex(db: SqliteDb, composerId: string, name: string, now: number): string | undefined {
    let row: Record<string, unknown> | undefined;
    try {
      row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
    } catch {
      return undefined; // no index table — nothing to update/back up
    }
    if (!row) return undefined;

    const parsed = parseJsonValue(row.value) ?? {};
    const all = Array.isArray(parsed.allComposers) ? (parsed.allComposers as Json[]) : [];

    // Mirror an existing entry's shape for maximum compatibility, then override.
    const template = (all[0] ?? {}) as Json;
    const entry: Json = {
      ...template,
      composerId,
      name,
      subtitle: "",
      createdAt: now,
      lastUpdatedAt: now,
      isDraft: false,
      isArchived: false,
      hasUnreadMessages: false,
      hasBlockingPendingActions: false,
      hasPendingPlan: false,
    };

    const backupPath = this.backupIndex(row.value);
    const next = { ...parsed, allComposers: [entry, ...all] };
    db.prepare("UPDATE ItemTable SET value = ? WHERE key = 'composer.composerHeaders'").run(JSON.stringify(next));
    return backupPath;
  }

  private backupIndex(value: unknown): string | undefined {
    try {
      const dir = relayBackupsDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `cursor-composerHeaders-${Date.now()}.json`);
      const text = typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8");
      writeFileSync(path, text, "utf8");
      return path;
    } catch {
      return undefined;
    }
  }
}
