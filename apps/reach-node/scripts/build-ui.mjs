import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const result = await build({
  entryPoints: ["src/ui/live-screen.js"],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  write: false,
  logLevel: "silent",
});
const js = result.outputFiles[0].text.replaceAll("</script>", "<\\/script>");
const template = await readFile("src/ui/live-screen.html", "utf8");
if (!template.includes("<!-- KORA_BUNDLED_SCRIPT -->")) throw new Error("UI marker missing");
const html = template.replace("<!-- KORA_BUNDLED_SCRIPT -->", () => "<script>" + js + "</script>");
await mkdir(path.join("dist", "src", "ui"), { recursive: true });
await writeFile(path.join("dist", "src", "ui", "live-screen.html"), html);
console.log("KORA Reach MCP Apps live screen built");
