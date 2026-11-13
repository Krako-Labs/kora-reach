# KORA Reach — P2 real hard-crash continuation and no-replay QC

**Observed:** 2026-11-12 09:03 KST, canonical MSM2-1. Candidate `Krako-Labs/kora-reach` in `/Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control`, branch `feat/verified-control`, local-only HEAD `ee6748c` (preserved). Remote Draft PR #3 at `5cfc98a72d5f39f3fa7215acb7a867309c6f0e58`, with **0** pull-request workflow runs for that SHA. **Release BLOCKED.**

## User goal and safety checks

- Read canonical AGENTS, KRAKO_CONTEXT, repo README, product decision and Reach-first reliability documents, latest 07:43 checkpoint, installed `gstack-review`, `gstack-verify` and `gstack-qa` skill instructions. Verified correct branch/remote/HEAD and inventoried all existing dirty and untracked files before writing. No competing Codex/Vitest writer identified in the process scan; source files had no recent competing edits.
- Kept old `/Volumes/MSM2-1-DATA/Projects/KORA-REACH` checkout and `Krako-Labs/krako-reach`, AgentGate, KORA Doctor, real policies/OAuth, production jobs, live Chrome and native GUI untouched. No commit, push, tag, model repair, service restart or policy expansion.

## Substantive test added (one test, one new file)

- **New:** `apps/reach-node/test/reach-goal-hard-crash.integration.test.ts` (untracked, deliberately left uncommitted).
- Starts a **real child Node HTTP/MCP server** on temporary loopback with a disposable bearer credential, private temporary state/workspace and one detached deterministic runner (`attempts.txt`, `output.txt`).
- Calls authenticated `reach_goal_create` with explicit `autoRecordVerification=true`, exact approved Node/workspace and SHA-256 file acceptance. Confirms Goal running, then kills the **actual Node server process with SIGKILL**, not `server.close()`.
- Restarts Node with the same disposable state and a fresh authenticated transport. Waits for autonomous, write-once verification receipt. Calls authenticated `reach_goal_status` across the process boundary, expects `verified` with original job/run/node identity and digest evidence. Confirms runner wrote exactly one `x` to `attempts.txt` (no replay) and the receipt has private permissions.
- Kills the restarted Node **again** with SIGKILL. On the second restart, confirms `verified`, identical receipt bytes and exactly one original runner launch. Cleanup stops the owned fixture job and Node and removes the disposable state/workspace. No production credentials, data, browser or GUI were read.
- First test attempt failed because this **new test** incorrectly accessed `structuredContent.goal.state` rather than `structuredContent.state`; a test assertion error, **not a product failure**. Corrected it and reran.

## Exact fresh QC evidence

| Verification | Result | Evidence |
| --- | --- | --- |
| New hard-crash integration | **1/1 PASS** after test correction | direct Vitest invocation |
| New test independent repeats | **3/3 PASS** | `/tmp/kora-reach-20261112-0856-crash-{1,2,3}.log` |
| Source Root tests | **58/58 PASS** | `/tmp/kora-reach-20261112-0856-source-root.log` |
| Source Reach Node typecheck/build + serial CI-shaped full suite | **287/287 PASS in 50 files** | `/tmp/kora-reach-20261112-0856-source-node.log` |
| Physically separate Git-free fixture | `.git` absent; `git rev-parse` rejects fixture; `npm ci --offline --ignore-scripts` succeeded | `/tmp/kora-reach-20261112-0900-clean-install.log` |
| Clean fixture full Root | **58/58 PASS** | `/tmp/kora-reach-20261112-0900-clean-root.log` |
| Clean fixture Reach Node typecheck/build + full serial suite | **287/287 PASS in 50 files** | `/tmp/kora-reach-20261112-0900-clean-node.log` |
| gStack deterministic verification | **223 selected tests executed in 34 files** (Node-selected **165/165 PASS**); overall **UNMAPPED / NOT GREEN** because workflow and pre-existing `docs/checkpoints/packages/*.sha256` lack mapped lanes | `/tmp/kora-reach-20261112-0901-gstack.log` |
| Git status/diff | Local HEAD preserved; `git diff --check` PASS | source worktree |
| Live read-only HTTP | `/health` **200**, `/health/auth` **404** (older unsupported endpoint, **not** OAuth store failure) | 09:00 KST |
| GitHub PR workflow | **0** PR-triggered runs at exact remote SHA `5cfc98a` | read-only GitHub connector |
| Production/auth/policy/browser/GUI/Git publication/model repair/user interruptions | **0** | this run |

## Proven and unverified

- **Proven:** on local disposable Node26.7.0, the authorized P2 Goal retains its binding and verified evidence across **two real Node SIGKILL restarts**. Autonomous receipt recording does not relaunch the original deterministic runner. Stronger than the prior graceful close/restart test.
- **Not proven:** host power outage or forced filesystem power loss, deployed SHA parity, live OAuth tools/list and call, production two-LaunchAgent cutover/rollback, hosted Node22 CI, native unlocked GUI, fresh-chat tool selection or mapped gStack release readiness.
- This one new file adds regression coverage, **not** a production logic change. All findings apply to the local dirty working tree, **not** remote PR #3.

**Next:** identify installed two-service build/state without exposing secrets; test safe service exclusion/rollback in isolated fixtures; pursue approved exact-SHA Node22 CI and real authenticated deployed tool outcomes only after safety gates. Do not operate native GUI on locked/unapproved Macs or rewrite local `ee6748c`.

**Task 86 Implemented — P2 hard-crash Goal regression 1/1, full source and clean offline QC pass; final release BLOCKED.**
