#!/usr/bin/env node
/**
 * Stands in for Samsung's `tizen` CLI beside the fake Samsung TV, for tests
 * that run the Hub as its own process, with `SAMSUNG_TV_TIZEN` set to this
 * file. It answers as the real CLI does when all goes well, and acts on the
 * fake TV at the serial's address, on `SAMSUNG_TV_REST_PORT`: `install` puts
 * the Player among its apps, `run` brings it to the front, and `uninstall`
 * takes it out. `package` writes a package of the folder it signs, signed
 * with nothing, once the security profile `cli-config` gave it is there.
 */
import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { PLAYER_APP_ID } from "@media-centre/shared";

import { FAKE_APPS_PATH, FAKE_FRONT_PATH, FAKE_PLAYER_APP, type FakeApp } from "./fake-samsung-tv.ts";

const args = process.argv.slice(2);
const [command] = args;
const option = (name: string): string => args[args.indexOf(name) + 1] ?? "";
const fakeTv = (path: string): string =>
  `http://${option("-s").split(":")[0] ?? ""}:${String(process.env.SAMSUNG_TV_REST_PORT)}${path}`;

const installedApps = async (): Promise<FakeApp[]> =>
  ((await (await fetch(fakeTv(FAKE_APPS_PATH))).json()) as FakeApp[]).map(({ id, name, icon }) => ({
    id,
    name,
    ...(icon === undefined ? {} : { icon }),
  }));
const installApps = async (apps: readonly FakeApp[]): Promise<void> => {
  await fetch(fakeTv(FAKE_APPS_PATH), { method: "PUT", body: JSON.stringify(apps) });
};

const fail = (message: string): void => {
  console.log(message);
  process.exitCode = 1;
};

switch (command) {
  case "cli-config":
    console.log("Setting configuration is succeeded....");
    break;
  case "package": {
    const output = option("-o");
    await mkdir(output, { recursive: true });
    await cp(join(args.at(-1) ?? "", "config.xml"), join(output, "Media Centre.wgt"));
    console.log(`Package File Location: ${join(output, "Media Centre.wgt")}`);
    break;
  }
  case "install": {
    await access(join(args.at(-1) ?? "", option("-n")));
    const apps = await installedApps();
    if (!apps.some(({ id }) => id === PLAYER_APP_ID)) await installApps([...apps, FAKE_PLAYER_APP]);
    console.log("Installing the package...\nInstalled the package: Id(MediaCntre)\nTotal time: 00:00:01.000");
    break;
  }
  case "run": {
    const front = await fetch(fakeTv(FAKE_FRONT_PATH), {
      method: "POST",
      body: JSON.stringify({ app: option("-p") }),
    });
    if (front.ok) console.log("Launching the Tizen application...\n... successfully launched");
    else fail("Package ID is not valid. Please check the package ID again.");
    break;
  }
  case "uninstall": {
    const apps = await installedApps();
    if (!apps.some(({ id }) => id === option("-p"))) {
      fail("uninstall failed[1, -1], reason: Not installed");
      break;
    }
    await installApps(apps.filter(({ id }) => id !== option("-p")));
    console.log("uninstall completed\nTotal time: 00:00:01.000");
    break;
  }
  default:
    fail(`Error: "${String(command)}" is not a valid value for "<command>"`);
}
