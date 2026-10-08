import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src/console", { recursive: true });
await cp("src/console", "dist/src/console", { recursive: true });

await cp("src/reach-runner.mjs", "dist/src/reach-runner.mjs");

await import("./build-ui.mjs");
