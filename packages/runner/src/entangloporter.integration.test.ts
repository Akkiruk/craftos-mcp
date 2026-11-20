import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
  sendAndWait,
  SessionManager,
} from "./index.js";

/**
 * Mekanism 10.2.5 Quantum Entangloporter, from TileEntityQuantumEntangloporter, InventoryFrequency,
 * TileComponentConfig and TileComponentEjector (docs/mekanism-qio.md has the lines).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "qe-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
`;

/**
 * This suite is the mod's 1.18.2 release, so a world without a version runs on 1.18.2 whatever the default is (the
 * public default is 1.21.1). The later releases have their own suites (mekanism-versions, extreme-reactors "Versions").
 */
function on1182(world: WorldConfig): WorldConfig {
  return { version: "1.18.2", ...world } as WorldConfig;
}

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, PRELUDE + source);
  return runTests(
    config,
    { paths: [name], world: on1182(world), timeoutMs: 30000 },
    1,
  );
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const sword = {
  name: "minecraft:diamond_sword",
  count: 1,
  maxCount: 1,
  nbt: { gear: { id: "x9", level: 40 } },
};

const world: WorldConfig = {
  players: [{ name: "Alice" }, { name: "Bob" }],
  mekanism: {
    entangloporter: {
      frequencies: [
        {
          name: "Shop",
          owner: "Alice",
          item: sword,
          fluid: { name: "minecraft:water", amount: 1000 },
          gas: { name: "mekanism:hydrogen", amount: 4096000 },
          energy: 64000000,
          temperature: 310,
        },
        { name: "Spare", owner: "Alice" },
        { name: "Hidden", public: false, owner: "Bob" },
      ],
    },
  },
  peripherals: [
    {
      name: "qe1",
      type: "quantumEntangloporter",
      owner: "Alice",
      frequency: "Shop",
    },
    {
      name: "qe2",
      type: "quantumEntangloporter",
      owner: "Alice",
      frequency: "Shop",
      facing: "UP",
    },
    { name: "qe3", type: "quantumEntangloporter", owner: "Alice" },
    {
      name: "bobs",
      type: "quantumEntangloporter",
      owner: "Bob",
      frequency: { name: "Hidden", public: false },
      securityMode: "PRIVATE",
    },
    {
      name: "chest",
      type: "minecraft:chest",
      size: 27,
      items: { "1": { name: "minecraft:dirt", count: 10 } },
    },
  ],
};

