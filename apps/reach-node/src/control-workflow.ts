import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, lstat, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { McpServices } from "./mcp-server.js";
import type { AppConfig } from "./config.js";
import { atomicJson, durableExclusiveClaim, durableLink, syncDirectory } from "./reach-durability.js";
import { FileEvidence } from "./file-evidence.js";
import { locateKoraCli } from "./kora-tools.js";
import { errorResult, imageResult, runAuditedTool } from "./tool-result.js";

const exec = promisify(execFile);
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const writes = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const assets = path.dirname(fileURLToPath(import.meta.url));
const origin = z
  .url()
  .refine((s) => /^https?:\/\//.test(s) && new URL(s).origin === s, "Use an exact HTTP(S) origin");
const target = z
  .object({
    session: z.enum(["managed", "existing"]),
    bundle: z.string().regex(/^[\w.-]{1,160}$/),
    title: z.string().trim().min(1).max(256),
    accountControl: z.string().trim().min(1).max(180).optional(),
    origin: origin.optional(),
  })
  .refine(
    (t) =>
      (!["com.google.Chrome", "com.apple.Safari"].includes(t.bundle) || !!t.origin) &&
      (t.session !== "managed" || t.bundle === "com.google.Chrome"),
    "Browser control requires the expected origin",
  );
const plan = z.object({
  startInBackground: z.boolean().default(false),
  allowFocus: z.boolean().default(false),
  onCodeDefect: z.enum(["return_to_chat", "repair_once"]).default("return_to_chat"),
  captureDownload: z.boolean().default(false),
  target,
  button: z.string().trim().min(1).max(180),
  verify: z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("file"),
        path: z.string().min(1),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        containsText: z.string().min(1).max(1024).optional(),
      })
      .refine((v) => !!v.sha256 || !!v.containsText, "Provide expected text or SHA-256"),
    z.object({ kind: z.literal("control"), name: z.string().trim().min(1).max(180) }),
  ]),
});
type Plan = z.infer<typeof plan>;
type Target = Plan["target"];
type Native = {
  status: string;
  matched?: number;
  controls?: string[];
  windows?: Array<{ title: string; pid: number }>;
  pid?: number;
  windowID?: number;
};
const codeIs = (e: unknown, code: string) => (e as NodeJS.ErrnoException)?.code === code;
const frameDigest = (f: {data: Buffer; id: number; pid?: number}) =>
  createHash("sha256").update(`${f.id}:${f.pid}:`).update(f.data).digest("hex");

function swift(helper: string, args: string[], timeout: number) {
  const compiled = path.join(assets, helper + "-" + process.arch);
  return existsSync(compiled)
    ? exec(compiled, args, { timeout, maxBuffer: 100_000 })
    : exec("/usr/bin/swift", [path.join(assets, helper + ".swift"), ...args], {
        timeout,
        maxBuffer: 100_000,
      });
}

async function native(mode: string, t: Target, name: string, expectedPid?: number): Promise<Native> {
  if (process.platform !== "darwin") return { status: "native_unavailable" };
  const { stdout } = await swift(
    "window-control",
    [mode, t.bundle, t.title, t.origin ?? "", name, String(expectedPid ?? 0)],
    18000,
  );
  return JSON.parse(stdout);
}
async function selectTab(t: Target) {
  const { stdout } = await exec(
    "/usr/bin/osascript",
    ["-l", "JavaScript", path.join(assets, "find-tab.jxa"), t.bundle, t.title, t.origin ?? ""],
    { timeout: 5000 },
  );
  return stdout.trim();
}

