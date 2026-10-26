# The Hub serves Media Files to the Player over HTTP

Samsung TVs can already browse DLNA servers and SMB shares, so the Player could read a PC or NAS directly. We chose instead to have the Hub read each Media Source (a local folder, or a share mounted on the Hub's machine) and serve its Media Files over plain HTTP: directly with range requests, or as HLS when they need converting ([ADR 0006](./0006-the-hub-converts-what-the-tv-cannot-play.md)). The Player only ever plays a URL. This means Media Sources are configured in one place, the Remote can browse exactly what the Player can play, and the Player stays thin.

## Considered Options

- **Player browses DLNA or SMB itself**: rejected. Every Player would need its own share configuration and credentials, and the Remote couldn't see the same library.
- **Run Plex or Jellyfin and wrap it**: rejected. It's a heavy dependency that does most of what this project exists to build.
