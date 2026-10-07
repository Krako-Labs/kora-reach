# Launch copy

## Hacker News

Title:

Show HN: KORA Reach - run a local AI agent without wasting model calls

Post:

KORA Reach is an open-source local agent that tries not to use a frontier model by default.

The loop is intentionally simple:

task -> deterministic/local work -> verify -> frontier reasoning only if needed -> verify again

For the coding demo, KORA runs the repo tests locally first. If they already pass, there is no frontier escalation. If they fail, it escalates to the official Codex CLI, then independently reruns the tests. For file automation, hashing, duplicate detection, and organization stay local.

At the end it prints execution stats so you can see how many KORA actions stayed off the frontier path.

The first release is intentionally small: coding, file organization and duplicates, and keep working until tests pass. No dashboard or multi-agent framework yet.

I would especially like feedback on which agent workflows waste the most inference today, and which deterministic steps you would want KORA to recognize next.

## X

AI automation without token anxiety.

I just open-sourced KORA Reach: a local agent that does deterministic work first and escalates to frontier reasoning only when it actually needs intelligence.

kora reach "Fix the failing tests in this repo"

It runs tests locally -> escalates only on failure -> verifies again -> shows how much work avoided frontier escalation.

First release is deliberately small. Code, files, long-running test repair. No dashboard.

## Reddit

Title:

I built a deterministic-first local agent that only escalates to a frontier model when needed

Body:

I have been working on KORA Reach, a small OSS CLI around a simple idea: local automation should not turn every step into an LLM call.

For coding tasks it detects and runs the existing test command locally. Only if verification fails does it escalate to a frontier coding agent, then KORA reruns the tests itself. For file tasks, hashing, duplicate detection, and organization are local.

The CLI shows execution stats at the end, including frontier escalations and the percentage of KORA actions handled without frontier-model escalation.

The v0 scope is intentionally only three demos:

1. Fix failing tests.
2. Organize a folder and identify duplicates.
3. Keep working until tests pass.

I am looking for critical feedback from people using coding and local agents: where are you seeing the most obviously unnecessary model usage, and what should be deterministic instead?
