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
  run(...params: unknown[]): unknown;
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb;
}

const require = createRequire(import.meta.url);

function loadModule(): SqliteModule {
  try {
    return require("node:sqlite") as SqliteModule;
  } catch {
    throw new Error(
      "Cursor support needs Node's built-in SQLite (node:sqlite), available in Node 22+. " +
        "Upgrade Node to use the Cursor adapter.",
    );
  }
}

/** Open a SQLite database read-only. Throws a friendly error if unavailable. */
export function openReadOnly(path: string): SqliteDb {
  return new (loadModule().DatabaseSync)(path, { readOnly: true });
}

/**
 * Open a SQLite database read-write, with a busy timeout so a brief lock held by
 * a running app (e.g. Cursor) doesn't immediately fail the write.
 */
export function openWritable(path: string): SqliteDb {
  const db = new (loadModule().DatabaseSync)(path);
  try {
    db.exec("PRAGMA busy_timeout = 4000");
  } catch {
    /* non-fatal */
  }
  return db;
}
