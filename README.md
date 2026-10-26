# Media Centre

![Media Centre: one remote for your whole home](docs/images/social-preview.png)

**One remote for your whole home.** Control your TVs, air conditioners, lights, heating, Echo and Ring devices room by room, and play the films, shows and music on your PC or NAS on any TV, from any phone, tablet or computer on your home network. It runs on your own Hub, with no account.

https://github.com/adrianeyre/media-centre

- **The Hub** is the always-on process, on a PC or in Docker on a NAS, that serves the Remote, controls every Appliance and serves Media Files to the Player.
- **The Remote** is the web app you use from any phone, tablet or computer on the home network: a tab each for the TVs, air conditioners, lights, heating, the network, Amazon Echos, Ring doorbells and Rooms, and Settings. It meets WCAG 2.2 at Level AA, in light and dark, and installs to a home screen.
- **The Player** is the app the Hub installs on each Samsung TV to play your films, shows and music.

## Screenshots

_All screenshots show demo Rooms and the project's fake Appliances, not a real home. `pnpm screenshots` takes them again._

![The TV tab on a computer](docs/images/screenshots/desktop-tv.png)

| Air conditioners                                                | Lights                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| ![The Aircon tab](docs/images/screenshots/desktop-aircon.png)   | ![The Lights tab](docs/images/screenshots/desktop-lights.png) |
| **Heating**                                                     | **Rooms and the floor plan**                                  |
| ![The Heating tab](docs/images/screenshots/desktop-heating.png) | ![The Rooms tab](docs/images/screenshots/desktop-rooms.png)   |
| **The network**                                                 | **Amazon Echo**                                               |
| ![The Network tab](docs/images/screenshots/desktop-network.png) | ![The Amazon tab](docs/images/screenshots/desktop-amazon.png) |
| **Ring**                                                        | **Settings**                                                  |
| ![The Ring tab](docs/images/screenshots/desktop-ring.png)       | ![Settings](docs/images/screenshots/desktop-settings.png)     |

### Dark mode

| TV                                                                      | Rooms                                                                         |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| ![The TV tab in dark mode](docs/images/screenshots/desktop-tv-dark.png) | ![The Rooms tab in dark mode](docs/images/screenshots/desktop-rooms-dark.png) |

### On a tablet

<p>
  <img src="docs/images/screenshots/tablet-tv.png" alt="The TV tab on a tablet" width="260">
  <img src="docs/images/screenshots/tablet-lights.png" alt="The Lights tab on a tablet" width="260">
  <img src="docs/images/screenshots/tablet-rooms-dark.png" alt="The Rooms tab on a tablet, in dark mode" width="260">
</p>

### On a phone

<p>
  <img src="docs/images/screenshots/phone-tv.png" alt="The TV tab on a phone" width="190">
  <img src="docs/images/screenshots/phone-lights.png" alt="The Lights tab on a phone" width="190">
  <img src="docs/images/screenshots/phone-heating.png" alt="The Heating tab on a phone" width="190">
  <img src="docs/images/screenshots/phone-rooms.png" alt="The Rooms tab on a phone" width="190">
</p>
<p>
  <img src="docs/images/screenshots/phone-aircon.png" alt="The Aircon tab on a phone" width="190">
  <img src="docs/images/screenshots/phone-amazon.png" alt="The Amazon tab on a phone" width="190">
  <img src="docs/images/screenshots/phone-ring.png" alt="The Ring tab on a phone" width="190">
  <img src="docs/images/screenshots/phone-tv-dark.png" alt="The TV tab on a phone, in dark mode" width="190">
</p>

## Quick start

You need Node 26 or later, pnpm 12, and ffmpeg with ffprobe on the `PATH`.

```bash
pnpm install
pnpm start        # builds the Remote and starts the Hub on http://localhost:41080
```

Then open http://localhost:41080 in a browser. To run the Hub in Docker on a NAS, see [Getting started](docs/guides/getting-started.md#running-the-hub-on-a-nas).

## Documentation

### Guides

