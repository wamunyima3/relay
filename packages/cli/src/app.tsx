import React, { useState } from "react";
import { useApp } from "ink";
import { join } from "node:path";
import {
  resumeIntoTool,
  saveUcf,
  type ImportResult,
  type SessionRef,
  type UcfDocument,
} from "@relay/core";

import { Home, type HomeAction } from "./ui/Home.js";
import { SessionPicker } from "./ui/SessionPicker.js";
import { SessionDetail, type DetailAction } from "./ui/SessionDetail.js";
import { OpenUcf, type UcfAction } from "./ui/OpenUcf.js";
import { Running } from "./ui/Running.js";
import { MessageView, type MessageLine } from "./ui/MessageView.js";
import { theme, toolName } from "./ui/theme.js";

/** All screens the app can be on. A tiny hand-rolled router via discriminated union. */
type Screen =
  | { k: "home" }
  | { k: "browse" }
  | { k: "detail"; session: SessionRef }
  | { k: "open-ucf" }
  | { k: "run"; label: string; run: () => Promise<MessageLine[]>; back: Screen }
  | { k: "message"; subtitle: string; lines: MessageLine[]; back: Screen };

function resumeResultLines(target: string, mode: string, result: ImportResult): MessageLine[] {
  return [
    { text: `✔ Staged a ${mode} session for ${toolName(target)}.`, color: theme.ok, bold: true },
    { text: "" },
    { text: "Resume it with:", color: theme.dim },
    { text: `  ${result.resumeCommand}`, color: theme.accent },
    { text: "" },
    { text: `File: ${result.path}`, color: theme.dim },
  ];
}

export function App(): React.ReactElement {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>({ k: "home" });

  const home = () => setScreen({ k: "home" });

  function handleHome(action: HomeAction) {
    if (action === "browse") setScreen({ k: "browse" });
    else if (action === "open-ucf") setScreen({ k: "open-ucf" });
    else exit();
  }

  /** Turn a resume/export/summary choice into the next screen. */
  function runResume(target: string, mode: "replay" | "native", doc: UcfDocument, back: Screen) {
    setScreen({
      k: "run",
      label: `Building ${mode} session for ${toolName(target)}…`,
      back,
      run: async () => {
        const result = await resumeIntoTool(target, doc, { mode });
        return resumeResultLines(target, mode, result);
      },
    });
  }

  function runExport(doc: UcfDocument, ref: SessionRef, back: Screen) {
    const out = join(process.cwd(), `relay-${ref.id.slice(0, 8)}.ucf.json`);
    setScreen({
      k: "run",
      label: `Writing UCF to ${out}…`,
      back,
      run: async () => {
        await saveUcf(out, doc);
        return [
          { text: `✔ Exported to ${out}`, color: theme.ok, bold: true },
          { text: "" },
          { text: `${doc.events.length} events · ${doc.redacted ? "redacted" : "no secrets found"}`, color: theme.dim },
        ];
      },
    });
  }

  function showSummary(doc: UcfDocument, back: Screen) {
    const lines: MessageLine[] = (doc.summary ?? "(no summary)").split("\n").map((text) => ({ text }));
    setScreen({ k: "message", subtitle: "Summary", lines, back });
  }

  function handleDetailAction(a: DetailAction, session: SessionRef) {
    const back: Screen = { k: "detail", session };
    if (a.kind === "resume") runResume(a.target, a.mode, a.doc, back);
    else if (a.kind === "export") runExport(a.doc, a.ref, back);
    else showSummary(a.doc, back);
  }

  function handleUcfAction(a: UcfAction) {
    const back: Screen = { k: "open-ucf" };
    if (a.kind === "resume") runResume(a.target, a.mode, a.doc, back);
    else showSummary(a.doc, back);
  }

  switch (screen.k) {
    case "home":
      return <Home onSelect={handleHome} />;
    case "browse":
      return <SessionPicker onPick={(s) => setScreen({ k: "detail", session: s })} onBack={home} />;
    case "detail":
      return (
        <SessionDetail
          session={screen.session}
          onAction={(a) => handleDetailAction(a, screen.session)}
          onBack={() => setScreen({ k: "browse" })}
        />
      );
    case "open-ucf":
      return <OpenUcf onAction={handleUcfAction} onBack={home} />;
    case "run":
      return (
        <Running<MessageLine[]>
          label={screen.label}
          run={screen.run}
          onDone={(lines) => setScreen({ k: "message", subtitle: "Done", lines, back: screen.back })}
          onError={(e) =>
            setScreen({
              k: "message",
              subtitle: "Something went wrong",
              lines: [{ text: `✖ ${e.message}`, color: theme.err }],
              back: screen.back,
            })
          }
        />
      );
    case "message":
      return <MessageView subtitle={screen.subtitle} lines={screen.lines} onDone={() => setScreen(screen.back)} />;
  }
}
