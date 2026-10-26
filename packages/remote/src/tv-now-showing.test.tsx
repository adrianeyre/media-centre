import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { PLAYER_APP_ID, type NowPlaying, type PowerState } from "@media-centre/shared";

import { HubRequestFailed } from "./hub-request.ts";
import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvNowShowing } from "./tv-now-showing.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

const YOUTUBE = { id: "111299001912", name: "YouTube", icon: true };

const renderCard = (appliances: FakeAppliancesApi, power: PowerState | undefined = "on", refreshMs = 20) =>
  render(<TvNowShowing appliances={appliances} tv={TV} title="Living room · TV" power={power} refreshMs={refreshMs} />);

const card = () => screen.getByRole("region", { name: "Now Showing" });

/** What the card says now. */
const shown = () => within(card()).getByRole("status").textContent;

describe("the Selected TV's Now Showing card (FR-26)", () => {
  it("names the app in front, with its icon from the Hub", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    renderCard(appliances);

    await waitFor(() => {
      expect(shown()).toBe("YouTube");
    });
    const icon = within(card()).getByRole("status").querySelector("img");
    expect(icon?.getAttribute("src")).toBe("/api/appliances/2/apps/111299001912/icon");
    expect(icon?.getAttribute("alt")).toBe("");
    expect(appliances.nowShowingReads.every((id) => id === TV.id)).toBe(true);
  });

  it("shows the app's first letter where the TV gives no icon, or the icon won't load", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: { id: "org.tizen.browser", name: "Internet", icon: false } });
    renderCard(appliances, "on", 60_000);

    await waitFor(() => {
      expect(card().querySelector(".app-icon-none")?.getAttribute("data-letter")).toBe("I");
    });
    expect(card().querySelector("img")).toBeNull();
    cleanup();

    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    renderCard(appliances, "on", 60_000);
    const icon = await waitFor(() => {
      const img = card().querySelector("img");
      if (img === null) throw new Error("YouTube has an icon");
      return img;
    });
    fireEvent.error(icon);
    await waitFor(() => {
      expect(card().querySelector(".app-icon-none")?.getAttribute("data-letter")).toBe("Y");
    });
  });

  it("follows the TV as another app comes to the front, without being shown again", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    renderCard(appliances);
    await waitFor(() => {
      expect(shown()).toBe("YouTube");
    });

    appliances.setNowShowing(TV.id, { known: true, app: { id: "3201907018807", name: "Netflix", icon: true } });

    await waitFor(() => {
      expect(shown()).toBe("Netflix");
    });
    expect(card().querySelector("img")?.getAttribute("src")).toBe("/api/appliances/2/apps/3201907018807/icon");
  });

  it("says it can't tell when no app says it is in front, rather than guessing", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: false, why: "cannot-tell" });
    renderCard(appliances);

    await waitFor(() => {
      expect(shown()).toBe("Can't tell what Living room · TV is showing: none of its apps says it is in front.");
    });
    expect(card().querySelector("img, .app-icon")).toBeNull();
  });

  it("says a TV in standby is in standby", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: false, why: "standby" });
    renderCard(appliances, "standby");

    await waitFor(() => {
      expect(shown()).toBe("Living room · TV is in standby.");
    });
  });

  it("says a TV that isn't answering isn't", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: false, why: "unreachable" });
    renderCard(appliances, "unreachable");

    await waitFor(() => {
      expect(shown()).toBe("Living room · TV isn't answering, so what it is showing can't be told.");
    });
  });

  it("says it is checking until the Hub first answers", () => {
    const appliances = fakeAppliancesApi([TV]);
    renderCard(appliances);

    expect(shown()).toBe("Checking what Living room · TV is showing…");
  });

  it("reads it again at once when the TV's power state changes", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: false, why: "standby" });
    const { rerender } = renderCard(appliances, "standby", 60_000);
    await waitFor(() => {
      expect(shown()).toBe("Living room · TV is in standby.");
    });

    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    rerender(<TvNowShowing appliances={appliances} tv={TV} title="Living room · TV" power="on" refreshMs={60_000} />);

    await waitFor(() => {
      expect(shown()).toBe("YouTube");
    });
  });

  it("says why it couldn't be read, and then shows no app rather than the one it last read", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    let failing = false;
    renderCard({
      ...appliances,
      readNowShowing: (id) =>
        failing
          ? Promise.reject(
              new HubRequestFailed("Living room · TV no longer lets the Hub in. Pair it again in Settings."),
            )
          : appliances.readNowShowing(id),
    });
    await waitFor(() => {
      expect(shown()).toBe("YouTube");
    });

    failing = true;

    expect((await within(card()).findByRole("alert")).textContent).toBe(
      "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
    );
    expect(shown()).toBe("");
    failing = false;
    await waitFor(() => {
      expect(shown()).toBe("YouTube");
    });
    expect(within(card()).queryByRole("alert")).toBeNull();
  });

  it("changes nothing on the TV", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    renderCard(appliances);
    await waitFor(() => {
      expect(appliances.nowShowingReads.length).toBeGreaterThan(2);
    });

    expect(appliances.keysPressed).toEqual([]);
    expect(appliances.appsDone).toEqual([]);
    expect(appliances.powerSwitches).toEqual([]);
    expect(appliances.volumeChanges).toEqual([]);
  });
});

