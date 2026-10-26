/**
 * What the Hub, the Remote and the Player say to one another (PRD NFR-1).
 *
 * Only types and the paths they travel on live here, so that each side imports
 * the same contract and a change to it fails to typecheck on both ends.
 */

/** Where the Hub answers `GET` with a {@link HubInfo}. */
export const HUB_INFO_PATH = "/api/hub";

/** The Hub's answer to "who are you?", used by the Remote to show it is connected. */
export interface HubInfo {
  readonly product: "media-centre";
  readonly version: string;
  /**
   * Chosen on the Hub's first start and kept in its database, so it stays the
   * same across restarts and upgrades (NFR-4): the same id means the same Hub.
   */
  readonly hubId: string;
}

/**
 * Where the Hub answers `GET` with a {@link LatestVersion}: the version of
 * media-centre on GitHub, which the Remote compares with its own to offer an
 * update (FR-61).
 */
export const LATEST_VERSION_PATH = "/api/latest-version";

/**
 * The version in the package.json on GitHub's `main`, which is the latest
 * release, or `null` when the Hub couldn't find out: the internet is
 * disconnected (NFR-3), or GitHub didn't answer as expected.
 */
export interface LatestVersion {
  readonly version: string | null;
}

/**
 * Where the Hub keeps the Rooms (FR-7, FR-10):
 *
 * - `GET` answers with every {@link Room}, in Room order.
 * - `POST` a {@link RoomNameRequest} adds a Room at the end of the order, and
 *   answers `201` with it.
 */
export const ROOMS_PATH = "/api/rooms";

/**
 * One Room, at `${ROOMS_PATH}/<id>`: `PATCH` a {@link RoomNameRequest} renames it
 * and answers with it; `DELETE` removes it and answers `204`.
 */
export const roomPath = (id: number): string => `${ROOMS_PATH}/${String(id)}`;

/**
 * `PUT` a {@link RoomOrderRequest} here to set the Room order, which every tab
 * shares (FR-10). It answers with every {@link Room} in the new order.
 */
export const ROOM_ORDER_PATH = `${ROOMS_PATH}/order`;

/** The longest a Room's name may be, in characters (FR-7). */
export const ROOM_NAME_MAX_LENGTH = 40;

/** A named place in the home that Appliances are grouped by. */
export interface Room {
  /** Chosen by the Hub, and never given to another Room, even after this one is deleted. */
  readonly id: number;
  /** 1 to {@link ROOM_NAME_MAX_LENGTH} characters, unique ignoring case. */
  readonly name: string;
}

export interface RoomNameRequest {
  readonly name: string;
}

export interface RoomOrderRequest {
  /** The id of every Room, each once, first Room first. */
  readonly roomIds: readonly number[];
}

/**
 * Which Room each place on the home's floor plan is: `GET` answers with a
 * {@link FloorPlanPlaces}. The Remote alone knows the drawing and the places
 * on it, each by an id such as "upstairs-1"; the Hub keeps which Room each
 * is, so that every Remote shows the same, and forgets it as the Room is
 * deleted.
 */
export const FLOOR_PLAN_PATH = `${ROOMS_PATH}/floor-plan`;

/**
 * One place on the floor plan, at `${FLOOR_PLAN_PATH}/<place>`: `PUT` a
 * {@link FloorPlanPlaceRequest} makes it that Room, taking the Room off any
 * other place, as a Room is in one place; `DELETE` leaves it no Room. Each
 * answers with the {@link FloorPlanPlaces} as they now are.
 */
export const floorPlanPlacePath = (place: string): string => `${FLOOR_PLAN_PATH}/${encodeURIComponent(place)}`;

/** A place's id: lower-case letters, digits and hyphens, at most 40. */
export const FLOOR_PLAN_PLACE_PATTERN = /^[a-z0-9-]{1,40}$/;

/** Each place on the floor plan that is a Room, by its id, with that Room's id. */
export type FloorPlanPlaces = Readonly<Record<string, number>>;

export interface FloorPlanPlaceRequest {
  readonly roomId: number;
}

/**
 * The floor plan's drawing, where the home's isn't the Remote's built-in one:
 * `GET` answers with a {@link FloorPlanDrawing}; `PUT` a {@link FloorPlanLayout}
 * makes it the plan's layout, and takes off the plan every place that isn't
 * on it any more; `DELETE` goes back to the built-in drawing, image and
 * layout both. Each answers with the {@link FloorPlanDrawing} as it now is.
 */
export const FLOOR_PLAN_DRAWING_PATH = `${ROOMS_PATH}/floor-plan-drawing`;

/**
 * The drawing's own image, where one has been given: `GET` answers with it,
 * as the type it was given as; `PUT` an image, as one of
 * {@link FLOOR_PLAN_IMAGE_TYPES} and at most {@link FLOOR_PLAN_IMAGE_MAX_BYTES},
 * makes it the plan's, and answers with the {@link FloorPlanDrawing}. The
 * Remote asks for it by its version, so a changed image is never the old one
 * from a cache.
 */
export const FLOOR_PLAN_IMAGE_PATH = `${ROOMS_PATH}/floor-plan-image`;

/** The kinds of image a floor plan may be given as. */
export const FLOOR_PLAN_IMAGE_TYPES = ["image/svg+xml", "image/png", "image/jpeg", "image/webp"] as const;

/** The biggest image a floor plan may be given as: more than a scan of a plan needs. */
export const FLOOR_PLAN_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** How much a {@link FloorPlanLayout} may hold, so that no plan is too big to draw or keep. */
export const FLOOR_PLAN_LAYOUT_LIMITS = {
  /** The most floors a plan has. */
  floors: 12,
  /** The most places a plan has, over every floor. */
  places: 200,
  /** The most corners a place's outline has: a freehand line is simplified to fewer. */
  points: 400,
  /** The longest a floor's name may be, in characters. */
  floorNameLength: 40,
  /** The biggest the drawing is, in its own units, each way. */
  size: 20_000,
} as const;

/** A place on the floor plan: an outline that can be a Room, with its id and no name. */
export interface FloorPlanPlaceOutline {
  /** Matches {@link FLOOR_PLAN_PLACE_PATTERN}, and is one place's alone, over every floor. */
  readonly id: string;
  /** Its outline, as an SVG polygon's points, in the drawing's units: at least three corners. */
  readonly points: string;
}

/** One floor: its name, the part of the drawing it is, and its places. */
export interface FloorPlanFloor {
  /** 1 to {@link FLOOR_PLAN_LAYOUT_LIMITS}.floorNameLength characters. */
  readonly name: string;
  /** Its part of the drawing, as an SVG viewBox: `x y width height`, in the drawing's units. */
  readonly viewBox: string;
  readonly places: readonly FloorPlanPlaceOutline[];
}

/** The floor plan's layout: the drawing's size, and its floors, each shown on its own with its places. */
export interface FloorPlanLayout {
  /** The drawing's size, in its own units: an image's pixels. */
  readonly width: number;
  readonly height: number;
  readonly floors: readonly FloorPlanFloor[];
}

/** The floor plan's drawing as the Hub keeps it, each part the Remote's built-in one where it is `null`. */
export interface FloorPlanDrawing {
  /** The layout drawn for this home, or `null`: the Remote's built-in one. */
  readonly layout: FloorPlanLayout | null;
  /** The image given for this home, by its type and how many times one has been given, or `null`: the Remote's built-in one. */
  readonly image: { readonly type: string; readonly version: number } | null;
}

/**
 * The Hub's answer when it refuses a request, e.g. a Room name that is too long.
 * The message is written for the person using the Remote, which shows it as is.
 */
export interface HubError {
  readonly error: string;
  /**
   * `"login"` when the Hub needs the owner's login to an Air Conditioner
   * maker's cloud to do this, e.g. to add a unit on Midea's protocol v3: the
   * Remote asks for it once, then sends the request again with a
   * {@link CloudLogin} (FR-51, ADR 0009).
   */
  readonly needs?: "login";
}

/**
 * The kinds of Appliance the Hub controls so far, each with a tab of its own
 * (FR-6), but for a Heating's, a Radiator Valve's and the Hot Water's, which
 * share the Heating tab.
 */
export type ApplianceKind = "tv" | "air-conditioner" | "light" | "heating" | "radiator-valve" | "hot-water";

/**
 * Where the Hub keeps the Appliances (FR-8):
 *
 * - `GET` answers with every {@link Appliance}, of every kind, in the order
 *   they were added. The Remote groups them by Room itself.
 * - `POST` an {@link AddApplianceRequest} finds the Appliance at that address,
 *   pairs with it and keeps it, then answers `201` with it. For a TV this waits
 *   while the TV asks the person to allow the Hub (FR-13). For an Air
 *   Conditioner on Midea's protocol v3, the Hub fetches its token and key from
 *   Midea's cloud with the request's `login`, once, and keeps only them
 *   (FR-51, ADR 0009); without one, it refuses with `401` and a
 *   {@link HubError} whose `needs` is `"login"`. For a Light, the request's
 *   `light` gives the key its maker issued it, and its id where the Hub
 *   didn't find it (FR-54): the Hub keeps them once the Light has answered
 *   to them, and never sends them back.
 */
export const APPLIANCES_PATH = "/api/appliances";

/**
 * One Appliance, at `${APPLIANCES_PATH}/<id>`: `PATCH` an
 * {@link UpdateApplianceRequest} renames it or moves it to another Room and
 * answers with it; `DELETE` removes it and its stored credentials (FR-11) and
 * answers `204`.
 */
export const appliancePath = (id: number): string => `${APPLIANCES_PATH}/${String(id)}`;

/**
 * `POST` here to have the Hub connect to the Appliance with the credentials it
 * stored when pairing. It answers with the {@link Appliance}, whose `pairing`
 * is `"pair-again"` if the Appliance refused them, e.g. because access was
 * revoked on the TV (FR-13).
 */
export const applianceConnectionPath = (id: number): string => `${appliancePath(id)}/connection`;

/**
 * `POST` here to pair with the Appliance again, replacing its stored
 * credentials. Answers with the {@link Appliance}. For an Air Conditioner,
 * this is "Fetch again": `POST` a {@link PairingRequest} with the owner's
 * login, and the Hub fetches its token and key from its maker's cloud once
 * more, as after a factory reset (FR-51).
 */
export const appliancePairingPath = (id: number): string => `${appliancePath(id)}/pairing`;

/** What "Fetch again" sends: the login to fetch an Air Conditioner's token and key with, which the Hub never keeps. */
export interface PairingRequest {
  readonly login: CloudLogin;
}

/**
 * The owner's login to an Air Conditioner maker's cloud, e.g. the email and
 * password of their MSmartHome account for a Midea unit. The Remote sends it
 * to the Hub once, as a v3 unit is added or its token and key are fetched
 * again; the Hub uses it for that alone, then forgets it. It is never kept,
 * logged or sent back (FR-51, ADR 0009).
 */
export interface CloudLogin {
  /** The account's email address, as the maker's app signs in with it. */
  readonly account: string;
  readonly password: string;
}

/** The longest {@link CloudLogin} account or password the Hub takes, in characters. */
export const CLOUD_LOGIN_MAX_LENGTH = 256;

/**
 * `GET` here to have the Hub read the Appliance's {@link PowerState} from it
 * now, e.g. from a TV's device info (FR-16). It answers with an
 * {@link AppliancePower}, and says "unreachable" rather than refusing when the
 * Appliance doesn't answer.
 *
 * `POST` here, with no body, for the Power button: the Hub reads the power
 * state now, switches the Appliance off if it is on and on if it isn't, e.g.
 * with Wake-on-LAN for a TV (FR-17), and answers with a {@link PowerSwitch}
 * once it has sent that. The Appliance may take a few seconds more to change,
 * which `GET` then says. Like a key, it refuses with `409` when the Appliance
 * no longer lets the Hub in to switch it off, which also marks it
 * `"pair-again"` (FR-13).
 */
export const appliancePowerPath = (id: number): string => `${appliancePath(id)}/power`;

/**
 * Whether an Appliance is on, in standby (a TV that is off but still on the
 * network), or not answering the Hub at all, e.g. switched off at the wall.
 */
export type PowerState = "on" | "standby" | "unreachable";

export interface AppliancePower {
  readonly power: PowerState;
}

/** Which way the Hub switched an Appliance. */
export interface PowerSwitch {
  readonly switching: "on" | "off";
}

/**
 * `POST` an {@link ApplianceSearchRequest} here to have the Hub search its
 * subnet for Appliances of that kind, e.g. "Find TVs" (FR-12). It answers,
 * after a few seconds, with every {@link FoundAppliance}, including any it has
 * already added; for `"air-conditioner"`, "Find Air Conditioners" (FR-51),
 * with every {@link FoundAirConditioner}; and for `"light"`, "Find Lights"
 * (FR-54), with every {@link FoundLight}. It refuses a kind whose Driver
 * can't search.
 */
export const APPLIANCE_SEARCH_PATH = `${APPLIANCES_PATH}/search`;

export interface ApplianceSearchRequest {
  readonly kind: ApplianceKind;
}

/** An Appliance the Hub found on its subnet, which can be added by its address. */
export interface FoundAppliance {
  readonly kind: ApplianceKind;
  /** Its IP address. */
  readonly address: string;
  /** Its own name, which it is given if added without one (FR-14). */
  readonly name: string;
  readonly model: string;
  /**
   * Lower case. An {@link Appliance} of the same kind with this MAC address is
   * this one, already added.
   */
  readonly macAddress: string;
}

/** An Air Conditioner the Hub found on its subnet, which can be added by its address (FR-51). */
export interface FoundAirConditioner {
  readonly kind: "air-conditioner";
  /** Its IP address. */
  readonly address: string;
  /** Its own name, as its Wi-Fi module gives it, which it is given if added without one. */
  readonly name: string;
  /** An {@link Appliance} with this serial number is this one, already added. */
  readonly serialNumber: string;
  /** Whether adding it needs the owner's {@link CloudLogin}, once, to fetch its token and key (FR-51). */
  readonly needsLogin: boolean;
}

