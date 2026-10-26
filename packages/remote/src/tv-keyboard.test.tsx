import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { aTv, fakeAppliancesApi, type FakeAppliancesApi } from "./testing/fake-appliances-api.ts";
import { TvKeyboard } from "./tv-keyboard.tsx";

afterEach(cleanup);

const TV = aTv(2, "TV", 1);

const renderKeyboard = (appliances: FakeAppliancesApi, refreshMs = 20) =>
  render(<TvKeyboard appliances={appliances} tv={TV} refreshMs={refreshMs} />);

const form = () => screen.queryByRole("form", { name: "TV keyboard" });
const field = () =>
  within(screen.getByRole("form", { name: "TV keyboard" })).getByRole<HTMLInputElement>("textbox", {
    name: "Text for the TV",
  });
const sendButton = () =>
  within(screen.getByRole("form", { name: "TV keyboard" })).getByRole<HTMLButtonElement>("button", { name: "Send" });

const type = (text: string): void => {
  fireEvent.input(field(), { target: { value: text } });
};

/** Submits the form, as the phone's own keyboard does with its Enter or Send key. */
const submit = (): void => {
  fireEvent.submit(screen.getByRole("form", { name: "TV keyboard" }));
};

const opened = async (): Promise<void> => {
  await waitFor(() => {
    expect(form()).not.toBeNull();
  });
};

const closed = async (): Promise<void> => {
  await waitFor(() => {
    expect(form()).toBeNull();
  });
};

describe("the text field for the TV's on-screen keyboard (FR-20)", () => {
  it("isn't there while the TV's keyboard is closed", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);

    await waitFor(() => {
      expect(appliances.keyboardReads.length).toBeGreaterThan(1);
    });
    expect(form()).toBeNull();
    expect(appliances.keyboardReads.every((id) => id === TV.id)).toBe(true);
  });

  it("appears, ready to type into, when the TV opens its keyboard, and goes when the TV closes it", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);

    appliances.setKeyboard(TV.id, true);
    await opened();
    await waitFor(() => {
      expect(document.activeElement).toBe(field());
    });
    expect(field().value).toBe("");
    expect(field().getAttribute("enterkeyhint")).toBe("send");
    expect(field().getAttribute("aria-describedby")).toBe("tv-keyboard-note");

    appliances.setKeyboard(TV.id, false);
    await closed();
  });

  it('sends exactly "cosmos documentary" when it is submitted, then goes as the TV closes its keyboard', async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();

    type("cosmos documentary");
    submit();

    await waitFor(() => {
      expect(appliances.textsEntered).toEqual([{ id: TV.id, text: "cosmos documentary" }]);
    });
    await closed();
  });

  it.each(["café", "日本語", "🎬 films", "  spaced  "])("sends %j as typed, with the Send button", async (text) => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();

    type(text);
    fireEvent.click(sendButton());

    await waitFor(() => {
      expect(appliances.textsEntered).toEqual([{ id: TV.id, text }]);
    });
  });

  it("sends nothing while the field is empty", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();

    expect(sendButton().disabled).toBe(true);
    submit();
    type("a");
    expect(sendButton().disabled).toBe(false);
    type("");
    expect(sendButton().disabled).toBe(true);
    submit();

    await Promise.resolve();
    expect(appliances.textsEntered).toEqual([]);
  });

  it("sends the text once, however often it is submitted while it is being sent", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();
    const release = appliances.holdNextText();

    type("cosmos documentary");
    submit();
    await waitFor(() => {
      expect(sendButton().disabled).toBe(true);
    });
    submit();
    release();

    await closed();
    expect(appliances.textsEntered).toEqual([{ id: TV.id, text: "cosmos documentary" }]);
  });

  it("keeps the text, and says why, when the Hub couldn't send it", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();
    appliances.refuseNextText("Living room · TV no longer lets the Hub in. Pair it again in Settings.");

    type("café");
    submit();

    expect((await within(screen.getByRole("form", { name: "TV keyboard" })).findByRole("alert")).textContent).toBe(
      "Living room · TV no longer lets the Hub in. Pair it again in Settings.",
    );
    expect(field().value).toBe("café");
    expect(field().getAttribute("aria-describedby")).toBe("tv-keyboard-note tv-keyboard-problem");

    submit();
    await waitFor(() => {
      expect(appliances.textsEntered).toEqual([{ id: TV.id, text: "café" }]);
    });
  });

  it("starts empty when the TV opens its keyboard again, after closing it with text unsent", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();
    type("half a search");

    appliances.setKeyboard(TV.id, false);
    await closed();
    appliances.setKeyboard(TV.id, true);
    await opened();

    expect(field().value).toBe("");
    expect(appliances.textsEntered).toEqual([]);
  });

  it("stays, with what is typed, while the Hub doesn't answer", async () => {
    const appliances = fakeAppliancesApi([TV]);
    renderKeyboard(appliances);
    appliances.setKeyboard(TV.id, true);
    await opened();
    type("cosmos");

    // The TV is gone from the Hub, so asking about it fails.
    appliances.setKeyboard(TV.id, false);
    await appliances.remove(TV.id);
    const reads = appliances.keyboardReads.length;
    await waitFor(() => {
      expect(appliances.keyboardReads.length).toBeGreaterThan(reads + 1);
    });

    expect(field().value).toBe("cosmos");
  });
});
