import { describe, expect, it } from "vitest";

import { REMOTE_VERSION, REPOSITORY_URL } from "./about.ts";
import { CHANGELOG, parseChangelog, type Inline } from "./changelog.ts";

const textOf = (content: readonly Inline[]): string => content.map((part) => part.text).join("");

describe("the Changelog", () => {
  // semantic-release writes each version into it as it releases it, so it is
  // empty until the first release, and has this version in it from then on.
  it("is the repository's CHANGELOG.md, empty until the first release, then with this version in it", () => {
    const versions = parseChangelog(CHANGELOG).flatMap((block) =>
      block.kind === "heading" && block.level < 3 ? [textOf(block.content)] : [],
    );

    if (CHANGELOG.trim() === "") expect(versions).toEqual([]);
    else expect(versions.some((version) => version.startsWith(`${REMOTE_VERSION} `))).toBe(true);
  });

  it("is nothing when nothing has been released", () => {
    expect(parseChangelog("")).toEqual([]);
  });

  it("reads the Markdown semantic-release writes", () => {
    const markdown = [
      `## [1.1.0](${REPOSITORY_URL}/compare/v1.0.0...v1.1.0) (2026-11-01)`,
      "",
      "",
      "### Features",
      "",
      `* **remote:** a thing ([#3](${REPOSITORY_URL}/issues/3)) ([abc1234](${REPOSITORY_URL}/commit/abc1234))`,
      "* another",
      "",
      "### BREAKING CHANGES",
      "",
      "Something stopped working as it did.",
    ].join("\n");

    expect(parseChangelog(markdown)).toEqual([
      {
        kind: "heading",
        level: 2,
        content: [
          { kind: "link", text: "1.1.0", href: `${REPOSITORY_URL}/compare/v1.0.0...v1.1.0` },
          { kind: "text", text: " (2026-11-01)" },
        ],
      },
      { kind: "heading", level: 3, content: [{ kind: "text", text: "Features" }] },
      {
        kind: "list",
        items: [
          [
            { kind: "strong", text: "remote:" },
            { kind: "text", text: " a thing (" },
            { kind: "link", text: "#3", href: `${REPOSITORY_URL}/issues/3` },
            { kind: "text", text: ") (" },
            { kind: "link", text: "abc1234", href: `${REPOSITORY_URL}/commit/abc1234` },
            { kind: "text", text: ")" },
          ],
          [{ kind: "text", text: "another" }],
        ],
      },
      { kind: "heading", level: 3, content: [{ kind: "text", text: "BREAKING CHANGES" }] },
      { kind: "paragraph", content: [{ kind: "text", text: "Something stopped working as it did." }] },
    ]);
  });

  it("links only to web addresses", () => {
    expect(parseChangelog("[click](javascript:void)")).toEqual([
      { kind: "paragraph", content: [{ kind: "text", text: "[click](javascript:void)" }] },
    ]);
  });
});
