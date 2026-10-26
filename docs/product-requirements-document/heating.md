# Heating — Product Requirements Document (Phase 4)

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| **Product**   | media-centre, Phase 4                                                      |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                     |
| **Status**    | Draft                                                                      |
| **Date**      | 2026-10-21                                                                 |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                         |
| **Decisions** | [`docs/architectural-decision-record/`](../architectural-decision-record/) |
| **Issues**    | The "Phase 4" milestone                                                    |

## 1. Summary

Phase 4 adds the Remote's **Heating** tab: the home's central heating, hot water and radiators, as Hive controls them.

The household's heating is Hive, from British Gas: a Hive hub, two heating zones each with its own Hive thermostat and receiver, Hive Radiator Valves on the radiators, and hot water on the receiver, all controlled today by the Hive app. Three Appliance kinds come with it: a **Heating** for each zone, a **Radiator Valve** for each valve, and the home's **Hot Water**. Each can be set on its own, every zone can be set at once as the **Whole home**, and a Room's valves can be set together.

Hive has no local API. Its hub speaks Zigbee to the thermostats, receivers and valves, and only Hive's cloud exposes them, through the unofficial API that Hive's own app and the open-source clients use (Hive retired its web dashboard and IFTTT in 2024). So the **Hive Driver** reaches Hive's cloud, as the one exception for Hive alone to controlling Appliances locally ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)). It is opt-in, off until the owner signs in to Hive in Settings, which says it needs the internet, and nothing else depends on it.

Everything in the parent PRD that isn't specific to TVs applies here too: Rooms and naming (§6.2), widgets (FR-58), credentials kept on the Hub (FR-3, FR-4), the non-functional requirements (§7) and the testing approach (§8).

## 2. Problem

- Turning the heating up, boosting a cold bedroom's radiator or boosting the hot water means opening the Hive app, which names things its own way and knows nothing of the Rooms the rest of the home is arranged by.
- With two zones, setting the whole house to one temperature, or off, is two separate changes in the Hive app.

## 3. Goals

1. Every Heating, Radiator Valve and Hot Water in the Heating tab, by Room, from the one app.
2. Each zone set on its own, every zone set at once, and a Room's radiators set together.
3. Nothing but Hive's own cloud between the Hub and Hive, with the password never kept, and the rest of the Remote unaffected when the internet is down.

## 4. Non-goals

- **Editing schedules.** Hive's schedules are set in Hive's app. The Remote can follow a schedule, hold a temperature against it and boost over it, but never changes it. Schedules stay under Later in the parent PRD.
- **Holiday mode, frost protection, geolocation and Heat on Demand.** All stay in Hive's app, under Later. Heat on Demand is Hive's own rule by which a Radiator Valve asks its zone's thermostat to boost; the Remote neither sets it nor switches it.
- **Automation.** Nothing in this phase sets heating or hot water without a tap. Scenes that include heating stay under Later.
- **Pairing Hive's devices to a Zigbee coordinator on the Hub** in place of Hive's hub. It would be local, but it means leaving the Hive app and re-pairing every device, and it is a hardware project of its own ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)).
- **Brands other than Hive.** Another brand is a new Driver and a revision of this PRD.
- **°F.** Temperatures are in °C.

## 5. Key scenarios

1. **A cold evening.** In the Heating tab, the owner sets **Whole home** to 21°. Both zones go to 21° until their next scheduled change, as the Hive app would do for each.
2. **One cold bedroom.** Under Bedroom, the owner boosts the Bedroom Radiator Valve to 22° for an hour. The tab shows the hour counting down, and the valve back on its schedule afterwards.
3. **A bath.** The owner boosts Hot Water for 30 minutes.
4. **Away for the day.** The owner sets **Whole home** off. Coming home, they set it back to Schedule.
5. **The internet goes down.** The Heating tab says "Can't reach Hive" and disables its controls. The TV, Aircon and Lights tabs carry on. When the internet is back, so is the Heating tab.
6. **Signing in.** In Settings, under Hive, the owner signs in once with their Hive email and password, and the code Hive texts them if it asks for one. Both Heating zones, the Hot Water and every Radiator Valve appear, named as they are in Hive, and the owner gives each valve a Room.

## 6. Functional requirements

- **FR-62:** The Heating tab shows, as widgets (FR-58): the **Whole home** control at the top, each **Heating** zone, the **Hot Water**, and every **Radiator Valve**, each a widget of its own, by Room, in Room order, with "No room" last; a Room with more than one has its Room-wide target (FR-65) as a widget of its own, before its Radiator Valves. Every Remote sees the same state. While any Remote has the tab open, the Hub reads Hive's state every 30 seconds and after each change, so the tab shows what Hive reports, never what was asked for. Nothing is read while no Remote has the tab open, or the Rooms tab showing a Room with any of Hive's, which shows them with the same controls.
- **FR-63:** A **Heating** is one heating zone as its Hive thermostat controls it. It has:
  - a target temperature in °C, in 0.5° steps, within the range Hive reports;
  - a mode: **Schedule**, **Manual** or **Off**. A target set in Schedule mode holds until the zone's next scheduled change, as in Hive's app; in Manual mode it holds until changed. Off is Hive's frost protection, which keeps the zone above the frost temperature set in Hive's app;
  - a **Boost**: a temperature for a duration, in the steps Hive's app offers (15 minutes to 6 hours), showing the time left, and a cancel. Cancelling returns the zone to the mode and target it had before, as Hive does;
  - the temperature it reads, and whether it is calling for heat.
