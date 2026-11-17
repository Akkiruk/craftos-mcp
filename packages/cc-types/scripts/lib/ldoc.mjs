// Read the doc comments of a CC:Tweaked ROM file (LDoc as illuaminate reads it) and turn their types into
// lua-language-server ones.

/** illuaminate type names -> ours. Anything not here and not a Lua type is reported and becomes `any`. */
export const TYPE_NAMES = {
  number: "number",
  string: "string",
  boolean: "boolean",
  table: "table",
  nil: "nil",
  any: "any",
  function: "function",
  true: "true",
  false: "false",
  coroutine: "thread",
  Vector: "cc.Vector",
  Redirect: "cc.Redirect",
  "term.Redirect": "cc.Redirect",
  Window: "cc.Window",
  "window.Window": "cc.Window",
  Handle: "cc.io.Handle",
  Doc: "cc.pretty.Doc",
  "cc.pretty.Doc": "cc.pretty.Doc",
  Response: "cc.http.Response",
  "http.Response": "cc.http.Response",
  Websocket: "cc.http.Websocket",
  "http.Websocket": "cc.http.Websocket",
  "fs.ReadHandle": "cc.fs.ReadHandle",
  "fs.WriteHandle": "cc.fs.WriteHandle",
  "fs.ReadWriteHandle": "cc.fs.ReadWriteHandle",
  "fs.BinaryReadHandle": "cc.fs.ReadHandle",
  "fs.BinaryWriteHandle": "cc.fs.WriteHandle",
  "file_transfer.TransferredFile": "cc.TransferredFile",
};

export class TypeError extends Error {}

/**
 * Parse one illuaminate type starting at `start`. Returns { type, end, vararg }: `type` in lua-language-server
 * syntax, `end` the index after it, `vararg` when it ended in `...`.
 */
