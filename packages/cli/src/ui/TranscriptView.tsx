import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { UcfDocument } from "@relay/core";
import { Banner } from "./Banner.js";
import { theme } from "./theme.js";
import { buildTranscriptLines } from "./transcript.js";

/** A keyboard-scrollable, read-only view of a whole conversation. */
export function TranscriptView({
  doc,
  onBack,
}: {
  doc: UcfDocument;
  onBack: () => void;
}): React.ReactElement {
  const width = (process.stdout.columns ?? 100) - 2;
  const rows = process.stdout.rows ?? 24;
  const pageSize = Math.max(8, rows - 7);

  const lines = useMemo(() => buildTranscriptLines(doc, width), [doc, width]);
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, lines.length - pageSize);
  const clamp = (n: number) => Math.min(maxOffset, Math.max(0, n));

  useInput((input, key) => {
    if (key.escape || input === "q") return onBack();
    if (key.downArrow || input === "j") setOffset((o) => clamp(o + 1));
    else if (key.upArrow || input === "k") setOffset((o) => clamp(o - 1));
    else if (key.pageDown || input === " ") setOffset((o) => clamp(o + pageSize));
    else if (key.pageUp || input === "b") setOffset((o) => clamp(o - pageSize));
    else if (input === "g") setOffset(0);
    else if (input === "G") setOffset(maxOffset);
  });

  const view = lines.slice(offset, offset + pageSize);
  const last = Math.min(offset + pageSize, lines.length);

  return (
    <Box flexDirection="column">
      <Banner subtitle={doc.title ? doc.title.slice(0, 70) : "Conversation"} />
      <Box flexDirection="column">
        {view.map((l, i) => (
          <Text key={offset + i} color={l.color} bold={l.bold} wrap="truncate-end">
            {l.text.length ? l.text : " "}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          {offset + 1}-{last}/{lines.length} · ↑/↓ scroll · space/b page · g/G ends · Esc back
        </Text>
      </Box>
    </Box>
  );
}
