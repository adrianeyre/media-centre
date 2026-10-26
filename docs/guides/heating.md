# Heating

The Hub controls the home's Hive Heating zones, Radiator Valves and Hot Water through Hive's cloud. The requirements are in the [Heating PRD](../product-requirements-document/heating.md).

![The Heating tab](../images/screenshots/desktop-heating.png)

## The Hive Driver

The Hive Driver, in `packages/hub/src/drivers/hive/`, controls the home's Heating zones, Radiator Valves and Hot Water through Hive's cloud, the one exception to controlling Appliances locally, as Hive has no local API ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)).

### Signing in

- It signs in once with the Hive account owner's email and password, which it uses for that alone and never keeps, and the code Hive texts, answering that it needs one as an answer of its own, not a failure.
- It registers the Hub with Hive as a trusted device, so that the code is asked for once.
- It keeps only Hive's tokens and the trusted device's keys, in the credentials it hands the Hub, renewing the tokens itself before they expire, or once Hive refuses them.

### What it lists and controls

It lists every Heating, Radiator Valve and Hot Water on the account by Hive's names, with the controls each has:

- a Heating's and a Radiator Valve's target, in half degrees within the range Hive reports, their modes, Schedule, Manual and Off, and a Boost to a target for 15 minutes to 6 hours;
- and the Hot Water's modes, Schedule, On, which is Hive's "Manual", and Off, and a Boost by duration only.

It reads what every one is doing in one request, with the controls each has, the mode, the target, the Boost with the time it has left, the temperature it reads, whether it is calling for heat, whether Hive can reach it, and a Radiator Valve's low battery and its Heating zone.

It makes one change at a time, a target, a mode, a Boost, or cancelling a Boost, back to the mode and target Hive kept from before it, refusing what an Appliance doesn't take before anything is sent.

### Errors

It tells apart:

- Hive it can't reach, as when nothing answers, too late, or with a server error, which is "Can't reach Hive";
- Hive refusing the Hub's tokens, `HiveAuthError`, for Settings to offer to sign in again;
- and Hive refusing a change, `HiveRefusedError`, which says which Appliance.

A Radiator Valve Hive reports offline is its state, not a failure. Neither the password, the code, a token nor a key is ever logged.

### Where it comes from

It is written from pyhiveapi, the library Home Assistant's Hive integration uses: signing in to Hive's AWS Cognito user pool by SRP, in `cognito.ts`, the one module that speaks to it, which has never been tried against Hive itself, and Hive's API, in `beekeeper.ts` and `nodes.ts`; each says what of it is uncertain, which the real Hive may correct, in the fake first, then the Driver.

## Signing in to Hive in Settings

Settings, under Hive, which says that Hive needs the internet, signs the Hub in to Hive, once, for the whole home: the Hive account owner's email and password, then, if Hive asks for one, the code it texts, within a few minutes.

The password goes to the Hub once, at `POST /api/hive/sign-in`, leaving its field as it is sent, and the code at `POST /api/hive/code`; the Hub uses them to sign in alone, and never keeps nor logs them, nor the email. Between the two, Hive's sign-in session is held in the Hub's memory alone.

The Hub keeps one sign-in, in its database, as the Hive Driver's credentials, Hive's tokens and the keys of the device Hive trusts the Hub as, never the password, and never sends them to the Remote nor logs them (FR-67a); Hive asks a Hub it trusts for no code again.

### Hive's Appliances

Every Heating, Radiator Valve and Hot Water on the account then appears by itself, with Hive's own name, in "No room", and is renamed and given a Room as any Appliance is, in the same section, through the Edit beside each, which the section says is how. They are listed there as soon as the Hub answers with them, not only once Hive has said whether it still accepts the Hub's tokens, which takes a few seconds and may fail, as renaming one and giving it a Room needs nothing of Hive.

Each is an ordinary Appliance, at `/api/appliances`, with Hive's id for it as its `serialNumber`, so that signing in again finds the same ones, keeping their names and Rooms, and one added to the account in Hive's app appears as Settings next opens; none is removed on its own, as Hive would list it again.

### Signing in again, and signing out

As Settings opens, the Hub asks Hive, at `GET /api/hive`, whether it still accepts the tokens; once it doesn't, as happens now and then on Hive's own schedule, Settings says so, with "Sign in again", which asks for the email and password once more, and the code if Hive has forgotten the Hub as a device, and restores control. Where it can't reach Hive, it says "Can't reach Hive".

