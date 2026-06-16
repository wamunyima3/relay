import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Read a JSONL file into parsed objects, tolerating blank lines and skipping
 * (rather than throwing on) the occasional malformed line — real session files
 * sometimes contain partial writes at the tail.
 */
export async function readJsonl(path: string): Promise<{ objects: unknown[]; skipped: number }> {
  const raw = await readFile(path, "utf8");
  return parseJsonl(raw);
}

export function parseJsonl(raw: string): { objects: unknown[]; skipped: number } {
  const objects: unknown[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      skipped += 1;
    }
  }
  return { objects, skipped };
}

/** Serialize objects to JSONL and write them, creating parent dirs as needed. */
export async function writeJsonl(path: string, objects: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const body = objects.map((o) => JSON.stringify(o)).join("\n") + "\n";
  await writeFile(path, body, "utf8");
}
