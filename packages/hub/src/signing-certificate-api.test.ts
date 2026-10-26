import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SIGNING_CERTIFICATE_MAX_BYTES,
  SIGNING_CERTIFICATE_PATH,
  appliancePlayerActionPath,
  type HubError,
  type SigningCertificateRequest,
  type SigningCertificateStatus,
} from "@media-centre/shared";

import { applianceStore } from "./appliances.ts";
import { openDatabase } from "./database.ts";
import { samsungTvDriver } from "./drivers/samsung-tv/samsung-tv-driver.ts";
import { startFakeSamsungTv, type FakeSamsungTv } from "./fakes/samsung-tv/fake-samsung-tv.ts";
import { createHub } from "./hub.ts";
import { signingCertificateStore } from "./signing-certificates.ts";
import { fakeCommands, type FakeCommands } from "./fakes/samsung-tv/fake-developer-tools.ts";

const LIVING_ROOM_TV = "127.0.0.2";
const HUB_IP = "192.168.1.10";

const AUTHOR = Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x01, 0x03, 0x30, 0x81, 0xde, 0xad, 0xbe, 0xef]);
const DISTRIBUTOR = Buffer.from([0x30, 0x82, 0x02, 0x0b, 0x02, 0x01, 0x03, 0x30, 0x81, 0xfe, 0xed, 0xfa, 0xce]);
const AUTHOR_PASSWORD = "Aut0r-p4ss-zq7";
const DISTRIBUTOR_PASSWORD = "D1str-p4ss-xk9";

const CERTIFICATE: SigningCertificateRequest = {
  author: AUTHOR.toString("base64"),
  authorPassword: AUTHOR_PASSWORD,
  distributor: DISTRIBUTOR.toString("base64"),
  distributorPassword: DISTRIBUTOR_PASSWORD,
};

let dir: string;
let databaseFile: string;
let database: DatabaseSync;
let tv: FakeSamsungTv;
let commands: FakeCommands;
let hub: Server;
let base: string;
/** Every body the Hub sent, to prove neither the certificate nor a password is ever among them. */
let answers: string[];
/** Every line the Hub logged, likewise. */
let logged: string[];

const ethernet = (address: string): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  eth0: [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: null }],
});

const startHub = async (): Promise<void> => {
  database = openDatabase(databaseFile);
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
    playerDir: join(dir, "player"),
  });
  await new Promise<void>((done) => hub.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
};

const stopHub = async (): Promise<void> => {
  await new Promise((done) => hub.close(done));
  database.close();
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hub-signing-certificate-test-"));
  databaseFile = join(dir, "media-centre.sqlite");
  await mkdir(join(dir, "player"));
  await writeFile(join(dir, "player", "config.xml"), "<widget/>");
  tv = await startFakeSamsungTv({ host: LIVING_ROOM_TV });
  tv.setDeveloper({ mode: "on", ip: HUB_IP });
  commands = fakeCommands();
  await startHub();
  answers = [];
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const text = (arg: unknown): string =>
        arg instanceof Error ? `${String(arg.stack)} ${String(arg.cause)}` : String(arg);
      logged.push(args.map(text).join(" "));
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopHub();
  await tv.stop();
  await rm(dir, { recursive: true, force: true });
});

const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  answers.push(text);
  return new Response(text, { status: response.status, headers: response.headers });
};

const status = async (method = "GET", body?: unknown): Promise<SigningCertificateStatus> => {
  const response = await send(method, SIGNING_CERTIFICATE_PATH, body);
  expect(response.status).toBe(200);
  return (await response.json()) as SigningCertificateStatus;
};

const refusal = async (body: unknown, status = 400): Promise<string> => {
  const response = await send("PUT", SIGNING_CERTIFICATE_PATH, body);
  expect(response.status).toBe(status);
  return ((await response.json()) as HubError).error;
};

