#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import pc from "picocolors";

import { allAdapters, getAdapter, toolIds } from "./adapters/registry.js";
import type { ImportResult } from "./adapters/types.js";
import { exportToUcf, loadUcf, resumeIntoTool, saveUcf } from "./core.js";
import { buildPrimingPrompt, renderMarkdown } from "./resume/render.js";
import { stripScaffolding } from "./resume/strip.js";

const program = new Command();

program
  .name("relay")
  .description("Port AI coding conversations between tools (Claude Code ⇄ Codex).")
  .version("0.1.0");

function fail(message: string): never {
  console.error(pc.red(`✖ ${message}`));
  process.exit(1);
}

function toolChoiceHelp(): string {
  return `tool to use (${toolIds().join(" | ")})`;
}

/** Print how to pick up a staged session — a command, or GUI guidance. */
function printResumeResult(result: ImportResult): void {
  if (result.resumeCommand) {
    console.log(`\n  Resume it with:\n  ${pc.cyan(result.resumeCommand)}\n`);
  } else if (result.note) {
    console.log(`\n  ${result.note}`);
    if (result.backupPath) console.log(pc.dim(`  Index backup: ${result.backupPath}`));
    console.log("");
  }
}

/** `--open`: drop the user straight into the resumed session. */
function openResumed(result: ImportResult): void {
  if (!result.launch) {
    console.log(pc.yellow(`  ${getAdapter(result.tool).label} can't be launched from the terminal — follow the note above.`));
    return;
  }
  const { cmd, args, cwd } = result.launch;
  console.log(pc.dim(`  Opening: ${cmd} ${args.join(" ")}  (in ${cwd})\n`));
  const run = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (run.error) {
    fail(`Couldn't launch ${cmd}: ${run.error.message}. Is it on your PATH?`);
  }
}

/* ----------------------------------- list ---------------------------------- */
program
  .command("list")
  .description("List conversations stored locally by each tool.")
  .option("--from <tool>", `only this ${toolChoiceHelp()}`)
  .option("--json", "output JSON")
  .option("-n, --limit <n>", "max sessions per tool", "15")
  .action(async (opts) => {
    const adapters = opts.from ? [getAdapter(opts.from)] : allAdapters();
    const limit = Number(opts.limit) || 15;
    const result: Record<string, unknown[]> = {};

    for (const adapter of adapters) {
      if (!(await adapter.available())) {
        if (!opts.json) console.log(pc.dim(`${adapter.label}: storage not found, skipping.`));
        continue;
      }
      const sessions = (await adapter.list()).slice(0, limit);
      result[adapter.tool] = sessions;
      if (opts.json) continue;

      console.log(pc.bold(`\n${adapter.label}`) + pc.dim(`  (${adapter.tool})`));
      if (sessions.length === 0) {
        console.log(pc.dim("  no sessions"));
        continue;
      }
      for (const s of sessions) {
        const title = s.title ? ` — ${s.title}` : "";
        const relayed = s.relayed ? pc.magenta(" ⇄ relayed") : "";
        console.log(
          `  ${pc.cyan(s.id.slice(0, 8))} ${pc.dim(s.updatedAt?.slice(0, 16) ?? "")} ` +
            `${pc.dim(`[${s.messageCount ?? "?"} msgs]`)}${relayed}${title}`,
        );
        if (s.cwd) console.log(pc.dim(`           ${s.cwd}`));
      }
    }

    if (opts.json) console.log(JSON.stringify(result, null, 2));
  });

/* ---------------------------------- export --------------------------------- */
program
  .command("export")
  .description("Export a native session to the Universal Conversation Format (UCF).")
  .requiredOption("--from <tool>", toolChoiceHelp())
  .option("--session <idOrPath>", "session id or .jsonl path (default: most recent)")
  .option("-o, --out <file>", "write UCF to this file (default: stdout)")
  .option("--no-redact", "do NOT strip secrets (unsafe — for local debugging only)")
  .option("--git", "enrich with git repo/commit metadata", false)
  .option("--max-output-bytes <n>", "truncate tool outputs larger than this", "8000")
  .action(async (opts) => {
    try {
      const { doc, ref, redaction } = await exportToUcf(opts.from, {
        session: opts.session,
        redact: opts.redact,
        detectGit: opts.git,
        maxOutputBytes: Number(opts.maxOutputBytes) || undefined,
      });

      if (opts.out) {
        await saveUcf(opts.out, doc);
        console.error(pc.green(`✔ Exported ${ref.id.slice(0, 8)} → ${opts.out}`));
        console.error(
          pc.dim(`  ${doc.events.length} events · ${doc.source.tool} → UCF ${doc.ucf_version}`),
        );
      } else {
        console.log(JSON.stringify(doc, null, 2));
      }

      if (redaction && redaction.total > 0) {
        const detail = Object.entries(redaction.byRule)
          .map(([k, v]) => `${k}×${v}`)
          .join(", ");
        console.error(pc.yellow(`⚠ Redacted ${redaction.total} secret(s): ${detail}`));
      } else if (opts.redact === false) {
        console.error(pc.red("⚠ Redaction DISABLED — this UCF may contain secrets."));
      }
    } catch (e) {
      fail((e as Error).message);
    }
  });

