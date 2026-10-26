import { describe, expect, it } from "vitest";

import {
  capabilitiesFrom,
  colourFrom,
  colourText,
  dataPointsFor,
  decodeAnnouncement,
  decodeFrame,
  decodeMessage,
  encodeAnnouncement,
  encodeFrame,
  encodeMessage,
  frameLength,
  NotAFrame,
  readAnnouncement,
  stateFrom,
  TUYA_COMMAND,
  Unreadable,
} from "./tuya.ts";

const KEY = "0123456789abcdef";

describe("Tuya's frames", () => {
  it("are 000055aa, a sequence number, a command and a length, the payload, a CRC-32 and 0000aa55", () => {
    const frame = encodeFrame({ seq: 1, command: TUYA_COMMAND.query, payload: Buffer.from("hi") });
    expect(frame.toString("hex")).toBe(
      "000055aa" + "00000001" + "0000000a" + "0000000a" + "6869" + frame.subarray(18, 22).toString("hex") + "0000aa55",
    );
    expect(frameLength(frame)).toBe(frame.length);
    expect(decodeFrame(frame, { fromLight: false })).toEqual({ seq: 1, command: 0x0a, payload: Buffer.from("hi") });
  });

  it("from the Light have a return code before the payload", () => {
    const frame = encodeFrame({ seq: 7, command: TUYA_COMMAND.control, retcode: 1, payload: Buffer.from("no") });
    expect(frame.readUInt32BE(12)).toBe(4 + 2 + 8);
    expect(decodeFrame(frame, { fromLight: true })).toEqual({
      seq: 7,
      command: 0x07,
      retcode: 1,
      payload: Buffer.from("no"),
    });
  });

  it("are told apart from what isn't one, or is only part of one, or has the wrong CRC", () => {
    const frame = encodeFrame({ seq: 1, command: TUYA_COMMAND.query, payload: Buffer.from("hi") });
    expect(frameLength(frame.subarray(0, 2))).toBeUndefined();
    expect(frameLength(frame.subarray(0, 15))).toBeUndefined();
    expect(() => frameLength(Buffer.from("GET / HTTP/1.1"))).toThrow(NotAFrame);
    const damaged = Buffer.from(frame);
    damaged[16] = 0x00;
    expect(() => decodeFrame(damaged, { fromLight: false })).toThrow("A Tuya frame whose CRC is wrong");
  });
});

