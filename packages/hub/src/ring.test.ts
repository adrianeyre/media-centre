import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NETWORK_ROOMS_PATH,
  RING_CODE_PATH,
  RING_PATH,
  RING_SIGN_IN_PATH,
  ringDeviceActionsPath,
  ringDevicePath,
  ringDeviceRoomPath,
  ringLiveViewPath,
  ringLiveViewSessionPath,
  ringRecordingPath,
  ringSnapshotPath,
  type RingDeviceState,
  type RingHome,
  type RoomDevices,
} from "@media-centre/shared";

import { openDatabase } from "./database.ts";
import {
  FAKE_RING_CODE,
  FAKE_RING_NO_CODE_PASSWORD,
  FAKE_RING_WRONG_PASSWORD,
  fakeRingDriver,
  type FakeRingDriver,
} from "./fakes/ring/fake-ring-driver.ts";
import { createHub } from "./hub.ts";
import { roomStore } from "./rooms.ts";

const TOKEN = "SECRET-RING-TOKEN";
const PASSWORD = "SECRET-RING-PASSWORD";

let directory: string;
let database: DatabaseSync;
let hub: Server | undefined;
let base: string;
let driver: FakeRingDriver;
let logged: string[];

const startHub = async (): Promise<void> => {
  database = openDatabase(join(directory, "hub.sqlite"));
  driver = fakeRingDriver({ token: TOKEN });
  const started = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    networkInterfaces: () => ({}),
    ring: { driver },
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
  database.close();
};

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const home = async (): Promise<RingHome> => (await (await fetch(`${base}${RING_PATH}`)).json()) as RingHome;

const signIn = async (): Promise<RingHome> => {
  await fetch(`${base}${RING_SIGN_IN_PATH}`, json("POST", { email: "owner@example.com", password: PASSWORD }));
  return (await (await fetch(`${base}${RING_CODE_PATH}`, json("POST", { code: FAKE_RING_CODE }))).json()) as RingHome;
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "media-centre-ring-"));
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

