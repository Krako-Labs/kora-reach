# Control workflow QC checkpoint — 2026-11-05

The feature is uncommitted on `feat/verified-control`. It is not deployed to production Reach connectors.

## User interruption and operating constraint

The user reported that Reach QC windows were interrupting a live robot demonstration. These windows came from our disposable AppKit test on MP. All visible UI testing was stopped. Process inspection confirmed no `ReachTest.app`, `qc-control-mac`, `window-control`, or `window-text` process remained on MP. Do not resume visible UI testing on MP or any active exhibition/demo desktop.

The QC script now requires both `--allow-visible-ui` and a host-matching `KORA_UI_QC_HOST` for any test that opens visible windows. Use only a dedicated idle Mac. Headless repair tests remain separate. This gate was syntax-checked; no visible test was launched after the complaint.

## Verified before interruption

- Reach typecheck/build and 169 tests passed; CLI 5 tests passed earlier.
- Existing Chrome via CDP downloaded authenticated fixture content and independently verified bytes/text.
- MP Chrome without CDP, and with an intentionally unreachable CDP endpoint, used Accessibility, downloaded the file, and opened it in TextEdit with content verification.
- Native AppKit button and NSSavePanel scenarios passed.
- Actual Codex repaired a minimal failing-test checkout; local tests and the original UI outcome were reverified.
- Real Codex unattended/restart test passed on MSM2-1. MSM2-2 used a stub repair process to test the durable continuation without another model call.
- Earlier isolated visual click and stale-frame rejection passed.

## Open QC issue — do not mark release-ready

A subsequent visual test was blocked by window occlusion. An optional exact-window focus recovery was added, but it has NOT passed final live QC. One occlusion run observed an unexpected file in the covering fixture; the following run blocked the click and left both files absent. The unexpected write's source remains unresolved. Do not infer safe behavior from a single later pass.

Latest additions (AX focus confirmation and native dispatch diagnostics) remain unverified in a live GUI. The test was stopped rather than rerun on the user's desktop. The 169-test result predates these last additions. Safari live behavior and production ChatGPT exposure of the six new tools are not verified.

## Separate demo failure observed

The user's actual demo tab is `http://127.0.0.1:4503/`, forwarded by SSH from MP to MSM2-1. Its server runs from `87_KORA-Robot-Evolution-PoC-venue-cost/arena-venue/server.mjs`. Qwen inference uses the task024 llama-server on port19180.

Read-only inspection of `63_KORA-Project-2/local/task024/model-server.log` found `decode() failed: Compute error` and Metal `Insufficient Memory (kIOGPUCommandBufferCallbackErrorOutOfMemory)`. The model server had already restarted when inspected; this session did not restart or modify it. The browser subsequently showed Qwen 4/4 calls and then 5/5 calls, VALID, and active assembly. The workload responsible for exhausting GPU memory has not been established. Do not attribute that failure to, or exclude, the QC without evidence.

## Next safe work

Preserve all source changes and prior dirty repositories. Finish static review and non-GUI tests separately. Resume visual QC only on a dedicated idle host, with explicit test-host selection and without moving the user's active desktop focus. Keep the feature undeployed until the unexpected-write and focus cases are resolved.

## Resumed development checkpoint

The user confirmed that the demo incident was recovered and requested resuming Reach development. MP/exhibition GUI testing remains stopped. MSM2-2 is still locked.

Latest candidate: commit `60adda52888c3737eb9eeb5a89db601821eb93f4`, pushed to `feat/verified-control`, draft PR https://github.com/Krako-Labs/kora-reach/pull/3 . Public verification report: docs/VERIFIED_CONTROL_QC.md (subsequent documentation-only update adds clean-install result).

Added process-targeted pointer dispatch, disabled pointer fallback by default, bound frame tokens to window/process identity, CPU-only bounded OCR, isolated malformed background queue entries, and regression tests. The latest build/typecheck and 173 Reach tests plus 5 CLI tests passed on MSM2-2. Headless authenticated download and stub-repair/restart/resume passed. OCR fixture returned in0.66s; locked-session refusal and visible-QC admission refusal were verified. Fresh source archive installation (`npm ci`, build, authenticated MCP, real headless download) also passed. No additional paid Codex test was run.

Open: dedicated unlocked-host visual/focus/occlusion QC, optional Safari certification, packaged release installation, and production ChatGPT new-tool exposure. No production rollout or merge performed.

## Resumed after separate KORA demo recovery — 2026-11-05

The user confirmed that KORA Project repaired the simulation demo and explicitly
requested resuming the existing Reach work. Keep demo troubleshooting out of this
project. Do not touch MP or the exhibition UI.

Canonical feature worktree: /Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control,
branch feat/verified-control, prior HEAD c21dc54. The legacy KORA-REACH worktree
has unrelated uncommitted changes and was left intact. The old MSM2-2 QC copy is
also dirty and was preserved. The previous dependency experiment existed only in
/tmp/86_KORA-Reach-clean.2ZNaDD; its audit result was not a fixed branch.

