import { defineConfig } from "vite";

// Builds the website's illustrations (main.tsx and the scenes it mounts) into
// stage/dist/: one script, stage.js, and one stylesheet, stage.css, which
// site/build.ts copies into the website beside the page. `pnpm scenes:dev`
// serves preview.html, every scene on one page, while drawing them.
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  oxc: { jsx: { runtime: "automatic", importSource: "react" } },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    rolldownOptions: {
      // lucide-react marks its modules "use client", for React Server
      // Components, which mean nothing in a page's bundle.
      onLog(level, log, handler) {
        if (log.code === "MODULE_LEVEL_DIRECTIVE") return;
        handler(level, log);
      },
    },
    lib: {
      entry: "main.tsx",
      formats: ["es"],
      fileName: () => "stage.js",
      cssFileName: "stage",
    },
  },
});