/** A Light the Hub found on its subnet, which can be added by its address and the key its maker issued it (FR-54). */
export interface FoundLight {
  readonly kind: "light";
  /** Its IP address. */
  readonly address: string;
  /** The name it is given if added without one. */
  readonly name: string;
  /** What it is, as its Driver can say, e.g. its make. */
  readonly model: string;
  /**
   * The id of the {@link Appliance} it already is, or `null` while it isn't
   * added. The Hub tells, from what the Light said of itself, which stays
   * on the Hub, as its credentials do.
   */
  readonly applianceId: number | null;
}

/** The longest an Appliance's name may be, in characters (FR-8). */
export const APPLIANCE_NAME_MAX_LENGTH = 40;

/**
 * Anything in the home the Hub controls. Its credentials, such as a TV's
 * pairing token, stay on the Hub and are never part of this (FR-4).
 */
export interface Appliance {
  /** Chosen by the Hub, and never given to another Appliance. */
  readonly id: number;
  readonly kind: ApplianceKind;
  /**
   * 1 to {@link APPLIANCE_NAME_MAX_LENGTH} characters, unique ignoring case
   * among Appliances of the same kind in the same Room (FR-8). The Remote
   * writes it as "Room · Name" (FR-9).
   */
  readonly name: string;
  /** The {@link Room} it is in, or `null` for "No room". */
  readonly roomId: number | null;
  /**
   * Its IP address on the home network. Empty for a Heating, a Radiator
   * Valve or the Hot Water, which the Hub reaches through Hive's cloud
   * (ADR 0010).
   */
  readonly address: string;
  readonly model: string;
  /**
   * For Wake-on-LAN (FR-14, FR-17), lower case. Empty for any Appliance but
   * a TV, which isn't woken so.
   */
  readonly macAddress: string;
  /**
   * An Air Conditioner's serial number, which says which unit it is, as a
   * {@link FoundAirConditioner} gives it, or, for a Heating, a Radiator
   * Valve or the Hot Water, its maker's id for it, so that signing in again
   * finds the same one (FR-67). Left out for a TV or a Light.
   */
  readonly serialNumber?: string;
  /**
   * `"pair-again"` once the Appliance has refused the Hub's stored credentials
   * (FR-13), until it is paired again. For an Air Conditioner, that is its
   * token and key, which the Remote offers to fetch again (FR-51); for a
   * Light, the key its maker issued it, as after it is paired again in its
   * maker's app.
   */
  readonly pairing: "paired" | "pair-again";
  /**
   * For a TV, its film Light Scene: the {@link LightScene} of its own Room
   * the Hub recalls as the Player starts a video on it, setting the Room's
   * Lights back as they were once the video stops (FR-57). Left out when it
   * has none, and for any other kind of Appliance.
   */
  readonly filmLightSceneId?: number;
}

export interface AddApplianceRequest {
  readonly kind: ApplianceKind;
  /** Its IP address. */
  readonly address: string;
  /** Left out or empty, the Appliance's own name is used (FR-14). */
  readonly name?: string;
  readonly roomId: number | null;
  /**
   * For an Air Conditioner that needs one, the owner's login to its maker's
   * cloud, to fetch its token and key with, once. Left out for any other.
   */
  readonly login?: CloudLogin;
  /** For a Light, what lets the Hub in to it. Left out for any other. */
  readonly light?: LightKeysGiven;
}

/**
 * What the person gives the Hub to control a Light with, from its maker's
 * app or a tool that reads it (FR-54): the key its maker issued it, and its
 * id, which the Hub hears from a Light it finds, so may be left out for one.
 * Both are secret: the Hub keeps them as the Light's credentials, and never
 * sends them back or logs them (FR-4).
 */
export interface LightKeysGiven {
  /** Left out, the Hub listens for the Light at the address, which says its id. */
  readonly id?: string;
  readonly key: string;
}

/** The longest Light id or key the Hub takes, in characters. */
export const LIGHT_KEYS_MAX_LENGTH = 64;

/**
 * What to change; anything left out stays as it is. A TV moved to another
 * Room loses a film Light Scene that isn't one of the new Room's.
 */
export interface UpdateApplianceRequest {
  readonly name?: string;
  readonly roomId?: number | null;
  /**
   * A TV's film Light Scene (FR-57), one of its own Room's, as it is once
   * moved by `roomId`, or `null` for none. The Hub refuses one of another
   * Room's, and any for a TV with no Room, with `400`, one deleted with
   * `409`, and any for an Appliance that isn't a TV with `400`.
   */
  readonly filmLightSceneId?: number | null;
}

/**
 * A key on the Remote's key pad for a TV (FR-18), named for the person, not
 * for any TV's protocol: each Driver turns it into its own brand's key.
 */
export type RemoteKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "ok"
  | "back"
  | "home"
  | "menu"
  | "tools"
  | "info"
  | "source"
  | "channel-up"
  | "channel-down"
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "play"
  | "pause"
  | "stop"
  | "rewind"
  | "fast-forward"
  | "volume-up"
  | "volume-down";

/**
 * `POST` a {@link KeyPressRequest} here to have the Hub press that key on the
 * Appliance, e.g. OK on a TV (FR-18). It answers `204` once the key is sent.
 * It refuses with `403` a key the Driver never sends, such as one that opens a
 * TV's service menu (FR-30), and with `409` when the Appliance no longer lets
 * the Hub in, which also marks it `"pair-again"` (FR-13).
 */
export const applianceKeysPath = (id: number): string => `${appliancePath(id)}/keys`;

export interface KeyPressRequest {
  readonly key: RemoteKey;
}

/**
 * The Appliance's own volume and mute (FR-19), read from it now, e.g. by a
 * TV's Driver:
 *
 * - `GET` answers with an {@link ApplianceVolume}. It says the volume is not
 *   known, rather than refusing, when the Appliance doesn't answer for it,
 *   e.g. a TV in standby.
 * - `PATCH` a {@link VolumeChange} sets the volume, the mute or both, then
 *   answers with the {@link ApplianceVolume} read back from the Appliance. It
 *   refuses with `502` when the Appliance doesn't answer for its volume.
 *
 * Volume up and down are keys ({@link applianceKeysPath}), which work even
 * when this doesn't.
 */
export const applianceVolumePath = (id: number): string => `${appliancePath(id)}/volume`;

/** The loudest an Appliance's volume goes, from 0 for silent. */
export const VOLUME_MAX = 100;

/**
 * The Appliance's volume, 0 to {@link VOLUME_MAX}, and whether it is muted, as
 * it says now; or `known: false` when it can't say, which the Remote shows as
 * not known rather than guessing (FR-25).
 */
export type ApplianceVolume =
  { readonly known: true; readonly volume: number; readonly muted: boolean } | { readonly known: false };

/** What to change; anything left out stays as it is. */
export interface VolumeChange {
  /** A whole number, 0 to {@link VOLUME_MAX}. */
  readonly volume?: number;
  readonly muted?: boolean;
}

/**
 * The Appliance's on-screen keyboard, such as the one a TV opens for a search
 * box (FR-20):
 *
 * - `GET` answers with an {@link ApplianceKeyboard}: whether it is open now,
 *   as the Appliance last said. It says it isn't, rather than refusing, when
 *   the Appliance can't be reached or needs pairing again.
 * - `POST` a {@link KeyboardText} types the text into it and submits it, as
 *   the keyboard's own Done key does, which closes it. It answers `204` once
 *   the text is sent. Like a key, it refuses with `409` when the Appliance no
 *   longer lets the Hub in, which also marks it `"pair-again"` (FR-13).
 */
export const applianceKeyboardPath = (id: number): string => `${appliancePath(id)}/keyboard`;

/** The most text sent to an on-screen keyboard at once, in characters. */
export const KEYBOARD_TEXT_MAX_LENGTH = 1_000;

export interface ApplianceKeyboard {
  readonly open: boolean;
}

export interface KeyboardText {
  /**
   * 1 to {@link KEYBOARD_TEXT_MAX_LENGTH} characters, in any script, sent
   * exactly as typed.
   */
  readonly text: string;
}

/**
 * The apps installed on the Appliance, e.g. a TV's YouTube and Netflix (FR-21):
 * `GET` answers with an {@link ApplianceApps}, read from the Appliance now. It
 * says why the apps aren't known, rather than refusing or answering with none,
 * when the Appliance is in standby or can't be reached. Like a key, it refuses
 * with `409` when the Appliance no longer lets the Hub in (FR-13), and it
 * doesn't ask one already marked `"pair-again"`.
 */
export const applianceAppsPath = (id: number): string => `${appliancePath(id)}/apps`;

/**
 * One app on the Appliance, by its {@link ApplianceApp.id}: `POST` here, with
 * no body, launches it, and `DELETE` closes it. Each answers `204` once the
 * Appliance has taken it, refuses with `400` an app it hasn't got, and with
 * `502` when it doesn't answer for its apps, e.g. a TV in standby.
 */
export const applianceAppPath = (id: number, appId: string): string =>
  `${applianceAppsPath(id)}/${encodeURIComponent(appId)}`;

/**
 * `GET` here for the app's icon, as the Appliance gives it, as an image, for
 * an app whose {@link ApplianceApp.icon} is true. It answers `404` when the
 * Appliance gives none after all.
 */
export const applianceAppIconPath = (id: number, appId: string): string => `${applianceAppPath(id, appId)}/icon`;

/** The most characters an {@link ApplianceApp.id} has. */
export const APP_ID_MAX_LENGTH = 100;

/** An app installed on an Appliance. */
export interface ApplianceApp {
  /**
   * The Appliance's own id for it, of letters, digits, `.`, `_` and `-`, with
   * at least one letter or digit, up to {@link APP_ID_MAX_LENGTH} characters.
   */
  readonly id: string;
  /** Its name, as the Appliance gives it, e.g. "YouTube". */
  readonly name: string;
  /** Whether the Appliance gives an icon for it, at {@link applianceAppIconPath}. */
  readonly icon: boolean;
}

/**
 * The Appliance's installed apps, in name order; or `known: false` when it
 * can't say, because it is in standby or isn't answering, which the Remote
 * shows rather than an empty list.
 */
export type ApplianceApps =
  | { readonly known: true; readonly apps: readonly ApplianceApp[] }
  | { readonly known: false; readonly why: "standby" | "unreachable" };

/**
 * A one-tap shortcut in TV Menu mode that opens or cycles one of the TV's own
 * settings (FR-24), named for the person, not for any TV's protocol: each
 * Driver turns it into its own brand's key, which not every model or firmware
 * acts on.
 */
export type MenuShortcut =
  | "picture-mode"
  | "picture-size"
  | "sleep-timer"
  | "energy-saving"
  | "captions"
  | "audio-description"
  | "audio-track"
  | "input-source";

/**
 * `POST` a {@link ShortcutRequest} here to have the Hub press the shortcut's
 * key on the Appliance (FR-24). It answers `200` as soon as the key is sent,
 * so that a key pressed next waits no longer than it would after any other
 * key, then listens a moment for the Appliance to say it ignored it before
 * sending the {@link ShortcutOutcome} as the body. It refuses as
 * {@link applianceKeysPath} does: `400` for a shortcut the Driver hasn't got,
 * `403` for a key it never sends (FR-30), and `409` when the Appliance no
 * longer lets the Hub in (FR-13).
 */
export const applianceShortcutsPath = (id: number): string => `${appliancePath(id)}/shortcuts`;

export interface ShortcutRequest {
  readonly shortcut: MenuShortcut;
}

/**
 * What the Appliance said of a shortcut's key: `"ignored"` when it said it
 * didn't take it, or `"unconfirmed"` when it said nothing, which doesn't mean
 * it acted on it, as a TV acknowledges no key. Neither says what the setting
 * is now, which the Hub can't read (FR-25).
 */
export interface ShortcutOutcome {
  readonly outcome: "ignored" | "unconfirmed";
}

/**
 * Now Showing (FR-26): `GET` answers with a {@link NowShowing}, what the Hub
 * can tell, now, of what the Appliance is displaying, e.g. the app in front on
 * a TV, as the TV's own app status says. It says why it can't tell, rather
 * than refusing or guessing, when the Appliance is in standby, can't be
 * reached, or doesn't say. When the app in front is the Player, it says
 * what that plays too (FR-27). Like {@link applianceAppsPath}, it refuses with
 * `409` when the Appliance no longer lets the Hub in (FR-13), and it doesn't
 * ask one already marked `"pair-again"`. It never changes anything on the
 * Appliance, so the Remote may ask whenever it shows it.
 */
export const applianceNowShowingPath = (id: number): string => `${appliancePath(id)}/now-showing`;

/**
 * The app in front on the Appliance, as one of its {@link ApplianceApp}s, with
 * its icon at {@link applianceAppIconPath}; or `known: false` with why not:
 * `"standby"` or `"unreachable"` as for {@link ApplianceApps}, or
 * `"cannot-tell"` when it is on but none of its apps says it is in front,
 * as may be so of live TV or another input, or more than one says so. The
 * Remote shows that rather than guessing (FR-25).
 */
export type NowShowing =
  | {
      readonly known: true;
      readonly app: ApplianceApp;
      /**
       * Only when the app in front is the Player (FR-27): what it plays, as
       * {@link appliancePlaybackPath} says, or null while it plays nothing.
       */
      readonly nowPlaying?: NowPlaying | null;
    }
  | { readonly known: false; readonly why: "standby" | "unreachable" | "cannot-tell" };

/**
 * The Appliance's device info, as it reports it now (FR-28): `GET` answers
 * with an {@link ApplianceDeviceInfo}. A TV reports it without pairing, in
 * standby too, so this asks nothing of a TV marked `"pair-again"`, and says
 * why it can't, rather than refusing, when the Appliance doesn't answer. It
 * never changes anything on the Appliance, so the Remote may ask whenever it
 * shows it.
 */
export const applianceDeviceInfoPath = (id: number): string => `${appliancePath(id)}/device-info`;

/** How an Appliance is connected to the home network. */
export type NetworkType = "wireless" | "wired";

/**
 * Whether a TV is in Developer Mode, which lets the Hub install the Player on
 * it, and the Developer IP it lets do that (FR-28, FR-29).
 */
export interface DeveloperSettings {
  readonly mode: "on" | "off";
  /** The IP address the TV lets install apps on it, or null when none is set. */
  readonly ip: string | null;
}

