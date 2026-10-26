import { cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDuration, formatSize } from "./media-format.ts";
import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { aMediaFile, fakeMediaSourcesApi, type FakeMediaSource } from "./testing/fake-media-sources-api.ts";
import { WatchAndListen, type PlayOn } from "./watch-and-listen.tsx";

afterEach(cleanup);

const FILMS: FakeMediaSource = {
  name: "Films",
  path: "/media/films",
  folders: {
    "": { folders: ["Sci-Fi", "Comedy"], files: [aMediaFile("Short.mp4", { size: 52_400_000, duration: 95 })] },
    "Sci-Fi": {
      folders: ["Classics"],
      files: [
        aMediaFile("Arrival.mkv", { size: 1_400_000_000, duration: 6_967 }),
        aMediaFile("Odd.avi", { duration: null }),
      ],
    },
    "Sci-Fi/Classics": {},
  },
};

const MUSIC: FakeMediaSource = {
  name: "Music",
  path: "/media/music",
  folders: {
    "": { folders: ["Album"], files: [aMediaFile("01 Song.flac", { size: 31_000_000, duration: 245.4 })] },
    Album: {
      files: [
        aMediaFile("01 Tone.flac", { duration: 3 }),
        aMediaFile("02 Tone.mp3", { duration: 2 }),
        aMediaFile("Video.mp4", { duration: 2 }),
      ],
    },
  },
};

const renderSection = (sources: readonly FakeMediaSource[] = [FILMS, MUSIC], playOn?: PlayOn) => {
  const mediaSources = fakeMediaSourcesApi(sources);
  let openedSettings = 0;
  const shownWith = (on: PlayOn | undefined) => (
    <WatchAndListen
      mediaSources={mediaSources}
      onOpenSettings={() => {
        openedSettings += 1;
      }}
      {...(on === undefined ? {} : { playOn: on })}
    />
  );
  const { rerender } = render(shownWith(playOn));
  return {
    mediaSources,
    openedSettings: () => openedSettings,
    playOnAnother: (on: PlayOn) => {
      rerender(shownWith(on));
    },
  };
};

const section = () => screen.getByRole("region", { name: "Watch & Listen" });

/** What the folder shown lists: each folder's name, then each Media File's name, size and duration. */
const shown = async (): Promise<string[]> => {
  const list = await within(section()).findByRole("list", { name: /^In / });
  return within(list)
    .getAllByRole("listitem")
    .map((item) =>
      item.classList.contains("media-file") || item.querySelector(".media-file") !== null
        ? [".media-file-name", ".media-file-size", ".media-file-duration"]
            .map((part) => item.querySelector(part)?.textContent)
            .join(" | ")
        : `[${item.textContent}]`,
    );
};

