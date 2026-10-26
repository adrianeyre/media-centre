# Appliances are controlled locally, by the Hub's own Drivers

Every Appliance is controlled over the home network by a Driver inside the Hub, with no manufacturer cloud and no other home-automation system in between. The Remote must keep working with the internet down and without any manufacturer account. Where a manufacturer offers a cloud API that reaches more than its local one, that cloud API may later be added as an opt-in, off by default, and nothing may depend on it.

For Samsung TVs this has a visible cost. There is no local or public API for the TV Menu. Locally, the Hub can send any remote key, launch and close apps, type text, read and set absolute volume and mute (UPnP), and read device info and app status. Picture mode, sound mode, sound output and input source can only be read and set directly through Samsung's SmartThings cloud. So settings beyond the local API are reached through TV Menu mode, where the Remote drives the TV's own menu with key presses.

## Considered Options

- **Samsung SmartThings for TVs**: deferred as an opt-in. It needs a linked Samsung account and the internet.
- **Home Assistant as the back end for Air Conditioners and Lights**: rejected. It already supports thousands of Appliances, but it is a second always-on system to install and keep updated, and its own UI competes with the Remote. If an Air Conditioner or Light turns out to have no usable local API, this decision is revisited for that brand alone, not reversed wholesale.

## Consequences

- The Remote cannot show a TV's current picture mode, sound mode or input source without SmartThings. It can only cycle them with keys.
- The hidden TV service menu is never exposed, and the Samsung TV Driver refuses to send its key sequences, because they can misconfigure or brick a TV.
- Wake-on-LAN, SSDP and UPnP only work on the Appliances' own subnet, so the Hub must share a subnet with the Appliances it controls.
- Each new brand costs a Driver and a fake of that Appliance for tests ([ADR 0004](./0004-a-fake-samsung-tv-stands-in-for-real-tvs.md)).