describe("Tuya's messages", () => {
  it("are JSON encrypted under the Light's key, a control's and a report's after the version", () => {
    const query = encodeMessage(KEY, TUYA_COMMAND.query, { devId: "bf01" });
    expect(query.subarray(0, 3).toString()).not.toBe("3.3");
    expect(query.length % 16).toBe(0);
    expect(decodeMessage(KEY, query)).toEqual({ devId: "bf01" });

    const control = encodeMessage(KEY, TUYA_COMMAND.control, { dps: { "20": true } });
    expect(control.subarray(0, 15)).toEqual(Buffer.concat([Buffer.from("3.3"), Buffer.alloc(12)]));
    expect(decodeMessage(KEY, control)).toEqual({ dps: { "20": true } });
    expect(decodeMessage(KEY, Buffer.alloc(0))).toBeUndefined();
  });

  it("don't read under another key, and say nothing of what they hold", () => {
    const message = encodeMessage(KEY, TUYA_COMMAND.query, { devId: "bf0123456789abcdef01" });
    let error: unknown;
    try {
      decodeMessage("fedcba9876543210", message);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Unreadable);
    expect(error).toMatchObject({ message: "The payload doesn't read with that key" });
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("Tuya's announcements", () => {
  it("are read encrypted, as on 6667, and in plain JSON, as on 6666", () => {
    const announcement = { ip: "192.168.1.40", id: "bf0123456789abcdef01", productKey: "keyabc" };
    const heard = { address: "192.168.1.40", id: "bf0123456789abcdef01", model: "Lepro, protocol v3.3" };
    const encrypted = encodeAnnouncement(announcement);
    expect(encrypted.includes(Buffer.from("bf0123456789abcdef01"))).toBe(false);
    expect(decodeAnnouncement(encrypted, "192.168.1.40")).toEqual(heard);
    const plain = encodeAnnouncement(announcement, { plain: true });
    expect(JSON.parse(plain.subarray(20, plain.length - 8).toString())).toMatchObject({
      gwId: "bf0123456789abcdef01",
      version: "3.3",
    });
    expect(decodeAnnouncement(plain, "192.168.1.40")).toEqual(heard);
  });

  it("are ignored when they aren't one", () => {
    expect(decodeAnnouncement(Buffer.from("hello"), "192.168.1.40")).toBeUndefined();
    const notAnnouncement = encodeFrame({ seq: 0, command: TUYA_COMMAND.status, retcode: 0, payload: Buffer.alloc(0) });
    expect(decodeAnnouncement(notAnnouncement, "192.168.1.40")).toBeUndefined();
  });

  it("say why one isn't a Light the Hub can use, never quoting its id", () => {
    const id = "bf0123456789abcdef01";
    const on = (version: string) =>
      encodeFrame({
        seq: 0,
        command: TUYA_COMMAND.announcePlain,
        retcode: 0,
        payload: Buffer.from(JSON.stringify({ ip: "192.168.1.40", gwId: id, productKey: "keyabc", version })),
      });
    const v34 = readAnnouncement(on("3.4"), "192.168.1.40");
    expect(v34).toEqual({
      ignored: "a Tuya module on protocol v3.4, product keyabc, where the Hub speaks v3.3 alone",
    });
    expect(JSON.stringify(v34)).not.toContain(id.slice(0, 10));
    expect(readAnnouncement(Buffer.from("000066990000000000000000", "hex"), "192.168.1.40")).toEqual({
      ignored: "a frame of Tuya's protocol v3.5, which the Hub doesn't speak",
    });
    expect(readAnnouncement(Buffer.from("hello"), "192.168.1.40")).toEqual({
      ignored: "5 bytes that aren't a Tuya frame (Not a Tuya frame), starting 68656c6c6f",
    });
    const status = encodeFrame({ seq: 0, command: TUYA_COMMAND.status, retcode: 0, payload: Buffer.alloc(0) });
    expect(readAnnouncement(status, "192.168.1.40")).toEqual({
      ignored: "a Tuya frame of command 0x8, not an announcement",
    });
    expect(readAnnouncement(on("3.3"), "192.168.1.40")).toEqual({
      light: { address: "192.168.1.40", id, model: "Lepro, protocol v3.3" },
    });
  });
});

describe("A Light's data points", () => {
  it("give its capabilities: 20 to 24 a Light's, 1 a plug's", () => {
    expect(capabilitiesFrom({ "20": true, "21": "white", "22": 500, "23": 0, "24": "000003e803e8" })).toEqual({
      onOff: true,
      brightness: true,
      colourTemperature: { min: 2_700, max: 6_500 },
      colour: true,
    });
    expect(capabilitiesFrom({ "20": false, "22": 500 })).toEqual({
      onOff: true,
      brightness: true,
      colourTemperature: null,
      colour: false,
    });
    expect(capabilitiesFrom({ "1": true })).toEqual({
      onOff: true,
      brightness: false,
      colourTemperature: null,
      colour: false,
    });
    expect(() => capabilitiesFrom({ "2": "white" })).toThrow("Reports no on/off");
  });

  it("read a plug that measures what it supplies as on/off alone, its readings on 18 to 26 aside", () => {
    const metering = { "1": true, "9": 0, "18": 120, "19": 250, "20": 2_301, "21": 1, "22": 600, "23": 30_000 };
    expect(capabilitiesFrom(metering)).toEqual({
      onOff: true,
      brightness: false,
      colourTemperature: null,
      colour: false,
    });
    expect(stateFrom(metering, capabilitiesFrom(metering))).toEqual({
      on: true,
      brightness: null,
      colourTemperature: null,
      colour: null,
    });
    expect(dataPointsFor({ on: false }, metering)).toEqual({ "1": false });
  });

  it("scale brightness from 10 to 1000 and colour temperature from 0 to 1000 as percent and kelvin", () => {
    const dps = { "20": true, "21": "white", "22": 10, "23": 1_000, "24": "000003e803e8" };
    expect(stateFrom(dps, capabilitiesFrom(dps))).toEqual({
      on: true,
      brightness: 1,
      colourTemperature: 6_500,
      colour: null,
    });
    expect(dataPointsFor({ brightness: 100, colourTemperature: 3_650 }, dps)).toEqual({
      "21": "white",
      "22": 1_000,
      "23": 250,
    });
  });

  it("write a colour as hue, saturation and value, 4 hex digits each", () => {
    expect(colourText({ hue: 360, saturation: 1_000, value: 10 })).toBe("016803e8000a");
    expect(colourFrom("016803e8000a")).toEqual({ hue: 360, saturation: 1_000, value: 10 });
    expect(colourFrom("016903e8000a")).toBeUndefined();
    expect(colourFrom("ffffff")).toBeUndefined();
    const dps = { "20": true, "21": "colour", "22": 10, "23": 0, "24": "016803e8000a" };
    expect(stateFrom(dps, capabilitiesFrom(dps)).colour).toEqual({ hue: 0, saturation: 100 });
  });
});
