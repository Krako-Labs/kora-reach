# KORA Reach autonomous development and release-readiness QC

**Observed:** 2026-11-10, 19:47 KST · **Canonical writer:** MSM2-1 · **Project:** `Krako-Labs/kora-reach` · **Worktree:** `/Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control` · **Branch:** `feat/verified-control`

**Status: CANDIDATE VERIFIED LOCALLY; NOT RELEASE-CERTIFIED.** No commit, push, service restart, runtime policy change, GUI event, or production rollout was performed.

## Baseline and concurrency

- Git HEAD and remote PR #3 head: `5cfc98a72d5f39f3fa7215acb7a867309c6f0e58`, draft/open. Changes below remain **uncommitted** and are **not** part of the GitHub PR's remote head.
- Read project instructions and repo README. The separate `KORA-REACH` worktree remains untouched. No competing `codex exec`, `vitest`, `qc-control-mac` or other project writer was observed at start.
- Original user work and `docs/checkpoints/` were preserved. No private credentials or OAuth state were copied into candidate archives.

## Changes present in the local candidate

1. Reused the previous uncommitted Access Doctor implementation as source, adding local-only target URL enforcement, redirect rejection, authenticated tool discovery, and distinct OAuth readiness outcomes: 200 = PASS, 404 = UNSUPPORTED, 503 = FAIL.
2. Structured tool errors now distinguish `WORKSPACE_DENIED`, `OS_PERMISSION_DENIED`, missing files and control errors, while retaining the legacy message.
3. Effect claims, immutable plans, queue links, and atomic JSON results now synchronize file data **and containing-directory metadata** before reporting success or dispatch. An uncertain result remains reserved; no replay is inferred solely from a transport 200.
4. Guarded `captureDownload` requires the verified CDP path. If no CDP adapter or exact tab/control exists, it does **not** select a tab via AppleScript, focus a window, call Accessibility, send a native click, or open the browser's default-download path. Five pre-dispatch error classes remain covered by tests.
5. Fresh installer defaults to restricted workspace roots with `allowExecution:false`; later explicit operator policy changes remain possible.
6. Added macOS GitHub Actions workflow for Node22 typecheck/build/tests, native Swift helper compilation, and root CLI checks. Node22.23.4 was independently run from an isolated npm package on MSM2-1; this is not a hosted CI run. The workflow is local/uncommitted.
7. Extended integration tests for disabled execution (control begin/run/repair and no queue/effect), invalid token (no plan/audit mutation), guarded download routing, Access Doctor target validation, and durable claims. Simulated file/directory sync failures retain their markers and queue links.
8. **Caught and fixed a real recovery regression:** the first long-running stub-repair/restart QA exposed that a guarded download with a verified missing DOM control was incorrectly classified as a missing CDP capture route; automatic coding repair did not start. Definitive missing DOM controls now return `web_control_missing` for authorized repair without allowing native fallback. Follow-up real headless stub-repair/restart/resume **PASS**; stub polling is now capped at 45 seconds instead of 5 minutes.

## Evidence recorded in this run

| Gate | Evidence | Result |
| --- | --- | --- |
| Root CLI syntax/tests | `npm run check` | PASS **5/5** |
| Reach Node typecheck/build/native helpers/tests | `npm run check --prefix apps/reach-node` | PASS **216/216**, **37 test files** on Node26 and Node22.23.4 |
| Actual headless Chrome | `qc-control-mac.mjs --headless` | PASS; verified downloaded bytes and repeat suppression; fixture browser exited cleanly with code 0 |
| Stub repair/restart/automatic original-task resumption | `qc-control-mac.mjs --repair --repair-stub --restart --unattended` (final corrected candidate) | PASS; repair corrected fixture, independent local test passed, original Chrome download verified, clean fixture exit |
| Restart and locked queue | `qc-control-mac.mjs --headless --locked-wait` | PASS; durable job remained queued across service restart; unrelated Chrome download completed cleanly |
| Production-dependency advisory check | `npm audit --omit=dev --prefix apps/reach-node --audit-level=high` | PASS, **0 known advisories** |
| Source integrity | `git diff --check` | PASS |
| Clean isolated runtime install | Only allowlisted source/build files copied to `/tmp/86_KORA-Reach-cleaninstall.*`; archive SHA-256 `54d84189b820fbef358dcf1804a732624631011f5e43edba07fc7680eb980bcb`; `npm ci --omit=dev --offline` | PASS; 96 production packages installed |
| Clean extracted runtime behavior | Temporary, loopback-only MCP service and restricted policy, no user profiles | PASS; 401 without authentication, 62 tools with authenticated discovery, workspace and shell/control denials confirmed |
| Draft PR metadata | GitHub PR #3 | OPEN, DRAFT; remote head remains `5cfc98a` |

Isolated test and install receipts: `/tmp/kora-reach-autonomous-20261110/`; source-snapshot archive is deliberately **not** called a signed production package or a clean-commit artifact. No production secret or user data is included.

## Known limitations / remaining release gates

- **Live native GUI / focus / visual occlusion is not certified.** MSM2-2 was checked read-only on November 10: `CGSSessionScreenIsLocked=1`, an existing process was managed by its live service, and no visible QC worker was running. Do not unlock or steal the desktop. Use the existing bounded, host-bound idle GUI QC harness only when the authorized dedicated Mac is unlocked and idle.
- **Hosted CI not yet run.** The workflow exists only in the dirty local worktree and has not been pushed. Node22.23.4 and Node26 local suites both passed 216/216; hosted CI and a branch-protection gate remain unverified.
- **Live deployment parity not established.** MSM2-1 production MCP remained reachable and `full` access was unchanged. Its `/health/auth` returned HTTP 404 while `/health` and authenticated tool listing worked. Access Doctor correctly classifies this as an *unsupported readiness endpoint*, not a proven OAuth storage failure. Do not restart the running service simply to gain that endpoint.
- **Actual power-loss fault injection not performed.** Three isolated `EIO` fault-injection tests verify fail-closed claims and queue links when file/directory sync fails; physical crash consistency cannot be proven with unit tests.
- **No release signing/notarization or public merge.** PR #3 remains draft; rollout to other Macs is not authorized by these local PASS results.

### Next safe steps

Re-run the full suite on any further changes; test the hosted macOS CI after a permitted commit/push, add authorization-revocation regression coverage if needed, complete live GUI checks only on a verified unlocked idle test Mac, then evaluate packaging/rollout parity with no active jobs. Preserve the user's already-running apps and existing profiles throughout.

**User interventions needed in this run: 0.**