/* ---------------------------------- resume --------------------------------- */
program
  .command("resume")
  .description("Stage a UCF document as a resumable session in the target tool.")
  .requiredOption("--to <tool>", toolChoiceHelp())
  .argument("<ucf>", "path to a UCF .json file")
  .option("--mode <mode>", "replay (universal, lossy) | native (high-fidelity)", "replay")
  .option("--cwd <dir>", "destination working directory (default: from UCF)")
  .option("--open", "launch the destination tool on the staged session right away")
  .option("--print", "print the priming prompt instead of writing a session")
  .showHelpAfterError(
    `\nTip: resume stages an exported UCF file. To go tool→tool in one step:\n  relay convert --from <tool> --to <tool> [--session <id>]`,
  )
  .action(async (ucfPath, opts) => {
    try {
      const doc = await loadUcf(ucfPath).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") {
          fail(
            `No such file: ${ucfPath}\n  resume takes a UCF file exported with \`relay export\`.\n` +
              `  To resume a session by id in one step: relay convert --from <tool> --to <tool> --session ${ucfPath}`,
          );
        }
        throw e;
      });
      if (opts.print) {
        // Mirror exactly what resumeIntoTool would write.
        console.log(buildPrimingPrompt(stripScaffolding(doc), getAdapter(opts.to).label));
        return;
      }
      if (opts.mode !== "replay" && opts.mode !== "native") {
        fail(`--mode must be "replay" or "native", got "${opts.mode}"`);
      }
      const result = await resumeIntoTool(opts.to, doc, { mode: opts.mode, cwd: opts.cwd });
      console.log(pc.green(`✔ Staged ${opts.mode} session for ${getAdapter(opts.to).label}`));
      console.log(pc.dim(`  ${result.path}`));
      printResumeResult(result);
      if (opts.open) openResumed(result);
    } catch (e) {
      fail((e as Error).message);
    }
  });

/* --------------------------------- convert --------------------------------- */
program
  .command("convert")
  .description("One-shot: export from one tool and resume into another.")
  .requiredOption("--from <tool>", `source ${toolChoiceHelp()}`)
  .requiredOption("--to <tool>", `target ${toolChoiceHelp()}`)
  .option("--session <idOrPath>", "source session (default: most recent)")
  .option("--mode <mode>", "replay | native", "replay")
  .option("--cwd <dir>", "destination working directory")
  .option("--open", "launch the destination tool on the staged session right away")
  .option("--no-redact", "do NOT strip secrets (unsafe)")
  .action(async (opts) => {
    try {
      const { doc, ref, redaction } = await exportToUcf(opts.from, {
        session: opts.session,
        redact: opts.redact,
      });
      console.log(pc.dim(`Exported ${ref.id.slice(0, 8)} from ${opts.from} (${doc.events.length} events).`));
      if (redaction && redaction.total > 0) {
        console.log(pc.yellow(`Redacted ${redaction.total} secret(s).`));
      }
      const result = await resumeIntoTool(opts.to, doc, { mode: opts.mode, cwd: opts.cwd });
      console.log(pc.green(`✔ ${opts.from} → ${opts.to} (${opts.mode})`));
      printResumeResult(result);
      if (opts.open) openResumed(result);
    } catch (e) {
      fail((e as Error).message);
    }
  });

/* --------------------------------- inspect --------------------------------- */
program
  .command("inspect")
  .description("Show a summary of a UCF document.")
  .argument("<ucf>", "path to a UCF .json file")
  .option("--markdown", "print the full transcript as Markdown")
  .action(async (ucfPath, opts) => {
    try {
      const doc = await loadUcf(ucfPath);
      if (opts.markdown) {
        console.log(renderMarkdown(doc));
        return;
      }
      console.log(pc.bold(`UCF ${doc.ucf_version}`) + pc.dim(`  (${doc.conversation_id})`));
      console.log(`  source : ${doc.source.tool}${doc.source.version ? ` v${doc.source.version}` : ""}`);
      console.log(`  title  : ${doc.title ?? pc.dim("(none)")}`);
      console.log(`  project: ${doc.project.cwd_hint ?? pc.dim("(unknown)")}${doc.project.git_branch ? ` @ ${doc.project.git_branch}` : ""}`);
      console.log(`  events : ${doc.events.length}`);
      console.log(`  redacted: ${doc.redacted ? pc.green("yes") : pc.yellow("no")}`);
      if (doc.summary) console.log(`\n${pc.bold("Summary")}\n${doc.summary}`);
    } catch (e) {
      fail((e as Error).message);
    }
  });

program.parseAsync().catch((e) => fail((e as Error).message));
