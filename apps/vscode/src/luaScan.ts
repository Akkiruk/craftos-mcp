// A light Lua tokenizer (strings, long strings and comments skipped properly, not regexes on raw lines), and what
// is read from its tokens: the tests a *.test.lua declares (CodeLens, the Testing view) and the version-aware
// warnings (diagnostics.ts): goto on Lua 5.1, calls only the emulator has, peripherals of addons that are off.
//
// No vscode import: the unit tests load this file in plain Node.
import {
  type PackData,
  ccFor,
  enabledAddons,
  reportedType,
  typeExistsOn,
  typeOwners,
} from "./pack.ts";

export type TokenKind = "name" | "string" | "number" | "op";

export interface Token {
  kind: TokenKind;
  /** The text as written; for a string, its value. */
  value: string;
  /** Offsets into the source, end exclusive. */
  start: number;
  end: number;
  /** 0-based. */
  line: number;
  col: number;
}

const OPS = ["...", "..", "::", "==", "~=", "<=", ">=", "//", "<<", ">>"];

/** The length of a long bracket opening at `i` (`[[`, `[==[`), or 0 when there is none; and its level. */
function longOpen(src: string, i: number): { len: number; level: number } {
  if (src[i] !== "[") return { len: 0, level: 0 };
  let j = i + 1;
  while (src[j] === "=") j++;
  return src[j] === "["
    ? { len: j - i + 1, level: j - i - 1 }
    : { len: 0, level: 0 };
}

function decodeEscape(src: string, i: number): { text: string; next: number } {
  const c = src[i];
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    a: "\x07",
    b: "\b",
    f: "\f",
    v: "\v",
  };
  if (c === undefined) return { text: "", next: i };
  if (simple[c] !== undefined) return { text: simple[c]!, next: i + 1 };
  if (c === "x") {
    const hex = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 1, i + 3))?.[0] ?? "";
    return {
      text: hex ? String.fromCharCode(parseInt(hex, 16)) : "x",
      next: i + 1 + hex.length,
    };
  }
  if (c === "z") {
    let j = i + 1;
    while (j < src.length && /\s/.test(src[j]!)) j++;
    return { text: "", next: j };
  }
  if (c === "u" && src[i + 1] === "{") {
    const close = src.indexOf("}", i);
    const code = close > 0 ? parseInt(src.slice(i + 2, close), 16) : NaN;
    if (!Number.isNaN(code))
      return { text: String.fromCodePoint(code), next: close + 1 };
  }
  if (/\d/.test(c)) {
    const digits = /^\d{1,3}/.exec(src.slice(i, i + 3))![0];
    return {
      text: String.fromCharCode(Number(digits)),
      next: i + digits.length,
    };
  }
  if (c === "\r" && src[i + 1] === "\n") return { text: "\n", next: i + 2 };
  return { text: c, next: i + 1 };
}

