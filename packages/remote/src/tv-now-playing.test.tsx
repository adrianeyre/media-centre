import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { NowPlaying } from "@media-centre/shared";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvNowPlaying } from "./tv-now-playing.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

const ARRIVAL: NowPlaying = {
  name: "Arrival.mkv",
  route: "audio-conversion",
  state: "playing",
  positionMs: 754_400,
  durationMs: 6_960_000,
  audioTracks: [
    { language: "eng", title: "Surround", codec: "dts", channels: 6 },
    { language: "fre", title: null, codec: "ac3", channels: 2 },
    { language: null, title: null, codec: "aac", channels: 2 },
  ],
  audioTrack: 0,
  subtitleTracks: [
    { language: "eng", title: null, codec: "subrip", sidecar: null, burnedIn: false },
    { language: "ger", title: "Signs", codec: "ass", sidecar: null, burnedIn: false },
    { language: "en", title: null, codec: "subrip", sidecar: "Arrival.en.srt", burnedIn: false },
    { language: "fr", title: null, codec: "ass", sidecar: "Arrival.fr.ass", burnedIn: false },
    { language: null, title: null, codec: "webvtt", sidecar: "Arrival.vtt", burnedIn: false },
  ],
  subtitleTrack: null,
  preview: null,
  music: null,
  queue: null,
};

const renderBar = (appliances: FakeAppliancesApi, refreshMs = 20) =>
  render(<TvNowPlaying appliances={appliances} tv={TV} refreshMs={refreshMs} />);

const bar = () => screen.getByRole("region", { name: "Now playing" });
const button = (name: string) => within(bar()).getByRole("button", { name });
const seekBar = () => within(bar()).getByRole<HTMLInputElement>("slider", { name: "Seek" });
const audio = () => within(bar()).getByRole<HTMLSelectElement>("combobox", { name: "Audio" });
const audioTracks = () => Array.from(audio().options).map(({ textContent, value }) => [textContent, value]);
const subtitles = () => within(bar()).getByRole<HTMLSelectElement>("combobox", { name: "Subtitles" });
const subtitleTracks = () => Array.from(subtitles().options).map(({ textContent, value }) => [textContent, value]);

/** A Media File playing on the TV, and the bar showing it. */
const playing = async (nowPlaying: NowPlaying = ARRIVAL, refreshMs = 20): Promise<FakeAppliancesApi> => {
  const appliances = fakeAppliancesApi([TV]);
  appliances.setNowPlaying(TV.id, nowPlaying);
  renderBar(appliances, refreshMs);
  await waitFor(() => {
    expect(within(bar()).getByText(nowPlaying.name, { selector: ".now-playing-name" })).toBeTruthy();
  });
  return appliances;
};

