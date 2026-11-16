# Linux web MCP canary — November 16, 2026

**Result: passed on a local Ubuntu 24.04 ARM64 VM.** The user registered a separate Linux MCP connector in ChatGPT Web, completed OAuth approval, and successfully requested work through that connector.

The test used the same chat-to-MCP connection to:

1. Request the node preflight and confirm the `server` capability profile and Linux ARM64 architecture.
2. Run `uname -s` and `uname -m`, which returned `Linux` and `aarch64`.
3. Create a uniquely named test directory inside the configured workspace.
4. Write `KORA Linux web MCP verified` to a file, then read it back.

An independent, read-only guest-side check verified that the file exists and contains exactly 27 bytes. Its SHA-256 was `bb21a9802703af4b0ee2495d548cea76cf375314c2179fb01a1565cc08fd953f`.

**Evidence distinction:** the connector UI actions and preflight responses were reported by the user. The file contents and hash were independently verified by reading the Linux guest filesystem. The raw connector UI event stream was not independently captured. No private hostname, node ID, account path, or credential is published here.

This is one real ChatGPT Web-to-Linux end-to-end test, not evidence of a clean install on an unrelated machine, a physical NAS, or Claude compatibility. The OS reboot and durable-work test used this VM; Linux OS restart ends running processes and does not preserve actively running jobs.

For setup, security restrictions and the supported server profile, see [Linux setup](LINUX_SETUP.md).
