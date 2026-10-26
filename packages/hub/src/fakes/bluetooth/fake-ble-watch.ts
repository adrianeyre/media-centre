#!/usr/bin/env node
/**
 * Stands in for the Hub's Bluetooth helper, `ble-watch.cs`, for tests that
 * run the Hub as its own process, with `BLUETOOTH_HELPER` set to this file,
 * on any machine. It writes the lines the helper does, for three devices: a
 * Lepro Light with a Telink chip, which advertises its name; a phone with a
 * made-up address, which names Apple; and a Midea Air Conditioner. It
 * listens for as many seconds as it is asked, writing each again each second.
 */
import { setTimeout as sleep } from "node:timers/promises";

/** The devices it stands in for, as the helper writes each: address, type, dBm, name as hex, company ids, UUIDs. */
export const FAKE_BLUETOOTH_DEVICES = [
  [
    "a4c1380a1b2c",
    "0",
    "-58",
    Buffer.from("Lepro LampUX").toString("hex"),
    "0211",
    "0000fff0-0000-1000-8000-00805f9b34fb",
  ],
  ["6a1f2e3d4c5b", "1", "-71", "", "004c", ""],
  ["f82a5379aec7", "0", "-82", Buffer.from("net").toString("hex"), "06a8", "0000180a-0000-1000-8000-00805f9b34fb"],
] as const;

const seconds = Number(process.argv[2] ?? "1");
for (let second = 0; second < seconds; second += 1) {
  for (const device of FAKE_BLUETOOTH_DEVICES) console.log(["ADVERT", ...device].join("\t"));
  await sleep(1_000);
}
console.log("DONE");
