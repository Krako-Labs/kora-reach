# KORA Reach reusable runtime vs public OSS

Research verified 2026-10-08.

Project | Main interface | Key reusable ideas | Decision
---|---|---|---
Existing Krako Reach | ChatGPT MCP and own Console | Native Mac, browser, durable jobs, OAuth, audit | Copy runtime into separate KORA branch
Composio Open Dot | Own Electron Mac app | Browser session, computer view, human takeover, approvals | UX reference only
CopilotKit OpenDots | Text, calls, Slack agents | Always-on jobs and event/polling patterns | UX reference only
CopilotKit OpenBot | Container supervisor and policy gateway | Policy, sandbox, audited shell/browser actions | Security reference only

KORA Reach is positioned differently:
- ChatGPT web is the default conversation brain, Claude later.
- User-owned Macs, not an obligatory cloud computer or separate hosted agent UI.
- Local/deterministic tasks and repeated screen polling need no separate
  frontier-model invocation by the KORA runtime.
- A human/model can still request higher-level reasoning; usage limits apply.

No third-party OpenDots / Open Dot / OpenBot source was copied. We reused
code from the user's existing separate Krako Reach codebase and preserved its
MIT license in apps/reach-node/LICENSE. Root KORA Reach remains Apache-2.0.

Sources:
- https://github.com/composio-community/open-dot
- https://github.com/CopilotKit/OpenDots
- https://github.com/CopilotKit/OpenBot
- https://developers.openai.com/plugins/build/chatgpt-ui
