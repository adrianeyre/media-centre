/**
 * Sets the version in the repository's package.json and in every package's,
 * so the Remote's footer, the Hub's `/api/hub` and the update check all
 * agree with the release semantic-release has just tagged.
 *
 * semantic-release runs this as it prepares a release (see `.releaserc.json`)
 * in place of `@semantic-release/npm`, which would run `npm version`: npm
 * refuses this pnpm workspace's `devEngines`, and would only change the
 * repository's own package.json, leaving the Hub's behind.
 *
 *   node scripts/set-version.ts 1.2.3
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`Usage: node scripts/set-version.ts <version>, not "${version}"`);
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const packages = join(root, "packages");
const files = [
  join(root, "package.json"),
  ...readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packages, entry.name, "package.json")),
];

for (const file of files) {
  const json = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
  json.version = version;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file}: ${version}`);
}
