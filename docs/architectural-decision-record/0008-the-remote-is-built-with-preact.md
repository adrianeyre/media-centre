# The Remote is built with Preact

The Remote will grow many screens that share state: the TV picker, the D-pad and TV Menu mode, the volume slider, Now Showing, Watch & Listen, the now-playing bar, and Settings for Rooms, Appliances and Media Sources. Building those by hand with the DOM would mean writing our own rendering and state layer, so the Remote uses a UI framework. We chose Preact: components and hooks with JSX, the same model as React, in about a tenth of the size. A phone on Wi-Fi opening the Remote from the Hub, on a low-power NAS, benefits from the smaller download, and the Remote needs nothing from React's wider ecosystem. Vite compiles its JSX with no plugin, and its components are tested with Testing Library in a simulated browser.

## Considered Options

- **React**: rejected for size alone. Preact has the same component model, so moving to React later, if the Remote ever needs a React-only library, is mostly a change of imports.
- **No framework**: rejected. The Remote's screens would each need their own rendering and update code.
- **Svelte, Solid, Vue or Lit**: rejected. Each is a fine choice, but each brings its own component model and compiler or templating, where Preact is plain TypeScript and JSX.

## Consequences

- Every screen of the Remote is a Preact component. Changing framework later means rewriting the Remote's screens, though not its talk with the Hub, which is in plain TypeScript using the types in `shared`.
- The Player's UI is a separate decision, made when the Player is built.
