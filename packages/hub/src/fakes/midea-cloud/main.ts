/**
 * Runs the fake Midea cloud as its own process, for tests that need one
 * outside Vitest, such as the Remote's end-to-end tests:
 *
 *   FAKE_MIDEA_CLOUD_ACCOUNT=owner@example.com FAKE_MIDEA_CLOUD_PASSWORD=… pnpm --filter @media-centre/hub fake-midea-cloud
 *
 * - `FAKE_MIDEA_CLOUD_HOST` is the address to listen on (127.0.0.1 by default).
 * - `FAKE_MIDEA_CLOUD_PORT` is its port, 8090 by default; 0 picks a free one.
 *   Give the Hub `MIDEA_CLOUD_URL=http://<host>:<port>` to use it.
 * - `FAKE_MIDEA_CLOUD_APP` is which app's cloud it is: `MSmartHome`, the
 *   default, given to the Hub as `MIDEA_CLOUD_URL`, or `Midea Air`, Midea's
 *   older cloud, given to it as `MIDEA_AIR_CLOUD_URL`.
 * - `FAKE_MIDEA_CLOUD_ACCOUNT` and `FAKE_MIDEA_CLOUD_PASSWORD` are the
 *   login of that app it signs in, and refuses any other. It never prints
 *   the password.
 * - `FAKE_MIDEA_CLOUD_UNITS` is the units it issues tokens and keys for,
 *   separated by commas, each `<id>:<token>:<key>`, the id in decimal and the
 *   token and key in hex, 64 and 32 bytes, as a fake Midea Air Conditioner's
 *   `FAKE_AIRCON_ID`, `FAKE_AIRCON_TOKEN` and `FAKE_AIRCON_KEY`. It never
 *   prints them.
 *
 * `PUT /_fake/units` with `[{"id": 1234, "token": "…", "key": "…"}]` replaces
 * the units, as after a unit is factory reset and paired again in Midea's
 * app, and `GET` lists their ids. `GET /_fake/requests` lists the requests it
 * answered, each with its path and whether it was accepted or why not, and
 * `DELETE` forgets them. Stopping the process is the internet going down.
 */
import { fakeCloudUnitsIn, startFakeMideaCloud } from "./fake-midea-cloud.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const {
  FAKE_MIDEA_CLOUD_HOST: host = "127.0.0.1",
  FAKE_MIDEA_CLOUD_PORT: portText = "8090",
  FAKE_MIDEA_CLOUD_ACCOUNT: account,
  FAKE_MIDEA_CLOUD_PASSWORD: password,
  FAKE_MIDEA_CLOUD_UNITS: unitsText = "",
  FAKE_MIDEA_CLOUD_APP: app = "MSmartHome",
} = process.env;

if (app !== "MSmartHome" && app !== "Midea Air")
  fail(`FAKE_MIDEA_CLOUD_APP must be MSmartHome or Midea Air, not "${app}"`);

const port = Number(portText);
if (!Number.isInteger(port) || port < 0 || port > 65_535)
  fail(`FAKE_MIDEA_CLOUD_PORT must be a port number, not "${portText}"`);
if (account === undefined || account === "") fail("FAKE_MIDEA_CLOUD_ACCOUNT must be the account it signs in");
if (password === undefined || password === "") fail("FAKE_MIDEA_CLOUD_PASSWORD must be that account's password");

// Never quoted back, even when wrong: they hold tokens and keys.
const units = fakeCloudUnitsIn(
  unitsText
    .split(",")
    .filter((each) => each.trim() !== "")
    .map((each) => {
      const [id, token, key] = each.trim().split(":");
      return { id: id === undefined || id === "" ? Number.NaN : Number(id), token, key };
    }),
);
if (units === undefined) {
  fail(
    "FAKE_MIDEA_CLOUD_UNITS must be <id>:<token>:<key> separated by commas, the token and key in hex, 64 and 32 bytes",
  );
}

const cloud = await startFakeMideaCloud({
  host,
  port,
  app: app === "Midea Air" ? "Midea Air" : "MSmartHome",
  account: account ?? "",
  password: password ?? "",
  units: units ?? [],
}).catch((error: unknown) =>
  fail(`The fake Midea cloud couldn't start: ${error instanceof Error ? error.message : String(error)}`),
);
console.log(`Fake Midea cloud listening on ${cloud.url}, for ${String(units?.length ?? 0)} units, as ${app}'s`);

const stop = (): void => {
  void cloud.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
