import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { Banner } from "./Banner.js";
import { theme } from "./theme.js";

export type HomeAction = "browse" | "open-ucf" | "quit";

interface Item {
  label: string;
  value: HomeAction;
}

const items: Item[] = [
  { label: "Browse conversations  — pick one and move it to another tool", value: "browse" },
  { label: "Open a UCF file       — inspect or resume an exported conversation", value: "open-ucf" },
  { label: "Quit", value: "quit" },
];

export function Home({ onSelect }: { onSelect: (a: HomeAction) => void }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Banner subtitle="Move a coding conversation between Claude Code and Codex." />
      <SelectInput items={items} onSelect={(i) => onSelect((i as Item).value)} />
      <Box marginTop={1}>
        <Text color={theme.dim}>↑/↓ to move · ↵ to select · Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
}
