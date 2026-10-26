import type {
  AirConditionerCapabilities,
  AirConditionerChange,
  AirConditionerState,
  ApplianceApp,
  ApplianceKind,
  ApplianceVolume,
  CloudLogin,
  DeviceInfo,
  HeatingCapabilities,
  HeatingChange,
  HeatingState,
  HotWaterCapabilities,
  HotWaterChange,
  HotWaterState,
  LightCapabilities,
  LightChange,
  LightState,
  PlayerActionStep,
  PowerState,
  RadiatorValveState,
} from "@media-centre/shared";

import type { ImageType } from "./images.ts";

/** What an Appliance says about itself, read as it is added (FR-14). */
export interface ApplianceIdentity {
  /** The Appliance's own name, which its name defaults to. */
  readonly name: string;
  readonly model: string;
  /** Lower case, for Wake-on-LAN. */
  readonly macAddress: string;
}

/** An Appliance found on the home network, and what it says about itself. */
export interface DiscoveredAppliance extends ApplianceIdentity {
  /** Its IP address, to add it by. */
  readonly address: string;
}

/** What an Appliance did with the credentials it was shown. */
export type ConnectionAnswer =
  /** It let the Hub in. `credentials` are the ones to keep, which it may have renewed. */
  | { readonly accepted: true; readonly credentials: string }
  /** It refused them, e.g. because the Hub's access was revoked on it: it must be paired again. */
  | { readonly accepted: false };

/**
 * What the Appliance did with a shortcut's key, and with the credentials it
 * was shown to press it. `ignored` resolves a moment after the key is sent,
 * with whether the Appliance said it didn't take it: false is only that it
 * said nothing.
 */
export type ShortcutAnswer =
  | { readonly accepted: true; readonly credentials: string; readonly ignored: Promise<boolean> }
  | { readonly accepted: false };

/** Whether the Appliance's on-screen keyboard is open, and what it did with the credentials it was shown to say so. */
export type KeyboardAnswer =
  { readonly accepted: true; readonly credentials: string; readonly open: boolean } | { readonly accepted: false };

/** The Appliance's installed apps, and what it did with the credentials it was shown to list them. */
export type AppsAnswer =
  | { readonly accepted: true; readonly credentials: string; readonly apps: readonly ApplianceApp[] }
  | { readonly accepted: false };

/**
 * The app in front on the Appliance, as {@link Driver.listApps} lists it, or
 * undefined when it doesn't say which, and what it did with the credentials
 * it was shown to say so.
 */
export type NowShowingAnswer =
  | { readonly accepted: true; readonly credentials: string; readonly app: ApplianceApp | undefined }
  | { readonly accepted: false };

/** An app's icon, as the Appliance gave it. */
export interface AppIcon {
  readonly type: ImageType;
  readonly bytes: Uint8Array;
}

/** An app's icon, or undefined when the Appliance gives none, and what it did with the credentials it was shown. */
export type AppIconAnswer =
  | { readonly accepted: true; readonly credentials: string; readonly icon: AppIcon | undefined }
  | { readonly accepted: false };

/** The codecs a TV plays from one container, each by ffprobe's name for it, e.g. "h264" or "ac3". */
export interface PlayableCodecs {
  readonly video: readonly string[];
  readonly audio: readonly string[];
}

/**
 * What the Player on a TV can play, which the Hub chooses each Media File's
 * Route by (FR-41, ADR 0006). Containers and codecs are by ffprobe's names
 * for them, as in a `MediaProbe`.
 */
export interface PlayableFormats {
  /** The codecs it plays straight from a Media File served as it is, in each container it plays so. */
  readonly direct: Readonly<Record<string, PlayableCodecs>>;
  /** The codecs it plays from an HLS stream of MPEG-TS segments, as the Hub streams every other Route (FR-42). */
  readonly streamed: PlayableCodecs;
  /** The subtitle formats it shows itself, e.g. "subrip". */
  readonly subtitles: readonly string[];
}

