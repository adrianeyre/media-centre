/** A file's text, built into the Remote by Vite, as `CHANGELOG.md` is. */
declare module "*.md?raw" {
  const text: string;
  export default text;
}
