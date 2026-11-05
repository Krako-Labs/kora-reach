import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src/console", { recursive: true });
await cp("src/console", "dist/src/console", { recursive: true });

await cp("src/reach-runner.mjs", "dist/src/reach-runner.mjs");

await import("./build-ui.mjs");

for (const asset of ["window-control.swift", "window-text.swift", "find-tab.jxa", "control-repair.mjs"]) {
  await cp("src/" + asset, "dist/src/" + asset);
}

if (process.platform === "darwin") {
  const { execFileSync } = await import("node:child_process");
  for (const helper of ["window-control", "window-text"]) {
    execFileSync("/usr/bin/swiftc", [
      "src/" + helper + ".swift", "-o", "dist/src/" + helper + "-" + process.arch,
    ], { stdio: "inherit" });
  }
}
