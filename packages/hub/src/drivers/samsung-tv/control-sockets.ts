import {
  ControlSocketUnreachable,
  openControlSocket,
  type ControlSocketOpening,
  type ControlSocketOptions,
  type OpenControlSocket,
} from "./control-socket.ts";
import { serviceMenuGuard, type ServiceMenuGuard } from "./service-menu.ts";

/** What a TV did with a key: took it, on the token it may have renewed, or refused the token. */
export type KeyAnswer =
  | { readonly accepted: true; readonly token: string }
  | { readonly accepted: false; readonly why: "unauthorized" | "timed-out" };

/**
 * What a TV did with a key it was listened to for, as a {@link KeyAnswer}
 * says: `ignored` resolves later, once the Driver has listened, with whether
 * the TV said it won't take it.
 */
export type ListenedKeyAnswer =
  | { readonly accepted: true; readonly token: string; readonly ignored: Promise<boolean> }
  | { readonly accepted: false; readonly why: "unauthorized" | "timed-out" };

/** The TV's answer to a question asked on its control socket, as a {@link KeyAnswer} says what it did with a key. */
export type AskAnswer =
  | { readonly accepted: true; readonly token: string; readonly data: unknown }
  | { readonly accepted: false; readonly why: "unauthorized" | "timed-out" };

/** Whether a TV's on-screen keyboard is open, as a {@link KeyAnswer} says what it did with a key. */
export type KeyboardAnswer =
  | { readonly accepted: true; readonly token: string; readonly open: boolean }
  | { readonly accepted: false; readonly why: "unauthorized" | "timed-out" };

export interface ControlSockets {
  /**
   * Presses the key with this code on the TV at `address`, on its control
   * socket, opening that with `token` only if it isn't open already. Rejects
   * with a `ServiceMenuRefusal` for a key the Driver never sends (FR-30), and
   * with a {@link ControlSocketUnreachable} when the TV can't be reached.
   */
  readonly pressKey: (address: string, token: string, code: string) => Promise<KeyAnswer>;
  /**
   * Presses the key as {@link pressKey} does, and resolves once it is sent,
   * then listens on the socket for `listenMs` for the TV to say it won't take
   * it (FR-24). Keys pressed next go at once, without waiting for that.
   */
  readonly pressKeyListening: (
    address: string,
    token: string,
    code: string,
    listenMs: number,
  ) => Promise<ListenedKeyAnswer>;
  /** Holds the key down for `holdMs`, then lets it go, as {@link pressKey} presses it. */
  readonly holdKey: (address: string, token: string, code: string, holdMs: number) => Promise<KeyAnswer>;
  /**
   * Whether the TV's on-screen keyboard is open (FR-20), as it said on its
   * control socket, which this opens with `token` if it isn't open already
   * and keeps open, so as to hear it open. Rejects with a
   * {@link ControlSocketUnreachable} when the TV can't be reached.
   */
  readonly readKeyboard: (address: string, token: string) => Promise<KeyboardAnswer>;
  /** Types the text into the TV's on-screen keyboard and submits it, in turn with keys, as {@link pressKey} presses one. */
  readonly enterText: (address: string, token: string, text: string) => Promise<KeyAnswer>;
  /**
   * Asks the TV something on its control socket, e.g. for its installed apps
   * (FR-21), as `OpenControlSocket.ask` does, opening the socket as
   * {@link pressKey} does. Questions don't wait for keys, nor keys for them.
   * Rejects with a `ControlSocketSilent` when the TV doesn't answer in time.
   */
  readonly ask: (
    address: string,
    token: string,
    question: { readonly event: string; readonly data?: object; readonly answers?: (data: unknown) => boolean },
    timeoutMs: number,
  ) => Promise<AskAnswer>;
  /** Closes the TV's control socket, if it is open. */
  readonly close: (address: string) => void;
}

interface Kept {
  /** The tokens it was opened with, and any the TV renewed it to. */
  readonly tokens: Set<string>;
  readonly opening: Promise<ControlSocketOpening>;
}

/**
 * Each TV's control socket, kept open between key presses so that a key
 * reaches the TV without first waiting for a connection (FR-22), and so that
 * the Hub hears the TV's on-screen keyboard open and close (FR-20). One the
 * TV closes, e.g. going into standby, is opened again on the next key, or
 * the next time the keyboard is read.
 *
 * This is the only way the Driver sends a key, so every key passes the TV's
 * service-menu guard here, whatever asked for it (FR-30).
 */
