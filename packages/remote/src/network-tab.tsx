import type {
  ApplianceKind,
  BluetoothDevice,
  BluetoothScan,
  DeviceRoom,
  NetworkDevice,
  NetworkScan,
  Room,
} from "@media-centre/shared";
import { useEffect, useId, useState } from "preact/hooks";

import { messageFor } from "./hub-request.ts";
import { Icon, type IconName } from "./icons.tsx";
import { NameInput } from "./name-input.tsx";
import type { NetworkApi } from "./network-api.ts";
import type { RemoteStorage } from "./remote-storage.ts";
import type { RoomsApi } from "./rooms-api.ts";
import { WidgetBoard, type WidgetDefinition } from "./widget-board.tsx";
import {
  BLUETOOTH_WIDGET_LAYOUT_KEY,
  NETWORK_WIDGET_LAYOUT_KEY,
  type Layout,
  type Placement,
} from "./widget-layout.ts";

/** How often the tab asks the Hub how far a scan, or a check of every port, has got. */
export const NETWORK_POLL_MS = 1_000;

/** Where this Remote remembers which of the tab's views it was left on. */
export const NETWORK_VIEW_KEY = "media-centre:network-view";

/**
 * Where this Remote keeps the last scan of the network, and of Bluetooth,
 * that it showed, so that it shows them at once when it opens, before the
 * Hub, which keeps them too, has answered, and with no scan needed.
 */
export const NETWORK_SCAN_CACHE_KEY = "media-centre:network-scan";
export const BLUETOOTH_SCAN_CACHE_KEY = "media-centre:bluetooth-scan";

/**
 * A scan, starting as this Remote last kept it, kept again each time it is
 * set, but while one is under way, which the Hub alone can say how far has got.
 */
const useCachedScan = <T extends { readonly scanning: boolean; readonly devices: readonly unknown[] }>(
  storage: RemoteStorage,
  key: string,
): [T | undefined, (next: T) => void] => {
  const [scan, setScan] = useState<T | undefined>(() => {
    try {
      const kept = storage.getItem(key);
      const read = kept === null ? undefined : (JSON.parse(kept) as T);
      return read !== undefined && Array.isArray(read.devices) ? { ...read, scanning: false } : undefined;
    } catch {
      return undefined;
    }
  });
  const set = (next: T): void => {
    setScan(next);
    if (next.scanning) return;
    try {
      storage.setItem(key, JSON.stringify(next));
    } catch {
      // A browser that refuses storage, or is full, just doesn't keep it.
    }
  };
  return [scan, set];
};

export type NetworkView = "network" | "bluetooth";

export interface NetworkTabProps {
  readonly network: NetworkApi;
  /** The Rooms each device can be put in, and where a new one is made. */
  readonly rooms: RoomsApi;
  /** Where this Remote remembers the tab's view and its widgets. */
  readonly storage: RemoteStorage;
}

const KIND_ICONS: Readonly<Record<ApplianceKind, IconName>> = {
  tv: "tv",
  "air-conditioner": "air-vent",
  light: "lightbulb",
  heating: "thermometer",
  "radiator-valve": "thermometer",
  "hot-water": "droplet",
};

/**
 * What a device is called: what the person named it, the Appliance's name,
 * its DNS name, who made it, or what it is.
 */
export const deviceTitle = (device: NetworkDevice): string =>
  device.name ??
  device.appliance?.name ??
  device.hostname ??
  (device.isHub ? "This Hub" : null) ??
  device.vendor ??
  (device.privateMacAddress ? "A device with a private address" : "Unknown device");

/** What a Bluetooth device is called: what the person named it, the name it advertises, or who made it. */
export const bluetoothTitle = (device: BluetoothDevice): string =>
  device.name ?? device.advertisedName ?? device.maker ?? "Unnamed Bluetooth device";

const iconFor = (device: NetworkDevice): IconName =>
  device.appliance === null ? (device.isHub ? "monitor" : "network") : KIND_ICONS[device.appliance.kind];

