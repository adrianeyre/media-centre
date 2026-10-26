import type {
  AirConditionerCapabilities,
  AirConditionerChange,
  AirConditionerReading,
  AirConditionerState,
  Appliance,
  ApplianceApp,
  ApplianceApps,
  ApplianceDeviceInfo,
  ApplianceKind,
  ApplianceVolume,
  CloudLogin,
  FoundAirConditioner,
  FoundAppliance,
  FoundLight,
  HeatingCapabilities,
  HeatingChange,
  HeatingOutcome,
  HeatingReading,
  HeatingReport,
  HeatingState,
  HiveSignedIn,
  HotWaterChange,
  HotWaterState,
  LightCapabilities,
  LightChange,
  LightKeysGiven,
  LightReading,
  LightScene,
  LightsChange,
  LightState,
  MenuShortcut,
  NowPlaying,
  NowShowing,
  PlaybackControl,
  PlayerAction,
  PlayerActionStep,
  PlayFolderRequest,
  PlayRequest,
  PlayStep,
  QueueControl,
  PowerState,
  RadiatorValveState,
  RemoteKey,
  VolumeChange,
} from "@media-centre/shared";

import type { AppliancesApi } from "../appliances-api.ts";
import { HubRequestFailed } from "../hub-request.ts";

export interface FakeAppliancesApi extends AppliancesApi {
  /** The Appliances the fake Hub has now. */
  readonly current: () => readonly Appliance[];
  /** Makes the next change fail with `message`, as the Hub refusing it would. */
  readonly refuseNext: (message: string) => void;
  /** Makes the TV refuse the Hub from now on, as revoking access on the TV would. */
  readonly revoke: (id: number) => void;
  /**
   * Makes the next pairing wait, as the TV does for the person to choose
   * Allow, until the returned function is called.
   */
  readonly holdPairing: () => () => void;
  /** The ids of the Appliances the Hub was asked to connect to, oldest first. */
  readonly connected: readonly number[];
  /**
   * Every login the Hub was sent to fetch an Air Conditioner's token and key
   * with, oldest first, with the Appliance's id when it was fetched again.
   * The fake cloud takes only {@link FAKE_CLOUD_LOGIN}.
   */
  readonly logins: readonly { readonly id?: number; readonly login: CloudLogin }[];
  /**
   * Makes the next search wait, as the Hub does while TVs answer, until the
   * returned function is called.
   */
  readonly holdSearch: () => () => void;
  /** How many times the Hub was asked to search. */
  readonly searches: () => number;
  /** Has the TV say it is in this power state from now on. Every TV is on until told otherwise. */
  readonly setPower: (id: number, power: PowerState) => void;
  /** The ids of the Appliances whose power state was read, oldest first. */
  readonly powerReads: readonly number[];
  /**
   * The ids of the Appliances the Power button switched, oldest first. Each
   * switches at once, on to off or off to on, as the fake TV does, unless
   * {@link holdPowerChange} says otherwise.
   */
  readonly powerSwitches: readonly number[];
  /**
   * Makes switches leave the power state as it was, as a TV slow to wake
   * would, until the returned function is called, which makes the change
   * then. The Hub still answers at once.
   */
  readonly holdPowerChange: () => () => void;
  /** Makes the next switch wait before the Hub answers, as holding a Frame's power key does, until the returned function is called. */
  readonly holdNextPowerSwitch: () => () => void;
  /** Every key the Hub pressed, oldest first, once it has. */
  readonly keysPressed: readonly { readonly id: number; readonly key: RemoteKey }[];
  /** Makes the next key press fail with `message`, as the Hub refusing it would, e.g. a key the Driver never sends. */
  readonly refuseNextKey: (message: string) => void;
  /** Makes the next key press wait, as one to a TV slow to answer would, until the returned function is called. */
  readonly holdNextKey: () => () => void;
  /** Every shortcut the Hub pressed, oldest first, once it has sent its key. */
  readonly shortcutsPressed: readonly { readonly id: number; readonly shortcut: MenuShortcut }[];
  /**
   * Has the TV say it ignored these shortcuts' keys from now on, as a model
   * without them that says so would. Every other it says nothing of.
   */
  readonly ignoreShortcuts: (id: number, shortcuts: readonly MenuShortcut[]) => void;
  /** Makes the next shortcut fail with `message`, as the Hub refusing it would. */
  readonly refuseNextShortcut: (message: string) => void;
  /**
   * Makes the next shortcut's outcome wait, as the Hub does while it listens
   * for the TV, until the returned function is called. Its key is sent at once.
   */
  readonly holdNextShortcutOutcome: () => () => void;
  /**
   * Has the TV say this is its volume from now on, as its own remote would
   * change it, or `{ known: false }` as one in standby. Every TV is at 11, not
   * muted, until told otherwise. Its volume keys turn a known volume up and
   * down by one, as the fake TV's do.
   */
  readonly setVolume: (id: number, volume: ApplianceVolume) => void;
  /** The ids of the Appliances whose volume was read, oldest first. */
  readonly volumeReads: readonly number[];
  /** Every volume change the Hub made, oldest first, once it has. */
  readonly volumeChanges: readonly { readonly id: number; readonly change: VolumeChange }[];
  /** Makes the next volume change wait before the Hub makes it, as one to a TV slow to answer would, until the returned function is called. */
  readonly holdNextVolumeChange: () => () => void;
  /**
   * Has the TV say its on-screen keyboard is open or closed from now on, as
   * choosing a search box on it would. Every TV's is closed until told
   * otherwise, and text typed into it closes it, as the fake TV's does.
   */
  readonly setKeyboard: (id: number, open: boolean) => void;
  /** The ids of the Appliances whose keyboard was read, oldest first. */
  readonly keyboardReads: readonly number[];
  /** Every text the Hub typed, oldest first, once it has. */
  readonly textsEntered: readonly { readonly id: number; readonly text: string }[];
  /** Makes the next text fail with `message`, as the Hub refusing it would. */
  readonly refuseNextText: (message: string) => void;
  /** Makes the next text wait before the Hub types it, as one to a TV slow to answer would, until the returned function is called. */
  readonly holdNextText: () => () => void;
  /**
   * Has the TV say these are its apps from now on, or `{ known: false, … }`
   * as one in standby or unreachable. Every TV has {@link FAKE_TV_APPS} until
   * told otherwise.
   */
  readonly setApps: (id: number, apps: ApplianceApps) => void;
  /** The ids of the Appliances whose apps were listed, oldest first. */
  readonly appsReads: readonly number[];
  /** Every app the Hub launched or closed, oldest first, once it has. */
  readonly appsDone: readonly { readonly id: number; readonly appId: string; readonly what: "launch" | "close" }[];
  /** Makes the next launch or close fail with `message`, as the Hub refusing it would. */
  readonly refuseNextApp: (message: string) => void;
  /** Makes the next launch or close wait before the Hub does it, until the returned function is called. */
  readonly holdNextApp: () => () => void;
  /**
   * Has the TV say this is what it is showing from now on, as launching an
   * app with its own remote would. Every TV says it can't tell until told
   * otherwise, or until an app is launched on it, which comes to the front.
   */
  readonly setNowShowing: (id: number, nowShowing: NowShowing) => void;
  /** The ids of the Appliances whose Now Showing was read, oldest first. */
  readonly nowShowingReads: readonly number[];
  /**
   * Has the TV report this about itself from now on, or `{ known: false, … }`
   * as one that can't be reached. Every TV reports {@link aTvDeviceInfo}
   * until told otherwise.
   */
  readonly setDeviceInfo: (id: number, deviceInfo: ApplianceDeviceInfo) => void;
  /** The ids of the Appliances whose device info was read, oldest first. */
  readonly deviceInfoReads: readonly number[];
  /** Everything the Hub was asked to do with the Player, and on which TV, oldest first. */
  readonly playerActions: readonly { readonly id: number; readonly action: PlayerAction }[];
  /**
   * Makes the next Player action wait at each step, as the Hub does while
   * the TV signs and installs it, until the test moves it on with the
   * returned controls. Otherwise each goes through every step at once.
   */
  readonly holdNextPlayerAction: () => HeldPlayerAction;
  /** Makes the next Player action be refused before it starts, as the Hub refusing it would. */
  readonly refuseNextPlayerAction: (message: string) => void;
  /** Every Media File the Hub was asked to play, and on which TV, oldest first. */
  readonly plays: readonly { readonly id: number; readonly request: PlayRequest | PlayFolderRequest }[];
  /**
   * Makes the next play wait at each step, as the Hub does while a TV wakes
   * and its Player connects, until the test moves it on with the returned
   * controls. Otherwise each play goes through every step at once, waking a
   * TV that isn't on first, which comes on.
   */
  readonly holdNextPlay: () => HeldPlay;
  /** Makes the next play be refused before it starts, as the Hub refusing it would. */
  readonly refuseNextPlay: (message: string) => void;
  /**
   * Has the Player on the TV say it is playing this from now on, or nothing
   * with null, as it would as it plays or as its own remote controls it.
   * Every TV plays nothing until told otherwise.
   */
  readonly setNowPlaying: (id: number, nowPlaying: NowPlaying | null) => void;
  /** The ids of the Appliances whose playback was read, oldest first. */
  readonly playbackReads: readonly number[];
  /**
   * Every control the Hub sent a Player, oldest first, once it has. Each
   * changes what is playing as the Player would: a seek or skip stops at
   * either end, and stop leaves nothing playing.
   */
  readonly playbackControls: readonly { readonly id: number; readonly control: PlaybackControl }[];
  /**
   * Every control of a Queue the Hub was sent, oldest first, once it has.
   * Each changes the Queue as the Hub would: next and previous move to the
   * Media File after or before, from its start, named as the Queue names
   * it, refused past either end unless it repeats all; shuffle reverses the
   * rest of the Queue, and unshuffling puts it back in name order.
   */
  readonly queueControls: readonly { readonly id: number; readonly control: QueueControl }[];
  /** Makes the next control, of playback or of a Queue, fail with `message`, as the Hub refusing it would. */
  readonly refuseNextControl: (message: string) => void;
  /** Makes the next control wait, as one the Player is slow to report would, until the returned function is called. */
  readonly holdNextControl: () => () => void;
  /**
   * Has the Air Conditioner report these controls from now on. Every one
   * reports {@link FULL_AIRCON_CAPABILITIES} until told otherwise.
   */
  readonly setAirConditionerCapabilities: (id: number, capabilities: AirConditionerCapabilities) => void;
  /**
   * Has the Air Conditioner say this from now on, as its own remote, or the
   * weather, would change it. Every one says {@link anAirConditionerState}
   * until told otherwise.
   */
  readonly setAirConditionerState: (id: number, change: Partial<AirConditionerState>) => void;
  /**
   * Has the Air Conditioner answer, or not, from now on, `why` it can't say
   * what it is doing: "unreachable", as one switched off at the wall, or
   * "fetch-again", as one that refuses the Hub's token and key; null answers
   * again. While it doesn't, changes to it are refused.
   */
  readonly setAirConditionerAnswering: (id: number, why: "unreachable" | "fetch-again" | null) => void;
  /** The ids of the Air Conditioners whose capabilities were read, oldest first. */
  readonly capabilitiesReads: readonly number[];
  /** The ids of the Air Conditioners whose state was read, oldest first. */
  readonly airConditionerReads: readonly number[];
  /**
   * Every change the Hub made to an Air Conditioner, oldest first, once it
   * has. Each changes its state as the Midea Driver would: a mode whose range
   * the target temperature is outside of takes the nearest it has.
   */
  readonly airConditionerChanges: readonly { readonly id: number; readonly change: AirConditionerChange }[];
  /** Makes the next change to an Air Conditioner fail with `message`, as the Hub refusing it would. */
  readonly refuseNextAirConditionerChange: (message: string) => void;
  /** Makes the next change to an Air Conditioner wait before the Hub makes it, until the returned function is called. */
  readonly holdNextAirConditionerChange: () => () => void;
  /** Every id and key the Hub was sent to add a Light with, oldest first, as the Remote sent them. */
  readonly lightKeys: readonly LightKeysGiven[];
  /**
   * Has the Light report these controls from now on. Every one reports
   * {@link COLOUR_LIGHT_CAPABILITIES} until told otherwise.
   */
  readonly setLightCapabilities: (id: number, capabilities: LightCapabilities) => void;
  /** Has the Light say this from now on, as its maker's app would change it. Every one says {@link aLightState} until told otherwise. */
  readonly setLightState: (id: number, change: Partial<LightState>) => void;
  /**
   * Has the Light answer, or not, from now on, `why` it can't say what it is
   * doing: "unreachable", as one switched off at the wall, or
   * "key-refused"; null answers again. While it doesn't, changes to it are
   * refused, and a Room-wide change or All off says it didn't answer.
   */
  readonly setLightAnswering: (id: number, why: "unreachable" | "key-refused" | null) => void;
  /** The ids of the Lights whose state was read, oldest first. */
  readonly lightReads: readonly number[];
  /** Every change the Hub made to one Light, oldest first, once it has. */
  readonly lightChanges: readonly { readonly id: number; readonly change: LightChange }[];
  /** Every Room-wide change and All off the Hub was asked for, oldest first, with no Room for All off. */
  readonly lightsChanges: readonly { readonly roomId: number | undefined; readonly change: LightsChange }[];
  /** Makes the next change to a Light, or Room-wide or All off, fail with `message`, as the Hub refusing it would. */
  readonly refuseNextLightChange: (message: string) => void;
  /** Makes the next change to a Light, or Room-wide or All off, wait before the Hub makes it, until the returned function is called. */
  readonly holdNextLightChange: () => () => void;
  /** The ids of the Light Scenes recalled, oldest first. */
  readonly lightSceneRecalls: readonly number[];
  /** Makes the next save, rename, delete or recall of a Light Scene fail with `message`, as the Hub refusing it would. */
  readonly refuseNextLightScene: (message: string) => void;
  /** Makes the next save, rename, delete or recall of a Light Scene wait, until the returned function is called. */
  readonly holdNextLightScene: () => () => void;
  /**
   * Has Hive say this of the Hub's tokens from now on, as Hive refusing
   * them now and then, or its cloud out of reach, would: "accepted",
   * "refused" or "unreachable", which also refuses signing in.
   */
  readonly setHiveTokens: (tokens: "accepted" | "refused" | "unreachable") => void;
  /**
   * Whether Hive asks for {@link FAKE_HIVE_CODE} as the Hub next signs in.
   * It does until the Hub has given it once, as the device Hive trusts from
   * then on.
   */
  readonly askHiveCode: (ask: boolean) => void;
  /** Every login and code the Hub was sent to sign in to Hive with, oldest first. */
  readonly hiveSignIns: readonly ({ readonly login: CloudLogin } | { readonly code: string })[];
  /** How many times the Hub was asked whether it is signed in to Hive. */
  readonly hiveReads: () => number;
  /** Makes the next sign-in to Hive, or code, wait before the Hub answers, until the returned function is called. */
  readonly holdNextHiveSignIn: () => () => void;
  /**
   * Has Hive report this of the Heating, Radiator Valve or Hot Water from
   * now on, as Hive's app, or the weather, would change it. Each reports
   * {@link aHeatingState}, {@link aRadiatorValveState} or
   * {@link aHotWaterState} until told otherwise.
   */
  readonly setHeatingState: (id: number, state: Partial<RadiatorValveState> | Partial<HotWaterState>) => void;
  /** Whether Hive refuses every change to this one from now on, as Hive refuses a change it won't take. */
  readonly refuseHeatingChanges: (id: number, refuse: boolean) => void;
  /** How many times the Hub was asked to read Hive for the Heating tab. */
  readonly heatingReads: () => number;
  /** Every change the Hub was asked to make, oldest first: to one by its id, the Whole home, or a Room's Radiator Valves. */
  readonly heatingChanges: readonly {
    readonly to: number | "whole-home" | { readonly roomId: number };
    readonly change: HeatingChange | HotWaterChange;
  }[];
  /** Makes the next change wait before the Hub makes it, until the returned function is called. */
  readonly holdNextHeatingChange: () => () => void;
}

