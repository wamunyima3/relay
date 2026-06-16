import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Home } from "../src/ui/Home.js";
import { SessionPicker } from "../src/ui/SessionPicker.js";
import { App } from "../src/app.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

let work: string;

const CODEX_FIXTURE =
  [
    { timestamp: "2026-03-31T07:00:00Z", type: "session_meta", payload: { id: "aaaa1111-bbbb-2222-cccc-333344445555", cwd: "/repo/demo", cli_version: "0.118.0" } },
    { timestamp: "2026-03-31T07:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "make the build green" }] } },
    { timestamp: "2026-03-31T07:00:06Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "relay-cli-test-"));
  process.env.RELAY_CLAUDE_DIR = join(work, "claude-empty");
  process.env.RELAY_CODEX_DIR = join(work, "codex");
  const dir = join(work, "codex", "2026", "03", "31");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-2026-03-31T07-00-00-aaaa1111.jsonl"), CODEX_FIXTURE);
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  delete process.env.RELAY_CLAUDE_DIR;
  delete process.env.RELAY_CODEX_DIR;
});

describe("Home", () => {
  it("renders the banner and menu options", () => {
    const { lastFrame } = render(<Home onSelect={() => {}} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Relay");
    expect(frame).toContain("Browse conversations");
    expect(frame).toContain("Open a UCF file");
    expect(frame).toContain("Quit");
  });
});

describe("SessionPicker", () => {
  it("loads and lists real sessions from the sandboxed storage", async () => {
    const { lastFrame } = render(<SessionPicker onPick={() => {}} onBack={() => {}} />);
    // Initial frame shows the loading spinner.
    expect(lastFrame() ?? "").toMatch(/Scanning|Reading/);
    await delay(150);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Codex");
    expect(frame).toContain("make the build green");
  });
});

describe("App", () => {
  it("mounts on the home screen", () => {
    const { lastFrame } = render(<App />);
    expect(lastFrame() ?? "").toContain("Browse conversations");
  });
});
