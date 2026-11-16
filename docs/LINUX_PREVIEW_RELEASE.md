# KORA Reach Linux — first developer preview

**Status:** first Linux-server developer prerelease (`v0.3.0-linux.1`). The stable CLI release remains `v0.2.0`; this does not certify a production-ready multi-platform installation.

## What works

- Authenticated remote MCP tools for files, commands, deterministic work and bounded persistent jobs.
- Headless Linux `server` profile, private installation state, workspace-aware file tools, and opt-in command execution.
- Read-only `doctor-linux` diagnostics, initial local install and optional systemd user service.
- Signed-in web chat stays the interface; the Linux machine executes requested actions and returns results to the same chat.
- User-reported ChatGPT Web canary with an independent artifact read-back on Ubuntu 24.04 ARM64. [Canary report](LINUX_WEB_MCP_CANARY.md).

## Verified separately

- Debian 13 x64 under Node 24: local build, test and archive-install checks.
- Ubuntu 24.04 ARM64 (Lima): tests, real archive install, OAuth and file operations, controller restart, whole-VM restart and historical evidence preservation.
- GitHub Linux matrix: Ubuntu22.04 x64 and Ubuntu24.04 x64/ARM64 × Node22/24 passed in all six jobs on PR #5. This does not replace device-specific or production validation.

## Install

Download the Linux archive matching your architecture from the prerelease assets, check its accompanying `.sha256` file, then extract into a **permanent directory**. Node.js 22.12+ and `/bin/bash` are required. The executable for Node is not bundled. From the extracted directory:

```sh
node scripts/setup-linux.mjs --no-install --dry-run
node scripts/setup-linux.mjs --no-install --allow-execution
~/.local/share/kora-reach-linux/start.sh
```

The installer binds the MCP service to loopback and does not create a public tunnel. `--allow-execution` permits shell commands with the Linux account's OS permissions; this is **not an operating-system sandbox**. Read the [complete Linux setup and security guide](LINUX_SETUP.md) before enabling shell execution or connecting a cloud client.

For optional systemd service installation, use `--service user` in the initial installer invocation. A cloud web app also needs a separately authenticated HTTPS MCP endpoint; do not expose a raw local token or unauthenticated command endpoint.

## Not yet verified or included

- No vendor NAS or UGREEN UGOS end-to-end deployment, direct Internet mail delivery, or running Docker Mailserver proof.
- No Linux desktop/browser UI control, seamless existing-node upgrade or Linux host-user account provisioning.
- No general user-initiated multi-agent autonomy, automatic cross-computer scheduling or guarantee of token/cost savings.
- No production certification, signed binaries, subscription-limit bypass or promise of unlimited frontier inference.

The optional Reach Mail package is experimental and not part of the default Linux server archive. Docker is not needed for the default package.

Report issues and install problems at [KORA Reach Issues](https://github.com/Krako-Labs/kora-reach/issues).