/**
 * The owner's signing certificate, as the Hub keeps it, which a Driver signs
 * the Player with to install it (FR-31). Its passwords are never written
 * anywhere a person or another program can read them, nor logged (FR-4).
 */
export interface SigningCertificate {
  /** The author certificate, a `.p12` file, which says who wrote the Player. */
  readonly author: Uint8Array;
  readonly authorPassword: string;
  /** The distributor certificate, a `.p12` file, which lists the TVs it may be installed on. */
  readonly distributor: Uint8Array;
  readonly distributorPassword: string;
}

/** The Player's build, as the Hub has it, to install. */
export interface PlayerBuild {
  /** The folder its files are in, which is only read. */
  readonly dir: string;
  readonly certificate: SigningCertificate;
}

/**
 * Installs, launches and uninstalls the Player on an Appliance, a TV, as its
 * maker's developer tools do, which the TV allows only in Developer Mode with
 * the Hub's IP as its Developer IP (FR-31). Each tells `step` each of its
 * steps as it starts it, resolves once it is done, and rejects with a
 * {@link DriverFailure} saying why it couldn't be: "unreachable" for a TV
 * that doesn't let the Hub connect, "refused" for one that won't take what
 * it was asked, and "not-supported" when the Hub's machine hasn't the tools.
 */
export interface PlayerTools {
  /** Signs the Player build and installs it, in place of any Player there. */
  readonly install: (address: string, build: PlayerBuild, step: (step: PlayerActionStep) => void) => Promise<void>;
  readonly launch: (address: string, step: (step: PlayerActionStep) => void) => Promise<void>;
  readonly uninstall: (address: string, step: (step: PlayerActionStep) => void) => Promise<void>;
}

/**
 * The brand-specific part of the Hub that controls one make of one kind of
 * Appliance, e.g. the Samsung TV Driver. A Driver is the only code that knows
 * its brand's protocol (NFR-6): the rest of the Hub knows only this, and keeps
 * the credentials a Driver hands it as text it never reads.
 */
/**
 * The TCP ports an Appliance a Driver controls listens on, and what each is,
 * for the Network tab to name: each Driver's own, as only it knows its protocol.
 */
export type ListeningPorts = ReadonlyMap<number, string>;

