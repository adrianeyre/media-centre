// Assembles the project website (GitHub Pages) in `site/dist/`: the page, its
// stylesheet, its script (types stripped) and its font from `site/`, its
// product illustrations from `site/stage/dist/`, the screenshots from
// `docs/images/`, and the icons from the Remote, copied rather than kept twice
// in Git. It also writes `CNAME`, `sitemap.xml` and `robots.txt` for the site's
// address. `.github/workflows/pages.yml` runs `pnpm site:build`, which builds
// the illustrations (`pnpm --filter @media-centre/site scenes`) and then runs
// this, and publishes `site/dist/`; run it yourself the same way, then serve
// `site/dist/`.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

/** The repository, named once: every link to it on the page comes from here. */
export const repositoryUrl = "https://github.com/adrianeyre/media-centre";

/**
 * The website's own address, with no trailing slash, for its canonical link,
 * link previews, sitemap and robots.txt: the custom domain set in the
 * repository's Pages settings, which a `CNAME` record at the domain points at
 * `adrianeyre.github.io`. The build writes the `CNAME` file GitHub Pages reads
 * the domain from. Every other URL in the page is relative, so the page still
 * works at the project page's `/media-centre/` path.
 */
export const siteUrl = "https://media-centre.adrianeyre.co.uk";

/** The bare domain of {@link siteUrl}, for the `CNAME` file. */
const siteDomain = new URL(siteUrl).hostname;

const root = join(import.meta.dirname, "..");
const source = import.meta.dirname;
const output = join(source, "dist");

/** Each `{{NAME}}` placeholder in the page, and what it becomes. */
const placeholders: Record<string, string> = {
  REPO_URL: repositoryUrl,
  REPO_NAME: repositoryUrl.split("/").at(-1) ?? "media-centre",
  SITE_URL: siteUrl,
};

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const page = readFileSync(join(source, "index.html"), "utf8").replaceAll(
  /\{\{([A-Z_]+)\}\}/g,
  (match, name: string) => {
    const value = placeholders[name];
    if (value === undefined) {
      throw new Error(`site/index.html names an unknown placeholder ${match}`);
    }
    return value;
  },
);
writeFileSync(join(output, "index.html"), page);
cpSync(join(source, "styles.css"), join(output, "styles.css"));
// The page's script, as the browser runs it: its types stripped, as Node
// strips them.
writeFileSync(join(output, "script.js"), stripTypeScriptTypes(readFileSync(join(source, "script.mts"), "utf8")));
cpSync(join(source, "fonts"), join(output, "fonts"), { recursive: true });
// The illustrations, built by Vite from site/stage/ (see its vite.config.ts).
const scenes = join(source, "stage/dist");
if (!existsSync(join(scenes, "stage.js"))) {
  throw new Error("site/stage/dist/ has not been built: run `pnpm site:build`, which builds it first");
}
cpSync(scenes, join(output, "stage"), { recursive: true });

cpSync(join(root, "docs/images/screenshots"), join(output, "images/screenshots"), { recursive: true });
// The floor plan the Rooms illustration draws on.
cpSync(join(root, "docs/images/floor-plan.png"), join(output, "images/floor-plan.png"));
cpSync(join(root, "packages/remote/brand/icon.svg"), join(output, "brand/icon.svg"));
for (const file of [
  "favicon.ico",
  "favicon.svg",
  "apple-touch-icon.png",
  "og-image.png",
  "mask-icon.svg",
  "icon-192.png",
]) {
  cpSync(join(root, "packages/remote/public", file), join(output, file));
}

// The custom domain, which GitHub Pages reads from the published files.
writeFileSync(
  join(output, "CNAME"),
  `${siteDomain}
`,
);

// For search engines, at the domain's root, where a crawler reads robots.txt;
// the sitemap is named in it.
const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  join(output, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}/</loc>
    <lastmod>${today}</lastmod>
  </url>
</urlset>
`,
);
writeFileSync(join(output, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);

// Every file the page names by a relative URL must be in the build, so a
// renamed screenshot or icon fails here rather than as a broken image.
const missing = [...page.matchAll(/\b(?:src|href|srcset)="([^"#:{}]+)"/g)]
  .map(([, url]) => url ?? "")
  .filter((url) => url !== "" && !url.startsWith("/") && !existsSync(join(output, url)));
if (missing.length > 0) {
  throw new Error(`site/index.html names files the build has not got: ${[...new Set(missing)].join(", ")}`);
}
if (/(?:src|href)="\/(?!\/)/.test(page)) {
  throw new Error("site/index.html has a root-absolute URL, which breaks at the project page's path");
}

console.log(`Built the website in ${output}`);
