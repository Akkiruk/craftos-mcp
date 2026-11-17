// The Lua VM per CC:Tweaked version: 1.101.3 (Cobalt 0.6) for Minecraft 1.18.2, 1.121.0 (Cobalt 0.9.9) for 1.20.1
// and 1.21.1. Every expected value here was read off Cobalt itself: each Cobalt jar run on the same snippets the way
// CC's CobaltLuaMachine sets it up (docs/conformance/emulator-vs-real-deviations.md rows 97, 99, 101, 108).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  resolveVersion,
  romDirFor,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "versions-vm-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
// the 1.121.0 ROM: node scripts/build-rom.mjs --download 1.20.1
const newer = existsSync(
  join(romDirFor(config, resolveVersion("1.20.1", {})), "bios.lua"),
);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runLua(
  lua: string,
  world: WorldConfig | undefined,
  name: string,
): Promise<TestRunResult> {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lua);
  return runTests(config, { paths: [name], world, timeoutMs: 30000 }, 1);
}

function failures(result: TestRunResult): string[] {
  expect(result.files.map((f) => f.status)).toHaveLength(1);
  return result.files.flatMap((f) =>
    f.status === "passed"
      ? []
      : [
          `${f.status}`,
          ...f.tests
            .filter((t) => !t.passed)
            .map((t) => `${t.name}: ${t.error}`),
        ],
  );
}

// compile(code) gives the chunk or nil and the message; err(fn) the error value of a failing call
const helpers = `
local function compile(code) return load(code, "=src") end
local function run(code) local fn, e = load(code, "=src") if not fn then error(e, 0) end return fn() end
local function err(fn, ...) local ok, e = pcall(fn, ...) ccunit.eq(ok, false, "expected an error") return e end
local function named(name) return setmetatable({}, { __name = name }) end
`;

// Both versions copy os.queueEvent arguments through Java (CobaltLuaMachine.toObject/toValue)
const queueEventLua = `
ccunit.test("queueEvent: a new table each argument, shared inside one", function()
  local t = { 1 } local inner = {} local both = { a = inner, b = inner }
  os.queueEvent("q1", t, t, both)
  local _, u, v, w = os.pullEvent("q1")
  ccunit.truthy(u ~= t) ccunit.truthy(u ~= v) ccunit.eq(u, { 1 }) ccunit.truthy(w.a == w.b)
end)
ccunit.test("queueEvent: cycles survive", function()
  local t = {} t.self = t
  os.queueEvent("q2", t)
  local _, u = os.pullEvent("q2")
  ccunit.truthy(u ~= t) ccunit.truthy(u.self == u)
end)
ccunit.test("queueEvent: functions, coroutines and their entries become nil", function()
  os.queueEvent("q3", print, coroutine.create(print), { f = print, [print] = 1, n = 2, 3 }, nil, "x")
  local e = table.pack(os.pullEvent("q3"))
  ccunit.eq(e.n, 6) ccunit.eq(e[2], nil) ccunit.eq(e[3], nil) ccunit.eq(e[4], { n = 2, 3 }) ccunit.eq(e[5], nil)
  ccunit.eq(e[6], "x")
end)
ccunit.test("queueEvent: metatables are not copied", function()
  os.queueEvent("q4", setmetatable({ 1 }, { __index = function() return 9 end }))
  local _, u = os.pullEvent("q4")
  ccunit.eq(getmetatable(u), nil) ccunit.eq(u[2], nil)
end)
`;

