import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { allAdapters, toolIds, type SessionRef } from "@relay/core";
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

type ToolFilter = string; // "all" or a tool id
const FILTERS: ToolFilter[] = ["all", ...toolIds()];

/** A row's searchable haystack. */
function haystack(s: SessionRef): string {
  const relayed = s.relayed ? "relayed" : "";
  return `${toolName(s.tool)} ${s.title ?? ""} ${s.cwd ?? ""} ${s.id} ${relayed}`.toLowerCase();
}

/** Every whitespace-separated term must appear somewhere in the row. */
function matches(s: SessionRef, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = haystack(s);
  return terms.every((t) => hay.includes(t));
}

const WINDOW = 12;

export function SessionPicker({
  onPick,
  onBack,
}: {
  onPick: (s: SessionRef) => void;
  onBack: () => void;
}): React.ReactElement {
  const { loading, error, value } = useAsync(loadAllSessions, []);
  const sessions = useMemo(() => value ?? [], [value]);

  const [query, setQuery] = useState("");
  const [tool, setTool] = useState<ToolFilter>("all");
  const [index, setIndex] = useState(0);

  const filtered = useMemo(
    () => sessions.filter((s) => (tool === "all" || s.tool === tool) && matches(s, query)),
    [sessions, tool, query],
  );

  // Keep the highlight in range whenever the filtered set shrinks/changes.
  const safeIndex = Math.min(index, Math.max(0, filtered.length - 1));

  useInput(
    (input, key) => {
      if (key.escape) return onBack();
      if (key.return) {
        const picked = filtered[safeIndex];
        if (picked) onPick(picked);
        return;
      }
      if (key.upArrow) return setIndex(Math.max(0, safeIndex - 1));
      if (key.downArrow) return setIndex(Math.min(filtered.length - 1, safeIndex + 1));
      if (key.tab) {
        const next = FILTERS[(FILTERS.indexOf(tool) + 1) % FILTERS.length]!;
        setTool(next);
        setIndex(0);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setIndex(0);
        return;
      }
      // Printable text → extend the query (ignore control/meta combos).
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setIndex(0);
      }
    },
    { isActive: !loading && !error },
  );

  if (loading) {
    return (
      <Box flexDirection="column">
        <Banner subtitle="Reading local sessions…" />
        <Text>
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>{" "}
          Scanning Claude Code, Codex, and Cursor storage…
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

  // Window the list so the highlight stays visible in long results.
  const start = Math.min(Math.max(0, safeIndex - Math.floor(WINDOW / 2)), Math.max(0, filtered.length - WINDOW));
  const view = filtered.slice(start, start + WINDOW);

  return (
    <Box flexDirection="column">
      <Banner subtitle={`${filtered.length}/${sessions.length} conversation(s)`} />

      <Box>
        <Text color={theme.accent}>Search </Text>
        <Text>{query}</Text>
        <Text color={theme.dim}>▌</Text>
        <Text color={theme.dim}>
          {"   "}
          [Tab] tool: <Text color={tool === "all" ? theme.dim : theme.brand}>{tool}</Text>
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {view.length === 0 ? (
          <Text color={theme.dim}>No conversations match your search.</Text>
        ) : (
          view.map((s, i) => {
            const selected = start + i === safeIndex;
            return <Row key={`${s.tool}-${s.id}`} session={s} selected={selected} />;
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>type to search · ↑/↓ move · ↵ select · Tab filter · Esc back</Text>
      </Box>
    </Box>
  );
}

function Row({ session: s, selected }: { session: SessionRef; selected: boolean }): React.ReactElement {
  const when = s.updatedAt?.slice(0, 16).replace("T", " ") ?? "";
  const msgs = s.messageCount != null ? `${s.messageCount}` : "?";
  const title = s.title ?? "(untitled)";
  return (
    <Box>
      <Text color={selected ? theme.brand : theme.dim}>{selected ? "❯ " : "  "}</Text>
      <Text color={selected ? theme.brand : undefined} bold={selected}>
        {toolBadge(s.tool)} {toolName(s.tool).padEnd(11)} {when} {msgs.padStart(4)} msgs  {title.slice(0, 48)}
      </Text>
      {s.relayed ? <Text color={theme.accent}> ⇄</Text> : null}
    </Box>
  );
}
