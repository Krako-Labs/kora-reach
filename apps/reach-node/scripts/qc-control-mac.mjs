// Run explicitly on an unlocked Mac. This opens an isolated, disposable Chrome profile.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/src/config.js";
import { createServices } from "../dist/src/mcp-server.js";
import { startHttpServer } from "../dist/src/http-server.js";

// Visible UI checks can steal focus from an active demo. Require an explicit host-bound opt-in.
const headlessRepair = (process.argv.includes("--repair") || process.argv.includes("--headless")) &&
  !process.argv.some(arg => ["--native-only", "--app", "--sheet", "--visual", "--open"].includes(arg));
if (!headlessRepair && (!process.argv.includes("--allow-visible-ui") ||
    process.env.KORA_UI_QC_HOST !== os.hostname())) {
  throw new Error("Visible UI QC disabled. Use a dedicated idle Mac and explicitly set KORA_UI_QC_HOST to its hostname with --allow-visible-ui. Never run on a live demo or user desktop.");
}

const scratch = await mkdtemp(path.join(os.tmpdir(), "reach-control-qc-"));
const title = "Reach QC " + randomUUID();
const sheet = process.argv.includes("--sheet");
const nativeApp = sheet || process.argv.includes("--app") || process.argv.includes("--visual");
const visual = process.argv.includes("--visual");
if (visual) process.env.KORA_CONTROL_VISUAL_EVENTS = "1";
const expected = nativeApp ? "native-ok\n" : "Reach verified download\n";
const filename = path.join(scratch, "reach-control.txt");
const profile = path.join(scratch, "chrome");
const repair = process.argv.includes("--repair");
const repairDir = path.join(scratch, "repair");
if (repair) {
  await mkdir(repairDir);
  execFileSync("git", ["init", "-q", repairDir]);
  await writeFile(
    path.join(repairDir, "package.json"),
    JSON.stringify({ scripts: { test: "node --test repair.test.cjs" } }),
  );
  await writeFile(path.join(repairDir, "label.txt"), "Broken sample");
  await writeFile(
    path.join(repairDir, "repair.test.cjs"),
    'require("node:test")("download label",()=>require("node:assert/strict").equal(require("node:fs").readFileSync("label.txt","utf8").trim(),"Download sample"))',
  );
  process.env.KORA_CONTROL_REPAIR_WORKSPACE = repairDir;
  if (process.argv.includes("--repair-stub")) {
    const stub = path.join(scratch,"codex-stub");
    await writeFile(stub, '#!/bin/sh\nsleep 2\nprintf "%s" "Download sample" > label.txt\n', {mode:0o700});
    process.env.KORA_CODEX_BIN = stub;
  }
}
const loginNonce = randomUUID();
const page = createServer(async (req, res) => {
  if (req.url === "/start/" + loginNonce) {
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": "reach_fixture=" + loginNonce + "; Path=/; HttpOnly; SameSite=Strict",
    });
    res.end();
    return;
  }
  if (req.headers.cookie !== "reach_fixture=" + loginNonce) {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.url === "/label") {
    res.end((await readFile(path.join(repairDir, "label.txt"), "utf8")).trim());
  } else if (req.url === "/sample") {
    res.setHeader("Content-Disposition", 'attachment; filename="reach-control.txt"');
    res.end(expected);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<title>" +
        title +
        "</title><h1>" +
        title +
        "</h1><a href='/sample'>" +
        (repair ? "Broken sample" : "Download sample") +
        "</a>" +
        (repair
          ? "<script>setInterval(async()=>document.querySelector('a').textContent=await(await fetch('/label')).text(),400)</script>"
          : ""),
    );
  }
});
page.listen(0, "127.0.0.1");
await once(page, "listening");
const origin = "http://127.0.0.1:" + page.address().port;
const token = randomUUID();
const config = loadConfig(
  {
    MCP_AUTH_TOKEN: token,
    MCP_DEFAULT_CWD: scratch,
    KRAKO_REACH_STATE_DIR: path.join(scratch, "state"),
    KRAKO_REACH_CONSOLE_ENABLED: "false",
  },
  scratch,
);
config.port = 0;
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const useCDP = !nativeApp && !process.argv.includes("--native-only");
if (useCDP || process.argv.includes("--cdp-down")) process.env.KORA_EXISTING_CHROME_PORT = String(port);
async function connect() {
  const host = await startHttpServer(config, createServices(config));
  const client = new Client({ name: "control-mac-qc", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL("http://127.0.0.1:" + host.httpServer.address().port + "/mcp"),
      { requestInit: { headers: { Authorization: "Bearer " + token } } },
    ),
  );
  return { host, client };
}
let { host, client } = await connect();
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  assert.ok(!r.isError, JSON.stringify(r.structuredContent));
  return r.structuredContent;
};
let chrome;
let occluder;
try {
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await writeFile(
    path.join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: scratch, prompt_for_download: false } }),
  );
  if (nativeApp) {
    const app = path.join(scratch, "ReachTest.app/Contents");
    await mkdir(path.join(app, "MacOS"), { recursive: true });
    await writeFile(
      path.join(app, "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>xyz.krako.reach.qcfixture</string><key>CFBundleName</key><string>ReachTest</string><key>CFBundleExecutable</key><string>ReachTest</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>',
    );
    const bin = path.join(app, "MacOS/ReachTest");
    execFileSync("/usr/bin/swiftc", ["test/helpers/control-app.swift", "-o", bin]);
    chrome = spawn(bin, [title, filename, ...(sheet ? ["--sheet", "-AppleLanguages", "(en)"] : [])], {
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 900));
  } else
    chrome = spawn(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        ...(useCDP
          ? [
              ...((repair || process.argv.includes("--headless")) ? ["--headless=new", "--disable-gpu"] : []),
              "--remote-debugging-address=127.0.0.1",
              "--remote-debugging-port=" + port,
            ]
          : []),
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--force-renderer-accessibility",
        origin + "/start/" + loginNonce,
      ],
      { stdio: "ignore" },
    );
  let jobId = randomUUID();
  const target = nativeApp
    ? { session: "existing", bundle: "xyz.krako.reach.qcfixture", title }
    : { session: "existing", bundle: "com.google.Chrome", title, origin };
  const unattended = process.argv.includes("--unattended");
  const fixture = {
    startInBackground: unattended,
    onCodeDefect: repair ? "repair_once" : "return_to_chat",
    captureDownload: useCDP,
    target,
    button: nativeApp ? (visual ? "Unlabelled visual target" : "Save sample") : "Download sample",
    verify: { kind: "file", path: filename, containsText: expected },
  };
  if (sheet) {
    const first = randomUUID();
    await call("control_begin", {
      jobId: first,
      plan: { target, button: "Save sample", verify: { kind: "control", name: "Save" } },
    });
    const opened = await call("control_run", { jobId: first });
    assert.ok(["verified", "outcome_unverified"].includes(opened.status));
    await new Promise((r) => setTimeout(r, 800));
    fixture.button = "Save";
  }
  if (visual) {
    occluder = spawn(path.join(scratch, "ReachTest.app/Contents/MacOS/ReachTest"),
      [title + " cover", path.join(scratch, "must-not-write.txt")], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 900));
  }
  if (unattended) await new Promise((r) => setTimeout(r, 1800));
  if (visual) {
    await assert.rejects(readFile(filename), {code:"ENOENT"}, "target before tools");
    await assert.rejects(readFile(path.join(scratch,"must-not-write.txt")), {code:"ENOENT"}, "cover before tools");
  }
  await call("control_begin", { jobId, plan: fixture });
  const discovery = await call("control_discover", { bundle: target.bundle, titleContains: title });
  if (nativeApp) assert.ok(discovery.windows.some((w) => w.title === title));
  let state;
  if (repair) {
    if (!unattended) {
      await new Promise((r) => setTimeout(r, 2500));
      const blocked = await call("control_run", { jobId });
      assert.equal(blocked.status, "web_control_missing");
      const handoff = await call("control_repair", { jobId, confirmedCodeDefect: true });
      assert.ok(handoff.repair.id);
      const repeated = await call("control_repair", { jobId, confirmedCodeDefect: true });
      assert.equal(repeated.repair.id, handoff.repair.id);
    }
    if (process.argv.includes("--restart")) {
      await client.close();
      await host.close();
      await new Promise((r) => setTimeout(r, 800));
      ({ host, client } = await connect());
    }
    for (let i = 0; i < 300; i++) {
      const result = await call("control_status", { jobId });
      if (result.repair.id && result.repair.status !== "running") {
        assert.equal(result.repair.status, "succeeded");
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.equal((await readFile(path.join(repairDir, "label.txt"), "utf8")).trim(), "Download sample");
    // Wait for the server to resume the UI without another control_run call.
    for (let i = 0; i < 25; i++) {
      if ((await call("control_status", { jobId })).evidence) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal((await call("control_status", { jobId })).evidence, true);
    console.log("Coding repair, independent local test and automatic UI resumption: PASS");
  }
  for (let n = 0; n < (visual ? 3 : 6); n++) {
    state = await call("control_run", { jobId });
    if (visual && !fixture.allowFocus) {
      await assert.rejects(readFile(path.join(scratch,"must-not-write.txt")), {code:"ENOENT"}, "cover after inspect");
    }
    if (visual && state.status === "visual_review") {
      const frame = await call("control_frame", { jobId });
      const stale = await call("control_run", {
        jobId,
        point: { frameHash: "0".repeat(64), x: 0.5, y: 0.6 },
      });
      assert.equal(stale.status, "frame_changed");
      if (!fixture.allowFocus) await assert.rejects(readFile(path.join(scratch,"must-not-write.txt")), {code:"ENOENT"}, "cover after stale frame");
      state = await call("control_run", { jobId, point: { frameHash: frame.frameHash, x: 0.5, y: 0.6 } });
      console.log("Visual dispatch", JSON.stringify(state));
      if (!fixture.allowFocus) {
        assert.equal(state.status, "target_occluded");
        await assert.rejects(readFile(filename), { code: "ENOENT" });
        await assert.rejects(readFile(path.join(scratch, "must-not-write.txt")), { code: "ENOENT" });
        console.log("Occluded target: no click dispatched, both files absent: PASS");
        fixture.allowFocus = true;
        jobId = randomUUID();
        await call("control_begin", { jobId, plan: fixture });
      }

    }
    if (state.evidence || state.status === "outcome_unverified") break;
    await new Promise((r) => setTimeout(r, 450));
  }
  console.log("selected route", JSON.stringify(state));
  for (let n = 0; n < 15; n++) {
    state = await call("control_status", { jobId });
    if (state.evidence) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(state.status, "verified");
  const read = await call("read_file", { path: filename });
  assert.equal(read.content, expected);
  if (process.argv.includes("--open")) {
    console.log(
      execFileSync("/usr/bin/swift", ["test/helpers/open-document.swift", filename, expected.trim()], {
        encoding: "utf8",
        timeout: 22000,
      }).trim(),
    );
  }
  assert.equal((await call("control_run", { jobId })).status, "verified");
  console.log(
    (nativeApp ? "Native AppKit" : "Existing Chrome") + " / contents verified / repeat suppressed: PASS",
  );
} finally {
  for (const child of [occluder, chrome]) {
    if (child && child.exitCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
  }
  await client.close();
  await host.close();
  page.close();
  await rm(scratch, { force: true, recursive: true });
}
