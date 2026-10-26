import {
  APPLIANCE_SEARCH_PATH,
  APPLIANCES_PATH,
  HEATING_PATH,
  HIVE_CODE_PATH,
  HIVE_PATH,
  HIVE_SIGN_IN_PATH,
  LIGHT_SCENES_PATH,
  LIGHTS_PATH,
  WHOLE_HOME_PATH,
  applianceAppPath,
  applianceAppsPath,
  applianceCapabilitiesPath,
  applianceConnectionPath,
  applianceDeviceInfoPath,
  applianceKeyboardPath,
  applianceKeysPath,
  applianceNowShowingPath,
  appliancePairingPath,
  appliancePath,
  appliancePlaybackPath,
  appliancePlayerActionPath,
  heatingPath,
  appliancePlayPath,
  applianceQueuePath,
  appliancePowerPath,
  applianceShortcutsPath,
  applianceStatePath,
  applianceVolumePath,
  lightSceneRecallPath,
  lightScenePath,
  roomTargetPath,
  type AddApplianceRequest,
  type AirConditionerCapabilitiesReading,
  type AirConditionerChange,
  type AirConditionerReading,
  type Appliance,
  type ApplianceApps,
  type ApplianceDeviceInfo,
  type ApplianceKeyboard,
  type ApplianceKind,
  type AppliancePlayback,
  type AppliancePower,
  type ApplianceVolume,
  type CloudLogin,
  type FoundAirConditioner,
  type FoundAppliance,
  type FoundLight,
  type HeatingChange,
  type HeatingHome,
  type HeatingOutcome,
  type HiveAccount,
  type HiveCodeRequest,
  type HiveSignedIn,
  type HiveSignInOutcome,
  type HotWaterChange,
  type KeyboardText,
  type KeyPressRequest,
  type LightCapabilitiesReading,
  type LightChange,
  type LightReading,
  type LightScene,
  type LightSceneSaved,
  type LightsChange,
  type LightsChangeRequest,
  type LightsOutcome,
  type PairingRequest,
  type MenuShortcut,
  type NowPlaying,
  type NowShowing,
  type PlaybackControl,
  type PlayerAction,
  type PlayerActionRequest,
  type PlayerActionStep,
  type PlayFolderRequest,
  type PlayRequest,
  type PlayStep,
  type QueueControl,
  type PowerState,
  type PowerSwitch,
  type RemoteKey,
  type ShortcutOutcome,
  type ShortcutRequest,
  type UpdateApplianceRequest,
  type VolumeChange,
} from "@media-centre/shared";

import { createHubRequest, HubRequestFailed } from "./hub-request.ts";