export interface Driver {
  readonly kind: ApplianceKind;
  /** See {@link ListeningPorts}. */
  readonly ports?: ListeningPorts;
  /** Reads what the Appliance at `address` says about itself. */
  readonly identify: (address: string) => Promise<ApplianceIdentity>;
  /**
   * Asks the Appliance to let the Hub in, e.g. with a TV's "Allow" prompt, and
   * resolves with the credentials it issued (FR-13).
   */
  readonly pair: (address: string) => Promise<string>;
  /** Connects with the credentials from {@link pair}. */
  readonly connect: (address: string, credentials: string) => Promise<ConnectionAnswer>;
  /**
   * Asks the Appliance whether it is on or in standby (FR-16). Never rejects:
   * one that doesn't answer, or answers as something else, is "unreachable".
   */
  readonly readPowerState: (address: string) => Promise<PowerState>;
  /**
   * Searches the Hub's subnet for Appliances it controls, and resolves with
   * each that answered, once each (FR-12). Left out by a Driver whose brand
   * can't be found that way, whose Appliances are only added by address.
   */
  readonly discover?: () => Promise<DiscoveredAppliance[]>;
  /**
   * Presses a key on the Appliance, e.g. OK on a TV (FR-18), connecting with
   * the credentials from {@link pair} if it isn't connected already, and
   * resolves once the key is sent. `key` is a `RemoteKey` as the Remote names
   * it, but comes from outside the Hub: a key the Driver doesn't have is
   * refused as "not-supported", and one it never sends, such as one that opens
   * a TV's service menu, as "refused" (FR-30). Left out by a Driver whose
   * Appliances have no keys.
   */
  readonly pressKey?: (address: string, credentials: string, key: string) => Promise<ConnectionAnswer>;
  /**
   * Presses the key for one of TV Menu mode's shortcuts, e.g. the picture
   * mode key (FR-24), as {@link pressKey} presses a key, and resolves once it
   * is sent, then listens a moment for the Appliance to say it ignored it,
   * which keys pressed meanwhile don't wait for. Which key each shortcut is
   * lives in the Driver alone. `shortcut` is a `MenuShortcut` as the Remote
   * names it, but comes from outside the Hub: one the Driver doesn't have is
   * refused as "not-supported", and a key it never sends as "refused"
   * (FR-30). Left out by a Driver whose Appliances have no menu.
   */
  readonly pressShortcut?: (address: string, credentials: string, shortcut: string) => Promise<ShortcutAnswer>;
  /**
   * Switches on the Appliance at `address`, in standby or not answering, e.g.
   * with a Wake-on-LAN magic packet to its MAC address (FR-17), and resolves
   * once that is sent: the Appliance may take a few seconds more to come on,
   * which {@link readPowerState} then says. Left out by a Driver whose
   * Appliances can't be switched on or off.
   */
  readonly switchOn?: (appliance: { readonly address: string; readonly macAddress: string }) => Promise<void>;
  /**
   * Switches off the Appliance at `address`, which is on, e.g. with a TV's
   * power key (FR-17), connecting with the credentials from {@link pair} as
   * {@link pressKey} does, and resolves once that is sent.
   */
  readonly switchOff?: (address: string, credentials: string) => Promise<ConnectionAnswer>;
  /**
   * Asks the Appliance for its own volume and mute, now (FR-19), so that what
   * the Remote shows stays true after someone uses the physical remote. Never
   * rejects: one that doesn't answer for them, e.g. a TV in standby, says
   * they are not known (FR-25). Left out, with {@link setVolume} and
   * {@link setMute}, by a Driver whose Appliances can't say their volume.
   */
  readonly readVolume?: (address: string) => Promise<ApplianceVolume>;
  /**
   * Sets the Appliance's volume, a whole number from 0 to `VOLUME_MAX`, and
   * resolves once it has taken it. Rejects with a {@link DriverFailure} when
   * the Appliance doesn't answer for its volume.
   */
  readonly setVolume?: (address: string, volume: number) => Promise<void>;
  /** Mutes the Appliance or unmutes it, as {@link setVolume} sets its volume. */
  readonly setMute?: (address: string, muted: boolean) => Promise<void>;
  /**
   * Whether the Appliance's on-screen keyboard is open now, e.g. a TV's for a
   * search box (FR-20), connecting with the credentials from {@link pair} as
   * {@link pressKey} does, and staying connected to hear it open and close.
   * Rejects with a {@link DriverFailure} when the Appliance can't be reached.
   * Left out, with {@link enterText}, by a Driver whose Appliances have no
   * on-screen keyboard.
   */
  readonly readKeyboard?: (address: string, credentials: string) => Promise<KeyboardAnswer>;
  /**
   * Types `text` into the Appliance's on-screen keyboard and submits it, as
   * the keyboard's own Done key does, connecting as {@link pressKey} does, and
   * resolves once it is sent. Text in any script arrives exactly as given.
   */
  readonly enterText?: (address: string, credentials: string, text: string) => Promise<ConnectionAnswer>;
  /**
   * Lists the apps installed on the Appliance, e.g. a TV's YouTube (FR-21),
   * with their names and whether it gives an icon for each, connecting as
   * {@link pressKey} does. Rejects with a {@link DriverFailure} when the
   * Appliance can't be reached or doesn't answer. Left out, with
   * {@link readAppIcon}, {@link launchApp} and {@link closeApp}, by a Driver
   * whose Appliances have no apps.
   */
  readonly listApps?: (address: string, credentials: string) => Promise<AppsAnswer>;
  /** The icon of the app with this id, as {@link listApps} lists it, connecting as it does. */
  readonly readAppIcon?: (address: string, credentials: string, appId: string) => Promise<AppIconAnswer>;
  /**
   * Launches the app with this id, which the Appliance brings to the front,
   * and resolves once it has taken that. Rejects with a {@link DriverFailure}:
   * "not-supported" for an app it hasn't got, and "unreachable" when it
   * doesn't answer for its apps, e.g. a TV in standby.
   */
  readonly launchApp?: (address: string, appId: string) => Promise<void>;
  /** Closes the app with this id, as {@link launchApp} launches it. */
  readonly closeApp?: (address: string, appId: string) => Promise<void>;
  /**
   * Launches the Player on the Appliance, a TV, which brings it to the front,
   * giving it `hubAddress`, the Hub's `host:port` as the TV reaches it, to
   * connect back to (FR-35), connecting as {@link pressKey} does. A Player
   * already running is given the address again. It resolves once the
   * Appliance has taken that, which is not yet the Player connecting.
   * Rejects with a {@link DriverFailure}: "not-supported" when the Player
   * isn't installed, and "unreachable" or "timed-out" when the Appliance
   * doesn't answer. Left out by a Driver whose Appliances can't run the Player.
   */
  readonly launchPlayer?: (address: string, credentials: string, hubAddress: string) => Promise<ConnectionAnswer>;
  /**
   * What the Player plays on the Driver's Appliances, which the Driver alone
   * knows (NFR-6). Left out, with {@link launchPlayer}, by a Driver whose
   * Appliances can't run the Player.
   */
  readonly playableFormats?: PlayableFormats;
  /**
   * Which of the apps {@link listApps} lists is in front on the Appliance now
   * (FR-26), as the Appliance itself says, connecting as {@link listApps}
   * does, and changing nothing on it. Resolves with no app when it says none
   * is, or says so of more than one, rather than guessing. Rejects as
   * {@link listApps} does. Left out by a Driver whose Appliances can't say.
   */
  readonly readNowShowing?: (address: string, credentials: string) => Promise<NowShowingAnswer>;
  /**
   * Reads what the Appliance reports about itself now, e.g. a TV's model,
   * network type and Developer Mode (FR-28), changing nothing on it. Rejects
   * with a {@link DriverFailure} when it doesn't answer, or answers as
   * something else. Left out by a Driver whose Appliances report nothing more
   * than {@link identify} reads.
   */
  readonly readDeviceInfo?: (address: string) => Promise<DeviceInfo>;
  /**
   * Installs, launches and uninstalls the Player on the Appliance, a TV
   * whose {@link readDeviceInfo} says it is in Developer Mode (FR-31). Left
   * out by a Driver whose Appliances can't have the Player installed so.
   */
  readonly playerTools?: PlayerTools;
  /** Closes anything the Driver keeps open to the Appliance, e.g. once it is removed. */
  readonly disconnect?: (address: string) => void;
}

