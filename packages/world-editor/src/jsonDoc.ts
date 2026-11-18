// A JSON text and edits to it that touch only what changed: the world editor sets, adds and removes values by path,
// and everything else in the file (key order, line breaks, indentation, CRLF, inline objects) stays as it was.
// No vscode here, so the unit tests and the webview can use it.

export type JsonPath = readonly (string | number)[];

export interface JsonNode {
  readonly kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  /** Offset of the value's first character. */
  readonly start: number;
  /** Offset just past its last character. */
  readonly end: number;
  readonly value: unknown;
  /** Objects: [key, value] per property, in file order. Arrays: elements. */
  readonly props?: readonly JsonProp[];
  readonly items?: readonly JsonNode[];
}

export interface JsonProp {
  readonly key: string;
  /** Offset of the key's opening quote. */
  readonly keyStart: number;
  readonly value: JsonNode;
}

export class JsonParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

/** Parse JSON (comments and trailing commas tolerated, as VS Code's JSON mode does) into nodes with offsets. */
export function parseTree(text: string): JsonNode | undefined {
  let i = 0;
  const fail = (what: string): never => {
    throw new JsonParseError(what, i);
  };
  const space = (): void => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) i++;
      else if (c === 47 && text[i + 1] === "/") {
        const nl = text.indexOf("\n", i);
        i = nl < 0 ? text.length : nl + 1;
      } else if (c === 47 && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close < 0) fail("Unterminated comment");
        i = close + 2;
      } else return;
    }
  };
  const str = (): string => {
    const start = i;
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined || c === "\n") {
        i = start;
        fail("Unterminated string");
      }
      if (c === "\\") i += 2;
      else if (c === '"') break;
      else i++;
    }
    i++;
    try {
      return JSON.parse(text.slice(start, i)) as string;
    } catch {
      i = start;
      return fail("Bad string escape");
    }
  };
  const value = (): JsonNode => {
    space();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      const props: JsonProp[] = [];
      const obj: Record<string, unknown> = {};
      space();
      while (text[i] !== "}") {
        if (text[i] !== '"') fail("Property name expected");
        const keyStart = i;
        const key = str();
        space();
        if (text[i] !== ":") fail("Colon expected");
        i++;
        const v = value();
        props.push({ key, keyStart, value: v });
        obj[key] = v.value;
        space();
        if (text[i] === ",") {
          i++;
          space();
        } else if (text[i] !== "}") fail("Comma or } expected");
      }
      i++;
      return { kind: "object", start, end: i, value: obj, props };
    }
    if (c === "[") {
      i++;
      const items: JsonNode[] = [];
      space();
      while (text[i] !== "]") {
        if (i >= text.length) fail("Unterminated array");
        const v = value();
        items.push(v);
        space();
        if (text[i] === ",") {
          i++;
          space();
        } else if (text[i] !== "]") fail("Comma or ] expected");
      }
      i++;
      return {
        kind: "array",
        start,
        end: i,
        value: items.map((n) => n.value),
        items,
      };
    }
    if (c === '"') {
      const s = str();
      return { kind: "string", start, end: i, value: s };
    }
    const word =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i, i + 400),
      );
    if (!word) return fail("Value expected");
    i += word[0].length;
    const w = word[0];
    if (w === "true" || w === "false")
      return { kind: "boolean", start, end: i, value: w === "true" };
    if (w === "null") return { kind: "null", start, end: i, value: null };
    return { kind: "number", start, end: i, value: Number(w) };
  };
  space();
  if (i >= text.length) return undefined;
  const root = value();
  space();
  if (i < text.length) fail("End of file expected");
  return root;
}

/** Line and column (both from 1) of an offset, for messages. */
export function lineCol(
  text: string,
  offset: number,
): { line: number; col: number } {
  let line = 1;
  let last = -1;
  for (
    let k = text.indexOf("\n");
    k >= 0 && k < offset;
    k = text.indexOf("\n", k + 1)
  ) {
    line++;
    last = k;
  }
  return { line, col: offset - last };
}

export function nodeAt(
  root: JsonNode | undefined,
  path: JsonPath,
): JsonNode | undefined {
  let node = root;
  for (const seg of path) {
    if (!node) return undefined;
    if (node.kind === "object" && typeof seg === "string")
      node = [...node.props!].reverse().find((p) => p.key === seg)?.value;
    else if (node.kind === "array" && typeof seg === "number")
      node = node.items![seg];
    else return undefined;
  }
  return node;
}

export interface Format {
  readonly eol: string;
  readonly indent: string;
  /** Prettier's printWidth: values that fit go on one line. */
  readonly width: number;
}

export function detectFormat(text: string): Format {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = /\n([ \t]+)\S/.exec(text);
  return { eol, indent: m?.[1] ?? "  ", width: 80 };
}

