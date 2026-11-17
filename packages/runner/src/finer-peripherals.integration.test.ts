import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  checkWorldAddons,
  loadConfig,
  resolveAddons,
  runTests,
} from "./index.js";

/**
 * Finer Peripherals 1.20.1-0.6.1 (Fabric 1.20.1), written from minecraftbossdj/FinerPeripherals at b217ea8 and
 * checked against the 0.6.1 jar. docs/finer-peripherals.md has the source of every rule. The mod is not in the pack:
 * nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "finer-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(base).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 60000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const world = (extra: Record<string, unknown>): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["finer-peripherals"],
    simProgram: true,
    ...extra,
  }) as WorldConfig;

describe("Finer Peripherals addon registry", () => {
  it("exists on 1.20.1 only, and its types do not clash with Advanced Peripherals'", () => {
    expect(resolveAddons(["finer-peripherals"], {}, "1.20.1")).toEqual([
      "finer-peripherals",
    ]);
    expect(() => resolveAddons(["finer-peripherals"], {}, "1.21.1")).toThrow(
      /no release for Minecraft 1.21.1/,
    );
    expect(() =>
      checkWorldAddons(
        { peripherals: [{ name: "c", type: "finerperipherals:chatbox" }] },
        ["advanced-peripherals"],
        "1.20.1",
      ),
    ).toThrow(/Finer Peripherals \(addon "finer-peripherals"\)/);
    // AP's own chatBox stays AP's
    expect(() =>
      checkWorldAddons(
        { peripherals: [{ name: "c", type: "chatBox" }] },
        ["advanced-peripherals"],
        "1.20.1",
      ),
    ).not.toThrow();
  });
});

describe.skipIf(!ready)("Finer Peripherals", () => {
  it("the example: ore_scout.lua against ore_scout.world.json, and every block's methods", async () => {
    const test = "examples/finer-peripherals/ore_scout.test.lua";
    const w = JSON.parse(
      readFileSync(
        join(base.workspaceDir, test.replace(/\.test\.lua$/, ".world.json")),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await runTests(
      base,
      { paths: [test], world: w, timeoutMs: 90000 },
      1,
    );
    expectAllPassed(result);
  }, 120000);

  it("pocket upgrades: chatbox, geoExplorer (no getOperationCooldown, false on cooldown), eventRelayer, debug", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("pocket", function()
  ccunit.eq(peripheral.getType("top"), "chatbox")
  ccunit.eq(peripheral.call("top", "tellraw", "hi"), true)
  ccunit.eq(peripheral.getType("back"), "geoExplorer")
  ccunit.eq(#peripheral.call("back", "scan", 1), 9) -- the ground under the holder: the y = 63 layer
  ccunit.eq({ peripheral.call("back", "scan", 1) }, { false, "On cooldown!" })
  ccunit.eq(err(peripheral.call, "back", "getOperationCooldown"), "No such method getOperationCooldown")
  ccunit.eq({ peripheral.call("bottom", "periphList") }, { false, "lil bro this shit dont exist anymore, lock in" })
  ccunit.eq(peripheral.getType("bottom"), "debug")
  ccunit.eq(peripheral.getType("left"), "eventRelayer")
  local n = 0
  parallel.waitForAny(function()
    while true do os.pullEvent("chat"); n = n + 1 end
  end, function() sim({ cmd = "finerChat", player = "Alex", message = "one" }); sleep(0.3) end)
  ccunit.eq(n, 1)
end)
`,
        world({
          players: [{ name: "Alex" }],
          ground: { y: 63, name: "minecraft:stone" },
          peripherals: [
            { name: "top", type: "finerperipherals:chatbox_pocket" },
            {
              name: "back",
              type: "finerperipherals:geoexplorer_pocket",
              x: 0.5,
              y: 64.2,
              z: 0.5,
            },
            { name: "bottom", type: "finerperipherals:debug_pocket" },
            { name: "left", type: "finerperipherals:eventrelayer_pocket" },
          ],
        }),
        "pocket.lua",
      ),
    );
  }, 60000);

  it("turtle upgrades: compass and geo explorer keep the block entity where they were made; the ender chest", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("compass", function()
  ccunit.eq(peripheral.getType("left"), "compass")
  local compass = peripheral.wrap("left")
  ccunit.eq(compass.getDirection(), "north")
  turtle.turnRight()
  ccunit.eq(compass.getDirection(), "east") -- still its own block entity
  ccunit.eq(compass.getDirectionInHub(), "east")
  ccunit.truthy(turtle.forward())
  turtle.turnLeft()
  ccunit.eq(compass.getDirection(), "east") -- the old block entity: the facing it had when it left
  ccunit.eq(err(compass.getDirectionInHub), "Java Exception Thrown: java.lang.NullPointerException") -- air there now
end)

ccunit.test("enderchest", function()
  local ender = peripheral.wrap("right")
  ccunit.eq(peripheral.getType("right"), "enderchest")
  ccunit.eq(ender.size(), 27)
  ccunit.eq(ender.list(), { { name = "minecraft:diamond", count = 10 } })
  ccunit.eq(ender.getItemLimit(1), 64)
  ccunit.eq({ ender.pushItems(1, 5, 4) }, { true, 5 })
  local inv = ender.getInventory()
  ccunit.eq(inv[4].name, "minecraft:diamond")
  ccunit.eq(inv[1].displayName, "[Coal]")
  ccunit.eq(inv[1].maxStackSize, 64)
  ccunit.eq(inv[5], nil)
  ccunit.eq({ ender.pullItems(1, 1, 1) }, { false, "To slot doesn't contain the same item!" }) -- coal onto diamonds
  ccunit.eq({ ender.pullItems(4, 2, 5) }, { true, 2 })
  ccunit.eq(ender.list()[5], { name = "minecraft:diamond", count = 2 })
  ccunit.eq({ ender.pullItems(9, 1, 1) }, { false, "From slot is empty!" })
  ccunit.eq(err(ender.pushItems, 1, 0, 4), "Stack Size out of range (between 1 and 64)")
  ccunit.eq(err(ender.pushItems, 30, 1, 1), "From slot out of range (between 1 and 27)")
  ccunit.eq(err(ender.pushItems, 1, 1, 17), "To slot out of range (between 1 and 16)")
  ccunit.eq(err(ender.pushItems, 1, 1), "bad argument #3 (number expected, got nil)")
  sim({ cmd = "finerSetOwner", owner = "Nobody" })
  ccunit.eq({ ender.list() }, { false, "Player isn't present" })
  ccunit.eq({ ender.size() }, { false, "Player isn't present" })
end)

ccunit.test("geoExplorer and chatBox turtles", function()
  turtle.select(2)
  ccunit.truthy(turtle.equipLeft())
  ccunit.eq(peripheral.getType("left"), "geoExplorer")
  local blocks = peripheral.call("left", "scan", 1)
  ccunit.eq(#blocks, 10) -- 3 x 3 of ground and the turtle itself
  local here
  for _, b in ipairs(blocks) do if b.x == 0 and b.y == 0 and b.z == 0 then here = b.name end end
  ccunit.eq(here, "computercraft:turtle_normal")
  ccunit.truthy(turtle.back())
  sleep(2.1)
  -- still around where it was equipped: the turtle, one block south now, shows up at 0, 0, 1
  local after = {}
  for _, b in ipairs(peripheral.call("left", "scan", 1)) do after[b.x .. "," .. b.y .. "," .. b.z] = b.name end
  ccunit.eq(after["0,0,0"], nil)
  ccunit.eq(after["0,0,1"], "computercraft:turtle_normal")
  turtle.select(3)
  ccunit.truthy(turtle.equipLeft())
  ccunit.eq(peripheral.getType("left"), "chatBox")
  ccunit.eq(peripheral.call("left", "tellraw", "beep"), true)
end)
`,
        world({
          players: [{ name: "Alex" }],
          finerPeripherals: {
            owner: "Alex",
            ender: { "0": { name: "minecraft:diamond", count: 10 } },
          },
          turtle: {
            x: 0,
            y: 64,
            z: 0,
            facing: "north",
            fuel: 100,
            left: "minecraft:compass",
            right: "minecraft:ender_chest",
            inventory: {
              "1": { name: "minecraft:coal", count: 5 },
              "2": { name: "finerperipherals:geoexplorer" },
              "3": { name: "finerperipherals:chatbox" },
            },
          },
          ground: { y: 63, name: "minecraft:stone" },
        }),
        "turtle.lua",
      ),
    );
  }, 60000);
});
