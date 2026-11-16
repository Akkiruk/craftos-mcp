// What CC:Tweaked 1.121.0 (Minecraft 1.20.1) does differently from 1.101.3 in the simulation, each case against the
// 1.121.0 source (tag v1.20.1-1.121.0) and, where the answer differs, the same case on 1.18.2 to show it stays as it
// was. The turtle stands at 0,64,0 facing north, so front is 0,64,-1 and back 0,64,1. See docs/turtle.md, "Minecraft
// versions".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type TurtleSpec,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "turtle121-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runLua(lua: string, world: WorldConfig): Promise<TestRunResult> {
  counter += 1;
  const name = `t121_${counter}.test.lua`;
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lua);
  return runTests(config, { paths: [name], world, timeoutMs: 60000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const pick = "minecraft:diamond_pickaxe";
function turtleWorld(
  version: string,
  t: TurtleSpec,
  extra: WorldConfig = {},
): WorldConfig {
  return {
    version,
    turtle: { x: 0, y: 64, z: 0, facing: "north", fuel: 100, ...t },
    ground: { y: 63, name: "minecraft:stone" },
    ...extra,
  };
}
const at = (
  x: number,
  y: number,
  z: number,
  name: string,
  more: object = {},
) => ({ x, y, z, name, ...more });

describe.skipIf(!ready)(
  "CC:Tweaked 1.121.0 in the simulation",
  { concurrent: true, timeout: 120000 },
  () => {
    it("getEquippedLeft/Right (1.116.0): the upgrade's item details, nil when empty; not on 1.18.2", async () => {
      const lua = (newer: boolean) => `
ccunit.test("equipped", function()
  ${
    newer
      ? `
  ccunit.eq(turtle.getEquippedLeft(), nil)
  local d = turtle.getEquippedRight()
  ccunit.eq(d.name, "minecraft:diamond_pickaxe")
  ccunit.eq(d.count, 1)
  ccunit.eq(d.displayName, "Diamond Pickaxe")
  ccunit.eq(d.maxDamage, 1561)
  ccunit.eq(d.damage, 0)
  ccunit.eq(next(d.itemGroups), nil, "itemGroups is always empty")
  ccunit.truthy(d.nbt, "a fresh tool carries Damage:0")
  ccunit.eq(d.mapColour, nil, "a pickaxe places no block")`
      : `
  ccunit.eq(turtle.getEquippedLeft, nil)
  ccunit.eq(turtle.getEquippedRight, nil)`
  }
end)
`;
      const [a, b] = await Promise.all([
        runLua(lua(true), turtleWorld("1.20.1", { right: pick })),
        runLua(lua(false), turtleWorld("1.18.2", { right: pick })),
      ]);
      expectAllPassed(a);
      expectAllPassed(b);
    });

    it("upgrades keep their item (1.121.0): a renamed tool equips and comes back renamed; damaged is refused", async () => {
      const named = {
        name: pick,
        count: 1,
        displayName: "Digger",
        nbt: { display: { Name: '{"text":"Digger"}' } },
      };
      const world = (version: string) =>
        turtleWorld(version, {
          inventory: {
            "1": named,
            "2": { name: pick, count: 1, damage: 5 },
          },
        });
      const [a, b] = await Promise.all([
        runLua(
          `
ccunit.test("renamed tool", function()
  local nbt = turtle.getItemDetail(1, true).nbt
  ccunit.eq({ turtle.equipLeft() }, { true })
  ccunit.eq(turtle.getItemCount(1), 0)
  local d = turtle.getEquippedLeft()
  ccunit.eq(d.displayName, "Digger")
  ccunit.eq(d.nbt, nbt)
  ccunit.eq({ turtle.equipLeft() }, { true }, "unequip into slot 1")
  local back = turtle.getItemDetail(1, true)
  ccunit.eq(back.displayName, "Digger")
  ccunit.eq(back.nbt, nbt)
end)
ccunit.test("damaged tool", function()
  turtle.select(2)
  ccunit.eq({ turtle.equipRight() }, { false, "Not a valid upgrade" })
end)
`,
          world("1.20.1"),
        ),
        runLua(
          `
ccunit.test("1.101.3 refuses a renamed tool", function()
  ccunit.eq({ turtle.equipLeft() }, { false, "Not a valid upgrade" })
end)
`,
          world("1.18.2"),
        ),
      ]);
      expectAllPassed(a);
      expectAllPassed(b);
    });

    it("suck from an inventory moves one slot at a time and passes over a slot that cannot fit (ForgeItemContainer.moveTo)", async () => {
      const chest = (items: object) =>
        at(0, 64, -1, "minecraft:chest", { items });
      const twoStacks = chest({
        "1": { name: "minecraft:cobblestone", count: 10 },
        "2": { name: "minecraft:cobblestone", count: 10 },
      });
      const full: Record<string, { name: string; count: number }> = {};
      for (let i = 1; i <= 15; i++)
        full[String(i)] = { name: "minecraft:dirt", count: 64 };
      full["16"] = { name: "minecraft:stone", count: 32 };
      const blocked = chest({
        "1": { name: "minecraft:dirt", count: 5 },
        "2": { name: "minecraft:stone", count: 5 },
      });
      const [a, b, c, d] = await Promise.all([
        runLua(
          `ccunit.test("one slot", function()
  ccunit.eq({ turtle.suck() }, { true })
  ccunit.eq(turtle.getItemCount(1), 10)
  ccunit.eq({ turtle.suck() }, { true })
  ccunit.eq(turtle.getItemCount(1), 20)
  ccunit.eq({ turtle.suck() }, { false, "No items to take" })
end)`,
          turtleWorld("1.20.1", {}, { blocks: [twoStacks] }),
        ),
        runLua(
          `ccunit.test("1.101.3 takes across slots", function()
  ccunit.eq({ turtle.suck() }, { true })
  ccunit.eq(turtle.getItemCount(1), 20)
end)`,
          turtleWorld("1.18.2", {}, { blocks: [twoStacks] }),
        ),
        runLua(
          `ccunit.test("skips the dirt", function()
  ccunit.eq({ turtle.suck() }, { true })
  ccunit.eq(turtle.getItemCount(16), 37)
  ccunit.eq({ turtle.suck() }, { false, "No space for items" })
end)`,
          turtleWorld("1.20.1", { inventory: full }, { blocks: [blocked] }),
        ),
        runLua(
          `ccunit.test("1.101.3 tries the first stack only", function()
  ccunit.eq({ turtle.suck() }, { false, "No space for items" })
  ccunit.eq(turtle.getItemCount(16), 32)
end)`,
          turtleWorld("1.18.2", { inventory: full }, { blocks: [blocked] }),
        ),
      ]);
      for (const r of [a, b, c, d]) expectAllPassed(r);
    });

    it("map colours in item and block details (DetailHelpers.fillMapColour); not on 1.18.2", async () => {
      const blocks = [
        at(0, 64, -1, "minecraft:oak_log", { state: { axis: "x" } }),
        at(0, 65, 0, "minecraft:stone"),
        at(0, 63, 0, "minecraft:glass"),
      ];
      const inventory = {
        "1": { name: "minecraft:oak_log", count: 2 },
        "2": { name: "minecraft:wheat_seeds", count: 1 },
        "3": { name: "minecraft:wheat", count: 1 },
        "4": { name: "computercraft:turtle_advanced", count: 1 },
      };
      const [a, b] = await Promise.all([
        runLua(
          `
ccunit.test("blocks", function()
  local _, log = turtle.inspect()
  ccunit.eq(log.mapColour, 8476209, "a log on its side shows its bark (PODZOL)")
  ccunit.eq(log.mapColor, 8476209)
  local _, stone = turtle.inspectUp()
  ccunit.eq(stone.mapColour, 7368816)
  local _, glass = turtle.inspectDown()
  ccunit.eq(glass.mapColour, nil, "glass has MapColor.NONE")
end)
ccunit.test("items", function()
  ccunit.eq(turtle.getItemDetail(1, true).mapColour, 9402184, "the item's block by default: axis y, WOOD")
  ccunit.eq(turtle.getItemDetail(2, true).mapColour, 31744, "seeds are the crop's BlockItem: PLANT")
  ccunit.eq(turtle.getItemDetail(3, true).mapColour, nil, "wheat is no BlockItem")
  ccunit.eq(turtle.getItemDetail(4, true).mapColour, 16445005, "CC's own block: GOLD")
  ccunit.eq(turtle.getItemDetail(1).mapColour, nil, "not in the basic details")
end)
`,
          turtleWorld("1.20.1", { inventory }, { blocks }),
        ),
        runLua(
          `
ccunit.test("1.101.3 has none", function()
  local _, log = turtle.inspect()
  ccunit.eq(log.mapColour, nil)
  ccunit.eq(turtle.getItemDetail(1, true).mapColour, nil)
end)
`,
          turtleWorld("1.18.2", { inventory }, { blocks }),
        ),
      ]);
      expectAllPassed(a);
      expectAllPassed(b);
    });

    it("turtle_can_use: a composter takes compostables and gives bone meal; 1.18.2 places the block instead", async () => {
      const world = (version: string, level: string) =>
        turtleWorld(
          version,
          {
            inventory: {
              "1": { name: "minecraft:pumpkin", count: 5 },
            },
          },
          {
            blocks: [
              at(0, 64, -1, "minecraft:composter", { state: { level } }),
            ],
          },
        );
      const [a, b, c, d] = await Promise.all([
        runLua(
          `ccunit.test("first item always counts", function()
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(turtle.getItemCount(1), 4)
  local _, b = turtle.inspect()
  ccunit.eq(b.state.level, 1)
end)`,
          world("1.20.1", "0"),
        ),
        runLua(
          `ccunit.test("level 7 takes nothing, then is ready 20 ticks later", function()
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(turtle.getItemCount(1), 5)
  sleep(1.1)
  local _, b = turtle.inspect()
  ccunit.eq(b.state.level, 8)
  ccunit.eq({ turtle.place() }, { true }, "bone meal out")
  ccunit.eq(turtle.getItemCount(1), 5)
  local _, b2 = turtle.inspect()
  ccunit.eq(b2.state.level, 0)
end)`,
          world("1.20.1", "7"),
        ),
        runLua(
          `ccunit.test("1.101.3 does not use the composter", function()
  turtle.place()
  local _, b = turtle.inspect()
  ccunit.eq(b.state.level, 0)
end)`,
          world("1.18.2", "0"),
        ),
        runLua(
          `ccunit.test("not compostable: the composter passes, the item has no use", function()
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { false, "Cannot place item here" })
  ccunit.eq(turtle.getItemCount(2), 1)
  local _, b = turtle.inspect()
  ccunit.eq(b.state.level, 3)
end)`,
          {
            ...world("1.20.1", "3"),
            turtle: {
              x: 0,
              y: 64,
              z: 0,
              facing: "north",
              fuel: 100,
              inventory: { "2": { name: "minecraft:stick", count: 1 } },
            },
          },
        ),
      ]);
      for (const r of [a, b, c, d]) expectAllPassed(r);
    });

    it("turtle_can_use: cauldrons take and give water, bottles go a level at a time; beehives give honey", async () => {
      const r = await runLua(
        `
ccunit.test("water bucket into an empty cauldron and back", function()
  ccunit.eq({ turtle.place() }, { true })
  local _, b = turtle.inspect()
  ccunit.eq(b.name, "minecraft:water_cauldron")
  ccunit.eq(b.state.level, 3)
  ccunit.eq(turtle.getItemDetail(1).name, "minecraft:bucket")
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(turtle.getItemDetail(1).name, "minecraft:water_bucket")
  local _, empty = turtle.inspect()
  ccunit.eq(empty.name, "minecraft:cauldron")
  ccunit.eq({ turtle.place() }, { true })
end)
ccunit.test("bottles", function()
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(turtle.getItemCount(2), 3)
  local potion = turtle.getItemDetail(3, true)
  ccunit.eq(potion.name, "minecraft:potion")
  local _, b = turtle.inspect()
  ccunit.eq(b.state.level, 2)
  turtle.select(3)
  ccunit.eq({ turtle.place() }, { true }, "the water bottle goes back in")
  local _, b2 = turtle.inspect()
  ccunit.eq(b2.state.level, 3)
  ccunit.eq(turtle.getItemDetail(3).name, "minecraft:glass_bottle")
end)
ccunit.test("beehive", function()
  turtle.turnRight()
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(turtle.getItemDetail(4).name, "minecraft:honey_bottle")
  local _, hive = turtle.inspect()
  ccunit.eq(hive.state.honey_level, 0)
end)
`,
        turtleWorld(
          "1.20.1",
          {
            inventory: {
              "1": { name: "minecraft:water_bucket", count: 1 },
              "2": { name: "minecraft:glass_bottle", count: 4 },
            },
          },
          {
            blocks: [
              at(0, 64, -1, "minecraft:cauldron"),
              at(1, 64, 0, "minecraft:beehive", {
                state: { facing: "west", honey_level: "5" },
              }),
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("redstone_relay is a peripheral (1.114.0) with RedstoneMethods; plain block on 1.18.2", async () => {
      const blocks = [
        at(0, 64, -1, "computercraft:redstone_relay", {
          state: { facing: "south" },
          blockEntity: { inputs: { left: 7 } },
        }),
      ];
      const [a, b] = await Promise.all([
        runLua(
          `
ccunit.test("relay", function()
  local r = peripheral.wrap("front")
  ccunit.eq(peripheral.getType("front"), "redstone_relay")
  ccunit.eq(r.getAnalogInput("left"), 7)
  ccunit.eq(r.getInput("LEFT"), true)
  ccunit.eq(r.getAnalogueInput("top"), 0)
  r.setAnalogOutput("back", 9)
  ccunit.eq(r.getAnalogOutput("back"), 9)
  ccunit.eq(r.getOutput("back"), true)
  r.setBundledOutput("top", 5)
  ccunit.eq(r.getBundledOutput("top"), 5)
  ccunit.eq(r.testBundledInput("top", 0), true)
  ccunit.raises(function() r.setAnalogOutput("back", 16) end, "Expected number in range 0%-15")
  ccunit.raises(function() r.getInput("up") end, "bad argument #1 %(unknown option up%)")
  ccunit.eq(r.getSides, nil)
end)
`,
          turtleWorld("1.20.1", {}, { blocks }),
        ),
        runLua(
          `ccunit.test("no relay", function() ccunit.eq(peripheral.getType("front"), nil) end)`,
          turtleWorld("1.18.2", {}, { blocks }),
        ),
      ]);
      expectAllPassed(a);
      expectAllPassed(b);
    });

    it("speaker.playSound: one sound per tick, no music discs, 1.121.0's messages", async () => {
      const world = (version: string): WorldConfig => ({
        version,
        peripherals: [{ name: "sp", type: "speaker" }],
      });
      const [a, b] = await Promise.all([
        runLua(
          `
ccunit.test("speaker", function()
  local sp = peripheral.wrap("sp")
  -- a burst: only the first call in each server tick plays (how many ticks it spans depends on the host's speed)
  local played = 0
  for _ = 1, 20 do if sp.playSound("block.note_block.harp") then played = played + 1 end end
  ccunit.truthy(played >= 1 and played < 20, "some of the burst was refused: " .. played)
  sleep(0.1)
  ccunit.eq(sp.playSound("minecraft:music_disc.cat"), false, "music discs are refused")
  ccunit.eq(sp.playSound("music_disc.pigstep"), false)
  ccunit.eq(sp.playSound("entity.creeper.primed"), true)
  ccunit.raises(function() sp.playSound("Bad Name") end, "bad argument #1 %(malformed sound name%)")
  ccunit.raises(function() sp.playSound(("a"):rep(513)) end, "bad argument #1 %(sound name is too long%)")
end)
`,
          world("1.20.1"),
        ),
        runLua(
          `
ccunit.test("1.101.3 speaker", function()
  local sp = peripheral.wrap("sp")
  for i = 1, 20 do ccunit.eq(sp.playSound("block.note_block.harp"), true, "sound " .. i) end
  ccunit.eq(sp.playSound("minecraft:music_disc.cat"), true)
  ccunit.raises(function() sp.playSound("Bad Name") end, "Malformed sound name 'Bad Name'")
end)
`,
          world("1.18.2"),
        ),
      ]);
      expectAllPassed(a);
      expectAllPassed(b);
    });

    it("an inventory peripheral's item details carry the map colour too", async () => {
      const world = (version: string): WorldConfig => ({
        version,
        peripherals: [
          {
            name: "chest",
            type: "minecraft:chest",
            size: 27,
            items: { "1": { name: "minecraft:stone", count: 3 } },
          },
        ],
      });
      const [a, b] = await Promise.all([
        runLua(
          `ccunit.test("chest", function()
  local d = peripheral.wrap("chest").getItemDetail(1)
  ccunit.eq(d.mapColour, 7368816)
  ccunit.eq(d.mapColor, 7368816)
  ccunit.eq(next(d.itemGroups), nil)
end)`,
          world("1.20.1"),
        ),
        runLua(
          `ccunit.test("chest 1.101.3", function()
  ccunit.eq(peripheral.wrap("chest").getItemDetail(1).mapColour, nil)
end)`,
          world("1.18.2"),
        ),
      ]);
      expectAllPassed(a);
      expectAllPassed(b);
    });
  },
);
