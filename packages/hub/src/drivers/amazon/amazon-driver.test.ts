import { describe, expect, it } from "vitest";

import {
  alarmVolumeIn,
  bluetoothIn,
  devicesIn,
  doNotDisturbIn,
  equaliserIn,
  familyName,
  musicProvidersIn,
  notificationsIn,
  playerIn,
  routinesIn,
  signInSiteFor,
  volumeIn,
} from "./amazon-driver.ts";

/** Cover art, where Amazon serves it. */
const ART_HOST = "m.media-amazon.com";
const ART = `https://${ART_HOST}/images/I/art.jpg`;

/** Answers as `alexa-remote2` passes Amazon's on, shaped as its own code reads them. */
describe("signing in to Amazon", () => {
  it("is on amazon.com, which gives the authorization code, for every site but Japan's", () => {
    expect(signInSiteFor("amazon.co.uk")).toBe("amazon.com");
    expect(signInSiteFor("amazon.de")).toBe("amazon.com");
    expect(signInSiteFor("amazon.com")).toBe("amazon.com");
    expect(signInSiteFor("amazon.co.jp")).toBe("amazon.co.jp");
  });
});

describe("Amazon's answers", () => {
  it("give the devices on the account, but the Alexa app's own, with what each can do, by name", () => {
    expect(
      devicesIn({
        devices: [
          {
            accountName: "Lounge Echo Show",
            serialNumber: "G2",
            deviceFamily: "KNIGHT",
            online: false,
            capabilities: ["AUDIO_PLAYER", "VOLUME_SETTING"],
          },
          {
            accountName: "Kitchen Echo Dot",
            serialNumber: "G1",
            deviceFamily: "ECHO",
            online: true,
            capabilities: [
              "AMAZON_MUSIC",
              "VOLUME_SETTING",
              "TIMERS_AND_ALARMS",
              "EQUALIZER_CONTROLLER_BASS",
              "A2DP_SINK",
            ],
          },
          { accountName: "This phone", serialNumber: "V1", deviceFamily: "VOX", online: true, capabilities: [] },
          { accountName: "No serial", deviceFamily: "ECHO" },
        ],
      }),
    ).toEqual([
      {
        serial: "G1",
        name: "Kitchen Echo Dot",
        family: "Echo",
        online: true,
        capabilities: { music: true, volume: true, alarms: true, equaliser: true, bluetooth: true },
      },
      {
        serial: "G2",
        name: "Lounge Echo Show",
        family: "Echo Show",
        online: false,
        capabilities: { music: true, volume: true, alarms: false, equaliser: false, bluetooth: false },
      },
    ]);
    expect(devicesIn(null)).toEqual([]);
    expect(familyName("SOME_NEW_THING")).toBe("Some New Thing");
  });

  it("give what a device plays, and its volume, or nothing where it says nothing", () => {
    const answer = {
      playerInfo: {
        state: "PLAYING",
        infoText: { title: "Bohemian Rhapsody", subText1: "Queen", subText2: "A Night at the Opera" },
        mainArt: { url: ART },
        provider: { providerName: "Amazon Music" },
        progress: { mediaProgress: 61, mediaLength: 354 },
        volume: { volume: 42.4, muted: false },
      },
    };
    expect(playerIn(answer)).toEqual({
      state: "playing",
      title: "Bohemian Rhapsody",
      subtitle: "Queen",
      provider: "Amazon Music",
      artUrl: ART,
      progress: 61,
      length: 354,
    });
    expect(volumeIn(answer)).toBe(42);
    expect(playerIn({ playerInfo: { state: null } })).toMatchObject({ state: "idle", title: null });
    expect(playerIn({})).toBeNull();
    expect(volumeIn({})).toBeNull();
  });

  it("give Do Not Disturb, the equaliser, the alarm volume and Bluetooth, for one device", () => {
    expect(
      doNotDisturbIn(
        {
          doNotDisturbDeviceStatusList: [
            { deviceSerialNumber: "G1", enabled: true },
            { deviceSerialNumber: "G2", enabled: false },
          ],
        },
        "G1",
      ),
    ).toBe(true);
    expect(doNotDisturbIn({ doNotDisturbDeviceStatusList: [] }, "G1")).toBeNull();
    expect(equaliserIn({ bass: 2, mid: -1, treble: 0 })).toEqual({ bass: 2, midrange: -1, treble: 0 });
    expect(equaliserIn({ bass: 2 })).toBeNull();
    expect(alarmVolumeIn({ volumeLevel: 60 })).toBe(60);
    expect(
      bluetoothIn(
        {
          bluetoothStates: [
            {
              deviceSerialNumber: "G1",
              pairedDeviceList: [
                { address: "AA:BB", friendlyName: "Phone", connected: true },
                { friendlyName: "No address" },
              ],
            },
          ],
        },
        "G1",
      ),
    ).toEqual([{ address: "AA:BB", name: "Phone", connected: true }]);
  });

  it("give a device's alarms, timers and reminders, soonest first, but those cancelled or another's", () => {
    expect(
      notificationsIn(
        {
          notifications: [
            {
              id: "r",
              type: "Reminder",
              deviceSerialNumber: "G1",
              status: "ON",
              reminderLabel: "Bins",
              alarmTime: 1_793_000_000_000,
            },
            { id: "a", type: "Alarm", deviceSerialNumber: "G1", status: "OFF", alarmTime: 1_792_000_000_000 },
            {
              id: "t",
              type: "Timer",
              deviceSerialNumber: "G1",
              status: "ON",
              timerLabel: "Pasta",
              alarmTime: 0,
              remainingTime: 125_000,
            },
            { id: "x", type: "Reminder", deviceSerialNumber: "G1", status: "INSTANCE_CANCELED", alarmTime: 1 },
            { id: "y", type: "Alarm", deviceSerialNumber: "G2", status: "ON", alarmTime: 1 },
            { id: "z", type: "SomethingElse", deviceSerialNumber: "G1" },
          ],
        },
        "G1",
      ),
    ).toEqual([
      { id: "t", type: "timer", label: "Pasta", on: true, at: null, remaining: 125 },
      {
        id: "a",
        type: "alarm",
        label: null,
        on: false,
        at: new Date(1_792_000_000_000).toISOString(),
        remaining: null,
      },
      {
        id: "r",
        type: "reminder",
        label: "Bins",
        on: true,
        at: new Date(1_793_000_000_000).toISOString(),
        remaining: null,
      },
    ]);
  });

  it("give the routines, named, or by what triggers them, and the music services available", () => {
    expect(
      routinesIn([
        { automationId: "b", name: "Movie time" },
        { automationId: "a", name: null, triggers: [{ payload: { utterance: "good night" } }] },
        { name: "No id" },
      ]),
    ).toEqual([
      { id: "a", name: "“good night”" },
      { id: "b", name: "Movie time" },
    ]);
    expect(
      musicProvidersIn([
        { id: "AMAZON_MUSIC", displayName: "Amazon Music", availability: "AVAILABLE" },
        { id: "SPOTIFY", displayName: "Spotify", availability: "UNAVAILABLE" },
        { id: "TUNEIN", displayName: "TuneIn" },
      ]),
    ).toEqual([
      { id: "AMAZON_MUSIC", name: "Amazon Music" },
      { id: "TUNEIN", name: "TuneIn" },
    ]);
  });
});
