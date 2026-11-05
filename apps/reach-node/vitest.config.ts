import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,js}"],
    exclude: [
      "codex/**", "node_modules/**", "dist/**",
      // macOS app packaging is a separate distribution; this subpackage is the MCP Node.
      "test/macos-*.test.js",
      "test/release-readiness.test.js",
      "test/ui-qc-gate.test.js",
      "test/package-evidence.test.js",
    ],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
