/**
 * The Samsung TV Driver's side of a TV's UPnP rendering control: SOAP calls,
 * over plain HTTP on port 9197 of a 2018 or later Samsung TV, that read and set
 * its actual volume and mute, whatever last changed them (FR-19). A TV answers
 * them without pairing, but only while it is on: in standby it doesn't answer.
 * Only the Driver knows this protocol (NFR-6).
 */

/** The port a Samsung TV answers UPnP on, as far as we know, for 2018 and later models. */
export const SAMSUNG_UPNP_PORT = 9197;

/** Where a Samsung TV takes rendering-control calls, as far as we know. */
export const RENDERING_CONTROL_PATH = "/upnp/control/RenderingControl1";

export const RENDERING_CONTROL_SERVICE = "urn:schemas-upnp-org:service:RenderingControl:1";

/** The SOAP envelope's namespace and encoding, which are names, never fetched. */
// eslint-disable-next-line media-centre/no-internet-urls -- an XML namespace's name, not an address
export const SOAP_ENVELOPE_NAMESPACE = "http://schemas.xmlsoap.org/soap/envelope/";
// eslint-disable-next-line media-centre/no-internet-urls -- an XML namespace's name, not an address
export const SOAP_ENCODING = "http://schemas.xmlsoap.org/soap/encoding/";

/** The rendering-control actions the Driver calls. */
export type RenderingControlAction = "GetVolume" | "SetVolume" | "GetMute" | "SetMute";

/** A rendering-control call's arguments, in the order the service lists them. */
export type RenderingControlArguments = readonly (readonly [name: string, value: string])[];

/** Every call is on the one instance, for the Master channel. */
const INSTANCE: RenderingControlArguments = [
  ["InstanceID", "0"],
  ["Channel", "Master"],
];

/** The TV didn't answer the call, or answered with a fault or something it can't be read from. */
export class RenderingControlUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderingControlUnavailable";
  }
}

/** The SOAPACTION header for `action`, quoted as UPnP has it. */
export const soapAction = (action: string): string => `"${RENDERING_CONTROL_SERVICE}#${action}"`;

/** A SOAP envelope with `body` in it, as both a call and its answer are sent. */
export const soapEnvelope = (body: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<s:Envelope xmlns:s="${SOAP_ENVELOPE_NAMESPACE}" s:encodingStyle="${SOAP_ENCODING}">` +
  `<s:Body>${body}</s:Body></s:Envelope>`;

/** `name` in the rendering-control service's namespace, with each argument as an element. */
export const actionElement = (name: string, args: RenderingControlArguments): string =>
  `<u:${name} xmlns:u="${RENDERING_CONTROL_SERVICE}">` +
  args.map(([argument, value]) => `<${argument}>${escapeXml(value)}</${argument}>`).join("") +
  `</u:${name}>`;

/** The text of the first `<name>` element in `xml`, or undefined if there is none. */
export const elementText = (xml: string, name: string): string | undefined =>
  new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z_][\\w.-]*:)?${name}>`)
    .exec(xml)?.[1]
    ?.trim();

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface RenderingControlOptions {
  readonly port?: number;
  readonly timeoutMs?: number;
}

/**
 * Calls `action` on the TV at `host`, and resolves with its answer's body.
 * Rejects with {@link RenderingControlUnavailable} when the TV doesn't answer
 * in time, e.g. in standby, or answers with a fault.
 */
const call = async (
  host: string,
  action: RenderingControlAction,
  args: RenderingControlArguments,
  { port = SAMSUNG_UPNP_PORT, timeoutMs = 2_000 }: RenderingControlOptions,
): Promise<string> => {
  let response: Response;
  let body: string;
  try {
    response = await fetch(`http://${host}:${String(port)}${RENDERING_CONTROL_PATH}`, {
      method: "POST",
      headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: soapAction(action) },
      body: soapEnvelope(actionElement(action, [...INSTANCE, ...args])),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.text();
  } catch (error) {
    throw new RenderingControlUnavailable(`The TV at ${host} didn't answer ${action}`, { cause: error });
  }
  if (!response.ok) {
    throw new RenderingControlUnavailable(`The TV at ${host} answered ${action} with ${String(response.status)}`);
  }
  return body;
};

/** Reads a whole number from the answer to `action`, or rejects if it has none in `0`…`max`. */
const numberIn = (host: string, action: RenderingControlAction, body: string, name: string, max: number): number => {
  const text = elementText(body, name) ?? "";
  const value = /^[0-9]{1,3}$/.test(text) ? Number(text) : Number.NaN;
  if (!(value >= 0 && value <= max)) {
    throw new RenderingControlUnavailable(`The TV at ${host} answered ${action} without a ${name} we can read`);
  }
  return value;
};

/** The TV's volume and whether it is muted, as it says now. */
export const readRenderingControl = async (
  host: string,
  options: RenderingControlOptions = {},
): Promise<{ readonly volume: number; readonly muted: boolean }> => {
  const [volume, mute] = await Promise.all([call(host, "GetVolume", [], options), call(host, "GetMute", [], options)]);
  return {
    volume: numberIn(host, "GetVolume", volume, "CurrentVolume", 100),
    muted: numberIn(host, "GetMute", mute, "CurrentMute", 1) === 1,
  };
};

/** Sets the TV's volume, a whole number from 0 to 100. */
export const setRenderingControlVolume = async (
  host: string,
  volume: number,
  options: RenderingControlOptions = {},
): Promise<void> => {
  await call(host, "SetVolume", [["DesiredVolume", String(volume)]], options);
};

/** Mutes the TV, or unmutes it. */
export const setRenderingControlMute = async (
  host: string,
  muted: boolean,
  options: RenderingControlOptions = {},
): Promise<void> => {
  await call(host, "SetMute", [["DesiredMute", muted ? "1" : "0"]], options);
};
