import React from "react";
import { Box, Text, useInput } from "ink";
import { Banner } from "./Banner.js";
import { theme } from "./theme.js";

export interface MessageLine {
  text: string;
  color?: string;
  bold?: boolean;
}

/**
 * A generic result/info screen: a titled block of lines plus a footer that
 * returns to wherever the caller came from (session detail, the UCF-file
 * screen, or home — `onDone` is whatever the caller wired up, not always
 * home). Used for success results, errors, and the summary view.
 */
export function MessageView({
  subtitle,
  lines,
  footer = "↵ or Esc to go back",
  onDone,
}: {
  subtitle: string;
  lines: MessageLine[];
  footer?: string;
  onDone: () => void;
}): React.ReactElement {
  useInput((_input, key) => {
    if (key.return || key.escape) onDone();
  });

  return (
    <Box flexDirection="column">
      <Banner subtitle={subtitle} />
      <Box flexDirection="column">
        {lines.map((l, i) => (
          <Text key={i} color={l.color} bold={l.bold}>
            {l.text}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{footer}</Text>
      </Box>
    </Box>
  );
}
