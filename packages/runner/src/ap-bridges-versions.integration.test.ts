import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

/**
 * The ME bridge and the RS bridge of Advanced Peripherals on each Minecraft version (rom-overlay/rom/ccsim/ap/
 * bridges.lua, bridges121.lua): 1.18.2 runs 0.7.31r, 1.20.1 0.7.48r and 1.21.1 0.7.62b. The method lists are every
 * @LuaFunction of MeBridgePeripheral / RsBridgePeripheral (MEBridgePeripheral / RSBridgePeripheral in 0.7.62b) as
 * javap reads them from the three jars on Modrinth; behaviour follows the sources at the 1.18.2-0.7.30r,
 * 1.20.1-0.7.48r and 1.21.1-0.7.62b tags. World types stay meBridge / rsBridge here: the 1.21.1 names (me_bridge,
 * rs_bridge) are the shared version plumbing's job.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ap-bridges-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Version = "1.18.2" | "1.20.1" | "1.21.1";
const VERSIONS: Version[] = ["1.18.2", "1.20.1", "1.21.1"];

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function onVersion(world: WorldConfig, version: Version): WorldConfig {
  return {
    ...world,
    version,
    ...(version === "1.18.2" ? {} : { vhcctweaks: false }),
  } as WorldConfig;
}

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  // SIM queues a sim command (craftos_sim_command) without waiting, so no event of the bridge is thrown away
  put(
    name,
    `local SIM = function(cmd) os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON(cmd)) end\n` +
      source,
  );
  return runTests(config, { paths: [name], world, timeoutMs: 25000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

function luaList(names: string[]): string {
  return `{ ${names.map((n) => JSON.stringify(n)).join(", ")} }`;
}

// ----- the jars' @LuaFunction names -----

const ME_1182 = [
  "craftFluid", "craftItem", "exportFluid", "exportFluidToPeripheral", "exportItem", "exportItemToPeripheral",
  "getAvailableFluidStorage", "getAvailableItemStorage", "getAvgPowerInjection", "getAvgPowerUsage",
  "getCraftingCPUs", "getEnergyStorage", "getEnergyUsage", "getItem", "getMaxEnergyStorage", "getTotalFluidStorage",
  "getTotalItemStorage", "getUsedFluidStorage", "getUsedItemStorage", "importFluid", "importFluidFromPeripheral",
  "importItem", "importItemFromPeripheral", "isConnected", "isItemCraftable", "isItemCrafting", "listCells",
  "listCraftableFluid", "listCraftableItems", "listFluid", "listItems",
]; // prettier-ignore
const ME_1201 = [...ME_1182, "isFluidCraftable", "isFluidCrafting", "listGas"];
const RS_1182 = [
  "craftFluid", "craftItem", "exportFluid", "exportFluidToPeripheral", "exportItem", "exportItemToPeripheral",
  "getEnergyStorage", "getEnergyUsage", "getItem", "getMaxEnergyStorage", "getMaxFluidDiskStorage",
  "getMaxFluidExternalStorage", "getMaxItemDiskStorage", "getMaxItemExternalStorage", "getPattern", "importFluid",
  "importFluidFromPeripheral", "importItem", "importItemFromPeripheral", "isConnected", "isItemCraftable",
  "isItemCrafting", "listCraftableFluids", "listCraftableItems", "listFluids", "listItems",
]; // prettier-ignore
const STORAGE_1211 = [
  "cancelCraftingTasks", "craftFluid", "craftItem", "exportChemical", "exportFluid", "exportItem",
  "getAvailableChemicalStorage", "getAvailableExternalChemicalStorage", "getAvailableExternalFluidStorage",
  "getAvailableExternalItemStorage", "getAvailableFluidStorage", "getAvailableItemStorage", "getAverageEnergyInput",
  "getCells", "getChemical", "getChemicals", "getCraftableFluids", "getCraftableItems", "getCraftingTask",
  "getCraftingTasks", "getDrives", "getEnergyCapacity", "getEnergyUsage", "getFluid", "getFluids", "getItem",
  "getItems", "getPatterns", "getStoredEnergy", "getTotalChemicalStorage", "getTotalExternalChemicalStorage",
  "getTotalExternalFluidStorage", "getTotalExternalItemStorage", "getTotalFluidStorage", "getTotalItemStorage",
  "getUsedChemicalStorage", "getUsedExternalChemicalStorage", "getUsedExternalFluidStorage",
  "getUsedExternalItemStorage", "getUsedFluidStorage", "getUsedItemStorage", "importChemical", "importFluid",
  "importItem", "isConnected", "isCraftable", "isCrafting", "isOnline",
]; // prettier-ignore
const ME_1211 = [...STORAGE_1211, "getCraftingCPUs"];
const RS_1211 = [...STORAGE_1211, "craftChemical", "getCraftableChemicals"];

const SURFACE: Record<Version, { me: string[]; rs: string[] }> = {
  "1.18.2": { me: ME_1182, rs: RS_1182 },
  "1.20.1": { me: ME_1201, rs: RS_1182 },
  "1.21.1": { me: ME_1211, rs: RS_1211 },
};

// ----- one fixture for every version -----

const meDef = {
  name: "me",
  type: "meBridge",
  items: [
    { name: "minecraft:iron_ingot", amount: 500 },
    { name: "minecraft:diamond", amount: 12, craftable: true },
    {
      name: "minecraft:gold_ingot",
      amount: 64,
      tags: ["minecraft:item/forge:ingots/gold"],
    },
  ],
  fluids: [{ name: "minecraft:water", amount: 8000 }],
  craftableItems: [{ name: "minecraft:piston" }],
  craftableFluids: [{ name: "minecraft:lava" }],
  energy: { stored: 4000, max: 10000, usage: 12.5, injection: 20 },
  cells: [
    {
      item: "ae2:item_storage_cell_4k",
      cellType: "item",
      bytesPerType: 8,
      totalBytes: 4096,
    },
    {
      item: "ae2:fluid_storage_cell_1k",
      cellType: "fluid",
      bytesPerType: 8,
      totalBytes: 1024,
    },
  ],
  cpus: [{ name: "cpu1", storage: 1024, coProcessors: 2, isBusy: false }],
  adjacent: { top: "chest" },
};

const rsDef = {
  name: "rs",
  type: "rsBridge",
  items: [
    { name: "minecraft:iron_ingot", amount: 300 },
    { name: "minecraft:stick", amount: 10, nbt: { Damage: 0 } },
  ],
  fluids: [{ name: "minecraft:lava", amount: 2000 }],
  craftableItems: [{ name: "minecraft:iron_pickaxe" }],
  energy: { stored: 900, max: 1000, usage: 4 },
  storage: {
    maxItemDisk: 32000,
    maxFluidDisk: 64000,
    maxItemExternal: -1,
    maxFluidExternal: 0,
  },
  patterns: [
    {
      outputs: [{ name: "minecraft:iron_pickaxe", count: 1 }],
      inputs: [
        [{ name: "minecraft:iron_ingot", count: 3 }],
        [{ name: "minecraft:stick", count: 2 }],
      ],
      processing: false,
    },
  ],
  adjacent: { top: "chest" },
};

const world: WorldConfig = {
  peripherals: [
    meDef as never,
    rsDef as never,
    { name: "chest", type: "minecraft:chest", size: 9 },
    { name: "tank", type: "fluid_storage", capacity: 4000 } as never,
  ],
};

describe.skipIf(!ready)("ME and RS bridge API per Minecraft version", () => {
  for (const version of VERSIONS) {
    it(`${version} has exactly the jar's methods`, async () => {
      const me = [...SURFACE[version].me, "getName", "getConfiguration"];
      const rs = [...SURFACE[version].rs, "getName", "getConfiguration"];
      me.sort();
      rs.sort();
      const result = await lua(
        `
ccunit.test("ME bridge surface", function()
  ccunit.eq(peripheral.getMethods("me"), ${luaList(me)})
end)
ccunit.test("RS bridge surface", function()
  ccunit.eq(peripheral.getMethods("rs"), ${luaList(rs)})
end)
ccunit.test("ME craftItem/craftFluid are the only calls that do not wait for a tick", function()
  local b = peripheral.wrap("me")
  local timer = os.startTimer(0)
  b.craftItem({ name = "minecraft:piston", count = 1 })
  local _, id = os.pullEvent("timer")
  ccunit.eq(id, timer) -- a server-thread call would have dropped this timer while it waited
end)
`,
        onVersion(world, version),
        `surface-${version}.test.lua`,
      );
      expectAllPassed(result);
    }, 60000);
  }

  for (const version of VERSIONS) {
    it(`${version} moves items to and from a chest the same way`, async () => {
      // the same network move with each version's method names
      const v21 = version === "1.21.1";
      const result = await lua(
        `
local V21 = ${v21}
local function amount(b, name)
  if V21 then return b.getItem({ name = name }).count end
  return b.getItem({ name = name }).amount
end

ccunit.test("ME export and import", function()
  local b = peripheral.wrap("me")
  local chest = peripheral.wrap("chest")
  ccunit.eq(b.exportItem({ name = "minecraft:iron_ingot", count = 100 }, "top"), 100)
  ccunit.eq(chest.list()[1].count, 64)
  ccunit.eq(amount(b, "minecraft:iron_ingot"), 400)
  ccunit.eq(b.importItem({ name = "minecraft:iron_ingot", count = 50 }, "top"), 50)
  ccunit.eq(amount(b, "minecraft:iron_ingot"), 450)
  if V21 then
    -- 0.7.62b takes a peripheral name in the same argument
    ccunit.eq(b.exportItem({ name = "minecraft:diamond", count = 5 }, "chest"), 5)
    ccunit.eq(b.importItem({ name = "minecraft:diamond" }, "chest"), 5)
  else
    ccunit.eq(b.exportItemToPeripheral({ name = "minecraft:diamond", count = 5 }, "chest"), 5)
    ccunit.eq(b.importItemFromPeripheral({ name = "minecraft:diamond" }, "chest"), 5)
  end
end)

ccunit.test("RS export", function()
  local r = peripheral.wrap("rs")
  if V21 then
    ccunit.eq(r.exportItem({ name = "minecraft:iron_ingot", count = 10 }, "chest"), 10)
  else
    ccunit.eq(r.exportItemToPeripheral({ name = "minecraft:iron_ingot", count = 10 }, "chest"), 10)
  end
  ccunit.eq(amount(r, "minecraft:iron_ingot"), 290)
end)

ccunit.test("ME fluids", function()
  local b = peripheral.wrap("me")
  local tank = peripheral.wrap("tank")
  if V21 then
    ccunit.eq(b.exportFluid({ name = "minecraft:water", amount = 3000 }, "tank"), 3000)
    ccunit.eq(b.getFluids()[1].count, 5000)
  else
    ccunit.eq(b.exportFluidToPeripheral({ name = "minecraft:water", count = 3000 }, "tank"), 3000)
    ccunit.eq(b.listFluid()[1].amount, 5000)
  end
  ccunit.eq(tank.tanks()[1].amount, 3000)
end)
`,
        onVersion(world, version),
        `move-${version}.test.lua`,
      );
      expectAllPassed(result);
    }, 60000);
  }

  it("1.20.1 follows 0.7.48r's changes", async () => {
    const result = await lua(
      `
ccunit.test("ME: NOT_FOUND, every craftable, fluid shapes", function()
  local b = peripheral.wrap("me")
  ccunit.eq({ b.getItem({ name = "minecraft:nothing_here" }) }, { nil, "NOT_FOUND" })
  local names = {}
  for _, e in ipairs(b.listCraftableItems()) do names[#names + 1] = e.name .. ":" .. e.amount end
  table.sort(names)
  ccunit.eq(names, { "minecraft:diamond:12", "minecraft:piston:0" })
  local craftableFluids = b.listCraftableFluid()
  ccunit.eq(#craftableFluids, 1)
  ccunit.eq(craftableFluids[1].name, "minecraft:lava")
  ccunit.eq(craftableFluids[1].amount, 0)
  local water = b.listFluid()[1]
  ccunit.eq(water.name, "minecraft:water")
  ccunit.eq(water.fingerprint, nil)
  ccunit.eq(water.nbt, nil)
  ccunit.eq(water.tags, {})
  ccunit.eq(b.getItem({ name = "minecraft:diamond" }).nbt, { id = "minecraft:diamond" })
end)

ccunit.test("ME: fluid crafting methods and listGas", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.isFluidCraftable({ name = "minecraft:lava" }), true)
  ccunit.eq(b.isFluidCraftable({ name = "minecraft:water" }), false)
  ccunit.eq({ b.isFluidCraftable({}) }, { false, "EMPTY_FILTER" })
  ccunit.eq({ b.isFluidCraftable({ name = "bad name!" }) }, { false, "FLUID_NOT_FOUND" })
  ccunit.eq(b.isFluidCrafting({ name = "minecraft:lava" }), false)
  ccunit.eq(b.craftFluid({ name = "minecraft:lava" }), true)
  ccunit.eq(b.isFluidCrafting({ name = "minecraft:lava" }), true)
  ccunit.eq(b.listGas(), {}) -- no Applied Mekanistics
end)

ccunit.test("ME: CPU name and selection mode", function()
  local cpu = peripheral.wrap("me").getCraftingCPUs()[1]
  ccunit.eq(cpu.name, "cpu1")
  ccunit.eq(cpu.selectionMode, "ANY")
end)

ccunit.test("ME: a missing target is reported, not thrown", function()
  local b = peripheral.wrap("me")
  ccunit.eq({ b.exportItem({ name = "minecraft:diamond" }, "left") }, { 0, "Target Inventory does not exist" })
  ccunit.eq({ b.exportFluid({ name = "minecraft:water" }, "left") }, { 0, "Target Tank does not exist" })
  local _, message = b.exportItemToPeripheral({ name = "minecraft:diamond" }, "nowhere")
  ccunit.truthy(message:find("^The target inventory does not exist"))
  local _, tankMessage = b.importFluidFromPeripheral({ name = "minecraft:water" }, "nowhere")
  ccunit.truthy(tankMessage:find("^The target tank does not exist"))
  ccunit.raises(function() b.exportItem({ name = "minecraft:diamond" }, "SIDEWAYS") end, "sideways is not a valid side")
end)

ccunit.test("ME: an empty filter matches everything", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.exportItem({ count = 3 }, "top"), 3)
  ccunit.eq(peripheral.wrap("chest").list()[1].name, "minecraft:iron_ingot")
end)

ccunit.test("ME: craftItem runs on the computer thread", function()
  local b = peripheral.wrap("me")
  local timer = os.startTimer(0)
  ccunit.eq(b.craftItem({ name = "minecraft:piston" }), true)
  local event, id = os.pullEvent("timer")
  ccunit.eq(id, timer) -- a server-thread call would have thrown this timer away
end)

ccunit.test("RS: NOT_FOUND, the crafting manager and fluid shapes", function()
  local r = peripheral.wrap("rs")
  ccunit.eq({ r.getItem({ name = "minecraft:nothing_here" }) }, { nil, "NOT_FOUND" })
  -- 0.7.48r hands isItemCrafting the crafting manager, so an unstocked craftable is found
  ccunit.eq(r.isItemCrafting({ name = "minecraft:iron_pickaxe" }), false)
  ccunit.eq(r.craftItem({ name = "minecraft:iron_pickaxe" }), true)
  ccunit.eq(r.isItemCrafting({ name = "minecraft:iron_pickaxe" }), true)
  local lava = r.listFluids()[1]
  ccunit.eq(lava.fingerprint, nil)
  ccunit.eq(lava.nbt, nil)
  ccunit.eq({ r.exportItem({ name = "minecraft:iron_ingot" }, "left") }, { 0, "INVALID_TARGET" })
end)
`,
      onVersion(world, "1.20.1"),
      "v20.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("1.21.1 ME bridge follows 0.7.62b", async () => {
    const result = await lua(
      `
ccunit.test("stacks are LuaConverter objects", function()
  local b = peripheral.wrap("me")
  local d = b.getItem({ name = "minecraft:diamond" })
  ccunit.eq(d.name, "minecraft:diamond")
  ccunit.eq(d.count, 12)
  ccunit.eq(d.amount, nil)
  ccunit.eq(d.displayName, "Diamond")
  ccunit.eq(d.maxStackSize, 64)
  ccunit.eq(d.components, {})
  ccunit.eq(d.isCraftable, true)
  ccunit.eq(type(d.fingerprint), "string")
  ccunit.eq(d.nbt, nil)
  local piston = b.getItem({ name = "minecraft:piston" })
  ccunit.eq(piston.count, 0) -- craftable, not stored
  ccunit.eq(b.getItem({ name = "minecraft:nothing_here" }), nil)
  ccunit.eq({ b.getItem({}) }, { nil, "EMPTY_FILTER" })
  ccunit.eq({ b.getItem({ name = "bad name!" }) }, { nil, "ITEM_NOT_FOUND" })
  ccunit.raises(function() b.getItem({ name = 5 }) end, "bad field 'name' %(string expected, got number%)")
  ccunit.raises(function() b.getItem({ name = "minecraft:diamond", count = "x" }) end,
    "bad field 'count' %(number expected, got string%)")
  local water = b.getFluid({ name = "minecraft:water" })
  ccunit.eq(water.count, 8000)
  ccunit.eq(water.fluidType.density, 1000)
  ccunit.eq(water.fluidType.canExtinguish, true)
  ccunit.eq(water.maxStackSize, nil)
end)

ccunit.test("lists take an optional filter", function()
  local b = peripheral.wrap("me")
  ccunit.eq(#b.getItems(), 3)
  ccunit.eq(#b.getItems({ name = "#forge:ingots/gold" }), 1)
  ccunit.eq(#b.getFluids(), 1)
  local names = {}
  for _, e in ipairs(b.getCraftableItems()) do names[#names + 1] = e.name .. ":" .. e.count end
  table.sort(names)
  ccunit.eq(names, { "minecraft:diamond:12", "minecraft:piston:0" })
  ccunit.eq(b.getCraftableFluids()[1].name, "minecraft:lava")
  ccunit.raises(function() b.getItems("x") end, "bad argument #1 %(table expected, got string%)")
end)

ccunit.test("chemicals need Applied Mekanistics", function()
  local b = peripheral.wrap("me")
  ccunit.eq({ b.getChemicals() }, { nil, "ADDON_NOT_LOADED_APP_MEKANISTICS" })
  ccunit.eq({ b.importChemical({ name = "mekanism:hydrogen" }, "top") }, { nil, "ADDON_NOT_LOADED_APP_MEKANISTICS" })
  ccunit.eq(b.getTotalChemicalStorage(), 0)
end)

ccunit.test("energy, cells, drives and storage", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.isConnected(), true)
  ccunit.eq(b.isOnline(), true)
  ccunit.eq(b.getStoredEnergy(), 4000)
  ccunit.eq(b.getEnergyCapacity(), 10000)
  ccunit.eq(b.getEnergyUsage(), 12.5)
  ccunit.eq(b.getAverageEnergyInput(), 20)
  ccunit.eq(b.getTotalItemStorage(), 4096)
  ccunit.eq(b.getUsedItemStorage(), 72 + 24)
  ccunit.eq(b.getAvailableItemStorage(), 4096 - 96)
  ccunit.eq(b.getTotalExternalItemStorage(), 0)
  local cells = b.getCells()
  ccunit.eq(#cells, 2)
  ccunit.eq(cells[1].type, "ae2:i")
  ccunit.eq(cells[1].bytes, 4096)
  ccunit.eq(cells[1].item.name, "ae2:item_storage_cell_4k")
  ccunit.eq(cells[2].type, "ae2:f")
  local drives = b.getDrives()
  ccunit.eq(#drives, 1)
  ccunit.eq(drives[1].totalBytes, 5120)
  ccunit.eq(#drives[1].cells, 2)
  local cpu = b.getCraftingCPUs()[1]
  ccunit.eq(cpu.name, "cpu1")
  ccunit.eq(cpu.isBusy, false)
end)

ccunit.test("transfers name a side or a peripheral", function()
  local b = peripheral.wrap("me")
  ccunit.eq({ b.exportItem({ name = "minecraft:diamond" }, "left") }, { 0, "INVENTORY_NOT_FOUND" })
  ccunit.eq({ b.exportItem({ name = "minecraft:diamond" }, "SIDEWAYS") }, { 0, "INVENTORY_NOT_FOUND" })
  ccunit.eq({ b.exportItem({ name = "bad name!" }, "top") }, { 0, "ITEM_NOT_FOUND" })
  ccunit.eq(b.exportItem({ name = "minecraft:gold_ingot", count = 2 }, "TOP"), 2)
end)

ccunit.test("generic filters", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.isCraftable({ name = "minecraft:piston" }), true)
  ccunit.eq(b.isCraftable({ name = "minecraft:lava" }), true) -- a fluid name makes a fluid filter
  ccunit.eq(b.isCraftable({ name = "minecraft:iron_ingot" }), false)
  ccunit.eq({ b.isCraftable({ name = "#forge:ingots" }) }, { false, "NO_VALID_FILTER_TYPE" })
  ccunit.eq({ b.isCraftable({ type = "item" }) }, { false, "EMPTY_FILTER" })
  ccunit.raises(function() b.isCraftable({ count = 1 }) end, 'Generic filter requires either field "type" or "name"')
  ccunit.raises(function() b.isCraftable({ type = "gas" }) end, "unexpected filter type gas")
  ccunit.eq(b.getPatterns(), {})
  ccunit.eq({ b.getPatterns({ foo = 1 }) }, { nil, "NO_FILTER" })
end)

ccunit.test("not connected", function()
  local b = peripheral.wrap("me")
  SIM({ cmd = "setNetworkConnected", peripheral = "me", connected = false }) sleep(0.1)
  ccunit.eq(b.isConnected(), false)
  ccunit.eq({ b.getItems() }, { nil, "NOT_CONNECTED" })
  ccunit.eq({ b.getStoredEnergy() }, { 0, "NOT_CONNECTED" })
  ccunit.eq({ b.isCraftable({ name = "minecraft:piston" }) }, { false, "NOT_CONNECTED" })
  ccunit.eq({ b.exportItem({ name = "minecraft:diamond" }, "top") }, { 0, "NOT_CONNECTED" })
  SIM({ cmd = "setNetworkConnected", peripheral = "me", connected = true }) sleep(0.1)
end)
`,
      onVersion(world, "1.21.1"),
      "v21-me.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("1.21.1 ME crafting returns a job and fires ae_crafting", async () => {
    const result = await lua(
      `
local function nextEvent()
  local _, isError, id, message = os.pullEvent("ae_crafting")
  return isError, id, message
end

ccunit.test("a job from request to done", function()
  local b = peripheral.wrap("me")
  ccunit.eq({ b.craftItem({ name = "minecraft:piston" }, "missing") }, { nil, "CPU_NOT_FOUND_missing" })
  ccunit.eq({ b.craftItem({}) }, { nil, "EMPTY_FILTER" })
  ccunit.eq({ b.craftItem({ name = "minecraft:bedrock" }) }, { nil, "NOT_CRAFTABLE" })
  ccunit.eq({ b.craftFluid({ name = "minecraft:milk" }) }, { false, "NOT_CRAFTABLE" })
  local job = b.craftItem({ name = "minecraft:piston", count = 4 })
  ccunit.eq(type(job), "table")
  local id = job.getId()
  ccunit.eq(job.isCalculationStarted(), false)
  ccunit.eq(job.getElapsedTime(), -1)
  ccunit.eq(job.getRequestedItem().count, 4)
  local isError, eid, message = nextEvent()
  ccunit.eq({ isError, eid, message }, { false, id, "CALCULATION_STARTED" })
  isError, eid, message = nextEvent()
  ccunit.eq({ isError, eid, message }, { false, id, "CRAFTING_STARTED" })
  ccunit.eq(job.isCraftingStarted(), true)
  ccunit.eq(job.getDebugMessage(), "CRAFTING_STARTED")
  ccunit.eq(job.getCraftingCPU().name, "cpu1")
  ccunit.eq(b.isCrafting({ name = "minecraft:piston" }), true)
  ccunit.eq(b.getCraftingCPUs()[1].isBusy, true)
  local tasks = b.getCraftingTasks()
  ccunit.eq(#tasks, 1)
  ccunit.eq(tasks[1].bridge_id, id)
  ccunit.eq(tasks[1].quantity, 4)
  ccunit.eq(b.getCraftingTask(id).getId(), id)
  ccunit.eq(b.getCraftingTask(99999), nil)
  SIM({ cmd = "completeCraft", peripheral = "me", name = "minecraft:piston" })
  isError, eid, message = nextEvent()
  ccunit.eq({ isError, eid, message }, { false, id, "JOB_DONE" })
  ccunit.eq(job.isDone(), true)
  ccunit.eq(b.getItem({ name = "minecraft:piston" }).count, 4)
  ccunit.eq(b.isCrafting({ name = "minecraft:piston" }), false)
end)

ccunit.test("a stored item without a pattern fails on its first tick", function()
  local b = peripheral.wrap("me")
  local job = b.craftItem({ name = "minecraft:iron_ingot" })
  local isError, eid, message = nextEvent()
  ccunit.eq({ isError, eid, message }, { true, job.getId(), "NOT_CRAFTABLE" })
  ccunit.eq(job.isCalculationNotSuccessful(), true)
  ccunit.eq(job.hasErrorOccurred(), true)
end)

ccunit.test("cancelling", function()
  local b = peripheral.wrap("me")
  local job = b.craftItem({ name = "minecraft:diamond", count = 2 })
  nextEvent()
  nextEvent()
  ccunit.eq(b.cancelCraftingTasks({ name = "minecraft:diamond" }), 1)
  local isError, eid, message = nextEvent()
  ccunit.eq({ isError, eid, message }, { false, job.getId(), "JOB_CANCELED" })
  ccunit.eq(job.isCanceled(), true)
end)
`,
      onVersion(world, "1.21.1"),
      "v21-me-craft.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("1.21.1 RS bridge follows 0.7.62b", async () => {
    const result = await lua(
      `
ccunit.test("reading the network", function()
  local r = peripheral.wrap("rs")
  ccunit.eq(r.isConnected(), true)
  ccunit.eq(r.isOnline(), true)
  local iron = r.getItem({ name = "minecraft:iron_ingot" })
  ccunit.eq(iron.count, 300)
  ccunit.eq(iron.isCraftable, false)
  ccunit.eq(iron.tags, {})
  ccunit.eq(r.getItem({ name = "minecraft:stick" }).components, { Damage = 0 })
  ccunit.eq(r.getItem({ name = "minecraft:stick", components = "{Damage:0}" }).name, "minecraft:stick")
  ccunit.eq({ r.getItem({ name = "minecraft:iron_pickaxe" }) }, { nil, "NOT_FOUND" }) -- stored items only
  ccunit.eq(#r.getItems(), 2)
  ccunit.eq(r.getCraftableItems()[1].name, "minecraft:iron_pickaxe")
  ccunit.eq(r.getCraftableItems()[1].count, 0)
  ccunit.eq(r.getFluid({ name = "minecraft:lava" }).fluidType.temperature, 1300)
  ccunit.eq({ r.getChemicals() }, { nil, "ADDON_NOT_LOADED_RS_MEKANISM" })
  ccunit.eq({ r.getCraftableChemicals() }, { nil, "ADDON_NOT_LOADED_refinedstorage_mekanism_integration" })
end)

ccunit.test("energy and disks", function()
  local r = peripheral.wrap("rs")
  ccunit.eq(r.getStoredEnergy(), 900)
  ccunit.eq(r.getEnergyCapacity(), 1000)
  ccunit.eq(r.getEnergyUsage(), 4)
  ccunit.eq(r.getAverageEnergyInput(), 0)
  ccunit.eq(r.getTotalItemStorage(), 32000)
  ccunit.eq(r.getUsedItemStorage(), 310)
  ccunit.eq(r.getAvailableFluidStorage(), 64000 - 2000)
  ccunit.eq(r.getTotalExternalItemStorage(), 0)
  local cells = r.getCells()
  ccunit.eq(#cells, 2)
  ccunit.eq(cells[1], { used = 310, capacity = 32000, state = "NORMAL", type = "item" })
  ccunit.eq(r.getDrives()[1].total, 96000)
end)

ccunit.test("patterns", function()
  local r = peripheral.wrap("rs")
  local all = r.getPatterns()
  ccunit.eq(#all, 1)
  ccunit.eq(all[1].primaryOutput.name, "minecraft:iron_pickaxe")
  ccunit.eq(all[1].inputs[1][1].count, 3)
  ccunit.eq(all[1].patternType, "CRAFTING")
  ccunit.eq(r.getPatterns({ input = { name = "minecraft:stick" } }).outputs[1].name, "minecraft:iron_pickaxe")
  ccunit.eq({ r.getPatterns({ output = { name = "minecraft:stick" } }) }, { nil, "NO_PATTERN_FOUND" })
  ccunit.eq(r.isCraftable({ name = "minecraft:iron_pickaxe" }), true)
  ccunit.eq(r.isCraftable({ name = "minecraft:stick" }), false)
end)

ccunit.test("crafting fires rs_crafting; JOB_DONE comes flagged as an error", function()
  local r = peripheral.wrap("rs")
  local job = r.craftItem({ name = "minecraft:iron_pickaxe", count = 2 })
  local id = job.getId()
  local seen = {}
  for _ = 1, 2 do
    local _, isError, eid, message = os.pullEvent("rs_crafting")
    ccunit.eq(eid, id)
    seen[#seen + 1] = tostring(isError) .. ":" .. message
  end
  ccunit.eq(seen, { "false:CALCULATION_STARTED", "false:CRAFTING_STARTED" })
  ccunit.eq(r.isCrafting({ name = "minecraft:iron_pickaxe" }), true)
  ccunit.eq(#r.getCraftingTasks(), 1)
  ccunit.eq(job.getEmittedItems()[1].name, "minecraft:iron_pickaxe")
  SIM({ cmd = "completeCraft", peripheral = "rs" })
  local _, isError, eid, message = os.pullEvent("rs_crafting")
  ccunit.eq({ isError, eid, message }, { true, id, "JOB_DONE" })
  ccunit.eq(r.getItem({ name = "minecraft:iron_pickaxe" }).count, 2)
  local bad = r.craftItem({ name = "minecraft:bedrock" })
  local _, e2, id2, m2 = os.pullEvent("rs_crafting")
  ccunit.eq({ e2, id2, m2 }, { true, bad.getId(), "NOT_CRAFTABLE" })
end)

ccunit.test("transfers", function()
  local r = peripheral.wrap("rs")
  ccunit.eq({ r.exportItem({ name = "minecraft:iron_ingot" }, "left") }, { 0, "INVENTORY_NOT_FOUND" })
  ccunit.eq(r.exportItem({ name = "minecraft:iron_ingot", count = 5 }, "top"), 5)
  ccunit.eq({ r.importChemical({ name = "mekanism:hydrogen" }, "top") },
    { 0, "ADDON_NOT_LOADED_refinedstorage_mekanism_integration" })
end)
`,
      onVersion(world, "1.21.1"),
      "v21-rs.test.lua",
    );
    expectAllPassed(result);
  }, 90000);
});
