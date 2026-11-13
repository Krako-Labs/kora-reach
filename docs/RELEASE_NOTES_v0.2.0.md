# KORA Reach v0.2.0

**Use the AI plan and computers you already have.**

This source release retains the deterministic-first standalone CLI and adds an **experimental, separately configured Mac-control MCP node**, resumable computer control, and limited Persistent Goals.

## Included

- **CLI:** detect and run repository tests, optionally perform bounded Codex coding repairs, organize files, identify duplicates and verify results. Execution statistics distinguish local operations, deterministic routing, reuse and frontier-agent handoffs.
- **Mac-control MCP preview:** authenticated user-owned Mac node with workspace policy, Chrome/CDP and native Accessibility tools, diagnostics, a local console and resumable background actions.
- **Limited Persistent Goals preview:** bind an already approved detached job to immutable acceptance criteria; query its state from a new authenticated session; verify file SHA-256 evidence and write a durable receipt; optionally continue evidence observation without replaying an uncertain side effect.
- **Reliability work:** bounded waits, typed permission and auth diagnostics, explicit failure classifications, safe update staging and rollback in isolated fixtures.
- **Documentation:** updated README hero, colored feature labels, a simple 16:9 PNG architecture diagram and detailed setup instructions.

## Verified before publication

- macOS Node22 hosted GitHub Actions for the pre-release PR source; the release commit must pass its own new hosted checks.
- Local CLI and Reach Node tests, TypeScript checks, and a real isolated candidate startup.
- MSM2-4 independent disposable AppKit window/button, Save sheet, browser and headless download checks without changing the user's Chrome account or live node.
- Crash/restart and no-duplicate-effect fixture tests for the limited, approved Goal functionality.

These results are not general real-user completion statistics or a production rollout certification.

## Known limitations

- **Provider limits apply.** No AI subscription usage limit, billing rule, or provider term is bypassed.
- **Not general multi-agent autonomy.** No general automatic cross-device scheduling, arbitrary future planning, or complete KORA Core runtime integration is claimed.
- **Mac GUI requires permission and an eligible session.** Accessibility, Screen Recording, authentication, website login, and screen unlocking may require real user action.
- **This release does not upgrade connected computers.** Running-service promotion, credential preservation, rollback, and source/deployed-version parity have separate safety gates.
- The CLI can run offline for deterministic local tasks; optional Codex and authenticated MCP remote connectivity require user configuration.

## Install

Standalone CLI (Node.js 22.12+):

```sh
npm install -g https://github.com/Krako-Labs/kora-reach.git#v0.2.0
kora doctor
kora reach "Fix the failing tests in this repo" --frontier none
```

Mac-control preview installation and limitations are in [ChatGPT-first MCP setup](CHATGPT_FIRST_MCP.md) and [Phase A Mac installation](PHASE_A_INSTALL.md). Never expose an unauthenticated local node publicly.

**License:** CLI Apache-2.0; separately packaged Reach Node MIT.
