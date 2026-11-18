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
  loadNamedWorld,
  runTests,
  sendAndWait,
  SessionManager,
} from "./index.js";

/**
 * CC:Tweaked 1.101.3's generic peripherals (InventoryMethods, FluidMethods, EnergyMethods) on blocks of any name,
 * checked against the jar (docs/generic-storage.md).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "generic-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local function types(name) return { peripheral.getType(name) } end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 30000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const world: WorldConfig = {
  peripherals: [
    {
      name: "machine_0",
      type: "thermal:machine_furnace",
      size: 3,
      items: { "1": { name: "minecraft:iron_ore", count: 5 } },
      tanks: [
        { name: "minecraft:water", amount: 3000, capacity: 8000 },
        { name: "minecraft:lava", amount: 500, capacity: 4000 },
        { capacity: 2000 },
      ],
      energy: 1000,
      energyCapacity: 50000,
    },
    { name: "cell_0", type: "energy_storage", energy: 7, energyCapacity: 100 },
    { name: "tank_0", type: "fluid_storage", capacity: 4000 },
    {
      name: "tank_1",
      type: "fluid_storage",
      capacity: 1000,
      fluid: { name: "minecraft:water", amount: 600 },
    },
    {
      name: "tank_2",
      type: "mymod:boiler",
      tanks: [{ name: "minecraft:water", amount: 100, capacity: 5000 }],
    },
    { name: "chest_0", type: "minecraft:chest", size: 9 },
    { name: "both_0", type: "mymod:battery", energy: 5, size: 2 },
    {
      name: "fe_0",
      type: "mymod:fe_tank",
      energy: 5,
      tanks: [{ capacity: 10 }],
    },
    {
      name: "steamer",
      type: "mymod:steamer",
      tanks: [{ name: "mymod:steam", amount: 300, capacity: 1000 }],
    },
    { name: "if_0", type: "mymod:tankbox", size: 1, tanks: [{ capacity: 10 }] },
  ],
};

describe.skipIf(!ready)("generic storage peripherals", () => {
  it("types, in CC's order, and the method list of every mix", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("types", function()
  ccunit.eq(types("machine_0"), { "thermal:machine_furnace", "inventory", "energy_storage", "fluid_storage" })
  ccunit.eq(types("cell_0"), { "energy_storage" })
  ccunit.eq(types("tank_0"), { "fluid_storage" })
  ccunit.eq(types("tank_2"), { "mymod:boiler", "fluid_storage" })
  ccunit.eq(types("chest_0"), { "minecraft:chest", "inventory" })
  -- CC lists the extra types from a HashSet: inventory, energy_storage, fluid_storage; pairs keep the same order
  ccunit.eq(types("both_0"), { "mymod:battery", "inventory", "energy_storage" })
  ccunit.eq(types("fe_0"), { "mymod:fe_tank", "energy_storage", "fluid_storage" })
  ccunit.eq(types("if_0"), { "mymod:tankbox", "inventory", "fluid_storage" })
  ccunit.eq(peripheral.hasType("machine_0", "fluid_storage"), true)
  ccunit.eq(peripheral.hasType("machine_0", "energy_storage"), true)
  ccunit.eq(peripheral.hasType("chest_0", "energy_storage"), false)
end)

ccunit.test("getMethods", function()
  ccunit.eq(peripheral.getMethods("cell_0"), { "getEnergy", "getEnergyCapacity" })
  ccunit.eq(peripheral.getMethods("tank_0"), { "pullFluid", "pushFluid", "tanks" })
  local all = peripheral.getMethods("machine_0")
  ccunit.eq({ unpack(all, #all - 4) }, { "getEnergy", "getEnergyCapacity", "pullFluid", "pushFluid", "tanks" })
  ccunit.eq(all[1], "getItemDetail") -- the inventory methods come first
end)

ccunit.test("find", function()
  ccunit.eq(#{ peripheral.find("energy_storage") }, 4)
  ccunit.eq(#{ peripheral.find("fluid_storage") }, 7)
end)
`,
        world,
        "types.lua",
      ),
    );
  }, 60000);

  it("energy_storage: getEnergy and getEnergyCapacity, and nothing else", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("energy", function()
  local m = peripheral.wrap("machine_0")
  ccunit.eq(m.getEnergy(), 1000)
  ccunit.eq(m.getEnergyCapacity(), 50000)
  local c = peripheral.wrap("cell_0")
  ccunit.eq(c.getEnergy(), 7)
  ccunit.eq(c.getEnergyCapacity(), 100)
  ccunit.eq(c.setEnergy, nil)
  ccunit.eq(err(peripheral.call, "cell_0", "setEnergy", 1), "No such method setEnergy")
end)
`,
        world,
        "energy.lua",
      ),
    );
  }, 60000);

  it("tanks(): one entry per non-empty tank, keyed by position, name and amount only", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("tanks", function()
  local m = peripheral.wrap("machine_0")
  local t = m.tanks()
  ccunit.eq(t[1], { name = "minecraft:water", amount = 3000 })
  ccunit.eq(t[2], { name = "minecraft:lava", amount = 500 })
  ccunit.eq(t[3], nil)
  ccunit.eq(peripheral.wrap("tank_0").tanks(), {})
  ccunit.eq(peripheral.wrap("tank_1").tanks(), { { name = "minecraft:water", amount = 600 } })
end)
`,
        world,
        "tanks.lua",
      ),
    );
  }, 60000);

  it("pushFluid: the first non-empty tank gives, limits, fluid names", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("push", function()
  local m, a = peripheral.wrap("machine_0"), peripheral.wrap("tank_0")
  ccunit.eq(m.pushFluid("tank_0", 1000), 1000)
  ccunit.eq(a.tanks()[1], { name = "minecraft:water", amount = 1000 })
  ccunit.eq(m.tanks()[1].amount, 2000)
  ccunit.eq(m.pushFluid("tank_0", 5000, "minecraft:water"), 2000) -- only the 2000 left in the water tank
  ccunit.eq(m.pushFluid("tank_0", 100, "minecraft:lava"), 0) -- tank_0 holds water now
  ccunit.eq(m.tanks()[2].amount, 500)
  ccunit.eq(m.tanks()[1], nil)
end)
`,
        world,
        "push.lua",
      ),
    );
  }, 60000);

  it("pushFluid with a name picks that fluid, and a bare name means minecraft:", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("by name", function()
  local m, a = peripheral.wrap("machine_0"), peripheral.wrap("tank_0")
  ccunit.eq(m.pushFluid("tank_0", 100, "lava"), 100)
  ccunit.eq(m.tanks()[2].amount, 400)
  ccunit.eq(a.tanks()[1], { name = "minecraft:lava", amount = 100 })
  ccunit.eq(m.pushFluid("tank_0"), 0) -- the first non-empty tank holds water, which tank_0 (lava) refuses
end)
`,
        world,
        "name.lua",
      ),
    );
  }, 60000);

  it("pullFluid takes what is there and what fits", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("pull", function()
  local b, c = peripheral.wrap("tank_1"), peripheral.wrap("tank_2")
  ccunit.eq(b.pullFluid("tank_2"), 100)
  ccunit.eq(b.tanks()[1].amount, 700)
  ccunit.eq(c.tanks(), {})
  ccunit.eq(b.pullFluid("tank_2"), 0)
  ccunit.eq(b.pullFluid("machine_0", 5000, "minecraft:water"), 300) -- tank_1 is full at 1000
  ccunit.eq(peripheral.wrap("machine_0").tanks()[1].amount, 2700)
  ccunit.eq(b.pullFluid("machine_0", 50, "minecraft:lava"), 0) -- it holds water
end)
`,
        world,
        "pull.lua",
      ),
    );
  }, 60000);

  it("fluid goes into a tank with the same fluid first, then an empty one", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("fill order", function()
  local m, b = peripheral.wrap("machine_0"), peripheral.wrap("tank_1")
  ccunit.eq(m.pullFluid("tank_1", 400), 400)
  ccunit.eq(m.tanks()[1].amount, 3400)
  ccunit.eq(b.tanks()[1].amount, 200)
  ccunit.eq(b.pushFluid("machine_0"), 200)
  ccunit.eq(b.tanks(), {})
  ccunit.eq(m.tanks()[1].amount, 3600)
  ccunit.eq(m.pullFluid("steamer"), 300) -- a new fluid takes the empty third tank
  ccunit.eq(m.tanks()[3], { name = "mymod:steam", amount = 300 })
  ccunit.eq(m.pullFluid("tank_2", 1000, "minecraft:water"), 100)
  ccunit.eq(m.tanks()[1].amount, 3700)
end)
`,
        world,
        "fill.lua",
      ),
    );
  }, 60000);

  it("an empty tank takes the first fluid offered; the target's room limits the move", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("fill", function()
  local a, b = peripheral.wrap("tank_0"), peripheral.wrap("tank_1")
  ccunit.eq(a.pullFluid("tank_1"), 600)
  ccunit.eq(a.tanks()[1], { name = "minecraft:water", amount = 600 })
  ccunit.eq(b.tanks(), {})
  ccunit.eq(a.pushFluid("tank_1", 5000), 600)
  ccunit.eq(a.tanks(), {})
end)
`,
        world,
        "empty.lua",
      ),
    );
  }, 60000);

  it("errors, in the order FluidMethods raises them", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("errors", function()
  local m = peripheral.wrap("machine_0")
  ccunit.eq(err(m.pushFluid, "nope"), "Target 'nope' does not exist")
  ccunit.eq(err(m.pullFluid, "nope"), "Target 'nope' does not exist")
  ccunit.eq(err(m.pushFluid, "chest_0"), "Target 'chest_0' is not an tank")
  ccunit.eq(err(m.pushFluid, "cell_0"), "Target 'cell_0' is not an tank")
  ccunit.eq(err(m.pushFluid, "tank_0", 0), "Limit must be > 0")
  ccunit.eq(err(m.pullFluid, "tank_0", -5), "Limit must be > 0")
  ccunit.eq(err(m.pushFluid, "tank_0", 10, "minecraft:cobblestone"), "Unknown fluid 'minecraft:cobblestone'")
  ccunit.eq(err(m.pushFluid, "tank_0", 10, "Bad Name"), "Unknown fluid 'Bad Name'")
  ccunit.eq(err(m.pushFluid, "nope", 10, "minecraft:cobblestone"), "Unknown fluid 'minecraft:cobblestone'") -- fluid first
  ccunit.eq(err(m.pushFluid, "nope", 0), "Target 'nope' does not exist") -- then the target, then the limit
  ccunit.eq(err(m.pushFluid), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(m.pushFluid, "tank_0", "x"), "bad argument #2 (number expected, got string)")
  ccunit.eq(err(m.pushFluid, "tank_0", 0 / 0), "bad argument #2 (number expected, got nan)")
  ccunit.eq(m.pushFluid("tank_0", 10, "minecraft:empty"), 0)
  ccunit.eq(m.pushFluid("tank_0", 10, "mymod:steam"), 0) -- a mod fluid the tank does not hold
end)
`,
        world,
        "errors.lua",
      ),
    );
  }, 60000);

  it("a block with tanks and an inventory moves items as well", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("items", function()
  local m = peripheral.wrap("machine_0")
  ccunit.eq(m.size(), 3)
  ccunit.eq(m.list()[1], { name = "minecraft:iron_ore", count = 5 })
  ccunit.eq(m.pushItems("chest_0", 1), 5)
  ccunit.eq(peripheral.wrap("chest_0").list()[1].count, 5)
  ccunit.eq(m.pullItems("chest_0", 1, 2, 2), 2) -- a limit of 2, into slot 2
  ccunit.eq(err(m.getItemDetail, 4), "Slot out of range (between 1 and 3)")
end)
`,
        world,
        "items.lua",
      ),
    );
  }, 60000);

  it("calls wait for the server tick like every main-thread method", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("tick wait", function()
  local c = peripheral.wrap("cell_0")
  local t = peripheral.wrap("tank_1")
  local before = os.epoch("utc")
  for _ = 1, 3 do c.getEnergy() t.tanks() end
  ccunit.eq(os.epoch("utc") - before >= 150, true)
end)
`,
        world,
        "tick.lua",
      ),
    );
  }, 60000);
});

/** Run an idle session and step it with sim commands; each step returns the state after the command. */
async function withSession(
  w: WorldConfig,
  run: (
    step: (c: SimCommand) => Promise<SimState>,
    raw: (c: SimCommand) => Promise<boolean>,
  ) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    await s.handle.session.waitForText(">", 0, 20000);
    await run(
      async (c) => {
        expect(await sendAndWait(s.handle, c)).toBe(true);
        return s.handle.readState()!;
      },
      (c) => sendAndWait(s.handle, c),
    );
  } finally {
    await manager.destroyAll();
  }
}

