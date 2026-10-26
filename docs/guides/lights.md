# Lights

The Hub controls Lepro's Lights on the home network, with no cloud, by Room, with Light Scenes and a film Light Scene for each TV. The requirements are in the [Lights PRD](../product-requirements-document/lights.md).

![The Lights tab](../images/screenshots/desktop-lights.png)

## The Lepro Driver

The Lepro Driver, in `packages/hub/src/drivers/lepro/`, controls Lepro's Lights on the home network, with no cloud.

### The protocol, and what isn't known yet

No one has yet looked at how a real one is reached (the spike, #48), so it is written on the reading that they are Tuya modules inside, as the Lights PRD's open question 1 has it, speaking Tuya's local protocol v3.3: on TCP port 6668, in frames encrypted under each Light's id and local key, found by the announcements each broadcasts to UDP ports 6666 and 6667.

All of that is in one module, `tuya.ts`, behind an interface of its own, `transport.ts`, which the Driver alone uses, so that if the spike finds they speak something else, only that module and the fake Lepro Light change. `tuya.ts` says what of the protocol is uncertain, which a real Light may correct, in the fake first, then there.

### Capabilities

The Driver reads which controls each Light has as the Appliance's capabilities, so that a smart plug has on/off alone:

- on/off;
- brightness;
- colour temperature, with the range it shows;
- and colour.

It reads and sets each, in percent, kelvin and hue and saturation, refusing what a Light hasn't got before anything is sent.

A Light that refuses its id and key fails with an error of its own, which the Hub tells apart from one it can't reach, and neither the id nor the key is ever logged nor in what the Driver answers.

## Adding a Light in Settings

Settings, under Lights, has "Find Lights", which finds the Lights on the Hub's subnet by their announcements, saying of each already added which Light it is, and "Add a Light by address", which a found one is added through, named and given a Room as any Appliance, and renamed, moved and removed the same way.

A Light answers only to the local key its maker issued it, so adding one takes that key, and, for one the Hub didn't find, its device id too, both typed in by hand: on the reading above, they are a Tuya module's, which Lepro's LampUX app doesn't show, and where to read them from a real Light is for the spike (#48) to say.

The Hub keeps the Light once it has answered to them, and, as a TV's pairing token, never sends them to the Remote nor logs them; the key's field is a password field, emptied once the key is sent. One that later refuses its key, as after it is paired again in LampUX, says so in Settings, to be removed and added again with its new key.

The Hub reads and changes each Light's state at `/api/appliances/<id>/state`, and the controls it has at `/api/appliances/<id>/capabilities`, where one it can't reach says so, as for an Air Conditioner.

### When "Find Lights" finds none

Each search writes what it did to the Hub's log, each line starting "Find Lights:": the UDP ports it listened on, each datagram that arrived and why it wasn't a Light, and how many it heard in all. Adding a Light by address logs the same, each line starting "Add the Light at". Neither ever logs a Light's id or key.

- **"Heard nothing at all"**: nothing arrived. A firewall on the Hub's machine may be dropping it: on Windows, a network set to Public blocks what arrives unasked, so set the home network to Private, or allow Node.js inbound UDP on ports 6666, 6667 and 7000. Otherwise, no Tuya module announced itself on the Hub's subnet.
- **"a Tuya module on protocol v3.4"**, or **"v3.5"**: a module the Hub heard but doesn't speak, as it speaks v3.3 alone.
- **"bytes that aren't a Tuya frame"**: something else on the network, with its first bytes, which may be how Lepro's Lights announce themselves if they aren't Tuya modules inside, for the spike (#48) to look at.

## The Lights tab

The Lights tab, between the Aircon tab and the Heating tab, lists every Light by Room, in Room order, with "No room" last.

### Widgets

Like the TV and Aircon tabs, it is a board of widgets (FR-58):

- each Room has a widget of its own, named "Room Lights", across the grid, with its Room-wide On and Off and brightness;
- and beneath it a widget for each of its Lights, named Room · Name, three side by side on a desktop, two on a tablet and one on a phone.

Each is dragged, resized, hidden and put back through its grip, its grip's menu and arrow keys, and the Widgets menu, and each Remote remembers its layout under `media-centre:lights-widgets`.

### A Light's controls

A Light's controls are the ones it reports it has, and no other:

- on/off;
- its brightness;
- and, where it has them, white at a colour temperature, within its range, and colour, as a hue and a saturation, with White and Colour to choose between for one that has both;

so a smart plug shows on/off alone. Each change shows at once and goes to the Hub, only the latest once the one before has gone, then the tab shows what the Light says it is doing.

### Room-wide controls and All off

A Room's On, Off and brightness, and the tab's All off, beside its name, are each one request to the Hub, at `POST /api/appliances/lights`, which makes the change of every Light in the Room, or in the home, at once, and answers once each has answered or not; the tab shows each Light's answer in its own widget, and names those that didn't answer.

A Room's brightness is for the Lights in it that dim, which it switches on too, and leaves a plug as it is; its slider shows theirs, as near as one value can.

### Refreshing, and Lights that don't answer

The tab asks the Hub again every 3 seconds while it is open, as the TV and Aircon tabs do, so that every Remote shows the same, and what LampUX changes. One that doesn't answer says "Can't reach this Light", with its controls disabled and showing no value, until it answers again. With none, it says how to add one.

## Light Scenes

Each Room in the Lights tab has its Light Scenes, in a widget of its own, "Room Light Scenes", beside the Room's Room-wide widget on a desktop or tablet and beneath it on a phone, dragged, resized, hidden and put back as every widget is.

### Saving one

"Save as Light Scene", named there, has the Hub read each Light in the Room through its Driver, and keep its on/off, brightness, colour temperature and colour, as it says them, in its database, at `/api/appliances/lights/scenes`; one that doesn't answer is left out, and named.

Each Light Scene is listed under its Room, with how many Lights it holds, and recalled, renamed or deleted, once asked to make sure, from there; its name is 1 to 40 characters, unique in its Room, ignoring case.

### Recalling one

Recalling one is one request to the Hub, which sets each Light still in the Room, and in the Light Scene, back to how it was saved, at once, and answers as a Room-wide control does: each Light's widget shows its answer at once, and those that didn't answer are named.

- A Light added to the Room since it was saved is left as it is.
- One moved to another Room is skipped while it is away.
- One removed is gone from it.

A Light Scene is a Room's, so "No room" has none, and deleting a Room deletes its Light Scenes. They survive a Hub restart, and every Remote sees the same, as the tab lists them with the Lights every 3 seconds. Only the fake Lepro Light has proved that a recall sets a Light back as saved; on a real Light, that is on the manual checklist.

## A TV's film Light Scene

A TV may have a film Light Scene, one of its own Room's, chosen in Settings, under TVs, where the TV is renamed and moved: its Edit offers "Film Light Scene", "None" or each Light Scene of the Room chosen for it, and none for "No room".

The Hub keeps it with the TV in its database, as the TV's `filmLightSceneId` at `/api/appliances/<id>`, so it survives a restart, and refuses one of another Room's; a TV moved to another Room loses it, and deleting the Light Scene, or its Room, leaves the TV with none.

### What happens during a video

- When the Player on that TV starts a video, as the Hub hears from what the Player reports, the Hub reads each Light in the Room through its Driver, keeping how it is, then recalls the Light Scene.
- When the video stops, by Stop, playing to its end, the TV playing audio instead, or the Player going away, as when the TV is switched off, the Hub sets each Light it read back as it was.
- A Light a person changes through the Remote while the video plays, on its own, Room-wide, by All off or by recalling a Light Scene, is left as they leave it; a change from LampUX, which the Hub doesn't hear, isn't.
- A video following another with no stop between, as the next one chosen, or one sent again by another Route, keeps the Lights as they were before the first.
- Audio changes nothing, nor does a TV with no Room or with "None".

The Hub holds what it read only while it runs, so a Hub restarted during a video doesn't set the Lights back. Only the fake Player and the fake Lepro Lights have proved it; on a real TV and real Lights, that is on the manual checklist.

## Testing against fakes

The fake Lepro Light is described in [The fake Appliances](fakes.md#the-fake-lepro-light).
