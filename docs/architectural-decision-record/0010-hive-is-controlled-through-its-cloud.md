# Hive is controlled through Hive's cloud, as the exception for Hive alone

Hive heating has no local API. The Hive hub speaks Zigbee to the thermostats, receivers and Radiator Valves, and only Hive's cloud exposes them to any app, Hive's own included. So the Hive Driver reaches Hive's cloud, which [ADR 0007](./0007-appliances-are-controlled-locally.md) forbids for every other Appliance. It is the exception ADR 0007 allows: opt-in, off until the owner signs in to Hive in Settings, marked there as needing the internet, and nothing else depends on it. The Hub keeps only the tokens Hive issues, refreshes them itself, and never stores the password, as [ADR 0009](./0009-midea-tokens-are-fetched-once-from-the-cloud.md) keeps only Midea's token and key.

## Considered Options

- **A Zigbee coordinator on the Hub** (a USB stick and zigbee2mqtt), with Hive's thermostats, receivers and valves paired to it instead of to Hive's hub: local, and within ADR 0007, but it means leaving the Hive app, re-pairing every device, and a hardware project of its own. Rejected for now; it remains the way to bring Hive within ADR 0007 if Hive's cloud closes or changes.
- **Home Assistant's Hive integration** as the back end: rejected by ADR 0007, and it reaches the same cloud.
- **No Hive**: rejected; the heating is Hive, and the household wants it in the Remote.

## Consequences

- The Heating tab needs the internet and a Hive account. Every other tab works without either.
- When the internet is down, or Hive's cloud is, the Heating tab says "Can't reach Hive" and nothing else in the Remote changes.
- If Hive changes or closes its cloud API, the Heating tab stops working until the Driver follows the change or the Zigbee route is taken. Nothing else breaks.
- Hive's API is unofficial, the one its own app uses; Hive has changed it without notice more than once, and each time the Driver has to follow. Hive's tokens expire on a schedule it doesn't publish, so the owner signs in again now and then, with a code, and Settings says when.
- The Hive Driver is tested against a fake Hive cloud. No test reaches Hive.
- This exception is for Hive alone. Another brand without a local API needs an ADR of its own, as this one is.
