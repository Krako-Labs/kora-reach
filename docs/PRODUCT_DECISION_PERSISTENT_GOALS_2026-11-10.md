# KORA Reach — Persistent Goals vs Multi-Agent Product Decision
Date: 2026-11-10 KST
Status: Product recommendation, not implementation approval or release PASS.
Source: gStack office-hours + plan-ceo-review and independent gStack devex review, both read-only on MSM2-1. Public-source review: OpenAI Dots, Meta Muse, gstack/gbrain, LangGraph/Letta/Temporal, user-owned Agent Handoff repo.

## Decision
**Build persistent GOAL execution into the KORA Reach core. Keep human/agent Handoff and multi-agent orchestration as optional integrations, with Agent Handoff kept in its own hkalbertkim/agent-handoff repository.**

Do not build a new cloud VM, SaaS, multi-agent swarm, generalized agent registry, or a second independent orchestration engine before real user pull. Continue current PR #3 reliability gates first.

## Why
The repeated real user failure is needing to say "try KORA Reach" after ChatGPT has already said a task cannot run. This can be host tool-nonselection, MCP auth, workspace policy, Chrome session identity, TCC, or locked GUI. Adding worker agents does not repair those failures. It creates more identities, permissions, retries and coordination decisions.

OpenAI Dots and Meta Muse demonstrate persistent goal ownership and saved scoped permission rules. Multi-agent internals are not the user's purchased outcome. The actual outcome is: **tell it once, it continues, it asks only when new authorization or a real decision is required, and it verifies completion.** KORA's wedge remains local user-owned computers, deterministic execution, provider-neutral entrypoints and transparent model handoff counts.

## gStack office-hours: six forcing questions
- Demand: first-person, high-frequency interruption problem is demonstrated; third-party multi-agent demand is unverified.
- Status quo: manual tool reminding, repeated access diagnosis, Chrome reconnect, chat recap, completion checking.
- Desperate user: developer working all day through ChatGPT on multiple personal Macs.
- Narrowest wedge: one pre-approved goal persists across chat disconnect and node restart; recovers autonomously and reports evidence.
- Surprise: failure is frequently agent/host tool selection and execution boundaries, not model intelligence.
- Future-fit: durable local effect ledger, approved capabilities, multi-Mac identity, evidence, recovery and least-privilege actions are durable differentiation; agent count is not.

## Alternatives (ranked)
1. **Persistent single-goal Reach core + optional later Handoff integration.** Recommended. Lowest new operations burden and reuse of current Reach code. Known limitation: Node cannot force ChatGPT to select tools it never calls.
2. Two-role planner/executor integrated in core. Defer until single-executor failure cases show a measurable benefit from specialized second agent.
3. Full multi-agent platform as Reach core. Reject for v0; grows auth, memory, execution and attack surface without proof of adoption.

## Product boundary
Reach core:
- Durable Goal Envelope: goal ID, acceptance criteria, selected Mac, workspace, Chrome session identity, allowed actions, current step, blocker, time/budget and evidence.
- Stable `reach_preflight` or equivalent read-only MCP tool: effective runtime/build version, authenticated tool capability, policy/TCC/browser/GUI state and retryability. Separate host-selection success from Reach-execution success.
- Minimal Project State: approved decisions, constraints, next actions, outcome summaries and provenance, not full raw transcript; keep credential/approval grants outside shared knowledge.
- Durable continuation: safe retry, cached deterministic actions, exact effect reservation, evidence-first recovery and restart.
- User control: capability-scoped, revocable grants tied to executor/device/origin/action class; no automatic elevation or broad inheritance on handoff.
- One goal-based user interface across ChatGPT, CLI and Console, not exposed agent/job/session graph.

Optional addon:
- Specialist coding/reviewer agents only when a measured blocked goal benefits, using the same goal/approval/evidence protocol.
- Separate `hkalbertkim/agent-handoff`: reuse the proven human controller/observer, SSE event feed, server-enforced 403 and constraints; do not misrepresent it as distributed persistent AI-agent handoff.
- Handoff server owns role assignments and policy; Reach owns node execution and file evidence. A Reach shell route must not bypass Handoff's 403.

