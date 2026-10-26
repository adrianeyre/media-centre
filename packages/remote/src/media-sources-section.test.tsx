import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";

import { MediaSourcesSection } from "./media-sources-section.tsx";
import { fakeMediaSourcesApi } from "./testing/fake-media-sources-api.ts";

afterEach(cleanup);

/** Each Media Source listed, as its name then its folder. */
const shownSources = async (): Promise<[string, string][]> => {
  const list = await screen.findByRole("list", { name: "Media Sources" });
  return within(list)
    .getAllByRole("listitem")
    .map((item) => [
      item.querySelector(".media-source-name")?.textContent ?? "",
      item.querySelector(".media-source-path")?.textContent ?? "",
    ]);
};

const type = (label: string | RegExp, text: string, within: HTMLElement = document.body): void => {
  fireEvent.input(screen.getAllByRole("textbox", { name: label }).find((box) => within.contains(box)) ?? document, {
    target: { value: text },
  });
};

const addForm = () => screen.getByRole("form", { name: "Add a Media Source" });

describe("Settings' Media Sources", () => {
  it("say how to start when there are none", async () => {
    render(<MediaSourcesSection mediaSources={fakeMediaSourcesApi()} />);

    expect(screen.getByText("Loading the Media Sources…")).toBeTruthy();
    expect(await screen.findByText("No Media Sources yet. Add a folder below, e.g. /media/films.")).toBeTruthy();
  });

  it("list each Media Source with its folder", async () => {
    render(
      <MediaSourcesSection
        mediaSources={fakeMediaSourcesApi([
          { name: "Films", path: "/media/films" },
          { name: "Music", path: "/mnt/nas/music" },
        ])}
      />,
    );

    expect(await shownSources()).toEqual([
      ["Films", "/media/films"],
      ["Music", "/mnt/nas/music"],
    ]);
  });

  it("add a folder by its path and a name, and empty the fields for the next", async () => {
    const mediaSources = fakeMediaSourcesApi();
    render(<MediaSourcesSection mediaSources={mediaSources} />);
    await screen.findByText(/No Media Sources yet/);

    type("Folder", "/media/films");
    type("Name", "Films");
    fireEvent.click(screen.getByRole("button", { name: "Add Media Source" }));

    await waitFor(async () => {
      expect(await shownSources()).toEqual([["Films", "/media/films"]]);
    });
    expect(mediaSources.current()).toEqual([{ id: 1, name: "Films", path: "/media/films" }]);
    expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "Folder" }).value).toBe("");
    expect(within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("");
  });

  it("show the Hub's reason for refusing a folder beside the form, and keep what was typed", async () => {
    const mediaSources = fakeMediaSourcesApi();
    render(<MediaSourcesSection mediaSources={mediaSources} />);
    await screen.findByText(/No Media Sources yet/);

    mediaSources.refuseNext('There is no folder at "/media/flims".');
    type("Folder", "/media/flims");
    fireEvent.click(screen.getByRole("button", { name: "Add Media Source" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('There is no folder at "/media/flims".');
    const folder = within(addForm()).getByRole<HTMLInputElement>("textbox", { name: "Folder" });
    expect(folder.value).toBe("/media/flims");
    expect(folder.getAttribute("aria-invalid")).toBe("true");
    expect(folder.getAttribute("aria-describedby")).toBe(alert.id);
    expect(mediaSources.current()).toEqual([]);
  });

  it("rename a Media Source", async () => {
    const mediaSources = fakeMediaSourcesApi([{ name: "Films", path: "/media/films" }]);
    render(<MediaSourcesSection mediaSources={mediaSources} />);
    await shownSources();

    fireEvent.click(screen.getByRole("button", { name: "Rename Films" }));
    const form = screen.getByRole("form", { name: "Rename Films" });
    const field = within(form).getByRole<HTMLInputElement>("textbox", { name: "Media Source name" });
    expect(field.value).toBe("Films");
    expect(document.activeElement).toBe(field);
    type("Media Source name", "Cinema", form);
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      expect(await shownSources()).toEqual([["Cinema", "/media/films"]]);
    });
  });

  it("show the Hub's reason for refusing a new name inside the rename form", async () => {
    const mediaSources = fakeMediaSourcesApi([{ name: "Films", path: "/media/films" }]);
    render(<MediaSourcesSection mediaSources={mediaSources} />);
    await shownSources();

    fireEvent.click(screen.getByRole("button", { name: "Rename Films" }));
    mediaSources.refuseNext("Give the Media Source a name.");
    const form = screen.getByRole("form", { name: "Rename Films" });
    type("Media Source name", " ", form);
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    expect((await within(form).findByRole("alert")).textContent).toBe("Give the Media Source a name.");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await shownSources()).toEqual([["Films", "/media/films"]]);
  });

  it("remove a Media Source only once the person says yes", async () => {
    const mediaSources = fakeMediaSourcesApi([
      { name: "Films", path: "/media/films" },
      { name: "Music", path: "/media/music" },
    ]);
    render(<MediaSourcesSection mediaSources={mediaSources} />);
    await shownSources();

    fireEvent.click(screen.getByRole("button", { name: "Remove Films" }));
    expect(screen.getByText("Remove Films? Its files stay where they are.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No, keep it" }));
    expect(mediaSources.current()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove Films" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove" }));

    await waitFor(async () => {
      expect(await shownSources()).toEqual([["Music", "/media/music"]]);
    });
  });
});
