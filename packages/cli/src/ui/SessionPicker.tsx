import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { allAdapters, type SessionRef } from "@relay/core";
import { Banner } from "./Banner.js";
import { theme, toolBadge, toolName } from "./theme.js";
import { useAsync } from "../hooks/useAsync.js";

/** Load every session from every available tool, newest first. */
async function loadAllSessions(): Promise<SessionRef[]> {
  const all: SessionRef[] = [];
  for (const adapter of allAdapters()) {
    if (!(await adapter.available())) continue;
    all.push(...(await adapter.list()));
  }
  all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return all;
}

function rowLabel(s: SessionRef): string {
  const when = s.updatedAt?.slice(0, 16).replace("T", " ") ?? "";
  const title = s.title ? ` ${s.title.slice(0, 48)}` : "";
  const msgs = s.messageCount != null ? `${s.messageCount} msgs` : "";
  return `${toolBadge(s.tool)} ${toolName(s.tool).padEnd(11)} ${when}  ${msgs.padStart(8)} ${title}`;
}

export function SessionPicker({
  onPick,
  onBack,
}: {
  onPick: (s: SessionRef) => void;
  onBack: () => void;
}): React.ReactElement {
  const { loading, error, value } = useAsync(loadAllSessions, []);

  useInput((_input, key) => {
    if (key.escape) onBack();
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Reading local sessions…" />
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>{" "}
          Scanning Claude Code and Codex storage…
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Couldn't read sessions" />
        <Text color={theme.err}>✖ {error.message}</Text>
        <Text color={theme.dim}>Esc to go back</Text>
      </Box>
    );
  }

  const sessions = value ?? [];
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="No conversations found" />
        <Text color={theme.dim}>No Claude Code or Codex sessions were found on this machine.</Text>
        <Text color={theme.dim}>Esc to go back</Text>
      </Box>
    );
  }

  const items = sessions.map((s, idx) => ({ label: rowLabel(s), value: String(idx), key: `${s.tool}-${s.id}` }));

  return (
    <Box flexDirection="column">
      <Banner subtitle={`${sessions.length} conversation(s) · pick one to move`} />
      <SelectInput
        items={items}
        limit={12}
        onSelect={(i) => {
          const picked = sessions[Number((i as { value: string }).value)];
          if (picked) onPick(picked);
        }}
      />
      <Box marginTop={1}>
        <Text color={theme.dim}>↑/↓ to move · ↵ to select · Esc to go back</Text>
      </Box>
    </Box>
  );
}