describe("Now Showing for the Player in front (FR-27)", () => {
  const PLAYER = { id: PLAYER_APP_ID, name: "Media Centre", icon: true };

  const FILM: NowPlaying = {
    name: "Arrival.mkv",
    route: "audio-conversion",
    state: "playing",
    positionMs: 754_400,
    durationMs: 6_960_000,
    audioTracks: [
      { language: "eng", title: "Surround", codec: "dts", channels: 6 },
      { language: "fre", title: null, codec: "ac3", channels: 2 },
    ],
    audioTrack: 1,
    subtitleTracks: [
      { language: "eng", title: null, codec: "subrip", sidecar: null, burnedIn: false },
      { language: "fr", title: null, codec: "ass", sidecar: "Arrival.fr.ass", burnedIn: false },
    ],
    subtitleTrack: 1,
    preview: { positionMs: 750_000 },
    music: null,
    queue: null,
  };

  /** Shows the card for the Player in front playing `playing`, as Now Showing and the Player's playback both say. */
  const showPlayer = (playing: NowPlaying | null, playbackRefreshMs = 20) => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: PLAYER, nowPlaying: playing });
    appliances.setNowPlaying(TV.id, playing);
    render(
      <TvNowShowing
        appliances={appliances}
        tv={TV}
        title="Living room · TV"
        power="on"
        refreshMs={60_000}
        playbackRefreshMs={playbackRefreshMs}
      />,
    );
    return appliances;
  };

  const player = () => card().querySelector(".now-showing-player");
  const preview = () => card().querySelector<HTMLImageElement>("img.now-showing-preview");
  const tracks = () =>
    Array.from(card().querySelectorAll(".now-showing-tracks > div")).map((row) => [
      row.querySelector("dt")?.textContent,
      row.querySelector("dd")?.textContent,
    ]);

  it("names the Player, and the Media File it plays, with its position, duration and the tracks in use", async () => {
    showPlayer(FILM);

    await waitFor(() => {
      expect(shown()).toBe("Media Centre");
    });
    expect(card().querySelector(".now-showing-media-file")?.textContent).toBe("Arrival.mkv");
    expect(card().querySelector(".now-showing-position")?.textContent).toBe("Playing · 12:34 of 1:56:00");
    expect(tracks()).toEqual([
      ["Audio", "French · Dolby Digital stereo"],
      ["Subtitles", "French · ASS file"],
    ]);
    // Outside what the card announces, so that it isn't read out as it moves on.
    expect(within(card()).getByRole("status").contains(player())).toBe(false);
  });

  it("shows the preview picture from the Hub, a frame of the file itself at its position", async () => {
    showPlayer(FILM);

    const picture = await waitFor(() => {
      const img = preview();
      if (img === null) throw new Error("The film has a preview picture");
      return img;
    });
    expect(picture.getAttribute("src")).toBe("/api/appliances/2/preview?at=750000");
    expect(picture.getAttribute("alt")).toBe("Arrival.mkv at 12:30, a frame from the file itself");
  });

  it("follows what the Player reports every second, asking for the preview picture again only once it has moved", async () => {
    const appliances = showPlayer(FILM);
    await waitFor(() => {
      expect(preview()?.getAttribute("src")).toBe("/api/appliances/2/preview?at=750000");
    });

    appliances.setNowPlaying(TV.id, { ...FILM, positionMs: 757_400 });
    await waitFor(() => {
      expect(card().querySelector(".now-showing-position")?.textContent).toBe("Playing · 12:37 of 1:56:00");
    });
    expect(preview()?.getAttribute("src")).toBe("/api/appliances/2/preview?at=750000");

    appliances.setNowPlaying(TV.id, {
      ...FILM,
      state: "paused",
      positionMs: 760_000,
      preview: { positionMs: 755_000 },
    });
    await waitFor(() => {
      expect(preview()?.getAttribute("src")).toBe("/api/appliances/2/preview?at=755000");
    });
    expect(card().querySelector(".now-showing-position")?.textContent).toBe("Paused · 12:40 of 1:56:00");
    // Read from the Hub, never from the TV, which Now Showing asks only every few seconds.
    expect(appliances.nowShowingReads).toHaveLength(1);
  });

  it("hides a preview picture that won't load until it moves", async () => {
    const appliances = showPlayer(FILM);
    const picture = await waitFor(() => {
      const img = preview();
      if (img === null) throw new Error("The film has a preview picture");
      return img;
    });

    fireEvent.error(picture);
    await waitFor(() => {
      expect(preview()).toBeNull();
    });
    expect(card().querySelector(".now-showing-media-file")?.textContent).toBe("Arrival.mkv");

    appliances.setNowPlaying(TV.id, { ...FILM, preview: { positionMs: 755_000 } });
    await waitFor(() => {
      expect(preview()?.getAttribute("src")).toBe("/api/appliances/2/preview?at=755000");
    });
  });

  it("shows no preview picture for a Media File without one, as audio, and says when subtitles are off", async () => {
    showPlayer({
      ...FILM,
      name: "01 Tone.flac",
      route: "direct-play",
      audioTracks: [{ language: null, title: null, codec: "flac", channels: 2 }],
      audioTrack: 0,
      subtitleTracks: [],
      subtitleTrack: null,
      preview: null,
    });

    await waitFor(() => {
      expect(card().querySelector(".now-showing-media-file")?.textContent).toBe("01 Tone.flac");
    });
    expect(preview()).toBeNull();
    expect(tracks()).toEqual([
      ["Audio", "Track 1 · FLAC stereo"],
      ["Subtitles", "Off"],
    ]);
  });

  describe("for audio, its cover art", () => {
    const MUSIC = {
      title: "Tone in A",
      artist: "The Sine Waves",
      album: "Test Tones",
      coverArt: "/api/media-sources/1/cover-art/Music/Album/01%20Tone.flac",
    };
    const TONE: NowPlaying = {
      ...FILM,
      name: "01 Tone.flac",
      route: "direct-play",
      audioTracks: [{ language: null, title: null, codec: "flac", channels: 2 }],
      audioTrack: 0,
      subtitleTracks: [],
      subtitleTrack: null,
      preview: null,
      music: MUSIC,
    };
    const coverArt = () => card().querySelector<HTMLImageElement>("img.now-showing-cover-art");
    const placeholder = () => within(card()).queryByRole("img", { name: "No cover art" });

    it("shows the cover art embedded in the file, from the Hub, as the Player's now-playing screen does", async () => {
      showPlayer(TONE);

      const shownArt = await within(card()).findByRole("img", { name: "Cover art of Test Tones" });
      expect(shownArt).toBe(coverArt());
      expect(shownArt.getAttribute("src")).toBe("/api/media-sources/1/cover-art/Music/Album/01%20Tone.flac");
      expect(preview()).toBeNull();
      expect(placeholder()).toBeNull();
      expect(card().querySelector(".now-showing-media-file")?.textContent).toBe("01 Tone.flac");
    });

    it("shows a placeholder for a Media File with none", async () => {
      showPlayer({ ...TONE, music: { title: "02 Tone.mp3", artist: null, album: null, coverArt: null } });

      await waitFor(() => {
        expect(placeholder()).not.toBeNull();
      });
      expect(coverArt()).toBeNull();
    });

    it("shows a placeholder for cover art that won't load, until the Player plays another", async () => {
      const appliances = showPlayer(TONE);
      await waitFor(() => {
        expect(coverArt()).not.toBeNull();
      });

      coverArt()?.dispatchEvent(new Event("error"));

      await waitFor(() => {
        expect(placeholder()).not.toBeNull();
      });
      const other = "/api/media-sources/1/cover-art/Music/Other%20Album/01.flac";
      appliances.setNowPlaying(TV.id, { ...TONE, music: { ...MUSIC, album: "Other Album", coverArt: other } });
      expect((await within(card()).findByRole("img", { name: "Cover art of Other Album" })).getAttribute("src")).toBe(
        other,
      );
    });
  });

  it("says what isn't known yet as the Media File loads", async () => {
    showPlayer({ ...FILM, state: "loading", positionMs: 0, durationMs: null, audioTrack: null, preview: null });

    await waitFor(() => {
      expect(card().querySelector(".now-showing-position")?.textContent).toBe(
        "Loading · 0:00 of a length not known yet",
      );
    });
    expect(tracks()[0]).toEqual(["Audio", "Not known yet"]);
  });

  it("says the Player is waiting while it plays nothing, and follows it once it plays", async () => {
    const appliances = showPlayer(null);
    await waitFor(() => {
      expect(player()?.textContent).toBe("The Player is waiting for a Media File.");
    });

    appliances.setNowPlaying(TV.id, FILM);

    await waitFor(() => {
      expect(card().querySelector(".now-showing-media-file")?.textContent).toBe("Arrival.mkv");
    });
  });

  it("says nothing of the Player's playback when another app is in front", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowShowing(TV.id, { known: true, app: YOUTUBE });
    appliances.setNowPlaying(TV.id, FILM);
    renderCard(appliances);

    await waitFor(() => {
      expect(shown()).toBe("YouTube");
    });
    expect(player()).toBeNull();
    expect(appliances.playbackReads).toEqual([]);
  });
});
