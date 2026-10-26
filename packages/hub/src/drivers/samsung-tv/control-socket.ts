/**
 * The Samsung TV Driver's side of a TV's secure control socket: a WebSocket on
 * `wss://<tv>:8002`, which a 2018 or later Samsung TV keeps for remote control
 * (PRD §11). Only the Driver knows this protocol (NFR-6).
 *
 * A client that connects without a token makes the TV show its "Allow" prompt;
 * once the person allows it, the TV issues a token, and a client that presents
 * that token later is let in without asking (FR-13). A TV whose access was
 * revoked refuses the token.
 */
import WebSocket from "ws";

/** The secure control socket's port. Device info is on 8001. */
export const SAMSUNG_CONTROL_PORT = 8002;

export const REMOTE_CONTROL_PATH = "/api/v2/channels/samsung.remote.control";

/** The event a TV sends once it lets a client in, with the token it issued. */
export const CONNECT_EVENT = "ms.channel.connect";
/** The event a TV sends when the person chose Deny, or the token is refused. */
export const UNAUTHORIZED_EVENT = "ms.channel.unauthorized";
/** The event a TV sends when nobody answered its prompt in time. */
export const TIMEOUT_EVENT = "ms.channel.timeOut";

/**
 * The events a TV sends every client let in on its control socket when its
 * on-screen keyboard opens, e.g. for a search box, and when it closes, as far
 * as we know them (FR-20). A client let in while it is open isn't told.
 */
export const KEYBOARD_OPEN_EVENT = "ms.remote.imeStart";
export const KEYBOARD_CLOSED_EVENT = "ms.remote.imeEnd";

export interface OnScreenKeyboardEvent {
  readonly event: typeof KEYBOARD_OPEN_EVENT | typeof KEYBOARD_CLOSED_EVENT;
}

/**
 * The event a TV's channel sends a client for a command it won't take. It has
 * been seen only for a method the TV doesn't recognise, e.g. on firmware
 * older than this Driver's: the TV acknowledges no key, and those who have
 * sent a TV a key it doesn't act on report that it says nothing at all. So it
 * is all a TV could signal of a key it ignores (FR-24), and its message names
 * nothing to tell which command it was for.
 */
export const ERROR_EVENT = "ms.error";

export interface ErrorEvent {
  readonly event: typeof ERROR_EVENT;
  readonly data: { readonly message: string };
}

/** How the Driver asks the TV for something on the control socket, e.g. its installed apps, which it answers with an event of the same name. */
export const CHANNEL_EMIT_METHOD = "ms.channel.emit";

/** A question for the TV, e.g. for its installed apps (FR-21). */
export interface EmitCommand {
  readonly method: typeof CHANNEL_EMIT_METHOD;
  readonly params: {
    /** The question, which names the event the TV answers with. */
    readonly event: string;
    readonly to: "host";
    readonly data?: object;
  };
}

/** The TV's answer to an {@link EmitCommand}, as far as we know it. */
export interface EmitAnswer {
  readonly event: string;
  readonly from?: string;
  readonly data: unknown;
}

/** What a TV sends first on its control socket, as far as we know it. */
export type ControlSocketEvent =
  | {
      readonly event: typeof CONNECT_EVENT;
      readonly data: {
        readonly id: string;
        readonly clients: readonly unknown[];
        /** Left out by some firmware when a client presented a token it already had. */
        readonly token?: string;
      };
    }
  | { readonly event: typeof UNAUTHORIZED_EVENT }
  | { readonly event: typeof TIMEOUT_EVENT };

export type ControlSocketAnswer =
  | { readonly accepted: true; readonly token: string | undefined }
  | { readonly accepted: false; readonly why: "unauthorized" | "timed-out" };

/** The TV let the Hub in, but didn't answer a question asked on its control socket in time. */
export class ControlSocketSilent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlSocketSilent";
  }
}

/** The control socket could not be reached, or closed without answering. */
export class ControlSocketUnreachable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ControlSocketUnreachable";
  }
}

export interface ControlSocketOptions {
  readonly port?: number;
  /** Shown on the TV's prompt and in its list of connected devices. */
  readonly clientName: string;
  /** Left out to pair, which makes the TV ask the person. */
  readonly token?: string;
  /** How long to wait for the TV's answer, including the person's. */
  readonly timeoutMs: number;
}

