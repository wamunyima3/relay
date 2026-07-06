import { z } from "zod";

/**
 * The Universal Conversation Format (UCF).
 *
 * This is Relay's interchange schema. Every adapter converts a tool's native
 * session into UCF (export) and reconstructs a native session from UCF (import).
 * Keeping every tool at arm's length from each other through one well-defined,
 * versioned format is what keeps the core clean as adapters multiply.
 *
 * Design rules (see project brief §3a):
 *  - append-only event stream, modelled on the JSONL shape Claude + Codex use
 *  - content is broken into typed blocks (text / code / tool_call / ...)
 *  - large tool outputs are truncated + hashed, never silently dropped
 *  - every event keeps provenance back to its source line
 */

export const UCF_VERSION = "1.0" as const;

/** A pointer to a file referenced in the conversation. */
export const fileRefBlock = z.object({
  kind: z.literal("file_ref"),
  path: z.string(),
  /** Optional content hash so we can detect drift without storing the file. */
  sha256: z.string().optional(),
});

export const textBlock = z.object({
  kind: z.literal("text"),
  text: z.string(),
});

/** Model "thinking" / reasoning. Carried for fidelity; usually not replayed. */
export const thinkingBlock = z.object({
  kind: z.literal("thinking"),
  text: z.string(),
});

export const codeBlock = z.object({
  kind: z.literal("code"),
  text: z.string(),
  language: z.string().optional(),
});

/** An image that lived in the transcript. We keep a reference, not the bytes. */
export const imageBlock = z.object({
  kind: z.literal("image"),
  media_type: z.string().optional(),
  /** Short note, e.g. "[image omitted]" — bytes are never synced. */
  placeholder: z.string().default("[image]"),
});

export const contentBlock = z.discriminatedUnion("kind", [
  textBlock,
  thinkingBlock,
  codeBlock,
  fileRefBlock,
  imageBlock,
]);

/** How a large output was reduced before storage. */
export const truncation = z.object({
  truncated: z.literal(true),
  original_bytes: z.number().int().nonnegative(),
  kept_bytes: z.number().int().nonnegative(),
  sha256: z.string(),
});

export const eventRole = z.enum(["user", "assistant", "tool", "system"]);
export const eventType = z.enum(["message", "tool_call", "tool_result"]);

export const ucfEvent = z.object({
  /** Stable id, unique within the conversation. */
  id: z.string(),
  /** Parent event id, forming the conversation tree. Null for the root. */
  parent: z.string().nullable().default(null),
  role: eventRole,
  type: eventType,
  /** Typed content blocks. Empty for pure tool_call/tool_result events. */
  content: z.array(contentBlock).default([]),
  /** For tool_call: the tool name (normalized, e.g. "shell", "edit"). */
  tool: z.string().optional(),
  /** For tool_call: the structured input the tool was invoked with. */
  input: z.record(z.unknown()).optional(),
  /** For tool_result: the call id this result answers. */
  ref: z.string().optional(),
  /** For tool_result: the (possibly truncated) textual output. */
  output: z.string().optional(),
  /** Set when `output` was truncated for size. */
  truncation: truncation.optional(),
  /** ISO-8601 timestamp, when known. */
  ts: z.string().optional(),
  /** Where this event came from in the source file (line number, native id). */
  provenance: z
    .object({
      native_id: z.string().optional(),
      line: z.number().int().optional(),
      native_type: z.string().optional(),
      /** Source tool flagged this as injected/synthetic (e.g. Claude's `isMeta`), not a genuine human turn. */
      meta: z.boolean().optional(),
    })
    .optional(),
});

export const ucfSource = z.object({
  tool: z.string(),
  version: z.string().optional(),
  /** Model that produced the assistant turns (e.g. "claude-sonnet-5", "gpt-5.4"), when the source records it. */
  model: z.string().optional(),
  exported_at: z.string(),
  /** Original native session id, so a round-trip can be correlated. */
  native_session_id: z.string().optional(),
});

export const ucfProject = z.object({
  repo: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  cwd_hint: z.string().nullable().default(null),
  git_branch: z.string().nullable().default(null),
});

export const ucfDocument = z.object({
  ucf_version: z.literal(UCF_VERSION),
  conversation_id: z.string(),
  title: z.string().optional(),
  source: ucfSource,
  project: ucfProject,
  events: z.array(ucfEvent),
  /** Rule- or model-generated recap, used for lossy ("replay") resume. */
  summary: z.string().optional(),
  /** True when redaction ran and at least one secret was removed. */
  redacted: z.boolean().default(false),
});

export type ContentBlock = z.infer<typeof contentBlock>;
export type UcfEvent = z.infer<typeof ucfEvent>;
export type UcfSource = z.infer<typeof ucfSource>;
export type UcfProject = z.infer<typeof ucfProject>;
export type UcfDocument = z.infer<typeof ucfDocument>;

/**
 * Parse + validate an unknown value as a UCF document. Throws a ZodError with
 * a readable path on failure, which the CLI surfaces to the user.
 */
export function parseUcf(value: unknown): UcfDocument {
  return ucfDocument.parse(value);
}

export function safeParseUcf(value: unknown) {
  return ucfDocument.safeParse(value);
}
