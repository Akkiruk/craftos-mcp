// What a run or a test file tells the person (or agent) about it: the error with its file and line, a terminal free of
// the random motd, results that survive a hanging test, ccunit's helpers, and the sim state without bookkeeping.
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
  checkConfig,
  loadConfig,
  resolveVersion,
  romDirFor,
  runProgram,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "dx-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
/** Both CC:Tweaked versions, where their ROMs are built. */
const versions = ["1.18.2", "1.21.1"].filter((mc) =>
  existsSync(join(romDirFor(config, resolveVersion(mc)), "bios.lua")),
);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

describe.skipIf(!ready)("run results", () => {
  it("pulls the runtime error's file and line out of the screen", async () => {
    put("lib/boom.lua", 'local function f() error("boom") end\nf()\n');
    const r = await runProgram(config, { program: "lib/boom.lua" });
    expect(r.status).toBe("program_failed");
    expect(r.error).toEqual({
      kind: "runtime",
      message: "boom",
      file: "lib/boom.lua",
      line: 1,
    });
  }, 40000);

  it.each(versions)(
    "says a syntax error is one, with its line (%s)",
    async (version) => {
      put("syntax.lua", "local x = 1\nlocal y = = 2\n");
      const r = await runProgram(config, {
        program: "syntax.lua",
        world: { version },
      });
      expect(r.error?.kind).toBe("syntax");
      expect(r.error?.file).toBe("syntax.lua");
      expect(r.error?.line).toBe(2);
    },
    40000,
  );

  it.each(versions)(
    "the motd setting leaves no event behind for the program (%s)",
    async (version) => {
      // the bios queues setting_changed when it applies default_computer_settings; a default server has none
      put(
        "first.lua",
        'os.queueEvent("mine") print(os.pullEventRaw()) print(settings.get("motd.enable"))',
      );
      const r = await runProgram(config, {
        program: "first.lua",
        world: { version },
      });
      expect(r.screens[0]!.lines.slice(1, 3)).toEqual(["mine", "false"]);
    },
    40000,
  );

  it("says when there is no such program", async () => {
    const r = await runProgram(config, { program: "nothere.lua" });
    expect(r.error).toEqual({
      kind: "not_found",
      message: "No such program: nothere.lua",
    });
  }, 40000);

  it("has no error on success, nor a motd under the banner; world.motd brings it back", async () => {
    put("hi.lua", 'print("hi")');
    const r = await runProgram(config, { program: "hi.lua" });
    expect(r.error).toBeUndefined();
    expect(r.screens[0]!.lines[0]).toMatch(/^CraftOS 1\.\d+$/);
    expect(r.screens[0]!.lines[1]).toBe("hi");
    put("motd.lua", 'print(tostring(settings.get("motd.enable")))');
    const on = await runProgram(config, {
      program: "motd.lua",
      world: { motd: true },
    });
    expect(on.screens[0]!.lines.join("\n")).toContain("true");
    const off = await runProgram(config, { program: "motd.lua" });
    expect(off.screens[0]!.lines[1]).toBe("false");
  }, 60000);

  it("keeps the sim's own bookkeeping out of the result", async () => {
    put("noop.lua", "");
    const r = await runProgram(config, {
      program: "noop.lua",
      world: { peripherals: [{ name: "chest_0", type: "minecraft:chest" }] },
    });
    expect(r.sim).toBeDefined();
    expect(r.sim).not.toHaveProperty("survives");
  }, 40000);
});

describe.skipIf(!ready)("ccunit", () => {
  it("keeps finished tests and names the one that hung", async () => {
    put(
      "hang.test.lua",
      [
        'ccunit.test("first", function() ccunit.eq(1, 1) end)',
        'ccunit.test("second", function() ccunit.eq(1, 2) end)',
        'ccunit.test("stuck", function() while true do sleep(1) end end)',
        'ccunit.test("never", function() end)',
      ].join("\n"),
    );
    const r = await runTests(config, {
      paths: ["hang.test.lua"],
      timeoutMs: 4000,
    });
    const file = r.files[0]!;
    expect(file.status).toBe("timed_out");
    expect(file.tests.map((t) => [t.name, t.passed])).toEqual([
      ["first", true],
      ["second", false],
      ["stuck", false],
    ]);
    expect(file.tests[1]).toMatchObject({ file: "hang.test.lua", line: 2 });
    expect(file.tests[2]!.error).toMatch(/timed out in this test/);
    // the hang is one failing test, not a second count for the file
    expect([r.passed, r.failed]).toEqual([1, 2]);
  }, 40000);

  it("gives a test its own timeout, skips, and has the new checks", async () => {
    put(
      "helpers.test.lua",
      [
        'ccunit.test("slow", function() sleep(30) end, { timeout = 0.5 })',
        'ccunit.skip("later")',
        'ccunit.test("checks", function()',
        "  ccunit.near(0.1 + 0.2, 0.3)",
        "  ccunit.neq({ 1 }, { 2 })",
        '  ccunit.contains("hello world", "o w")',
        "  ccunit.contains({ 1, 2, 3 }, 2)",
        '  ccunit.raises(function() ccunit.contains("abc", "z") end, "does not contain")',
        '  ccunit.raises(function() ccunit.near(1, 2) end, "%+/%-")',
        "end)",
      ].join("\n"),
    );
    const r = await runTests(config, { paths: ["helpers.test.lua"] });
    const tests = r.files[0]!.tests;
    expect(tests[0]).toMatchObject({ name: "slow", passed: false });
    expect(tests[0]!.error).toMatch(/timed out after 0.5 s/);
    expect(tests[1]).toMatchObject({ name: "later", skipped: true });
    expect(tests[2]).toMatchObject({ name: "checks", passed: true });
    expect(r.skipped).toBe(1);
    expect([r.passed, r.failed]).toEqual([1, 1]);
  }, 40000);

  it("runs a program and reads the terminal and a monitor it drew on", async () => {
    put(
      "door.lua",
      [
        'local m = peripheral.find("monitor")',
        'm.clear() m.setCursorPos(1, 1) m.write("OPEN")',
        'print("door ready", ...)',
        "while true do",
        '  local _, _, x, y = os.pullEvent("monitor_touch")',
        '  m.setCursorPos(1, 2) m.write("hit " .. x .. "," .. y)',
        "end",
      ].join("\n"),
    );
    put(
      "door.test.lua",
      [
        'ccunit.test("draws", function()',
        '  local r = ccunit.run("door.lua", { args = { "now" }, seconds = 0.5 })',
        "  ccunit.eq(r.done, false)",
        '  ccunit.contains(r.screen, "door ready\\tnow")',
        '  ccunit.eq(ccunit.screen("top")[1], "OPEN")',
        '  ccunit.eq(peripheral.getType(peripheral.find("monitor")), "monitor")',
        "end)",
        'ccunit.test("touch", function()',
        '  ccunit.run("door.lua", { script = function()',
        '    sleep(0.2) ccunit.touch("top", 2, 3) sleep(0.2)',
        "  end })",
        '  ccunit.contains(ccunit.screen("top"), "hit 2,3")',
        "end)",
      ].join("\n"),
    );
    const r = await runTests(config, {
      paths: ["door.test.lua"],
      monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
    });
    expect(r.files[0]!.tests).toEqual([
      { name: "draws", passed: true },
      { name: "touch", passed: true },
    ]);
  }, 40000);
});
