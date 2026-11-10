# KORA Reach — P0 Access Preflight + Writer Collision QC

**Date:** 2026-11-10 KST (20:15–20:36 approx.)  
**Canonical Mac:** MSM2-1 · **Branch:** `feat/verified-control` (draft PR #3)  
**Repository:** `Krako-Labs/kora-reach` at `/Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control`  
**Baseline HEAD / remote PR head:** `5cfc98a72d5f39f3fa7215acb7a867309c6f0e58`  
**Status:** Local candidate P0 hardening and QC PASS; **release gate still PARTIAL**. No commit, push, deployment, policy change, service restart, user-browser intervention, external posting or model repair call.

## Preconditions and change protection

- Read host `/Volumes/MSM2-1-DATA/Projects/AGENTS.md`, `KRAKO_CONTEXT.md`, root README, package manifests and latest reliability/autonomous checkpoint.
- Confirmed active worktree and remote SHA. No competing KORA Reach writer found. The separate legacy `/Volumes/MSM2-1-DATA/Projects/KORA-REACH` remains dirty (37 changed/untracked entries) and **untouched**.
- Preserved preexisting PR #3 modifications and untracked research/CI/checkpoints.
- README and the developer QC report updated without changes to the user's current runtime.

## Implemented this run

### 1. Single read-only `reach_preflight` MCP entry point

- Added `apps/reach-node/src/reach-preflight.ts` and registered the tool near the start of the Node tool catalog.
- The tool reports current effective file/shell policy and Chrome connection status, optional macOS Accessibility/Screen Recording grant preflight, unverified UI session state, and explicit runtime parity uncertainty.
- It does **not** start Chrome, touch credentials, disclose workspace roots/profile paths/tokens/URLs/ports, run shell, execute actions, or grant new access.
- Server instructions now direct the agent to check `reach_preflight` before declaring a Mac task inaccessible when capability is unclear.
- Added two integration cases for restricted/no-shell and full policy with opt-in OS permission check; the complete MCP tool inventory now exercises the additional registered tool.
- Important architectural boundary: a Reach tool cannot force ChatGPT to select Reach. Host tool selection and actual deployed tool-menu exposure remain separate E2E gates.

### 2. Reproducible release-blocking collision fixed fail-closed

- Two full-suite attempts independently failed with `Reach state writer reservation is occupied` in **different** isolated fixtures (`reach-durability` and `reach-diagnostics`) although tests used distinct state directories.
- Root weakness: `acquireStateWriter` used a single 20,000-slot deterministic TCP port derived from the canonical directory; collisions falsely block healthy local managers under concurrent tests.
- Updated `apps/reach-node/src/reach-durability.ts`: an OS-held server replies with its exact canonical-directory fingerprint. On a conflicting port, a candidate retries a secondary deterministic port **only if the occupant proves it is a different new Reach state directory**.
- Same canonical identity, unknown/legacy listener, timeout or connection failure still fail closed. There is no stale-file removal, PID-based takeover, bypass or unsafe replay.
- Added two deterministic new tests: construct two distinct state paths with a real first-port collision and verify both can run; simulate an unknown older listener and confirm no fallback/takeover.

## Actual QC receipts

| Check | Result / evidence |
| --- | --- |
| Root CLI `npm run check` | **5/5 PASS**, log `/tmp/kora-reach-20261110-2030-final-root.log` |
| Node `npm run check` | **221/221 PASS**, 38 files; TypeScript build and native Swift helpers, log `/tmp/kora-reach-20261110-2030-final-node.log` |
| Writer collision stress | Three successive full Node test runs **221/221 PASS** each, `/tmp/kora-reach-20261110-port-stress-{1,2,3}.log` |
| Targeted preflight, catalog, writer tests | PASS; extra tests were executed via authenticated loopback MCP |
| Isolated actual headless Chrome | Downloaded expected content, suppressed repeat, PASS; fixture browser clean exit code 0 / signal null / forced false; `/tmp/kora-reach-20261110-2030-final-headless.log` |
| Stub coding repair + automatic restart and original UI resumption | PASS with independent local verification and content check; browser clean exit code 0; `/tmp/kora-reach-20261110-2030-final-repair-stub.log`; **no model inference call** |
| Fresh isolated source install | PASS: allowlisted source copy, offline `npm ci --ignore-scripts`, full `npm run check`, production-only `npm ci --omit=dev`, built runtime exists, root CLI `npm run check`. Disposable fixture deleted after checks. |
| Prod-only authenticated smoke | PASS: unauthenticated MCP HTTP 401; authenticated `tools/list` includes `reach_preflight`; restricted/no-shell preflight; no managed Chrome launch. |
| Proposed CI workflow | Local YAML syntax/macOS runner structure PASS; workflow still uncommitted and **0 hosted workflow runs** on current remote PR head. |
| Security source patterns | No obvious private key, OpenAI/GitHub personal token, or Cloudflare token matches in checked new/modified source. Not a substitute for external security audit. |
| `git diff --check` | PASS |
| User interruptions | **0** |

## Running service / GUI gates

- Read-only live MSM2-1 `/health`: HTTP 200, `version:0.5.0`, effective access `full`, OAuth enabled, access diagnostics contract 1. This is the **preexisting deployed service**; no runtime was restarted or upgraded.
- Read-only live MSM2-1 `/health/auth`: **HTTP 404**. The current runtime lacks the readiness endpoint. This is **UNSUPPORTED**, **not** demonstrated OAuth storage failure. Local candidate and deployed parity are **not** certified.
- Read-only MSM2-2 `ioreg` confirms `CGSSessionScreenIsLocked=Yes`. No visible UI tests, unlock, password, TCC modification or personal Chrome event were performed.
- User-owned original `Krako-Labs/krako-reach`, AgentGate, KORA Doctor and older KORA Reach worktree not modified.
- PR #3 remains **OPEN / DRAFT**, remote SHA `5cfc98a...`. New local changes are not yet in the PR, so hosted CI cannot validate them.

## Remaining release requirements

1. Permitted commit/push and hosted macOS Node22 CI on the exact candidate SHA (do not auto-publish under host rules).
2. Real native GUI, focus/occlusion, delayed Chrome dialog and post-unlock tests on an explicitly authorized *idle, unlocked dedicated Mac*. **Not a PASS** while MSM2-2 is locked.
3. Actual deployed build identity, OAuth endpoint parity, upgrade/policy persistence and restart impact before any service rollout. Do not restart production with live processes.
4. Additional physical crash/power-loss validation for state and effect-claim directory sync; current EIO tests do not prove physical power-loss behavior.
5. Fresh ChatGPT new-chat selection test to establish the agent chooses Reach and the new `reach_preflight` automatically, independent of Node MCP tool success.

**Release decision:** Continue development/QC without user interruption. Keep existing recurring task active; disable only after verified final release gates. No final GUI PASS or deployed parity claim.