/** Whether any of `texts` has what was typed in the filter, ignoring case. */
const matches = (filter: string, texts: readonly (string | null | undefined)[]): boolean => {
  const wanted = filter.trim().toLowerCase();
  return wanted === "" || texts.some((each) => each?.toLowerCase().includes(wanted));
};

const networkMatches = (device: NetworkDevice, filter: string): boolean =>
  matches(filter, [
    deviceTitle(device),
    device.address,
    device.macAddress,
    device.vendor,
    device.hostname,
    device.appliance?.name,
    device.room?.name,
    ...device.openPorts.flatMap(({ port, service }) => [String(port), service]),
  ]);

const bluetoothMatches = (device: BluetoothDevice, filter: string): boolean =>
  matches(filter, [
    bluetoothTitle(device),
    device.address,
    device.advertisedName,
    device.maker,
    device.room?.name,
    device.maybeLight ? "light" : null,
    ...device.services.flatMap(({ uuid, name }) => [uuid, name]),
  ]);

const isBusy = (scan: NetworkScan | undefined): boolean =>
  scan !== undefined &&
  (scan.scanning || scan.devices.some(({ portCheck }) => portCheck.kind === "all" && !portCheck.done));

const timeOf = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** What the scan is doing, or found, in a sentence, for the status line. */
const statusOf = (scan: NetworkScan): string => {
  if (scan.scanning) {
    return scan.checked < scan.total
      ? `Looking at ${scan.checked.toLocaleString()} of ${plural(scan.total, "address", "addresses")} on ${scan.subnet ?? "the network"}…`
      : "Checking each device's ports and name…";
  }
  if (scan.finishedAt === null) return "The Hub hasn't scanned the network yet.";
  return `${plural(scan.devices.length, "device")} on ${scan.subnet ?? "the network"}, scanned at ${timeOf(scan.finishedAt)}.`;
};

const bluetoothStatusOf = (scan: BluetoothScan): string => {
  if (scan.scanning)
    return `Listening for ${String(scan.seconds)} seconds… ${plural(scan.devices.length, "device")} heard so far.`;
  if (scan.finishedAt === null) return "The Hub hasn't listened for Bluetooth devices yet.";
  return `${plural(scan.devices.length, "device")} heard, at ${timeOf(scan.finishedAt)}.`;
};

/** How strong a signal is, in a word, beside its dBm. */
const strengthOf = (signal: number): string =>
  signal >= -60 ? "Strong" : signal >= -75 ? "Good" : signal >= -85 ? "Weak" : "Very weak";

/**
 * How tall each device's widget starts, in rows of the board's grid, for a
 * desktop's 12 columns, a tablet's 8 and a phone's 4: enough for its details
 * and a few ports, which on a phone stand one above another.
 */
const NETWORK_WIDGET_ROWS: Readonly<Record<number, number>> = { 12: 16, 8: 16, 4: 21 };
const BLUETOOTH_WIDGET_ROWS: Readonly<Record<number, number>> = { 12: 13, 8: 13, 4: 17 };

/** Each device's widget, by its address. */
export const networkWidgetId = (address: string): string => `network-device-${address}`;
export const bluetoothWidgetId = (address: string): string => `bluetooth-device-${address}`;

/** Where each widget starts: three side by side on a desktop, two on a tablet, one on a phone, in the Hub's order. */
const widgetLayouts = (
  ids: readonly string[],
  rowsFor: Readonly<Record<number, number>>,
): Readonly<Record<number, Layout>> =>
  Object.fromEntries(
    [12, 8, 4].map((columns) => {
      const w = 4;
      const across = columns / w;
      const rows = rowsFor[columns] ?? 14;
      const layout: Record<string, Placement> = {};
      ids.forEach((id, index) => {
        layout[id] = { x: (index % across) * w, y: Math.floor(index / across) * rows, w, h: rows };
      });
      return [columns, layout];
    }),
  );

const loadView = (storage: RemoteStorage): NetworkView => {
  try {
    return storage.getItem(NETWORK_VIEW_KEY) === "bluetooth" ? "bluetooth" : "network";
  } catch {
    return "network";
  }
};