/** A control socket the TV let the Hub in on, kept open to press keys on (FR-22). */
export interface OpenControlSocket {
  /** False once either end has closed it, e.g. when the TV goes into standby. */
  readonly isOpen: () => boolean;
  /**
   * Presses the key with this code, as a tap on the TV's own remote does, and
   * resolves once it is sent. Rejects with {@link ControlSocketUnreachable} if
   * the socket has closed.
   */
  readonly pressKey: (code: string) => Promise<void>;
  /**
   * Listens for `windowMs` for the TV's {@link ERROR_EVENT}, and resolves with
   * whether it came. Called just before a key is sent, it hears the TV say it
   * won't take that key, if the TV says so at all. The event names nothing to
   * tell commands apart by, so a later call ends this one's listening, which
   * then resolves false, as one does whose socket closes first. Never rejects.
   */
  readonly listenForError: (windowMs: number) => Promise<boolean>;
  /**
   * Holds the key with this code down for `holdMs`, then lets it go, as
   * holding it on the TV's own remote does, and resolves once it is let go.
   * Rejects with {@link ControlSocketUnreachable} if the socket has closed
   * before the key went down. One the TV closes while the key is held, as it
   * may on switching off, has had the key held: it resolves.
   */
  readonly holdKey: (code: string, holdMs: number) => Promise<void>;
  /**
   * Whether the TV has said its on-screen keyboard opened, and not since that
   * it closed, while this socket has been open (FR-20).
   */
  readonly keyboardOpen: () => boolean;
  /**
   * Types `text` into the TV's on-screen keyboard and submits it, as its Done
   * key does, and resolves once both are sent. Rejects as {@link pressKey} does.
   */
  readonly enterText: (text: string) => Promise<void>;
  /**
   * Emits `event`, with `data` if given, and resolves with the `data` of the
   * TV's answer, the next event of that name for which `answers` is true.
   * Questions are asked one at a time, as the TV's answers carry nothing to
   * tell them apart by. Rejects with {@link ControlSocketSilent} after
   * `timeoutMs` without an answer, and as {@link pressKey} does if the socket
   * has closed or closes first.
   */
  readonly ask: (
    event: string,
    data: object | undefined,
    timeoutMs: number,
    answers?: (data: unknown) => boolean,
  ) => Promise<unknown>;
  readonly close: () => void;
}

export type ControlSocketOpening =
  | { readonly accepted: true; readonly token: string | undefined; readonly socket: OpenControlSocket }
  | { readonly accepted: false; readonly why: "unauthorized" | "timed-out" };

/** How the Driver presses a key on the control socket. */
export const REMOTE_CONTROL_METHOD = "ms.remote.control";

/** One key press, as the TV's control socket takes it. */
export interface KeyCommand {
  readonly method: typeof REMOTE_CONTROL_METHOD;
  readonly params: {
    /** A tap; "Press" and "Release" hold a key down and let it go. */
    readonly Cmd: "Click" | "Press" | "Release";
    /** The key's code, e.g. "KEY_ENTER" for OK. */
    readonly DataOfCmd: string;
    readonly Option: "false";
    readonly TypeOfRemote: "SendRemoteKey";
  };
}

/**
 * Text for the TV's on-screen keyboard, as its control socket takes it, which
 * the TV puts in the keyboard's field as far as we know (FR-20).
 */
export interface TextCommand {
  readonly method: typeof REMOTE_CONTROL_METHOD;
  readonly params: {
    /** The text as UTF-8, in base64, so that text in any script arrives intact. */
    readonly Cmd: string;
    readonly DataOfCmd: "base64";
    readonly TypeOfRemote: "SendInputString";
  };
}

/** Submits what is in the TV's on-screen keyboard, as its Done key does, which closes it, as far as we know. */
export interface TextEndCommand {
  readonly method: typeof REMOTE_CONTROL_METHOD;
  readonly params: { readonly TypeOfRemote: "SendInputEnd" };
}

/**
 * Opens the TV's control socket and waits for its first event. If the TV lets
 * the Hub in, the socket is left open for keys; otherwise it is closed again.
 * Rejects with {@link ControlSocketUnreachable} when the TV can't be reached
 * or hangs up without answering. `onClose` is called once an open socket
 * closes, from either end.
 *
 * The URL carries the token, so neither it nor anything quoting it is ever put
 * in an error or a log (FR-4).
 */
