# Air Conditioners

The Hub controls Midea Air Conditioners on the home network, with no cloud once each is added. The requirements are in the [Aircon PRD](../product-requirements-document/aircon.md).

![The Aircon tab](../images/screenshots/desktop-aircon.png)

## The Midea Driver

The Midea Driver, in `packages/hub/src/drivers/midea/`, controls Midea Air Conditioners on the home network by Midea's own protocol, on TCP port 6444, v2 and v3, and finds them by Midea's UDP discovery, broadcast to ports 6445 and 20086, with no cloud.

It is the only part of the Hub that knows that protocol: it turns each Air Conditioner's report of what it has into the Appliance's capabilities, and reads and sets its state in those terms. The capabilities are:

- its modes, each with its target temperatures, in °C, in half degrees where it takes them and whole degrees otherwise;
- its fan steps and auto;
- its swing up and down and side to side;
- the presets Eco, Turbo and Sleep;
- its display;
- whether it reports the outdoor temperature;
- and each further function it reports as an on/off or a choice.

A v3 Air Conditioner answers only after a handshake with the token and key Midea's cloud issues for it; one that refuses them, or answers with what the key can't read, fails with an error of its own, which the Hub tells apart from one it can't reach, and neither the token nor the key is ever logged.

The details of Midea's protocol are taken from the open-source libraries that speak it (msmart-ng, midea-local and midea-beautiful-air), and the code says where they are unsure, which a real Air Conditioner may correct, in the fake first, then the Driver.

## Adding an Air Conditioner in Settings

Settings, under Air Conditioners, has "Find Air Conditioners", which finds the Midea units on the Hub's subnet by that discovery, and "Add Air Conditioner by IP", which a found one is added through, named and given a Room as a TV is, and renamed, moved and removed the same way.

- A unit on **protocol v2** is added at once.
- A unit on **v3** answers only with a token and key from Midea's cloud, so Settings asks, in a dialog, once, for the owner's MSmartHome login, the email and password of their account in Midea's app, and sends it to the Hub with the add.

### Fetching a v3 unit's token and key

The Hub signs in to Midea's cloud with it, as the MSmartHome app does, first asking Midea's router which of its regional servers holds the account, as Europe's holds one made in the UK, then signing in there, the email without any space around it, and fetches that unit's token and key, keeps them once the unit has accepted them, and forgets the login: it is never stored, logged or sent back, and the token and key, like a TV's pairing token, are never sent to the Remote nor logged ([ADR 0009](../architectural-decision-record/0009-midea-tokens-are-fetched-once-from-the-cloud.md)).

From then on the Hub controls the unit with no internet and no account, and never asks the cloud for it again.

As Settings opens, the Hub checks each Air Conditioner still accepts its token and key; one that refuses them, as after a factory reset, says so, with "Fetch again", which asks for the login once more and fetches new ones.

### The API and the cloud

The Hub reads and changes each Air Conditioner's state at `/api/appliances/<id>/state`, where one it can't reach says so.

Midea's cloud is the one address on the internet the Hub ever asks, `https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=`, the MSmartHome app's API as msmart-ng signs in to it, in `packages/hub/src/drivers/midea/cloud.ts`, which says what of that is uncertain; no test reaches it.

## The Aircon tab

The Aircon tab, beside the TV tab, lists every Air Conditioner by Room, in Room order, with "No room" last, as the TV tab lists the TVs, each with its power, its mode, its target temperature and the room temperature it reports, and the outdoor temperature where it reports one.

### Widgets

Like the TV tab, it is a board of widgets (FR-58), one for each Air Conditioner, named Room · Name: they start side by side in Room order, with no Room starting a row of its own, three side by side on a desktop, two on a tablet and one on a phone, each tall enough for every control a unit can report, and each is dragged, resized, hidden and put back through its grip, its grip's menu and arrow keys, and the Widgets menu.

Each Remote remembers its own layout of each tab, under a key of the tab's own in the browser: the Aircon tab's `media-centre:aircon-widgets`, the TV tab's `media-centre:tv-widgets`, as it always was.

### Controls

Its controls are the ones the unit reports it has, which the Hub reads through its Driver at `/api/appliances/<id>/capabilities`, and no other:

- power;
- its modes;
- the target temperature, by a step down and up and a slider, within the current mode's range, in the unit's half or whole degrees, none in fan mode;
- its fan steps and auto;
- swing up and down and side to side;
- Eco, Turbo and Sleep, at most one at a time;
- its display;
- and each further function, an on/off as a button that stays pressed, a choice as a list.

Each change shows at once and goes to the Hub, only the latest once the one before has gone, then the tab shows what the unit says it is doing. The tab asks the Hub again every 3 seconds while it is open, as the TV tab does, so that every Remote shows the same, and what the unit's own remote changes.

### When a unit doesn't answer

- One that doesn't answer, as one switched off at the wall, says "Can't reach this Air Conditioner", with its controls disabled and showing no value, until it answers again.
- One that refuses the Hub's token and key says so, with the way to Settings, where "Fetch again" is.
- With none, it says how to add one.

## Testing against fakes

The fake Midea Air Conditioner and the fake of Midea's cloud are described in [The fake Appliances](fakes.md#the-fake-midea-air-conditioner).
