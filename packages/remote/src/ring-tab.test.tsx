import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { RingHome } from "@media-centre/shared";

import { RingTab, type CreatePeerConnection } from "./ring-tab.tsx";
import { aRingDevice, aRingState, fakeRingApi, RING_SIGNED_OUT, type FakeRingApi } from "./testing/fake-ring-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";

afterEach(cleanup);

const FRONT_DOOR = aRingDevice({ id: "1", name: "Front Door" });
const GARDEN = aRingDevice({
  id: "2",
  name: "Garden",
  kind: "camera",
  model: "Floodlight Cam",
  battery: null,
  capabilities: { light: true, siren: true, video: true },
});
const CHIME = aRingDevice({
  id: "3",
  name: "Hallway Chime",
  kind: "chime",
  model: "Chime Pro",
  battery: null,
  capabilities: { light: false, siren: false, video: false },
});

const SIGNED_IN: RingHome = { status: { state: "signed-in", problem: null }, devices: [FRONT_DOOR, GARDEN, CHIME] };

/** The browser's end of a live view, as a test sees it: it gathers at once, and answers whatever it is given. */
const fakePeer = () => {
  const made: { closed: boolean; remote?: string | undefined }[] = [];
  const create: CreatePeerConnection = () => {
    const peer = {
      closed: false,
      remote: undefined as string | undefined,
      iceGatheringState: "complete",
      localDescription: { sdp: "v=0 offer" },
      ontrack: null,
      addTransceiver: () => undefined,
      addEventListener: () => undefined,
      createOffer: () => Promise.resolve({ type: "offer", sdp: "v=0 offer" }),
      setLocalDescription: () => Promise.resolve(),
      setRemoteDescription: (description: { sdp: string }) => {
        peer.remote = description.sdp;
        return Promise.resolve();
      },
      close: () => {
        peer.closed = true;
      },
    };
    made.push(peer);
    return peer as unknown as RTCPeerConnection;
  };
  return { create, made };
};

const renderTab = (ring: FakeRingApi, create: CreatePeerConnection = fakePeer().create) =>
  render(
    <RingTab
      ring={ring}
      rooms={fakeRoomsApi(["Hall"])}
      storage={memoryStorage()}
      refreshMs={60_000}
      createPeerConnection={create}
    />,
  );

const card = (name: string): HTMLElement => screen.getByRole("article", { name });