/** An Air Conditioner found on the home network, and what it says about itself (FR-51). */
export interface DiscoveredAirConditioner {
  /** Its IP address, to add it by. */
  readonly address: string;
  /** Its own name, as its Wi-Fi module gives it. */
  readonly name: string;
  /** What the Driver can say of what it is, e.g. its make and protocol, which the Hub keeps as its model. */
  readonly model: string;
  /** Its serial number. An Air Conditioner with this serial number is this one, already added. */
  readonly serialNumber: string;
  /**
   * The credentials to control it with, which the Hub keeps as text it never
   * reads. For one that {@link needsKeys}, they are only a start: it answers
   * nothing until its maker's cloud has issued keys for it (ADR 0009).
   */
  readonly credentials: string;
  /** Whether it answers only with keys its maker's cloud issues, fetched once as it is added (FR-51). */
  readonly needsKeys: boolean;
}

/**
 * The brand-specific part of the Hub that controls one make of Air
 * Conditioner, e.g. the Midea Driver. It is the only code that knows its
 * brand's protocol (NFR-6): the rest of the Hub knows an Air Conditioner only
 * by its address, its credentials, which it keeps as text it never reads, and
 * the capabilities and state the Driver reads from it.
 *
 * Each read and change rejects with a {@link DriverFailure}: "unreachable"
 * when nothing answers at the address, "timed-out" when the unit lets the
 * Hub connect but doesn't answer, "not-recognised" when what answers isn't an
 * Air Conditioner the Driver can read, "not-supported" for a change the unit
 * hasn't the capability for, and a {@link CredentialsRefused} when it refuses
 * the credentials, so that the Remote can offer to fetch them again rather
 * than say it can't reach the unit (FR-51, FR-51a).
 */
