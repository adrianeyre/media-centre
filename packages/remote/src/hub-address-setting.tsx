import { useEffect, useRef, useState } from "preact/hooks";

import type { HubAddress } from "@media-centre/shared";

import type { HubAddressApi } from "./hub-address-api.ts";
import { messageFor } from "./hub-request.ts";

export interface HubAddressSettingProps {
  readonly hubAddress: HubAddressApi;
}

const describe = ({ address, found, override }: HubAddress): string => {
  if (address === null) return "The Hub couldn't find its IP address on your home network. Set it below.";
  if (override === null) return `The Hub's IP address is ${address}, which it found on its network.`;
  return found === null
    ? `The Hub's IP address is set to ${override}.`
    : `The Hub's IP address is set to ${override}, rather than ${found}, which it found on its network.`;
};

/**
 * Settings' Hub IP address (FR-29): the one the Hub found on its network, and
 * a field to set another to use instead, e.g. on a machine on more than one
 * network, or to go back to the one found. TVs are given it as their
 * Developer IP. The Hub decides what an IP address is, and says why it
 * refuses one.
 */
export const HubAddressSetting = ({ hubAddress }: HubAddressSettingProps) => {
  const [read, setRead] = useState<HubAddress | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  /** Whether the person has typed in the field, which the first reading then leaves alone. */
  const edited = useRef(false);

  // Read once, on opening Settings, and answered again by every change.
  useEffect(() => {
    let current = true;
    void hubAddress.read().then(
      (address) => {
        if (!current) return;
        setRead(address);
        if (!edited.current) setTyped(address.override ?? "");
      },
      (error: unknown) => {
        if (current) setProblem(messageFor(error));
      },
    );
    return () => {
      current = false;
    };
  }, [hubAddress]);

  /** Sets the address to use, or with null the one found. One change runs at a time. */
  const change = async (override: string | null): Promise<void> => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      const address = await hubAddress.setOverride(override);
      setRead(address);
      setTyped(address.override ?? "");
    } catch (error) {
      setProblem(messageFor(error));
    }
    changing.current = false;
    setBusy(false);
  };

  return (
    <div class="hub-address" role="group" aria-labelledby="hub-address-heading">
      <h3 id="hub-address-heading">IP address</h3>
      <p class="hub-address-now" aria-live="polite">
        {read === undefined ? (problem === undefined ? "Reading the Hub's IP address…" : "") : describe(read)}
      </p>
      <p class="hub-address-note">
        Each TV is given it as its Developer IP. Set it here if the Hub found the wrong one, as it may on a machine on
        more than one network.
      </p>
      <form
        class="room-form"
        aria-label="Set the Hub's IP address"
        onSubmit={(event) => {
          event.preventDefault();
          void change(typed.trim() === "" ? null : typed);
        }}
      >
        <label>
          IP address to use
          <input
            type="text"
            inputMode="decimal"
            value={typed}
            placeholder={read?.found ?? "e.g. 192.168.1.10"}
            autocomplete="off"
            aria-invalid={problem !== undefined}
            {...(problem === undefined ? {} : { "aria-describedby": "hub-address-problem" })}
            onInput={(event) => {
              edited.current = true;
              setTyped(event.currentTarget.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          Use this IP address
        </button>
        {read?.override !== null && read?.override !== undefined && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void change(null);
            }}
          >
            Use the one found
          </button>
        )}
        {problem !== undefined && (
          <p id="hub-address-problem" class="problem" role="alert">
            {problem}
          </p>
        )}
      </form>
    </div>
  );
};
