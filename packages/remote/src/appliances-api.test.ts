import { describe, expect, it } from "vitest";

import { APPLIANCES_PATH } from "@media-centre/shared";

import { createAppliancesApi, PLAY_CUT_OFF, PLAYER_ACTION_CUT_OFF } from "./appliances-api.ts";
import { HubRequestFailed } from "./hub-request.ts";
import { aFoundAirConditioner, aFoundLight, aLight, anAirConditioner, aTv } from "./testing/fake-appliances-api.ts";

interface Sent {
  readonly path: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

const hubAnswering = (response: () => Response) => {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    sent.push({
      path: input instanceof Request ? input.url : input.toString(),
      method: init?.method,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(response());
  };
  return { sent, fetchFn };
};

describe("the Remote's Appliances client", () => {
  it("lists the Appliances", async () => {
    const tvs = [aTv(1, "TV", null)];
    const { sent, fetchFn } = hubAnswering(() => Response.json(tvs));

    expect(await createAppliancesApi(fetchFn).list()).toEqual(tvs);
    expect(sent).toEqual([{ path: APPLIANCES_PATH, method: "GET", body: undefined }]);
  });

  it("sends each request to its path", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json(aTv(3, "TV", 1)));
    const api = createAppliancesApi(fetchFn);

    expect(await api.add({ kind: "tv", address: "192.168.1.20", name: "TV", roomId: 1 })).toEqual(aTv(3, "TV", 1));
    await api.update(3, { name: "Big TV", roomId: null });
    await api.checkConnection(3);
    await api.pairAgain(3);

    expect(sent).toEqual([
      { path: APPLIANCES_PATH, method: "POST", body: { kind: "tv", address: "192.168.1.20", name: "TV", roomId: 1 } },
      { path: "/api/appliances/3", method: "PATCH", body: { name: "Big TV", roomId: null } },
      { path: "/api/appliances/3/connection", method: "POST", body: undefined },
      { path: "/api/appliances/3/pairing", method: "POST", body: undefined },
    ]);
  });

  it("has the Hub find Air Conditioners, add one with the login, and fetch its token and key again", async () => {
    const found = [aFoundAirConditioner(1, "Unit 0001")];
    const login = { account: "owner@example.com", password: "secret" };
    let answer: unknown = found;
    const { sent, fetchFn } = hubAnswering(() => Response.json(answer));
    const api = createAppliancesApi(fetchFn);

    expect(await api.findAirConditioners()).toEqual(found);
    answer = anAirConditioner(1, "Aircon", null);
    await api.add({ kind: "air-conditioner", address: "192.168.1.41", name: "Aircon", roomId: null, login });
    expect(await api.fetchAgain(1, login)).toEqual(answer);

    expect(sent).toEqual([
      { path: "/api/appliances/search", method: "POST", body: { kind: "air-conditioner" } },
      {
        path: APPLIANCES_PATH,
        method: "POST",
        body: { kind: "air-conditioner", address: "192.168.1.41", name: "Aircon", roomId: null, login },
      },
      { path: "/api/appliances/1/pairing", method: "POST", body: { login } },
    ]);
  });

  it("says when the Hub needs the login before it adds an Air Conditioner", async () => {
    const { fetchFn } = hubAnswering(() => Response.json({ error: "Sign in once.", needs: "login" }, { status: 401 }));

    const failure = await createAppliancesApi(fetchFn)
      .add({ kind: "air-conditioner", address: "192.168.1.41", roomId: null })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HubRequestFailed);
    expect(failure).toMatchObject({ message: "Sign in once.", needs: "login" });
  });

  it("has the Hub find TVs on its network", async () => {
    const found = [
      { kind: "tv", address: "192.168.1.20", name: "[TV] Samsung", model: "QE55", macAddress: "02:00:00:00:00:01" },
    ];
    const { sent, fetchFn } = hubAnswering(() => Response.json(found));

    expect(await createAppliancesApi(fetchFn).find("tv")).toEqual(found);
    expect(sent).toEqual([{ path: "/api/appliances/search", method: "POST", body: { kind: "tv" } }]);
  });

