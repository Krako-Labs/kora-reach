import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import type { FileService } from "./file-service.js";
import { runAuditedTool } from "./tool-result.js";

export type MailAction =
  | "plan" | "init" | "status" | "account-list" | "account-add"
  | "start" | "stop" | "dns-plan" | "verify-local";

const ACTIONS = new Set<MailAction>([
  "plan", "init", "status", "account-list", "account-add",
  "start", "stop", "dns-plan", "verify-local",
]);

export function locateMailCli(moduleUrl = import.meta.url): string {
  const directory = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(directory, "../../reach-mail/bin/reach-mail.mjs"),
    path.resolve(directory, "../../../reach-mail/bin/reach-mail.mjs"),
  ];
  const cli = candidates.find(candidate => existsSync(candidate));
  if (!cli) throw new Error("Reach Mail package is not installed beside Reach Node.");
  return cli;
}

function helperEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The mail helper needs Docker's service-account configuration, never Reach's
  // bearer token, OAuth approval key, or unrelated provider credentials.
  const names = [
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP",
    "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONTEXT",
    "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ];
  return Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}

function assertNoSecretValues(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:password|passwd|secret|token|apiKey|privateKey|relayPassword|authToken)$/i.test(key)
        && typeof entry === "string" && entry.length > 0) {
      throw new Error("Mail helper returned a secret value; response withheld.");
    }
    assertNoSecretValues(entry);
  }
}

export interface MailInvocationOptions {
  cliPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** One fixed executable, a bounded JSON request on stdin, and no shell parsing. */
export async function invokeMail(
  instanceDir: string,
  action: MailAction,
  fields: Record<string, unknown> = {},
  options: MailInvocationOptions = {},
): Promise<Record<string, unknown>> {
  if (!path.isAbsolute(instanceDir)) throw new Error("Mail instance directory must be absolute.");
  if (!ACTIONS.has(action)) throw new Error("Unsupported mail action.");
  if ("action" in fields || "instanceDir" in fields) throw new Error("Mail request cannot override its configured instance or action.");
  if ("password" in fields || "token" in fields) throw new Error("Plaintext credentials are not accepted.");
  const request = JSON.stringify({ ...fields, action, instanceDir });
  if (Buffer.byteLength(request) > 32 * 1024) throw new Error("Mail request is too large.");
  const budget = (action === "start" || action === "stop" || action === "account-add") ? 180_000 : action === "verify-local" ? 90_000 : 45_000;
  const timeoutMs = options.timeoutMs ?? budget;
  const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024;
  const cli = options.cliPath ?? locateMailCli();

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--json-stdin"], {
      env: helperEnvironment(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let outputBytes = 0;
    let stopped: Error | undefined;
    let finished = false;
    let escalation: NodeJS.Timeout | undefined;

    function signalOwnedProcess(signal: NodeJS.Signals): void {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The owned process may have exited between checks. */ }
    }
    function stop(error: Error): void {
      if (stopped || finished) return;
      stopped = error;
      signalOwnedProcess("SIGTERM");
      escalation = setTimeout(() => signalOwnedProcess("SIGKILL"), 500);
      escalation.unref();
    }
    const timeout = setTimeout(() => {
      stop(new Error("Mail action timed out; its outcome may be uncertain. Check reach_mail_status before retrying."));
    }, timeoutMs);
    timeout.unref();

    function finish(error?: Error, data?: Record<string, unknown>): void {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (error) reject(error);
      else resolve(data ?? {});
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) return stop(new Error("Mail helper output exceeded its limit; response withheld."));
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      // Diagnostics may contain provider output. Never echo stderr into a chat.
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) stop(new Error("Mail helper output exceeded its limit; response withheld."));
    });
    child.on("error", () => finish(new Error("Could not start the Reach Mail helper.")));
    child.stdin.on("error", () => { /* The close handler reports the helper result. */ });
    child.on("close", (code) => {
      if (stopped) return finish(stopped);
      try {
        const envelope: unknown = JSON.parse(stdout);
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid mail helper response.");
        const result = envelope as Record<string, unknown>;
        assertNoSecretValues(result);
        if (result.ok !== true || code !== 0) {
          const error = result.error && typeof result.error === "object"
            ? result.error as Record<string, unknown> : {};
          const errorCode = typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "MAIL_ACTION_FAILED";
          // The controlled helper returns sanitized messages; raw process output
          // and provider diagnostics are deliberately excluded.
          const message = typeof error.message === "string" ? error.message.slice(0,1000) : "The mail action did not complete.";
          return finish(new Error(errorCode + ": " + message));
        }
        if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw new Error("Mail helper returned no structured result.");
        finish(undefined, result.data as Record<string, unknown>);
      } catch (error) {
        if (error instanceof SyntaxError) return finish(new Error("Mail helper returned invalid JSON; raw output withheld."));
        finish(error instanceof Error ? error : new Error("Invalid mail helper response."));
      }
    });
    child.stdin.end(request + "\n");
  });
}

