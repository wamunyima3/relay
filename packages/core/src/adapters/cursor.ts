import { existsSync } from "node:fs";

import type { Adapter, ExportOptions, SessionRef } from "./types.js";
import type { UcfDocument, UcfEvent } from "../ucf/schema.js";
import { UCF_VERSION } from "../ucf/schema.js";
import { reduceOutput } from "../util/text.js";
import { cursorGlobalDb } from "../util/paths.js";
import { openReadOnly, type SqliteDb } from "../util/sqlite.js";

/**
 * Cursor adapter — EXPORT ONLY.
 *
 * Cursor keeps conversations in a single global SQLite DB (`state.vscdb`). A
 * conversation is a `composerData:<id>` row; its messages ("bubbles") live in
 * separate `bubbleId:<composerId>:<bubbleId>` rows, ordered by the composer's
 * `fullConversationHeadersOnly` list. Bubble `type` 1 = user, 2 = assistant; an
 * assistant bubble may bundle reasoning (`thinking`), a tool call+result
 * (`toolFormerData`), and text together.
 *
 * The schema is undocumented and has changed across Cursor releases, so reads
 * are defensive and writing back is intentionally unsupported (the brief treats
 * Cursor injection as too fragile to ship). Relay can pull a Cursor chat out and
 * resume it in Claude or Codex, not the reverse.
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
      const refs = this.listFromIndex(db) ?? this.listFromBlobs(db);
      refs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
      return refs;
    } finally {
      db.close();
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

  // No importSession: Cursor is export-only (see class docs).
}