/** Lua's tokens, comments and whitespace dropped. Never throws: an unfinished string ends at its line's end. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;
  /** Move past src[from, to), counting the newlines in it. */
  const advance = (to: number): void => {
    for (let k = i; k < to; k++)
      if (src[k] === "\n") {
        line++;
        lineStart = k + 1;
      }
    i = to;
  };
  const push = (
    kind: TokenKind,
    value: string,
    start: number,
    startLine: number,
    startCol: number,
  ) =>
    tokens.push({ kind, value, start, end: i, line: startLine, col: startCol });
  while (i < src.length) {
    const c = src[i]!;
    if (
      c === "\n" ||
      c === " " ||
      c === "\t" ||
      c === "\r" ||
      c === "\f" ||
      c === "\v"
    ) {
      advance(i + 1);
      continue;
    }
    const start = i;
    const startLine = line;
    const startCol = i - lineStart;
    // a #! line at the very start, as lua does
    if (i === 0 && c === "#" && src[1] === "!") {
      const nl = src.indexOf("\n");
      advance(nl < 0 ? src.length : nl);
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      const long = longOpen(src, i + 2);
      if (long.len) {
        const close = src.indexOf(
          `]${"=".repeat(long.level)}]`,
          i + 2 + long.len,
        );
        advance(close < 0 ? src.length : close + long.level + 2);
      } else {
        const nl = src.indexOf("\n", i);
        advance(nl < 0 ? src.length : nl);
      }
      continue;
    }
    const long = longOpen(src, i);
    if (long.len) {
      const close = src.indexOf(`]${"=".repeat(long.level)}]`, i + long.len);
      const end = close < 0 ? src.length : close;
      // a newline right after the opening bracket is not part of the string
      let body = src.slice(i + long.len, end);
      if (body.startsWith("\r\n")) body = body.slice(2);
      else if (body.startsWith("\n")) body = body.slice(1);
      advance(close < 0 ? src.length : close + long.level + 2);
      push("string", body, start, startLine, startCol);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") {
          const esc = decodeEscape(src, j + 1);
          value += esc.text;
          j = esc.next;
        } else value += src[j++];
      }
      advance(src[j] === c ? j + 1 : j);
      push("string", value, start, startLine, startCol);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      advance(j);
      push("name", src.slice(start, i), start, startLine, startCol);
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      const m =
        /^(0[xX][0-9a-fA-F.]*([pP][+-]?\d+)?|[0-9.]+([eE][+-]?\d+)?)/.exec(
          src.slice(i),
        )!;
      advance(i + m[0].length);
      push("number", m[0], start, startLine, startCol);
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? c;
    advance(i + op.length);
    push("op", op, start, startLine, startCol);
  }
  return tokens;
}

const KEYWORDS = new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while",
]);

const isOp = (t: Token | undefined, op: string): boolean =>
  t?.kind === "op" && t.value === op;
const isName = (t: Token | undefined, name?: string): boolean =>
  t?.kind === "name" && (name === undefined || t.value === name);
/** A name used on its own: not a field (`x.name`, `x:name`). */
const freeName = (tokens: Token[], i: number, name?: string): boolean =>
  isName(tokens[i], name) &&
  !isOp(tokens[i - 1], ".") &&
  !isOp(tokens[i - 1], ":");

/** The index of the `)` matching the `(` at `open`, or the last token. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const v = tokens[i]!.kind === "op" ? tokens[i]!.value : "";
    if (v === "(" || v === "{" || v === "[") depth++;
    else if (v === ")" || v === "}" || v === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/**
 * The names a file declares itself, anywhere: locals, function parameters, loop variables, `function name`, and
 * plain `name =` assignments. A global the scanner would flag is left alone when the file has its own of that name.
 */
export function declaredNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isName(t, "local") || isName(t, "for")) {
      let j = i + 1;
      if (isName(tokens[j], "function")) j++;
      while (isName(tokens[j]) && !KEYWORDS.has(tokens[j]!.value)) {
        names.add(tokens[j]!.value);
        j++;
        // <const> / <close> attributes
        if (isOp(tokens[j], "<")) j += 3;
        if (!isOp(tokens[j], ",")) break;
        j++;
      }
    } else if (isName(t, "function")) {
      let j = i + 1;
      if (
        isName(tokens[j]) &&
        !isOp(tokens[j + 1], ".") &&
        !isOp(tokens[j + 1], ":")
      )
        names.add(tokens[j]!.value);
      while (j < tokens.length && !isOp(tokens[j], "(")) j++;
      const close = closing(tokens, j);
      for (let k = j + 1; k < close; k++)
        if (isName(tokens[k])) names.add(tokens[k]!.value);
    } else if (
      freeName(tokens, i) &&
      isOp(tokens[i + 1], "=") &&
      !KEYWORDS.has(t.value)
    )
      names.add(t.value);
  }
  return names;
}

export interface DeclaredTest {
  name: string;
  /** 0-based line of the call. */
  line: number;
  /** 0-based column of the call. */
  col: number;
}

/**
 * The tests a file declares with a literal name, in order: `ccunit.test("name", ...)`, and calls through a local
 * alias (`local t = ccunit.test`, `local t, eq = ccunit.test, ccunit.eq`). Comments and strings are skipped.
 */
