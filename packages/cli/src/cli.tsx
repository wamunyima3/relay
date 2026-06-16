#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./app.js";

// A non-TTY stdin (e.g. piped) breaks interactive input; guide the user instead.
if (!process.stdin.isTTY) {
  console.error("relay-ui needs an interactive terminal. For scripting, use `relay` (the @relay/core CLI).");
  process.exit(1);
}

const { waitUntilExit } = render(<App />);
waitUntilExit().then(() => process.exit(0));