/** A held play once it has started, for the test's controls to move on. */
interface StartedPlay {
  readonly onStep: (step: PlayStep) => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** A play the test moves on, step by step, as the Hub would. */
export interface HeldPlay {
  /** As the Hub starting this step. */
  readonly step: (step: PlayStep) => void;
  /** As the Hub having sent the Player the Media File. */
  readonly sent: () => void;
  /** As a step failing, with why. */
  readonly fail: (message: string) => void;
}

/** A held Player action once it has started, for the test's controls to move on. */
interface StartedPlayerAction {
  readonly onStep: (step: PlayerActionStep) => void;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** A Player action the test moves on, step by step, as the Hub would. */
export interface HeldPlayerAction {
  /** As the Hub starting this step. */
  readonly step: (step: PlayerActionStep) => void;
  /** As the Hub having done it. */
  readonly done: () => void;
  /** As a step failing, with why. */
  readonly fail: (message: string) => void;
}

/** The steps the Hub goes through for each Player action, in order. */
const PLAYER_ACTION_STEPS: Readonly<Record<PlayerAction, readonly PlayerActionStep[]>> = {
  install: ["connecting", "signing", "installing"],
  launch: ["connecting", "launching"],
  uninstall: ["connecting", "uninstalling"],
};

/** The apps every fake TV has until told otherwise: two with icons, one without. */
export const FAKE_TV_APPS: readonly ApplianceApp[] = [
  { id: "org.tizen.browser", name: "Internet", icon: false },
  { id: "3201907018807", name: "Netflix", icon: true },
  { id: "111299001912", name: "YouTube", icon: true },
];

/** A TV as the Hub would say it found it, with {@link aTv}'s address and MAC address for the same `id`. */
export const aFoundTv = (id: number, name: string): FoundAppliance => {
  const { kind, address, model, macAddress } = aTv(id, name, null);
  return { kind, address, name, model, macAddress };
};

/**
 * What a TV reports about itself unless told otherwise: what {@link aTv} says
 * of it, on Wi-Fi, not a Frame, with Developer Mode off and no Developer IP.
 */
export const aTvDeviceInfo = (tv: Appliance): Extract<ApplianceDeviceInfo, { known: true }> => ({
  known: true,
  info: {
    name: `[TV] ${tv.name}`,
    model: tv.model,
    macAddress: tv.macAddress,
    networkType: "wireless",
    frame: false,
    developer: { mode: "off", ip: null },
  },
});

/** The only login the fake Hub's cloud takes, to fetch an Air Conditioner's token and key. */
export const FAKE_CLOUD_LOGIN: CloudLogin = { account: "owner@example.com", password: "correct horse battery staple" };

/** What the Hub says when its maker's cloud refuses the login. */
export const FAKE_CLOUD_REFUSAL =
  "Neither MSmartHome nor Midea Air accepted that email and password. Check them, as you sign in to the app the Air Conditioner is set up in, then try again.";

/** The code the fake Hub's Hive asks for, as Hive texts one. Its login is {@link FAKE_CLOUD_LOGIN}. */
export const FAKE_HIVE_CODE = "246810";

/** What the Hub says when Hive refuses the login. */
export const FAKE_HIVE_REFUSAL = "Hive refused the email or password. Use the Hive account owner's.";

/** What the Hub says when Hive refuses the code. */
export const FAKE_HIVE_WRONG_CODE = "That isn't the code Hive sent. Try it again.";

/** What the Hub says when it can't reach Hive. */
export const FAKE_HIVE_UNREACHABLE = "Can't reach Hive. Check that the Hub is connected to the internet.";

/** A Heating, a Radiator Valve or the Hot Water as the Hub would answer with it, with Hive's id for it. */
export const aHiveAppliance = (
  id: number,
  kind: "heating" | "radiator-valve" | "hot-water",
  name: string,
  roomId: number | null = null,
): Appliance => ({
  id,
  kind,
  name,
  roomId,
  address: "",
  model: { heating: "Hive Heating", "radiator-valve": "Hive Radiator Valve", "hot-water": "Hive Hot Water" }[kind],
  macAddress: "",
  serialNumber: `${kind}-${name.toLowerCase()}`,
  pairing: "paired",
});

/** The Heating zones, Radiator Valves and Hot Water on the fake Hub's Hive account, by Hive's names. */
export const FAKE_HIVE_HOME: readonly Pick<Appliance, "kind" | "name">[] = [
  { kind: "heating", name: "Downstairs" },
  { kind: "heating", name: "Upstairs" },
  { kind: "radiator-valve", name: "Bedroom" },
  { kind: "radiator-valve", name: "Study" },
  { kind: "hot-water", name: "Hot Water" },
];

const HIVE_KINDS: readonly ApplianceKind[] = ["heating", "radiator-valve", "hot-water"];

/** The Boosts Hive's app offers, in minutes, as the Hive Driver reports them. */
export const FAKE_BOOST_MINUTES: readonly number[] = [15, 30, 45, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360];

/** The controls every one of the fake Hub's Heatings and Radiator Valves has. */
export const FAKE_HEATING_CAPABILITIES: HeatingCapabilities = {
  modes: ["schedule", "manual", "off"],
  target: { min: 5, max: 32, step: 0.5 },
  boostMinutes: FAKE_BOOST_MINUTES,
};

/** A Heating as Hive reports it unless told otherwise: following its schedule at 20°, reading 19.5°. */
export const aHeatingState = (more: Partial<HeatingState> = {}): HeatingState => ({
  mode: "schedule",
  target: 20,
  boost: null,
  temperature: 19.5,
  callingForHeat: false,
  online: true,
  ...more,
});

/** A Radiator Valve as Hive reports it unless told otherwise: as {@link aHeatingState}, in the Upstairs zone. */
export const aRadiatorValveState = (more: Partial<RadiatorValveState> = {}): RadiatorValveState => ({
  ...aHeatingState(),
  lowBattery: false,
  zone: { id: "heating-upstairs", name: "Upstairs" },
  ...more,
});

/** The Hot Water as Hive reports it unless told otherwise: following its schedule, not heating. */
export const aHotWaterState = (more: Partial<HotWaterState> = {}): HotWaterState => ({
  mode: "schedule",
  boost: null,
  on: false,
  online: true,
  ...more,
});

/** What the Hub says when it needs the login, as for adding an Air Conditioner on Midea's protocol v3. */
export const FAKE_LOGIN_NEEDED =
  "This Air Conditioner answers only once the Hub has its token and key. Sign in once, so that the Hub can fetch them from its maker's cloud.";

/** An Air Conditioner as the Hub would answer with it, on Midea's protocol v3 unless told otherwise. */
export const anAirConditioner = (
  id: number,
  name: string,
  roomId: number | null,
  more: Partial<Appliance> = {},
): Appliance => ({
  id,
  kind: "air-conditioner",
  name,
  roomId,
  address: `192.168.1.${String(40 + id)}`,
  model: "Midea, protocol v3",
  macAddress: "",
  serialNumber: `000000P0000000Q1F0C9A1B2C3${String(id).padStart(2, "0")}0000`,
  pairing: "paired",
  ...more,
});

/** An Air Conditioner as "Find Air Conditioners" would find it, needing the login unless told otherwise. */
export const aFoundAirConditioner = (id: number, name: string, needsLogin = true): FoundAirConditioner => {
  const { address, serialNumber = "" } = anAirConditioner(id, name, null);
  return { kind: "air-conditioner", address, name, serialNumber, needsLogin };
};

/**
 * Every control an Air Conditioner can report, as the Midea Driver reads a
 * unit that has them all: each mode, with half degrees, each fan step and
 * auto, both swings, every preset, the display, both temperatures, and a
 * further function of each kind.
 */
export const FULL_AIRCON_CAPABILITIES: AirConditionerCapabilities = {
  power: true,
  modes: [
    { mode: "cool", temperature: { min: 16, max: 30, step: 0.5 } },
    { mode: "heat", temperature: { min: 17, max: 31, step: 0.5 } },
    { mode: "dry", temperature: { min: 16, max: 30, step: 0.5 } },
    { mode: "fan", temperature: null },
    { mode: "auto", temperature: { min: 18, max: 28, step: 0.5 } },
  ],
  fan: { speeds: ["silent", "low", "medium", "high", "full"], auto: true },
  swing: { vertical: true, horizontal: true },
  presets: ["eco", "turbo", "sleep"],
  display: true,
  temperatures: { room: true, outdoor: true },
  functions: [
    { id: "self-clean", name: "Self-clean", kind: "on-off" },
    {
      id: "breeze",
      name: "Breeze",
      kind: "choice",
      options: [
        { id: "off", name: "Off" },
        { id: "away", name: "Breeze away" },
        { id: "mild", name: "Breeze mild" },
      ],
    },
  ],
};

/** What an Air Conditioner says it is doing until told otherwise: off, set to cool at 22°, in a room at 24.5°. */
export const anAirConditionerState = (more: Partial<AirConditionerState> = {}): AirConditionerState => ({
  power: false,
  mode: "cool",
  targetTemperature: 22,
  fanSpeed: "auto",
  swing: { vertical: false, horizontal: false },
  preset: null,
  display: true,
  roomTemperature: 24.5,
  outdoorTemperature: 12,
  functions: { "self-clean": false, breeze: "off" },
  ...more,
});

/** A Light as the Hub would answer with it. */
export const aLight = (id: number, name: string, roomId: number | null, more: Partial<Appliance> = {}): Appliance => ({
  id,
  kind: "light",
  name,
  roomId,
  address: `192.168.1.${String(60 + id)}`,
  model: "Lepro, protocol v3.3",
  macAddress: "",
  pairing: "paired",
  ...more,
});

/** A Light as "Find Lights" would find it, at the address {@link aLight} gives one with this id. */
export const aFoundLight = (id: number, applianceId: number | null = null): FoundLight => ({
  kind: "light",
  address: aLight(id, "", null).address,
  name: "Lepro Light",
  model: "Lepro, protocol v3.3",
  applianceId,
});

/** The only key the fake Hub's Lights answer to, made up for the tests: no real Light's. */
export const FAKE_LIGHT_KEY = "k3y!for~a+fake/L";

/** What the Hub says of a key a Light doesn't answer to. */
export const FAKE_LIGHT_KEY_REFUSAL =
  "The Light didn't answer to that device id and local key. Check each, as they were read from the Light.";

/** A colour bulb's controls: on/off, brightness, colour temperature and colour. */
export const COLOUR_LIGHT_CAPABILITIES: LightCapabilities = {
  onOff: true,
  brightness: true,
  colourTemperature: { min: 2_700, max: 6_500 },
  colour: true,
};

/** A smart plug's: on/off alone. */
export const PLUG_CAPABILITIES: LightCapabilities = {
  onOff: true,
  brightness: false,
  colourTemperature: null,
  colour: false,
};

/** What a Light says it is doing until told otherwise: on, white at 4,600 K, at its brightest. */
export const aLightState = (more: Partial<LightState> = {}): LightState => ({
  on: true,
  brightness: 100,
  colourTemperature: 4_600,
  colour: null,
  ...more,
});

/** A TV as the Hub would answer with it. */
export const aTv = (id: number, name: string, roomId: number | null, more: Partial<Appliance> = {}): Appliance => ({
  id,
  kind: "tv",
  name,
  roomId,
  address: `192.168.1.${String(20 + id)}`,
  model: "QE55Q60TAUXXU",
  macAddress: `02:00:00:00:00:${String(id).padStart(2, "0")}`,
  pairing: "paired",
  ...more,
});

/**
 * Appliances kept in memory, standing in for the Hub. It makes whatever change
 * it is asked to: the rules are the Hub's, and are tested there.
 */
export const fakeAppliancesApi = (
  initial: readonly Appliance[] = [],
  /** What a search finds, whether or not it is already added. */
  found: readonly FoundAppliance[] = [],
  /** What "Find Air Conditioners" finds, likewise. Adding one of these that needs the login asks for it. */
  foundAirConditioners: readonly FoundAirConditioner[] = [],
  /** What "Find Lights" finds; each says which Light it is by the address it has. */
  foundLights: readonly FoundLight[] = [],
): FakeAppliancesApi => {
  let appliances = [...initial];
  let searchHold: Promise<void> | undefined;
  let searches = 0;
  let nextId = Math.max(0, ...appliances.map(({ id }) => id)) + 1;
  let refusal: string | undefined;
  let hold: Promise<void> | undefined;
  const revoked = new Set<number>();
  const connected: number[] = [];
  const logins: { id?: number; login: CloudLogin }[] = [];
  const powers = new Map<number, PowerState>();
  const powerReads: number[] = [];
  const keysPressed: { id: number; key: RemoteKey }[] = [];
  let keyRefusal: string | undefined;
  let keyHold: Promise<void> | undefined;
  const shortcutsPressed: { id: number; shortcut: MenuShortcut }[] = [];
  const ignoredShortcuts = new Map<number, ReadonlySet<MenuShortcut>>();
  let shortcutRefusal: string | undefined;
  let outcomeHold: Promise<void> | undefined;
  const powerSwitches: number[] = [];
  let powerChangeHeld = false;
  /** The change a held switch has yet to make. */
  let heldChange: (() => void) | undefined;
  let switchHold: Promise<void> | undefined;
  const volumes = new Map<number, ApplianceVolume>();
  const volumeReads: number[] = [];
  const volumeChanges: { id: number; change: VolumeChange }[] = [];
  let volumeHold: Promise<void> | undefined;
  const keyboards = new Set<number>();
  const keyboardReads: number[] = [];
  const textsEntered: { id: number; text: string }[] = [];
  let textRefusal: string | undefined;
  let textHold: Promise<void> | undefined;
  const appLists = new Map<number, ApplianceApps>();
  const appsReads: number[] = [];
  const appsDone: { id: number; appId: string; what: "launch" | "close" }[] = [];
  let appRefusal: string | undefined;
  let appHold: Promise<void> | undefined;
  const showing = new Map<number, NowShowing>();
  const nowShowingReads: number[] = [];
  const deviceInfos = new Map<number, ApplianceDeviceInfo>();
  const deviceInfoReads: number[] = [];
  const playerActions: { id: number; action: PlayerAction }[] = [];
  let playerActionRefusal: string | undefined;
  /** Starts the held Player action, if there is one. */
  let playerActionHold: ((action: StartedPlayerAction) => void) | undefined;
  const plays: { id: number; request: PlayRequest | PlayFolderRequest }[] = [];
  const queueControls: { id: number; control: QueueControl }[] = [];
  let playRefusal: string | undefined;
  /** Starts the held play, if there is one. */
  let playHold: ((play: StartedPlay) => void) | undefined;
  const nowPlaying = new Map<number, NowPlaying>();
  const playbackReads: number[] = [];
  const playbackControls: { id: number; control: PlaybackControl }[] = [];
  let controlRefusal: string | undefined;
  let controlHold: Promise<void> | undefined;
  const volumeOf = (id: number): ApplianceVolume => volumes.get(id) ?? { known: true, volume: 11, muted: false };
  const airConditionerCapabilities = new Map<number, AirConditionerCapabilities>();
  const airConditionerStates = new Map<number, AirConditionerState>();
  const notAnswering = new Map<number, "unreachable" | "fetch-again">();
  const capabilitiesReads: number[] = [];
  const airConditionerReads: number[] = [];
  const airConditionerChanges: { id: number; change: AirConditionerChange }[] = [];
  let airConditionerRefusal: string | undefined;
  let airConditionerHold: Promise<void> | undefined;
  const capabilitiesOf = (id: number): AirConditionerCapabilities =>
    airConditionerCapabilities.get(id) ?? FULL_AIRCON_CAPABILITIES;
  const airConditionerStateOf = (id: number): AirConditionerState =>
    airConditionerStates.get(id) ?? anAirConditionerState();
  const lightKeys: LightKeysGiven[] = [];
  const lightCapabilities = new Map<number, LightCapabilities>();
  const lightStates = new Map<number, LightState>();
  const lightsNotAnswering = new Map<number, "unreachable" | "key-refused">();
  const lightReads: number[] = [];
  const lightChanges: { id: number; change: LightChange }[] = [];
  const lightsChanges: { roomId: number | undefined; change: LightsChange }[] = [];
  let lightRefusal: string | undefined;
  let lightHold: Promise<void> | undefined;
  let lightScenes: LightScene[] = [];
  let nextLightSceneId = 1;
  const lightSceneRecalls: number[] = [];
  let lightSceneRefusal: string | undefined;
  let lightSceneHold: Promise<void> | undefined;
  let hiveSignedIn = appliances.some(({ kind }) => HIVE_KINDS.includes(kind));
  let hiveTokens: "accepted" | "refused" | "unreachable" = "accepted";
  let hiveAsksCode = true;
  let hiveCodePending = false;
  let hiveReads = 0;
  const hiveSignIns: ({ login: CloudLogin } | { code: string })[] = [];
  let hiveHold: Promise<void> | undefined;
  const heatingStates = new Map<number, HeatingState | RadiatorValveState | HotWaterState>();
  /** The mode and target each Boost goes back to. */
  const beforeBoost = new Map<number, { mode: string; target: number }>();
  const refusingHeating = new Set<number>();
  let heatingReads = 0;
  const heatingChanges: {
    to: number | "whole-home" | { roomId: number };
    change: HeatingChange | HotWaterChange;
  }[] = [];
  let heatingHold: Promise<void> | undefined;
  const heatingStateOf = (appliance: Appliance): HeatingState | RadiatorValveState | HotWaterState =>
    heatingStates.get(appliance.id) ??
    (appliance.kind === "hot-water"
      ? aHotWaterState()
      : appliance.kind === "radiator-valve"
        ? aRadiatorValveState()
        : aHeatingState());
  const heatingReport = (appliance: Appliance): HeatingReport => {
    const state = heatingStateOf(appliance);
    return appliance.kind === "hot-water"
      ? { kind: "hot-water", id: appliance.id, state: state as HotWaterState }
      : appliance.kind === "radiator-valve"
        ? { kind: "radiator-valve", id: appliance.id, state: state as RadiatorValveState }
        : { kind: "heating", id: appliance.id, state: state as HeatingState };
  };
  /** Makes one change as Hive would, unless it refuses it. */
  const changeHeatingOne = (appliance: Appliance, change: HeatingChange | HotWaterChange): boolean => {
    if (refusingHeating.has(appliance.id)) return false;
    const state = heatingStateOf(appliance) as RadiatorValveState & HotWaterState;
    const before = beforeBoost.get(appliance.id);
    let next: HeatingState | RadiatorValveState | HotWaterState;
    if ("target" in change) next = { ...state, target: change.target };
    else if ("mode" in change) next = { ...state, mode: change.mode, boost: null };
    else if (change.boost === null) {
      next = {
        ...state,
        boost: null,
        ...(before === undefined || !("target" in state) ? {} : { target: before.target }),
      };
    } else {
      if (state.boost === null && "target" in state)
        beforeBoost.set(appliance.id, { mode: state.mode, target: state.target });
      next =
        "target" in change.boost
          ? {
              ...state,
              target: change.boost.target,
              boost: { target: change.boost.target, minutesLeft: change.boost.minutes },
            }
          : { ...state, boost: { minutesLeft: change.boost.minutes } };
    }
    heatingStates.set(appliance.id, next);
    return true;
  };
  /** Makes the change of each at once, and answers as the Hub would, naming those Hive refused it for. */
  const changeHeatingEach = async (
    to: number | "whole-home" | { roomId: number },
    targets: readonly Appliance[],
    change: HeatingChange | HotWaterChange,
  ): Promise<HeatingOutcome> => {
    heatingChanges.push({ to, change });
    const waitFor = heatingHold;
    heatingHold = undefined;
    await waitFor;
    await Promise.resolve();
    if (!hiveSignedIn) throw new HubRequestFailed("The Hub isn't signed in to Hive. Sign in in Settings.");
    if (hiveTokens === "unreachable") throw new HubRequestFailed(FAKE_HIVE_UNREACHABLE);
    if (hiveTokens === "refused") {
      throw new HubRequestFailed("Hive no longer accepts the Hub's sign-in. Sign in to Hive again in Settings.");
    }
    const refused = targets.filter((appliance) => !changeHeatingOne(appliance, change)).map(({ id }) => id);
    return { appliances: targets.map(heatingReport), refused };
  };
  /** Waits as a held sign-in does, then refuses as the Hub would where Hive can't be reached. */
  const hiveSigningIn = async (): Promise<void> => {
    const waitFor = hiveHold;
    hiveHold = undefined;
    await waitFor;
    await Promise.resolve();
    if (hiveTokens === "unreachable") throw new HubRequestFailed(FAKE_HIVE_UNREACHABLE);
  };
  /** Signed in: adds each of Hive's Appliances the fake Hub hasn't, by Hive's id, with Hive's name and no Room. */
  const signedInToHive = (): HiveSignedIn => {
    hiveSignedIn = true;
    hiveTokens = "accepted";
    hiveCodePending = false;
    const added: Appliance[] = [];
    for (const { kind, name } of FAKE_HIVE_HOME) {
      const appliance = aHiveAppliance(nextId, kind as "heating" | "radiator-valve" | "hot-water", name);
      if (appliances.some(({ serialNumber }) => serialNumber === appliance.serialNumber)) continue;
      added.push(appliance);
      nextId += 1;
    }
    appliances = [...appliances, ...added];
    return { signedIn: true, added };
  };
  const lightCapabilitiesOf = (id: number): LightCapabilities => lightCapabilities.get(id) ?? COLOUR_LIGHT_CAPABILITIES;
  const lightStateOf = (id: number): LightState => {
    const state = lightStates.get(id) ?? aLightState();
    return lightCapabilitiesOf(id).brightness ? state : { ...state, brightness: null, colourTemperature: null };
  };
  const lightReading = (id: number): LightReading => {
    const why = lightsNotAnswering.get(id);
    return why === undefined ? { known: true, state: lightStateOf(id) } : { known: false, why };
  };
  /** Waits as a held change does, then refuses as the Hub would, or goes on. */
  const lightChanging = async (): Promise<void> => {
    const waitFor = lightHold;
    lightHold = undefined;
    await waitFor;
    await Promise.resolve();
    if (lightRefusal !== undefined) {
      const message = lightRefusal;
      lightRefusal = undefined;
      throw new HubRequestFailed(message);
    }
  };
  /** Waits as a held save, rename, delete or recall of a Light Scene does, then refuses as the Hub would, or goes on. */
  const lightSceneChanging = async (): Promise<void> => {
    const waitFor = lightSceneHold;
    lightSceneHold = undefined;
    await waitFor;
    await Promise.resolve();
    if (lightSceneRefusal !== undefined) {
      const message = lightSceneRefusal;
      lightSceneRefusal = undefined;
      throw new HubRequestFailed(message);
    }
  };
  /** The Light Scene, if the fake Hub has it, or why not. */
  const lightSceneAt = (id: number): LightScene => {
    const scene = lightScenes.find((each) => each.id === id);
    if (scene === undefined) throw new HubRequestFailed("That Light Scene has been deleted.");
    return scene;
  };
  /** What the change makes of the Light's state, as the Lepro Driver makes it. */
  const lightChanged = (state: LightState, change: LightChange): LightState => ({
    ...state,
    ...(change.on === undefined ? {} : { on: change.on }),
    ...(change.brightness === undefined ? {} : { brightness: change.brightness }),
    ...(change.colourTemperature === undefined ? {} : { colourTemperature: change.colourTemperature, colour: null }),
    ...(change.colour === undefined ? {} : { colour: change.colour, colourTemperature: null }),
  });
  /** The Light, if it is one the fake Hub has, or why not. */
  const lightAt = async (id: number): Promise<void> => {
    await Promise.resolve();
    if (!appliances.some((appliance) => appliance.id === id && appliance.kind === "light"))
      throw new HubRequestFailed("That Appliance has been removed.");
  };
  /** The Air Conditioner, if it is one the fake Hub has, or why not. */
  const airConditionerAt = async (id: number): Promise<void> => {
    await Promise.resolve();
    if (!appliances.some((appliance) => appliance.id === id && appliance.kind === "air-conditioner"))
      throw new HubRequestFailed("That Appliance has been removed.");
  };
  const reading = (id: number): AirConditionerReading => {
    const why = notAnswering.get(id);
    return why === undefined ? { known: true, state: airConditionerStateOf(id) } : { known: false, why };
  };
  /** What the change makes of the state, as the Midea Driver makes it. */
  const airConditionerChanged = (
    id: number,
    state: AirConditionerState,
    change: AirConditionerChange,
  ): AirConditionerState => {
    const mode = change.mode ?? state.mode;
    const range = capabilitiesOf(id).modes.find((each) => each.mode === mode)?.temperature ?? null;
    const target = change.targetTemperature ?? state.targetTemperature;
    return {
      ...state,
      ...(change.power === undefined ? {} : { power: change.power }),
      mode,
      targetTemperature: range === null ? target : Math.min(range.max, Math.max(range.min, target)),
      ...(change.fanSpeed === undefined ? {} : { fanSpeed: change.fanSpeed }),
      swing: { ...state.swing, ...change.swing },
      ...(change.preset === undefined ? {} : { preset: change.preset }),
      ...(change.display === undefined ? {} : { display: change.display }),
      functions: { ...state.functions, ...change.functions },
    };
  };

  /** What a Player playing this does with the control. */
  const controlled = (playing: NowPlaying, control: PlaybackControl): NowPlaying | null => {
    const within = (positionMs: number): number =>
      Math.max(0, Math.min(positionMs, playing.durationMs ?? Number.POSITIVE_INFINITY));
    switch (control.action) {
      case "play":
        return { ...playing, state: "playing" };
      case "pause":
        return { ...playing, state: "paused" };
      case "seek":
        return { ...playing, positionMs: within(control.positionMs) };
      case "skip":
        return { ...playing, positionMs: within(playing.positionMs + control.byMs) };
      case "stop":
        return null;
      case "audio-track":
        return { ...playing, audioTrack: control.track };
      case "subtitle-track":
        return { ...playing, subtitleTrack: control.track };
    }
  };

  /** What the Hub does with the control to the Queue this plays, or throws why it refuses it. */
  const queueControlled = (playing: NowPlaying, control: QueueControl): NowPlaying => {
    const { queue } = playing;
    if (queue === null) throw new HubRequestFailed("The TV isn't playing a Queue.");
    switch (control.action) {
      case "repeat":
        return { ...playing, queue: { ...queue, repeat: control.repeat } };
      case "shuffle": {
        const { current, mediaFiles } = queue;
        const name = mediaFiles[current] ?? "";
        if (!control.shuffle) {
          const sorted = mediaFiles.toSorted();
          return { ...playing, queue: { ...queue, mediaFiles: sorted, current: sorted.indexOf(name), shuffle: false } };
        }
        const shuffled = [...mediaFiles.slice(0, current + 1), ...mediaFiles.slice(current + 1).toReversed()];
        return { ...playing, queue: { ...queue, mediaFiles: shuffled, shuffle: true } };
      }
      case "next":
      case "previous": {
        const { length } = queue.mediaFiles;
        const place = queue.current + (control.action === "next" ? 1 : -1);
        if ((place < 0 || place >= length) && queue.repeat !== "all") {
          throw new HubRequestFailed(
            `That is the ${control.action === "next" ? "last" : "first"} Media File of the Queue.`,
          );
        }
        const current = (place + length) % length;
        return {
          ...playing,
          name: queue.mediaFiles[current] ?? playing.name,
          positionMs: 0,
          queue: { ...queue, current },
        };
      }
    }
  };

  /** A promise, and the function that resolves it. */
  const held = (): [Promise<void>, () => void] => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return [promise, release];
  };

