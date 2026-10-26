import type { ResumableMediaFile } from "@media-centre/shared";

import { element, icon } from "./dom.ts";
import type { HubConnectionState } from "./hub-connection.ts";

export interface WaitingScreenState {
  /** The Hub's address the Player has, or null when it hasn't been given one yet. */
  readonly hubAddress: string | null;
  /** How the Player's connection to the Hub is, or null with no address to connect to. */
  readonly connection: HubConnectionState | null;
  /** What went wrong with the last Media File the Hub sent, or null. */
  readonly problem: string | null;
  /** The Media File to offer to resume, as the Hub last said, or null for none. */
  readonly resumable: ResumableMediaFile | null;
}

export interface WaitingScreen {
  readonly show: (state: WaitingScreenState) => void;
  /** Hides it, as while the Player shows its now-playing screen instead, or shows it again. */
  readonly hide: (hidden: boolean) => void;
}

const CONNECTION_TEXT: Readonly<Record<HubConnectionState, string>> = {
  connecting: "Connecting to the Hub…",
  connected: "Connected to the Hub",
  retrying: "Can't reach the Hub. Trying again…",
};

/**
 * A position to the second, as "m:ss", or "h:mm:ss" from an hour, as the
 * Remote shows it, e.g. "1:12:30". Without `padStart`, which Chromium 56
 * hasn't got.
 */
export const formatPosition = (positionMs: number): string => {
  const whole = Math.round(positionMs / 1_000);
  const hours = Math.floor(whole / 3_600);
  const twoDigits = (value: number): string => `${value < 10 ? "0" : ""}${String(value)}`;
  const minutes = Math.floor((whole % 3_600) / 60);
  const seconds = twoDigits(whole % 60);
  return hours > 0 ? `${String(hours)}:${twoDigits(minutes)}:${seconds}` : `${String(minutes)}:${seconds}`;
};

/**
 * The screen the Player shows while it plays nothing, as when it is opened
 * from the TV's own app list (FR-39): "Waiting for the Remote", with the
 * Hub's address and whether the Player can reach it, a "Resume <last Media
 * File>" button when the Hub offers one, which calls `onResume` with it, and
 * why the last Media File the Hub sent isn't playing, if it couldn't be
 * played. It is drawn into `root` once, then only its text changes. The
 * button has focus whenever it is shown, so that OK on the TV's own remote
 * presses it.
 */
export const waitingScreen = (root: HTMLElement, onResume: (resumable: ResumableMediaFile) => void): WaitingScreen => {
  const screen = element("section", "waiting");
  screen.setAttribute("aria-labelledby", "waiting-title");
  // The app's name, at the top left, as a TV's apps have it.
  const header = element("header", "masthead");
  const logo = element("img", "logo");
  logo.src = "icon.png";
  logo.alt = "";
  header.appendChild(logo);
  header.appendChild(element("p", "brand", "Media Centre"));
  // What to do, in the middle, with Resume, the one thing to press, below it.
  const body = element("div", "waiting-body");
  const title = element("h1", "title", "Waiting for the Remote");
  title.id = "waiting-title";
  const hint = element("p", "hint");
  const resume = element("button", "resume");
  resume.type = "button";
  const resumeName = element("span", "resume-name");
  const resumeFrom = element("span", "resume-from");
  resume.appendChild(icon("play", "icon resume-icon"));
  resume.appendChild(resumeName);
  resume.appendChild(document.createTextNode(" "));
  resume.appendChild(resumeFrom);
  let offered: ResumableMediaFile | null = null;
  resume.addEventListener("click", () => {
    if (offered !== null) onResume(offered);
  });
  const problemShown = element("p", "problem");
  problemShown.setAttribute("role", "alert");
  const problemIcon = icon("warning", "icon problem-icon");
  const problemText = element("span", "problem-text");
  problemShown.appendChild(problemIcon);
  problemShown.appendChild(problemText);
  body.appendChild(title);
  body.appendChild(hint);
  body.appendChild(resume);
  body.appendChild(problemShown);
  // The Hub, and whether the Player can reach it, along the bottom.
  const footer = element("footer", "status-bar");
  const connection = element("p", "connection");
  connection.setAttribute("role", "status");
  const hub = element("p", "hub");
  const address = element("span", "address");
  hub.appendChild(document.createTextNode("Hub: "));
  hub.appendChild(address);
  footer.appendChild(connection);
  footer.appendChild(hub);
  screen.appendChild(header);
  screen.appendChild(body);
  screen.appendChild(footer);
  root.appendChild(screen);

  return {
    hide: (hidden) => {
      screen.hidden = hidden;
      // So that OK on the TV's own remote can't press it unseen.
      if (hidden && document.activeElement === resume) resume.blur();
    },
    show: ({ hubAddress, connection: state, problem, resumable }) => {
      offered = resumable;
      resume.hidden = resumable === null;
      resumeName.textContent = resumable === null ? "" : `Resume ${resumable.name}`;
      resumeFrom.textContent = resumable === null ? "" : `from ${formatPosition(resumable.positionMs)}`;
      if (resumable !== null && !screen.hidden && document.activeElement !== resume) resume.focus();
      problemText.textContent = problem ?? "";
      problemShown.hidden = problem === null;
      hint.textContent =
        hubAddress === null
          ? "This TV hasn't been given the Hub's address yet. Choose a Media File for it on the Remote, and the Player will remember the Hub."
          : "Choose a Media File for this TV on the Remote.";
      hub.hidden = hubAddress === null;
      address.textContent = hubAddress ?? "";
      connection.textContent = state === null ? "" : CONNECTION_TEXT[state];
      connection.className = `connection ${state ?? ""}`;
      // Nothing to say along the bottom without a Hub's address, but its status stays, to be heard once it has.
      footer.className = hubAddress === null && state === null ? "status-bar empty" : "status-bar";
    },
  };
};