export function parseType(text, start, unknown = () => {}) {
  let i = start;
  const peek = () => text[i];
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const fail = (what) => {
    throw new TypeError(
      `${what} at ${i} in ${JSON.stringify(text.slice(start, start + 60))}`,
    );
  };

  function name() {
    const m = /^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)*/.exec(text.slice(i));
    if (!m) fail("expected a type name");
    i += m[0].length;
    return m[0];
  }

  // nested: inside {} or (), where spaces around | and before ... are fine
  function union(nested) {
    const parts = [];
    let vararg = false;
    for (;;) {
      const a = atom(nested);
      parts.push(a.type);
      if (nested) ws();
      if (text.startsWith("...", i)) {
        i += 3;
        vararg = true;
        if (nested) ws();
      }
      const save = i;
      if (nested) ws();
      if (peek() === "|") {
        i++;
        if (nested) ws();
        continue;
      }
      i = save;
      break;
    }
    const flat = [...new Set(parts)];
    return { type: flat.join("|"), vararg, single: flat.length === 1 };
  }

  function atom(nested) {
    const c = peek();
    if (c === "{") return table();
    if (c === "(") {
      i++;
      ws();
      const inner = union(true);
      ws();
      if (peek() !== ")") fail("expected )");
      i++;
      return { type: inner.single ? inner.type : `(${inner.type})` };
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) fail("unclosed string");
      const s = text.slice(i, end + 1);
      i = end + 1;
      return { type: `"${s.slice(1, -1)}"` };
    }
    if (/[0-9-]/.test(c ?? "")) {
      const m = /^-?\d+(\.\d+)?/.exec(text.slice(i));
      if (!m) fail("bad number");
      i += m[0].length;
      return { type: m[0] };
    }
    const n = name();
    if (n === "function" && peek() === "(") return func();
    if (TYPE_NAMES[n]) return { type: TYPE_NAMES[n] };
    unknown(n);
    return { type: "any" };
  }

  function func() {
    i++; // (
    const params = [];
    ws();
    let index = 0;
    while (peek() !== ")") {
      if (i >= text.length) fail("unclosed function type");
      index++;
      // `name: type`, or just a type
      const m = /^([A-Za-z_]\w*)\s*:\s*/.exec(text.slice(i));
      let pname;
      if (m) {
        pname = m[1];
        i += m[0].length;
      }
      if (text.startsWith("...", i)) {
        i += 3;
        params.push("...: any");
      } else {
        const t = union(true);
        if (t.vararg) params.push(`...: ${t.type}`);
        else params.push(`${pname ?? "arg" + index}: ${t.type}`);
      }
      ws();
      if (peek() === ",") {
        i++;
        ws();
      }
    }
    i++; // )
    let ret = "";
    if (peek() === ":") {
      i++;
      const save = i;
      ws();
      // a return type follows only when it is glued on or one space away
      if (i - save > 1) i = save;
      else {
        const r = union(false);
        ret = `: ${r.type}`;
      }
    }
    return { type: `fun(${params.join(", ")})${ret}` };
  }

  function table() {
    i++; // {
    const fields = [];
    let array;
    let map;
    ws();
    while (peek() !== "}") {
      if (i >= text.length) fail("unclosed table type");
      if (peek() === "[") {
        i++;
        ws();
        const k = union(true);
        ws();
        if (peek() !== "]") fail("expected ]");
        i++;
        ws();
        if (peek() !== "=") fail("expected =");
        i++;
        ws();
        const v = union(true);
        map = `table<${k.type}, ${v.type}>`;
      } else {
        const m = /^([A-Za-z_]\w*)\s*(\?)?\s*(\?)?=\s*/.exec(text.slice(i));
        if (m && !text.slice(i).startsWith(m[1] + "...")) {
          i += m[0].length;
          const v = union(true);
          fields.push(`${m[1]}${m[2] || m[3] ? "?" : ""}: ${v.type}`);
        } else {
          const v = union(true);
          array = v.single ? `${v.type}[]` : `(${v.type})[]`;
        }
      }
      ws();
      if (peek() === ",") {
        i++;
        ws();
      }
    }
    i++; // }
    if (fields.length && !array && !map)
      return { type: `{ ${fields.join(", ")} }` };
    if (array && !fields.length && !map) return { type: array };
    if (map && !fields.length && !array) return { type: map };
    return { type: "table" };
  }

  const result = union(false);
  return { type: result.type, end: i, vararg: result.vararg };
}

/** Markdown of a doc comment, with illuaminate's reference links flattened to code spans. */
export function cleanText(text) {
  return text
    .replace(/\[([^\]]+)\]\[`[^`\]]+`\]/g, "$1") // [text][`ref`]
    .replace(/\[(`[^`\]]+`)\]/g, "$1") // [`ref`]
    .replace(
      /^> \[!(\w+)\]\s*$/gm,
      (_, kind) => `> **${kind[0]}${kind.slice(1).toLowerCase()}**`,
    )
    .replace(/[ \t]+$/gm, "");
}

function parseTagHead(raw) {
  // "[1,opt=true]" -> { group: 1, opt: true, default: "true" }
  const mods = { group: undefined, opt: false, default: undefined };
  for (const part of raw.split(",").map((s) => s.trim())) {
    if (/^\d+$/.test(part)) mods.group = Number(part);
    else if (part === "opt") mods.opt = true;
    else if (part.startsWith("opt=")) {
      mods.opt = true;
      mods.default = part.slice(4);
    }
  }
  return mods;
}

/**
 * One doc comment -> { summary, body, params, returns, since, changed, deprecated, throws, see, module, type, local,
 * usage }. `params`: { name, type, opt, default, desc, group }. `returns`: { type, desc, group, vararg }.
 */