const where = (): string[] =>
  within(within(section()).getByRole("navigation", { name: "Folder" }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

const tap = async (name: string): Promise<void> => {
  fireEvent.click(await within(section()).findByRole("button", { name }));
};

/** A Media File's button, which a screen reader names by the file's name, size and length. */
const fileButton = (file: string) =>
  within(section()).findByRole("button", { name: new RegExp(`^${file.replaceAll(".", "\\.")} ?, `) });

const tapFile = async (file: string): Promise<void> => {
  fireEvent.click(await fileButton(file));
};

describe("Watch & Listen", () => {
  it("lists the Media Sources", async () => {
    renderSection();

    const list = await within(section()).findByRole("list", { name: "Media Sources" });

    expect(
      within(list)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Films", "Music"]);
  });

  it("says how to add a Media Source when there are none, and opens Settings", async () => {
    const { openedSettings } = renderSection([]);

    expect(
      await within(section()).findByText(
        "No Media Sources yet. Add the folders of films, shows and music on your PC or NAS in Settings.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(section()).getByRole("button", { name: "Add a Media Source" }));
    expect(openedSettings()).toBe(1);
  });

  it("opens a Media Source at its own folder, with folders first, then Media Files with size and duration", async () => {
    const { mediaSources } = renderSection();

    await tap("Films");

    expect(await shown()).toEqual(["[Sci-Fi]", "[Comedy]", "Short.mp4 | 52 MB | 1:35"]);
    expect(where()).toEqual(["Media Sources", "Films"]);
    expect(mediaSources.browsed()).toEqual(["1:"]);
  });

  it("browses down the folder tree, and back up it", async () => {
    const { mediaSources } = renderSection();
    await tap("Films");

    await tap("Sci-Fi");
    expect(await shown()).toEqual([
      "[Classics]",
      "Arrival.mkv | 1.4 GB | 1:56:07",
      "Odd.avi | 1.4 GB | Length unknown",
    ]);
    expect(where()).toEqual(["Media Sources", "Films", "Sci-Fi"]);

    await tap("Classics");
    expect(await within(section()).findByText("No folders or Media Files here.")).toBeTruthy();
    expect(where()).toEqual(["Media Sources", "Films", "Sci-Fi", "Classics"]);
    expect(
      within(within(section()).getByRole("navigation", { name: "Folder" }))
        .getByText("Classics")
        .getAttribute("aria-current"),
    ).toBe("location");

    await tap("Films");
    expect(await shown()).toEqual(["[Sci-Fi]", "[Comedy]", "Short.mp4 | 52 MB | 1:35"]);

    await tap("Media Sources");
    expect(await within(section()).findByRole("list", { name: "Media Sources" })).toBeTruthy();
    expect(mediaSources.browsed()).toEqual(["1:", "1:Sci-Fi", "1:Sci-Fi/Classics", "1:"]);
  });

  it("shows the Hub's reason when it can't open a folder", async () => {
    const { mediaSources } = renderSection();
    await tap("Films");
    await shown();

    mediaSources.refuseNext("The Hub can't read that folder.");
    await tap("Comedy");

    expect((await within(section()).findByRole("alert")).textContent).toBe("The Hub can't read that folder.");
    expect(where()).toEqual(["Media Sources", "Films", "Comedy"]);
  });
});

describe("playing a Media File on the Selected TV (FR-35)", () => {
  const LIVING_ROOM_TV = aTv(1, "TV", 1);

  const renderPlaying = (appliances: FakeAppliancesApi = fakeAppliancesApi([LIVING_ROOM_TV])) => ({
    appliances,
    ...renderSection([FILMS, MUSIC], { appliances, tv: LIVING_ROOM_TV, title: "Living room · TV" }),
  });

  const progress = () => within(section()).getByRole("region", { name: /^Play / });

  /** Each step in the list, with how it stands, as a screen reader reads it. */
  const stepsShown = (): string[] =>
    within(progress())
      .getAllByRole("listitem")
      .map((item) => item.textContent);

  const now = (): string => within(progress()).getByRole("status").textContent;

  it("lists Media Files as buttons that play each on the Selected TV, named with its size, length and Route", async () => {
    renderPlaying();
    await tap("Films");

    const button = await fileButton("Short.mp4");

    expect(button.textContent).toBe("Short.mp4, 52 MB, 1:35, Direct Play");
    expect(within(section()).getByText("Choose a Media File to play it on Living room · TV.")).toBeTruthy();
  });

  it("asks the Hub to play the Media File chosen on the Selected TV, by its path in the Media Source", async () => {
    const { appliances } = renderPlaying();
    await tap("Films");
    await tap("Sci-Fi");

    await tapFile("Arrival.mkv");

    await within(section()).findByText("Sent to the Player on Living room · TV.");
    expect(appliances.plays).toEqual([
      { id: 1, request: { mediaSourceId: 1, path: "Sci-Fi/Arrival.mkv", resume: false } },
    ]);
  });

  it("plays a Media File in a Media Source's own folder by its name alone", async () => {
    const { appliances } = renderPlaying();
    await tap("Music");

    await tapFile("01 Song.flac");

    await within(section()).findByText("Sent to the Player on Living room · TV.");
    expect(appliances.plays).toEqual([{ id: 1, request: { mediaSourceId: 2, path: "01 Song.flac", resume: false } }]);
  });

  it("shows each step as the Hub takes it, for a TV that was on", async () => {
    const { appliances } = renderPlaying();
    const play = appliances.holdNextPlay();
    await tap("Films");

    await tapFile("Short.mp4");

    expect(within(progress()).getByRole("heading").textContent).toBe("Play Short.mp4 on Living room · TV");
    expect(now()).toBe("Asking the Hub…");
    expect(stepsShown()).toEqual([
      "Launch the Player (to do)",
      "The Player connects to the Hub (to do)",
      "Send the Media File (to do)",
    ]);

    play.step("launching");
    await within(progress()).findByText("Launching the Player…");
    expect(stepsShown()).toEqual([
      "Launch the Player (in progress)",
      "The Player connects to the Hub (to do)",
      "Send the Media File (to do)",
    ]);
    expect(within(progress()).getByText("Launch the Player").getAttribute("aria-current")).toBe("step");

    play.step("connecting");
    await within(progress()).findByText("Waiting for the Player to connect to the Hub…");
    expect(stepsShown()).toEqual([
      "Launch the Player (done)",
      "The Player connects to the Hub (in progress)",
      "Send the Media File (to do)",
    ]);

    play.step("sending");
    await within(progress()).findByText("Sending the Media File…");

    play.sent();
    await within(progress()).findByText("Sent to the Player on Living room · TV.");
    expect(stepsShown()).toEqual([
      "Launch the Player (done)",
      "The Player connects to the Hub (done)",
      "Send the Media File (done)",
    ]);
    expect(within(progress()).queryByRole("alert")).toBeNull();
  });

  it("shows switching the TV on as the first step, for a TV that was off", async () => {
    const { appliances } = renderPlaying();
    const play = appliances.holdNextPlay();
    await tap("Films");
    await tapFile("Short.mp4");

    play.step("waking");

    await within(progress()).findByText("Switching the TV on. It can take up to 30 seconds…");
    expect(stepsShown()).toEqual([
      "Switch the TV on (in progress)",
      "Launch the Player (to do)",
      "The Player connects to the Hub (to do)",
      "Send the Media File (to do)",
    ]);

    play.step("launching");
    await within(progress()).findByText("Launching the Player…");
    expect(stepsShown()[0]).toBe("Switch the TV on (done)");
  });

  it("shows the Hub's reason when a step fails, e.g. the TV not coming on, marking that step", async () => {
    const { appliances } = renderPlaying();
    const play = appliances.holdNextPlay();
    await tap("Films");
    await tapFile("Short.mp4");
    play.step("waking");

    play.fail("Living room · TV didn't come on within 30 seconds. Check that it is plugged in.");

    expect((await within(progress()).findByRole("alert")).textContent).toBe(
      "Living room · TV didn't come on within 30 seconds. Check that it is plugged in.",
    );
    expect(now()).toBe("Couldn't play it on Living room · TV.");
    expect(stepsShown()).toEqual([
      "Switch the TV on (failed)",
      "Launch the Player (to do)",
      "The Player connects to the Hub (to do)",
      "Send the Media File (to do)",
    ]);
  });

  it("shows the Hub's reason when it refuses to start, and lets the person dismiss it", async () => {
    const { appliances } = renderPlaying();
    await tap("Films");
    appliances.refuseNextPlay("That Media File no longer exists.");

    await tapFile("Short.mp4");

    expect((await within(progress()).findByRole("alert")).textContent).toBe("That Media File no longer exists.");
    fireEvent.click(within(progress()).getByRole("button", { name: "Dismiss" }));
    expect(within(section()).queryByRole("region", { name: /^Play / })).toBeNull();
  });

  it("offers no Dismiss while the Hub is still playing it", async () => {
    const { appliances } = renderPlaying();
    appliances.holdNextPlay();
    await tap("Films");

    await tapFile("Short.mp4");

    expect(within(progress()).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows only the last Media File chosen, ignoring how an earlier one goes", async () => {
    const { appliances } = renderPlaying();
    const first = appliances.holdNextPlay();
    await tap("Films");
    await tapFile("Short.mp4");
    first.step("launching");
    await within(progress()).findByText("Launching the Player…");

    const second = appliances.holdNextPlay();
    await tap("Sci-Fi");
    await tapFile("Arrival.mkv");
    first.fail("The Player on Living room · TV disconnected before it was sent the Media File. Try again.");
    second.step("launching");
    second.sent();

    await within(progress()).findByText("Sent to the Player on Living room · TV.");
    expect(within(progress()).getByRole("heading").textContent).toBe("Play Arrival.mkv on Living room · TV");
    expect(within(progress()).queryByRole("alert")).toBeNull();
  });

  it("plays on the TV selected when the Media File is chosen, and names it", async () => {
    const bedroom = aTv(2, "TV", 2);
    const appliances = fakeAppliancesApi([LIVING_ROOM_TV, bedroom]);
    const { playOnAnother } = renderPlaying(appliances);
    playOnAnother({ appliances, tv: bedroom, title: "Bedroom · TV" });
    await tap("Films");
    expect(await within(section()).findByText("Choose a Media File to play it on Bedroom · TV.")).toBeTruthy();

    await tapFile("Short.mp4");

    await within(section()).findByText("Sent to the Player on Bedroom · TV.");
    expect(appliances.plays.map(({ id }) => id)).toEqual([2]);
  });

  it("with no TV, lists Media Files without playing them", async () => {
    renderSection();
    await tap("Films");

    await shown();

    expect(within(section()).queryByRole("button", { name: /^Short\.mp4 ?, / })).toBeNull();
    expect(within(section()).queryByText(/^Choose a Media File/)).toBeNull();
  });
});

describe("playing a folder as a Queue on the Selected TV (FR-46)", () => {
  const LIVING_ROOM_TV = aTv(1, "TV", 1);

  const renderPlaying = (appliances: FakeAppliancesApi = fakeAppliancesApi([LIVING_ROOM_TV])) => ({
    appliances,
    ...renderSection([FILMS, MUSIC], { appliances, tv: LIVING_ROOM_TV, title: "Living room · TV" }),
  });

  it('offers "Play folder" in a folder with audio Media Files, which plays it by its path, showing each step', async () => {
    const { appliances } = renderPlaying();
    await tap("Music");
    await tap("Album");

    await tap("Play folder");

    const progress = within(section()).getByRole("region", { name: "Play Album on Living room · TV" });
    await within(progress).findByText("Sent to the Player on Living room · TV.");
    expect(appliances.plays).toEqual([{ id: 1, request: { mediaSourceId: 2, folder: "Album" } }]);
  });

  it("plays a Media Source's own folder by its empty path, named as the Media Source", async () => {
    const { appliances } = renderPlaying();
    await tap("Music");

    await tap("Play folder");

    await within(section()).findByRole("region", { name: "Play Music on Living room · TV" });
    expect(appliances.plays).toEqual([{ id: 1, request: { mediaSourceId: 2, folder: "" } }]);
  });

  it("shows the Hub's reason when it refuses the folder", async () => {
    const { appliances } = renderPlaying();
    appliances.refuseNextPlay('There are no audio Media Files in "Album" to play.');
    await tap("Music");
    await tap("Album");

    await tap("Play folder");

    expect((await within(section()).findByRole("alert")).textContent).toBe(
      'There are no audio Media Files in "Album" to play.',
    );
  });

  it("offers nothing to play in a folder with only videos, or with no TV", async () => {
    renderPlaying();
    await tap("Films");
    await fileButton("Short.mp4");
    expect(within(section()).queryByRole("button", { name: "Play folder" })).toBeNull();

    cleanup();
    renderSection([MUSIC]);
    await tap("Music");
    await shown();
    expect(within(section()).queryByRole("button", { name: "Play folder" })).toBeNull();
  });
});

describe("resuming a Media File, or starting it over (FR-40)", () => {
  const LIVING_ROOM_TV = aTv(1, "TV", 1);
  const WITH_RESUME: FakeMediaSource = { ...FILMS, resumePositions: { "Sci-Fi/Arrival.mkv": 4_350_000 } };

  const renderPlaying = (sources: readonly FakeMediaSource[] = [WITH_RESUME, MUSIC]) => {
    const appliances = fakeAppliancesApi([LIVING_ROOM_TV]);
    return { appliances, ...renderSection(sources, { appliances, tv: LIVING_ROOM_TV, title: "Living room · TV" }) };
  };

  const offer = () => screen.findByRole("dialog", { name: "Play Arrival.mkv" });
  const chooseArrival = async (): Promise<void> => {
    await tap("Films");
    await tap("Sci-Fi");
    await tapFile("Arrival.mkv");
  };

  it("offers to resume a Media File from its Resume Position, or to start it over", async () => {
    const { appliances } = renderPlaying();

    await chooseArrival();

    const dialog = await offer();
    expect(within(dialog).getByText(/^Playback last reached 1:12:30\./).textContent).toBe(
      "Playback last reached 1:12:30. Resume it from there on Living room · TV, or start over.",
    );
    expect(within(dialog).getByRole("button", { name: "Resume from 1:12:30" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Start over" })).toBeTruthy();
    expect(within(section()).queryByRole("region", { name: /^Play .+ on / })).toBeNull();
    expect(appliances.plays).toEqual([]);
  });

  it("resumes it from its Resume Position", async () => {
    const { appliances } = renderPlaying();
    await chooseArrival();

    fireEvent.click(within(await offer()).getByRole("button", { name: "Resume from 1:12:30" }));

    await within(section()).findByText("Sent to the Player on Living room · TV.");
    expect(appliances.plays).toEqual([
      { id: 1, request: { mediaSourceId: 1, path: "Sci-Fi/Arrival.mkv", resume: true } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts it over from the start", async () => {
    const { appliances } = renderPlaying();
    await chooseArrival();

    fireEvent.click(within(await offer()).getByRole("button", { name: "Start over" }));

    await within(section()).findByText("Sent to the Player on Living room · TV.");
    expect(appliances.plays).toEqual([
      { id: 1, request: { mediaSourceId: 1, path: "Sci-Fi/Arrival.mkv", resume: false } },
    ]);
  });

  it("plays nothing when the offer is closed", async () => {
    const { appliances } = renderPlaying();
    await chooseArrival();

    fireEvent.click(within(await offer()).getByRole("button", { name: "Close, playing nothing" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(section()).queryByRole("region", { name: /^Play .+ on / })).toBeNull();
    expect(appliances.plays).toEqual([]);
  });

  it("plays a Media File with no Resume Position straight away, from the start", async () => {
    const { appliances } = renderPlaying();
    await tap("Films");

    await tapFile("Short.mp4");

    await within(section()).findByText("Sent to the Player on Living room · TV.");
    expect(appliances.plays).toEqual([{ id: 1, request: { mediaSourceId: 1, path: "Short.mp4", resume: false } }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks the Hub each time a Media File is chosen, as playing it may have changed its Resume Position since", async () => {
    const { appliances, mediaSources } = renderPlaying([FILMS, MUSIC]);
    await tap("Films");
    await tap("Sci-Fi");
    await tapFile("Arrival.mkv");
    await within(section()).findByText("Sent to the Player on Living room · TV.");

    mediaSources.setResumePosition(1, "Sci-Fi/Arrival.mkv", 30_000);
    await tapFile("Arrival.mkv");
    fireEvent.click(within(await offer()).getByRole("button", { name: "Resume from 0:30" }));
    await vi.waitFor(() => {
      expect(appliances.plays).toHaveLength(2);
    });

    mediaSources.setResumePosition(1, "Sci-Fi/Arrival.mkv", null);
    await tapFile("Arrival.mkv");
    await vi.waitFor(() => {
      expect(appliances.plays).toHaveLength(3);
    });
    expect(appliances.plays.map(({ request }) => ("resume" in request ? request.resume : undefined))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("shows the Hub's reason when it can't say whether the Media File has a Resume Position", async () => {
    const { appliances, mediaSources } = renderPlaying();
    await tap("Films");
    await tap("Sci-Fi");

    mediaSources.refuseNext("Can't reach the Hub.");
    await tapFile("Arrival.mkv");

    const progress = within(section()).getByRole("region", { name: "Play Arrival.mkv on Living room · TV" });
    expect((await within(progress).findByRole("alert")).textContent).toBe("Can't reach the Hub.");
    expect(appliances.plays).toEqual([]);
  });
});

describe("a Media File's size and duration", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [999, "999 bytes"],
    [1_000, "1 KB"],
    [12_345, "12 KB"],
    [999_499, "999 KB"],
    [999_600, "1 MB"],
    [850_000_000, "850 MB"],
    [1_449_000_000, "1.4 GB"],
    [4_000_000_000_000, "4 TB"],
  ])("writes %d bytes as %s", (bytes, written) => {
    expect(formatSize(bytes)).toBe(written);
  });

  it.each([
    [0, "0:00"],
    [2.04, "0:02"],
    [59.6, "1:00"],
    [245.4, "4:05"],
    [3_599, "59:59"],
    [3_600, "1:00:00"],
    [4_350, "1:12:30"],
    [36_000, "10:00:00"],
  ])("writes %d seconds as %s", (seconds, written) => {
    expect(formatDuration(seconds)).toBe(written);
  });
});

describe("Watch & Listen's Routes (FR-34)", () => {
  const LIVING_ROOM_TV = aTv(1, "TV", 1);
  const BEDROOM_TV = aTv(2, "TV", 2);

  const FORMATS: FakeMediaSource = {
    name: "Films",
    path: "/media/films",
    folders: {
      "": {
        files: [
          aMediaFile("Arrival.mp4", { route: "direct-play" }),
          aMediaFile("Concert.mkv", { route: "audio-conversion" }),
          aMediaFile("Home Video.avi", { route: "full-conversion" }),
          aMediaFile("Damaged.mp4", { duration: null, route: null }),
          aMediaFile("Recording.mkv", { route: "remux" }),
        ],
      },
    },
  };

  /** Each Media File's name and the Route it shows, as a person reads them. */
  const routesShown = async (): Promise<string[][]> => {
    const list = await within(section()).findByRole("list", { name: /^In / });
    return within(list)
      .getAllByRole("listitem")
      .map((item) =>
        [".media-file-name", ".media-file-route", ".media-file-cpu"].flatMap((part) => {
          const text = item.querySelector(part)?.textContent;
          return text === undefined ? [] : [text];
        }),
      );
  };

  it("says how each Media File reaches the Selected TV, and flags Full Conversion as heavy on the Hub's CPU", async () => {
    const appliances = fakeAppliancesApi([LIVING_ROOM_TV]);
    const { mediaSources } = renderSection([FORMATS], { appliances, tv: LIVING_ROOM_TV, title: "Living room · TV" });

    await tap("Films");

    expect(await routesShown()).toEqual([
      ["Arrival.mp4", "Direct Play"],
      ["Concert.mkv", "Audio Conversion"],
      ["Home Video.avi", "Full Conversion", "Uses a lot of the Hub's CPU"],
      // ffprobe couldn't read it, so the Hub can't tell.
      ["Damaged.mp4"],
      ["Recording.mkv", "Remux"],
    ]);
    expect(mediaSources.browsedFor()).toEqual([LIVING_ROOM_TV.id]);
    expect((await fileButton("Home Video.avi")).textContent).toBe(
      "Home Video.avi, 1.4 GB, 1:12:30, Full Conversion, Uses a lot of the Hub's CPU",
    );
    expect((await fileButton("Recording.mkv")).textContent).toBe("Recording.mkv, 1.4 GB, 1:12:30, Remux");
  });

  it("says no Route with no TV to play on", async () => {
    const { mediaSources } = renderSection([FORMATS]);

    await tap("Films");

    expect((await routesShown()).every((shownFile) => shownFile.length === 1)).toBe(true);
    expect(mediaSources.browsedFor()).toEqual([undefined]);
  });

  it("reads the folder again for another Selected TV, which may play other things directly", async () => {
    const appliances = fakeAppliancesApi([LIVING_ROOM_TV, BEDROOM_TV]);
    const { mediaSources, playOnAnother } = renderSection([FORMATS], {
      appliances,
      tv: LIVING_ROOM_TV,
      title: "Living room · TV",
    });
    await tap("Films");
    await routesShown();

    playOnAnother({ appliances, tv: BEDROOM_TV, title: "Bedroom · TV" });

    await within(section()).findByText("Choose a Media File to play it on Bedroom · TV.");
    await expect.poll(() => mediaSources.browsedFor()).toEqual([LIVING_ROOM_TV.id, BEDROOM_TV.id]);
    expect(mediaSources.browsed()).toEqual(["1:", "1:"]);
  });
});
