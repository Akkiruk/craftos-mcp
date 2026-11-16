import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  loadNamedWorld,
  runProgram,
  runTests,
  worldJson,
} from "./index.js";

/**
 * Advanced Peripherals 0.7.31r: geoScanner, blockReader, inventoryManager and the chunky turtle (ccsim/ap/extra.lua).
 * Expected values come from the 1.18.2-0.7.30r source (the 0.7.31r jar has the same methods and strings) and AP's
 * default config: scanBlocks cooldown 2000 ms, free radius 8, max radius 16, 0.17 fuel per extra block.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ap-extra-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/** Lua helpers every test file gets: the bare error message of a call, and a check that a call waited a tick. */
const PRELUDE = `
local function msg(fn, ...)
  local ok, err = pcall(fn, ...)
  if ok then return nil end
  return (tostring(err):gsub("^[^:]*:%d+: ", ""):gsub("^pcall: ", ""))
end
local function waits(fn)
  os.queueEvent("probe")
  fn()
  os.queueEvent("after")
  return os.pullEvent() == "after" -- a main-thread call loses the probe while it waits for the server tick
end
local function has(list, value)
  for _, v in ipairs(list) do if v == value then return true end end
  return false
end
`;

async function lua(source: string, world: WorldConfig): Promise<TestRunResult> {
  counter += 1;
  const name = `apx${counter}.test.lua`;
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

/** Every world here runs without the server mod: that is where these four exist. */
function off(w: WorldConfig): WorldConfig {
  return {
    ...w,
  };
}

const at = (
  x: number,
  y: number,
  z: number,
  name: string,
  more: object = {},
) => ({ x, y, z, name, ...more });

const geoWorld = off({
  blocks: [
    at(1, 64, 0, "minecraft:stone"),
    at(0, 65, 0, "minecraft:dirt"),
    at(0, 63, 0, "minecraft:diamond_ore"),
    at(5, 64, 5, "minecraft:gold_ore"),
  ],
  fills: [
    { from: [2, 10, 2], to: [3, 10, 3], name: "minecraft:iron_ore" },
    { from: [17, 10, 0], to: [18, 10, 0], name: "minecraft:iron_ore" },
  ],
  peripherals: [{ name: "geo", type: "geoScanner", x: 0, y: 64, z: 0 }],
});

describe.skipIf(!ready)(
  "geoScanner",
  { concurrent: true, timeout: 120000 },
  () => {
    it("scans the block world as a cube, x then y then z, relative to the scanner", async () => {
      const r = await lua(
        `
local g = peripheral.wrap("geo")
ccunit.test("surface", function()
  ccunit.eq(peripheral.getType("geo"), "geoScanner")
  ccunit.eq(peripheral.getMethods("geo"), { "chunkAnalyze", "cost", "getConfiguration", "getFuelConsumptionRate",
    "getFuelLevel", "getMaxFuelLevel", "getName", "getOperationCooldown", "scan", "setFuelConsumptionRate" })
  ccunit.eq(g.getName(), "")
  ccunit.eq(g.getConfiguration(), { maxFuelConsumptionRate = 1, scanBlocks = { name = "scanBlocks",
    type = "de.srendi.advancedperipherals.common.addons.computercraft.operations.SphereOperation",
    cooldown = 2000, maxFreeRadius = 8, maxCostRadius = 16, extraBlockCost = 0.17 } })
  ccunit.eq({ g.getFuelLevel(), g.getMaxFuelLevel(), g.getFuelConsumptionRate() }, { 0, 0, 1 })
  ccunit.eq({ g.setFuelConsumptionRate(2) }, { nil, "Too big fuel consumption rate" })
end)
ccunit.test("cost", function()
  ccunit.eq(g.cost(8), 0)
  ccunit.eq(g.cost(9), 330) -- (19^3 - 17^3) * 0.17
  ccunit.eq(g.cost(16), 5274)
  ccunit.eq({ g.cost(17) }, { nil, "Radius is exceed max value" })
  ccunit.eq(msg(g.cost, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq(waits(function() g.cost(1) end), false)
end)
ccunit.test("scan", function()
  local list
  local asked = os.epoch("utc") -- the cooldown starts on the tick the scan runs, no earlier than this
  ccunit.eq(waits(function() list = g.scan(1) end), true)
  local names = {}
  for i, b in ipairs(list) do names[i] = ("%s %d,%d,%d"):format(b.name, b.x, b.y, b.z) end
  ccunit.eq(names, { "minecraft:diamond_ore 0,-1,0", "advancedperipherals:geo_scanner 0,0,0",
    "minecraft:dirt 0,1,0", "minecraft:stone 1,0,0" })
  ccunit.truthy(has(list[4].tags, "minecraft:block/minecraft:mineable/pickaxe"), "stone tags")
  ccunit.truthy(has(list[1].tags, "minecraft:block/forge:ores"), "ore tags")
  -- the cooldown is the operation's, shared with chunkAnalyze
  ccunit.eq({ g.scan(1) }, { nil, "scanBlocks is on cooldown" })
  ccunit.eq({ g.chunkAnalyze() }, { nil, "scanBlocks is on cooldown" })
  local left = g.getOperationCooldown("scanBlocks")
  -- exact on the side load cannot move: never more than 2000, and no less than 2000 minus the time since the scan was asked for
  local since = os.epoch("utc") - asked
  ccunit.truthy(left <= 2000 and left >= 2000 - since, ("cooldown %d, %d ms after the scan was asked for"):format(left, since))
  ccunit.eq({ g.getOperationCooldown("scanEntities") }, { nil, "Cannot find this operation" })
  sleep(2.05)
  ccunit.eq(g.getOperationCooldown("scanBlocks"), 0)
  -- a radius that is too big is refused before the cooldown starts
  ccunit.eq({ g.scan(17) }, { nil, "Radius is exceed max value" })
  ccunit.eq(g.getOperationCooldown("scanBlocks"), 0)
  ccunit.eq(msg(g.scan), "bad argument #1 (number expected, got nil)")
  -- 16 costs fuel, which a block has none of, but powered peripherals are off so it is free
  ccunit.eq(#g.scan(16), 5) -- the iron ore lies 54 below
end)
ccunit.test("chunkAnalyze counts ores in the scanner's chunk", function()
  sleep(2.05)
  ccunit.eq(g.chunkAnalyze(), { ["minecraft:diamond_ore"] = 1, ["minecraft:iron_ore"] = 4, ["minecraft:gold_ore"] = 1 })
end)
`,
        geoWorld,
      );
      expectAllPassed(r);
    });

    it("uses its own blocks without a block world, and sees itself with none at all", async () => {
      const r = await lua(
        `
ccunit.test("fixture blocks", function()
  local list = peripheral.call("own", "scan", 2)
  ccunit.eq(#list, 2)
  ccunit.eq({ list[1].name, list[1].x, list[1].y, list[1].z }, { "advancedperipherals:geo_scanner", 0, 0, 0 })
  ccunit.eq({ list[2].name, list[2].x, list[2].y, list[2].z }, { "minecraft:oak_log", 0, 0, 2 })
  local alone = peripheral.call("bare", "scan", 3)
  ccunit.eq(#alone, 1)
  sleep(2.05) -- chunkAnalyze shares the scan's cooldown
  ccunit.eq(peripheral.call("own", "chunkAnalyze"), {})
  ccunit.eq(peripheral.call("bare", "chunkAnalyze"), {})
end)
`,
        off({
          peripherals: [
            {
              name: "own",
              type: "geoScanner",
              x: 10,
              y: 70,
              z: 10,
              blocks: [at(10, 70, 12, "minecraft:oak_log")],
            },
            { name: "bare", type: "geoScanner" },
          ],
        }),
      );
      expectAllPassed(r);
    });

    it("on a turtle: scans around the turtle and pays in turtle fuel", async () => {
      const r = await lua(
        `
local g = peripheral.wrap("right")
ccunit.test("turtle geo scanner", function()
  ccunit.eq(peripheral.getType("right"), "geoScanner")
  ccunit.eq(g.getName(), nil)
  ccunit.eq({ g.getFuelLevel(), g.getMaxFuelLevel() }, { 100, 20000 })
  ccunit.eq({ g.scan(9) }, { nil, "Not enough fuel for operation" })
  ccunit.eq(g.getOperationCooldown("scanBlocks"), 0)
  local list = g.scan(1)
  ccunit.eq({ list[1].name, list[1].x, list[1].y, list[1].z }, { "minecraft:cobblestone", 0, 0, -1 })
  ccunit.eq({ list[2].name, list[2].z }, { "computercraft:turtle_normal", 0 }) -- the turtle itself
  ccunit.eq(turtle.getFuelLevel(), 100)
end)
ccunit.test("paid scan and moving", function()
  turtle.refuel()
  ccunit.eq(turtle.getFuelLevel(), 100 + 8 * 80)
  sleep(2.05)
  local list = g.scan(9)
  ccunit.eq(turtle.getFuelLevel(), 100 + 8 * 80 - 330)
  ccunit.eq(g.getFuelLevel(), turtle.getFuelLevel())
  turtle.back()
  sleep(2.05)
  list = g.scan(1)
  ccunit.eq({ list[1].name, list[1].z }, { "computercraft:turtle_normal", 0 })
  ccunit.eq(#list, 1) -- the cobblestone is two blocks ahead now
end)
`,
        off({
          turtle: {
            x: 0,
            y: 64,
            z: 0,
            facing: "north",
            fuel: 100,
            right: "advancedperipherals:geo_scanner",
            inventory: { "1": { name: "minecraft:coal", count: 8 } },
          },
          blocks: [at(0, 64, -1, "minecraft:cobblestone")],
        }),
      );
      expectAllPassed(r);
    });

    it("a turtle equips one, and a placed geo scanner block is a peripheral", async () => {
      const r = await lua(
        `
ccunit.test("equip and place", function()
  turtle.select(1)
  ccunit.eq({ turtle.equipLeft() }, { true })
  ccunit.eq(peripheral.getType("left"), "geoScanner")
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(peripheral.getType("front"), "geoScanner")
  local list = peripheral.call("front", "scan", 1)
  ccunit.eq({ list[1].name, list[1].z }, { "advancedperipherals:geo_scanner", 0 })
  ccunit.eq({ list[2].name, list[2].z }, { "computercraft:turtle_normal", 1 })
end)
`,
        off({
          turtle: {
            fuel: 100,
            inventory: {
              "1": { name: "advancedperipherals:geo_scanner", count: 1 },
              "2": { name: "advancedperipherals:geo_scanner", count: 1 },
            },
          },
          turtleConfig: { needFuel: false },
          // the block as the mod's jar has it, for a ROM with only vanilla game data
          gameData: {
            blocks: {
              "advancedperipherals:geo_scanner": {
                orientation: [
                  "down_east",
                  "down_north",
                  "down_south",
                  "down_west",
                  "east_up",
                  "north_up",
                  "south_up",
                  "up_east",
                  "up_north",
                  "up_south",
                  "up_west",
                  "west_up",
                ],
              },
            },
          },
        }),
      );
      expectAllPassed(r);
    });
  },
);

describe.skipIf(!ready)(
  "blockReader",
  { concurrent: true, timeout: 120000 },
  () => {
    it("reads the block in front: name, and its block entity as NBT", async () => {
      const r = await lua(
        `
ccunit.test("reader", function()
  ccunit.eq(peripheral.getMethods("chestReader"), { "getBlockData", "getBlockName", "getConfiguration", "getName" })
  ccunit.eq(peripheral.call("chestReader", "getBlockName"), "minecraft:chest")
  local data
  ccunit.eq(waits(function() data = peripheral.call("chestReader", "getBlockData") end), true)
  ccunit.eq(data, { CustomName = '{"text":"Loot"}', Items = {
    { Slot = 0, id = "minecraft:coal", Count = 16 }, { Slot = 4, id = "minecraft:diamond", Count = 2 } } })
  ccunit.eq(peripheral.call("stoneReader", "getBlockName"), "minecraft:stone")
  ccunit.eq(peripheral.call("stoneReader", "getBlockData"), nil)
  ccunit.eq(peripheral.call("airReader", "getBlockName"), "none")
  ccunit.eq(peripheral.call("airReader", "getBlockData"), nil)
  ccunit.eq(peripheral.call("upReader", "getBlockName"), "minecraft:glass")
  ccunit.eq(peripheral.call("fixtureReader", "getBlockName"), "minecraft:furnace")
  ccunit.eq(peripheral.call("fixtureReader", "getBlockData"), { BurnTime = 20 })
  ccunit.eq(peripheral.call("chestReader", "getConfiguration"), {})
end)
`,
        off({
          blocks: [
            at(0, 64, -1, "minecraft:chest", {
              items: {
                "1": { name: "minecraft:coal", count: 16 },
                "5": { name: "minecraft:diamond", count: 2 },
              },
              blockEntity: { CustomName: '{"text":"Loot"}' },
            }),
            at(11, 64, 0, "minecraft:stone"),
            at(20, 65, 0, "minecraft:glass"),
          ],
          peripherals: [
            { name: "chestReader", type: "blockReader", x: 0, y: 64, z: 0 },
            {
              name: "stoneReader",
              type: "blockReader",
              x: 10,
              y: 64,
              z: 0,
              orientation: "east_up",
            },
            { name: "airReader", type: "blockReader", x: 30, y: 64, z: 0 },
            {
              name: "upReader",
              type: "blockReader",
              x: 20,
              y: 64,
              z: 0,
              orientation: { front: "up", top: "north" },
            },
            {
              name: "fixtureReader",
              type: "blockReader",
              block: {
                name: "minecraft:furnace",
                blockEntity: { BurnTime: 20 },
              },
            },
          ],
        }),
      );
      expectAllPassed(r);
    });

    it("in a turtle world: a reader block sees what the turtle put in front of it", async () => {
      const r = await lua(
        `
ccunit.test("turtle world reader", function()
  ccunit.eq(peripheral.getType("front"), "blockReader")
  ccunit.eq(peripheral.call("front", "getBlockName"), "none")
  turtle.up()
  ccunit.eq({ turtle.place() }, { true })
  turtle.down()
  ccunit.eq(peripheral.call("front", "getBlockName"), "minecraft:oak_planks")
end)
`,
        off({
          turtle: {
            fuel: 100,
            inventory: { "1": { name: "minecraft:oak_planks", count: 4 } },
          },
          // the reader in front of the turtle faces up (orientation up_north): it reads 0,65,-1
          blocks: [
            at(0, 64, -1, "advancedperipherals:block_reader", {
              state: { orientation: "up_north" },
            }),
          ],
        }),
      );
      expectAllPassed(r);
    });
  },
);

const inventoryWorld = off({
  players: [
    { name: "Alice", x: 0, y: 64, z: 0 },
    { name: "Bob", online: false },
  ],
  ap: {
    players: {
      Alice: {
        inventory: {
          "0": { name: "minecraft:diamond_sword", count: 1 },
          "1": { name: "minecraft:cobblestone", count: 40 },
          "3": { name: "minecraft:cobblestone", count: 64 },
        },
        armor: {
          head: { name: "minecraft:iron_helmet" },
          feet: { name: "minecraft:carved_pumpkin" },
        },
        offhand: { name: "minecraft:torch", count: 10 },
        selected: 1,
      },
    },
  },
  peripherals: [
    {
      name: "chest",
      type: "minecraft:chest",
      size: 27,
      items: { "1": { name: "minecraft:dirt", count: 5 } },
    },
    {
      name: "im",
      type: "inventoryManager",
      owner: "Alice",
      adjacent: { up: "chest" },
    },
    { name: "bobs", type: "inventoryManager", owner: "Bob" },
    { name: "empty", type: "inventoryManager" },
  ],
});

describe.skipIf(!ready)(
  "inventoryManager",
  { concurrent: true, timeout: 120000 },
  () => {
    it("reads the owner's inventory and armour", async () => {
      const r = await lua(
        `
local im = peripheral.wrap("im")
ccunit.test("surface", function()
  ccunit.eq(peripheral.getMethods("im"), { "addItemToPlayer", "addItemToPlayerNBT", "getArmor", "getConfiguration",
    "getEmptySpace", "getFreeSlot", "getItemInHand", "getItemInOffHand", "getItems", "getItemsChest", "getName",
    "getOwner", "isPlayerEquipped", "isSpaceAvailable", "isWearing", "list", "listChest", "pullItems", "pushItems",
    "removeItemFromPlayer", "removeItemFromPlayerNBT" })
  ccunit.eq(waits(function() im.getOwner() end), false)
  ccunit.eq(waits(function() im.getItems() end), true)
  ccunit.eq(im.getOwner(), "Alice")
  ccunit.eq(peripheral.call("bobs", "getOwner"), nil) -- offline
  ccunit.eq(peripheral.call("empty", "getOwner"), nil)
  local noCard = "The Inventory Manager doesn't have a memory card or it isn't bound to a player."
  ccunit.eq(msg(peripheral.call, "bobs", "getItems"), noCard)
  ccunit.eq(msg(peripheral.call, "empty", "getArmor"), noCard)
end)
ccunit.test("items", function()
  local items = im.getItems()
  ccunit.eq(#items, 3)
  ccunit.eq(items[1].slot, 0)
  ccunit.eq(items[1].name, "minecraft:diamond_sword")
  ccunit.eq(items[1].maxStackSize, 1)
  ccunit.eq(items[1].nbt, {})
  ccunit.eq(items[2].displayName, "[Cobblestone]")
  ccunit.eq({ items[2].slot, items[2].count, items[3].slot }, { 1, 40, 3 })
  ccunit.truthy(has(items[2].tags, "minecraft:item/forge:cobblestone"), "item tags")
  ccunit.eq(im.list(), items)
  ccunit.eq(im.getEmptySpace(), 33)
  ccunit.eq(im.isSpaceAvailable(), true)
  ccunit.eq(im.getFreeSlot(), 2)
  ccunit.eq(im.getItemInHand().name, "minecraft:cobblestone")
  ccunit.eq(im.getItemInHand().slot, nil)
  ccunit.eq(im.getItemInOffHand().count, 10)
end)
ccunit.test("armour", function()
  local armor = im.getArmor()
  ccunit.eq(#armor, 2)
  ccunit.eq({ armor[1].name, armor[1].slot }, { "minecraft:carved_pumpkin", 0 }) -- not an ArmorItem
  ccunit.eq({ armor[2].name, armor[2].slot }, { "minecraft:iron_helmet", 103 })
  ccunit.eq(im.isPlayerEquipped(), true)
  -- isWearing compares index with (worn pieces counted from 0) - 100
  ccunit.eq({ im.isWearing(103), im.isWearing(0), im.isWearing(-100), im.isWearing(-99), im.isWearing(-98) },
    { false, false, true, true, false })
end)
ccunit.test("chest listing", function()
  local chest = im.listChest("up")
  ccunit.eq(#chest, 1)
  ccunit.eq({ chest[1].name, chest[1].slot, chest[1].count, chest[1].displayName }, { "minecraft:dirt", 0, 5, "[Dirt]" })
  ccunit.eq(im.getItemsChest("up"), chest)
  ccunit.eq({ im.listChest("down") }, { nil, "INVENTORY_TO_INVALID" })
  ccunit.eq(msg(im.listChest, "sideways"), "SIDEWAYS is not a valid side")
end)
`,
        inventoryWorld,
      );
      expectAllPassed(r);
    });

    it("moves items between the player and the chest", async () => {
      const r = await lua(
        `
local im = peripheral.wrap("im")
local function chest(slot) return peripheral.call("chest", "getItemDetail", slot) end
ccunit.test("push: player to chest", function()
  -- every player slot in order: 40 from slot 1, then 10 of slot 3
  ccunit.eq(im.removeItemFromPlayer("up", 50, nil, "minecraft:cobblestone"), 50)
  ccunit.eq(chest(2).count, 50)
  local items = im.getItems()
  ccunit.eq({ items[2].slot, items[2].count }, { 3, 54 })
  -- the deprecated slot is the chest's (0-based); pushItems is the same method
  ccunit.eq(im.pushItems("up", 4, 9, "minecraft:cobblestone"), 4)
  ccunit.eq(chest(10).count, 4)
  -- an empty filter takes anything, armour included
  ccunit.eq(im.removeItemFromPlayerNBT("up", 1, nil, { fromSlot = 103 }), 1)
  ccunit.eq(#im.getArmor(), 1)
  ccunit.eq(chest(3).name, "minecraft:iron_helmet")
  ccunit.eq(im.removeItemFromPlayerNBT("up", 5, nil, { fromSlot = 36 }), 5)
  ccunit.eq(im.getItemInOffHand().count, 5)
  ccunit.eq({ im.removeItemFromPlayer("down", 1) }, { 0, "INVENTORY_TO_INVALID" })
end)
ccunit.test("pull: chest to player", function()
  -- into the first slot that takes it: slot 1 is empty now
  ccunit.eq(im.addItemToPlayer("up", 3, nil, "minecraft:dirt"), 3)
  ccunit.eq(im.getItems()[2].name, "minecraft:dirt")
  ccunit.eq(im.addItemToPlayerNBT("up", 1, 103, { name = "minecraft:iron_helmet" }), 1)
  ccunit.eq(im.getArmor()[2].slot, 103)
  -- the armour slot only takes what fits it
  ccunit.eq(im.addItemToPlayerNBT("up", 64, 100, { name = "minecraft:cobblestone" }), 0)
  -- the item's own count wins over the count argument
  ccunit.eq(im.pullItems("up", 64, nil, "minecraft:cobblestone"), 54)
  ccunit.eq(im.addItemToPlayerNBT("up", 64, nil, { name = "minecraft:dirt", count = 1 }), 1)
end)
ccunit.test("filter errors and Java exceptions", function()
  ccunit.eq({ im.addItemToPlayer("up", 1, nil, "minecraft:not_an_item") }, { 0, "ITEM_NOT_FOUND" })
  ccunit.eq({ im.addItemToPlayerNBT("up", 1, nil, { name = 5 }) }, { 0, "NO_VALID_ITEM" })
  ccunit.eq({ im.addItemToPlayerNBT("up", 1, nil, { count = "x" }) }, { 0, "NO_VALID_COUNT" })
  ccunit.eq({ im.removeItemFromPlayerNBT("up", 1, nil, { fingerprint = 1 }) }, { 0, "NO_VALID_FINGERPRINT" })
  ccunit.eq(msg(im.addItemToPlayerNBT, "up", 1, nil, "dirt"), "bad argument #4 (table expected, got string)")
  ccunit.eq(msg(im.pushItems, "up"), "bad argument #2 (number expected, got nil)")
  ccunit.eq(msg(im.pushItems, "nowhere", 1), "NOWHERE is not a valid side")
  ccunit.eq(msg(im.pushItems, "up", 1, 30, "minecraft:cobblestone"),
    "Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index 30 out of bounds for length 27")
end)
ccunit.test("fingerprints and tags", function()
  ccunit.eq(im.removeItemFromPlayerNBT("up", 2, nil, { name = "#forge:cobblestone" }), 2)
  ccunit.eq(im.removeItemFromPlayerNBT("up", 2, nil, { fingerprint = "0123" }), 0)
  -- an NBT filter that is not valid SNBT is no filter at all; a non-empty table never parses either
  ccunit.eq(im.removeItemFromPlayerNBT("up", 1, nil, { name = "minecraft:diamond_sword", nbt = "{oops" }), 1)
end)
`,
        inventoryWorld,
      );
      expectAllPassed(r);
    });

    it("sim commands, state and a block-world chest", async () => {
      put(
        "inv.lua",
        `
local SIM = function(cmd) os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON(cmd)) sleep(0.1) end
SIM({ cmd = "setPlayerItem", player = "Alice", slot = 5, item = { name = "minecraft:apple", count = 3 } })
SIM({ cmd = "setPlayerItem", player = "Alice", selected = 5 })
assert(peripheral.call("im", "getItemInHand").name == "minecraft:apple")
SIM({ cmd = "setMemoryCard", peripheral = "im", owner = "Nobody" })
assert(peripheral.call("im", "getOwner") == nil)
SIM({ cmd = "setMemoryCard", peripheral = "im", owner = "Alice" })
assert(peripheral.call("im", "pushItems", "up", 2, nil, "minecraft:apple") == 2)
`,
      );
      const r = await runProgram(config, {
        program: "inv.lua",
        world: off({
          players: [{ name: "Alice" }],
          blocks: [at(0, 65, 0, "minecraft:barrel", { size: 27 })],
          peripherals: [
            { name: "im", type: "inventoryManager", owner: "Alice" },
          ],
        }),
        timeoutMs: 60000,
      });
      expect(r.status).toBe("completed");
      const state = r.sim?.peripherals?.["im"] as {
        owner: string;
        player: {
          inventory: Record<string, { name: string; count: number }>;
          selected: number;
        };
      };
      expect(state.owner).toBe("Alice");
      expect(state.player.selected).toBe(5);
      expect(state.player.inventory["5"]).toMatchObject({
        name: "minecraft:apple",
        count: 1,
      });
    });
  },
);

describe.skipIf(!ready)(
  "chunky turtle",
  { concurrent: true, timeout: 120000 },
  () => {
    const chunkWorld = (left?: string) =>
      off({
        turtle: {
          x: 14,
          y: 64,
          z: 0,
          facing: "east",
          fuel: 100,
          left,
          inventory: {
            "1": { name: "advancedperipherals:chunk_controller", count: 1 },
          },
        },
        loadedChunks: [[0, 0]],
      });

    it("without one the turtle stops at the loaded chunk's edge", async () => {
      const r = await lua(
        `
ccunit.test("edge", function()
  ccunit.eq({ turtle.forward() }, { true })
  ccunit.eq({ turtle.forward() }, { false, "Cannot leave loaded world" })
end)
`,
        chunkWorld(),
      );
      expectAllPassed(r);
    });

    it("with one its chunk and two around it stay loaded wherever it goes", async () => {
      const r = await lua(
        `
ccunit.test("chunky", function()
  ccunit.eq(peripheral.getType("left"), "chunky")
  ccunit.eq(peripheral.getMethods("left"), { "getConfiguration", "getName" })
  ccunit.eq(peripheral.call("left", "getName"), nil)
  ccunit.eq(peripheral.call("left", "getConfiguration"), {})
  for i = 1, 40 do ccunit.eq({ turtle.forward() }, { true }, "step " .. i) end
  -- unequipped (into the empty slot 2), the force goes: the turtle is in chunk 3 now, far from chunk 0
  turtle.select(2)
  ccunit.eq({ turtle.equipLeft() }, { true })
  ccunit.eq(turtle.getItemDetail(2).name, "advancedperipherals:chunk_controller")
  ccunit.eq({ turtle.forward() }, { false, "Cannot leave loaded world" })
  ccunit.eq({ turtle.equipLeft() }, { true })
  ccunit.eq(peripheral.getType("left"), "chunky")
  ccunit.eq({ turtle.forward() }, { true })
end)
`,
        chunkWorld("advancedperipherals:chunk_controller"),
      );
      expectAllPassed(r);
    });

    it("reports the chunk it keeps loaded", async () => {
      put("chunky.lua", `turtle.forward() turtle.forward() turtle.forward()`);
      const r = await runProgram(config, {
        program: "chunky.lua",
        world: chunkWorld("advancedperipherals:chunk_controller"),
        timeoutMs: 60000,
      });
      expect(r.status).toBe("completed");
      expect(r.sim?.peripherals?.["left"]).toEqual({
        loadedChunk: { x: 1, z: 0, dimension: "minecraft:overworld" },
      });
    });
  },
);

describe.skipIf(!ready)(
  "addon off and demo",
  { concurrent: true, timeout: 120000 },
  () => {
    it("a world with the addon off refuses these peripherals", () => {
      expect(() => worldJson({ ...geoWorld, addons: "none" })).toThrow(
        /peripheral "geo" is a geoScanner from Advanced Peripherals \(addon "advanced-peripherals"\)/,
      );
      expect(() =>
        worldJson({ addons: "none", ap: { players: { Alice: {} } } }),
      ).toThrow(/world.ap configures Advanced Peripherals/);
      expect(() =>
        worldJson({ addons: ["advanced-peripherals"], ...inventoryWorld }),
      ).not.toThrow();
    });

    it("the demo world has all four and they answer", async () => {
      const r = await lua(
        `
ccunit.test("demo", function()
  local t0 = os.epoch("utc")
  ccunit.eq(#peripheral.call("geo", "scan", 16), 33 * 33 * 16 + 6) -- the ground, four blocks, the turtle, itself
  print("scan(16) took " .. (os.epoch("utc") - t0) .. " ms")
  ccunit.eq(peripheral.call("reader", "getBlockName"), "minecraft:chest")
  ccunit.eq(peripheral.call("inv", "getOwner"), "Alice")
  ccunit.eq(peripheral.call("inv", "listChest", "up")[1].name, "minecraft:oak_log")
  ccunit.eq(peripheral.call("inv", "getArmor")[1].slot, 103)
  ccunit.eq(peripheral.getType("left"), "chunky")
  ccunit.eq(peripheral.getType("right"), "geoScanner")
  ccunit.eq(peripheral.call("right", "chunkAnalyze"), { ["minecraft:diamond_ore"] = 1, ["minecraft:iron_ore"] = 4 })
  ccunit.eq(peripheral.getType("back"), "blockReader")
  ccunit.eq(peripheral.call("back", "getBlockName"), "minecraft:furnace") -- it faces east
  ccunit.eq(peripheral.call("back", "getBlockData").Items, {})
  ccunit.eq({ turtle.back() }, { false, "Movement obstructed" })
end)
`,
        off(loadNamedWorld(config.worldsDir, "ap-extra-demo")),
      );
      expectAllPassed(r);
    });
  },
);
