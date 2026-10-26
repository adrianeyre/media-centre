# The Hub sits between the Remote and every Appliance

The Remote is a web page, and a web page cannot control most Appliances directly. A Samsung TV's control socket on port 8002 uses a self-signed certificate that browsers reject. Power-on needs a Wake-on-LAN UDP broadcast, discovery needs SSDP multicast, and most air conditioner and light protocols are raw TCP or UDP. None of these can be done from a browser. So the Remote only ever talks to the Hub, a small always-on Node process on the home network that serves the Remote and controls each Appliance through its Driver.

## Consequences

- The Remote is useless while the Hub is down. The Hub must therefore run on an always-on machine (the NAS by default), not a PC that sleeps.
- Pairing tokens and any other Appliance credentials live on the Hub, never in the browser.
- Adding a kind of Appliance means a Driver in the Hub and a tab in the Remote, never a direct connection from the Remote.