export function registerMailTools(server: McpServer, config: AppConfig, files: FileService): boolean {
  if (!config.reachMailDirectory) return false;
  const instanceDir = config.reachMailDirectory;
  const invoke = (name: string, action: MailAction, fields: Record<string, unknown> = {}) =>
    runAuditedTool(files.audit, name, async () => {
      files.policy?.execution();
      // Validate the configured instance against the existing workspace policy.
      // Mail-specific paths and Docker configuration are validated by the helper.
      const admitted = files.resolve(instanceDir);
      const scopedFields = { ...fields };
      for (const key of ["tlsCertPath", "tlsKeyPath", "passwordFile"]) {
        if (typeof scopedFields[key] === "string") scopedFields[key] = files.resolve(scopedFields[key] as string);
      }
      if (typeof scopedFields.passwordFile === "string") {
        const relative = path.relative(path.join(admitted, "secrets"), scopedFields.passwordFile);
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
          throw new Error("Local verification requires a credential file inside this mail instance's secrets directory.");
        }
      }
      return invokeMail(admitted, action, scopedFields);
    });

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  server.registerTool("reach_mail_status", {
    title: "Check the configured mail server",
    description: "Inspect the one configured Reach Mail instance. Report configuration, container state and delivery verification separately. A configured instance is not proof that mail can be delivered.",
    inputSchema: {}, annotations: readOnly,
  }, async () => invoke("reach_mail_status", "status"));

  const configuration = {
    domain: z.string().trim().min(3).max(253),
    hostname: z.string().trim().min(3).max(253),
    profile: z.enum(["local-test", "direct", "relay"]).default("local-test"),
    bindAddress: z.string().trim().min(1).max(64).optional(),
    relayHost: z.string().trim().min(3).max(253).optional(),
    relayPort: z.number().int().min(1).max(65535).optional(),
    tlsCertPath: z.string().min(1).optional(),
    tlsKeyPath: z.string().min(1).optional(),
  };
  server.registerTool("reach_mail_plan", {
    title: "Plan a mail server configuration",
    description: "Preview the configuration for the configured mail directory. Does not write files, start containers, change DNS, or send mail. Local-test is loopback-only. Direct and relay profiles require their documented external prerequisites.",
    inputSchema: configuration, annotations: readOnly,
  }, async fields => invoke("reach_mail_plan", "plan", fields));

  server.registerTool("reach_mail_configure", {
    title: "Prepare a mail server configuration",
    description: "Write the approved configuration and persistent directories for the one configured Reach Mail instance. Does not start the server, edit public DNS, or send mail. Use reach_mail_plan to inspect the requested configuration first.",
    inputSchema: configuration, annotations: mutation,
  }, async fields => invoke("reach_mail_configure", "init", fields));

  server.registerTool("reach_mail_start", {
    title: "Start the configured mail server",
    description: "Start the approved Reach Mail Docker Compose service. This can download the pinned mail image and bind the configured ports. Use only when the user has requested starting this instance. If interrupted, check status before retrying.",
    inputSchema: {
      activateNetwork: z.boolean().default(false).describe("Set true only for an explicitly requested direct/relay deployment after its network and TLS prerequisites have been reviewed. Local-test does not need it."),
    }, annotations: { ...mutation, openWorldHint: true },
  }, async ({ activateNetwork }) => invoke("reach_mail_start", "start", { activateNetwork }));

  server.registerTool("reach_mail_stop", {
    title: "Stop the configured mail server",
    description: "Stop the configured mail service while preserving its data. Existing users lose access until it is restarted. Use only when the user requests this operational change.",
    inputSchema: {}, annotations: { ...mutation, destructiveHint: true },
  }, async () => invoke("reach_mail_stop", "stop"));

  server.registerTool("reach_mail_accounts", {
    title: "List mail accounts",
    description: "List configured accounts without passwords or password hashes. This does not prove that a mail client can authenticate or that external delivery works.",
    inputSchema: {}, annotations: readOnly,
  }, async () => invoke("reach_mail_accounts", "account-list"));

  server.registerTool("reach_mail_account_create", {
    title: "Create a mail account",
    description: "Create one account on the configured mail server. Check for an existing account first; never reset an existing password implicitly. A generated password is kept in a private credential file and is never returned to chat. Return the account result and credential-file location; delivery remains a separate check.",
    inputSchema: { email: z.string().trim().min(3).max(254) },
    annotations: mutation,
  }, async ({ email }) => invoke("reach_mail_account_create", "account-add", { email, generatePassword: true }));

  server.registerTool("reach_mail_dns_plan", {
    title: "Show mail DNS requirements",
    description: "Read the required DNS and network configuration for this instance. Does not change public DNS, buy a domain, or claim that internet delivery is verified.",
    inputSchema: {}, annotations: readOnly,
  }, async () => invoke("reach_mail_dns_plan", "dns-plan"));

  server.registerTool("reach_mail_verify_local", {
    title: "Verify local SMTP and IMAP delivery",
    description: "For an explicitly requested local-test check, submit one test message to the same local account and confirm it through IMAP. Only the configured loopback local-test instance is allowed. Read a private credential file inside its secrets directory without returning the password. This does not test Internet delivery.",
    inputSchema: {
      email: z.string().trim().min(3).max(254),
      credentialFile: z.string().min(1).describe("Credential-file location returned by reach_mail_account_create."),
    },
    annotations: mutation,
  }, async ({ email, credentialFile }) => invoke("reach_mail_verify_local", "verify-local", { email, passwordFile: credentialFile }));

  return true;
}
