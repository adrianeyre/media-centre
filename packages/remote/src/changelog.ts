import changelog from "../../../CHANGELOG.md?raw";

/**
 * media-centre's CHANGELOG.md, written by semantic-release as each version is
 * released, and built into the Remote, so the footer's version shows it with
 * the internet disconnected (NFR-3).
 */
export const CHANGELOG = changelog;

/** A run of text within a line: plain, bold, or a link. */
export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

export type Block =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly content: readonly Inline[] }
  | { readonly kind: "list"; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: "paragraph"; readonly content: readonly Inline[] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM = /^[*-]\s+(.*)$/;
const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Reads the Markdown semantic-release writes: a heading for each version and
 * for each kind of change in it, a list of the changes, each with its scope
 * in bold and links to its issues and commit, and any paragraph, such as a
 * breaking change's description. Nothing else in Markdown is needed.
 */
export const parseChangelog = (markdown: string): readonly Block[] => {
  const blocks: Block[] = [];
  let items: (readonly Inline[])[] | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const item = LIST_ITEM.exec(line);
    if (item) {
      if (items === undefined) {
        items = [];
        blocks.push({ kind: "list", items });
      }
      items.push(parseInline(item[1] ?? ""));
      continue;
    }
    items = undefined;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, content: parseInline(heading[2] ?? "") });
    } else if (line.trim() !== "") {
      blocks.push({ kind: "paragraph", content: parseInline(line.trim()) });
    }
  }
  return blocks;
};

const parseInline = (line: string): readonly Inline[] => {
  const content: Inline[] = [];
  let at = 0;
  for (const match of line.matchAll(INLINE)) {
    if (match.index > at) content.push({ kind: "text", text: line.slice(at, match.index) });
    const [whole, strong, text, href] = match;
    if (strong !== undefined) content.push({ kind: "strong", text: strong });
    // Only a web address is made a link; anything else stays as it was written.
    else if (text !== undefined && href !== undefined && /^https?:\/\//.test(href))
      content.push({ kind: "link", text, href });
    else content.push({ kind: "text", text: whole });
    at = match.index + whole.length;
  }
  if (at < line.length) content.push({ kind: "text", text: line.slice(at) });
  return content;
};
