# Resumable computer control — verification report

KORA Reach can save a UI step, try existing browser and native controls, verify its result, and resume authorized work after the chat disconnects. Optional coding repair reuses the official Codex CLI only after local tests fail.

This change is a **draft release candidate**. Pointer-event fallback is disabled by default. It has not passed final live-window QC.

- [What changed](#what-changed) — the user-facing execution path.
- [Verification](#verification) — automated and actual Mac results.
- [Remaining limits](#remaining-limits) — what is not certified.
- [Reproduce safely](#reproduce-safely) — commands and test boundaries.

<br />

## What changed

Six tools provide discovery, immutable job creation, execution, status reconciliation, scoped screenshots, and optional coding repair. Existing Chrome can attach through an operator-configured loopback CDP port. Native Accessibility provides a fallback for an identified existing window. Discovery does not launch a browser or replace its profile.

A job records its exact app/window, browser origin when applicable, named control, and expected outcome. A file result must match expected text or a SHA-256 digest. An uncertain click is reserved rather than repeated after a lost response. A matching result is checked again when status is requested.

The default keeps reasoning in the user's chat. Optional `repair_once` uses an isolated operator-configured checkout. Local tests run first. The CLI permits at most one Codex escalation for that job. A durable repair process survives a Reach server restart; after successful local verification, the server attempts the original UI step and rechecks its outcome. This is not a guarantee of recovery from every browser, login, OS, or application failure.

<br />

## Verification

Recorded on 2026-11-05. Test pages, browser profiles, files, and native apps were disposable fixtures.

| Check | Result | Scope |
| --- | --- | --- |
| Typecheck, build, native helper compilation | PASS | Latest candidate on Apple Silicon macOS. |
| Reach automated suite | 173 passed | 30 test files; includes the existing regression suite. |
| Root CLI suite | 5 passed | Includes zero escalation when tests already pass. |
| Clean source installation | PASS | Downloaded the pushed branch, extracted a fresh source archive, ran `npm ci`, built native helpers, started the authenticated HTTP MCP server, and completed a real headless-browser download. |
| Real browser download | PASS | Authenticated local fixture, headless Chrome, file content verification, repeated execution suppressed. |
| Background continuation | PASS | Client disconnect and server restart, saved job execution, independent outcome check. |
| Failed queue item | PASS | Malformed saved plan is isolated; a second valid job still completes. |
| Repair continuation | PASS | Stub repair, restart, local tests, automatic original UI resumption. No model usage in this repeat test. |
| Actual Codex repair | PASS in earlier candidate | Official signed-in CLI corrected a failing fixture; local tests and the original browser download were verified. It was not rerun for later native-pointer-only changes. |
| Chrome without CDP | PASS in earlier candidate | Native Accessibility downloaded the file; TextEdit opened it and its text was verified. |
| Unreachable CDP fallback | PASS in earlier candidate | Same existing Chrome window reached through Accessibility. |
| Native button and Save sheet | PASS in earlier candidate | Actual AppKit button and NSSavePanel, verified output file. |
| File evidence boundary cases | PASS | UTF-8 text across chunk boundaries, simultaneous digest/text checks, mismatches, size limit. |
| CPU-only OCR | PASS | Generated text image recognized in approximately 0.66s, including process startup; not a general latency benchmark. |
| Locked session | PASS | Native helper refused dispatch with `session_locked`. |
| Visible-test admission | PASS | No host-specific opt-in: script stops before creating test windows. |
| Visual coordinates and focus recovery | NOT CERTIFIED | Earlier isolated success did not remain reliable during window occlusion. Latest process-targeted dispatch requires a dedicated unlocked-host retest. |

<br />

## Remaining limits

- Pointer events require `KORA_CONTROL_VISUAL_EVENTS=1`. Keep this unset until dedicated live QC passes. Named CDP and Accessibility actions do not require it.
- Earlier visual QC observed an unexpected output file in a covering fixture. Its source was not established. A later run correctly blocked the click. The candidate now targets pointer events to the selected process instead of the desktop-wide event stream; that change still requires actual GUI verification.
- `allowFocus` is opt-in per plan. It can bring the exact target window forward before capturing a new frame. A caller-supplied coordinate frame never changes focus. Focus recovery is not yet certified.
- The frame token includes image pixels, window ID, and process ID. A changed frame rejects coordinates. Dynamic content may require another screenshot.
- Safari discovery and routing have not received an actual Safari end-to-end test.
- macOS Accessibility, Screen Recording, and browser Automation permissions still apply. Reach cannot unlock the user's session or satisfy a login/permission prompt automatically.
- Background recovery requires the Reach service to be running. Host reboot recovery, packaged-release installation, release signing, and production ChatGPT exposure of the new tools are not certified by these tests.
- A code patch that needs an application rebuild or deployment may require additional work. A repair success does not itself certify the original task.
- File evidence/download handling is bounded to 32MiB. A matched text string is weaker evidence than a full digest; choose the appropriate expected outcome.
- These checks do not establish reliability on arbitrary websites or unrestricted whole-desktop workflows.

<br />

## Reproduce safely

From `apps/reach-node`:

```sh
npm ci
npm run check
node scripts/qc-control-mac.mjs --headless
node scripts/qc-control-mac.mjs --repair --repair-stub --restart --unattended
```

The last command tests continuation with a stub repair executable. To test the real Codex path, omit `--repair-stub`; this can consume the signed-in account's allowance.

Visible tests must use a dedicated idle Mac. Never use an active user's desktop or an exhibition/demo computer. They require both a matching `KORA_UI_QC_HOST` environment value and `--allow-visible-ui`. Available scenarios include `--native-only`, `--cdp-down`, `--app`, `--sheet`, and `--visual`. The visual scenario explicitly enables experimental pointer events for its disposable test only.

No production Reach service was restarted or updated for this feature. Do not treat this report as deployment approval or as a successful live-window release gate.
