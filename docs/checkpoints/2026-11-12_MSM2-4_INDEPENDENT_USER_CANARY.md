# KORA Reach — MSM2-4 Independent User Canary (Headless)

Date: 2026-11-12 KST.
Canonical source: MSM2-1, `Krako-Labs/kora-reach`, worktree `86_KORA-Reach-Control`.
Independent test host: **MSM2-4** (macOS, arm64, Node.js v24.22.0).
Status: **isolated headless QC PASS; full user/GUI and production release NOT verified.**

## Host selection and security boundaries

- MSM2-1 stays the sole source writer. MSM2-4 is selected for an independently isolated runtime test because no personal Chrome process was running there; MSM2-3 has an existing live personal Chrome session and is reserved for a later explicit existing-browser integration test.
- Both MSM2-3 and MSM2-4 have a working Reach listener (`/health` HTTP 200), OAuth diagnostic (`/health/auth` HTTP 200), Screen Recording and Accessibility grants, but both macOS consoles were locked. A service health check does not prove GUI availability, and no native GUI action or unlock was attempted.
- MSM2-4's managed browser was disconnected; Chrome app binary was installed. No existing user browser profile was read or modified.
- A probe with an arbitrary `/tmp` workdir was **DENIED** by MSM2-4's Reach workspace policy. This denial was respected. All subsequent execution was confined to the authorized `/Users/akim/KORA-Workspace/kora-reach-test.8beCzdEg` directory. The test source initially copied under `/tmp/kora-reach-pilot4.PETQeuAD` was cleaned via a narrowly scoped SSH cleanup; no further testing was run there.
- The authorized test folder contains only a copied KORA Reach source snapshot, isolated test dependencies and QC logs; no source Git metadata, credentials, OAuth state, original Chrome profile, live launchd settings or services were transferred.
- Source transfer used existing user-owned Mac-to-Mac batch-mode SSH; no remote repository push, new service/tunnel, OS privilege grant or production port takeover.

## Actual execution evidence

| Check | MSM2-4 result |
| --- | --- |
| Host Reach HTTP health | 200 before and after tests |
| Host OAuth readiness | 200 on existing older service (not a test of candidate's OAuth code) |
| Node and TypeScript toolchain | Node.js v24.22.0; TypeScript typecheck PASS |
| Initial P2 focused suite in authorized workspace | **6/6 PASS** across six P2 Goal test files |
| Full Reach Node suite on complete copied repo source | **292/292 PASS**, 51 files under `npm run check:ci`, including typecheck/build |
| Root CLI suite on independent host | **58/58 PASS**, `npm run check` |
| Real, disposable headless Chrome | Download content verified, duplicate suppressed, owned Chrome exited code 0 / signal null / forced false |
| Live original Reach process | Health HTTP 200 after all tests; no restart or replacement |
| User intervention, TCC change, login, personal Chrome operations | 0 |
| Native GUI, unlock-to-dispatch, ChatGPT host tool-selection | **NOT TESTED** (locked/host boundary) |
| Package exact commit and external Node22 CI | **NOT VERIFIED** on this uncommitted source snapshot |

Evidence retained on MSM2-4:
- `/Users/akim/KORA-Workspace/kora-reach-test.8beCzdEg/apps/reach-node/pilot-p2.log`
- `/Users/akim/KORA-Workspace/kora-reach-test.8beCzdEg/apps/reach-node/pilot-full-complete.log`
- `/Users/akim/KORA-Workspace/kora-reach-test.8beCzdEg/apps/reach-node/pilot-headless-chrome.log`
- `/Users/akim/KORA-Workspace/kora-reach-test.8beCzdEg/pilot-root.log`
The authorized test folder is intentionally retained for future controlled canary testing.

## Corrected harness problems (not hidden)

1. The first attempt ran from `/tmp`, and the local Reach tool correctly denied that workdir. Moved to an authorized workspace instead of bypassing policy.
2. Offline `npm ci` failed because the clean Mac lacked cached `zod@4.6.7`. Standard `npm ci --ignore-scripts --no-audit --no-fund` from the official registry succeeded with local-only dependencies, not global software installation.
3. The first full suite had 3/281 failures because the test transfer included only `apps/reach-node` but not top-level `bin/`, `src/`, `scripts/`, and CLI fixtures. The temporary test copy was completed, and the entire suite was re-run **292/292 PASS**. An undici `setTypeOfService EINVAL` uncaught test-runner error occurred on that incomplete first run but did not reproduce in the complete full run. It remains a signal to watch on Node24; there is no proof yet of a product defect or of unconditional absence.
4. The candidate under test is an isolated snapshot of dirty MSM2-1 source; newly changed code requires a new snapshot and retest.

## Next staged rollout

1. Keep MSM2-4 as dedicated headless regression + Goal continuation test host. Use only separately owned test directories and bounded ephemeral ports; never replace existing port 3208 or live users' services.
2. Repeat the narrow Goal creation -> chat/client disconnect -> server restart -> autonomously recorded file acceptance -> fresh MCP client verification test; this scenario is already included in the 292-suite and focused P2 PASS, but it is not yet a separate *ChatGPT model selection* test.
3. Once a dedicated Mac is unlocked and idle with user-granted native UI access, run the opt-in visible-GUI/focus/Chrome test. Neither MSM2-3 nor MSM2-4 can be certified as visible-GUI-ready while locked.
4. Test existing Chrome profile on MSM2-3 separately; do not attach, reset, launch or capture the personal Chrome session without a safe scope and explicit authorization.
5. Measure Reach's initial selection by ChatGPT in new chats separately from the Node execution success rate. Node cannot see when the chat host never invokes it.
6. Do not claim released or Dots/Muse-grade full autonomy until real rollout, external Node22 CI, installed runtime parity, GUI QC and cross-chat usability tests pass.

**Conclusion:** MSM2-4 is the right first isolated test Mac; its independent Node24 full and headless-browser QC has passed. It is not an unlocked native-GUI test machine yet.
