# A fake Samsung TV stands in for real TVs in every automated test

Neither CI nor a Sandcastle sandbox can reach a real TV: they have no route to the home network, no Wake-on-LAN, no SSDP and no Tizen device. So the repository includes a fake Samsung TV, a local process that speaks the same WebSocket and REST protocols as a real one and records what it was sent. Every automated test of the Hub, the Samsung TV Driver and the Remote runs against it. Anything that can only be proven on a real TV, such as pairing prompts, actual power-on and the Player playing a real file, goes on the PRD's manual checklist instead of being silently untested.

## Consequences

- The fake TV is only as good as our knowledge of the real one. When real hardware behaves differently from the fake, fix the fake first, then the code.
- Every other Driver, for another TV brand or for an Air Conditioner or Light, comes with its own fake in the same way.
