import { useEffect, useRef, useState } from "preact/hooks";

import type { SigningCertificateStatus } from "@media-centre/shared";

import { messageFor } from "./hub-request.ts";
import type { SigningCertificateApi } from "./signing-certificate-api.ts";

export interface SigningCertificateSettingProps {
  readonly signingCertificate: SigningCertificateApi;
}

/** A file's bytes in base64, as the Hub takes a certificate. */
const base64Of = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const describe = ({ stored, storedAt }: SigningCertificateStatus): string => {
  if (!stored) return "The Hub has no signing certificate yet. It needs one to install the Player on a TV.";
  const when =
    storedAt === null ? "" : `, stored on ${new Date(storedAt).toLocaleDateString(undefined, { dateStyle: "long" })}`;
  return `The Hub has a signing certificate${when}.`;
};

/**
 * Settings' signing certificate (FR-31): the Samsung certificate the Hub
 * signs the Player with to install it on a TV, as its two `.p12` files from
 * Tizen Studio's Certificate Manager, the author and the distributor
 * certificate, each with its password, the distributor's left empty when it
 * is the author's. The Hub keeps it, and only ever says whether it has one,
 * never sending it or its passwords back (FR-4); the form forgets them once
 * the Hub has them. Storing another replaces it, and it can be removed.
 */
export const SigningCertificateSetting = ({ signingCertificate }: SigningCertificateSettingProps) => {
  const [status, setStatus] = useState<SigningCertificateStatus | undefined>(undefined);
  const [author, setAuthor] = useState<File | undefined>(undefined);
  const [authorPassword, setAuthorPassword] = useState("");
  const [distributor, setDistributor] = useState<File | undefined>(undefined);
  const [distributorPassword, setDistributorPassword] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const form = useRef<HTMLFormElement>(null);

  // Read once, on opening Settings, and answered again by every change.
  useEffect(() => {
    let current = true;
    void signingCertificate.read().then(
      (read) => {
        if (current) setStatus(read);
      },
      (error: unknown) => {
        if (current) setProblem(messageFor(error));
      },
    );
    return () => {
      current = false;
    };
  }, [signingCertificate]);

  /** Runs one change on the Hub, calling `onDone` once it is made. One change runs at a time. */
  const change = async (work: () => Promise<SigningCertificateStatus>, onDone: () => void): Promise<void> => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      setStatus(await work());
      onDone();
    } catch (error) {
      setProblem(messageFor(error));
    }
    changing.current = false;
    setBusy(false);
  };

  const forget = (): void => {
    form.current?.reset();
    setAuthor(undefined);
    setAuthorPassword("");
    setDistributor(undefined);
    setDistributorPassword("");
  };

  return (
    <section aria-labelledby="settings-signing-certificate">
      <h2 id="settings-signing-certificate">Signing certificate</h2>
      <p aria-live="polite">{status === undefined ? (problem === undefined ? "Reading…" : "") : describe(status)}</p>
      <p class="hub-address-note">
        A Samsung TV installs only apps signed with a Samsung certificate that lists it. Make one with Tizen Studio's
        Certificate Manager, then give the Hub its two files here, and the Hub installs the Player from each TV's
        Developer section. The Hub keeps them, and never sends them or their passwords back.
      </p>
      {status?.stored === true &&
        (removing ? (
          <div class="room-row">
            <span class="room-name">Remove the signing certificate? The Hub can't install the Player without one.</span>
            <button
              type="button"
              class="button-danger"
              disabled={busy}
              onClick={() => {
                void change(signingCertificate.remove, () => {
                  setRemoving(false);
                });
              }}
            >
              Yes, remove
            </button>
            <button
              type="button"
              onClick={() => {
                setRemoving(false);
              }}
            >
              No, keep it
            </button>
          </div>
        ) : (
          <div class="room-row">
            <button
              type="button"
              onClick={() => {
                setRemoving(true);
              }}
            >
              Remove signing certificate
            </button>
          </div>
        ))}
      <form
        ref={form}
        class="room-form"
        aria-label="Store a signing certificate"
        onSubmit={(event) => {
          event.preventDefault();
          if (author === undefined || distributor === undefined) {
            setProblem("Choose both the author certificate and the distributor certificate.");
            return;
          }
          void change(
            async () =>
              signingCertificate.store({
                author: await base64Of(author),
                authorPassword,
                distributor: await base64Of(distributor),
                distributorPassword: distributorPassword === "" ? null : distributorPassword,
              }),
            forget,
          );
        }}
      >
        <h3 class="form-heading">{status?.stored === true ? "Replace it" : "Store one"}</h3>
        <label>
          Author certificate (author.p12)
          <input
            type="file"
            accept=".p12,application/x-pkcs12"
            onChange={(event) => {
              setAuthor(event.currentTarget.files?.[0]);
            }}
          />
        </label>
        <label>
          Author certificate's password
          <input
            type="password"
            value={authorPassword}
            autocomplete="off"
            onInput={(event) => {
              setAuthorPassword(event.currentTarget.value);
            }}
          />
        </label>
        <label>
          Distributor certificate (distributor.p12)
          <input
            type="file"
            accept=".p12,application/x-pkcs12"
            onChange={(event) => {
              setDistributor(event.currentTarget.files?.[0]);
            }}
          />
        </label>
        <label>
          Distributor certificate's password
          <input
            type="password"
            value={distributorPassword}
            autocomplete="off"
            placeholder="Left empty, the author certificate's"
            onInput={(event) => {
              setDistributorPassword(event.currentTarget.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          Store signing certificate
        </button>
        {problem !== undefined && (
          <p class="problem" role="alert">
            {problem}
          </p>
        )}
      </form>
    </section>
  );
};