/** The Hub's Appliances, as the Remote finds, asks for, changes and controls them (FR-8, FR-11 to FR-14, FR-16 to FR-21, FR-24, FR-26, FR-28, FR-31, FR-35, FR-36, FR-49 to FR-54, FR-57b, FR-67). */
export interface AppliancesApi {
  /** Every Appliance, of every kind. */
  readonly list: () => Promise<Appliance[]>;
  /**
   * Resolves once the Appliance is paired, which for a TV waits on the person
   * choosing Allow. For an Air Conditioner that needs the owner's login to
   * its maker's cloud, and was sent none, it fails with `needs: "login"`.
   * A Light is sent with its key, which the Remote never shows again.
   */
  readonly add: (request: AddApplianceRequest) => Promise<Appliance>;
  readonly update: (id: number, change: UpdateApplianceRequest) => Promise<Appliance>;
  /** Removes it, and the Hub forgets its credentials. */
  readonly remove: (id: number) => Promise<void>;
  /** Has the Hub connect to it, and resolves with it, `"pair-again"` if it refused the Hub. */
  readonly checkConnection: (id: number) => Promise<Appliance>;
  readonly pairAgain: (id: number) => Promise<Appliance>;
  /**
   * "Fetch again": has the Hub fetch an Air Conditioner's token and key from
   * its maker's cloud once more, with the owner's login, which it forgets
   * (FR-51). Resolves with it, `"paired"` once it accepts them.
   */
  readonly fetchAgain: (id: number, login: CloudLogin) => Promise<Appliance>;
  /** Has the Hub ask it, now, whether it is on, in standby or unreachable. */
  readonly readPower: (id: number) => Promise<PowerState>;
  /**
   * The Power button: has the Hub switch it off if it is on, and on if it
   * isn't, and resolves with which, once the Hub has sent that. It may take a
   * few seconds more to change, which {@link readPower} then says.
   */
  readonly switchPower: (id: number) => Promise<PowerSwitch>;
  /** Has the Hub search its network, e.g. "Find TVs", which takes a few seconds (FR-12). */
  readonly find: (kind: Exclude<ApplianceKind, "air-conditioner" | "light">) => Promise<FoundAppliance[]>;
  /** Has the Hub search its network for Air Conditioners, "Find Air Conditioners", which takes a few seconds (FR-51). */
  readonly findAirConditioners: () => Promise<FoundAirConditioner[]>;
  /** Has the Hub search its network for Lights, "Find Lights", which takes a few seconds (FR-54). */
  readonly findLights: () => Promise<FoundLight[]>;
  /** Has the Hub press a key on it, e.g. OK on a TV, and resolves once the key is sent. */
  readonly pressKey: (id: number, key: RemoteKey) => Promise<void>;
  /**
   * Has the Hub press one of TV Menu mode's shortcuts on it (FR-24), and
   * resolves once the key is sent, so that the next key can go. `outcome`
   * resolves a moment later with what it said of the key: `"unconfirmed"`
   * also when the Hub's answer is cut off, as nothing more is known then.
   */
  readonly pressShortcut: (
    id: number,
    shortcut: MenuShortcut,
  ) => Promise<{ readonly outcome: Promise<ShortcutOutcome["outcome"]> }>;
  /** Has the Hub ask it, now, for its own volume and mute, which it may not be able to say, e.g. in standby. */
  readonly readVolume: (id: number) => Promise<ApplianceVolume>;
  /** Has the Hub set its volume, its mute or both, and resolves with them as it says they are now. */
  readonly changeVolume: (id: number, change: VolumeChange) => Promise<ApplianceVolume>;
  /** Has the Hub say whether its on-screen keyboard is open, as it last said. */
  readonly readKeyboard: (id: number) => Promise<boolean>;
  /** Has the Hub type the text into its on-screen keyboard and submit it, and resolves once it is sent. */
  readonly enterText: (id: number, text: string) => Promise<void>;
  /** Has the Hub ask it, now, for its installed apps, which it can't say in standby or unreachable. */
  readonly listApps: (id: number) => Promise<ApplianceApps>;
  /** Has the Hub launch the app on it, and resolves once it has taken that. */
  readonly launchApp: (id: number, appId: string) => Promise<void>;
  /** Has the Hub close the app on it, and resolves once it has taken that. */
  readonly closeApp: (id: number, appId: string) => Promise<void>;
  /** Has the Hub ask it, now, which app is in front, which it may not be able to tell, changing nothing on it. */
  readonly readNowShowing: (id: number) => Promise<NowShowing>;
  /** Has the Hub ask it, now, what it reports about itself, e.g. a TV's Developer Mode, changing nothing on it. */
  readonly readDeviceInfo: (id: number) => Promise<ApplianceDeviceInfo>;
  /**
   * Has the Hub install or update, launch or uninstall the Player on it, a
   * TV in Developer Mode with the Hub's IP as its Developer IP (FR-31),
   * calling `onStep` with each step as the Hub starts it, and resolves once
   * it is done. It fails with why: the Hub refusing it, e.g. for a TV not in
   * Developer Mode, a step failing, or the Hub's answer cut off.
   */
  readonly playerAction: (id: number, action: PlayerAction, onStep: (step: PlayerActionStep) => void) => Promise<void>;
  /**
   * Has the Hub play the Media File on it, a TV (FR-35), or a folder as a
   * Queue (FR-46), calling `onStep` with each step as the Hub starts it, and
   * resolves once the Player has been sent the Media File, or the Queue's
   * first. It fails with why: the Hub refusing it, a step failing, e.g. the
   * TV not coming on, or the Hub's answer cut off.
   */
  readonly play: (
    id: number,
    request: PlayRequest | PlayFolderRequest,
    onStep: (step: PlayStep) => void,
  ) => Promise<void>;
  /**
   * Has the Hub say what the Player on it, a TV, is playing, as the Player
   * last told it, or null for nothing (FR-36). It asks nothing of the TV.
   */
  readonly readPlayback: (id: number) => Promise<NowPlaying | null>;
  /**
   * Has the Hub send the control to the Player on it, and resolves with what
   * the Player is playing once it has done it, or null for nothing.
   */
  readonly controlPlayback: (id: number, control: PlaybackControl) => Promise<NowPlaying | null>;
  /**
   * Has the Hub change the Queue it, a TV, plays (FR-48), and resolves with
   * what the Player is playing once it has started the Media File the Queue
   * moved to, if it moved, or null for nothing.
   */
  readonly controlQueue: (id: number, control: QueueControl) => Promise<NowPlaying | null>;
  /**
   * Has the Hub ask an Air Conditioner, now, for the controls it reports it
   * has (FR-50), which it can't say while it can't be reached (FR-51a).
   */
  readonly readAirConditionerCapabilities: (id: number) => Promise<AirConditionerCapabilitiesReading>;
  /** Has the Hub ask an Air Conditioner, now, what it is doing, which it can't say while it can't be reached (FR-51a). */
  readonly readAirConditioner: (id: number) => Promise<AirConditionerReading>;
  /** Has the Hub change what is asked on an Air Conditioner, and resolves with what it then says it is doing. */
  readonly changeAirConditioner: (id: number, change: AirConditionerChange) => Promise<AirConditionerReading>;
  /** Has the Hub ask a Light, now, for the controls it reports it has (FR-52), which it can't say while it can't be reached (FR-57b). */
  readonly readLightCapabilities: (id: number) => Promise<LightCapabilitiesReading>;
  /** Has the Hub ask a Light, now, what it is doing, which it can't say while it can't be reached (FR-57b). */
  readonly readLight: (id: number) => Promise<LightReading>;
  /** Has the Hub change what is asked on a Light, and resolves with what it then says it is doing. */
  readonly changeLight: (id: number, change: LightChange) => Promise<LightReading>;
  /**
   * A Room-wide control, or with no Room All off (FR-53): has the Hub make
   * the change of every Light in the Room, or in the home, and resolves with
   * how each went, and which didn't answer (FR-57b).
   */
  readonly changeLights: (roomId: number | undefined, change: LightsChange) => Promise<LightsOutcome>;
  /** Every Light Scene the Hub keeps, by Room, in Room order (FR-56). */
  readonly lightScenes: () => Promise<LightScene[]>;
  /**
   * "Save as Light Scene": has the Hub keep each Light in the Room as it is
   * now, under `name`, and resolves with it, and which Lights didn't answer.
   */
  readonly saveLightScene: (roomId: number, name: string) => Promise<LightSceneSaved>;
  readonly renameLightScene: (id: number, name: string) => Promise<LightScene>;
  readonly deleteLightScene: (id: number) => Promise<void>;
  /**
   * Has the Hub set each Light still in the Light Scene's Room, and in it,
   * back to how it was saved, and resolves with how each went, and which
   * didn't answer (FR-57b).
   */
  readonly recallLightScene: (id: number) => Promise<LightsOutcome>;
  /** Whether the Hub is signed in to Hive, which the Hub asks Hive now, and whether Hive still accepts its tokens (FR-67b). */
  readonly readHive: () => Promise<HiveAccount>;
  /**
   * Has the Hub sign in to Hive with the account owner's email and
   * password, which it never keeps (FR-67), and resolves with the
   * Appliances it added, or that Hive asks for the code it texted.
   */
  readonly signInToHive: (login: CloudLogin) => Promise<HiveSignInOutcome>;
  /** Gives the Hub the code Hive texted, and resolves with the Appliances it added once signed in. */
  readonly enterHiveCode: (code: string) => Promise<HiveSignedIn>;
  /** Has the Hub sign out of Hive, removing every Heating, Radiator Valve and Hot Water. */
  readonly signOutOfHive: () => Promise<void>;
  /**
   * Every Heating, Radiator Valve and Hot Water, with what Hive reports of
   * each now, which the Hub reads from Hive as it is asked (FR-62), or why it
   * can't.
   */
  readonly readHeating: () => Promise<HeatingHome>;
  /** Has the Hub make one change to one Heating, Radiator Valve or Hot Water, and resolves with what Hive then reports. */
  readonly changeHeating: (id: number, change: HeatingChange | HotWaterChange) => Promise<HeatingOutcome>;
  /** The Whole home: has the Hub make the change of every Heating, and resolves with which didn't take it (FR-64). */
  readonly changeWholeHome: (change: HeatingChange) => Promise<HeatingOutcome>;
  /** A Room-wide target: has the Hub set every Radiator Valve in the Room to it, and resolves with which didn't take it (FR-65). */
  readonly setRoomTarget: (roomId: number, target: number) => Promise<HeatingOutcome>;
}

