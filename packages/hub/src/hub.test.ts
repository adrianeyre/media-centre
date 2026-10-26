import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HUB_INFO_PATH, LATEST_VERSION_PATH } from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { createHub } from "./hub.ts";

let dir: string;
let database: DatabaseSync;
let hub: Server;
let base: string;

beforeEach(async () => {
  // A secret beside the Remote's files, to prove the Hub never serves outside them.
  dir = await mkdtemp(join(tmpdir(), "hub-test-"));
  await writeFile(join(dir, "secret.txt"), "not for the Remote");
  await mkdir(join(dir, "remote", "assets"), { recursive: true });
  await writeFile(join(dir, "remote", "index.html"), "<h1>Remote</h1>");
  await writeFile(join(dir, "remote", "assets", "app.js"), "console.log(1);");
  await writeFile(join(dir, "remote", "robots.txt"), "User-agent: *");
  await writeFile(join(dir, "remote", "sitemap.xml"), "<urlset/>");

  database = openDatabase(":memory:");
  hub = createHub({ remoteDir: join(dir, "remote"), version: "9.9.9", hubId: "hub-1", database });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((done) => hub.close(done));
  database.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A raw request, because `fetch` normalises `..` out of a URL before sending it,
 * and will not send a Host header of the caller's choosing.
 */
const rawGet = (
  path: string,
  { method = "GET", host }: { method?: string; host?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> =>
  new Promise((done, fail) => {
    const headers = host === undefined ? {} : { host };
    const req = httpRequest(`${base}${path}`, { path, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        done({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", fail);
    req.end();
  });

describe("the Hub", () => {
  it("tells the Remote who it is", async () => {
    const response = await fetch(`${base}${HUB_INFO_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ product: "media-centre", version: "9.9.9", hubId: "hub-1" });
  });

  it("doesn't know the latest version unless told how to find it out", async () => {
    const response = await fetch(`${base}${LATEST_VERSION_PATH}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: null });
  });

  it("tells the Remote the latest version of media-centre, as it found it out (FR-61)", async () => {
    const latest = createHub({
      remoteDir: join(dir, "remote"),
      version: "9.9.9",
      hubId: "hub-1",
      database,
      latestVersion: () => Promise.resolve("10.0.0"),
    });
    await new Promise<void>((done) => latest.listen(0, "127.0.0.1", done));
    try {
      const response = await fetch(`http://127.0.0.1:${(latest.address() as AddressInfo).port}${LATEST_VERSION_PATH}`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version: "10.0.0" });
    } finally {
      await new Promise((done) => latest.close(done));
    }
  });

  it("answers an unknown API path with a JSON 404", async () => {
    const response = await fetch(`${base}/api/nothing-here`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("serves the Remote's index page at the root", async () => {
    const response = await fetch(`${base}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<h1>Remote</h1>");
  });

  it("serves the Remote's other files with their content type", async () => {
    const response = await fetch(`${base}/assets/app.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("console.log(1);");
  });

  it("answers HEAD without a body", async () => {
    const response = await fetch(`${base}/assets/app.js`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("15");
    expect(await response.text()).toBe("");
  });

  it.each([
    ["/robots.txt", "text/plain; charset=utf-8"],
    ["/sitemap.xml", "application/xml; charset=utf-8"],
  ])("serves %s as %s", async (path, type) => {
    const response = await fetch(`${base}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
  });

  describe("on the Remote's index page", () => {
    const page = '<meta property="og:image" content="__HUB_ORIGIN__/og-image.png" /><link href="__HUB_ORIGIN__/" />';

    beforeEach(async () => {
      await writeFile(join(dir, "remote", "index.html"), page);
    });

    it.each(["/", "/index.html"])("makes the URLs on %s absolute with the Hub's address", async (path) => {
      const host = "192.168.1.20:8080";
      const { status, body } = await rawGet(path, { host });

      expect(status).toBe(200);
      expect(body).toBe(
        `<meta property="og:image" content="http://${host}/og-image.png" /><link href="http://${host}/" />`,
      );
    });

    it.each(["media-centre.local", "[fe80::1]:8080"])("accepts the host %s", async (host) => {
      const { body } = await rawGet("/", { host });

      expect(body).toContain(`content="http://${host}/og-image.png"`);
    });

    it.each(['evil.com"><script>alert(1)</script>', "evil.com/path", "user@evil.com", "evil.com:80:80"])(
      "leaves the URLs relative rather than repeat the host %j",
      async (host) => {
        const { body } = await rawGet("/", { host });

        expect(body).toBe('<meta property="og:image" content="/og-image.png" /><link href="/" />');
      },
    );

    it("answers HEAD with the length of the page it would send", async () => {
      const get = await rawGet("/", { host: "192.168.1.20:8080" });
      const head = await rawGet("/", { method: "HEAD", host: "192.168.1.20:8080" });

      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(get.body)));
      expect(get.headers["content-length"]).toBe(String(Buffer.byteLength(get.body)));
    });
  });

  it("answers a missing file with a 404", async () => {
    expect((await fetch(`${base}/nope.js`)).status).toBe(404);
    expect((await fetch(`${base}/assets`)).status).toBe(404);
  });

  it.each(["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/%E0%A4%A"])(
    "refuses %s rather than leave the Remote's files",
    async (path) => {
      const { status, body } = await rawGet(path);

      expect(status).toBe(404);
      expect(body).not.toContain("not for the Remote");
    },
  );

  it("refuses anything but GET and HEAD", async () => {
    const response = await fetch(`${base}${HUB_INFO_PATH}`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});