export const controlSockets = (options: Omit<ControlSocketOptions, "token">): ControlSockets => {
  const kept = new Map<string, Kept>();
  const guards = new Map<string, ServiceMenuGuard>();

  const forget = (address: string, entry: Kept): void => {
    if (kept.get(address) === entry) kept.delete(address);
  };

  const discard = (address: string, entry: Kept | undefined): void => {
    if (entry === undefined) return;
    forget(address, entry);
    void entry.opening.then(
      (opening) => {
        if (opening.accepted) opening.socket.close();
      },
      () => undefined,
    );
  };

  const socketFor = (address: string, token: string): Kept => {
    const open = kept.get(address);
    if (open?.tokens.has(token) === true) return open;
    // Opened with other credentials, e.g. before the TV was paired again.
    discard(address, open);

    const entry: Kept = {
      tokens: new Set([token]),
      opening: openControlSocket(address, { ...options, token }, () => {
        forget(address, entry);
      }),
    };
    kept.set(address, entry);
    entry.opening.then(
      (opening) => {
        if (!opening.accepted) forget(address, entry);
        else if (opening.token !== undefined) entry.tokens.add(opening.token);
      },
      () => {
        forget(address, entry);
      },
    );
    return entry;
  };

  const guardFor = (address: string): ServiceMenuGuard => {
    let guard = guards.get(address);
    if (guard === undefined) {
      guard = serviceMenuGuard();
      guards.set(address, guard);
    }
    return guard;
  };

  /** Does `work` on the TV's control socket, and resolves with what it resolved with. */
  const workOn = async <Value>(
    address: string,
    token: string,
    work: (socket: OpenControlSocket) => Promise<Value>,
  ): Promise<
    { readonly accepted: true; readonly token: string; readonly value: Value } | Exclude<KeyAnswer, { accepted: true }>
  > => {
    // A socket kept open may have closed unnoticed since the last key, so a
    // failed send is tried once more, on a socket opened afresh.
    for (let attempt = 1; ; attempt += 1) {
      const entry = socketFor(address, token);
      const opening = await entry.opening;
      if (!opening.accepted) return opening;
      let value: Value;
      try {
        value = await work(opening.socket);
      } catch (error) {
        discard(address, entry);
        if (attempt < 2 && error instanceof ControlSocketUnreachable) continue;
        throw error;
      }
      return { accepted: true, token: opening.token ?? token, value };
    }
  };

  /** Does `work` on the TV's control socket. */
  const sendOn = async (
    address: string,
    token: string,
    work: (socket: OpenControlSocket) => Promise<void>,
  ): Promise<KeyAnswer> => {
    const answer = await workOn(address, token, work);
    return answer.accepted ? { accepted: true, token: answer.token } : answer;
  };

  /** Presses the key, or holds it for `holdMs`. */
  const press = async (address: string, token: string, code: string, holdMs?: number): Promise<KeyAnswer> => {
    const guard = guardFor(address);
    guard.check(code);
    const answer = await sendOn(address, token, (socket) =>
      holdMs === undefined ? socket.pressKey(code) : socket.holdKey(code, holdMs),
    );
    if (answer.accepted) guard.sent(code);
    return answer;
  };

  /** Presses the key, listening from just before it is sent, so as not to miss the TV's answer. */
  const pressListening = async (
    address: string,
    token: string,
    code: string,
    listenMs: number,
  ): Promise<ListenedKeyAnswer> => {
    const guard = guardFor(address);
    guard.check(code);
    // In an object, so that awaiting the work doesn't await the listening too.
    const answer = await workOn(address, token, async (socket) => {
      const ignored = socket.listenForError(listenMs);
      await socket.pressKey(code);
      return { ignored };
    });
    if (!answer.accepted) return answer;
    guard.sent(code);
    return { accepted: true, token: answer.token, ignored: answer.value.ignored };
  };

  /** The last send asked for on each TV, settled either way, which the next waits for. */
  const queues = new Map<string, Promise<unknown>>();

  // One key, or text, at a time per TV, in the order asked: the TV acts on
  // them in that order, and the guard sees every key before it checks the
  // next. A key held keeps the next waiting until it is let go.
  const queued = <Answer>(address: string, send: () => Promise<Answer>): Promise<Answer> => {
    const sent = (queues.get(address) ?? Promise.resolve()).then(send);
    queues.set(
      address,
      sent.catch(() => undefined),
    );
    return sent;
  };

  return {
    pressKey: (address, token, code) => queued(address, () => press(address, token, code)),
    pressKeyListening: (address, token, code, listenMs) =>
      queued(address, () => pressListening(address, token, code, listenMs)),
    holdKey: (address, token, code, holdMs) => queued(address, () => press(address, token, code, holdMs)),
    readKeyboard: async (address, token) => {
      let entry = socketFor(address, token);
      let opening = await entry.opening;
      // One the TV is closing hears nothing more, so the next is opened now.
      if (opening.accepted && !opening.socket.isOpen()) {
        discard(address, entry);
        entry = socketFor(address, token);
        opening = await entry.opening;
      }
      if (!opening.accepted) return opening;
      return { accepted: true, token: opening.token ?? token, open: opening.socket.keyboardOpen() };
    },
    enterText: (address, token, text) =>
      queued(address, () => sendOn(address, token, (socket) => socket.enterText(text))),
    ask: async (address, token, { event, data, answers }, timeoutMs) => {
      const answer = await workOn(address, token, (socket) => socket.ask(event, data, timeoutMs, answers));
      return answer.accepted ? { accepted: true, token: answer.token, data: answer.value } : answer;
    },
    close: (address) => {
      discard(address, kept.get(address));
    },
  };
};