export function findTests(source: string): DeclaredTest[] {
  const tokens = tokenize(source);
  const aliases = new Set<string>();
  const isCcunitTest = (i: number) =>
    freeName(tokens, i, "ccunit") &&
    isOp(tokens[i + 1], ".") &&
    isName(tokens[i + 2], "test");
  for (let i = 0; i < tokens.length; i++) {
    if (!isName(tokens[i], "local")) continue;
    const names: string[] = [];
    let j = i + 1;
    while (isName(tokens[j]) && !KEYWORDS.has(tokens[j]!.value)) {
      names.push(tokens[j]!.value);
      j++;
      if (!isOp(tokens[j], ",")) break;
      j++;
    }
    if (!isOp(tokens[j], "=")) continue;
    j++;
    // values that are plain dotted names (`ccunit.test, ccunit.eq`); the first other kind of value ends the look
    for (let n = 0; n < names.length; n++) {
      if (!isName(tokens[j])) break;
      let k = j + 1;
      while (isOp(tokens[k], ".") && isName(tokens[k + 1])) k += 2;
      const followed = tokens[k];
      const plain =
        !followed ||
        isOp(followed, ",") ||
        isOp(followed, ";") ||
        followed.kind === "name";
      if (!plain) break;
      if (k === j + 3 && isCcunitTest(j)) aliases.add(names[n]!);
      if (!isOp(followed, ",")) break;
      j = k + 1;
    }
  }
  const found: DeclaredTest[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let open = -1;
    if (isCcunitTest(i)) open = i + 3;
    else if (
      freeName(tokens, i) &&
      aliases.has(tokens[i]!.value) &&
      !isName(tokens[i - 1], "local")
    )
      open = i + 1;
    if (
      open < 0 ||
      !isOp(tokens[open], "(") ||
      tokens[open + 1]?.kind !== "string"
    )
      continue;
    found.push({
      name: tokens[open + 1]!.value,
      line: tokens[i]!.line,
      col: tokens[i]!.col,
    });
  }
  return found;
}

export interface Finding {
  code:
    | "goto-lua51"
    | "label-lua51"
    | "missing-on-lua51"
    | "shutdown-exit-code"
    | "craftos-pc-only"
    | "addon-off"
    | "addon-no-release"
    | "type-renamed"
    | "type-not-on-version";
  message: string;
  /** 0-based, end exclusive. */
  start: { line: number; col: number };
  end: { line: number; col: number };
  /** For the quick fix. remove: the source range to delete. addon: the addon to switch on. */
  remove?: {
    start: { line: number; col: number };
    end: { line: number; col: number };
  };
  addon?: string;
}

export interface ScanOptions {
  data: PackData;
  /** The Minecraft version the file runs on. */
  mc: string;
  /** What decides the addons: the world file's `addons`, else the craftos-mcp.addons setting. */
  addons: string | readonly string[] | undefined;
  /** Where `addons` came from, for the messages. */
  addonsFrom: string;
}

/** End position of a token. */
function endOf(t: Token, src: string): { line: number; col: number } {
  const text = src.slice(t.start, t.end);
  const nl = text.lastIndexOf("\n");
  return nl < 0
    ? { line: t.line, col: t.col + text.length }
    : { line: t.line + text.split("\n").length - 1, col: text.length - nl - 1 };
}

/** CraftOS-PC's own globals: the emulator hides them (scripts/rom-patches/startup-emulator.lua), CC:Tweaked has none. */
// `config` and `mounter` are common names for a program's own tables, so only their CraftOS-PC functions count.
const CRAFTOS_PC_GLOBALS: Record<string, Set<string> | "any"> = {
  periphemu: "any",
  ccpc: "any",
  config: new Set([
    "get",
    "set",
    "list",
    "getType",
    "add",
    "delete",
    "setPanicHook",
  ]),
  mounter: new Set(["mount", "unmount", "list", "isReadOnly"]),
};
const CRAFTOS_PC_TERM = new Set([
  "drawPixels",
  "getFrozen",
  "getGraphicsMode",
  "getPixel",
  "getPixels",
  "relativeMouse",
  "screenshot",
  "setFrozen",
  "setGraphicsMode",
  "setPixel",
  "showMouse",
]);
/** Lua 5.2 functions Cobalt 0.6 (CC:Tweaked 1.101.3) lacks: library -> names. */
const MISSING_ON_LUA51: Record<string, string[]> = {
  table: ["move"],
  coroutine: ["isyieldable"],
};