export interface AirConditionerDriver {
  /** See {@link ListeningPorts}. */
  readonly ports?: ListeningPorts;
  /**
   * Searches the Hub's subnet for the Driver's Air Conditioners, and resolves
   * with each that answered, once each (FR-51).
   */
  readonly discover: () => Promise<DiscoveredAirConditioner[]>;
  /** Asks the Air Conditioner at `address` what it is, as {@link discover} finds it, to add it by its address. */
  readonly identify: (address: string) => Promise<DiscoveredAirConditioner>;
  /**
   * Fetches the keys its maker's cloud issues for the unit at `address`,
   * one that {@link DiscoveredAirConditioner.needsKeys}, which `credentials`
   * say which it is, as {@link discover} found it or as the Hub kept them.
   * It signs in with the owner's `login`, for this alone, and forgets it
   * (ADR 0009), then resolves with the credentials to keep, once the unit
   * has accepted them. Rejects with a {@link DriverFailure}: "refused" for a
   * login the cloud refuses, "unreachable" when the cloud or the unit can't
   * be reached, and a {@link CredentialsRefused} when the unit accepts none
   * of the keys the cloud issued.
   */
  readonly fetchKeys: (address: string, credentials: string, login: CloudLogin) => Promise<string>;
  /** Reads the controls the unit reports it has, as the Appliance's capabilities (FR-50). */
  readonly readCapabilities: (address: string, credentials: string) => Promise<AirConditionerCapabilities>;
  /** Reads what the unit is doing now. */
  readonly readState: (address: string, credentials: string) => Promise<AirConditionerState>;
  /** Changes what is asked, leaving the rest as it is, and resolves with the state the unit then reports. */
  readonly setState: (
    address: string,
    credentials: string,
    change: AirConditionerChange,
  ) => Promise<AirConditionerState>;
}

/** A Light found on the home network, and what it says about itself (FR-54). */
export interface DiscoveredLight {
  /** Its IP address. */
  readonly address: string;
  /** The name it is given if added without one: its own, or its make's where it gives none. */
  readonly name: string;
  /** What the Driver can say of what it is, e.g. its make and protocol, which the Hub keeps as its model. */
  readonly model: string;
  /**
   * The credentials to control it with, which the Hub keeps as text it never
   * reads. They are only a start: it answers nothing until they have its
   * key, which only its maker gives.
   */
  readonly credentials: string;
}

/**
 * The brand-specific part of the Hub that controls one make of Light, e.g.
 * the Lepro Driver. It is the only code that knows its brand's protocol
 * (NFR-6): the rest of the Hub knows a Light only by its address, its
 * credentials, which it keeps as text it never reads, and the capabilities
 * and state the Driver reads from it.
 *
 * Each read and change rejects with a {@link DriverFailure}: "unreachable"
 * when nothing answers at the address, "timed-out" when the Light lets the
 * Hub connect but doesn't answer, "not-recognised" when what answers isn't a
 * Light the Driver can read, "not-supported" for a change the Light hasn't
 * the capability for, and a {@link CredentialsRefused} when it refuses the
 * credentials (FR-57b).
 */