export function parseDoc(text, onUnknown = () => {}) {
  const lines = text.split("\n");
  const head = [];
  const tags = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^\s*@([\w.]+)(?:\[([^\]]*)\])?[ \t]*(.*)$/.exec(line);
    if (m) tags.push({ tag: m[1], mods: m[2] ?? "", text: m[3] });
    else if (tags.length) tags[tags.length - 1].text += "\n" + line;
    else head.push(line);
  }
  const body = cleanText(head.join("\n")).trim();
  const doc = {
    body,
    summary: body.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " "),
    params: [],
    returns: [],
    changed: [],
    throws: [],
    see: [],
    usage: [],
  };
  let paramGroup = 1;
  let returnGroup = 1;
  const oneLine = (s) =>
    cleanText(s)
      .replace(/\s*\n\s*/g, " ")
      .trim();
  for (const { tag, mods, text: raw } of tags) {
    const text = raw.replace(/^\s+/, "");
    if (tag === "tparam" || tag === "param") {
      const m = parseTagHead(mods);
      if (m.group !== undefined) paramGroup = m.group;
      let type = "any";
      let rest = text;
      let vararg = false;
      if (tag === "tparam") {
        try {
          const t = parseType(text, 0, onUnknown);
          type = t.type;
          vararg = t.vararg;
          rest = text.slice(t.end).replace(/^\s+/, "");
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          onUnknown(error.message);
          rest = text.replace(/^\S+\s*/, "");
        }
      }
      const nm = /^(\.\.\.|[A-Za-z_]\w*)\s*/.exec(rest);
      if (!nm) {
        onUnknown(
          `parameter without a name: ${JSON.stringify(text.slice(0, 50))}`,
        );
        continue;
      }
      doc.params.push({
        name: nm[1],
        type,
        vararg,
        opt: m.opt,
        default: m.default,
        desc: oneLine(rest.slice(nm[0].length)),
        group: paramGroup,
      });
    } else if (tag === "treturn" || tag === "return") {
      const m = parseTagHead(mods);
      if (m.group !== undefined) returnGroup = m.group;
      let type = "any";
      let rest = text;
      let vararg = false;
      if (tag === "treturn") {
        try {
          const t = parseType(text, 0, onUnknown);
          type = t.type;
          vararg = t.vararg;
          rest = text.slice(t.end);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          onUnknown(error.message);
          rest = text.replace(/^\S+\s*/, "");
        }
      }
      doc.returns.push({
        type,
        vararg,
        desc: oneLine(rest),
        group: returnGroup,
      });
    } else if (tag === "since") doc.since = text.trim();
    else if (tag === "changed") doc.changed.push(oneLine(text));
    else if (tag === "deprecated") doc.deprecated = oneLine(text) || true;
    else if (tag === "throws") doc.throws.push(oneLine(text));
    else if (tag === "see") doc.see.push(text.trim().split(/\s/)[0]);
    else if (tag === "module") doc.module = text.trim();
    else if (tag === "type") doc.type = text.trim();
    else if (tag === "local") doc.local = true;
    else if (tag === "usage") doc.usage.push(text);
  }
  return doc;
}

/**
 * Every doc comment of a Lua file with the line of code it documents: [{ doc, code, indent }]. `code` is the first
 * line after the comment that is not blank.
 */
