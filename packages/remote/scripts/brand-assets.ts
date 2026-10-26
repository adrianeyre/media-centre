/**
 * Draws the Remote's icons, launch screens and link-preview image from the
 * SVGs in `brand/` into `public/`, which Vite copies to the root of the build,
 * and the repository's social preview into `docs/images/`. The PNGs are
 * committed, so this only needs running when the artwork changes:
 *
 *   pnpm --filter @media-centre/remote brand
 *
 * It rasterises in Playwright's Chromium (`pnpm exec playwright install chromium`),
 * with the Remote's own typeface, so text in the artwork matches the app.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { chromium, type Page } from "@playwright/test";

const brand = new URL("../brand/", import.meta.url);
const publicDir = new URL("../public/", import.meta.url);
const startupDir = new URL("startup/", publicDir);
const docsImages = new URL("../../../docs/images/", import.meta.url);
const indexHtml = new URL("../index.html", import.meta.url);

/** The background every full-bleed image sits on: the dark theme's page. */
const NIGHT = "#080D19";
/** And the light theme's, for light launch screens. */
const DAY = "#F6F8FB";

const font = await readFile(
  createRequire(import.meta.url).resolve(
    "@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2",
  ),
);
const FONT_FACE =
  `@font-face{font-family:"Plus Jakarta Sans Variable";font-weight:200 800;` +
  `src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2")}`;

interface Raster {
  readonly source: string;
  readonly width: number;
  readonly height?: number;
  /** Fills any transparent corners, for platforms that would otherwise show them black. */
  readonly background?: string;
  /** Where it goes, if not `public/`. */
  readonly dir?: URL;
}

const RASTERS: Readonly<Record<string, Raster>> = {
  // At 16 and 32 pixels the full icon's stand and thin lines blur, so these use a simpler drawing.
  "favicon-16.png": { source: "icon-small.svg", width: 16 },
  "favicon-32.png": { source: "icon-small.svg", width: 32 },
  "favicon-48.png": { source: "icon.svg", width: 48 },
  // iOS rounds the corners itself and turns transparency black, so this one is full bleed.
  "apple-touch-icon.png": { source: "icon-maskable.svg", width: 180, background: NIGHT },
  "icon-192.png": { source: "icon.svg", width: 192 },
  "icon-512.png": { source: "icon.svg", width: 512 },
  "icon-maskable-192.png": { source: "icon-maskable.svg", width: 192, background: NIGHT },
  "icon-maskable-512.png": { source: "icon-maskable.svg", width: 512, background: NIGHT },
  // Windows' pinned-site tile, which it draws on the tile colour.
  "mstile-150x150.png": { source: "icon.svg", width: 150 },
  "og-image.png": { source: "og-image.svg", width: 1200, height: 630, background: NIGHT },
  // GitHub's social preview, uploaded by hand in the repository's settings: 1280 × 640.
  "social-preview.png": { source: "og-image.svg", width: 1280, height: 640, background: NIGHT, dir: docsImages },
};

/**
 * Each iPhone and iPad, portrait, by its screen in CSS pixels and its pixel
 * ratio: iOS shows a launch screen only if one matches the device exactly.
 */
const APPLE_SCREENS: readonly (readonly [width: number, height: number, ratio: number])[] = [
  [440, 956, 3],
  [430, 932, 3],
  [428, 926, 3],
  [414, 896, 3],
  [414, 896, 2],
  [414, 736, 3],
  [402, 874, 3],
  [393, 852, 3],
  [390, 844, 3],
  [375, 812, 3],
  [375, 667, 2],
  [320, 568, 2],
  [1032, 1376, 2],
  [1024, 1366, 2],
  [834, 1210, 2],
  [834, 1194, 2],
  [834, 1112, 2],
  [820, 1180, 2],
  [810, 1080, 2],
  [768, 1024, 2],
  [744, 1133, 2],
];