Applied canonical changes: pinned Zod 4.6.7 and Vitest 4.1.12, refreshed affected
compatible transitive dependencies, added a compressed HTTP request recovery
regression, corrected main-branch installation instructions, updated verification
report. No forced major dependency upgrade.

Fresh QA source on MSM2-2:
 /Users/akim/KORA-Workspace/86_KORA-Reach-Control-QC-20261105-resume
Source archive SHA-256:
 be6e74a270db29a8c8546dc6f821d62a706a8ca4884d2129fb11488cbaa340a6
This archive includes all tested runtime/dependency/test changes; later edits were
documentation only.

Evidence on MSM2-2:
- /tmp/reach-resume-install-20261105.log: clean npm ci, zero advisories.
- /tmp/reach-resume-check-20261105.log: typecheck/build, 174 tests in 30 files.
- /tmp/reach-resume-cli-20261105.log: CLI check, 5 tests.
- /tmp/reach-resume-download-20261105.log: authenticated real headless Chrome
  download, file verification, repeated execution suppressed.
- /tmp/reach-resume-repair-20261105.log: restart/disconnect, stub repair,
  independent tests, automatic original browser task resumption, verified file.
- /tmp/reach-resume-audit-20261105.json and
  /tmp/reach-resume-runtime-audit-20261105.json: zero known advisories.
- Visible QC without host opt-in was refused before fixture creation.
- Native input on the locked session returned session_locked.
- No fixture/helper/browser test process remained after completion.

No new actual Codex invocation was made. Keep the prior real Codex test distinct.
MSM2-2 remains locked; live visual/focus/occlusion QC is not passed. Pointer
fallback remains disabled by default. Safari, packaged-release install, and
production ChatGPT exposure of the six new tools remain uncertified. No merge,
production service restart, or deployment was performed during this resumption.


Published continuation: commits17c44b6 and0f1ac36 pushed to the existing
feat/verified-control branch. PR#3 description now distinguishes174 current
Reach tests,5 CLI tests, dependency audit0, and stub-vs-real Codex evidence.
GitHub head verified as0f1ac36b091c5ad13af1dc762377156940a6418e.
PR remains draft, merge state CLEAN/MERGEABLE, not merged. Tracked working
tree clean; this pre-existing private checkpoint directory remains untracked.
No final live GUI certification is implied.


Chrome popup follow-up: screenshot identified MSM2-2. Personal Chrome PID66585 has run since Nov3 11:04KST. No current crash dialog or fixture process at inspection. Unified log shows QC exits14:11 and ReportCrash notification/open requests14:16-14:18, no available Chrome .ips. Exact origin unresolved; delayed fixture alerts are a hypothesis. Added QC child-only SIGINT shutdown, exit-code/signal recording, failed-run evidence retention and6 simulated-process tests, all passed. No new Chrome launch, no profile change, no production restart. See updated VERIFIED_CONTROL_QC.md.


Status-request resumption at14:57–14:58KST: no claim of autonomous model work
between chat turns. Copied only the new shutdown helper/QC script/test to the
existing isolated MSM2-2 QC archive. Real headless download and restart/unattended
stub repair both passed with code0, signal=null, forced=false (Chrome fixture
PIDs83935 and84122). Logs: /tmp/reach-chrome-shutdown-live-20261105.log and
/tmp/reach-chrome-shutdown-repair-live-20261105.log on MSM2-2. Personal Chrome
PID66585 unchanged. At follow-up the host is locked again; visual/focus/occlusion
and delayed-dialog-after-unlock remain pending. No production deployment or
model call. Do not claim ongoing background development after the turn ends.


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
Live GUI execution after unlocking remains unverified. These changes are in
the QC harness, not a deployed production auto-unlock feature.

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
transition. Live GUI/focus/occlusion remains pending. This is a draft candidate;
the production Reach service has not been updated.

<br />


Final logs on MSM2-2: /tmp/reach-session-wait-final-check-20261105.log, /tmp/reach-locked-queue-final-20261105.log, /tmp/reach-session-repair-final-20261105.log. An intermediate lock-priority regression was corrected; final real repair retest passed. No production deployment.


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


Private rollout details: /Users/akim/.local/share/kora-reach/releases/control-preview-9dc24a0 on MSM2-2; activation-result.json records active source9dc24a05a333 and unchanged prior launcher hash; archiveSHA2569880f9f0d1a843e1e1fed3cbc283dd08e57d052664f16290cb94299c89451dbb. Live proof /tmp/reach-live-control-proof-20261105.log. GUI worker PID98401; /Users/akim/KORA-Workspace/86_KORA-Reach-Control-QC-20261105-resume/gui-continuation-20261105/status.json, events.jsonl, worker.log; waiting_for_unlock at2026-11-05T07:33:17Z, expires2026-11-06T07:33:17Z. No claim of model reasoning continuing in background; this is an actual bounded local QC process.