export const openControlSocket = (
  host: string,
  { port = SAMSUNG_CONTROL_PORT, clientName, token, timeoutMs }: ControlSocketOptions,
  onClose: () => void = () => undefined,
): Promise<ControlSocketOpening> =>
  new Promise((resolve, reject) => {
    const query = new URLSearchParams({ name: Buffer.from(clientName).toString("base64") });
    if (token !== undefined) query.set("token", token);
    const urlHost = host.includes(":") ? `[${host}]` : host;

    // A TV's certificate is self-signed by Samsung, so it can't be verified.
    const socket = new WebSocket(`wss://${urlHost}:${String(port)}${REMOTE_CONTROL_PATH}?${query.toString()}`, {
      rejectUnauthorized: false,
      handshakeTimeout: Math.min(timeoutMs, 5_000),
    });

    let settled = false;
    const settle = (finish: () => void, keepOpen = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // A socket closed before it opened still reports an error; ignore it.
      socket.on("error", () => undefined);
      if (keepOpen) socket.once("close", onClose);
      else socket.terminate();
      finish();
    };

    const timer = setTimeout(() => {
      // The TV opened the socket, but nobody answered its prompt.
      const opened = socket.readyState === WebSocket.OPEN;
      settle(() => {
        if (opened) resolve({ accepted: false, why: "timed-out" });
        else reject(new ControlSocketUnreachable(`The TV at ${host} did not open its control socket in time`));
      });
    }, timeoutMs);

    socket.on("message", (data: WebSocket.RawData) => {
      const event = parseEvent(rawText(data));
      if (event === undefined) return;
      if (event.event === CONNECT_EVENT) {
        settle(() => {
          resolve({ accepted: true, token: event.data.token, socket: keptOpen(host, socket) });
        }, true);
        return;
      }
      settle(() => {
        resolve({ accepted: false, why: event.event === UNAUTHORIZED_EVENT ? "unauthorized" : "timed-out" });
      });
    });
    // Only the error's code is kept: its message can quote the URL.
    socket.on("error", (error: NodeJS.ErrnoException) => {
      settle(() => {
        reject(
          new ControlSocketUnreachable(
            `The TV at ${host} could not be reached on its control socket (${error.code ?? "no answer"})`,
          ),
        );
      });
    });
    socket.on("close", () => {
      settle(() => {
        reject(new ControlSocketUnreachable(`The TV at ${host} closed its control socket without answering`));
      });
    });
  });

const keptOpen = (host: string, socket: WebSocket): OpenControlSocket => {
  const isOpen = (): boolean => socket.readyState === WebSocket.OPEN;
  const closed = (): ControlSocketUnreachable =>
    new ControlSocketUnreachable(`The TV at ${host} closed its control socket`);
  const send = (command: KeyCommand | TextCommand | TextEndCommand | EmitCommand): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!isOpen()) {
        reject(closed());
        return;
      }
      // Node passes null rather than nothing once it is written.
      socket.send(JSON.stringify(command), (error) => {
        if (error instanceof Error) reject(closed());
        else resolve();
      });
    });
  const sendKey = (cmd: KeyCommand["params"]["Cmd"], code: string): Promise<void> =>
    send({
      method: REMOTE_CONTROL_METHOD,
      params: { Cmd: cmd, DataOfCmd: code, Option: "false", TypeOfRemote: "SendRemoteKey" },
    });

  let keyboard = false;
  /** Waiting for the TV's answer to the question asked, if one is. */
  let listener: ((answer: EmitAnswer) => void) | undefined;
  /** Listening for the TV's error event, if anything is. */
  let errorListener: ((heard: boolean) => void) | undefined;
  socket.on("message", (data: WebSocket.RawData) => {
    const text = rawText(data);
    if (eventIn(text)?.event === ERROR_EVENT) errorListener?.(true);
    const event = parseKeyboardEvent(text);
    if (event !== undefined) keyboard = event.event === KEYBOARD_OPEN_EVENT;
    const answer = parseEmitAnswer(text);
    if (answer !== undefined) listener?.(answer);
  });

  /** The last question asked, settled either way, which the next waits for. */
  let asking: Promise<unknown> = Promise.resolve();
  const askNow = (event: string, data: object | undefined, timeoutMs: number, answers: (data: unknown) => boolean) =>
    new Promise<unknown>((resolve, reject) => {
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        listener = undefined;
        socket.off("close", onClose);
        settle();
      };
      const onClose = (): void => {
        finish(() => {
          reject(closed());
        });
      };
      const timer = setTimeout(() => {
        finish(() => {
          reject(new ControlSocketSilent(`The TV at ${host} didn't answer ${event} in time`));
        });
      }, timeoutMs);
      listener = (answer) => {
        if (answer.event === event && answers(answer.data)) {
          finish(() => {
            resolve(answer.data);
          });
        }
      };
      socket.once("close", onClose);
      send({
        method: CHANNEL_EMIT_METHOD,
        params: { event, to: "host", ...(data === undefined ? {} : { data }) },
      }).catch((error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : closed());
        });
      });
    });

  return {
    isOpen,
    pressKey: (code) => sendKey("Click", code),
    listenForError: (windowMs) =>
      new Promise((resolve) => {
        errorListener?.(false);
        const finish = (heard: boolean): void => {
          clearTimeout(timer);
          socket.off("close", onClose);
          if (errorListener === finish) errorListener = undefined;
          resolve(heard);
        };
        const onClose = (): void => {
          finish(false);
        };
        const timer = setTimeout(onClose, windowMs);
        errorListener = finish;
        socket.once("close", onClose);
      }),
    holdKey: async (code, holdMs) => {
      await sendKey("Press", code);
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      // Let go even if the TV has closed the socket: sending the key down
      // again, on a socket opened afresh, could switch it back on.
      await sendKey("Release", code).catch(() => undefined);
    },
    keyboardOpen: () => keyboard && isOpen(),
    enterText: async (text) => {
      await send({
        method: REMOTE_CONTROL_METHOD,
        params: {
          Cmd: Buffer.from(text, "utf8").toString("base64"),
          DataOfCmd: "base64",
          TypeOfRemote: "SendInputString",
        },
      });
      await send({ method: REMOTE_CONTROL_METHOD, params: { TypeOfRemote: "SendInputEnd" } });
    },
    ask: (event, data, timeoutMs, answers = () => true) => {
      const asked = asking.then(() => askNow(event, data, timeoutMs, answers));
      asking = asked.catch(() => undefined);
      return asked;
    },
    close: () => {
      socket.terminate();
    },
  };
};

