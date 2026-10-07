#!/usr/bin/env node
import { runCli } from "../src/core.js";

runCli(process.argv.slice(2)).catch(function (error) {
  var message = error instanceof Error ? error.message : String(error);
  console.error("\nKORA Reach failed: " + message);
  process.exitCode = 1;
});