  it("has the Hub read a TV's power state", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ power: "standby" }));

    expect(await createAppliancesApi(fetchFn).readPower(2)).toBe("standby");
    expect(sent).toEqual([{ path: "/api/appliances/2/power", method: "GET", body: undefined }]);
  });

  it("has the Hub switch a TV on or off, and says which", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ switching: "on" }));

    expect(await createAppliancesApi(fetchFn).switchPower(2)).toEqual({ switching: "on" });
    expect(sent).toEqual([{ path: "/api/appliances/2/power", method: "POST", body: undefined }]);
  });

  it("has the Hub press a key on a TV", async () => {
    const { sent, fetchFn } = hubAnswering(() => new Response(null, { status: 204 }));

    await createAppliancesApi(fetchFn).pressKey(2, "channel-up");

    expect(sent).toEqual([{ path: "/api/appliances/2/keys", method: "POST", body: { key: "channel-up" } }]);
  });

  it("has the Hub press a TV Menu shortcut on a TV, and hears later what the TV said of it", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ outcome: "ignored" }));

    const { outcome } = await createAppliancesApi(fetchFn).pressShortcut(2, "picture-mode");

    expect(await outcome).toBe("ignored");
    expect(sent).toEqual([{ path: "/api/appliances/2/shortcuts", method: "POST", body: { shortcut: "picture-mode" } }]);
  });

  it("resolves a shortcut once the Hub has sent its key, before the Hub has heard back from the TV", async () => {
    let finish = (): void => undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        finish = () => {
          controller.enqueue(new TextEncoder().encode('{"outcome":"unconfirmed"}'));
          controller.close();
        };
      },
    });
    const { fetchFn } = hubAnswering(() => new Response(body, { status: 200 }));

    const { outcome } = await createAppliancesApi(fetchFn).pressShortcut(2, "sleep-timer");
    let heard: string | undefined;
    void outcome.then((said) => {
      heard = said;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(heard).toBeUndefined();

    finish();
    expect(await outcome).toBe("unconfirmed");
  });

  it("says a shortcut is unconfirmed when the Hub's answer is cut off", async () => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.error(new Error("connection reset"));
      },
    });
    const { fetchFn } = hubAnswering(() => new Response(body, { status: 200 }));

    const { outcome } = await createAppliancesApi(fetchFn).pressShortcut(2, "captions");

    expect(await outcome).toBe("unconfirmed");
  });

  it("fails a shortcut with the Hub's reason when it refuses", async () => {
    const { fetchFn } = hubAnswering(() => Response.json({ error: "The TV has no such shortcut." }, { status: 400 }));

    await expect(createAppliancesApi(fetchFn).pressShortcut(2, "captions")).rejects.toThrow(
      "The TV has no such shortcut.",
    );
  });

  it("has the Hub read a TV's volume and mute, which it may not know", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ known: false }));

    expect(await createAppliancesApi(fetchFn).readVolume(2)).toEqual({ known: false });
    expect(sent).toEqual([{ path: "/api/appliances/2/volume", method: "GET", body: undefined }]);
  });

  it("has the Hub set a TV's volume, and answers with it as the TV says it is", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ known: true, volume: 18, muted: false }));

    expect(await createAppliancesApi(fetchFn).changeVolume(2, { volume: 18 })).toEqual({
      known: true,
      volume: 18,
      muted: false,
    });
    expect(sent).toEqual([{ path: "/api/appliances/2/volume", method: "PATCH", body: { volume: 18 } }]);
  });

  it("has the Hub read an Air Conditioner's capabilities and state, and change it", async () => {
    let answer: unknown = { known: false, why: "unreachable" };
    const { sent, fetchFn } = hubAnswering(() => Response.json(answer));
    const api = createAppliancesApi(fetchFn);

    expect(await api.readAirConditionerCapabilities(4)).toEqual({ known: false, why: "unreachable" });
    expect(await api.readAirConditioner(4)).toEqual({ known: false, why: "unreachable" });
    answer = { known: true, state: { power: true } };
    expect(await api.changeAirConditioner(4, { power: true, swing: { vertical: true } })).toEqual(answer);

    expect(sent).toEqual([
      { path: "/api/appliances/4/capabilities", method: "GET", body: undefined },
      { path: "/api/appliances/4/state", method: "GET", body: undefined },
      { path: "/api/appliances/4/state", method: "PATCH", body: { power: true, swing: { vertical: true } } },
    ]);
  });

  it("has the Hub find Lights, add one with its key, read and change one, and change a Room's or the home's", async () => {
    const found = [aFoundLight(1)];
    let answer: unknown = found;
    const { sent, fetchFn } = hubAnswering(() => Response.json(answer));
    const api = createAppliancesApi(fetchFn);

    expect(await api.findLights()).toEqual(found);
    answer = aLight(1, "Lamp", 2);
    await api.add({ kind: "light", address: "192.168.1.61", name: "Lamp", roomId: 2, light: { key: "k" } });
    answer = { known: true, capabilities: { onOff: true } };
    expect(await api.readLightCapabilities(1)).toEqual(answer);
    answer = { known: false, why: "unreachable" };
    expect(await api.readLight(1)).toEqual(answer);
    expect(await api.changeLight(1, { on: false })).toEqual(answer);
    answer = { lights: [], unreached: [1] };
    expect(await api.changeLights(2, { brightness: 30 })).toEqual(answer);
    expect(await api.changeLights(undefined, { on: false })).toEqual(answer);

    expect(sent).toEqual([
      { path: "/api/appliances/search", method: "POST", body: { kind: "light" } },
      {
        path: APPLIANCES_PATH,
        method: "POST",
        body: { kind: "light", address: "192.168.1.61", name: "Lamp", roomId: 2, light: { key: "k" } },
      },
      { path: "/api/appliances/1/capabilities", method: "GET", body: undefined },
      { path: "/api/appliances/1/state", method: "GET", body: undefined },
      { path: "/api/appliances/1/state", method: "PATCH", body: { on: false } },
      { path: "/api/appliances/lights", method: "POST", body: { change: { brightness: 30 }, roomId: 2 } },
      { path: "/api/appliances/lights", method: "POST", body: { change: { on: false } } },
    ]);
  });

  it("has the Hub list, save, rename, delete and recall Light Scenes (FR-56)", async () => {
    const film = { id: 7, roomId: 2, name: "Film", lights: [] };
    let answer: unknown = [film];
    const { sent, fetchFn } = hubAnswering(() =>
      answer === undefined ? new Response(null, { status: 204 }) : Response.json(answer),
    );
    const api = createAppliancesApi(fetchFn);

    expect(await api.lightScenes()).toEqual([film]);
    answer = { lightScene: film, unreached: [3] };
    expect(await api.saveLightScene(2, "Film")).toEqual(answer);
    answer = { ...film, name: "Cinema" };
    expect(await api.renameLightScene(7, "Cinema")).toEqual(answer);
    answer = { lights: [], unreached: [] };
    expect(await api.recallLightScene(7)).toEqual(answer);
    answer = undefined;
    await api.deleteLightScene(7);

    expect(sent).toEqual([
      { path: "/api/appliances/lights/scenes", method: "GET", body: undefined },
      { path: "/api/appliances/lights/scenes", method: "POST", body: { roomId: 2, name: "Film" } },
      { path: "/api/appliances/lights/scenes/7", method: "PATCH", body: { name: "Cinema" } },
      { path: "/api/appliances/lights/scenes/7/recall", method: "POST", body: undefined },
      { path: "/api/appliances/lights/scenes/7", method: "DELETE", body: undefined },
    ]);
  });

  it("has the Hub say whether it is signed in to Hive, sign in with the login and the code, and sign out (FR-67)", async () => {
    const login = { account: "owner@example.com", password: "secret" };
    let answer: unknown = { signedIn: false };
    const { sent, fetchFn } = hubAnswering(() =>
      answer === undefined ? new Response(null, { status: 204 }) : Response.json(answer),
    );
    const api = createAppliancesApi(fetchFn);

    expect(await api.readHive()).toEqual({ signedIn: false });
    answer = { signedIn: false, needs: "code" };
    expect(await api.signInToHive(login)).toEqual(answer);
    answer = { signedIn: true, added: [] };
    expect(await api.enterHiveCode("246810")).toEqual(answer);
    answer = undefined;
    await api.signOutOfHive();

    expect(sent).toEqual([
      { path: "/api/hive", method: "GET", body: undefined },
      { path: "/api/hive/sign-in", method: "POST", body: login },
      { path: "/api/hive/code", method: "POST", body: { code: "246810" } },
      { path: "/api/hive", method: "DELETE", body: undefined },
    ]);
  });

  it("has the Hub say whether a TV's on-screen keyboard is open", async () => {
    const { sent, fetchFn } = hubAnswering(() => Response.json({ open: true }));

    expect(await createAppliancesApi(fetchFn).readKeyboard(2)).toBe(true);
    expect(sent).toEqual([{ path: "/api/appliances/2/keyboard", method: "GET", body: undefined }]);
  });

  it("has the Hub type text into a TV's on-screen keyboard, exactly as given", async () => {
    const { sent, fetchFn } = hubAnswering(() => new Response(null, { status: 204 }));

    await createAppliancesApi(fetchFn).enterText(2, "café");

    expect(sent).toEqual([{ path: "/api/appliances/2/keyboard", method: "POST", body: { text: "café" } }]);
  });

  it("has the Hub list a TV's apps, which it may not know", async () => {
    const apps = { known: true, apps: [{ id: "111299001912", name: "YouTube", icon: true }] };
    const { sent, fetchFn } = hubAnswering(() => Response.json(apps));

    expect(await createAppliancesApi(fetchFn).listApps(2)).toEqual(apps);
    expect(sent).toEqual([{ path: "/api/appliances/2/apps", method: "GET", body: undefined }]);
  });

  it("has the Hub launch and close an app on a TV, by its id", async () => {
    const { sent, fetchFn } = hubAnswering(() => new Response(null, { status: 204 }));
    const api = createAppliancesApi(fetchFn);

    await api.launchApp(2, "111299001912");
    await api.closeApp(2, "org.tizen.browser");

    expect(sent).toEqual([
      { path: "/api/appliances/2/apps/111299001912", method: "POST", body: undefined },
      { path: "/api/appliances/2/apps/org.tizen.browser", method: "DELETE", body: undefined },
    ]);
  });

  it("has the Hub say which app is in front on a TV, which it may not be able to tell", async () => {
    const nowShowing = { known: true, app: { id: "111299001912", name: "YouTube", icon: true } };
    const { sent, fetchFn } = hubAnswering(() => Response.json(nowShowing));

    expect(await createAppliancesApi(fetchFn).readNowShowing(2)).toEqual(nowShowing);
    expect(sent).toEqual([{ path: "/api/appliances/2/now-showing", method: "GET", body: undefined }]);
  });

  it("has the Hub say what is playing on a TV, and send its Player a control (FR-36)", async () => {
    const nowPlaying = { name: "Arrival.mkv", state: "paused", positionMs: 12_000, durationMs: 6_960_000 };
    const { sent, fetchFn } = hubAnswering(() => Response.json({ nowPlaying }));
    const api = createAppliancesApi(fetchFn);

    expect(await api.readPlayback(2)).toEqual(nowPlaying);
    expect(await api.controlPlayback(2, { action: "skip", byMs: -10_000 })).toEqual(nowPlaying);

    expect(sent).toEqual([
      { path: "/api/appliances/2/playback", method: "GET", body: undefined },
      { path: "/api/appliances/2/playback", method: "POST", body: { action: "skip", byMs: -10_000 } },
    ]);
  });

  it("reads an Appliance's device info", async () => {
    const deviceInfo = {
      known: true,
      info: {
        name: "[TV] Samsung Q60 Series (55)",
        model: "QE55Q60TAUXXU",
        macAddress: "02:00:00:00:00:02",
        networkType: "wireless",
        frame: false,
        developer: { mode: "on", ip: "192.168.1.5" },
      },
    };
    const { sent, fetchFn } = hubAnswering(() => Response.json(deviceInfo));

    expect(await createAppliancesApi(fetchFn).readDeviceInfo(2)).toEqual(deviceInfo);
    expect(sent).toEqual([{ path: "/api/appliances/2/device-info", method: "GET", body: undefined }]);
  });

  it("removes an Appliance", async () => {
    const { sent, fetchFn } = hubAnswering(() => new Response(null, { status: 204 }));

    await createAppliancesApi(fetchFn).remove(4);

    expect(sent).toEqual([{ path: "/api/appliances/4", method: "DELETE", body: undefined }]);
  });

  it("fails with the Hub's own reason when it refuses", async () => {
    const { fetchFn } = hubAnswering(() =>
      Response.json({ error: 'There is already a TV called "TV" in Living room.' }, { status: 409 }),
    );

    const failure = createAppliancesApi(fetchFn).add({ kind: "tv", address: "192.168.1.21", name: "tv", roomId: 1 });

    await expect(failure).rejects.toThrow(HubRequestFailed);
    await expect(failure).rejects.toThrow('There is already a TV called "TV" in Living room.');
  });
});

