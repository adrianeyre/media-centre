import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";
import tseslint from "typescript-eslint";

import { noInternetUrls } from "./eslint-rules/no-internet-urls.ts";

export default tseslint.config(
  // `.sandcastle/` is the harness that runs the agents, not media-centre itself.
  {
    ignores: ["**/node_modules/", "**/dist/", "test-results/", "playwright-report/", ".sandcastle/"],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  // Nothing the Hub, the Remote or the Player runs may reach the internet (NFR-3).
  {
    files: ["packages/*/src/**"],
    plugins: { "media-centre": { rules: { "no-internet-urls": noInternetUrls } } },
    rules: { "media-centre/no-internet-urls": "error" },
  },
  {
    files: ["packages/remote/src/**", "packages/player/src/**"],
    languageOptions: { globals: { ...globals.browser } },
  },
  // The Remote meets WCAG 2.2 at Level AA, so its markup is checked as it is written.
  { files: ["packages/remote/src/**/*.tsx"], ...jsxA11y.flatConfigs.recommended },
  {
    files: ["packages/remote/src/**/*.tsx"],
    rules: {
      // A region that scrolls, such as a dialog's body, is focusable so it can be scrolled from the keyboard.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: [], roles: ["tabpanel", "region"] }],
    },
  },
  { files: ["**/*.js"], ...tseslint.configs.disableTypeChecked },
  // Formatting is Prettier's: `pnpm format`. This turns off the rules it would fight with.
  prettier,
);
