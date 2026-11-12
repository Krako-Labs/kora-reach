# Reach Node: safe candidate preparation (P1)

**Status:** local staging only. No production activation, launchd changes, authentication changes or live service restarts. This is not a completed updater or a release approval.

## Purpose

The initial `setup-mac.mjs` deliberately refuses an already configured Mac. Re-running it would not be a safe upgrade: it generates a token, policy, service launcher and state directory. Existing users must not lose their MCP authorization, selected Chrome identity, node ID, or saved OAuth clients.

`prepare-node-upgrade.mjs` handles only the safe first phase: validate a committed, source-identified Node package and install its production dependencies into a **new isolated release directory**. It never copies user state, switches the active Node, changes policy, launches Chrome or sends a signal to launchd. Activation remains a distinct release gate.

## Candidate contract

Use `scripts/package-node.mjs` from a **clean source checkout** with a reviewed commit. The output archive must have its SHA-256 sidecar verified independently before extraction. Confirm the archive was produced locally from trusted source, and inspect entries for path escapes or unexpected links. Extract it into a disposable directory. The candidate must contain `BUILD.json` with a full 40-character source commit, `nodePackageVersion`, `productionCertified:false`, and the expected compiled Node entry point. Older archives without version identity are rejected.

The checker reads the existing `settings.json` only to verify that the chosen state belongs to the intended installation. It checks the token's *file permissions*, not its secret bytes. It refuses a destination inside the live state, candidate or current source, including symlinked ancestors. It copies only `BUILD.json`, the Node package manifest/lockfile, and compiled `dist` output. It rejects source symlinks and special files.

## Preparation commands

From the reviewed Reach source checkout, with the **extracted** candidate directory and deliberate separate install root:

```sh
node scripts/prepare-node-upgrade.mjs \
  --candidate-dir /absolute/disposable/kora-reach-node \
  --state-dir "$HOME/.local/share/kora-reach" \
  --install-root "$HOME/.local/share/kora-reach-releases"
```

This is a read-only `plan_only` check. Add `--stage` to install dependencies and atomically publish a new versioned **staged** directory. Add `--offline` when dependencies are already available in the npm cache and network access must be avoided.

If dependency installation fails or the package changes while copying, the script removes only its own temporary stage. Previous releases and every user state file remain unchanged. Repeated staging checks an immutable payload digest, compiled output and installed dependency-tree digest; it will not silently overwrite a changed release.

## Approval and rollback boundary

The tool **does not activate** staged code. Existing `start.sh`, `settings.json`, policy, OAuth storage, node-state registry and saved Chrome profile remain untouched; no live-state backup is needed for this staging phase. A future activation procedure must first establish an explicit maintenance window and confirm no active jobs, back up the existing launcher/settings and relevant state with owner-only permissions, verify the candidate's runtime build and authenticated MCP tool behavior, then switch and verify the service with a tested rollback. Do not auto-activate a new source tree from a running user installation.

The current local candidate is not yet in GitHub CI or deployed. Node22 hosted CI, runtime parity, physical GUI dispatch and user-level tool selection remain independent release gates. The known unexpected local-only commit `ee6748c` must not be pushed or rewritten automatically.


## Candidate path and identity hardening (2026-11-10 23:15 KST)

The stage loader refuses a forged version that is not a bounded semver-style release name. It rejects symlinked candidate parent directories, including `dist` itself, before inspecting compiled code. It also resolves the current `settings.nodeDir` physically before checking whether the target staging directory overlaps the active node. These checks are fail-closed; they do not change production settings or running processes. Three isolated negative regressions plus the complete local suites passed. See `docs/checkpoints/2026-11-10_2315_P1_STAGE_INPUT_BOUNDARY_QC.md`.

<br />

## Isolated switch/rollback exercise (2026-11-11)

The separate `scripts/simulate-node-upgrade-switch.mjs` is **fixture-only test infrastructure**, not an activator. Its entrypoint is an imported test helper, not an install command. It refuses state paths outside a marked, physical temporary fixture and does not call launchd, change an installed service or invoke a model. The test creates a staged release using `prepare-node-upgrade.mjs`, then temporarily switches only the fixture's `settings.json` Node target and launcher `cd` line. It restores their exact original bytes and launcher file mode, and confirms policy, token, OAuth state, node ID and Chrome selection remain unchanged.

The exercise uses an exclusive journal directory, owner-only copies of the two original files, staged content fingerprint verification, per-file atomic replacement and automatic rollback. The journal also records old and expected new hashes for independent fixture recovery. Tests inject failures after the first and second file replacements and confirm restoration. A concurrent modification is **not** overwritten during rollback: it leaves the fixture journal for investigation. Forged/missing fixture roots, escaped stage paths, changed staged executables and concurrent journals fail closed. Those injected failures are **in-process fixture** results. A real process kill or power loss does not execute JavaScript `finally`. A new **separate-process fixture-only** recovery helper reads the persisted journal and verifies backup hashes and expected post-switch file hashes before restoring. Tests kill an isolated Node child with `SIGKILL` after either file replacement, then use a second process to recover the original bytes and file modes. A corrupt backup fails closed. This does **not** prove physical power-loss durability or recovery of a live launchd service.

