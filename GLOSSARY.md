# media-centre

One home-network app for controlling the household's Appliances (TVs, air conditioners, lights and heating), grouped by Room, and for watching and listening to media stored on a PC or NAS through the TVs.

## Language

### The system

**Remote**:
The web app a person uses, on a phone or any browser on the home network, to control Appliances and choose Media Files. It has one tab per kind of Appliance.
_Avoid_: client, controller, web app, front end, dashboard

**Hub**:
The always-on process on the home network that serves the Remote, controls every Appliance and serves Media Files to the Player.
_Avoid_: server, backend, bridge, media server, gateway

**Player**:
The app installed on a TV that plays a Media File it has been sent.
_Avoid_: TV app, receiver, client

**Driver**:
The brand-specific part of the Hub that controls one make of one kind of Appliance, e.g. the Samsung TV Driver.
_Avoid_: adapter, plugin, integration

**Widget**:
One part of a tab, such as the TV tab's Keys or Now Showing, on a grid where each Remote can move it, make it bigger or smaller, or hide it.
_Avoid_: panel, card, tile

### The home

**Appliance**:
Anything in the home the Hub controls: a TV, an Air Conditioner, a Light, a Heating, a Radiator Valve or the Hot Water.
_Avoid_: device, gadget, thing

**Room**:
A named place in the home that Appliances are grouped by. An Appliance is in at most one Room.
_Avoid_: zone, area, location

**Floor plan**:
The drawing of the home the Rooms tab shows, a floor at a time, with a place for each room on it. The built-in drawing until one is drawn in the editor, on the home's own image; the Hub keeps the drawing so every Remote shows the same.
_Avoid_: map, blueprint

**Place**:
An outline on the floor plan that can be a Room: it has an id, such as `upstairs-1` or `place-3`, and no name of its own. Which Room a place is, the Hub keeps. A Room is in one place at most.
_Avoid_: zone, area, region

**Network device**:
Anything the Network tab finds: a device on the home network, or a Bluetooth device near the Hub. It may be an Appliance too, but most aren't: a NAS, a printer, a phone. It can be named and put in a Room, which the Hub keeps.
_Avoid_: host, node, client

**Echo**:
An Amazon Echo, or another Alexa device, on the owner's Amazon account, which the Amazon tab shows and controls through Amazon's cloud (ADR 0011). It can be put in a Room, but it isn't an Appliance.
_Avoid_: Alexa (the assistant, not the device), smart speaker

**Ring device**:
A Ring video doorbell, camera or chime on the owner's Ring account, which the Ring tab shows and controls through Ring's cloud (ADR 0014). It can be put in a Room, but it isn't an Appliance.
_Avoid_: doorbell (for any Ring device), Ring (the company and its account, not the device)

**TV**:
A smart TV the Hub can control.
_Avoid_: display, screen

**Air Conditioner**:
A heating or cooling unit the Hub can control. "Aircon" is its tab's label.
_Avoid_: AC, HVAC, heat pump, climate

**Light**:
A light, bulb, lamp, light strip, smart plug or wall dimmer the Hub can control.
_Avoid_: lamp, bulb, fixture

**Light Scene**:
A Room's Lights as they were when it was saved, which recalling sets them back to. Kept by the Hub.
_Avoid_: preset, mood, Scene (which, unqualified, is the later idea that spans tabs)

**Heating**:
One heating zone of the home's central heating, as its thermostat controls it: a target temperature, a mode and the temperature it reads. A home has one per zone. "Heating" is also its tab's label.
_Avoid_: thermostat, zone (on its own), climate, central heating

**Whole home**:
The control that sets every Heating at once. It has no state of its own.
_Avoid_: all zones, house mode

**Radiator Valve**:
A valve on one radiator the Hub can control, with its own target temperature and the temperature it reads.
_Avoid_: TRV, smart valve, radiator thermostat

**Hot Water**:
The home's stored hot water as its heating controls it, with a mode and a Boost. A home has one.
_Avoid_: hot water (lower case, as a thing), cylinder, DHW, tank

**Boost**:
A Heating, Radiator Valve or Hot Water set higher, or on, for a duration, after which it goes back to its mode.
_Avoid_: override, timer

### TVs

**Selected TV**:
The one TV a Remote is currently controlling. Each Remote has at most one.
_Avoid_: active TV, current device

**TV Menu**:
A TV's own on-screen settings menu, which the Remote can only drive with key presses, not read.
_Avoid_: settings page, OSD

**Now Showing**:
What the Hub can tell about what a TV is displaying: the app in front, and when it is the Player, the Media File and position. It is never a capture of the screen.
_Avoid_: screen view, mirror, live view

### Media

**Media Source**:
A folder, on the Hub's machine or mounted into it from a PC or NAS, whose Media Files the Hub can serve.
_Avoid_: library, share, drive

**Media File**:
A video or audio file in a Media Source.
_Avoid_: video, track, item, movie

**Resume Position**:
How far into a Media File playback last reached, remembered per Media File rather than per person.
_Avoid_: bookmark, progress, watch history

**Route**:
One of the four ways a Media File reaches the Player, chosen by the Hub before each play: Direct Play, Remux, Audio Conversion or Full Conversion.
_Avoid_: transcode mode, profile, pipeline

**Queue**:
The ordered Media Files a TV plays one after another, e.g. when a folder is played.
_Avoid_: playlist, which is a separate, later idea