describe("the Ring tab, signed out", () => {
  it("signs in with the email and password, then the code Ring sent, and shows the devices", async () => {
    const ring = fakeRingApi(RING_SIGNED_OUT, [], [FRONT_DOOR]);
    renderTab(ring);

    const signIn = await screen.findByRole("region", { name: "Sign in to Ring" });
    expect(within(signIn).getByText(/never keeps it/)).toBeTruthy();
    const submit = within(signIn).getByRole("button", { name: "Sign in to Ring" });
    expect(submit).toHaveProperty("disabled", true);
    fireEvent.input(within(signIn).getByLabelText("Email address"), { target: { value: "owner@example.com" } });
    fireEvent.input(within(signIn).getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(submit);

    const code = await screen.findByRole("region", { name: "Enter Ring's code" });
    expect(within(code).getByText(/sent to \+44•••••123 via sms/)).toBeTruthy();
    fireEvent.input(within(code).getByLabelText("Code"), { target: { value: "000000" } });
    fireEvent.click(within(code).getByRole("button", { name: "Sign in" }));
    expect(await within(code).findByRole("alert")).toHaveProperty("textContent", "Ring didn't accept that code.");

    fireEvent.input(within(code).getByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(within(code).getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("article", { name: "Front Door" })).toBeTruthy();
    expect(ring.asked()).toEqual([
      ["sign-in", "owner@example.com", "hunter2"],
      ["code", "000000"],
      ["code", "123456"],
    ]);
  });

  it("cancels a sign-in waiting for the code", async () => {
    const ring = fakeRingApi({
      devices: [],
      status: { state: "code-needed", email: "owner@example.com", prompt: "sent by email", problem: null },
    });
    renderTab(ring);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("region", { name: "Sign in to Ring" })).toBeTruthy();
  });
});

describe("the Ring tab, signed in", () => {
  it("shows each device as a widget, with its model, battery and whether it is online", async () => {
    renderTab(fakeRingApi(SIGNED_IN, [aRingState("1", { battery: 15, charging: true })]));

    const door = await screen.findByRole("article", { name: "Front Door" });
    expect(within(door).getByText("Video Doorbell 4")).toBeTruthy();
    expect(await within(door).findByText("Battery 15%, charging")).toBeTruthy();
    expect(within(door).getByRole("img", { name: "The latest snapshot from Front Door" })).toBeTruthy();
    expect(within(card("Hallway Chime")).queryByRole("img")).toBeNull();
  });

  it("says the doorbell was just pressed", async () => {
    renderTab(fakeRingApi(SIGNED_IN, [aRingState("1", { lastDing: new Date().toISOString() })]));
    const door = await screen.findByRole("article", { name: "Front Door" });
    expect((await within(door).findByRole("alert")).textContent).toMatch(/Someone rang the doorbell at/);
  });

  it("switches a camera's light, siren and motion detection", async () => {
    const ring = fakeRingApi(SIGNED_IN, [aRingState("2", { light: false, siren: false, motionDetection: true })]);
    renderTab(ring);
    const garden = await screen.findByRole("article", { name: "Garden" });

    const light = await within(garden).findByRole("button", { name: "Light" });
    await waitFor(() => {
      expect(light.getAttribute("aria-pressed")).toBe("false");
    });
    fireEvent.click(light);
    await waitFor(() => {
      expect(within(garden).getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(within(garden).getByRole("button", { name: "Siren" }));
    await waitFor(() => {
      expect(within(garden).getByRole("button", { name: "Siren" }).getAttribute("aria-pressed")).toBe("true");
    });
    fireEvent.click(within(garden).getByRole("button", { name: "Motion detection" }));
    await waitFor(() => {
      expect(ring.asked()).toContainEqual(["2", { kind: "motion-detection", on: false }]);
    });
    expect(within(card("Front Door")).queryByRole("button", { name: "Light" })).toBeNull();
  });

  it("sets a chime's volume, and plays its sounds", async () => {
    const ring = fakeRingApi(SIGNED_IN, [aRingState("3", { volume: 8, battery: null })]);
    renderTab(ring);
    const chime = await screen.findByRole("article", { name: "Hallway Chime" });
    const volume = await within(chime).findByRole("slider", { name: "Volume" });
    await waitFor(() => {
      expect(volume).toHaveProperty("disabled", false);
    });
    fireEvent.change(volume, { target: { value: "4" } });
    await waitFor(() => {
      expect(within(chime).getByRole("button", { name: "Play the doorbell sound" })).toHaveProperty("disabled", false);
    });
    fireEvent.click(within(chime).getByRole("button", { name: "Play the doorbell sound" }));
    await waitFor(() => {
      expect(ring.asked()).toEqual([
        ["3", { kind: "chime-volume", level: 4 }],
        ["3", { kind: "chime-test", sound: "ding" }],
      ]);
    });
  });

  it("lists a camera's events, and plays a recorded one", async () => {
    const ring = fakeRingApi(SIGNED_IN, [
      aRingState("1", {
        events: [
          { id: "e2", kind: "ding", at: "2026-10-25T10:00:00Z", recorded: true },
          { id: "e1", kind: "live-view", at: "2026-10-25T09:00:00Z", recorded: false },
        ],
      }),
    ]);
    renderTab(ring);
    const door = await screen.findByRole("article", { name: "Front Door" });
    expect(await within(door).findByText("Doorbell pressed")).toBeTruthy();
    expect(within(door).getAllByRole("button", { name: /^Watch (?!live)/ })).toHaveLength(1);

    fireEvent.click(within(door).getByRole("button", { name: /^Watch doorbell pressed/ }));
    await waitFor(() => {
      expect(door.querySelector("video")?.getAttribute("src")).toBe("http://localhost/ring-recordings/e2.mp4");
    });
    fireEvent.click(within(door).getByRole("button", { name: "Back to the snapshot" }));
    expect(within(door).getByRole("img", { name: "The latest snapshot from Front Door" })).toBeTruthy();
  });

  it("starts live view, handing Ring the browser's offer and the browser Ring's answer, and ends it", async () => {
    const ring = fakeRingApi(SIGNED_IN);
    const peers = fakePeer();
    renderTab(ring, peers.create);
    const door = await screen.findByRole("article", { name: "Front Door" });

    fireEvent.click(within(door).getByRole("button", { name: "Watch live" }));
    expect(await within(door).findByRole("button", { name: "Stop live view" })).toBeTruthy();
    await waitFor(() => {
      expect(peers.made[0]?.remote).toBe("v=0 answer");
    });
    expect(ring.asked()).toContainEqual(["1", { live: "v=0 offer" }]);

    fireEvent.click(within(door).getByRole("button", { name: "Stop live view" }));
    await waitFor(() => {
      expect(ring.asked()).toContainEqual(["1", { end: "session-1" }]);
    });
    expect(peers.made[0]?.closed).toBe(true);
  });

  it("says why Ring refused live view, and signs out", async () => {
    const ring = fakeRingApi(SIGNED_IN);
    const peers = fakePeer();
    renderTab(ring, peers.create);
    const door = await screen.findByRole("article", { name: "Front Door" });
    // Once its state is read, so the refusal is live view's.
    await within(door).findByText(/Wi-Fi good/);

    ring.failNext("Live view is currently disabled for Front Door.");
    fireEvent.click(within(door).getByRole("button", { name: "Watch live" }));
    expect((await within(door).findByRole("alert")).textContent).toBe(
      "Live view is currently disabled for Front Door.",
    );
    expect(peers.made[0]?.closed).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("region", { name: "Sign in to Ring" })).toBeTruthy();
  });
});
