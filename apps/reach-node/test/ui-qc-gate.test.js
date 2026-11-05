import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("fail-closed macOS UI package gate", () => {
  it("runs strict image QC before creating the package and embeds evidence", async () => {
    const source = await readFile("scripts/package-basic-alpha.mjs", "utf8");
    const gate = source.indexOf("scripts/check-macos-ui-contract.mjs");
    const build = source.indexOf("scripts/build-macos-settings-app.mjs");
    const publish = source.indexOf("await mkdir(output)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(build);
    expect(build).toBeLessThan(publish);
    for (const required of [
      "uiQCReport.result !== \"PASS\"",
      "uiQCReport.candidateReports?.length !== 20",
      "uiQCReportSHA256",
      "uiQCDetectorSHA256",
      "uiQCRequiredStateIds",
      "path.join(output, \"ui-qc\")",
    ]) expect(source).toContain(required);
  });

  it("qualifies native-source checks and the detector with rendered defects", async () => {
    const checker = await readFile("scripts/check-macos-ui-contract.mjs", "utf8");
    const renderer = await readFile("scripts/render-onboarding.mjs", "utf8");
    for (const defect of ["missing-footer", "missing-hero", "clipped-default-footer", "tinted-dark-canvas", "titlebar-seam"]) {
      expect(checker).toContain(defect);
      expect(renderer).toContain(defect);
    }
    expect(checker).toContain("custom-scroller");
    expect(checker).toContain("forbiddenSource");
    expect(checker).toContain("detectorQualification");
    expect(checker).toContain("candidateReports");
  });
});