describe("the Hub's Ring", () => {
  it("is signed out at first, with no devices", async () => {
    await startHub();
    expect(await home()).toEqual({ status: { state: "signed-out", problem: null }, devices: [] });
  });

  it("signs in with the email and password, then Ring's code, keeps only the token, and signs in again with it after a restart", async () => {
    await startHub();
    const asked = await fetch(
      `${base}${RING_SIGN_IN_PATH}`,
      json("POST", { email: " owner@example.com ", password: PASSWORD }),
    );
    expect(asked.status).toBe(200);
    expect(((await asked.json()) as RingHome).status).toEqual({
      state: "code-needed",
      email: "owner@example.com",
      prompt: "sent to +44•••••123 via sms",
      problem: null,
    });

    // A wrong code is refused, and the code asked for again.
    const wrong = (await (
      await fetch(`${base}${RING_CODE_PATH}`, json("POST", { code: "000000" }))
    ).json()) as RingHome;
    expect(wrong.status).toMatchObject({ state: "code-needed" });
    expect(wrong.status.problem).toContain("code");

    const now = (await (
      await fetch(`${base}${RING_CODE_PATH}`, json("POST", { code: FAKE_RING_CODE }))
    ).json()) as RingHome;
    expect(now.status).toEqual({ state: "signed-in", problem: null });
    expect(now.devices.map(({ name, kind }) => [name, kind])).toEqual([
      ["Front Door", "doorbell"],
      ["Garden", "camera"],
      ["Hallway Chime", "chime"],
    ]);
    expect(database.prepare("SELECT token FROM ring_account").get()).toEqual({ token: TOKEN });
    expect(JSON.stringify(database.prepare("SELECT * FROM ring_account").all())).not.toContain(PASSWORD);

    // Restarted, it signs in with the token kept, asking for nothing.
    await stopHub();
    await startHub();
    await vi.waitFor(async () => {
      expect((await home()).devices).toHaveLength(3);
    });
    const log = logged.join("\n");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain(PASSWORD);
    expect(log).not.toContain(FAKE_RING_CODE);
  });

  it("signs in at once where Ring asks for no code, and says why Ring refused a password", async () => {
    await startHub();
    const refused = await fetch(
      `${base}${RING_SIGN_IN_PATH}`,
      json("POST", { email: "owner@example.com", password: FAKE_RING_WRONG_PASSWORD }),
    );
    expect(((await refused.json()) as RingHome).status).toEqual({
      state: "signed-out",
      problem: "Signing in to Ring failed: Verify that your email and password are correct.",
    });

    const signedIn = await fetch(
      `${base}${RING_SIGN_IN_PATH}`,
      json("POST", { email: "owner@example.com", password: FAKE_RING_NO_CODE_PASSWORD }),
    );
    expect(((await signedIn.json()) as RingHome).status).toEqual({ state: "signed-in", problem: null });
  });

  it("refuses a sign-in with no email or password, and a code with no sign-in under way", async () => {
    await startHub();
    expect((await fetch(`${base}${RING_SIGN_IN_PATH}`, json("POST", { email: "", password: "x" }))).status).toBe(400);
    expect((await fetch(`${base}${RING_SIGN_IN_PATH}`, json("POST", { email: "a@b.c" }))).status).toBe(400);
    expect((await fetch(`${base}${RING_CODE_PATH}`, json("POST", { code: "123456" }))).status).toBe(502);
  });

  it("reads each device, and does what it is asked, answering with what Ring then reports", async () => {
    await startHub();
    await signIn();

    const read = (await (await fetch(`${base}${ringDevicePath("100001")}`)).json()) as RingDeviceState;
    expect(read).toMatchObject({ id: "100001", battery: 82, motionDetection: true, light: null });
    expect(read.events.map(({ kind }) => kind)).toEqual(["motion", "ding", "live-view"]);

    driver.ding("100001");
    expect(((await (await fetch(`${base}${ringDevicePath("100001")}`)).json()) as RingDeviceState).lastDing).not.toBe(
      null,
    );

    const act = async (id: string, action: unknown) => {
      const answer = await fetch(`${base}${ringDeviceActionsPath(id)}`, json("POST", action));
      return { status: answer.status, body: (await answer.json()) as RingDeviceState & { error?: string } };
    };
    expect((await act("100002", { kind: "light", on: true })).body.light).toBe(true);
    expect((await act("100002", { kind: "siren", on: true })).body.siren).toBe(true);
    expect((await act("100001", { kind: "motion-detection", on: false })).body.motionDetection).toBe(false);
    expect((await act("100003", { kind: "chime-volume", level: 3 })).body.volume).toBe(3);
    expect((await act("100003", { kind: "chime-test", sound: "ding" })).status).toBe(200);

    // What isn't an action, or is out of range, is refused before Ring is asked.
    expect((await act("100003", { kind: "chime-volume", level: 12 })).status).toBe(400);
    expect((await act("100002", { kind: "light", on: "yes" })).status).toBe(400);
    expect((await act("100003", { kind: "chime-test", sound: "fanfare" })).status).toBe(400);
    expect((await act("100001", { kind: "hack" })).status).toBe(400);

    // Ring refusing is answered with 502, and why.
    expect(await act("100001", { kind: "light", on: true })).toEqual({
      status: 502,
      body: { error: "That camera has no light." },
    });
    driver.refuseNext("Ring refused: device offline");
    expect((await act("100002", { kind: "light", on: false })).status).toBe(502);
  });

  it("gives a camera's snapshot, a recording's address, and hands Ring the offer for live view", async () => {
    await startHub();
    await signIn();

    const snapshot = await fetch(`${base}${ringSnapshotPath("100001")}`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await snapshot.arrayBuffer()).slice(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    expect((await fetch(`${base}${ringSnapshotPath("100003")}`)).status).toBe(502);

    const recording = await fetch(`${base}${ringRecordingPath("100001", "100001-2")}`);
    expect(await recording.json()).toEqual({ url: "http://localhost/ring-recordings/100001-2.mp4" });

    // Only an SDP offer is handed on; the fake has no video to answer with.
    expect((await fetch(`${base}${ringLiveViewPath("100001")}`, json("POST", { sdp: "hello" }))).status).toBe(400);
    const live = await fetch(`${base}${ringLiveViewPath("100001")}`, json("POST", { sdp: "v=0\r\n" }));
    expect(live.status).toBe(502);
    expect((await fetch(`${base}${ringLiveViewSessionPath("100001", "s-1")}`, { method: "DELETE" })).status).toBe(204);
  });

  it("puts a Ring device in a Room, which the Rooms tab lists it in", async () => {
    await startHub();
    await signIn();
    const hall = roomStore(database).add("Hall");

    const put = await fetch(`${base}${ringDeviceRoomPath("100001")}`, json("PUT", { roomId: hall.id }));
    expect(put.status).toBe(200);
    expect(((await put.json()) as RingHome).devices[0]?.room).toEqual({ id: hall.id, name: "Hall" });
    expect(((await (await fetch(`${base}${NETWORK_ROOMS_PATH}`)).json()) as RoomDevices).devices).toEqual([
      { key: "ring:100001", kind: "ring", roomId: hall.id, title: "Front Door", address: null, maker: "Ring" },
    ]);
  });

  it("refuses what needs a sign-in while signed out, and signs out, forgetting the token", async () => {
    await startHub();
    expect((await fetch(`${base}${ringDevicePath("100001")}`)).status).toBe(502);
    await signIn();

    const out = await fetch(`${base}${RING_SIGN_IN_PATH}`, { method: "DELETE" });
    expect(((await out.json()) as RingHome).status).toEqual({ state: "signed-out", problem: null });
    expect(database.prepare("SELECT * FROM ring_account").all()).toEqual([]);
    expect(driver.signedIn()).toBe(false);
  });
});
