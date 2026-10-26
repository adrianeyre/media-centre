import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import type { AmazonHome } from "@media-centre/shared";

import { AmazonTab } from "./amazon-tab.tsx";
import {
  anEcho,
  anEchoState,
  FAKE_HUB_ADDRESS,
  fakeAmazonApi,
  SIGNED_OUT,
  type FakeAmazonApi,
} from "./testing/fake-amazon-api.ts";
import { fakeRoomsApi } from "./testing/fake-rooms-api.ts";
import { memoryStorage } from "./testing/memory-storage.ts";

afterEach(cleanup);

const KITCHEN = anEcho({ serial: "G1", name: "Kitchen Echo Dot" });
const LOUNGE = anEcho({
  serial: "G2",
  name: "Lounge Echo Show",
  family: "Echo Show",
  online: false,
  capabilities: { music: true, volume: true, alarms: false, equaliser: false, bluetooth: false },
});

const SIGNED_IN: AmazonHome = {
  status: { state: "signed-in", domain: "amazon.co.uk", problem: null },
  devices: [KITCHEN, LOUNGE],
  routines: [
    { id: "r1", name: "Good night" },
    { id: "r2", name: "Movie time" },
  ],
  musicProviders: [
    { id: "AMAZON_MUSIC", name: "Amazon Music" },
    { id: "TUNEIN", name: "TuneIn" },
  ],
};

const renderTab = (amazon: FakeAmazonApi, rooms = fakeRoomsApi(["Kitchen"])) =>
  render(<AmazonTab amazon={amazon} rooms={rooms} storage={memoryStorage()} refreshMs={60_000} signInPollMs={20} />);

const echo = (name: string): HTMLElement => screen.getByRole("article", { name });

/** Waits until the Echo's widget has finished what it was last asked, as its controls are enabled again. */
const idle = (name: string): Promise<void> =>
  waitFor(() => {
    expect(within(echo(name)).getByRole("button", { name: "Joke" })).toHaveProperty("disabled", false);
    for (const picker of within(echo(name)).getAllByRole("combobox")) expect(picker).toHaveProperty("disabled", false);
  });