export function docComments(source, onUnknown = () => {}) {
  const lines = source.split(/\r?\n/);
  const found = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let text;
    const long = /^\s*--\[(=*)\[-(.*)$/.exec(line);
    if (long) {
      const close = `]${long[1]}]`;
      const parts = [];
      let rest = long[2];
      for (;;) {
        const at = rest.indexOf(close);
        if (at >= 0) {
          parts.push(rest.slice(0, at));
          break;
        }
        parts.push(rest);
        i++;
        if (i >= lines.length) break;
        rest = lines[i];
      }
      i++;
      // drop the indent the whole block shares
      const body = parts.slice(1).filter((l) => l.trim());
      const indent = Math.min(...body.map((l) => /^\s*/.exec(l)[0].length), 99);
      text = [
        parts[0].trim(),
        ...parts
          .slice(1)
          .map((l) => l.slice(Math.min(indent, /^\s*/.exec(l)[0].length))),
      ].join("\n");
    } else if (/^\s*---(?!-)/.test(line)) {
      const parts = [line.replace(/^\s*---\s?/, "")];
      i++;
      while (i < lines.length && /^\s*--(?!\[=*\[)/.test(lines[i])) {
        parts.push(lines[i].replace(/^\s*--\s?/, ""));
        i++;
      }
      text = parts.join("\n");
    } else {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    const code = lines[j] ?? "";
    found.push({
      doc: parseDoc(text, onUnknown),
      code: code.trim(),
      indent: /^\s*/.exec(code)[0].length,
      expects: expectCalls(lines, j),
      returnsValue: returnsValue(lines, j),
    });
  }
  return found;
}

/**
 * Does the function that starts on line `at` return anything? A doc comment without @treturn does not say it returns
 * nothing: the code does.
 */
function returnsValue(lines, at) {
  const first = lines[at] ?? "";
  const indent = /^\s*/.exec(first)[0];
  const returns = (line) =>
    /(^|\s)return\s+[^\s;-]/.test(line.replace(/--.*$/, ""));
  if (/\bend\s*,?\s*$/.test(first) && /\bfunction\b/.test(first))
    return returns(first);
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.startsWith(indent + "end") &&
      !/^\s/.test(line.slice(indent.length))
    )
      return false;
    if (returns(line)) return true;
  }
  return false;
}

/**
 * The cc.expect checks at the top of a function that starts on line `at`: { [argument name]: [types] }. This is what
 * the function really accepts, and now and then the doc comment forgets that an argument may be left out.
 */
function expectCalls(lines, at) {
  const found = {};
  const indent = /^\s*/.exec(lines[at] ?? "")[0];
  for (let i = at + 1; i < Math.min(lines.length, at + 40); i++) {
    const line = lines[i];
    if (
      line.startsWith(indent + "end") ||
      /^\s*(local\s+)?function\b/.test(line)
    )
      break;
    for (const m of line.matchAll(
      /\bexpect\(\s*\d+\s*,\s*([A-Za-z_]\w*)\s*((?:,\s*"[a-z]+"\s*)+)\)/g,
    )) {
      found[m[1]] ??= [...m[2].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    }
  }
  return found;
}

/** `return { a = b, c = d }` at the end of a module -> { a: "b", c: "d" }. */
export function moduleExports(source) {
  const at = source.lastIndexOf("\nreturn ");
  if (at < 0) return {};
  const tail = source.slice(at);
  const open = tail.indexOf("{");
  if (open < 0) return {};
  const close = tail.indexOf("}", open);
  const out = {};
  for (const m of tail
    .slice(open + 1, close)
    .matchAll(/([A-Za-z_]\w*)\s*=\s*([A-Za-z_][\w.]*)/g))
    out[m[1]] = m[2];
  return out;
}

/** What a line of code defines: { kind: "function"|"value", path: ["a","b"], local, args, self, value }. */
export function definition(code) {
  let m;
  if (
    (m = /^(local\s+)?function\s+([\w.]+)(?::(\w+))?\s*\(([^)]*)\)/.exec(code))
  ) {
    const path = m[2].split(".");
    if (m[3]) path.push(m[3]);
    return {
      kind: "function",
      path,
      local: !!m[1],
      method: !!m[3],
      args: splitArgs(m[4]),
    };
  }
  if ((m = /^(local\s+)?([\w.]+)\s*=\s*function\s*\(([^)]*)\)/.exec(code)))
    return {
      kind: "function",
      path: m[2].split("."),
      local: !!m[1],
      args: splitArgs(m[3]),
    };
  if ((m = /^(local\s+)?([\w.]+)\s*=\s*(.+?)\s*,?$/.exec(code)))
    return { kind: "value", path: m[2].split("."), local: !!m[1], value: m[3] };
  if ((m = /^local\s+(\w+)\s*$/.exec(code)))
    return { kind: "value", path: [m[1]], local: true, value: "" };
  return undefined;
}

function splitArgs(s) {
  return s
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}