/**
 * Opens the TV's control socket, waits for its first event, and closes it
 * again, to find out whether the TV lets the Hub in. See {@link openControlSocket}.
 */
export const askControlSocket = async (host: string, options: ControlSocketOptions): Promise<ControlSocketAnswer> => {
  const opening = await openControlSocket(host, options);
  if (!opening.accepted) return opening;
  opening.socket.close();
  return { accepted: true, token: opening.token };
};

const rawText = (data: WebSocket.RawData): string =>
  (Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data).toString("utf8");

/** The message's event, or undefined for a message that isn't JSON with one. */
const eventIn = (text: string): { readonly event: unknown } | undefined => {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof message === "object" && message !== null && "event" in message ? message : undefined;
};

/** The TV's keyboard opening or closing, or undefined for any other message. */
const parseKeyboardEvent = (text: string): OnScreenKeyboardEvent | undefined => {
  const event = eventIn(text)?.event;
  return event === KEYBOARD_OPEN_EVENT || event === KEYBOARD_CLOSED_EVENT ? { event } : undefined;
};

/**
 * An event that may answer an {@link EmitCommand}: one with a name, other than
 * the keyboard's, the error event and those that answer the Hub's connection.
 * Its `data` is for the question's asker to read.
 */
const parseEmitAnswer = (text: string): EmitAnswer | undefined => {
  const message = eventIn(text);
  if (message === undefined || typeof message.event !== "string") return undefined;
  if (parseKeyboardEvent(text) !== undefined || parseEvent(text) !== undefined || message.event === ERROR_EVENT) {
    return undefined;
  }
  return { event: message.event, data: "data" in message ? message.data : undefined };
};

/** The TV's event, or undefined for one this Driver doesn't know, which it waits past. */
const parseEvent = (text: string): ControlSocketEvent | undefined => {
  const message = eventIn(text);
  if (message === undefined) return undefined;
  switch (message.event) {
    case CONNECT_EVENT: {
      const data = "data" in message && typeof message.data === "object" && message.data !== null ? message.data : {};
      const token = "token" in data && typeof data.token === "string" && data.token !== "" ? data.token : undefined;
      return { event: CONNECT_EVENT, data: { id: "", clients: [], ...(token === undefined ? {} : { token }) } };
    }
    case UNAUTHORIZED_EVENT:
      return { event: UNAUTHORIZED_EVENT };
    case TIMEOUT_EVENT:
      return { event: TIMEOUT_EVENT };
    default:
      return undefined;
  }
};
