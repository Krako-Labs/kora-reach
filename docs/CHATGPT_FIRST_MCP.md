# KORA Reach: ChatGPT-first MCP Mac agent

Status: included in the **v0.2.0 source release as an experimental Mac-control preview**. The CLI remains independently usable; this is not a certified production desktop agent.

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

Start with the **v0.2.0 source tag** from an otherwise unused Mac user account, or on a Mac where KORA Reach has not yet been installed:

    git clone --branch v0.2.0 https://github.com/Krako-Labs/kora-reach.git
    cd kora-reach
    node scripts/setup-mac.mjs --dry-run
    node scripts/setup-mac.mjs

The owner-user setup installs pinned dependencies, sets a restricted workspace
policy (no shell execution by default), generates private local credentials,
and registers the local-only launchd service. It does **not** silently grant
macOS Accessibility or Screen Recording, provision a tunnel, or replace an
existing Reach installation. Review [Phase A installation](PHASE_A_INSTALL.md)
before connecting ChatGPT.

Local Console (once the service is running): http://127.0.0.1:3208/console
Local MCP: http://127.0.0.1:3208/mcp

Developers running the Node directly must separately configure authenticating
bearer/OAuth credentials, the permitted workspace and its explicit execution
policy. Do not expose a manually started unrestricted local process to the
internet. The copied runtime retains KRAKO_REACH_* environment variable names;
these do not connect it to the separate legacy Krako Reach installation.

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

At the release candidate, the Node source has macOS Node22 GitHub Actions
coverage, and isolated local tests include resumable work, OAuth and state
recovery. Independently, an authorized temporary macOS AppKit window, Save
sheet and disposable Chrome browser passed interactive GUI QC on MSM2-4. Those
fixtures do not prove that all real websites, sessions or signed applications
are supported.

A live production rollout, exact deployed Node build/identity parity, full
first-use ChatGPT connector selection behavior and the interactive screen
widget in all hosts remain **unverified**. Read the dated
[verification record](VERIFIED_CONTROL_QC.md) as historical test evidence,
not as a release certificate.

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

## Optional P1 background Accessibility engine

KORA Reach optionally integrates the separately installed MIT-licensed
opensymph/open-computer-use engine for semantic app state and limited
Accessibility-based actions. KORA does not redistribute its native runtime.
Install this dependency yourself and configure KORA_OCU_BIN with the
absolute path to its 'ocu' executable.

MCP tools:
- background_computer_status: inspect optional backend availability.
- background_app_state: read app semantic accessibility state.
- background_app_action: execute an allowlisted action, subject to execution policy.

These are optional; the built-in macOS computer tools remain available.
The semantic adapter is intended to reduce redundant screenshots and
model vision decisions, but no measured token savings are claimed.
Unattended native GUI operation and actual click/type behavior still
require an interactive macOS permission/GUI E2E test.