describe("playing a Media File through the Remote's Appliances client (FR-35)", () => {
  /** The Hub's answer to a play, in these chunks, sent one at a time; or cut off after them if `cutOff`. */
  const streamed = (chunks: readonly string[], { cutOff = false } = {}): Response => {
    const encoder = new TextEncoder();
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const chunk = chunks[next];
        next += 1;
        if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
        else if (cutOff) controller.error(new TypeError("network error"));
        else controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  };

  it("posts the Media File to the TV's play path, and tells each step until the Player has it", async () => {
    const { sent, fetchFn } = hubAnswering(() =>
      streamed([
        '{"step":"waking"}\n',
        '{"step":"launching"}\n{"step":"conn',
        'ecting"}\n',
        '{"step":"sending"}\n{"step":"sent"}\n',
      ]),
    );
    const steps: string[] = [];

    await createAppliancesApi(fetchFn).play(2, { mediaSourceId: 1, path: "Films/Arrival.mkv" }, (step) => {
      steps.push(step);
    });

    expect(sent).toEqual([
      { path: "/api/appliances/2/play", method: "POST", body: { mediaSourceId: 1, path: "Films/Arrival.mkv" } },
    ]);
    expect(steps).toEqual(["waking", "launching", "connecting", "sending"]);
  });

  it("fails with the Hub's reason when a step fails", async () => {
    const { fetchFn } = hubAnswering(() =>
      streamed([
        '{"step":"waking"}\n{"step":"failed","error":"Living room · TV didn\'t come on within 30 seconds."}\n',
      ]),
    );
    const steps: string[] = [];

    await expect(
      createAppliancesApi(fetchFn).play(2, { mediaSourceId: 1, path: "Films/Arrival.mkv" }, (step) => {
        steps.push(step);
      }),
    ).rejects.toThrow(new HubRequestFailed("Living room · TV didn't come on within 30 seconds."));
    expect(steps).toEqual(["waking"]);
  });

  it("fails with the Hub's reason when it refuses to start", async () => {
    const { fetchFn } = hubAnswering(() =>
      Response.json({ error: "That path is outside the Media Source." }, { status: 403 }),
    );

    await expect(
      createAppliancesApi(fetchFn).play(2, { mediaSourceId: 1, path: "../x.mp4" }, () => undefined),
    ).rejects.toThrow(new HubRequestFailed("That path is outside the Media Source."));
  });

  it.each([
    ["ends", { cutOff: false }],
    ["is cut off", { cutOff: true }],
  ])("says so when the Hub's answer %s before saying how it went", async (_, options) => {
    const { fetchFn } = hubAnswering(() => streamed(['{"step":"launching"}\n'], options));

    await expect(
      createAppliancesApi(fetchFn).play(2, { mediaSourceId: 1, path: "Films/Arrival.mkv" }, () => undefined),
    ).rejects.toThrow(new HubRequestFailed(PLAY_CUT_OFF));
  });
});

