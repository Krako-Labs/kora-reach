<p align="center">
  <img src="assets/readme-hero.webp" alt="KORA Reach. Use the AI Plan and Computers You Already Have. Connect your computers, automate everyday work, and use frontier AI when it matters." width="100%" />
</p>

<p align="center"><strong>Use the AI Plan and Computers You Already Have.</strong></p>

<p align="center">Your web chat stays the interface. KORA Reach handles approved work on your computers and returns verified results.</p>

<p align="center">The CLI is released today. Authenticated ChatGPT-to-Mac control is a developer preview.</p>

<p align="center">
  <a href="https://github.com/Krako-Labs/kora-reach/releases/tag/v0.2.0"><img src="https://img.shields.io/badge/CLI-v0.2.0-1769AA?style=flat-square" alt="Released CLI v0.2.0" /></a>
  <img src="https://img.shields.io/badge/Execution-local--first-0B9EA2?style=flat-square" alt="Local-first execution" />
  <a href="docs/CHATGPT_FIRST_MCP.md"><img src="https://img.shields.io/badge/Mac%20control-developer%20preview-7952B3?style=flat-square" alt="Mac control developer preview" /></a>
  <img src="https://img.shields.io/badge/Results-verified-198754?style=flat-square" alt="Verified results" />
</p>

<p align="center">Node.js 22.12+ · Apache-2.0 · No Docker or API key for local-only tasks</p>

<br />

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#verified-example">Real example</a> ·
  <a href="#capabilities-and-status">Capabilities</a> ·
  <a href="#web-chat-as-the-last-mile-ui">Web Chat architecture</a> ·
  <a href="#chatgpt-and-mac-setup">Connect a Mac</a> ·
  <a href="#safety-and-limits">Safety</a>
</p>

<br />

**Why start in Web Chat?** You already have a conversation with an AI assistant. Keep that conversation for reasoning, approvals, and results; send authorized computer actions through KORA Reach instead of starting a separate coding-agent session for every routine step. **Mac control via ChatGPT MCP is still a developer preview.**

<br />

## Quick start

**1. Install the released CLI** — requires Node.js 22.12+ and Git.

```bash
npm install -g https://github.com/Krako-Labs/kora-reach.git#v0.2.0
kora doctor
```

**2. Give it a real local task.** This creates a disposable sample folder. No model or API key is needed.

```bash
DEMO_DIR="$(mktemp -d)"
cd "$DEMO_DIR"
printf 'hello KORA\n' > notes.txt
cp notes.txt notes-copy.txt

kora reach "Organize this folder and identify duplicate files" --frontier none
```

Reach moves the sample files into `Documents/` and reports the duplicate; it does **not** delete it. The input files are temporary, but Reach also writes a local hash cache and run trace in your home directory. For real files, **start with a disposable copy**.

<details>
<summary><strong>Optional: enable AI-powered coding repairs with Codex</strong></summary>

