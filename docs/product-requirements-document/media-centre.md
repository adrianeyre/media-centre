# media-centre — Product Requirements Document

|                |                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| **Product**    | media-centre                                                                                          |
| **Repository** | `adrianeyre/temp` (to become [`adrianeyre/media-centre`](https://github.com/adrianeyre/media-centre)) |
| **Status**     | Draft                                                                                                 |
| **Visibility** | Private during development                                                                            |
| **Date**       | 2026-10-20                                                                                            |
| **Glossary**   | [`GLOSSARY.md`](../../GLOSSARY.md)                                                                    |
| **Decisions**  | [`docs/architectural-decision-record/`](../architectural-decision-record/)                            |

## 1. Summary

media-centre is one app, on any phone or browser on the home network, for controlling every **Appliance** in the home. That means the TVs, the **Air Conditioners** and the **Lights**, each grouped by **Room**. It also turns the TVs into players for the films, shows and music stored on a PC or NAS.

It has three parts:

- The **Remote** is a phone-first web app with one tab per kind of Appliance: **TV**, **Aircon**, **Lights** and **Heating**.
- The **Hub** is a small always-on process, shipped as a Docker container and normally run on the NAS. It serves the Remote, controls each Appliance through a brand-specific **Driver**, and serves **Media Files** from configured **Media Sources**.
- The **Player** is an app sideloaded onto each Samsung TV. It plays whatever the Hub sends it.

The Remote never talks to an Appliance or a Player directly; everything goes through the Hub ([ADR 0001](../architectural-decision-record/0001-hub-mediates-between-remote-and-appliances.md), [ADR 0003](../architectural-decision-record/0003-remote-reaches-player-only-through-hub.md)). Every Appliance is controlled locally, with no manufacturer cloud required ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).

The work is in three phases:

- **Phase 1 is the TV tab:** control of Samsung Tizen TVs (2018 and later) and media playback on them, plus the Rooms and the tab layout every later phase plugs into.
- **Phase 2 is Aircon.**
- **Phase 3 is Lights.**
- **Phase 4 is Heating.**

Phases 2, 3 and 4 have PRDs of their own: [Aircon](./aircon.md), [Lights](./lights.md) and [Heating](./heating.md).

## 2. Problem

- Every Appliance has its own remote or its own manufacturer app, each with its own account and cloud. Nothing shows the whole home in one place.
- With several TVs, Air Conditioners and Lights, "which one is this?" is a real question. Manufacturer apps name things by model, not by where they are.
- The TV's physical remote gets lost, has no keyboard, and buries most settings several menus deep.
- Watching a film stored on the NAS means navigating the TV's built-in media browser with the physical remote. That browser cannot play many common files: 2018 and later Samsung TVs have no DTS audio, and older codecs such as DivX are unsupported.
- Plex and Jellyfin solve playback but are heavy, and are not under the owner's control.

## 3. Goals

1. One app for every Appliance in the home, grouped by Room, with no manufacturer account and no internet connection needed.
2. Everything a TV's physical remote can do, from a phone.
3. As much of a TV's settings as Samsung allows: real controls where a local API exists, and the **TV Menu** driven by key presses everywhere else ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).
4. Choose any Media File on the phone and have it playing on a TV, waking the TV first if needed, and see what each TV is showing.
5. Every video and audio format ffmpeg can decode plays, converted by the Hub only when the TV cannot decode it ([ADR 0006](../architectural-decision-record/0006-the-hub-converts-what-the-tv-cannot-play.md)).
6. Adding a brand means writing a Driver. Adding a kind of Appliance means a Driver and a tab. Neither changes the rest of the Remote.

## 4. Non-goals

- **Access from outside the home network.** The Hub and Remote are LAN-only.
- **User accounts or authentication.** Anyone on the home network can control every Appliance and play every Media File, just as anyone in the room can pick up a physical remote. A guest on the Wi-Fi has that same access; this is an accepted risk.
- **A live view of a TV's screen.**
  - Samsung offers no local or public API to capture a TV's screen.
  - Screen mirroring only goes phone → TV.
  - `sdb` on a retail TV cannot capture the screen.
  - Copy-protected apps (Netflix and the like) would show black even if it could.

  **Now Showing** (§6.6) is what is offered instead.

- **Publishing the Player on the Samsung app store.** It is sideloaded in Developer Mode.
- **The TV's hidden service menu.** It can misconfigure or brick a TV, so it is never offered and its key sequences are refused (FR-30).
- **DRM-protected files** (e.g. purchased iTunes `.m4v`) and **disc images or disc folders** (`.iso`, `VIDEO_TS`, `BDMV`).
- **Switching a TV's Developer Mode on remotely.** Samsung allows this only at the TV.
- **Any dependency on a manufacturer's cloud or on another home-automation system** such as Home Assistant ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).
- **Automation**, meaning scenes and schedules, **in Phases 1 to 4.** Everything happens when someone taps it. Scenes and schedules are listed under Later. The one exception is Phase 3's Light Scenes, which a TV can recall when a film starts ([Lights PRD](./lights.md)).
- **TV brands other than Samsung in Phase 1.**

## 5. Users and key scenarios

**Primary user:** the owner, a developer with several Samsung TVs, Air Conditioners and Lights, plus a NAS and a PC, all on one home network. They want to control them all from a phone and watch their own media on the TVs.

**Others in the household** use the same Remote with no setup beyond opening its address or tapping its home-screen icon.

1. **Set up the home.**
   1. In Settings, the owner creates the Rooms "Living room", "Bedroom" and "Office".
   2. They tap "Find TVs", pair the two TVs that appear, and rename them: "TV" in the Living room and "TV" in the Bedroom.
   3. Everywhere in the Remote they now read **Living room · TV** and **Bedroom · TV**.
2. **Pick up the phone, not the remote.**
   1. The owner taps the Remote's home-screen icon. The TV tab opens, and Living room · TV is already the Selected TV.
   2. They tap Power, and the TV wakes over Wake-on-LAN.
   3. They drag the volume slider to 18. The slider shows the TV's real volume, even after someone else changed it with the physical remote.
3. **What's on in the bedroom?** The owner switches the Selected TV to Bedroom · TV. Now Showing says "YouTube". They switch back to the Living room without disturbing it.
4. **Type a search.** In YouTube on the TV, the on-screen keyboard opens. The owner types "cosmos documentary" on the phone's own keyboard, and it appears on the TV.
5. **Change a buried setting.** The owner wants to turn off motion smoothing.
   1. They open TV Menu mode, tap Menu, and navigate the TV's own settings with the full-screen D-pad while watching the TV.
   2. For picture mode they use the one-tap Picture Mode shortcut instead.
6. **Watch a film from the NAS.** Living room · TV is off.
   1. In the TV tab's **Watch & Listen** section, the owner browses `Films/Sci-Fi` and taps an MKV with DTS audio.
   2. The Hub wakes the TV, launches the Player, converts only the audio to AC3, and the film starts.
   3. Now Showing shows the film's name, the position, and a preview picture from the film that updates as it plays.
   4. They pause from the phone, pick the English subtitle track, and stop halfway through.
   5. Next evening the Remote offers "Resume from 1:12:30".
7. **Play an album.** The owner taps a folder of FLACs and chooses "Play folder". The TV shows a now-playing screen with the cover art embedded in the files. The phone shows next, previous, shuffle and repeat.
8. **Set up a new TV's Player.**
   1. The Developer section shows the steps to put a new TV in Developer Mode with the Hub's IP as the Developer IP.
   2. The owner follows them, then taps "Install / update Player".
9. **Cool the bedroom (Phase 2).** In the Aircon tab, under Bedroom, the owner sets the Bedroom Air Conditioner to cool at 21° with a low fan.
10. **Lights down (Phase 3).** In the Lights tab, the owner dims every Light in the Living room to 30% with one Room slider.

## 6. Functional requirements

### 6.1 Hub, setup and storage

- **FR-1:** The Hub ships as a Docker image. It also runs with `pnpm start` on a PC for development. One container serves the Remote, the API the Remote and Player use, and the Media Files.
- **FR-2:** The Hub must be on the same subnet as the Appliances it controls. Wake-on-LAN, SSDP discovery and UPnP all require it ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)). The Hub's setup documentation says so, including the Docker networking it needs on a NAS (host networking).
- **FR-3:** All Hub state is in one SQLite file in a Docker volume. This covers Rooms, Appliances, pairing tokens and other Appliance credentials, Media Sources and Resume Positions. Everything is managed from the Remote's Settings screen; there are no hand-edited config files.
- **FR-4:** Pairing tokens and other Appliance credentials are stored only on the Hub. They are never sent to the Remote or written to logs ([ADR 0001](../architectural-decision-record/0001-hub-mediates-between-remote-and-appliances.md)).
- **FR-5:** The Hub serves only files inside a configured Media Source. Any request whose resolved path falls outside one, including via `..` or symlinks, is refused.

