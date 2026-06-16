import { homedir, platform } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

/**
 * Storage roots. Resolved at call time and overridable via env vars so tests
 * stay hermetic and a future daemon can point at a sandbox. Defaults match the
 * real tool locations.
 */
export function claudeProjectsDir(): string {
  return process.env.RELAY_CLAUDE_DIR ?? join(HOME, ".claude", "projects");
}

export function codexSessionsDir(): string {
  return process.env.RELAY_CODEX_DIR ?? join(HOME, ".codex", "sessions");
}

/**
 * Claude Code names a project's session directory by taking the absolute cwd
 * and replacing every non-alphanumeric character with a dash, e.g.
 * `/Users/me/dev/app` -> `-Users-me-dev-app`. Reproducing that lets us write a
 * session file into the directory Claude will scan for that project.
 */
export function encodeClaudeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Cursor stores all conversations in a single global SQLite database. Its
 * location is OS-specific; `RELAY_CURSOR_DB` overrides it (used by tests).
 */
export function cursorGlobalDb(): string {
  if (process.env.RELAY_CURSOR_DB) return process.env.RELAY_CURSOR_DB;
  const sub = join("Cursor", "User", "globalStorage", "state.vscdb");
  switch (platform()) {
    case "darwin":
      return join(HOME, "Library", "Application Support", sub);
    case "win32":
      return join(process.env.APPDATA ?? join(HOME, "AppData", "Roaming"), sub);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), sub);
  }
}

/** Build the dated Codex rollout directory for a given date (defaults: now). */
export function codexDateDir(date = new Date()): string {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return join(codexSessionsDir(), y, m, d);
}
