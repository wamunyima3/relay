/**
 * Deriving a human-readable conversation name.
 *
 * Claude Code stores a model-generated `aiTitle`; Codex stores none, so its name
 * is the first *real* user prompt. In both tools the early messages are often
 * injected scaffolding (environment context, AGENTS.md, IDE hints, slash-command
 * wrappers) that should never be shown as the title.
 */

/** Leading markers of injected/scaffolding messages, not real user prompts. */
const INJECTED_PREFIXES = [
  "<environment_context",
  "<permissions",
  "<user_instructions",
  "<ide_opened_file",
  "<ide_selection",
  "<command-name",
  "<command-message",
  "<command-args",
  "<local-command",
  "<system-reminder",
  "# agents.md",
  "# files mentioned by the user",
  "caveat: the messages below",
];

/** True if `text` looks like injected scaffolding rather than a human prompt. */
export function isInjectedText(text: string): boolean {
  const t = text.trimStart().toLowerCase();
  if (!t) return true;
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

/** Normalize a prompt into a compact one-line title. */
export function toTitle(text: string, max = 80): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/**
 * Pick the first genuine user prompt from an ordered list of (role, text)
 * messages, skipping injected scaffolding. Returns a compact title or undefined.
 */
export function firstHumanPromptTitle(
  messages: { role: string | undefined; text: string }[],
  max = 80,
): string | undefined {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (isInjectedText(m.text)) continue;
    const title = toTitle(m.text, max);
    if (title) return title;
  }
  return undefined;
}
