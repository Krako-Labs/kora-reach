import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

describe("Reach Mail through authenticated Linux-profile MCP", () => {
  let root: string;
  let workspace: string;
  let instanceDir: string;
  let server: RunningHttpServer;
  let endpoint: string;
  const token = "mail-integration-fixture-token";
  let requestId = 0;

  async function rpc(method: string, params: Record<string, unknown>, authenticated = true) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(authenticated ? {authorization: "Bearer " + token} : {}),
      },
      body: JSON.stringify({jsonrpc:"2.0",id:++requestId,method,params}),
    });
    return { status: response.status, body: await response.json() as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown>; tools?: Array<{name:string}> };
    }};
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "reach-mail-mcp-integration-"));
    workspace = path.join(root,"workspace");
    instanceDir = path.join(workspace,"mail-instance");
    await mkdir(workspace);
    const policy = path.join(root,"policy.json");
    await writeFile(policy,JSON.stringify({version:2,mode:"restricted",roots:[workspace],allowExecution:true}));
    const config = loadConfig({
      MCP_AUTH_TOKEN:token, MCP_HOST:"127.0.0.1", MCP_DEFAULT_CWD:workspace,
      KRAKO_REACH_PROFILE:"server", KRAKO_REACH_CONSOLE_ENABLED:"false",
      KRAKO_REACH_MAIL_DIR:instanceDir, KRAKO_REACH_STATE_DIR:path.join(root,"state"),
      KRAKO_REACH_POLICY_FILE:policy,
    },root);
    config.port=0;
    server=await startHttpServer(config,createServices(config));
    const address=server.httpServer.address() as AddressInfo;
    endpoint="http://127.0.0.1:"+address.port+config.endpoint;
  });

  afterAll(async () => {
    await server?.close();
    if(root) await rm(root,{recursive:true,force:true});
  });

  it("requires authentication before exposing mail tools", async () => {
    const denied=await rpc("tools/list",{},false);
    expect(denied.status).toBe(401);
    const listed=await rpc("tools/list",{});
    expect(listed.status).toBe(200);
    expect(listed.body.result?.tools?.map(t=>t.name)).toEqual(expect.arrayContaining([
      "reach_mail_plan","reach_mail_configure","reach_mail_account_create","reach_mail_status",
    ]));
  });

  it("plans and prepares a real loopback mail configuration without starting containers", async () => {
    const fields={domain:"example.com",hostname:"mail.example.com",profile:"local-test"};
    const plan=await rpc("tools/call",{name:"reach_mail_plan",arguments:fields});
    expect(plan.body.result?.isError).not.toBe(true);
    expect(plan.body.result?.structuredContent).toMatchObject({
      status:"planned",changed:false,
      configuration:{profile:"local-test",bindAddress:"127.0.0.1"},
    });
    await expect(access(instanceDir)).rejects.toMatchObject({code:"ENOENT"});

    const configured=await rpc("tools/call",{name:"reach_mail_configure",arguments:fields});
    expect(configured.body.result?.isError).not.toBe(true);
    expect(configured.body.result?.structuredContent).toMatchObject({status:"configured",runtimeStarted:false});
    const compose=await readFile(path.join(instanceDir,"compose.yaml"),"utf8");
    expect(compose).toContain("127.0.0.1:1025:25");
    expect(compose).toContain("docker-mailserver:17.0.0");
    expect(compose).not.toContain(token);
    const key=await stat(path.join(instanceDir,"certs","privkey.pem"));
    expect(key.mode&0o777).toBe(0o600);

    const repeat=await rpc("tools/call",{name:"reach_mail_configure",arguments:fields});
    expect(repeat.body.result?.isError).not.toBe(true);
    expect(repeat.body.result?.structuredContent).toMatchObject({status:"already_configured",runtimeStarted:false});

    const accounts=await rpc("tools/call",{name:"reach_mail_accounts",arguments:{}});
    expect(accounts.body.result?.isError).not.toBe(true);
    expect(accounts.body.result?.structuredContent).toMatchObject({accounts:[],runtimeVerified:false});
  },20_000);

  it("does not accept certificate paths outside the authorized workspace", async () => {
    const result=await rpc("tools/call",{name:"reach_mail_plan",arguments:{
      domain:"example.com",hostname:"mail.example.com",profile:"direct",
      tlsCertPath:path.join(root,"outside-cert.pem"),tlsKeyPath:path.join(root,"outside-key.pem"),
    }});
    expect(result.body.result?.isError).toBe(true);
    expect(result.body.result?.structuredContent?.errorDetails).toMatchObject({code:"WORKSPACE_DENIED"});
  });
});
