/**
 * The Appliances a Settings list shows, grouped by the Room each says it is
 * in, in the order shown, each as the Remote names it: so a test says what
 * the person sees of each Room, and in what order, whatever the markup.
 * A row being edited, which shows its form instead, is left out.
 */
export const deviceGroups = (root: Element): [string, string[]][] => {
  const groups: [string, string[]][] = [];
  for (const row of root.querySelectorAll(".device-list > li")) {
    if (row.querySelector(".device-row") === null) continue;
    const room = row.querySelector(".device-meta .chip")?.textContent ?? "";
    const title = row.getAttribute("aria-label") ?? "";
    const last = groups.at(-1);
    if (last?.[0] === room) last[1].push(title);
    else groups.push([room, [title]]);
  }
  return groups;
};
