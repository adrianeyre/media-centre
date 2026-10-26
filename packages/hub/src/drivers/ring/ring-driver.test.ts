import { describe, expect, it } from "vitest";

import { cameraIn, cameraStateIn, chimeIn, chimeStateIn, eventsIn } from "./ring-driver.ts";

/** A doorbell, as Ring's `ring_devices` gives one, cut to what the Driver reads, with its sort of noise. */
const DOORBELL = {
  id: 100001,
  description: "Front Door",
  kind: "doorbell_v4",
  battery_life: "82",
  battery_life_2: null,
  external_connection: false,
  alerts: { connection: "online", battery: "ok" },
  settings: { motion_detection_enabled: true, live_view_disabled: false },
  health: { rssi: -52, rssi_category: "good", battery_percentage: 82, battery_present: true },
  owner: { email: "owner@example.com" },
};

/** A wired floodlight camera, with its light and siren. */
const FLOODLIGHT = {
  id: 100002,
  description: "Garden",
  kind: "floodlight_v2",
  battery_life: null,
  external_connection: true,
  alerts: { connection: "offline" },
  settings: {},
  motion_detection_enabled: false,
  led_status: "on",
  siren_status: { seconds_remaining: 0 },
  health: { rssi: -71, rssi_category: "poor" },
};

const CHIME = {
  id: 100003,
  description: "Hallway Chime",
  kind: "chime_pro",
  alerts: { connection: "online" },
  settings: { volume: 8 },
};

describe("Ring's answers, as the Ring Driver reads them", () => {
  it("reads a doorbell and a camera, with what each can do", () => {
    expect(cameraIn(DOORBELL, true, "Video Doorbell 4", "Home")).toEqual({
      id: "100001",
      name: "Front Door",
      kind: "doorbell",
      model: "Video Doorbell 4",
      location: "Home",
      online: true,
      battery: 82,
      capabilities: { light: false, siren: false, video: true },
    });
    expect(cameraIn(FLOODLIGHT, false, "Floodlight Cam", "Home")).toMatchObject({
      kind: "camera",
      online: false,
      battery: null,
      capabilities: { light: true, siren: true, video: true },
    });
    expect(cameraIn({ description: "No id" }, false, "Stick Up Cam", "Home")).toBeNull();
    expect(cameraIn(null, false, "Stick Up Cam", "Home")).toBeNull();
  });

  it("reads a chime", () => {
    expect(chimeIn(CHIME, "Chime Pro", "Home")).toMatchObject({ id: "100003", kind: "chime", battery: null });
    expect(chimeStateIn(CHIME)).toEqual({ online: true, volume: 8, wifi: null });
    expect(chimeStateIn({ settings: { volume: 40 } }).volume).toBe(11);
  });

  it("reads a camera's state, each part null where Ring says nothing of it", () => {
    expect(cameraStateIn(DOORBELL)).toEqual({
      online: true,
      battery: 82,
      charging: false,
      wifi: { rssi: -52, quality: "good" },
      light: null,
      siren: null,
      motionDetection: true,
    });
    expect(cameraStateIn(FLOODLIGHT)).toMatchObject({
      light: true,
      siren: false,
      motionDetection: false,
      charging: null,
    });
    expect(cameraStateIn({ ...FLOODLIGHT, siren_status: { seconds_remaining: 25 } }).siren).toBe(true);
    expect(cameraStateIn(undefined)).toMatchObject({ battery: null, wifi: null, motionDetection: null });
  });

  it("reads a camera's events, newest first, recorded where Ring has the video", () => {
    expect(
      eventsIn({
        events: [
          { ding_id_str: "7001", kind: "motion", created_at: "2026-10-25T09:00:00Z", recording_status: "ready" },
          { ding_id: 7002, kind: "ding", created_at: "2026-10-25T10:00:00Z" },
          { ding_id_str: "7003", kind: "on_demand", created_at: "2026-10-24T10:00:00Z" },
          { ding_id_str: "7004", kind: "door_activity", created_at: "2026-10-23T10:00:00Z" },
          { kind: "motion", created_at: "2026-10-25T11:00:00Z" },
          "noise",
        ],
      }),
    ).toEqual([
      { id: "7002", kind: "ding", at: "2026-10-25T10:00:00.000Z", recorded: false },
      { id: "7001", kind: "motion", at: "2026-10-25T09:00:00.000Z", recorded: true },
      { id: "7003", kind: "live-view", at: "2026-10-24T10:00:00.000Z", recorded: false },
      { id: "7004", kind: "other", at: "2026-10-23T10:00:00.000Z", recorded: false },
    ]);
    expect(eventsIn(null)).toEqual([]);
  });
});
