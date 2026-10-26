# Rooms — Product Requirements Document

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| **Product**   | media-centre                                                               |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                     |
| **Status**    | Built                                                                      |
| **Date**      | 2026-10-24                                                                 |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                         |
| **Decisions** | [`docs/architectural-decision-record/`](../architectural-decision-record/) |
| **Guide**     | [Rooms and the floor plan](../guides/rooms-and-floor-plan.md)              |

## 1. Summary

A **Room** is a named place in the home that everything is grouped by. This PRD gathers what the Remote does with Rooms: the requirements the parent PRD set out, the Rooms tab and its floor plan, and, newly, putting any **Network device** or **Echo** in a Room, and the Rooms tab listing them.

The **Rooms** tab is always the last tab. Settings, where Rooms are made, renamed, ordered and deleted, is opened from the cog in the app bar, no longer from a tab.

## 2. Problem

- Each tab showed its own Appliances by Room, but nowhere showed everything in one room together.
- A device that isn't an Appliance, such as a NAS, a printer or an Echo, had no Room at all.

## 3. Goals

1. One place, the Rooms tab, to see and control everything in a room.
2. Any device the Remote knows of placed in a Room, from wherever it is shown, with a new Room made there and then.
3. One Room kept in one place: an Appliance's is the Appliance's, wherever it is changed from.

## 4. Non-goals

- **A device in more than one Room**, and Rooms within Rooms.
- **Controlling a Network device from the Rooms tab.** It is listed there; it is controlled, if at all, from its own tab.

## 5. Key scenarios

1. **The lounge.** On the Rooms tab, the person taps the lounge on the floor plan: its TV, Air Conditioner and Lights, with their controls, and a Devices card listing the Echo and the NAS put there from the Network and Amazon tabs.
2. **A new room.** On the Network tab, the printer's Room picker offers "New room…". The person names it "Office", and the printer is in it.
3. **Moving an Appliance.** On the Network tab, the person puts the TV in the Bedroom. The TV moves on every tab, as if moved in Settings.

## 6. Functional requirements

These, from the parent PRD and the phases since, still hold: **FR-7** (Settings makes, renames and deletes Rooms, 1 to 40 characters, unique ignoring case), **FR-8**, **FR-9** (Room · Name), **FR-10** (Room order, shared by every tab), and the Rooms tab and floor plan, as the [guide](../guides/rooms-and-floor-plan.md) describes them. New with this PRD:

- **FR-92:** Each device on the Network tab, home network or Bluetooth, and each Echo on the Amazon tab, has a Room picker: "No room", each Room in Room order, and "New room…", which names a Room, makes it as Settings would, and puts the device in it. Its Room is shown beside it. What the Hub refuses, such as a Room's name already taken, is said beside the picker.
- **FR-93:** A device that is an Appliance is moved to the Room as Settings moves it, so it moves on every tab, and is refused as Settings would refuse it. Any other device is kept in the Room in the Hub's database, by its MAC address, IP address, Bluetooth address or Echo's serial number, through restarts; deleting the Room leaves it in "No room".
- **FR-94:** Each Room on the Rooms tab lists, in a **Devices** card beside its Appliances, every device put in it that isn't an Appliance: by its name, or what it was last seen as, with whether it is on the network, Bluetooth, Amazon or Ring, its address and its maker. The Hub keeps what each was last seen as, so a Room lists it whether or not it was scanned since. A Room with devices but no Appliances shows them. A Hub that can't list them still shows the Room's Appliances.
- **FR-107:** Each Echo and Ring device put in a Room shows in it on the Rooms tab, beside its Appliances, with every control it has on the Amazon or Ring tab (FR-84 to FR-89, FR-100 to FR-104), while the Hub is signed in to its account; it is then not listed in the Devices card as well. Signed out, it is listed there, as FR-94 says. So every TV, Air Conditioner, Light, Hive Appliance, network and Bluetooth device, Echo and Ring device put in a Room shows in it.
- **FR-108:** A Room on the Rooms tab, under the floor plan, is a board of widgets (FR-58), as the other tabs are: each TV, Air Conditioner, Light, Echo and Ring device in it a widget, Hive's together one, Heating, as they are read from Hive together, and its other devices one, Devices. Each Room's board is its own, remembered by each Remote.
- **FR-95:** The tabs are, in order: **TV**, **Aircon**, **Lights**, **Heating**, **Network**, **Amazon**, and **Rooms**, always last. This replaces FR-6's list. _Ring now comes before Rooms: see the [Ring PRD](./ring.md)'s FR-106._
- **FR-96:** Settings is no tab: the cog in the app bar opens it, as each tab's "Open Settings" does, and the Remote reopens on it if it was left there.

## 7. Non-functional requirements

Those of the parent PRD apply. In particular, accessibility: the tab bar's labels fit, or end in an ellipsis, on a phone 320 pixels wide, and the Rooms tab and each Room picker meet WCAG 2.2 AA in both themes.

## 8. Testing

- Rooms for devices and Appliances, refusals, deleted Rooms and the list for the Rooms tab, through the Hub's API.
- The Room picker, making a Room, and the Rooms tab's Devices card, against fakes of the Hub's API.
- End to end: a device put in a new Room from the Network tab, then listed in that Room on the Rooms tab; the tab order and Settings from the cog.
