import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/**
 * Stands in the Remote's index page for the Hub's own origin. A link preview
 * needs an absolute URL for its image, and only the Hub knows its address.
 */
export const HUB_ORIGIN_PLACEHOLDER = "__HUB_ORIGIN__";

// A host name or IP address with an optional port, and nothing else, so a
// forged Host header can never write markup into the page.
const SAFE_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * Sends one of the Remote's built files, or a 404. A path that resolves outside
 * `remoteDir`, e.g. through an encoded `..`, is refused rather than followed.
 * `host` is the request's Host header, used to make the index page's URLs absolute.
 */
export const serveRemoteFile = async (
  remoteDir: string,
  pathname: string,
  host: string | undefined,
  headOnly: boolean,
  response: ServerResponse,
): Promise<void> => {
  const root = resolve(remoteDir);
  const file = resolveInside(root, pathname === "/" ? "/index.html" : pathname);
  const stats = file === undefined ? undefined : await stat(file).catch(() => undefined);

  if (file === undefined || stats === undefined || !stats.isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  if (file === join(root, "index.html")) {
    const origin = host !== undefined && SAFE_HOST.test(host) ? `http://${host}` : "";
    const page = (await readFile(file, "utf8")).replaceAll(HUB_ORIGIN_PLACEHOLDER, origin);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[".html"],
      "content-length": Buffer.byteLength(page),
      // The page differs by the address it was asked for, so a cache must not share it.
      vary: "host",
    });
    response.end(headOnly ? undefined : page);
    return;
  }

  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "content-length": stats.size,
  });
  if (headOnly) {
    response.end();
    return;
  }
  await pipeline(createReadStream(file), response);
};

const resolveInside = (root: string, pathname: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const file = resolve(root, `.${decoded}`);
  return file.startsWith(root + sep) ? file : undefined;
};