### 6.2 The Remote, tabs and Rooms

- **FR-6:** The Remote has one tab per kind of Appliance, in this order: **TV**, **Aircon**, **Lights**, **Heating**, plus a **Settings** screen. A tab appears once its phase has shipped. A tab with no Appliances configured shows how to add one. The Remote reopens on the last tab used. _The tabs are now as the [Ring PRD](./ring.md)'s FR-106 lists them, with Network, Amazon, Ring and Rooms, Rooms last, and Settings opened from the cog (FR-96)._
- **FR-7:** Settings creates, renames and deletes **Rooms**. A Room's name is 1 to 40 characters and is unique, ignoring case.
- **FR-8:** Every Appliance has an editable name and is in **at most one** Room. Appliances with no Room are shown under "No room". Several Appliances of the same kind may share a Room, e.g. two Lights in the Living room. An Appliance's name is unique, ignoring case, among Appliances of the same kind in the same Room.
- **FR-9:** Wherever the Remote names an Appliance, it writes **Room · Name** (e.g. "Bedroom · TV"), or just the name for an Appliance with no Room.
- **FR-10:** Each tab lists its Appliances grouped by Room, in Room order. Settings sets the Room order, which is shared by every tab.
- **FR-11:** Deleting a Room moves its Appliances to "No room". It never deletes an Appliance. Removing an Appliance is a separate action in Settings, which also deletes its stored credentials.
- **FR-58:** Everything on the TV tab below the TV picker is a **widget** on a grid: 12 columns on a desktop, 8 on a tablet and 4 on a phone, each with its own layout. A widget is dragged by its grip, or with a mouse by any part that isn't a control. It snaps into the grid, tilting as it is dragged, and whatever is in its way moves down. Dropped onto the widget below it, the two swap. The widgets around a dropped widget shake. Its corner makes it bigger or smaller, a cell at a time. Any row left empty is removed. Each widget can be hidden. The **Widgets** menu lists every widget, to show or hide each, and resets the layout. Nothing needs a drag (WCAG 2.5.7): a widget's grip opens a menu that moves it, resizes it and hides it, and the arrow keys on the grip move it, or resize it with Shift. Each Remote remembers its own layout.
- **FR-59:** The cog in the app bar, which stays at the top as the page scrolls, opens **Appearance**: Light, Dark or System (the default, following the device), and one of six themes: Evergreen (the default), Ocean, Violet, Sunset, Rose and Graphite. Each Remote remembers its own, and takes it on before the page is first drawn.
- **FR-60:** The footer's **Version** opens the **Changelog**: `CHANGELOG.md`, as semantic-release writes it, newest version first, built into the Remote so that it opens with the internet disconnected. Each change links to its issue and commit on GitHub, in a new tab.
- **FR-61:** As the Remote opens, it asks the Hub for the **latest version** of media-centre, which the Hub reads from the `package.json` on GitHub's `main`, keeping it for an hour. If it isn't the Remote's own version, an **Update available** dialog gives both versions and a button to the latest release on GitHub, in a new tab. Settings has a **Version** section with both versions, and an **Update** button to the same release when they differ. With the internet disconnected the Hub can't say, and the Remote offers nothing and says so in Settings. `HUB_LATEST_VERSION_URL` points the Hub at another `package.json`, or, empty, stops it looking.