describe.skipIf(!ready)("Quantum Entangloporter methods", () => {
  it("frequency, buffers, energy, config, ejector and security", async () => {
    const result = await lua(
      `
ccunit.test("frequency", function()
  local q = peripheral.wrap("qe1")
  ccunit.eq(peripheral.getType("qe1"), "quantumEntangloporter")
  ccunit.eq(q.hasFrequency(), true)
  ccunit.eq(q.getFrequency(), { key = "Shop", public = true })
  ccunit.eq(q.getFrequencies(), { { key = "Shop", public = true }, { key = "Spare", public = true } })
  ccunit.eq(peripheral.call("bobs", "getFrequency"), { key = "Hidden", public = false })
  ccunit.eq(err(q.setFrequency, "Hidden"), "No public inventory frequency with name 'Hidden' found.")
  ccunit.eq(err(q.createFrequency, "Spare"), "Unable to create public inventory frequency with name 'Spare' as one already exists.")
  ccunit.eq(err(peripheral.wrap("qe3").getBufferItem), "No frequency is currently selected.")
  ccunit.eq(err(peripheral.wrap("bobs").setFrequency, "Shop"), "Setter not available due to machine security not being public.")
end)

ccunit.test("one shared buffer per frequency, NBT kept", function()
  local a, b = peripheral.wrap("qe1"), peripheral.wrap("qe2")
  local item = { name = "minecraft:diamond_sword", count = 1, nbt = { gear = { id = "x9", level = 40 } } }
  ccunit.eq(a.getBufferItem(), item)
  ccunit.eq(b.getBufferItem(), item)
  ccunit.eq(a.getBufferFluid(), { name = "minecraft:water", amount = 1000 })
  ccunit.eq(a.getBufferFluidCapacity(), 256000)
  ccunit.eq(a.getBufferFluidNeeded(), 255000)
  ccunit.eq(a.getBufferFluidFilledPercentage(), 1000 / 256000)
  ccunit.eq(a.getBufferGas(), { name = "mekanism:hydrogen", amount = 4096000 })
  ccunit.eq(a.getBufferGasFilledPercentage(), 0.5)
  ccunit.eq(a.getBufferSlurry(), { name = "mekanism:empty", amount = 0 })
  ccunit.eq(a.getBufferSlurryCapacity(), 8192000)
  ccunit.eq(a.getTemperature(), 310)
  ccunit.eq(a.getEnergy(), 64000000)
  ccunit.eq(a.getMaxEnergy(), 256000000)
  ccunit.eq(a.getEnergyNeeded(), 192000000)
  ccunit.eq(a.getEnergyFilledPercentage(), 0.25)
  local none = peripheral.wrap("qe3")
  ccunit.eq(none.getEnergy(), 0)
  ccunit.eq(none.getMaxEnergy(), 0)
  ccunit.eq(none.getEnergyFilledPercentage(), 1) -- FloatingLong.divideToLevel by zero
  ccunit.eq(none.getTransferLoss(), 0)
  ccunit.eq(none.hasFrequency(), false)
end)

ccunit.test("frequencies set and created from a computer are public", function()
  local q = peripheral.wrap("qe3")
  q.setFrequency("Spare")
  ccunit.eq(q.getFrequency(), { key = "Spare", public = true })
  ccunit.eq(q.getBufferItem(), { name = "minecraft:air", count = 0 })
  q.createFrequency("Mine")
  ccunit.eq(q.getFrequency(), { key = "Mine", public = true })
  ccunit.eq(#q.getFrequencies(), 3)
end)

ccunit.test("side config", function()
  local q = peripheral.wrap("qe1")
  ccunit.eq(q.getConfigurableTypes(), { "ITEM", "FLUID", "GAS", "INFUSION", "PIGMENT", "SLURRY", "ENERGY", "HEAT" })
  ccunit.eq(q.getSupportedModes("item"), { "NONE", "INPUT", "OUTPUT", "INPUT_OUTPUT" })
  ccunit.eq(q.getSupportedModes("HEAT"), { "NONE", "INPUT_OUTPUT" })
  ccunit.eq(q.getMode("ITEM", "FRONT"), "OUTPUT")
  ccunit.eq(q.getMode("ITEM", "back"), "INPUT")
  ccunit.eq(q.getMode("HEAT", "LEFT"), "INPUT_OUTPUT")
  ccunit.eq(q.isEjecting("ITEM"), false)
  ccunit.eq(q.canEject("ITEM"), true)
  ccunit.eq(q.canEject("HEAT"), false)
  ccunit.eq(err(q.setEjecting, "HEAT", true), "This machine does not support auto-ejecting for transmission type 'HEAT'.")
  q.setEjecting("ITEM", true)
  ccunit.eq(q.isEjecting("ITEM"), true)
  q.setEjecting("ITEM", false)
  q.incrementMode("ITEM", "BACK")
  ccunit.eq(q.getMode("ITEM", "BACK"), "OUTPUT") -- INPUT_1 and INPUT_2 are skipped: not supported
  q.incrementMode("ITEM", "BACK")
  ccunit.eq(q.getMode("ITEM", "BACK"), "INPUT_OUTPUT")
  q.incrementMode("ITEM", "BACK")
  ccunit.eq(q.getMode("ITEM", "BACK"), "NONE")
  q.decrementMode("ITEM", "BACK")
  ccunit.eq(q.getMode("ITEM", "BACK"), "INPUT_OUTPUT")
  q.setMode("ITEM", "BACK", "input")
  ccunit.eq(err(q.setMode, "ITEM", "BACK", "EXTRA"), "This machine does not support mode 'EXTRA' for transmission type 'ITEM'.")
  ccunit.eq(err(q.setMode, "ITEM", "BACK", "SIDEWAYS"), "Invalid argument 2, setMode expected DataType but received type String with value SIDEWAYS.")
  ccunit.eq(err(q.getMode, "ITEM", "NORTH"), "Invalid argument 1, getMode expected RelativeSide but received type String with value NORTH.")
  ccunit.eq(err(q.getMode, "WATER", "TOP"), "Invalid argument 0, getMode expected TransmissionType but received type String with value WATER.")
  ccunit.eq(q.getMode(6, 0), "OUTPUT") -- enums also take their ordinal: ITEM, FRONT
end)

ccunit.test("ejector colours", function()
  local q = peripheral.wrap("qe1")
  ccunit.eq(q.hasStrictInput(), false)
  q.setStrictInput(true)
  ccunit.eq(q.hasStrictInput(), true)
  ccunit.eq(q.getOutputColor(), nil)
  q.incrementOutputColor()
  ccunit.eq(q.getOutputColor(), "DARK_BLUE")
  q.decrementOutputColor()
  ccunit.eq(q.getOutputColor(), nil)
  q.decrementOutputColor()
  ccunit.eq(q.getOutputColor(), "BLACK")
  ccunit.eq(err(q.setOutputColor, "WHITE"), "Color 'WHITE' is not a supported transporter color.")
  q.setInputColor("LEFT", "red")
  ccunit.eq(q.getInputColor("LEFT"), "RED")
  q.clearInputColor("LEFT")
  ccunit.eq(q.getInputColor("LEFT"), nil)
  ccunit.eq(q.getSupportedUpgrades(), { "ANCHOR" })
  ccunit.eq(q.getInstalledUpgrades(), {})
  ccunit.eq(q.getDirection(), "NORTH")
  ccunit.eq(peripheral.call("qe2", "getDirection"), "UP")
end)

ccunit.test("CC inventory methods reach the read-only null-side handler", function()
  local chest = peripheral.wrap("chest")
  ccunit.eq(peripheral.wrap("qe1").list, nil) -- Mekanism supplies the peripheral: no inventory methods
  ccunit.eq(chest.pushItems("qe1", 1), 0)
  ccunit.eq(chest.pushItems("qe1", 1, 64, 1), 0)
  ccunit.eq(chest.pullItems("qe1", 1), 0)
  ccunit.eq(chest.list()[1].count, 10)
  ccunit.eq(peripheral.call("qe1", "getBufferItem").name, "minecraft:diamond_sword")
  ccunit.eq(err(chest.pullItems, "qe1", 2), "From slot out of range (between 1 and 1)")
  ccunit.eq(err(chest.pushItems, "qe1", 1, 64, 2), "To slot out of range (between 1 and 1)")
end)
`,
      world,
      "methods.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("without a frequency it is not an inventory at all", async () => {
    const result = await lua(
      `
ccunit.test("no frequency", function()
  ccunit.eq(err(peripheral.wrap("chest").pushItems, "qe3", 1), "Target 'qe3' is not an inventory")
end)
`,
      world,
      "nofreq.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── ejection on the virtual clock ─────────────

async function withSession(
  w: WorldConfig,
  run: (step: (c: SimCommand) => Promise<SimState>) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, on1182(w));
  try {
    await s.handle.session.waitForText(">", 0, 20000);
    await run(async (c) => {
      expect(await sendAndWait(s.handle, c)).toBe(true);
      return s.handle.readState()!;
    });
  } finally {
    await manager.destroyAll();
  }
}

function count(state: SimState, inv: string, item: string): number {
  const slots = (state.inventories?.[inv] ?? {}) as Record<
    string,
    { name: string; count: number }
  >;
  return Object.values(slots)
    .filter((s) => s.name === item)
    .reduce((a, s) => a + s.count, 0);
}

/** The first tick after `after` on which an entangloporter that has ejected since tick 0 ejects again. */
function nextEject(after: number): number {
  return Math.ceil((after + 1) / 11) * 11;
}

describe.skipIf(!ready)("Quantum Entangloporter ejection", () => {
  it("ejects the whole slot through output sides every 11th tick; input sides get nothing; unloaded ones stop", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        mekanism: {
          entangloporter: {
            frequencies: [
              {
                name: "Shop",
                owner: "Alice",
                item: { name: "minecraft:cobblestone", count: 64 },
              },
            ],
          },
        },
        peripherals: [
          { name: "out", type: "minecraft:chest", size: 27 },
          { name: "side", type: "minecraft:chest", size: 27 },
          {
            name: "qe",
            type: "quantumEntangloporter",
            owner: "Alice",
            frequency: "Shop",
            config: { ITEM: { ejecting: true } },
            // facing north: the front (OUTPUT by default) is north; the left (INPUT) is east
            adjacent: { front: "out", east: "side" },
          },
        ],
      },
      async (step) => {
        let state = await step({ cmd: "advance", seconds: 0.05 });
        expect(count(state, "out", "minecraft:cobblestone")).toBe(64); // tick 0
        state = await step({
          cmd: "qeInsert",
          frequency: "Shop",
          item: { name: "minecraft:cobblestone", count: 64 },
        });
        const inserted = state.qio!.gameTime;
        expect(
          state.qio!.entangloporter!.frequencies[0]!.item?.count ?? 0,
        ).toBe(64);
        state = await step({ cmd: "advance", seconds: 0.3 });
        const ejected = state.qio!.gameTime >= nextEject(inserted);
        expect(count(state, "out", "minecraft:cobblestone")).toBe(
          ejected ? 128 : 64,
        );
        state = await step({ cmd: "advance", seconds: 1 });
        expect(count(state, "out", "minecraft:cobblestone")).toBe(128);
        expect(count(state, "side", "minecraft:cobblestone")).toBe(0);
        await step({ cmd: "qeSetLoaded", block: "qe", loaded: false });
        await step({
          cmd: "qeInsert",
          frequency: "Shop",
          item: { name: "minecraft:cobblestone", count: 64 },
        });
        state = await step({ cmd: "advance", seconds: 2 });
        expect(count(state, "out", "minecraft:cobblestone")).toBe(128);
        expect(state.qio!.entangloporter!.frequencies[0]!.item?.count).toBe(64);
      },
    );
  }, 60000);

  it("gear keeps its NBT through the buffer, one per slot", async () => {
    const result = await lua(
      `
ccunit.test("gear", function()
  sleep(0.2)
  local list = peripheral.wrap("out").list()
  ccunit.eq(list[1].name, "minecraft:diamond_sword")
  ccunit.eq(list[1].count, 1)
  ccunit.eq(peripheral.wrap("out").getItemDetail(1).maxCount, 1)
  ccunit.eq(peripheral.call("qe", "getBufferItem"), { name = "minecraft:air", count = 0 })
end)
`,
      {
        players: [{ name: "Alice" }],
        mekanism: {
          entangloporter: {
            frequencies: [{ name: "Shop", owner: "Alice", item: sword }],
          },
        },
        peripherals: [
          { name: "out", type: "minecraft:chest", size: 27 },
          {
            name: "qe",
            type: "quantumEntangloporter",
            owner: "Alice",
            frequency: "Shop",
            config: { ITEM: { ejecting: true } },
            adjacent: { north: "out" },
          },
        ],
      },
      "gear.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