/** The version-aware warnings for one Lua file. */
export function scanLua(source: string, opts: ScanOptions): Finding[] {
  const tokens = tokenize(source);
  const own = declaredNames(tokens);
  const findings: Finding[] = [];
  const cc = ccFor(opts.data, opts.mc);
  const lua51 = cc === "1.101.3";
  const at = (t: Token) => ({ line: t.line, col: t.col });
  const span = (a: Token, b: Token) => ({
    start: at(a),
    end: endOf(b, source),
  });
  const { on } = enabledAddons(opts.data, opts.addons, opts.mc);
  // every string in the file: one that names a type's other name too asks for both (type-renamed)
  const strings = new Set(
    tokens.filter((t) => t.kind === "string").map((t) => t.value),
  );

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (
      lua51 &&
      freeName(tokens, i, "goto") &&
      isName(tokens[i + 1]) &&
      !KEYWORDS.has(tokens[i + 1]!.value) &&
      !isName(tokens[i - 1], "local") &&
      !isName(tokens[i - 1], "function")
    ) {
      findings.push({
        code: "goto-lua51",
        message: `goto needs Lua 5.2, and Minecraft ${opts.mc} (CC:Tweaked ${cc}) runs Lua 5.1: the computer refuses to load this file. Use a loop condition, break or a function instead, or target Minecraft 1.20.1 or newer.`,
        ...span(t, tokens[i + 1]!),
      });
      continue;
    }
    if (
      lua51 &&
      isOp(t, "::") &&
      isName(tokens[i + 1]) &&
      isOp(tokens[i + 2], "::")
    ) {
      findings.push({
        code: "label-lua51",
        message: `Labels (::${tokens[i + 1]!.value}::) need Lua 5.2, and Minecraft ${opts.mc} (CC:Tweaked ${cc}) runs Lua 5.1: the computer refuses to load this file.`,
        ...span(t, tokens[i + 2]!),
      });
      i += 2;
      continue;
    }
    if (
      !freeName(tokens, i) ||
      !isOp(tokens[i + 1], ".") ||
      !isName(tokens[i + 2])
    ) {
      // collectgarbage: CC:Tweaked takes it out of the global table
      if (
        freeName(tokens, i, "collectgarbage") &&
        !own.has(t.value) &&
        isOp(tokens[i + 1], "(")
      )
        findings.push(craftosPc(t.value, span(t, t)));
      continue;
    }
    // lib.field from here on
    const lib = t.value;
    const field = tokens[i + 2]!;
    if (own.has(lib)) continue;
    const pc = Object.hasOwn(CRAFTOS_PC_GLOBALS, lib)
      ? CRAFTOS_PC_GLOBALS[lib]
      : undefined;
    if (pc === "any" || pc?.has(field.value)) {
      findings.push(craftosPc(`${lib}.${field.value}`, span(t, field)));
      continue;
    }
    if (lib === "term" && CRAFTOS_PC_TERM.has(field.value)) {
      findings.push(craftosPc(`term.${field.value}`, span(t, field)));
      continue;
    }
    if (lib === "os" && field.value === "about") {
      findings.push(craftosPc("os.about", span(t, field)));
      continue;
    }
    if (lua51 && MISSING_ON_LUA51[lib]?.includes(field.value)) {
      findings.push({
        code: "missing-on-lua51",
        message: `${lib}.${field.value} is Lua 5.2: CC:Tweaked ${cc} (Minecraft ${opts.mc}) does not have it, so this is nil there.`,
        ...span(t, field),
      });
      continue;
    }
    if (
      lib === "os" &&
      field.value === "shutdown" &&
      isOp(tokens[i + 3], "(") &&
      !isOp(tokens[i + 4], ")")
    ) {
      const close = closing(tokens, i + 3);
      findings.push({
        code: "shutdown-exit-code",
        message:
          "os.shutdown takes no arguments on a real computer: the exit code only exists in the emulator (craftos-mcp's exit status), and in the game the computer just turns off.",
        ...span(t, tokens[close]!),
        remove: { start: at(tokens[i + 4]!), end: at(tokens[close]!) },
      });
      continue;
    }
    if (lib === "peripheral" && isOp(tokens[i + 3], "(")) {
      let arg: Token | undefined;
      if (field.value === "find") arg = tokens[i + 4];
      else if (field.value === "hasType") {
        const close = closing(tokens, i + 3);
        let depth = 0;
        for (let k = i + 3; k < close; k++) {
          const v = tokens[k]!.kind === "op" ? tokens[k]!.value : "";
          if (v === "(" || v === "{" || v === "[") depth++;
          else if (v === ")" || v === "}" || v === "]") depth--;
          else if (v === "," && depth === 1) {
            arg = tokens[k + 1];
            break;
          }
        }
      }
      if (arg?.kind !== "string") continue;
      const typed = typeOwners(opts.data, arg.value);
      const live = typed.filter(
        (o) => on.has(o.addon.id) && o.addon.versions[opts.mc] !== undefined,
      );
      if (live.length > 0) {
        // the mod is on: is this what it calls the block on this Minecraft version (addons.ts byVersion)?
        const there = live.filter((o) =>
          typeExistsOn(o.addon, o.canonical, opts.mc),
        );
        if (
          there.some(
            (o) => reportedType(o.addon, o.canonical, opts.mc) === arg.value,
          )
        )
          continue;
        if (there.length === 0) {
          const { addon, canonical } = live[0]!;
          const note = Object.values(addon.byVersion ?? {})
            .map((c) => c.note?.[canonical])
            .find((n) => n !== undefined);
          findings.push({
            code: "type-not-on-version",
            message: `"${arg.value}" is a peripheral ${addon.name} ${addon.versions[opts.mc]} does not have on Minecraft ${opts.mc}${note ? ` (${note})` : ""}: peripheral.${field.value} never finds one there.`,
            ...span(arg, arg),
          });
          continue;
        }
        const { addon, canonical } = there[0]!;
        const name = reportedType(addon, canonical, opts.mc);
        // a program that asks for both names runs on every version
        if (strings.has(name)) continue;
        findings.push({
          code: "type-renamed",
          message: `On Minecraft ${opts.mc}, ${addon.name} ${addon.versions[opts.mc]} reports this peripheral as "${name}", not "${arg.value}": peripheral.${field.value}("${arg.value}") never finds one there. Use "${name}", or try both for a program that runs on several versions.`,
          ...span(arg, arg),
        });
        continue;
      }
      const owners = typed.map((o) => o.addon);
      if (owners.length === 0) continue;
      const released = owners.find((a) => a.versions[opts.mc] !== undefined);
      if (released)
        findings.push({
          code: "addon-off",
          message: `"${arg.value}" is a peripheral from ${released.name} (addon "${released.id}"), which is switched off (${opts.addonsFrom}): in the emulator peripheral.${field.value} never finds one.`,
          ...span(arg, arg),
          addon: released.id,
        });
      else {
        const a = owners[0]!;
        findings.push({
          code: "addon-no-release",
          message: `"${arg.value}" is a peripheral from ${a.name}, which has no release for Minecraft ${opts.mc} (it has ${Object.keys(a.versions).join(", ")}): the emulator cannot switch it on there.`,
          ...span(arg, arg),
        });
      }
    }
  }
  return findings;
}

function craftosPc(
  what: string,
  where: { start: Finding["start"]; end: Finding["end"] },
): Finding {
  return {
    code: "craftos-pc-only",
    message: `${what} is CraftOS-PC's, not CC:Tweaked's: a real computer has no such thing, and craftos-mcp hides it too so a program cannot lean on it. (A world with "craftosPcApis": true gives programs periphemu, config and mounter, acting as the game would.)`,
    ...where,
  };
}