### 6.3 TVs and pairing (Phase 1a)

- **FR-12:** "Find TVs" discovers Samsung TVs on the subnet over SSDP. A TV can also be added by IP address. Several TVs can be added, each named and given a Room as it is added.
- **FR-13:** Pairing opens the TV's secure control socket, which makes the TV show its "Allow" prompt. The token the TV issues is stored for later connections. Revoking access on the TV makes the Remote show "Pair again" for that TV.
- **FR-14:** Each TV stores its IP, MAC address (for Wake-on-LAN) and model, read from the TV's device info. Its name defaults to the TV's own name.
- **FR-15:** In the TV tab, a Remote has one **Selected TV**, which it remembers. The TV picker shows every TV as Room · Name and is one tap away from every TV screen.
- **FR-16:** The TV list shows each TV's power state (on, standby or unreachable), read from the TV's device info.

### 6.4 TV control (Phase 1a)

- **FR-17:** Power on uses Wake-on-LAN; power off uses the power key. Frame TVs need a held power key rather than a press, and the Samsung TV Driver handles this.
- **FR-18:** Keys: D-pad, OK, Back, Home, Menu, Tools, Info, Source, channel up and down, a number pad, the coloured keys, and media keys (play, pause, stop, rewind, fast-forward).
- **FR-19:** Volume: an absolute 0–100 slider and a mute toggle, both reading the TV's actual state over UPnP. Volume up and down buttons too. When UPnP is unavailable (e.g. TV in standby), the slider is disabled and the buttons still work.
- **FR-20:** Text input: while the TV's on-screen keyboard is open, a text field on the Remote sends what is typed to the TV.
- **FR-21:** Apps: the Remote lists the TV's installed apps and launches or closes any of them.
- **FR-22:** Key presses feel immediate: on the home network, the TV acts on a key within 200 ms of the tap in normal conditions.

