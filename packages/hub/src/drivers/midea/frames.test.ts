import { describe, expect, it } from "vitest";

import {
  buildFrame,
  capabilitiesAnswerBody,
  FRAME_QUERY,
  FRAME_SET,
  MIDEA_FAN,
  MIDEA_MODE,
  NotAFrame,
  parseCapabilitiesAnswer,
  parseFrame,
  parsePropertiesAnswer,
  parsePropertiesQuery,
  parsePropertiesSet,
  parseSetState,
  parseStateAnswer,
  propertiesAnswerBody,
  QUERY_PROPERTIES,
  queryPropertiesBody,
  setPropertiesBody,
  setStateBody,
  stateAnswerBody,
  SWING_HORIZONTAL,
  SWING_VERTICAL,
  type MideaSettings,
  type MideaState,
} from "./frames.ts";
import { crc8 } from "./security.ts";

const STATE: MideaState = {
  power: true,
  mode: MIDEA_MODE.heat,
  targetTemperature: 21.5,
  fanSpeed: MIDEA_FAN.low,
  swing: SWING_VERTICAL | SWING_HORIZONTAL,
  eco: false,
  turbo: true,
  sleep: false,
  display: false,
  indoorTemperature: 19.3,
  outdoorTemperature: -2.4,
};

describe("Midea's frames", () => {
  it("end the body with its CRC-8, the Dallas/Maxim one", () => {
    // The check value every CRC-8/MAXIM implementation gives for these nine bytes.
    expect(crc8(Buffer.from("123456789", "ascii"))).toBe(0xa1);
  });

  it("carry a body with its type, and refuse one whose checksum doesn't add up", () => {
    const frame = buildFrame(Buffer.from([0x41, 0x81, 0x00]), FRAME_QUERY);

    expect(frame[0]).toBe(0xaa);
    expect(frame[1]).toBe(frame.length - 1);
    expect(frame[2]).toBe(0xac);
    expect(parseFrame(frame)).toEqual({ type: FRAME_QUERY, body: Buffer.from([0x41, 0x81, 0x00]) });

    const corrupt = Buffer.from(frame);
    corrupt[11] = 0x82;
    expect(() => parseFrame(corrupt)).toThrow(NotAFrame);
    expect(() => parseFrame(Buffer.from([0x55, 1, 2]))).toThrow(NotAFrame);
  });

  it("read back the state a unit answers with, to a half degree and a tenth", () => {
    expect(parseStateAnswer(stateAnswerBody(STATE))).toEqual(STATE);
    expect(parseStateAnswer(stateAnswerBody({ ...STATE, indoorTemperature: null, outdoorTemperature: null }))).toEqual(
      expect.objectContaining({ indoorTemperature: null, outdoorTemperature: null }),
    );
    for (const targetTemperature of [16, 17.5, 30, 31.5, 13, 43]) {
      expect(parseStateAnswer(stateAnswerBody({ ...STATE, targetTemperature })).targetTemperature).toBe(
        targetTemperature,
      );
    }
  });

  it("read back the whole state the set command sets", () => {
    const settings: MideaSettings = {
      power: true,
      mode: MIDEA_MODE.dry,
      targetTemperature: 17.5,
      fanSpeed: MIDEA_FAN.high,
      swing: SWING_HORIZONTAL,
      eco: false,
      turbo: true,
      sleep: false,
    };

    expect(parseSetState(setStateBody(settings))).toEqual(settings);
    expect(parseSetState(setStateBody({ ...settings, power: false, eco: true, turbo: false, sleep: true }))).toEqual({
      ...settings,
      power: false,
      eco: true,
      turbo: false,
      sleep: true,
    });
  });

  it("read back a page of capabilities, and whether another follows", () => {
    const entries = [
      { id: 0x0214, value: Buffer.of(1) },
      { id: 0x0225, value: Buffer.of(32, 60, 32, 60, 32, 60, 1) },
    ];

    expect(parseCapabilitiesAnswer(capabilitiesAnswerBody(entries, true))).toEqual({ entries, more: true });
    expect(parseCapabilitiesAnswer(capabilitiesAnswerBody([], false))).toEqual({ entries: [], more: false });
  });

  it("query and set further functions by id, and read back those the unit took", () => {
    expect(parsePropertiesQuery(queryPropertiesBody([0x0039, 0x0043]))).toEqual([0x0039, 0x0043]);
    const set = [{ id: 0x0043, value: Buffer.of(3) }];
    expect(parsePropertiesSet(setPropertiesBody(set))).toEqual(set);

    const answer = propertiesAnswerBody(QUERY_PROPERTIES, [{ id: 0x0039, value: Buffer.of(1) }]);
    expect(parsePropertiesAnswer(answer)).toEqual(new Map([[0x0039, Buffer.of(1)]]));
    // One the unit didn't take, with a result that isn't 0, is left out.
    const refused = Buffer.from(answer);
    refused[4] = 1;
    expect(parsePropertiesAnswer(refused)).toEqual(new Map());
    expect(FRAME_SET).not.toBe(FRAME_QUERY);
  });
});