/**
 * JSON text the way Prettier writes it: objects and arrays on one line, `{ "a": 1 }`, when they fit in the width
 * from `column`, one entry per line otherwise. `base` is the indentation of the line the value starts on.
 */
export function stringify(
  value: unknown,
  fmt: Format,
  base = "",
  column = base.length,
): string {
  const flat = flatText(value);
  if (flat !== undefined && column + flat.length <= fmt.width) return flat;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const inner = base + fmt.indent;
    const parts = value.map((v) => inner + stringify(v, fmt, inner));
    return `[${fmt.eol}${parts.join(`,${fmt.eol}`)}${fmt.eol}${base}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (!entries.length) return "{}";
    const inner = base + fmt.indent;
    const parts = entries.map(([k, v]) => {
      const key = `${inner}${JSON.stringify(k)}: `;
      return key + stringify(v, fmt, inner, key.length);
    });
    return `{${fmt.eol}${parts.join(`,${fmt.eol}`)}${fmt.eol}${base}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function flatText(value: unknown): string | undefined {
  if (Array.isArray(value))
    return value.length
      ? `[${value.map((v) => flatText(v)).join(", ")}]`
      : "[]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    return entries.length
      ? `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${flatText(v)}`).join(", ")} }`
      : "{}";
  }
  return JSON.stringify(value) ?? "null";
}

/** The whitespace at the start of the line `offset` is on. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function column(text: string, offset: number): number {
  return offset - (text.lastIndexOf("\n", offset - 1) + 1);
}

export interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export function applyEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.start) + edit.text + text.slice(edit.end);
}

/** One container's children as spans: a property from its key, an element from its value. */
function spans(node: JsonNode): { start: number; end: number }[] {
  if (node.kind === "object")
    return node.props!.map((p) => ({ start: p.keyStart, end: p.value.end }));
  return node.items!.map((n) => ({ start: n.start, end: n.end }));
}

/** Text for a new child of `node`, put after its last child (or into it when empty). */
function appendChild(
  text: string,
  node: JsonNode,
  childText: (base: string, col: number) => string,
  fmt: Format,
): TextEdit {
  const kids = spans(node);
  if (!kids.length) {
    const base = lineIndent(text, node.start);
    const inner = base + fmt.indent;
    const open = node.start + 1;
    const close = node.end - 1;
    // keep `{}` written over lines as it was; an empty `[]` or `{}` on one line takes the new child inline if it fits
    const one = childText(inner, column(text, node.start) + 2);
    if (
      !one.includes("\n") &&
      column(text, node.start) + one.length + 4 <= fmt.width &&
      !text.slice(open, close).includes("\n")
    )
      return {
        start: open,
        end: close,
        text: node.kind === "object" ? ` ${one} ` : one,
      };
    return {
      start: open,
      end: close,
      text: `${fmt.eol}${inner}${childText(inner, inner.length)}${fmt.eol}${base}`,
    };
  }
  const last = kids[kids.length - 1]!;
  const prev = kids.length > 1 ? kids[kids.length - 2]! : undefined;
  const between = prev
    ? text.slice(prev.end, last.start)
    : text.slice(node.start + 1, last.start);
  if (between.includes("\n")) {
    const base = lineIndent(text, last.start);
    return {
      start: last.end,
      end: last.end,
      text: `,${fmt.eol}${base}${childText(base, base.length)}`,
    };
  }
  // one line: `[a, b]` becomes `[a, b, c]` while it fits
  const col = column(text, last.end) + 2;
  const base = lineIndent(text, node.start);
  const child = childText(base, col);
  const closeLen = text.slice(node.end).split(/\r?\n/)[0]!.length + 1;
  if (!child.includes("\n") && col + child.length + closeLen <= fmt.width)
    return { start: last.end, end: last.end, text: `, ${child}` };
  // too long for one line: one child per line, as Prettier breaks it, each old child keeping its own text
  const inner = base + fmt.indent;
  const parts = kids.map((k) => inner + text.slice(k.start, k.end));
  parts.push(inner + childText(inner, inner.length));
  return {
    start: node.start + 1,
    end: node.end - 1,
    text: `${fmt.eol}${parts.join(`,${fmt.eol}`)}${fmt.eol}${base}`,
  };
}

/** Set the value at `path`, making the objects on the way if they are missing. */
export function setEdit(
  text: string,
  path: JsonPath,
  value: unknown,
  fmt = detectFormat(text),
): TextEdit {
  const root = parseTree(text);
  if (!root) {
    let whole: unknown = value;
    for (let k = path.length - 1; k >= 0; k--) {
      const seg = path[k]!;
      whole = typeof seg === "number" ? [whole] : { [seg]: whole };
    }
    return {
      start: 0,
      end: text.length,
      text: stringify(whole, fmt) + fmt.eol,
    };
  }
  let node = root;
  for (let k = 0; k < path.length; k++) {
    const seg = path[k]!;
    const next = nodeAt(node, [seg]);
    if (next) {
      node = next;
      continue;
    }
    let rest: unknown = value;
    for (let j = path.length - 1; j > k; j--) {
      const s = path[j]!;
      rest = typeof s === "number" ? [rest] : { [s]: rest };
    }
    if (node.kind === "object" && typeof seg === "string")
      return appendChild(
        text,
        node,
        (base, col) => {
          const key = `${JSON.stringify(seg)}: `;
          return key + stringify(rest, fmt, base, col + key.length);
        },
        fmt,
      );
    if (
      node.kind === "array" &&
      typeof seg === "number" &&
      seg === node.items!.length
    )
      return appendChild(
        text,
        node,
        (base, col) => stringify(rest, fmt, base, col),
        fmt,
      );
    // the path runs through a value of another kind: replace that value
    let whole: unknown = rest;
    whole = typeof seg === "number" ? [whole] : { [seg]: whole };
    return replaceNode(text, node, whole, fmt);
  }
  return replaceNode(text, node, value, fmt);
}

function replaceNode(
  text: string,
  node: JsonNode,
  value: unknown,
  fmt: Format,
): TextEdit {
  if (JSON.stringify(node.value) === JSON.stringify(value))
    return { start: node.start, end: node.start, text: "" };
  const base = lineIndent(text, node.start);
  return {
    start: node.start,
    end: node.end,
    text: stringify(value, fmt, base, column(text, node.start)),
  };
}

/** Append `value` to the array at `path` (made if missing). */
export function pushEdit(
  text: string,
  path: JsonPath,
  value: unknown,
  fmt = detectFormat(text),
): TextEdit {
  const arr = nodeAt(parseTree(text), path);
  if (arr?.kind === "array")
    return setEdit(text, [...path, arr.items!.length], value, fmt);
  return setEdit(text, path, [value], fmt);
}

/** Remove the property or element at `path`, with its comma. Nothing to remove: an empty edit. */
export function removeEdit(text: string, path: JsonPath): TextEdit {
  const none = { start: 0, end: 0, text: "" };
  if (!path.length) return none;
  const root = parseTree(text);
  const parent = nodeAt(root, path.slice(0, -1));
  if (!parent || (parent.kind !== "object" && parent.kind !== "array"))
    return none;
  const seg = path[path.length - 1]!;
  const kids = spans(parent);
  const index =
    parent.kind === "object"
      ? parent.props!.map((p) => p.key).lastIndexOf(String(seg))
      : typeof seg === "number"
        ? seg
        : -1;
  if (index < 0 || index >= kids.length) return none;
  const kid = kids[index]!;
  // `{ "a": 1 }` and `{\n  "a": 1\n}` both become `{}`
  if (kids.length === 1)
    return { start: parent.start + 1, end: parent.end - 1, text: "" };
  if (index < kids.length - 1)
    return { start: kid.start, end: kids[index + 1]!.start, text: "" };
  return { start: kids[index - 1]!.end, end: kid.end, text: "" };
}

/** Move an array element from one place to another (removing then inserting its own text). */
export function moveEdit(
  text: string,
  path: JsonPath,
  from: number,
  to: number,
): string {
  const arr = nodeAt(parseTree(text), path);
  if (arr?.kind !== "array" || from === to) return text;
  const items = [...(arr.value as unknown[])];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return applyEdit(text, setEdit(text, path, items));
}

export type EditOp =
  | { readonly op: "set"; readonly path: JsonPath; readonly value: unknown }
  | { readonly op: "remove"; readonly path: JsonPath }
  | { readonly op: "push"; readonly path: JsonPath; readonly value: unknown };

/** Apply edit ops in order. Setting `undefined` removes. */
export function applyOps(text: string, ops: readonly EditOp[]): string {
  let out = text;
  const fmt = detectFormat(text);
  for (const o of ops) {
    if (o.op === "remove" || (o.op === "set" && o.value === undefined))
      out = applyEdit(out, removeEdit(out, o.path));
    else if (o.op === "set")
      out = applyEdit(out, setEdit(out, o.path, o.value, fmt));
    else out = applyEdit(out, pushEdit(out, o.path, o.value, fmt));
  }
  return out;
}

/** The smallest single replacement that turns `before` into `after`: what goes into the document. */
export function minimalEdit(
  before: string,
  after: string,
): TextEdit | undefined {
  if (before === after) return undefined;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start))
    start++;
  let tail = 0;
  while (
    tail < max - start &&
    before.charCodeAt(before.length - 1 - tail) ===
      after.charCodeAt(after.length - 1 - tail)
  )
    tail++;
  return {
    start,
    end: before.length - tail,
    text: after.slice(start, after.length - tail),
  };
}
