# KORA Reach Linux + Mail integration

Use an existing ChatGPT or Claude conversation to manage a Linux execution node and one configured mail server. Reach provides the execution and state layer. Reach Mail packages Docker Mailserver and exposes specific mail operations.

This is an unreleased development preview. The first build verifies a local authenticated MCP endpoint, configuration, and the connection between both packages. A public web-app connection, a running mail container, Internet delivery, and a vendor-specific NAS installer each need separate end-to-end checks.

## Contents

- [Develop on a Mac](#develop-on-a-mac) — use the current workstation and test on Linux.
- [Install both packages](#install-both-packages) — one source checkout or combined preview archive.
- [Operate through a conversation](#operate-through-a-conversation) — concrete mail tools and their results.
- [Choose the delivery profile](#choose-the-delivery-profile) — local test, direct delivery, or relay.
- [Connect an AI web application](#connect-an-ai-web-application) — reuse the existing Reach connection model.
- [Verification and next milestone](#verification-and-next-milestone) — distinguish completed checks from deployment work.

<br />

## Develop on a Mac

A new physical Linux computer is not required. Keep source development on the existing Mac Studio. Run Linux-specific installation and service checks in a Linux virtual machine, a separate Linux validation environment, or the target NAS.

Apple Silicon and many NAS systems use different CPU architectures. An ARM64 Linux virtual machine on an Apple Silicon Mac is useful for Linux behavior, but it does not certify an x86_64 package. Build and execute the final distribution on each supported target architecture. This preview has an x86_64 Linux validation target; ARM64 and UGOS hardware remain unverified.

Keep these responsibilities separate:

| Environment | Work |
| --- | --- |
| Mac Studio | Source edits, code review, package development, and tests that also run on macOS. |
| Linux validation environment | Headless Reach runtime, Linux installer, authenticated MCP, and restart behavior. |
| Linux VM or NAS with Docker | Mail container startup, real SMTP/IMAP, persistent volumes, and Docker lifecycle. |
| Target NAS and its real network | NAS service integration, restart after boot, inbound access, TLS, and Internet delivery. |

Docker is not required for Reach itself. Docker Engine and Compose are required on the machine that runs the mail server. The build does not install Docker on the development Mac.

<br />

## Install both packages

The combined archive preserves this layout:

```text
apps/reach-node/        Compiled Linux MCP runtime and production dependencies
apps/reach-mail/        Mail helper, verification script, and documentation
scripts/setup-linux.mjs Linux setup
docs/                  Setup and integration notes
PREVIEW_BUILD.json     Preview provenance, not a release attestation
```

The host needs Node.js 22.12 or later and /bin/bash. Mail initialization also needs OpenSSL; local delivery verification needs Python 3. A built archive contains neither a Node executable nor the Docker Mailserver image.

Choose an existing workspace and a fresh state directory. The mail directory must be a child of the workspace and may be absent:

```sh
node scripts/setup-linux.mjs \
  --no-install \
  --workspace /srv/kora-workspace \
  --state-dir /home/kora/.local/share/kora-reach-linux \
  --mail-dir /srv/kora-workspace/mail-instance \
  --allow-execution

/home/kora/.local/share/kora-reach-linux/start.sh
```

Use --no-install only with the prebuilt archive and its included production dependencies. For a source checkout, see [Linux setup](LINUX_SETUP.md).

The initial endpoint is authenticated and bound to loopback. The setup writes a private token file and a workspace policy. It refuses to overwrite an existing state directory. Its default is a foreground process; systemd user service setup is optional.

The execution policy grants commands the service account's operating-system permissions. It is not an operating-system sandbox. The typed mail integration limits its own helper inputs and instance paths; it does not reduce the privileges of arbitrary commands that an operator separately enables.

<br />

## Operate through a conversation

The initial integration exposes nine mail tools. They operate on the one configured instance directory.

| Tool | Result |
| --- | --- |
| reach_mail_plan | Preview configuration, Compose content, and network requirements without writes. |
| reach_mail_configure | Create instance files and local-test TLS material; keep the container stopped. |
| reach_mail_accounts | List account addresses without password hashes. |
| reach_mail_account_create | Create an absent account and return a private credential-file path. |
| reach_mail_start | Start the configured Compose service; Internet-facing profiles require explicit network activation. |
| reach_mail_status | Separate configuration, runtime state, and delivery evidence. |
| reach_mail_verify_local | Submit one message to the same local account and verify it through IMAP. |
| reach_mail_dns_plan | Report DNS requirements without editing public DNS. |
| reach_mail_stop | Stop the service while preserving mail data. |

A useful first request is:

> Prepare a local test mail server for example.test at mail.example.test. Create alex@example.test, start the local server, and verify that Alex can receive the local test message.

The intended sequence is:

1. Plan and configure the local-test profile.
2. Check whether the account already exists.
3. Create the absent account. Store the generated password in its private local file.
4. Start the service after the account exists.
5. Call local verification with the returned credential-file path.
6. Report account configuration, container state, and local delivery as separate results.

The account helper needs Docker even before the main service starts. It uses the pinned Docker Mailserver image to create the account through the upstream setup command. It does not implement a separate mail-account database.

Do not read a generated credential file into the conversation. The mail tools return its path without returning the password. Secure user onboarding and password handoff remain product work for the next milestone. Repeating account creation does not reset an existing user's password.

An interrupted command may already have changed state. Inspect the instance and account list before retrying. The bridge reports failed helper operations as failures and does not echo raw helper stderr into the conversation.

The same helper can be called locally with one JSON request on standard input:

```sh
node apps/reach-mail/bin/reach-mail.mjs --json-stdin <<'JSON'
{
  "action": "plan",
  "instanceDir": "/srv/kora-workspace/mail-instance",
  "domain": "example.test",
  "hostname": "mail.example.test",
  "profile": "local-test"
}
JSON
```

See [Reach Mail](../apps/reach-mail/README.md) for the complete helper contract and Docker requirements.

<br />

## Choose the delivery profile

| Profile | Purpose | Additional work |
| --- | --- | --- |
| local-test | Loopback SMTP and IMAP with a short-lived self-signed certificate. | Run Docker and perform the real local delivery probe. |
| direct | Receive and send Internet mail from the selected host. | Public routing, reachable SMTP, suitable IP and reverse DNS, valid TLS, and domain authentication. |
| relay | Use an external SMTP relay for outbound delivery. | Configure the relay service and local credential file; solve inbound delivery separately. |

The local-test profile binds host ports 1025, 1587, 1465, and 1993 to 127.0.0.1. It does not use host networking, a privileged container, or a mounted Docker socket. Its default relay policy does not trust the Docker network for unrestricted relay.

Dynamic DNS keeps a domain pointed at a changing address. It does not remove CGNAT, an ISP's blocked SMTP port, or recipient-side reputation requirements. The relay profile does not automatically provide an inbound gateway. Some networks will need an external relay or gateway, so a domain-only operating-cost promise is not part of this preview.

The wrapper pins Docker Mailserver v17.0.0. The image is downloaded by Docker on the deployment machine. Wrapper and upstream licenses are documented in the package.

<br />

## Connect an AI web application

The product uses the user's existing ChatGPT or Claude web application. No local language model is required for these tools.

This installer creates an authenticated local node. A remotely hosted web application also needs an authenticated HTTPS route and the existing Reach connector configuration. The preview does not create that route, register an application, or change public DNS.

The mail helper runs inside the operator's Linux environment. The conversation calls typed MCP tools, and the Reach process invokes the local helper through a fixed executable and JSON stdin. Mail credentials remain local. Account passwords are not tool arguments.

Keep the general Linux product separate from any hackathon submission adapter. A local runtime package and an official NAS Skill have different execution contracts. This preview does not claim that its runtime is an accepted hackathon submission.

<br />

## Verification and next milestone

The package manifest records the source revision, source digest, runtime digest, platform, Node version, and whether the source tree had uncommitted changes. Packaging by itself is not proof that tests passed. Keep the build's separate verification report with its archive.

The current checks cover source validation, real Linux Reach execution, authenticated MCP, file and command work, durable job restart behavior, mail helper operations, and generated Compose configuration.

These checks do not certify an actual mail container, Internet delivery, a real systemd boot, ARM64, or a specific NAS vendor. Test doubles for Docker account operations must remain labelled as test doubles.

The next practical milestone is one Linux VM or NAS with Docker. Install the combined archive, complete the local-test account flow, verify actual SMTP-to-IMAP delivery, restart the container, and confirm that the account and message persist. Then connect the existing web-app workflow and test Internet delivery on an explicitly chosen domain and network.

Update scheduling, automated recovery, secure employee onboarding, and migration to a cloud provider remain later product milestones. They are not implemented by the first package.