## First-run and continuing experience
One-time: install Mac node, choose default Mac/workspace, connect ChatGPT, choose permitted Chrome identity, approve precise capabilities, pass a real authenticated tool smoke test.

Every request: host chooses Reach (a host-side problem that must be tested) -> Reach preflight -> persist goal -> local action -> recover/retry only safe states -> verify original acceptance condition -> report result. A locked desktop queues native work and permits independently authorized headless actions.

Intervention only for new scope, TCC/OS login lock, MFA/CAPTCHA, revoked authentication, risky irreversible external actions, genuinely uncertain side effects or material judgement. Do not promise zero prompts regardless of security.

## Five highest product release blockers from gStack devex
1. No measured ChatGPT first-tool selection and false refusal rate; Reach Node can't observe calls the host never makes.
2. No single, small read-only Reach preflight, while broad MCP tool surface burdens tool selection.
3. Existing installer refuses configured installations; need idempotent upgrade that preserves policy/OAuth/node identity.
4. Source/deployed version drift (actual 2026-11-10 MSM2-1 `/health` OK, `/health/auth` 404); need runtime build/tool-catalog identity.
5. Insufficient stable goal-to-Mac/Chrome-profile/policy binding and safe failover contract.

## 48-hour spike (after existing release gates, not concurrently)
0–8h: persist a goal envelope and outcome in existing Reach job storage.
8–20h: cross-chat goal ID/status/resume and typed blockers; no new model inference for status.
20–32h: capability check on two Macs, only read-only/idempotent failover.
32–48h: realistic 10-scenario user-intervention and crash/recovery test. No Handoff product rewrite.

## 14-day proof gates, not claims
Days 1–3: Goal schema, effect/evidence and blockers.
Days 4–6: one-time onboarding and preflight.
Days 7–9: OAuth/Chrome/resume/restart failure recovery.
Days 10–11: cross-chat goal recall with selective memory.
Days 12–13: measure 10+ new ChatGPT chats and 20 task scenarios across selected Macs.
Day 14: decide if specialist worker/Handoff adds measurable completion benefit.

Suggested targets (not observed): at least 18 verified completions out of 20 supported scenarios, median unnecessary interventions zero, no duplicate external effects or approval bypass. Track initial host selection separately.

## OSS reuse
- Existing Playwright CDP + macOS AX + Node job/effect/durability code first.
- Adapt OpenClaw connection doctor/reconnect patterns; do not import entire gateway.
- GBrain and Letta demonstrate persistent shared knowledge; GBrain explicitly separates knowledge from runtime grants/state. Compare existing project-state storage before installing a new database.
- Temporal/LangGraph demonstrate checkpoint and evidence-first resumption, but importing large orchestration stacks into v0 is not justified.
- Existing Agent Handoff remains independently marketable to multi-person collaboration use cases. Keep repo and policies separate.

## Distribution positioning
**KORA Reach keeps goals moving after the chat ends.**
Configure your Mac, workspace, and browser once. Reach continues authorized local work, recovers from ordinary failures, and asks only when your permission is genuinely needed. Independent verification before "done."

Do not market as fully autonomous multi-agent, never prompting, bypassing login/provider limits, or literally unlimited model use.

## Evidence
- https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
- https://ai.meta.com/muse/
- https://github.com/garrytan/gstack/blob/main/USING_GBRAIN_WITH_GSTACK.md
- https://github.com/garrytan/gbrain/blob/master/docs/guides/memory-boundaries.md
- https://docs.letta.com/tutorials/attaching-detaching-blocks/
- https://docs.temporal.io/ai/featured/memory-state-stripe
- https://github.com/hkalbertkim/agent-handoff
- Local `docs/REACH_FIRST_RELIABILITY_2026-11-10.md`, `docs/VERIFIED_CONTROL_QC.md`