- **FR-64:** The **Whole home** control sets every Heating zone together: a target temperature, a mode, or a Boost, sent to each zone. It has no state of its own: it shows the zones' value when they agree and "Mixed" when they don't. It names any zone that didn't take the change (FR-68). Its Boost, and cancelling it, is every Radiator Valve's too, at the same target and for as long; its target and mode are the zones' alone. The Hot Water is not part of it.
- **FR-64a:** A Heating zone's **Boost**, and cancelling it, is made of every Radiator Valve Hive reports in that zone too, at the same target and for as long, so that the whole zone warms together. Its target and mode are its own. Any Radiator Valve that didn't take the Boost is named (FR-68).
- **FR-65:** A **Radiator Valve** is one Hive Radiator Valve on one radiator. It has a target temperature, a mode and a Boost as a Heating does (FR-63), the temperature it reads, the zone it belongs to as Hive reports it (read-only; moving it stays in Hive's app), and a low-battery warning when Hive reports one. Where a Room has more than one Radiator Valve, the Room has a Room-wide target temperature that sets them all and names any that didn't take it.
- **FR-66:** **Hot Water** is the home's stored hot water as Hive's receiver controls it, one per home. It has a mode, **Schedule**, **On** (Hive's "Manual") or **Off**, and a **Boost** by duration only (15 minutes to 6 hours), with the time left and a cancel. It is not part of the Whole home control.
- **FR-67:** Hive is added in Settings, under **Hive**, which says that Hive needs the internet. The owner signs in once with the Hive account owner's email and password (Hive's API refuses guest and partner accounts), and the code Hive texts, since Hive requires two-step verification on every account. The Hub registers itself with Hive as a trusted device, so the code is asked for once rather than at every sign-in, and keeps only the tokens and device keys Hive issues, refreshes them itself, and never stores the password ([ADR 0010](../architectural-decision-record/0010-hive-is-controlled-through-its-cloud.md)). Every Heating, Radiator Valve and Hot Water on the account then appears by itself, with Hive's own name as its default name, and each is renamed and given a Room like any Appliance (parent PRD §6.2); Hive has no Rooms, so each starts in "No room". Each is listed with an **Edit** beside it, to rename it and give it a Room, as soon as the Hub has it, whatever Hive answers as Settings opens; and while any has no Room, the Heating tab says how many, with **Give each a Room**, which opens Settings on Heating. **Sign out** removes Hive's Appliances from the Heating tab. The Heating tab is always there: until the Hub is signed in to Hive, it says "Not signed in to Hive", with **Open Settings**, which opens Settings on Heating.
- **FR-67a:** The tokens and device keys are secrets like a TV's pairing token: they never appear in an API response, a log or a commit. The password is sent to the Hub once, over the Remote's existing channel, and is never written anywhere.
- **FR-67b:** If Hive stops accepting the tokens, Settings says so and offers to sign in again. Until then the Heating tab shows "Can't reach Hive". This is expected now and then: Hive's tokens expire on a schedule Hive doesn't publish (reports range from days to months), and the open-source clients see the same.
- **FR-68:** When Hive's cloud can't be reached, the Heating tab says "Can't reach Hive" with every control disabled, and comes back by itself. A Radiator Valve that Hive reports offline (out of range, flat battery) says "Can't reach this Radiator Valve", with its controls disabled until Hive reports it back. A change Hive refuses is shown as refused, and the control shows what Hive reports.
- **FR-68a:** The Hive Driver is tested against a **fake Hive cloud** that speaks the same API, issues tokens for one account and refuses others, lists a configurable set of Heating zones, Radiator Valves and Hot Water, keeps their state, records the changes it receives, and has a test-only endpoint that changes its state as Hive's app would (NFR-5). Nothing in any test reaches Hive.

## 7. Delivery

The "Phase 4" milestone, in this order:

1. The Hive Driver and the fake Hive cloud.
2. Hive in Settings: sign in once, the Appliances appear, Rooms, sign out.
3. The Heating tab.
4. The manual checklist on the real Hive (§8).

## 8. Manual checklist (real Hive only)

- [ ] Signing in, with the code if Hive asks for one, lists both Heating zones, the Hot Water and every Radiator Valve with Hive's names.
- [ ] Each Heating's target, mode and Boost change the zone, and the Hive app shows the same change; Whole home changes both zones.
- [ ] Each Radiator Valve's target, mode and Boost change the valve, and a Room-wide target changes every valve in the Room.
- [ ] Hot Water's mode and Boost change it.
- [ ] The temperatures and the calling-for-heat state match the Hive app.
- [ ] With the internet disconnected, the Heating tab says "Can't reach Hive" and the other tabs still work; reconnected, it comes back by itself.
- [ ] A Radiator Valve with its battery out says "Can't reach this Radiator Valve", and comes back when the battery is in.
- [ ] After a Hub restart, Hive is still signed in and nothing asks for the password.

## 9. Open questions

1. **How often Hive's cloud can be read.** FR-62 says every 30 seconds while the tab is open. Hive publishes no limit; the open-source clients read every 30 to 120 seconds, in one request for everything, and none reports being refused. If Hive refuses or asks for less, the number changes here and in the Driver, and this question records what was found.
2. **Two-step verification.** _Answered in part:_ Hive requires it on every account, by text with email as the fallback, and a trusted device is not asked again (FR-67). _Still open:_ whether Hive still asks the Hub for a code after its tokens expire, which the manual checklist records.
3. **Models and counts.** Record the Hive hub, each zone's thermostat and receiver, the number of Radiator Valves and whether hot water is on the receiver, when the manual checklist is run.
4. **Which zone a Radiator Valve belongs to.** _Answered:_ Hive reports it, by the zone's name and the Heating it is linked to, so FR-65 shows it. _Still open:_ the range of target temperatures a Radiator Valve takes, which Hive doesn't state (the valve's hardware takes 5° to 35°); the Driver uses what Hive reports.
