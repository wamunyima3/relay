import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { loadUcf, type UcfDocument } from "@relay/core";
import { Banner } from "./Banner.js";
import { theme, toolName } from "./theme.js";

export type UcfAction =
  | { kind: "resume"; target: string; mode: "replay" | "native"; doc: UcfDocument }
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

  const items = [
    { label: `Resume into ${toolName("claude")}  (replay)`, value: "claude:replay" },
    { label: `Resume into ${toolName("claude")}  (native)`, value: "claude:native" },
    { label: `Resume into ${toolName("codex")}  (replay)`, value: "codex:replay" },
    { label: `Resume into ${toolName("codex")}  (native)`, value: "codex:native" },
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
          if (v === "summary") return onAction({ kind: "summary", doc });
          const [target, mode] = v.split(":") as [string, "replay" | "native"];
          onAction({ kind: "resume", target, mode, doc });
        }}
      />
      <Box marginTop={1}>
        <Text color={theme.dim}>↵ to choose · Esc to go back</Text>
      </Box>
    </Box>
  );
}