Sign out, at `DELETE /api/hive`, once asked to make sure, has the Hub forget its tokens and device keys, overwriting them in its database, and removes every Heating, Radiator Valve and Hot Water, and their places in Rooms, and so the Heating tab's widgets.

The sign-in and Hive's Appliances survive a restart, and nothing asks for the password then. Only the fake Hive cloud has proved any of it; signing in to the real Hive, with its code, and a restart after it, are on the Heating PRD's manual checklist.

## The Heating tab

The Heating tab, after the Lights tab, is always there: until the Hub is signed in to Hive, it says "Not signed in to Hive", with Open Settings, which opens Settings on Heating, where Hive is signed in to.

### Widgets

Like the TV, Aircon and Lights tabs, it is a board of widgets (FR-58), dragged, resized, hidden and put back through each one's grip, its grip's menu and arrow keys, and the Widgets menu, three side by side on a desktop, two on a tablet and one on a phone, each Remote remembering its layout under `media-centre:heating-widgets`. The widgets are:

1. the Whole home first;
2. then each Heating, the Hot Water, and each Radiator Valve as a widget of its own, named Room · Name, by Room, in Room order, with "No room" last, a Room with more than one led by its Room-wide target's widget, named Room · Radiator Valves.

As Hive has no Rooms, and each of its Appliances starts in "No room", the tab says how many have no Room yet while any hasn't, with "Give each a Room", which opens Settings on Heating, where each is given one; like every other tab's, its widgets have no Room control of their own.

### Heating zones and Radiator Valves

A Heating and a Radiator Valve each have:

- the temperature it reads;
- its target, by a step down and up in half degrees within the range Hive reports;
- its mode, Schedule, Manual or Off;
- and Boost…, which asks in a dialog for a temperature and how long, in the steps Hive's app offers, 15 minutes to 6 hours, after which the widget shows the Boost's target and time left, counting down between reads of Hive, and Cancel Boost, back to the mode and target it had.

A Heating says whether it is calling for heat; a Radiator Valve names its Heating zone, as the Hub names that Heating, and warns of a low battery.

### The Hot Water

The Hot Water has its mode, Schedule, On or Off, whether it is heating the water, and a Boost by duration alone.

### The Whole home and Room-wide targets

- The Whole home sets every Heating's target, mode or Boost, and its Boost, and cancelling it, is every Radiator Valve's too, never the Hot Water's.
- A Heating zone's Boost, and cancelling it, is every Radiator Valve's in that zone too, as Hive reports each valve's zone, read as the Boost is asked for, any valve that didn't take it named; each Boost dialog says so.
- The Whole home shows their value where they agree and "Mixed" where they don't, a step from "Mixed" going from between them.
- A Room with more than one Radiator Valve has a Room-wide target in its own widget, which sets every one in the Room and none outside it.

The Whole home is one request to the Hub, at `POST /api/heating/whole-home`, and a Room-wide target one, at `POST /api/heating/rooms/<id>/target`, which make the change of each at once and answer once each has taken it or not, the widget naming any that didn't. A change to one is `POST /api/heating/<id>`.

### What the tab shows

The tab shows what Hive reports, never what was asked for: a change shows "Sending to Hive…" until the Hub answers with what Hive then reports, and one Hive refuses says "Hive refused this", the control showing what Hive reports.

The tab reads every Heating, Radiator Valve and Hot Water, with the controls each has, at `GET /api/heating`, which the Hub answers by reading Hive then, in one request, keeping nothing between, every 30 seconds while the tab is open and once after each change, so that every Remote sees the same, and Hive's app's changes, and Hive is read only while a Remote has the tab open.

### When Hive can't be reached

- Where Hive can't be reached, the tab says "Can't reach Hive", with every control disabled and showing no value, and goes on asking, so that it comes back by itself.
- Where Hive no longer accepts the Hub's tokens, it says the same, with the way to Settings, where "Sign in again" is.
- A Radiator Valve Hive reports offline says "Can't reach this Radiator Valve", with its controls disabled, until Hive reports it back.

Only the fake Hive cloud has proved it; on the real Hive, each control, the Whole home, a Room-wide target, the temperatures, the internet going down and a Radiator Valve with its battery out are on the Heating PRD's manual checklist.

## Testing against fakes

The fake Hive cloud is described in [The fake Appliances](fakes.md#the-fake-hive-cloud).
