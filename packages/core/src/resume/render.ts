import type { UcfDocument, UcfEvent } from "../ucf/schema.js";
import { buildSummary } from "./summary.js";

function blockText(ev: UcfEvent): string {
  return ev.content
    .map((b) => {
      if (b.kind === "text") return b.text;
      if (b.kind === "code") return "```" + (b.language ?? "") + "\n" + b.text + "\n```";
      if (b.kind === "thinking") return ""; // omit reasoning from transcript
      if (b.kind === "image") return "[image]";
      if (b.kind === "file_ref") return `[file: ${b.path}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export interface RenderOptions {
  /** Include tool calls/results, not just messages. */
  includeTools?: boolean;
  /** Cap each tool output in the transcript. */
  toolOutputCap?: number;
}

/** Render a UCF document as a readable Markdown transcript. */
export function renderMarkdown(doc: UcfDocument, opts: RenderOptions = {}): string {
  const includeTools = opts.includeTools ?? true;
  const cap = opts.toolOutputCap ?? 1200;
  const out: string[] = [];

  out.push(`# Conversation${doc.title ? `: ${doc.title}` : ""}`);
  out.push(
    `_Source: ${doc.source.tool}${doc.source.version ? ` v${doc.source.version}` : ""} · exported ${doc.source.exported_at}_`,
  );
  if (doc.project.cwd_hint) out.push(`_Project: ${doc.project.cwd_hint}${doc.project.git_branch ? ` (${doc.project.git_branch})` : ""}_`);
  out.push("");

  for (const ev of doc.events) {
    if (ev.type === "message") {
      const text = blockText(ev);
      if (!text) continue;
      const who = ev.role === "user" ? "🧑 User" : ev.role === "assistant" ? "🤖 Assistant" : "⚙️ System";
      out.push(`### ${who}`);
      out.push(text);
      out.push("");
    } else if (ev.type === "tool_call" && includeTools) {
      out.push(`### 🔧 Tool call: \`${ev.tool}\``);
      out.push("```json");
      out.push(JSON.stringify(ev.input ?? {}, null, 2));
      out.push("```");
      out.push("");
    } else if (ev.type === "tool_result" && includeTools) {
      const o = ev.output ?? "";
      out.push(`### 📤 Tool result`);
      out.push("```");
      out.push(o.length > cap ? o.slice(0, cap) + "\n…[truncated for transcript]" : o);
      out.push("```");
      out.push("");
    }
  }

  return out.join("\n").trim() + "\n";
}

/**
 * Build the single priming prompt used for Mode A (replay) resume: a summary up
 * top so the destination model gets the gist even if context is tight, then the
 * full transcript, then an explicit instruction to continue.
 */
/** Display names for tool ids used in the priming prompt. */
const TOOL_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

function prettyTool(id: string): string {
  return TOOL_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function buildPrimingPrompt(doc: UcfDocument, targetTool: string): string {
  const summary = doc.summary ?? buildSummary(doc);
  const transcript = renderMarkdown(doc, { includeTools: true });
  return [
    `You are resuming a coding conversation that began in **${prettyTool(doc.source.tool)}** and is being continued in **${targetTool}** via Relay.`,
    ``,
    `The repository files travel separately through git — verify you are on a compatible commit/branch before acting on file state. Do not assume the working tree matches the transcript.`,
    ``,
    `## Recap`,
    summary,
    ``,
    `## Full prior transcript`,
    transcript,
    ``,
    `---`,
    `Continue from where the conversation left off. Pick up the most recent open thread; ask for clarification only if the next step is genuinely ambiguous.`,
  ].join("\n");
}
