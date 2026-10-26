/**
 * The Player as a TV runs it: the entry point of the bundle `pnpm build`
 * makes. On a TV it plays through AVPlay (ADR 0005); in a desktop browser,
 * which has none, through the fake, so that its screens can be seen there.
 */
import { appControlData, launchedHubAddress } from "./launch.ts";
import { avplayPlayback } from "./playback/avplay-playback.ts";
import { fakePlayback } from "./playback/fake-playback.ts";
import { startPlayer } from "./player.ts";
import { rememberedHub } from "./remembered-hub.ts";
import { registerMediaKeys } from "./remote-keys.ts";

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const root = document.getElementById("player");
if (root === null) throw new Error("The Player's page has no #player element.");
const subtitlesRoot = document.getElementById("subtitles");
if (subtitlesRoot === null) throw new Error("The Player's page has no #subtitles element.");
const overlayRoot = document.getElementById("overlay");
if (overlayRoot === null) throw new Error("The Player's page has no #overlay element.");

const launched = (): string | null => launchedHubAddress(appControlData(window.tizen), window.location.search);

const player = startPlayer({
  root,
  launchedWith: launched(),
  rememberedHub: rememberedHub(storage()),
  openSocket: (url) => new WebSocket(url),
  // In a desktop browser, the fake plays in real time, so that the Remote's now-playing bar moves.
  playback: window.webapis === undefined ? fakePlayback({ tickMs: 1_000 }) : avplayPlayback(window.webapis.avplay),
  subtitlesRoot,
  overlayRoot,
});

// The TV sends the Player its own remote's media keys only once it has asked for them (FR-37).
registerMediaKeys(window.tizen?.tvinputdevice);

// A TV that launches the Player while it is already running, as the Hub
// does to play a Media File, tells it so, with its new launch data.
window.addEventListener("appcontrol", () => {
  player.launched(launched());
});
