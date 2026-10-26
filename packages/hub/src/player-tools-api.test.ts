import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SIGNING_CERTIFICATE_PATH,
  appliancePlayerActionPath,
  type Appliance,
  type HubError,
  type PlayerActionProgress,
  type SigningCertificateRequest,
} from "@media-centre/shared";

import { applianceStore } from "./appliances.ts";
import { openDatabase } from "./database.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import { startFakeSamsungTv, type FakeSamsungTv } from "./fakes/samsung-tv/fake-samsung-tv.ts";
import { createHub } from "./hub.ts";
import { roomStore } from "./rooms.ts";
import { fakeCommands, type FakeCommands } from "./fakes/samsung-tv/fake-developer-tools.ts";

// The fake TV is at its own loopback address; the Hub says its own IP on the
// home network is HUB_IP, which the TV must have as its Developer IP.
const LIVING_ROOM_TV = "127.0.0.2";
const HUB_IP = "192.168.1.10";

const CERTIFICATE: SigningCertificateRequest = {
  author: Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x01]).toString("base64"),
  authorPassword: "correct horse battery staple",
  distributor: Buffer.from([0x30, 0x82, 0x02, 0x0b, 0x02, 0x01]).toString("base64"),
};

let dir: string;
let playerDir: string;
let database: DatabaseSync;
let tv: FakeSamsungTv;
let tvStopped: boolean;
let commands: FakeCommands;
let hub: Server;
let base: string;
let living: Appliance;
let logged: string[];

const ethernet = (address: string): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  eth0: [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: null }],
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-player-tools-test-"));
  playerDir = join(dir, "player");
  await mkdir(playerDir);
  await writeFile(join(playerDir, "config.xml"), "<widget/>");
  database = openDatabase(":memory:");
  tv = await startFakeSamsungTv({ host: LIVING_ROOM_TV });
  tv.setDeveloper({ mode: "on", ip: HUB_IP });
  tvStopped = false;
  commands = fakeCommands();
  hub = createHub({
    remoteDir: "/nonexistent",
    version: "9.9.9",
    hubId: "hub-1",
    database,
    networkInterfaces: () => ethernet(HUB_IP),
    drivers: {
      tv: samsungTvDriver({
        restPort: tv.restPort,
        controlPort: tv.controlPort,
        playerTools: { run: commands.run, tempDir: dir },
      }),
    },
    playerDir,
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  living = applianceStore(database).add(
    {
      kind: "tv",
      name: "TV",
      roomId: roomStore(database).add("Living room").id,
      address: LIVING_ROOM_TV,
      model: "QE55Q80TATXXU",
      macAddress: "02:00:00:00:00:0a",
    },
    "token",
  );
  logged = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((done) => hub.close(done));
  database.close();
  if (!tvStopped) await tv.stop();
  await rm(dir, { recursive: true, force: true });
});

const send = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

const storeCertificate = async (): Promise<void> => {
  expect((await send("PUT", SIGNING_CERTIFICATE_PATH, CERTIFICATE)).status).toBe(200);
};

/** Has the Hub do `action` with the Player on the TV, and resolves with each progress it sent. */
const act = async (action: string, id = living.id): Promise<PlayerActionProgress[]> => {
  const response = await send("POST", appliancePlayerActionPath(id), { action });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
  return (await response.text())
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as PlayerActionProgress);
};

const refusal = async (response: Response, status: number): Promise<string> => {
  expect(response.status).toBe(status);
  return ((await response.json()) as HubError).error;
};

const commandLines = (): string[] => commands.ran.map(({ program, args }) => [program, ...args].join(" "));

