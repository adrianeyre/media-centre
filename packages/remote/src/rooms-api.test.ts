import { describe, expect, it } from "vitest";

import { ROOM_ORDER_PATH, ROOMS_PATH } from "@media-centre/shared";

import { HubRequestFailed, messageFor } from "./hub-request.ts";
import { createRoomsApi } from "./rooms-api.ts";

interface Sent {
  readonly path: string;
  readonly method: string | undefined;
  readonly contentType: string | null;
  readonly body: unknown;
}

/** A `fetch` that records what it was sent and answers with `response`. */
const hubAnswering = (response: () => Response) => {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    sent.push({
      path: input instanceof Request ? input.url : input.toString(),
      method: init?.method,
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(response());
  };
  return { sent, fetchFn };
};

describe("the Remote's Rooms client", () => {
  it("lists the Rooms", async () => {
    const rooms = [{ id: 1, name: "Living room" }];
    const { sent, fetchFn } = hubAnswering(() => Response.json(rooms));

    expect(await createRoomsApi(fetchFn).list()).toEqual(rooms);
    expect(sent).toEqual([{ path: ROOMS_PATH, method: "GET", contentType: null, body: undefined }]);
  });

  it("sends each change as JSON, to its path", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ id: 3, name: "Office" }));
    const api = createRoomsApi(fetchFn);

    await api.add("Office");
    await api.rename(3, "Study");
    await api.reorder([3, 1, 2]);

    expect(sent).toEqual([
      { path: ROOMS_PATH, method: "POST", contentType: "application/json", body: { name: "Office" } },
      { path: "/api/rooms/3", method: "PATCH", contentType: "application/json", body: { name: "Study" } },
      { path: ROOM_ORDER_PATH, method: "PUT", contentType: "application/json", body: { roomIds: [3, 1, 2] } },
    ]);
  });

  it("deletes a Room", async () => {
    const { sent, fetchFn } = hubAnswering(() => new Response(null, { status: 204 }));

    await createRoomsApi(fetchFn).remove(4);

    expect(sent).toEqual([{ path: "/api/rooms/4", method: "DELETE", contentType: null, body: undefined }]);
  });

  it("fails with the Hub's own reason when it refuses", async () => {
    const { fetchFn } = hubAnswering(() =>
      Response.json({ error: 'There is already a Room called "bedroom".' }, { status: 409 }),
    );

    const failure = createRoomsApi(fetchFn).add("Bedroom");

    await expect(failure).rejects.toThrow(HubRequestFailed);
    await expect(failure).rejects.toThrow('There is already a Room called "bedroom".');
  });

  it("fails with the status when the refusal isn't the Hub's", async () => {
    const { fetchFn } = hubAnswering(() => new Response("<h1>Bad gateway</h1>", { status: 502 }));

    await expect(createRoomsApi(fetchFn).list()).rejects.toThrow("The Hub couldn't do that (error 502).");
  });

  it("says it can't reach the Hub when the request fails", async () => {
    const api = createRoomsApi(() => Promise.reject(new TypeError("fetch failed")));

    await expect(api.list()).rejects.toThrow("Can't reach the Hub");
  });

  it("has a message for any failure", () => {
    expect(messageFor(new HubRequestFailed("Give the Room a name."))).toBe("Give the Room a name.");
    expect(messageFor(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
