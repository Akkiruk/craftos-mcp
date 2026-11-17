// The debugger's conversions (src/debug/paths.ts): editor file <-> computer path, hit counts, log messages, names.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  childExpression,
  frameName,
  hoverExpression,
  logExpression,
  luaQuote,
  parseHitCondition,
  sortEntries,
  toComputerPath,
  toHostPath,
} from "../../src/debug/paths.ts";

const root = join(process.cwd(), "proj");

test("a project file maps to its path on the computer and back", () => {
  assert.equal(toComputerPath(join(root, "prog.lua"), root), "/prog.lua");
  assert.equal(
    toComputerPath(join(root, "lib", "util.lua"), root),
    "/lib/util.lua",
  );
  assert.equal(
    toHostPath("/lib/util.lua", root),
    join(root, "lib", "util.lua"),
  );
});

test("a file outside the project folder is not on the computer", () => {
  assert.equal(toComputerPath(join(root, "..", "other.lua"), root), undefined);
  assert.equal(toComputerPath(root, root), undefined);
});

test("the BIOS and paths that climb out have no project file", () => {
  assert.equal(toHostPath("bios.lua", root), undefined);
  assert.equal(toHostPath("/../secret.lua", root), undefined);
  assert.equal(toHostPath("/", root), undefined);
});

test("hit counts: a bare number means from that hit on", () => {
  assert.deepEqual(parseHitCondition("5"), { hitOp: ">=", hitN: 5 });
  assert.deepEqual(parseHitCondition(" > 5 "), { hitOp: ">", hitN: 5 });
  assert.deepEqual(parseHitCondition(">=2"), { hitOp: ">=", hitN: 2 });
  assert.deepEqual(parseHitCondition("== 3"), { hitOp: "==", hitN: 3 });
  assert.deepEqual(parseHitCondition("= 3"), { hitOp: "==", hitN: 3 });
  assert.deepEqual(parseHitCondition("% 2"), { hitOp: "%", hitN: 2 });
});

test("hit counts that mean nothing are refused", () => {
  assert.equal(parseHitCondition("often"), undefined);
  assert.equal(parseHitCondition("% 0"), undefined);
  assert.equal(parseHitCondition("< 3"), undefined);
  assert.equal(parseHitCondition(""), undefined);
});

test("a Lua string literal survives quotes, backslashes and newlines", () => {
  assert.equal(luaQuote('say "hi"\\\n'), '"say \\"hi\\"\\\\\\n"');
  assert.equal(luaQuote("tab\there"), '"tab\\9here"');
});

test("a log message becomes one Lua expression", () => {
  assert.equal(logExpression("plain"), '"plain"');
  assert.equal(logExpression("x is {x}"), '"x is " .. tostring((x))');
  assert.equal(
    logExpression("{a} and {#list} done"),
    'tostring((a)) .. " and " .. tostring((#list)) .. " done"',
  );
  assert.equal(logExpression("open { only"), '"open { only"');
  assert.equal(logExpression(""), '""');
});

test("an entry's expression follows its table's", () => {
  assert.equal(childExpression("t", "x"), "t.x");
  assert.equal(childExpression("t", "[1]"), "t[1]");
  assert.equal(childExpression("t.list", '["a b"]'), 't.list["a b"]');
});

test("table entries: the list part in order, then names, then other keys, the metatable last", () => {
  const names = sortEntries(
    ["zeta", "[10]", "(metatable)", "[2]", "alpha", '["a b"]', "[1]"].map(
      (name) => ({
        name,
        value: "",
        type: "",
      }),
    ),
  ).map((v) => v.name);
  assert.deepEqual(names, [
    "[1]",
    "[2]",
    "[10]",
    "alpha",
    "zeta",
    '["a b"]',
    "(metatable)",
  ]);
});

test("hovering a name evaluates it with the names it hangs off, and nothing that calls", () => {
  const line = "  local w = config.screen.width + pad(x) -- wide";
  const at = (text) =>
    hoverExpression(line, line.indexOf(text) + 1)?.expression;
  assert.equal(at("config"), "config");
  assert.equal(at("screen"), "config.screen");
  assert.equal(at("width"), "config.screen.width");
  assert.equal(at("pad"), "pad");
  assert.equal(at("x)"), "x");
  assert.equal(at("wide"), undefined, "a word in a comment");
  assert.equal(at("+"), undefined);
  const range = hoverExpression(line, line.indexOf("screen") + 2);
  assert.equal(line.slice(range.start, range.end), "config.screen");
});

test("hovering words in strings and numbers evaluates nothing", () => {
  assert.equal(hoverExpression('print("hello world", name)', 9), undefined);
  assert.equal(
    hoverExpression('print("hello world", name)', 22)?.expression,
    "name",
  );
  assert.equal(hoverExpression("x = 0xff + 1e5", 6), undefined);
  assert.equal(hoverExpression("obj:method(a.b)", 5)?.expression, "method");
  assert.equal(hoverExpression("obj:method(a.b)", 13)?.expression, "a.b");
});

test("frame names", () => {
  const frame = {
    i: 0,
    thread: 0,
    line: 3,
    path: "/prog.lua",
    user: true,
    defined: 2,
  };
  assert.equal(frameName({ ...frame, what: "Lua", name: "add" }), "add");
  assert.equal(frameName({ ...frame, what: "main", name: "f" }), "main chunk");
  assert.equal(
    frameName({ ...frame, what: "C", name: "error", path: "" }),
    "[C] error",
  );
  assert.equal(frameName({ ...frame, what: "Lua" }), "function <prog.lua:2>");
});
