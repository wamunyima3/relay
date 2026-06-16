import type { Adapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

const adapters: Adapter[] = [new ClaudeAdapter(), new CodexAdapter()];

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
