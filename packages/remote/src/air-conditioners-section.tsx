import { useEffect, useId, useRef, useState } from "preact/hooks";

import {
  APPLIANCE_NAME_MAX_LENGTH,
  CLOUD_LOGIN_MAX_LENGTH,
  type Appliance,
  type CloudLogin,
  type FoundAirConditioner,
  type Room,
} from "@media-centre/shared";

import type { AppliancesApi } from "./appliances-api.ts";
import { applianceTitle, groupByRoom } from "./appliance-names.ts";
import { DeviceRow } from "./device-row.tsx";
import { Dialog } from "./dialog.tsx";
import { HubRequestFailed, messageFor } from "./hub-request.ts";
import { NameInput } from "./name-input.tsx";
import type { RoomsApi } from "./rooms-api.ts";
import { RoomSelect } from "./tvs-section.tsx";

export interface AirConditionersSectionProps {
  readonly appliances: AppliancesApi;
  readonly rooms: RoomsApi;
  /** Changes whenever the Rooms are changed in Settings, so the Air Conditioners are shown in them as they now are. */
  readonly roomsVersion: number;
}

/** Where a refusal is shown: beside whatever the person just tried. */
type Problem = { readonly where: "list" | "find" | "add" | "edit" | number; readonly message: string };

/** What the login is asked for: to add an Air Conditioner, or to fetch one's token and key again. */
type SigningIn =
  | {
      readonly for: "add";
      readonly address: string;
      readonly name: string;
      readonly roomId: number | null;
    }
  | { readonly for: "fetch-again"; readonly airConditioner: Appliance; readonly title: string };

/** The Name field of "Add Air Conditioner by IP", where choosing a found one leaves the person. */
const ADD_NAME_ID = "add-air-conditioner-name";

const FETCHING = "Fetching the token and key from Midea's cloud…";

/**
 * Settings' Air Conditioners (FR-51): find the Midea units on the network,
 * or add one by its IP address, then rename it, move it to another Room or
 * remove it, as a TV is (FR-8, FR-11). Each is named "Room · Name" (FR-9) and
 * listed under its Room, in Room order, or under "No room". A found one is
 * added through "Add Air Conditioner by IP".
 *
 * A unit on Midea's protocol v3 needs a token and key from Midea's cloud
 * before it answers on the home network, so adding one asks, in a dialog,
 * for the owner's MSmartHome login, once: the Hub fetches them, keeps only
 * them, and forgets the login (ADR 0009). One that later refuses them, as
 * after a factory reset, says so, and offers to fetch them again.
 */