Install the [official Codex CLI](https://github.com/openai/codex), then use its supported sign-in flow:

```bash
npm install -g @openai/codex
codex
```

Inside a repository where you permit code changes:

```bash
kora reach "Fix the failing tests in this repo"
```

Reach runs the tests locally, requests a bounded Codex repair if tests fail, and independently reruns the tests. Applicable ChatGPT/Codex plan limits still apply.

</details>

<br />

## Verified example

This is **real output from a local file-demo run**, with no frontier-agent handoff:

```text
KORA Reach
Route: files
Organized 2 files locally.

Duplicate groups:
  - notes-copy.txt = notes.txt

Task completed ✓

Total KORA actions             7
Local operations               5
Deterministic routing          2
Cached / reused                0
Frontier escalations           0

100% handled without frontier-model escalation
```

**What it means:** The sample work ran locally, and Reach reported the actions it performed. **100% refers to this example only**, not a guaranteed savings rate or unlimited AI usage.

<details>
<summary><strong>Watch the original CLI coding-repair demo (30 seconds)</strong></summary>

![Recorded KORA Reach coding repair: local tests, bounded Codex repair, and independent verification.](demo/kora-reach-demo.gif)

This is a condensed recording of a real failing-test repair on a test repository. It reports **one frontier-agent handoff across six KORA actions** (83% without a frontier escalation). A handoff is **not** a raw provider model-call count or a verified cost saving.

</details>

<br />

## Capabilities and status

**Released in v0.2.0 (CLI)**

- **Test and repair code:** run supported project tests locally; optionally ask Codex for a bounded repair, then verify again.
- **Organize files:** group top-level files and report duplicates, without deleting them.
- **Keep trying, within a limit:** use `--max-rounds 3` for a bounded test → repair → verification loop.

Supported test detection: npm, pnpm, bun, pytest, Cargo, and Go.

**Experimental developer preview (separate setup)**

- **ChatGPT → Mac:** authenticated file, command, browser, and macOS controls, subject to each Mac's permissions.
- **Limited Persistent Goals:** observe an *already authorized* background job, restore its status after reconnect, and verify file evidence.

**Not released:** automatic multi-Mac task scheduling, arbitrary multi-agent planning, or a fully integrated KORA Core runtime.

<br />

## Web Chat as the last-mile UI

![Web-first KORA Reach architecture. The user talks to ChatGPT Web, the last-mile interface for conversation and reasoning. An authenticated MCP connection invokes KORA Reach as the local execution layer on the user's computer. Verified results return to the same chat. Optional coding-agent handoffs, limited Persistent Goals and KORA Core routing principles are separately labeled.](assets/kora-reach-web-chat-architecture.png)

[Open the full-size Web Chat architecture](assets/kora-reach-web-chat-architecture.png)

**The web chat is the front end. Reach is the execution layer.** In the ChatGPT Mac-control preview, the flow is:

1. **You → ChatGPT Web:** describe the task, discuss tradeoffs, review decisions, and approve sensitive actions.
2. **ChatGPT Web → authenticated MCP → KORA Reach:** call approved computer tools. Reach runs routine file, shell, test, browser, and macOS operations within their configured permissions.
3. **Reach → ChatGPT Web:** return tool outputs, verification evidence, and available progress. You continue in the *same* conversation.

**Why not run a second coding agent for every step?** Dedicated coding agents such as Codex or Claude Code can perform similar tasks, but repeated model-driven planning, tool calls, and retries can consume their applicable usage allowances. Reach aims to handle **deterministic work locally** instead of launching a separate coding-agent loop for routine operations. Use an optional coding agent when code repair genuinely needs it; the released CLI currently supports **Codex** for this handoff, not Claude Code integration.

**What this does not mean:** Web Chat also uses model context and has its own limits. ChatGPT and Codex may have distinct allowances, depending on plan. KORA Reach does **not** create unlimited frontier usage, bypass provider terms, or guarantee lower token or credit consumption on every task. Actual savings must be measured. [ChatGPT plan and model limits](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt) · [Credits and Codex usage](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans).

**KORA Core** is the local-first routing direction, not a fully integrated runtime in v0.2.0. Authenticated Mac control and limited Persistent Goals are developer-preview features. Other web chat hosts require separate connector compatibility testing.

<br />

## ChatGPT and Mac setup

The **v0.2.0 Mac-control developer preview** keeps ChatGPT Web as the user-facing conversation and sends approved actions to a user-owned Mac through an authenticated MCP service. It includes browser and native Mac tools, a local Console, and limited, persisted Goal status. It does not create a second KORA chat application.

**For a fresh Mac installation**, start with the setup check:

```bash
git clone --branch v0.2.0 https://github.com/Krako-Labs/kora-reach.git
cd kora-reach
node scripts/setup-mac.mjs --dry-run
```

Then follow the [Mac installation guide](docs/PHASE_A_INSTALL.md) for the actual install, permissions, and secure ChatGPT connection. Existing installations require a separate safe upgrade path; **do not rerun the initial setup over a working node**.

The default service is local-only. ChatGPT in the cloud needs an approved, authenticated HTTPS MCP endpoint or supported secure tunnel. macOS Accessibility, Screen Recording, website login, and an unlocked desktop can require user approval.

**Persistent Goals have a narrow scope:** a Goal can track an existing approved detached job, survive a Node restart, and record verified file output. This does **not** mean Reach can plan any future task on its own.

<br />

## Safety and limits

- **Commands can change things.** Local tests can execute project scripts. Optional Codex can edit source files inside its selected workspace. Commit your work or use a disposable copy first.
- **Workspaces matter.** `--cwd` selects the CLI task directory. The MCP node has a separate workspace/execution policy. A denied path is not permission to bypass a restriction.
- **File organization moves files.** Test on a temporary copy. Duplicates are reported, **not deleted**.
- **No uncertain replays.** Browser clicks and submissions with unclear outcomes must be checked before retrying.
- **MCP shell permissions are different.** Enabling shell execution can grant commands the Reach service account's normal host permissions; a file root restriction is not an OS sandbox.
- **Local traces may contain private details.** Reach saves task metadata and execution results under `~/.local/share/kora-reach/runs/`. Review traces before sharing.
- **No unlimited frontier AI.** Subscription allowances, rate limits, account access, and provider terms remain in effect.
- **Preview is not production certification.** Mac-control integration requires separate authentication, permissions, and real-device checks; v0.2.0 does not upgrade an existing Mac automatically.

<br />

## Contribute and learn more

**The most useful contributions are real tasks or failures that Reach should handle locally and verify reliably.**

[Report a bug or request a use case](https://github.com/Krako-Labs/kora-reach/issues) · [Contributing guide](CONTRIBUTING.md) · [v0.2.0 release](https://github.com/Krako-Labs/kora-reach/releases/tag/v0.2.0)

<details>
<summary><strong>Technical documentation and project relationships</strong></summary>

- [ChatGPT MCP architecture and setup](docs/CHATGPT_FIRST_MCP.md)
- [Mac installation and permissions](docs/PHASE_A_INSTALL.md)
- [Verified control QC and remaining gaps](docs/VERIFIED_CONTROL_QC.md)
- [Safe update staging and its limitations](docs/P1_SAFE_NODE_UPDATE.md)
- [Research and provider access](docs/RESEARCH.md)
- [v0.2.0 release notes](docs/RELEASE_NOTES_v0.2.0.md)

[**KORA Doctor**](https://github.com/Krako-Labs/kora-doctor) identifies possible waste in AI execution records. **KORA Reach** runs work locally to reduce unnecessary model handoffs. Both are independent open-source projects.

**License:** CLI [Apache-2.0](LICENSE); separately packaged Reach Node MIT. Optional tools have their own licenses. Maintained by [Krako Labs](https://github.com/Krako-Labs).

</details>
