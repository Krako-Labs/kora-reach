# Security

KORA Reach executes work on your computer. Treat task text and repositories as potentially untrusted.

Current v0 safety boundaries:

- deterministic file organization is scoped to the selected directory;
- duplicate detection never deletes files;
- file reorganization is skipped inside Git repositories;
- frontier coding uses Codex workspace-write, not unrestricted host access;
- KORA does not print or store provider credentials;
- KORA instructs the frontier agent not to commit or push.

Review changes before committing them. Do not include secrets in public issues.