/** What the Remote says when the Hub's answer to a play stops before it says how it went. */
export const PLAY_CUT_OFF = "Lost touch with the Hub before it said whether the Media File is playing.";

const PLAY_STEPS: readonly PlayStep[] = ["waking", "launching", "connecting", "sending"];
const PLAYER_ACTION_STEPS: readonly PlayerActionStep[] = [
  "connecting",
  "signing",
  "installing",
  "launching",
  "uninstalling",
];

/** What the Remote says when the Hub's answer to a Player action stops before it says how it went. */
export const PLAYER_ACTION_CUT_OFF =
  "Lost touch with the Hub before it said how that went. Check the TV, then try again.";

/**
 * Reads the Hub's answer to something it does in steps, one progress per
 * line, as each arrives, calling `onStep` with each of the `steps` it
 * knows, until one says it is `finished`, or failed. One that stops before
 * either fails as `cutOff`.
 */
const followSteps = async <Step extends string>(
  response: Response,
  steps: readonly Step[],
  onStep: (step: Step) => void,
  finished: string,
  cutOff: string,
): Promise<void> => {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new HubRequestFailed(cutOff);
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch {
      throw new HubRequestFailed(cutOff);
    }
    if (read.done) throw new HubRequestFailed(cutOff);
    pending += decoder.decode(read.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      let progress: { readonly step: Step } | { readonly step: "failed"; readonly error: string };
      try {
        progress = JSON.parse(line) as typeof progress;
      } catch {
        continue;
      }
      if (progress.step === finished) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      if ("error" in progress) {
        await reader.cancel().catch(() => undefined);
        throw new HubRequestFailed(progress.error);
      }
      const known = steps.find((step) => step === progress.step);
      if (known !== undefined) onStep(known);
    }
  }
};

