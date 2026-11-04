# Rehearsal notes

How the website's illustrations were drawn and checked, as Stageshow's hand-over
asks. They were filmed with Stageshow's `scripts/film.mjs` against
`pnpm --filter @media-centre/site scenes:dev`, at 1104 and 390 wide, light and
dark, and their posters with `--reduced`.

## The scenes

| Scene                                 | Gold copied                                   | What it is                                                                                                                                                                                                                 |
| ------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hero` (`scenes/hero.tsx`)            | `device-pair`, with `hero-demo`'s beats       | The TV tab on a computer and the Remote on a phone. A film is tapped in Watch & Listen on the phone; both Remotes show it in Now Playing from its Resume Position; Stop on the phone stops it on both. Loops, about 11 s.  |
| `route` (`scenes/route.tsx`)          | `payout-flow`                                 | How the Hub picks a Route: ffprobe's streams, the four Routes ruled out or taken, a line from the DTS stream to Audio Conversion. Plays once in view, no cursor.                                                           |
| `rooms`, `aircon`, `lights` (`tiles`) | `bento`, `static-card` (pinned, bottom bleed) | The feature grid's pictures: the floor plan with the Living Room and what is in it (a still); the target temperature turned down to 21°; Film night recalled, the brightness following. The two widgets play once in view. |

## What changed from the gold

- The look is the Remote's (`look.css`): Evergreen on slate, its radii and
  Plus Jakarta Sans, in light and dark; the icons are Lucide, the Remote's own.
- The hero is a wide hero (1040 × 520, shown at 1:1) under the page's copy,
  not a 720-wide demo beside it, which the page's column would have shrunk to
  about 0.78.
- Compact (below 720): the hero's window is whole across, cropped to Now
  Playing and faded at its foot under the phone, which is the column's width so
  its words stay above 10px; the Route stacks the file over its Routes, without
  the line; the Rooms tile drops its card.

## Left as they are

- `film.mjs --gate` reports framing lines on the compact hero: it reads the
  phone as the hero and the window as its satellite, and asks for a 348px
  gutter. Both share the one 16px gutter; judged by eye on the 390 sheet.
- "uneven inset" on the phone's "On the TV" pill: it is a trailing pill in a
  file row, not a pill inside a field.
- A one-frame width change of the "Nothing playing" title as it swaps: the
  title is left-aligned, so nothing beside it moves.

## Not checked

- Every frame of the loops at `--slow`; the sheets were filmed at 700 to 900ms.
- Windows' Contrast Themes (forced colours) over the scenes.
