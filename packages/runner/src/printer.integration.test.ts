// CC:Tweaked's printer (rom/ccsim/printer.lua), against PrinterPeripheral and TilePrinter (1.101.3) /
// PrinterBlockEntity (1.121.0): ink and paper, pages of 25x21, the printed pages in the output slots, chests reaching
// the slots, and what the two versions write for a value that is not a string.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runProgram,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "printer-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

async function lua(source: string, world: WorldConfig): Promise<TestRunResult> {
  counter += 1;
  const name = `printer_${counter}.test.lua`;
  put(name, source);
  return runTests(config, { paths: [name], world, timeoutMs: 30000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const world = (version: string, extra: object = {}): WorldConfig => ({
  version,
  addons: "none",
  peripherals: [
    { name: "left", type: "printer", ink: 2, paper: 3, ...extra },
    { name: "chest_0", type: "minecraft:chest", size: 27 },
  ] as never,
});

const SAME = `
ccunit.test("a page from start to end", function()
  local p = peripheral.wrap("left")
  ccunit.eq(peripheral.getType("left"), "printer")
  ccunit.eq(peripheral.hasType("left", "inventory"), false)
  ccunit.eq(p.list, nil)
  ccunit.eq(p.getInkLevel(), 2)
  ccunit.eq(p.getPaperLevel(), 3)
  ccunit.raises(function() p.write("x") end, "Page not started")
  ccunit.raises(function() p.getCursorPos() end, "Page not started")
  ccunit.raises(function() p.getPageSize() end, "Page not started")
  ccunit.raises(function() p.setPageTitle("t") end, "Page not started")
  ccunit.raises(function() p.endPage() end, "Page not started")
  ccunit.raises(function() p.setPageTitle(5) end, "bad argument #1 %(string expected, got number%)")
  ccunit.raises(function() p.setCursorPos("a", 1) end, "bad argument #1 %(number expected, got string%)")

  ccunit.eq(p.newPage(), true)
  ccunit.eq(p.getInkLevel(), 1)
  ccunit.eq(p.getPaperLevel(), 2)
  ccunit.eq({ p.getPageSize() }, { 25, 21 })
  ccunit.eq({ p.getCursorPos() }, { 1, 1 })
  p.write("Hello")
  ccunit.eq({ p.getCursorPos() }, { 6, 1 })
  p.setCursorPos(23, 2)
  p.write("cut off here")
  ccunit.eq({ p.getCursorPos() }, { 35, 2 })
  p.setCursorPos(1, 30) -- below the page: nothing written, the cursor still moves
  p.write("lost")
  ccunit.eq({ p.getCursorPos() }, { 5, 30 })
  p.setPageTitle("Report \\1 of a very long title that goes on")
  ccunit.eq(p.endPage(), true)
  ccunit.raises(function() p.write("x") end, "Page not started")

  -- the page came out in the first output slot, a stack of one; a chest takes it by the printer's name
  local chest = peripheral.wrap("chest_0")
  ccunit.eq(chest.pullItems("left", 8), 1)
  local page = chest.getItemDetail(1)
  ccunit.eq(page.name, "computercraft:printed_page")
  ccunit.eq(page.displayName, "Printed Page")
  ccunit.eq(page.maxCount, 1)
  ccunit.eq(page.__page, nil)
  ccunit.truthy(chest.list()[1].nbt)

  -- newPage while printing ends that page first; with no ink it says false and nothing changes
  ccunit.eq(p.newPage(), true)
  p.write("second")
  ccunit.eq(p.getInkLevel(), 0)
  ccunit.eq(p.newPage(), false)
  ccunit.eq(p.getCursorPos(), 7)
  ccunit.eq(p.endPage(), true)

  -- a dye goes in the ink slot only, paper in 2-7 only, nothing in the output slots
  ccunit.eq(chest.pullItems("left", 8), 1) -- the second page
  chest.pullItems("left", 2)
  chest.pullItems("left", 3)
  local items = chest.list()
  ccunit.eq(p.getPaperLevel(), 0)
  -- the printed page from the first run goes back in as paper, to print over
  ccunit.eq(chest.pushItems("left", 1), 1)
  ccunit.eq(p.getPaperLevel(), 1)
end)
`;

describe.skipIf(!ready)("the printer", () => {
  it.each(["1.18.2", "1.21.1"])(
    "prints, runs out, and hands its pages to a chest (%s)",
    async (mc) => {
      expectAllPassed(await lua(SAME, world(mc)));
    },
    60000,
  );

  it.each(["1.18.2", "1.21.1"])(
    "takes ink and paper from a chest by its slot rules (%s)",
    async (mc) => {
      expectAllPassed(
        await lua(
          `
ccunit.test("slots", function()
  local p = peripheral.wrap("left")
  local chest = peripheral.wrap("chest_0")
  ccunit.eq(p.getInkLevel(), 0)
  chest.size() -- the chest's items come from the world
  ccunit.eq(chest.pushItems("left", 1), 10) -- red dye: slot 1
  ccunit.eq(chest.pushItems("left", 2), 5)  -- paper: slots 2-7
  ccunit.eq(chest.pushItems("left", 3), 0)  -- a stone has no slot
  ccunit.eq(chest.pushItems("left", 3, 1, 8), 0)
  ccunit.eq(p.getInkLevel(), 10)
  ccunit.eq(p.getPaperLevel(), 5)
  ccunit.eq(p.newPage(), true)
end)
`,
          {
            ...world(mc),
            peripherals: [
              { name: "left", type: "printer" },
              {
                name: "chest_0",
                type: "minecraft:chest",
                size: 27,
                items: {
                  "1": { name: "minecraft:red_dye", count: 10 },
                  "2": { name: "minecraft:paper", count: 5 },
                  "3": { name: "minecraft:stone", count: 1 },
                },
              },
            ],
          },
        ),
      );
    },
    60000,
  );

  it("writes a value that is not a string as each version's Java does", async () => {
    const source = `
ccunit.test("coerce", function()
  local p = peripheral.wrap("left")
  p.newPage()
  local function put(v) p.setCursorPos(1, 1) p.write(string.rep(" ", 25)) p.setCursorPos(1, 1) p.write(v) return (select(1, p.getCursorPos())) - 1 end
  _G.lengths = { put(5), put(1.5), put(true), put(nil), put(1e10), put(0.0001) }
end)
ccunit.test("lengths", function()
  ccunit.eq(_G.lengths, EXPECTED)
end)
`;
    // 1.101.3: "5.0" "1.5" "true" "" "1.0E10" "1.0E-4"; 1.121.0: "5" "1.5" "true" "nil" "1.0E10" "1.0E-4"
    const [a, b] = await Promise.all([
      lua(source.replace("EXPECTED", "{ 3, 3, 4, 0, 6, 6 }"), world("1.18.2")),
      lua(source.replace("EXPECTED", "{ 1, 3, 4, 3, 6, 6 }"), world("1.21.1")),
    ]);
    expectAllPassed(a);
    expectAllPassed(b);
  }, 60000);

  it("shows the printed pages in the sim state", async () => {
    put(
      "print.lua",
      `local p = peripheral.wrap("left")
p.newPage()
p.setPageTitle("Shopping")
p.write("eggs")
p.setCursorPos(1, 2)
p.write("milk")
p.endPage()
p.newPage()
p.write("half done")
`,
    );
    const result = await runProgram(config, {
      program: "print.lua",
      world: world("1.21.1", {
        items: { "1": { name: "minecraft:blue_dye", count: 3 } },
      }),
      timeoutMs: 30000,
    });
    expect(result.status).toBe("completed");
    const state = result.sim?.peripherals?.["left"] as {
      printing: boolean;
      page: string[];
      printed: { title: string; text: string[]; colours: string[] }[];
      ink: number;
      inkColour: string;
      paper: number;
    };
    expect(state.printed).toHaveLength(1);
    expect(state.printed[0]!.title).toBe("Shopping");
    expect(state.printed[0]!.text.slice(0, 2)).toEqual([
      "eggs".padEnd(25),
      "milk".padEnd(25),
    ]);
    // blue dye is colour 11: "b" on every letter of the page
    expect(state.printed[0]!.colours[0]).toBe("b".repeat(25));
    expect(state.printing).toBe(true);
    expect(state.page[0]).toBe("half done".padEnd(25));
    expect(state).toMatchObject({
      ink: 1,
      inkColour: "minecraft:blue_dye",
      paper: 1,
    });
    const slots = result.sim?.inventories?.["left"] as Record<
      string,
      { name: string }
    >;
    expect(slots["8"]!.name).toBe("computercraft:printed_page");
  }, 60000);
});
