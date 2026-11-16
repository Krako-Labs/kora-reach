# KORA Reach for Linux

Use the AI conversation you already use to run approved work on a Linux computer. KORA Reach supplies authenticated file, command and persistent-job tools. Routine work runs locally.

**Status: Linux server developer preview.** This source branch extends the released Mac/CLI project. It does not install a local model, require Docker, or provide Linux desktop control.

## Contents

- [Install and start](#install-and-start) — a normal Linux account and one workspace.
- [Check the connection](#check-the-connection) — read-only diagnostics for the installed node.
- [Connect Web Chat](#connect-web-chat) — the existing conversation stays the interface.
- [Run local work](#run-local-work) — files, tests and persistent jobs.
- [Run as a user service](#run-as-a-user-service) — optional systemd.
- [Build and verify](#build-and-verify) — source checks and an actual package test.
- [Optional mail package](#optional-mail-package) — the separate NAS/mail application.

<br />

## Install and start

Requirements: Linux, Node.js22.12+, `/bin/bash`, and a normal user account. A source checkout also needs npm to install build dependencies. Keep the extracted package in a permanent directory; the launcher uses that location.

For a prebuilt standalone Linux package:

~~~sh
node scripts/setup-linux.mjs --no-install --dry-run
node scripts/setup-linux.mjs --no-install --allow-execution
"$HOME/.local/share/kora-reach-linux/start.sh"
~~~

For a source checkout, omit `--no-install`. Setup installs the required dependencies and builds the server if needed.

The defaults are:

| Setting | Default |
| --- | --- |
| Workspace | `~/KORA-Workspace` |
| Private installation state | `~/.local/share/kora-reach-linux` |
| Local MCP endpoint | `http://127.0.0.1:3208/mcp` |
| Capability profile | `server` |
| Browser, desktop and Console | Disabled |
| Command execution | Disabled unless `--allow-execution` is supplied |

The initial setup refuses to overwrite an existing installation. The private state must be outside the file workspace. A custom workspace must already exist.

~~~sh
node scripts/setup-linux.mjs \
  --workspace /srv/kora-workspace \
  --state-dir /home/kora/.local/share/kora-reach-linux \
  --port 3210 \
  --allow-execution
~~~

File tools follow the configured workspace policy. Enabled commands use the Linux account's operating-system permissions. The workspace policy does not sandbox a shell command.

<br />

## Check the connection

With the launcher running, open another terminal:

~~~sh
node scripts/doctor-linux.mjs
~~~

For a custom installation:

~~~sh
node scripts/doctor-linux.mjs --state-dir /home/kora/.local/share/kora-reach-linux
~~~

The doctor reads the saved port and state. It checks the live loopback service, authentication rejection, authenticated tool discovery and `reach_preflight`. It reports the server profile, effective policy and available package identity.

The default doctor does not execute commands, create files, start services, change permissions, or expose credentials. A configured workspace is not proof that a particular task can complete.

Packaged previews report the baseline Git revision, whether the source had changes, and the source/compiled-file digests. The metadata is unsigned and remains `verified:false`. A source checkout without a package manifest reports identity as unavailable.

<br />

## Connect Web Chat

The user-facing flow stays:

**Your conversation → authenticated MCP → KORA Reach on Linux → results in the same conversation.**

A cloud web application needs an authenticated HTTPS route to the local MCP endpoint. Use the existing Reach connector and OAuth configuration with an approved HTTPS proxy or tunnel. The Linux installer creates a loopback service; it does not publish a port, create a tunnel, change DNS, or register a connector.

Keep the token private. Do not paste it into chat or screenshots. The launcher preserves intentionally configured OAuth settings.

A real ChatGPT Web connection on Ubuntu 24.04 ARM64 completed OAuth authorization, node preflight, command execution, file write and file read-back on November 16, 2026. See the [independently checked web-MCP canary](LINUX_WEB_MCP_CANARY.md). This confirms one ChatGPT session on a controlled VM; a fresh user installation and Claude connector remain unverified. See the [ChatGPT-first design](CHATGPT_FIRST_MCP.md).

<br />

## Run local work

The server profile reuses Reach's file, command, test and persistent-job implementations. It exposes no browser, screen or desktop tools.

Examples to request through a connected conversation:

- “Organize this copied folder and identify duplicate files.”
- “Run this repository's tests and show the actual result.”
- “Run this approved job, keep its status after reconnect, and verify the output file.”

`kora_local_task` calls the local CLI with `--frontier none`. It does not start another model. File organization moves files and reports duplicates without deleting them. Use a disposable copy for a first trial.

| Tool | Purpose |
| --- | --- |
| `reach_job_start` | Start one approved command with a detached runner. |
| `reach_job_list` | List saved jobs after reconnect. |
| `reach_job_status` | Read the latest background-reconciled state and output. |
| `reach_job_stop` | Stop that job through its runner. |
| `reach_goal_create` | Bind an existing approved job to fixed completion criteria. |
| `reach_goal_status` | Check the job and current file evidence. |
| `reach_goal_record_verification` | Save one verified observation. |

Persistent Goals can record an approved file observation after controller restart. They do not create new plans or repeat an uncertain command. A historical verification receipt remains historical; current status rechecks the file.

Ordinary `exec_command` sessions remain useful for short work. Use durable jobs when work must continue through a controller restart. A full operating-system shutdown still stops local processes.

<br />

## Run as a user service

When a systemd user manager is available, opt in during initial setup:

~~~sh
node scripts/setup-linux.mjs --service user --allow-execution
systemctl --user status kora-reach.service
journalctl --user -u kora-reach.service
~~~

`--no-start` writes the unit and reloads the user manager without enabling or starting it. Setup does not use sudo, change login lingering, create a system service, or replace an existing unit.

The unit uses `KillMode=process` so an approved detached job can survive a controller restart. Stop jobs through Reach before stopping the service when you need those jobs stopped too. User-service behavior after logout depends on the host's user manager.

A NAS vendor's own service manager, ARM64 packaging, and real boot/logout behavior need separate validation.

<br />

## Build and verify

From this source checkout:

~~~sh
npm --prefix apps/reach-node ci --ignore-scripts
npm run check
npm --prefix apps/reach-node run check:server
node scripts/package-linux-preview.mjs --output-dir /absolute/output-directory
~~~

`build:server` compiles in a fresh temporary directory, copies the server assets, and replaces generated `dist` only after compilation succeeds. Desktop helpers from an earlier build are not carried into the server package. Build source checkouts separately from installed runtimes.

The package includes the compiled runtime, production dependencies, CLI, Linux installer and doctor. It does not include Node itself, user state, credentials or mail-container images.

For the opt-in test of the actual generated archive:

~~~sh
KORA_LINUX_TEST_ARCHIVE=/absolute/package.tgz \
  npm --prefix apps/reach-node run test:linux-package
~~~

The test installs into disposable directories, starts the actual packaged server, checks authenticated operations, and exercises controller-crash recovery. It does not operate a user service or a real NAS.

The Linux CI workflow covers Ubuntu22.04/24.04 and Node22/24 when run on GitHub. A workflow definition is not a passing result. Consult the dated verification report for environments actually tested.

<br />

## Optional mail package

The default Linux archive contains the general execution runtime. A combined archive can include the separate mail helper:

~~~sh
node scripts/package-linux-preview.mjs --with-mail --output-dir /absolute/output-directory
~~~

Configure a mail directory only with that combined package or a source checkout containing `apps/reach-mail`:

~~~sh
node scripts/setup-linux.mjs --mail-dir /srv/kora-workspace/mail-instance \
  --workspace /srv/kora-workspace --allow-execution
~~~

Docker is required by the mail server, not by Reach. See `docs/NAS_MAIL_INTEGRATION.md` in the source checkout or combined package. Gulpy remains a separate product using the Reach runtime.