export interface LightDriver {
  /** See {@link ListeningPorts}. */
  readonly ports?: ListeningPorts;
  /** Searches the Hub's subnet for the Driver's Lights, and resolves with each that answered, once each (FR-54). */
  readonly discover: () => Promise<DiscoveredLight[]>;
  /** Finds the Light at `address`, as {@link discover} finds it, to add it by its address. */
  readonly identify: (address: string) => Promise<DiscoveredLight>;
  /**
   * The Light at `address` as the person gives it, by its id, for one that
   * can't be found, as {@link identify} would find it. Nothing is sent to
   * it: whether it is there is for {@link readCapabilities} to say.
   */
  readonly given: (address: string, id: string) => DiscoveredLight;
  /**
   * The credentials to keep for a Light, from those it was found or
   * {@link given} with, and the key its maker issued it, which the person
   * gives (FR-54). Throws a {@link DriverFailure} "not-supported" for an id
   * or key that can't be a Light's, quoting neither (FR-4). Whether the
   * Light answers to them is for {@link readCapabilities} to say.
   */
  readonly withKey: (found: string, key: string) => string;
  /** Whether two of the Driver's credentials are for the same Light, e.g. one just found and one the Hub kept. */
  readonly isSameLight: (credentials: string, other: string) => boolean;
  /** Reads the controls the Light reports it has, as the Appliance's capabilities (FR-52). */
  readonly readCapabilities: (address: string, credentials: string) => Promise<LightCapabilities>;
  /** Reads what the Light is doing now. */
  readonly readState: (address: string, credentials: string) => Promise<LightState>;
  /** Changes what is asked, leaving the rest as it is, and resolves with the state the Light then reports. */
  readonly setState: (address: string, credentials: string, change: LightChange) => Promise<LightState>;
}

/**
 * One Heating, Radiator Valve or Hot Water on the account a
 * {@link HeatingDriver} signed in to, as its maker names it (FR-67), with
 * the controls it has.
 */
export type HeatingAccountAppliance =
  | {
      readonly kind: "heating" | "radiator-valve";
      /** The Driver's id for it, the same each time it is listed, which the Hub keeps as text it never reads. */
      readonly id: string;
      /** Its name in its maker's app, which its name defaults to. */
      readonly name: string;
      readonly capabilities: HeatingCapabilities;
    }
  | {
      readonly kind: "hot-water";
      readonly id: string;
      readonly name: string;
      readonly capabilities: HotWaterCapabilities;
    };

/** What one Heating, Radiator Valve or Hot Water is doing now, by the id its {@link HeatingDriver} lists it by. */
export type HeatingApplianceState =
  | { readonly kind: "heating"; readonly id: string; readonly state: HeatingState }
  | { readonly kind: "radiator-valve"; readonly id: string; readonly state: RadiatorValveState }
  | { readonly kind: "hot-water"; readonly id: string; readonly state: HotWaterState };

/** What signing in to a heating maker's cloud came to. */
export type HeatingSignIn =
  /** Signed in: the credentials to keep, which the Hub keeps as text it never reads. */
  | { readonly signedIn: true; readonly credentials: string }
  /**
   * The maker asks for the code it texted the owner: give it, with
   * `pending`, to {@link HeatingDriver.enterCode} within a few minutes.
   * `pending` is secret, as credentials are: it is never sent to the Remote
   * nor logged (FR-67a).
   */
  | { readonly signedIn: false; readonly needs: "code"; readonly pending: string };

