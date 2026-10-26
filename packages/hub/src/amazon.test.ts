import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AMAZON_ANNOUNCE_PATH,
  AMAZON_PATH,
  AMAZON_SIGN_IN_PATH,
  amazonDeviceActionsPath,
  amazonDevicePath,
  amazonDeviceRoomPath,
  NETWORK_ROOMS_PATH,
  type AmazonDeviceState,
  type AmazonHome,
  type RoomDevices,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import { fakeAmazonDriver, type FakeAmazonDriver } from "./fakes/amazon/fake-amazon-driver.ts";
import { createHub } from "./hub.ts";
import { roomStore } from "./rooms.ts";

/** The Hub's address on the home network, as its network interfaces give it. */
const HUB_ADDRESS = "192.168.1.5";

let directory: string;
let database: DatabaseSync;
let hub: Server | undefined;
let base: string;
let driver: FakeAmazonDriver;
let logged: string[];

const startHub = async (signInMs = 50): Promise<void> => {
  database = openDatabase(join(directory, "hub.sqlite"));
  driver = fakeAmazonDriver({ signInMs, session: "SECRET-SESSION-TOKEN" });
  const started = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    networkInterfaces: () => ({
      eth0: [
        {
          address: "192.168.1.5",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "02:00:00:00:00:01",
          internal: false,
          cidr: "192.168.1.5/24",
        },
      ],
    }),
    amazon: { driver, signInPort: 41_999 },
  });
  hub = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((started.address() as AddressInfo).port)}`;
};

const stopHub = async (): Promise<void> => {
  if (hub === undefined) return;
  const stopping = hub;
  hub = undefined;
  await new Promise((resolve) => stopping.close(resolve));
  // A sign-in still waiting on the fake's timer would keep its session in the
  // database after it is closed, failing whichever test is running then.
  driver.signOut();
  database.close();
};

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Posts `body` as a browser that reached the Hub at `host` would, which `fetch` can't, as it sets the host itself. */
const postAs = (host: string, path: string, body: unknown): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const sent = request(
      `${base}${path}`,
      { method: "POST", headers: { host, "content-type": "application/json" } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: text });
        });
      },
    );
    sent.on("error", reject);
    sent.end(JSON.stringify(body));
  });

const home = async (): Promise<AmazonHome> => (await (await fetch(`${base}${AMAZON_PATH}`)).json()) as AmazonHome;

const signedIn = async (): Promise<AmazonHome> => {
  for (;;) {
    const now = await home();
    if (now.status.state === "signed-in") return now;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "media-centre-amazon-"));
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopHub();
  rmSync(directory, { recursive: true, force: true });
});

describe("the Hub's Amazon", () => {
  it("is signed out at first, with no devices", async () => {
    await startHub();
    expect(await home()).toEqual({
      status: { state: "signed-out", problem: null },
      devices: [],
      routines: [],
      musicProviders: [],
    });
  });

  it("signs in through Amazon's sign-in page, served at the Hub's own address, keeps the session, and signs in again with it after a restart", async () => {
    // Slower than the Hub waits for the sign-in page, as a person signing in is.
    await startHub(2_000);
    // As a phone on the home network asks it, at the Hub's address.
    const started = await postAs(`${HUB_ADDRESS}:41080`, AMAZON_SIGN_IN_PATH, { domain: "amazon.co.uk" });
    expect(started.status).toBe(202);
    expect((JSON.parse(started.body) as AmazonHome).status).toEqual({
      state: "signing-in",
      domain: "amazon.co.uk",
      signInUrl: `http://${HUB_ADDRESS}:41999/`,
    });

    const now = await signedIn();
    expect(now.status).toEqual({ state: "signed-in", domain: "amazon.co.uk", problem: null });
    expect(now.devices.map(({ name }) => name)).toEqual(["Kitchen Echo Dot", "Lounge Echo Show"]);
    expect(now.routines.map(({ name }) => name)).toEqual(["Good night", "Movie time"]);
    expect(now.musicProviders.map(({ name }) => name)).toEqual(["Amazon Music", "TuneIn"]);
    expect(database.prepare("SELECT domain, session FROM amazon_account").get()).toEqual({
      domain: "amazon.co.uk",
      session: "SECRET-SESSION-TOKEN",
    });

    // Restarted, it signs in with the session kept, with no sign-in page.
    await stopHub();
    await startHub(60_000);
    expect((await signedIn()).devices).toHaveLength(2);
    expect(logged.join("\n")).not.toContain("SECRET-SESSION-TOKEN");
  });

  it("serves the sign-in page at localhost when signing in from the Hub's PC, where a browser lets Amazon's page encrypt the password", async () => {
    await startHub(2_000);
    const started = await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, json("POST", { domain: "amazon.co.uk" }));
    expect(((await started.json()) as AmazonHome).status).toEqual({
      state: "signing-in",
      domain: "amazon.co.uk",
      signInUrl: "http://localhost:41999/",
    });
  });

  it("refuses a site that isn't one of Amazon's", async () => {
    await startHub();
    const refused = await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, json("POST", { domain: "evil.example" }));
    expect(refused.status).toBe(400);
  });

  it("reads each device, and does what it is asked, answering with what Amazon then reports", async () => {
    await startHub();
    await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, json("POST", { domain: "amazon.co.uk" }));
    await signedIn();
    const serial = "G0911W0000000001";

    const read = (await (await fetch(`${base}${amazonDevicePath(serial)}`)).json()) as AmazonDeviceState;
    expect(read).toMatchObject({ serial, volume: 40, doNotDisturb: false, player: { title: "Bohemian Rhapsody" } });

    const act = async (action: unknown) => {
      const answer = await fetch(`${base}${amazonDeviceActionsPath(serial)}`, json("POST", action));
      return { status: answer.status, body: (await answer.json()) as AmazonDeviceState & { error?: string } };
    };
    expect((await act({ kind: "volume", level: 65 })).body.volume).toBe(65);
    expect((await act({ kind: "do-not-disturb", on: true })).body.doNotDisturb).toBe(true);
    expect((await act({ kind: "pause" })).body.player?.state).toBe("paused");
    expect((await act({ kind: "notification-delete", id: "alarm-1" })).body.notifications.map(({ id }) => id)).toEqual([
      "reminder-1",
    ]);
    expect((await act({ kind: "ask", text: "  set a timer for 10 minutes " })).status).toBe(200);
    expect((await act({ kind: "quick", action: "joke" })).status).toBe(200);
    expect(driver.asked().map(([, action]) => action)).toContainEqual({
      kind: "ask",
      text: "set a timer for 10 minutes",
    });

    // What isn't an action, or is out of range, is refused before Amazon is asked.
    expect((await act({ kind: "volume", level: 101 })).status).toBe(400);
    expect((await act({ kind: "speak", text: "" })).status).toBe(400);
    expect((await act({ kind: "speak", text: "x".repeat(251) })).status).toBe(400);
    expect((await act({ kind: "quick", action: "self-destruct" })).status).toBe(400);
    expect((await act({ kind: "hack" })).status).toBe(400);

    // Amazon refusing is answered with 502, and why.
    driver.refuseNext("Device is offline");
    const refused = await act({ kind: "play" });
    expect(refused).toEqual({ status: 502, body: { error: "Amazon refused: Device is offline" } });
  });

  it("announces on every Echo", async () => {
    await startHub();
    await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, json("POST", { domain: "amazon.co.uk" }));
    await signedIn();
    const announced = await fetch(`${base}${AMAZON_ANNOUNCE_PATH}`, json("POST", { text: "Dinner is ready" }));
    expect(announced.status).toBe(204);
    expect(driver.asked()).toContainEqual(["*", { kind: "announce-everywhere", text: "Dinner is ready" }]);
  });

  it("puts an Echo in a Room, which the Rooms tab lists it in", async () => {
    await startHub();
    await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, json("POST", { domain: "amazon.co.uk" }));
    await signedIn();
    const kitchen = roomStore(database).add("Kitchen");

    const put = await fetch(`${base}${amazonDeviceRoomPath("G0911W0000000001")}`, json("PUT", { roomId: kitchen.id }));
    expect(put.status).toBe(200);
    expect(((await put.json()) as AmazonHome).devices[0]?.room).toEqual({ id: kitchen.id, name: "Kitchen" });
    expect(((await (await fetch(`${base}${NETWORK_ROOMS_PATH}`)).json()) as RoomDevices).devices).toEqual([
      {
        key: "amazon:G0911W0000000001",
        kind: "amazon",
        roomId: kitchen.id,
        title: "Kitchen Echo Dot",
        address: null,
        maker: "Amazon",
      },
    ]);
  });

  it("refuses what needs a sign-in while signed out, and signs out, forgetting the session", async () => {
    await startHub();
    expect((await fetch(`${base}${amazonDevicePath("G1")}`)).status).toBe(502);
    await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, json("POST", { domain: "amazon.co.uk" }));
    await signedIn();

    const out = await fetch(`${base}${AMAZON_SIGN_IN_PATH}`, { method: "DELETE" });
    expect(((await out.json()) as AmazonHome).status).toEqual({ state: "signed-out", problem: null });
    expect(database.prepare("SELECT * FROM amazon_account").all()).toEqual([]);
    expect(driver.signedIn()).toBe(false);
  });
});