### 6.5 TV Menu mode and settings (Phase 1a)

- **FR-23:** **TV Menu mode** is a full-screen layout for driving the TV Menu while watching the TV. It has a large D-pad, OK, Back, Home, Menu and Tools.
- **FR-24:** TV Menu mode has one-tap shortcuts that open or cycle TV settings directly: picture mode, picture size, sleep timer, energy saving, captions, audio description, audio track and input source. A shortcut the Selected TV ignores is reported to the person, not silently dropped. Which keys work varies by model and firmware.
- **FR-25:** The TV tab shows real controls only for what the local API can read or set (FR-19 to FR-21). It never displays a value it cannot read, such as the current picture mode, as if it were known.

### 6.6 Now Showing

- **FR-26 (Phase 1a):** For the Selected TV, the TV tab shows a **Now Showing** card with the app in front (name and icon, e.g. "YouTube" or "Live TV"). The Hub reads this from the TV's local app status, which reports for each app whether it is running and visible. When it cannot tell, the card says so rather than guessing. When the TV is in standby, it says that.
- **FR-27 (Phase 1b):** When the Player is in front, Now Showing adds:
  - the Media File's name, position and duration, and the audio and subtitle tracks in use;
  - for video, a **preview picture**. The Hub extracts the frame at the current position from the Media File itself with ffmpeg and refreshes it every 5 seconds while playing. It is a picture of the file, not a capture of the screen;
  - for audio, the cover art embedded in the file.

### 6.7 Developer section (TV)

- **FR-28:** For the Selected TV, the Developer section shows device info: model, name, MAC, network type, Frame support, and, if the TV reports them, Developer Mode on or off and the Developer IP. **(Phase 1a)**
- **FR-29:** It shows step-by-step instructions for turning on Developer Mode with the Hub's IP as the Developer IP. Samsung allows this only at the TV, with the physical remote. **(Phase 1a)**
- **FR-30:** The Samsung TV Driver refuses to send `KEY_FACTORY` and the known service-menu key sequences, whatever asks for them. **(Phase 1a)**
- **FR-31 (Phase 1b):** When the TV is in Developer Mode with the Hub's IP as its Developer IP, the Developer section has an **Install / update Player** button. The Hub uses Samsung's `sdb` and `tizen` command-line tools, which are in its image, and the owner's Samsung signing certificate, which is stored on the Hub, to install the current Player build. Progress and errors are shown. The Developer section can also launch and uninstall the Player. Until this exists, the manual install from a PC with Tizen Studio is documented.

### 6.8 Watch & Listen: Media Sources and browsing (Phase 1b)

- **FR-32:** A Media Source is a folder the Hub can read: a local path, or a network share mounted into the Hub's container. Settings adds, renames and removes Media Sources.
- **FR-33:** The TV tab has a **Watch & Listen** section. It browses each Media Source as its folder tree, showing folders and Media Files (videos and audio) by file name, with size and duration. Other files are hidden. There are no posters or scraped metadata.
- **FR-34:** Each Media File shows whether it will play directly or needs converting. Full conversion (FR-41) is flagged so the person knows it uses a lot of Hub CPU.