/** What an Appliance reports about itself (FR-28). */
export interface DeviceInfo {
  /** Its own name, which may not be the name the Hub gives it (FR-14). */
  readonly name: string;
  readonly model: string;
  /** Lower case. */
  readonly macAddress: string;
  /** Or null when it doesn't say in a way the Hub knows. */
  readonly networkType: NetworkType | null;
  /** Whether it is a Frame TV. */
  readonly frame: boolean;
  /**
   * Its Developer Mode and Developer IP, or null when it doesn't report them,
   * as some firmware doesn't. The Remote says so rather than guessing (FR-25).
   */
  readonly developer: DeveloperSettings | null;
}

/**
 * The Appliance's {@link DeviceInfo}; or `known: false` when it isn't
 * answering, e.g. switched off at the wall.
 */
export type ApplianceDeviceInfo =
  { readonly known: true; readonly info: DeviceInfo } | { readonly known: false; readonly why: "unreachable" };

/**
 * The Hub's own IP address on the home network, which a TV is given as its
 * Developer IP (FR-29):
 *
 * - `GET` answers with a {@link HubAddress}.
 * - `PUT` a {@link HubAddressRequest} sets the address to use instead of the
 *   one the Hub finds, or with `null` goes back to that one, and answers with
 *   the {@link HubAddress}. It is kept with the rest of the Hub's state (FR-3).
 */
export const HUB_ADDRESS_PATH = `${HUB_INFO_PATH}/address`;

export interface HubAddress {
  /** The address to use: {@link override} if set, otherwise {@link found}; null when neither is. */
  readonly address: string | null;
  /**
   * The IPv4 address the Hub finds on its own network interfaces, preferring
   * the home network's to a virtual one's, e.g. Docker's own; or null when it
   * finds none.
   */
  readonly found: string | null;
  /** The IPv4 address set in Settings to use instead, or null. */
  readonly override: string | null;
}

export interface HubAddressRequest {
  /** An IPv4 address, or null to use the one the Hub finds. */
  readonly override: string | null;
}

/**
 * The owner's Samsung signing certificate, which the Hub signs the Player
 * with to install it on a TV (FR-31). It is kept with the rest of the Hub's
 * state (FR-3), and it and its passwords are never answered nor logged
 * (FR-4): the Hub says only whether it has one.
 *
 * - `GET` answers with a {@link SigningCertificateStatus}.
 * - `PUT` a {@link SigningCertificateRequest} stores it, in place of any it
 *   had, and answers with the {@link SigningCertificateStatus}.
 * - `DELETE` removes it, and answers with the {@link SigningCertificateStatus}.
 */
export const SIGNING_CERTIFICATE_PATH = `${HUB_INFO_PATH}/signing-certificate`;

/** The longest certificate file the Hub takes; a real one is a few kilobytes. */
export const SIGNING_CERTIFICATE_MAX_BYTES = 32 * 1024;

/** The longest password the Hub takes for either half of a signing certificate. */
export const SIGNING_PASSWORD_MAX_LENGTH = 256;

export interface SigningCertificateStatus {
  /** Whether the Hub has a signing certificate. */
  readonly stored: boolean;
  /** When it was stored, as an ISO 8601 time, or null when it has none. */
  readonly storedAt: string | null;
}

/**
 * A Samsung TV signing certificate's two halves, each a `.p12` file as Tizen
 * Studio's Certificate Manager made it, in base64: the author certificate,
 * which says who wrote the Player, and the distributor certificate, which
 * lists the TVs it may be installed on.
 */
export interface SigningCertificateRequest {
  readonly author: string;
  readonly authorPassword: string;
  readonly distributor: string;
  /** Left out, or null, when it is the author certificate's. */
  readonly distributorPassword?: string | null;
}

/**
 * Where the Hub keeps the Media Sources, the folders whose Media Files it
 * serves (FR-32):
 *
 * - `GET` answers with every {@link MediaSource}, in name order.
 * - `POST` an {@link AddMediaSourceRequest} adds one, and answers `201` with
 *   it. It refuses a path that isn't a folder the Hub can read now.
 */
export const MEDIA_SOURCES_PATH = "/api/media-sources";

/**
 * One Media Source, at `${MEDIA_SOURCES_PATH}/<id>`: `PATCH` a
 * {@link MediaSourceNameRequest} renames it and answers with it; `DELETE`
 * removes it and answers `204`. Removing one never touches its files.
 */
export const mediaSourcePath = (id: number): string => `${MEDIA_SOURCES_PATH}/${String(id)}`;

/** The query parameter of {@link mediaFolderPath} that names the TV whose Routes to say. */
export const MEDIA_FOLDER_TV_KEY = "tv";

/**
 * `GET` here for a {@link MediaFolder}: one folder of the Media Source, by its
 * path inside it, `""` for the Media Source's own folder, e.g. `"Films/Sci-Fi"`
 * (FR-33). The Hub refuses with `403` any path that leads outside the Media
 * Source, whether through `..`, a symlink or an encoded path (FR-5). Given a
 * TV's id, as `?tv=<id>`, it says each Media File's {@link Route} to that TV
 * (FR-34).
 */
export const mediaFolderPath = (id: number, folder: string, tvId?: number): string =>
  [
    `${mediaSourcePath(id)}/folder`,
    ...folder
      .split("/")
      .filter((name) => name !== "")
      .map(encodeURIComponent),
  ].join("/") + (tvId === undefined ? "" : `?${MEDIA_FOLDER_TV_KEY}=${String(tvId)}`);

/**
 * One Media File of the Media Source, by its path inside it, e.g.
 * `"Films/Sci-Fi/Arrival.mkv"`: `GET` serves it unchanged, the Direct Play
 * Route (FR-41), answering a range request with `206` and that part of it,
 * as a player seeking asks (ADR 0002). It is the URL the Hub sends the Player.
 * As for {@link mediaFolderPath}, the Hub refuses with `403` any path that
 * leads outside the Media Source, and serves Media Files only: not a folder,
 * a hidden file or any other file (FR-5).
 */
export const mediaFilePath = (id: number, file: string): string =>
  [
    `${mediaSourcePath(id)}/file`,
    ...file
      .split("/")
      .filter((name) => name !== "")
      .map(encodeURIComponent),
  ].join("/");

/**
 * The cover art embedded in one audio Media File of the Media Source, by its
 * path inside it, as for {@link mediaFilePath} (FR-47): `GET` answers with it
 * as a JPEG, which the Hub takes out of the file itself with ffmpeg, scaled
 * down to fit a TV's screen, or `404` when the file has none. It refuses as
 * {@link mediaFilePath} does anything that leads outside the Media Source
 * (FR-5). It is the {@link MusicDetails.coverArt} the Player's now-playing
 * screen and Now Showing show.
 */
export const mediaCoverArtPath = (id: number, file: string): string =>
  [
    `${mediaSourcePath(id)}/cover-art`,
    ...file
      .split("/")
      .filter((name) => name !== "")
      .map(encodeURIComponent),
  ].join("/");

/**
 * `GET` here for the {@link MediaResumePosition} of one Media File of the
 * Media Source, by its path inside it, as for {@link mediaFilePath} (FR-40).
 * It reads only what the Hub has recorded, not the file.
 */
export const mediaResumePositionPath = (id: number, file: string): string =>
  [
    `${mediaSourcePath(id)}/resume-position`,
    ...file
      .split("/")
      .filter((name) => name !== "")
      .map(encodeURIComponent),
  ].join("/");

/**
 * The subtitle formats the Hub serves a subtitle track in (FR-45), by
 * ffmpeg's names for them: SubRip (`.srt`) and WebVTT (`.vtt`), which the
 * Player renders itself.
 */
export type SubtitleFormat = "subrip" | "webvtt";

/** The query parameters of {@link mediaSubtitlePath}. */
export const MEDIA_SUBTITLE_KEYS = { stream: "stream", sidecar: "sidecar", format: "format" } as const;

/**
 * Which of a Media File's subtitle tracks: the stream at `stream`, its index
 * in the Media File as ffprobe says, or the sidecar file beside it named
 * `sidecar`, e.g. `"Film.en.srt"`.
 */
export type SubtitleSource = { readonly stream: number } | { readonly sidecar: string };

/**
 * `GET` here for one subtitle track of one Media File of the Media Source, by
 * its path inside it, as for {@link mediaFilePath}, in `format` (FR-44,
 * FR-45): a sidecar file in that format as it is; anything else converted to
 * it with ffmpeg, such as an `.ass`, or a text track taken out of the Media
 * File. It is one of the URLs the Hub sends the Player with the Media File,
 * whatever its Route, as the Player shows subtitles itself. The Hub refuses
 * with `404` a stream that isn't a text subtitle track of the Media File, and
 * a sidecar that isn't one of its own, and as {@link mediaFilePath} does,
 * anything that leads outside the Media Source (FR-5).
 */
export const mediaSubtitlePath = (id: number, file: string, source: SubtitleSource, format: SubtitleFormat): string => {
  const track =
    "stream" in source
      ? `${MEDIA_SUBTITLE_KEYS.stream}=${String(source.stream)}`
      : `${MEDIA_SUBTITLE_KEYS.sidecar}=${encodeURIComponent(source.sidecar)}`;
  return `${[
    `${mediaSourcePath(id)}/subtitle`,
    ...file
      .split("/")
      .filter((name) => name !== "")
      .map(encodeURIComponent),
  ].join("/")}?${track}&${MEDIA_SUBTITLE_KEYS.format}=${format}`;
};

/**
 * A Media File played to within this much of its length is treated as
 * finished, and its Resume Position is cleared (FR-40): its last 5%.
 */
export const RESUME_FINISHED_FRACTION = 0.95;

/**
 * How far into a Media File playback last reached, as the Hub recorded it
 * from what the Player reported, on whichever TV (FR-40).
 */
export interface MediaResumePosition {
  /** In milliseconds, or null when it has none: never played, or played to within its last 5%. */
  readonly positionMs: number | null;
}

/** The longest a Media Source's name may be, in characters. */
export const MEDIA_SOURCE_NAME_MAX_LENGTH = 40;

/**
 * A folder, on the Hub's machine or mounted into it from a PC or NAS, whose
 * Media Files the Hub can serve.
 */
export interface MediaSource {
  /** Chosen by the Hub, and never given to another Media Source. */
  readonly id: number;
  /** 1 to {@link MEDIA_SOURCE_NAME_MAX_LENGTH} characters, unique ignoring case. */
  readonly name: string;
  /** The folder's full path, as the Hub sees it, e.g. inside its container. */
  readonly path: string;
}

export interface AddMediaSourceRequest {
  /** Left out or empty, the folder's own name is used. */
  readonly name?: string;
  /** The folder's full path, as the Hub sees it. */
  readonly path: string;
}

export interface MediaSourceNameRequest {
  readonly name: string;
}

/** Whether a Media File is a video or audio, as its file name says. */
export type MediaKind = "video" | "audio";

/**
 * One of the four ways a Media File reaches the Player, which the Hub chooses
 * before each play, the cheapest that works on the TV (FR-41, ADR 0006):
 *
 * - `direct-play`: the file is served unchanged, with range requests.
 * - `remux`: the container changes and the streams are copied, streamed as HLS.
 * - `audio-conversion`: only the audio is re-encoded, streamed as HLS.
 * - `full-conversion`: the video is re-encoded too, which uses a lot of the
 *   Hub's CPU (FR-34), streamed as HLS.
 */
export type Route = "direct-play" | "remux" | "audio-conversion" | "full-conversion";

/** A video or audio file in a Media Source. */
export interface MediaFile {
  /** Its file name. */
  readonly name: string;
  readonly kind: MediaKind;
  /** In bytes. */
  readonly size: number;
  /** In seconds, as ffprobe says; or null when ffprobe can't tell. */
  readonly duration: number | null;
  /**
   * The {@link Route} it takes to the TV the folder was asked for with (see
   * {@link mediaFolderPath}), or null when none was, or the Hub can't tell,
   * as when ffprobe can't read it.
   */
  readonly route: Route | null;
}

/**
 * One folder of a Media Source: the folders and Media Files in it, each in
 * name order. Other files, and hidden ones, are left out.
 */
export interface MediaFolder {
  readonly mediaSourceId: number;
  /** Its path inside the Media Source, `""` for the Media Source's own folder. */
  readonly path: string;
  /** The names of the folders in it. */
  readonly folders: readonly string[];
  readonly files: readonly MediaFile[];
}

/**
 * The Player's app id on a TV, which the Hub launches it by (FR-35) and the
 * Player's Tizen manifest declares: a Tizen package id of 10 letters and
 * digits, a dot, and the app's own name.
 */
export const PLAYER_APP_ID = "MediaCntre.Player";

/**
 * The launch parameter that gives the Player the Hub's address (FR-35), which
 * it remembers (FR-39). The Hub passes {@link playerLaunchParameter} as the
 * TV's deep link data.
 */
export const PLAYER_LAUNCH_HUB_KEY = "hub";

/**
 * What the Hub launches the Player with: `hub=<address>`, where the address
 * is the Hub's `host:port` as the TV reaches it, e.g. `192.168.1.10:41080`.
 */
export const playerLaunchParameter = (hubAddress: string): string =>
  `${PLAYER_LAUNCH_HUB_KEY}=${encodeURIComponent(hubAddress)}`;

/**
 * Where a Player opens its WebSocket to the Hub (ADR 0003), which it keeps
 * open, opening it again whenever it drops. The Hub knows which TV a Player is
 * on by the address it connects from, which is that TV's. The Hub sends it
 * {@link HubToPlayerMessage}s, as JSON.
 */
export const PLAYER_SOCKET_PATH = "/api/player";

/**
 * How often the Hub sends each Player a heartbeat. A Player that hears
 * nothing for three of these takes its connection for dropped, as one can
 * without closing, e.g. when the Hub's machine loses power.
 */
export const PLAYER_HEARTBEAT_MS = 10_000;

