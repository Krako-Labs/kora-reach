# KORA Reach Phase A - Mac install

For macOS 13+ with Node.js 22+ and Git.

The MCP preview is on `main`. The resumable control changes in [draft PR #3](https://github.com/Krako-Labs/kora-reach/pull/3) remain separate until their release checks pass.

## Get started

Open Terminal and run these commands:

    git clone --branch main https://github.com/Krako-Labs/kora-reach.git
    cd kora-reach
    node scripts/setup-mac.mjs

The installer creates a limited working folder at ~/KORA-Workspace,
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

Note: Avoid defaulting background macOS launch agents to ~/Documents, Desktop or Downloads. Those privacy-protected folders may block command execution until macOS TCC approval; installer uses ~/KORA-Workspace.

## Updating an existing installation (candidate stage only)

Do **not** rerun initial setup to overwrite an installed Node, credentials or policy. The draft PR #3 branch now contains a separate, deliberately non-activating candidate preparation tool. See [safe Node candidate preparation](P1_SAFE_NODE_UPDATE.md). It stages an identified compiled package into an isolated release directory, checks production dependencies and leaves launchd, OAuth, the node ID, state, Chrome identity and running jobs unchanged. Activation, backup/rollback for a live switch and actual deployed parity still require separate validation and approval.
