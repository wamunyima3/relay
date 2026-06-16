import type { UcfDocument } from "../ucf/schema.js";
import { DEFAULT_RULES, redactString, type RedactionRule } from "./redact.js";

export interface UcfRedactionReport {
  total: number;
  byRule: Record<string, number>;
}

/**
 * Walk a UCF document and redact every place a secret could hide: text/code
 * blocks, tool output, and tool input values. Returns a new document plus a
 * report. The `redacted` flag is set true when anything was removed.
 */
export function redactUcf(
  doc: UcfDocument,
  rules: RedactionRule[] = DEFAULT_RULES,
): { doc: UcfDocument; report: UcfRedactionReport } {
  const byRule: Record<string, number> = {};
  const bump = (hits: { rule: string; count: number }[]) => {
    for (const h of hits) byRule[h.rule] = (byRule[h.rule] ?? 0) + h.count;
  };

  const events = doc.events.map((event) => {
    const content = event.content.map((block) => {
      if ((block.kind === "text" || block.kind === "code" || block.kind === "thinking") && "text" in block) {
        const r = redactString(block.text, rules);
        bump(r.hits);
        return { ...block, text: r.text };
      }
      return block;
    });

    let output = event.output;
    if (typeof output === "string") {
      const r = redactString(output, rules);
      bump(r.hits);
      output = r.text;
    }

    let input = event.input;
    if (input && typeof input === "object") {
      const r = redactString(JSON.stringify(input), rules);
      bump(r.hits);
      if (r.total > 0) {
        try {
          input = JSON.parse(r.text) as Record<string, unknown>;
        } catch {
          // If masking broke JSON structure, fall back to a safe stub.
          input = { __redacted: true };
        }
      }
    }

    return { ...event, content, output, input };
  });

  // The title is often derived from the first user message and can leak too.
  let title = doc.title;
  if (typeof title === "string") {
    const r = redactString(title, rules);
    bump(r.hits);
    title = r.text;
  }

  const total = Object.values(byRule).reduce((n, c) => n + c, 0);
  return {
    doc: { ...doc, title, events, redacted: doc.redacted || total > 0 },
    report: { total, byRule },
  };
}