/** Talks to the Hub about Appliances. A refusal fails with a `HubRequestFailed` giving the Hub's reason. */
export const createAppliancesApi = (fetchFn: typeof fetch = fetch): AppliancesApi => {
  const request = createHubRequest(fetchFn);
  const appliance = async (response: Promise<Response>): Promise<Appliance> =>
    (await (await response).json()) as Appliance;

  return {
    list: async () => (await (await request("GET", APPLIANCES_PATH)).json()) as Appliance[],
    add: (body) => appliance(request("POST", APPLIANCES_PATH, body)),
    update: (id, change) => appliance(request("PATCH", appliancePath(id), change)),
    remove: async (id) => {
      await request("DELETE", appliancePath(id));
    },
    checkConnection: (id) => appliance(request("POST", applianceConnectionPath(id))),
    pairAgain: (id) => appliance(request("POST", appliancePairingPath(id))),
    fetchAgain: (id, login) => {
      const body: PairingRequest = { login };
      return appliance(request("POST", appliancePairingPath(id), body));
    },
    readPower: async (id) => ((await (await request("GET", appliancePowerPath(id))).json()) as AppliancePower).power,
    switchPower: async (id) => (await (await request("POST", appliancePowerPath(id))).json()) as PowerSwitch,
    find: async (kind) => (await (await request("POST", APPLIANCE_SEARCH_PATH, { kind })).json()) as FoundAppliance[],
    findAirConditioners: async () =>
      (await (
        await request("POST", APPLIANCE_SEARCH_PATH, { kind: "air-conditioner" })
      ).json()) as FoundAirConditioner[],
    findLights: async () =>
      (await (await request("POST", APPLIANCE_SEARCH_PATH, { kind: "light" })).json()) as FoundLight[],
    pressKey: async (id, key) => {
      const body: KeyPressRequest = { key };
      await request("POST", applianceKeysPath(id), body);
    },
    pressShortcut: async (id, shortcut) => {
      const body: ShortcutRequest = { shortcut };
      const response = await request("POST", applianceShortcutsPath(id), body);
      return {
        outcome: response.json().then(
          (answer) => ((answer as ShortcutOutcome).outcome === "ignored" ? "ignored" : "unconfirmed"),
          () => "unconfirmed" as const,
        ),
      };
    },
    readVolume: async (id) => (await (await request("GET", applianceVolumePath(id))).json()) as ApplianceVolume,
    changeVolume: async (id, change) =>
      (await (await request("PATCH", applianceVolumePath(id), change)).json()) as ApplianceVolume,
    readKeyboard: async (id) =>
      ((await (await request("GET", applianceKeyboardPath(id))).json()) as ApplianceKeyboard).open,
    enterText: async (id, text) => {
      const body: KeyboardText = { text };
      await request("POST", applianceKeyboardPath(id), body);
    },
    listApps: async (id) => (await (await request("GET", applianceAppsPath(id))).json()) as ApplianceApps,
    launchApp: async (id, appId) => {
      await request("POST", applianceAppPath(id, appId));
    },
    closeApp: async (id, appId) => {
      await request("DELETE", applianceAppPath(id, appId));
    },
    readNowShowing: async (id) => (await (await request("GET", applianceNowShowingPath(id))).json()) as NowShowing,
    readDeviceInfo: async (id) =>
      (await (await request("GET", applianceDeviceInfoPath(id))).json()) as ApplianceDeviceInfo,
    playerAction: async (id, action, onStep) => {
      const body: PlayerActionRequest = { action };
      const response = await request("POST", appliancePlayerActionPath(id), body);
      await followSteps(response, PLAYER_ACTION_STEPS, onStep, "done", PLAYER_ACTION_CUT_OFF);
    },
    play: async (id, body, onStep) => {
      await followSteps(await request("POST", appliancePlayPath(id), body), PLAY_STEPS, onStep, "sent", PLAY_CUT_OFF);
    },
    readPlayback: async (id) =>
      ((await (await request("GET", appliancePlaybackPath(id))).json()) as AppliancePlayback).nowPlaying,
    controlPlayback: async (id, control) =>
      ((await (await request("POST", appliancePlaybackPath(id), control)).json()) as AppliancePlayback).nowPlaying,
    controlQueue: async (id, control) =>
      ((await (await request("POST", applianceQueuePath(id), control)).json()) as AppliancePlayback).nowPlaying,
    readAirConditionerCapabilities: async (id) =>
      (await (await request("GET", applianceCapabilitiesPath(id))).json()) as AirConditionerCapabilitiesReading,
    readAirConditioner: async (id) =>
      (await (await request("GET", applianceStatePath(id))).json()) as AirConditionerReading,
    changeAirConditioner: async (id, change) =>
      (await (await request("PATCH", applianceStatePath(id), change)).json()) as AirConditionerReading,
    readLightCapabilities: async (id) =>
      (await (await request("GET", applianceCapabilitiesPath(id))).json()) as LightCapabilitiesReading,
    readLight: async (id) => (await (await request("GET", applianceStatePath(id))).json()) as LightReading,
    changeLight: async (id, change) =>
      (await (await request("PATCH", applianceStatePath(id), change)).json()) as LightReading,
    changeLights: async (roomId, change) => {
      const body: LightsChangeRequest = { change, ...(roomId === undefined ? {} : { roomId }) };
      return (await (await request("POST", LIGHTS_PATH, body)).json()) as LightsOutcome;
    },
    lightScenes: async () => (await (await request("GET", LIGHT_SCENES_PATH)).json()) as LightScene[],
    saveLightScene: async (roomId, name) =>
      (await (await request("POST", LIGHT_SCENES_PATH, { roomId, name })).json()) as LightSceneSaved,
    renameLightScene: async (id, name) =>
      (await (await request("PATCH", lightScenePath(id), { name })).json()) as LightScene,
    deleteLightScene: async (id) => {
      await request("DELETE", lightScenePath(id));
    },
    recallLightScene: async (id) => (await (await request("POST", lightSceneRecallPath(id))).json()) as LightsOutcome,
    readHive: async () => (await (await request("GET", HIVE_PATH)).json()) as HiveAccount,
    signInToHive: async (login) =>
      (await (await request("POST", HIVE_SIGN_IN_PATH, login)).json()) as HiveSignInOutcome,
    enterHiveCode: async (code) => {
      const body: HiveCodeRequest = { code };
      return (await (await request("POST", HIVE_CODE_PATH, body)).json()) as HiveSignedIn;
    },
    signOutOfHive: async () => {
      await request("DELETE", HIVE_PATH);
    },
    readHeating: async () => (await (await request("GET", HEATING_PATH)).json()) as HeatingHome,
    changeHeating: async (id, change) =>
      (await (await request("POST", heatingPath(id), change)).json()) as HeatingOutcome,
    changeWholeHome: async (change) =>
      (await (await request("POST", WHOLE_HOME_PATH, change)).json()) as HeatingOutcome,
    setRoomTarget: async (roomId, target) =>
      (await (await request("POST", roomTargetPath(roomId), { target })).json()) as HeatingOutcome,
  };
};
