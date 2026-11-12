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

### 2026-11-12 10:24 KST — P2 immediate-parent storage alias guard (local only)

A physical Goal `state/` path could still be reached through a symlinked **immediate parent**. An isolated read status resolved into that foreign tree, and a Goal create wrote into it. New negative regressions **2/2 RED** before fix. The P2 store now checks the configured state root's immediate parent with `lstat` before reads and **before any fresh-state mkdir**. Focused regression **5/5 PASS**, including a no-foreign-directory-create case. This is not an atomic check or a proof about deeper ancestors.

- Source root **58/58 PASS**; Reach Node TypeScript/build and **292/292 PASS in 51 files**. Independent Git-free offline clean-install fixture: root **58/58**, Node **292/292**, TypeScript/build PASS; npm ci offline succeeded. `git diff --check` PASS. All prior uncommitted work and local-only `ee6748c` preserved.
- GitHub connector found **zero** PR-triggered CI runs at remote SHA `5cfc98a`. Exact deployed runtime parity, real OAuth tool call, safe service transition, external Node22 CI and native idle/unlocked GUI remain blocked. gStack mapped final release verdict was **not rerun**; do not claim green.
- [Dated evidence and limits](checkpoints/2026-11-12_1025_P2_GOAL_IMMEDIATE_PARENT_ALIAS_QC.md).

<br />

### 2026-11-12 03:01 KST — P0 LaunchAgents parent replacement fails closed (local only)

The read-only installed-service diagnostic already guarded against plist replacement during allowlisted scalar reads. It did **not** detect a swapped LaunchAgents *parent* directory when the plist inode stayed the same. A corrected test renamed the parent and introduced a symlink pointing at its original inode, causing the previous code to report a misleading stable config. **Expected RED: 1 failed / 11 passed** before fix. The probe now checks the parent directory's identity and metadata after all scalar reads and sets every service config to `unsafe` with unknown flags if it changed. It still reports `atomicSnapshot=false` and **never authorizes a live upgrade**.

- Focused **12/12 PASS**; source Root **58/58 PASS**, Reach Node **281/281 PASS in 47 files**, typecheck/build PASS. Independent Git-free offline clean install and full QC **58/58 + 281/281 PASS**, with no accidental linked-worktree Git.
- Real MSM2-1 read-only probe: two loaded Node LaunchAgents with `KeepAlive` and `RunAtLoad` enabled; source/build and durable state identities remain **not_verified**. Deployed `/health=200`, `/health/auth=404` on older runtime, not evidence of broken OAuth storage. GitHub connector: **0** pull-request-triggered workflow runs for remote PR #3 head `5cfc98a`.
- No production/service/OAuth/policy/user Chrome/native GUI activity, no Git commit/push, no model call or user interruption. Current source Node26 local; hosted Node22, deployed parity, safe mixed-version transition and real GUI remain **BLOCKED**. gStack independent mapped verdict not green.
- [Full timestamped evidence](checkpoints/2026-11-12_0301_P0_LAUNCHAGENT_PARENT_DRIFT_QC.md).

<br />

### 2026-11-12 01:02 KST — P0 read-only installed Node executable evidence (local only)

`reach_preflight`'s optional LaunchAgent diagnostic now classifies the **executable type** of a loaded Node job using PID + read-only `ps -o comm`. It returns only `node`, `other`, `unknown` or `not_probed` and never exposes raw executable paths, argument lists, credentials or environment. Build SHA and state identity stay `not_verified`. Actual MSM2-1 reports both Node jobs loaded and both executable names `node`, with auto-restart enabled; it is **not proof** that they share state or run the candidate build.

- **Focused 10/10 PASS** after 3 expected red regressions; source **Root 58/58, Reach Node 279/279 in 47 files PASS**, typecheck/build PASS.
- Independent, Git-free, offline-install fixture: **58/58 + 279/279 PASS**, typecheck/build PASS. No Git commit, push, live process action or user GUI.
- Deployed `/health` 200, `/health/auth` 404 (old route); Draft PR #3 has 0 PR-head workflow runs. Node26 local only, not hosted Node22. Real service/source identity, managed restart, OAuth/tool outcome and native GUI remain **BLOCKED**; independent gStack release verdict unverified.
- [Full read-only identity and QC evidence](checkpoints/2026-11-12_0102_P0_LAUNCHD_EXECUTABLE_READONLY_QC.md).

<br />

## 2026-11-11 23:20 KST — P0 typed LaunchAgent restart preflight (local only)

The existing authenticated `reach_preflight` MCP tool now supports an optional **read-only** installed-service scan. Its four exact LaunchAgent labels expose only known restart flags and loaded PID; credentials, process arguments, policy, OAuth, browser state and production services are not changed. Direct Mac QC reports **both installed Node agents loaded with KeepAlive and RunAtLoad enabled**. Upgrade readiness stays `false` even if a snapshot appears idle. This does not prove both Node services use the same durable state or that a double Writer occurred.

- **Focused:** 19/19 PASS. **Source:** Root **58/58**, Reach Node **277/277 in 47 files** PASS, typecheck/build PASS.
- **Independent Git-free, offline `npm ci` fixture:** Root **58/58** and Reach Node **277/277** PASS, typecheck/build PASS. No canonical install or Git write.
- Deployed `/health` 200, `/health/auth` 404 (old route). PR-head workflow runs **0**. Node26 local only, not hosted Node22. No actual GUI or managed production switch validation; release **BLOCKED**, gStack independent verdict **not green**.
- Full file scope, installed-service evidence and limitations: [23:20 checkpoint](checkpoints/2026-11-11_2320_P0_LAUNCHD_TYPED_PREFLIGHT_QC.md).

<br />


### 2026-11-11 19:06 KST — P1 fixture blocks identical-byte inode replacement (local-only)

An external actor could replace the fixture launcher or settings file with a new inode carrying **identical SHA-256 and mode**. Both ordinary rollback and `SIGKILL` journal recovery previously overwrote that object. Four new regressions were RED before their fixes, then all PASS. The helper now tracks original and switched object identities and requires a matching persisted post-switch identity marker for crash recovery. A missing marker blocks recovery instead of guessing.

- Fixture 34/34; source Root **58/58 PASS**, Node **265/265 PASS (46 files)** plus typecheck/build. Independent Git-free offline-install QC **58/58 + 265/265 PASS**. No live services touched.
- Remote PR #3 remains Draft `5cfc98a`, 0 public branch CI runs. Local `ee6748c` and all pre-existing changes are preserved; no commit, push or deployment. Runtime `/health` 200, `/health/auth` 404 (old runtime unsupported). Hosted Node22 CI, actual deployed parity, physical GUI, crash/power-loss recovery, State Writer PID, and production activation are still release-blocked. gStack independent mapped gate is not proven.
- Full evidence: [`2026-11-11_1906_P1_SAME_BYTES_INODE_ROLLBACK_QC.md`](checkpoints/2026-11-11_1906_P1_SAME_BYTES_INODE_ROLLBACK_QC.md).

### 2026-11-11 17:25 KST — P1 fixture rollback refuses permission-only drift (local-only)

The disposable Node update switch and post-`SIGKILL` journal recovery previously checked content hashes but not permission changes. A concurrent `chmod` could be silently reset. Both paths now reject changed file modes for `settings.json` and `start.sh`, preserve the journal, and leave the changed file untouched. **Four focused regressions** passed; the initial two failed before the fix. No live service was switched.

