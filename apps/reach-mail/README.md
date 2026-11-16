# KORA Reach Mail

Prepare and manage a mail server on a Linux NAS from the AI conversation you already use.

This developer preview packages **Docker Mailserver 17.0.0** and exposes a small JSON command interface for KORA Reach. It creates an isolated mail instance, provisions accounts through the upstream management command, and reports the difference between configuration, container health, and verified delivery.

## Contents

- [Status](#status) — what this preview verifies.
- [Quick start](#quick-start) — prepare a loopback-only test instance.
- [Reach integration](#reach-integration) — the JSON request and result contract.
- [Network profiles](#network-profiles) — local, direct, and relay deployments.
- [Account credentials](#account-credentials) — create accounts without exposing passwords in chat.
- [Validation](#validation) — checks that can run without a mail container.
- [Production work remaining](#production-work-remaining) — what a public mail service still needs.

<br />

## Status

**This is a packaging and administration preview. It does not establish successful Internet mail delivery.**

| Evidence | What it establishes |
| --- | --- |
| Configuration generated | The instance files exist and pass local checks. No container was started. |
| Account configured | The upstream command completed and the address exists in DMS account configuration. Dovecot may still be applying the change. |
| Container healthy | Docker reports the image health check. This does not prove mailbox login or external delivery. |
| `verify-local` passed | A synthetic message was submitted on loopback and read back from the same local account through IMAP. |
| Internet delivery | Requires separate real-world incoming/outgoing tests after DNS and network setup. This package never marks it verified automatically. |

The package has no LLM dependency, web chatbot, or custom SMTP/IMAP implementation. A mail client or separately installed webmail remains necessary for reading normal mail. It does not create NAS users or NAS folder permissions.

<br />

## Quick start

Requirements for configuration: Node.js 22.12+ and OpenSSL. Running the mail server additionally requires a Linux host with working Docker Engine and Docker Compose. The optional local mail probe uses Python3 standard libraries.

From this package directory, prepare a new test instance:

```bash
node bin/reach-mail.mjs --json-stdin <<'JSON'
{"action":"init","instanceDir":"/srv/reach-mail-test","domain":"example.com","hostname":"mail.example.com","profile":"local-test"}
JSON
```

Use a directory the current user owns. Initialization does not install Docker, pull an image, start a container, change DNS, or send mail. It creates a seven-day self-signed test certificate and binds SMTP/submission/SMTPS/IMAPS to `127.0.0.1` on ports `1025/1587/1465/1993`.

Create the first account before starting DMS:

```bash
node bin/reach-mail.mjs --json-stdin <<'JSON'
{"action":"account-add","instanceDir":"/srv/reach-mail-test","email":"alex@example.com","generatePassword":true}
JSON
```

This operation requires Docker. It runs the pinned image's official `setup email add` command in a temporary container, with the password on stdin. The output reports a protected local credential file path; it never prints the password. If the address already exists, the command returns `already_exists` without rotating its password.

Start only this instance:

```bash
node bin/reach-mail.mjs --json-stdin <<'JSON'
{"action":"start","instanceDir":"/srv/reach-mail-test"}
JSON
```

`stop` uses Compose `down` without volume deletion. Mail, state, configuration and logs are bind-mounted below the instance directory and remain there.

<br />

## Reach integration

Execute the fixed package entry point with `--json-stdin`; send a single JSON request to stdin. Do not build a shell command from a natural-language request.

```text
node /path/to/kora-reach/apps/reach-mail/bin/reach-mail.mjs --json-stdin
```

The command writes one JSON object to stdout. Success uses exit0; failure uses exit1. Raw subprocess output is withheld from error responses because upstream tools can include sensitive values.

```json
{"ok":true,"data":{"status":"configured","configurationVerified":true,"runtimeVerified":false}}
```

```json
{"ok":false,"error":{"code":"DOCKER_UNAVAILABLE","message":"A working Docker Engine and Docker Compose are required. Nothing was installed or started."}}
```

| Action | Required fields beyond `action` and `instanceDir` | Behavior |
| --- | --- | --- |
| `plan` | `domain`, `hostname`; optional profile settings | Returns proposed files and network requirements without writing. |
| `init` | Same as `plan` | Creates an isolated instance; does not start it. |
| `status` | None | Reports configuration and sanitized Docker state separately. |
| `account-list` | None | Lists configured addresses; never returns password hashes. |
| `account-add` | `email`, plus exactly one of `passwordFile` or `generatePassword:true` | Uses official DMS account management and checks configuration afterwards. |
| `start` | `activateNetwork:true` for non-test profiles | Starts only this instance; at least one account must exist. |
| `stop` | None | Stops the instance while retaining bind-mounted data. |
| `dns-plan` | None | Reports DNS/network preparation items; applies nothing. |
| `verify-local` | `email`, `passwordFile` | Opt-in synthetic loopback SMTP-to-IMAP test for local-test only. |

`plan`/`init` profile fields are `profile`, `bindAddress`, `relayHost`, `relayPort`, `tlsCertPath`, and `tlsKeyPath`. Unknown fields, including a direct `password` field, are rejected. All addresses belong to the configured domain in this first version.

The Reach MCP layer should admit the instance directory under its own workspace policy, expose only intended actions, and use generated local credentials for chat-driven account creation. A successful JSON transport response must not be described as verified delivery.

Managed `compose.yaml` and `mailserver.env` have integrity hashes. Hand editing them makes execution fail with `CONFIG_CHANGED`. This avoids executing an unexpected Compose file through the adapter. This preview has no in-place configuration migration; create a separately reviewed instance or add a future explicit update operation.

<br />

## Network profiles

| Profile | Intended environment | Still required |
| --- | --- | --- |
| `local-test` | High loopback ports and a generated test certificate | Linux Docker to start; no public mail claim. |
| `direct` | A reachable mail endpoint using normal mail ports | Valid certificate/key, domain DNS, inbound/outbound TCP25, suitable PTR and IP reputation. |
| `relay` | NAS mailbox storage with an outbound SMTP relay | Valid certificate/key, relay host and authentication, plus a separate reachable inbound path. |

All profiles default to `127.0.0.1`. A production bind address must be selected explicitly. Direct and relay initialization require absolute PEM certificate and private-key paths. The files are copied into the instance; the certificate must match the hostname and key and must not be expired. Renewed certificates must be maintained by the operator until a tested renewal operation is added.

The relay profile sets `DEFAULT_RELAY_HOST`. It does **not** buy or configure a relay provider. Configure DMS relay credentials through the upstream protected-input workflow before activation; `start` checks that the relay credential file exists. The package does not return those credentials. Inbound gateways, tunnels and sender policies are separate infrastructure.

**DDNS changes name resolution.** It does not remove CGNAT, unblock TCP25, configure reverse DNS, or establish an IP's sending reputation. An outbound relay also does not receive incoming mail for a NAS behind CGNAT. The DNS plan reports these dependencies instead of claiming that buying a domain is sufficient.

No DNS records, router rules, firewall rules, public endpoint, or external email are changed by this package's initialization. The package does not provide automatic production updates or external mailbox migration yet.

<br />

## Account credentials

- `generatePassword:true` creates a random password in `secrets/` with mode0600. The instance directory has mode0700.
- `passwordFile` accepts an existing absolute, non-symlink file with no group/other permissions. The password must be one line, 16–1024 characters, without leading or trailing whitespace.
- Passwords are not accepted as command arguments or JSON fields. The adapter sends them to DMS through stdin.
- The upstream DMS process may handle a password internally; this wrapper does not change upstream process internals.
- Do not read the credential file into the AI conversation. Deliver it through an approved private channel and remove temporary handoff files when appropriate.
- An uncertain account operation keeps the credential file and reports the uncertainty. Check current account state before retrying.
- A leftover `.accounts.lock` after process termination needs inspection; the adapter does not delete an uncertain operation's lock automatically.

<br />

## Validation

```bash
npm run check
```

Tests cover real configuration generation, local certificate creation, secret-file permissions, duplicate-account behavior, request validation, managed-file integrity, and the official CLI invocation contract. **The Docker command fixture is a test double, not a running mail server.**

A Compose CLI can validate generated YAML with `docker compose -f /path/to/instance/compose.yaml config --quiet` without starting the server. This does not replace a container test.

Once a real local-test container is healthy, request `verify-local` with the generated account and its local credential-file path. The probe uses TLS, submits only to that same configured account, reads back the synthetic Message-ID, and leaves the message in the test mailbox. It cannot test an external recipient or production profile. A failed probe does not print protocol exceptions or passwords.

<br />

## Production work remaining

This first package needs real Docker runtime testing on Linux and on the selected NAS model. Internet readiness additionally needs DNS/DKIM/SPF/DMARC, certificate renewal, inbound connectivity, outbound delivery tests, backup/restore drills, resource sizing and an update/rollback process. User onboarding still uses a protected credential-file handoff; an end-user invitation/password-reset flow is future work.

The full Reach mail product is separate from the UGREEN hackathon's restricted Uliya Skill format. Do not include this executable package in a Skill ZIP or claim that a Uliya-only demo validates this mail server.

### Upstream sources

- [Docker Mailserver 17.0.0](https://github.com/docker-mailserver/docker-mailserver/releases/tag/v17.0.0)
- [Official deployment and account setup](https://docker-mailserver.github.io/docker-mailserver/latest/usage/)
- [Official Compose template](https://github.com/docker-mailserver/docker-mailserver/blob/v17.0.0/compose.yaml)
- [Official account creation implementation](https://github.com/docker-mailserver/docker-mailserver/blob/v17.0.0/target/scripts/helpers/database/manage/postfix-accounts.sh)
- [TLS configuration](https://docker-mailserver.github.io/docker-mailserver/latest/config/security/ssl/)
- [Outbound relay configuration](https://docker-mailserver.github.io/docker-mailserver/latest/config/advanced/mail-forwarding/relay-hosts/)
- [Inbound and outbound relay example](https://docker-mailserver.github.io/docker-mailserver/latest/examples/use-cases/external-relay-only-mailserver/)

The package pins the container version; upstream documentation under `latest` can change. Consult the matching version before changing the image.