/**
 * The Network tab: the devices on the home network, or the Bluetooth devices
 * near the Hub, chosen at the top and remembered, each a widget, as on the
 * other tabs, which can be moved, made bigger or smaller, hidden, and named.
 * A device on the network shows its address, MAC address, maker, name, the
 * Appliance the Hub has there and its open ports, with a check of every
 * port, which the Hub remembers; a Bluetooth device, its maker, signal and
 * services, and whether it might be a light. The tab asks the Hub how far a
 * scan has got every second while one is under way.
 */
export const NetworkTab = ({ network, rooms, storage }: NetworkTabProps) => {
  const [view, setView] = useState<NetworkView>(() => loadView(storage));
  const choose = (next: NetworkView): void => {
    setView(next);
    try {
      storage.setItem(NETWORK_VIEW_KEY, next);
    } catch {
      // A browser that refuses storage just forgets.
    }
  };
  const name = useId();

  const header = (
    <div class="network-head">
      <p class="network-lead">
        {view === "network"
          ? "Every device the Hub can see on the home network, who made it, and the ports it accepts connections on."
          : "The Bluetooth devices near the Hub's PC, as each advertises itself: who made it, how strongly it is heard, and what it offers."}
      </p>
      <fieldset class="network-view">
        <legend class="visually-hidden">Show</legend>
        <div class="segmented network-segmented">
          {(
            [
              ["network", "Home network", "network"],
              ["bluetooth", "Bluetooth", "bluetooth"],
            ] as const
          ).map(([value, label, icon]) => (
            <label key={value} class="segment">
              <input
                type="radio"
                name={name}
                value={value}
                checked={view === value}
                onChange={() => {
                  choose(value);
                }}
              />
              <Icon name={icon} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );

  return view === "network" ? (
    <HomeNetwork network={network} rooms={rooms} storage={storage} header={header} />
  ) : (
    <Bluetooth network={network} rooms={rooms} storage={storage} header={header} />
  );
};

interface ViewProps extends NetworkTabProps {
  readonly header: preact.ComponentChildren;
}

/** The tab's title, its header and a view's own controls, then its widgets, or none before a scan. */
const Board = ({
  header,
  controls,
  widgets,
  rows,
  storage,
  storageKey,
}: {
  readonly header: preact.ComponentChildren;
  readonly controls: preact.ComponentChildren;
  readonly widgets: readonly WidgetDefinition[];
  readonly rows: Readonly<Record<number, number>>;
  readonly storage: RemoteStorage;
  readonly storageKey: string;
}) => {
  const toolbar = (
    <>
      <h1>Network</h1>
      <div class="network-controls">
        {header}
        {controls}
      </div>
    </>
  );
  if (widgets.length === 0) {
    return <div class="widget-toolbar network-alone">{toolbar}</div>;
  }
  return (
    <WidgetBoard
      widgets={widgets}
      defaults={widgetLayouts(
        widgets.map(({ id }) => id),
        rows,
      )}
      storage={storage}
      storageKey={storageKey}
      tab="Network"
      toolbar={toolbar}
    />
  );
};

/** A scan's button, what it is doing, how far it has got, why it failed, and the filter. */
const ScanControls = ({
  label,
  busy,
  disabled,
  status,
  progress,
  problem,
  filter,
  filterPlaceholder,
  showFilter,
  nothingMatches,
  onScan,
  onFilter,
  hint,
}: {
  readonly label: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly status: string;
  readonly progress: { readonly value: number | undefined; readonly max: number } | undefined;
  readonly problem: string | undefined;
  readonly filter: string;
  readonly filterPlaceholder: string;
  readonly showFilter: boolean;
  readonly nothingMatches: boolean;
  readonly onScan: () => void;
  readonly onFilter: (filter: string) => void;
  readonly hint?: preact.ComponentChildren;
}) => (
  <>
    <div class="network-toolbar">
      <button type="button" class="button-primary" disabled={disabled} onClick={onScan}>
        <Icon name="search" />
        {busy ? "Scanning…" : label}
      </button>
      <p class="network-status" role="status">
        {status}
      </p>
    </div>
    {hint}
    {progress !== undefined && (
      <progress
        class="network-progress"
        aria-label="How far the scan has got"
        max={progress.max}
        value={progress.value}
      />
    )}
    {problem !== undefined && (
      <p class="problem" role="alert">
        {problem}
      </p>
    )}
    {showFilter && (
      <label class="network-filter">
        <span>Filter</span>
        <input
          type="search"
          value={filter}
          placeholder={filterPlaceholder}
          onInput={(event) => {
            onFilter(event.currentTarget.value);
          }}
        />
      </label>
    )}
    {nothingMatches && <p class="network-none">No device matches “{filter.trim()}”.</p>}
  </>
);

/** The Rooms, read once the view opens and again as one is made, for each device's Room. */
const useRooms = (rooms: RoomsApi): { readonly list: readonly Room[]; readonly reload: () => Promise<void> } => {
  const [list, setList] = useState<readonly Room[]>([]);
  const reload = (): Promise<void> => rooms.list().then(setList, () => undefined);
  useEffect(() => {
    void reload();
  }, [rooms]);
  return { list, reload };
};

/** The home network's devices. */
const HomeNetwork = ({ network, rooms, storage, header }: ViewProps) => {
  const [scan, setScan] = useCachedScan<NetworkScan>(storage, NETWORK_SCAN_CACHE_KEY);
  const roomList = useRooms(rooms);
  const [problem, setProblem] = useState<string>();
  const [filter, setFilter] = useState("");

  const take = (asked: Promise<NetworkScan>): Promise<void> =>
    asked.then(
      (next) => {
        setScan(next);
        setProblem(undefined);
      },
      (error: unknown) => {
        setProblem(messageFor(error));
      },
    );

  useEffect(() => {
    void take(network.read());
  }, [network]);

  const busy = isBusy(scan);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void take(network.read());
    }, NETWORK_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [busy, network]);

  const shown = scan?.devices.filter((device) => networkMatches(device, filter)) ?? [];
  const widgets: WidgetDefinition[] = shown.map((device) => ({
    id: networkWidgetId(device.address),
    title: deviceTitle(device),
    ownHeading: true,
    children: (
      <NetworkDeviceCard
        device={device}
        onCheckAllPorts={() => {
          void take(network.checkAllPorts(device.address));
        }}
        onRename={(name) => network.setName(device.address, name).then(setScan)}
        roomPicker={
          <RoomPicker
            device={deviceTitle(device)}
            room={device.room}
            rooms={roomList.list}
            onCreate={async (name) => {
              const room = await rooms.add(name);
              await roomList.reload();
              return room;
            }}
            onChoose={(roomId) => network.setRoom(device.address, roomId).then(setScan)}
          />
        }
      />
    ),
  }));

  return (
    <Board
      header={header}
      widgets={widgets}
      rows={NETWORK_WIDGET_ROWS}
      storage={storage}
      storageKey={NETWORK_WIDGET_LAYOUT_KEY}
      controls={
        <ScanControls
          label={scan?.finishedAt == null ? "Scan the network" : "Scan again"}
          busy={scan?.scanning === true}
          disabled={scan === undefined || scan.scanning}
          status={scan === undefined ? (problem === undefined ? "Loading…" : "") : statusOf(scan)}
          progress={
            scan?.scanning === true
              ? { max: scan.total, value: scan.checked < scan.total ? scan.checked : undefined }
              : undefined
          }
          problem={problem}
          filter={filter}
          filterPlaceholder="Name, address, maker or port"
          showFilter={scan !== undefined && scan.devices.length > 0}
          nothingMatches={scan !== undefined && scan.devices.length > 0 && shown.length === 0}
          onScan={() => {
            void take(network.scan());
          }}
          onFilter={setFilter}
        />
      }
    />
  );
};

/** The Bluetooth devices near the Hub. */
const Bluetooth = ({ network, rooms, storage, header }: ViewProps) => {
  const [scan, setScan] = useCachedScan<BluetoothScan>(storage, BLUETOOTH_SCAN_CACHE_KEY);
  const roomList = useRooms(rooms);
  const [problem, setProblem] = useState<string>();
  const [filter, setFilter] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const take = (asked: Promise<BluetoothScan>): Promise<void> =>
    asked.then(
      (next) => {
        setScan(next);
        setProblem(undefined);
      },
      (error: unknown) => {
        setProblem(messageFor(error));
      },
    );

  useEffect(() => {
    void take(network.readBluetooth());
  }, [network]);

  const scanning = scan?.scanning === true;
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => {
      void take(network.readBluetooth());
      setElapsed((seconds) => seconds + NETWORK_POLL_MS / 1_000);
    }, NETWORK_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [scanning, network]);

  const shown = scan?.devices.filter((device) => bluetoothMatches(device, filter)) ?? [];
  const widgets: WidgetDefinition[] = shown.map((device) => ({
    id: bluetoothWidgetId(device.address),
    title: bluetoothTitle(device),
    ownHeading: true,
    children: (
      <BluetoothDeviceCard
        device={device}
        onRename={(name) => network.setBluetoothName(device.address, name).then(setScan)}
        roomPicker={
          <RoomPicker
            device={bluetoothTitle(device)}
            room={device.room}
            rooms={roomList.list}
            onCreate={async (name) => {
              const room = await rooms.add(name);
              await roomList.reload();
              return room;
            }}
            onChoose={(roomId) => network.setBluetoothRoom(device.address, roomId).then(setScan)}
          />
        }
      />
    ),
  }));

  const unavailable = scan !== undefined && !scan.available;
  return (
    <Board
      header={header}
      widgets={widgets}
      rows={BLUETOOTH_WIDGET_ROWS}
      storage={storage}
      storageKey={BLUETOOTH_WIDGET_LAYOUT_KEY}
      controls={
        <ScanControls
          label={scan?.finishedAt == null ? "Scan for Bluetooth devices" : "Scan again"}
          busy={scanning}
          disabled={scan === undefined || scanning || unavailable}
          status={scan === undefined ? (problem === undefined ? "Loading…" : "") : bluetoothStatusOf(scan)}
          progress={scanning ? { max: scan.seconds, value: Math.min(elapsed, scan.seconds) } : undefined}
          problem={problem ?? scan?.problem ?? undefined}
          filter={filter}
          filterPlaceholder="Name, address, maker or “light”"
          showFilter={scan !== undefined && scan.devices.length > 0}
          nothingMatches={scan !== undefined && scan.devices.length > 0 && shown.length === 0}
          onScan={() => {
            setElapsed(0);
            void take(network.scanBluetooth());
          }}
          onFilter={setFilter}
          hint={
            unavailable ? undefined : (
              <p class="network-note network-hint">
                A Bluetooth bulb usually stops advertising while a phone is connected to it: close its app, such as
                LampUX, and switch off your phone's Bluetooth while the Hub listens.
              </p>
            )
          }
        />
      }
    />
  );
};

