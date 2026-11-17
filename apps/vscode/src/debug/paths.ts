// The debugger's small conversions: a file in the editor against the same file on the computer, a breakpoint's hit
// count and log message as the engine takes them, and how variables are named and ordered. No vscode import and
// nothing but arithmetic on strings, so the unit tests cover all of it.
import { isAbsolute, join, relative } from "node:path";

/**
 * Where a file of the project is on the computer. The emulator copies the project folder (`root`) into the computer's
 * root, so `<root>/lib/util.lua` is `/lib/util.lua`, which is also how the ROM names the chunk it loads from it.
 * Undefined for a file outside the folder: the computer has no such file.
 */
export function toComputerPath(file: string, root: string): string | undefined {
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return `/${rel.split("\\").join("/")}`;
}

/** The project's file for a path on the computer ("/lib/util.lua"), wherever that would be. Undefined for a chunk
 * that is no file of the computer ("bios.lua", the BIOS). */
export function toHostPath(
  computerPath: string,
  root: string,
): string | undefined {
  if (!computerPath.startsWith("/")) return undefined;
  const parts = computerPath.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) return undefined;
  return join(root, ...parts);
}

/** The last part of a path, for either kind of slash. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export interface HitCondition {
  readonly hitOp: "==" | ">=" | ">" | "%";
  readonly hitN: number;
}

/**
 * A breakpoint's hit count: "5" (from the fifth hit on), ">= 5", "> 5", "== 5" or "= 5" (only the fifth), "% 5"
 * (every fifth). Undefined for anything else, which the adapter reports back on the breakpoint.
 */
export function parseHitCondition(text: string): HitCondition | undefined {
  const m = /^\s*(==?|>=|>|%)?\s*(\d+)\s*$/.exec(text);
  if (!m) return undefined;
  const hitN = Number(m[2]);
  const op = m[1] ?? ">=";
  if (op === "%" && hitN === 0) return undefined;
  return { hitOp: op === "=" ? "==" : (op as HitCondition["hitOp"]), hitN };
}

/** A Lua string literal for any text (bytes over 127 are left to the JSON on the way to the engine). */
export function luaQuote(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 32 || code === 127) out += `\\${code}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * A logpoint's message as one Lua expression: "x is {x} of {#list}" becomes
 * `"x is " .. tostring((x)) .. " of " .. tostring((#list))`. A brace that is never closed is plain text.
 */
export function logExpression(message: string): string {
  const parts: string[] = [];
  let rest = message;
  for (;;) {
    const open = rest.indexOf("{");
    const close = open < 0 ? -1 : rest.indexOf("}", open + 1);
    if (open < 0 || close < 0) break;
    if (open > 0) parts.push(luaQuote(rest.slice(0, open)));
    const expr = rest.slice(open + 1, close).trim();
    parts.push(expr ? `tostring((${expr}))` : luaQuote("{}"));
    rest = rest.slice(close + 1);
  }
  if (rest || parts.length === 0) parts.push(luaQuote(rest));
  return parts.join(" .. ");
}

/** The expression for a table's entry, from the table's own: `t` and `x` give `t.x`, `t` and `[1]` give `t[1]`. */
export function childExpression(parent: string, name: string): string {
  return name.startsWith("[") ? `${parent}${name}` : `${parent}.${name}`;
}

/**
 * What to evaluate when the mouse rests on a column of a line: the name there with the names it hangs off, so that
 * `config.screen.width` gives `config` on its first word, `config.screen` on its second and the whole on its third.
 * Only names and dots: nothing that could call a function. Undefined when the column is on no name (or on a number).
 */
export function hoverExpression(
  line: string,
  column: number,
): { start: number; end: number; expression: string } | undefined {
  const chain = /[A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/g;
  for (let m = chain.exec(line); m; m = chain.exec(line)) {
    const start = m.index;
    if (column < start || column > start + m[0].length) continue;
    // a name glued to a digit before it is part of a number (1e5, 0xff)
    if (start > 0 && /[0-9.]/.test(line[start - 1]!)) return undefined;
    // words in a string or a comment are not variables (as far as one line can tell)
    const before = line.slice(0, start).replace(/\\./g, "");
    const code = before.replace(/"[^"]*"|'[^']*'/g, "");
    if (/["']/.test(code) || code.includes("--")) return undefined;
    // cut after the word the column is on
    const word = /[A-Za-z0-9_]*/y;
    let end = column;
    while (end > start && /[A-Za-z0-9_]/.test(line[end - 1]!)) end--;
    word.lastIndex = end;
    end += word.exec(line)?.[0].length ?? 0;
    if (end <= start) return undefined;
    const expression = line.slice(start, end).replace(/\s+/g, "");
    if (!expression || expression.endsWith(".")) return undefined;
    return { start, end, expression };
  }
  return undefined;
}

/** A variable as the engine reports it (debug_server.cpp variableJson). */
export interface EngineVariable {
  readonly name: string;
  readonly value: string;
  readonly type: string;
  /** A table: the number to ask its entries by, good until the program runs on. */
  readonly ref?: number;
  /** The name can follow its parent's in an expression. */
  readonly ek?: boolean;
}

/**
 * A table's entries in reading order: the list part by index, then the named ones by name, then other keys, and the
 * metatable last. Lua hands them over in hash order, which changes from run to run.
 */
export function sortEntries(
  entries: readonly EngineVariable[],
): EngineVariable[] {
  const rank = (v: EngineVariable): [number, number, string] => {
    if (v.name === "(metatable)") return [3, 0, ""];
    const index = /^\[(-?\d+(?:\.\d+)?)\]$/.exec(v.name);
    if (index) return [0, Number(index[1]), ""];
    if (!v.name.startsWith("[")) return [1, 0, v.name];
    return [2, 0, v.name];
  };
  return [...entries].sort((a, b) => {
    const [ra, na, sa] = rank(a);
    const [rb, nb, sb] = rank(b);
    return ra - rb || na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
  });
}

/** A stack frame as the engine reports it (debug_server.cpp cmdStack). */
export interface EngineFrame {
  /** Its place in the whole stack, 0 on top: what locals, upvalues and eval take as `frame`. */
  readonly i: number;
  /** Which coroutine: 0 is the one that stopped, 1 the one that resumed it, and so on. */
  readonly thread: number;
  /** "Lua", "main" (a file's own code) or "C". */
  readonly what: string;
  readonly line: number;
  readonly name?: string;
  /** "/dir/file.lua" for a file on the computer, "bios.lua" for the BIOS, "" for none. */
  readonly path: string;
  /** The program's own code, not the ROM's. */
  readonly user: boolean;
  /** For code that came from a string: how Lua shows where it is from. */
  readonly chunk?: string;
  readonly defined: number;
}

/** What the Call Stack view calls a frame. */
export function frameName(frame: EngineFrame): string {
  if (frame.what === "C") return `[C] ${frame.name ?? "?"}`;
  if (frame.what === "main") return "main chunk";
  if (frame.name) return frame.name;
  const where = frame.path ? baseName(frame.path) : (frame.chunk ?? "?");
  return `function <${where}:${frame.defined}>`;
}
