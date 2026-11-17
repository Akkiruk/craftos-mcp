// The public copy's view of a file: scripts/export-public.mjs writes it, and the world schema test builds the public
// schema from it. This file goes public itself, so it spells the markers in pieces: a whole marker here would read as
// one when the export strips this file.
const START = "@private" + "-start";
const END = "@private" + "-end";

/**
 * Drop every block between a line containing the start marker and the next line containing the end marker, and turn
 * `<indent>// @public: <code>` (or `-- @public:` / `# @public:`) into `<indent><code>`: the public variant of a line.
 */
export function stripPrivate(text, path) {
  text = text.replace(/^([ \t]*)(?:\/\/|--|#) @public: ?(.*)$/gm, "$1$2");
  text = text.replace(/^<!-- @public: ?(.*?) ?-->$/gm, "$1"); // markdown
  if (!text.includes(START) && !text.includes(END)) return text;
  const lines = text.split("\n");
  const kept = [];
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    if (line.includes(START)) depth++;
    else if (line.includes(END)) {
      if (depth === 0)
        throw new Error(`${path}:${i + 1}: ${END} without a start`);
      depth--;
    } else if (depth === 0) kept.push(line);
  }
  if (depth !== 0) throw new Error(`${path}: ${START} never ended`);
  return kept.join("\n");
}