/**
 * A device's name, with Name to change it: the field, Save and Cancel, and
 * why the Hub refused one. Saving an empty name forgets it.
 */
const DeviceName = ({
  current,
  onRename,
}: {
  readonly current: string | null;
  readonly onRename: (name: string | null) => Promise<unknown>;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const problemId = useId();

  if (!editing) {
    return (
      <button
        type="button"
        class="network-rename"
        onClick={() => {
          setDraft(current ?? "");
          setRefusal(undefined);
          setEditing(true);
        }}
      >
        <Icon name="pencil" />
        {current === null ? "Name it" : "Rename"}
      </button>
    );
  }
  return (
    <form
      class="network-name-form"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        onRename(draft.trim() === "" ? null : draft).then(
          () => {
            setSaving(false);
            setEditing(false);
          },
          (error: unknown) => {
            setSaving(false);
            setRefusal(messageFor(error));
          },
        );
      }}
    >
      <NameInput
        label="Name"
        value={draft}
        placeholder="e.g. Kitchen bulb"
        invalid={refusal !== undefined}
        describedBy={problemId}
        focus
        onInput={setDraft}
      />
      <div class="network-name-actions">
        <button type="submit" disabled={saving}>
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
          }}
        >
          Cancel
        </button>
      </div>
      {refusal !== undefined && (
        <p class="problem" id={problemId} role="alert">
          {refusal}
        </p>
      )}
    </form>
  );
};

