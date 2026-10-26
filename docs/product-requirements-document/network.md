# Network — Product Requirements Document

|               |                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Product**   | media-centre                                                                                                                                                                                           |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                                                                                                                                                 |
| **Status**    | Built                                                                                                                                                                                                  |
| **Date**      | 2026-10-24                                                                                                                                                                                             |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                                                                                                                                                     |
| **Decisions** | [ADR 0012](../architectural-decision-record/0012-the-network-is-found-by-scanning-it-from-the-hub.md), [ADR 0013](../architectural-decision-record/0013-bluetooth-is-heard-through-windows-own-api.md) |
| **Guide**     | [The Network tab](../guides/network.md)                                                                                                                                                                |

## 1. Summary

The Remote's **Network** tab shows every **Network device** the Hub can find, in two views chosen at its top:

- **Home network:** every device on the Hub's subnet, with who made it, its addresses and name, the Appliance the Hub has there, and the TCP ports it accepts connections on.
- **Bluetooth:** the Bluetooth Low Energy devices near the Hub's PC, as each advertises itself.

Each device is a widget, as on the other tabs. The person can name it and put it in a Room. The Hub keeps both, and the last scan of each view, so the tab opens on what it found before, with a button to scan again.

It began as a way to find the household's Lepro lights, which "Find Lights" didn't find, and is useful for knowing what is on the network at all.

## 2. Problem

- "Find Lights" found no Lights, and nothing in the Remote said what was on the network instead.
- A device's MAC address, maker and open ports are scattered across the router's pages and the apps of each device, if they are shown at all.
- A Bluetooth-only bulb is invisible to the network, and the Remote had no way to look for one.

## 3. Goals

1. Every device on the home network, found by the Hub on asking, with what can be learnt of it without its credentials.
2. Every Bluetooth device near the Hub's PC, by what it advertises, with a hint of which might be a light.
3. Each device nameable, and placed in a Room, kept on the Hub, so every Remote shows the same.
4. Nothing scanned without asking: the last scan shown until the person asks again.

## 4. Non-goals

- **Controlling what is found.** A device found is shown, not controlled. Controlling one is a Driver's, through its own tab.
- **Scanning beyond the Hub's /24**, or for UDP services. See ADR 0012.
- **Classic Bluetooth.** Only Bluetooth Low Energy devices advertise.
- **Bluetooth on a Hub not on Windows.** See ADR 0013.
- **Intrusion detection, alerts for new devices, or history.** The tab shows the last scan, no more.

## 5. Key scenarios

1. **What is on the network?** The person opens Network and taps "Scan the network". After about 15 seconds, each device is a widget with its maker, MAC address, name and open ports.
2. **What is this one?** A device shows only "Amazon Technologies Inc." and port 55443. The person taps "Check every port", which finds two more, and names it "Kitchen Echo".
3. **The next day.** Opening the tab shows yesterday's scan at once, with no scan, and the Echo by its name. "Scan again" looks afresh.
4. **Looking for a bulb.** In Bluetooth, the person closes LampUX, switches off their phone's Bluetooth, and taps "Scan for Bluetooth devices". A device named "LEPRO-A19" is listed first, marked "Maybe a light".
5. **Where is it?** The person puts the NAS in the Study from its widget, making the Room there and then. The Rooms tab lists it under the Study.

## 6. Functional requirements

- **FR-69:** The Network tab, between Heating and Amazon, shows the **Home network** or **Bluetooth**, chosen at its top, and each Remote remembers which. Each device is a widget (FR-58), three across on a desktop, two on a tablet and one on a phone, laid out on each Remote on its own. A filter matches each device by any of its details.
- **FR-70:** "Scan the network" has the Hub scan its own /24 subnet (ADR 0012): it tries a few TCP ports at every address, takes a device that accepts or refuses one as there, adds every address its machine's ARP table has, then tries each device's common ports, those its Drivers name, and those found open on it before, and asks DNS its name. The tab shows how far it has got.
- **FR-71:** Each device on the home network shows its name, IP address, MAC address, maker (from the IEEE's registry, offline), whether its MAC address is a private one, its DNS name, how quickly it answered, the Appliance the Hub has at its address with its Room, whether it is the Hub, and each open port with what usually listens there.
- **FR-72:** "Check every port" tries all 65,535 ports of one device, showing how far it has got. The Hub remembers the ports found open, by the device's MAC address, and every scan after tries them too.
- **FR-73:** "Scan for Bluetooth devices" has the Hub listen for 20 seconds (ADR 0013). Each device heard shows its name, address and whether that address changes, its maker (from the company its advertisement names, or the IEEE's registry), how strongly it was heard, the name it advertises, when it was last heard, and the services it names. One whose name sounds like a light's, or whose maker makes smart bulbs' chips, is marked "Maybe a light" and listed first. The tab says how to make a bulb advertise.
- **FR-74:** Where the Hub can't listen for Bluetooth, the view says why and its button is disabled. Where Windows stops listening, as when Bluetooth is off, it says why.
- **FR-75:** Each device can be **named**, 1 to 40 characters, or its name forgotten. A device on the home network is named by its MAC address, or its IP address where the Hub has none; a Bluetooth device by its Bluetooth address. Its name is what it is called wherever it shows.
- **FR-76:** Each device can be put in a **Room**, or a new one made there and then (see the [Rooms PRD](./rooms.md), FR-92).
- **FR-77:** The Hub keeps the last scan of each view in its database, so the tab shows it after a restart. Each Remote also keeps the last it showed, and shows it at once as the tab opens, before the Hub answers. Nothing is scanned until the person asks.
- **FR-78:** The Hub logs each scan, each check of every port and each Bluetooth scan as it starts and ends.
- **FR-79:** Only a Driver knows its protocol's port numbers (NFR-6): each Driver names the ports its Appliances listen on, which the scan tries and names.
- **FR-80:** For tests, `NETWORK_SCAN_TARGETS` and `NETWORK_SCAN_PORTS` replace the subnet and the ports, and `BLUETOOTH_HELPER` runs a fake in place of the Bluetooth helper, so no test scans the real network or radio.

## 7. Non-functional requirements

Those of the parent PRD apply. In particular:

- **Offline (NFR-3):** makers' and services' names are in the Hub, so the tab works with the internet disconnected.
- **Accessibility:** WCAG 2.2 AA, checked by axe in both themes, for both views.
- **Load:** a scan opens about 3,000 connections over 15 seconds, at most 256 at once; "Check every port" 65,535 to one device. Neither runs without being asked.

## 8. Testing

- The scan, the port checks, names, Rooms and the kept scans, against a fake network of probes and an ARP table, through the Hub's API.
- The Bluetooth helper's output, makers and services, and the scan, through a fake helper run as its own process.
- The tab against fakes of the Hub's API, and end to end against the fake TVs and the fake Bluetooth helper.
