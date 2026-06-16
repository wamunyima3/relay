# Relay

Port AI coding conversations between tools. Start a session in **Codex**, pick it
up — with full context — in **Claude Code**, and back again.

Relay reads a conversation out of one tool's local storage, normalizes it to a
single versioned format (the **Universal Conversation Format**, UCF), strips any
secrets, and stages it as a resumable session in another tool.

> **Status:** Phase 1 (local CLI, Claude Code ⇄ Codex). Cursor, cloud sync, and a
> mobile PWA are on the roadmap below. Built against the on-disk formats of Claude
> Code and Codex CLI as of mid-2026 — re-verify before relying on it, the vendors
> move fast.

---

## What actually moves

A conversation is several layers, and they aren't equally portable. Relay is
honest about this:

| Layer | Portability | What Relay does |
|---|---|---|
| Message transcript | High | Moved faithfully |
| Tool calls & results | Medium | Normalized to generic `tool_call`/`tool_result`; large outputs truncated + hashed |
| Working state (open files, cursor) | Low | Not captured |
| Model context window | None | Reconstructed by the destination model from the transcript |
| Secrets / auth | — | **Stripped before anything is written** |

You can't teleport the model's mind. Relay moves the **transcript + tool history**;
the destination model rebuilds its working context from that. Repo files travel
separately and naturally through **git** — Relay records the commit/branch so the
destination can warn about drift, but it never syncs code.

## Two ways to drive it

Relay ships as a small monorepo with two front-ends over one engine:

| Folder | Package | Binary | For |
|---|---|---|---|
| `packages/core` | `@relay/core` | `relay` | Scriptable commands + the engine library |
| `packages/cli` | `@relay/cli` | `relay-ui` | Interactive terminal UI (Ink), like Claude Code |

Pick whichever fits: type exact commands with `relay`, or launch `relay-ui` and
drive everything with arrow keys.

## Install

```bash
pnpm install
pnpm build              # builds both packages
```

Run from source without building:

```bash
pnpm relay <command>    # scriptable CLI  (packages/core)
pnpm ui                 # interactive UI  (packages/cli)
```

Put the binaries on your PATH:

```bash
pnpm -r --filter @relay/core --filter @relay/cli exec npm link
# now `relay` and `relay-ui` are global
```

## Interactive UI

```bash
relay-ui
```

```
⇄ Relay · conversation portability
Move a coding conversation between Claude Code and Codex.

❯ Browse conversations  — pick one and move it to another tool
  Open a UCF file       — inspect or resume an exported conversation
  Quit
```

- **Browse conversations** — lists every Claude Code and Codex session on the
  machine (newest first, with message counts and titles). Pick one to see its
  details, then resume it into the other tool (replay or native), export it to a
  UCF file, or read its summary.
- **Open a UCF file** — load a previously exported `.ucf.json` and resume it into
  either tool.

Arrow keys to move, `↵` to select, `Esc` to go back, `Ctrl+C` to quit. It needs an
interactive terminal; for pipelines and scripts use `relay` below.

## Scriptable CLI

### List what's stored locally

```bash
relay list                 # both tools
relay list --from codex    # one tool
relay list --json          # machine-readable
```

### Export a session to UCF

```bash
# most recent Codex session → a portable UCF file
relay export --from codex -o session.ucf.json

# a specific session by id (prefix is fine) or by path
relay export --from claude --session 7b7009a9 -o session.ucf.json

# enrich with git repo/commit so the destination can check for drift
relay export --from codex --git -o session.ucf.json
```

Redaction runs by default. The command prints what it removed:

```
✔ Exported 019ecefd → session.ucf.json
  542 events · codex → UCF 1.0
⚠ Redacted 2 secret(s): secret-assignment×2
```

### Resume into another tool

```bash
# stage the UCF as a Claude Code session, then follow the printed command
relay resume --to claude session.ucf.json
#   ✔ Staged replay session for Claude Code
#     Resume it with:
#     cd /path/to/repo && claude --resume <new-session-id>
```

### One-shot convert

```bash
relay convert --from codex --to claude --session 019ecefd
relay convert --from claude --to codex            # uses most recent
```

