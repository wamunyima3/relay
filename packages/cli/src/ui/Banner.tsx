import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

/** Header shown at the top of every screen. */
export function Banner({ subtitle }: { subtitle?: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.brand} bold>
          ⇄ Relay
        </Text>
        <Text color={theme.dim}> · conversation portability</Text>
      </Box>
      {subtitle ? <Text color={theme.dim}>{subtitle}</Text> : null}
    </Box>
  );
}
