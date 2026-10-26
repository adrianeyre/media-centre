// Assembles the project website (GitHub Pages) in `site/dist/`: the page, its
// stylesheet, its script (types stripped) and its font from `site/`, the
// screenshots from `docs/images/`, and the icons from the Remote, copied rather
// than kept twice in Git. It also writes `sitemap.xml` and `robots.txt` for the
// site's address. `.github/workflows/pages.yml` runs it and publishes
// `site/dist/`; run it yourself with `pnpm site:build` (it needs no install),
// then serve `site/dist/`.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

/** The repository, named once: every link to it on the page comes from here. */
export const repositoryUrl = "https://github.com/adrianeyre/media-centre";

/**
 * The website's own address, with no trailing slash, for its canonical link,
 * link previews, sitemap and robots.txt. Every other URL in the page is
 * relative, so the page works under this project page's `/media-centre/` path.
 *
 * To move it to a custom domain later: set this to `https://<the domain>`,
 * write a `CNAME` file holding the bare domain into `site/dist/` below (as
 * `writeFileSync(join(output, "CNAME"), "<the domain>\n")`), add the DNS record
 * GitHub Pages asks for (a CNAME to `adrianeyre.github.io`), and set the
 * domain in the repository's Pages settings.
 */
export const siteUrl = "https://adrianeyre.github.io/media-centre";

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
// strips them, so the build still needs no install.
writeFileSync(join(output, "script.js"), stripTypeScriptTypes(readFileSync(join(source, "script.mts"), "utf8")));
cpSync(join(source, "fonts"), join(output, "fonts"), { recursive: true });

cpSync(join(root, "docs/images/screenshots"), join(output, "images/screenshots"), { recursive: true });
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

// For search engines. A crawler reads robots.txt only at a domain's root, so
// it counts once the site has a custom domain; the sitemap is named in it.
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
  throw new Error("site/index.html has a root-absolute URL, which breaks under the project page's path");
}

console.log(`Built the website in ${output}`);