const render = async (page: Page, { source, width, height = width, background }: Raster): Promise<Buffer> => {
  const svg = await readFile(new URL(source, brand), "utf8");
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><style>${FONT_FACE}html,body{margin:0;background:${background ?? "transparent"}}` +
      `svg{display:block;width:${width}px;height:${height}px}</style>${svg.replace("<svg ", '<svg preserveAspectRatio="xMidYMid slice" ')}`,
  );
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ omitBackground: background === undefined, type: "png" });
};

/** A launch screen: the icon over the app's name, centred on the theme's page colour, the same size on every screen. */
const renderStartup = async (page: Page, [width, height, ratio]: readonly [number, number, number], dark: boolean) => {
  const icon = await readFile(new URL("icon.svg", brand), "utf8");
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<!doctype html><style>${FONT_FACE}html,body{margin:0;height:100%;background:${dark ? NIGHT : DAY}}` +
      `body{display:grid;place-content:center;justify-items:center;gap:${String(10 * ratio)}px;` +
      `font:750 ${String(13 * ratio)}px/1 "Plus Jakarta Sans Variable",sans-serif;letter-spacing:-0.02em;` +
      `color:${dark ? "#F1F5F9" : "#0B1220"}}svg{width:${String(56 * ratio)}px;height:${String(56 * ratio)}px;` +
      `filter:drop-shadow(0 ${String(6 * ratio)}px ${String(12 * ratio)}px rgb(0 0 0 / ${dark ? "0.5" : "0.18"}))}</style>` +
      `${icon}<span>Media Centre</span>`,
  );
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ type: "png" });
};

/** An ICO file is a small directory of images; modern browsers accept PNGs inside it. */
const ico = (images: readonly { size: number; png: Buffer }[]): Buffer => {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
};

const START = "<!-- apple-touch-startup-image: written by scripts/brand-assets.ts -->";
const END = "<!-- /apple-touch-startup-image -->";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const pngs = new Map<string, Buffer>();
  for (const [name, raster] of Object.entries(RASTERS)) {
    const png = await render(page, raster);
    pngs.set(name, png);
    if (name !== "favicon-48.png") await writeFile(new URL(name, raster.dir ?? publicDir), png);
  }

  const sized = (name: string, size: number): { size: number; png: Buffer } => {
    const png = pngs.get(name);
    if (png === undefined) throw new Error(`${name} was not drawn`);
    return { size, png };
  };
  await writeFile(
    new URL("favicon.ico", publicDir),
    ico([sized("favicon-16.png", 16), sized("favicon-32.png", 32), sized("favicon-48.png", 48)]),
  );
  // The browser tab draws the scalable favicon small, so it is the simpler drawing too.
  await copyFile(new URL("icon-small.svg", brand), new URL("favicon.svg", publicDir));
  // Safari's pinned tabs and other one-colour places take a silhouette.
  await copyFile(new URL("icon-mask.svg", brand), new URL("mask-icon.svg", publicDir));

  // The launch screens, each drawn at the device's real pixels, and the links that pick them.
  await mkdir(startupDir, { recursive: true });
  const links: string[] = [];
  for (const [width, height, ratio] of APPLE_SCREENS) {
    for (const dark of [false, true]) {
      const name = `apple-splash-${String(width * ratio)}x${String(height * ratio)}${dark ? "-dark" : ""}.png`;
      await writeFile(
        new URL(name, startupDir),
        await renderStartup(page, [width * ratio, height * ratio, ratio], dark),
      );
      const media =
        `(device-width: ${String(width)}px) and (device-height: ${String(height)}px) and ` +
        `(-webkit-device-pixel-ratio: ${String(ratio)}) and (orientation: portrait) and ` +
        `(prefers-color-scheme: ${dark ? "dark" : "light"})`;
      links.push(`    <link rel="apple-touch-startup-image" href="/startup/${name}" media="${media}" />`);
    }
  }
  const html = await readFile(indexHtml, "utf8");
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from === -1 || to === -1) throw new Error(`index.html has no ${START} … ${END} markers`);
  await writeFile(indexHtml, `${html.slice(0, from + START.length)}\n${links.join("\n")}\n    ${html.slice(to)}`);
} finally {
  await browser.close();
}
