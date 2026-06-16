import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { Banner } from "./Banner.js";
import { theme } from "./theme.js";
import { useAsync } from "../hooks/useAsync.js";

/** Runs an async action with a spinner, then hands the result (or error) up. */
export function Running<T>({
  label,
  run,
  onDone,
  onError,
}: {
  label: string;
  run: () => Promise<T>;
  onDone: (value: T) => void;
  onError: (error: Error) => void;
}): React.ReactElement {
  const { loading, error, value } = useAsync<T>(run, []);

  React.useEffect(() => {
    if (loading) return;
    if (error) onError(error);
    else if (value !== null) onDone(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return (
    <Box flexDirection="column">
      <Banner subtitle="Working…" />
      <Text>
        <Text color={theme.accent}>
          <Spinner type="dots" />
        </Text>{" "}
        {label}
      </Text>
    </Box>
  );
}
