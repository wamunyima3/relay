import { createRequire } from "node:module";

/**
 * Thin wrapper over Node's built-in `node:sqlite` (Node ≥ 22). Using the
 * built-in keeps Relay free of a native dependency; the module is loaded lazily
 * so tools that never touch SQLite (Claude, Codex) don't pay for it, and a
 * missing/old runtime fails with a clear message instead of a cryptic one.
 */

export interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;
}

const require = createRequire(import.meta.url);

/** Open a SQLite database read-only. Throws a friendly error if unavailable. */
export function openReadOnly(path: string): SqliteDb {
  let mod: SqliteModule;
  try {
    mod = require("node:sqlite") as SqliteModule;
  } catch {
    throw new Error(
      "Reading Cursor needs Node's built-in SQLite (node:sqlite), available in Node 22+. " +
        "Upgrade Node to use the Cursor adapter.",
    );
  }
  return new mod.DatabaseSync(path, { readOnly: true });
}
