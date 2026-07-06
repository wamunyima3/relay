import type { UcfDocument, UcfEvent } from "../ucf/schema.js";
import { isInjectedText } from "../util/title.js";

function eventText(ev: UcfEvent): string {
  return ev.content
    .filter((b) => b.kind === "text" || b.kind === "code")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/** True if this event is source-tool scaffolding rather than real dialogue. */
function isScaffolding(ev: UcfEvent): boolean {
  if (ev.type !== "message") return false;
  if (ev.provenance?.meta) return true;
  // Assistant text is always genuine dialogue; only user/system turns carry
  // injected scaffolding (permissions blocks, AGENTS.md, IDE context, …).
  if (ev.role === "assistant") return false;
  return isInjectedText(eventText(ev));
}

/**
 * Remove source-tool scaffolding events (permissions instructions, AGENTS.md,
 * environment context, skill/slash-command bodies) from a document before it
 * is written into a destination tool. The destination injects its own
 * scaffolding on resume, so carrying the source's along is pure noise — it
 * bloats replay priming prompts and shows up as fake "user" turns in natively
 * imported sessions.
 *
 * Parent pointers of surviving events are remapped to their nearest surviving
 * ancestor so the conversation chain stays intact. The original exported UCF
 * is untouched — stripping happens only on the copy handed to the destination.
 */
export function stripScaffolding(doc: UcfDocument): UcfDocument {
  const events: UcfEvent[] = [];
  // Nearest surviving ancestor at-or-above each event id (self when kept).
  const keptAncestor = new Map<string, string | null>();

  for (const ev of doc.events) {
    const parent = ev.parent ? keptAncestor.get(ev.parent) ?? null : null;
    if (isScaffolding(ev)) {
      keptAncestor.set(ev.id, parent);
    } else {
      events.push(ev.parent === parent ? ev : { ...ev, parent });
      keptAncestor.set(ev.id, ev.id);
    }
  }

  return { ...doc, events };
}
