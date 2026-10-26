# Echo devices are controlled through the Alexa app's private API, as a second exception

Amazon offers no way to control an Echo on the home network. An Echo can be read and controlled only through Amazon's cloud, by the API the Alexa app itself uses, which Amazon neither documents nor offers to others. The owner asked for the most functionality possible for their Echos, so the Amazon Driver reaches that API, through the open-source `alexa-remote2` library (MIT), which [ADR 0007](./0007-appliances-are-controlled-locally.md) forbids for an Appliance. It is a second exception, after [Hive's](./0010-hive-is-controlled-through-its-cloud.md), on the same terms: opt-in, off until the owner signs in on the Amazon tab, marked there as needing the internet, and nothing else depends on it.

Signing in is through `alexa-cookie2`'s sign-in page, which the Hub serves, and on which the owner signs in to Amazon themselves, two-step code and all, so the Hub never sees the password. The Hub keeps the session it is given, which the library refreshes every four days, in its database, as it keeps Hive's tokens, and never logs it. The library's own log writes the session out, so it is never turned on.

## Considered Options

- **An Alexa Smart Home skill**: Amazon's supported way, but the other way round. It lets Alexa control the Hub's Appliances by voice, through Amazon's cloud, an AWS Lambda and a Hub reachable from the internet. It can't read or control the Echo itself. Rejected for this tab; it remains the way to voice control.
- **The Hub as a Matter bridge**: local, and within ADR 0007, so Alexa could control the Hub's Appliances with no Amazon cloud code. It too can't control the Echo itself, and it is a much bigger project. Rejected for this tab; it remains the local way to voice control.
- **Only listing Echos found on the network and over Bluetooth**: local, but it controls nothing. Rejected; the owner asked for control.
- **Writing the calls to Amazon's API ourselves**: rejected. The API is undocumented, and `alexa-remote2` is maintained and widely used, and follows Amazon's changes. The Driver checks every call it relies on against the library's own source.

## Consequences

- The Amazon tab needs the internet and an Amazon account. Every other tab works without either.
- Using the Alexa app's API this way is against Amazon's terms. The tab says so before signing in. It is the owner's account and the owner's decision.
- Amazon can change the API without notice. When it does, a widget says what Amazon refused, and the Driver follows the library's fix. Nothing else in the Remote breaks.
- The library looks up music searches in German. Where Amazon refuses a search, the Driver asks Alexa as if out loud ("play … on …").
- `alexa-remote2` and `alexa-cookie2` are dependencies of the Hub, with `express` for the sign-in page. Only `drivers/amazon/alexa.ts` imports them; a boundary test fails if anything else names the API.
- The sign-in page listens on `AMAZON_SIGN_IN_PORT` (41081) on every interface while signing in, then stops. The Hub's PC must accept connections on it from the browser used to sign in, or the page is opened on the Hub's PC itself.
- Amazon's sign-in page encrypts the password in the browser (its "Siege" client-side encryption), with WebCrypto, which browsers give only to HTTPS pages and `localhost`. The page the Hub serves is plain HTTP, so it works only at `localhost`, on the Hub's PC: signing in started from a Remote at `localhost` serves it there. Serving it over HTTPS, with a certificate every browser would warn about, was rejected for now.
- The sign-in is on amazon.com, but for Japan's accounts, whichever site the account is on: since 2026, signed in on amazon.co.uk, Amazon answers with no authorization code (no `openid.oa2.*` at all), so the sign-in never finishes, while the same account on amazon.com gets one. The library's `baseAmazonPage`, for signing in and registering the Hub, is amazon.com; its `amazonPage`, for the Echos, is the account's own site. Home Assistant's Alexa integration does the same.
- The Amazon Driver is tested against a fake Amazon Driver and against samples of Amazon's answers. No test reaches Amazon, so what Amazon really answers is checked only when the owner first signs in.
- This exception is for Amazon's Echos alone, as Hive's is for Hive. Another brand without a local API needs an ADR of its own.
