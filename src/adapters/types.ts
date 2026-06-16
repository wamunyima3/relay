import type { UcfDocument } from "../ucf/schema.js";

/** A session discovered on disk, before full parsing. */
export interface SessionRef {
  tool: string;
  id: string;
  path: string;
  title?: string;
  cwd?: string;
  updatedAt?: string;
  messageCount?: number;
}

export interface ExportOptions {
  /** Max bytes to keep per tool output before truncating. */
  maxOutputBytes?: number;
}

export interface ImportOptions {
  /** Destination working directory the resumed session should target. */
  cwd?: string;
  /**
   * "replay": package the whole transcript as a single priming prompt inside a
   * fresh native session (universal, lossy — the MVP default).
   * "native": reconstruct events one-to-one into the native format (high
   * fidelity, per-tool).
   */
  mode?: "replay" | "native";
  /** Pre-rendered priming prompt for replay mode. */
  primingPrompt?: string;
}

export interface ImportResult {
  tool: string;
  /** Native session id the destination tool will recognize. */
  sessionId: string;
  /** Where the native session file was written. */
  path: string;
  /** Command the user runs to resume it. */
  resumeCommand: string;
  mode: "replay" | "native";
}

/**
 * One adapter per tool. Each owns all the tool-specific mess so the core never
 * has to know how a given tool stores its sessions.
 */
export interface Adapter {
  /** Canonical tool id, e.g. "claude" or "codex". */
  readonly tool: string;
  /** Human-friendly name for help text and output. */
  readonly label: string;

  /** Whether this adapter can read sessions on this machine (dirs exist). */
  available(): Promise<boolean>;

  /** List sessions this tool has stored locally. */
  list(): Promise<SessionRef[]>;

  /** Read a native session file into UCF. */
  exportSession(ref: SessionRef, opts?: ExportOptions): Promise<UcfDocument>;

  /** Resolve a session by id or path into a SessionRef. */
  resolve(idOrPath: string): Promise<SessionRef>;

  /** Write a UCF document into a native session this tool can resume. */
  importSession?(doc: UcfDocument, opts?: ImportOptions): Promise<ImportResult>;
}
