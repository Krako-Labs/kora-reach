# KORA Reach Node

This package is the optional ChatGPT-first computer/MCP execution node
for the independent KORA Reach project. It is a separately copied and
modified subset of the user's existing Krako Reach runtime, not an imported
production dependency.

Start with the top-level docs/CHATGPT_FIRST_MCP.md for safe installation
and authentication. Run npm ci and npm run check inside this directory.

Model calling is optional: kora_local_task never invokes Codex or frontier
inference. ChatGPT can use the other authenticated tools to inspect files,
run programs, operate a browser or Mac, and control long-running jobs.

The UI integration is experimental. The live screen viewer requires an
MCP Apps-compatible host and an accessible Mac GUI display.
