import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

/** The size of the fake TV's app icons, in pixels. Small, as only the Hub and the Remote look at them. */
const SIDE = 16;

/**
 * An app's icon for the fake TV: a PNG of one colour, chosen from the app's
 * id, so that each app's differs, and each is the same every time.
 */
export const fakeAppIcon = (appId: string): Buffer => {
  const [red = 0, green = 0, blue = 0] = createHash("sha256").update(appId).digest();
  const row = Buffer.from([0, ...Array.from({ length: SIDE }, () => [red, green, blue]).flat()]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIDE, 0);
  header.writeUInt32BE(SIDE, 4);
  // 8 bits a channel, truecolour, no interlacing.
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: SIDE }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, check]);
};
