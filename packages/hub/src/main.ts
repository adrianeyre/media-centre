/**
 * Starts the Hub: `pnpm start` from the repository root builds the Remote and
 * runs this (PRD FR-1). Node runs the TypeScript directly, so there is no Hub
 * build step.
 *
 * - `HUB_PORT` is the port to listen on (41080 by default, as few other apps use it; 0 picks a free one).
 * - `HUB_DATABASE` is the SQLite file that holds all the Hub's state (FR-3),
 *   created on first start. By default it is `data/media-centre.sqlite` at the
 *   repository root.
 * - `SAMSUNG_TV_REST_PORT`, `SAMSUNG_TV_CONTROL_PORT` and
 *   `SAMSUNG_TV_UPNP_PORT` move the Samsung TV Driver off a real TV's ports,
 *   only to run the Hub against the fake TV, and `SAMSUNG_TV_WAKE_PORT` sends
 *   Wake-on-LAN to the fake's own address there. `SAMSUNG_TV_SDB` and
 *   `SAMSUNG_TV_TIZEN` run the fake TV's stand-ins for Samsung's `sdb` and
 *   `tizen`, which install the Player, in place of those on the `PATH`.
 * - `MIDEA_PORT`, `MIDEA_DISCOVERY_PORT` and `MIDEA_SEARCH_TARGETS` move the
 *   Midea Driver off a real Air Conditioner's ports and broadcast, only to
 *   run the Hub against the fake Midea Air Conditioner, and `MIDEA_CLOUD_URL`
 *   and `MIDEA_AIR_CLOUD_URL`, always set together, have it fetch a v3 unit's
 *   token and key from fakes of MSmartHome's and Midea Air's clouds rather
 *   than Midea's own.
 * - `LEPRO_PORT`, `LEPRO_DISCOVERY_PORT` and `LEPRO_SEARCH_TARGETS` move the
 *   Lepro Driver off a real Light's ports and broadcasts, only to run the
 *   Hub against the fake Lepro Light.
 * - `HIVE_URL` and `HIVE_AUTH_URL`, always set together, have the Hive
 *   Driver reach the fake Hive cloud's API and sign-in service rather than
 *   Hive's own, only to run the Hub against it (ADR 0010).
 * - `NETWORK_SCAN_TARGETS` is the addresses the Network tab's scan looks at,
 *   separated by commas, and `NETWORK_SCAN_PORTS` the ports it checks, in
 *   place of the Hub's subnet and the common ports, only to run the Hub
 *   against the fakes.
 * - `BLUETOOTH_HELPER` is a program, or a Node script, to run in place of
 *   the Hub's own Bluetooth helper, which listens with Windows' API, and
 *   `BLUETOOTH_SCAN_SECONDS` how long a Bluetooth scan listens, only to run
 *   the Hub against the fake one, on any machine.
 * - `AMAZON_SIGN_IN_PORT` is where Amazon's sign-in page listens, 41081 by
 *   default, and `AMAZON_FAKE`, set to anything, has the Hub reach the fake
 *   Amazon in place of the Alexa app's API (ADR 0011), only to run it
 *   against the fakes.
 * - `RING_FAKE`, set to anything, has the Hub reach the fake Ring in place
 *   of the Ring app's API (ADR 0014), only to run it against the fakes.
 * - `HUB_LATEST_VERSION_URL` is the package.json the Hub reads the latest
 *   version of media-centre from, for the Remote to offer an update (FR-61):
 *   by default, the one on GitHub's `main`. Empty, the Hub doesn't look.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { openDatabase, readHubId } from "./database.ts";
import type { Drivers } from "./drivers/driver.ts";
import { driversFromEnvironment } from "./drivers/drivers.ts";
import { windowsWatch } from "./bluetooth.ts";
import { fakeAmazonDriver } from "./fakes/amazon/fake-amazon-driver.ts";
import { fakeRingDriver } from "./fakes/ring/fake-ring-driver.ts";
import { createHub } from "./hub.ts";
import { latestPackageJsonUrl, latestVersionFrom } from "./latest-version.ts";

const DEFAULT_PORT = 41_080;
const DEFAULT_DATABASE = resolve(import.meta.dirname, "../../../data/media-centre.sqlite");

const port = Number(process.env.HUB_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`HUB_PORT must be a port number, not "${String(process.env.HUB_PORT)}"`);
  process.exit(1);
}

let drivers: Drivers;
try {
  drivers = driversFromEnvironment(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const listIn = (variable: string): string[] | undefined =>
  process.env[variable]
    ?.split(",")
    .map((each) => each.trim())
    .filter((each) => each !== "");
const networkTargets = listIn("NETWORK_SCAN_TARGETS");
const networkPorts = listIn("NETWORK_SCAN_PORTS")?.map(Number);
if (networkPorts?.some((each) => !Number.isInteger(each) || each < 1 || each > 65_535)) {
  console.error(
    `NETWORK_SCAN_PORTS must be port numbers, separated by commas, not "${String(process.env.NETWORK_SCAN_PORTS)}"`,
  );
  process.exit(1);
}

const bluetoothHelper = process.env.BLUETOOTH_HELPER;
const bluetoothSeconds =
  process.env.BLUETOOTH_SCAN_SECONDS === undefined ? undefined : Number(process.env.BLUETOOTH_SCAN_SECONDS);
if (bluetoothSeconds !== undefined && (!Number.isInteger(bluetoothSeconds) || bluetoothSeconds < 1)) {
  console.error(
    `BLUETOOTH_SCAN_SECONDS must be a whole number of seconds, not "${String(process.env.BLUETOOTH_SCAN_SECONDS)}"`,
  );
  process.exit(1);
}

const amazonPort = process.env.AMAZON_SIGN_IN_PORT === undefined ? undefined : Number(process.env.AMAZON_SIGN_IN_PORT);
if (amazonPort !== undefined && (!Number.isInteger(amazonPort) || amazonPort < 1 || amazonPort > 65_535)) {
  console.error(`AMAZON_SIGN_IN_PORT must be a port number, not "${String(process.env.AMAZON_SIGN_IN_PORT)}"`);
  process.exit(1);
}

const databaseFile = resolve(process.env.HUB_DATABASE ?? DEFAULT_DATABASE);
const database = openDatabase(databaseFile);

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
  version: string;
};

// Where the Remote is told an update is waiting: the repository named in
// media-centre's own package.json.
const { repository } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")) as {
  repository: { url: string };
};
const latestVersionUrl = process.env.HUB_LATEST_VERSION_URL ?? latestPackageJsonUrl(repository.url);

const hub = createHub({
  remoteDir: resolve(import.meta.dirname, "../../remote/dist"),
  version: packageJson.version,
  hubId: readHubId(database),
  database,
  drivers,
  network: {
    ...(networkTargets === undefined ? {} : { targets: networkTargets }),
    ...(networkPorts === undefined ? {} : { ports: networkPorts, knockPorts: networkPorts }),
  },
  ...(bluetoothHelper === undefined && bluetoothSeconds === undefined
    ? {}
    : {
        bluetooth: {
          ...(bluetoothHelper === undefined && process.platform !== "win32"
            ? {}
            : { watch: windowsWatch(bluetoothHelper === undefined ? {} : { helper: bluetoothHelper }) }),
          ...(bluetoothSeconds === undefined ? {} : { seconds: bluetoothSeconds }),
        },
      }),
  amazon: {
    ...(process.env.AMAZON_FAKE === undefined ? {} : { driver: fakeAmazonDriver() }),
    ...(amazonPort === undefined ? {} : { signInPort: amazonPort }),
  },
  ...(process.env.RING_FAKE === undefined ? {} : { ring: { driver: fakeRingDriver() } }),
  ...(latestVersionUrl === "" ? {} : { latestVersion: latestVersionFrom(latestVersionUrl) }),
});

// Every interface, not just loopback: the Remote is opened from phones on the
// home network.
hub.listen(port, () => {
  console.log(`Hub state in ${databaseFile}`);
  console.log(`Hub listening on http://0.0.0.0:${(hub.address() as AddressInfo).port}`);
});

const stop = (): void => {
  hub.close(() => {
    database.close();
    process.exit(0);
  });
  hub.closeAllConnections();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
