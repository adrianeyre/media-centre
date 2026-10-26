# Ring — Product Requirements Document

|               |                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Product**   | media-centre                                                                                                       |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                                                             |
| **Status**    | Built; untried against a real Ring account                                                                         |
| **Date**      | 2026-10-25                                                                                                         |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                                                                 |
| **Decisions** | [ADR 0014](../architectural-decision-record/0014-ring-devices-are-controlled-through-the-ring-apps-private-api.md) |
| **Guide**     | [The Ring tab](../guides/ring.md)                                                                                  |

## 1. Summary

The Remote's **Ring** tab shows every **Ring device** on the owner's Ring account (their video doorbell, cameras and chimes), each a widget, with what the Ring app lets the Hub do with it: who rang and when, the latest snapshot, live video, recorded events, the light, siren and motion detection, and a chime's volume and sounds.

Ring offers no way to reach its devices on the home network, nor an API for owners. The only way is the Ring app's own cloud API, which Ring neither documents nor offers to others. The Hub reaches it through the open-source `ring-client-api` library ([ADR 0014](../architectural-decision-record/0014-ring-devices-are-controlled-through-the-ring-apps-private-api.md)). It is opt-in, off until the owner signs in to Ring on the tab, which says that it needs the internet and that Ring may change it.

## 2. Problem

- Seeing who is at the door, or checking the garden camera, means finding a phone and the Ring app, apart from everything else in the home.
- The doorbell, its chime and the cameras can't be put in Rooms with the rest of the home's devices.

## 3. Goals

1. Every Ring doorbell, camera and chime on the account in one tab, each with the controls the Ring app's API offers.
2. Live video in the Remote, without the video passing through the Hub.
3. Ring devices placed in Rooms, as every other device can be.
4. The password used once and never kept, the token kept and refreshed, and the rest of the Remote unaffected by Ring.

## 4. Non-goals

- **Ring Alarm**: arming, disarming and its sensors. It is security equipment, and a mistake there has real cost. Under Later.
- **Talking through the doorbell.** Live view only receives. Sending the Remote's microphone needs HTTPS for the Remote, which it hasn't got.
- **Notifications on a Remote that isn't open.** A widget says the doorbell rang only while the tab is shown. Push to a phone needs a service worker and HTTPS.
- **Changing motion zones, schedules, modes and ringtones.** They are the Ring app's.
- **Downloading recordings to the Hub's Media Sources.** Under Later.
- **More than one Ring account.**

## 5. Key scenarios

1. **Signing in.** On the Ring tab, the owner enters their Ring email and password and taps "Sign in to Ring". Ring texts a code. They enter it, and the tab shows their doorbell, garden camera and chime.
2. **Someone at the door.** The doorbell rings while the owner is on the Remote. The Front Door widget says "Someone rang the doorbell at 14:02". They tap "Watch live" and see the porch.
3. **The parcel.** Later, they open Recent events on the doorbell's widget, find the motion at 11:20 and tap "Watch".
4. **The garden at night.** They turn the floodlight camera's light on, look at its snapshot, and turn it off.
5. **The baby's asleep.** They turn the hallway chime's volume down to 2 and play its doorbell sound to check.

## 6. Functional requirements

- **FR-97:** The Ring tab, between Amazon and Rooms, signs the Hub in to Ring with the account's email address and password, then the two-step code Ring sends, as Ring says where it sent it. A wrong code is asked for again. The Hub uses the password once and never keeps it, nor logs it. Before signing in, the tab says that it needs the internet and that Ring may change it.
- **FR-98:** The Hub keeps only the token Ring issues, in its database, replaced as Ring refreshes it, signs in with it again after a restart, and never logs it (FR-4). "Sign out" forgets it.
- **FR-99:** Signed in, each doorbell, camera and chime on the account is a widget (FR-58), with its name, model, whether it is online, its battery and whether it is charging where it has one, and its Room. Each reads Ring every 5 seconds while it is shown.
- **FR-100:** A doorbell's widget says the doorbell was pressed, and when, for two minutes after Ring says so.
- **FR-101:** A doorbell's or camera's widget shows its latest snapshot, fetched by the Hub, and a new one on asking. "Watch live" shows its live video, which the browser receives from Ring itself: the Hub only hands Ring the browser's WebRTC offer and the browser Ring's answer. "Stop live view" ends it at Ring.
- **FR-102:** Each lists its last 10 events, newest first: the doorbell pressed, motion, live view, or another event, with when. A recorded event can be watched in the widget, from Ring, where the account's Ring Protect plan keeps recordings.
- **FR-103:** Each switches its light and siren, where it has them, and its motion detection, as Ring reports them, and shows its Wi-Fi signal.
- **FR-104:** A chime's widget sets its volume, from 0 to 11, and plays its doorbell and motion sounds.
- **FR-105:** Each Ring device can be put in a Room, or a new one made there and then (see the [Rooms PRD](./rooms.md), FR-92); the Rooms tab lists it as a Ring device. What Ring refuses, the widget says, as Ring says it.
- **FR-106:** The tabs are, in order: **TV**, **Aircon**, **Lights**, **Heating**, **Network**, **Amazon**, **Ring**, and **Rooms**, always last. This replaces the Rooms PRD's FR-95.

## 7. Non-functional requirements

Those of the parent PRD apply, but for being local: this is the third exception to [ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md), after Hive's and Amazon's. In particular:

- **Secrets (FR-4):** the token is kept on the Hub only, never sent to the Remote and never logged. The password and code pass through the Hub once, to Ring, and are kept only in memory, only until signed in. The library's own log is silenced.
- **Boundary (NFR-6):** only the Ring Driver knows the Ring app's API; a test fails if anything else names it.
- **Video:** live video goes from Ring to the browser, never through the Hub. The browser asks a public STUN server for its own internet address so that Ring's video can reach it.
- **Accessibility:** WCAG 2.2 AA, checked by axe in both themes, signed out, asking for the code, and signed in.

## 8. Testing

- Ring's answers, read as the Driver reads them, from samples shaped as the library's own types describe them.
- The Hub's Ring: signing in with and without a code, a wrong code and a wrong password, keeping and resuming the token, every action and its checks, snapshots, recordings, live view's offer, Rooms and signing out, against the fake Ring Driver. The password, code and token are checked never to be logged.
- The tab against a fake of the Hub's API, with a fake of the browser's WebRTC, and end to end against the fake Ring (`RING_FAKE`). No test reaches Ring.
- Untried against a real account: what Ring really answers, and live video in a real browser, are checked only when the owner first signs in.

## 9. Later

- Ring Alarm's mode, as a widget, with a confirmation to disarm.
- Recordings downloaded to a Media Source, to play on a TV.
- The doorbell ringing shown on every Remote, and on the TV through the Player.
