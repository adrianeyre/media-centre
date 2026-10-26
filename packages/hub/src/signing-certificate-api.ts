import type { IncomingMessage, ServerResponse } from "node:http";

import {
  SIGNING_CERTIFICATE_MAX_BYTES,
  SIGNING_CERTIFICATE_PATH,
  SIGNING_PASSWORD_MAX_LENGTH,
} from "@media-centre/shared";

import type { SigningCertificate } from "./drivers/driver.ts";
import { HttpRefusal, readJson, refuseMethod, sendJson } from "./http.ts";
import type { SigningCertificateStore } from "./signing-certificates.ts";

/** Both halves of the biggest signing certificate in base64, their passwords, and room to spare. */
const MAX_REQUEST_BYTES = 4 * SIGNING_CERTIFICATE_MAX_BYTES;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Answers the Remote's requests about the signing certificate (see
 * `SIGNING_CERTIFICATE_PATH` in `shared`), or returns false for a path that
 * isn't it. It only ever answers whether the Hub has one; the certificate and
 * its passwords never leave the Hub, and a change is logged without them
 * (FR-4).
 */
export const handleSigningCertificateRequest = async (
  certificates: SigningCertificateStore,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> => {
  if (pathname !== SIGNING_CERTIFICATE_PATH) return false;
  switch (request.method) {
    case "GET":
    case "HEAD":
      sendJson(response, 200, certificates.status());
      return true;
    case "PUT": {
      const stored = certificates.store(certificateIn(await readJson(request, MAX_REQUEST_BYTES)));
      console.log("Stored the signing certificate, to install the Player with");
      sendJson(response, 200, stored);
      return true;
    }
    case "DELETE": {
      const removed = certificates.remove();
      console.log("Removed the signing certificate");
      sendJson(response, 200, removed);
      return true;
    }
    default:
      refuseMethod(response, ["GET", "HEAD", "PUT", "DELETE"]);
      return true;
  }
};

/** One half of a signing certificate, a `.p12` file in base64, which may be anything. */
const certificateFileIn = (body: object, key: "author" | "distributor", name: string): Uint8Array => {
  const value = key in body ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || value === "") throw new HttpRefusal(400, `Choose the ${name} file, a .p12 file.`);
  const bytes = BASE64.test(value) ? Buffer.from(value, "base64") : undefined;
  // A .p12 file is DER, which starts with a SEQUENCE.
  if (bytes === undefined || bytes.length === 0 || bytes[0] !== 0x30) {
    throw new HttpRefusal(400, `The ${name} isn't a .p12 file. Choose the one Tizen Studio made.`);
  }
  if (bytes.length > SIGNING_CERTIFICATE_MAX_BYTES) {
    throw new HttpRefusal(400, `The ${name} is too big to be a .p12 file. Choose the one Tizen Studio made.`);
  }
  return new Uint8Array(bytes);
};

/** A password, which may be anything. Its value is never put in a refusal. */
const passwordIn = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value === "") throw new HttpRefusal(400, `Give the ${name}'s password.`);
  if (value.length > SIGNING_PASSWORD_MAX_LENGTH) {
    throw new HttpRefusal(400, `The ${name}'s password is longer than any Tizen Studio takes.`);
  }
  return value;
};

/** The signing certificate a `SigningCertificateRequest` gives, which may be anything. */
const certificateIn = (body: unknown): SigningCertificate => {
  if (typeof body !== "object" || body === null) throw new HttpRefusal(400, "Give the signing certificate.");
  const author = certificateFileIn(body, "author", "author certificate");
  const authorPassword = passwordIn("authorPassword" in body ? body.authorPassword : undefined, "author certificate");
  const distributor = certificateFileIn(body, "distributor", "distributor certificate");
  const asked = "distributorPassword" in body ? body.distributorPassword : undefined;
  const distributorPassword =
    asked === undefined || asked === null || asked === ""
      ? authorPassword
      : passwordIn(asked, "distributor certificate");
  return { author, authorPassword, distributor, distributorPassword };
};
