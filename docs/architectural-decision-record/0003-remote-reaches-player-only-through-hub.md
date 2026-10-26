# The Remote reaches the Player only through the Hub

When a person chooses a Media File on the Remote, the Remote asks the Hub to play it. The Hub has the Samsung TV Driver launch the Player, the Player opens a WebSocket back to the Hub, and the Hub sends it the Media File's URL. After that, play, pause and seek go Remote → Hub → Player, and playback state comes back the same way. The Remote never connects to a Player directly, because a browser has no reliable way to find or reach an app running on a TV, and routing through the Hub keeps one source of truth for what each TV is playing.