### Inspect a UCF file

```bash
relay inspect session.ucf.json              # summary + metadata
relay inspect session.ucf.json --markdown   # full readable transcript
```

## Two resume modes

- **`replay`** (default, universal, lossy) — the whole conversation is packaged
  as one well-structured priming prompt ("here's the prior conversation and
  decisions, continue from here") and dropped into a fresh session. Works on any
  surface. Start here.
- **`native`** (`--mode native`, high-fidelity) — events are reconstructed
  one-to-one into the destination's native format so its own `--resume`/`resume`
  picks them up seamlessly. Strongest for the Claude ⇄ Codex JSONL pair.

```bash
relay convert --from codex --to claude --mode native
```

## Safety

- **Redaction is mandatory and runs before anything is written.** It catches
  provider API keys (Anthropic, OpenAI, GitHub, Slack, Google, Stripe, AWS),
  private-key blocks, JWTs, bearer tokens, and `SECRET=…` / `"password": "…"`
  style assignments. `--no-redact` exists for local debugging and shouts a
  warning; don't sync the result.
- **No code is synced.** Git is the file-transport. Relay only records the
  commit/branch so a resume can warn if the destination has drifted.
- **Everything is local.** Nothing leaves your machine in Phase 1.

## How it works

```
  native session ──exportSession──▶ UCF ──redact──▶ UCF ──importSession──▶ native session
   (Claude/Codex)    (adapter)      (normalized)    (safe)    (adapter)      (resumable)
```

- **UCF** (`packages/core/src/ucf/schema.ts`) — a versioned, Zod-validated,
  append-only event stream modelled on the JSONL shape Claude and Codex already
  use. Typed content blocks; large tool outputs truncated + hashed; every event
  keeps provenance.
- **Adapters** (`packages/core/src/adapters/`) — one module per tool, each doing
  `export` (read native → UCF) and `import` (UCF → native). All the tool-specific
  mess lives here so the core stays clean. Adding Cursor is "write another adapter."
- **Redaction** (`packages/core/src/redact/`) — fail-closed secret scanning over
  text, tool output, tool input, and titles.
- **Resume** (`packages/core/src/resume/`) — deterministic, no-API summarizer +
  transcript / priming-prompt renderers.
- **Interactive UI** (`packages/cli/src/`) — an Ink (React-for-terminals) app that
  drives the engine through `@relay/core`'s library exports. No tool logic lives
  here; it's purely a front-end.

### Storage formats (verified against real sessions on this machine)

- **Claude Code** — append-only JSONL at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`,
  with `uuid`/`parentUuid` chains and `message.content[]` blocks
  (`text`/`thinking`/`tool_use`/`tool_result`/`image`).
- **Codex CLI** — append-only rollout JSONL at
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`: a `session_meta` header then
  `response_item` payloads (`message`, `function_call`, `function_call_output`,
  `reasoning`, `custom_tool_call`).

Override the storage roots with `RELAY_CLAUDE_DIR` / `RELAY_CODEX_DIR` (used by
the test suite for hermetic runs).

## Development

```bash
pnpm install
pnpm build          # build both packages (cli imports built @relay/core)
pnpm test           # run every package's vitest suite
pnpm typecheck
```

Layout:

```
relay/
├─ package.json            # workspace root (scripts: build, test, relay, ui)
├─ pnpm-workspace.yaml
└─ packages/
   ├─ core/                # @relay/core — engine + scriptable `relay` CLI
   └─ cli/                 # @relay/cli  — interactive `relay-ui` (Ink)
```

## Roadmap

- **Phase 1 (done)** — local CLI + interactive Ink UI, transcript replay + native injection, Claude ⇄ Codex.
- **Phase 2** — Cursor read adapter (`state.vscdb` SQLite, `composerData:*` BLOBs).
- **Phase 3** — local watcher daemon + authenticated, end-to-end-encrypted cloud sync; resume on another machine.
- **Phase 4** — mobile PWA: browse on your phone, trigger a resume on a paired machine.
- **Phase 5** — model-written summaries, redaction hardening, more adapters (Windsurf, Aider).

## License

MIT