This simulator is deliberately not permission to activate a staged candidate. Before production, add an independently reviewable idle-job gate, verified source SHA/CI, on-disk recoverable journal with verified backup hashes and explicit resume handling, authenticated compiled-runtime smoke, and tested launcher/service rollback during a planned maintenance window. Keep existing access policy and OAuth/browser identity unchanged; never switch a live installation through this fixture helper.


## Restart-impact is not a maintenance lock (2026-11-11)

The candidate's authenticated `/api/reach/restart-impact` response is a read-only, non-atomic observation. It now includes active MCP request count, running durable jobs even without `runId`, browser probe availability, and explicit `idleConfirmed:false`. Browser inspection failure is reported as unknown, not as an idle browser. Do **not** use an empty snapshot to automatically restart launchd or activate staged code. The read-only `/health.runtimeBuild` field exposes guarded unsigned build identity when packaged; its `verified:false` means it is not a signed provenance or a source-to-deployment parity certificate. These changes passed independent Root 29/29 and Node 234/234 tests, including a fresh offline-install copy after the final running-job-without-runId regression. See `docs/checkpoints/2026-11-11_0151_P1_RESTART_IMPACT_RUNTIME_IDENTITY_QC.md`.

<br />

## Permission-only concurrent change protection (2026-11-11 17:25 KST)

The isolated switch helper previously compared only content SHA-256 before rolling back, so a concurrent owner-only `chmod` with unchanged file bytes could be silently overwritten. Both normal rollback and independent `SIGKILL` recovery now verify that `settings.json` and `start.sh` remain ordinary files with their original permission bits. A mismatch **blocks** recovery and preserves the fixture journal. Four regressions cover both files and both paths. This is *fixture-only* evidence, not an atomic production maintenance lock or physical power-loss proof. See [2026-11-11_1725_P1_FIXTURE_PERMISSION_DRIFT_ROLLBACK_QC.md](checkpoints/2026-11-11_1725_P1_FIXTURE_PERMISSION_DRIFT_ROLLBACK_QC.md).

<br />

## Identical-byte inode substitution guard (2026-11-11 19:06 KST)

Content hashes and permission bits alone do not identify the original filesystem object. In the **isolated fixture-only** switch helper, an external rename with identical bytes and mode could still be overwritten. Normal rollback now compares device/inode for each expected file object. The post-`SIGKILL` journal records original object identities and private post-switch identity markers; if a required marker is absent or the current inode changed, recovery **refuses** to replace the file and preserves the journal. Four targeted regressions failed before correction and passed afterward. Full Root **58/58** and Node **265/265**, including independent offline-install QC, passed. This is not protection against all simultaneous writers, journal forgery, or power-loss failure. It does **not** authorize production activation. See [the dated QC checkpoint](checkpoints/2026-11-11_1906_P1_SAME_BYTES_INODE_ROLLBACK_QC.md).


<br />

## Mixed-version writer exclusion (2026-11-11 21:34 KST)

The fixed-primary TCP reservation prevents two **new** Reach writers from selecting different ports for the same state. It cannot prevent the **old v1** binary from starting *later* and selecting one of its legacy fallback ports. Blocking all of the legacy ports was tested and **rejected**: it caused a real conflict with an unrelated Cloudflare tunnel listener on MSM2-1 (TCP 20242), failing a clean-install integration test.

**Production activation is blocked** until an authorized maintenance window can prove the old installed binary is stopped, its automatic restart is disabled for the entire transition, active work is drained, and the new single writer passes authenticated smoke and rollback. A read-only preflight must report the old-service/auto-restart status without reading secrets or changing launchd. This is a **service-level transition gate**, not a reason to widen workspace or macOS permissions. No production switch took place. See [the 21:34 checkpoint](checkpoints/2026-11-11_2134_P0_LEGACY_LATE_START_PORT_CONFLICT_QC.md).

<br />

## Installed LaunchAgent preflight (2026-11-11 23:20 KST)

The single authenticated `reach_preflight` MCP tool now accepts optional `includeInstalledServices:true`. It reads only the Label, KeepAlive, RunAtLoad and Disabled keys from the two known Node and two known tunnel plists, plus filtered launchctl presence/PID. The default does not scan installed services. It does not inspect credentials, start programs, change launchctl or grant activation.

The observed MSM2-1 state has **both Node LaunchAgents loaded and auto-restart configured**. Its output is `state:blocked`, `reason:node_job_loaded`, `upgradeReady:false`. A snapshot is non-atomic and cannot prevent an older version from starting later. Do not interpret `not_verified` or any uninstalled/disabled plist as a safe maintenance approval. First establish real managed-service exclusion, drain and effect reconciliation at a separately approved production window.

See [23:20 typed preflight checkpoint](checkpoints/2026-11-11_2320_P0_LAUNCHD_TYPED_PREFLIGHT_QC.md).
