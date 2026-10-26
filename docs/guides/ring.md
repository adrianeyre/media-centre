# The Ring tab

The Ring tab, between Amazon and Rooms, shows every Ring doorbell, camera and chime on your Ring account, each a widget, with what the Ring app lets the Hub do with it. The requirements are in the [Ring PRD](../product-requirements-document/ring.md), and why it works as it does in [ADR 0014](../architectural-decision-record/0014-ring-devices-are-controlled-through-the-ring-apps-private-api.md).

![The Ring tab](../images/screenshots/desktop-ring.png)

## Before you sign in

Ring offers no way to reach its devices on the home network. The Hub reaches them through the Ring app's own cloud service, by the open-source `ring-client-api` library. That means:

- **It needs the internet.** Every other tab works without it.
- **Ring may change it without warning.** When it does, a widget says what Ring refused, until the Hub follows the change.

## Signing in

1. On the Ring tab, enter your Ring account's email address and password, and tap **Sign in to Ring**.
2. Ring sends you a code, by text, email or your authenticator app, and the tab says where. Enter it and tap **Sign in**.
3. The tab shows your Ring devices.

The Hub uses your password once, to sign in, and never keeps or logs it. It keeps only the token Ring gives it, in its database, replaced as Ring refreshes it, and signs in with it again after a restart. **Sign out**, at the top of the tab, forgets it. Ring lists the Hub among your account's signed-in devices as "media-centre Hub"; removing it there signs the Hub out too.

## Each device

Each device is a widget, dragged, resized, hidden and put back as on the other tabs, remembered on each Remote under `media-centre:ring-widgets`. Each shows its name, model, whether it is online, its battery where it has one, and its Room, with:

- **Room**: put it in a Room, or make one with "New room…", and the Rooms tab lists it there as a Ring device.
- **Someone rang the doorbell**: for two minutes after the doorbell is pressed, while the tab is open.
- **Snapshot**: the camera's latest picture. **New snapshot** asks Ring for another. A battery camera takes one only every few minutes, and none while motion detection is off.
- **Watch live**: the camera's live video, muted until you unmute it. It comes from Ring straight to your browser, not through the Hub. **Stop live view** ends it.
- **Light**, **Siren** and **Motion detection**: on or off, where the camera has them.
- **Recent events**: the last 10, newest first. **Watch** plays a recorded one, which needs a Ring Protect plan.
- **Wi-Fi**: the signal, as Ring rates it.
- **A chime's volume**, from 0 to 11, and **Play the doorbell sound** and **Play the motion sound**.

Each widget reads its device from Ring every 5 seconds while the tab is open.

## The API

- `GET /api/ring` answers with the `RingHome`: whether the Hub is signed in, and the devices.
- `POST /api/ring/sign-in` with `{ "email": "…", "password": "…" }` signs in, and may answer that Ring wants the code; `DELETE` signs out.
- `POST /api/ring/code` with `{ "code": "123456" }` gives Ring the code.
- `GET /api/ring/devices/<id>` answers with what the device reports, as a `RingDeviceState`.
- `POST /api/ring/devices/<id>/actions` with a `RingAction`, e.g. `{ "kind": "light", "on": true }`, does it, and answers with the device's state.
- `GET /api/ring/devices/<id>/snapshot` answers with the camera's latest snapshot, as a JPEG.
- `POST /api/ring/devices/<id>/live` with `{ "sdp": "…" }`, the browser's WebRTC offer, answers with Ring's, and the session; `DELETE /api/ring/devices/<id>/live/<session>` ends it.
- `GET /api/ring/devices/<id>/events/<event>/recording` answers with where to watch the recording.
- `PUT /api/ring/devices/<id>/room` with `{ "roomId": 3 }`, or `null`, puts the device in a Room.

What Ring refuses is answered with `502`, and why.

## Testing against fakes

`RING_FAKE`, set to anything, has the Hub reach the fake Ring, `packages/hub/src/fakes/ring/fake-ring-driver.ts`, in place of Ring: a Front Door doorbell, a Garden floodlight camera and a Hallway Chime, which answer as the Ring app's API would and keep what they are asked. Signing in asks for the code `123456`. It has no live video to give. The end-to-end tests run against it, so no test reaches Ring.