/**
 * - `heartbeat`: sent every {@link PLAYER_HEARTBEAT_MS}.
 * - `play`: play the Media File at `url`, from `positionMs` into it, 0 for
 *   the start, in place of anything playing (FR-35, FR-40). It is the Hub's
 *   own, at the address the Hub launched the Player with: a
 *   {@link mediaFilePath} for Direct Play, or a {@link streamPlaylistPath}
 *   for any other {@link Route}. `subtitles` has the URL of each of its
 *   subtitle tracks, a {@link mediaSubtitlePath} at that address, in the order
 *   of {@link NowPlaying.subtitleTracks}, none of them shown until the Hub
 *   asks (FR-44), and `""` in place of each the Hub burns into the picture
 *   instead (FR-45). A Hub older than the Player leaves it out. `audioTrack`
 *   and `subtitleTrack`, when there, are the audio track to play and the
 *   subtitle track to show from the start, by their places as for a
 *   `control`, as when the Hub sends the Media File again from where it is,
 *   by another Route, to burn a subtitle track in or no longer (FR-45),
 *   keeping what was chosen. `music`, for an audio Media File, is what its
 *   now-playing screen shows (FR-47), its cover art at the Hub's address the
 *   Player was launched with; it is left out for a video, and by a Hub older
 *   than the Player.
 * - `control`: do this to what is playing (FR-36), as the Remote's
 *   now-playing bar asked.
 * - `resumable`: what the Player's waiting screen offers to resume (FR-39),
 *   or null for nothing. The Hub sends it whenever the Player says it plays
 *   nothing, as when it connects and once it stops.
 */
export type HubToPlayerMessage =
  | { readonly type: "heartbeat" }
  | {
      readonly type: "play";
      readonly url: string;
      readonly positionMs: number;
      readonly subtitles?: readonly string[];
      readonly audioTrack?: number;
      readonly subtitleTrack?: number | null;
      readonly music?: MusicDetails;
    }
  | { readonly type: "control"; readonly control: PlaybackControl }
  | { readonly type: "resumable"; readonly resumable: ResumableMediaFile | null };

/**
 * The Media File whose Resume Position the Hub recorded last, on any TV,
 * which the Player's waiting screen offers to resume (FR-39, FR-40).
 */
export interface ResumableMediaFile {
  readonly mediaSourceId: number;
  /** Its path inside the Media Source, e.g. `"Films/Sci-Fi/Arrival.mkv"`. */
  readonly path: string;
  /** Its file name, e.g. "Arrival.mkv". */
  readonly name: string;
  /** Its Resume Position, in milliseconds. */
  readonly positionMs: number;
}

/**
 * What can be done to what a Player is playing (FR-36, FR-37), from the
 * Remote's now-playing bar or the TV's own remote:
 *
 * - `play` and `pause`.
 * - `seek`: move to `positionMs` from the start.
 * - `skip`: move `byMs` from where it is, back when negative, e.g. one of
 *   {@link PLAYBACK_SKIPS_MS}. The Player skips from its own position, which
 *   the Remote only knows as of the Player's last report.
 * - `stop`: stop and unload, so the Player shows its waiting screen again.
 * - `audio-track`: play the Media File's audio track at `track`, its place
 *   among {@link NowPlaying.audioTracks}, from where it is (FR-36).
 * - `subtitle-track`: show the Media File's subtitle track at `track`, its
 *   place among {@link NowPlaying.subtitleTracks}, or none, "Off", for null
 *   (FR-36, FR-44). One the Hub burns into the picture (FR-45) it shows by
 *   sending the Player the Media File again, from where it is, by Full
 *   Conversion, with it burned in; and once one is, "Off" or a text track
 *   by sending it again by the Route it takes without, with that track.
 *
 * A seek or skip past either end stops at that end.
 */
export type PlaybackControl =
  | { readonly action: "play" }
  | { readonly action: "pause" }
  | { readonly action: "seek"; readonly positionMs: number }
  | { readonly action: "skip"; readonly byMs: number }
  | { readonly action: "stop" }
  | { readonly action: "audio-track"; readonly track: number }
  | { readonly action: "subtitle-track"; readonly track: number | null };

/** The now-playing bar's skips (FR-36): back 30 and 10 seconds, and forward 10 and 30. */
export const PLAYBACK_SKIPS_MS: readonly number[] = [-30_000, -10_000, 10_000, 30_000];

/**
 * What a Player's playback is doing, as it last said:
 *
 * - `idle`: playing nothing, and showing its waiting screen.
 * - `loading`: opening a Media File.
 * - `paused`: loaded, and paused or not yet started.
 * - `playing`.
 */
export type PlaybackState = "idle" | "loading" | "paused" | "playing";

/** What a Player tells the Hub of its playback (FR-36). */
export interface PlayerPlayback {
  readonly state: PlaybackState;
  /** The URL of the Media File it has, as the Hub sent it, or null while idle. */
  readonly url: string | null;
  /** How far into it, in milliseconds. */
  readonly positionMs: number;
  /** Its length, in milliseconds, or null while it doesn't say, e.g. as it loads. */
  readonly durationMs: number | null;
  /**
   * The audio track it plays, by its place among the Media File's audio
   * tracks, in the order they are in the file, which is the order they are in
   * the Hub's stream of it too; or null while it doesn't say, e.g. as it loads.
   */
  readonly audioTrack: number | null;
  /**
   * The subtitle track it shows, by its place among those the Hub sent it
   * with the Media File, or null for none, "Off". A Player older than the
   * Hub leaves it out, and shows none.
   */
  readonly subtitleTrack?: number | null;
}

/**
 * - `playback`: what its playback is doing now. A Player sends it as it
 *   connects, whenever its playback changes state, every second or so as it
 *   plays, and once it has done each `control` it was sent, even if that
 *   changed nothing. The Hub records each Media File's Resume Position from
 *   it (FR-40).
 * - `resume`: play this Media File from its Resume Position, as the waiting
 *   screen's "Resume" button asks (FR-39), which the Hub answers with
 *   `play`, from the start if it has none by then.
 * - `ended`: the Media File at `url`, as the Hub sent it, has played to its
 *   end, sent just after the `playback` that says it plays nothing. The Hub
 *   answers with `play` for the next Media File of the {@link Queue} it
 *   was the current one of, if any (FR-48).
 */
export type PlayerToHubMessage =
  | { readonly type: "playback"; readonly playback: PlayerPlayback }
  | { readonly type: "resume"; readonly mediaSourceId: number; readonly path: string }
  | { readonly type: "ended"; readonly url: string };

/**
 * Whether the Player is running on the Appliance, a TV, and connected to the
 * Hub (ADR 0003): `GET` answers with an {@link AppliancePlayer}.
 */
export const appliancePlayerPath = (id: number): string => `${appliancePath(id)}/player`;

export interface AppliancePlayer {
  readonly connected: boolean;
}

/**
 * What the Player on the Appliance, a TV, is playing, for the Remote's
 * now-playing bar (FR-36), as the Player last told the Hub (ADR 0003), so
 * that every Remote on that TV sees the same:
 *
 * - `GET` answers with an {@link AppliancePlayback}. It never asks anything
 *   of the TV, so the Remote may ask as often as it shows the bar.
 * - `POST` a {@link PlaybackControl} has the Hub send it to the Player, and
 *   answers with the {@link AppliancePlayback} the Player reports once it has
 *   done it, or as it last reported if it says nothing for a few seconds. It
 *   refuses with `409` when nothing is playing there, and with `400` an
 *   `audio-track` or `subtitle-track` the Media File hasn't got. A
 *   `subtitle-track` that changes the Route, to burn a subtitle track in or
 *   no longer (FR-45), it refuses as playing the Media File is refused, as
 *   it plays it again.
 */
export const appliancePlaybackPath = (id: number): string => `${appliancePath(id)}/playback`;

/** One audio track of a Media File, as ffprobe says. */
export interface AudioTrack {
  /**
   * Its language, as the file tags it: an ISO 639-2 code such as "eng", or,
   * less often, an ISO 639-1 one such as "en". Null when the file doesn't
   * say, or says "und", undetermined.
   */
  readonly language: string | null;
  /** The name the file gives it, e.g. "Director's commentary", or null for none. */
  readonly title: string | null;
  /** Its codec, by ffprobe's name for it, e.g. "dts" or "ac3": the file's, whatever the Route converts it to. */
  readonly codec: string;
  /** How many channels it has, e.g. 6 for 5.1, or null when ffprobe doesn't say. */
  readonly channels: number | null;
}

/**
 * One subtitle track of a Media File (FR-44): one of its own streams, as
 * ffprobe says, or a sidecar file beside it, e.g. `Film.en.srt` beside
 * `Film.mkv`. Its own image subtitles, such as PGS or VobSub, which the TV
 * can't render, are listed too, as the Hub burns them into the picture to
 * show them (FR-45).
 */
export interface SubtitleTrack {
  /**
   * Its language: as the Media File tags its own, an ISO 639-2 code such as
   * "eng", or less often an ISO 639-1 one such as "en"; or as a sidecar's
   * name says, e.g. "en" for `Film.en.srt`. Null when neither says, or the
   * file says "und", undetermined.
   */
  readonly language: string | null;
  /** The name the file gives it, e.g. "Signs", or what else a sidecar's name says, e.g. "forced" for `Film.en.forced.srt`; or null. */
  readonly title: string | null;
  /** Its format, by ffmpeg's name for it, e.g. "subrip", "webvtt" or "ass": the file's, whatever the Hub converts it to. */
  readonly codec: string;
  /** The sidecar file's name, e.g. "Film.en.srt", or null for one of the Media File's own streams. */
  readonly sidecar: string | null;
  /**
   * Whether it is image subtitles the TV can't render, e.g. "hdmv_pgs_subtitle"
   * (PGS) or "dvd_subtitle" (VobSub), which the Hub burns into the picture to
   * show, by the Full Conversion Route, which uses a lot of its CPU (FR-45).
   */
  readonly burnedIn: boolean;
}

/** A Media File a Player is playing, or loading, as it last said. */
export interface NowPlaying {
  /** The Media File's file name, e.g. "Arrival.mkv". */
  readonly name: string;
  /**
   * The {@link Route} the Hub sent it to the Player by, or null when the Hub
   * didn't, as for one the Player was playing before the Hub restarted.
   */
  readonly route: Route | null;
  readonly state: Exclude<PlaybackState, "idle">;
  /** How far into it, in milliseconds. */
  readonly positionMs: number;
  /** Its length, in milliseconds, or null while the Player doesn't say. */
  readonly durationMs: number | null;
  /**
   * Every audio track of the Media File, in the order they are in the file,
   * as the Hub probed it before sending it the Player (FR-36); empty when the
   * Hub didn't, as for one the Player was playing before the Hub restarted.
   */
  readonly audioTracks: readonly AudioTrack[];
  /** The one of {@link audioTracks} the Player plays, by its place among them, or null while it doesn't say. */
  readonly audioTrack: number | null;
  /**
   * Every subtitle track of the Media File, its own in the order they are in
   * it, then its sidecar files, by name, as the Hub found them before sending
   * it the Player (FR-36, FR-44); empty when it has none, or the Hub didn't,
   * as for one the Player was playing before the Hub restarted.
   */
  readonly subtitleTracks: readonly SubtitleTrack[];
  /**
   * The one of {@link subtitleTracks} shown, by its place among them, or null
   * for none, "Off": the one the Player shows, or the one the Hub burned into
   * the picture (FR-45).
   */
  readonly subtitleTrack: number | null;
  /**
   * The preview picture Now Showing shows of it (FR-27), a frame of the
   * Media File itself, at {@link appliancePreviewPath}; or null for one with
   * no video, or the Hub didn't send it, as for one the Player was playing
   * before the Hub restarted.
   */
  readonly preview: PreviewPicture | null;
  /**
   * What an audio Media File's tags say of it, and its cover art, which Now
   * Showing shows (FR-27), as the Player's now-playing screen does (FR-47);
   * or null for a video, or one the Hub didn't send, as for one the Player
   * was playing before the Hub restarted. Its cover art is a path at the Hub.
   */
  readonly music: MusicDetails | null;
  /**
   * The Queue the TV plays, which this is the current Media File of (FR-48),
   * or null when it plays a Media File on its own.
   */
  readonly queue: Queue | null;
}

/**
 * Whether a {@link Queue} plays its Media Files again (FR-48):
 *
 * - `off`: it ends after its last Media File.
 * - `one`: it plays the current Media File again at its end, until next or
 *   previous moves on.
 * - `all`: it starts again from its first Media File after its last.
 */
export type QueueRepeat = "off" | "one" | "all";

/**
 * The ordered Media Files a TV plays one after another, as when a folder is
 * played (FR-46, FR-48). The Hub holds it, one per TV, so every Remote sees
 * the same, and sends the Player the next Media File itself at the end of
 * each. It is kept only as long as the Hub runs.
 */
export interface Queue {
  readonly mediaSourceId: number;
  /** The folder it plays, by its path inside the Media Source, `""` for the Media Source's own. */
  readonly folder: string;
  /**
   * The file names of its Media Files, all directly in {@link folder}, in the
   * order they play: file-name order, or, once shuffled, those after the
   * current Media File in a random order.
   */
  readonly mediaFiles: readonly string[];
  /** The place among {@link mediaFiles} of the one the Player plays. */
  readonly current: number;
  /** Whether the rest of it has been shuffled. */
  readonly shuffle: boolean;
  readonly repeat: QueueRepeat;
}

/**
 * What can be done to the {@link Queue} a TV plays, from the Remote (FR-48):
 *
 * - `next`: play the Media File after the current one, from its start; after
 *   the last, the first, if it repeats all.
 * - `previous`: play the one before it, from its start; before the first,
 *   the last, if it repeats all.
 * - `shuffle`: with `shuffle: true`, put the Media Files after the current
 *   one in a random order, the current one playing on; with `false`, back in
 *   file-name order, the current one playing on where it is in it.
 * - `repeat`: repeat as {@link QueueRepeat} says.
 */
export type QueueControl =
  | { readonly action: "next" }
  | { readonly action: "previous" }
  | { readonly action: "shuffle"; readonly shuffle: boolean }
  | { readonly action: "repeat"; readonly repeat: QueueRepeat };

/**
 * `POST` a {@link QueueControl} here to change the {@link Queue} the
 * Appliance, a TV, plays (FR-48). It answers with the {@link AppliancePlayback}
 * once the Player has started the Media File it moved to, if it moved, as a
 * {@link PlaybackControl} is answered. It refuses with `409` when the TV
 * plays no Queue, and a `next` or `previous` past either end of one that
 * doesn't repeat all; and a Media File it moves to as playing it is refused.
 */
export const applianceQueuePath = (id: number): string => `${appliancePath(id)}/queue`;

