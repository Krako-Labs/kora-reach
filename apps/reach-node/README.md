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

## Continue a browser or Mac window task

Ask ChatGPT to find an existing tab or window and describe an observable outcome, such as a downloaded document containing a specific heading. Reach can also verify a known SHA-256 digest. The operator can restrict files to an approved workspace.

1. `control_discover` searches one app by bundle identifier and title fragment. It distinguishes existing windows and attached tabs from Reach-managed Chrome.
2. `control_begin` records the target, named button and expected outcome under a caller-generated UUID. Supply the exact browser origin and, when needed, a unique account control.
3. `control_run` attempts a uniquely matched page control, then native Accessibility, then window-scoped text recognition. For unlabeled controls ChatGPT can inspect `control_frame` and return a point bound to that frame. Pointer-event fallback is experimental and disabled unless the operator sets `KORA_CONTROL_VISUAL_EVENTS=1`. CDP and named Accessibility actions do not require this flag. Visual clicking requires an active, unobstructed window. Set `allowFocus: true` in the saved plan to let Reach raise the exact target window before capturing a new frame. A caller-supplied point never changes focus. Its frame token binds both the pixels and window/process identity. Pointer events target that process only. OCR runs on the CPU with a bounded timeout.
4. `control_status` checks the original evidence after disconnect or restart. Reuse the same UUID. An uncertain click is reserved until its result can be established. Use a fresh step for a verified subsequent action such as confirming a Save sheet.

Native browser control uses the existing GUI session. On an unlocked Mac it can work without a debugging port. An already authorized Chromium debugging endpoint can be selected by setting `KORA_EXISTING_CHROME_PORT` locally. Reach connects to loopback only. Keep the account in its existing profile. Native capture and clicks need appropriate macOS permissions. A locked session can still serve an available CDP connection.

### Optional coding repair

The default returns decisions to ChatGPT. To enable one coding handoff per job, the Mac operator sets `KORA_CONTROL_REPAIR_WORKSPACE` to an isolated, writable checkout with a reproducible test and an authenticated official Codex CLI. Set the job budget to `onCodeDefect: repair_once` before handing a confirmed integration defect to `control_repair`. A plan with `onCodeDefect: repair_once` can request the same handoff through `control_run` after the chat confirms the code defect. Codex usage is subject to the account's plan.

With `startInBackground: true`, the Mac can begin a saved step after the chat disconnects. A missing control on a verified web page can trigger the preauthorized local repair test after native routes have been tried. A live visual decision is returned to the chat.

The local CLI runs the checkout's tests first and allows at most one Codex escalation. The repair runner retains its workspace reservation and job ID across Reach restarts. After a successful repair, Reach attempts the original UI step and checks the original evidence. A patch that requires a rebuild or deployment may still need operator action. Inspect job status before retrying a submission.

Visible UI QC is disabled by default because it opens windows and can steal focus. On a dedicated idle Mac only, set `KORA_UI_QC_HOST` to that host’s hostname and run `node scripts/qc-control-mac.mjs --allow-visible-ui`. Never run it on a live demo or user desktop. Options include `--native-only` for Chrome without CDP, `--app`, `--sheet`, and `--visual` for a disposable native fixture. Use `--headless` for a real browser download without visible windows. Use `--repair --repair-stub --restart --unattended` to test recovery without model usage. Omitting `--repair-stub` intentionally exercises the configured Codex executable and can consume plan allowance. The normal test suite does not start a paid repair.

See [the verification report](../../docs/VERIFIED_CONTROL_QC.md) for tested behavior and remaining release checks.