- Full source **Root 54/54 PASS**; Node **265/265 PASS, 46 files** with typecheck/build. Separate Git-free offline install: **54/54 + 265/265 PASS**.
- gStack review/verify/QA instructions started, but independent mapped verdict and real native GUI remain UNVERIFIED. Node26 local only; hosted Node22 PR CI 0.
- Remote Draft PR #3 `5cfc98a`, local-only `ee6748c`, deployed `/health` 200 and `/health/auth` 404. No source/deploy parity, production restart, auth/policy/browser change, commit/push or user interruption.

[Detailed permission drift checkpoint](checkpoints/2026-11-11_1725_P1_FIXTURE_PERMISSION_DRIFT_ROLLBACK_QC.md).

<br />

### 2026-11-11 14:40 KST — P2 opt-in, restart-safe deterministic receipt (local-only)

A user can now explicitly approve `autoRecordVerification: true` while binding an existing authorized job to a Goal. The current Node or a Node restarted after chat disconnect observes only the **original** runner and approved file SHA-256 and automatically records one historical write-once verification receipt. An omitted/false opt-in keeps manual recording. A retry cannot widen the original allowed actions. No new process, model call, browser effect, retry or policy change is initiated.

- **Direct proof:** authenticated MCP creation, real HTTP server close/reopen, receipt created without any subsequent tool call, single runner launch, unchanged receipt across later ticks, tampered file blocked. Unauthenticated and string-valued opt-in rejected. At that checkpoint the observer had an incorrect 256-entry cutoff; the later 16:53 fix removed that cutoff. The current observer evaluates at most 8 Goals per tick, but still enumerates all directory metadata each interval. Admission remains in-process.
- **QC:** final Root **50/50**; Node **263/263** (44 files), typecheck/build PASS; physically separate `.git`-free offline install then **50/50 + 263/263** PASS. Default-parallel full suite **263/263 ×2**, but historical State Writer conflict remains unproven fixed.
- **Release remains BLOCKED:** candidate not deployed or pushed; remote PR #3 `5cfc98a`, local unpublished `ee6748c`; hosted Node22 CI 0; `/health=200`, `/health/auth=404` older runtime; actual live maintenance, native GUI, gStack mapped release verdict and host tool-selection not verified. No operating-service/auth/policy/user-Chrome change or user interruption.

[Full 14:40 checkpoint](checkpoints/2026-11-11_1440_P2_OPT_IN_AUTONOMOUS_RECEIPT_QC.md).

<br />

### 2026-11-11 13:35 KST — P2 write-once verification receipt (local-only)

An authenticated, explicit `reach_goal_record_verification` operation records the first successful observation of an existing authorized Goal as a private, durable, app-level write-once receipt. The receipt binds the approved Mac, original job/run, immutable criteria and observed result. `reach_goal_status` stays read-only and rechecks current file bytes even if an earlier receipt says `matched`. A changed or missing file remains blocked or waiting and is never replayed.

- Eight simultaneous verification requests: exactly **one** first write; later requests return the same receipt. New Node process, authenticated MCP, HTTP and existing Goal identity all verified. Tampered and symlinked receipt records fail closed. No credentials appear in the receipt.
- Source **Root 50/50** and **Reach Node 262/262** PASS, typecheck/build PASS. Independent Git-free offline clean copy **50/50 + 262/262** PASS. Default-parallel suite **262/262 ×2**, but historical writer collision is **not** declared fixed.
- Real disposable headless Chrome content, replay suppression and clean process exit PASS. Operating `/health=200`, `/health/auth=404` (old runtime route). Node22 hosted CI, deployed parity and live native GUI remain UNVERIFIED. No service/Git/auth/policy changes.
- This is a **historical observation**, not cryptographically protected or immutable against host-owner edits, not a power-loss-tested durability guarantee, and not a general natural-language acceptance engine. Scoped gStack principles were applied, but no independent mapped gStack release verdict exists.

[Full 13:35 checkpoint](checkpoints/2026-11-11_1335_P2_WRITE_ONCE_VERIFICATION_RECEIPT_QC.md).

<br />

### 2026-11-11 13:08 KST — P2 file acceptance independently verified (local-only)

An approved, already-running detached job can now bind an optional immutable `acceptance.fileName` (one direct workspace file) and expected `acceptance.sha256`. `reach_goal_status` checks current file bytes after terminal runner success. Only an exact digest returns file-verified. Missing, tampered or symlinked evidence never triggers job replay. A duplicate Goal request with changed acceptance fails HTTP400 instead of changing criteria.

- Source Root **50/50 PASS**; Node typecheck/build + **262/262 PASS**. Independent Git-free offline installation and the entire clean full suite repeated **50/50 + 262/262 PASS**.
- Real isolated headless Chrome download, content check, replay suppression, and clean child exit: **PASS**. No user profile or visible desktop interaction.
- Live `/health=200`, `/health/auth=404` (older route unsupported). Remote `5cfc98a` remains without PR-run Node22 CI or combined statuses. Local `ee6748c` and all changes retained; no deploy or push.
- This is not an independent natural-language Goal verifier, historic immutable proof, multi-step agent, or production GUI/update release. State Writer parallel collision, deployed parity, hosted Node22 and native GUI remain blocked. gStack mapped gate not green.

[Detailed P2 evidence and remaining gates](checkpoints/2026-11-11_1308_P2_INDEPENDENT_FILE_ACCEPTANCE_QC.md).

<br />

### 2026-11-11 07:31 KST — durable repair markers block fixture maintenance

After a restart, an orphaned `repair.json`, `session-wait.json`, or `codex-used` marker now causes the test-only maintenance scanner to return `pending_reconciliation`, even if the repair queue entry is missing. This prevents a false idle result. Files are checked with `lstat`; plan, marker and credential contents are not read.

- Focused **19/19 PASS**. Full root **40/40 PASS** and Reach Node **260/260 PASS**, including typecheck and build.
- Independent, Git-free offline install reran **40/40 + 260/260 PASS** on the exact dirty source copy.
- No deployed version parity or GUI claim. Node v26.7.0 only; GitHub Node22 PR CI absent, gStack overall `UNMAPPED`.
- No Git publication or runtime changes. Details: [07:31 checkpoint](checkpoints/2026-11-11_0731_P1_ORPHAN_RECONCILIATION_GUARD_QC.md).

<br />

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

<br />

## Local hardening after gStack review — November 10, 2026

The independent, read-only gStack-style review identified two release-blocking
failure modes: an insufficiently durable replay-prevention claim and unsafe
native fallback for a guarded download. The **uncommitted local candidate**
now synchronizes its effect marker and parent directory before dispatch and
forbids unguarded native/AppleScript/Accessibility fallback for `captureDownload`.
Regression tests cover five CDP pre-dispatch errors and native-route exclusion.

The same candidate includes a read-only Access Doctor with authenticated
tool discovery, explicit loopback-only credential routing, and separate
`/health/auth` outcomes. A missing readiness endpoint (404) is classified
as an unsupported deployed diagnostic, not as a proven OAuth outage. New
installations default to restricted file roots without shell execution.

**Local checks:** CLI 5/5, Reach Node 216/216 in 37 test files on Node26 and locally provisioned Node22.23.4, build/Swift
helpers/typecheck PASS. Real isolated Chrome download and locked-queue restart
checks PASS; both fixture Chrome exits were clean. Production dependency
audit reported 0 known vulnerabilities. A fresh source snapshot installed
96 production packages offline and passed an authenticated MCP runtime
smoke test with a restricted workspace. The proposed macOS/Node22 CI
workflow is not committed or executed remotely.

