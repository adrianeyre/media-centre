import { useEffect, useRef, useState } from "preact/hooks";

import {
  APPLIANCE_NAME_MAX_LENGTH,
  CLOUD_LOGIN_MAX_LENGTH,
  HIVE_CODE_MAX_LENGTH,
  type Appliance,
  type HiveAccount,
  type Room,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, groupByRoom } from "./appliance-names.ts";
import { messageFor } from "./hub-request.ts";
import { DeviceRow } from "./device-row.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { NameInput } from "./name-input.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { RoomSelect } from "./tvs-section.tsx";

export interface HiveSectionProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Changes whenever the Rooms are changed in Settings, so Hive's Appliances are shown in them as they now are. */
  readonly roomsVersion: number;
}

/** The kinds of Appliance that are Hive's. */
const HIVE_KINDS: readonly Appliance["kind"][] = ["heating", "radiator-valve", "hot-water"];

/** Hive's Appliances, a card for each kind: what it holds, said at its top. */
const HIVE_LISTS: readonly {
  readonly kind: Appliance["kind"];
  readonly heading: string;
  readonly lead: string;
  readonly icon: IconName;
}[] = [
  {
    kind: "heating",
    heading: "Heating zones",
    lead: "Each zone's Hive thermostat. Boosting a zone boosts its Radiator Valves too. Edit one to rename it or give it a Room.",
    icon: "flame",
  },
  {
    kind: "radiator-valve",
    heading: "Radiator Valves",
    lead: "One on each radiator. Give each its Room, so that it shows in that Room, in the Rooms tab and on the floor plan.",
    icon: "thermometer",
  },
  {
    kind: "hot-water",
    heading: "Hot Water",
    lead: "Your hot water's timer. Edit it to rename it or give it a Room.",
    icon: "droplet",
  },
];

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = {
  readonly where: "list" | "sign-in" | "code" | "sign-out" | "edit";
  readonly message: string;
};

/**
 * Settings' Hive (FR-67): Hive needs the internet, as the one exception to
 * controlling Appliances on the home network (ADR 0010), so the section
 * says so. The owner signs in once, with the Hive account owner's email and
 * password, and the code Hive texts if it asks for one; the Hub keeps only
 * Hive's tokens, never the password, which stays in its field only until
 * it is sent. Every Heating, Radiator Valve and Hot Water on the account
 * then appears by itself, with Hive's name, in "No room", to be renamed and
 * given a Room as any Appliance is (FR-8), through the Edit beside each,
 * which the section says is how. As Settings opens, the Hub asks Hive
 * whether it still accepts the tokens, and if it doesn't, the section says
 * so and offers to sign in again (FR-67b). Hive's Appliances are listed as
 * soon as the Hub answers with them, not only once Hive has answered too,
 * which takes a few seconds and may fail: renaming one or giving it a Room
 * is the Hub's alone, and needs nothing of Hive. Sign out removes every one
 * of Hive's Appliances from the Heating tab.
 */