### 6.9 Playback and the Player (Phase 1b)

- **FR-35:** Choosing a Media File plays it on the Selected TV ([ADR 0003](../architectural-decision-record/0003-remote-reaches-player-only-through-hub.md)):
  1. If the TV is off, the Hub wakes it and waits up to 30 seconds. After that the Remote shows an error.
  2. The Hub launches the Player through the Samsung TV Driver, passing the Hub's address as a launch parameter.
  3. The Player opens a WebSocket to the Hub, and the Hub sends it the Media File's URL.
  4. The Remote shows progress through each step.
- **FR-36:** While a Media File is playing, the Remote shows a now-playing bar on every TV screen with play/pause, a seek bar, ±10 s and ±30 s skips, stop, and audio and subtitle track selection. Playback state comes back from the Player through the Hub.
- **FR-37:** The physical remote's media keys and Back also control the Player.
- **FR-38:** The Player plays through Samsung's AVPlay ([ADR 0005](../architectural-decision-record/0005-the-player-uses-samsung-avplay.md)), behind a playback interface inside the Player.
- **FR-39:** The Player remembers the Hub's address. Opened from the TV's own app list, it shows a "Waiting for the Remote" screen with the Hub's address, plus a "Resume <last Media File>" button.
- **FR-40:** The Hub records a **Resume Position** for each Media File as it plays. Choosing a Media File with one offers "Resume from h:mm:ss" or "Start over". A Media File played to within its last 5% is treated as finished, and its Resume Position is cleared.

### 6.10 Formats and conversion (Phase 1b)

- **FR-41:** Every Media File whose video and audio ffmpeg can decode plays. Before each play, the Hub probes the Media File with ffprobe and compares it with what the Selected TV can decode. It then picks the cheapest route that works ([ADR 0006](../architectural-decision-record/0006-the-hub-converts-what-the-tv-cannot-play.md)):
  1. **Direct play:** the file is served unchanged over HTTP with range requests.
  2. **Remux:** the container changes and the streams are copied.
  3. **Audio conversion:** only the audio is re-encoded, e.g. DTS or TrueHD to AC3.
  4. **Full conversion:** the video is re-encoded too.
- **FR-42:** Remux and both kinds of conversion are streamed to the Player as HLS, so seeking works. Full conversion uses hardware acceleration (VAAPI, Quick Sync, NVENC) when the container can see a GPU device, and software encoding otherwise.
- **FR-43:** ffmpeg and ffprobe ship inside the Hub's Docker image.

### 6.11 Subtitles (Phase 1b)

- **FR-44:** Sidecar subtitle files next to a Media File (`.srt`, `.vtt`, `.ass`, matched by file name, with language from suffixes like `.en.srt`) are offered alongside the subtitle tracks inside the file.
- **FR-45:** Text subtitles the Player cannot render natively are converted to a format it can. Image-based subtitles (PGS, VobSub) the TV cannot render are burned into the picture, which forces full conversion.

### 6.12 Music (Phase 1b)

- **FR-46:** Audio Media Files (MP3, FLAC, AAC, ALAC, OGG/Opus, WAV, and anything else ffmpeg can decode) are browsed like videos. One can be played on its own, or a folder can be played as a queue.
- **FR-47:** While audio plays, the Player shows a now-playing screen: cover art embedded in the file, title, artist, album and progress, taken from the file's tags and falling back to the file name.
- **FR-48:** The Remote has queue controls: next, previous, shuffle and repeat (off, one, all). It also shows the queue.

### 6.13 Aircon (Phase 2)

FR-49 to FR-51b are in the [Aircon PRD](./aircon.md): the Midea Driver, adding Air Conditioners with a one-off token fetch, and the Aircon tab with each unit's own controls.

### 6.14 Lights (Phase 3)

FR-52 to FR-57b are in the [Lights PRD](./lights.md): the Lepro Driver after a spike, the Lights tab with Room-wide control and All off, Light Scenes, and a TV's film Light Scene.

### 6.15 Heating (Phase 4)

FR-62 to FR-68a are in the [Heating PRD](./heating.md): the Hive Driver through Hive's cloud, as the one exception to local control ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)), Hive in Settings, and the Heating tab with each zone, the Whole home, the Hot Water and the Radiator Valves by Room.

## 7. Non-functional requirements