**Still not a release PASS:** MSM2-2 remained locked, so final native
focus/occlusion/save-sheet QC was not run. The running MCP services were
not upgraded or restarted, and the remote PR head remains unchanged.
Hardware power-loss durability, hosted CI and real deployment parity
remain pending. See
[the dated checkpoint](checkpoints/2026-11-10-autonomous-reach-hardening.md)
for exact evidence, source identity and remaining gates.


A real headless `--repair --repair-stub --restart --unattended` run found a
regression that the initial unit suite missed: guarded downloads no longer
identified a definitively missing web control as eligible for authorized
coding repair. The route now preserves `web_control_missing` without
falling back to native input. The repeated full Node26 and Node22 suites
passed 216/216, and the real isolated stub-repair, restart, local test,
automatic original-task resume, file verification and clean Chrome shutdown
subsequently **passed**. A 45-second stub-specific deadline prevents this
QA path from silently polling for five minutes if the repair never starts.
Three isolated disk-sync `EIO` injection cases also passed: uncertain
action claims and queue links remain reserved on failure. This is not a
physical power-loss test.

## Read-only Reach-first capability entry point — November 10, 2026

The local (not deployed) PR #3 candidate adds `reach_preflight` as a narrow MCP
entry point. It reports **effective** workspace/shell policy and current
managed/attached Chrome connection without starting a browser or changing
permissions. macOS grant checks are optional and do not certify an unlocked
GUI. The response intentionally omits workspace roots, bearer tokens, Chrome
profile paths, tab URLs and CDP ports. It reports deployed/source parity as
**not verified** until a separate build-identity check can prove it.

Real authenticated MCP tests cover restricted shell disabled, full access,
optional permission inspection and no browser launch. No claim is made that
ChatGPT automatically chooses this tool in a new conversation. That host-side
tool-selection gate remains open, independent of server test success.

## Writer-port collision recovery — November 10, 2026

Two full-suite runs independently exposed `Reach state writer reservation is
occupied` in **different** fixture suites even though they used separate
state directories. The original single deterministic TCP port was the likely
cause: a 20,000-port namespace is not collision-free when many test workers
open independent Reach managers. It fails closed, but falsely blocks an
otherwise healthy node.

The local candidate now identifies a conflicting new Reach writer by an exact
canonical-directory fingerprint. It tries another deterministic candidate
**only if the first port is positively identified as belonging to a different
state directory**. The same canonical directory, old/unknown listener,
connection failure and timeout all remain fail-closed. It never unlinks
reservation files or takes over a stored PID. Regression tests construct a
real first-port hash collision and a simulated legacy unidentified listener.

Validation after this change: full Node suite **221/221 PASS** across 38
files, three further consecutive Node test runs **221/221 PASS** each; root
CLI **5/5 PASS**. Real isolated headless Chrome download and stub coding
repair/restart/original-task continuation passed with clean browser exits
(code 0, no forced signal). A fresh isolated source install passed full QC,
production-only dependency installation and authenticated/unauthenticated
loopback MCP smoke tests. These local passes do **not** substitute for hosted
CI, a final live GUI test, an actual power-loss test or deployment parity.

<br />

## Typed Reach preflight, policy and auth-negative QC — November 10, 2026

The local PR #3 candidate now returns capability-specific `state` and
`reason` fields for file roots, shell execution, managed Chrome, attached
Chrome, GUI capture and GUI input. It does **not** turn an admitted MCP
request, a connected browser, a macOS TCC grant, or a healthy listener into a
claim of full execution authority. A target file, browser account and
unlocked desktop still require independent checks.

The implementation also distinguishes an unverified upstream/no-auth mode and
preserves `unknown` after adapter exceptions. Actual HTTP authorization
negative testing confirms an unauthenticated `reach_preflight` call receives
**401 before any capability probe**. A stored Node ID was reopened without
changing identity. No credentials, profile paths or raw probe errors are
included in these diagnostics.

**Verified locally:** CLI **6/6 PASS**, Reach Node **232/232 PASS** in 39 test
files, including TypeScript and Swift helper builds. A fresh offline install in
an isolated copy independently passed the same **6/6 + 232/232** checks.
A disposable real Chrome download and stub-based repair/restart/work-resume
path both passed with clean browser exits. No real model repair call was made.

The installed gStack verification runner reported **UNMAPPED**, not green,
because 24 branch-touched files lack explicit pregate mappings. Full
repository tests were run independently. Real MSM2-1 `/health` is 200 and
`/health/auth` is still 404 on the preexisting deployment. The external
GitHub PR #3 head is still `5cfc98a` with no hosted CI runs. Native visible
GUI, live runtime parity, fresh-chat tool selection and physical power-loss QC
are **not verified**. The local-only `ee6748c` commit was preserved and not
pushed.

For exact source and log evidence, see
[the timestamped P1 checkpoint](checkpoints/2026-11-10_2125_P1_TYPED_PREFLIGHT_SECURITY_QC.md).

## 2026-11-10 23:02 KST — P1 staged-update reliability slice

- Added `scripts/prepare-node-upgrade.mjs` (read-only plan, isolated production-dependency staging, recorded source identity, versioned immutable release, idempotent digest check, rollback by deleting only an owned pending directory). This does **not** activate, restart or modify existing Reach state.
- Added `test/prepare-node-upgrade.test.js` with nine targeted negative/positive cases covering policy/auth/OAuth/node/browser preservation, symlink redirects to live state, forged build identity, candidate symlinks, tampered releases/dependencies, failed npm rollback and repeat staging.
- Verified clean source `ee6748c` in a true disposable Git clone, offline npm ci/build, actual `package-node.mjs`, SHA-256, then staged compiled production-only Node from that archive in isolated state and checked `npm ls --omit=dev`, `node --check`, idempotent repeat and unchanged simulated state. All PASS; `/tmp/kora-reach-2300-stage-archive.log`. This does **not** package the current uncommitted P1 source.
- Latest complete checks: root 15/15 PASS, Reach Node 232/232 PASS (39 files), with typecheck/build; `/tmp/kora-reach-2310-root.log`, `/tmp/kora-reach-2310-node.log`. gStack mapped subset 117 PASS, but the gate remains **UNMAPPED** for two upstream/untracked files (`.github/workflows/reach-reliability.yml` and the existing package SHA sidecar); do not claim gStack green.
- The previous historical archive at `9dc24a` is intentionally rejected by new staging validation because its `BUILD.json` lacked `nodePackageVersion`. No older release was altered.
- No Git commit/push, live launcher, existing node state, browser session, TCC, runtime access mode, production service or user identity action. Stage-only release safety is not equivalent to full update/rollback or release readiness.


## 2026-11-10 23:15 KST — P1 staging input boundary hardening

- Hardened `scripts/prepare-node-upgrade.mjs` against forged release-version path traversal, symlinked compiled-source ancestors and installed-node alias overlap. Added three fail-closed tests in `test/prepare-node-upgrade.test.js`. Existing user state and uncommitted source preserved.
- Current root check **18/18 PASS**; Reach Node check **232/232 PASS**, 39 files. Source verification logs `/tmp/kora-reach-20261110_231203-{root,node}.log`.
- Real isolated clean clone of **local-only** `ee6748c`: offline install, compiled archive, independently checked SHA256, patched script stage + repeat `already_staged`, unchanged fixture state **PASS**. See `/tmp/kora-reach-20261110_2318-clean-archive.log`. This does not certify newer uncommitted P1 source.
- Live deployment `/health` 200, `/health/auth` 404 (unsupported older runtime); PR #3 Draft/remote HEAD `5cfc98a`, not source-identical. Hosted Node22, exact CI, activation/rollback, real GUI, runtime parity, fresh-chat selection **NOT VERIFIED**. Previous gStack `UNMAPPED` unchanged.
- No production access change, restart, service activation, Git commit/push or live GUI. User interventions: **0**. Full checkpoint: `docs/checkpoints/2026-11-10_2315_P1_STAGE_INPUT_BOUNDARY_QC.md`.

