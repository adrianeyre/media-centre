/** An element of the Player's screens, with its class and any text. */
export const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  made.className = className;
  made.textContent = text;
  return made;
};

// eslint-disable-next-line media-centre/no-internet-urls -- an XML namespace's name, not an address
const SVG = "http://www.w3.org/2000/svg";

/** The paths of each icon the Player draws, on a 24 × 24 grid. */
const ICONS = {
  play: "M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z",
  pause:
    "M7 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm7 0h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
  music: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
} as const;

export type IconName = keyof typeof ICONS;

/**
 * An icon, drawn as SVG in the text's colour. It is only ever beside text
 * that says the same, so it is hidden from assistive technology, and adds
 * nothing to its element's text or name.
 */
export const icon = (name: IconName, className = "icon"): SVGSVGElement => {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
};
