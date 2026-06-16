/** Shared colors and small helpers for the Relay TUI. */
export const theme = {
  brand: "#7c5cff",
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  err: "red",
  dim: "gray",
} as const;

/** Friendly display name for a tool id. */
export function toolName(id: string): string {
  const names: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
  };
  return names[id] ?? id;
}

/** Short emoji marker per tool, for list rows. */
export function toolBadge(id: string): string {
  const badges: Record<string, string> = { claude: "🟣", codex: "🟢", cursor: "🔵" };
  return badges[id] ?? "•";
}