export function registerControlWorkflow(
  server: McpServer | undefined,
  config: AppConfig,
  services: McpServices,
) {
  const files = services.fileService;
  const browser = services.browser;
  const dir = (id: string) => path.join(config.reachStateDirectory, "control-jobs", z.uuid().parse(id));
  const queue = path.join(config.reachStateDirectory, "control-repair-queue");
  const load = async (id: string) =>
    plan.parse(JSON.parse(await readFile(path.join(dir(id), "plan.json"), "utf8")));
  const audit = (action: string, fn: () => Promise<Record<string, unknown>>) =>
    runAuditedTool(files.audit, action, fn);
  const schemaId = { jobId: z.uuid() };

  server?.registerTool(
    "control_discover",
    {
      annotations: readOnly,
      description:
        "Find matching real Mac windows and existing Chrome or Safari tabs before choosing a route. No browser is started.",
      inputSchema: {
        bundle: z.string().regex(/^[\w.-]{1,160}$/),
        titleContains: z.string().max(180).default(""),
        origin: origin.optional(),
      },
    },
    ({ bundle, titleContains, origin: site }) =>
      audit("control_discover", async () => {
        const scope: Target = { session: "existing", bundle, title: titleContains, origin: site };
        const found = await native("discover", scope, "");
        const sources: Record<string, unknown> = { windows: found.windows ?? [] };
        if (bundle === "com.google.Chrome" || bundle === "com.apple.Safari") {
          try {
            const result = await exec(
              "/usr/bin/osascript",
              [
                "-l",
                "JavaScript",
                path.join(assets, "find-tab.jxa"),
                bundle,
                titleContains,
                site ?? "",
                "discover",
              ],
              { timeout: 4000 },
            );
            sources.existingTabs = JSON.parse(result.stdout);
          } catch {
            sources.tabDiscovery = "native_browser_automation_unavailable";
          }
          if (bundle === "com.google.Chrome")
            for (const [session, port] of [
              ["managed", browser],
              ["attached", services.existingChrome],
            ] as const) {
              if (!port) continue;
              try {
                sources[session] = (await port.listTabs())
                  .filter(
                    (t) =>
                      t.title.toLowerCase().includes(titleContains.toLowerCase()) &&
                      (!site || t.origin === site),
                  )
                  .slice(0, 40)
                  .map(({ title, origin }) => ({ title, origin }));
              } catch {
                sources[session] = "unavailable";
              }
            }
        }
        return sources;
      }),
  );

  async function inspect(t: Target, name: string, allowSelection: boolean, skipDOM = false, requireCDP = false) {
    const attempts: string[] = [];
    const dom =
      t.session === "managed"
        ? browser
        : t.bundle === "com.google.Chrome"
          ? services.existingChrome
          : undefined;
    if (t.session === "managed" && skipDOM && !browser.managedPid?.())
      return { status: "managed_identity_unavailable", attempts };
    if (dom && !skipDOM) {
      try {
        const tabs = (await dom.listTabs()).filter((tab) => tab.origin === t.origin && tab.title === t.title);
        if (tabs.length > 1) return { status: "ambiguous_tab", attempts };
        if (tabs.length === 1) {
          const snapshot = await dom.snapshot(tabs[0]!.id, 1000);
          if (snapshot.origin !== t.origin) return { status: "target_changed", attempts };
          if (t.accountControl && snapshot.elements.filter((e) => e.name === t.accountControl).length !== 1)
            return { status: "account_unverified", attempts };
          const hits = snapshot.elements.filter((e) => e.name === name);
          if (hits.length === 1 && !snapshot.truncated)
            return { status: "ready", route: "cdp", tab: tabs[0]!.id, ref: hits[0]!.ref, attempts };
          if (!hits.length && !snapshot.truncated) attempts.push("cdp_control_missing");
          if (hits.length > 1) return { status: "ambiguous_control", attempts };
        }
        attempts.push("cdp_target_missing");
      } catch {
        attempts.push("cdp_unavailable");
      }
      // A native fallback must belong to the same managed Chrome process.
      if (t.session === "managed" && !browser.managedPid?.())
        return { status: "managed_identity_unavailable", attempts };
    }
    // Guarded downloads cannot use AX, OCR, AppleScript tab selection or
    // native clicks: those paths cannot control the file destination.
    // A definite missing DOM control is a code-defect signal even for guarded
    // downloads. Return it for the optional authorized repair workflow, but
    // NEVER fall back to an unguarded native click or tab selection.
    if (requireCDP) return {
      status: attempts.includes("cdp_control_missing") ? "web_control_missing" : "capture_route_unavailable",
      attempts,
    };
    let view = await native("observe", t, name);
    if (allowSelection && t.session === "existing" && view.status === "window_missing" && t.origin) {
      try {
        attempts.push(await selectTab(t));
      } catch {
        attempts.push("tab_automation_unavailable");
      }
      view = await native("observe", t, name);
    }
    attempts.push(view.status);
    if (["window_missing", "origin_unverified", "incomplete_tree"].includes(view.status)) {
      view = await native("visualInspect", t, name);
      attempts.push(view.status);
    }
    if (view.status !== "observed")
      return {
        status: attempts.includes("cdp_control_missing") ? "web_control_missing" : view.status,
        attempts,
      };
    if (!identityOK(t, view)) return { status: "target_changed", attempts };
    if (t.accountControl) {
      const account = await native("observe", t, t.accountControl, view.pid);
      if (account.matched !== 1) return { status: "account_unverified", attempts };
    }
    if (view.matched === 1) return { status: "ready", route: "ax", pid: view.pid, attempts };
    return { status: view.matched ? "ambiguous_control" : "visual_review", attempts };
  }
  function identityOK(t: Target, view: Native & { pid?: number }) {
    return t.session === "managed"
      ? view.pid === browser.managedPid?.() && !!view.pid
      : !view.pid || view.pid !== browser.managedPid?.();
  }
  async function verified(p: Plan) {
    if (p.verify.kind === "control")
      return (await inspect(p.target, p.verify.name, false)).status === "ready";
    const filename = files.resolve(p.verify.path);
    try {
      const fd = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await fd.stat();
        if (!st.isFile() || st.size > 32 * 1024 * 1024)
          throw new Error("Verification requires a regular file up to 32 MiB");
        const evidence = new FileEvidence(p.verify.sha256, p.verify.containsText);
        for await (const chunk of fd.createReadStream({ autoClose: false })) evidence.update(chunk);
        return evidence.bytes === st.size && evidence.matches();
      } finally {
        await fd.close();
      }
    } catch (e) {
      if (codeIs(e, "ENOENT")) return false;
      throw e;
    }
  }
  async function claim(id: string, key: string) {
    return durableExclusiveClaim(path.join(dir(id), key));
  }
  async function readStatus(id: string) {
    const p = await load(id);
    const evidence = await verified(p);
    let last = { status: "planned" };
    try {
      last = JSON.parse(await readFile(path.join(dir(id), "last.json"), "utf8"));
    } catch (e) {
      if (!codeIs(e, "ENOENT")) throw e;
    }
    let dispatched = false;
    try {
      await readFile(path.join(dir(id), "effect"));
      dispatched = true;
    } catch (e) {
      if (!codeIs(e, "ENOENT")) throw e;
    }
    return {
      jobId: id,
      target: p.target,
      button: p.button,
      evidence,
      last,
      repair: await repairState(id),
      sessionWait: await sessionWait(id),
      status: evidence ? "verified" : dispatched ? "outcome_unverified" : last.status,
    };
  }

  server?.registerTool(
    "control_begin",
    {
      annotations: writes,
      description:
        "Start a resumable UI step on this Mac. Use existing for personal Chrome/Safari or a native app and managed only for Reach Chrome. Supply exact window/tab title and the expected outcome. Reuse jobId after a lost response. startInBackground also waits up to 24 hours for a locked console, checking at most once per minute without bypassing authentication.",
      inputSchema: { ...schemaId, plan },
    },
    ({ jobId, plan: p }) =>
      audit("control_begin", async () => {
        files.policy?.execution();
        if (p.verify.kind === "file") files.resolve(p.verify.path);
        await mkdir(dir(jobId), { recursive: true, mode: 0o700 });
        await syncDirectory(path.dirname(dir(jobId)));
        const filename = path.join(dir(jobId), "plan.json");
        // Publish a completely written immutable plan, even across competing clients.
        const temporary = path.join(dir(jobId), randomUUID() + ".tmp");
        const planFile = await open(temporary, "wx", 0o600);
        try {
          await planFile.writeFile(JSON.stringify(p));
          await planFile.sync();
        } finally { await planFile.close(); }
        try {
          await durableLink(temporary, filename);
        } finally {
          await rm(temporary, { force: true });
        }
        if (JSON.stringify(await load(jobId)) !== JSON.stringify(p))
          throw new Error("Job ID belongs to another plan");
        if (p.startInBackground) {
          await mkdir(queue, { recursive: true, mode: 0o700 });
          await syncDirectory(path.dirname(queue));
          await durableLink(filename, path.join(queue, jobId));
        }
        return readStatus(jobId);
      }),
  );
  server?.registerTool(
    "control_status",
    {
      annotations: readOnly,
      description:
        "Reconcile a saved job against its actual expected outcome without dispatching another action.",
      inputSchema: schemaId,
    },
    ({ jobId }) => audit("control_status", () => readStatus(jobId)),
  );

  server?.registerTool(
    "control_run",
    {
      annotations: writes,
      description:
        "Try CDP then scoped native window access. Use a returned window frame for visual fallback. Never repeat a possibly completed click.",
      inputSchema: {
        ...schemaId,
        webConfirmedCodeDefect: z.boolean().default(false),
        point: z
          .object({
            frameHash: z.string().regex(/^[a-f0-9]{64}$/),
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
          })
          .optional(),
      },
    },
    ({ jobId, point, webConfirmedCodeDefect }) =>
      audit("control_run", () => runStep(jobId, point, webConfirmedCodeDefect)),
  );
  async function runStep(
    jobId: string,
    point?: { frameHash: string; x: number; y: number },
    webConfirmedCodeDefect = false,
    skipDOM = false,
  ): Promise<Record<string, unknown>> {
    files.policy?.execution();
    const p = await load(jobId);
    const before = await readStatus(jobId);
    if (before.evidence || before.status === "outcome_unverified") return before;
    if (p.verify.kind === "file" && p.captureDownload) {
      try {
        await lstat(files.resolve(p.verify.path, undefined, true));
        return { jobId, status: "destination_conflict" };
      } catch (e) {
        if (!codeIs(e, "ENOENT")) throw e;
      }
    }
    if (before.repair.status === "running" || before.repair.status === "reserved") return before;
    // Fail before any native inspection, focus or tab selection if the
    // requested capture capability is not present on this browser session.
    const domForCapture = p.target.session === "managed" ? browser : services.existingChrome;
    if (p.captureDownload && (p.verify.kind !== "file" ||
        p.target.bundle !== "com.google.Chrome" || !domForCapture?.captureDownload)) {
      // Reconciliation must show the same safe, pre-dispatch failure instead
      // of reverting to "planned" after the request returns.
      await atomicJson(path.join(dir(jobId), "last.json"), { status: "capture_route_unavailable" });
      return { jobId, status: "capture_route_unavailable", next: "CDP download capture is required; no action dispatched." };
    }
    const route = await inspect(p.target, p.button, true, skipDOM, p.captureDownload);
    if (route.status === "visual_review" && !point) {
      // Focus only with the saved plan's permission, before capturing a new frame.
      // Never raise a window underneath a caller-supplied coordinate frame.
      if (p.allowFocus) {
        const focused = await native("focus", p.target, "", route.pid);
        if (focused.status !== "focused" || !identityOK(p.target, focused)) {
          const result = { status: focused.status === "focused" ? "target_changed" : focused.status };
          await atomicJson(path.join(dir(jobId), "last.json"), result);
          return { jobId, ...result };
        }
      }
      let f;
      try {
        f = await frame(p.target, p.button);
      } catch {
        await atomicJson(path.join(dir(jobId), "last.json"), {
          status: "window_capture_unavailable",
          attempts: route.attempts,
        });
        return {
          jobId,
          status: "window_capture_unavailable",
          next: "Inspect screen recording and GUI session; no action dispatched.",
        };
      }
      if (f.coords) point = { frameHash: frameDigest(f), x: f.coords[0], y: f.coords[1] };
    }
    if (route.status !== "ready" && !(route.status === "visual_review" && point)) {
      await atomicJson(path.join(dir(jobId), "last.json"), route);
      if (
        (webConfirmedCodeDefect || (p.startInBackground && route.status === "web_control_missing")) &&
        p.onCodeDefect === "repair_once" &&
        ["web_control_missing", "visual_review"].includes(route.status) &&
        !point &&
        process.env.KORA_CONTROL_REPAIR_WORKSPACE
      )
        return startRepair(jobId, route.status);
      return { ...route, jobId };
    }
    let at = "";
    if (route.status === "visual_review" && point) {
      const f = await frame(p.target);
      if (frameDigest(f) !== point.frameHash) return { jobId, status: "frame_changed" };
      at = [f.id, point.x, point.y, f.pid].join(",");
    }
    // Download capture owns its destination and verification. A generic native
    // click has no equivalent destination guarantee: never silently fall back.
    if (p.captureDownload && (route.route !== "cdp" ||
        p.verify.kind !== "file" ||
        !(p.target.session === "managed" ? browser : services.existingChrome)?.captureDownload)) {
      return { jobId, status: "capture_route_unavailable", next: "Use a verified CDP download route; no action dispatched." };
    }
    if (!(await claim(jobId, "effect"))) return readStatus(jobId);
    let result = "outcome_unknown";
    let nativeEvidence: Native | undefined;
    try {
      if (route.route === "cdp" && route.tab && route.ref) {
        const dom = p.target.session === "managed" ? browser : services.existingChrome!;
        const current = await dom.getTab(route.tab);
        if (current.title !== p.target.title || current.origin !== p.target.origin)
          throw Object.assign(new Error("target changed"), { code: "STALE_ELEMENT" });
        if (p.captureDownload && p.verify.kind === "file" && dom.captureDownload) {
          await dom.captureDownload(
            route.tab,
            route.ref,
            p.target.origin!,
            files.resolve(p.verify.path, undefined, true),
            p.verify.sha256,
            p.verify.containsText,
            { title: p.target.title, name: p.button },
          );
        } else {
          await dom.act(route.tab, route.ref, "click", undefined, p.target.origin, {
            title: p.target.title,
            name: p.button,
          });
        }
        result = "dispatched";
      } else {
        nativeEvidence = await native(
          at ? "point" : "press",
          p.target,
          at || p.button,
          route.pid || (at ? Number(at.split(",")[3]) : undefined),
        );
        result = nativeEvidence.status;
      }
    } catch (error) {
      // These adapter errors are raised before Playwright dispatches input. A timeout is ambiguous.
      const code = (error as { code?: string }).code ?? "";
      if (
        route.route === "cdp" &&
        [
          "ELEMENT_NOT_FOUND",
          "ELEMENT_NOT_VISIBLE",
          "ELEMENT_DISABLED",
          "STALE_ELEMENT",
          "TAB_NOT_FOUND",
        ].includes(code)
      )
        result = "cdp_before_dispatch";
    } finally {
      await atomicJson(path.join(dir(jobId), "last.json"), {
        status: result,
        route: at ? "visual" : route.route,
        nativeEvidence,
        attempts: route.attempts,
      });
    }
    if (result === "cdp_before_dispatch" && !skipDOM) {
      // A native fallback would lose captureDownload's guarded destination.
      // A confirmed pre-dispatch error is safe to retry only with the same
      // verified CDP capability, never through an unguarded native click.
      await rm(path.join(dir(jobId), "effect"), { force: true });
      await syncDirectory(dir(jobId));
      if (p.captureDownload) return { jobId, status: "capture_route_unavailable", next: "CDP download unavailable; no native click dispatched." };
      return runStep(jobId, point, false, true);
    }
    if (
      [
        "target_changed",
        "target_occluded",
        "visual_events_disabled",
        "session_locked",
        "origin_unverified",
        "window_capture_unavailable",
      ].includes(result)
    ) {
      // These helper statuses are all returned before any mouse or AX event.
      await rm(path.join(dir(jobId), "effect"), { force: true });
      await syncDirectory(dir(jobId));
    }
    return readStatus(jobId);
  }
  async function frame(t: Target, label?: string) {
    const view = await native("frame", t, "");
    if (!identityOK(t, view) || !view.windowID)
      throw new Error("No unique verified window is available for capture");
    if (t.accountControl && (await native("observe", t, t.accountControl, view.pid)).matched !== 1)
      throw new Error("Account identity unverified");
    const folder = await mkdtemp(path.join(tmpdir(), "reach-window-"));
    try {
      const dest = path.join(folder, "window.png");
      await exec("/usr/sbin/screencapture", ["-x", "-o", "-l", String(view.windowID), dest], {
        timeout: 6000,
      });
      let coords: [number, number] | null = null;
      if (label) {
        const ocr = await swift("window-text", [dest, label], 2500).catch(() => ({ stdout: "null" }));
        coords = z
          .tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
          .nullable()
          .parse(JSON.parse(ocr.stdout));
      }
      return { id: view.windowID, pid: view.pid, data: await readFile(dest), coords };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  server?.registerTool(
    "control_frame",
    {
      annotations: readOnly,
      description:
        "Inspect only the requested window for a saved visual-review step. Use relative image coordinates and the returned frame hash.",
      inputSchema: schemaId,
    },
    async ({ jobId }) => {
      try {
        const p = await load(jobId);
        const f = await files.audit.run("mcp", "control_frame", () => frame(p.target));
        return imageResult(
          { data: f.data.toString("base64"), mimeType: "image/png" },
          { jobId, frameHash: frameDigest(f) },
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server?.registerTool(
    "control_repair",
    {
      annotations: writes,
      description:
        "One operator-enabled Codex coding fallback for a confirmed UI integration defect. Uses only the operator-configured repair checkout. Never handles login, permissions, or an uncertain click. Recheck original UI evidence after repair.",
      inputSchema: { ...schemaId, confirmedCodeDefect: z.literal(true) },
    },
    ({ jobId }) =>
      audit("control_repair", async () => {
        files.policy?.execution();
        const state = await readStatus(jobId);
        return startRepair(jobId, state.status);
      }),
  );
  async function startRepair(jobId: string, reason: string) {
    if ((await load(jobId)).onCodeDefect !== "repair_once")
      throw new Error("No coding repair budget for this job");
    const workspace = process.env.KORA_CONTROL_REPAIR_WORKSPACE;
    const jobs = services.repairJobs;
    if (!workspace || !path.isAbsolute(workspace) || !jobs)
      throw new Error("Codex fallback disabled on this host");
    if (!["web_control_missing", "visual_review"].includes(reason))
      throw new Error("Job is not eligible for code repair");
    const cwd = files.resolve(".", workspace, true);
    const cli = locateKoraCli();
    if (!(await claim(jobId, "codex-used"))) return { jobId, repair: await repairState(jobId) };
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const command = [process.execPath, path.join(assets, "control-repair.mjs"), cli, jobId, reason]
      .map(quote)
      .join(" ");
    await mkdir(queue, { recursive: true, mode: 0o700 });
    await syncDirectory(path.dirname(queue));
    await durableLink(path.join(dir(jobId), "plan.json"), path.join(queue, jobId));
    const task = await jobs.start(command, cwd);
    await atomicJson(path.join(dir(jobId), "repair.json"), { id: task.id });
    return {
      jobId,
      repair: await repairState(jobId),
      next: "Check control_status, resume control_run and verify the original outcome.",
    };
  }
  async function repairState(id: string): Promise<{ id?: string; status?: string }> {
    try {
      const record = JSON.parse(await readFile(path.join(dir(id), "repair.json"), "utf8"));
      const job = services.repairJobs?.list().find((j) => j.id === record.id);
      return { id: record.id, status: job?.status ?? "unverified" };
    } catch (e) {
      if (!codeIs(e, "ENOENT")) throw e;
      try {
        await readFile(path.join(dir(id), "codex-used"));
        const match = services.repairJobs
          ?.list()
          .find(
            (job) =>
              job.command.includes("'" + path.join(assets, "control-repair.mjs") + "'") &&
              job.command.includes("'" + id + "'"),
          );
        if (match) return { id: match.id, status: match.status };
        return { status: "reserved" };
      } catch (err) {
        if (!codeIs(err, "ENOENT")) throw err;
        return {};
      }
    }
  }
  const waitSchema = z.object({
    firstBlockedAt: z.number().finite().nonnegative(),
    nextAttemptAt: z.number().finite().nonnegative(),
  });
  async function sessionWait(id: string) {
    try {
      return waitSchema.parse(JSON.parse(await readFile(path.join(dir(id), "session-wait.json"), "utf8")));
    } catch (e) {
      if (codeIs(e, "ENOENT")) return undefined;
      throw e;
    }
  }
  async function retainLockedStep(id: string, result: Record<string, unknown>) {
    if (result.status !== "session_locked") return false;
    const now = Date.now();
    const firstBlockedAt = (await sessionWait(id))?.firstBlockedAt ?? now;
    await atomicJson(path.join(dir(id), "session-wait.json"), {
      firstBlockedAt, nextAttemptAt: now + 60_000,
    });
    return true;
  }
  return async function resumeCompletedRepairs() {
    let ids: string[];
    try {
      ids = await readdir(queue);
    } catch (e) {
      if (codeIs(e, "ENOENT")) return;
      throw e;
    }
    for (const id of ids) {
      if (!z.uuid().safeParse(id).success) continue;
      try {
        const waiting = await sessionWait(id);
        if (waiting && Date.now() - waiting.firstBlockedAt >= 24 * 60 * 60_000) {
          await atomicJson(path.join(dir(id), "last.json"), { status: "session_wait_expired" });
          await rm(path.join(queue, id), { force: true });
          await rm(path.join(dir(id), "session-wait.json"), { force: true });
          continue;
        }
        if (waiting && Date.now() < waiting.nextAttemptAt) continue;
        const repair = await repairState(id);
        if (!repair.id && !repair.status) {
          if ((await load(id)).startInBackground) {
            const result = await files.audit.run("mcp", "control_background_step", () => runStep(id));
            if (await retainLockedStep(id, result)) continue;
            if ((await repairState(id)).status) continue;
          }
          await rm(path.join(queue, id), { force: true });
          await rm(path.join(dir(id), "session-wait.json"), { force: true });
          continue;
        }
        if (!repair.id || repair.status === "running") continue;
        if (repair.status === "succeeded") {
          // Recheck the original UI goal. The durable effect claim prevents duplicate dispatch.
          const result = await files.audit.run("mcp", "control_resume_repaired", () => runStep(id));
          if (await retainLockedStep(id, result)) continue;
        }
        await rm(path.join(queue, id), { force: true });
        await rm(path.join(dir(id), "session-wait.json"), { force: true });
      } catch {
        // Keep the original plan/evidence for inspection, but do not let a poison
        // item monopolize the background loop or repeatedly log sensitive errors.
        await atomicJson(path.join(dir(id), "last.json"), {status:"background_reconciliation_failed"}).catch(()=>{});
        await rm(path.join(queue,id), {force:true});
        await rm(path.join(dir(id), "session-wait.json"), { force: true });
        console.error("Control job reconciliation failed:", id);
      }
    }
  };
}
