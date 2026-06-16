import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { loadUcf, resumeTargets, type UcfDocument } from "@relay/core";
import { Banner } from "./Banner.js";
import { theme, toolName } from "./theme.js";

export type UcfAction =
  | { kind: "resume"; target: string; mode: "replay" | "native"; doc: UcfDocument }
  | { kind: "transcript"; doc: UcfDocument }
  | { kind: "summary"; doc: UcfDocument };

export function OpenUcf({
  onAction,
  onBack,
}: {
  onAction: (a: UcfAction) => void;
  onBack: () => void;
}): React.ReactElement {
  const [path, setPath] = useState("");
  const [doc, setDoc] = useState<UcfDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.escape) onBack();
  });

  async function submit(value: string) {
    const trimmed = value.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~");
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const loaded = await loadUcf(trimmed);
      setDoc(loaded);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Loading UCF…" />
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>{" "}
          Reading and validating {path}…
        </Text>
      </Box>
    );
  }

  if (!doc) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Open a UCF file" />
        <Box>
          <Text color={theme.dim}>Path: </Text>
          <TextInput value={path} onChange={setPath} onSubmit={submit} placeholder="./session.ucf.json" />
        </Box>
        {error ? <Text color={theme.err}>✖ {error}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.dim}>↵ to load · Esc to go back</Text>
        </Box>
      </Box>
    );
  }

  // Offer every valid target except the tool that produced this conversation.
  const resumeItems = resumeTargets(doc.source.tool).flatMap((target) => [
    { label: `▶ Resume in ${toolName(target)} — continue this thread`, value: `resume:${target}:native` },
    { label: `▶ Resume in ${toolName(target)} — new chat primed with a recap`, value: `resume:${target}:replay` },
  ]);
  const items = [
    { label: "💬 Read the conversation", value: "transcript" },
    ...resumeItems,
    { label: "View summary", value: "summary" },
    { label: "← Back", value: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Banner subtitle={doc.title ? doc.title.slice(0, 70) : "UCF document"} />
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.dim}>
          source {doc.source.tool} · {doc.events.length} events · redacted {doc.redacted ? "yes" : "no"}
        </Text>
      </Box>
      <SelectInput
        items={items}
        onSelect={(i) => {
          const v = (i as { value: string }).value;
          if (v === "back") return onBack();
          if (v === "transcript") return onAction({ kind: "transcript", doc });
          if (v === "summary") return onAction({ kind: "summary", doc });
          if (v.startsWith("resume:")) {
            const [, target, mode] = v.split(":") as [string, string, "replay" | "native"];
            onAction({ kind: "resume", target, mode, doc });
          }
        }}
      />
      <Box marginTop={1}>
        <Text color={theme.dim}>↵ to choose · Esc to go back</Text>
      </Box>
    </Box>
  );
}