  const doApp = async (id: number, appId: string, what: "launch" | "close"): Promise<void> => {
    const waitFor = appHold;
    appHold = undefined;
    await waitFor;
    await Promise.resolve();
    if (appRefusal !== undefined) {
      const message = appRefusal;
      appRefusal = undefined;
      throw new HubRequestFailed(message);
    }
    if (!appliances.some((appliance) => appliance.id === id))
      throw new HubRequestFailed("That Appliance has been removed.");
    appsDone.push({ id, appId, what });
    // A launched app comes to the front, and one closed there leaves nothing the TV says is.
    const listed = appLists.get(id) ?? { known: true, apps: FAKE_TV_APPS };
    const app = listed.known ? listed.apps.find((each) => each.id === appId) : undefined;
    const front = showing.get(id);
    if (what === "launch" && app !== undefined) showing.set(id, { known: true, app });
    if (what === "close" && front?.known === true && front.app.id === appId)
      showing.set(id, { known: false, why: "cannot-tell" });
  };

  const changing = async <T>(work: () => T): Promise<T> => {
    await Promise.resolve();
    if (refusal !== undefined) {
      const message = refusal;
      refusal = undefined;
      throw new HubRequestFailed(message);
    }
    return work();
  };

  const pairing = async <T>(work: () => T): Promise<T> => {
    const waitFor = hold;
    hold = undefined;
    await waitFor;
    return changing(work);
  };

