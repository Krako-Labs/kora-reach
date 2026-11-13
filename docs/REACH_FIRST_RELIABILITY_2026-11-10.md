# KORA Reach — Reach-First Reliability Research & Implementation Contract

Date: 2026-11-10
Status: Research and implementation handoff; no new release claim.
Active candidate: Krako-Labs/kora-reach, feat/verified-control, PR #3.
One active writer: existing KORA Reach dev/QC automation on canonical MSM2-1.

## Decision

The user's main failure is not just Chrome access. Even when Reach is connected and authorized, ChatGPT sometimes does not choose it and says a task is impossible. When reminded to use Reach, the same task can proceed. The product goal is to eliminate such avoidable user intervention, not to grant unlimited system access.

### Real failure layers

| Layer | Observed cause | Required fix |
| --- | --- | --- |
| Chat/tool routing | Model did not select Reach; newly registered tools can be missing from a stale host-side tool menu | Stable first-class capability/preflight entry and fresh-chat Reach-first evaluation; server alone cannot force model selection |
| MCP auth and transport | Healthy HTTP 200 while OAuth credential lookup stalls; protocol version mismatch | Separate listener, OAuth, authenticated tool-list, actual tool-outcome checks |
| File policy | Restricted direct file roots deny project volumes while independently authorized shell may work | Per-operation effective-policy diagnostics, no policy bypass |
| macOS | TCC permissions depend on the executable/process; locked console disables GUI input | Distinguish headless and GUI capabilities, retain blocked jobs, no lock bypass |
| Browser | Agent-managed Chrome profile differs from user's logged-in Chrome; CDP attach can fail | Explicit chosen profile/session, reattach before relaunch, scoped AX fallback, no cookie copying |
| Job execution | Disconnect after UI effect leaves uncertain result | Durable effect claim, evidence reconciliation and no blind replays |

Evidence: docs/VERIFIED_CONTROL_QC.md; existing Access Doctor; OAuth recovery PR #1 and candidate PR #3. No measured incident frequency exists. Do not invent it.

## Dots and Muse reference

OpenAI Dots maintains its own cloud computer/browser and memory across tasks. Optional connected local computers can be reused between tasks while their desktop application is open. Meta Muse uses a persistent dedicated Secure VM/browser with saved connected-app permissions and background work. Both still enforce approvals. We should copy persistent *user experience*, not build a cloud VM or claim that macOS permissions can be bypassed.

Official:
- https://learn.chatgpt.com/docs/dots
- https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- https://ai.meta.com/muse/
- https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent

## OSS: choose reuse before building

| Priority | OSS | What to borrow | Decision |
| --- | --- | --- | --- |
| P0 | OpenClaw (MIT) | Doctor: live service-vs-package mismatch, Chrome readiness, OAuth state, persistent approved pairing, capped reconnect backoff, typed non-retryable denials | Adapt small logic/UX patterns in Reach Node; do NOT import entire gateway |
| P0 | Playwright (Apache-2.0; already installed) | Existing-browser CDP, tab identity, persistent authenticated contexts, DOM checks | Reuse current dependency and add capability diagnostics; do not create another browser engine |
| P0 experiment | Browser Use (MIT) | Persistent local browser daemon, reattachment, first-time browser login reuse, single browser lane, browser doctor | Compare against Reach's current Playwright in isolated Chrome only; use adapter or small patterns only if proven better; do not import Python agent/model loop by default |
| P1 | OpenHands SDK | Risk-based confirmation and resumable conversations | Adapt policy patterns; keep existing agent runtime |
| P1 | Temporal / Prefect | Activity-level retry and durable state instead of retrying whole workflow | Borrow semantics using existing Reach job ledger; do not deploy separate workflow server |
| Deferred | Muse/Dots cloud-computer model | Always-on isolated cloud machine | Outside local-first v0; wait for actual user demand |

References:
- https://docs.openclaw.ai/cli/doctor
- https://docs.openclaw.ai/gateway/doctor/provider-repairs
- https://docs.openclaw.ai/web/control-ui/connect-and-pair
- https://docs.openclaw.ai/gateway/protocol/auth
- https://playwright.dev/docs/auth
- https://github.com/browser-use/browser-use/blob/main/skills/browser-use/SKILL.md
- https://github.com/browser-use/browser-use/blob/main/skills/cloud/references/sessions.md
- https://docs.temporal.io/encyclopedia/retry-policies
- https://github.com/OpenHands/software-agent-sdk

