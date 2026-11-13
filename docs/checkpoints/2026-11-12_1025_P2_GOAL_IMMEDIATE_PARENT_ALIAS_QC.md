# KORA Reach — P2 Goal immediate-parent alias guard, clean-install QC

**Observed:** 2026-11-12 10:24 KST, canonical MSM2-1. Repository: `Krako-Labs/kora-reach`; candidate `/Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control` on `feat/verified-control`. Existing local-only HEAD `ee6748c56088584a6d33947098354e653d28f51c` remains unchanged. Remote draft PR #3 head last confirmed `5cfc98a72d5f39f3fa7215acb7a867309c6f0e58` with **zero** PR-triggered workflow runs returned by GitHub connector. **FINAL RELEASE BLOCKED.**

## Scope and single-writer safety

Read `/Volumes/MSM2-1-DATA/Projects/AGENTS.md`, `KRAKO_CONTEXT.md`, candidate README, product/reliability decisions, prior 09:54 checkpoint and installed gStack review/verify/QA guidance. Confirmed physical worktree, branch, HEAD, remote, dirty/untracked source and absence of competing Codex/Vitest source writer before editing. Preserved old dirty `KORA-REACH` checkout, unrelated Krako Reach repository, AgentGate, KORA Doctor, existing commit, artifacts in `docs/checkpoints/packages/`, and all other staged/unstaged changes. No Git mutation, production operations or model repairs.

## Changed files and test-first proof

- **Updated pre-existing untracked** `apps/reach-node/test/reach-goal-storage-ancestor.test.ts`: added three isolated cases for a symbolic-link **immediate parent** of the configured Goal state path: read-only goal lookup rejects alias, Goal creation rejects alias, and a fresh absent state path is **not created in a foreign directory**. Earlier two state-root alias tests remain.
- **Updated pre-existing untracked** `apps/reach-node/src/reach-goals.ts`: added a narrowly scoped `lstat` check for the configured state directory's immediate parent. Both `status` and Goal creation use it. Creation checks **before** `mkdir`, not only afterward. Does not change job dispatch, approved scope, effects, runtime service or policy.
- New regression initially **2 FAIL / 2 PASS** before the correction (read alias reached `ENOENT` in a foreign location; create alias actually wrote into the foreign state root); corrected focused tests **5/5 PASS**, including the third absent-directory case.
- **Updated** `docs/VERIFIED_CONTROL_QC.md` with this measured result; **new** this dated checkpoint.

The immediate parent rule is a bounded guard and is **not** a proof of full path confinement against more distant symbolic links, concurrent path swaps, macOS system-root aliases, or power-loss durability. Existing other Job/state protections remain separate. Never claim atomic TOCTOU safety.

## Actual QC

| Run | Verified outcome |
| --- | --- |
| Focused new negative tests before fix | **2 failed / 2 passed**, expected RED |
| Focused regressions after fix | **5/5 PASS** |
| Source root `npm run check` | **58/58 PASS** |
| Source Reach Node `npm run check:ci` | TypeScript + build PASS; **292/292 PASS in 51 files** |
| Independent source-free-of-Git fixture | Physical distinct temporary root; `.git` file **and** directory absent; `git rev-parse` rejected; root **58/58**, offline `npm ci --offline --ignore-scripts` completed; Node TypeScript/build and **292/292 PASS** |
| `git diff --check` | PASS |
| GitHub connector | **0** PR-triggered workflow runs at remote `5cfc98a` |
| gStack | Instructions and prior read-only adversarial findings reviewed; **mapped final verdict not rerun/NOT GREEN**. Previous gStack selected success does not certify this change. |

Host logs: `/tmp/kora-reach-20261112-102x-parent-{red,green,focused,root,node,offline-root,offline-install,offline-node}.log`. Initial root test was inadvertently run when targeting a Node Vitest script; it passed root **58/58**, but is **not** treated as negative-test evidence. The subsequent explicit `npx vitest run` proved RED before source fix. Standalone fixture cleanup completed.

## Release gates and operations

- Local Node 26.7.0 tests do **not** replace externally hosted Node22 CI. Dirty local source is not pushed to PR #3, and no exact-source compiled runtime has been deployed.
- Current installed `/health/auth` HTTP 404 is an older-runtime unsupported endpoint; prior read-only `/health` HTTP 200 does not prove storage fault or OAuth readiness. This session did **not** recheck live OAuth tools/list or invoke a live tool against the new build.
- Exact deployed/runtime SHA and source parity, live OAuth tool outcome, managed LaunchAgent writer exclusion and safe rollback, user Chrome identity, native GUI on a verified idle/unlocked dedicated Mac, power-loss persistence, external Node22 CI, mapped gStack release verdict and first-tool Reach selection remain **BLOCKED / NOT VERIFIED**.
- Production/service settings, OAuth and policy modes, active browser, TCC, user GUI and remote Git were untouched. No commits, pushes, tags, public posts, unsafe model calls or user interventions.

**Task 86 Implemented — narrow P2 Goal storage immediate-parent alias guard verified locally; final release BLOCKED.**
