# KORA Reach Phase A - Mac install

For macOS 13+ with Node.js 22+ and Git.

## Get started

Open Terminal and run these commands:

    git clone https://github.com/Krako-Labs/kora-reach.git
    cd kora-reach
    git switch feat/chatgpt-mcp-computer-control
    node scripts/setup-mac.mjs

The installer creates a limited working folder under Documents/KORA-Workspace,
installs pinned dependencies, builds the MCP Node, generates an owner-only
authentication secret, configures a restricted workspace policy, and installs
a user launchd service on localhost port 3208.

It does not open an internet port or automatically create a public tunnel.
It refuses to replace an existing installation.

Options:

    node scripts/setup-mac.mjs --dry-run
    node scripts/setup-mac.mjs --workspace "$HOME/my-existing-folder"
    node scripts/setup-mac.mjs --no-start

After setup, the local console is http://127.0.0.1:3208/console

## ChatGPT connection

ChatGPT cannot call your localhost address from the cloud.

Use a properly authenticated HTTPS MCP endpoint or an official Secure MCP
Tunnel where available. In ChatGPT web:

Plugins > + > Add custom MCP server > URL or Tunnel > approve > install.

Never expose a full computer MCP endpoint without robust authentication and
an explicit permissions policy. Do not share tokens in conversations.
Mac Screen Recording and Accessibility permissions require user approval.

The screen viewer still needs live ChatGPT and foreground GUI testing.
ChatGPT and Claude model usage remains subject to provider plan limits.

Not yet included: single-click tunnel provisioning, public Plugin Directory
branding, signed native Mac app, automatic provider OAuth enrollment.
