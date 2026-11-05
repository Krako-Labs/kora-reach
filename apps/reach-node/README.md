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

## Diagnose a connected app that cannot run tools

When OAuth is enabled, Reach checks the credential lookup path every 30 seconds
and logs readiness changes. To check it immediately, send a GET to
`/health/auth` on the same Reach host. This probe uses a synthetic client ID
and does not issue or rotate credentials.

| Observation | Meaning | Next step |
| --- | --- | --- |
| `/health` succeeds and `/health/auth` returns 503 | The server can handle HTTP, but the credential lookup failed or exceeded its storage deadline. | Check the most recent `oauth_storage` and `oauth_token_request` events. |
| Both endpoints return 200 but a tool fails | The local lookup completed. The connected client's end-to-end path still needs verification. | Run `hostname` and read a known permitted file through that client. |
| A token request reports a pending commit | The atomic rename was already in progress when the caller timed out. | Allow storage to settle. A lost refresh response may require a fresh authorization grant. Replaying a consumed refresh token triggers grant revocation. |

Storage events identify load, wait for a prior write, save and atomic commit.
Token request start and finish events share a server-generated request ID.
The default storage deadline is 3000ms per operation. Set
`MCP_OAUTH_STORAGE_TIMEOUT_MS` to an integer from 50 through 30000 to override it.
During a storage outage, the MCP bearer endpoint returns 503 and the OAuth SDK
returns a 5xx server error on token exchange. A timed-out write retains its
lock until the I/O settles. If a disk operation never returns, repair the
storage or arrange a controlled restart.

<br />

### Check the impact before restarting

Call the authenticated `GET /api/reach/restart-impact` endpoint while credentials
are usable. It lists live managed process IDs and session IDs, managed browser
presence, and running durable job IDs. Ordinary `exec_command` sessions end
during shutdown. When OAuth is blocked, `/health` still exposes the count in
`activeManagedProcesses`.

For a preview server or tunnel that must survive a Reach restart, start it
as a **Reach Console job** with the console enabled. The existing
`POST /api/reach/jobs` endpoint starts a detached runner and records its run ID.
After restarting Reach, check `GET /api/reach/jobs/<id>` for the same run ID
and attached or terminal status. Existing shell sessions cannot be converted
in place. This procedure covers a Reach service restart on the same computer.
