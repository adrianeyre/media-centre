// Draws the website's product illustrations into the page: each element with
// a `data-stage` attribute gets the scene it names, in the light or dark of
// the page's colour scheme. What the element held (a screenshot, or nothing)
// is what a reader without JavaScript sees instead. Each element is a picture
// to assistive technology (`role="img"` and its label, in the page), so the
// scene inside it is never read out. A looping scene has a button in the page
// that pauses it (`data-stage-pause`, WCAG 2.2.2): paused, it holds its
// poster, the frame reduced motion shows.
import { StrictMode, useSyncExternalStore, type ComponentType } from "react";
import { createRoot } from "react-dom/client";

import "./kit/stageshow.css";
import "./look.css";
import { Hero } from "./scenes/hero.tsx";
import { Route } from "./scenes/route.tsx";
import { AirconTile, LightsTile, RoomsTile } from "./scenes/tiles.tsx";

type Theme = "light" | "dark";

type SceneProps = { theme: Theme; still: boolean };

const SCENES: Partial<Record<string, ComponentType<SceneProps>>> = {
  hero: Hero,
  route: Route,
  rooms: RoomsTile,
  aircon: AirconTile,
  lights: LightsTile,
};

const dark = window.matchMedia("(prefers-color-scheme: dark)");
const subscribe = (change: () => void) => {
  dark.addEventListener("change", change);
  return () => {
    dark.removeEventListener("change", change);
  };
};
const theme = (): Theme => (dark.matches ? "dark" : "light");

/** The scenes paused by their buttons, by name, and who to tell when that changes. */
const paused = new Set<string>();
const listeners = new Set<() => void>();
const subscribePaused = (change: () => void) => {
  listeners.add(change);
  return () => {
    listeners.delete(change);
  };
};

function Scene({ name, scene: Drawn }: { name: string; scene: ComponentType<SceneProps> }) {
  const still = useSyncExternalStore(subscribePaused, () => paused.has(name));
  return <Drawn theme={useSyncExternalStore(subscribe, theme)} still={still} />;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-stage-pause]")) {
  const name = button.dataset.stagePause ?? "";
  const label = button.querySelector("span");
  button.hidden = false;
  button.addEventListener("click", () => {
    const pause = !paused.has(name);
    if (pause) paused.add(name);
    else paused.delete(name);
    button.setAttribute("aria-pressed", String(pause));
    if (label) label.textContent = pause ? "Play the animation" : "Pause the animation";
    for (const change of listeners) change();
  });
}

for (const element of document.querySelectorAll<HTMLElement>("[data-stage]")) {
  const name = element.dataset.stage ?? "";
  const scene = SCENES[name];
  if (scene === undefined) continue;
  element.replaceChildren();
  element.dataset.staged = "";
  createRoot(element).render(
    <StrictMode>
      <Scene name={name} scene={scene} />
    </StrictMode>,
  );
}
