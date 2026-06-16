/**
 * Public library surface for the Relay engine.
 *
 * Anything a UI (the interactive CLI, a future daemon, the PWA) needs to drive
 * Relay is re-exported here, so consumers import from `@relay/core` rather than
 * reaching into internal paths.
 */

// Pipeline
export {
  exportToUcf,
  resumeIntoTool,
  loadUcf,
  saveUcf,
  type ExportToUcfOptions,
  type ExportToUcfResult,
  type ResumeOptions,
} from "./core.js";

// Adapters & discovery
export {
  allAdapters,
  getAdapter,
  toolIds,
  importableToolIds,
  resumeTargets,
} from "./adapters/registry.js";
export type {
  Adapter,
  SessionRef,
  ImportResult,
  ImportOptions,
  ExportOptions,
} from "./adapters/types.js";

// UCF schema & types
export {
  UCF_VERSION,
  parseUcf,
  safeParseUcf,
  type UcfDocument,
  type UcfEvent,
  type ContentBlock,
} from "./ucf/schema.js";

// Redaction
export { redactUcf, type UcfRedactionReport } from "./redact/redactUcf.js";
export { redactString, DEFAULT_RULES, type RedactionRule } from "./redact/redact.js";

// Rendering & summary
export { renderMarkdown, buildPrimingPrompt, type RenderOptions } from "./resume/render.js";
export { buildSummary } from "./resume/summary.js";
