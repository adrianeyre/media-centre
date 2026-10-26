import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// The footer's version and its "Website design" link are the repository's own,
// read from its package.json so they are never written twice.
const { version, repository } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
  repository: { url: string };
};

// In production the Hub serves the built Remote itself. `pnpm dev` here only
// serves the Remote, so the API is forwarded to a Hub started with `pnpm start`.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  define: {
    __REMOTE_VERSION__: JSON.stringify(version),
    __REPOSITORY_URL__: JSON.stringify(repository.url.replace(/^git\+/, "").replace(/\.git$/, "")),
  },
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.HUB_PORT ?? 41080}`,
    },
  },
  test: {
    name: "remote",
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