/**
 * What an audio Media File's own tags say of it, as ffprobe reads them, and
 * where its cover art is (FR-47): what the Player's now-playing screen shows
 * while it plays, and Now Showing too (FR-27). There is no music library
 * behind it, nor anything looked up elsewhere; only the file.
 */
export interface MusicDetails {
  /** Its title, as its tags say, or its file name when they don't, e.g. "01 Tone.flac". */
  readonly title: string;
  /** Its artist, as its tags say, or its album's artist when only that is tagged; or null for neither. */
  readonly artist: string | null;
  /** Its album, as its tags say, or null. */
  readonly album: string | null;
  /**
   * The URL of the cover art embedded in it, a {@link mediaCoverArtPath} at
   * the Hub, or null when it has none, for which a placeholder is shown.
   */
  readonly coverArt: string | null;
}

/**
 * A preview picture of a video Media File as it plays (FR-27): the frame at
 * a position, which the Hub extracts from the Media File itself with ffmpeg,
 * never a capture of the TV's screen. The Hub moves it to where the Player
 * is every {@link PREVIEW_REFRESH_MS} while it plays, and at once when it
 * seeks; while it is paused, the picture holds still.
 */
export interface PreviewPicture {
  /** Where in the Media File the frame is, in milliseconds. */
  readonly positionMs: number;
}

/** How often the preview picture moves to where the Player is, while it plays: every 5 seconds (FR-27). */
export const PREVIEW_REFRESH_MS = 5_000;

/**
 * The preview picture of what the Player on the Appliance, a TV, plays now
 * (FR-27): `GET` answers with it as a JPEG, or `404` when there is none, as
 * {@link NowPlaying.preview} says. The Hub extracts each frame the first time
 * it is asked for it, and only once, so the Remote may ask whenever
 * {@link PreviewPicture.positionMs} changes, e.g. with it in the query, so
 * that the browser asks again only then.
 */
export const appliancePreviewPath = (id: number): string => `${appliancePath(id)}/preview`;

export interface AppliancePlayback {
  /** Null when no Player is connected there, or it plays nothing. */
  readonly nowPlaying: NowPlaying | null;
}

/**
 * `POST` a {@link PlayRequest} here to play that Media File on the Appliance,
 * a TV (FR-35, ADR 0003), or a {@link PlayFolderRequest} to play a folder's
 * audio Media Files as a {@link Queue}, which starts with the first of them
 * (FR-46). Playing one Media File on its own ends any Queue the TV had. The Hub wakes the TV if it is off, waiting up to
 * {@link PLAY_WAKE_TIMEOUT_MS} for it to come on; launches the Player with the
 * Hub's address; waits for the Player to connect to the Hub; and sends it the
 * Media File's URL, with where to start: its Resume Position when the
 * request asks to resume, otherwise the start (FR-40). It probes the Media
 * File with ffprobe first, to choose its {@link Route} to the TV (FR-41).
 *
 * It refuses, as other requests are refused, before it starts: `404` for a
 * TV or Media File that isn't there, `403` for a path outside the Media
 * Source (FR-5), `409` for a TV that no longer lets the Hub in (FR-13), a
 * Hub that doesn't know its own address, or a Media File it must stream but
 * can't tell the length of; and a folder with no audio Media Files in it. Once it has started it answers `200`
 * at once, then sends each {@link PlayProgress} as it happens, one JSON
 * object per line (`application/x-ndjson`), ending with `"sent"` or
 * `"failed"`.
 */
export const appliancePlayPath = (id: number): string => `${appliancePath(id)}/play`;

/**
 * Where the Hub streams a Media File to a Player as HLS, for every {@link Route}
 * but Direct Play (FR-42, ADR 0006). Each stream is the Hub's for one play on
 * one TV, by an id it chose, and ends once that Player stops or disconnects.
 */
export const STREAMS_PATH = "/api/streams";

/**
 * A stream's HLS playlist, the URL the Hub sends the Player: `GET` answers
 * with the whole of the Media File's length, as segments of a few seconds
 * each, so that the Player can seek anywhere in it, even where the Hub has
 * not produced the segments yet.
 */
export const streamPlaylistPath = (id: string): string => `${STREAMS_PATH}/${encodeURIComponent(id)}/index.m3u8`;

/** How long the Hub waits for a TV it woke to come on before it gives up (FR-35). */
export const PLAY_WAKE_TIMEOUT_MS = 30_000;

export interface PlayRequest {
  readonly mediaSourceId: number;
  /** The Media File's path inside the Media Source, e.g. `"Films/Sci-Fi/Arrival.mkv"`. */
  readonly path: string;
  /**
   * True for "Resume from h:mm:ss": play from its Resume Position, or from
   * the start if it has none. Left out or false for "Start over", from the
   * start (FR-40).
   */
  readonly resume?: boolean;
}

/**
 * Plays the audio Media Files directly in a folder of a Media Source, not
 * those in its folders, in file-name order, as a {@link Queue}, from the
 * first, each from its start (FR-46). Its other Media Files, videos, are left
 * out.
 */
export interface PlayFolderRequest {
  readonly mediaSourceId: number;
  /** The folder's path inside the Media Source, e.g. `"Music/Album"`, or `""` for the Media Source's own folder. */
  readonly folder: string;
}

/**
 * The steps of playing a Media File on a TV, in order. `waking` is left out
 * for a TV that is already on.
 *
 * - `waking`: switching the TV on, and waiting for it to come on.
 * - `launching`: launching the Player on it.
 * - `connecting`: waiting for the Player to connect to the Hub.
 * - `sending`: sending the Player the Media File's URL.
 */
export type PlayStep = "waking" | "launching" | "connecting" | "sending";

/**
 * How playing a Media File is going: a {@link PlayStep} as it starts, which
 * ends the step before it; then `sent` once the Player has the Media File's
 * URL, or `failed` with why, written for the person, as a {@link HubError} is.
 */
export type PlayProgress =
  { readonly step: PlayStep } | { readonly step: "sent" } | { readonly step: "failed"; readonly error: string };

/**
 * `POST` a {@link PlayerActionRequest} here to install or update, launch or
 * uninstall the Player on the Appliance, a TV, with Samsung's developer tools
 * (FR-31). The TV must say it is in Developer Mode with the Hub's IP as its
 * Developer IP, and installing needs the signing certificate stored in
 * Settings, which signs the Player build the Hub has.
 *
 * It refuses, as other requests are refused, before it starts: `404` for a
 * TV that isn't there, `409` for one not in Developer Mode with the Hub's
 * IP, one already doing another, a Hub with no signing certificate or no
 * Player build, and `502` for a TV that doesn't answer. Once it has started
 * it answers `200` at once, then sends each {@link PlayerActionProgress} as
 * it happens, one JSON object per line (`application/x-ndjson`), ending with
 * `"done"` or `"failed"`.
 */
export const appliancePlayerActionPath = (id: number): string => `${appliancePlayerPath(id)}/action`;

/** What to do with the Player on a TV. `install` installs it, or updates the one there to the Hub's build. */
export type PlayerAction = "install" | "launch" | "uninstall";

export interface PlayerActionRequest {
  readonly action: PlayerAction;
}

/**
 * The steps of a {@link PlayerAction}, in order. Each action has
 * `connecting`, then its own: `signing` and `installing` to install,
 * `launching` to launch, and `uninstalling` to uninstall.
 *
 * - `connecting`: connecting to the TV as its Developer IP.
 * - `signing`: signing the Player build with the signing certificate.
 * - `installing`: installing it on the TV, in place of any there.
 * - `launching`: launching the Player on the TV.
 * - `uninstalling`: uninstalling it from the TV.
 */
export type PlayerActionStep = "connecting" | "signing" | "installing" | "launching" | "uninstalling";

/**
 * How a {@link PlayerAction} is going: a {@link PlayerActionStep} as it
 * starts, which ends the step before it; then `done`, or `failed` with why,
 * written for the person, as a {@link HubError} is.
 */
export type PlayerActionProgress =
  { readonly step: PlayerActionStep } | { readonly step: "done" } | { readonly step: "failed"; readonly error: string };

/**
 * The modes an Air Conditioner may have (FR-50), each where the unit has it:
 * `fan` moves air without heating or cooling it.
 */
export type AirConditionerMode = "cool" | "heat" | "dry" | "fan" | "auto";

/** The target temperatures an Air Conditioner takes in one mode, in °C, from `min` to `max` in steps of `step`. */
export interface TemperatureRange {
  readonly min: number;
  readonly max: number;
  /** 0.5 where the unit takes half degrees, 1 where it takes whole degrees only (FR-50). */
  readonly step: 0.5 | 1;
}

/** One mode an Air Conditioner has, and the target temperatures it takes in it, or `null` where it takes none, as in `fan`. */
export interface AirConditionerModeCapability {
  readonly mode: AirConditionerMode;
  readonly temperature: TemperatureRange | null;
}

/** An Air Conditioner's own fan steps, slowest first. */
export type FanSpeed = "silent" | "low" | "medium" | "high" | "full";

/** The presets an Air Conditioner may have (FR-50), at most one of which is on at a time. */
export type AirConditionerPreset = "eco" | "turbo" | "sleep";

/** Which ways an Air Conditioner's louvres swing, each on its own. */
export interface AirConditionerSwing {
  readonly vertical: boolean;
  readonly horizontal: boolean;
}

/** One of an Air Conditioner's choices for a {@link AirConditionerFunction} that is a choice. */
export interface AirConditionerOption {
  /** Chosen by its Driver, the same on every unit of its brand, e.g. "mild". */
  readonly id: string;
  /** For the person, e.g. "Mild". */
  readonly name: string;
}

/**
 * A function an Air Conditioner reports beyond the named ones, e.g. a
 * self-clean, which its Driver exposes as an on/off or a choice, so that
 * nothing the unit can do is reachable only from its maker's app (FR-50).
 */
export type AirConditionerFunction =
  | {
      /** Chosen by its Driver, the same on every unit of its brand, e.g. "self-clean". */
      readonly id: string;
      /** For the person, e.g. "Self-clean". */
      readonly name: string;
      readonly kind: "on-off";
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly kind: "choice";
      readonly options: readonly AirConditionerOption[];
    };

/**
 * The controls an Air Conditioner has, as its Driver reads them from the
 * unit itself (FR-50, NFR-6). The Remote shows each it has and no other.
 */
export interface AirConditionerCapabilities {
  /** Whether it can be switched on and off. */
  readonly power: boolean;
  /** Its modes, each with its target temperatures, in the order the Remote shows them. */
  readonly modes: readonly AirConditionerModeCapability[];
  readonly fan: {
    /** Its own steps, slowest first. */
    readonly speeds: readonly FanSpeed[];
    /** Whether it has an automatic fan, too. */
    readonly auto: boolean;
  };
  /** Which ways it swings: vertical and horizontal separately where it swings both ways. */
  readonly swing: AirConditionerSwing;
  readonly presets: readonly AirConditionerPreset[];
  /** Whether its indoor unit's display can be switched on and off. */
  readonly display: boolean;
  /** Which temperatures it reports, besides the target. */
  readonly temperatures: { readonly room: boolean; readonly outdoor: boolean };
  /** Every further function it reports, each an on/off or a choice. */
  readonly functions: readonly AirConditionerFunction[];
}

/** What an Air Conditioner says it is doing now. Temperatures are in °C. */
export interface AirConditionerState {
  readonly power: boolean;
  readonly mode: AirConditionerMode;
  readonly targetTemperature: number;
  readonly fanSpeed: FanSpeed | "auto";
  readonly swing: AirConditionerSwing;
  /** The preset on, or `null` for none. */
  readonly preset: AirConditionerPreset | null;
  readonly display: boolean;
  /** As the indoor unit measures it, or `null` where it doesn't say. */
  readonly roomTemperature: number | null;
  /** As the outdoor unit measures it, or `null` where it doesn't say, as when its outdoor unit is idle. */
  readonly outdoorTemperature: number | null;
  /**
   * The value of each of its {@link AirConditionerCapabilities.functions},
   * by its id: on or off for an on/off, an option's id for a choice.
   */
  readonly functions: Readonly<Record<string, boolean | string>>;
}

/**
 * What to change on an Air Conditioner; anything left out stays as it is.
 * Each must be one of the unit's {@link AirConditionerCapabilities}.
 */
export interface AirConditionerChange {
  readonly power?: boolean;
  readonly mode?: AirConditionerMode;
  /** Within the mode's {@link TemperatureRange}, in its steps. */
  readonly targetTemperature?: number;
  readonly fanSpeed?: FanSpeed | "auto";
  /** Each way it swings that is left out stays as it is. */
  readonly swing?: Partial<AirConditionerSwing>;
  /** `null` switches off whichever preset is on. */
  readonly preset?: AirConditionerPreset | null;
  readonly display?: boolean;
  /** Each function's new value, by its id; those left out stay as they are. */
  readonly functions?: Readonly<Record<string, boolean | string>>;
}

/**
 * What an Air Conditioner or a Light is doing, read from it now through its
 * Driver, with no cloud (ADR 0007):
 *
 * - `GET` answers with an {@link AirConditionerReading}, or for a Light a
 *   {@link LightReading}.
 * - `PATCH` an {@link AirConditionerChange}, or a {@link LightChange}, has the
 *   Hub change what is asked, and answers with the reading the Appliance then
 *   gives. It refuses a change the Appliance hasn't the capability for with
 *   `400`, and one it can't be reached for with `502`.
 *
 * One that refuses the Hub's token and key, or a Light its key, is marked
 * `"pair-again"`, so that the Remote offers to fetch them again (FR-51).
 */
export const applianceStatePath = (id: number): string => `${appliancePath(id)}/state`;

/**
 * An Air Conditioner's {@link AirConditionerState}; or `known: false` when it
 * isn't answering (FR-51a), or when it refuses the Hub's token and key, as
 * after a factory reset, and they need fetching again (FR-51).
 */
export type AirConditionerReading =
  | { readonly known: true; readonly state: AirConditionerState }
  | { readonly known: false; readonly why: "unreachable" | "fetch-again" };

/**
 * `GET` here to have the Hub read, now, the controls an Air Conditioner or a
 * Light reports it has, through its Driver, which its tab shows it with and
 * no other (FR-50, FR-52). It answers with an
 * {@link AirConditionerCapabilitiesReading}, or for a Light a
 * {@link LightCapabilitiesReading}. One that refuses the Hub's token and key,
 * or its key, is marked `"pair-again"`, as for its state.
 */