describe.skipIf(!ready)("the Lua VM follows the CC:Tweaked version", () => {
  it("1.18.2: CC:Tweaked 1.101.3's Cobalt 0.6", async () => {
    const result = await runLua(
      `${helpers}${queueEventLua}
ccunit.test("no goto or labels", function()
  ccunit.eq(select(2, compile("goto top")), "src:1: '=' expected near 'top'")
  ccunit.eq(select(2, compile("::top::")), "src:1: unexpected symbol near ':'")
  ccunit.eq(run("local goto = 4 return goto"), 4)
end)
ccunit.test("syntax error wording", function() ccunit.eq(select(2, compile("x x")), "src:1: '=' expected near 'x'") end)
ccunit.test("no hex floats", function() ccunit.eq(tonumber("0x1p4"), nil) ccunit.eq(compile("return 0xA.8"), nil) end)
ccunit.test("numbers print with 14 digits", function()
  ccunit.eq(tostring(0.1 + 0.2), "0.3") ccunit.eq(tostring(1 / 3), "0.33333333333333")
  ccunit.eq(tostring(1e15), "1000000000000000") ccunit.eq(tostring(2^63), "9223372036854775807")
  ccunit.eq(tostring(math.pi), "3.1415926535898") ccunit.eq((0.1 + 0.2) .. "", "0.3")
end)
ccunit.test("__name is not read", function()
  ccunit.truthy(tostring(named("Foo")):find("^table: "))
  ccunit.eq(err(function() return named("Foo") + 1 end):match("attempt to.*"), "attempt to perform arithmetic on a table value")
  ccunit.truthy(err(string.rep, named("Foo"), 1):find("got table", 1, true))
end)
ccunit.test("_VERSION", function() ccunit.eq(_VERSION, "Lua 5.1") end)
ccunit.test("xpcall drops extra arguments", function()
  ccunit.eq(select("#", select(2, xpcall(function(...) return ... end, print, 1, 2))), 0)
end)
ccunit.test("error positions", function()
  ccunit.eq(err(error, "s"), "pcall: s")
  ccunit.eq(err(run, "error(42)"), "src:1: 42")
end)
ccunit.test("string.rep has no separator", function() ccunit.eq(string.rep("a", 3, ","), "aaa") end)
ccunit.test("%g is a plain g", function()
  ccunit.eq(("a b g"):gsub("%g", "x"), "a b x")
  ccunit.eq((string.char(192)):find("%a"), 1)
end)
ccunit.test("5.2 library extras are missing", function()
  ccunit.eq(table.create, nil) ccunit.eq(table.move, nil) ccunit.eq(coroutine.isyieldable, nil)
  ccunit.eq(select("#", utf8.offset("abc", 2)), 1)
end)
ccunit.test("bytecode dumps and loads", function()
  local f = load(string.dump(function() return 7 end)) ccunit.eq(f(), 7)
end)
ccunit.test("math.random ignores a third argument", function() ccunit.eq(math.random(1, 1, 5), 1) end)
ccunit.test("table.insert ignores a fourth argument", function() local t = {} table.insert(t, 1, 2, 3) ccunit.eq(t, {}) end)
ccunit.test("os.time: a missing min and sec are 12", function()
  ccunit.eq(os.time({ year = 2020, month = 1, day = 1 }), os.time({ year = 2020, month = 1, day = 1, min = 12, sec = 12 }))
end)
ccunit.test("a function expression makes a new function each time", function()
  local fs = {} for i = 1, 2 do fs[i] = function() return i end end ccunit.truthy(fs[1] ~= fs[2])
end)
ccunit.finish()
`,
      { version: "1.18.2" },
      "vm101.test.lua",
    );
    expect(failures(result)).toEqual([]);
  });

  it.skipIf(!newer)("1.20.1: CC:Tweaked 1.121.0's Cobalt 0.9.9", async () => {
    const result = await runLua(
      `${helpers}${queueEventLua}
ccunit.test("goto and labels", function()
  ccunit.eq(run("local n = 0 ::top:: n = n + 1 if n < 3 then goto top end return n"), 3)
  ccunit.eq(run("local s = 0 for i = 1, 5 do if i % 2 == 0 then goto continue end s = s + i ::continue:: end return s"), 9)
  ccunit.eq(run("local goto = 4 return goto"), 4)
  ccunit.eq(run("local t = {goto = 1} return t.goto"), 1)
  ccunit.eq(select(2, compile("goto nowhere")), "src:1: no visible label 'nowhere' for <goto> at line 1")
  ccunit.eq(select(2, compile("::a:: ::a::")), "src:1: label 'a' already defined on line 1")
  ccunit.eq(select(2, compile("::a:: do ::a:: end")), "src:1: label 'a' already defined on line 1")
  ccunit.eq(select(2, compile("do goto l local x = 1 ::l:: print(x) end")),
    "src:1: <goto l> at line 1 jumps into the scope of local 'x'")
  ccunit.eq(select(2, compile("break")), "src:1: break outside loop at line 1")
end)
ccunit.test("syntax error wording", function() ccunit.eq(select(2, compile("x x")), "src:1: syntax error near 'x'") end)
ccunit.test("hex floats", function()
  ccunit.eq(run("return 0x1p4"), 16) ccunit.eq(run("return 0xA.8"), 10.5) ccunit.eq(tonumber("0x.1"), 0.0625)
  ccunit.eq(tonumber("0x1p4"), 16) ccunit.eq("0x1p1" + 0, 2)
end)
ccunit.test("numbers print as %.15g, else %.17g", function()
  ccunit.eq(tostring(0.1 + 0.2), "0.30000000000000004") ccunit.eq(tostring(1 / 3), "0.33333333333333331")
  ccunit.eq(tostring(0.1), "0.1") ccunit.eq(tostring(100), "100") ccunit.eq(tostring(-0.0), "0")
  ccunit.eq(tostring(1e15), "1e+15") ccunit.eq(tostring(2^31), "2147483648") ccunit.eq(tostring(2^53), "9007199254740992")
  ccunit.eq(tostring(2^63), "9.2233720368547758e+18") ccunit.eq(tostring(math.pi), "3.1415926535897931")
  ccunit.eq(tostring(5e-324), "4.94065645841247e-324") ccunit.eq(tostring(1e14 + 0.5), "100000000000000.5")
  ccunit.eq(tostring(1 / 0), "inf") ccunit.eq(tostring(-1 / 0), "-inf") ccunit.eq(tostring(0 / 0), "nan")
  ccunit.eq((0.1 + 0.2) .. "", "0.30000000000000004") ccunit.eq(table.concat({ 1.5, 0.1 + 0.2 }, " "), "1.5 0.30000000000000004")
  ccunit.eq(string.format("%s %g", 1 / 3, 0.1), "0.33333333333333331 0.1")
end)
ccunit.test("__name on tables and userdata", function()
  ccunit.truthy(tostring(named("Foo")):find("^Foo: "))
  ccunit.truthy(tostring(setmetatable({}, { __name = 5 })):find("^table: "))
  ccunit.eq(err(function() return named("Foo") + 1 end):match("attempt to.*"), "attempt to perform arithmetic on a Foo value")
  ccunit.eq(err(run, "local t = setmetatable({}, {__name = 'Foo'}) return t < 1"), "src:1: attempt to compare Foo with number")
  ccunit.truthy(err(string.rep, named("Foo"), 1):find("got Foo", 1, true))
end)
ccunit.test("_VERSION", function() ccunit.eq(_VERSION, "Lua 5.2") end)
ccunit.test("xpcall passes extra arguments", function()
  ccunit.eq({ xpcall(function(...) return select("#", ...), ... end, print, 1, 2) }, { true, 2, 1, 2 })
end)
ccunit.test("error: only strings get a position, only from Lua", function()
  ccunit.eq(err(error, "s"), "s") ccunit.eq(err(function() error(42) end), 42)
  ccunit.eq(err(run, "error('s')"), "src:1: s") ccunit.eq(err(run, "pcall(error, 's', 2) error(select(2, pcall(error, 's', 2)), 0)"), "src:1: s")
end)
ccunit.test("library errors take the nearest Lua caller's position", function()
  ccunit.eq(select(2, run("return pcall(string.rep)")):sub(1, 7), "src:1: ")
  ccunit.eq(select(2, run("return pcall(setfenv, string.len, {})")), "src:1: 'setfenv' cannot change environment of given object")
end)
ccunit.test("assert throws its message as it is", function()
  ccunit.eq(type(err(assert, false, {})), "table") ccunit.eq(err(assert, false, 5), 5)
  ccunit.eq(err(assert, false, nil), nil) ccunit.truthy(err(assert):find("bad argument #1 (value expected)", 1, true))
  ccunit.eq(err(run, "assert(false)"), "src:1: assertion failed!")
end)
ccunit.test("getfenv and setfenv on Lua functions only", function()
  ccunit.truthy(getfenv() == _ENV) ccunit.truthy(getfenv(0) == _G) ccunit.truthy(getfenv(string.len) == _G)
  ccunit.truthy(err(setfenv, string.len, {}):find("'setfenv' cannot change environment of given object", 1, true))
  ccunit.truthy(err(setfenv, 0, _G):find("'setfenv' cannot change environment of given object", 1, true))
  ccunit.truthy(err(getfenv, -1):find("level must be non-negative", 1, true))
  local fs = {} for i = 1, 3 do fs[i] = function() return A end end
  for i = 1, 3 do ccunit.truthy(setfenv(fs[i], { A = i }) == fs[i]) end
  ccunit.eq({ fs[1](), fs[2](), fs[3]() }, { 1, 2, 3 })
end)
ccunit.test("no bytecode", function()
  ccunit.truthy(err(string.dump, function() end):find("unable to dump given function", 1, true))
  ccunit.eq({ load(string.char(27) .. "Lua") }, { nil, "attempt to load a binary chunk" })
  ccunit.eq({ load("return 1", "x", "b") }, { nil, "attempt to load a text chunk (mode is b)" })
end)
ccunit.test("string.rep with a separator", function() ccunit.eq(string.rep("a", 3, ","), "a,a,a") end)
ccunit.test("ASCII character classes", function()
  ccunit.eq(select(2, ("a_b.c!"):gsub("%p", "x")), 3) ccunit.eq((string.char(192)):find("%a"), nil)
  ccunit.eq(select(2, ("a b g"):gsub("%g", "x")), 3)
end)
ccunit.test("string.format", function()
  ccunit.eq(string.format("%a %a %A", 1, 3.75, 0.5), "0x1p+0 0x1.ep+1 0X1P-1")
  ccunit.eq(string.format("%8a|%-8a|", 1, 1), "  0x1p+0|0x1p+0  |")
  ccunit.truthy(err(string.format, "%5%"):find("invalid conversion '%5%' to 'format'", 1, true))
  ccunit.truthy(err(string.format, "%y", 1):find("invalid conversion '%y' to 'format'", 1, true))
  ccunit.truthy(err(string.format, "abc%"):find("invalid conversion '%' to 'format'", 1, true))
  ccunit.truthy(err(string.format, "%10q", "x"):find("specifier '%q' cannot have modifiers", 1, true))
end)
ccunit.test("table.create, table.move, coroutine.isyieldable", function()
  ccunit.eq(type(table.create(5)), "table") ccunit.eq(next(table.create(2, 3)), nil)
  ccunit.truthy(err(table.create, -1):find("bad argument #1 (out of range)", 1, true))
  ccunit.eq(table.move({ 1, 2, 3 }, 1, 3, 2), { 1, 1, 2, 3 })
  ccunit.eq(type(coroutine.isyieldable), "function")
end)
ccunit.test("table.insert wants 2 or 3 arguments", function()
  ccunit.truthy(err(table.insert, {}, 1, 2, 3):find('wrong number of arguments to "insert"', 1, true))
  ccunit.truthy(err(table.insert, {}):find('wrong number of arguments to "insert"', 1, true))
end)
ccunit.test("utf8.offset gives both ends", function()
  ccunit.eq({ utf8.offset("h" .. string.char(0xC3, 0xA4) .. "x", 2) }, { 2, 3 })
  ccunit.eq({ utf8.offset("abc", 4) }, { 4, 4 })
end)
ccunit.test("math.random", function()
  ccunit.truthy(err(math.random, 0):find("interval is empty", 1, true))
  ccunit.truthy(err(math.random, 1, 2, 3):find("wrong number of arguments", 1, true))
end)
ccunit.test("an upvalue indexed in place is not named", function()
  ccunit.eq(err(run, "local u local function f() return u.x end return f()"), "src:1: attempt to index a nil value")
  ccunit.eq(err(run, "local u local function f() return u + 1 end return f()"),
    "src:1: attempt to perform arithmetic on upvalue 'u' (a nil value)")
end)
ccunit.test("os.time: a missing min and sec are 0", function()
  ccunit.eq(os.time({ year = 2020, month = 1, day = 1 }), os.time({ year = 2020, month = 1, day = 1, min = 0, sec = 0 }))
end)
ccunit.finish()
`,
      { version: "1.20.1" },
      "vm121.test.lua",
    );
    expect(failures(result)).toEqual([]);
  });
});
