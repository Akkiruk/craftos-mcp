// The Lua tokenizer, the test finder (CodeLens, Testing view) and the version-aware diagnostics scanner, against the
// real version and addon list from packages/runner (pack-data.mjs, as the build reads it).
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTests, scanLua, tokenize } from "../../src/luaScan.ts";
import { loadPackData } from "../../pack-data.mjs";

const data = await loadPackData();
const scan = (
  source,
  mc = "1.18.2",
  addons = "",
  addonsFrom = "craftos-mcp.addons",
) => scanLua(source, { data, mc, addons, addonsFrom });
const codes = (findings) => findings.map((f) => f.code);

test("the tokenizer skips comments and reads every kind of string", () => {
  const src = [
    "-- goto nowhere",
    "--[==[ a long",
    "comment ]] still ]==] local a = 'it''s'",
    'local b = "say \\"hi\\"\\n"',
    "local c = [[",
    "goto x ]]",
    "x = 0x1F + 1e3 .. ...",
  ].join("\n");
  const t = tokenize(src);
  assert.deepEqual(
    t.map((k) => k.value),
    [
      "local",
      "a",
      "=",
      "it",
      "s",
      "local",
      "b",
      "=",
      'say "hi"\n',
      "local",
      "c",
      "=",
      "goto x ",
      "x",
      "=",
      "0x1F",
      "+",
      "1e3",
      "..",
      "...",
    ],
  );
  assert.deepEqual([t[0].line, t[0].col], [2, 22]);
  const long = t.find((k) => k.value === "goto x ");
  assert.equal(long.kind, "string");
  assert.equal(long.line, 4);
});

test("an unfinished string ends at its line, and the tokenizer never throws", () => {
  const t = tokenize('print("oops\nprint("fine")');
  assert.deepEqual(
    t.map((k) => k.value),
    ["print", "(", "oops", "print", "(", "fine", ")"],
  );
  assert.doesNotThrow(() => tokenize("--[[ never closed"));
  assert.doesNotThrow(() => tokenize("[==[ never closed"));
});

test("finds tests: ccunit.test, local aliases, multi-line calls, not comments or strings", () => {
  const source = [
    "local t, eq = ccunit.test, ccunit.eq", // 0
    'ccunit.test("plain", function() end)', // 1
    't("alias", function() eq(1, 1) end)', // 2
    "-- ccunit.test('commented', function() end)", // 3
    "print(\"ccunit.test('in a string')\")", // 4
    "ccunit.test(", // 5
    '  "split over lines",', // 6
    "  function() end)", // 7
    "--[[ t('in a long comment', f) ]]", // 8
    "local other = foo.test", // 9
    'other("not a test", f)', // 10
    "t(name, f)", // 11
    '  t "no parens", f', // 12
    'obj.t("a field", f)', // 13
  ].join("\n");
  assert.deepEqual(findTests(source), [
    { name: "plain", line: 1, col: 0 },
    { name: "alias", line: 2, col: 0 },
    { name: "split over lines", line: 5, col: 0 },
  ]);
});

test("goto and labels are flagged only on 1.18.2 (Lua 5.1)", () => {
  const src = [
    "for i = 1, 3 do",
    "  if i == 2 then goto continue end",
    "  print(i)",
    "  ::continue::",
    "end",
    "-- goto in a comment",
    'print("goto label")',
    "local t = { goto = 1 }",
    "t.goto = 2",
  ].join("\n");
  const old = scan(src, "1.18.2");
  assert.deepEqual(codes(old), ["goto-lua51", "label-lua51"]);
  assert.deepEqual(old[0].start, { line: 1, col: 17 });
  assert.deepEqual(old[0].end, { line: 1, col: 30 });
  assert.match(old[0].message, /Lua 5\.1/);
  assert.deepEqual(old[1].start, { line: 3, col: 2 });
  assert.deepEqual(old[1].end, { line: 3, col: 14 });
  assert.deepEqual(scan(src, "1.20.1"), []);
  assert.deepEqual(scan(src, "1.21.1"), []);
});

test("table.move and coroutine.isyieldable are missing on 1.18.2 only", () => {
  const src =
    "table.move(a, 1, 2, 1, b)\nprint(coroutine.isyieldable())\nlocal table, coroutine = {}, {}\n";
  // a file that has its own `table` is left alone
  assert.deepEqual(scan(src, "1.18.2"), []);
  const plain = "table.move(a, 1, 2, 1, b)\nprint(coroutine.isyieldable())\n";
  assert.deepEqual(codes(scan(plain, "1.18.2")), [
    "missing-on-lua51",
    "missing-on-lua51",
  ]);
  assert.deepEqual(scan(plain, "1.21.1"), []);
});

test("os.shutdown with an exit code is emulator-only, with a fix that removes the argument", () => {
  const src =
    "os.shutdown(failed > 0 and 1 or 0)\nos.shutdown()\nos.shutdown( )\nx.os.shutdown(1)\n";
  const found = scan(src, "1.21.1");
  assert.deepEqual(codes(found), ["shutdown-exit-code"]);
  assert.deepEqual(found[0].remove, {
    start: { line: 0, col: 12 },
    end: { line: 0, col: 33 },
  });
  assert.deepEqual(found[0].end, { line: 0, col: 34 });
});