describe("the now-playing bar (FR-36)", () => {
  it("shows nothing while the TV's Player plays nothing", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderBar(appliances);

    await waitFor(() => {
      expect(appliances.playbackReads.length).toBeGreaterThan(1);
    });
    expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
  });

  it("shows the Media File playing, with its position and length on a seek bar", async () => {
    await playing();

    expect(bar().textContent).toContain("12:34");
    expect(bar().textContent).toContain("1:56:00");
    expect(seekBar().value).toBe("754");
    expect(seekBar().max).toBe("6960");
    expect(seekBar().getAttribute("aria-valuetext")).toBe("12:34 of 1:56:00");
    expect(within(bar()).getByRole("group", { name: "Playback" })).toBeTruthy();
    expect(
      within(bar())
        .getAllByRole("button")
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual(["Back 30 seconds", "Back 10 seconds", "Pause", "Forward 10 seconds", "Forward 30 seconds", "Stop"]);
  });

  it("lists every audio track of the Media File, by its language where known, with the one playing chosen", async () => {
    await playing();

    expect(audioTracks()).toEqual([
      ["English · Surround · DTS 5.1", "0"],
      ["French · Dolby Digital stereo", "1"],
      ["Track 3 · AAC stereo", "2"],
    ]);
    expect(audio().value).toBe("0");
  });

  it("switches audio track as chosen, through the Hub, whatever the Route, and shows the Player playing it", async () => {
    const appliances = await playing();

    fireEvent.change(audio(), { target: { value: "2" } });

    await waitFor(() => {
      expect(appliances.playbackControls).toEqual([{ id: TV.id, control: { action: "audio-track", track: 2 } }]);
    });
    await waitFor(() => {
      expect(audio().value).toBe("2");
    });
    // From where it was.
    expect(seekBar().value).toBe("754");
  });

  it("says it doesn't know which audio track plays until the Player says", async () => {
    await playing({ ...ARRIVAL, audioTrack: null });

    expect(audio().value).toBe("");
    expect(audioTracks()[0]).toEqual(["Not known yet", ""]);
    expect(audio().options[0]?.disabled).toBe(true);
  });

  it("lists no audio tracks when the Hub knows none", async () => {
    await playing({ ...ARRIVAL, audioTracks: [], audioTrack: null });

    expect(within(bar()).queryByRole("combobox", { name: "Audio" })).toBeNull();
  });

  it("lists every subtitle track, the Media File's own then its sidecar files, by language where known, after Off (FR-44)", async () => {
    await playing();

    expect(subtitleTracks()).toEqual([
      ["Off", ""],
      ["English · SRT", "0"],
      ["German · Signs · ASS", "1"],
      ["English · SRT file", "2"],
      ["French · ASS file", "3"],
      ["Track 5 · WebVTT file", "4"],
    ]);
    expect(subtitles().value).toBe("");
  });

  it("shows a subtitle track as chosen, through the Hub, then hides them all with Off", async () => {
    const appliances = await playing();

    fireEvent.change(subtitles(), { target: { value: "3" } });
    await waitFor(() => {
      expect(subtitles().value).toBe("3");
    });
    fireEvent.change(subtitles(), { target: { value: "" } });
    await waitFor(() => {
      expect(subtitles().value).toBe("");
    });

    expect(appliances.playbackControls).toEqual([
      { id: TV.id, control: { action: "subtitle-track", track: 3 } },
      { id: TV.id, control: { action: "subtitle-track", track: null } },
    ]);
    // From where it was.
    expect(seekBar().value).toBe("754");
  });

  it("shows the subtitle track the Player shows, which another Remote may have chosen", async () => {
    await playing({ ...ARRIVAL, subtitleTrack: 1 });

    expect(subtitles().value).toBe("1");
  });

  describe("image subtitles, burned in by Full Conversion (FR-45)", () => {
    /** Played by Direct Play, with a SubRip, then PGS and VobSub, which the Hub burns in. */
    const OPERA: NowPlaying = {
      ...ARRIVAL,
      name: "Opera.mkv",
      route: "direct-play",
      subtitleTracks: [
        { language: "eng", title: null, codec: "subrip", sidecar: null, burnedIn: false },
        { language: "ita", title: null, codec: "hdmv_pgs_subtitle", sidecar: null, burnedIn: true },
        { language: "fre", title: null, codec: "dvd_subtitle", sidecar: null, burnedIn: true },
      ],
      subtitleTrack: null,
    };
    const warning = () => screen.queryByRole("dialog", { name: "These subtitles need Full Conversion" });

    it("lists them as needing Full Conversion", async () => {
      await playing(OPERA);

      expect(subtitleTracks()).toEqual([
        ["Off", ""],
        ["English · SRT", "0"],
        ["Italian · PGS · Full Conversion", "1"],
        ["French · VobSub · Full Conversion", "2"],
      ]);
    });

    it("warns that one needs Full Conversion before switching to it, sending nothing until the person agrees", async () => {
      const appliances = await playing(OPERA);

      fireEvent.change(subtitles(), { target: { value: "1" } });

      const dialog = await screen.findByRole("dialog", { name: "These subtitles need Full Conversion" });
      expect(within(dialog).getByText(/^Italian · PGS are image subtitles/).textContent).toBe(
        "Italian · PGS are image subtitles, which the TV can't show itself, so the Hub burns them into the " +
          "picture by Full Conversion, re-encoding the video. That uses a lot of the Hub's CPU, and on a low-power " +
          "NAS may not keep up. Playback starts again from where it is.",
      );
      // Shown as it was until then.
      expect(subtitles().value).toBe("");
      expect(appliances.playbackControls).toEqual([]);

      fireEvent.click(within(dialog).getByRole("button", { name: "Use Full Conversion" }));

      await waitFor(() => {
        expect(subtitles().value).toBe("1");
      });
      expect(warning()).toBeNull();
      expect(appliances.playbackControls).toEqual([{ id: TV.id, control: { action: "subtitle-track", track: 1 } }]);
    });

    it.each(["Cancel", "Close, keeping the subtitles as they are"])(
      "keeps the subtitles as they were with %s, sending nothing",
      async (name) => {
        const appliances = await playing({ ...OPERA, subtitleTrack: 0 });

        fireEvent.change(subtitles(), { target: { value: "2" } });
        fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name }));

        await waitFor(() => {
          expect(warning()).toBeNull();
        });
        expect(subtitles().value).toBe("0");
        expect(appliances.playbackControls).toEqual([]);
      },
    );

    it("doesn't warn of one when the Media File plays by Full Conversion already", async () => {
      const appliances = await playing({ ...OPERA, route: "full-conversion", subtitleTrack: 1 });

      fireEvent.change(subtitles(), { target: { value: "2" } });

      await waitFor(() => {
        expect(subtitles().value).toBe("2");
      });
      expect(warning()).toBeNull();
      expect(appliances.playbackControls).toEqual([{ id: TV.id, control: { action: "subtitle-track", track: 2 } }]);
    });

    it("goes back without a warning for Off or a text track, once one is burned in", async () => {
      const appliances = await playing({ ...OPERA, route: "full-conversion", subtitleTrack: 1 });

      fireEvent.change(subtitles(), { target: { value: "0" } });
      await waitFor(() => {
        expect(subtitles().value).toBe("0");
      });
      fireEvent.change(subtitles(), { target: { value: "" } });
      await waitFor(() => {
        expect(subtitles().value).toBe("");
      });

      expect(warning()).toBeNull();
      expect(appliances.playbackControls).toEqual([
        { id: TV.id, control: { action: "subtitle-track", track: 0 } },
        { id: TV.id, control: { action: "subtitle-track", track: null } },
      ]);
    });
  });

  it("lists no subtitles when the Media File has none", async () => {
    await playing({ ...ARRIVAL, subtitleTracks: [], subtitleTrack: null });

    expect(within(bar()).queryByRole("combobox", { name: "Subtitles" })).toBeNull();
  });

  it("follows the Player's reports as it plays, is paused and plays on", async () => {
    const appliances = await playing();

    appliances.setNowPlaying(TV.id, { ...ARRIVAL, state: "paused", positionMs: 800_000 });

    await waitFor(() => {
      expect(seekBar().value).toBe("800");
    });
    expect(button("Play")).toBeTruthy();
  });

  it("pauses and plays, showing what the Player says once it has", async () => {
    const appliances = await playing(ARRIVAL, 60_000);

    fireEvent.click(button("Pause"));
    await waitFor(() => {
      expect(button("Play")).toBeTruthy();
    });
    fireEvent.click(button("Play"));
    await waitFor(() => {
      expect(button("Pause")).toBeTruthy();
    });

    expect(appliances.playbackControls).toEqual([
      { id: TV.id, control: { action: "pause" } },
      { id: TV.id, control: { action: "play" } },
    ]);
  });

  it("skips back and forward 10 and 30 seconds, in the order tapped", async () => {
    const appliances = await playing({ ...ARRIVAL, positionMs: 60_000 }, 60_000);

    fireEvent.click(button("Back 30 seconds"));
    fireEvent.click(button("Back 10 seconds"));
    fireEvent.click(button("Forward 10 seconds"));
    fireEvent.click(button("Forward 30 seconds"));
    fireEvent.click(button("Forward 30 seconds"));

    await waitFor(() => {
      expect(appliances.playbackControls).toHaveLength(5);
    });
    expect(appliances.playbackControls.map(({ control }) => control)).toEqual([
      { action: "skip", byMs: -30_000 },
      { action: "skip", byMs: -10_000 },
      { action: "skip", byMs: 10_000 },
      { action: "skip", byMs: 30_000 },
      { action: "skip", byMs: 30_000 },
    ]);
    await waitFor(() => {
      expect(seekBar().value).toBe("90");
    });
  });

  it("seeks where the seek bar is let go, showing where it is dragged to meanwhile", async () => {
    const appliances = await playing(ARRIVAL, 60_000);
    const release = appliances.holdNextControl();

    fireEvent.input(seekBar(), { target: { value: "3600" } });
    expect(bar().textContent).toContain("1:00:00");
    expect(appliances.playbackControls).toEqual([]);

    fireEvent.change(seekBar(), { target: { value: "3600" } });
    release();

    await waitFor(() => {
      expect(appliances.playbackControls).toEqual([{ id: TV.id, control: { action: "seek", positionMs: 3_600_000 } }]);
    });
    expect(seekBar().value).toBe("3600");
  });

  it("is gone once stopped", async () => {
    const appliances = await playing(ARRIVAL, 60_000);

    fireEvent.click(button("Stop"));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    });
    expect(appliances.playbackControls).toEqual([{ id: TV.id, control: { action: "stop" } }]);
  });

  it("is gone once the Player stops, as at the end, or from the TV's own remote", async () => {
    const appliances = await playing();

    appliances.setNowPlaying(TV.id, null);

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Now playing" })).toBeNull();
    });
  });

  it("says why when the Hub couldn't send a control", async () => {
    const appliances = await playing(ARRIVAL, 60_000);
    appliances.refuseNextControl("The Player on Living room · TV has disconnected from the Hub.");

    fireEvent.click(button("Pause"));

    await waitFor(() => {
      expect(within(bar()).getByRole("alert").textContent).toBe(
        "The Player on Living room · TV has disconnected from the Hub.",
      );
    });
    fireEvent.click(button("Pause"));
    await waitFor(() => {
      expect(within(bar()).queryByRole("alert")).toBeNull();
    });
  });

  it("can't seek or skip a Media File still loading, whose length isn't known, but can stop it", async () => {
    await playing({ ...ARRIVAL, state: "loading", positionMs: 0, durationMs: null, audioTrack: null });

    expect(bar().textContent).toContain("Loading…");
    expect(seekBar().disabled).toBe(true);
    expect(seekBar().getAttribute("aria-valuetext")).toBe("Length not known yet");
    expect((button("Forward 10 seconds") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Play") as HTMLButtonElement).disabled).toBe(true);
    expect(audio().disabled).toBe(true);
    expect(subtitles().disabled).toBe(true);
    expect((button("Stop") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows two Remotes on the same TV the same, whichever controls it", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowPlaying(TV.id, ARRIVAL);
    /** Each Remote's own page, as on two phones. */
    const remote = (): HTMLElement => {
      const container = document.body.appendChild(document.createElement("div"));
      render(<TvNowPlaying appliances={appliances} tv={TV} refreshMs={20} />, { container });
      return container;
    };
    const first = remote();
    const second = remote();
    const barOf = (page: HTMLElement) => within(page).getByRole("region", { name: "Now playing" });
    await waitFor(() => {
      expect(within(barOf(second)).getByRole("button", { name: "Pause" })).toBeTruthy();
    });

    fireEvent.click(within(barOf(first)).getByRole("button", { name: "Pause" }));
    fireEvent.click(within(barOf(first)).getByRole("button", { name: "Forward 30 seconds" }));

    await waitFor(() => {
      expect(within(barOf(second)).getByRole("button", { name: "Play" })).toBeTruthy();
      expect(within(barOf(second)).getByRole<HTMLInputElement>("slider").value).toBe("784");
    });
  });
});

describe("the now-playing bar's Queue (FR-48)", () => {
  const ALBUM: NowPlaying = {
    ...ARRIVAL,
    name: "02 Tone.mp3",
    route: "direct-play",
    positionMs: 30_000,
    durationMs: 120_000,
    audioTracks: [],
    audioTrack: null,
    subtitleTracks: [],
    music: { title: "02 Tone.mp3", artist: null, album: null, coverArt: null },
    queue: {
      mediaSourceId: 1,
      folder: "Music/Album",
      mediaFiles: ["01 Tone.flac", "02 Tone.mp3", "03 Tone.m4a"],
      current: 1,
      shuffle: false,
      repeat: "off",
    },
  };

  const queueList = () => within(bar()).getByRole("list", { name: /^Queue/ });
  /** The Queue as listed, the current Media File marked as a screen reader reads it. */
  const listed = () =>
    within(queueList())
      .getAllByRole("listitem")
      .map((item) => `${item.textContent}${item.getAttribute("aria-current") === "true" ? " *" : ""}`);
  const repeat = () => within(bar()).getByRole<HTMLSelectElement>("combobox", { name: "Repeat" });
  const shuffle = () => button("Shuffle");

  it("has no Queue controls for a Media File played on its own", async () => {
    await playing();

    expect(within(bar()).queryByRole("group", { name: "Queue" })).toBeNull();
    expect(within(bar()).queryByRole("list", { name: /^Queue/ })).toBeNull();
  });

  it("shows the Queue, in the order it plays, with the current Media File marked, and previous, next, shuffle and repeat", async () => {
    await playing(ALBUM);

    expect(listed()).toEqual(["01 Tone.flac", "02 Tone.mp3 (playing) *", "03 Tone.m4a"]);
    expect(within(bar()).getByRole("heading", { name: "Queue 2 of 3" })).toBeTruthy();
    const controls = within(bar()).getByRole("group", { name: "Queue" });
    expect(
      within(controls)
        .getAllByRole("button")
        .map((each) => each.getAttribute("aria-label") ?? each.textContent),
    ).toEqual(["Previous", "Next", "Shuffle"]);
    expect(shuffle().getAttribute("aria-pressed")).toBe("false");
    expect(repeat().value).toBe("off");
    expect(Array.from(repeat().options).map(({ textContent }) => textContent)).toEqual(["Off", "One", "All"]);
  });

  it("moves to the next and previous Media File through the Hub, showing the one the Player plays then", async () => {
    const appliances = await playing(ALBUM, 60_000);

    fireEvent.click(button("Next"));

    await waitFor(() => {
      expect(listed()).toEqual(["01 Tone.flac", "02 Tone.mp3", "03 Tone.m4a (playing) *"]);
    });
    expect(within(bar()).getByText("03 Tone.m4a", { selector: ".now-playing-name" })).toBeTruthy();
    // There is none after the last, as it doesn't repeat all.
    expect(button("Next")).toHaveProperty("disabled", true);

    fireEvent.click(button("Previous"));
    fireEvent.click(button("Previous"));

    await waitFor(() => {
      expect(listed()[0]).toBe("01 Tone.flac (playing) *");
    });
    expect(button("Previous")).toHaveProperty("disabled", true);
    expect(appliances.queueControls.map(({ control }) => control)).toEqual([
      { action: "next" },
      { action: "previous" },
      { action: "previous" },
    ]);
  });

  it("goes past either end once it repeats all", async () => {
    await playing({
      ...ALBUM,
      queue: { ...(ALBUM.queue as NonNullable<NowPlaying["queue"]>), current: 2, repeat: "all" },
    });

    expect(button("Next")).toHaveProperty("disabled", false);
    expect(repeat().value).toBe("all");
  });

  it("shuffles the rest of the Queue, and puts it back, through the Hub", async () => {
    const appliances = await playing({
      ...ALBUM,
      name: "01 Tone.flac",
      queue: { ...(ALBUM.queue as NonNullable<NowPlaying["queue"]>), current: 0 },
    });

    fireEvent.click(shuffle());

    await waitFor(() => {
      expect(shuffle().getAttribute("aria-pressed")).toBe("true");
    });
    expect(listed()).toEqual(["01 Tone.flac (playing) *", "03 Tone.m4a", "02 Tone.mp3"]);

    fireEvent.click(shuffle());

    await waitFor(() => {
      expect(shuffle().getAttribute("aria-pressed")).toBe("false");
    });
    expect(listed()).toEqual(["01 Tone.flac (playing) *", "02 Tone.mp3", "03 Tone.m4a"]);
    expect(appliances.queueControls.map(({ control }) => control)).toEqual([
      { action: "shuffle", shuffle: true },
      { action: "shuffle", shuffle: false },
    ]);
  });

  it("repeats as chosen, through the Hub", async () => {
    const appliances = await playing(ALBUM);

    fireEvent.change(repeat(), { target: { value: "one" } });

    await waitFor(() => {
      expect(appliances.queueControls).toEqual([{ id: TV.id, control: { action: "repeat", repeat: "one" } }]);
    });
    await waitFor(() => {
      expect(repeat().value).toBe("one");
    });
  });

  it("says why when the Hub couldn't move the Queue on", async () => {
    const appliances = await playing(ALBUM);
    appliances.refuseNextControl("That Media File no longer exists.");

    fireEvent.click(button("Next"));

    expect((await within(bar()).findByRole("alert")).textContent).toBe("That Media File no longer exists.");
    expect(listed()[1]).toBe("02 Tone.mp3 (playing) *");
  });

  it("shows two Remotes on the same TV the same Queue, whichever moves it on", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setNowPlaying(TV.id, ALBUM);
    const remote = (): HTMLElement => {
      const container = document.body.appendChild(document.createElement("div"));
      render(<TvNowPlaying appliances={appliances} tv={TV} refreshMs={20} />, { container });
      return container;
    };
    const first = remote();
    const second = remote();
    const currentIn = (page: HTMLElement) =>
      within(within(page).getByRole("list", { name: /^Queue/ })).getByRole("listitem", { current: true }).textContent;
    await waitFor(() => {
      expect(currentIn(second)).toBe("02 Tone.mp3 (playing)");
    });

    fireEvent.click(within(first).getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(currentIn(second)).toBe("03 Tone.m4a (playing)");
    });
  });
});
