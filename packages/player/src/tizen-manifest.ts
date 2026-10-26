import { PLAYER_APP_ID } from "@media-centre/shared";

/** The manifest's namespaces, its id and the privilege it asks for, which are names, never fetched. */
// eslint-disable-next-line media-centre/no-internet-urls -- an XML namespace's name, not an address
const WIDGETS_NAMESPACE = "http://www.w3.org/ns/widgets";
// eslint-disable-next-line media-centre/no-internet-urls -- an XML namespace's name, not an address
const TIZEN_NAMESPACE = "http://tizen.org/ns/widgets";
// eslint-disable-next-line media-centre/no-internet-urls -- the widget's id, which W3C widgets write as an IRI, not an address
const WIDGET_ID = "http://media-centre.local/player";
// eslint-disable-next-line media-centre/no-internet-urls -- a Tizen privilege's name, not an address
export const INTERNET_PRIVILEGE = "http://tizen.org/privilege/internet";
// eslint-disable-next-line media-centre/no-internet-urls -- a Tizen privilege's name, not an address
export const INPUT_DEVICE_PRIVILEGE = "http://tizen.org/privilege/tv.inputdevice";
// eslint-disable-next-line media-centre/no-internet-urls -- a Tizen feature's name, not an address
const ANY_SCREEN_SIZE = "http://tizen.org/feature/screen.size.all";

/**
 * The Player's Tizen manifest, `config.xml`, which `pnpm build` writes beside
 * its files so that its app id is the one in `shared`, which the Hub launches
 * it by. A Tizen app id is the package id, a dot, and the app's name.
 *
 * - Tizen 4.0, the 2018 TVs' (PRD §11), is the oldest it installs on.
 * - `internet` lets it reach the Hub; `<access origin="*">` lets that be at
 *   any address on the home network.
 * - `tv.inputdevice` lets it register the media keys of the TV's own remote,
 *   so that it is sent them (FR-37).
 * - It runs on Samsung TVs only, full screen, and stops when it isn't in front.
 */
export const tizenManifest = (version: string): string => {
  const [packageId] = PLAYER_APP_ID.split(".");
  return `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="${WIDGETS_NAMESPACE}" xmlns:tizen="${TIZEN_NAMESPACE}" id="${WIDGET_ID}" version="${version}" viewmodes="maximized">
  <tizen:application id="${PLAYER_APP_ID}" package="${packageId ?? ""}" required_version="4.0"/>
  <tizen:profile name="tv-samsung"/>
  <name>Media Centre</name>
  <icon src="icon.png"/>
  <content src="index.html"/>
  <feature name="${ANY_SCREEN_SIZE}"/>
  <access origin="*" subdomains="true"/>
  <tizen:privilege name="${INTERNET_PRIVILEGE}"/>
  <tizen:privilege name="${INPUT_DEVICE_PRIVILEGE}"/>
  <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
`;
};
