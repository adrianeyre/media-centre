import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { makeTestMediaSource } from "../packages/hub/src/testing/media.ts";
import { formatSize } from "../packages/remote/src/media-format.ts";
import { openSettingsOn } from "./settings.ts";

/** Holds the test Media Source, generated with ffmpeg, and a folder beside it that is in no Media Source. */
let dir: string;
let media: string;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-centre-e2e-media-"));
  media = join(dir, "Media");
  await makeTestMediaSource(media);
  await mkdir(join(dir, "Outside"));
  await writeFile(join(dir, "Outside", "private.mp4"), "");
  await symlink(join(dir, "Outside"), join(media, "Escape"));
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// The run's Hub is shared by every test, so each starts and ends with no Media Sources.
const removeEveryMediaSource = async (request: APIRequestContext): Promise<void> => {
  const sources = (await (await request.get("/api/media-sources")).json()) as { id: number }[];
  for (const { id } of sources) {
    expect((await request.delete(`/api/media-sources/${String(id)}`)).status()).toBe(204);
  }
};
test.beforeEach(async ({ request }) => removeEveryMediaSource(request));
test.afterEach(async ({ request }) => removeEveryMediaSource(request));

const addMediaSource = async (request: APIRequestContext, name: string): Promise<number> => {
  const response = await request.post("/api/media-sources", { data: { name, path: media } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: number }).id;
};

const listed = (page: Page) =>
  page.getByRole("list", { name: "Media Sources" }).getByRole("listitem").locator(".media-source-name");

// FR-32.
test("Settings adds, renames and removes a Media Source, and refuses a folder that isn't there", async ({ page }) => {
  await page.goto("/");
  await openSettingsOn(page, "TV");
  await expect(page.getByText("No Media Sources yet.")).toBeVisible();
  const form = page.getByRole("form", { name: "Add a Media Source" });

  await form.getByRole("textbox", { name: "Folder" }).fill(join(dir, "Nowhere"));
  await form.getByRole("button", { name: "Add Media Source" }).click();
  await expect(form.getByRole("alert")).toHaveText(`There is no folder at "${join(dir, "Nowhere")}".`);

  await form.getByRole("textbox", { name: "Folder" }).fill(join(dir, "Outside", "private.mp4"));
  await form.getByRole("button", { name: "Add Media Source" }).click();
  await expect(form.getByRole("alert")).toHaveText(`"${join(dir, "Outside", "private.mp4")}" is a file, not a folder.`);

  await form.getByRole("textbox", { name: "Folder" }).fill(media);
  await form.getByRole("textbox", { name: "Name", exact: true }).fill("Films");
  await form.getByRole("button", { name: "Add Media Source" }).click();
  await expect(listed(page)).toHaveText(["Films"]);
  await expect(page.locator(".media-source-path")).toHaveText([media]);
  await expect(form.getByRole("textbox", { name: "Folder" })).toHaveValue("");

  await page.getByRole("button", { name: "Rename Films" }).click();
  const rename = page.getByRole("form", { name: "Rename Films" });
  await rename.getByRole("textbox", { name: "Media Source name" }).fill("Cinema");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(listed(page)).toHaveText(["Cinema"]);

  // The Media Sources are the Hub's, not this browser's: a fresh page reads them back.
  await page.reload();
  await expect(listed(page)).toHaveText(["Cinema"]);

  await page.getByRole("button", { name: "Remove Cinema" }).click();
  await page.getByRole("button", { name: "Yes, remove" }).click();
  await expect(page.getByText("No Media Sources yet.")).toBeVisible();
  expect((await stat(join(media, "Films", "Sci-Fi", "Clip.mp4"))).isFile()).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// FR-33, through ffprobe on files ffmpeg made.
test("Watch & Listen browses a Media Source's folders and Media Files, with size and duration, hiding other files", async ({
  page,
  request,
}) => {
  await addMediaSource(request, "Films");
  await page.goto("/");
  await page.getByRole("tab", { name: "TV" }).click();
  const watchAndListen = page.getByRole("region", { name: "Watch & Listen" });

  await watchAndListen.getByRole("button", { name: "Films" }).click();
  const inFolder = (name: string) => watchAndListen.getByRole("list", { name: `In ${name}` });
  // The symlink pointing out of the Media Source isn't shown, nor are readme.txt and .hidden.mp4.
  await expect(inFolder("Films").getByRole("listitem")).toHaveText(["Films", "Music", /^Damaged\.mp4/]);
  await expect(inFolder("Films").getByRole("listitem", { name: "Damaged.mp4" })).toContainText("Length unknown");

  await inFolder("Films").getByRole("button", { name: "Music" }).click();
  await inFolder("Music").getByRole("button", { name: "Album" }).click();
  const album = inFolder("Album");
  await expect(album.locator(".media-file-name")).toHaveText(["01 Tone.flac", "02 Tone.mp3", "03 Tone.m4a"]);
  for (const [name, duration] of [
    ["01 Tone.flac", "0:03"],
    ["02 Tone.mp3", "0:02"],
    ["03 Tone.m4a", "0:02"],
  ] as const) {
    const file = album.getByRole("listitem", { name });
    await expect(file.locator(".media-file-size")).toHaveText(
      formatSize((await stat(join(media, "Music", "Album", name))).size),
    );
    await expect(file.locator(".media-file-duration")).toHaveText(duration);
  }

  await watchAndListen.getByRole("navigation", { name: "Folder" }).getByRole("button", { name: "Films" }).click();
  await inFolder("Films").getByRole("button", { name: "Films" }).click();
  await inFolder("Films").getByRole("button", { name: "Sci-Fi" }).click();
  await expect(
    inFolder("Sci-Fi").getByRole("listitem", { name: "Clip.mp4" }).locator(".media-file-duration"),
  ).toHaveText("0:02");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

/** Sends a path to the run's Hub exactly as written, as a browser would not. */
const getAsWritten = (baseURL: string, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(baseURL);
    httpRequest({ host: hostname, port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    })
      .on("error", reject)
      .end();
  });

// FR-5, at the Hub process itself.
test("the Hub refuses a folder outside a Media Source, through `..`, encoded `..` or a symlink", async ({
  request,
  baseURL,
}) => {
  const id = await addMediaSource(request, "Films");
  const folder = `/api/media-sources/${String(id)}/folder`;

  for (const path of [
    `${folder}/../Outside`,
    `${folder}/%2e%2e/Outside`,
    `${folder}/..%2fOutside`,
    `${folder}/Escape`,
  ]) {
    const { status, body } = await getAsWritten(baseURL ?? "", path);
    expect(status, path).toBe(403);
    expect(body, path).toContain("That path is outside the Media Source.");
    expect(body, path).not.toContain("private.mp4");
  }
});
