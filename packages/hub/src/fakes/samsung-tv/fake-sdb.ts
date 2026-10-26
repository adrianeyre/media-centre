#!/usr/bin/env node
/**
 * Stands in for Samsung's `sdb` beside the fake Samsung TV, for tests that run
 * the Hub as its own process, with `SAMSUNG_TV_SDB` set to this file. It
 * answers as the real `sdb` does, with an exit code of 0 even when it fails:
 * `connect <host>:26101` connects only to a fake TV, on `SAMSUNG_TV_REST_PORT`,
 * that says Developer Mode is on, and `disconnect` always disconnects.
 */
import { FAKE_DEVELOPER_PATH } from "./fake-samsung-tv.ts";

const [command, serial = ""] = process.argv.slice(2);
const host = serial.split(":")[0] ?? "";

if (command === "connect") {
  const developer = await fetch(`http://${host}:${String(process.env.SAMSUNG_TV_REST_PORT)}${FAKE_DEVELOPER_PATH}`)
    .then(async (response) => (await response.json()) as { mode?: string } | null)
    .catch(() => null);
  console.log(
    developer?.mode === "on"
      ? `connecting to ${serial} ...\nconnected to ${serial}`
      : `error: failed to connect to remote target '${host}'`,
  );
} else if (command === "disconnect") {
  console.log(`disconnected ${serial}`);
} else {
  console.log(`error: unknown command ${String(command)}`);
  process.exitCode = 1;
}