export const applianceCapabilitiesPath = (id: number): string => `${appliancePath(id)}/capabilities`;

/**
 * An Air Conditioner's {@link AirConditionerCapabilities}; or `known: false`
 * when it isn't answering (FR-51a), or refuses the Hub's token and key, as
 * an {@link AirConditionerReading} says.
 */
export type AirConditionerCapabilitiesReading =
  | { readonly known: true; readonly capabilities: AirConditionerCapabilities }
  | { readonly known: false; readonly why: "unreachable" | "fetch-again" };

/** The colour temperatures a Light takes, in kelvin, from `min`, the warmest, to `max`, the coolest. */
export interface ColourTemperatureRange {
  readonly min: number;
  readonly max: number;
}

/** A colour a Light shows, its brightness apart. */
export interface LightColour {
  /** On the colour wheel, in whole degrees from 0, red, to 359. */
  readonly hue: number;
  /** In whole percent, from 0, white, to 100, the colour at its fullest. */
  readonly saturation: number;
}

/** A Light's brightness, in whole percent, from this to {@link LIGHT_BRIGHTNESS_MAX}: a Light that is on is never at 0. */
export const LIGHT_BRIGHTNESS_MIN = 1;
export const LIGHT_BRIGHTNESS_MAX = 100;

/**
 * The controls a Light has, as its Driver reads them from the Light itself
 * (FR-52, NFR-6). The Remote shows each it has and no other, so that a smart
 * plug shows on/off only.
 */
export interface LightCapabilities {
  /** Whether it switches on and off, as every Light does. */
  readonly onOff: boolean;
  /** Whether it dims, from {@link LIGHT_BRIGHTNESS_MIN} to {@link LIGHT_BRIGHTNESS_MAX}. */
  readonly brightness: boolean;
  /** The colour temperatures it shows white at, or `null` where it has only the one white, or none. */
  readonly colourTemperature: ColourTemperatureRange | null;
  /** Whether it shows colours. */
  readonly colour: boolean;
}

/**
 * What a Light says it is doing now. It shows white at a colour temperature
 * or a colour, never both, so at most one of those is set; neither is while
 * it shows something else, such as an effect set in its maker's app.
 */
export interface LightState {
  readonly on: boolean;
  /** In whole percent, or `null` for a Light that doesn't dim. */
  readonly brightness: number | null;
  /** In kelvin, while it shows white, where it has {@link LightCapabilities.colourTemperature}. */
  readonly colourTemperature: number | null;
  /** While it shows a colour. */
  readonly colour: LightColour | null;
}

/**
 * What to change on a Light; anything left out stays as it is. Each must be
 * one of the Light's {@link LightCapabilities}. A colour temperature has it
 * show white, and a colour that colour, so a change has one or the other.
 */
export interface LightChange {
  readonly on?: boolean;
  /** In whole percent, from {@link LIGHT_BRIGHTNESS_MIN} to {@link LIGHT_BRIGHTNESS_MAX}. */
  readonly brightness?: number;
  /** In kelvin, within its {@link ColourTemperatureRange}. */
  readonly colourTemperature?: number;
  readonly colour?: LightColour;
}

/**
 * A Light's {@link LightState}; or `known: false` when it isn't answering,
 * which the Remote shows as "Can't reach this Light" (FR-57b), or when it
 * refuses the key the Hub has for it, as after it is paired again in its
 * maker's app.
 */
export type LightReading =
  | { readonly known: true; readonly state: LightState }
  | { readonly known: false; readonly why: "unreachable" | "key-refused" };

/** A Light's {@link LightCapabilities}; or `known: false` as a {@link LightReading} says. */
export type LightCapabilitiesReading =
  | { readonly known: true; readonly capabilities: LightCapabilities }
  | { readonly known: false; readonly why: "unreachable" | "key-refused" };

/**
 * `POST` a {@link LightsChangeRequest} here for a Room-wide control or All
 * off (FR-53): one request, which the Hub makes of every Light in the Room,
 * or in the home, at once, through each one's Driver, and answers, once
 * each has answered or not, with a {@link LightsOutcome} saying which didn't
 * (FR-57b). It refuses a change that isn't one with `400`, and a Room that
 * no longer exists with `409`.
 */
export const LIGHTS_PATH = `${APPLIANCES_PATH}/lights`;

/** What a Room-wide control or All off changes on every Light it reaches. */
export interface LightsChange {
  /** On or off, as every Light switches. */
  readonly on?: boolean;
  /**
   * In whole percent, from {@link LIGHT_BRIGHTNESS_MIN} to
   * {@link LIGHT_BRIGHTNESS_MAX}, for each Light that dims, which it also
   * switches on; one that doesn't dim, such as a smart plug, is left as it is.
   */
  readonly brightness?: number;
}

export interface LightsChangeRequest {
  /** The {@link Room} whose Lights to change; left out, every Light in the home, as All off has. */
  readonly roomId?: number;
  readonly change: LightsChange;
}

/** How a Room-wide control or All off went, Light by Light. */
export interface LightsOutcome {
  /**
   * Every Light it was for, by its {@link Appliance}'s id, with what it then
   * read: the change made, or `known: false` for one that didn't take it.
   */
  readonly lights: readonly { readonly id: number; readonly reading: LightReading }[];
  /** The ids of the Lights that didn't take it, as they didn't answer, which the Remote names. */
  readonly unreached: readonly number[];
}

/**
 * Where the Hub keeps the Light Scenes (FR-56), each a {@link Room}'s Lights
 * as they were when it was saved:
 *
 * - `GET` answers with every {@link LightScene}, by Room, in Room order, each
 *   Room's in the order they were saved.
 * - `POST` a {@link SaveLightSceneRequest}, "Save as Light Scene", reads each
 *   Light in the Room now, through its Driver, and keeps what each said,
 *   answering `201` with a {@link LightSceneSaved}. A Light that doesn't
 *   answer is left out, and named. It refuses a name that isn't one, or is
 *   the Room's already, with `400` or `409`, a Room that no longer exists
 *   with `409`, and a Room none of whose Lights answered with `502`.
 */
export const LIGHT_SCENES_PATH = `${LIGHTS_PATH}/scenes`;

/**
 * One Light Scene, at `${LIGHT_SCENES_PATH}/<id>`: `PATCH` a
 * {@link LightSceneNameRequest} renames it and answers with it; `DELETE`
 * removes it and answers `204`.
 */
export const lightScenePath = (id: number): string => `${LIGHT_SCENES_PATH}/${String(id)}`;

/**
 * `POST` here to recall the Light Scene: the Hub sets each Light still in
 * its Room, and in the Light Scene, back to how it was saved, at once,
 * through each one's Driver, and answers once each has answered or not with
 * a {@link LightsOutcome}, as a Room-wide control does (FR-57b). A Light
 * added to the Room since it was saved is left as it is, and one since
 * moved out of it, or removed, is skipped.
 */
export const lightSceneRecallPath = (id: number): string => `${lightScenePath(id)}/recall`;

/** The longest a Light Scene's name may be, in characters. */
export const LIGHT_SCENE_NAME_MAX_LENGTH = 40;

/** A Room's Lights as they were when it was saved, which recalling sets them back to (FR-56). Kept by the Hub. */
export interface LightScene {
  /** Chosen by the Hub, and never given to another Light Scene, even after this one is deleted. */
  readonly id: number;
  /** The {@link Room} it is of. It goes with the Room, when the Room is deleted. */
  readonly roomId: number;
  /** 1 to {@link LIGHT_SCENE_NAME_MAX_LENGTH} characters, unique in its Room, ignoring case. */
  readonly name: string;
  /** Each Light in it, by its {@link Appliance}'s id, as it was when it was saved. */
  readonly lights: readonly { readonly id: number; readonly state: LightState }[];
}

export interface SaveLightSceneRequest {
  /** The {@link Room} whose Lights to save. */
  readonly roomId: number;
  readonly name: string;
}

export interface LightSceneNameRequest {
  readonly name: string;
}

/** What "Save as Light Scene" kept, and which of the Room's Lights it couldn't, as they didn't answer. */
export interface LightSceneSaved {
  readonly lightScene: LightScene;
  /** The ids of the Room's Lights left out, which the Remote names. */
  readonly unreached: readonly number[];
}

/**
 * A Heating's or a Radiator Valve's modes (FR-63, FR-65): `schedule` follows
 * the schedule set in its maker's app, a target set in it holding until the
 * next scheduled change; `manual` holds its target until it is changed; and
 * `off` keeps it above the frost temperature set in its maker's app.
 */
export type HeatingMode = "schedule" | "manual" | "off";

/** The Hot Water's modes (FR-66): following its schedule, on or off. */
export type HotWaterMode = "schedule" | "on" | "off";

/**
 * The controls a Heating or a Radiator Valve has, as its Driver reads them
 * from its maker (FR-63, FR-65, NFR-6).
 */
export interface HeatingCapabilities {
  readonly modes: readonly HeatingMode[];
  /** The target temperatures it takes, in °C, as its maker reports them. */
  readonly target: TemperatureRange;
  /** How long a Boost may last, in minutes, shortest first, in the steps its maker's app offers. */
  readonly boostMinutes: readonly number[];
}

/** The controls the Hot Water has (FR-66): its modes, and a Boost by duration only. */
export interface HotWaterCapabilities {
  readonly modes: readonly HotWaterMode[];
  /** How long a Boost may last, in minutes, shortest first, in the steps its maker's app offers. */
  readonly boostMinutes: readonly number[];
}

/** A Heating's or a Radiator Valve's Boost, while it lasts. */
export interface HeatingBoost {
  /** In °C. */
  readonly target: number;
  /** How long it has left, in whole minutes, after which it goes back to its mode and the target it had. */
  readonly minutesLeft: number;
}

/** The Hot Water's Boost, while it lasts. */
export interface HotWaterBoost {
  /** How long it has left, in whole minutes, after which it goes back to its mode. */
  readonly minutesLeft: number;
}

/**
 * What a Heating says it is doing now, as its maker reports it (FR-63).
 * Temperatures are in °C.
 */
export interface HeatingState {
  /** Its mode, which during a Boost is the one it goes back to. */
  readonly mode: HeatingMode;
  /** The target it heats to now: during a Boost, the Boost's. */
  readonly target: number;
  /** Its Boost, or `null` while it has none. */
  readonly boost: HeatingBoost | null;
  /** The temperature it reads, or `null` where its maker doesn't say. */
  readonly temperature: number | null;
  /** Whether it is calling for heat now. */
  readonly callingForHeat: boolean;
  /**
   * Whether its maker can reach it. One that can't, e.g. a Radiator Valve out
   * of range or with a flat battery, says so (FR-68), and the rest of its
   * state is as its maker last heard it.
   */
  readonly online: boolean;
}

/** What a Radiator Valve says it is doing now (FR-65): as a Heating, and more. */
export interface RadiatorValveState extends HeatingState {
  /** Whether its maker warns that its battery is low. */
  readonly lowBattery: boolean;
  /**
   * The Heating it belongs to, as its maker reports it, by the id its Driver
   * lists that Heating by, and its Heating zone's name, or `null` where its maker
   * doesn't say. It is moved only in its maker's app.
   */
  readonly zone: { readonly id: string | null; readonly name: string } | null;
}

/** What the Hot Water says it is doing now (FR-66). */
export interface HotWaterState {
  /** Its mode, which during a Boost is the one it goes back to. */
  readonly mode: HotWaterMode;
  /** Its Boost, or `null` while it has none. */
  readonly boost: HotWaterBoost | null;
  /** Whether it is heating the water now, by its schedule, being on, or a Boost. */
  readonly on: boolean;
  /** Whether its maker can reach it. */
  readonly online: boolean;
}

/**
 * One change to a Heating or a Radiator Valve (FR-63, FR-65): a target, in
 * its {@link HeatingCapabilities.target}'s range and steps, held as its mode
 * holds it; a mode; a Boost, to a target for one of its
 * {@link HeatingCapabilities.boostMinutes}; or `boost: null`, which cancels
 * the Boost, back to the mode and target it had before.
 */
export type HeatingChange =
  | { readonly target: number }
  | { readonly mode: HeatingMode }
  | { readonly boost: { readonly target: number; readonly minutes: number } }
  | { readonly boost: null };

/**
 * One change to the Hot Water (FR-66): a mode; a Boost for one of its
 * {@link HotWaterCapabilities.boostMinutes}; or `boost: null`, which cancels
 * the Boost, back to the mode it had before.
 */
export type HotWaterChange =
  { readonly mode: HotWaterMode } | { readonly boost: { readonly minutes: number } } | { readonly boost: null };

/**
 * Where the Hub keeps its sign-in to Hive, the one account for the whole
 * home's Heating, Radiator Valves and Hot Water, reached through Hive's
 * cloud (FR-67, ADR 0010):
 *
 * - `GET` answers with a {@link HiveAccount}, asking Hive now, as Settings
 *   opens, whether it still accepts the Hub's tokens (FR-67b). Any
 *   Appliance on the account the Hub hasn't yet is added as it asks.
 * - `DELETE` signs out: the Hub forgets its tokens and device keys, and
 *   removes every Heating, Radiator Valve and Hot Water, and so the Heating
 *   tab, then answers `204`.
 *
 * The tokens and device keys never leave the Hub (FR-67a).
 */
export const HIVE_PATH = "/api/hive";

/**
 * `POST` a {@link CloudLogin} here, the Hive account owner's email and
 * password, to sign the Hub in to Hive, once. It answers with a
 * {@link HiveSignInOutcome}: signed in, with the Appliances it added, or
 * that Hive asks for the code it texted, for {@link HIVE_CODE_PATH}. The
 * login is used for this alone and never kept, logged or sent back (FR-67,
 * FR-67a). Signing in again, as after Hive stops accepting the tokens,
 * keeps the Appliances the Hub has, with their names and Rooms.
 */
export const HIVE_SIGN_IN_PATH = `${HIVE_PATH}/sign-in`;

/**
 * `POST` a {@link HiveCodeRequest} here with the code Hive texted, after
 * {@link HIVE_SIGN_IN_PATH} said Hive asks for one, within a few minutes.
 * It answers with a {@link HiveSignedIn}, or refuses a wrong code, which
 * can be given again, or one given too late, which needs signing in again.
 */