describe("the signing certificate in Settings", () => {
  it("is stored, said to be, and removed, keeping only that it has one in what it answers", async () => {
    expect(await status()).toEqual({ stored: false, storedAt: null });

    const stored = await status("PUT", CERTIFICATE);

    expect(stored).toEqual({ stored: true, storedAt: expect.any(String) as string });
    expect(Number.isNaN(Date.parse(String(stored.storedAt)))).toBe(false);
    expect(await status()).toEqual(stored);
    expect(logged).toEqual(["Stored the signing certificate, to install the Player with"]);

    expect(await status("DELETE")).toEqual({ stored: false, storedAt: null });
    expect(await status()).toEqual({ stored: false, storedAt: null });
    expect(signingCertificateStore(database).read()).toBeNull();
    expect(logged.at(-1)).toBe("Removed the signing certificate");
  });

  it("keeps both halves and their passwords on the Hub, through a restart", async () => {
    await status("PUT", CERTIFICATE);
    await stopHub();
    await startHub();

    expect((await status()).stored).toBe(true);
    const kept = signingCertificateStore(database).read();
    expect(Buffer.from(kept?.author ?? [])).toEqual(AUTHOR);
    expect(Buffer.from(kept?.distributor ?? [])).toEqual(DISTRIBUTOR);
    expect(kept?.authorPassword).toBe(AUTHOR_PASSWORD);
    expect(kept?.distributorPassword).toBe(DISTRIBUTOR_PASSWORD);
  });

  it("takes the author certificate's password for the distributor's when it isn't given", async () => {
    await status("PUT", { ...CERTIFICATE, distributorPassword: null });

    expect(signingCertificateStore(database).read()?.distributorPassword).toBe(AUTHOR_PASSWORD);
  });

  it("replaces the one it had", async () => {
    await status("PUT", CERTIFICATE);
    await status("PUT", { ...CERTIFICATE, authorPassword: "another-password" });

    expect(signingCertificateStore(database).read()?.authorPassword).toBe("another-password");
  });

  it("takes a certificate as big as a real one can be, and refuses one bigger", async () => {
    const big = Buffer.alloc(SIGNING_CERTIFICATE_MAX_BYTES, 1);
    big[0] = 0x30;
    await status("PUT", { ...CERTIFICATE, author: big.toString("base64"), distributor: big.toString("base64") });

    const bigger = Buffer.concat([big, Buffer.from([1])]).toString("base64");
    expect(await refusal({ ...CERTIFICATE, author: bigger })).toBe(
      "The author certificate is too big to be a .p12 file. Choose the one Tizen Studio made.",
    );
  });

  it("refuses what isn't a signing certificate, saying why, but never echoing a password", async () => {
    expect(await refusal({ ...CERTIFICATE, author: "" })).toBe("Choose the author certificate file, a .p12 file.");
    expect(await refusal({ ...CERTIFICATE, distributor: undefined })).toBe(
      "Choose the distributor certificate file, a .p12 file.",
    );
    expect(await refusal({ ...CERTIFICATE, author: "not base64!" })).toBe(
      "The author certificate isn't a .p12 file. Choose the one Tizen Studio made.",
    );
    expect(await refusal({ ...CERTIFICATE, distributor: Buffer.from("hello").toString("base64") })).toBe(
      "The distributor certificate isn't a .p12 file. Choose the one Tizen Studio made.",
    );
    expect(await refusal({ ...CERTIFICATE, authorPassword: "" })).toBe("Give the author certificate's password.");
    expect(await refusal({ ...CERTIFICATE, authorPassword: 42 })).toBe("Give the author certificate's password.");
    expect(await refusal({ ...CERTIFICATE, distributorPassword: "x".repeat(257) })).toBe(
      "The distributor certificate's password is longer than any Tizen Studio takes.",
    );
    expect(await refusal(null)).toBe("Give the signing certificate.");
    expect((await status()).stored).toBe(false);
  });

  it("never sends the certificate or its passwords to the Remote, nor logs them, even when a tool repeats one", async () => {
    await status("PUT", CERTIFICATE);
    await status();
    tv.setDeveloper({ mode: "on", ip: HUB_IP });
    applianceStore(database).add(
      {
        kind: "tv",
        name: "TV",
        roomId: null,
        address: LIVING_ROOM_TV,
        model: "QE55Q80T",
        macAddress: "02:00:00:00:00:0a",
      },
      "token",
    );
    const [living] = applianceStore(database).list();
    const install = (): Promise<Response> =>
      send("POST", appliancePlayerActionPath(Number(living?.id)), { action: "install" });

    expect((await install()).status).toBe(200);
    // A tool that ever repeated a password in what it says is never passed on as it said it.
    commands.answer((program, args) => program === "tizen" && args[0] === "install", {
      exitCode: 1,
      output: `install failed, reason: wrong password ${AUTHOR_PASSWORD} or ${DISTRIBUTOR_PASSWORD}\n`,
    });
    expect((await install()).status).toBe(200);
    expect(answers.at(-1)).toContain("wrong password ******** or ********");
    await refusal({ ...CERTIFICATE, author: "" });
    await refusal({ ...CERTIFICATE, distributorPassword: `${DISTRIBUTOR_PASSWORD}${"x".repeat(256)}` });
    await status("DELETE");

    const secrets = [
      AUTHOR_PASSWORD,
      DISTRIBUTOR_PASSWORD,
      CERTIFICATE.author,
      CERTIFICATE.distributor,
      AUTHOR.toString("hex"),
      DISTRIBUTOR.toString("hex"),
    ];
    expect(answers.length).toBeGreaterThan(5);
    expect(logged.length).toBeGreaterThan(3);
    for (const text of [...answers, ...logged]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
    // Nor are the passwords ever in a command's arguments, which other programs on the Hub's machine could read.
    for (const { args } of commands.ran) {
      expect(args.join(" ")).not.toContain(AUTHOR_PASSWORD);
      expect(args.join(" ")).not.toContain(DISTRIBUTOR_PASSWORD);
    }
  });
});