<br />

## 2026-11-11 00:55 KST — P1 isolated launcher-switch / rollback exercise

- Added `scripts/simulate-node-upgrade-switch.mjs`, an **isolated test-fixture-only** transaction exercise. It checks physical temporary roots, a deliberate fixture marker, an unactivated staged build, actual stage file fingerprints and a single known Node-directory line in the launcher. It records owner-only backup files and temporarily changes the simulated `settings.json` and `start.sh` using individual atomic file replacements. It restores the original bytes and launcher mode. It never calls launchd, OAuth, TCC, a model or the real service.
- Extended `test/prepare-node-upgrade.test.js` with eight original switch-related cases: ordinary restoration, failures after each of two writes, absent marker, escaped stage path, altered staged executable, duplicate journal and non-clobbering concurrent-edit detection. Added three more tests: `SIGKILL` after settings-only and after full launcher switch, followed by **second-process journal recovery**, plus corrupt-backup rejection. The stage suite is now **23/23 PASS**. One intentionally divergent fixture is not overwritten; it retains the journal. No real service or power-loss recovery has been demonstrated.
- Full source root **29/29 PASS**, Node **232/232 PASS** in 39 files, including typecheck/build. Evidence: `/tmp/kora-reach-20261111_0103-final-root.log`, `/tmp/kora-reach-20261111_0103-final-node.log` and the latest standalone stage-suite output. Full gStack gate remains **UNMAPPED**; installed `review/` files are partial and `qa/verify` skill entrypoints were unavailable, so this check uses direct full suites and code review instead of claiming gStack PASS.
- Local deployed health remains **200** (`/health`) and **404** (`/health/auth`), evidence of older deployed route support, not proof of OAuth storage loss. GitHub PR #3 remains open Draft at `5cfc98a`, whereas local HEAD `ee6748c` and newer uncommitted work remain unpushed. No source-identical Node22 CI, deployed parity, native GUI, physical power-loss or live activation is certified.
- **Release remains BLOCKED.** No production access mode, OAuth/policy, installed launcher, running browser, service, Git commit/push/tag, or user identity changed. User interventions: **0**. Checkpoint: `docs/checkpoints/2026-11-11_0055_P1_FIXTURE_SWITCH_ROLLBACK_QC.md`.


## 2026-11-11 01:52 KST — P1 restart-impact and runtime build identity

The authenticated `/api/reach/restart-impact` snapshot now reports ongoing MCP requests, all running durable jobs even when `runId` is absent, and explicit browser/job inspection availability. Browser probe failure is `null` (unknown), not `false` (idle). It always returns `atomicSnapshot:false` and `idleConfirmed:false`: no consumer may treat a momentary empty list as safe permission to restart a live service. Public read-only `/health` now exposes the guarded `runtimeBuild` identity, with `verified:false` for unsigned metadata and `unavailable` for source runs. This does not prove source parity or OAuth readiness.

**QC:** focused real OAuth/restart tests 9/9 PASS; full Root 29/29 PASS; full Reach Node 233/233 PASS across 39 files, including typecheck and build. A physically independent clean copy excluding `.git` file/directory and all dependencies passed offline `npm ci` and full 233/233 Node + 29/29 Root checks. Evidence logs: `/tmp/kora-reach-20261111_0200-focused.log`, `/tmp/kora-reach-20261111_0153-{root,node}.log`, `/tmp/kora-reach-20261111_0157-isolated-{install,node,root}.log`. Read-only deployed `/health=200`, `/health/auth=404` (older runtime); PR #3 Draft at remote `5cfc98a`, local unpushed `ee6748c`. No service restart, production setting edit, Chrome/GUI activity, commit, push or user intervention. **Release BLOCKED:** exact Node22 CI, deployed auth/build parity, guaranteed idle lock/rollback, physical GUI, host tool-selection metrics, and previously UNMAPPED gStack gate. Full checkpoint: `docs/checkpoints/2026-11-11_0151_P1_RESTART_IMPACT_RUNTIME_IDENTITY_QC.md`.


## 01:54 KST final regression addendum

Added an explicit negative regression in `apps/reach-node/test/oauth-recovery.integration.test.ts`: a running durable job **without** a `runId` remains visible as `{id,runId:null}`; stopped jobs are excluded; commands are not exposed. This verifies the original fail-open omission, not only the endpoint shape.

All checks were repeated **after this final test edit**:

- Focused OAuth/restart suite: **10/10 PASS** (`/tmp/kora-reach-20261111_0155-focused-unclaimed.log`).
- Active checkout Root check: **29/29 PASS** (`/tmp/kora-reach-20261111_0155-final-root.log`).
- Active checkout Reach Node typecheck, build, tests: **234/234 PASS**, 39 files (`/tmp/kora-reach-20261111_0155-final-node.log`).
- Physically separate .git-free disposable copy: offline `npm ci` and entire Reach Node **234/234 PASS**, Root **29/29 PASS** (`/tmp/kora-reach-20261111_0155-final-clean-node.log`, `/tmp/kora-reach-20261111_0155-final-clean-root.log`). Fixture cleaned after verification.
- `git diff --check`: PASS. No production restart, no history mutation, no credential reads for live verification.

The earlier 233-test count reflects the **intermediate source snapshot** and is superseded by these final 234/234 results. Release is still BLOCKED for the previously listed real-service gates.


## 2026-11-11 02:50 KST — P1 bounded diagnostics (local-only)

Read-only `reach_preflight` and authenticated `/api/reach/restart-impact` now time-bound stuck browser/macOS status probes to 1,200ms, conservatively reporting unknown rather than hanging or claiming idle. Restart-impact also discloses `backgroundReconciliationActive`. No service-idle lock, restart authorization, or production switch was added.

- New `read-only-probe.ts` + 4 direct cases, 2 new HTTP/MCP integration cases. Focused 22/22 PASS.
- Active root **29/29**, Reach Node **240/240** (40 files), typecheck/build PASS. Independent Git-free offline `npm ci` copy: root **29/29**, Reach Node **240/240** PASS. Host Node 26.7.0.
- Authenticated diagnostics never serialize adapter errors, secrets or paths. Runtime `/health` 200; `/health/auth` 404 (older unsupported runtime). No installed parity.
- PR #3 still Draft at `5cfc98a`; local historical unexpected `ee6748c` preserved, one ahead and unpushed. Exact GitHub Node22 CI, real GUI, service-idle/activation, full gStack gate remain blocked.
- Evidence: `docs/checkpoints/2026-11-11_0250_P1_BOUNDED_PROBE_QC.md`; `/tmp/kora-reach-20261111_0250-{root,node,install,clean-root,clean-node}.log`. No operating-service change or user interruption.

## 2026-11-11 03:04 KST — P0 unauthenticated health identity redaction