export const HIVE_CODE_PATH = `${HIVE_PATH}/code`;

/**
 * Whether the Hub is signed in to Hive and, if it is, what Hive said of its
 * tokens as the Hub asked: `"accepted"`; `"refused"`, as now and then on
 * Hive's own schedule, for Settings to offer to sign in again (FR-67b); or
 * `"unreachable"`, "Can't reach Hive" (FR-68).
 */
export type HiveAccount =
  { readonly signedIn: false } | { readonly signedIn: true; readonly tokens: "accepted" | "refused" | "unreachable" };

/** Signed in to Hive, and the Appliances on the account the Hub added, each with Hive's name and no Room (FR-67). */
export interface HiveSignedIn {
  readonly signedIn: true;
  readonly added: readonly Appliance[];
}

/** Hive asks for the code it texted the account's owner, which goes to {@link HIVE_CODE_PATH}. */
export interface HiveCodeNeeded {
  readonly signedIn: false;
  readonly needs: "code";
}

export type HiveSignInOutcome = HiveSignedIn | HiveCodeNeeded;

export interface HiveCodeRequest {
  readonly code: string;
}

/** The longest code the Hub takes, in characters; Hive's are 6 digits. */
export const HIVE_CODE_MAX_LENGTH = 16;

/**
 * The Heating tab's one read of Hive (FR-62): `GET` answers with a
 * {@link HeatingHome}, every Heating, Radiator Valve and Hot Water with the
 * controls it has and what Hive reports of it now, read from Hive in one
 * request as it is asked, and kept nowhere, so that nothing is read while no
 * Remote has the tab open. The tab asks every 30 seconds while it is open,
 * and so every Remote sees the same.
 */
export const HEATING_PATH = "/api/heating";

/**
 * `POST` a {@link HeatingChange}, or for the Hot Water a
 * {@link HotWaterChange}, here to make one change to the Heating, Radiator
 * Valve or Hot Water with this {@link Appliance} id. It answers with a
 * {@link HeatingOutcome}: what Hive then reports of it, refused or not
 * (FR-68). It refuses a change it can't take with `400`, an Appliance that
 * isn't Hive's with `404`, and, signed out of Hive, `409`; where Hive can't
 * be reached, or refuses the Hub's tokens, it answers `502`.
 */
export const heatingPath = (id: number): string => `${HEATING_PATH}/${String(id)}`;

/**
 * `POST` a {@link HeatingChange} here for the Whole home (FR-64): the Hub
 * makes it of every Heating at once, never a Radiator Valve or the Hot
 * Water, and answers once each has taken it or not with a
 * {@link HeatingOutcome}, naming any that didn't.
 */
export const WHOLE_HOME_PATH = `${HEATING_PATH}/whole-home`;

/**
 * `POST` a {@link RoomTargetRequest} here for a Room's Room-wide target
 * (FR-65): the Hub sets every Radiator Valve in the {@link Room} to it at
 * once, and none outside it, and answers with a {@link HeatingOutcome},
 * naming any that didn't take it. A Room that no longer exists is `409`.
 */
export const roomTargetPath = (roomId: number): string => `${HEATING_PATH}/rooms/${String(roomId)}/target`;

export interface RoomTargetRequest {
  /** In °C, in half degrees. */
  readonly target: number;
}

/** What Hive reports of one Heating, Radiator Valve or Hot Water, by its {@link Appliance}'s id. */
export type HeatingReport =
  | { readonly kind: "heating"; readonly id: number; readonly state: HeatingState }
  | { readonly kind: "radiator-valve"; readonly id: number; readonly state: RadiatorValveState }
  | { readonly kind: "hot-water"; readonly id: number; readonly state: HotWaterState };

/** One Heating, Radiator Valve or Hot Water as the Heating tab shows it: the Appliance, its controls and its state. */
export type HeatingReading =
  | {
      readonly kind: "heating";
      readonly id: number;
      readonly appliance: Appliance;
      readonly capabilities: HeatingCapabilities;
      readonly state: HeatingState;
    }
  | {
      readonly kind: "radiator-valve";
      readonly id: number;
      readonly appliance: Appliance;
      readonly capabilities: HeatingCapabilities;
      readonly state: RadiatorValveState;
    }
  | {
      readonly kind: "hot-water";
      readonly id: number;
      readonly appliance: Appliance;
      readonly capabilities: HotWaterCapabilities;
      readonly state: HotWaterState;
    };

/**
 * What the Heating tab shows: signed out of Hive, where the tab goes
 * (FR-67); "Can't reach Hive", with every control disabled, where Hive
 * can't be reached (`"unreachable"`, FR-68) or no longer accepts the Hub's
 * tokens (`"tokens-refused"`, FR-67b), to sign in again in Settings; or
 * every one of Hive's Appliances the Hub has, in the Hub's order, with what
 * Hive reports of it.
 */
export type HeatingHome =
  | { readonly signedIn: false }
  | { readonly signedIn: true; readonly hive: "unreachable" | "tokens-refused" }
  | { readonly signedIn: true; readonly hive: "reachable"; readonly appliances: readonly HeatingReading[] };

/** How a change to one Heating, Radiator Valve or Hot Water, the Whole home, or a Room-wide target went. */
export interface HeatingOutcome {
  /** Each Appliance it was for, with what Hive then reports of it, whether it took the change or not (FR-68). */
  readonly appliances: readonly HeatingReport[];
  /** The ids of those that didn't take it, which the Remote names, and shows as refused (FR-64, FR-65, FR-68). */
  readonly refused: readonly number[];
}

/**
 * The devices on the home network, as the Network tab shows them:
 *
 * - `GET` answers with the {@link NetworkScan}: the last scan's devices, or
 *   the one under way, with how far it has got.
 * - `POST` {@link NETWORK_SCAN_PATH} starts a scan of the Hub's subnet, or,
 *   with one under way, leaves it, and answers with the {@link NetworkScan}.
 * - `POST` {@link networkDevicePortsPath} starts checking every port of one
 *   device found, and answers with the {@link NetworkScan}. The ports it
 *   finds open are remembered, and every scan after checks them too.
 * - `PUT` a {@link NetworkDeviceNameRequest} to {@link networkDeviceNamePath}
 *   names a device found, or with `null` forgets its name, and answers with
 *   the {@link NetworkScan}.
 * - `PUT` a {@link NetworkDeviceRoomRequest} to {@link networkDeviceRoomPath}
 *   puts a device found in a Room, or with `null` in "No room", and answers
 *   with the {@link NetworkScan}. A device that is an Appliance is moved, as
 *   in Settings, which may refuse as Settings does (`409` for a name taken in
 *   that Room); a Room deleted since is refused with `409`.
 *
 * The Hub keeps the last scan only while it runs, and each device's name,
 * Room and remembered ports in its database, by its MAC address, or by its IP address
 * where it has none.
 */
export const NETWORK_PATH = "/api/network";

export const NETWORK_SCAN_PATH = `${NETWORK_PATH}/scan`;

export const networkDevicePortsPath = (address: string): string =>
  `${NETWORK_PATH}/devices/${encodeURIComponent(address)}/ports`;

export const networkDeviceNamePath = (address: string): string =>
  `${NETWORK_PATH}/devices/${encodeURIComponent(address)}/name`;

export const networkDeviceRoomPath = (address: string): string =>
  `${NETWORK_PATH}/devices/${encodeURIComponent(address)}/room`;

export interface NetworkDeviceRoomRequest {
  /** The {@link Room} to put the device in, or null for "No room". */
  readonly roomId: number | null;
}

/**
 * The devices put in a Room from the Network tab, but for Appliances, which
 * are in theirs as they are, for the Rooms tab: `GET` answers with
 * {@link RoomDevices}, whether or not a scan since has found them.
 */
export const NETWORK_ROOMS_PATH = `${NETWORK_PATH}/rooms`;

/** A device on the network, or a Bluetooth device, as the Rooms tab shows it in its Room. */
export interface RoomDevice {
  /** Which device it is, as the Hub keeps it, unique among them. */
  readonly key: string;
  readonly kind: "network" | "bluetooth" | "amazon" | "ring";
  readonly roomId: number;
  /** What the person named it, otherwise what a scan last saw it as. */
  readonly title: string;
  /** Its IP address, or Bluetooth address, as a scan last saw it, or null. */
  readonly address: string | null;
  readonly maker: string | null;
}

export interface RoomDevices {
  /** In the order the Hub keeps them: by title. */
  readonly devices: readonly RoomDevice[];
}

/** The Room a device on the network, or a Bluetooth device, is in. */
export interface DeviceRoom {
  readonly id: number;
  readonly name: string;
}

/** The most characters a device's name may have, as a person counts them. */
export const NETWORK_DEVICE_NAME_MAX_LENGTH = 40;

export interface NetworkDeviceNameRequest {
  /** 1 to {@link NETWORK_DEVICE_NAME_MAX_LENGTH} characters, or null, or only spaces, to forget its name. */
  readonly name: string | null;
}

/** A TCP port a device accepted a connection on, and what usually listens there, or null for a port with no common use. */
export interface OpenPort {
  readonly port: number;
  readonly service: string | null;
}

/**
 * How much of a device's ports were checked: the common ones, with those
 * found open by checking every port before, or every one, from 1 to 65535.
 */
export type PortCheck =
  | { readonly kind: "common"; readonly ports: number; readonly remembered: number }
  | { readonly kind: "all"; readonly checked: number; readonly total: number; readonly done: boolean };

/** One device the Hub found on the home network. */
export interface NetworkDevice {
  /** Its IPv4 address. */
  readonly address: string;
  /** What the person named it, or null. */
  readonly name: string | null;
  /** The Room it is in: the Appliance's, where it is one; or null for "No room". */
  readonly room: DeviceRoom | null;
  /** Its MAC address, lower case with colons, or null where the Hub's machine hasn't one for it. */
  readonly macAddress: string | null;
  /** Who made its network card, from its MAC address, or null where the registry doesn't say. */
  readonly vendor: string | null;
  /**
   * Whether its MAC address is one it made up, as a phone does for each
   * Wi-Fi network, so says nothing of who made it.
   */
  readonly privateMacAddress: boolean;
  /** Its name, as the network's DNS gives it, or null where it gives none. */
  readonly hostname: string | null;
  /** Whether it is the Hub's own machine. */
  readonly isHub: boolean;
  /** The Appliance the Hub has at its address, or null. */
  readonly appliance: {
    readonly id: number;
    readonly kind: ApplianceKind;
    readonly name: string;
    /** Its Room's name, or null for "No room". */
    readonly room: string | null;
  } | null;
  /** The ports it accepted a connection on, lowest first. */
  readonly openPorts: readonly OpenPort[];
  /** How long it took to answer the Hub, in milliseconds, or null where it answered only to its MAC address. */
  readonly responseMs: number | null;
  readonly portCheck: PortCheck;
}

/** The devices the Hub found on the home network, and how far a scan has got. */
export interface NetworkScan {
  /** What the Hub scans, e.g. `192.168.1.0/24`, or null before its first scan, or where it has no address. */
  readonly subnet: string | null;
  /** Whether a scan of the subnet is under way. */
  readonly scanning: boolean;
  /** How far the scan under way, or the last, has got: how many addresses of how many it has looked at. */
  readonly checked: number;
  readonly total: number;
  /** When the last scan began and ended, as ISO 8601, or null. */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Every device found, in address order. */
  readonly devices: readonly NetworkDevice[];
}

/**
 * The Bluetooth devices near the Hub's machine, as the Network tab's
 * Bluetooth view shows them, found by what each advertises:
 *
 * - `GET` answers with the {@link BluetoothScan}.
 * - `POST` {@link BLUETOOTH_SCAN_PATH} starts listening, unless the Hub is,
 *   and answers with the {@link BluetoothScan}.
 * - `PUT` a {@link NetworkDeviceNameRequest} to {@link bluetoothDeviceNamePath}
 *   names a device found, or with `null` forgets its name.
 * - `PUT` a {@link NetworkDeviceRoomRequest} to {@link bluetoothDeviceRoomPath}
 *   puts a device heard in a Room, or with `null` in "No room".
 *
 * The Hub keeps the last scan only while it runs, and each device's name in
 * its database, by its Bluetooth address.
 */
export const BLUETOOTH_PATH = `${NETWORK_PATH}/bluetooth`;

export const BLUETOOTH_SCAN_PATH = `${BLUETOOTH_PATH}/scan`;

export const bluetoothDeviceNamePath = (address: string): string =>
  `${BLUETOOTH_PATH}/devices/${encodeURIComponent(address)}/name`;

export const bluetoothDeviceRoomPath = (address: string): string =>
  `${BLUETOOTH_PATH}/devices/${encodeURIComponent(address)}/room`;

/** A service a Bluetooth device says it offers: its UUID, and its name where the Bluetooth SIG gives one. */
export interface BluetoothService {
  readonly uuid: string;
  readonly name: string | null;
}

/** One Bluetooth device the Hub heard advertising. */
export interface BluetoothDevice {
  /** Its Bluetooth address, lower case with colons. */
  readonly address: string;
  /**
   * Whether its address is one it made up, as a phone's is, and changes now
   * and then, rather than its maker's.
   */
  readonly randomAddress: boolean;
  /** What the person named it, or null. */
  readonly name: string | null;
  /** The Room it is in, or null for "No room". */
  readonly room: DeviceRoom | null;
  /** The name it advertises, or null where it gives none. */
  readonly advertisedName: string | null;
  /**
   * Who made it: the company its advertisement names, by the Bluetooth SIG's
   * list, or, for a maker's address, the IEEE's registry; or null.
   */
  readonly maker: string | null;
  /** How strongly the Hub heard it at best, in dBm: about -50 close by, -90 at the edge of range. */
  readonly signal: number;
  readonly services: readonly BluetoothService[];
  /** Whether what it advertises is as a light's might be: its name, or its maker's being a maker of smart bulbs' chips. */
  readonly maybeLight: boolean;
  /** When it was last heard, as ISO 8601. */
  readonly lastHeardAt: string;
}

export interface BluetoothScan {
  /** Whether the Hub can listen for Bluetooth devices, which it can on Windows alone, for now. */
  readonly available: boolean;
  /** Why the last scan failed, or why the Hub can't scan, written for the person; or null. */
  readonly problem: string | null;
  readonly scanning: boolean;
  /** How long a scan listens, in seconds. */
  readonly seconds: number;
  /** When the last scan began and ended, as ISO 8601, or null. */
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** Every device heard, possible lights first, then the strongest heard. */
  readonly devices: readonly BluetoothDevice[];
}