describe("installing, launching and uninstalling the Player through the Remote's Appliances client (FR-31)", () => {
  const streamed = (text: string, { cutOff = false } = {}): Response => {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(text));
        if (cutOff) controller.error(new TypeError("network error"));
        else controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  };

  it("posts the action to the TV's Player, and tells each step until it is done", async () => {
    const { sent, fetchFn } = hubAnswering(() =>
      streamed('{"step":"connecting"}\n{"step":"signing"}\n{"step":"installing"}\n{"step":"done"}\n'),
    );
    const steps: string[] = [];

    await createAppliancesApi(fetchFn).playerAction(2, "install", (step) => {
      steps.push(step);
    });

    expect(sent).toEqual([{ path: "/api/appliances/2/player/action", method: "POST", body: { action: "install" } }]);
    expect(steps).toEqual(["connecting", "signing", "installing"]);
  });

  it("fails with the Hub's reason when a step fails", async () => {
    const { fetchFn } = hubAnswering(() =>
      streamed('{"step":"connecting"}\n{"step":"failed","error":"The TV didn\'t let the Hub connect."}\n'),
    );

    await expect(createAppliancesApi(fetchFn).playerAction(2, "launch", () => undefined)).rejects.toThrow(
      new HubRequestFailed("The TV didn't let the Hub connect."),
    );
  });

  it("fails with the Hub's reason when it refuses to start", async () => {
    const { fetchFn } = hubAnswering(() =>
      Response.json({ error: "Living room · TV isn't in Developer Mode." }, { status: 409 }),
    );

    await expect(createAppliancesApi(fetchFn).playerAction(2, "uninstall", () => undefined)).rejects.toThrow(
      new HubRequestFailed("Living room · TV isn't in Developer Mode."),
    );
  });

  it("says so when the Hub's answer is cut off before saying how it went", async () => {
    const { fetchFn } = hubAnswering(() => streamed('{"step":"connecting"}\n', { cutOff: true }));

    await expect(createAppliancesApi(fetchFn).playerAction(2, "install", () => undefined)).rejects.toThrow(
      new HubRequestFailed(PLAYER_ACTION_CUT_OFF),
    );
  });
});