/** What "New room…" is in a device's Room picker, which no Room's id can be. */
const NEW_ROOM = "new";

/**
 * The Room a device is in, chosen from the Hub's Rooms, "No room", or "New
 * room…", which names one there, makes it, and puts the device in it. Why
 * the Hub refused either is said beside it.
 */
export const RoomPicker = ({
  device,
  room,
  rooms,
  onCreate,
  onChoose,
}: {
  /** The device's title, for the picker's name. */
  readonly device: string;
  readonly room: DeviceRoom | null;
  readonly rooms: readonly Room[];
  readonly onCreate: (name: string) => Promise<Room>;
  readonly onChoose: (roomId: number | null) => Promise<unknown>;
}) => {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const selectId = useId();
  const problemId = useId();

  const run = (work: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true);
    setRefusal(undefined);
    work().then(
      () => {
        setBusy(false);
        after?.();
      },
      (error: unknown) => {
        setBusy(false);
        setRefusal(messageFor(error));
      },
    );
  };

  // A Room the device is in that the list hasn't yet, as one made on another Remote.
  const shown = room === null || rooms.some(({ id }) => id === room.id) ? rooms : [...rooms, room];
  return (
    <div class="network-room">
      <label class="network-room-picker" for={selectId}>
        <span>Room</span>
        <select
          id={selectId}
          aria-label={`Room for ${device}`}
          value={creating ? NEW_ROOM : String(room?.id ?? "")}
          disabled={busy}
          {...(refusal === undefined || creating ? {} : { "aria-describedby": problemId, "aria-invalid": true })}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === NEW_ROOM) {
              setDraft("");
              setRefusal(undefined);
              setCreating(true);
              return;
            }
            setCreating(false);
            run(() => onChoose(value === "" ? null : Number(value)));
          }}
        >
          <option value="">No room</option>
          {shown.map(({ id, name }) => (
            <option key={id} value={String(id)}>
              {name}
            </option>
          ))}
          <option value={NEW_ROOM}>New room…</option>
        </select>
      </label>
      {creating && (
        <form
          class="network-name-form"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              async () => {
                const made = await onCreate(draft);
                await onChoose(made.id);
              },
              () => {
                setCreating(false);
              },
            );
          }}
        >
          <NameInput
            label="New Room's name"
            value={draft}
            placeholder="e.g. Kitchen"
            invalid={refusal !== undefined}
            describedBy={problemId}
            focus
            onInput={setDraft}
          />
          <div class="network-name-actions">
            <button type="submit" disabled={busy}>
              Create and put it there
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setRefusal(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {refusal !== undefined && (
        <p class="problem" id={problemId} role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
};

interface NetworkDeviceCardProps {
  readonly device: NetworkDevice;
  readonly onCheckAllPorts: () => void;
  readonly onRename: (name: string | null) => Promise<unknown>;
  readonly roomPicker: preact.ComponentChildren;
}

/** One device on the network: what it is, its details, and its open ports, with a check of every port. */
const NetworkDeviceCard = ({ device, onCheckAllPorts, onRename, roomPicker }: NetworkDeviceCardProps) => {
  const id = `device-${device.address.replaceAll(".", "-")}`;
  const { portCheck } = device;
  const checking = portCheck.kind === "all" && !portCheck.done;
  return (
    <article class="network-device" aria-labelledby={id}>
      <div class="device-row">
        <span class="device-icon">
          <Icon name={iconFor(device)} />
        </span>
        <div class="device-text">
          <h2 class="device-name network-device-name" id={id}>
            {deviceTitle(device)}
          </h2>
          <span class="device-meta">
            <code>{device.address}</code>
            {device.isHub && <span class="chip chip-good">This Hub</span>}
            {device.room !== null && <span class="chip chip-good">{device.room.name}</span>}
          </span>
        </div>
      </div>
      <DeviceName current={device.name} onRename={onRename} />
      {roomPicker}
      <dl class="network-facts">
        <div>
          <dt>Maker</dt>
          <dd>{device.vendor ?? (device.privateMacAddress ? "Not known: a private MAC address" : "Not known")}</dd>
        </div>
        <div>
          <dt>MAC address</dt>
          <dd>{device.macAddress === null ? "Not known" : <code>{device.macAddress}</code>}</dd>
        </div>
        <div>
          <dt>Network name</dt>
          <dd>{device.hostname ?? "None given"}</dd>
        </div>
        <div>
          <dt>Answered in</dt>
          <dd>{device.responseMs === null ? "Only to the Hub's ARP" : `${device.responseMs.toLocaleString()} ms`}</dd>
        </div>
      </dl>
      <section class="network-ports" aria-labelledby={`${id}-ports`}>
        <h3 id={`${id}-ports`}>
          Open ports <span class="count">{device.openPorts.length}</span>
        </h3>
        {device.openPorts.length === 0 ? (
          <p class="network-note">None open.</p>
        ) : (
          <ul class="network-port-list">
            {device.openPorts.map(({ port, service }) => (
              <li key={port} class="chip">
                <code>{port}</code>
                {service !== null && <span>{service}</span>}
              </li>
            ))}
          </ul>
        )}
        <div class="network-port-check">
          <p class="network-note">
            {portCheck.kind === "common"
              ? `Checked the ${plural(portCheck.ports, "common port")}${
                  portCheck.remembered === 0 ? "" : `, and ${plural(portCheck.remembered, "port")} found open before`
                }.`
              : portCheck.done
                ? `Checked every port, all ${portCheck.total.toLocaleString()}. The Hub remembers those open, and checks them each scan.`
                : `Checking every port: ${portCheck.checked.toLocaleString()} of ${portCheck.total.toLocaleString()}…`}
          </p>
          {checking ? (
            <progress
              class="network-progress"
              aria-label={`How far checking every port of ${device.address} has got`}
              max={portCheck.total}
              value={portCheck.checked}
            />
          ) : (
            portCheck.kind === "common" && (
              <button type="button" onClick={onCheckAllPorts}>
                Check every port
              </button>
            )
          )}
        </div>
      </section>
    </article>
  );
};

/** One Bluetooth device: what it is, how strongly it is heard, and what it offers. */
const BluetoothDeviceCard = ({
  device,
  onRename,
  roomPicker,
}: {
  readonly device: BluetoothDevice;
  readonly onRename: (name: string | null) => Promise<unknown>;
  readonly roomPicker: preact.ComponentChildren;
}) => {
  const id = `bluetooth-${device.address.replaceAll(":", "-")}`;
  return (
    <article class="network-device" aria-labelledby={id}>
      <div class="device-row">
        <span class="device-icon">
          <Icon name={device.maybeLight ? "lightbulb" : "bluetooth"} />
        </span>
        <div class="device-text">
          <h2 class="device-name network-device-name" id={id}>
            {bluetoothTitle(device)}
          </h2>
          <span class="device-meta">
            <code>{device.address}</code>
            {device.room !== null && <span class="chip chip-good">{device.room.name}</span>}
            {device.maybeLight && <span class="chip chip-good">Maybe a light</span>}
            {device.randomAddress && <span class="chip">Changing address</span>}
          </span>
        </div>
      </div>
      <DeviceName current={device.name} onRename={onRename} />
      {roomPicker}
      <dl class="network-facts">
        <div>
          <dt>Maker</dt>
          <dd>{device.maker ?? "Not known"}</dd>
        </div>
        <div>
          <dt>Signal</dt>
          <dd>
            {strengthOf(device.signal)}, {device.signal} dBm
          </dd>
        </div>
        <div>
          <dt>Advertised name</dt>
          <dd>{device.advertisedName ?? "None given"}</dd>
        </div>
        <div>
          <dt>Last heard</dt>
          <dd>{timeOf(device.lastHeardAt)}</dd>
        </div>
      </dl>
      <section class="network-ports" aria-labelledby={`${id}-services`}>
        <h3 id={`${id}-services`}>
          Services <span class="count">{device.services.length}</span>
        </h3>
        {device.services.length === 0 ? (
          <p class="network-note">It names none.</p>
        ) : (
          <ul class="network-port-list">
            {device.services.map(({ uuid, name }) => (
              <li key={uuid} class="chip">
                {name ?? <code>{uuid}</code>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
};
