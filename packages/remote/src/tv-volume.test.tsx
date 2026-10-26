import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvVolume } from "./tv-volume.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

const renderVolume = (appliances: FakeAppliancesApi, refreshMs?: number) =>
  render(<TvVolume appliances={appliances} tv={TV} {...(refreshMs === undefined ? {} : { refreshMs })} />);

const region = () => screen.getByRole("region", { name: "Volume" });
const slider = () => within(region()).getByRole<HTMLInputElement>("slider", { name: "Volume" });
const level = () => within(region()).getByRole("status", { name: "Volume level" }).textContent;
const mute = () => within(region()).getByRole("button", { name: "Mute" });
const button = (name: string) => within(region()).getByRole("button", { name });

const drag = (volume: number): void => {
  fireEvent.input(slider(), { target: { value: String(volume) } });
};

/** Waits until the slider shows `volume`, as it does once the TV's volume has been read. */
const showing = async (volume: number): Promise<void> => {
  await waitFor(() => {
    expect(level()).toBe(String(volume));
  });
  expect(slider().value).toBe(String(volume));
};

describe("the volume slider and mute (FR-19)", () => {
  it("shows the TV's own volume and mute, read from it through the Hub", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setVolume(TV.id, { known: true, volume: 23, muted: true });
    renderVolume(appliances);

    await showing(23);

    expect(slider().disabled).toBe(false);
    expect(slider().min).toBe("0");
    expect(slider().max).toBe("100");
    expect(mute().getAttribute("aria-pressed")).toBe("true");
    expect(appliances.volumeReads).toEqual([TV.id]);
  });

  it("has no value, and can't be moved, until the TV's volume has been read", () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances);

    expect(slider().disabled).toBe(true);
    expect(slider().getAttribute("aria-valuetext")).toBe("Not known");
    expect(level()).toBe("–");
    expect(mute().hasAttribute("disabled")).toBe(true);
  });

  it("sets the TV's volume to where the slider is dragged, 18", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances);
    await showing(11);

    drag(18);

    await waitFor(() => {
      expect(appliances.volumeChanges).toEqual([{ id: TV.id, change: { volume: 18 } }]);
    });
    await showing(18);
    expect(within(region()).queryByRole("alert")).toBeNull();
  });

  it("follows the TV's volume and mute as its own remote changes them, without being reopened", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances, 20);
    await showing(11);
    expect(mute().getAttribute("aria-pressed")).toBe("false");

    appliances.setVolume(TV.id, { known: true, volume: 30, muted: true });

    await showing(30);
    await waitFor(() => {
      expect(mute().getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("sends only the latest of the volumes dragged through while the Hub sets one, and shows where it was dragged to", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances, 20);
    await showing(11);
    const release = appliances.holdNextVolumeChange();

    for (const volume of [12, 13, 14, 15]) drag(volume);
    // Readings come and go, saying the TV is still at 11, but the slider stays where it was dragged.
    const reads = appliances.volumeReads.length;
    await waitFor(() => {
      expect(appliances.volumeReads.length).toBeGreaterThan(reads + 1);
    });
    expect(level()).toBe("15");
    expect(slider().value).toBe("15");

    release();
    await waitFor(() => {
      expect(appliances.volumeChanges.map(({ change }) => change)).toEqual([{ volume: 12 }, { volume: 15 }]);
    });
    await showing(15);
  });

  it("mutes the TV and unmutes it", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances);
    await showing(11);

    fireEvent.click(mute());
    await waitFor(() => {
      expect(mute().getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(mute());
    await waitFor(() => {
      expect(mute().getAttribute("aria-pressed")).toBe("false");
    });

    expect(appliances.volumeChanges).toEqual([
      { id: TV.id, change: { muted: true } },
      { id: TV.id, change: { muted: false } },
    ]);
    expect(level()).toBe("11");
  });

  it("can't be muted again while the Hub is muting it", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances);
    await showing(11);
    const release = appliances.holdNextVolumeChange();

    fireEvent.click(mute());
    await waitFor(() => {
      expect(mute().hasAttribute("disabled")).toBe(true);
    });
    fireEvent.click(mute());
    release();

    await waitFor(() => {
      expect(mute().hasAttribute("disabled")).toBe(false);
    });
    expect(appliances.volumeChanges).toEqual([{ id: TV.id, change: { muted: true } }]);
  });

  it("is disabled, showing no volume, while the TV can't say it, and volume up and down still press keys", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setVolume(TV.id, { known: false });
    renderVolume(appliances);
    await waitFor(() => {
      expect(appliances.volumeReads).toHaveLength(1);
    });
    await waitFor(() => {
      expect(within(region()).getByText(/can't say its volume now/)).toBeTruthy();
    });

    expect(slider().disabled).toBe(true);
    expect(slider().getAttribute("aria-valuetext")).toBe("Not known");
    expect(slider().classList.contains("volume-unknown")).toBe(true);
    expect(level()).toBe("–");
    expect(mute().hasAttribute("disabled")).toBe(true);
    expect(mute().hasAttribute("aria-pressed")).toBe(false);

    fireEvent.click(button("Volume up"));
    fireEvent.click(button("Volume down"));

    await waitFor(() => {
      expect(appliances.keysPressed).toEqual([
        { id: TV.id, key: "volume-up" },
        { id: TV.id, key: "volume-down" },
      ]);
    });
    expect(level()).toBe("–");
  });

  it("comes back once the TV can say its volume again", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.setVolume(TV.id, { known: false });
    renderVolume(appliances, 20);
    await waitFor(() => {
      expect(appliances.volumeReads.length).toBeGreaterThan(0);
    });

    appliances.setVolume(TV.id, { known: true, volume: 9, muted: false });

    await showing(9);
    expect(slider().disabled).toBe(false);
    expect(slider().hasAttribute("aria-valuetext")).toBe(false);
    expect(within(region()).queryByText(/can't say its volume now/)).toBeNull();
  });

  it("turns the volume up and down with keys, and the slider follows at once", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances);
    await showing(11);

    fireEvent.click(button("Volume up"));
    fireEvent.click(button("Volume up"));
    await showing(13);
    fireEvent.click(button("Volume down"));
    await showing(12);

    expect(appliances.keysPressed.map(({ key }) => key)).toEqual(["volume-up", "volume-up", "volume-down"]);
    expect(appliances.volumeChanges).toEqual([]);
  });

  it("shows the Hub's reason when it couldn't set the volume, and the TV's volume as it then says", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderVolume(appliances);
    await showing(11);
    // The TV went into standby since the slider last read it.
    appliances.setVolume(TV.id, { known: false });

    drag(40);

    expect((await within(region()).findByRole("alert")).textContent).toBe(
      "The TV at 192.168.1.22 isn't answering for its volume, as when it is in standby. Volume up and down still work.",
    );
    await waitFor(() => {
      expect(slider().disabled).toBe(true);
    });
    expect(level()).toBe("–");
  });

  it("shows the Hub's reason when it couldn't press volume up", async () => {
    const appliances = fakeAppliancesApi([TV]);
    appliances.refuseNextKey("Living room · TV no longer lets the Hub in. Pair it again in Settings.");
    renderVolume(appliances);

    fireEvent.click(button("Volume up"));

    expect((await within(region()).findByRole("alert")).textContent).toBe(
      "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
    );
  });
});