A read-only independent gStack audit warned that exposing the persistent Mac ID on public `/health` permits correlation across calls. Candidate `/health` now omits `nodeId` and user-selected `nodeName`; authenticated MCP `reach_preflight` and Console still return stable identity as authorized. Access Doctor's public mode/execution contract remains unchanged. The new negative integration regression verifies authorized identity plus no public identity leak. **Focused MCP/health 15/15, full Node typecheck/build/tests 241/241, Root CLI 29/29 PASS**. A physically separate `.git`-free offline-install copy also passed **Node 241/241 + Root 29/29**. Secret-pattern scan on newly added lines found 0 candidates; no complete security audit claim. Logs and scope: `docs/checkpoints/2026-11-11_0304_P0_PUBLIC_NODE_IDENTITY_QC.md`.

Actual installed MSM2-1 service remains unchanged: read-only `/health=200`, `/health/auth=404` (older unsupported route, not proven OAuth storage failure). PR #3 remains Draft at remote `5cfc98a`; local unexpected `ee6748c` and all dirty files preserved. CI Node22, exact runtime parity, real GUI, exclusive maintenance gate, power-loss proof and first-tool-selection metrics remain **BLOCKED / unverified**. Public health field removals should be assessed against any external health consumers before release. No deploy/commit/push/restart/user intervention.


## 2026-11-11 04:22 KST — fixture-exclusive maintenance admission QC

The isolated upgrade-switch simulator now requires a synchronous new-work admission fence before any fixture file change. A real `/api/reach/restart-impact` response (`atomicSnapshot:false`, `idleConfirmed:false`) is rejected and cannot claim permission to switch. Work already admitted, concurrent leases, missing/unknown browser and job observations, delayed inspection, and a late positive result all fail closed. Deadline recovery and restored admission were tested.

**Source QC:** targeted 34/34, Root CLI 40/40, Reach Node 241/241, physical independent `.git`-free offline installation then Root 40/40 and Node 241/241, all PASS. The killed child at each of two fixture switch phases still recovered the original bytes. Evidence: [dated checkpoint](checkpoints/2026-11-11_0422_P1_FIXTURE_MAINTENANCE_ADMISSION_GATE_QC.md).

**No live lease, production activation, GUI certification or exact external CI is claimed.** The live Node service does not yet share the fixture gate. Draft PR #3, missing Node22 CI, deployment parity, protected GUI and gStack unmapped status remain release blockers. User interactions 0.


## 2026-11-11 05:34 KST — trusted fixture idle recheck and in-flight MCP QC

The candidate's test-only maintenance fence now requires both caller evidence and the live disposable Node's trusted job/process/browser observation. Authenticated in-flight reach_preflight, a detached running Console job after HTTP completion, and an unknown browser observation all block fixture maintenance. These guards are not an OS-wide or launchd upgrade lock.

Source full Root 40/40, Reach Node 249/249 (41 files) and admission 8/8 PASS. Physically isolated .git-free source with offline Node npm ci passed Root 40/40 and Node 249/249 again. Node v26.7.0; exact external Node22 CI absent. Remote PR #3 remains Draft at 5cfc98a, workflow runs/statuses 0/0. Deployed /health 200 and /health/auth 404 (older unsupported route, not proof of OAuth storage failure). Existing ee6748c and dirty files preserved. No live service, policies, Chrome, Mac GUI, Git history or other repositories changed; user interruptions 0.

See docs/checkpoints/2026-11-11_0534_P1_TRUSTED_FIXTURE_IDLE_RECHECK_QC.md. gStack mapped verdict UNMAPPED, exact deployed parity, GUI, safe live switching and user-level Reach tool choice remain BLOCKED.

## 2026-11-11 06:24 KST — persisted effect claim idle guard (Task 86)

An isolated Node maintenance gate now checks persisted control effect claims and pending repair queue entries before treating a restarted Node as idle. The authenticated restart-impact diagnostic reports only a typed status. Missing/unreadable/symlinked state fails closed; no durable claim is cleared or replayed. Real HTTP close/restart with the same state confirms maintenance refusal. Files: `src/reach-maintenance-evidence.ts`, `src/http-server.ts`, `test/reach-maintenance-evidence.test.ts`, `test/reach-request-admission.integration.test.ts`. Full root **40/40**, Node **256/256** (42 files); clean Git-free offline install repeat **40/40 + 256/256**. See `docs/checkpoints/2026-11-11_0624_P1_DURABLE_EFFECT_IDLE_GUARD_QC.md` and `/tmp/kora-reach-20261111_0627-*` evidence. This is fixture-only, not an operational lease or deployed parity. Node22 CI, gStack mapping, GUI and service-switch gates still blocked. No Git history, production configuration, auth or service changed.

## 2026-11-11 08:22 KST — P1 cooperating cross-process fixture admission

After reading canonical host rules and preserving local ee6748c plus all dirty work, added an isolated process-shared maintenance gate using atomic temporary-directory admission serialization. Independent Node child tests prove active work rejection, two competing maintenance candidates cannot both win, and SIGKILL leaves orphan markers that block later switches. Late observation cannot trigger a switch. Reused existing strict-idle fixture predicate. No production process fence or deployment activation is claimed.

Focused 18/18 PASS. Five repetitions of 8 cross-process cases: 40/40 PASS. Source root 50/50 and Reach Node 260/260 (42 files), typecheck/build PASS. Separate physical .git-free offline install then full root 50/50 and Node 260/260 PASS. Node 26.7.0, not Node22. Live read-only HTTP 200/404; /health/auth remains an old-runtime unsupported route, not proof of OAuth store failure. GitHub PR #3 still open/Draft at remote 5cfc98a, 0 PR workflow runs. A read-only gStack reviewer timed out before a verdict; overall gate remains UNMAPPED. No live GUI, auth/policy, Chrome, process or Git publication changes, no user interruption. Release remains BLOCKED.

Evidence: docs/checkpoints/2026-11-11_0822_P1_CROSS_PROCESS_FIXTURE_BARRIER_QC.md and /tmp/kora-reach-20261111_0810-* logs.

08:25 addendum: a second bounded read-only gStack review read sources but timed out before issuing findings; gStack is still NOT PASS. Four scoped fixture files passed basic secret-marker and whitespace checks. No extra production access or changes.

## 2026-11-11 09:28 KST — P0 writer reservation collision investigation and CI isolation

Confirmed a genuine intermittent `Reach state writer reservation is occupied` failure under Vitest parallel execution: 1 failure in 5 final parallel full-suite runs (4 PASS, 1 FAIL), with an earlier parallel failure during this run. No proof of the exact live socket owner; **do not label resolved or zero-flake**. Conservatively added same-port-only bounded exclusive-bind retries after an unidentified owner; active unidentified or same-state writers still fail closed. Added a real delayed transient-owner regression and removed a secondary teardown error from failed OAuth fixture startup.

The local `.github/workflows/reach-reliability.yml` now uses `check:ci` (single-worker Vitest) while normal `npm test` remains parallel as a stress signal. Serial source 261/261 PASS in two repeats, final source 261/261 PASS, physically isolated Git-free offline install plus Node 261/261 and Root 50/50 PASS. Final root source 50/50 PASS. The remote PR #3 at `5cfc98a` is Draft with 0 checks; local unexpected `ee6748c` remains unpublished. Real Node22 hosted checks, deployed 200/404 parity, native GUI, production activation, independent mapped gStack and adoption metrics remain **BLOCKED**. No service or account/policy changes, commit/push, or user intervention. Exact files/logs in `docs/checkpoints/2026-11-11_0928_P0_WRITER_COLLISION_CI_ISOLATION_QC.md`.


