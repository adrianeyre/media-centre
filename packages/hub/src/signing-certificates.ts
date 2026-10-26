import type { DatabaseSync } from "node:sqlite";

import type { SigningCertificateStatus } from "@media-centre/shared";

import type { SigningCertificate } from "./drivers/driver.ts";

export interface SigningCertificateStore {
  /** Whether the Hub has a signing certificate, and since when, which is all that ever leaves the Hub (FR-4). */
  readonly status: () => SigningCertificateStatus;
  /** The signing certificate, for a Driver to sign the Player with, or null when the Hub has none. */
  readonly read: () => SigningCertificate | null;
  /** Keeps it, in place of any the Hub had. */
  readonly store: (certificate: SigningCertificate) => SigningCertificateStatus;
  /** Forgets it, overwriting it in the database. */
  readonly remove: () => SigningCertificateStatus;
}

/**
 * The owner's signing certificate, which the Player is signed with to install
 * it on a TV (FR-31), kept only in the Hub's database, so that it survives a
 * restart (NFR-4).
 */
export const signingCertificateStore = (database: DatabaseSync): SigningCertificateStore => {
  const status = (): SigningCertificateStatus => {
    const row = database.prepare("SELECT stored_at FROM signing_certificate").get() as
      { stored_at: string } | undefined;
    return { stored: row !== undefined, storedAt: row?.stored_at ?? null };
  };

  return {
    status,
    read: () => {
      const row = database
        .prepare("SELECT author, author_password, distributor, distributor_password FROM signing_certificate")
        .get() as
        | { author: Uint8Array; author_password: string; distributor: Uint8Array; distributor_password: string }
        | undefined;
      if (row === undefined) return null;
      return {
        author: row.author,
        authorPassword: row.author_password,
        distributor: row.distributor,
        distributorPassword: row.distributor_password,
      };
    },
    store: ({ author, authorPassword, distributor, distributorPassword }) => {
      database
        .prepare(
          "INSERT INTO signing_certificate " +
            "(singleton, author, author_password, distributor, distributor_password, stored_at) " +
            "VALUES (1, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (singleton) DO UPDATE SET author = excluded.author, " +
            "author_password = excluded.author_password, distributor = excluded.distributor, " +
            "distributor_password = excluded.distributor_password, stored_at = excluded.stored_at",
        )
        .run(author, authorPassword, distributor, distributorPassword, new Date().toISOString());
      return status();
    },
    remove: () => {
      database.prepare("DELETE FROM signing_certificate").run();
      return status();
    },
  };
};