## Required first-run experience

Install, select approved workspaces, connect ChatGPT MCP, bind a default Mac, grant actual macOS TCC to correct process when needed, select a permitted existing Chrome profile, sign in once, run a real authenticated tool smoke test, save approval and profile identity. Do not require users to configure CDP, workspace paths and shell separately on every task. Do not silently authorize new scopes.

## Required every-task experience

1. Check host-agent availability of Reach in the current tool context. Node cannot see or force a tool call that the ChatGPT host did not expose/select.
2. Read-only preflight: selected Mac, transport, OAuth readiness, authenticated tools/list, effective policy, target file metadata, GUI lock and browser/profile capability.
3. Use existing user-approved path: local deterministic operation first, then attached CDP, scoped Accessibility, opt-in visual when appropriate. Distinguish read actions, privileged actions and guarded downloads.
4. For transient pre-effect failures retry with capped exponential backoff plus jitter. For an explicit security denial or missing approval STOP rather than changing identity or escaping through shell.
5. Save progress and keep independently authorized tasks running. Locked desktop is WAITING_FOR_UNLOCK, not 'Reach is broken'.
6. Verify the original desired outcome; do not repeat uncertain clicks, downloads, payments or submissions.
7. Report only the minimum user action when security/login approval is actually necessary.

## State UI, not one green Connected badge

Separate: READY (files/commands/browser/GUI per capability), RECOVERING, WAITING_FOR_UNLOCK, NEEDS_APPROVAL (exact scope), NEEDS_WEBSITE_LOGIN, POLICY_DENIED, OUTCOME_UNCERTAIN, VERIFIED_DONE.

## P0 implementation and QC gates

A. Stable discoverable read-only Reach readiness surface with exact runtime/build identity, target Mac, capabilities and typed recovery hints. A Host-side Reach-first tool-selection evaluation across fresh ChatGPT conversations is required. Do not claim perfect model selection based on Node unit tests.

B. Extend Access Doctor: active service vs installed package, OAuth 404 unsupported vs 503 storage failure, real MCP tool outcome, approved file roots, macOS TCC, selected Chrome session, browser route, and lock. One actionable diagnostic; no secrets. Exercise all historic failures.

C. Safe self-recovery: continue when disconnected, reattach browser and reuse approved identity, bounded backoff for temporary errors; retry only before effect dispatch. Never modify policy or browser accounts automatically. Keep existing durable queue and replay-protection work.

D. First-run onboarding and persisted preferences for selected computer, approved workspace, and permitted browser. On new access, ask once for minimum scope. No new dashboard/backend required.

E. Metrics: first-attempt Reach tool-selection rate, completion verified, automatic recoveries, interventions per completed task, retries blocked on security, time-to-first-task. Proposed target, not measured: 90%+ of supported real-user tasks complete without unnecessary intervention, zero unapproved privilege expansion.

## Test plan

Use 10+ fresh ChatGPT conversations to test first-choice Reach selection and tool exposure. Run a 20-task cross-machine scenario set including file denial, active service but stale auth, Chrome CDP failure, attached existing-profile tab, locked Mac, server restart, auth revocation and uncertain click. Distinguish client tool-selection failure from transport or Node fault. Record real results, not simulated claims. Browser-use comparison on disposable profiles only; do not export real user cookies.

## Constraints

Do not build a cloud VM, a new macOS UI, a second agent/runtime, or a full OpenClaw/Browser Use/Temporal dependency without measured activation benefit. Existing GitHub public source should remain distinct from Krako Reach. Respect macOS TCC, ChatGPT approvals, OAuth and intentional WorkspacePolicy denies. Preserve code licenses/notices if any actual OSS code is copied. Avoid simultaneous writers; existing hourly automation owns implementation work.

## Immediate action

Finish PR #3 safety/reliability QC, then build the smallest Reach-first capability preflight and first-use canary. Prioritize reducing 'can't access' false refusals over adding more Chrome click methods. Keep launch/marketing secondary until measured user flow improves.
