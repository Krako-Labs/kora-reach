import os from "node:os";
import path from "node:path";

export function expandPath(input: string, baseDirectory: string): string {
  const expanded = input === "~"
    ? os.homedir()
    : input.startsWith("~/")
      ? path.join(os.homedir(), input.slice(2))
      : input;
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(baseDirectory, expanded);
}