## 2026-11-11 10:52 KST — P2 minimum durable goal prototype (local-only)

The user requested actual P2 code while the P0/P1 release gates remain. Added a strict local Goal Envelope bound to an **existing authorized detached job**, persistent node ID, canonical workspace, immutable job/run effect identity, terminal evidence, and current policy. New authenticated MCP `reach_goal_create` and read-only `reach_goal_status`, plus authenticated Console goal endpoints. Verified independent MCP client across Node restart, a **single** existing runner launch, symlink and unauthorized-workspace rejection. No model calls/retries/GUI operations occur in the goal observation path.

Final source typecheck/build and entire Reach Node **262/262 PASS** (43 files); Root **50/50 PASS**. A physically separate `.git`-free offline install passed the same **262/262 + 50/50**. Logs and exact changed files: `docs/checkpoints/2026-11-11_1052_P2_MINIMUM_DURABLE_GOAL_PROTOTYPE_QC.md`. P2 is **prototype only**: a successful terminal runner is not an independently verified general acceptance criterion; no arbitrary future scheduler or multi-Mac/GUI action migrations.

P0 parallel State Writer contention still open (prior 1/5 parallel full failures); serial green does not fix root cause. Local `ee6748c` remains unpushed, PR #3 Draft remote old SHA; external Node22 CI 0, gStack mapped verdict NOT GREEN, physical native GUI and real deployed parity NOT VERIFIED. Read-only deployed `/health=200`, `/health/auth=404` (older unsupported runtime, not OAuth storage failure). No production change, Git history mutation, account action, service restart, or user interruption. **Release BLOCKED.**

## 2026-11-11 11:37 KST — P2 idempotent Goal create (local only)

A stable UUIDv8-style Goal ID and exclusive-create retry handling now return the original Goal envelope for the same approved node/workspace/job/run. Eight simultaneous authenticated HTTP retries and one request after server restart returned one existing Goal ID; the original detached job executed only once. Source Root **50/50**, Node **262/262** with typecheck/build; isolated Git-free offline clean Root **50/50**, Node **262/262**. Root CLI has no package-lock (do not run root npm ci). No production, Git history, browser, GUI or account changes.

Release stays **BLOCKED**: prior parallel State Writer collision not proven fixed; external hosted Node22 CI (0 PR runs), gStack mapped verification, exact deployment parity, native GUI and live update/rollback are not verified. Evidence: `docs/checkpoints/2026-11-11_1140_P2_IDEMPOTENT_GOAL_CREATE_QC.md`.

## 2026-11-11 15:20 KST — State Writer typed diagnostics + autonomous Goal admission safety (Task 86)

A new `ReachStateWriterReservationError` preserves the existing fail-closed socket reservation but adds safe `ownerKind` and loopback port evidence, without disclosing the state directory or listener fingerprint. Real TCP collision regressions now assert same-state vs unidentified owner. A new real HTTP/Console/Goal integration test holds an opt-in P2 observation during durable runner evidence lookup; the VITEST-only maintenance gate denies the switch before trusting a caller-supplied idle signal, then autonomous receipt recording completes after the hold is removed.

Focused writer/Goal tests **20/20 PASS**; final source Root **50/50**, Node **264/264** with TypeScript/build; physically independent Git-free offline npm install and full Root **50/50**, Node **264/264** PASS. Four default-parallel full suite trials **4/4 PASS**, each 264/264, but the earlier 1/5 failed suite remains an unresolved flake. Local Node 26.7.0. Basic touched-file secret marker scan 0 and `git diff --check` PASS. Installed gStack review/verify/qa preambles loaded, no completed independent mapped review verdict.

Read-only live `/health` **200**, `/health/auth` **404** (unsupported old runtime, not OAuth-store failure); public PR #3 still Draft at remote `5cfc98a`, hosted workflow runs **0**, local `ee6748c` still unpushed. No production/policy/auth/browser/GUI/account change, Git history mutation or user interruption. **Release BLOCKED** for actual socket process ownership root cause, Node22 CI, deployed SHA/OAuth parity, live cutover/rollback, native GUI, mapped gStack and real user-selection outcomes. Evidence: [2026-11-11 15:20 checkpoint](checkpoints/2026-11-11_1520_P0_WRITER_CLASSIFICATION_P2_ADMISSION_QC.md).

## 2026-11-11 16:53 KST — P2 multi-Goal fair continuation (Task 86)

A real P2 background-observer starvation bug was reproduced: more than 256 Goal-shaped filenames, including corrupt historical records, caused the observer to abandon **all** authorized verification, not just one record. Removed the global entry-count veto while retaining the per-tick 8-Goal processing limit, rotating cursor, explicit opt-in, write-once receipts and no replay. Repaired the existing untracked regression's canonical workspace fixture. Its **257 records** (248 corrupt, 8 opted in, 1 opted out) now produce exactly 8 receipts, without creating a new runner or granting the opt-out Goal background verification.

Focused 3/3 PASS. Entire source Root **50/50**, Node **265/265** (46 files) with TypeScript/build PASS. Separate Git-free offline `npm ci` and full Root **50/50** + Node **265/265** PASS. gStack selected 193 tests PASS but verdict **UNMAPPED**, not READY. Runtime Node26, not hosted Node22. Read-only live `/health=200`, `/health/auth=404` (older route unsupported); Draft PR #3 still at remote `5cfc98a` with 0 workflows; local historical `ee6748c` and all dirty changes untouched. No production restart, browser/GUI action, Git publication or user intervention. Metadata enumeration is still linear in directory size. Final release remains **BLOCKED**.

Evidence: [16:53 P2 fairness checkpoint](checkpoints/2026-11-11_1653_P2_GOAL_BATCH_STARVATION_QC.md), `/tmp/kora-reach-20261111-1648-p2-batch-*.log`, `/tmp/kora-reach-20261111-1650-p2-batch-*.log`, and `/tmp/kora-reach-20261111-1652-gstack-verify.log`.

**16:56 KST P0 parallel addendum:** three more default-parallel Node full-suite runs all **265/265 PASS**. Logs: `/tmp/kora-reach-20261111-1655-p0-parallel-{1,2,3}.log`. No collision or process PID was observed; the historical intermittent State Writer failure remains open.


## 2026-11-11 20:03 KST — P0 State Writer identity fail-closed regression

An occupied TCP port with a malformed `kora-reach-state-writer-v1:` prefix previously let a new writer skip the port. A real loopback regression failed before the fix; both collision paths now accept only a complete 64-hex different-state fingerprint for port skipping. Unknown/malformed/same-state owners remain blocked. Focused **20/20**, full Root **58/58**, Node TypeScript/build and serial CI-shaped **266/266**, and isolated Git-free offline install + **58/58 + 266/266** PASS. Evidence: `docs/checkpoints/2026-11-11_2004_P0_WRITER_SIGNATURE_FAIL_CLOSED_QC.md`. Not a proven root cause for historical reservation flakes; no observed listener PID or deployment parity; release remains BLOCKED. No service, auth, policy, Chrome, Git history or publication changes.

## 2026-11-11 20:59 KST — P0 deterministic State Writer single-port safety fix

