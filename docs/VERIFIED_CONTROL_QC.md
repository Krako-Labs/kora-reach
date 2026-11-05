# Resumable computer control — verification report

KORA Reach can save a UI step, try existing browser and native controls, verify its result, and resume authorized work after the chat disconnects. Optional coding repair reuses the official Codex CLI only after local tests fail.

This change is a **draft release candidate**. Pointer-event fallback is disabled by default. It has not passed final live-window QC.

- [What changed](#what-changed) — the user-facing execution path.
- [Verification](#verification) — automated and actual Mac results.
- [Remaining limits](#remaining-limits) — what is not certified.
- [Reproduce safely](#reproduce-safely) — commands and test boundaries.

<br />

## What changed

Six tools provide discovery, immutable job creation, execution, status reconciliation, scoped screenshots, and optional coding repair. Existing Chrome can attach through an operator-configured loopback CDP port. Native Accessibility provides a fallback for an identified existing window. Discovery does not launch a browser or replace its profile.

A job records its exact app/window, browser origin when applicable, named control, and expected outcome. A file result must match expected text or a SHA-256 digest. An uncertain click is reserved rather than repeated after a lost response. A matching result is checked again when status is requested.

The default keeps reasoning in the user's chat. Optional `repair_once` uses an isolated operator-configured checkout. Local tests run first. The CLI permits at most one Codex escalation for that job. A durable repair process survives a Reach server restart; after successful local verification, the server attempts the original UI step and rechecks its outcome. This is not a guarantee of recovery from every browser, login, OS, or application failure.

<br />

## Verification

Recorded on 2026-11-05. Test pages, browser profiles, files, and native apps were disposable fixtures.

| Check | Result | Scope |
| --- | --- | --- |
| Typecheck, build, native helper compilation | PASS | Latest candidate on Apple Silicon macOS. |
| Reach automated suite | 187 passed | 32 test files; includes shutdown and locked-session continuation regressions. |
| Root CLI suite | 5 passed | Includes zero escalation when tests already pass. |
| Dependency audit | PASS | Full and production-only audits both report zero known vulnerabilities after the updates below. |
| Damaged compressed HTTP request | PASS | Returns HTTP 400; a subsequent valid compressed, authenticated MCP initialization returns HTTP 200. |
| Clean source installation | PASS | A fresh source archive passed `npm ci`, native-helper build, authenticated HTTP MCP startup, and a real headless-browser download. The resumed run used the same runtime/dependency/test file hashes as the canonical worktree. |
| Real browser download | PASS | Authenticated local fixture, headless Chrome, file content verification, repeated execution suppressed. |
| Background continuation | PASS | Client disconnect and server restart, saved job execution, independent outcome check. |
| Failed queue item | PASS | Malformed saved plan is isolated; a second valid job still completes. |
| Repair continuation | PASS | Stub repair, restart, local tests, automatic original UI resumption. No model usage in this repeat test. |
| Actual Codex repair | PASS in earlier candidate | Official signed-in CLI corrected a failing fixture; local tests and the original browser download were verified. It was not rerun for later native-pointer-only changes. |
| Chrome without CDP | PASS in earlier candidate | Native Accessibility downloaded the file; TextEdit opened it and its text was verified. |
| Unreachable CDP fallback | PASS in earlier candidate | Same existing Chrome window reached through Accessibility. |
| Native button and Save sheet | PASS in earlier candidate | Actual AppKit button and NSSavePanel, verified output file. |
| File evidence boundary cases | PASS | UTF-8 text across chunk boundaries, simultaneous digest/text checks, mismatches, size limit. |
| CPU-only OCR | PASS | Generated text image recognized in approximately 0.66s, including process startup; not a general latency benchmark. |
| Locked session | PASS | Native helper refused dispatch with `session_locked`. |
| Visible-test admission | PASS | No host-specific opt-in: script stops before creating test windows. |
| Visual coordinates and focus recovery | NOT CERTIFIED | Earlier isolated success did not remain reliable during window occlusion. Latest process-targeted dispatch requires a dedicated unlocked-host retest. |

<br />

## Dependency and non-GUI revalidation — 2026-11-05

The resumed candidate updates Zod from 4.4.3 to 4.6.7 and Vitest from 4.1.11 to 4.1.12.
Compatible transitive updates include body-parser 2.4.0, fast-uri 3.1.9,
@hono/node-server 2.1.6, Hono 4.13.16, ip-address 10.7.6, qs 6.17.1 and Vite 8.3.5.
No forced major upgrade or production service restart was used.

The original audit reported 10 affected packages (3 high, 7 moderate). Both the full
audit and `npm audit --omit=dev` now report 0. This is the registry's known-advisory
result, not a guarantee that the application has no security defects. Relevant
upstream advisories:
[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
[body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828), and
[Vitest](https://github.com/advisories/GHSA-qxg6-89mg-rqv8).

A fresh source archive on MSM2-2 passed `npm ci`, typecheck, native-helper build,
174 Reach tests, and 5 CLI tests. The authenticated headless Chrome download
verified the actual file and suppressed a repeated request. A second real-browser
scenario passed client disconnect, server restart, stub coding repair, independent
local tests, automatic original-task resumption and file verification. This repeat
used **zero real Codex calls**. The earlier real Codex result remains historical.

MSM2-2 was locked during this run. No visible fixture, focus change, Safari session,
or exhibition desktop was used. Live visual/focus/occlusion QC and actual ChatGPT
exposure of the new tools remain unverified. The `main` installation instructions
now select `main`, rather than the superseded integration branch.

<br />

## Chrome crash-dialog investigation — 2026-11-05

The user reported repeated macOS Chrome crash dialogs on MSM2-2 after opening
Screen Sharing. The existing personal Chrome process (PID 66585) had been running
since November 3 at 11:04 KST and remained running throughout inspection. The
screenshot matched its existing G App Launcher tab. At inspection, the dialog was
absent and only that personal Chrome browser process remained.

Unified logs place the two most recent headless fixture shutdowns at 14:11:11 and
14:11:20 KST. ReportCrash processed a sequence of notifications/open requests
at 14:16–14:18 KST. No Chrome diagnostic report was available in the inspected user
or system DiagnosticReports folders. Delayed notifications from earlier fixture
processes are a hypothesis; the exact crashed process, exception and cause are
**not established**. Do not claim the personal profile is corrupt or that this
incident is fixed.

The QC harness previously sent SIGTERM and did not inspect the exit result.
It now asks only its own Chrome child to exit with SIGINT, records PID/exit
code/signal, fails QC on early/abnormal/forced exit, and retains failed-run
evidence. Timeout cleanup remains bounded and targets only that child handle.
[Chromium's signal handler](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/chrome_browser_main_posix.cc)
distinguishes SIGINT's normal exit path from SIGTERM's session-ending path.

Six focused regression tests passed with simulated child processes. Script syntax
checks passed. The earlier 174-test result predates this QC-harness-only change.

A controlled follow-up on MSM2-2 at 14:57–14:58 KST passed both a real headless
download and the restart/unattended/stub-repair continuation. Both fixture browser
processes exited with code0, no signal and no forced termination. Personal Chrome
PID66585 remained unchanged. A subsequent check found no UserNotificationCenter
dialog or remaining test process. The Mac was locked again; delayed-dialog
behavior after unlocking and live focus/occlusion remain unverified. No real
Codex was invoked in this repeat.

<br />

## Locked-session handling — November 5, 2026

Visible QC now checks the macOS console before creating fixtures. A locked or
unavailable console stops that test with an unlock message. Headless QC does not
require an unlocked desktop.

Admitted visible QC holds task-scoped `caffeinate -d -i -w <pid>` assertions.
An outer cleanup releases them even if setup or testing throws; the process-bound
assertions also end when the QC process exits. This suppresses idle display and
system sleep only. It does not unlock the session or prevent manual/security
policy locks. Authentication and power settings are unchanged.

On MSM2-2 at 16:02 KST, the actual locked-console preflight rejected GUI QC.
A short isolated probe verified both sleep assertions and their removal on
cleanup. A real headless download still passed while locked, including file
contents, repeat suppression and clean Chrome exit (code0, no signal).
Live GUI execution after unlocking remains unverified. These sleep-prevention changes are in
the QC harness; they do not provide automatic login unlocking.

<br />

## Automatic continuation after a locked session

Previously, a background native step was removed from the queue when it encountered
a locked console. It now retains the immutable plan and checks again at most once
per minute, for up to 24 hours after the first block. The wait survives a server
restart. On expiry, the job reports `session_wait_expired` and preserves its plan
for inspection. Foreground-only jobs are not silently added to the queue.

Only a confirmed pre-dispatch `session_locked` result receives this retry.
An uncertain click remains reserved. Every resumed attempt rechecks target,
policy and outcome. Independent jobs continue. A directly observed missing DOM
control remains eligible for the separately authorized headless coding-repair
path even when native fallback cannot access the desktop.

The MCP guidance now tells the calling assistant to perform authorized routine
diagnostics, safe recovery and verification before asking the user to act.
It does not grant new permissions or bypass authentication.

Final validation on November 5:
- Typecheck, build and all 187 tests across 32 files passed on macOS.
- Seven new simulated-native regressions cover persistent wait, throttling,
  expiry, uncertain input, foreground-only scope, lock during dispatch,
  independent jobs, post-repair wait and headless DOM defect handling.
- Actual locked MSM2-2: a native job remained queued across an HTTP server
  restart while an independent real Chrome download completed and verified.
- The restart/stub-repair scenario also completed its original browser task.
  Both final fixture browsers exited with code0, no signal and no forced exit.
- No fixture processes remained; the existing personal Chrome was unchanged.

Unlock-to-dispatch is covered by simulated-native tests, not a live unlock
transition. Live GUI/focus/occlusion remains pending. This was pre-rollout validation; see the later limited live rollout below.

<br />

## Packaged candidate and limited live rollout

The Apple Silicon Node package was built from commit `9dc24a05a333`. The archive
includes compiled runtime, native helpers, the local CLI and pinned dependency
manifests; it excludes local credentials, runtime state and installed dependencies.
The new `scripts/package-node.mjs` records source identity in `BUILD.json`
and emits a SHA-256 checksum. A candidate package is not a signed/notarized Mac app.

A fresh extraction on MSM2-2 passed checksum validation and production-only
dependency installation with zero known advisories. Against that packaged runtime:
- Unauthenticated MCP requests returned 401; authenticated tool listing contained
  all six control tools.
- A restricted file boundary rejected an outside-workspace fixture.
- The local CLI ran a real passing test with no model escalation.
- Saved control evidence and repeat suppression passed.
- Actual locked-queue persistence, independent Chrome download, server restart
  and stub-repair continuation passed. Both browser fixtures exited cleanly.

MSM2-2 alone now runs this **limited preview**. Activation checked for active
managed processes, browsers, durable jobs and MCP requests before switching its
launcher. Existing authentication, OAuth state and workspace policy were retained.
An automatic rollback path was prepared. The healthy activation path passed;
rollback was not deliberately triggered on the live service.

After activation, HTTP/OAuth readiness passed. An actual ChatGPT connector command
succeeded, and an authenticated client verified the live local CLI and saved
control outcome. Experimental production pointer events remain disabled.
Other Macs were not updated. The public PR remains draft.

The six tools are present on the live MCP server. They are **not yet present in
this conversation's cached direct tool list**; do not claim refreshed ChatGPT
tool-menu exposure.

### Deferred native GUI QC

A bounded local worker on MSM2-2 is waiting for an unlocked console and at least
60 seconds without input. It then runs the isolated native Save-sheet,
visual occlusion/focus and Chrome Accessibility scenarios. It checks readiness
before each scenario, records local status and logs, and expires after 24 hours
of waiting. It does not change login security or publish results automatically.
A short locked-host probe confirmed expiry without launching a test fixture.

The worker is `apps/reach-node/scripts/qc-when-unlocked.mjs`; it requires the
same explicit host-bound visible-QC opt-in. Its waiting state is not a GUI PASS.
The experimental visual setting is confined to its disposable QC process.

<br />

## Remaining limits

- Pointer events require `KORA_CONTROL_VISUAL_EVENTS=1`. Keep this unset until dedicated live QC passes. Named CDP and Accessibility actions do not require it.
- Earlier visual QC observed an unexpected output file in a covering fixture. Its source was not established. A later run correctly blocked the click. The candidate now targets pointer events to the selected process instead of the desktop-wide event stream; that change still requires actual GUI verification.
- `allowFocus` is opt-in per plan. It can bring the exact target window forward before capturing a new frame. A caller-supplied coordinate frame never changes focus. Focus recovery is not yet certified.
- The frame token includes image pixels, window ID, and process ID. A changed frame rejects coordinates. Dynamic content may require another screenshot.
- Safari discovery and routing have not received an actual Safari end-to-end test.
- macOS Accessibility, Screen Recording, and browser Automation permissions still apply. Reach cannot unlock the user's session or satisfy a login/permission prompt automatically.
- Background recovery requires the Reach service to be running. Host reboot recovery, release signing and refreshed direct ChatGPT tool-menu exposure are not certified. Packaged Node installation and a limited live rollout are verified above.
- A code patch that needs an application rebuild or deployment may require additional work. A repair success does not itself certify the original task.
- File evidence/download handling is bounded to 32MiB. A matched text string is weaker evidence than a full digest; choose the appropriate expected outcome.
- These checks do not establish reliability on arbitrary websites or unrestricted whole-desktop workflows.

<br />

## Reproduce safely

From `apps/reach-node`:

```sh
npm ci
npm run check
node scripts/qc-control-mac.mjs --headless
# On a locked dedicated test Mac, also verify persistent waiting:
node scripts/qc-control-mac.mjs --headless --locked-wait
node scripts/qc-control-mac.mjs --repair --repair-stub --restart --unattended
```

The last command tests continuation with a stub repair executable. To test the real Codex path, omit `--repair-stub`; this can consume the signed-in account's allowance.

Visible tests must use a dedicated idle Mac. Never use an active user's desktop or an exhibition/demo computer. They require both a matching `KORA_UI_QC_HOST` environment value and `--allow-visible-ui`. Available scenarios include `--native-only`, `--cdp-down`, `--app`, `--sheet`, and `--visual`. The visual scenario explicitly enables experimental pointer events for its disposable test only.

MSM2-2 now runs the limited Node preview described above. This does not establish a successful live-window release gate or authorize rollout to other hosts.
