/** The kinds of image the Hub passes on from an Appliance, e.g. an app's icon (FR-21). */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * What kind of image the bytes are, from their first few, or undefined for
 * anything else, which the Hub doesn't pass on: it never serves the Remote
 * what an Appliance sent as an image without knowing it is one.
 */
export const imageTypeOf = (bytes: Uint8Array): ImageType | undefined => {
  const starts = (...prefix: number[]): boolean => prefix.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
};