Reproduced a critical dual-writer race in the old fallback-port algorithm: after a foreign same-port state exits, two TCP reservations for the **same** state can simultaneously succeed on the primary and fallback ports. The new regression failed before the fix (`/tmp/kora-reach-20261111-2055-collision-red.log`). `acquireStateWriter` now never skips the deterministic primary port, and checks old v1 candidate ports for a live same-state writer before accepting a primary bind. Distinct-state port collisions therefore fail closed rather than risking duplicate effects. Additional legacy-fallback regression passes. Focused 21/21, full source root **58/58**, Reach Node **267/267** (46 files), clean Git-less offline reinstall + full **58/58 + 267/267**, typecheck/build/diff-check PASS. Logs `/tmp/kora-reach-20261111-2107-{source-root,source-node,clean-install,clean-root,clean-node}.log`. [Checkpoint](checkpoints/2026-11-11_2059_P0_DOUBLE_WRITER_PORT_CHURN_QC.md). Node26 host is not hosted Node22 CI. Live `/health`=200, `/health/auth`=404 (unsupported), remote PR workflow runs at `5cfc98a`=0. No real deployed-parity/GUI/production-transition claim. Exact prior intermittent collision PID/root cause still unknown. All older changes and local `ee6748c` preserved; no commit, push, service action, model repair, or user interruption.


## 2026-11-11 21:34 KST — P0 legacy late-start compatibility and foreign TCP collision (Task 86)

A real-loopback regression showed that a late-start older v1 writer can still bind a fallback port while the new fixed-primary writer holds the same state. An experimental reserve-all-fallback approach blocked that test, but an independent 269-case clean suite exposed a **real unrelated cloudflared listener** on TCP 20242 and a false `REACH_STATE_WRITER_OCCUPIED` error. The unsafe broad port reservation was **discarded**. A new focused regression protects legitimate startup when an unrelated legacy candidate port is occupied. This remains a **mixed-version upgrade admission blocker**, not a completed fix; stop/disable the old service must be proven in a future authorized transition.

Final post-revert QC: focused durability **22/22**, source Root **58/58**, Node **268/268** across 46 files; independent Git-free/offline Node install and Root **58/58** + Node **268/268**; typecheck/build/diff check PASS. No source or production deployment/commits, no policy/OAuth/browser changes, 0 user interventions. Live health 200; auth endpoint 404 (old runtime unsupported); remote PR #3 SHA `5cfc98a` has 0 returned PR workflow runs. Hosted Node22, deployed parity, native GUI, production rollback, gStack mapped verdict remain unverified. Evidence: [21:34 checkpoint](checkpoints/2026-11-11_2134_P0_LEGACY_LATE_START_PORT_CONFLICT_QC.md) and `/tmp/kora-reach-20261111-2140-final-*` logs.

[2026-11-11 22:27 KST read-only installed service preflight] Two installed Reach Node LaunchAgent plists show KeepAlive=true and RunAtLoad=true, while only reach-1.node is listed active. Existing unrelated cloudflared uses TCP 20242. No service changes, code edits, tests or runtime parity claims. See docs/checkpoints/2026-11-11_2227_P0_INSTALLED_LAUNCHD_AUTORESTART_READONLY.md; release remains blocked pending verified legacy restart suppression.


## 2026-11-12 02:06 KST — LaunchAgent plist snapshot drift guard

Verified read-only service preflight now detects a same-byte, same-mode plist inode replacement **during** allowlisted scalar reads and returns `service_configuration_unsafe` with unknown flags. RED 1 targeted regression; after fix 11/11 focused, 58/58 Root, 280/280 Reach Node; Git-free offline clean install and full 58/58 + 280/280 PASS. Two installed Node LaunchAgents retain `KeepAlive`/`RunAtLoad` and unverified app/state identities. Draft PR #3 has no PR workflow runs on remote SHA `5cfc98a`; `/health` 200 and old-runtime `/health/auth` 404. No deployment, policy, OAuth, GUI, Git history or personal Chrome change. Release BLOCKED: non-atomic diagnostics do not prove safe version transition, external Node22 CI, real GUI or parity. Checkpoint: `docs/checkpoints/2026-11-12_0206_P0_LAUNCHAGENT_PLIST_SNAPSHOT_QC.md`.

## 2026-11-12 03:12 KST — P2 Goal observer admission exception guard

A deterministic timer regression reproduced an exception escaping the authorization admission callback, risking Reach Node termination. After a narrow fail-closed guard in the pre-existing untracked Goal source, targeted **1/1 PASS**, and a later healthy observation can proceed without replay or new permission. Source Root **58/58** and Reach Node **282/282** PASS with typecheck/build. Separate Git-free offline installation and full **58/58 + 282/282** PASS. Remote Draft PR #3 SHA **5cfc98a** has 0 returned PR workflow runs; live health=200, old-runtime auth health=404. No production, access/TCC, live browser/GUI, Git or model actions, 0 user interruptions. Hosted Node22, deployed parity, OAuth tool results, native GUI and safe legacy service transition remain blocked. Evidence: [03:12 checkpoint](checkpoints/2026-11-12_0312_P2_GOAL_CONTINUATION_ADMISSION_EXCEPTION_QC.md).


## 2026-11-12 04:15 KST — P2 continuation release callback containment (Task 86)

Reproduced a remaining exception path after the 03:12 admission fix: `release()` throwing from the async Goal observer `.finally()` produced **1 Vitest unhandled promise rejection and suite exit 1**, even though its test body passed. Guarded the finalizer without permission expansion or runner/effect replay and added a deterministic two-tick regression. Targeted after-fix **2/2 PASS**; full source Root **58/58**, Reach Node **283/283 in 49 files**, typecheck/build PASS; independent Git-free offline install, full Root **58/58** + Reach Node **283/283** and typecheck/build PASS. Node26 macOS is not hosted Node22.

Live read-only `/health=200`, `/health/auth=404` (old-runtime unsupported, not OAuth-storage failure), remote Draft PR #3 SHA `5cfc98a` has **0** PR-triggered workflow runs. The historical local `ee6748c` and all dirty files remain untouched as Git objects; no commit/push, production/auth/policy/browser/GUI changes, model calls or user interruptions. Formal gStack mapping, actual OAuth tools/list+call, deployed parity, legacy service cutover, native GUI and first-tool selection still **BLOCKED**. Evidence: [04:15 P2 checkpoint](checkpoints/2026-11-12_0415_P2_GOAL_CONTINUATION_RELEASE_EXCEPTION_QC.md) and `/tmp/kora-reach-20261112-0409-goal-release-red.log`, `/tmp/kora-reach-20261112-0411-goal-release-green.log`, `/tmp/kora-reach-20261112-0412-{source-root,source-node,clean-install,clean-node,clean-root}.log`.


## 2026-11-12 05:55 KST — P2 log-independent Goal status and detached fixture teardown

A real authenticated isolated HTTP regression showed an already-verified Goal returned 400 when its runner stdout/stderr log became unreadable (red focused 1 failed/1). `ReachGoalStore.status` now reads only stable runner outcome metadata via `ReachJobManager.goalOutcome`; it does not open runner logs, dispatch effects or expand permissions. The test now verifies 200 even when the log is replaced by a directory. The original full Console job log API remains unchanged.

The first gStack selected suite found a pre-existing detached runner teardown race (`ENOTEMPTY`, 1/161 failed): the fixture deleted run state immediately after an asynchronous stop acknowledgement. Fixture-only test cleanup now waits for the bounded runner terminal `result.json` before deletion. Focused 10/10 PASS, gStack selected rerun 161/161 PASS, **overall gStack UNMAPPED** (workflow YAML and historical package checksum lack test lanes; no mapping or commit created).

