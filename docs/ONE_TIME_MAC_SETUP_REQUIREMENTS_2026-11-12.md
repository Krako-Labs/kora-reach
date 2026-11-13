# KORA Reach — One-Time Mac Setup and Self-Healing Onboarding

Date: 2026-11-12 KST
Status: Product and engineering decision; not implemented or deployed by this note.
Project: Krako-Labs/kora-reach (separate from Krako-Labs/krako-reach)
Canonical writer: MSM2-1
Product promise: **Set up once. Work continuously. Ask only for genuinely new approvals.**

## Why this is needed

Actual November 12 MSM2-4 user/GUI canary disproved a stale false-lock diagnosis: a remote Screen Sharing session showed an unlocked desktop and the direct GUI preflight said READY. Native temporary AppKit button/file, Save sheet and isolated Chrome GUI control without CDP all passed. Errors observed earlier were:
- A local Reach workspace policy correctly denied an arbitrary /tmp test working directory.
- npm offline install failed from a missing cache object.
- Incomplete fixture source transfer omitted required root CLI/scripts/tests; a later full copy passed Node24 292/292, root 58/58.
- A visible QC command was called from the wrong cwd, so its own `test/helpers/control-app.swift` was absent; correcting cwd yielded a PASS.
- Prior false GUI-lock judgement relied on a single session flag rather than a real Mac GUI capability test.
- A first incomplete-suite run emitted a Node24/undici socket error, not reproduced by final full 292-test run.

These are multiple *distinct* failure layers. Changing macOS privacy settings will not fix a bad cwd, missing dependencies, stale tool catalog, source/runtime mismatch or unknown browser profile.

## Apple platform security boundary (verified official docs)

- macOS TCC grants are scoped to an app/process code identity. Signed stable designated requirements allow grant continuity after updates; ad-hoc/unsigned test builds can repeat prompts. Source: https://developer.apple.com/documentation/Technotes/tn3127-inside-code-signing-requirements
- A normal local installer cannot simply auto-approve Screen Recording / Accessibility / Automation or bypass a login/lock screen. Use supported user-visible macOS permission flows; never mutate TCC.db or use undocumented bypasses. `tccutil reset` REMOVES approvals; it does not grant them. Source: https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos
- Approved MDM can preconfigure some Privacy Preferences (such as Accessibility and some file scopes), but a PPPC profile requires user-approved device management and cannot be manually installed for that purpose. ScreenCapture policy cannot silently grant capture. This is an optional advanced managed-device path, NOT a consumer/v0 installer dependency. Sources:
  https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol
  https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.TCC.configuration-profile-policy.yaml
- Never disable screen locking, FileVault, Gatekeeper, SIP, OS authentication or global TCC protections by default. GUI-dependent steps wait for a normally unlocked authenticated console; deterministic/headless jobs continue.

## Core UX contract

One native/simple CLI entrypoint, e.g. `kora setup` / `kora doctor`, with no Docker, SaaS requirement, privileged root daemon or generic MDM requirement.

**One-time setup flow**
1. Verify supported macOS, Node dependency or bundled signed runtime, package build identity, disk and network prerequisites. Show only actionable failures.
2. Generate durable local node identity, immutable policy and private token, select allowed workspaces and permitted browser identity. Preserve existing installations and prior approval state on upgrade.
3. Configure an owner-user launchd agent and restart policy with an actual authenticated health/tool smoke test; detect already running old agent or competing LaunchAgent before claiming success. Never blindly restart a live node.
4. Request needed macOS approvals through Apple's supported prompts/System Settings UI. Use a stable signed executable identity for desktop privileges so users do not have to approve every update. Display exact requesting app identity and human action; never request unnecessary Full Disk Access as the default.
5. Run real **capability-specific** probes under the same service process that will execute actions: file/stat/write inside approved temp workspace, process command, authenticated MCP tools/list/call, attached browser/isolated-profile session, screen capture and semantic AX on a disposable window if unlocked. Don't confuse a grant preflight with actual success; distinguish locked vs unknown vs inaccessible.
6. Persist nonsecret preferences, not general login credentials, and print a capability matrix plus a verified final canary outcome.