test("CraftOS-PC's own APIs are flagged, a program's own tables of the same name are not", () => {
  const src = [
    'periphemu.create("left", "monitor")',
    'config.set("abortTimeout", 1000)',
    "term.setGraphicsMode(1)",
    "collectgarbage()",
    "print(os.about())",
  ].join("\n");
  assert.deepEqual(
    codes(scan(src, "1.21.1")),
    Array(5).fill("craftos-pc-only"),
  );
  const mine = [
    "local config = { speed = 1 }",
    "config.speed = config.get and 2 or 1",
    "config.set = nil",
    "mounter = {}",
    "mounter.mount()",
    "local mon = peripheral.wrap('top')",
    "mon.setGraphicsMode(1)",
    "local function collectgarbage() end",
    "collectgarbage()",
    "print(t.config.get())",
  ].join("\n");
  assert.deepEqual(scan(mine, "1.21.1"), []);
  // a config table of the program's that is set somewhere else
  assert.deepEqual(scan("print(config.speed)", "1.21.1"), []);
});

test("peripherals of an addon that is off", () => {
  const src = [
    'local chat = peripheral.find("chatBox")', // advanced-peripherals
    'local me = peripheral.find("meBridge", function(n, p) return true end)',
    'if peripheral.hasType(name, "playerDetector") then end',
    'local m = peripheral.find("monitor")', // CC:Tweaked's own
    'local r = peripheral.find("BiggerReactors_Reactor")',
  ].join("\n");
  assert.deepEqual(scan(src, "1.18.2", ""), [], "every addon is on by default");
  assert.deepEqual(scan(src, "1.18.2", "all"), []);
  const off = scan(src, "1.18.2", "mekanism");
  assert.deepEqual(codes(off), [
    "addon-off",
    "addon-off",
    "addon-off",
    "addon-off",
  ]);
  assert.equal(off[0].addon, "advanced-peripherals");
  assert.match(
    off[0].message,
    /Advanced Peripherals \(addon "advanced-peripherals"\), which is switched off \(craftos-mcp\.addons\)/,
  );
  assert.deepEqual(off[0].start, { line: 0, col: 29 });
  assert.equal(off[3].addon, "bigger-reactors");
  // on 1.21.1 Bigger Reactors has no release at all
  const newer = scan(
    src,
    "1.21.1",
    ["advanced-peripherals"],
    "the world file's addons",
  );
  // and Advanced Peripherals 0.7.62b names its blocks chat_box, me_bridge, player_detector there
  assert.deepEqual(codes(newer), [
    "type-renamed",
    "type-renamed",
    "type-renamed",
    "addon-no-release",
  ]);
  assert.match(
    newer[0].message,
    /reports this peripheral as "chat_box", not "chatBox"/,
  );
  assert.match(newer[1].message, /"me_bridge"/);
  assert.match(newer[2].message, /"player_detector"/);
  assert.match(newer[3].message, /no release for Minecraft 1\.21\.1/);
  // a world's empty list switches everything off
  assert.equal(scan(src, "1.18.2", [], "the world file's addons").length, 4);
});

test("a type a mod renames or drops on the file's Minecraft version (addons.ts byVersion), on a made-up mod", () => {
  const fake = {
    newest: "1.21.1",
    versions: [
      { mc: "1.18.2", cc: "1.101.3" },
      { mc: "1.21.1", cc: "1.121.0" },
    ],
    addons: [
      {
        id: "fake-mod",
        name: "Fake Mod",
        versions: { "1.18.2": "1.0", "1.21.1": "3.0" },
        requires: [],
        types: ["oldName", "gone", "fresh"],
        byVersion: {
          "1.21.1": {
            rename: { oldName: "old_name" },
            removed: ["gone"],
            added: ["fresh"],
            note: { gone: "replaced by redstone_relay" },
          },
        },
      },
    ],
  };
  const scanFake = (source, mc) =>
    scanLua(source, {
      data: fake,
      mc,
      addons: "",
      addonsFrom: "craftos-mcp.addons",
    });
  // the old name on the version that renamed it, and the new name on the version before
  const old = scanFake('local d = peripheral.find("oldName")', "1.21.1");
  assert.deepEqual(codes(old), ["type-renamed"]);
  assert.match(
    old[0].message,
    /On Minecraft 1\.21\.1, Fake Mod 3\.0 reports this peripheral as "old_name", not "oldName"/,
  );
  assert.deepEqual(
    codes(scanFake('local d = peripheral.find("old_name")', "1.18.2")),
    ["type-renamed"],
  );
  // the version's own name, or both names for a program that runs on several versions
  assert.deepEqual(
    scanFake('local d = peripheral.find("old_name")', "1.21.1"),
    [],
  );
  assert.deepEqual(
    scanFake('local d = peripheral.find("oldName")', "1.18.2"),
    [],
  );
  assert.deepEqual(
    scanFake(
      'local d = peripheral.find("oldName") or peripheral.find("old_name")',
      "1.21.1",
    ),
    [],
  );
  // gone there, or only on another version
  const gone = scanFake('if peripheral.hasType(n, "gone") then end', "1.21.1");
  assert.deepEqual(codes(gone), ["type-not-on-version"]);
  assert.match(
    gone[0].message,
    /Fake Mod 3\.0 does not have on Minecraft 1\.21\.1 \(replaced by redstone_relay\)/,
  );
  assert.deepEqual(scanFake('peripheral.find("gone")', "1.18.2"), []);
  assert.deepEqual(codes(scanFake('peripheral.find("fresh")', "1.18.2")), [
    "type-not-on-version",
  ]);
  // the mod off: either name says so as before
  const off = scanLua('peripheral.find("old_name")', {
    data: fake,
    mc: "1.21.1",
    addons: "none",
    addonsFrom: "craftos-mcp.addons",
  });
  assert.deepEqual(codes(off), ["addon-off"]);
});