describe("installing, launching and uninstalling the Player from the Hub", () => {
  it("installs the Player build, signed with the certificate in Settings, telling each step", async () => {
    await storeCertificate();

    expect(await act("install")).toEqual([
      { step: "connecting" },
      { step: "signing" },
      { step: "installing" },
      { step: "done" },
    ]);

    const lines = commandLines();
    expect(lines[0]).toBe(`sdb connect ${LIVING_ROOM_TV}:26101`);
    expect(lines[1]).toMatch(/^tizen cli-config profiles\.path=/);
    expect(lines[2]).toMatch(/^tizen package -t wgt -s media-centre /);
    expect(lines[3]).toMatch(new RegExp(`^tizen install -s ${LIVING_ROOM_TV}:26101 -n Media Centre\\.wgt -- `));
    expect(lines[4]).toBe(`sdb disconnect ${LIVING_ROOM_TV}:26101`);
    expect(lines).toHaveLength(5);
    expect(logged).toContain("Installed the Player on Living room · TV");
  });

  it("launches and uninstalls the Player, telling each step", async () => {
    expect(await act("launch")).toEqual([{ step: "connecting" }, { step: "launching" }, { step: "done" }]);
    expect(await act("uninstall")).toEqual([{ step: "connecting" }, { step: "uninstalling" }, { step: "done" }]);

    expect(commandLines()).toEqual([
      `sdb connect ${LIVING_ROOM_TV}:26101`,
      `tizen run -s ${LIVING_ROOM_TV}:26101 -p MediaCntre.Player`,
      `sdb disconnect ${LIVING_ROOM_TV}:26101`,
      `sdb connect ${LIVING_ROOM_TV}:26101`,
      `tizen uninstall -s ${LIVING_ROOM_TV}:26101 -p MediaCntre.Player`,
      `sdb disconnect ${LIVING_ROOM_TV}:26101`,
    ]);
    expect(logged).toEqual(["Launched the Player on Living room · TV", "Uninstalled the Player on Living room · TV"]);
  });

  it("tells the Remote why a step failed, and logs it", async () => {
    await storeCertificate();
    commands.answer((program, args) => program === "tizen" && args[0] === "install", {
      exitCode: 0,
      output: "app_id[MediaCntre.Player] install failed[118, -12], reason: Author certificate not match\n",
    });

    const progress = await act("install");

    expect(progress.slice(0, -1)).toEqual([{ step: "connecting" }, { step: "signing" }, { step: "installing" }]);
    const last = progress.at(-1);
    expect(last?.step).toBe("failed");
    const error = last?.step === "failed" ? last.error : "";
    expect(error).toContain("The TV didn't install the Player.");
    expect(error).toContain("Author certificate not match");
    expect(logged).toContain(`Couldn't install the Player on Living room · TV: ${error}`);
  });

  it("tells the Remote when the TV doesn't let the Hub connect", async () => {
    commands.answer((program, args) => program === "sdb" && args[0] === "connect", {
      exitCode: 0,
      output: "error: failed to connect to remote target '127.0.0.2'\n",
    });

    const progress = await act("launch");

    expect(progress[0]).toEqual({ step: "connecting" });
    expect(progress[1]?.step).toBe("failed");
    expect(progress).toHaveLength(2);
  });

  describe("refuses, running nothing,", () => {
    afterEach(() => {
      expect(commands.ran).toEqual([]);
    });

    it("a TV not in Developer Mode", async () => {
      tv.setDeveloper({ mode: "off", ip: null });

      for (const action of ["install", "launch", "uninstall"]) {
        expect(await refusal(await send("POST", appliancePlayerActionPath(living.id), { action }), 409)).toBe(
          `Living room · TV isn't in Developer Mode with the Hub's IP, ${HUB_IP}, as its Developer IP. Its Developer ` +
            "section says how to switch it on.",
        );
      }
    });

    it("a TV whose Developer IP isn't the Hub's", async () => {
      tv.setDeveloper({ mode: "on", ip: "192.168.1.99" });

      await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "launch" }), 409);
    });

    it("a TV that doesn't report Developer Mode", async () => {
      tv.setDeveloper(null);

      await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "launch" }), 409);
    });

    it("to install without a signing certificate", async () => {
      expect(await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "install" }), 409)).toBe(
        "The Hub has no signing certificate to sign the Player with. Add yours in Settings, under Signing certificate.",
      );
    });

    it("to install without a Player build", async () => {
      await storeCertificate();
      await rm(join(playerDir, "config.xml"));

      expect(await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "install" }), 409)).toBe(
        "The Hub has no Player build to install. Build it with `pnpm --filter @media-centre/player build`.",
      );
    });

    it("a TV that isn't answering", async () => {
      await tv.stop();
      tvStopped = true;

      await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "launch" }), 502);
    });

    it("a TV the Hub hasn't got, or an action it doesn't know", async () => {
      await refusal(await send("POST", appliancePlayerActionPath(living.id + 1), { action: "launch" }), 404);
      expect(await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "reboot" }), 400)).toBe(
        'Say what to do with the Player: "install", "launch" or "uninstall".',
      );
      expect((await send("GET", appliancePlayerActionPath(living.id))).status).toBe(405);
    });
  });

  it("does one at a time on a TV", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    commands.answer(
      (program, args) => program === "tizen" && args[0] === "run",
      { exitCode: 0, output: "launched" },
      held,
    );

    const first = act("launch");
    await expect.poll(() => commandLines()).toContain(`tizen run -s ${LIVING_ROOM_TV}:26101 -p MediaCntre.Player`);
    expect(await refusal(await send("POST", appliancePlayerActionPath(living.id), { action: "uninstall" }), 409)).toBe(
      "Living room · TV is busy with the Player already. Wait until it is done, then try again.",
    );

    release();
    expect((await first).at(-1)).toEqual({ step: "done" });
    expect((await act("uninstall")).at(-1)).toEqual({ step: "done" });
  });
});