describe("the Amazon tab, signed out", () => {
  it("says nothing of signing in on the Hub's PC when the sign-in page is already at localhost", async () => {
    renderTab(
      fakeAmazonApi({
        ...SIGNED_OUT,
        status: { state: "signing-in", domain: "amazon.co.uk", signInUrl: "http://localhost:41081/" },
      }),
    );
    const page = await screen.findByRole("link", { name: "Open Amazon's sign-in page (opens in a new tab)" });
    expect(page.getAttribute("href")).toBe("http://localhost:41081/");
    expect(screen.queryByText(/encrypts your password/)).toBeNull();
  });

  it("signs in on the Amazon site chosen, through Amazon's sign-in page, and shows the Echos once signed in", async () => {
    const amazon = fakeAmazonApi(SIGNED_OUT);
    renderTab(amazon);

    const signIn = await screen.findByRole("region", { name: "Sign in to Amazon" });
    expect(within(signIn).getByText(/Amazon's terms don't allow it/)).toBeTruthy();
    fireEvent.change(within(signIn).getByRole("combobox", { name: "Amazon site" }), {
      target: { value: "amazon.com" },
    });
    fireEvent.click(within(signIn).getByRole("button", { name: "Sign in to Amazon" }));

    const page = await screen.findByRole("link", { name: "Open Amazon's sign-in page (opens in a new tab)" });
    expect(page.getAttribute("href")).toBe(`http://${FAKE_HUB_ADDRESS}:41081/`);
    expect(page.getAttribute("target")).toBe("_blank");
    expect(amazon.asked()).toEqual([["sign-in", "amazon.com"]]);
    // At the Hub's address, Amazon's page can't encrypt the password, so the tab says where it can.
    expect(screen.getByText(/encrypts your password/).textContent).toContain("http://localhost:");

    amazon.setHome(SIGNED_IN);
    expect(await screen.findByRole("article", { name: "Kitchen Echo Dot" })).toBeTruthy();
    expect(echo("Kitchen Echo Dot").closest(".widget")).not.toBeNull();
    expect(screen.getByText("amazon.co.uk")).toBeTruthy();
  });

  it("says why signing in failed", async () => {
    renderTab(
      fakeAmazonApi({
        ...SIGNED_OUT,
        status: { state: "signed-out", problem: "Signing in to Amazon failed: no csrf found" },
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Signing in to Amazon failed: no csrf found");
  });
});

describe("the Amazon tab, signed in", () => {
  it("shows each Echo with what it is, whether it is online, what it plays and its controls", async () => {
    renderTab(
      fakeAmazonApi(SIGNED_IN, [
        anEchoState("G1", {
          notifications: [
            { id: "a1", type: "alarm", label: null, on: true, at: "2026-10-25T07:00:00.000Z", remaining: null },
            { id: "t1", type: "timer", label: "Pasta", on: true, at: null, remaining: 125 },
          ],
          bluetooth: [{ address: "AA:BB", name: "Phone", connected: false }],
        }),
      ]),
    );

    const kitchen = await screen.findByRole("article", { name: "Kitchen Echo Dot" });
    expect(within(kitchen).getByText("Echo")).toBeTruthy();
    expect(within(kitchen).getByText("Online")).toBeTruthy();
    expect(await within(kitchen).findByText("Bohemian Rhapsody")).toBeTruthy();
    expect(within(kitchen).getByText("Queen")).toBeTruthy();
    expect(within(kitchen).getByText("1:01 / 5:54")).toBeTruthy();
    expect(within(kitchen).getByRole("slider", { name: "Volume" })).toHaveProperty("value", "40");
    expect(within(kitchen).getByRole("button", { name: "Do Not Disturb" }).getAttribute("aria-pressed")).toBe("false");
    for (const each of ["Weather", "News", "Joke", "Stop"])
      expect(within(kitchen).getByRole("button", { name: each })).toBeTruthy();
    expect(within(kitchen).getByText("Timer: Pasta")).toBeTruthy();
    expect(within(kitchen).getByText("2:05 left")).toBeTruthy();
    expect(within(kitchen).getByRole("button", { name: "Connect Phone" })).toBeTruthy();
    expect(within(kitchen).getByRole("slider", { name: "Bass" })).toBeTruthy();

    // One with fewer capabilities shows fewer controls; one offline says so.
    const lounge = echo("Lounge Echo Show");
    expect(within(lounge).getByText("Offline")).toBeTruthy();
    expect(within(lounge).queryByText(/Alarms, timers and reminders/)).toBeNull();
  });

  it("plays, pauses, sets the volume and Do Not Disturb, and deletes an alarm, as Amazon then reports", async () => {
    const amazon = fakeAmazonApi(SIGNED_IN, [
      anEchoState("G1", {
        notifications: [
          { id: "a1", type: "alarm", label: "Work", on: true, at: "2026-10-25T07:00:00.000Z", remaining: null },
        ],
      }),
    ]);
    renderTab(amazon);
    const kitchen = await screen.findByRole("article", { name: "Kitchen Echo Dot" });
    await within(kitchen).findByText("Bohemian Rhapsody");

    fireEvent.click(within(kitchen).getByRole("button", { name: "Play" }));
    expect(await within(echo("Kitchen Echo Dot")).findByRole("button", { name: "Pause" })).toBeTruthy();

    fireEvent.change(within(echo("Kitchen Echo Dot")).getByRole("slider", { name: "Volume" }), {
      target: { value: "70" },
    });
    await waitFor(() => {
      expect(within(echo("Kitchen Echo Dot")).getByRole("slider", { name: "Volume" })).toHaveProperty("value", "70");
    });

    fireEvent.click(within(echo("Kitchen Echo Dot")).getByRole("button", { name: "Do Not Disturb" }));
    await waitFor(() => {
      expect(
        within(echo("Kitchen Echo Dot")).getByRole("button", { name: "Do Not Disturb" }).getAttribute("aria-pressed"),
      ).toBe("true");
    });

    fireEvent.click(within(echo("Kitchen Echo Dot")).getByRole("button", { name: "Delete alarm Work" }));
    await waitFor(() => {
      expect(within(echo("Kitchen Echo Dot")).queryByText("Alarm: Work")).toBeNull();
    });

    expect(amazon.asked()).toEqual([
      ["G1", { kind: "play" }],
      ["G1", { kind: "volume", level: 70 }],
      ["G1", { kind: "do-not-disturb", on: true }],
      ["G1", { kind: "notification-delete", id: "a1" }],
    ]);
  });

  it("asks Alexa, says and announces words, runs a quick action, a routine and music, and announces everywhere", async () => {
    const amazon = fakeAmazonApi(SIGNED_IN);
    renderTab(amazon);
    const kitchen = await screen.findByRole("article", { name: "Kitchen Echo Dot" });

    const words = within(kitchen).getByRole("textbox", { name: "Ask Alexa, or have it say or announce something" });
    fireEvent.input(words, { target: { value: "set a timer for 10 minutes" } });
    fireEvent.click(within(kitchen).getByRole("button", { name: "Ask Alexa" }));
    await within(echo("Kitchen Echo Dot")).findByText("Sent.");
    await idle("Kitchen Echo Dot");
    fireEvent.input(words, { target: { value: "Dinner is ready" } });
    fireEvent.click(within(kitchen).getByRole("button", { name: "Announce" }));
    await waitFor(() => {
      expect(amazon.asked()).toHaveLength(2);
    });

    await idle("Kitchen Echo Dot");
    fireEvent.click(within(kitchen).getByRole("button", { name: "Weather" }));
    await idle("Kitchen Echo Dot");
    fireEvent.change(within(kitchen).getByRole("combobox", { name: "Routine" }), { target: { value: "r2" } });
    fireEvent.click(within(kitchen).getByRole("button", { name: "Run it here" }));
    await idle("Kitchen Echo Dot");
    fireEvent.change(within(kitchen).getByRole("combobox", { name: "From" }), { target: { value: "TUNEIN" } });
    fireEvent.input(within(kitchen).getByRole("textbox", { name: "Song, artist, album, playlist or station" }), {
      target: { value: "Radio 2" },
    });
    fireEvent.click(within(kitchen).getByRole("button", { name: "Play music" }));

    const everywhere = screen.getByRole("textbox", { name: "Announce to every Echo" });
    fireEvent.input(everywhere, { target: { value: "Leaving in 5 minutes" } });
    fireEvent.click(screen.getByRole("button", { name: "Announce everywhere" }));

    await waitFor(() => {
      expect(amazon.asked()).toEqual([
        ["G1", { kind: "ask", text: "set a timer for 10 minutes" }],
        ["G1", { kind: "announce", text: "Dinner is ready" }],
        ["G1", { kind: "quick", action: "weather" }],
        ["G1", { kind: "routine", routineId: "r2" }],
        ["G1", { kind: "music", providerId: "TUNEIN", search: "Radio 2" }],
        ["announce-everywhere", "Leaving in 5 minutes"],
      ]);
    });
  });

  it("puts an Echo in a Room, and says why Amazon refused something, in its widget", async () => {
    const amazon = fakeAmazonApi(SIGNED_IN);
    const rooms = fakeRoomsApi(["Kitchen"]);
    renderTab(amazon, rooms);
    const kitchen = await screen.findByRole("article", { name: "Kitchen Echo Dot" });

    const picker = within(kitchen).getByRole<HTMLSelectElement>("combobox", { name: "Room for Kitchen Echo Dot" });
    await waitFor(() => {
      expect(picker.options).toHaveLength(3);
    });
    fireEvent.change(picker, { target: { value: String(rooms.current()[0]?.id) } });
    await waitFor(() => {
      expect(amazon.asked()).toEqual([["G1", { room: rooms.current()[0]?.id }]]);
    });
    // Once the Room change, and the Hub's answer to it, have settled in the widget.
    await new Promise((resolve) => setTimeout(resolve, 150));
    amazon.failNext("Amazon refused: Device is offline");
    fireEvent.click(within(echo("Kitchen Echo Dot")).getByRole("button", { name: "Joke" }));
    expect((await within(echo("Kitchen Echo Dot")).findByRole("alert")).textContent).toBe(
      "Amazon refused: Device is offline",
    );
  });

  it("signs out", async () => {
    const amazon = fakeAmazonApi(SIGNED_IN);
    renderTab(amazon);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("region", { name: "Sign in to Amazon" })).toBeTruthy();
  });
});
