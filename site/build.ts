// Assembles the project website (GitHub Pages) in `site/dist/`: the page, its
// stylesheet, its script (types stripped) and its font from `site/`, its
// product illustrations from `site/stage/dist/`, the screenshots from
// `docs/images/`, and the icons from the Remote, copied rather than kept twice
// in Git. It also writes `CNAME`, `sitemap.xml` and `robots.txt` for the site's
// address. `.github/workflows/pages.yml` runs `pnpm site:build`, which builds
// the illustrations (`pnpm --filter @media-centre/site scenes`) and then runs
// this, and publishes `site/dist/`; run it yourself the same way, then serve
// `site/dist/`.
import { execFileSync } from "node:child_process";
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

/**
 * The IndexNow key: Bing, Yandex, Seznam, Naver and Yep read it from
 * `/<key>.txt` to trust that a ping about this site came from its owner. It
 * is public by design; pages.yml pings with it after each deployment.
 */
export const indexNowKey = "6dcb83f617a0bfa53d71e0f371068d5f";

/** The released version, which semantic-release writes to package.json. */
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

/**
 * When the site last changed: the last commit's date, which is stable from
 * build to build, unlike the build's own date, so search engines can trust
 * the sitemap's `lastmod`. Pages.yml only builds when the site's files change.
 */
function lastModified(): string {
  try {
    const date = execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: root, encoding: "utf8" }).trim();
    if (date !== "") return new Date(date).toISOString();
  } catch {
    // Not a Git checkout: fall back to now.
  }
  return new Date().toISOString();
}
const dateModified = lastModified();

/** Each `{{NAME}}` placeholder in the pages, and what it becomes. */
const placeholders: Record<string, string> = {
  REPO_URL: repositoryUrl,
  REPO_NAME: repositoryUrl.split("/").at(-1) ?? "media-centre",
  SITE_URL: siteUrl,
  VERSION: version,
  DATE_MODIFIED: dateModified,
};

/** A page from site/, its placeholders filled in. */
function fill(file: string): string {
  return readFileSync(join(source, file), "utf8").replaceAll(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
    const value = placeholders[name];
    if (value === undefined) {
      throw new Error(`site/${file} names an unknown placeholder ${match}`);
    }
    return value;
  });
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const page = fill("index.html");
writeFileSync(join(output, "index.html"), page);
// GitHub Pages serves 404.html for any missing path, with a 404 status.
writeFileSync(join(output, "404.html"), fill("404.html"));
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
  "icon-512.png",
  "icon-maskable-192.png",
  "icon-maskable-512.png",
]) {
  cpSync(join(root, "packages/remote/public", file), join(output, file));
}

// The custom domain, which GitHub Pages reads from the published files.
writeFileSync(
  join(output, "CNAME"),
  `${siteDomain}
`,
);

// The web app manifest, for the website itself (the Remote has its own), so
// a browser or search engine that reads it gets the site's name and icons.
writeFileSync(
  join(output, "site.webmanifest"),
  `${JSON.stringify(
    {
      name: "Media Centre",
      short_name: "Media Centre",
      description: "A free, self-hosted remote for your whole home.",
      start_url: "./",
      scope: "./",
      display: "browser",
      lang: "en-GB",
      background_color: "#080d19",
      theme_color: "#080d19",
      icons: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        { src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      ],
    },
    null,
    2,
  )}\n`,
);

/** Escapes text for XML. */
function xml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// For search engines, at the domain's root, where a crawler reads robots.txt;
// the sitemap is named in it. It lists the page and, for image search, the
// link preview and every screenshot the page shows (Google reads only each
// image's address; the page's alt text describes it).
const shown = new Set(["og-image.png"]);
for (const [, src] of page.matchAll(/\bsrc="(images\/screenshots\/[^"]+)"/g)) {
  if (src !== undefined) shown.add(src);
}
const images = [...shown]
  .map(
    (src) => `    <image:image>
      <image:loc>${siteUrl}/${xml(src)}</image:loc>
    </image:image>`,
  )
  .join("\n");
writeFileSync(
  join(output, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>${siteUrl}/</loc>
    <lastmod>${dateModified}</lastmod>
${images}
  </url>
</urlset>
`,
);
writeFileSync(join(output, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`);
writeFileSync(join(output, `${indexNowKey}.txt`), indexNowKey);

// Every file the page names by a relative URL must be in the build, so a
// renamed screenshot or icon fails here rather than as a broken image.
const missing = [...page.matchAll(/\b(?:src|href|srcset)="([^"#:{}]+)"/g)]
  .map(([, url]) => url ?? "")
  .filter((url) => url !== "" && !url.startsWith("/") && !existsSync(join(output, url)));
if (missing.length > 0) {
  throw new Error(`site/index.html names files the build has not got: ${[...new Set(missing)].join(", ")}`);
}
// The link preview, structured data and canonical name the site by its full
// address, which no relative check sees: each must be in the build too.
const absent = [...page.matchAll(new RegExp(`${siteUrl.replaceAll(".", "\\.")}/(\\w[^"#?\\s]*)`, "g"))]
  .map(([, path]) => path ?? "")
  .filter((path) => !existsSync(join(output, path)));
if (absent.length > 0) {
  throw new Error(
    `site/index.html links to ${siteUrl}/ paths the build has not got: ${[...new Set(absent)].join(", ")}`,
  );
}
if (/(?:src|href)="\/(?!\/)/.test(page)) {
  throw new Error("site/index.html has a root-absolute URL, which breaks at the project page's path");
}

console.log(`Built the website in ${output}`);