export const AirConditionersSection = ({ appliances, rooms, roomsVersion }: AirConditionersSectionProps) => {
  const [airConditioners, setAirConditioners] = useState<readonly Appliance[] | undefined>(undefined);
  const [roomList, setRoomList] = useState<readonly Room[]>([]);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [adding, setAdding] = useState({ address: "", name: "", roomId: "" });
  const [editing, setEditing] = useState<{ readonly id: number; readonly name: string; readonly roomId: string }>();
  const [removing, setRemoving] = useState<number | undefined>(undefined);
  /** What is waiting on the Hub: adding one, or fetching one's token and key again. */
  const [waitingOn, setWaitingOn] = useState<"add" | number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  /** What "Find Air Conditioners" last found, or undefined before it has finished searching. */
  const [found, setFound] = useState<readonly FoundAirConditioner[] | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const [signingIn, setSigningIn] = useState<SigningIn | undefined>(undefined);
  const changing = useRef(false);
  /** The Air Conditioners whose token and key have been checked since Settings opened. */
  const checked = useRef(new Set<number>());

  const replace = (airConditioner: Appliance): void => {
    setAirConditioners((current) => current?.map((each) => (each.id === airConditioner.id ? airConditioner : each)));
  };

  /**
   * Has the Hub read each Air Conditioner once, so one that no longer
   * accepts its token and key shows "Fetch again" (FR-51). One that can't be
   * reached is left as it was.
   */
  const checkKeys = (list: readonly Appliance[]): void => {
    for (const airConditioner of list) {
      if (airConditioner.pairing !== "paired" || checked.current.has(airConditioner.id)) continue;
      checked.current.add(airConditioner.id);
      appliances.checkConnection(airConditioner.id).then(replace, () => undefined);
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const [all, inOrder] = await Promise.all([appliances.list(), rooms.list()]);
      const list = all.filter(({ kind }) => kind === "air-conditioner");
      setRoomList(inOrder);
      setAirConditioners(list);
      checkKeys(list);
    } catch (error) {
      setProblem({ where: "list", message: messageFor(error) });
    }
  };

  useEffect(() => {
    void reload();
  }, [appliances, rooms, roomsVersion]);

  /**
   * Runs one change on the Hub, calling `onDone` once it is made, then shows
   * the Air Conditioners as the Hub now has them, whether or not the change
   * was made: another Remote may have changed them. One change runs at a
   * time. A refusal that needs the login calls `onLoginNeeded` instead.
   */
  const change = async (
    where: Problem["where"],
    work: () => Promise<unknown>,
    onDone: () => void = () => undefined,
    waitingFor?: "add" | number,
    onLoginNeeded?: () => void,
  ): Promise<boolean> => {
    if (changing.current) return false;
    changing.current = true;
    setBusy(true);
    setProblem(undefined);
    setWaitingOn(waitingFor);
    let done = false;
    try {
      await work();
      onDone();
      done = true;
    } catch (error) {
      if (onLoginNeeded !== undefined && error instanceof HubRequestFailed && error.needs === "login") onLoginNeeded();
      else setProblem({ where, message: messageFor(error) });
    }
    setWaitingOn(undefined);
    await reload();
    changing.current = false;
    setBusy(false);
    return done;
  };

  /** Has the Hub search its network for Air Conditioners (FR-51), which takes a few seconds. */
  const findAirConditioners = async (): Promise<void> => {
    setFinding(true);
    setFound(undefined);
    setProblem(undefined);
    try {
      setFound(await appliances.findAirConditioners());
    } catch (error) {
      setProblem({ where: "find", message: messageFor(error) });
    }
    setFinding(false);
  };

  /** Fills in "Add Air Conditioner by IP" with a found one's address, to name it and choose its Room there. */
  const choose = (airConditioner: FoundAirConditioner): void => {
    setAdding({ ...adding, address: airConditioner.address, name: "" });
    setProblem(undefined);
    document.getElementById(ADD_NAME_ID)?.focus();
  };

  /** The Air Conditioner a found one already is, by the serial number both read from it. */
  const addedAs = (airConditioner: FoundAirConditioner): Appliance | undefined =>
    airConditioners?.find(({ serialNumber }) => serialNumber === airConditioner.serialNumber);

  const roomIdFrom = (value: string): number | null => (value === "" ? null : Number(value));

  const resetAdding = (): void => {
    setAdding({ address: "", name: "", roomId: "" });
  };

  /**
   * Adds the Air Conditioner at the address. One found needing the login
   * asks for it at once; any other is tried without, and asks for it if the
   * Hub says it needs it, as one added by IP on v3 does.
   */
  const add = (): void => {
    const asked = { address: adding.address.trim(), name: adding.name, roomId: roomIdFrom(adding.roomId) };
    const signIn = (): void => {
      setSigningIn({ for: "add", ...asked });
    };
    if (found?.some(({ address, needsLogin }) => needsLogin && address === asked.address) === true) {
      signIn();
      return;
    }
    void change("add", () => appliances.add({ kind: "air-conditioner", ...asked }), resetAdding, "add", signIn);
  };

  /** Sends the login with what it was asked for, once. It stays in the dialog's fields alone, and goes with them. */
  const signInWith = async (login: CloudLogin): Promise<boolean> => {
    if (signingIn === undefined) return false;
    const asked = signingIn;
    if (asked.for === "add") {
      const done = await change(
        "add",
        () =>
          appliances.add({
            kind: "air-conditioner",
            address: asked.address,
            name: asked.name,
            roomId: asked.roomId,
            login,
          }),
        resetAdding,
        "add",
      );
      return done;
    }
    return change(
      asked.airConditioner.id,
      () => appliances.fetchAgain(asked.airConditioner.id, login),
      undefined,
      asked.airConditioner.id,
    );
  };

  /** Where a refusal goes while the login dialog is open: into it, as the rest of the page is behind it. */
  const dialogWhere: Problem["where"] | undefined =
    signingIn === undefined ? undefined : signingIn.for === "add" ? "add" : signingIn.airConditioner.id;

  const problemAt = (where: Problem["where"]) =>
    problem?.where === where &&
    dialogWhere !== where && (
      <p id={`air-conditioners-problem-${String(where)}`} class="problem" role="alert">
        {problem.message}
      </p>
    );

  const waiting = (on: "add" | number) =>
    waitingOn === on && (
      <p class="waiting" role="status">
        {on === "add" ? "Adding the Air Conditioner…" : FETCHING}
      </p>
    );

  return (
    <section aria-labelledby="settings-air-conditioners">
      <div class="settings-card-head">
        <div>
          <h2 id="settings-air-conditioners">
            Air Conditioners
            {airConditioners !== undefined && airConditioners.length > 0 && (
              <span class="count" aria-hidden="true">
                {airConditioners.length}
              </span>
            )}
          </h2>
          <p class="settings-card-lead">
            Each Midea unit the Hub controls. Edit one to rename it or move it to another Room.
          </p>
        </div>
      </div>
      {airConditioners === undefined ? (
        problem === undefined && <p>Loading the Air Conditioners…</p>
      ) : airConditioners.length === 0 ? (
        <p>
          No Air Conditioners yet. Find them on the network below, or add one by its IP address, which your router or
          Midea's app shows.
        </p>
      ) : (
        <ul class="device-list">
          {groupByRoom(airConditioners, roomList)
            .flatMap(({ appliances: inGroup }) => inGroup)
            .map((airConditioner) => {
              const title = applianceTitle(airConditioner, roomList);
              return (
                <li key={airConditioner.id} aria-label={title}>
                  {editing?.id === airConditioner.id ? (
                    <form
                      class="room-form"
                      aria-label={`Edit ${title}`}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void change(
                          "edit",
                          () =>
                            appliances.update(airConditioner.id, {
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
                        label="Air Conditioner name"
                        value={editing.name}
                        placeholder={`Up to ${String(APPLIANCE_NAME_MAX_LENGTH)} characters`}
                        invalid={problem?.where === "edit"}
                        describedBy="air-conditioners-problem-edit"
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
                  ) : removing === airConditioner.id ? (
                    <div class="room-row">
                      <span class="room-name">Remove {title}? The Hub forgets its token and key too.</span>
                      <button
                        type="button"
                        class="button-danger"
                        disabled={busy}
                        onClick={() => {
                          void change(airConditioner.id, () => appliances.remove(airConditioner.id));
                          setRemoving(undefined);
                        }}
                      >
                        Yes, remove
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoving(undefined);
                        }}
                      >
                        No, keep it
                      </button>
                    </div>
                  ) : (
                    <DeviceRow
                      icon="air-vent"
                      name={airConditioner.name}
                      room={roomList.find(({ id }) => id === airConditioner.roomId)?.name}
                      details={
                        <>
                          {airConditioner.model}, at {airConditioner.address}
                        </>
                      }
                    >
                      <button
                        type="button"
                        aria-label={`Edit ${title}`}
                        onClick={() => {
                          setEditing({
                            id: airConditioner.id,
                            name: airConditioner.name,
                            roomId: airConditioner.roomId === null ? "" : String(airConditioner.roomId),
                          });
                          setRemoving(undefined);
                          setProblem(undefined);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${title}`}
                        onClick={() => {
                          setRemoving(airConditioner.id);
                          setEditing(undefined);
                        }}
                      >
                        Remove
                      </button>
                    </DeviceRow>
                  )}
                  {airConditioner.pairing === "pair-again" && (
                    <div class="room-row">
                      <p id={`air-conditioner-${String(airConditioner.id)}-keys`} class="room-name problem">
                        This Air Conditioner no longer accepts the Hub's token and key, as after a factory reset.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        aria-describedby={`air-conditioner-${String(airConditioner.id)}-keys`}
                        onClick={() => {
                          setProblem(undefined);
                          setSigningIn({ for: "fetch-again", airConditioner, title });
                        }}
                      >
                        Fetch again
                      </button>
                    </div>
                  )}
                  {waiting(airConditioner.id)}
                  {problemAt(airConditioner.id)}
                </li>
              );
            })}
        </ul>
      )}
      {problemAt("list")}
      <section class="room-form" aria-labelledby="find-air-conditioners">
        <h3 id="find-air-conditioners" class="form-heading">
          Find Air Conditioners
        </h3>
        <p class="form-help">
          Looks for Midea Air Conditioners that are plugged in and on the same network as the Hub.
        </p>
        <button type="button" disabled={finding} onClick={() => void findAirConditioners()}>
          Find Air Conditioners
        </button>
        {finding && (
          <p class="waiting" role="status">
            Looking for Air Conditioners on the network…
          </p>
        )}
        {found !== undefined &&
          (found.length === 0 ? (
            <p class="found-none" role="status">
              No Air Conditioners found. Check that it is plugged in and on the same network as the Hub, or add it by
              its IP address under "Add Air Conditioner by IP" below.
            </p>
          ) : (
            <ul class="rooms found" aria-label="Air Conditioners found">
              {found.map((airConditioner) => {
                const added = addedAs(airConditioner);
                return (
                  <li
                    key={`${airConditioner.serialNumber} ${airConditioner.address}`}
                    aria-label={`${airConditioner.name}, at ${airConditioner.address}`}
                  >
                    <div class="room-row">
                      <span class="found-name">{airConditioner.name}</span>
                      {added === undefined ? (
                        <button
                          type="button"
                          aria-label={`Add ${airConditioner.name}, at ${airConditioner.address}`}
                          onClick={() => {
                            choose(airConditioner);
                          }}
                        >
                          Add
                        </button>
                      ) : (
                        <span class="found-added">Added, as {applianceTitle(added, roomList)}</span>
                      )}
                    </div>
                    <p class="appliance-details">
                      At {airConditioner.address}
                      {airConditioner.needsLogin ? ", needs the MSmartHome login once" : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          ))}
        {problemAt("find")}
      </section>
      <form
        class="room-form"
        aria-label="Add Air Conditioner by IP"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <h3 class="form-heading">Add Air Conditioner by IP</h3>
        <p class="form-help">Plug it in first. It has to be on the same network as the Hub.</p>
        <label>
          IP address
          <input
            type="text"
            inputMode="decimal"
            value={adding.address}
            placeholder="e.g. 192.168.1.30"
            autocomplete="off"
            aria-invalid={problem?.where === "add"}
            {...(problem?.where === "add" ? { "aria-describedby": "air-conditioners-problem-add" } : {})}
            onInput={(event) => {
              setAdding({ ...adding, address: event.currentTarget.value });
            }}
          />
        </label>
        <NameInput
          id={ADD_NAME_ID}
          label="Name"
          value={adding.name}
          placeholder="Left empty, its own name"
          invalid={false}
          describedBy="air-conditioners-problem-add"
          onInput={(name) => {
            setAdding({ ...adding, name });
          }}
        />
        <RoomSelect
          rooms={roomList}
          value={adding.roomId}
          onChange={(roomId) => {
            setAdding({ ...adding, roomId });
          }}
        />
        <button type="submit" disabled={busy}>
          Add Air Conditioner
        </button>
        {waiting("add")}
        {problemAt("add")}
      </form>
      <LoginDialog
        signingIn={signingIn}
        busy={busy}
        onSignIn={signInWith}
        onClose={() => {
          setSigningIn(undefined);
        }}
        problem={dialogWhere !== undefined && problem?.where === dialogWhere ? problem.message : undefined}
      />
    </section>
  );
};

interface LoginDialogProps {
  readonly signingIn: SigningIn | undefined;
  readonly busy: boolean;
  /** Resolves with whether the Hub did what the login was for, which closes the dialog. */
  readonly onSignIn: (login: CloudLogin) => Promise<boolean>;
  readonly onClose: () => void;
  /** Why the Hub refused, e.g. the login, shown in the dialog to try again. */
  readonly problem: string | undefined;
}

/**
 * Asks for the owner's MSmartHome login, once, to fetch an Air Conditioner's
 * token and key with. The login is kept only in these fields while the
 * dialog is open, and cleared as it closes; the Hub forgets it once it has
 * the token and key (ADR 0009).
 */
const LoginDialog = ({ signingIn, busy, onSignIn, onClose, problem }: LoginDialogProps) => {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const formId = useId();
  const problemId = useId();

  const close = (): void => {
    setAccount("");
    setPassword("");
    onClose();
  };

  return (
    <Dialog
      open={signingIn !== undefined}
      onClose={close}
      title="Sign in to MSmartHome"
      closeLabel="Close, without signing in"
      footer={
        signingIn !== undefined && (
          <>
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button type="submit" form={formId} class="button-primary" disabled={busy}>
              {signingIn.for === "add" ? "Sign in and add" : "Sign in and fetch again"}
            </button>
          </>
        )
      }
    >
      {signingIn !== undefined && (
        <form
          id={formId}
          class="room-form"
          aria-label="MSmartHome login"
          onSubmit={(event) => {
            event.preventDefault();
            void onSignIn({ account, password }).then((done) => {
              if (done) close();
            });
          }}
        >
          <p>
            {signingIn.for === "add"
              ? "This Air Conditioner answers the Hub only with a token and key from Midea's cloud."
              : `${signingIn.title} no longer accepts its token and key, as after a factory reset.`}{" "}
            Sign in with your MSmartHome account, once: the Hub fetches the token and key, keeps only them, and forgets
            your email and password. After that it needs neither the internet nor the account.
          </p>
          <p class="form-help">
            The Air Conditioner must be paired in the MSmartHome app, on that account. Midea no longer issues the token
            and key to Midea Air or NetHome Plus accounts, nor to accounts moved from them: if yours is one, make a new
            account in the MSmartHome app and pair the Air Conditioner there.
          </p>
          <label>
            Email
            <input
              type="email"
              value={account}
              required
              maxLength={CLOUD_LOGIN_MAX_LENGTH}
              autocomplete="username"
              aria-invalid={problem !== undefined}
              {...(problem === undefined ? {} : { "aria-describedby": problemId })}
              onInput={(event) => {
                setAccount(event.currentTarget.value);
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
              aria-invalid={problem !== undefined}
              {...(problem === undefined ? {} : { "aria-describedby": problemId })}
              onInput={(event) => {
                setPassword(event.currentTarget.value);
              }}
            />
          </label>
          {busy && (
            <p class="waiting" role="status">
              {FETCHING}
            </p>
          )}
          {problem !== undefined && (
            <p id={problemId} class="problem" role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
};
