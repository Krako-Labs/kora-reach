# P0 benchmark and private MCP pilot, 2026-10-08

## Real measurement, one tiny already-passing JavaScript repository

Task intent: Fix the failing tests, but the single test already passes.

- KORA v0.1 deterministic CLI: runs npm test locally, PASS, zero extra frontier escalations.
- Standalone official Codex CLI 0.160.1 with ChatGPT authentication, JSONL:
  - input_tokens: 62,727
  - cached_input_tokens: 58,624
  - output_tokens: 182
  - reasoning_output_tokens: 0
  - turn.completed result: succeeded
- Run is **one small sample**, not evidence of generalized 99%-100% token reduction.
- Cached input tokens still count toward the reported usage, but pricing and subscription
  accounting differ from ordinary non-cached tokens.
- This is not a clean cost-matched baseline for all agent functionality. The Codex
  prompt explicitly instructed test-first and no change if passing. KORA uses a
  known deterministic test detector.
- A working failing-test demo previously used one Codex escalation; that separate
  scenario is not yet benchmarked with a matched baseline.
- Reproduction script: scripts/compare-codex.mjs. It invokes a subscribed
  Codex CLI and incurs provider usage. Never run it automatically in CI.

## Private MCP pilot

A standalone Node ran on 127.0.0.1 with an ephemeral high-numbered port,
generated bearer credential, restricted root to an isolated temp test workspace,
and HTTP auth rejects unauthenticated MCP calls with 401. It was stopped after
the smoke test. Existing Krako Reach production service was never changed.

Security: the existing process shell may have configured OAuth state, so do
not treat this local pilot as proof of a production OAuth login journey.
Full ChatGPT web connector and embedded live viewer remain unverified.

## Next external steps (need explicit user account actions)

1. In ChatGPT web Plugins, add a custom MCP server using an isolated secure
   tunnel (preferred) or HTTPS endpoint for KORA. OpenAI documents separate
   permissions for Platform tunnels and ChatGPT plugins.
2. Complete the OAuth / connector approval prompts and select KORA Reach in chat.
3. Run a real read-only task, then a restricted workspace coding task.
4. Test the screen viewer with an active GUI session. MSM2-1's prior headless
   screencapture failed despite preflight reporting Screen Recording granted.
5. Only then promote v0.2 as a user-facing release.

Sources:
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