type PState = Record<string, any>;
const periph = (s: SimState, name: string): PState =>
  (s as unknown as { peripherals: Record<string, PState> }).peripherals[name]!;

describe.skipIf(!ready)("generic storage over time and sim commands", () => {
  const timed: WorldConfig = {
    peripherals: [
      {
        name: "gen",
        type: "mymod:generator",
        energy: 100,
        energyCapacity: 1000,
        energyRate: 10,
      },
      {
        name: "drain",
        type: "energy_storage",
        energy: 100,
        energyCapacity: 1000,
        energyRate: -30,
      },
      {
        name: "pump",
        type: "mymod:pump",
        tanks: [
          { name: "minecraft:water", amount: 0, capacity: 500, rate: 20 },
          { name: "minecraft:lava", amount: 300, capacity: 500, rate: -50 },
        ],
      },
      { name: "calm", type: "energy_storage", energy: 5, energyCapacity: 10 },
      { name: "tank", type: "fluid_storage", capacity: 1000 },
    ],
  };

  it("rates run on the virtual clock and stop at the limits", async () => {
    await withSession(timed, async (step) => {
      // 1 second = 20 ticks
      let s = await step({ cmd: "advance", seconds: 1 });
      expect(periph(s, "gen").energy.energy).toBeGreaterThanOrEqual(300);
      expect(periph(s, "gen").energy.energy).toBeLessThanOrEqual(320);
      expect(periph(s, "drain").energy.energy).toBe(0);
      expect(periph(s, "pump").tanks[0].fluid.amount).toBeGreaterThanOrEqual(
        400,
      );
      expect(periph(s, "pump").tanks[1].fluid).toBeUndefined();
      expect(periph(s, "calm").energy.energy).toBe(5);
      s = await step({ cmd: "advance", seconds: 10 });
      expect(periph(s, "gen").energy.energy).toBe(1000);
      expect(periph(s, "pump").tanks[0].fluid.amount).toBe(500);
    });
  }, 90000);

  it("setEnergy and setFluid change what a program reads", async () => {
    await withSession(timed, async (step, raw) => {
      let s = await step({ cmd: "setEnergy", peripheral: "calm", energy: 9 });
      expect(periph(s, "calm").energy.energy).toBe(9);
      s = await step({ cmd: "setEnergy", peripheral: "calm", energy: 9999 });
      expect(periph(s, "calm").energy.energy).toBe(10); // kept within the capacity
      s = await step({
        cmd: "setFluid",
        peripheral: "tank",
        fluid: { name: "minecraft:lava", amount: 250 },
      });
      expect(periph(s, "tank").fluid).toMatchObject({
        name: "minecraft:lava",
        amount: 250,
      });
      s = await step({ cmd: "setFluid", peripheral: "tank", fluid: null });
      expect(periph(s, "tank").tanks[0].fluid).toBeUndefined();
      // commands that name something that is not there change nothing (and do not stop the session)
      await raw({
        cmd: "setFluid",
        peripheral: "tank",
        tank: 5,
        fluid: { name: "minecraft:water", amount: 5 },
      });
      await raw({ cmd: "setEnergy", peripheral: "tank", energy: 1 });
      s = await step({ cmd: "setEnergy", peripheral: "calm", energy: 3 });
      expect(periph(s, "tank").tanks[0].fluid).toBeUndefined();
      expect(periph(s, "calm").energy.energy).toBe(3);
    });
  }, 90000);
});

describe.skipIf(!ready)("the demo world", () => {
  it("loads and its blocks answer", async () => {
    const demo = loadNamedWorld(config.worldsDir, "generic-storage-demo");
    expectAllPassed(
      await lua(
        `
ccunit.test("demo", function()
  ccunit.eq(peripheral.getType("furnace_0"), "thermal:machine_furnace")
  ccunit.eq(peripheral.wrap("furnace_0").getEnergyCapacity(), 50000)
  ccunit.eq(peripheral.wrap("boiler_0").tanks()[1].name, "minecraft:water")
  ccunit.eq(peripheral.wrap("battery_0").getEnergy() >= 20000, true)
end)
`,
        demo as WorldConfig,
        "demo.lua",
      ),
    );
  }, 60000);
});
