import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import type { FileService } from "../src/file-service.js";
import { invokeMail, registerMailTools } from "../src/mail-tools.js";

const temporary: string[] = [];
async function helper(body: string): Promise<{ root: string; cliPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reach-mail-bridge-test-"));
  temporary.push(root);
  const cliPath = path.join(root, "mail helper.mjs");
  await writeFile(cliPath, [
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "const request = JSON.parse(input);",
    body,
  ].join("\n"));
  return { root, cliPath };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("mail helper subprocess boundary", () => {
  it("sends one structured request through stdin and excludes Reach credentials", async () => {
    const fixture = await helper(`console.log(JSON.stringify({ok:true,data:{
      request, argv:process.argv.slice(2),
      gotReachToken:!!process.env.MCP_AUTH_TOKEN,
      gotOAuthKey:!!process.env.MCP_OAUTH_APPROVAL_KEY,
      dockerContext:process.env.DOCKER_CONTEXT
    }}));`);
    const data = await invokeMail(fixture.root, "account-add", {
      email: "new.hire@example.com", generatePassword: true,
    }, { cliPath: fixture.cliPath, env: {
      PATH: process.env.PATH, MCP_AUTH_TOKEN: "fixture-token-not-to-forward",
      MCP_OAUTH_APPROVAL_KEY: "fixture-oauth-key-not-to-forward",
      DOCKER_CONTEXT: "nas-test-context",
    }});
    expect(data).toMatchObject({
      request: { action: "account-add", instanceDir: fixture.root, email: "new.hire@example.com", generatePassword: true },
      argv: ["--json-stdin"], gotReachToken: false, gotOAuthKey: false,
      dockerContext: "nas-test-context",
    });
  });

  it("does not allow callers to change the configured instance or pass a plaintext password", async () => {
    await expect(invokeMail("/tmp/configured-mail", "status", { instanceDir: "/tmp/other" })).rejects.toThrow("cannot override");
    await expect(invokeMail("/tmp/configured-mail", "status", { action: "start" })).rejects.toThrow("cannot override");
    await expect(invokeMail("/tmp/configured-mail", "account-add", { password: "fixture-secret" })).rejects.toThrow("Plaintext credentials");
  });

  it("treats a helper failure as failure even when the process exits successfully", async () => {
    const fixture = await helper(`console.log(JSON.stringify({ok:false,error:{code:"DOCKER_UNAVAILABLE",message:"Docker is not available."}}));`);
    await expect(invokeMail(fixture.root, "status", {}, fixture)).rejects.toThrow("DOCKER_UNAVAILABLE");
  });

  it("does not accept a successful envelope from an unsuccessful process", async () => {
    const fixture = await helper(`console.log(JSON.stringify({ok:true,data:{running:true}})); process.exitCode=2;`);
    await expect(invokeMail(fixture.root, "status", {}, fixture)).rejects.toThrow("MAIL_ACTION_FAILED");
  });

  it("withholds malformed stdout and raw stderr", async () => {
    const fixture = await helper(`process.stderr.write("fixture-provider-secret"); process.stdout.write("not-json-fixture-secret");`);
    const failure = await invokeMail(fixture.root, "status", {}, fixture).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("invalid JSON");
    expect((failure as Error).message).not.toContain("fixture-provider-secret");
    expect((failure as Error).message).not.toContain("not-json-fixture-secret");
  });

  it("refuses to relay a plaintext secret accidentally returned by the helper", async () => {
    const fixture = await helper(`console.log(JSON.stringify({ok:true,data:{account:"new.hire@example.com",nested:{password:"fixture-secret"}}}));`);
    await expect(invokeMail(fixture.root, "account-add", {}, fixture)).rejects.toThrow("response withheld");
  });

  it("allows a credential file location without exposing its contents", async () => {
    const fixture = await helper(`console.log(JSON.stringify({ok:true,data:{credentialFile:request.instanceDir+"/secrets/new-hire.txt",status:"created"}}));`);
    const data = await invokeMail(fixture.root, "account-add", {}, fixture);
    expect(data).toMatchObject({status:"created", credentialFile:fixture.root+"/secrets/new-hire.txt"});
  });

  it("bounds the helper output", async () => {
    const fixture = await helper(`process.stdout.write("x".repeat(4096));`);
    await expect(invokeMail(fixture.root, "status", {}, {...fixture,maxOutputBytes:256})).rejects.toThrow("exceeded its limit");
  });

  it("terminates a timed-out helper and marks the outcome uncertain", async () => {
    const fixture = await helper(`setInterval(() => {},1000);`);
    await expect(invokeMail(fixture.root, "start", {}, {...fixture,timeoutMs:100})).rejects.toThrow("outcome may be uncertain");
  });
});

describe("mail MCP registration", () => {
  function collector() {
    const tools = new Map<string, { metadata: Record<string, unknown>; handler: (args: Record<string, unknown>) => Promise<unknown> }>();
    const server = { registerTool(name: string, metadata: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      tools.set(name, { metadata, handler });
    }} as unknown as McpServer;
    return { server, tools };
  }

  it("does not expose mail operations until an instance directory is configured", () => {
    const { server, tools } = collector();
    const config = loadConfig({MCP_AUTH_TOKEN:"fixture-token"}, "/tmp");
    expect(registerMailTools(server, config, {} as FileService)).toBe(false);
    expect(tools.size).toBe(0);
  });

  it("provides a bounded account interface and enforces the existing execution policy", async () => {
    const { server, tools } = collector();
    const config = {
      ...loadConfig({MCP_AUTH_TOKEN:"fixture-token"}, "/tmp"),
      reachMailDirectory: "/tmp/configured-mail",
    };
    let resolved = false;
    const files = {
      policy: { execution() { throw new Error("Execution deliberately denied"); } },
      resolve() { resolved=true; return "/tmp/configured-mail"; },
      audit: { async run(_kind: string, _action: string, work: () => unknown) { return await work(); } },
    } as unknown as FileService;
    expect(registerMailTools(server, config, files)).toBe(true);
    expect([...tools.keys()]).toEqual(expect.arrayContaining(["reach_mail_status","reach_mail_plan","reach_mail_configure","reach_mail_account_create"]));
    const account = tools.get("reach_mail_account_create")!;
    expect(Object.keys(account.metadata.inputSchema as object)).toEqual(["email"]);
    const result = await account.handler({email:"new.hire@example.com"}) as {isError:boolean; structuredContent:Record<string,unknown>};
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toContain("Execution deliberately denied");
    expect(resolved).toBe(false);
  });
});
