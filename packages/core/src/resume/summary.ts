import { isInjectedText } from "../util/title.js";
import type { UcfDocument, UcfEvent } from "../ucf/schema.js";

/** Heuristics for pulling file paths out of tool inputs. */
const PATH_KEYS = ["file_path", "path", "filePath", "filename", "notebook_path"];

function eventText(ev: UcfEvent): string {
  return ev.content
    .filter((b) => b.kind === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}

function collectFiles(events: UcfEvent[]): string[] {
  const files = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "tool_call" || !ev.input) continue;
    for (const key of PATH_KEYS) {
      const v = ev.input[key];
      if (typeof v === "string" && v.length < 200) files.add(v);
    }
  }
  return [...files];
}

function collectTools(events: UcfEvent[]): { tool: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "tool_call" && ev.tool) {
      counts.set(ev.tool, (counts.get(ev.tool) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * A deterministic, no-API recap of a conversation: who did what, which tools
 * and files were touched, and the most recent user request. This mirrors how
 * the tools themselves do `/compact`, and it is what powers a lossy "replay"
 * resume when the full transcript would overflow the destination context.
 */
export function buildSummary(doc: UcfDocument): string {
  const events = doc.events;
  const userMsgs = events.filter((e) => e.type === "message" && e.role === "user");
  const assistantMsgs = events.filter((e) => e.type === "message" && e.role === "assistant");
  const tools = collectTools(events);
  const files = collectFiles(events);

  // Injected/synthetic turns (slash-command wrappers, skill bodies) are real
  // conversation events but were never typed by the user — skip them when
  // picking the request text shown as "Opening request" / "Most recent request".
  const genuineUserMsgs = userMsgs.filter((e) => !e.provenance?.meta);
  const firstUserEvent = genuineUserMsgs.find((e) => {
    const t = eventText(e);
    return t && !isInjectedText(t);
  });
  const firstUser = firstUserEvent ? eventText(firstUserEvent) : undefined;
  const lastUser = [...genuineUserMsgs].reverse().find((e) => {
    const t = eventText(e);
    return t && !isInjectedText(t);
  });
  const lastUserText = lastUser ? eventText(lastUser) : undefined;

  const lines: string[] = [];
  lines.push(`Conversation from ${doc.source.tool}${doc.title ? ` — "${doc.title}"` : ""}.`);
  if (doc.project.cwd_hint) lines.push(`Working directory: ${doc.project.cwd_hint}`);
  if (doc.project.git_branch) lines.push(`Git branch: ${doc.project.git_branch}`);
  lines.push(
    `${userMsgs.length} user message(s), ${assistantMsgs.length} assistant message(s), ${tools.reduce((n, t) => n + t.count, 0)} tool call(s).`,
  );

  if (firstUser) lines.push(`\nOpening request:\n${truncate(firstUser, 600)}`);
  if (lastUserText && lastUserText !== firstUser) {
    lines.push(`\nMost recent request:\n${truncate(lastUserText, 600)}`);
  }
  if (tools.length) {
    lines.push(`\nTools used: ${tools.map((t) => `${t.tool} (${t.count})`).join(", ")}`);
  }
  if (files.length) {
    lines.push(`\nFiles referenced:\n${files.slice(0, 25).map((f) => `  - ${f}`).join("\n")}`);
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}
