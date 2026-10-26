# Aircon — Product Requirements Document (Phase 2)

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| **Product**   | media-centre, Phase 2                                                      |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                     |
| **Status**    | Draft                                                                      |
| **Date**      | 2026-10-21                                                                 |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                         |
| **Decisions** | [`docs/architectural-decision-record/`](../architectural-decision-record/) |
| **Issues**    | The "Phase 2" milestone                                                    |

## 1. Summary

Phase 2 adds the Remote's **Aircon** tab: every **Air Conditioner** in the home, by **Room**, with every control the unit itself has.

The household's Air Conditioners are Midea units, three or more, controlled today by Midea's MSmartHome app over Wi-Fi. Midea's Wi-Fi modules take commands on the home network over TCP port 6444. So a **Midea Driver** in the **Hub** controls them locally, as every Appliance is controlled ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)). A unit on Midea's protocol v3 needs a token and key that Midea's cloud issues, and the Hub fetches them once, when the unit is added ([ADR 0009](../architectural-decision-record/0009-midea-tokens-are-fetched-once-from-the-cloud.md)).

Everything in the parent PRD that isn't specific to TVs applies here too: Rooms and naming (§6.2), credentials kept on the Hub (FR-3, FR-4), the non-functional requirements (§7) and the testing approach (§8).

## 2. Problem

- Each Air Conditioner is controlled from Midea's app, which needs a Midea account and the internet, and names units by model rather than by Room.
- With three or more units, the phone already in hand for the TV has to switch apps to change the bedroom's temperature.

## 3. Goals

1. Every Air Conditioner in the Aircon tab, by Room, with no Midea app and with the internet down.
2. Every function a unit has is reachable from the Remote, not only a common subset.
3. Adding a unit is as easy as adding a TV: found on the network, named, given a Room.

## 4. Non-goals

- **Timers and schedules.** The unit's own timer and Midea's app cover them. Schedules stay under Later in the parent PRD.
- **Room-wide or whole-home Aircon control.** Each Air Conditioner is set on its own; Rooms only group them.
- **°F.** Temperatures are in °C.
- **An IR blaster**, or any Air Conditioner reachable only by infrared. Every unit in the home is on Wi-Fi.
- **Brands other than Midea.** Another brand is a new Driver and a revision of this PRD.
- **Control through Midea's cloud** ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).

## 5. Key scenarios

1. **Cool the bedroom.** In the Aircon tab, under Bedroom, the owner sets the Bedroom Air Conditioner to cool at 21.5° with a low fan and the display off for the night.
2. **Add the units.** In Settings, the owner taps **Find Air Conditioners**. Three units appear. For each, they sign in to MSmartHome once, name it and give it a Room. The internet then goes down, and the Aircon tab still works.
3. **A unit loses power.** The Living-room unit is switched off at the wall. Its card says "Can't reach this Air Conditioner" and its controls are disabled. When it is back, so are they.

## 6. Functional requirements

- **FR-49:** The Aircon tab lists every Air Conditioner by Room, in Room order, with "No room" last, each with its power state, mode, target temperature and the room temperature it reports. Every Remote sees the same state, refreshed while the tab is open.
- **FR-50:** An Air Conditioner's controls are the ones it reports it has. Midea units report their capabilities, and the Midea Driver turns that report into the Appliance's capabilities (NFR-6). The Remote shows each control the unit has and no other:
  - power;
  - mode: cool, heat, dry, fan and auto, each where the unit has it;
  - target temperature in °C, in 0.5° steps where the unit takes them and whole degrees otherwise, within the range it reports for each mode;
  - fan speed, as the unit's own steps and auto;
  - swing, vertical and horizontal separately where the unit swings both ways;
  - the presets Eco, Turbo and Sleep;
  - the indoor unit's display on or off;
  - the room temperature and the outdoor temperature, where the unit reports them;
  - any further function the unit reports, which the Driver exposes as an on/off or a choice, so that nothing the unit can do is reachable only from Midea's app.
- **FR-51:** Air Conditioners are added in Settings and are named and given a Room like any Appliance (parent PRD §6.2):
  1. **Find Air Conditioners** discovers Midea units on the Hub's subnet by Midea's UDP broadcast, sent to the broadcast address and to each of the Hub's network interfaces' own subnets, as a host with a VPN or virtual machines sends the broadcast address out of only one. Adding by IP address works too.
  2. A unit on Midea's protocol v3 needs a token and key before it answers locally. Settings asks once for the MSmartHome login of an account the unit is paired to (Midea no longer issues tokens to Midea Air accounts), and the Hub fetches that unit's token and key from Midea's cloud and keeps only them. It never stores the login, and never contacts the cloud again for that unit ([ADR 0009](../architectural-decision-record/0009-midea-tokens-are-fetched-once-from-the-cloud.md)). A unit on protocol v2 needs neither.
  3. The token and key are secrets like a TV's pairing token: they never appear in an API response, a log or a commit.
  4. If the unit stops accepting the token and key, e.g. after a factory reset, the Remote says so and offers to fetch them again.
- **FR-51a:** An Air Conditioner that doesn't answer shows "Can't reach this Air Conditioner", and its controls are disabled until it answers again.
- **FR-51b:** The Midea Driver is tested against a fake Midea Air Conditioner that speaks the LAN protocol, v2 and v3 with its handshake, answers discovery, reports a configurable set of capabilities, and records the commands it receives (NFR-5). A fake of the cloud's token endpoint stands in for Midea's cloud.

## 7. Delivery

The "Phase 2" milestone, in this order:

1. The Midea Driver and the fake Midea Air Conditioner.
2. Adding Air Conditioners in Settings: discovery, by IP, and the one-off token fetch.
3. The Aircon tab.
4. The manual checklist on the real units (§8).

## 8. Manual checklist (real Air Conditioner only)

- [ ] Find Air Conditioners discovers each unit; adding by IP works; the one-off token fetch succeeds, and control still works with the internet disconnected.
- [ ] Each control the unit reports changes the unit, and Midea's app shows the same change.
- [ ] The room and outdoor temperatures match the unit's own display or Midea's app.
- [ ] A unit switched off at the wall shows "Can't reach this Air Conditioner", and comes back by itself.

## 9. Open questions

1. **Model numbers.** Record each unit's model, from its label or MSmartHome's device info, and its protocol version (v2 or v3), when the manual checklist is run.
