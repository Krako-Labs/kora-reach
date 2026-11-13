# KORA Reach — Reliability Development & QC Checkpoint

Date: 2026-11-10 KST
Worktree: `/Volumes/MSM2-1-DATA/Projects/86_KORA-Reach-Control`
Branch: `feat/verified-control` (existing draft PR #3)
Base before this session: `5cfc98a`
**Status: local candidate updated and tested; NOT committed, pushed, merged, or deployed.**

## Scope and preserved state

The original `/Volumes/MSM2-1-DATA/Projects/KORA-REACH` worktree was already dirty and behind its remote branch. Its existing code and user changes were not overwritten. This work happened in the separately tracked PR #3 worktree; pre-existing `docs/checkpoints/` and packaged fixtures were preserved.

No account or OAuth secrets were output; no policy was changed on a running host; no production process was restarted; no personal Chrome was touched; no public post was made.

## Implemented

1. Reused the existing Access Doctor, file-error mapping, tool-result audit event, and policy diagnostics from prior local work rather than rebuilding them.
2. Access Doctor checks the running mode (not just disk policy), local MCP bearer `tools/list`, target stat/read, and optional explicitly requested read-only shell check / disposable file probe.
3. Access Doctor allows only direct loopback HTTP endpoints with redirects disabled. It cannot send the local bearer token to a remote URL. OAuth readiness reports `pass`, `failed`, or `unsupported` (missing endpoint), not one misleading failure class.
4. Structured error codes distinguish `WORKSPACE_DENIED`, `OS_PERMISSION_DENIED`, `NOT_FOUND`, `NOT_DIRECTORY`; tool success and HTTP transport completion are audited separately.
5. Fresh installer default changed from restricted file roots plus UNSANDBOXED shell allowed, to restricted file roots with shell disabled. A user must explicitly opt in to shell execution. Existing running policies and credentials were not modified.
6. gStack-style adversarial read-only Codex review identified two significant PR #3 defects:
   - effect-claim and background queue metadata not synced before action;
   - `captureDownload` pre-dispatch CDP failure could fall back to an unguarded native click.
   Both paths were fixed: synchronous durable claims and linked plans/queue entries; captureDownload now requires a guarded CDP route and never uses an unguarded native retry.
7. Added regression tests for credential/tool authorization, no token exfiltration, intentional policy denial, result codes, durable claims, and five pre-dispatch download failure modes. Added proposed GitHub macOS/Node22 CI workflow with clean `npm ci` from the package directory.
8. Added developer-facing diagnostic usage and explicit permission boundary docs.

## Executed QC and evidence

- Root CLI `npm run check`: **5/5 PASS**.
- MCP Node `npm run check`: **209/209 PASS** across 36 test files, including TypeScript typecheck and Swift helper build.
- Repeated actual disposable headless Chrome download: **PASS**; expected contents verified, duplicate action suppressed, owned browser clean exit code 0, no signal.
- Actual restart, disconnected work, stub coding repair, independent local verification and original browser work continuation: **PASS**, no model call.
- Locked-console queue and independent browser task while blocked: **PASS** on prior headless locked-session QC.
- Fresh isolated source copy, `npm ci --ignore-scripts` from `apps/reach-node`, `npm run check`: **209/209 PASS**; fresh CLI copy **5/5 PASS**. Fresh test fixture removed after completion.
- `npm audit --omit=dev --prefix apps/reach-node`: **0 known vulnerabilities** at test time.
- Root CLI `npm pack --dry-run --json`: PASS; version 0.1.0, 6 distributable files.
- `git diff --check`: PASS.
- Local MCP health plus authenticated shell tool on MSM2-1/2/3/4: all respond; no changes to running services.

## IMPORTANT live-runtime mismatch

On 2026-11-10, current MSM2-1 service `/health` returned HTTP 200 and version `0.5.0`, effective `full` access, and authenticated file/MCP tools passed. However `/health/auth` returned **404 Not Found**, despite `oauthEnabled=true`. Access Doctor now reports `authReadiness: unsupported`, not `failed` storage. This means live service build is missing OAuth-readiness diagnostic, and **running deployment parity is not certified**. Do NOT misclassify as a credential-store outage or restart production automatically.

## Remaining release gates

1. MSM2-2 still reported console `locked=1`, despite Screen Recording and Accessibility grants. Native post-unlock action, Save sheet, visual focus/occlusion, crash-dialog delayed behavior remain **NOT VERIFIED**; preserve the safety gate. It was idle but locked, so no GUI QC was started.
2. Proposed GitHub workflow is local/uncommitted: PR #3 has **no external CI result**. Run CI on the exact proposed commit before merge.
3. Before changing any deployed service, inspect active managed jobs/browser/restart impact, verify preserved policy/OAuth state and rollback. Avoid disrupting independent user work.
4. Verify true clean upgrade persistence, policy migration, app UI exposure / direct ChatGPT tool-list refresh, and Safari separately. Omit unverified features from a stable release.
5. Conduct a final security review of the exact diff and ensure all files in the release tree are intentionally included. Only commit/push/tag/publish as allowed by applicable user and host release rules.

## Continued autonomous workflow

The dedicated KORA Reach autonomous dev/QC automation is active and should work on this worktree without overlapping an existing writer. Keep independently useful tasks moving even while a GUI is locked. Do not ask for unlock/password merely to run headless QC. Log real evidence; report only meaningful milestones or genuine approval-only security blockers. Stop automation once final gates are satisfied and the release is ready to hand off.
