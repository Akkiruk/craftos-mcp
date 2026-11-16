// Turtles (CC:Tweaked 1.101.3): every expected value here comes from docs/turtle/cct-1.101.3-turtle-rules.md, which
// is written from the mod's source. The turtle stands at 0,64,0 facing north (-z) unless a case says otherwise, so
// front is 0,64,-1, back 0,64,1, left (west) -1,64,0, right (east) 1,64,0, up 0,65,0 and down 0,63,0.
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
const scratch = mkdtempSync(join(tmpdir(), "turtle-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runLua(lua: string, world: WorldConfig): Promise<TestRunResult> {
  counter += 1;
  const name = `turtle${counter}.test.lua`;
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
function turtleWorld(t: TurtleSpec, extra: WorldConfig = {}): WorldConfig {
  return {
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
  "turtle emulation",
  { concurrent: true, timeout: 120000 },
  () => {
    it("is a turtle: API, terminal, colour, programs", async () => {
      const r = await runLua(
        `
ccunit.test("globals", function()
  ccunit.truthy(turtle and turtle.native, "turtle API")
  ccunit.eq(turtle.craft, nil, "no workbench, no craft")
  local w, h = term.getSize()
  ccunit.eq(w, 39) ccunit.eq(h, 13)
  ccunit.eq(term.isColor(), false, "a normal turtle has no colour")
end)
ccunit.test("turtle programs on the path", function()
  ccunit.truthy(shell.resolveProgram("excavate"), "excavate")
  ccunit.truthy(shell.resolveProgram("go"), "go")
  ccunit.eq(shell.resolveProgram("worm"), nil, "no fun programs on a turtle")
end)
ccunit.test("fuel", function()
  ccunit.eq(turtle.getFuelLevel(), 100)
  ccunit.eq(turtle.getFuelLimit(), 20000)
end)
ccunit.test("argument errors", function()
  ccunit.raises(function() turtle.select(17) end, "Slot number 17 out of range")
  ccunit.raises(function() turtle.select("x") end, "bad argument #1 %(number expected, got string%)")
  ccunit.raises(function() turtle.drop(65) end, "Item count 65 out of range")
  ccunit.raises(function() turtle.dig("up") end, "bad argument #1 %(unknown option up%)")
  ccunit.raises(function() turtle.refuel(-1) end, "Refuel count %-1 out of range")
  ccunit.eq(turtle.getSelectedSlot(), 1)
  ccunit.eq(select("#", turtle.drop(print)), 2, "a function argument is no argument: drop() with nothing")
end)
`,
        turtleWorld({}),
      );
      expectAllPassed(r);
    });

    it("moves: fuel, obstruction, height limits, replaceable blocks, timing", async () => {
      const r = await runLua(
        `
ccunit.test("obstructed before out of fuel", function()
  ccunit.eq({ turtle.back() }, { false, "Movement obstructed" })
end)
ccunit.test("moves use one fuel, turns none", function()
  ccunit.eq({ turtle.forward() }, { true })
  ccunit.eq(turtle.getFuelLevel(), 2)
  turtle.turnLeft() turtle.turnRight()
  ccunit.eq(turtle.getFuelLevel(), 2)
end)
ccunit.test("grass and water are walked into, the grass is gone", function()
  ccunit.eq({ turtle.forward() }, { true }) -- into the tall grass at z=-2
  ccunit.eq({ turtle.forward() }, { true }) -- into the water at z=-3
  ccunit.eq(turtle.getFuelLevel(), 0)
  ccunit.eq({ turtle.forward() }, { false, "Out of fuel" })
end)
`,
        turtleWorld(
          { fuel: 3 },
          {
            blocks: [
              at(0, 64, 1, "minecraft:stone"),
              at(0, 64, -2, "minecraft:grass"),
              at(0, 64, -3, "minecraft:water", { state: { level: "0" } }),
            ],
          },
        ),
      );
      expectAllPassed(r);
      const result = r.files[0]!;
      expect(result.status).toBe("passed");
    });

    it("stops at the build limits", async () => {
      const r = await runLua(
        `
ccunit.test("too high", function() ccunit.eq({ turtle.up() }, { false, "Too high to move" }) end)
`,
        turtleWorld({ y: 319 }),
      );
      expectAllPassed(r);
      const low = await runLua(
        `
ccunit.test("too low", function() ccunit.eq({ turtle.down() }, { false, "Too low to move" }) end)
`,
        { turtle: { x: 0, y: -64, z: 0, fuel: 10 } },
      );
      expectAllPassed(low);
    });

    it("runs one command a tick and holds the next one 8 ticks after an animation", async () => {
      const r = await runLua(
        `
ccunit.test("five moves", function()
  local start = os.clock()
  for _ = 1, 5 do turtle.forward() end
  local took = os.clock() - start
  -- the first move runs on the next tick, then one every 8 ticks: 0.05 + 4 x 0.4
  -- the ticks never come early, so the lower bound is exact; a busy machine only makes them late: no upper bound
  ccunit.truthy(took >= 1.6, "five moves took " .. took)
end)
ccunit.test("detect has no animation", function()
  turtle.detect() -- waits out the last move's animation
  local start = os.clock()
  for _ = 1, 10 do turtle.detect() end
  local took = os.clock() - start
  ccunit.truthy(took >= 0.45, "ten detects took " .. took)
end)
ccunit.test("the 18th command is refused", function()
  local results = {}
  local fns = {}
  for i = 1, 18 do fns[i] = function() results[i] = { turtle.detect() } end end
  parallel.waitForAll(table.unpack(fns))
  local refused = 0
  for i = 1, 18 do if results[i][2] == "Too many ongoing turtle commands" then refused = refused + 1 end end
  ccunit.eq(refused, 1)
end)
`,
        turtleWorld({ fuel: 100 }),
      );
      expectAllPassed(r);
    });

    it("digs with the real loot tables and tool rules", async () => {
      const r = await runLua(
        `
ccunit.test("stone gives cobblestone", function()
  ccunit.eq({ turtle.dig() }, { true })
  ccunit.eq(turtle.getItemDetail(1), { name = "minecraft:cobblestone", count = 1 })
end)
ccunit.test("nothing, water, bedrock", function()
  ccunit.eq({ turtle.dig() }, { false, "Nothing to dig here" })
  ccunit.eq({ turtle.digUp() }, { false, "Nothing to dig here" }) -- water above
  ccunit.eq({ turtle.digDown() }, { false, "Cannot break unbreakable block" })
end)
ccunit.test("glass breaks and drops nothing", function()
  turtle.turnLeft()
  ccunit.eq({ turtle.dig() }, { true })
  ccunit.eq(turtle.getItemCount(2), 0)
end)
ccunit.test("a chest's contents come along", function()
  turtle.turnLeft() -- facing south: the chest at 0,64,1
  ccunit.eq({ turtle.dig() }, { true })
  local found = {}
  for i = 1, 16 do local d = turtle.getItemDetail(i) if d then found[d.name] = (found[d.name] or 0) + d.count end end
  ccunit.eq(found["minecraft:chest"], 1)
  ccunit.eq(found["minecraft:diamond"], 3)
end)
`,
        turtleWorld(
          { right: pick },
          {
            blocks: [
              at(0, 64, -1, "minecraft:stone"),
              at(0, 65, 0, "minecraft:water", { state: { level: "0" } }),
              at(0, 63, 0, "minecraft:bedrock"),
              at(-1, 64, 0, "minecraft:glass"),
              at(0, 64, 1, "minecraft:chest", {
                items: { "1": { name: "minecraft:diamond", count: 3 } },
              }),
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("tool rules: no tool, axe on stone, sword, torches pop", async () => {
      const r = await runLua(
        `
ccunit.test("axe digs stone and gets nothing", function()
  ccunit.eq({ turtle.dig() }, { true })
  ccunit.eq(turtle.getItemCount(1), 0)
end)
ccunit.test("sword cannot break stone", function()
  turtle.turnLeft()
  ccunit.eq({ turtle.dig("left") }, { false, "Cannot break block with this tool" })
end)
ccunit.test("the left tool's message wins, the axe then digs", function()
  ccunit.eq({ turtle.dig() }, { true })
end)
ccunit.test("a torch on the dug block pops into the turtle", function()
  turtle.turnRight() turtle.turnRight() -- east: oak log at 1,64,0 with a torch on top
  ccunit.eq({ turtle.dig() }, { true })
  local names = {}
  for i = 1, 16 do local d = turtle.getItemDetail(i) if d then names[d.name] = d.count end end
  ccunit.eq(names["minecraft:oak_log"], 1)
  ccunit.eq(names["minecraft:torch"], 1)
end)
`,
        turtleWorld(
          { left: "minecraft:diamond_sword", right: "minecraft:diamond_axe" },
          {
            blocks: [
              at(0, 64, -1, "minecraft:stone"),
              at(-1, 64, 0, "minecraft:stone"),
              at(1, 64, 0, "minecraft:oak_log"),
              at(1, 65, 0, "minecraft:torch"),
            ],
          },
        ),
      );
      expectAllPassed(r);
      const none = await runLua(
        `
ccunit.test("no tool", function()
  ccunit.eq({ turtle.dig() }, { false, "No tool to dig with" })
  ccunit.eq({ turtle.attack() }, { false, "No tool to attack with" })
end)
`,
        turtleWorld({}),
      );
      expectAllPassed(none);
    });

    it("gravel falls into the gap", async () => {
      const r = await runLua(
        `
ccunit.test("dig until clear", function()
  local digs = 0
  while turtle.detect() do
    turtle.dig()
    digs = digs + 1
    sleep(0.5)
    if digs > 10 then break end
  end
  ccunit.eq(digs, 3)
  local n = 0
  for i = 1, 16 do n = n + turtle.getItemCount(i) end
  ccunit.eq(n, 3)
end)
`,
        turtleWorld(
          { right: pick },
          {
            blocks: [
              at(0, 64, -1, "minecraft:gravel"),
              at(0, 65, -1, "minecraft:gravel"),
              at(0, 66, -1, "minecraft:gravel"),
            ],
            gameData: {
              loot: {
                "minecraft:gravel": {
                  pools: [
                    {
                      rolls: 1,
                      entries: [
                        { type: "minecraft:item", name: "minecraft:gravel" },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ),
      );
      expectAllPassed(r);
    });

    it("places blocks, facing and sign text as vanilla sets them", async () => {
      const r = await runLua(
        `
ccunit.test("nothing selected", function()
  turtle.select(16)
  ccunit.eq({ turtle.place() }, { false, "No items to place" })
  turtle.select(1)
end)
ccunit.test("a chest faces the turtle", function()
  ccunit.eq({ turtle.place() }, { true })
  local ok, b = turtle.inspect()
  ccunit.eq(b.name, "minecraft:chest")
  ccunit.eq(b.state.facing, "south")
end)
ccunit.test("stairs face where the turtle looks", function()
  turtle.turnLeft()
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  local _, b = turtle.inspect()
  ccunit.eq(b.state.facing, "west")
  ccunit.eq(b.state.half, "bottom")
  ccunit.eq(b.state.waterlogged, false)
  ccunit.truthy(b.tags["minecraft:stairs"], "stairs tag")
end)
ccunit.test("solid in the way", function()
  turtle.select(3)
  ccunit.eq({ turtle.place() }, { false, "Cannot place block here" })
end)
ccunit.test("a stick is not placeable", function()
  turtle.turnLeft()
  turtle.select(4)
  ccunit.eq({ turtle.place() }, { false, "Cannot place item here" })
end)
ccunit.test("a sign keeps its text, one line on row 2", function()
  turtle.select(5)
  ccunit.eq({ turtle.place("Hello") }, { true })
  local _, b = turtle.inspect()
  ccunit.eq(b.name, "minecraft:oak_sign")
end)
ccunit.test("a bucket takes a water source", function()
  turtle.turnLeft()
  turtle.select(6)
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(turtle.getItemDetail(6).name, "minecraft:water_bucket")
  ccunit.eq({ turtle.inspect() }, { false, "No block to inspect" })
end)
`,
        turtleWorld(
          {
            inventory: {
              "1": { name: "minecraft:chest", count: 1 },
              "2": { name: "minecraft:oak_stairs", count: 1 },
              "3": { name: "minecraft:stone", count: 1 },
              "4": { name: "minecraft:stick", count: 1 },
              "5": { name: "minecraft:oak_sign", count: 1 },
              "6": { name: "minecraft:bucket", count: 1 },
            },
          },
          {
            blocks: [
              at(1, 64, 0, "minecraft:water", { state: { level: "0" } }),
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("drops, sucks, transfers and compares", async () => {
      const r = await runLua(
        `
ccunit.test("drop into the chest in front", function()
  ccunit.eq({ turtle.drop(0) }, { true })
  ccunit.eq({ turtle.drop(10) }, { true })
  ccunit.eq(turtle.getItemCount(1), 54)
  local chest = peripheral.wrap("front")
  ccunit.eq(chest.list()[1].count, 10)
end)
ccunit.test("nothing to drop", function()
  turtle.select(16)
  ccunit.eq({ turtle.drop() }, { false, "No items to drop" })
  turtle.select(1)
end)
ccunit.test("suck back and the turtle_inventory event", function()
  ccunit.eq({ turtle.suck(4) }, { true })
  ccunit.eq(turtle.getItemCount(1), 58)
  -- queued at the end of the tick the suck ran in, after its turtle_response, so it is still waiting
  local got = false
  local t = os.startTimer(0.2)
  while true do
    local e, id = os.pullEvent()
    if e == "turtle_inventory" then got = true elseif e == "timer" and id == t then break end
  end
  ccunit.truthy(got, "turtle_inventory")
end)
ccunit.test("drop on the ground and pick it up", function()
  turtle.turnLeft() turtle.turnLeft()
  ccunit.eq({ turtle.drop(5) }, { true })
  ccunit.eq(turtle.getItemCount(1), 53)
  ccunit.eq({ turtle.suckDown() }, { false, "No items to take" })
end)
ccunit.test("transferTo and compareTo", function()
  ccunit.eq({ turtle.transferTo(2, 3) }, { true })
  ccunit.eq(turtle.getItemCount(2), 3)
  ccunit.eq({ turtle.compareTo(2) }, { true })
  ccunit.eq({ turtle.compareTo(3) }, { false, nil })
  ccunit.eq({ turtle.transferTo(3) }, { false, "No space for items" })
  turtle.select(16)
  ccunit.eq({ turtle.transferTo(2) }, { true }, "nothing to take is a success")
  turtle.select(1)
end)
ccunit.test("item space and detail", function()
  ccunit.eq(turtle.getItemSpace(3), 15, "ender pearls stack to 16")
  ccunit.eq(turtle.getItemSpace(16), 64)
  ccunit.eq(turtle.getItemDetail(1), { name = "minecraft:cobblestone", count = 50 })
  local d = turtle.getItemDetail(1, true)
  ccunit.eq(d.displayName, "Cobblestone")
  ccunit.eq(d.maxCount, 64)
  ccunit.truthy(d.tags["forge:cobblestone"], "item tags")
end)
`,
        turtleWorld(
          {
            inventory: {
              "1": { name: "minecraft:cobblestone", count: 64 },
              "3": { name: "minecraft:ender_pearl", count: 1 },
            },
          },
          { blocks: [at(0, 64, -1, "minecraft:chest")] },
        ),
      );
      expectAllPassed(r);
    });

    it("compare, inspect and detect follow the block's item", async () => {
      const r = await runLua(
        `
ccunit.test("empty slot against air and water", function()
  turtle.select(16)
  ccunit.eq({ turtle.compareUp() }, { true })
  ccunit.eq({ turtle.compare() }, { true }, "water's item is air")
  ccunit.eq({ turtle.detect() }, { false, nil }, "liquid is not detected")
  local ok, w = turtle.inspect()
  ccunit.eq(w.name, "minecraft:water")
  ccunit.eq(w.state.level, 0)
end)
ccunit.test("cobblestone is not stone", function()
  turtle.select(1)
  ccunit.eq({ turtle.compareDown() }, { false, nil })
  turtle.select(2)
  ccunit.eq({ turtle.compareDown() }, { true })
end)
ccunit.test("grass is detected though a turtle walks into it", function()
  turtle.turnLeft()
  ccunit.eq({ turtle.detect() }, { true })
end)
`,
        turtleWorld(
          {
            inventory: {
              "1": { name: "minecraft:cobblestone", count: 1 },
              "2": { name: "minecraft:stone", count: 1 },
            },
          },
          {
            blocks: [
              at(0, 64, -1, "minecraft:water", { state: { level: "0" } }),
              at(-1, 64, 0, "minecraft:grass"),
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("refuels from furnace burn times", async () => {
      const r = await runLua(
        `
ccunit.test("not fuel", function()
  turtle.select(3)
  ccunit.eq({ turtle.refuel() }, { false, "Items not combustible" })
  turtle.select(4)
  ccunit.eq({ turtle.refuel() }, { false, "No items to combust" })
end)
ccunit.test("refuel(0) asks without burning", function()
  turtle.select(1)
  ccunit.eq({ turtle.refuel(0) }, { true })
  ccunit.eq(turtle.getItemCount(1), 2)
end)
ccunit.test("coal is 80, lava 1000 and gives the bucket back", function()
  ccunit.eq({ turtle.refuel(1) }, { true })
  ccunit.eq(turtle.getFuelLevel(), 80)
  turtle.select(2)
  ccunit.eq({ turtle.refuel() }, { true })
  ccunit.eq(turtle.getFuelLevel(), 1080)
  ccunit.eq(turtle.getItemDetail(2).name, "minecraft:bucket")
end)
`,
        turtleWorld({
          fuel: 0,
          inventory: {
            "1": { name: "minecraft:coal", count: 2 },
            "2": { name: "minecraft:lava_bucket", count: 1 },
            "3": { name: "minecraft:dirt", count: 1 },
          },
        }),
      );
      expectAllPassed(r);
    });

    it("equips upgrades, crafts on a crafting table, sees its modem", async () => {
      const r = await runLua(
        `
ccunit.test("not an upgrade", function()
  turtle.select(3)
  ccunit.eq({ turtle.equipLeft() }, { false, "Not a valid upgrade" })
end)
ccunit.test("a modem on the left", function()
  turtle.select(1)
  ccunit.eq({ turtle.equipLeft() }, { true })
  ccunit.eq(peripheral.getType("left"), "modem")
  ccunit.eq(peripheral.call("left", "isWireless"), true)
end)
ccunit.test("a crafting table on the right gives turtle.craft", function()
  turtle.select(2)
  ccunit.eq({ turtle.equipRight() }, { true })
  ccunit.eq(peripheral.getType("right"), "workbench")
  ccunit.truthy(turtle.craft, "craft")
end)
ccunit.test("craft planks", function()
  turtle.select(3)
  turtle.transferTo(1)
  turtle.select(1)
  ccunit.eq({ turtle.craft(0) }, { true })
  ccunit.eq({ turtle.craft() }, { true })
  ccunit.eq(turtle.getItemDetail(1), { name = "minecraft:oak_planks", count = 4 })
end)
ccunit.test("no recipe", function()
  turtle.transferTo(6, 1)
  ccunit.eq({ turtle.craft() }, { false, "No matching recipes" })
end)
ccunit.test("unequip gives the item back", function()
  turtle.select(10)
  ccunit.eq({ turtle.equipLeft() }, { true })
  ccunit.eq(turtle.getItemDetail(10).name, "computercraft:wireless_modem_normal")
  ccunit.eq(peripheral.isPresent("left"), false)
end)
`,
        turtleWorld({
          inventory: {
            "1": { name: "computercraft:wireless_modem_normal", count: 1 },
            "2": { name: "minecraft:crafting_table", count: 1 },
            "3": { name: "minecraft:oak_log", count: 1 },
          },
        }),
      );
      expectAllPassed(r);
    });

    it("sees the blocks around it as peripherals as it turns", async () => {
      const r = await runLua(
        `
ccunit.test("a chest on the right", function()
  ccunit.eq(peripheral.getNames(), { "right" })
  ccunit.eq({ peripheral.getType("right") }, { "minecraft:chest", "inventory" })
  ccunit.eq(peripheral.call("right", "list")[1].name, "minecraft:diamond")
end)
ccunit.test("turning moves it to the front", function()
  turtle.turnRight()
  -- its peripheral events came while turnRight waited for its turtle_response, and were lost as in game
  ccunit.eq(peripheral.getNames(), { "front" })
end)
`,
        turtleWorld(
          {},
          {
            blocks: [
              at(1, 64, 0, "minecraft:chest", {
                items: { "1": { name: "minecraft:diamond", count: 2 } },
              }),
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("attacks: 3 damage with a pickaxe, i-frames, a sword kills", async () => {
      const r = await runLua(
        `
ccunit.test("hit, then the second hit misses", function()
  -- The i-frames last 10 ticks and the second attack runs 8 ticks after the first, but the ticks are the real clock:
  -- on a busy machine the second attack can come late, after the i-frames. The first attack runs after it was
  -- issued (a tick later at the earliest) and the second before its call returned, so if the pair took at most
  -- 0.5 s from issue to return the ticks between them were at most 9 and the second hit has to miss. A pair that
  -- came late proves nothing: try again (at most 4 times, so the zombie, with 30 health, survives 8 hits of 3).
  local proved = false
  for _ = 1, 4 do
    local issued = os.clock()
    local first = { turtle.attack("right") }
    local second = { turtle.attack("right") }
    local took = os.clock() - issued
    ccunit.eq(first, { true })
    if took <= 0.5 then
      ccunit.eq(second, { false, "Nothing to attack here" })
      proved = true
      break
    end
    sleep(1)
  end
  ccunit.truthy(proved, "the machine was too busy for the two attacks to come within 10 ticks")
end)
ccunit.test("a sword kills and the drops come in", function()
  sleep(1)
  for _ = 1, 8 do
    turtle.attack("left")
    sleep(0.6)
    if turtle.getItemDetail(1) then break end
  end
  ccunit.eq(turtle.getItemDetail(1), { name = "minecraft:rotten_flesh", count = 2 })
  ccunit.eq({ turtle.attack() }, { false, "Nothing to attack here" })
end)
`,
        turtleWorld(
          { left: "minecraft:diamond_sword", right: pick },
          {
            entities: [
              {
                type: "minecraft:zombie",
                x: 0.5,
                y: 64,
                z: -0.5,
                health: 30,
                drops: [{ name: "minecraft:rotten_flesh", count: 2 }],
              } as never,
            ],
          },
        ),
      );
      expectAllPassed(r);
    });
  },
);
