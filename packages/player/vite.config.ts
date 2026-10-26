import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

import { tizenManifest } from "./src/tizen-manifest.ts";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string };

// The Player is a Tizen web app: `pnpm build` writes its files to `dist/`,
// which Tizen Studio signs and packages as a `.wgt` (see
// docs/processes/installing-the-player-with-tizen-studio.md). `public/` is
// copied as is, beside the one script and the manifest.
//
// The 2018 TVs run Tizen 4, whose web engine is Chromium 56. That has no
// modules, so the script is a classic one, and not all of ES2017, such as
// String padding, so it is written as ES2016: async functions become
// generators. `es-check` then checks the script holds nothing newer (see
// `.escheckrc`).
export default defineConfig({
  build: {
    target: "es2016",
    lib: {
      entry: "src/main.ts",
      formats: ["iife"],
      name: "MediaCentrePlayer",
      fileName: () => "player.js",
    },
  },
  plugins: [
    {
      name: "tizen-manifest",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "config.xml", source: tizenManifest(version) });
      },
    },
  ],
  test: {
    name: "player",
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});