- **NFR-1:** TypeScript (strict, ESM) throughout, as a pnpm monorepo of `hub`, `remote`, `player` and `shared`. `shared` holds the message types the Hub, Remote and Player exchange. Node 26+ and pnpm 12.
- **NFR-2:** The Remote is phone-first and works on tablets and desktop browsers. It is served over plain HTTP and is installed with Add to Home Screen. HTTPS through a local certificate authority (for a fully installable PWA) is listed under Later.
- **NFR-3:** The Remote, Hub and Player work with the internet disconnected. The one thing the Hub asks the internet for is the latest version's number (FR-61), and it works on without an answer. The Remote talks only to the Hub.
- **NFR-4:** The Hub restarts cleanly. Rooms, Appliances, pairing tokens, Media Sources and Resume Positions survive a container restart or image upgrade.
- **NFR-5:** Every automated test runs against fakes of the Appliances: a fake Samsung TV in Phase 1, with each later Driver bringing its own fake. Nothing in CI or a Sandcastle sandbox needs a real Appliance ([ADR 0004](../architectural-decision-record/0004-a-fake-samsung-tv-stands-in-for-real-tvs.md)).
- **NFR-6:** A Driver is the only code that knows a brand's protocol. The Remote and the rest of the Hub work in terms of Appliances and their capabilities.

## 8. Testing and delivery

- **Unit and integration:** Vitest. The Hub and the Samsung TV Driver are tested against the fake Samsung TV, which speaks the TV's WebSocket and REST protocols and records what it receives. The Player's UI is tested against a fake playback implementation, because AVPlay exists only on a TV.
- **End to end:** Playwright drives the Remote against a real Hub, the fake TV and a test Media Source of small sample files covering each conversion route.
- **Manual:** anything only a real Appliance can prove is on the checklist in §10, and each pull request says which items it affects.
- **CI:** a GitHub Actions workflow runs the gate, `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test`, on every pull request and every push to `main`, and can be run by hand (`workflow_dispatch`). It was created with the first code but run only by hand until every phase was complete, to save GitHub Actions minutes; enabling it was the project's final task. A pull request pushed to again cancels its out-of-date run. The gate is still run locally before a pull request is opened (see [`docs/processes/running-sandcastle.md`](../processes/running-sandcastle.md)), and the end-to-end tests, which need Linux's loopback addresses and the fakes, run locally only.
- **Releases:** the same workflow's `release` job runs semantic-release on a push to `main` that passes the gate. From the Conventional Commits since the last `v*` tag it picks the next version, prepends it to `CHANGELOG.md`, sets every `package.json` to it in a `chore(release): <version> [skip ci]` commit, tags it and makes a GitHub release. `v1.0.0` marks the commit `CHANGELOG.md` was first written up to, so the first automated release follows on from it rather than writing 1.0.0 again.

## 9. Phases

### Phase 1 — TV

**1a. The Remote, the Hub and TV control.** FR-1 to FR-26, FR-28 to FR-30, and NFRs.

- Monorepo, Hub Docker image, SQLite storage, and the fake Samsung TV.
- The tab layout, Settings, and Rooms.
- Discovery and pairing of several TVs, naming, Rooms, and the Selected TV.
- All remote keys, text input, apps, power and the absolute volume slider.
- TV Menu mode and its shortcuts.
- Now Showing (the app in front).
- The Developer section (device info and instructions).
- The CI workflow, run only by hand until every phase was complete (§8).

**1b. The Player and media.** FR-27, FR-31 to FR-48.

- Media Sources and Watch & Listen.
- The Player (AVPlay) and the launch and WebSocket handshake.
- Playback controls and Resume Positions.
- Now Showing with the preview picture.
- ffprobe and the four routes, with HLS and hardware acceleration.
- Subtitles and music.
- Install / update Player through `sdb`.

### Phase 2 — Aircon

See the [Aircon PRD](./aircon.md).

### Phase 3 — Lights

See the [Lights PRD](./lights.md).

### Phase 4 — Heating

See the [Heating PRD](./heating.md).

### Final task

- Enable CI on pull requests and pushes to `main`. Done: see §8.

### Later (not scheduled)