Final direct source and isolated Git-free offline installation each passed **Root 58/58 + Node 283/283 (49 files)** with TypeScript/build. Read-only live `/health=200`, `/health/auth=404` (older unsupported route). GitHub PR #3 remains draft at remote `5cfc98a` with zero PR workflows/statuses. Deployed parity, hosted Node22 CI, production service transition, live OAuth tool outcomes, native GUI and fresh-chat tool-selection still **BLOCKED**. No deployment, production service restart, policy/TCC/browser/OAuth mutation, Git commit/push, model use or user interruption. Full evidence: [05:55 checkpoint](checkpoints/2026-11-12_0555_P2_GOAL_LOG_FREE_STATUS_FIXTURE_CLEANUP_QC.md).

## 2026-11-12 06:59 KST — P2 private Goal/receipt durable read guard (Task 86)

A real authenticated HTTP fixture exposed a P2 persisted Goal record with broadened file permission `0644`: `reach_goal_status` incorrectly returned 200. Added fail-closed private-mode validation and same-fd post-read identity/mtime/ctime/mode comparison for Goal envelopes, plus private-mode and mode-drift checks for verification receipts. The restored `0600` records continue to work through existing cross-chat/restart/receipt scenarios. **RED 1/1 failed before fix, GREEN 1/1 PASS after fix;** later source full Root **58/58**, Reach Node **283/283** with TypeScript/build; independent Git-free offline `npm ci` and full **58/58 + 283/283** PASS. gStack selected **161/161 PASS**, final **UNMAPPED**, not green. Read-only live `/health=200`, old-runtime `/health/auth=404` (unsupported route, not OAuth-store failure). PR #3 draft, remote SHA `5cfc98a`, 0 workflow runs on that SHA. No production/auth/policy/user Chrome/GUI change, model calls, Git commit/push or user interruption. This protects privacy/permission drift, **not same-user tamper resistance** or native GUI/production parity. Final release BLOCKED: hosted Node22 CI, exact runtime SHA, live OAuth tools/list and call, safe dual-LaunchAgent transition, physical GUI and power-loss checks, gStack mapped verdict. Evidence: [06:59 P2 checkpoint](checkpoints/2026-11-12_0659_P2_PRIVATE_GOAL_RECEIPT_SNAPSHOT_QC.md) and `/tmp/kora-reach-20261112-065*` logs.

## 2026-11-12 07:43 KST — P0 two loaded Node services and disposable fixture TCP collision (Task 86)

Read-only installed-service diagnostics now distinguish **two loaded Reach Node LaunchAgents** with `multiple_node_jobs_loaded`, without claiming shared state, common build or safe switch. Actual MSM2-1 reported two loaded Node service PIDs (1551 and 94364), both `KeepAlive`/`RunAtLoad` enabled; `upgradeReady=false`.

The first independent offline suite failed **1/284** because a fresh random Access Doctor test state hashed to TCP **11434**, an unrelated local **Ollama** listener. Production's single-fixed-port State Writer guard still fails closed. The **test-only disposable fixture** now retries only with a completely new state on `unidentified`/`foreign_listener` reservation errors; same-state or other startup errors remain fatal. Deterministic tests cover these branches. This is a confirmed cause of this one flake, **not proof of all past flake causes**.

RED two-node reason 1/13 expected failure; after source fix 13/13 PASS. Focused fixture/service 24/24 PASS. Final source Root **58/58**, Reach Node **286/286 in 49 files**, TypeScript/build PASS. Separate physically Git-free offline install and full Root **58/58** + Node **286/286** PASS. gStack selected 222 tests in 33 files, Node 164/164 PASS, overall **UNMAPPED** (workflow + untracked SHA256 package file). Live read-only `/health=200`, `/health/auth=404` (old unsupported route, not OAuth failure). PR #3 remote SHA `5cfc98a` confirmed by `git ls-remote`, Draft and **0** returned PR workflow runs. Local `ee6748c` and all prior dirty files preserved; no production/service/auth/policy/browser/GUI changes, model calls, Git mutation/publication or user intervention.

**Release BLOCKED** for external Node22 CI, deployed build/OAuth parity, safe two-service transition/rollback, native GUI, physical power-loss durability, mapped gStack and actual ChatGPT first-tool selection. Exact logs/files: [07:43 checkpoint](checkpoints/2026-11-12_0743_P0_MULTI_NODE_FOREIGN_PORT_QC.md).

## 2026-11-12 09:03 KST — P2 real SIGKILL Goal continuation/no replay (Task 86)

A new isolated authenticated MCP integration case kills the real Reach Node HTTP process **twice** with SIGKILL around an opt-in persistent Goal, restarts against the same disposable state, and verifies a private write-once SHA-256 receipt, stable Node/Goal/runner identities and **exactly one** detached runner launch. Stronger than the prior graceful close/restart Goal test, **not** a host-power-loss proof. Initial red was a new test's assertion path error (fixed), not a service failure. New case 1/1 PASS, repeat **3/3 PASS**; source Root **58/58**, Node TypeScript/build **287/287**; separate Git-free offline install Root **58/58**, Node **287/287**. gStack selected 223 tests PASS but **UNMAPPED** for workflow + pre-existing package checksum, not release green. Read-only live `/health=200`, `/health/auth=404` (old unsupported), GitHub PR #3 remote `5cfc98a` at 0 PR runs. Exact evidence: `docs/checkpoints/2026-11-12_0903_P2_HARD_CRASH_GOAL_REPLAY_QC.md` and `/tmp/kora-reach-20261112-{0856,0900,0901}-*`. All pre-existing dirty files and local-only `ee6748c` preserved; no production, auth/policy, live Chrome/GUI, model repair or Git publication. **Release BLOCKED:** hosted Node22 exact-SHA CI, deployed auth/build parity, safe dual-LaunchAgent cutover, physical GUI, true power loss and host tool-choice metrics unverified.

## 2026-11-12 09:54 KST — P2 Goal state-root alias protection; full clean QC (Task 86)

Two isolated regressions failed before the fix: a configured state directory that was a direct symlink allowed Goal status to follow its private goals subtree and Goal creation to write there. Added an `lstat` guard on the configured state root before Goal status and creation. Preserved first-use creation of an absent state root; no permission expansion, background dispatch or existing Goal mutation. The guard is non-atomic and does not prove every ancestor resists concurrent swaps. New test: `apps/reach-node/test/reach-goal-storage-ancestor.test.ts`; updated existing untracked `src/reach-goals.ts` and the existing admission-release fake-timer test (the latter now waits for the actual asynchronous release instead of assuming all file I/O completes within two fake clock ticks).

Test-first evidence: new negative 2/2 RED, then 2/2 GREEN. Two intermediate full-suite iterations revealed an initially absent-state-root compatibility issue and a separate fake-timer race; both repaired and disclosed. Final source `npm run check` Root **58/58**, Reach Node TypeScript/build + `check:ci` **289/289 in 51 files**. Independent Git-free offline Reach Node `npm ci`, Root **58/58** and Node **289/289** also PASS; no root lockfile exists, so root `npm ci` is not a valid check. gStack selected **225** tests (Node **167/167**), but overall UNMAPPED due to existing workflow/archived SHA256 non-mappings. Read-only remote SHA remains `5cfc98a`, 0 PR CI runs; `/health` 200, `/health/auth` 404 (old runtime). Node26 local, NOT hosted Node22. The exact full report is `docs/checkpoints/2026-11-12_0954_P2_GOAL_STATE_ALIAS_QC.md`. No production/Git/Chrome/GUI/security-setting changes; no user intervention. **FINAL RELEASE BLOCKED.**
