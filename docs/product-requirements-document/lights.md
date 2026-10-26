# Lights — Product Requirements Document (Phase 3)

|               |                                                                            |
| ------------- | -------------------------------------------------------------------------- |
| **Product**   | media-centre, Phase 3                                                      |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                     |
| **Status**    | Draft                                                                      |
| **Date**      | 2026-10-21                                                                 |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                         |
| **Decisions** | [`docs/architectural-decision-record/`](../architectural-decision-record/) |
| **Issues**    | The "Phase 3" milestone                                                    |

## 1. Summary

Phase 3 adds the Remote's **Lights** tab: every **Light** in the home, by **Room**. That covers bulbs, LED strips, smart plugs and wall dimmers, each with the controls it has. Each Room also gets Room-wide control, and the whole home an **All off**. A Room's Lights can be saved as a **Light Scene**, and a TV can recall one when a film starts.

The household's Lights are Lepro bulbs, controlled today by Lepro's LampUX app. Phase 3 builds the **Lepro Driver** first, after a spike finds out how LampUX bulbs can be reached on the home network. Philips Hue, TP-Link Tapo/Kasa and Tuya / Smart Life are wanted later, each as its own Driver. The plugs, strips and wall dimmers are planned, brand not yet chosen.

Everything in the parent PRD that isn't specific to TVs applies here too: Rooms and naming (§6.2), credentials kept on the Hub (FR-3, FR-4), the non-functional requirements (§7) and the testing approach (§8).

## 2. Problem

- Each brand of Light has its own app and account. The Lights in one Room can't be dimmed together unless they are all one brand.
- Dimming the Living room for a film means putting the TV remote down and opening another app.

## 3. Goals

1. Every Light in the Lights tab, by Room, from one app.
2. A Room's Lights set together, and every Light off with one tap.
3. A Room's lighting saved and recalled, and recalled by itself when a film starts.
4. Control on the home network wherever the brand allows it ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).

## 4. Non-goals

- **Schedules**, and **Scenes across tabs** (Lights, Aircon and TV together). Both stay under Later in the parent PRD. Light Scenes and a TV's film Light Scene are the one exception to the parent PRD's "no automation in Phases 1 to 3".
- **Hue, Tapo/Kasa and Tuya Drivers in this phase.** They follow the Lepro Driver as separate work.
- **Reading or recalling a brand app's own scenes.** Light Scenes are kept by the Hub.
- **Effects** such as colour loops, music sync or flashing.

## 5. Key scenarios

1. **Lights down.** In the Lights tab, the owner dims every Light in the Living room to 30% with one Room slider.
2. **Bedtime.** The owner taps **All off**, and every Light in the home goes off.
3. **Save a look.** The owner sets the Living-room Lights to a dim warm white, with the strip in blue, and taps "Save as Light Scene", naming it "Film".
4. **A film starts.** Living room · TV has "Film" as its Light Scene. The owner plays a film from Watch & Listen, and the Living-room Lights change to "Film". When the film is stopped, they go back to how they were.

## 6. Functional requirements

- **FR-52:** The Lights tab lists every Light by Room, each with on/off and, where the Light has them, brightness, colour temperature and colour. A Light's controls are the ones its Driver reports, so a smart plug shows on/off only (NFR-6).
- **FR-53:** Each Room in the Lights tab has a Room-wide on/off and brightness control that applies to every Light in that Room. A whole-home **All off** switches every Light off.
- **FR-54:** Lights are added in Settings, by discovery where the brand supports it or by address, and are named and given a Room like any Appliance (parent PRD §6.2). Control is local, by a Driver in the Hub ([ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md)).
- **FR-55:** Before the Lepro Driver is built, a spike finds out how LampUX bulbs can be controlled on the home network. If they have a local API, the Driver uses it. If they have none, the Lepro Driver alone may reach them through Lepro's cloud. That would be opt-in, off by default, marked in Settings as needing the internet, and nothing else would depend on it. The exception is recorded in an ADR of its own, as ADR 0007 requires.
- **FR-56:** A **Light Scene** is a Room's Lights as they were when it was saved: each one's on/off, brightness, colour temperature and colour. "Save as Light Scene" captures them; recalling it sets them back. Light Scenes are kept by the Hub, not in a brand's app, and can be renamed and deleted.
- **FR-57:** A TV may name one Light Scene of its own Room to recall when the Player starts a video. When playback stops, the Hub sets that Room's Lights back to how they were before. Audio doesn't trigger it, and a person changing a Light while the video plays cancels the restore for that Light.
- **FR-57a:** Each Light Driver is tested against a fake of that brand's Light (NFR-5).
- **FR-57b:** A Light that doesn't answer shows "Can't reach this Light", with its controls disabled until it answers again. Room-wide control and All off reach every Light that answers, and say which didn't.

## 7. Delivery

The "Phase 3" milestone, in this order:

1. The LampUX spike (FR-55), on a real bulb.
2. The Lepro Driver and a fake Lepro Light.
3. Adding Lights in Settings, and the Lights tab with Room-wide control and All off.
4. Light Scenes.
5. A TV's film Light Scene.
6. The manual checklist on the real Lights (§8).

## 8. Manual checklist (real Lights only)

- [ ] Each Light is found or added, and on/off, brightness, colour temperature and colour change it.
- [ ] Room-wide on/off and brightness, and All off, reach every Light.
- [ ] A Light Scene recalls the Room as saved; a film's Light Scene comes on with the video, and the Room goes back when it stops.

## 9. Open questions

1. **Does LampUX have a local API?** The spike answers it (FR-55). Some Lepro bulbs are Tuya modules inside, which would make a Tuya Driver serve them.
2. **Which brand for the plugs, strips and wall dimmers?** Not chosen yet. Choosing one the Hub already has a Driver for avoids a new one.