export const HiveSection = ({ appliances, rooms, roomsVersion }: HiveSectionProps) => {
  const [account, setAccount] = useState<HiveAccount | undefined>(undefined);
  const [hiveAppliances, setHiveAppliances] = useState<readonly Appliance[]>([]);
  const [roomList, setRoomList] = useState<readonly Room[]>([]);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  /** Which of the sign-in's steps is shown: the login, the code Hive asked for, or neither. */
  const [signingIn, setSigningIn] = useState<"login" | "code" | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [editing, setEditing] = useState<{ readonly id: number; readonly name: string; readonly roomId: string }>();
  const [signingOut, setSigningOut] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What is waiting on the Hub, while it is. */
  const [waitingOn, setWaitingOn] = useState<Problem["where"] | undefined>(undefined);
  const changing = useRef(false);

  const reload = async (): Promise<void> => {
    try {
      const [all, inOrder] = await Promise.all([appliances.list(), rooms.list()]);
      setRoomList(inOrder);
      setHiveAppliances(all.filter(({ kind }) => HIVE_KINDS.includes(kind)));
    } catch (error) {
      setProblem({ where: "list", message: messageFor(error) });
    }
  };

  // Hive is asked once, as Settings opens, whether it still accepts the Hub's tokens (FR-67b).
  useEffect(() => {
    appliances.readHive().then(
      (read) => {
        setAccount(read);
        if (!read.signedIn) setSigningIn("login");
        // Hive's Appliances the Hub added as it asked.
        void reload();
      },
      (error: unknown) => {
        setProblem({ where: "list", message: messageFor(error) });
      },
    );
  }, [appliances]);

  useEffect(() => {
    void reload();
  }, [appliances, rooms, roomsVersion]);

  /**
   * Runs one change on the Hub, calling `onDone` with what it answered once
   * it is made, then shows Hive's Appliances as the Hub now has them,
   * whether or not the change was made. One change runs at a time.
   */
  const change = async <T,>(
    where: Problem["where"],
    work: () => Promise<T>,
    onDone: (done: T) => void = () => undefined,
  ): Promise<void> => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    setWaitingOn(where);
    try {
      onDone(await work());
    } catch (error) {
      setProblem({ where, message: messageFor(error) });
    }
    setWaitingOn(undefined);
    await reload();
    changing.current = false;
    setBusy(false);
  };

  const signedIn = (): void => {
    setAccount({ signedIn: true, tokens: "accepted" });
    setSigningIn(undefined);
    setEmail("");
    setCode("");
  };

  const signIn = (): void => {
    const login = { account: email, password };
    // The password goes no further than this request.
    setPassword("");
    void change(
      "sign-in",
      () => appliances.signInToHive(login),
      (outcome) => {
        if (outcome.signedIn) signedIn();
        else setSigningIn("code");
      },
    );
  };

  const enterCode = (): void => {
    void change("code", () => appliances.enterHiveCode(code), signedIn);
  };

  const signOut = (): void => {
    void change(
      "sign-out",
      () => appliances.signOutOfHive(),
      () => {
        setAccount({ signedIn: false });
        setSigningIn("login");
        setSigningOut(false);
        setEditing(undefined);
      },
    );
  };

  const roomIdFrom = (value: string): number | null => (value === "" ? null : Number(value));

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where && (
      <p id={`hive-problem-${where}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  const waiting = (on: Problem["where"], what: string) =>
    waitingOn === on && (
      <p class="waiting" role="status">
        {what}
      </p>
    );

  /** Hive's Appliances of one kind, in Room order, "No room" last, as Settings lists them. */
  const ofKind = (kind: Appliance["kind"]): Appliance[] =>
    groupByRoom(
      hiveAppliances.filter((appliance) => appliance.kind === kind),
      roomList,
    ).flatMap(({ appliances: inGroup }) => inGroup);

  return (
    <>
      <section aria-labelledby="settings-hive" class="settings-card">
        <div class="settings-card-head">
          <div>
            <h2 id="settings-hive">Hive</h2>
            <p class="settings-card-lead">
              Hive's Heating, Radiator Valves and Hot Water are controlled through Hive's cloud, so they need the
              internet. Nothing else in the Remote does.
            </p>
          </div>
          {account?.signedIn === true && account.tokens === "accepted" && (
            <span class="chip chip-good" role="status">
              <Icon name="check" />
              Signed in to Hive
            </span>
          )}
        </div>
        {account === undefined ? (
          problem === undefined && <p>Checking Hive…</p>
        ) : !account.signedIn ? null : account.tokens === "refused" ? (
          <div class="room-row">
            <p id="hive-sign-in-again" class="room-name problem">
              Hive no longer accepts the Hub's sign-in, as happens now and then. The Heating can't be controlled until
              you sign in again.
            </p>
            {signingIn === undefined && (
              <button
                type="button"
                aria-describedby="hive-sign-in-again"
                onClick={() => {
                  setProblem(undefined);
                  setSigningIn("login");
                }}
              >
                Sign in again
              </button>
            )}
          </div>
        ) : account.tokens === "unreachable" ? (
          <p class="problem" role="status">
            Can't reach Hive. Check that the Hub is connected to the internet.
          </p>
        ) : null}
        {signingIn === "login" && (
          <form
            class="room-form"
            aria-label="Sign in to Hive"
            onSubmit={(event) => {
              event.preventDefault();
              signIn();
            }}
          >
            <h3 class="form-heading">Sign in to Hive</h3>
            <p class="form-help">
              Sign in once with the Hive account owner's email and password, as in Hive's app. The Hub keeps only the
              sign-in Hive gives it, never your password.
            </p>
            <label>
              Email
              <input
                type="email"
                value={email}
                required
                maxLength={CLOUD_LOGIN_MAX_LENGTH}
                autocomplete="username"
                aria-invalid={problem?.where === "sign-in"}
                {...(problem?.where === "sign-in" ? { "aria-describedby": "hive-problem-sign-in" } : {})}
                onInput={(event) => {
                  setEmail(event.currentTarget.value);
                }}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                required
                maxLength={CLOUD_LOGIN_MAX_LENGTH}
                autocomplete="current-password"
                aria-invalid={problem?.where === "sign-in"}
                {...(problem?.where === "sign-in" ? { "aria-describedby": "hive-problem-sign-in" } : {})}
                onInput={(event) => {
                  setPassword(event.currentTarget.value);
                }}
              />
            </label>
            <button type="submit" class="button-primary" disabled={busy}>
              Sign in
            </button>
            {account?.signedIn === true && (
              <button
                type="button"
                onClick={() => {
                  setSigningIn(undefined);
                  setPassword("");
                  setProblem(undefined);
                }}
              >
                Cancel
              </button>
            )}
            {waiting("sign-in", "Signing in to Hive…")}
            {problemAt("sign-in")}
          </form>
        )}
        {signingIn === "code" && (
          <form
            class="room-form"
            aria-label="Hive's code"
            onSubmit={(event) => {
              event.preventDefault();
              enterCode();
            }}
          >
            <h3 class="form-heading">Hive's code</h3>
            <p class="form-help">
              Hive has texted a code to the account owner's phone. Enter it within a few minutes. Hive then trusts the
              Hub, and won't ask it for a code again.
            </p>
            <label>
              Code
              <input
                type="text"
                inputMode="numeric"
                value={code}
                required
                maxLength={HIVE_CODE_MAX_LENGTH}
                autocomplete="one-time-code"
                aria-invalid={problem?.where === "code"}
                {...(problem?.where === "code" ? { "aria-describedby": "hive-problem-code" } : {})}
                onInput={(event) => {
                  setCode(event.currentTarget.value);
                }}
              />
            </label>
            <button type="submit" class="button-primary" disabled={busy}>
              Sign in
            </button>
            <button
              type="button"
              onClick={() => {
                setSigningIn("login");
                setCode("");
                setProblem(undefined);
              }}
            >
              Cancel
            </button>
            {waiting("code", "Signing in to Hive…")}
            {problemAt("code")}
          </form>
        )}
        {account?.signedIn === true &&
          (signingOut ? (
            <div class="room-row">
              <span class="room-name">
                Sign out of Hive? The Hub forgets its sign-in, and removes Hive's Heating, Radiator Valves and Hot Water
                from the Heating tab.
              </span>
              <button type="button" class="button-danger" disabled={busy} onClick={signOut}>
                Yes, sign out
              </button>
              <button
                type="button"
                onClick={() => {
                  setSigningOut(false);
                }}
              >
                No, stay signed in
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSigningOut(true);
                setEditing(undefined);
              }}
            >
              <Icon name="log-out" />
              Sign out of Hive
            </button>
          ))}
        {problemAt("sign-out")}
      </section>
      {account?.signedIn === true && hiveAppliances.length === 0 && (
        <section class="settings-card" aria-label="Hive's Appliances">
          <p>Hive lists no Heating, Radiator Valves or Hot Water on this account.</p>
        </section>
      )}
      {HIVE_LISTS.map(({ kind, heading, lead, icon }) => {
        const listed = ofKind(kind);
        if (listed.length === 0) return null;
        const roomless = listed.filter(({ roomId }) => !roomList.some(({ id }) => id === roomId)).length;
        const headingId = `settings-hive-${kind}`;
        return (
          <section key={kind} class="settings-card hive-kind" aria-labelledby={headingId}>
            <div class="settings-card-head">
              <div>
                <h2 id={headingId}>
                  {heading}
                  <span class="count" aria-hidden="true">
                    {listed.length}
                  </span>
                </h2>
                <p class="settings-card-lead">{lead}</p>
              </div>
              {roomless > 0 && <span class="chip chip-warning">{roomless} without a Room</span>}
            </div>
            <ul class="device-list">
              {listed.map((appliance) => {
                const title = applianceTitle(appliance, roomList);
                return (
                  <li key={appliance.id} aria-label={title}>
                    {editing?.id === appliance.id ? (
                      <form
                        class="room-form"
                        aria-label={`Edit ${title}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void change(
                            "edit",
                            () =>
                              appliances.update(appliance.id, {
                                name: editing.name,
                                roomId: roomIdFrom(editing.roomId),
                              }),
                            () => {
                              setEditing(undefined);
                            },
                          );
                        }}
                      >
                        <NameInput
                          label="Name"
                          value={editing.name}
                          placeholder={`Up to ${String(APPLIANCE_NAME_MAX_LENGTH)} characters`}
                          invalid={problem?.where === "edit"}
                          describedBy="hive-problem-edit"
                          focus
                          onInput={(name) => {
                            setEditing({ ...editing, name });
                          }}
                        />
                        <RoomSelect
                          rooms={roomList}
                          value={editing.roomId}
                          onChange={(roomId) => {
                            setEditing({ ...editing, roomId });
                          }}
                        />
                        <button type="submit" disabled={busy}>
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(undefined);
                            setProblem(undefined);
                          }}
                        >
                          Cancel
                        </button>
                        {problemAt("edit")}
                      </form>
                    ) : (
                      <DeviceRow
                        icon={icon}
                        name={appliance.name}
                        room={roomList.find(({ id }) => id === appliance.roomId)?.name}
                      >
                        <button
                          type="button"
                          aria-label={`Edit ${title}`}
                          onClick={() => {
                            setEditing({
                              id: appliance.id,
                              name: appliance.name,
                              roomId: appliance.roomId === null ? "" : String(appliance.roomId),
                            });
                            setProblem(undefined);
                          }}
                        >
                          Edit
                        </button>
                      </DeviceRow>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      {problemAt("list")}
    </>
  );
};
