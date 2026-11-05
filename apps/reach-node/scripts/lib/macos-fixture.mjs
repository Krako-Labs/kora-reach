import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function freePort() {
  const s = createServer();
  await new Promise((resolve, reject) => { s.once("error", reject); s.listen(0, "127.0.0.1", resolve); });
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
}
export async function makeProfile(root, name) {
  const profile = path.join(root, name), workspace = path.join(root, name + "-workspace");
  await mkdir(profile, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const config = { version: 1, workspace, port: await freePort(), authToken: randomBytes(32).toString("hex"), openBrowser: false };
  const file = path.join(profile, "launcher.json");
  const save = () => writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await save();
  return { profile, workspace, config, file, save,
    base: "http://127.0.0.1:" + config.port,
    headers: { Authorization: "Bearer " + config.authToken, "Content-Type": "application/json" } };
}
export async function stop(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(resolve => child.once("close", resolve));
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await done; clearTimeout(timer);
}
export async function launch(app, profile, { failure = false } = {}) {
  const layout = await packageLayout(app);
  const child = spawn(path.join(app, "Contents", "MacOS", "Reach"), [], {
    env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      KRAKO_REACH_APP_PROFILE: profile.profile,
      MCP_HOST: "0.0.0.0", MCP_ALLOW_NO_AUTH: "true", NODE_OPTIONS: "--definitely-invalid-node-option" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", error = "", spawnError = false, closed = false;
  child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); });
  child.stderr.on("data", bytes => { error = (error + bytes).slice(-16384); });
  child.on("error", () => { spawnError = true; });
  child.on("close", () => { closed = true; });
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (spawnError || closed || child.exitCode !== null || child.signalCode !== null) {
      if (failure && child.exitCode !== 0 && !output.includes(" ready at ") &&
          (!profile.config.authToken || (!output.includes(profile.config.authToken) && !error.includes(profile.config.authToken))))
        return { child, output, error };
      throw new Error("Packaged node exited before readiness (exit " + child.exitCode + ", signal " + child.signalCode + "): " + (profile.config.authToken ? error.replaceAll(profile.config.authToken, "[redacted]") : error));
    }
    if (!failure && output.includes(layout.ready + profile.base + "/console/")) {
      try {
        const response = await fetch(profile.base + "/api/reach/node", { headers: profile.headers, signal: AbortSignal.timeout(300) });
        const data = await response.json();
        if (response.ok && data.node?.protocolVersion === "reach/1") return { child, node: data.node };
      } catch {}
    }
    await pause(25);
  }
  await stop(child);
  throw new Error("Packaged node readiness deadline");
}
export async function until(read, predicate) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await pause(40); }
  throw new Error("Packaged fixture observation deadline");
}

export async function packageLayout(app) {
  let kind = "development";
  try {
    const meta = JSON.parse(await readFile(path.join(app, "Contents/Resources/candidate.json"), "utf8"));
    if (meta.profileKind !== "candidate" || meta.kind !== "unsigned-release-candidate") throw new Error("Invalid candidate fixture");
    kind = "candidate";
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const pkg = JSON.parse(await readFile(path.join(app, "Contents/Resources/app/package.json"), "utf8"));
  return { kind, version: pkg.version, ready: "KRAKO Reach " + kind + " ready at ",
    marker: ".reach-" + kind + "-profile", markerValue: "reach-" + kind + "-state/1\n",
    node: path.join(app, kind === "candidate" ? "Contents/Helpers/node" : "Contents/Resources/runtime/bin/node") };
}
