/**
 * The keys that open a Samsung TV's hidden service menu, which can
 * misconfigure or brick a TV. The Samsung TV Driver never sends them (FR-30,
 * ADR 0007), whatever asks: every key the Driver sends passes a
 * {@link serviceMenuGuard} first.
 */

/** The service remote's key, which opens the service menu on its own. */
export const FACTORY_KEY = "KEY_FACTORY";

const POWER_KEYS = ["KEY_POWER", "KEY_POWEROFF", "KEY_POWERON"];

/**
 * The known sequences that open the service menu, or the hotel mode beside
 * it, from the TV's own remote. Each step is the keys any of which counts.
 */
export const SERVICE_MENU_SEQUENCES: readonly (readonly (readonly string[])[])[] = [
  [["KEY_INFO"], ["KEY_MENU"], ["KEY_MUTE"], POWER_KEYS],
  [["KEY_MUTE"], ["KEY_1"], ["KEY_8"], ["KEY_2"], POWER_KEYS],
  [["KEY_INFO"], ["KEY_PMODE"], ["KEY_MUTE"], POWER_KEYS],
  [["KEY_SLEEP"], ["KEY_PMODE"], ["KEY_MUTE"], POWER_KEYS],
  [["KEY_MUTE"], ["KEY_1"], ["KEY_1"], ["KEY_9"], ["KEY_ENTER"]],
];

/** How each key in a sequence is named to the person, who knows them from the TV's remote. */
const KEY_NAMES: Readonly<Record<string, string>> = {
  KEY_INFO: "Info",
  KEY_MENU: "Menu",
  KEY_MUTE: "Mute",
  KEY_POWER: "Power",
  KEY_POWEROFF: "Power",
  KEY_POWERON: "Power",
  KEY_PMODE: "Picture Mode",
  KEY_SLEEP: "Sleep",
  KEY_ENTER: "OK",
  KEY_1: "1",
  KEY_2: "2",
  KEY_8: "8",
  KEY_9: "9",
};

const nameOf = (code: string): string => KEY_NAMES[code] ?? code;

/** "Info, Menu and Mute". */
const listed = (names: readonly string[]): string =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;

/** A key the Driver refused to send. The message is for the person, and names keys as the TV's remote does. */
export class ServiceMenuRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceMenuRefusal";
  }
}

/** Whether a key name, from wherever it came, is the factory key, in the Remote's terms or the TV's. */
export const namesFactoryKey = (key: string): boolean => /^(?:key_)?factory$/i.test(key.trim());

export interface ServiceMenuGuard {
  /** Throws a {@link ServiceMenuRefusal} if sending this key next would open the service menu. */
  readonly check: (code: string) => void;
  /** Notes a key that was sent, which the next {@link check} looks back on. */
  readonly sent: (code: string) => void;
}

/**
 * Watches the keys sent to one TV. It refuses the factory key outright, and
 * the last key of any known sequence when the keys sent before it are the
 * rest of that sequence, however long ago they were sent: a TV that waits
 * longer between keys than we think must not slip through.
 */
export const serviceMenuGuard = (): ServiceMenuGuard => {
  const longest = Math.max(...SERVICE_MENU_SEQUENCES.map((sequence) => sequence.length));
  const recent: string[] = [];

  return {
    check: (code) => {
      if (code.trim().toUpperCase() === FACTORY_KEY) {
        throw new ServiceMenuRefusal(
          "The Hub never sends the Factory key: it opens the TV's service menu, which can misconfigure or break the TV.",
        );
      }
      for (const sequence of SERVICE_MENU_SEQUENCES) {
        const before = sequence.slice(0, -1);
        const last = sequence.at(-1) ?? [];
        const tail = recent.slice(-before.length);
        if (
          last.includes(code) &&
          tail.length === before.length &&
          before.every((step, index) => step.includes(tail[index] ?? ""))
        ) {
          throw new ServiceMenuRefusal(
            `The Hub didn't send ${nameOf(code)}: after ${listed(tail.map(nameOf))} it opens the TV's service menu, ` +
              "which can misconfigure or break the TV. Press another key first.",
          );
        }
      }
    },
    sent: (code) => {
      recent.push(code);
      if (recent.length > longest) recent.shift();
    },
  };
};
