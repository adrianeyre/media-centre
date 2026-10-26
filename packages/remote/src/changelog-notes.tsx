import { CHANGELOG, parseChangelog, type Inline } from "./changelog.ts";

const InlineText = ({ content }: { readonly content: readonly Inline[] }) => (
  <>
    {content.map((part, index) => {
      switch (part.kind) {
        case "text":
          return part.text;
        case "strong":
          return <strong key={index}>{part.text}</strong>;
        case "link":
          return (
            <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
              {part.text}
            </a>
          );
      }
    })}
  </>
);

/**
 * What changed in each version of media-centre, newest first, from
 * CHANGELOG.md. Under the dialog's own heading, each version is a level 3
 * heading and each kind of change in it a level 4. Before the first release,
 * CHANGELOG.md is empty, and it says so.
 */
export const ChangelogNotes = ({ markdown = CHANGELOG }: { readonly markdown?: string }) => {
  const blocks = parseChangelog(markdown);
  if (blocks.length === 0) {
    return (
      <div class="changelog">
        <p>No version has been released yet. Each release will be listed here, with what changed in it.</p>
      </div>
    );
  }
  return (
    <div class="changelog">
      <p class="policy-updated">Each change links to its issue and commit on GitHub, which open in a new tab.</p>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return block.level === 3 ? (
              <h4 key={index}>
                <InlineText content={block.content} />
              </h4>
            ) : (
              <h3 key={index}>
                <InlineText content={block.content} />
              </h3>
            );
          case "list":
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineText content={item} />
                  </li>
                ))}
              </ul>
            );
          case "paragraph":
            return (
              <p key={index}>
                <InlineText content={block.content} />
              </p>
            );
        }
      })}
    </div>
  );
};