- [Getting started](docs/guides/getting-started.md): what you need, running the Hub on a PC or a NAS, its settings and the network
- [The Player and playback](docs/guides/player-and-playback.md): installing the Player on a TV, Routes, subtitles, music, Queues and Resume Positions
- [Air Conditioners](docs/guides/air-conditioners.md): the Midea Driver, adding units in Settings and the Aircon tab
- [Lights](docs/guides/lights.md): the Lepro Driver, adding Lights, the Lights tab, Light Scenes and a TV's film Light Scene
- [Heating](docs/guides/heating.md): the Hive Driver, signing in to Hive and the Heating tab
- [Rooms and the floor plan](docs/guides/rooms-and-floor-plan.md): the Rooms tab, naming places on the floor plan, and drawing the plan on your own image
- [The Network tab](docs/guides/network.md): every device on the home network and every Bluetooth device near the Hub, who made it, its open ports, and naming each
- [The Amazon tab](docs/guides/amazon.md): every Echo on your Amazon account, with everything the Alexa app allows, through Amazon's cloud
- [The Ring tab](docs/guides/ring.md): your Ring doorbell, cameras and chimes, with snapshots, live video, events and recordings, through Ring's cloud
- [Versions and releases](docs/guides/versions-and-releases.md): update notices, the Changelog and semantic-release
- [Testing](docs/guides/testing.md): the gate that must pass before work lands
- [The fake Appliances](docs/guides/fakes.md): the fake Samsung TV, Midea Air Conditioner, Midea cloud, Lepro Light and Hive cloud

### Setup and processes

- [Running the Hub in Docker](docs/setup/running-the-hub-in-docker.md)
- [Installing the Player with Tizen Studio](docs/processes/installing-the-player-with-tizen-studio.md)
- [Setting up Tizen Studio and the VS Code extension](docs/processes/setting-up-tizen-studio-and-the-vs-code-extension.md)
- [Running Sandcastle](docs/processes/running-sandcastle.md)

### Requirements and decisions

The packages are `hub`, `remote`, `player` and `shared`; the words they use are in [`GLOSSARY.md`](GLOSSARY.md).

- Product requirements: [Media centre](docs/product-requirements-document/media-centre.md), [Aircon](docs/product-requirements-document/aircon.md), [Lights](docs/product-requirements-document/lights.md), [Heating](docs/product-requirements-document/heating.md), [Network](docs/product-requirements-document/network.md), [Amazon](docs/product-requirements-document/amazon.md), [Ring](docs/product-requirements-document/ring.md), [Rooms](docs/product-requirements-document/rooms.md)
- [Architectural decision records](docs/architectural-decision-record/):
  - [0001 The Hub mediates between the Remote and the Appliances](docs/architectural-decision-record/0001-hub-mediates-between-remote-and-appliances.md)
  - [0002 The Hub serves media over HTTP](docs/architectural-decision-record/0002-hub-serves-media-over-http.md)
  - [0003 The Remote reaches the Player only through the Hub](docs/architectural-decision-record/0003-remote-reaches-player-only-through-hub.md)
  - [0004 A fake Samsung TV stands in for real TVs](docs/architectural-decision-record/0004-a-fake-samsung-tv-stands-in-for-real-tvs.md)
  - [0005 The Player uses Samsung AVPlay](docs/architectural-decision-record/0005-the-player-uses-samsung-avplay.md)
  - [0006 The Hub converts what the TV cannot play](docs/architectural-decision-record/0006-the-hub-converts-what-the-tv-cannot-play.md)
  - [0007 Appliances are controlled locally](docs/architectural-decision-record/0007-appliances-are-controlled-locally.md)
  - [0008 The Remote is built with Preact](docs/architectural-decision-record/0008-the-remote-is-built-with-preact.md)
  - [0009 Midea tokens are fetched once from the cloud](docs/architectural-decision-record/0009-midea-tokens-are-fetched-once-from-the-cloud.md)
  - [0010 Hive is controlled through its cloud](docs/architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)
  - [0011 Echo devices are controlled through the Alexa app's private API](docs/architectural-decision-record/0011-echo-devices-are-controlled-through-the-alexa-apps-private-api.md)
  - [0012 The network is found by scanning it from the Hub](docs/architectural-decision-record/0012-the-network-is-found-by-scanning-it-from-the-hub.md)
  - [0013 Bluetooth is heard through Windows' own API](docs/architectural-decision-record/0013-bluetooth-is-heard-through-windows-own-api.md)
  - [0014 Ring devices are controlled through the Ring app's private API](docs/architectural-decision-record/0014-ring-devices-are-controlled-through-the-ring-apps-private-api.md)
- [Changelog](CHANGELOG.md)
