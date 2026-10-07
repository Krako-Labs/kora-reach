# KORA Reach v0.1.0

**AI automation without token anxiety.**

This is the first public release of KORA Reach: a deterministic-first local agent that keeps routine work on your computer and escalates to frontier reasoning only when local execution cannot finish the task.

## Included

- Fix failing tests: detect and run tests locally first, escalate to the separately installed OpenAI Codex CLI only after a real failure, then independently rerun tests.
- Organize a folder and identify duplicates: hashing and organization stay local; duplicate files are never deleted; Git repositories are protected from file moves.
- Keep working until tests pass: verify, escalate only if needed, verify again, bounded by the configured round limit.
- Execution reporting for local, deterministic, cached/reused, and frontier-escalation actions.
- Local JSON run traces and kora doctor.
- Zero runtime npm dependencies in the KORA core.

## Verified before release

The primary coding demo was run end-to-end on MSM2-1 against a real failing repository fixture:

1. local npm test failed;
2. KORA escalated once to Codex signed in with ChatGPT;
3. Codex made the one-line fix;
4. KORA independently reran npm test;
5. the test passed;
6. an additional external verification run also passed.

Observed KORA report:

    Total KORA actions             6
    Local operations               2
    Deterministic routing          3
    Cached / reused                0
    Frontier escalations           1

    83% handled without frontier-model escalation

A frontier escalation is one KORA handoff to the frontier agent runtime, not a claim about the number of provider-internal model turns.

## Model access

v0 uses the official OpenAI Codex CLI as the optional frontier coding runtime. Codex can be signed in with ChatGPT. Applicable plan limits and provider terms still apply.

KORA Reach does not claim unlimited usage, bypass provider limits, use private ChatGPT backend endpoints, or expose a generic subscription-to-API proxy.

## Intentionally not included

No GUI, dashboard, hosted account backend, billing, generalized plugin framework, enterprise console, or multi-agent architecture. Those are postponed until user pull justifies them.