/**
 * The Amazon Echo devices on the owner's Amazon account, as the Amazon tab
 * shows them, which the Hub reaches through the Alexa app's own, private,
 * cloud API (ADR 0011), signed in to once:
 *
 * - `GET` answers with the {@link AmazonHome}.
 * - `POST` an {@link AmazonSignInRequest} to {@link AMAZON_SIGN_IN_PATH}
 *   starts signing in, and answers with the {@link AmazonHome}, whose status
 *   then gives the page to sign in to Amazon on; `DELETE` signs out.
 * - `GET` {@link amazonDevicePath} answers with an {@link AmazonDeviceState}.
 * - `POST` an {@link AmazonAction} to {@link amazonDeviceActionsPath} does it
 *   on the device, and answers with its {@link AmazonDeviceState}.
 * - `POST` an {@link AmazonAnnouncement} to {@link AMAZON_ANNOUNCE_PATH}
 *   announces it on every device, and answers `204`.
 * - `PUT` a {@link NetworkDeviceRoomRequest} to {@link amazonDeviceRoomPath}
 *   puts a device in a Room, and answers with the {@link AmazonHome}.
 *
 * Amazon may refuse or change any of it without notice: what it refuses is
 * answered with `502` and why.
 */
export const AMAZON_PATH = "/api/amazon";

export const AMAZON_SIGN_IN_PATH = `${AMAZON_PATH}/sign-in`;

export const AMAZON_ANNOUNCE_PATH = `${AMAZON_PATH}/announce`;

export const amazonDevicePath = (serial: string): string => `${AMAZON_PATH}/devices/${encodeURIComponent(serial)}`;

export const amazonDeviceActionsPath = (serial: string): string => `${amazonDevicePath(serial)}/actions`;

export const amazonDeviceRoomPath = (serial: string): string => `${amazonDevicePath(serial)}/room`;

/** The Amazon sites the Hub can sign in to, by the Amazon site the account is on. */
export const AMAZON_DOMAINS = [
  "amazon.co.uk",
  "amazon.com",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.ca",
  "amazon.com.au",
  "amazon.in",
  "amazon.co.jp",
  "amazon.com.br",
] as const;

export type AmazonDomain = (typeof AMAZON_DOMAINS)[number];

export interface AmazonSignInRequest {
  readonly domain: AmazonDomain;
}

/** Whether the Hub is signed in to Amazon, and, while signing in, where to. */
export type AmazonStatus =
  | { readonly state: "signed-out"; readonly problem: string | null }
  | {
      readonly state: "signing-in";
      readonly domain: AmazonDomain;
      /** The page, served by the Hub, to sign in to Amazon on, in a browser on the home network. */
      readonly signInUrl: string | null;
    }
  | { readonly state: "signed-in"; readonly domain: AmazonDomain; readonly problem: string | null };

/** What a device can do, as Amazon says of it. */
export interface AmazonCapabilities {
  readonly music: boolean;
  readonly volume: boolean;
  readonly alarms: boolean;
  readonly equaliser: boolean;
  readonly bluetooth: boolean;
}

/** One Echo, or other Alexa device, on the account. */
export interface AmazonDevice {
  /** Amazon's serial number for it, which says which it is. */
  readonly serial: string;
  /** Its name, as the Alexa app has it. */
  readonly name: string;
  /** What it is, e.g. "Echo" or "Echo Show", from Amazon's family for it. */
  readonly family: string;
  readonly online: boolean;
  readonly capabilities: AmazonCapabilities;
  /** The Room it is in, as put there on the Amazon tab, or null. */
  readonly room: DeviceRoom | null;
}

export interface AmazonRoutine {
  readonly id: string;
  readonly name: string;
}

export interface AmazonMusicProvider {
  readonly id: string;
  readonly name: string;
}

export interface AmazonHome {
  readonly status: AmazonStatus;
  /** Every device on the account but the Alexa app's own, by name; none while signed out. */
  readonly devices: readonly AmazonDevice[];
  readonly routines: readonly AmazonRoutine[];
  readonly musicProviders: readonly AmazonMusicProvider[];
}

/** What a device is playing, as Amazon reports it. */
export interface AmazonPlayer {
  readonly state: "playing" | "paused" | "idle";
  readonly title: string | null;
  readonly subtitle: string | null;
  readonly provider: string | null;
  /** The cover art's address, on Amazon's servers, or null. */
  readonly artUrl: string | null;
  /** Where it is, and how long it is, in seconds, where it says. */
  readonly progress: number | null;
  readonly length: number | null;
}

/** An alarm, timer or reminder on a device. */
export interface AmazonNotification {
  readonly id: string;
  readonly type: "alarm" | "timer" | "reminder";
  readonly label: string | null;
  readonly on: boolean;
  /** When it goes off, as ISO 8601, where Amazon says. */
  readonly at: string | null;
  /** How long a timer has left, in seconds. */
  readonly remaining: number | null;
}

export interface AmazonBluetoothDevice {
  readonly address: string;
  readonly name: string;
  readonly connected: boolean;
}

/** Everything the Amazon tab shows of one device, read afresh from Amazon. Each part is null where Amazon didn't say. */
export interface AmazonDeviceState {
  readonly serial: string;
  readonly player: AmazonPlayer | null;
  /** From 0 to 100. */
  readonly volume: number | null;
  readonly doNotDisturb: boolean | null;
  /** Each from -6 to 6. */
  readonly equaliser: { readonly bass: number; readonly midrange: number; readonly treble: number } | null;
  /** From 0 to 100. */
  readonly alarmVolume: number | null;
  readonly notifications: readonly AmazonNotification[];
  readonly bluetooth: readonly AmazonBluetoothDevice[];
}

/** What Alexa can be asked to say or do at once, as its own routines' actions. */
export const AMAZON_QUICK_ACTIONS = [
  "weather",
  "traffic",
  "news",
  "good-morning",
  "fun-fact",
  "joke",
  "story",
  "song",
  "calendar",
  "stop",
] as const;

export type AmazonQuickAction = (typeof AMAZON_QUICK_ACTIONS)[number];

/** Something to do on a device. */
export type AmazonAction =
  | { readonly kind: "play" | "pause" | "next" | "previous" }
  | { readonly kind: "volume"; readonly level: number }
  /** `ask` is as if the text were said to Alexa, e.g. "set a timer for 10 minutes". */
  | { readonly kind: "speak" | "announce" | "ask"; readonly text: string }
  | { readonly kind: "quick"; readonly action: AmazonQuickAction }
  | { readonly kind: "routine"; readonly routineId: string }
  | { readonly kind: "do-not-disturb"; readonly on: boolean }
  | { readonly kind: "music"; readonly providerId: string; readonly search: string }
  | { readonly kind: "equaliser"; readonly bass: number; readonly midrange: number; readonly treble: number }
  | { readonly kind: "alarm-volume"; readonly level: number }
  | { readonly kind: "notification-on"; readonly id: string; readonly on: boolean }
  | { readonly kind: "notification-delete"; readonly id: string }
  | { readonly kind: "bluetooth"; readonly address: string; readonly connect: boolean };

export interface AmazonAnnouncement {
  readonly text: string;
}

/** The most characters what is said, announced or asked may have. */
export const AMAZON_TEXT_MAX_LENGTH = 250;

/**
 * The Ring doorbells, cameras and chimes on the owner's Ring account, as the
 * Ring tab shows them, which the Hub reaches through the Ring app's own,
 * private, cloud API (ADR 0014), signed in to once:
 *
 * - `GET` answers with the {@link RingHome}.
 * - `POST` a {@link RingSignInRequest} to {@link RING_SIGN_IN_PATH} signs in
 *   with the account's email and password, which the Hub never keeps, and
 *   answers with the {@link RingHome}, whose status may then ask for the
 *   two-step code; `DELETE` signs out.
 * - `POST` a {@link RingCodeRequest} to {@link RING_CODE_PATH} gives the
 *   two-step code, and answers with the {@link RingHome}.
 * - `GET` {@link ringDevicePath} answers with a {@link RingDeviceState}.
 * - `POST` a {@link RingAction} to {@link ringDeviceActionsPath} does it on
 *   the device, and answers with its {@link RingDeviceState}.
 * - `GET` {@link ringSnapshotPath} answers with the camera's latest snapshot,
 *   as a JPEG.
 * - `POST` a {@link RingLiveViewRequest} to {@link ringLiveViewPath} starts
 *   live view, and answers with a {@link RingLiveView}; `DELETE`
 *   {@link ringLiveViewSessionPath} ends it.
 * - `GET` {@link ringRecordingPath} answers with a {@link RingRecording}.
 * - `PUT` a {@link NetworkDeviceRoomRequest} to {@link ringDeviceRoomPath}
 *   puts a device in a Room, and answers with the {@link RingHome}.
 *
 * Ring may refuse or change any of it without notice: what it refuses is
 * answered with `502` and why.
 */
export const RING_PATH = "/api/ring";

export const RING_SIGN_IN_PATH = `${RING_PATH}/sign-in`;

export const RING_CODE_PATH = `${RING_PATH}/code`;

export const ringDevicePath = (id: string): string => `${RING_PATH}/devices/${encodeURIComponent(id)}`;

export const ringDeviceActionsPath = (id: string): string => `${ringDevicePath(id)}/actions`;

export const ringDeviceRoomPath = (id: string): string => `${ringDevicePath(id)}/room`;

export const ringSnapshotPath = (id: string): string => `${ringDevicePath(id)}/snapshot`;

export const ringLiveViewPath = (id: string): string => `${ringDevicePath(id)}/live`;

export const ringLiveViewSessionPath = (id: string, sessionId: string): string =>
  `${ringLiveViewPath(id)}/${encodeURIComponent(sessionId)}`;

export const ringRecordingPath = (id: string, eventId: string): string =>
  `${ringDevicePath(id)}/events/${encodeURIComponent(eventId)}/recording`;

export interface RingSignInRequest {
  readonly email: string;
  /** Used once, to sign in, and never kept nor logged (FR-4). */
  readonly password: string;
}

export interface RingCodeRequest {
  readonly code: string;
}

/** Whether the Hub is signed in to Ring, and, while signing in, whether Ring wants the two-step code. */
export type RingStatus =
  | { readonly state: "signed-out"; readonly problem: string | null }
  | {
      readonly state: "code-needed";
      readonly email: string;
      /** Where Ring sent the code, as it says, e.g. "sent to +44•••••123 by SMS". */
      readonly prompt: string;
      readonly problem: string | null;
    }
  | { readonly state: "signed-in"; readonly problem: string | null };

export type RingDeviceKind = "doorbell" | "camera" | "chime";

/** What a device can do, as Ring says of it. */
export interface RingCapabilities {
  readonly light: boolean;
  readonly siren: boolean;
  /** Snapshots, events, recordings and live view: every doorbell's and camera's. */
  readonly video: boolean;
}

/** One Ring doorbell, camera or chime on the account. */
export interface RingDevice {
  /** Ring's id for it, which says which it is. */
  readonly id: string;
  /** Its name, as the Ring app has it. */
  readonly name: string;
  readonly kind: RingDeviceKind;
  /** Ring's model, e.g. "Video Doorbell 4". */
  readonly model: string;
  /** The Ring location it is at, by name. */
  readonly location: string;
  readonly online: boolean;
  /** Its battery, from 0 to 100, or null where it has none. */
  readonly battery: number | null;
  readonly capabilities: RingCapabilities;
  /** The Room it is in, as put there on the Ring tab, or null. */
  readonly room: DeviceRoom | null;
}

export interface RingHome {
  readonly status: RingStatus;
  /** Every doorbell, camera and chime on the account, by name; none while signed out. */
  readonly devices: readonly RingDevice[];
}

/** One of a doorbell's or camera's events, as Ring keeps them. */
export interface RingEvent {
  readonly id: string;
  /** `ding` is the doorbell pressed, `live-view` someone watching, `other` the rest. */
  readonly kind: "ding" | "motion" | "live-view" | "other";
  /** When, as ISO 8601. */
  readonly at: string;
  /** Whether Ring recorded it, so it can be watched. Recordings need a Ring Protect plan. */
  readonly recorded: boolean;
}

/** Everything the Ring tab shows of one device, read afresh from Ring. Each part is null where Ring didn't say. */
export interface RingDeviceState {
  readonly id: string;
  readonly online: boolean;
  readonly battery: number | null;
  readonly charging: boolean | null;
  /** The Wi-Fi signal, in dBm, and how good Ring says it is, e.g. "good". */
  readonly wifi: { readonly rssi: number; readonly quality: string } | null;
  readonly light: boolean | null;
  readonly siren: boolean | null;
  readonly motionDetection: boolean | null;
  /** When the doorbell was last pressed, and motion last seen, since the Hub signed in, as ISO 8601. */
  readonly lastDing: string | null;
  readonly lastMotion: string | null;
  /** A doorbell's or camera's last events, newest first. */
  readonly events: readonly RingEvent[];
  /** A chime's volume, from 0 to {@link RING_CHIME_VOLUME_MAX}. */
  readonly volume: number | null;
}

/** The loudest a chime goes, as the Ring app's own slider. */
export const RING_CHIME_VOLUME_MAX = 11;

/** Something to do on a device. */
export type RingAction =
  | { readonly kind: "light" | "siren" | "motion-detection"; readonly on: boolean }
  | { readonly kind: "chime-volume"; readonly level: number }
  /** Plays a chime's ding or motion sound, to hear it. */
  | { readonly kind: "chime-test"; readonly sound: "ding" | "motion" };

/** The Remote's offer, as WebRTC's SDP, to receive a camera's live video. */
export interface RingLiveViewRequest {
  readonly sdp: string;
}

/** Ring's answer to the offer, as SDP, and the session to end once done watching. */
export interface RingLiveView {
  readonly sessionId: string;
  readonly sdp: string;
}

/** Where to watch a recorded event, on Ring's servers, for a while. */
export interface RingRecording {
  readonly url: string;
}

/** The most characters the email, password or code may have. */
export const RING_FIELD_MAX_LENGTH = 254;
