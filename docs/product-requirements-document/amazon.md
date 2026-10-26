# Amazon — Product Requirements Document

|               |                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Product**   | media-centre                                                                                                        |
| **Parent**    | [`media-centre.md`](./media-centre.md)                                                                              |
| **Status**    | Built; untried against a real Amazon account                                                                        |
| **Date**      | 2026-10-24                                                                                                          |
| **Glossary**  | [`GLOSSARY.md`](../../GLOSSARY.md)                                                                                  |
| **Decisions** | [ADR 0011](../architectural-decision-record/0011-echo-devices-are-controlled-through-the-alexa-apps-private-api.md) |
| **Guide**     | [The Amazon tab](../guides/amazon.md)                                                                               |

## 1. Summary

The Remote's **Amazon** tab shows every **Echo** on the owner's Amazon account, such as their Echo Dot, each a widget, with everything the Alexa app lets the Hub do with it.

Amazon offers no way to control an Echo on the home network. The only way to read and control one is the Alexa app's own cloud API, which Amazon neither documents nor offers to others. The owner chose it, for the most features possible. The Hub reaches it through the open-source `alexa-remote2` library ([ADR 0011](../architectural-decision-record/0011-echo-devices-are-controlled-through-the-alexa-apps-private-api.md)). It is opt-in, off until the owner signs in to Amazon on the tab, which says it needs the internet and that Amazon's terms don't allow it.

## 2. Problem

- The Echos are controlled only from the Alexa app, or by voice, apart from everything else in the home.
- Announcing to the house, setting a timer, or running a routine means finding a phone and the Alexa app.

## 3. Goals

1. Every Echo on the account in one tab, each with every control the Alexa app's API offers.
2. Echos placed in Rooms, as every other device can be.
3. The password never seen by the Hub, the session kept and refreshed, and the rest of the Remote unaffected by Amazon.

## 4. Non-goals

- **Alexa controlling the Hub's Appliances by voice.** That needs an Alexa skill or the Hub as a Matter bridge, each a project of its own.
- **Alexa's smart-home devices, lists, shopping, calls and Drop In.** They are other parts of the Alexa app, under Later.
- **Creating alarms, timers and reminders by form.** "Ask Alexa" sets them as words do, e.g. "set a timer for 10 minutes", which is more reliable through this API than creating them.
- **More than one Amazon account.**

## 5. Key scenarios

1. **Signing in.** On the Amazon tab, the owner chooses amazon.co.uk and taps "Sign in to Amazon". The Hub opens Amazon's own sign-in page, served by the Hub. The owner signs in there, with their two-step code, and the tab shows their Echos.
2. **Dinner.** The owner types "Dinner is ready" in "Announce to every Echo".
3. **Music in the kitchen.** On the Kitchen Echo Dot's widget, the owner plays "Radio 2" from TuneIn, then turns the volume down.
4. **Bedtime.** On the bedroom Echo, they set Do Not Disturb, check tomorrow's alarm, and run the "Good night" routine.
5. **A pasta timer.** They type "set a timer for 10 minutes" and tap "Ask Alexa". The timer shows under Alarms, timers and reminders, counting down.

## 6. Functional requirements

- **FR-81:** The Amazon tab, between Network and Ring, signs the Hub in to Amazon on the Amazon site the account is on, through Amazon's own sign-in page, served by the Hub on `AMAZON_SIGN_IN_PORT` (41081), where the owner signs in with their two-step code; the Hub never sees the password. The sign-in is on amazon.com, or amazon.co.jp for Japan's, whichever site the account is on, as Amazon gives its authorization code only there; the Echos are reached on the account's own site. Started from a Remote at the Hub's PC's `localhost`, the page is served at `localhost` too, the only address over plain HTTP where a browser lets Amazon's page encrypt the password, as it now does; started from elsewhere, the tab says to sign in on the Hub's PC if Amazon refuses the password. It says, before signing in, that it needs the internet, that Amazon may change it, and that Amazon's terms don't allow it.
- **FR-82:** The Hub keeps the session in its database, refreshed as it is refreshed, signs in with it again after a restart, and never logs it (FR-4). "Sign out" forgets it.
- **FR-83:** Signed in, each Echo on the account, but the Alexa app's own, is a widget (FR-58), with its name, family, whether it is online, and its Room. Each reads Amazon every 5 seconds while it is shown.
- **FR-84:** Each Echo's widget has what it is playing, with its cover art, provider and progress, Previous, Play or Pause, and Next, and its volume.
- **FR-85:** Each has Do Not Disturb, and "Ask Alexa", "Say it" and "Announce", which send words, up to 250 characters, as if spoken to Alexa, to be said, or as an announcement.
- **FR-86:** Each has Alexa's quick actions: weather, traffic, news, good morning, a fun fact, a joke, a story, a song, today's calendar, and Stop. And the account's routines, run on it.
- **FR-87:** Each plays music from any service the account has, by a search. Where Amazon refuses the search, the Hub asks Alexa as if out loud.
- **FR-88:** Each lists its alarms, timers and reminders, soonest first, with a timer's time left, each alarm or reminder switched on or off, and each deleted.
- **FR-89:** Each has its equaliser's bass, midrange and treble, and its alarm volume, where Amazon reports them, and its Bluetooth pairings, each connected or disconnected.
- **FR-90:** "Announce to every Echo" announces on every Echo that is online.
- **FR-91:** Each Echo can be put in a Room, or a new one made there and then (see the [Rooms PRD](./rooms.md), FR-92). What Amazon refuses, the widget says, as Amazon says it.

## 7. Non-functional requirements

Those of the parent PRD apply, but for being local: this is the second exception to [ADR 0007](../architectural-decision-record/0007-appliances-are-controlled-locally.md), after Hive's. In particular:

- **Secrets (FR-4):** the session is kept on the Hub only, never sent to the Remote and never logged. The library's own log, which writes it out, is never turned on.
- **Boundary (NFR-6):** only the Amazon Driver knows the Alexa app's API; a test fails if anything else names it.
- **Accessibility:** WCAG 2.2 AA, checked by axe in both themes, signed out and signed in.

## 8. Testing

- Amazon's answers, read as the Driver reads them, from samples shaped as the library's own code reads them.
- The Hub's Amazon, signing in, keeping and resuming the session, every action and its checks, Rooms and signing out, against the fake Amazon Driver.
- The tab against a fake of the Hub's API, and end to end against the fake Amazon (`AMAZON_FAKE`). No test reaches Amazon.
- Untried against a real account: what Amazon really answers is checked only when the owner first signs in, and the Driver follows what it finds.
