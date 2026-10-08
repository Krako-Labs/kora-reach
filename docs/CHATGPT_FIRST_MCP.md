# KORA Reach: ChatGPT-first MCP Mac agent

Status: v0.2 integration branch, not a production release. Existing v0.1 CLI is unchanged.

## What it is

ChatGPT web is the primary interface. The user's local or remote Mac is the execution environment.
Claude can use the same remote MCP server after its connector is separately verified.

ChatGPT -> authenticated KORA Reach Node -> local execution, cache, durable jobs,
browser/computer, verification -> response. ChatGPT remains responsible for reasoning.

Local work does not require an extra Codex run; model requests to ChatGPT itself
remain subject to all applicable plan, product and provider limits. Do not claim
unlimited ChatGPT, unlimited reasoning or an API subscription proxy.

## Reused, isolated in apps/reach-node

- MCP Streamable HTTP server with bearer and OAuth authentication
- Filesystem and process execution, scripts, upload/download, hashing and patches
- Durable jobs, retained output, recovery, stop and retry
- Browser automation in a new dedicated Chrome profile
- Native macOS keyboard, pointer, screenshot and application tools
- Browser-based Reach Console and job/artifact API
- Workspace policy, permissions, audit and redaction

New KORA tools:
- kora_local_task: run deterministic code/file tasks with frontier mode NONE
- computer_live_view: interactive MCP Apps screen viewer inside compatible hosts
- computer_live_frame: app-only polling tool, not a model inference request

Never reuse the existing production Krako Reach tunnel, profiles or credentials.
The former project's source was copied, not linked; it is a separate repository.

## Local pilot

Requirements: Node.js 22+, a Mac, terminal access; GUI login and Screen & System
Audio Recording / Accessibility permissions for screen/computer control.

Run from the root checkout on the feature branch:

    git switch feat/chatgpt-mcp-computer-control
    cd apps/reach-node
    npm ci
    npm run check

Create a random bearer token in your OWN shell (do not share it in chat):

    export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
    export MCP_HOST=127.0.0.1
    export MCP_PORT=3208
    export MCP_DEFAULT_CWD="$HOME/Projects"
    npm start

Local Console: http://127.0.0.1:3208/console
Local MCP: http://127.0.0.1:3208/mcp

The existing internal KRAKO_REACH_* configuration variable names remain in
the copied runtime during this pilot. They do not read the old runtime state.

IMPORTANT: the inherited runtime allows OS-user-wide execution without an
explicit policy. Configure a restricted workspace policy or an explicitly
approved Full Access policy before network exposure.

## ChatGPT web

Loopback IP addresses cannot be called directly from ChatGPT's cloud.
For a personal pilot, use a separately authenticated HTTPS endpoint with OAuth,
or an official Secure MCP Tunnel when the account/workspace supports it.
The existing krako-reach production domain is NOT this service.

ChatGPT Plugins -> + -> Add custom MCP server -> HTTPS URL ending in /mcp,
or Tunnel -> complete authentication -> install the plugin -> select it in chat.

Required E2E gates before calling this feature production-ready:
1. Connect the separate KORA endpoint from ChatGPT.
2. Verify tool approvals and permission boundaries.
3. Run one real coding task in the ChatGPT web conversation.
4. Verify UI frame polling and stop/start on a Mac with an active GUI display.
5. Run a durable job, disconnect the UI and resume reading the result.

## Claude

Claude custom remote connectors can use the same authenticated MCP endpoint,
but Claude web/desktop support and UI bridge behavior must be tested separately.
Claude remote connectors originate from Anthropic's cloud, not the local Mac.

## Honest status

All 157 Node-focused tests pass, including simulated repeated screen frames,
OAuth and durable restart/recovery. Browser start/list/stop worked on MSM2-1.

The actual MSM2-1 screenshot command failed with "could not create image from
display" despite a granted permission preflight. This may require an active
Mac GUI session or responsible-process TCC fix. Real screen pixels have NOT
been validated in this pilot, and neither ChatGPT nor Claude has rendered the
new screen widget in a live conversation.

The MCP SDK currently uses the stable v1.x compatibility line for the
copied runtime. A later migration to SDK v2 / MCP 2026-07-28 is a separate
compatibility task, not a claim that v2 is already implemented.

## Security

- Never run with MCP_ALLOW_NO_AUTH=true on a network-accessible interface.
- Never reuse the existing Krako Reach credential state.
- Avoid tunneling an unrestricted full-computer Node without explicit consent.
- Respect macOS TCC, SIP and administrator authentication.
- Screen/card polling is user-started and stops with the viewer. It does not
  guarantee that frame data bypasses the connected service's normal privacy
  and retention policies.
- Every chat or provider subscription still has its published usage limits.

Official docs:
- https://developers.openai.com/plugins/deploy/connect-chatgpt
- https://developers.openai.com/plugins/build/chatgpt-ui
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
