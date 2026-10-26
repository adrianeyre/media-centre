# The fake Appliances

Every automated test runs against fakes of the Appliances, never a real one. Each fake runs on its own with a `pnpm --filter @media-centre/hub fake-…` script, and has `/_fake/` paths for tests to read and change what it is doing. How the tests use them is in [Testing](testing.md).

- [The fake Samsung TV](#the-fake-samsung-tv)
- [The fake Midea Air Conditioner](#the-fake-midea-air-conditioner)
- [The fake Midea cloud](#the-fake-midea-cloud)
- [The fake Lepro Light](#the-fake-lepro-light)
- [The fake Hive cloud](#the-fake-hive-cloud)

## The fake Samsung TV

`pnpm --filter @media-centre/hub fake-tv` runs the fake Samsung TV on its own.

### Its settings

| Variable                                                                              | What it is                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAKE_TV_HOST`                                                                        | 127.0.0.1 by default                                                                                                                                                        |
| `FAKE_TV_REST_PORT`, `FAKE_TV_CONTROL_PORT`, `FAKE_TV_SSDP_PORT`, `FAKE_TV_UPNP_PORT` | 8001, 8002, 1900 and 9197 by default                                                                                                                                        |
| `FAKE_TV_NAME`, `FAKE_TV_MAC`                                                         | What it reports                                                                                                                                                             |
| `FAKE_TV_FRAME`                                                                       | `true` to report itself as a Frame TV, whose power key must be held to switch it off                                                                                        |
| `FAKE_TV_WAKE_PORT`                                                                   | Where it hears Wake-on-LAN magic packets sent to its own address (a free port by default, which it prints, as a real TV's 9 needs root); one for its own MAC switches it on |

### Running the Hub against it

- To run the Hub against it on other ports, set `SAMSUNG_TV_REST_PORT`, `SAMSUNG_TV_CONTROL_PORT` and `SAMSUNG_TV_UPNP_PORT` for the Hub, and `SAMSUNG_TV_WAKE_PORT` to send Wake-on-LAN to each TV's own address on that port rather than broadcasting it.
- The fake answers searches sent to its own address only, so for "Find TVs" to reach it, set `SAMSUNG_TV_SEARCH_TARGETS` to its `host:port` (several separated by commas) and the Hub searches there instead of the multicast group.
- For the Hub to install the Player on it, set `SAMSUNG_TV_SDB` and `SAMSUNG_TV_TIZEN` to `packages/hub/src/fakes/samsung-tv/fake-sdb.ts` and `fake-tizen.ts`, stand-ins for Samsung's tools, by their full paths: they answer as the real ones do, `sdb` connecting only to a fake TV that says Developer Mode is on, and `tizen` installing the Player among the fake TV's apps, bringing it to the front, and uninstalling it, through its `/_fake/apps` and `/_fake/front`.

Nothing else should set these.

The end-to-end run starts two fake TVs at 127.0.0.2 and 127.0.0.3, and one test starts and stops a third at 127.0.0.4, which Linux answers on loopback; macOS needs those addresses aliased first.

### Power, keys and Wake-on-LAN

- `POST /_fake/power` with `{"power": "standby"}` or `{"power": "on"}` puts a running fake TV in standby or switches it on.
- `GET /_fake/keys` lists the keys pressed on a running fake TV, each with when it arrived.
- `GET /_fake/wakes` lists the packets it heard on its Wake-on-LAN port, each with the MAC address it was a magic packet for.

### Volume

`GET /_fake/volume` says its volume and mute, and `POST /_fake/volume` with `{"volume": 18}`, `{"muted": true}` or both changes them as its own remote would; it answers the Hub's volume calls only while it is on, and its volume keys turn it up and down by one.

### The on-screen keyboard

- `GET /_fake/keyboard` says whether its on-screen keyboard is open, and `POST /_fake/keyboard` with `{"open": true}` or `{"open": false}` opens or closes it, as choosing a search box on the TV would; it tells the clients on its control socket at that moment, not any that connect later, and it opens none in standby.
- `GET /_fake/text` lists the text typed into it, each with whether its keyboard was open to take it, and submitting the text closes the keyboard.

### Apps

- `GET /_fake/apps` lists its installed apps, YouTube, Netflix, Prime Video and Internet by default, each with whether it is running and visible, and `PUT /_fake/apps` with a list such as `[{"id": "111299001912", "name": "YouTube", "icon": true}]` installs those instead; launching an app makes it running and visible, only one app is visible at a time, and standby closes them all.
- `GET /_fake/front` says which app is in front, and `POST /_fake/front` with `{"app": "111299001912"}` brings that one to the front, launching it, or with `{"app": null}` none, leaving the apps running behind, as choosing an app or live TV with its own remote would; it refuses in standby.

### The fake Player

Once the Player is installed on a fake TV, with `PUT /_fake/apps` and `{"id": "MediaCntre.Player", "name": "Media Centre"}` in the list, launching it runs a fake Player: a WebSocket client that connects to the Hub at the address it was launched with, from the fake TV's own address, and plays what the Hub sends it through the Player's fake playback, in real time, as though every Media File were a minute long, from where the Hub says to start, with the audio and subtitle tracks it says, doing the Hub's controls and reporting back as the Player does, telling the Hub too when each Media File plays to its end.

Sent an HLS stream, it reads it from the Hub as AVPlay would, from the fake TV's address: the playlist as it loads, then the segment at its position whenever that moves into another, as it plays or seeks, stopping if the Hub doesn't send one, and giving up on any it is still reading when it seeks elsewhere, as AVPlay drops what it was buffering.

`GET /_fake/player` says:

- whether it is running, the Hub's address it has, and whether it is connected;
- the URL of every Media File the Hub sent it;
- every HLS segment it read, but those it gave up on, with the Hub's status and how many bytes it sent;
- what its playback is doing, and its position;
- the audio track it plays, by its place among the Media File's, which it switches to as the Hub asks;
- the subtitle track it shows, by its place among those the Hub sent it, with the text it shows at its position;
- and, for an audio Media File, what the Player's now-playing screen would show of it, as the Hub sent it, with what the Hub answered for its cover art, which it reads from the fake TV's address as the Player does.

It reads the subtitle track the Hub asks for from the Hub, from the fake TV's address, and renders only SubRip and WebVTT, as the Player does.

### Developer Mode

`GET /_fake/developer` says what its device info reports of Developer Mode and the Developer IP, off and none by default, and `PUT /_fake/developer` with `{"mode": "on", "ip": "192.168.1.10"}` changes them, as doing that at the TV and restarting it would, or with `null` leaves both out, as firmware that doesn't report them would.

### Ignored keys

`GET /_fake/ignored-keys` lists the keys it ignores, none by default, and `PUT /_fake/ignored-keys` with `{"keys": ["KEY_PMODE"], "answer": "silence"}` has it ignore those instead, as a model or firmware without them would: it records them as ignored in `/_fake/keys` and does nothing with them, saying nothing, as a real TV is reported to, or, with `"answer": "error"`, answering each with the control socket's `ms.error` event, the only thing a TV is known to send for a command it won't take.

## The fake Midea Air Conditioner

`pnpm --filter @media-centre/hub fake-aircon` runs the fake Midea Air Conditioner on its own.

### Its settings

| Variable                                                                  | What it is                                                                                          |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `FAKE_AIRCON_HOST`                                                        | 127.0.0.1 by default                                                                                |
| `FAKE_AIRCON_PORT`, `FAKE_AIRCON_DISCOVERY_PORT`, `FAKE_AIRCON_HTTP_PORT` | 6444, 6445 and 6446 by default, the last for its `/_fake/` paths                                    |
| `FAKE_AIRCON_VERSION`                                                     | 2 by default, or 3 with `FAKE_AIRCON_TOKEN` and `FAKE_AIRCON_KEY`                                   |
| `FAKE_AIRCON_TOKEN`, `FAKE_AIRCON_KEY`                                    | The token and key, in hex, 64 and 32 bytes, that it expects in the handshake, which it never prints |
| `FAKE_AIRCON_ID`, `FAKE_AIRCON_SERIAL`, `FAKE_AIRCON_NAME`                | What it answers discovery with, so that two fakes can be told apart                                 |
| `FAKE_AIRCON_CAPABILITIES`                                                | What it has: `all`, the default, or a list separated by commas (below)                              |

`FAKE_AIRCON_CAPABILITIES` lists, separated by commas:

- the modes `cool`, `heat`, `dry` and `auto`, fan mode being on every Air Conditioner;
- the fan steps `fan-silent`, `fan-medium`, `fan-auto` and `fan-percent`, low and high being on every one that doesn't set its fan by percentage;
- `swing-vertical` and `swing-horizontal`;
- the presets `eco` and `turbo`, Sleep being on every one;
- `display`;
- `half-degrees`;
- `outdoor-temperature`;
- and the further functions `vertical-vane`, `horizontal-vane`, `breeze`, `power-limit`, `self-clean`, `frost-protection`, `electric-heater`, `ionizer`, `smart-eye`, `air-towards-me` and `air-away-from-me`.

It won't start with modes or fan steps no Midea Air Conditioner reports together.

### Running the Hub against it

It answers discovery sent to its own address only, so for the Midea Driver to find it, set `MIDEA_SEARCH_TARGETS` to its `host:port` (several separated by commas) and the Driver searches there instead of broadcasting, and set `MIDEA_PORT` and `MIDEA_DISCOVERY_PORT` to reach it on other ports; the Driver takes these from the Hub's environment, once the Hub runs it, and nothing else should set them.

On v3 it refuses any other token with "ERROR", closing the connection, and a Driver with the wrong key can't read its answer.

### Its `/_fake/` paths

- `GET /_fake/state` says its state: power, mode, target temperature, fan speed as Midea holds it, a percentage or 102 for auto, swing, Eco, Turbo, Sleep, display, the room and outdoor temperatures, and each further function's value as Midea holds it; `POST /_fake/state` with part of it, e.g. `{"power": true, "mode": "heat", "roomTemperature": 19.5}`, changes it as its own remote, or the weather, would.
- `GET /_fake/commands` lists the commands it received, each with when, on which connection, the v3 counter it came with, and what it set, and `GET /_fake/connections` each connection made to it, with whether its handshake was accepted or refused; `DELETE` on either forgets them.
- `GET /_fake/capabilities` says its version, what it has and its target temperatures in cool, auto and heat.
- On v3, `POST /_fake/keys` with `{"token": "…", "key": "…"}`, in hex, has it expect those from then on and refuse the old ones, as a factory reset and pairing it again in Midea's app would.

## The fake Midea cloud

`pnpm --filter @media-centre/hub fake-midea-cloud` runs the fake of Midea's cloud on its own, which issues each unit it knows the token and key the fake Air Conditioner expects.

| Variable                                                | What it is                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAKE_MIDEA_CLOUD_HOST`                                 | 127.0.0.1 by default                                                                                                                              |
| `FAKE_MIDEA_CLOUD_PORT`                                 | 8090 by default                                                                                                                                   |
| `FAKE_MIDEA_CLOUD_ACCOUNT`, `FAKE_MIDEA_CLOUD_PASSWORD` | The one MSmartHome login it signs in, refusing any other                                                                                          |
| `FAKE_MIDEA_CLOUD_UNITS`                                | Each unit as `<id>:<token>:<key>`, separated by commas, as the fake Air Conditioner's `FAKE_AIRCON_ID`, `FAKE_AIRCON_TOKEN` and `FAKE_AIRCON_KEY` |

It never prints the password, the tokens or the keys. Set `MIDEA_CLOUD_URL` to its `http://host:port` for the Hub to fetch tokens and keys from it rather than from Midea's; nothing else should set it.

- `PUT /_fake/units` with `[{"id": 4102, "token": "…", "key": "…"}]` replaces the units, as after a factory reset.
- `GET /_fake/requests` lists the requests it answered, each with whether it took them or why not; `DELETE` forgets them.

The end-to-end run starts a v2 fake Air Conditioner at 127.0.0.5 and a v3 one at 127.0.0.6, with a token and key made up for the run, and the fake cloud on 127.0.0.1:18090; the Aircon tab's tests start and stop a third, on v2, at 127.0.0.7, with fewer capabilities, or to switch it off at the wall.

## The fake Lepro Light

`pnpm --filter @media-centre/hub fake-light` runs the fake Lepro Light on its own.

### Its settings

| Variable                                                               | What it is                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAKE_LIGHT_HOST`                                                      | 127.0.0.1 by default                                                                                                                                          |
| `FAKE_LIGHT_PORT`, `FAKE_LIGHT_DISCOVERY_PORT`, `FAKE_LIGHT_HTTP_PORT` | 6668, 6667 and 6669 by default, the last for its `/_fake/` paths                                                                                              |
| `FAKE_LIGHT_ID`, `FAKE_LIGHT_KEY`                                      | The id it answers to and the local key, 16 characters, it takes, both needed, which it never prints                                                           |
| `FAKE_LIGHT_CAPABILITIES`                                              | What it is: `colour`, the default, which shows white at a colour temperature or a colour, `white`, white at a colour temperature only, or `plug`, on/off only |

It refuses what isn't encrypted under its key, or is for another id.

### Running the Hub against it

It answers searches sent to its own address only, as it can't broadcast, so for the Lepro Driver to find it, set `LEPRO_SEARCH_TARGETS` to its `host:port` (several separated by commas) and the Driver asks there instead of listening for broadcasts, and set `LEPRO_PORT` and `LEPRO_DISCOVERY_PORT` to reach it on other ports; the Driver takes these from the Hub's environment, once the Hub runs it, and nothing else should set them.

### Its `/_fake/` paths

- `GET /_fake/state` says its Tuya data points' values, by number, and `POST /_fake/state` with some of them, e.g. `{"20": false}` or `{"21": "colour", "24": "00f003e803e8"}`, changes them as Lepro's LampUX app would.
- `GET /_fake/commands` lists the commands it received, each with when, on which connection, and the data points it set, and those it refused; `DELETE` forgets them.
- `GET /_fake/capabilities` says what it is and its data points.

### In tests

A test in Node may start one with `startFakeLeproLight`, whose `light()` and `setLight()` say and change its state in the Appliance's terms, on/off, brightness, colour temperature and colour, as the Lepro Driver reads them, for tests outside the protocol's boundary, which mayn't know its data points.

The end-to-end tests start the fake Lights they need themselves:

- 127.0.0.8, a colour Light;
- 127.0.0.9, a plug;
- 127.0.0.10, a white Light, which the run's Hub searches;
- and 127.0.0.11, a white Light it doesn't, to be added by its device id;

stopping one as a Light switched off at the wall, and starting it again with the same id and key.

## The fake Hive cloud

`pnpm --filter @media-centre/hub fake-hive-cloud` runs the fake Hive cloud on its own.

### Its settings

| Variable                                              | What it is                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAKE_HIVE_CLOUD_HOST`                                | 127.0.0.1 by default                                                                                                                                    |
| `FAKE_HIVE_CLOUD_PORT`                                | 8092 by default                                                                                                                                         |
| `FAKE_HIVE_CLOUD_ACCOUNT`, `FAKE_HIVE_CLOUD_PASSWORD` | The one Hive login it signs in, refusing any other                                                                                                      |
| `FAKE_HIVE_CLOUD_CODE`                                | The code it asks for as it signs in a Hub it doesn't yet trust, and the only one it takes, asking for none when it isn't set                            |
| `FAKE_HIVE_CLOUD_HEATING`                             | Its Heating zones' names, separated by commas (`Downstairs,Upstairs` by default)                                                                        |
| `FAKE_HIVE_CLOUD_RADIATOR_VALVES`                     | Its Radiator Valves, each `<name>:<its Heating zone's name>`, separated by commas (`Bedroom:Upstairs,Study:Upstairs,Living Room:Downstairs` by default) |
| `FAKE_HIVE_CLOUD_HOT_WATER`                           | `true`, the default, or `false`, whether it has the Hot Water                                                                                           |

It never prints the password, the code, a token or a key.

### How it behaves

- It checks the password's proof as Hive's sign-in service does, with the Driver's own arithmetic, so that only the real service can prove that arithmetic.
- It asks for the code within 3 minutes.
- It trusts the Hub once the Driver has registered it, asking it for no code from then on.
- It renews tokens, which last 60 minutes of its clock.
- It answers Hive's API to the tokens it issued until they are revoked.

Set both `HIVE_URL` and `HIVE_AUTH_URL` to its `http://host:port` for the Hub to use it rather than Hive's; the Hub won't start with one and not the other, and nothing else should set them.

### Its state

`GET /_fake/state` says each Heating, Radiator Valve and Hot Water's state: its kind, name, mode, target, the minutes its Boost has left, the temperature it reads, `working`, whether it is calling for heat, `online`, a Radiator Valve's battery and Heating zone, and whether it refuses changes.

`POST /_fake/state` with `{"id": "…", …}`, or a list of them, changes one as Hive's app would:

- `mode`, `schedule`, `manual` or `off`, or the Hot Water's `on`;
- `target`;
- `boost`, in minutes, with a `target`, or `null` to cancel it;
- `temperature`;
- `working`;
- `online`, `false` taking a Radiator Valve offline;
- `battery`;
- and `refusesChanges`, `true` for it to refuse every change, as Hive refuses one it won't take.

### Its other `/_fake/` paths

- `PUT /_fake/products` with `[{"kind": "heating", "name": "Heating"}]` replaces them all, so that a fake with one Heating zone and no Hot Water lists only that.
- `POST /_fake/revoke` refuses every token from then on, and with `{"devices": true}` forgets the Hub it trusted too, so that signing in asks for the code again.
- `POST /_fake/clock` with `{"minutes": 30}` moves its clock on, counting each Boost down until it goes back to the mode and target it had, as one cancelled does, and expiring the tokens and the wait for a code.
- `POST /_fake/outage` with `{"down": true}` drops every connection but those to `/_fake/` unanswered, as the internet going down, keeping its products, tokens and trusted devices, and `{"down": false}` brings it back, as Hive coming back; stopping its process forgets the tokens it issued, so that the Hub must sign in again.
- `GET /_fake/requests` lists the requests it answered, each with whether it took it and, for a change, which one it changed and what it asked, and those it dropped while down; `DELETE` forgets them.

### In tests

A test in Node may start one with `startFakeHiveCloud`.

The end-to-end run starts it at 127.0.0.1:18092, with the household's two Heating zones, three Radiator Valves and the Hot Water, asking for a code, and gives the run's Hub its address.

- The end-to-end tests of Hive in Settings sign in to it, with the code and, as a device it trusts, without, revoke its tokens for "Sign in again", and forget the Hub it trusts between tests.
- The Heating tab's take it down and bring it back, take a Radiator Valve offline, have it refuse a change, move its clock on for a Boost, and check on its requests that the Hub reads it only while the tab is open.
