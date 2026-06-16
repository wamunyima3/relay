import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import {
  exportToUcf,
  resumeTargets,
  type SessionRef,
  type UcfDocument,
  type ExportToUcfResult,
} from "@relay/core";
import { Banner } from "./Banner.js";
import { theme, toolName } from "./theme.js";
import { useAsync } from "../hooks/useAsync.js";

export type DetailAction =
  | { kind: "resume"; target: string; mode: "replay" | "native"; doc: UcfDocument }
  | { kind: "transcript"; doc: UcfDocument }
  | { kind: "export"; doc: UcfDocument; ref: SessionRef }
  | { kind: "summary"; doc: UcfDocument };

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box>
      <Box width={12}>
        <Text color={theme.dim}>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

export function SessionDetail({
  session,
  onAction,
  onBack,
}: {
  session: SessionRef;
  onAction: (a: DetailAction) => void;
  onBack: () => void;
}): React.ReactElement {
  const { loading, error, value } = useAsync<ExportToUcfResult>(
    () => exportToUcf(session.tool, { session: session.id }),
    [session.tool, session.id],
  );

  useInput((_input, key) => {
    if (key.escape) onBack();
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Loading conversation…" />
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>{" "}
          Reading & redacting {toolName(session.tool)} session…
        </Text>
      </Box>
    );
  }

  if (error || !value) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Couldn't load conversation" />
        <Text color={theme.err}>✖ {error?.message ?? "unknown error"}</Text>
        <Text color={theme.dim}>Esc to go back</Text>
      </Box>
    );
  }

  const { doc, redaction } = value;
  const targets = resumeTargets(session.tool);
  const events = doc.events.length;

  // For each valid target, offer "continue" (native — reconstructs the whole
  // thread and shows up in that tool's history/resume picker) and "new primed
  // chat" (replay). The source tool is never a target; Cursor is read-only.
  const resumeItems = targets.flatMap((target) => [
    {
      label: `▶ Resume in ${toolName(target)} — continue this thread (adds to ${toolName(target)}'s history)`,
      value: `resume:${target}:native`,
    },
    {
      label: `▶ Resume in ${toolName(target)} — new chat primed with a recap`,
      value: `resume:${target}:replay`,
    },
  ]);
  const items = [
    { label: "💬 Read the conversation", value: "transcript" },
    ...resumeItems,
    { label: "Export to a UCF file", value: "export" },
    { label: "View summary", value: "summary" },
    { label: "← Back", value: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Banner subtitle={doc.title ? doc.title.slice(0, 70) : "Conversation"} />
      <Box flexDirection="column" marginBottom={1}>
        <Row label="Source" value={`${toolName(session.tool)}${doc.source.version ? ` v${doc.source.version}` : ""}`} />
        <Row label="Project" value={doc.project.cwd_hint ?? "(unknown)"} />
        <Row label="Events" value={String(events)} />
        <Row
          label="Secrets"
          value={
            redaction && redaction.total > 0
              ? `${redaction.total} redacted ✓`
              : "none found"
          }
        />
      </Box>
      <SelectInput
        items={items}
        onSelect={(i) => {
          const v = (i as { value: string }).value;
          if (v === "back") return onBack();
          if (v === "transcript") return onAction({ kind: "transcript", doc });
          if (v === "export") return onAction({ kind: "export", doc, ref: session });
          if (v === "summary") return onAction({ kind: "summary", doc });
          if (v.startsWith("resume:")) {
            const [, target, mode] = v.split(":") as [string, string, "replay" | "native"];
            return onAction({ kind: "resume", target, mode, doc });
          }
        }}
      />
      <Box marginTop={1}>
        <Text color={theme.dim}>↵ to choose · Esc to go back</Text>
      </Box>
    </Box>
  );
}
