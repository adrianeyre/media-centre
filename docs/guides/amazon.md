# The Amazon tab

The Amazon tab, between Network and Ring, shows every Echo on your Amazon account, such as your Echo Dot, each a widget, with everything the Alexa app lets the Hub do with it. The requirements are in the [Amazon PRD](../product-requirements-document/amazon.md), and why it works as it does in [ADR 0011](../architectural-decision-record/0011-echo-devices-are-controlled-through-the-alexa-apps-private-api.md).

![The Amazon tab](../images/screenshots/desktop-amazon.png)

## Before you sign in

Amazon offers no way to control an Echo on the home network. The Hub reaches your Echos through the Alexa app's own cloud service, by the open-source `alexa-remote2` library. That means:

- **It needs the internet.** Every other tab works without it.
- **Amazon may change it without warning.** When it does, a widget says what Amazon refused, until the Hub follows the change.
- **Amazon's terms don't allow it.** It is your account, and your decision.

## Signing in

1. On the Amazon tab, choose the Amazon site your account is on, e.g. amazon.co.uk, and tap **Sign in to Amazon**.
2. Tap **Open Amazon's sign-in page**. It is Amazon's own page, served by the Hub on port 41081 (`AMAZON_SIGN_IN_PORT`).
3. Sign in there, with your two-step code if Amazon asks. The Hub never sees your password. It is amazon.com's sign-in page, whichever site your account is on (but Japan's): signed in on amazon.co.uk or another European site, Amazon leaves out the code the Hub needs, and the page ends on Amazon's "Looking for something?". Your account and your Echos are the same; the Hub still reaches them on your own site.
4. The tab carries on by itself once you have, and shows your Echos.

**Sign in from the Hub's PC.** Amazon's page encrypts your password in the browser before sending it, and browsers allow that only on HTTPS pages or at `localhost`. The Hub's sign-in page is neither when opened at the Hub's address from a phone, so Amazon refuses the password. Open the Remote in a browser on the Hub's PC, at `http://localhost:41080`, and sign in from the Amazon tab there: the Hub then serves Amazon's page at `http://localhost:41081/`, where it works. Signed in, every Remote shows your Echos.

From another device, the sign-in page is at the Hub's address. If it doesn't open at all, the Hub's PC is refusing connections on that port.

The Hub keeps the session Amazon gives it, in its database, refreshed every four days, and signs in with it again after a restart. It never logs it. **Sign out**, at the top of the tab, forgets it.

## Each Echo

Each Echo is a widget, dragged, resized, hidden and put back as on the other tabs, remembered on each Remote under `media-centre:amazon-widgets`. Each shows its name, what it is, e.g. "Echo" or "Echo Show", whether it is online, and its Room, with:

- **Room**: put it in a Room, or make one with "New room…", and the Rooms tab lists it there.
- **Now playing**: the title, artist, service, cover art and progress, with Previous, Play or Pause, and Next.
- **Volume.**
- **Do Not Disturb.**
- **Ask Alexa, Say it and Announce**: type words, up to 250 characters. "Ask Alexa" is as if you said them to it, e.g. "set a timer for 10 minutes" or "turn on the kitchen light". "Say it" has it say them, and "Announce" announces them.
- **Quick actions**: Weather, Traffic, News, Good morning, Fun fact, Joke, Story, Sing a song, Today's calendar and Stop.
- **Routines**: run any of your account's routines on it.
- **Play music**: from any service your account has, by a search. If Amazon refuses the search, the Hub asks Alexa as if out loud.
- **Alarms, timers and reminders**: soonest first, a timer with its time left. Switch an alarm or reminder on or off, or delete it. Set new ones with "Ask Alexa".
- **Sound**: the equaliser's bass, midrange and treble, and the alarm volume, where it has them.
- **Bluetooth**: what is paired with it, each connected or disconnected.

Each widget reads your Echo from Amazon every 5 seconds while the tab is open. **Announce to every Echo**, at the top, announces on every Echo that is online.

## The API

- `GET /api/amazon` answers with the `AmazonHome`: whether the Hub is signed in, and the Echos, routines and music services.
- `POST /api/amazon/sign-in` with `{ "domain": "amazon.co.uk" }` starts signing in; `DELETE` signs out.
- `GET /api/amazon/devices/<serial>` answers with what the Echo reports, as an `AmazonDeviceState`.
- `POST /api/amazon/devices/<serial>/actions` with an `AmazonAction`, e.g. `{ "kind": "volume", "level": 40 }`, does it, and answers with the Echo's state.
- `POST /api/amazon/announce` with `{ "text": "…" }` announces on every Echo.
- `PUT /api/amazon/devices/<serial>/room` with `{ "roomId": 3 }`, or `null`, puts the Echo in a Room.

What Amazon refuses is answered with `502`, and why.

## Testing against fakes

`AMAZON_FAKE`, set to anything, has the Hub reach the fake Amazon, `packages/hub/src/fakes/amazon/fake-amazon-driver.ts`, in place of Amazon: two Echos, a Kitchen Echo Dot and a Lounge Echo Show, which answer as the Alexa app's API would and keep what they are asked. Signing in completes as though you had signed in on Amazon's page. The end-to-end tests run against it, so no test reaches Amazon.
