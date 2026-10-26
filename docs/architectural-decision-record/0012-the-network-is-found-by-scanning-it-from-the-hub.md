# The network is found by scanning it from the Hub, and the last scan is kept

The Network tab shows every device on the home network. The Hub finds them itself, on asking, by scanning its own /24 subnet. It knocks on a few TCP ports at every address, taking a device that accepts or refuses one as there. It adds every address its machine's ARP table then has, which the knocking fills. Then it tries each device's common ports, the ports its Drivers name, and those found open on it before, and asks reverse DNS its name. It names each device's maker from its MAC address, by the IEEE's registry, which it has with it (`oui-data`), so this works offline.

The last scan is kept in the Hub's database, as is each device's name, Room and the ports found open on it, so the tab shows the last scan after a restart without scanning again. Each Remote also keeps the last scan it showed, in its own storage, so the tab shows it at once, before the Hub answers.

## Considered Options

- **The router's list of devices**: the most complete, but each router has its own interface, most have no API, and the Hub can't know the owner's router.
- **Passive listening** (ARP, mDNS, SSDP and DHCP traffic): finds devices without sending anything, but only those that speak up while it listens, and needs raw sockets, so privileges the Hub doesn't run with.
- **nmap**: thorough, but a native program to install on every Hub machine, and on Windows it needs a packet capture driver too. Rejected for the Hub's own scan.
- **Scanning on every visit**: always current, but slow, and loud on the network. Rejected: the person asked for the last scan to be kept, with a button to scan again.
- **An online MAC registry**: always current, but it sends the home's MAC addresses to someone else and fails offline. Rejected for NFR-3.

## Consequences

- A device that accepts and refuses no TCP connection, and isn't in the ARP table, isn't found. UDP-only services aren't seen.
- A scan opens about 3,000 connections over 15 seconds, and "Check every port" 65,535 to one device, at most 256 at a time. Network security software may notice. Neither runs without being asked.
- The scan sees the Hub's own subnet: in Docker, only with host networking.
- A device's name, Room and remembered ports are kept by its MAC address, so they survive a new IP address; a phone's private MAC address, which it makes up for each network, is kept as it is.
- What a scan shows can be stale; the tab says when it was scanned, and "Scan again" refreshes it.
- Only a Driver knows its protocol's port numbers (NFR-6): each names its Appliances' ports, which the scan tries and names.
- `oui-data` is a dependency of the Hub, about 6 MB, loaded the first time a scan needs it.
