# Ring devices are controlled through the Ring app's private API, as a third exception

Ring offers no way to reach its doorbells, cameras and chimes on the home network, and no API for owners. They can be read and controlled only through Ring's cloud, by the API the Ring app itself uses, which Ring neither documents nor offers to others. The owner asked for their Ring doorbell in the Remote, so the Ring Driver reaches that API, through the open-source `ring-client-api` library (MIT), which [ADR 0007](./0007-appliances-are-controlled-locally.md) forbids for an Appliance. It is a third exception, after [Hive's](./0010-hive-is-controlled-through-its-cloud.md) and [Amazon's](./0011-echo-devices-are-controlled-through-the-alexa-apps-private-api.md), on the same terms: opt-in, off until the owner signs in on the Ring tab, marked there as needing the internet, and nothing else depends on it.

Ring has no sign-in page the Hub could serve, as Amazon has. So the owner gives the tab their email and password, and the two-step code Ring then sends. The Hub hands them to Ring once, keeps the password only in memory until signed in, and keeps only the token Ring issues, in its database, as it keeps Hive's, replaced each time the library refreshes it. It never logs any of them, and the library's own log is silenced.

Live video never passes through the Hub. The library can hand Ring a WebRTC offer made by a browser and give back Ring's answer, so the Remote's browser makes the offer, the Hub carries it to Ring and back, and the browser receives the video from Ring's media servers itself. Snapshots and recordings' addresses come through the Hub, as Ring wants the token for them.

## Considered Options

- **Through the Hub, with ffmpeg**: the library can receive the video on the Hub, with `werift`, and ffmpeg could make HLS of it for the Remote, as the Hub does for Media Files. Rejected: it costs the Hub a transcode per viewer and seconds of delay, for video the browser can take from Ring directly.
- **Home Assistant's Ring integration** as the back end: rejected by ADR 0007, and it reaches the same cloud through the same kind of library.
- **Writing the calls to Ring's API ourselves**: rejected. The API is undocumented, and `ring-client-api` is maintained, widely used (by Homebridge's and Home Assistant's Ring plugins), and follows Ring's changes.
- **No Ring**: rejected; the owner asked for it.

## Consequences

- The Ring tab needs the internet and a Ring account. Every other tab works without either.
- Ring can change the API without notice. When it does, a widget says what Ring refused, and the Driver follows the library's fix. Nothing else in the Remote breaks.
- Ring lists the Hub among the account's signed-in devices, as "media-centre Hub". Removing it there signs the Hub out.
- The browser asks a public STUN server (Google's) for its own internet address, for live view. Nothing else of the Remote's reaches it.
- Live view only receives. Talking through the doorbell would need the Remote's microphone, which browsers give only to HTTPS pages.
- `ring-client-api` is a dependency of the Hub. Its `ffmpeg-for-homebridge` dependency's install script, which downloads ffmpeg, is not run, as the Hub never streams the video. Only `drivers/ring/ring.ts` imports the library; a boundary test fails if anything else names the API.
- The library declares Node 20 to 24, and the Hub runs Node 26. Its tests pass there, and the Driver is the only part that runs it.
- The Ring Driver is tested against a fake Ring Driver and against samples of Ring's answers. No test reaches Ring, so what Ring really answers is checked only when the owner first signs in.
- This exception is for Ring alone, as Hive's is for Hive. Another brand without a local API needs an ADR of its own.
