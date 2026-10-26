# The Player uses Samsung's AVPlay, not HTML5 video

Every Media File the TV can decode natively plays without the Hub converting it ([ADR 0006](./0006-the-hub-converts-what-the-tv-cannot-play.md)), so the more the Player can decode, the less CPU the Hub burns. On Samsung TVs, HTML5 `<video>` is unreliable with MKV and several audio codecs and gives poor access to embedded subtitle tracks. AVPlay, Samsung's native player API, plays what the TV's own media player plays (MKV, HEVC, AC3/EAC3, 4K/HDR where the panel supports it), lists embedded audio and subtitle tracks, and loads sidecar `.srt` files. So the Player uses AVPlay, wrapped in a small playback interface inside the Player so that a Player for another brand can supply its own implementation.

## Consequences

- AVPlay is unavailable in a desktop browser, so the Player's UI is developed against a fake playback implementation, and real playback is only proven on a TV (see [ADR 0004](./0004-a-fake-samsung-tv-stands-in-for-real-tvs.md)).
