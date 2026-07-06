import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { getAdapter } from "./adapters/registry.js";
import type { ImportOptions, ImportResult, SessionRef } from "./adapters/types.js";
import { parseUcf, type UcfDocument } from "./ucf/schema.js";
import { redactUcf, type UcfRedactionReport } from "./redact/redactUcf.js";
import { buildSummary } from "./resume/summary.js";
import { buildPrimingPrompt } from "./resume/render.js";
import { stripScaffolding } from "./resume/strip.js";
import { detectGit } from "./util/git.js";

export interface ExportToUcfOptions {
  /** Session id or path; if omitted, the most recently updated session is used. */
  session?: string;
  redact?: boolean;
  maxOutputBytes?: number;
  /** Run `git` in cwd_hint to enrich project metadata. */
  detectGit?: boolean;
}

export interface ExportToUcfResult {
  doc: UcfDocument;
  ref: SessionRef;
  redaction?: UcfRedactionReport;
}

/** Read a tool's native session, normalize to UCF, redact, and summarize. */
export async function exportToUcf(
  tool: string,
  opts: ExportToUcfOptions = {},
): Promise<ExportToUcfResult> {
  const adapter = getAdapter(tool);
  if (!(await adapter.available())) {
    throw new Error(`${adapter.label} storage not found on this machine.`);
  }

  let ref: SessionRef;
  if (opts.session) {
    ref = await adapter.resolve(opts.session);
  } else {
    const all = await adapter.list();
    if (all.length === 0) throw new Error(`No ${adapter.label} sessions found.`);
    ref = all[0]!;
  }

  let doc = await adapter.exportSession(ref, { maxOutputBytes: opts.maxOutputBytes });

  if (opts.detectGit && doc.project.cwd_hint && existsSync(doc.project.cwd_hint)) {
    const git = await detectGit(doc.project.cwd_hint);
    doc.project.repo = git.repo;
    doc.project.commit = git.commit;
    if (git.branch) doc.project.git_branch = git.branch;
  }

  let redaction: UcfRedactionReport | undefined;
  if (opts.redact ?? true) {
    const r = redactUcf(doc);
    doc = r.doc;
    redaction = r.report;
  }

  doc.summary = buildSummary(doc);
  return { doc, ref, redaction };
}

/** Load and validate a UCF document from a file. */
export async function loadUcf(path: string): Promise<UcfDocument> {
  const raw = await readFile(path, "utf8");
  return parseUcf(JSON.parse(raw));
}

/** Write a UCF document to a file as pretty JSON. */
export async function saveUcf(path: string, doc: UcfDocument): Promise<void> {
  await writeFile(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export interface ResumeOptions {
  mode?: "replay" | "native";
  cwd?: string;
}

/** Stage a UCF document as a resumable native session in the target tool. */
export async function resumeIntoTool(
  tool: string,
  doc: UcfDocument,
  opts: ResumeOptions = {},
): Promise<ImportResult> {
  const adapter = getAdapter(tool);
  if (!adapter.importSession) {
    throw new Error(`${adapter.label} does not support writing sessions yet.`);
  }
  // The destination injects its own scaffolding on resume; carrying the
  // source's along bloats prompts and pollutes native history. The UCF file
  // itself keeps full fidelity — only the destination copy is cleaned.
  const cleaned = stripScaffolding(doc);
  const importOpts: ImportOptions = {
    mode: opts.mode ?? "replay",
    cwd: opts.cwd,
    primingPrompt: buildPrimingPrompt(cleaned, adapter.label),
  };
  return adapter.importSession(cleaned, importOpts);
}