**Runtime**
- Separate `HEALTHY_HTTP`, `AUTH_READY`, `MCP_TOOLS_VISIBLE`, `FILES_READY`, `SHELL_ALLOWED`, `BROWSER_ATTACHED`, `GUI_READY`, `WAITING_FOR_UNLOCK`, `NEEDS_WEBSITE_LOGIN`, `NEEDS_APPROVAL`, `POLICY_DENIED`, `OUTCOME_UNCERTAIN`.
- Auto-recover transient pre-effect outages with bounded retries and identity validation. Never escape deliberate file/shell policy via another tool; never replay an uncertain click.
- When GUI is temporarily locked, persist UI task and continue authorized headless work. Re-check exact session and target at dispatch; do not force unlock.
- An old deployed service missing `/health/auth` is *unsupported/version mismatch*, not proof of OAuth storage failure.
- Keep UI error guidance to one exact user action only when genuinely needed.

## Explicit work split

**Installer can safely automate**: local directories, pinned dependencies/build, owner launchd agent, immutable settings, allowed workspace policy, app-owned temporary browser profile, read-only checks, secure browser attach when already authorized, bounded task-scoped `caffeinate` while visible QC (does not prevent user lock), retries and verified upgrade staging.

**Requires user macOS approval**: TCC Screen Recording, Accessibility, Automation/AppleEvents as required; website MFA/login; operating system unlocking; new sensitive workspace scope.

**Should not change at all by default**: lock password requirement, FileVault, SIP, Gatekeeper, global sleep/screen-lock policies, unrelated app permissions, personal Chrome profile/session, old KRAKO Reach service.

## Prioritized next implementation

P0: unify current setup-mac.mjs, scripts/access-doctor.mjs, reach_preflight and app runtime build identity into a common capability report. Fix false-lock detection and record the *same session and identity* that will act; one successful native AppKit canary is worth more than 10 green preflight booleans. Reuse existing code; do not add new onboarding framework/GUI.

P1: user-facing initial permission wizard to open approved System Settings pane or native Apple request once; save only that approval is granted after re-testing. Match the code-signing identity that the production service uses. Distinguish user-grant from privileged process access.

P1: no-disruption installer upgrade preserving OAuth, node ID, policy and launch agent, with exclusive maintenance gate and rollback; no auto live rollout until proven.

P2: after onboarding canary, test a fresh ChatGPT session's first-tool selection separately from authenticated server calls; Node cannot force a model to select an MCP connector it didn't invoke.

## Acceptance gates

- Brand new Mac installation: one guided setup, no user writing commands beyond initial install, all supported local tasks verified end to end.
- Two Mac app versions signed under stable designated requirement: established user grants survive upgrade. Do not claim this for unsigned prototypes.
- When a Mac is genuinely locked, only GUI step waits and is resumed after legitimate unlock; no false failure after Screen Sharing.
- Normal health + stale auth + different browser profile produce different actionable statuses.
- Existing service is not restarted until explicit maintenance admission and rollback proves safe; no config/credential loss.
- No false 'READY' from a preflight-only TCC check; no silent security expansion or global system protection weakening.
- Track installation user steps, first verified goal success, manual prompts per goal, unnecessary intervention rate, and duplicate-effect count.

## Scope discipline

Do not implement a polished macOS settings app, enterprise policy server, MDM manager, generic plugin architecture, or full multi-agent platform solely for onboarding. Start with a CLI-first single guided setup+doctor flow. Existing isolated candidate on MSM2-4 is where no-risk canary QC has passed; do not overwrite live service on port 3208 or personal Chrome. Agent Handoff remains a separate project.

## Implementation caveat

This is a research and engineering decision record. No global Mac settings changed, user-granted permissions forced, live Node restarted, Git commit or push performed as part of this note.