- **Scenes:** one tap sets several Appliances across tabs, beyond a Room's Light Scenes (FR-56), e.g. "Movie night" dims the Living-room Lights, sets the Aircon to 21° and turns on the TV.
- **Schedules:** a Scene or a single action at a set time, and editing Hive's own heating and hot water schedules.
- **Hive's holiday mode, frost protection and geolocation**, and bringing Hive within [ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md) by a Zigbee coordinator on the Hub ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)).
- **SmartThings for TVs**, opt-in and off by default. It would read and set picture mode, sound mode, sound output and input source ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).
- **Frame TV Art Mode** settings.
- **HTTPS** through a local certificate authority, so the Remote can be installed as a full PWA.
- **Posters and descriptions** from TMDB.
- **Music library** by artist and album, and **playlists**.
- **mDNS** (`media-centre.local`).
- **Other TV brands:** LG webOS, Android/Google TV, Roku.

## 10. Manual checklist (real Appliance only)

To be run on a real Samsung TV before each part of Phase 1 is called done, and on a real Air Conditioner, real Lights and the real Hive before Phases 2, 3 and 4 are.

- [ ] SSDP discovery finds the TV; adding by IP works; two TVs can be added, named and given Rooms.
- [ ] The pairing prompt appears on the TV; the token persists across a Hub restart; revoking it on the TV leads to "Pair again".
- [ ] Wake-on-LAN powers on the TV from standby; power off works (including the held key on a Frame).
- [ ] The UPnP volume slider reads and sets the real volume; it is disabled in standby.
- [ ] Text input reaches the on-screen keyboard.
- [ ] Each TV Menu shortcut (FR-24) does what it says on this model, and any it ignores is reported.
- [ ] Now Showing names the app in front for Live TV, YouTube, Netflix and the Player.
- [ ] Device info reports Developer Mode and Developer IP (or the Developer section copes when it doesn't).
- [ ] The Player installs (manually, then through `sdb`), launches with the Hub's address, and reconnects when opened from the app list.
- [ ] One sample of each route plays: direct MP4, an MKV needing remux, an MKV with DTS (audio conversion), DivX/Xvid AVI (full conversion), 4K HEVC HDR direct.
- [ ] Seeking works on direct play and on HLS; the preview picture follows the position.
- [ ] Sidecar, embedded text and image-based subtitles all display.
- [ ] A FLAC folder plays as a queue with cover art.

Phases 2, 3 and 4 have their own checklists, in the [Aircon](./aircon.md), [Lights](./lights.md) and [Heating](./heating.md) PRDs.

## 11. Open questions

1. **Which TV models?** Requirements assume 2018 or later Samsungs (Tizen 4+, secure control socket on port 8002 with a pairing token).
2. **Which machine runs the Hub?** Make and model of the NAS, or its CPU. This decides whether full conversion of 1080p or 4K keeps up in real time, and which hardware acceleration to target first.
3. **Which Air Conditioners?** _Answered:_ Midea, three or more units, controlled today by Midea's MSmartHome app over Wi-Fi. Model numbers are still to be recorded from the units' labels. Phase 2 stays local, with one cloud fetch per unit when it is added ([ADR 0009](../architectural-decision-record/0009-midea-tokens-are-fetched-once-from-the-cloud.md)). No IR blaster is needed. See the [Aircon PRD](./aircon.md).
4. **Which Lights?** _Answered:_ Lepro bulbs, controlled by Lepro's LampUX app; plugs, strips and wall dimmers are planned, brand undecided. Philips Hue, TP-Link Tapo/Kasa and Tuya / Smart Life are wanted as later Drivers. _Still open:_ whether LampUX bulbs have a local API, which the Phase 3 spike answers. See the [Lights PRD](./lights.md).
5. **Which heating?** _Answered:_ Hive, with two heating zones, Hive Radiator Valves and hot water, controlled today by the Hive app. Hive has no local API, so the Hive Driver reaches Hive's cloud as the one exception for Hive alone ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)). Models and counts are still to be recorded. See the [Heating PRD](./heating.md).
6. **Unverified research**, to be confirmed on a real TV:
   - Does the device info at `GET http://<tv>:8001/api/v2/` report `developerMode` and `developerIP`?
   - Does app status at `GET http://<tv>:8001/api/v2/applications/<appId>` report `visible` reliably enough to drive Now Showing?
   - How much does `sdb shell` allow on a retail TV?
   - For the later SmartThings work: do new personal access tokens now expire after 24 hours, forcing OAuth?
