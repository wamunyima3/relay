import { createHash } from "node:crypto";
import type { UcfEvent } from "../ucf/schema.js";

/** Default ceiling for a single tool output before we truncate + hash it. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8_000;

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export interface ReducedOutput {
  output: string;
  truncation?: UcfEvent["truncation"];
}

/**
 * Reduce an oversized tool output to a kept prefix, recording the original size
 * and a hash so nothing is silently lost. The brief calls for this on every
 * large tool output (§3a).
 */
export function reduceOutput(
  raw: string,
  maxBytes: number = DEFAULT_MAX_OUTPUT_BYTES,
): ReducedOutput {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes <= maxBytes) return { output: raw };

  // Keep a head slice that is valid UTF-8 (slice on a string boundary, not bytes).
  const kept = sliceToBytes(raw, maxBytes);
  const keptBytes = Buffer.byteLength(kept, "utf8");
  return {
    output: `${kept}\n…[truncated ${bytes - keptBytes} bytes of ${bytes}; sha256=${sha256(raw)}]`,
    truncation: {
      truncated: true,
      original_bytes: bytes,
      kept_bytes: keptBytes,
      sha256: sha256(raw),
    },
  };
}

/** Return the longest prefix of `s` whose UTF-8 encoding is <= maxBytes. */
function sliceToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Binary search on character length.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(s.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

/** Collapse content blocks of an event into a plain text string. */
export function flattenText(blocks: { kind: string; text?: string }[]): string {
  return blocks
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}