/**
 * The brand-specific part of the Hub that controls the home's heating
 * through its maker's cloud, e.g. the Hive Driver, the one exception to
 * controlling Appliances locally (ADR 0010): a Heating for each zone, each
 * Radiator Valve and the Hot Water, all on one account. It is the only code
 * that knows its maker's API (NFR-6): the rest of the Hub knows only the
 * credentials it hands it, as text it never reads, which hold the tokens and
 * device keys its maker issued and never the password (FR-67, FR-67a), and
 * the Appliances, their capabilities and their state. Each call that takes
 * credentials resolves with the credentials to keep from then on, which it
 * may have renewed.
 *
 * Each rejects with a {@link DriverFailure}: "unreachable" when the maker's
 * cloud can't be reached, doesn't answer in time or fails (FR-68); a
 * {@link CredentialsRefused} when it refuses the credentials, and renewing
 * them fails, so that Settings offers to sign in again (FR-67b); and
 * "refused" when it refuses a change, saying which Appliance. One that its
 * maker reports offline is its state, not a failure.
 */
export interface HeatingDriver {
  /**
   * Signs in with the owner's login, which is used for this alone and never
   * kept (FR-67). Given the credentials `kept` from before, it signs in as
   * the same trusted device, so that the maker doesn't ask for a code again.
   * Rejects with a {@link DriverFailure} "refused" for a login refused.
   */
  readonly signIn: (login: CloudLogin, kept?: string) => Promise<HeatingSignIn>;
  /**
   * Gives the code the maker asked for, and resolves with the credentials to
   * keep, once the Hub is trusted as a device. Rejects with a
   * {@link DriverFailure} "refused" for a wrong code, or one given too late.
   */
  readonly enterCode: (pending: string, code: string) => Promise<string>;
  /** Renews the credentials' tokens now, and resolves with the credentials to keep. */
  readonly refresh: (credentials: string) => Promise<string>;
  /** Lists every Heating, Radiator Valve and Hot Water on the account, by its maker's names. */
  readonly listAppliances: (
    credentials: string,
  ) => Promise<{ readonly credentials: string; readonly appliances: readonly HeatingAccountAppliance[] }>;
  /**
   * Reads what every one of them is doing now, in one request, and, from
   * the same request, every one as {@link listAppliances} lists it, with
   * the controls it has, so that the Heating tab is one request (FR-62).
   */
  readonly readStates: (credentials: string) => Promise<{
    readonly credentials: string;
    readonly states: readonly HeatingApplianceState[];
    readonly appliances: readonly HeatingAccountAppliance[];
  }>;
  /**
   * Makes one change to the Appliance with this id, and resolves with what
   * it then reports. A change it hasn't the capability for is refused as
   * "not-supported" before anything is sent.
   */
  readonly setState: (
    credentials: string,
    id: string,
    change: HeatingChange | HotWaterChange,
  ) => Promise<{ readonly credentials: string; readonly state: HeatingApplianceState }>;
}

/**
 * Every Driver the Hub has, one for each kind of Appliance: a {@link Driver}
 * for TVs, an {@link AirConditionerDriver} for Air Conditioners, a
 * {@link LightDriver} for Lights, and a {@link HeatingDriver} for the
 * Heatings, Radiator Valves and Hot Water together, the last three of which
 * a Hub may be run without, refusing to add them.
 */
export interface Drivers {
  readonly tv: Driver;
  readonly "air-conditioner"?: AirConditionerDriver;
  readonly light?: LightDriver;
  readonly heating?: HeatingDriver;
}

/**
 * Why a Driver couldn't do what it was asked. The message is written for the
 * person using the Remote, which shows it as is, so it never names a protocol,
 * and never quotes credentials (FR-4).
 */
export class DriverFailure extends Error {
  readonly reason: "unreachable" | "not-recognised" | "not-allowed" | "timed-out" | "not-supported" | "refused";

  constructor(reason: DriverFailure["reason"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DriverFailure";
    this.reason = reason;
  }
}

/**
 * An Appliance refused the credentials it was shown, e.g. an Air Conditioner
 * whose keys were issued again after a factory reset: it can be reached, but
 * needs its credentials again (FR-51). Its message never quotes them (FR-4).
 */
export class CredentialsRefused extends DriverFailure {
  constructor(message: string, options?: ErrorOptions) {
    super("not-allowed", message, options);
    this.name = "CredentialsRefused";
  }
}
