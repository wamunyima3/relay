import type { Adapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { CursorAdapter } from "./cursor.js";

const adapters: Adapter[] = [new ClaudeAdapter(), new CodexAdapter(), new CursorAdapter()];

export function allAdapters(): Adapter[] {
  return adapters;
}

export function getAdapter(tool: string): Adapter {
  const a = adapters.find((x) => x.tool === tool);
  if (!a) {
    const known = adapters.map((x) => x.tool).join(", ");
    throw new Error(`Unknown tool "${tool}". Known tools: ${known}`);
  }
  return a;
}

export function toolIds(): string[] {
  return adapters.map((a) => a.tool);
}

/** Tool ids that can have a session written into them (valid resume targets). */
export function importableToolIds(): string[] {
  return adapters.filter((a) => typeof a.importSession === "function").map((a) => a.tool);
}

/** Valid resume targets for a given source tool (all writable tools but itself). */
export function resumeTargets(sourceTool: string): string[] {
  return importableToolIds().filter((t) => t !== sourceTool);
}
