import { isInjectedText, type UcfDocument } from "@relay/core";
import type { MessageLine } from "./MessageView.js";
import { theme, toolName } from "./theme.js";

/** Word-wrap a paragraph to a width, preserving existing newlines. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      if (line && line.length + w.length + 1 > width) {
        out.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Pull a short, human-readable argument out of a tool input object. */
function briefInput(input?: Record<string, unknown>): string {
  if (!input) return "";
  for (const k of ["cmd", "command", "path", "file_path", "filePath", "target_file", "query", "pattern"]) {
    const v = input[k];
    if (typeof v === "string") return v.length > 60 ? v.slice(0, 59) + "…" : v;
  }
  const s = JSON.stringify(input);
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

function blockText(content: UcfDocument["events"][number]["content"]): string {
  return content
    .filter((b) => b.kind === "text" || b.kind === "code")
    .map((b) => (b as { text: string }).text)
    .join("\n")
    .trim();
}

/**
 * Render a conversation into colored, pre-wrapped lines for the scrollable
 * transcript viewer. Reasoning is shown collapsed; tool calls/results are shown
 * as compact one-liners so the human dialogue stays readable.
 */
export function buildTranscriptLines(doc: UcfDocument, width: number): MessageLine[] {
  const lines: MessageLine[] = [];
  const w = Math.max(20, width);

  for (const ev of doc.events) {
    if (ev.type === "message") {
      if (ev.content.every((b) => b.kind === "thinking")) {
        lines.push({ text: "   💭 (thinking)", color: theme.dim });
        continue;
      }
      const text = blockText(ev.content);
      if (!text) continue;
      // Hide injected scaffolding (permissions, environment context, AGENTS.md,
      // IDE hints) so the reader sees the real human↔assistant dialogue.
      if (ev.role !== "assistant" && isInjectedText(text)) continue;
      const who =
        ev.role === "user" ? "🧑 You" : ev.role === "assistant" ? "🤖 Assistant" : "⚙️  System";
      const color = ev.role === "user" ? theme.accent : ev.role === "assistant" ? theme.brand : theme.dim;
      lines.push({ text: "" });
      lines.push({ text: who, color, bold: true });
      for (const l of wrap(text, w)) lines.push({ text: l });
    } else if (ev.type === "tool_call") {
      lines.push({ text: `   🔧 ${ev.tool}(${briefInput(ev.input)})`, color: theme.dim });
    } else if (ev.type === "tool_result") {
      const first = (ev.output ?? "").split("\n").find((l) => l.trim()) ?? "";
      if (first) lines.push({ text: `      ↳ ${first.slice(0, w - 8)}`, color: theme.dim });
    }
  }

  if (lines.length === 0) lines.push({ text: "(no readable messages)", color: theme.dim });
  // A small header line giving provenance.
  lines.unshift({ text: `from ${toolName(doc.source.tool)} · ${doc.events.length} events`, color: theme.dim });
  return lines;
}
