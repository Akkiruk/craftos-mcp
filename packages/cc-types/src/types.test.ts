// The Lua language server types (packages/cc-types). The fast tests read doc comments and types; the slow one runs
// scripts/check.mjs, which needs lua-language-server and is skipped where there is none.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script, no types
import {
  definition,
  docComments,
  parseDoc,
  parseType,
} from "../scripts/lib/ldoc.mjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(PKG, "..", "..");

const type = (text: string): string => parseType(text, 0).type;

describe("illuaminate types as lua-language-server types", () => {
  it("keeps plain types and maps CC:Tweaked's own", () => {
    expect(type("string")).toBe("string");
    expect(type("number|nil")).toBe("number|nil");
    expect(type("Vector")).toBe("cc.Vector");
    expect(type("term.Redirect")).toBe("cc.Redirect");
    expect(type("coroutine")).toBe("thread");
  });

  it("turns list, map and record tables into their own syntax", () => {
    expect(type("{ string... }")).toBe("string[]");
    expect(type("{string...}|number")).toBe("string[]|number");
    expect(type("{ [string] = string }")).toBe("table<string, string>");
    expect(type("{ description? = string, default? = any }")).toBe(
      "{ description?: string, default?: any }",
    );
    expect(type("{ co = coroutine, can_wrap ?= boolean }")).toBe(
      "{ co: thread, can_wrap?: boolean }",
    );
    expect(type("{ (table|nil)... }")).toBe("(table|nil)[]");
  });

  it("reads a type that runs over several lines", () => {
    const text =
      "{\n  url = string, headers? = { [string] = string },\n  binary? = boolean,\n} request Options";
    const parsed = parseType(text, 0);
    expect(parsed.type).toBe(
      "{ url: string, headers?: table<string, string>, binary?: boolean }",
    );
    expect(text.slice(parsed.end).trim()).toBe("request Options");
  });

  it("turns function types around", () => {
    expect(type("function(name:string, wrapped:table):boolean")).toBe(
      "fun(name: string, wrapped: table): boolean",
    );
    expect(type("function():string|nil")).toBe("fun(): string|nil");
    expect(type("function")).toBe("function");
  });

  it("marks a vararg", () => {
    expect(parseType("number... A list", 0)).toMatchObject({
      type: "number",
      vararg: true,
    });
    expect(parseType("(string|nil)... x", 0)).toMatchObject({
      type: "(string|nil)",
      vararg: true,
    });
  });

  it("reports a name it does not know and falls back to any", () => {
    const unknown: string[] = [];
    expect(parseType("Mystery", 0, (n: string) => unknown.push(n)).type).toBe(
      "any",
    );
    expect(unknown).toEqual(["Mystery"]);
  });
});

describe("doc comments", () => {
  it("reads parameters, optional ones, defaults and numbered sets", () => {
    const doc = parseDoc(
      [
        "Open a thing.",
        "",
        "More about it, with a link to [`fs.open`].",
        "",
        "@tparam string path The path",
        "@tparam[opt=false] boolean binary Raw bytes.",
        "@tparam[2] { path = string } options Everything at once.",
        "@treturn[1] Handle The handle.",
        "@treturn[2] nil If it failed.",
        "@treturn string Why.",
        "@since 1.2",
        "@changed 1.109.0 Something new.",
      ].join("\n"),
    );
    expect(doc.summary).toBe("Open a thing.");
    expect(doc.body).toContain("a link to `fs.open`");
    expect(doc.params).toEqual([
      {
        name: "path",
        type: "string",
        vararg: false,
        opt: false,
        default: undefined,
        desc: "The path",
        group: 1,
      },
      {
        name: "binary",
        type: "boolean",
        vararg: false,
        opt: true,
        default: "false",
        desc: "Raw bytes.",
        group: 1,
      },
      {
        name: "options",
        type: "{ path: string }",
        vararg: false,
        opt: false,
        default: undefined,
        desc: "Everything at once.",
        group: 2,
      },
    ]);
    // an untagged return after a numbered one stays in that set
    expect(
      doc.returns.map((r: { type: string; group: number }) => [
        r.type,
        r.group,
      ]),
    ).toEqual([
      ["cc.io.Handle", 1],
      ["nil", 2],
      ["string", 2],
    ]);
    expect(doc.since).toBe("1.2");
    expect(doc.changed).toEqual(["1.109.0 Something new."]);
  });

  it("finds each comment's code and the expect() calls that say what may be nil", () => {
    const source = [
      "--- Serialise it.",
      "-- @param t The value",
      "-- @tparam table opts Options",
      "function serialize(t, opts)",
      '    expect(2, opts, "table", "nil")',
      "end",
      "",
      "--[[- Second.",
      "@treturn number n",
      "]]",
      "local function other() end",
    ].join("\n");
    const found = docComments(source);
    expect(found.map((c: { code: string }) => c.code)).toEqual([
      "function serialize(t, opts)",
      "local function other() end",
    ]);
    expect(found[0].expects).toEqual({ opts: ["table", "nil"] });
    expect(definition(found[0].code)).toMatchObject({
      kind: "function",
      path: ["serialize"],
      local: false,
      args: ["t", "opts"],
    });
    expect(definition("add = function(self, o)")).toMatchObject({
      kind: "function",
      path: ["add"],
      args: ["self", "o"],
    });
    expect(definition("white = 0x1")).toMatchObject({
      kind: "value",
      path: ["white"],
      value: "0x1",
    });
  });
});

const run = (script: string, args: string[] = []) =>
  spawnSync(process.execPath, [join(PKG, "scripts", script), ...args], {
    encoding: "utf8",
    cwd: REPO,
  });

const haveRoms =
  existsSync(join(REPO, "rom", "cc-1.101.3", "rom", "apis")) &&
  existsSync(join(REPO, "rom", "cc-1.121.0", "rom", "apis"));

describe.skipIf(!haveRoms)("the generated files", () => {
  it("are what generate.mjs writes from the ROMs and the emulator's answers", () => {
    const result = run("generate.mjs", ["--check"]);
    expect(result.stderr + result.stdout).toContain(
      "generated files are up to date",
    );
    expect(result.status).toBe(0);
  });
});

function haveLanguageServer(): boolean {
  const exe =
    process.platform === "win32"
      ? "lua-language-server.exe"
      : "lua-language-server";
  if (process.env.LUA_LANGUAGE_SERVER)
    return existsSync(process.env.LUA_LANGUAGE_SERVER);
  const onPath = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .some((d) => d && existsSync(join(d, exe)));
  if (
    onPath ||
    existsSync(join(PKG, ".cache", "lua-language-server", "bin", exe))
  )
    return true;
  return [
    ".vscode",
    ".vscode-server",
    ".vscode-insiders",
    ".cursor",
    ".vscode-oss",
  ].some((root) => {
    const extensions = join(homedir(), root, "extensions");
    return (
      existsSync(extensions) &&
      readdirSync(extensions).some((n) => n.startsWith("sumneko.lua-"))
    );
  });
}

describe.skipIf(!haveLanguageServer())(
  "lua-language-server with the library",
  () => {
    it("knows every CC:Tweaked name and finds no undefined global or wrong arity in the examples", () => {
      const result = run("check.mjs", ["--json"]);
      const out = result.stdout + result.stderr;
      expect(out).not.toContain("are not in the library");
      expect(out).not.toContain("problems in the definitions themselves");
      expect(out).not.toContain("undefined globals or wrong argument counts");
      expect(result.status, out).toBe(0);
    }, 600_000);
  },
);
