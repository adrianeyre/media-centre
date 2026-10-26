# Midea tokens are fetched once from the cloud, then never again

Midea Air Conditioners on protocol v3 answer on the home network only after a handshake with a token and key that Midea's cloud issues for each unit. The Hub fetches them once, when the Air Conditioner is added: Settings asks for the owner's login, the Hub asks Midea's cloud for that unit's token and key, keeps them, and forgets the login. From then on the Midea Driver controls the unit locally, with the internet down, as [ADR 0007](./0007-appliances-are-controlled-locally.md) requires. The token and key are secrets, treated like a TV's pairing token.

Midea has two clouds, each with its own accounts: MSmartHome's, and the older one that the Midea Air and NetHome Plus apps sign in to. A unit set up in Midea Air has an account MSmartHome has never heard of, so the Hub signs in to MSmartHome's cloud first, then, if it refuses the login, to Midea Air's, and fetches the token and key from whichever signs in. It logs each cloud's refusal code, never the login.

By 2026 Midea had stopped issuing tokens through its older cloud: it still signs Midea Air and NetHome Plus accounts in, but answers every token request with 9999, "system error", for every library that asks (midea-lan, msmart-ng, Home Assistant). The Hub says so in place of that code, and asks for an MSmartHome account instead. MSmartHome issues a unit's token only to an account the unit is **paired** to, not one it is shared with, nor an account moved there from Midea Air, and only when asked with `applianceCodes`, the unit's id as that account knows it, which is usually, not always, its own. So the Hub asks by the unit's own id, then by each Air Conditioner the account lists at `/v1/appliance/user/list/get`, and keeps the first token the unit accepts.

## Considered Options

- **Paste the token and key by hand**, fetched with a separate tool: no cloud call from the Hub at all, but a step most people can't do. Rejected for now; a hand-entry field can be added later if Midea's cloud stops issuing them.
- **Control through Midea's cloud**: rejected by ADR 0007.
- **Home Assistant's Midea integration**: rejected by ADR 0007.

## Consequences

- Adding a v3 Air Conditioner needs the internet and an MSmartHome account it is paired to, once. A unit set up only in Midea Air must be paired in the MSmartHome app, with a new account, first. Controlling it never needs either.
- If Midea changes or closes either cloud's endpoint, units already added keep working, but new v3 units can't be added until the Driver follows the change or hand entry is added.
- A unit that is factory-reset or re-paired in Midea's app gets a new token and key, so the Remote offers to fetch them again (FR-51).
- The fake Midea Air Conditioner speaks v3's handshake, and fakes of both clouds' sign-in and token endpoints stand in for Midea's in tests. No test reaches either real cloud: the Hub takes both clouds' URLs from its environment together, or neither.
