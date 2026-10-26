/** Characters as a person counts them, so "é" or an emoji is one. */
export const characters = (text: string): number => [...new Intl.Segmenter().segment(text)].length;

/** The first `count` characters, as {@link characters} counts them. */
export const firstCharacters = (text: string, count: number): string =>
  [...new Intl.Segmenter().segment(text)]
    .slice(0, count)
    .map(({ segment }) => segment)
    .join("");

/** The name with case ignored, so "Bedroom" and "bedroom" are the same. */
export const nameKey = (name: string): string => name.toLowerCase();
