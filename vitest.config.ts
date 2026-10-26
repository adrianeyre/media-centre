import { defineConfig } from "vitest/config";

// One run covers every package. The Remote's and the Player's tests run in a
// simulated browser, each configured beside it; the rest run in Node. The
// Playwright end-to-end tests in `e2e/` are run separately, by `pnpm test:e2e`.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "node", include: ["packages/{hub,shared}/src/**/*.test.ts", "eslint-rules/**/*.test.ts"] },
      },
      "packages/remote",
      "packages/player",
    ],
  },
});