  /** Sends the login to the fake cloud, which refuses any but {@link FAKE_CLOUD_LOGIN}. */
  const signIn = (login: CloudLogin, id?: number): void => {
    logins.push({ ...(id === undefined ? {} : { id }), login });
    if (login.account !== FAKE_CLOUD_LOGIN.account || login.password !== FAKE_CLOUD_LOGIN.password) {
      throw new HubRequestFailed(FAKE_CLOUD_REFUSAL);
    }
  };

  const set = (id: number, change: Partial<Appliance>): Appliance => {
    const found = appliances.find((appliance) => appliance.id === id);
    if (found === undefined) throw new HubRequestFailed("That Appliance has been removed.");
    const changed = { ...found, ...change };
    appliances = appliances.map((appliance) => (appliance.id === id ? changed : appliance));
    return changed;
  };

  return {
    current: () => appliances,
    refuseNext: (message) => {
      refusal = message;
    },
    logins,
    revoke: (id) => {
      revoked.add(id);
    },
    holdPairing: () => {
      let release = (): void => undefined;
      hold = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    connected,
    holdSearch: () => {
      let release = (): void => undefined;
      searchHold = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    searches: () => searches,
    setPower: (id, power) => {
      powers.set(id, power);
    },
    powerReads,
    powerSwitches,
    holdPowerChange: () => {
      powerChangeHeld = true;
      return () => {
        powerChangeHeld = false;
        heldChange?.();
        heldChange = undefined;
      };
    },
    holdNextPowerSwitch: () => {
      const [promise, release] = held();
      switchHold = promise;
      return release;
    },
    switchPower: async (id) => {
      const waitFor = switchHold;
      switchHold = undefined;
      await waitFor;
      return changing(() => {
        if (!appliances.some((appliance) => appliance.id === id)) {
          throw new HubRequestFailed("That Appliance has been removed.");
        }
        powerSwitches.push(id);
        const switching = (powers.get(id) ?? "on") === "on" ? "off" : "on";
        const change = (): void => {
          powers.set(id, switching === "on" ? "on" : "standby");
        };
        if (powerChangeHeld) heldChange = change;
        else change();
        return { switching };
      });
    },
    keysPressed,
    refuseNextKey: (message) => {
      keyRefusal = message;
    },
    holdNextKey: () => {
      let release = (): void => undefined;
      keyHold = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    pressKey: async (id, key) => {
      const waitFor = keyHold;
      keyHold = undefined;
      await waitFor;
      await Promise.resolve();
      if (keyRefusal !== undefined) {
        const message = keyRefusal;
        keyRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      keysPressed.push({ id, key });
      const volume = volumeOf(id);
      if (volume.known && (key === "volume-up" || key === "volume-down")) {
        const level = Math.min(100, Math.max(0, volume.volume + (key === "volume-up" ? 1 : -1)));
        volumes.set(id, { known: true, volume: level, muted: false });
      }
    },
    shortcutsPressed,
    ignoreShortcuts: (id, shortcuts) => {
      ignoredShortcuts.set(id, new Set(shortcuts));
    },
    refuseNextShortcut: (message) => {
      shortcutRefusal = message;
    },
    holdNextShortcutOutcome: () => {
      const [promise, release] = held();
      outcomeHold = promise;
      return release;
    },
    pressShortcut: async (id, shortcut) => {
      await Promise.resolve();
      if (shortcutRefusal !== undefined) {
        const message = shortcutRefusal;
        shortcutRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      shortcutsPressed.push({ id, shortcut });
      const waitFor = outcomeHold;
      outcomeHold = undefined;
      const ignored = ignoredShortcuts.get(id)?.has(shortcut) === true;
      const outcome = async () => {
        await waitFor;
        return ignored ? ("ignored" as const) : ("unconfirmed" as const);
      };
      return { outcome: outcome() };
    },
    setVolume: (id, volume) => {
      volumes.set(id, volume);
    },
    volumeReads,
    volumeChanges,
    holdNextVolumeChange: () => {
      const [promise, release] = held();
      volumeHold = promise;
      return release;
    },
    readVolume: async (id) => {
      volumeReads.push(id);
      await Promise.resolve();
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      return volumeOf(id);
    },
    changeVolume: async (id, change) => {
      const waitFor = volumeHold;
      volumeHold = undefined;
      await waitFor;
      return changing(() => {
        const appliance = appliances.find((each) => each.id === id);
        if (appliance === undefined) throw new HubRequestFailed("That Appliance has been removed.");
        const volume = volumeOf(id);
        if (!volume.known) {
          throw new HubRequestFailed(
            `The TV at ${appliance.address} isn't answering for its volume, as when it is in standby. Volume up and down still work.`,
          );
        }
        volumeChanges.push({ id, change });
        const changed = { ...volume, ...change };
        volumes.set(id, changed);
        return changed;
      });
    },
    setKeyboard: (id, open) => {
      if (open) keyboards.add(id);
      else keyboards.delete(id);
    },
    keyboardReads,
    textsEntered,
    refuseNextText: (message) => {
      textRefusal = message;
    },
    holdNextText: () => {
      const [promise, release] = held();
      textHold = promise;
      return release;
    },
    readKeyboard: async (id) => {
      keyboardReads.push(id);
      await Promise.resolve();
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      return keyboards.has(id);
    },
    enterText: async (id, text) => {
      const waitFor = textHold;
      textHold = undefined;
      await waitFor;
      await Promise.resolve();
      if (textRefusal !== undefined) {
        const message = textRefusal;
        textRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      textsEntered.push({ id, text });
      keyboards.delete(id);
    },
    setApps: (id, apps) => {
      appLists.set(id, apps);
    },
    appsReads,
    appsDone,
    refuseNextApp: (message) => {
      appRefusal = message;
    },
    holdNextApp: () => {
      const [promise, release] = held();
      appHold = promise;
      return release;
    },
    listApps: async (id) => {
      appsReads.push(id);
      await Promise.resolve();
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      return appLists.get(id) ?? { known: true, apps: FAKE_TV_APPS };
    },
    launchApp: (id, appId) => doApp(id, appId, "launch"),
    closeApp: (id, appId) => doApp(id, appId, "close"),
    setNowShowing: (id, nowShowing) => {
      showing.set(id, nowShowing);
    },
    nowShowingReads,
    readNowShowing: async (id) => {
      nowShowingReads.push(id);
      await Promise.resolve();
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      return showing.get(id) ?? { known: false, why: "cannot-tell" };
    },
    setDeviceInfo: (id, deviceInfo) => {
      deviceInfos.set(id, deviceInfo);
    },
    deviceInfoReads,
    playerActions,
    holdNextPlayerAction: () => {
      const waiting: ((action: StartedPlayerAction) => void)[] = [];
      let started: StartedPlayerAction | undefined;
      const then = (action: (started: StartedPlayerAction) => void): void => {
        if (started === undefined) waiting.push(action);
        else action(started);
      };
      playerActionHold = (action) => {
        started = action;
        for (const each of waiting.splice(0)) each(action);
      };
      return {
        step: (step) => {
          then(({ onStep }) => {
            onStep(step);
          });
        },
        done: () => {
          then(({ resolve }) => {
            resolve();
          });
        },
        fail: (message) => {
          then(({ reject }) => {
            reject(new HubRequestFailed(message));
          });
        },
      };
    },
    refuseNextPlayerAction: (message) => {
      playerActionRefusal = message;
    },
    playerAction: async (id, action, onStep) => {
      playerActions.push({ id, action });
      await Promise.resolve();
      if (playerActionRefusal !== undefined) {
        const message = playerActionRefusal;
        playerActionRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      const hold = playerActionHold;
      playerActionHold = undefined;
      if (hold !== undefined) {
        await new Promise<void>((resolve, reject) => {
          hold({ onStep, resolve, reject });
        });
        return;
      }
      for (const step of PLAYER_ACTION_STEPS[action]) onStep(step);
    },
    plays,
    holdNextPlay: () => {
      /** What the test did before the play started, done once it has. */
      const waiting: ((play: StartedPlay) => void)[] = [];
      let started: StartedPlay | undefined;
      const then = (action: (play: StartedPlay) => void): void => {
        if (started === undefined) waiting.push(action);
        else action(started);
      };
      playHold = (play) => {
        started = play;
        for (const action of waiting.splice(0)) action(play);
      };
      return {
        step: (step) => {
          then(({ onStep }) => {
            onStep(step);
          });
        },
        sent: () => {
          then(({ resolve }) => {
            resolve();
          });
        },
        fail: (message) => {
          then(({ reject }) => {
            reject(new HubRequestFailed(message));
          });
        },
      };
    },
    refuseNextPlay: (message) => {
      playRefusal = message;
    },
    play: async (id, request, onStep) => {
      plays.push({ id, request });
      await Promise.resolve();
      if (playRefusal !== undefined) {
        const message = playRefusal;
        playRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      const hold = playHold;
      playHold = undefined;
      if (hold !== undefined) {
        await new Promise<void>((resolve, reject) => {
          hold({ onStep, resolve, reject });
        });
        return;
      }
      if ((powers.get(id) ?? "on") !== "on") {
        onStep("waking");
        powers.set(id, "on");
      }
      for (const step of ["launching", "connecting", "sending"] as const) onStep(step);
    },
    setNowPlaying: (id, playing) => {
      if (playing === null) nowPlaying.delete(id);
      else nowPlaying.set(id, playing);
    },
    playbackReads,
    playbackControls,
    queueControls,
    refuseNextControl: (message) => {
      controlRefusal = message;
    },
    holdNextControl: () => {
      const [promise, release] = held();
      controlHold = promise;
      return release;
    },
    readPlayback: async (id) => {
      playbackReads.push(id);
      await Promise.resolve();
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      return nowPlaying.get(id) ?? null;
    },
    controlPlayback: async (id, control) => {
      const waitFor = controlHold;
      controlHold = undefined;
      await waitFor;
      await Promise.resolve();
      if (controlRefusal !== undefined) {
        const message = controlRefusal;
        controlRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      const playing = nowPlaying.get(id);
      if (playing === undefined) throw new HubRequestFailed("Nothing is playing on the TV.");
      playbackControls.push({ id, control });
      const next = controlled(playing, control);
      if (next === null) nowPlaying.delete(id);
      else nowPlaying.set(id, next);
      return next;
    },
    controlQueue: async (id, control) => {
      const waitFor = controlHold;
      controlHold = undefined;
      await waitFor;
      await Promise.resolve();
      if (controlRefusal !== undefined) {
        const message = controlRefusal;
        controlRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      const playing = nowPlaying.get(id);
      if (playing === undefined) throw new HubRequestFailed("Nothing is playing on the TV.");
      const next = queueControlled(playing, control);
      queueControls.push({ id, control });
      nowPlaying.set(id, next);
      return next;
    },
    readDeviceInfo: async (id) => {
      deviceInfoReads.push(id);
      await Promise.resolve();
      const appliance = appliances.find((each) => each.id === id);
      if (appliance === undefined) throw new HubRequestFailed("That Appliance has been removed.");
      return deviceInfos.get(id) ?? aTvDeviceInfo(appliance);
    },
    list: () => Promise.resolve([...appliances]),
    add: ({ kind, address, name, roomId, login, light }) =>
      pairing(() => {
        if (kind === "light") {
          if (light !== undefined) lightKeys.push(light);
          if (light?.key !== FAKE_LIGHT_KEY) throw new HubRequestFailed(FAKE_LIGHT_KEY_REFUSAL);
          const appliance = aLight(
            nextId++,
            name === undefined || name.trim() === "" ? "Lepro Light" : name.trim(),
            roomId,
            {
              address,
            },
          );
          appliances = [...appliances, appliance];
          return appliance;
        }
        if (kind === "air-conditioner") {
          const known = foundAirConditioners.find((each) => each.address === address);
          if (known?.needsLogin ?? true) {
            if (login === undefined) throw new HubRequestFailed(FAKE_LOGIN_NEEDED, "login");
            signIn(login);
          }
          const id = nextId++;
          const appliance = anAirConditioner(
            id,
            name === undefined || name === "" ? (known?.name ?? "Unit 0000") : name,
            roomId,
            {
              address,
              ...(known === undefined
                ? {}
                : {
                    serialNumber: known.serialNumber,
                    model: known.needsLogin ? "Midea, protocol v3" : "Midea, protocol v2",
                  }),
            },
          );
          appliances = [...appliances, appliance];
          return appliance;
        }
        const id = nextId++;
        // As the Hub reads it from the TV: the same as when the TV was found.
        const known = found.find((each) => each.address === address);
        const appliance = {
          ...aTv(id, name === undefined || name === "" ? (known?.name ?? "[TV] Samsung") : name, roomId),
          kind,
          address,
          ...(known === undefined ? {} : { model: known.model, macAddress: known.macAddress }),
        };
        appliances = [...appliances, appliance];
        return appliance;
      }),
    update: (id, { filmLightSceneId, ...change }) =>
      changing(() => {
        const { filmLightSceneId: had, ...changed } = set(id, {
          ...change,
          ...(change.name === undefined ? {} : { name: change.name.trim() }),
        });
        // Left out for none, as the Hub answers.
        const chosen = filmLightSceneId === undefined ? had : (filmLightSceneId ?? undefined);
        const appliance: Appliance = { ...changed, ...(chosen === undefined ? {} : { filmLightSceneId: chosen }) };
        appliances = appliances.map((each) => (each.id === id ? appliance : each));
        return appliance;
      }),
    remove: (id) =>
      changing(() => {
        appliances = appliances.filter((appliance) => appliance.id !== id);
      }),
    checkConnection: (id) => {
      connected.push(id);
      // Not a change the person made, so it never takes a refusal meant for one.
      return Promise.resolve().then(() => set(id, revoked.has(id) ? { pairing: "pair-again" } : {}));
    },
    readPower: async (id) => {
      powerReads.push(id);
      await Promise.resolve();
      if (!appliances.some((appliance) => appliance.id === id))
        throw new HubRequestFailed("That Appliance has been removed.");
      return powers.get(id) ?? "on";
    },
    pairAgain: (id) =>
      pairing(() => {
        revoked.delete(id);
        return set(id, { pairing: "paired" });
      }),
    fetchAgain: (id, login) =>
      pairing(() => {
        signIn(login, id);
        revoked.delete(id);
        return set(id, { pairing: "paired" });
      }),
    find: async (kind) => {
      searches += 1;
      const waitFor = searchHold;
      searchHold = undefined;
      await waitFor;
      return changing(() => found.filter((each) => each.kind === kind));
    },
    setAirConditionerCapabilities: (id, capabilities) => {
      airConditionerCapabilities.set(id, capabilities);
    },
    setAirConditionerState: (id, change) => {
      airConditionerStates.set(id, { ...airConditionerStateOf(id), ...change });
    },
    setAirConditionerAnswering: (id, why) => {
      if (why === null) notAnswering.delete(id);
      else notAnswering.set(id, why);
    },
    capabilitiesReads,
    airConditionerReads,
    airConditionerChanges,
    refuseNextAirConditionerChange: (message) => {
      airConditionerRefusal = message;
    },
    holdNextAirConditionerChange: () => {
      const [promise, release] = held();
      airConditionerHold = promise;
      return release;
    },
    readAirConditionerCapabilities: async (id) => {
      capabilitiesReads.push(id);
      await airConditionerAt(id);
      const why = notAnswering.get(id);
      return why === undefined ? { known: true, capabilities: capabilitiesOf(id) } : { known: false, why };
    },
    readAirConditioner: async (id) => {
      airConditionerReads.push(id);
      await airConditionerAt(id);
      return reading(id);
    },
    changeAirConditioner: async (id, change) => {
      const waitFor = airConditionerHold;
      airConditionerHold = undefined;
      await waitFor;
      await airConditionerAt(id);
      if (airConditionerRefusal !== undefined) {
        const message = airConditionerRefusal;
        airConditionerRefusal = undefined;
        throw new HubRequestFailed(message);
      }
      if (notAnswering.get(id) === "unreachable")
        throw new HubRequestFailed(
          "No Air Conditioner answered. Check that it is switched on and on the same network as the Hub.",
        );
      if (notAnswering.get(id) === "fetch-again")
        throw new HubRequestFailed("It no longer accepts the Hub's token and key. Fetch them again in Settings.");
      airConditionerChanges.push({ id, change });
      airConditionerStates.set(id, airConditionerChanged(id, airConditionerStateOf(id), change));
      return reading(id);
    },
    findLights: async () => {
      searches += 1;
      const waitFor = searchHold;
      searchHold = undefined;
      await waitFor;
      return changing(() =>
        foundLights.map((each) => ({
          ...each,
          applianceId:
            appliances.find((appliance) => appliance.kind === "light" && appliance.address === each.address)?.id ??
            null,
        })),
      );
    },
    lightKeys,
    setLightCapabilities: (id, capabilities) => {
      lightCapabilities.set(id, capabilities);
    },
    setLightState: (id, change) => {
      lightStates.set(id, { ...(lightStates.get(id) ?? aLightState()), ...change });
    },
    setLightAnswering: (id, why) => {
      if (why === null) lightsNotAnswering.delete(id);
      else lightsNotAnswering.set(id, why);
    },
    lightReads,
    lightChanges,
    lightsChanges,
    refuseNextLightChange: (message) => {
      lightRefusal = message;
    },
    holdNextLightChange: () => {
      const [promise, release] = held();
      lightHold = promise;
      return release;
    },
    readLightCapabilities: async (id) => {
      capabilitiesReads.push(id);
      await lightAt(id);
      const why = lightsNotAnswering.get(id);
      return why === undefined ? { known: true, capabilities: lightCapabilitiesOf(id) } : { known: false, why };
    },
    readLight: async (id) => {
      lightReads.push(id);
      await lightAt(id);
      return lightReading(id);
    },
    changeLight: async (id, change) => {
      await lightChanging();
      await lightAt(id);
      if (lightsNotAnswering.get(id) === "unreachable")
        throw new HubRequestFailed(
          "No Light answered. Check that it is switched on and on the same network as the Hub.",
        );
      if (lightsNotAnswering.get(id) === "key-refused")
        throw new HubRequestFailed("It no longer answers to the Hub's key.");
      lightChanges.push({ id, change });
      lightStates.set(id, lightChanged(lightStates.get(id) ?? aLightState(), change));
      return lightReading(id);
    },
    changeLights: async (roomId, change) => {
      await lightChanging();
      lightsChanges.push({ roomId, change });
      const lights = appliances.filter(
        (appliance) => appliance.kind === "light" && (roomId === undefined || appliance.roomId === roomId),
      );
      const outcome = lights.flatMap(({ id }) => {
        if (lightsNotAnswering.has(id)) return [{ id, reading: lightReading(id) }];
        const dims = lightCapabilitiesOf(id).brightness;
        if (change.brightness !== undefined && !dims && change.on === undefined) return [];
        const asked: LightChange =
          change.brightness !== undefined && dims
            ? { on: true, ...change }
            : { ...(change.on === undefined ? {} : { on: change.on }) };
        lightStates.set(id, lightChanged(lightStates.get(id) ?? aLightState(), asked));
        return [{ id, reading: lightReading(id) }];
      });
      return { lights: outcome, unreached: outcome.filter(({ reading }) => !reading.known).map(({ id }) => id) };
    },
    lightSceneRecalls,
    refuseNextLightScene: (message) => {
      lightSceneRefusal = message;
    },
    holdNextLightScene: () => {
      const [promise, release] = held();
      lightSceneHold = promise;
      return release;
    },
    lightScenes: async () => {
      await Promise.resolve();
      return [...lightScenes];
    },
    saveLightScene: async (roomId, name) => {
      await lightSceneChanging();
      const inRoom = appliances.filter((appliance) => appliance.kind === "light" && appliance.roomId === roomId);
      const lightScene: LightScene = {
        id: nextLightSceneId,
        roomId,
        name: name.trim(),
        lights: inRoom
          .filter(({ id }) => !lightsNotAnswering.has(id))
          .map(({ id }) => ({ id, state: lightStateOf(id) })),
      };
      nextLightSceneId += 1;
      lightScenes = [...lightScenes, lightScene];
      return { lightScene, unreached: inRoom.filter(({ id }) => lightsNotAnswering.has(id)).map(({ id }) => id) };
    },
    renameLightScene: async (id, name) => {
      await lightSceneChanging();
      const renamed = { ...lightSceneAt(id), name: name.trim() };
      lightScenes = lightScenes.map((each) => (each.id === id ? renamed : each));
      return renamed;
    },
    deleteLightScene: async (id) => {
      await lightSceneChanging();
      lightSceneAt(id);
      lightScenes = lightScenes.filter((each) => each.id !== id);
    },
    recallLightScene: async (id) => {
      await lightSceneChanging();
      const { roomId, lights } = lightSceneAt(id);
      lightSceneRecalls.push(id);
      const outcome = lights
        .filter((saved) => appliances.some((appliance) => appliance.id === saved.id && appliance.roomId === roomId))
        .map(({ id: lightId, state }) => {
          if (!lightsNotAnswering.has(lightId)) lightStates.set(lightId, state);
          return { id: lightId, reading: lightReading(lightId) };
        });
      return { lights: outcome, unreached: outcome.filter(({ reading }) => !reading.known).map(({ id }) => id) };
    },
    setHiveTokens: (tokens) => {
      hiveTokens = tokens;
    },
    askHiveCode: (ask) => {
      hiveAsksCode = ask;
    },
    hiveSignIns,
    hiveReads: () => hiveReads,
    holdNextHiveSignIn: () => {
      const [promise, release] = held();
      hiveHold = promise;
      return release;
    },
    readHive: async () => {
      hiveReads += 1;
      await Promise.resolve();
      return hiveSignedIn ? { signedIn: true, tokens: hiveTokens } : { signedIn: false };
    },
    signInToHive: async (login) => {
      hiveSignIns.push({ login });
      await hiveSigningIn();
      if (login.account !== FAKE_CLOUD_LOGIN.account || login.password !== FAKE_CLOUD_LOGIN.password) {
        throw new HubRequestFailed(FAKE_HIVE_REFUSAL);
      }
      if (!hiveAsksCode) return signedInToHive();
      hiveCodePending = true;
      return { signedIn: false, needs: "code" };
    },
    enterHiveCode: async (code) => {
      hiveSignIns.push({ code });
      await hiveSigningIn();
      if (!hiveCodePending) throw new HubRequestFailed("Hive's code has expired. Sign in again for a new one.");
      if (code !== FAKE_HIVE_CODE) throw new HubRequestFailed(FAKE_HIVE_WRONG_CODE);
      // The device Hive trusts from now on.
      hiveAsksCode = false;
      return signedInToHive();
    },
    signOutOfHive: async () => {
      await Promise.resolve();
      hiveSignedIn = false;
      hiveCodePending = false;
      appliances = appliances.filter(({ kind }) => !HIVE_KINDS.includes(kind));
    },
    setHeatingState: (id, state) => {
      const appliance = appliances.find((each) => each.id === id);
      if (appliance === undefined) throw new Error(`The fake Hub has no Appliance ${String(id)}`);
      heatingStates.set(id, { ...heatingStateOf(appliance), ...state } as RadiatorValveState | HotWaterState);
    },
    refuseHeatingChanges: (id, refuse) => {
      if (refuse) refusingHeating.add(id);
      else refusingHeating.delete(id);
    },
    heatingReads: () => heatingReads,
    heatingChanges,
    holdNextHeatingChange: () => {
      const [promise, release] = held();
      heatingHold = promise;
      return release;
    },
    readHeating: async () => {
      heatingReads += 1;
      await Promise.resolve();
      if (!hiveSignedIn) return { signedIn: false };
      if (hiveTokens !== "accepted") {
        return { signedIn: true, hive: hiveTokens === "refused" ? "tokens-refused" : "unreachable" };
      }
      return {
        signedIn: true,
        hive: "reachable",
        appliances: appliances
          .filter(({ kind }) => HIVE_KINDS.includes(kind))
          .map((appliance): HeatingReading => {
            const report = heatingReport(appliance);
            return report.kind === "hot-water"
              ? {
                  ...report,
                  appliance,
                  capabilities: { modes: ["schedule", "on", "off"], boostMinutes: FAKE_BOOST_MINUTES },
                }
              : { ...report, appliance, capabilities: FAKE_HEATING_CAPABILITIES };
          }),
      };
    },
    changeHeating: async (id, change) => {
      const appliance = appliances.find((each) => each.id === id && HIVE_KINDS.includes(each.kind));
      if (appliance === undefined) throw new HubRequestFailed("That Appliance has been removed.");
      return changeHeatingEach(id, [appliance], change);
    },
    changeWholeHome: (change) =>
      changeHeatingEach(
        "whole-home",
        appliances.filter(({ kind }) => kind === "heating"),
        change,
      ),
    setRoomTarget: (roomId, target) =>
      changeHeatingEach(
        { roomId },
        appliances.filter(({ kind, roomId: inRoom }) => kind === "radiator-valve" && inRoom === roomId),
        { target },
      ),
    findAirConditioners: async () => {
      searches += 1;
      const waitFor = searchHold;
      searchHold = undefined;
      await waitFor;
      return changing(() => [...foundAirConditioners]);
    },
  };
};
