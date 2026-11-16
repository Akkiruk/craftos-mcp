import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
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
 * Mekanism 10.2.5 and Mekanism Generators 10.2.5 multiblocks: fission reactor, industrial turbine, thermoelectric
 * boiler, induction matrix, fusion reactor. Behaviour read from the 1.18.x source at the 10.2.5 commit and the
 * pack's jars (docs/mekanism-multiblocks.md has the line for every rule).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "mekmb-ws-"));
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
local function near(a, b, eps)
  if math.abs(a - b) > (eps or 1e-6) * math.max(1, math.abs(b)) then error(("%s is not near %s"):format(tostring(a), tostring(b)), 2) end
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

/** Run an idle session and step it with sim commands; each step returns the state after the command. */
async function withSession(
  w: WorldConfig,
  run: (
    step: (c: Record<string, unknown>) => Promise<SimState>,
  ) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    await s.handle.session.waitForText(">", 0, 20000);
    await run(async (c) => {
      expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
        true,
      );
      return s.handle.readState()!;
    });
  } finally {
    await manager.destroyAll();
  }
}

type MB = Record<string, unknown> & { kind: string };
/** Every multiblock's state is under addons["mekanism-machines"] (the module with the clock), generators' too. */
function mbState(
  state: SimState,
  _module: string,
  id: string,
): Record<string, any> {
  const addons = (
    state as unknown as {
      addons?: Record<string, { multiblocks: Record<string, unknown> }>;
    }
  ).addons;
  return addons!["mekanism-machines"]!.multiblocks[id] as Record<string, any>;
}
/** The last tick simulated (the first is 0). */
function gameTime(state: SimState, _module: string): number {
  const addons = (
    state as unknown as { addons?: Record<string, { gameTime: number }> }
  ).addons;
  return addons!["mekanism-machines"]!.gameTime;
}

/** FloatingLong.create(double): four decimals. */
const fl = (d: number) =>
  d <= 0
    ? 0
    : Math.floor(d) + Math.round((d - Math.floor(d)) * 10_000) / 10_000;

/** TurbineMultiblockData.tick for the default 5x5x9 turbine, `input` mB/t of steam piped in after each tick. */
function turbineModel(ticks: number, o: { steam: number; input: number }) {
  const cap = 6_400_000,
    energyCap = 225 * 16_000_000,
    mult = 2.1426;
  let steam = o.steam,
    energy = 0,
    newIn = 0,
    lastIn = 0,
    flow = 0;
  for (let i = 0; i < ticks; i++) {
    lastIn = newIn;
    newIn = 0;
    const needed = energyCap - energy;
    if (steam > 0 && needed > 0) {
      const rate =
        Math.min(Math.min(steam, 384_000), fl(needed / mult)) * (steam / cap);
      flow = Math.trunc(rate);
      if (flow > 0) {
        energy = fl(energy + Math.min(fl(mult * fl(rate)), needed));
        steam -= flow;
      }
    } else flow = 0;
    const n = Math.min(o.input, cap - steam);
    steam += n;
    newIn += n;
  }
  return { steam, energy, flow, lastIn };
}

const fission = (extra: Record<string, unknown> = {}): MB => ({
  kind: "fission",
  fuel: 1000,
  coolant: 1_000_000,
  ...extra,
});

function reactorWorld(
  extra: Record<string, unknown> = {},
  more: Record<string, MB> = {},
): WorldConfig {
  return {
    peripherals: [
      {
        name: "adapter",
        type: "fissionReactorLogicAdapter",
        multiblock: "reactor",
      },
      { name: "port", type: "fissionReactorPort", multiblock: "reactor" },
    ],
    mekanism: { multiblocks: { reactor: fission(extra), ...more } },
  } as unknown as WorldConfig;
}

// ───────────── surface ─────────────

const tank = (p: string) =>
  ["", "Capacity", "Needed", "FilledPercentage"].map((s) => `get${p}${s}`);
const energy = [
  "getEnergy",
  "getMaxEnergy",
  "getEnergyNeeded",
  "getEnergyFilledPercentage",
];
const shape = ["getLength", "getWidth", "getHeight", "getMinPos", "getMaxPos"];

/**
 * Every @ComputerMethod, @SyntheticComputerMethod and @WrappingComputerMethod the jars bind for each block (javap
 * on the 10.2.5.465 classes), restrictions applied: the tile's (with TileEntityMultiblock and TileEntityMekanism),
 * then the multiblock's (with MultiblockData) while formed.
 */
const SOURCE: Record<string, { tile: string[]; multiblock?: string[] }> = {
  fissionReactorLogicAdapter: {
    tile: [
      "getLogicMode",
      "getRedstoneLogicStatus",
      "setLogicMode",
      "isFormed",
      "getRedstoneMode",
      "setRedstoneMode",
    ],
    multiblock: [
      "getFuelAssemblies",
      "getFuelSurfaceArea",
      ...tank("Fuel"),
      ...tank("HeatedCoolant"),
      ...tank("Waste"),
      "getTemperature",
      "getEnvironmentalLoss",
      "getHeatingRate",
      "getActualBurnRate",
      "getBurnRate",
      "isForceDisabled",
      "getStatus",
      "getBoilEfficiency",
      "getMaxBurnRate",
      "getDamagePercent",
      "activate",
      "scram",
      "setBurnRate",
      "getCoolant",
      "getCoolantCapacity",
      "getCoolantNeeded",
      "getCoolantFilledPercentage",
      "getHeatCapacity",
      ...shape,
    ],
  },
  fissionReactorPort: {
    tile: ["getMode", "setMode", "incrementMode", "decrementMode"],
  },
  turbineValve: {
    tile: ["isFormed", "getComparatorLevel", ...energy],
    multiblock: [
      ...tank("Steam"),
      "getDumpingMode",
      "getBlades",
      "getVents",
      "getCoils",
      "getCondensers",
      "getLastSteamInputRate",
      "getFlowRate",
      "getDispersers",
      "getProductionRate",
      "getMaxProduction",
      "getMaxFlowRate",
      "getMaxWaterOutput",
      "setDumpingMode",
      "incrementDumpingMode",
      "decrementDumpingMode",
      ...shape,
    ],
  },
  boilerValve: {
    tile: [
      "getMode",
      "setMode",
      "incrementMode",
      "decrementMode",
      "isFormed",
      "getComparatorLevel",
    ],
    multiblock: [
      ...tank("HeatedCoolant"),
      ...tank("CooledCoolant"),
      ...tank("Water"),
      ...tank("Steam"),
      "getTemperature",
      "getEnvironmentalLoss",
      "getBoilRate",
      "getMaxBoilRate",
      "getSuperheaters",
      "getBoilCapacity",
      ...shape,
    ],
  },
  inductionPort: {
    tile: ["getMode", "setMode", "isFormed", "getComparatorLevel", ...energy],
    multiblock: [
      "getInputItem",
      "getOutputItem",
      "getTransferCap",
      "getLastInput",
      "getLastOutput",
      "getInstalledCells",
      "getInstalledProviders",
      ...shape,
    ],
  },
  fusionReactorLogicAdapter: {
    tile: [
      "isActiveCooledLogic",
      "getLogicMode",
      "setLogicMode",
      "setActiveCooledLogic",
      "isFormed",
    ],
    multiblock: [
      ...tank("Water"),
      ...tank("Steam"),
      "getPlasmaTemperature",
      "getCaseTemperature",
      ...tank("Deuterium"),
      ...tank("Tritium"),
      ...tank("DTFuel"),
      "getHohlraum",
      "getInjectionRate",
      "getMinInjectionRate",
      "getMaxPlasmaTemperature",
      "getMaxCasingTemperature",
      "getIgnitionTemperature",
      "setInjectionRate",
      "getPassiveGeneration",
      "getProductionRate",
      ...shape,
    ],
  },
  fusionReactorPort: { tile: ["getMode", "setMode", ...energy] },
};

/** java.util.HashMap iteration order for String keys put in this order into new HashMap<>(initialCapacity). */
function javaHashMapOrder(keys: string[], initialCapacity: number): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 1;
  while (cap < initialCapacity) cap *= 2;
  let threshold = Math.floor(cap * 0.75);
  for (let size = 1; size <= keys.length; size++) {
    if (size > threshold) {
      cap *= 2;
      threshold = Math.floor(cap * 0.75);
    }
  }
  return keys
    .map((k, i) => ({ k, i, b: hash(k) & (cap - 1) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.k);
}

/**
 * Single blocks: the tile's methods (with the TileEntityMekanism ones its block attributes allow), then the
 * upgrade, security, side config and ejector components', each group sorted, as javap shows them in the jars.
 */
const dir = ["getDirection"],
  red = ["getRedstoneMode", "setRedstoneMode"],
  cmp = ["getComparatorLevel"];
const UPG = ["getInstalledUpgrades", "getSupportedUpgrades"];
const SEC = ["getOwnerUUID", "getOwnerName", "getSecurityMode"];
const CFG = [
  "getConfigurableTypes",
  "canEject",
  "isEjecting",
  "setEjecting",
  "getSupportedModes",
  "getMode",
  "setMode",
  "incrementMode",
  "decrementMode",
];
const EJ = [
  "hasStrictInput",
  "getOutputColor",
  "getInputColor",
  "setStrictInput",
  "clearInputColor",
  "incrementInputColor",
  "decrementInputColor",
  "setInputColor",
  "clearOutputColor",
  "incrementOutputColor",
  "decrementOutputColor",
  "setOutputColor",
];
const four = ["getStored", "getCapacity", "getNeeded", "getFilledPercentage"];
const tiers = ["basic", "advanced", "elite", "ultimate", "creative"];
const SINGLES: Record<string, string[][]> = {};
for (const t of tiers) {
  SINGLES[`${t}EnergyCube`] = [
    ["getChargeItem", "getDischargeItem", ...dir, ...red, ...cmp, ...energy],
    SEC,
    CFG,
    EJ,
  ];
  SINGLES[`${t}FluidTank`] = [
    [
      ...four,
      "getInputItem",
      "getOutputItem",
      "getContainerEditMode",
      "setContainerEditMode",
      "incrementContainerEditMode",
      "decrementContainerEditMode",
      ...cmp,
    ],
    SEC,
  ];
  SINGLES[`${t}ChemicalTank`] = [
    [
      "getDumpingMode",
      "getDrainItem",
      "getFillItem",
      ...four,
      "setDumpingMode",
      "incrementDumpingMode",
      "decrementDumpingMode",
      ...dir,
      ...red,
      ...cmp,
    ],
    SEC,
    CFG,
    EJ,
  ];
}
const electric = [
  "getInput",
  "getOutput",
  "getEnergyItem",
  "getEnergyUsage",
  "getRecipeProgress",
  "getTicksRequired",
  ...dir,
  ...red,
  ...cmp,
  ...energy,
];
for (const m of ["enrichmentChamber", "crusher", "energizedSmelter"])
  SINGLES[m] = [electric, UPG, SEC, CFG, EJ];
SINGLES.metallurgicInfuser = [
  [...tank("InfuseType"), "getInfuseTypeItem", ...electric, "dumpInfuseType"],
  UPG,
  SEC,
  CFG,
  EJ,
];
SINGLES.electrolyticSeparator = [
  [
    ...tank("Input"),
    ...tank("LeftOutput"),
    ...tank("RightOutput"),
    "getLeftOutputDumpingMode",
    "getRightOutputDumpingMode",
    "getInputItem",
    "getLeftOutputItem",
    "getRightOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    ...["Left", "Right"].flatMap((s) => [
      `set${s}OutputDumpingMode`,
      `increment${s}OutputDumpingMode`,
      `decrement${s}OutputDumpingMode`,
    ]),
    ...dir,
    ...red,
    ...cmp,
    ...energy,
  ],
  UPG,
  SEC,
  CFG,
  EJ,
];
const gen = [
  "getMaxOutput",
  "getEnergyItem",
  ...dir,
  ...red,
  ...cmp,
  ...energy,
];
SINGLES.solarGenerator = [[...gen, "canSeeSun", "getProductionRate"], UPG, SEC];
SINGLES.advancedSolarGenerator = SINGLES.solarGenerator;
SINGLES.windGenerator = [
  [...gen, "isBlacklistedDimension", "getProductionRate"],
  UPG,
  SEC,
];
SINGLES.heatGenerator = [
  [
    ...gen,
    ...tank("Lava"),
    "getTemperature",
    "getFuelItem",
    "getProductionRate",
    "getTransferLoss",
    "getEnvironmentalLoss",
  ],
  UPG,
  SEC,
];
SINGLES.bioGenerator = [
  [...gen, ...tank("BioFuel"), "getFuelItem", "getProductionRate"],
  UPG,
  SEC,
];
SINGLES.gasBurningGenerator = [
  [...gen, ...tank("Fuel"), "getFuelItem", "getBurnRate", "getProductionRate"],
  UPG,
  SEC,
];

const surface = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./mekanism-multiblocks-surface.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<string, string[]>;

describe("multiblock method surface (no engine)", () => {
  it("mekanism-multiblocks-surface.json is the jar's methods in CC's order, formed and unformed", () => {
    const expected: Record<string, string[]> = {};
    for (const [type, { tile, multiblock }] of Object.entries(SOURCE)) {
      const t = [...new Set(tile)].sort();
      if (multiblock) {
        const bound = [
          ...t,
          ...[...new Set(multiblock)].sort().filter((n) => !t.includes(n)),
        ];
        expected[type] = javaHashMapOrder(bound, bound.length);
        expected[`${type}:unformed`] = javaHashMapOrder(t, t.length);
      } else expected[type] = javaHashMapOrder(t, t.length);
    }
    for (const [type, groups] of Object.entries(SINGLES)) {
      const bound: string[] = [];
      for (const g of groups)
        for (const n of [...new Set(g)].sort())
          if (!bound.includes(n)) bound.push(n);
      expected[type] = javaHashMapOrder(bound, bound.length);
    }
    expect(surface).toEqual(expected);
  });
});

const surfaceLua = (s: Record<string, string[]>) =>
  JSON.stringify(s)
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/"([\w:]+)":/g, '["$1"] =');

const allTypesWorld = (formed: boolean): WorldConfig =>
  ({
    peripherals: [...Object.keys(SOURCE), ...Object.keys(SINGLES)].map(
      (type) => ({ name: `p_${type}`, type, formed }),
    ),
  }) as unknown as WorldConfig;

describe.skipIf(!ready)("multiblock method surface", () => {
  for (const formed of [true, false]) {
    it(`every block has exactly these methods in this order (${formed ? "formed" : "unformed"})`, async () => {
      const result = await lua(
        `
local expected = ${surfaceLua(surface)}
for ty in pairs(${surfaceLua(Object.fromEntries([...Object.keys(SOURCE), ...Object.keys(SINGLES)].map((k) => [k, []])))}) do
  ccunit.test(ty, function()
    local names = expected[ty .. ":unformed"] and ${formed ? "expected[ty]" : 'expected[ty .. ":unformed"]'} or expected[ty]
    ccunit.eq(peripheral.getMethods("p_" .. ty), names)
    ccunit.eq({ peripheral.getType("p_" .. ty) }, { ty })
    ccunit.truthy(peripheral.find(ty), "find " .. ty)
  end)
end
`,
        allTypesWorld(formed),
        `surface-${formed}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);
  }
});

// ───────────── fission reactor ─────────────

describe.skipIf(!ready)(
  "fission reactor: readings, arguments and errors",
  () => {
    it("answers like the source", async () => {
      const result = await lua(
        `
local r = peripheral.wrap("adapter")
local port = peripheral.wrap("port")
ccunit.test("readings of a cold 5x5x5 reactor", function()
  ccunit.eq(r.isFormed(), true)
  ccunit.eq(r.getStatus(), false)
  ccunit.eq(r.getTemperature(), 300)
  ccunit.eq(r.getHeatCapacity(), 98000) -- 1000 per shell block, 125 - 27
  ccunit.eq(r.getFuel(), { name = "mekanism:fissile_fuel", amount = 1000 })
  ccunit.eq(r.getFuelCapacity(), 64000) -- 8000 per assembly
  ccunit.eq(r.getFuelNeeded(), 63000)
  near(r.getFuelFilledPercentage(), 1000 / 64000)
  ccunit.eq(r.getWaste(), { name = "mekanism:empty", amount = 0 })
  ccunit.eq(r.getWasteFilledPercentage(), 0)
  ccunit.eq(r.getCoolant(), { name = "minecraft:water", amount = 1000000 })
  ccunit.eq(r.getCoolantCapacity(), 12500000)
  ccunit.eq(r.getCoolantNeeded(), 11500000)
  ccunit.eq(r.getHeatedCoolant(), { name = "mekanism:empty", amount = 0 })
  ccunit.eq(r.getHeatedCoolantCapacity(), 125000000)
  ccunit.eq(r.getFuelAssemblies(), 8)
  ccunit.eq(r.getFuelSurfaceArea(), 40)
  ccunit.eq(r.getBoilEfficiency(), 1)
  ccunit.eq(r.getMaxBurnRate(), 8)
  ccunit.eq(r.getBurnRate(), 0.1)
  ccunit.eq(r.getActualBurnRate(), 0)
  ccunit.eq(r.getDamagePercent(), 0)
  ccunit.eq(r.isForceDisabled(), false)
  ccunit.eq(r.getEnvironmentalLoss(), 0)
  ccunit.eq(r.getHeatingRate(), 0)
  ccunit.eq({ r.getLength(), r.getWidth(), r.getHeight() }, { 5, 5, 5 })
  ccunit.eq(r.getMinPos(), { x = 0, y = 64, z = 0 })
  ccunit.eq(r.getMaxPos(), { x = 4, y = 68, z = 4 })
  ccunit.eq(r.getLogicMode(), "DISABLED")
  ccunit.eq(r.getRedstoneLogicStatus(), "IDLE")
  ccunit.eq(r.getRedstoneMode(), "DISABLED")
end)

ccunit.test("activate and scram", function()
  ccunit.eq(err(r.scram), "Scram requires the reactor to be active.")
  ccunit.eq(select("#", r.activate()), 0) -- void: no values
  ccunit.eq(r.getStatus(), true)
  ccunit.eq(err(r.activate), "Reactor is already active.")
  ccunit.eq(select("#", r.scram()), 0)
  ccunit.eq(r.getStatus(), false)
end)

ccunit.test("burn rate: two decimals, the range check's broken format", function()
  r.setBurnRate(1.239)
  ccunit.eq(r.getBurnRate(), 1.23)
  r.setBurnRate(8)
  ccunit.eq(r.getBurnRate(), 8)
  r.setBurnRate(-0.001) -- truncates to 0
  ccunit.eq(r.getBurnRate(), 0)
  r.setBurnRate(0 / 0) -- NaN: (long) NaN is 0
  ccunit.eq(r.getBurnRate(), 0)
  ccunit.eq(err(r.setBurnRate, 8.01), "d != java.lang.Double")
  ccunit.eq(err(r.setBurnRate, -1), "d != java.lang.Double")
  ccunit.eq(err(r.setBurnRate, "2"), "Invalid argument 0, setBurnRate expected double but received type String with value 2.")
  ccunit.eq(err(r.setBurnRate), "Mismatched parameter count. setBurnRate expected: '1' arguments, but received: '0' arguments.")
  ccunit.eq(err(r.setBurnRate, nil), "Invalid argument 0, setBurnRate expected double but received null.")
  ccunit.eq(err(r.getStatus, 1), "Mismatched parameter count. getStatus expected: '0' arguments, but received: '1' arguments.")
end)

ccunit.test("logic and redstone modes", function()
  r.setLogicMode("temperature")
  ccunit.eq(r.getLogicMode(), "TEMPERATURE")
  r.setLogicMode(5)
  ccunit.eq(r.getLogicMode(), "DEPLETED")
  ccunit.eq(err(r.setLogicMode, "boom"), "Invalid argument 0, setLogicMode expected FissionReactorLogic but received type String with value boom.")
  ccunit.eq(err(r.setLogicMode, 6), "Invalid argument 0, setLogicMode expected FissionReactorLogic but received type Double with value 6.0.")
  r.setRedstoneMode("high")
  ccunit.eq(r.getRedstoneMode(), "HIGH")
  ccunit.eq(err(r.setRedstoneMode, "PULSE"), "Unsupported redstone control mode: PULSE")
  ccunit.eq(r.getRedstoneMode(), "HIGH")
end)

ccunit.test("port modes cycle", function()
  ccunit.eq(port.getMode(), "INPUT")
  port.incrementMode()
  ccunit.eq(port.getMode(), "OUTPUT_WASTE")
  port.incrementMode()
  port.incrementMode()
  ccunit.eq(port.getMode(), "INPUT")
  port.decrementMode()
  ccunit.eq(port.getMode(), "OUTPUT_COOLANT")
  port.setMode("output_waste")
  ccunit.eq(port.getMode(), "OUTPUT_WASTE")
  ccunit.eq(err(port.setMode, 3), "Invalid argument 0, setMode expected FissionPortMode but received type Double with value 3.0.")
  ccunit.eq(port.getStatus, nil) -- the port does not expose the reactor
  ccunit.eq(port.isFormed, nil)
end)
`,
        reactorWorld(),
        "fission-readings.test.lua",
      );
      expectAllPassed(result);
    }, 90000);

    it("waits a server tick and eats events; bad arguments fail at once", async () => {
      const result = await lua(
        `
local function survives(fn)
  os.queueEvent("probe_before")
  pcall(fn)
  os.queueEvent("probe_after")
  local kept = false
  while true do
    local ev = os.pullEvent()
    if ev == "probe_before" then kept = true end
    if ev == "probe_after" then break end
  end
  return kept
end
ccunit.test("main thread", function()
  local r = peripheral.wrap("adapter")
  ccunit.eq(survives(function() r.getTemperature() end), false)
  ccunit.eq(survives(function() r.scram() end), false) -- the state check runs on the server thread
  ccunit.eq(survives(function() r.setBurnRate("x") end), true)
  ccunit.eq(survives(function() r.getTemperature(1) end), true)
  ccunit.eq(survives(function() peripheral.call("port", "getMode") end), false)
  local t0 = os.clock()
  for _ = 1, 4 do r.getStatus() end
  ccunit.truthy(os.clock() - t0 >= 0.2, "four calls take four ticks")
end)
`,
        reactorWorld(),
        "fission-timing.test.lua",
      );
      expectAllPassed(result);
    }, 60000);
  },
);

/** FissionReactorMultiblockData.tick with water coolant, in TypeScript, for the default 5x5x5 reactor. */
function fissionModel(
  ticks: number,
  o: { fuel: number; water: number; rate: number },
) {
  const C = 98_000;
  let heat = C * 300;
  let fuel = o.fuel,
    water = o.water,
    steam = 0,
    waste = 0,
    burnRemaining = 0,
    partialWaste = 0,
    damage = 0;
  let lastBoil = 0,
    lastBurn = 0,
    envLoss = 0;
  for (let i = 0; i < ticks; i++) {
    let pending = 0;
    // burnFuel
    let stored = fuel + burnRemaining;
    const toBurn = Math.min(Math.min(o.rate, stored), 8);
    stored -= toBurn;
    fuel = Math.trunc(stored);
    burnRemaining = stored % 1;
    pending += toBurn * 1_000_000;
    partialWaste += toBurn;
    const newWaste = Math.floor(partialWaste);
    if (newWaste > 0) {
      partialWaste %= 1;
      waste += Math.min(newWaste, 64_000 - waste);
    }
    lastBurn = toBurn;
    // handleCoolant
    const temp = heat / C;
    const h = (temp - 373.15) * C;
    let heated = 0;
    if (water > 0) {
      heated = Math.trunc((0.2 * h * 0.5) / 10);
      heated = Math.max(0, Math.min(heated, water));
      if (heated > 0) {
        water -= heated;
        steam += heated;
        pending -= (heated * 10) / 0.2;
      }
    }
    lastBoil = heated;
    // simulateEnvironment
    const t = (temp - 300) / 20_010;
    pending -= t * C;
    envLoss = Math.max(t, 0);
    heat += pending;
    const temp2 = heat / C;
    if (temp2 > 1200) damage += Math.min(temp2, 1800) / 12_000;
    else damage = Math.max(0, damage - (1200 - temp2) / 120_000);
  }
  return {
    temperature: heat / C,
    fuel,
    water,
    steam,
    waste,
    damage,
    lastBoil,
    lastBurn,
    envLoss,
  };
}

describe.skipIf(!ready)("fission reactor on the virtual clock", () => {
  it("burns fuel, makes waste and steam, heats up, tick for tick like the source", async () => {
    await withSession(
      reactorWorld({ burnRate: 8, active: true }),
      async (step) => {
        for (const seconds of [0.5, 2, 5]) {
          const state = await step({ cmd: "advance", seconds });
          const s = mbState(state, "mekanism-generators", "reactor");
          const m = fissionModel(gameTime(state, "mekanism-generators") + 1, {
            fuel: 1000,
            water: 1_000_000,
            rate: 8,
          });
          expect(s.temperature).toBeCloseTo(m.temperature, 6);
          expect(s.fuel?.amount ?? 0).toBe(m.fuel);
          expect(s.waste?.amount ?? 0).toBe(m.waste);
          expect(s.coolant?.amount ?? 0).toBe(m.water);
          expect(s.heatedCoolant?.amount ?? 0).toBe(m.steam);
          expect(s.damage).toBeCloseTo(m.damage, 9);
          expect(s.heatingRate).toBe(m.lastBoil);
          expect((s.fuel?.amount ?? 0) + (s.waste?.amount ?? 0)).toBe(1000);
        }
        const s = mbState(
          await step({ cmd: "advance", seconds: 0.05 }),
          "mekanism-generators",
          "reactor",
        );
        expect(s.fuel).toBeUndefined(); // 1000 mB at 8 mB/t is gone after 125 ticks
        expect(s.actualBurnRate).toBe(0);
        expect(s.active).toBe(true);
      },
    );
  }, 120000);

  it("melts down when left hot: damage climbs, then the structure goes and its blocks detach", async () => {
    await withSession(
      {
        ...reactorWorld({
          burnRate: 8,
          active: true,
          coolant: 0,
          fuel: 64000,
          seed: 3,
        }),
      } as WorldConfig,
      async (step) => {
        let s = mbState(
          await step({ cmd: "advance", seconds: 2 }),
          "mekanism-generators",
          "reactor",
        );
        expect(s.temperature).toBeGreaterThan(1200);
        let destroyed = false;
        for (let i = 0; i < 60 && !destroyed; i++) {
          const state = await step({ cmd: "advance", seconds: 10 });
          s = mbState(state, "mekanism-generators", "reactor");
          destroyed = s.destroyed === true;
          if (!destroyed) expect(s.damage).toBeGreaterThan(0);
        }
        expect(destroyed).toBe(true);
        expect(s.meltdowns).toBe(1);
        expect(s.damage).toBe(75); // fissionPostMeltdownDamage
        expect(s.active).toBe(false);
        expect(s.formed).toBe(false);
        expect(s.waste).toBeUndefined(); // the radioactive waste went into the air
        expect(s.radiated).toBeGreaterThan(0);
        const state = await step({ cmd: "advance", seconds: 0.05 });
        expect(state.peripherals?.["adapter"]).toBeUndefined();
      },
    );
  }, 300000);

  it("with meltdowns off the reactor force-disables itself and stays off until it is safe", async () => {
    const w = reactorWorld({
      burnRate: 8,
      active: true,
      coolant: 0,
      fuel: 64000,
      temperature: 1800,
      damage: 99.9,
    }) as any;
    w.mekanism.config = {
      fissionMeltdownsEnabled: false,
      fissionMeltdownChance: 1,
    };
    const result = await lua(
      `
ccunit.test("force disabled", function()
  local r = peripheral.wrap("adapter")
  sleep(0.2)
  ccunit.eq(r.isForceDisabled(), true)
  ccunit.eq(r.getStatus(), false)
  ccunit.truthy(r.getDamagePercent() >= 100)
  ccunit.eq(err(r.activate), "Reactor must reach safe damage and temperature levels before it can be reactivated.")
end)
`,
      w,
      "fission-forcedisable.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("logic adapter: Activation follows redstone, status outputs; sim commands set fixtures", async () => {
    const w = reactorWorld({}) as any;
    w.peripherals[0].logicMode = "ACTIVATION";
    await withSession(w, async (step) => {
      let state = await step({
        cmd: "mekSetRedstone",
        peripheral: "adapter",
        powered: true,
      });
      expect(mbState(state, "mekanism-generators", "reactor").active).toBe(
        true,
      );
      expect((state.peripherals?.["adapter"] as any).redstoneStatus).toBe(
        "POWERED",
      );
      state = await step({
        cmd: "mekSetRedstone",
        peripheral: "adapter",
        powered: false,
      });
      expect(mbState(state, "mekanism-generators", "reactor").active).toBe(
        false,
      );
      state = await step({
        cmd: "mekSet",
        multiblock: "reactor",
        fuel: 0,
        temperature: 900,
        damage: 40,
      });
      let s = mbState(state, "mekanism-generators", "reactor");
      expect(s.fuel).toBeUndefined();
      expect(s.temperature).toBe(900);
      expect(s.damage).toBe(40);
      state = await step({ cmd: "advance", seconds: 0.5 });
      s = mbState(state, "mekanism-generators", "reactor");
      expect(s.temperature).toBeLessThan(900); // the water takes the heat
      expect(s.damage).toBeLessThan(40); // below 1200 K it repairs
      state = await step({
        cmd: "mekAddTank",
        peripheral: "adapter",
        tank: "fuel",
        amount: 500,
      });
      expect(mbState(state, "mekanism-generators", "reactor").fuel).toEqual({
        name: "mekanism:fissile_fuel",
        amount: 500,
      });
      state = await step({
        cmd: "mekAddTank",
        multiblock: "reactor",
        tank: "fuel",
        amount: -200,
      });
      expect(mbState(state, "mekanism-generators", "reactor").fuel.amount).toBe(
        300,
      );
      state = await step({
        cmd: "mekSet",
        multiblock: "reactor",
        fuelInput: 10,
      });
      state = await step({ cmd: "advance", seconds: 1 });
      expect(
        mbState(state, "mekanism-generators", "reactor").fuel.amount,
      ).toBeGreaterThanOrEqual(300 + 10 * 19);
    });
  }, 90000);

  it("waste leaves only through a port in OUTPUT_WASTE", async () => {
    await withSession(
      reactorWorld({ waste: 5000, wasteOutput: 100 }),
      async (step) => {
        const s = mbState(
          await step({ cmd: "advance", seconds: 0.5 }),
          "mekanism-generators",
          "reactor",
        );
        expect(s.waste.amount).toBe(5000); // the only port is on INPUT
      },
    );
    const result = await lua(
      `
ccunit.test("output waste", function()
  local port = peripheral.wrap("port")
  local r = peripheral.wrap("adapter")
  port.setMode("OUTPUT_WASTE")
  local before = r.getWaste().amount
  sleep(0.5)
  local after = r.getWaste().amount
  ccunit.truthy(before - after >= 800, ("%d -> %d"):format(before, after))
  ccunit.eq((before - after) % 100, 0)
end)
`,
      reactorWorld({ waste: 5000, wasteOutput: 100 }),
      "fission-waste.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("unforming detaches and attaches the adapter with the tile's methods only; the port stays", async () => {
    const result = await lua(
      `
ccunit.test("unform and form", function()
  local r = peripheral.wrap("adapter")
  ccunit.eq(#peripheral.getMethods("adapter"), 43)
  ccunit.eq(#peripheral.getMethods("port"), 4)
end)
`,
      reactorWorld(),
      "fission-form.test.lua",
    );
    expectAllPassed(result);
    await withSession(reactorWorld(), async (step) => {
      let state = await step({
        cmd: "mekSetFormed",
        multiblock: "reactor",
        formed: false,
      });
      expect(mbState(state, "mekanism-generators", "reactor").formed).toBe(
        false,
      );
      expect((state.peripherals?.["adapter"] as any).formed).toBe(false);
      state = await step({ cmd: "advance", seconds: 1 });
      expect(mbState(state, "mekanism-generators", "reactor").temperature).toBe(
        300,
      );
      state = await step({
        cmd: "mekSetFormed",
        peripheral: "port",
        formed: true,
      });
      expect(mbState(state, "mekanism-generators", "reactor").formed).toBe(
        true,
      );
    });
  }, 90000);
});

describe.skipIf(!ready)(
  "fission reactor: formation events seen by a program",
  () => {
    it("a program gets peripheral_detach then peripheral, and the method list shrinks", async () => {
      const manager = new SessionManager(config);
      put(
        "watch.lua",
        `
local evs = {}
while #evs < 2 do
  local ev, name = os.pullEvent()
  if ev == "peripheral" or ev == "peripheral_detach" then evs[#evs + 1] = ev .. " " .. name end
end
print(table.concat(evs, " "))
print("N=" .. #peripheral.getMethods("adapter") .. " F=" .. tostring(peripheral.call("adapter", "isFormed")))
local ok, e = pcall(peripheral.call, "adapter", "getStatus")
print(tostring(e))
print("DONE")
`,
      );
      const s = manager.create([], 1, reactorWorld());
      try {
        const term = s.handle.session;
        await term.waitForText(">", 0, 20000);
        term.typeLine("watch");
        await new Promise((r) => setTimeout(r, 500));
        expect(
          await sendAndWait(s.handle, {
            cmd: "mekSetFormed",
            multiblock: "reactor",
            formed: false,
          } as unknown as SimCommand),
        ).toBe(true);
        await term.waitForText("DONE", 0, 10000);
        const text = term.screen()!.lines.join("\n");
        expect(text).toContain("peripheral_detach adapter peripheral adapter");
        expect(text).toContain("N=6 F=false");
        expect(text).toContain("No such method getStatus");
      } finally {
        await manager.destroyAll();
      }
    }, 60000);
  },
);

// ───────────── turbine ─────────────

const turbineWorld = (extra: Record<string, unknown> = {}): WorldConfig =>
  ({
    peripherals: [
      { name: "valve", type: "turbineValve", multiblock: "turbine" },
    ],
    mekanism: {
      multiblocks: { turbine: { kind: "turbine", steam: 1_000_000, ...extra } },
    },
  }) as unknown as WorldConfig;

describe.skipIf(!ready)("industrial turbine", () => {
  it("readings, flow and production from steam", async () => {
    const result = await lua(
      `
local v = peripheral.wrap("valve")
ccunit.test("shape and limits", function()
  ccunit.eq(v.isFormed(), true)
  ccunit.eq({ v.getLength(), v.getWidth(), v.getHeight() }, { 5, 5, 9 })
  ccunit.eq(v.getBlades(), 6)
  ccunit.eq(v.getCoils(), 2)
  ccunit.eq(v.getVents(), 12)
  ccunit.eq(v.getCondensers(), 0)
  ccunit.eq(v.getDispersers(), 8)
  ccunit.eq(v.getSteamCapacity(), 6400000) -- lowerVolume 100 * 64000
  ccunit.eq(v.getMaxFlowRate(), 384000) -- min(100 * 8 * 1280, 12 * 32000)
  ccunit.eq(v.getMaxWaterOutput(), 0)
  near(v.getMaxProduction(), 2.1426 * 384000) -- 10 / 28 = 0.3571, times min(6 blades, 2 coils * 4)
  ccunit.eq(v.getMaxEnergy(), 225 * 16000000)
  ccunit.eq(v.getDumpingMode(), "IDLE")
end)
ccunit.test("spinning", function()
  sleep(0.1)
  local stored = v.getSteam().amount
  ccunit.truthy(stored < 1000000)
  ccunit.truthy(v.getFlowRate() > 0)
  ccunit.truthy(v.getProductionRate() > 0)
  ccunit.truthy(v.getEnergy() > 0)
  local level = v.getComparatorLevel()
  ccunit.truthy(level >= 1 and level <= math.floor(stored / 6400000 * 14) + 1)
  near(v.getEnergyFilledPercentage(), v.getEnergy() / v.getMaxEnergy(), 1e-2)
  ccunit.eq(v.getEnergyNeeded() > 0, true)
end)
ccunit.test("dumping modes", function()
  v.setDumpingMode("DUMPING")
  ccunit.eq(v.getDumpingMode(), "DUMPING")
  v.incrementDumpingMode()
  ccunit.eq(v.getDumpingMode(), "IDLE")
  v.decrementDumpingMode()
  ccunit.eq(v.getDumpingMode(), "DUMPING")
  local before = v.getSteam().amount
  sleep(1)
  ccunit.truthy(v.getSteam().amount < before * 0.6) -- 2% a tick on top of what the blades take
  ccunit.eq(err(v.setDumpingMode, "dump"), "Invalid argument 0, setDumpingMode expected GasMode but received type String with value dump.")
end)
`,
      turbineWorld(),
      "turbine.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("spins up tick for tick like TurbineMultiblockData.tick; steam input counts a tick later", async () => {
    await withSession(turbineWorld({ steamInput: 50_000 }), async (step) => {
      for (const seconds of [0.1, 1, 3]) {
        const state = await step({ cmd: "advance", seconds });
        const s = mbState(state, "mekanism-generators", "turbine");
        const m = turbineModel(gameTime(state, "mekanism-generators") + 1, {
          steam: 1_000_000,
          input: 50_000,
        });
        expect(s.steam?.amount ?? 0).toBe(m.steam);
        expect(s.flowRate).toBe(m.flow);
        expect(s.energy).toBeCloseTo(m.energy, 3);
        expect(s.lastSteamInput).toBe(m.lastIn);
        expect(s.productionRate).toBeCloseTo(fl(2.1426 * m.flow), 3);
      }
    });
  }, 60000);
});

// ───────────── boiler ─────────────

describe.skipIf(!ready)("thermoelectric boiler", () => {
  it("boils water with heat, cools superheated sodium, valve modes", async () => {
    const result = await lua(
      `
local b = peripheral.wrap("boiler")
ccunit.test("readings", function()
  ccunit.eq(b.isFormed(), true)
  ccunit.eq(b.getSuperheaters(), 4)
  ccunit.eq(b.getBoilCapacity(), 1280000) -- 4 * 16e6 / 10 * 0.2
  ccunit.eq(b.getWaterCapacity(), 18 * 16000)
  ccunit.eq(b.getSteamCapacity(), 9 * 160000)
  ccunit.eq(b.getHeatedCoolantCapacity(), 18 * 256000)
  ccunit.eq(b.getCooledCoolantCapacity(), 9 * 256000)
  ccunit.eq(b.getHeatedCoolant(), { name = "mekanism:empty", amount = 0 })
  ccunit.eq(b.getWater().name, "minecraft:water")
  ccunit.eq(b.getMode(), "INPUT")
end)
ccunit.test("boiling", function()
  sleep(0.2)
  ccunit.truthy(b.getBoilRate() > 0)
  ccunit.truthy(b.getSteam().amount > 0)
  ccunit.truthy(b.getTemperature() > 373.15)
  ccunit.truthy(b.getMaxBoilRate() >= b.getBoilRate())
  ccunit.truthy(b.getEnvironmentalLoss() > 0)
end)
ccunit.test("modes", function()
  b.incrementMode()
  ccunit.eq(b.getMode(), "OUTPUT_STEAM")
  b.setMode("OUTPUT_COOLANT")
  b.incrementMode()
  ccunit.eq(b.getMode(), "INPUT")
  ccunit.eq(err(b.setMode, "x"), "Invalid argument 0, setMode expected BoilerValveMode but received type String with value x.")
end)
`,
      {
        peripherals: [
          { name: "boiler", type: "boilerValve", multiblock: "boiler" },
        ],
        mekanism: {
          multiblocks: {
            boiler: {
              kind: "boiler",
              superheaters: 4,
              water: 200_000,
              temperature: 900,
              waterVolume: 18,
              steamVolume: 9,
              heatInput: 1_000_000,
              waterInput: 50_000,
              steamOutput: 100_000,
            },
          },
        },
      } as unknown as WorldConfig,
      "boiler.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── induction matrix ─────────────

const matrixWorld = (extra: Record<string, unknown> = {}): WorldConfig =>
  ({
    peripherals: [
      { name: "matrix", type: "inductionPort", multiblock: "matrix" },
    ],
    mekanism: {
      multiblocks: {
        matrix: {
          kind: "matrix",
          cells: { ultimate: 1 },
          providers: { basic: 1 },
          energy: 1e9,
          ...extra,
        },
      },
    },
  }) as unknown as WorldConfig;

describe.skipIf(!ready)("induction matrix", () => {
  it("stores, rate-limits and reports input and output; the port mode gates output", async () => {
    const result = await lua(
      `
local m = peripheral.wrap("matrix")
ccunit.test("readings", function()
  ccunit.eq(m.getMaxEnergy(), 4e12)
  ccunit.eq(m.getTransferCap(), 256000)
  ccunit.eq(m.getInstalledCells(), 1)
  ccunit.eq(m.getInstalledProviders(), 1)
  ccunit.eq(m.getInputItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(m.getMode(), false)
  ccunit.eq(m.getComparatorLevel(), 1)
end)
ccunit.test("input flows through the input-mode port, output waits for output mode", function()
  sleep(0.2)
  ccunit.eq(m.getLastInput(), 256000) -- 300000 offered, the provider takes 256000 a tick
  ccunit.eq(m.getLastOutput(), 0)
  m.setMode(true)
  sleep(0.2)
  ccunit.eq(m.getLastInput(), 0)
  ccunit.eq(m.getLastOutput(), 50000)
  local e1 = m.getEnergy()
  sleep(0.5)
  ccunit.truthy(m.getEnergy() < e1)
  ccunit.truthy(math.abs(m.getEnergyNeeded() + m.getEnergy() - m.getMaxEnergy()) <= 100000) -- a tick apart
  near(m.getEnergyFilledPercentage(), m.getEnergy() / 4e12, 1e-3)
  ccunit.eq(err(m.setMode, "yes"), "Invalid argument 0, setMode expected boolean but received type String with value yes.")
end)
`,
      matrixWorld({ input: 300_000, output: 50_000 }),
      "matrix.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("with no port peripheral, the fixture's cables flow both ways", async () => {
    await withSession(
      {
        peripherals: [],
        mekanism: {
          multiblocks: {
            matrix: {
              kind: "matrix",
              cells: 2,
              providers: { elite: 1 },
              input: 100_000,
              output: 30_000,
            },
          },
        },
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 1 });
        const s = mbState(state, "mekanism-machines", "matrix");
        expect(s.maxEnergy).toBe(16e9);
        expect(s.transferCap).toBe(16_384_000);
        expect(s.lastInput).toBe(100_000);
        expect(s.lastOutput).toBe(30_000);
        // the last tick's transfers are queued: stored + queued = 70000 per tick so far
        expect(s.energy).toBe(
          70_000 * (gameTime(state, "mekanism-machines") + 1),
        );
      },
    );
  }, 60000);
});

// ───────────── fusion ─────────────

const fusionWorld = (extra: Record<string, unknown> = {}): WorldConfig =>
  ({
    peripherals: [
      {
        name: "fusion",
        type: "fusionReactorLogicAdapter",
        multiblock: "fusion",
      },
      {
        name: "fport",
        type: "fusionReactorPort",
        multiblock: "fusion",
        mode: "output",
      },
    ],
    mekanism: {
      multiblocks: {
        fusion: {
          kind: "fusion",
          deuterium: 1000,
          tritium: 1000,
          water: 1_000_000,
          ...extra,
        },
      },
    },
  }) as unknown as WorldConfig;

describe.skipIf(!ready)("fusion reactor", () => {
  it("formulas, injection rate checks, logic adapter", async () => {
    const result = await lua(
      `
local f = peripheral.wrap("fusion")
local p = peripheral.wrap("fport")
ccunit.test("formulas from FusionReactorMultiblockData", function()
  ccunit.eq(f.getInjectionRate(), 2)
  ccunit.eq(f.getMinInjectionRate(false), 2)
  ccunit.eq(f.getMinInjectionRate(true), 2)
  near(f.getIgnitionTemperature(false), 1e8 * 1e7 * 0.3 / (1e7 * 0.3 - 0.2 * 0.1))
  near(f.getMaxPlasmaTemperature(false), 2 * 1e7 / 0.2 * 0.3 / 0.1)
  near(f.getMaxPlasmaTemperature(true), 2 * 1e7 / 0.2 * 0.6 / 0.4)
  near(f.getMaxCasingTemperature(false), 2e8)
  near(f.getMaxCasingTemperature(true), 5e7)
  near(f.getPassiveGeneration(false), 0.05 * 0.1 * 2e8)
  near(f.getProductionRate(), 0.05 * 0.1 * 2e8)
  ccunit.eq(f.getPlasmaTemperature(), 300)
  ccunit.eq(f.getCaseTemperature(), 300)
  ccunit.eq(f.getDeuterium(), { name = "mekanismgenerators:deuterium", amount = 1000 })
  ccunit.eq(f.getDTFuel(), { name = "mekanism:empty", amount = 0 })
  ccunit.eq(f.getDTFuelCapacity(), 1000)
  ccunit.eq(f.getWaterCapacity(), 2000000)
  ccunit.eq(f.getSteamCapacity(), 200000000)
  ccunit.eq(f.getHohlraum(), { name = "minecraft:air", count = 0 })
  ccunit.eq(p.getMaxEnergy(), 1e9)
  ccunit.eq(p.getMode(), true)
end)
ccunit.test("setInjectionRate", function()
  f.setInjectionRate(10)
  ccunit.eq(f.getInjectionRate(), 10)
  ccunit.eq(f.getWaterCapacity(), 10000000)
  ccunit.eq(err(f.setInjectionRate, 99), "Injection Rate '99' is out of range must be an even number between 0 and 98. (Inclusive)")
  ccunit.eq(err(f.setInjectionRate, 7), "Injection Rate '7' must be an even number between 0 and 98. (Inclusive)")
  ccunit.eq(err(f.setInjectionRate, -2), "Injection Rate '-2' is out of range must be an even number between 0 and 98. (Inclusive)")
  ccunit.eq(err(f.getMinInjectionRate, 1), "Invalid argument 0, getMinInjectionRate expected boolean but received type Double with value 1.0.")
  f.setInjectionRate(2.9) -- an int argument truncates
  ccunit.eq(f.getInjectionRate(), 2)
end)
ccunit.test("logic adapter", function()
  ccunit.eq(f.getLogicMode(), "DISABLED")
  f.setLogicMode("ready")
  ccunit.eq(f.getLogicMode(), "READY")
  ccunit.eq(f.isActiveCooledLogic(), false)
  f.setActiveCooledLogic(true)
  ccunit.eq(f.isActiveCooledLogic(), true)
end)
`,
      fusionWorld(),
      "fusion.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("ignites with laser heat and a hohlraum, burns D-T, boils water, makes energy", async () => {
    await withSession(
      fusionWorld({ hohlraum: true, deuteriumInput: 10, tritiumInput: 10 }),
      async (step) => {
        let state = await step({
          cmd: "mekFusionLaser",
          multiblock: "fusion",
          energy: 1e9,
        });
        let s = mbState(state, "mekanism-generators", "fusion");
        expect(s.plasmaTemperature).toBeGreaterThan(1e8 - 1e6);
        state = await step({ cmd: "advance", seconds: 1 });
        s = mbState(state, "mekanism-generators", "fusion");
        expect(s.burning).toBe(true);
        expect(s.hohlraum).toBeUndefined();
        expect(s.caseTemperature).toBeGreaterThan(300);
        state = await step({ cmd: "advance", seconds: 20 });
        s = mbState(state, "mekanism-generators", "fusion");
        expect(s.burning).toBe(true);
        expect(s.steam.amount).toBeGreaterThan(0);
        expect(s.water?.amount ?? 0).toBeLessThan(1_000_000); // vaporized faster than 10 mB/t comes in
      },
    );
  }, 120000);
});

// ───────────── chains ─────────────

describe.skipIf(!ready)(
  "a power plant: sodium reactor -> boiler -> turbine -> matrix",
  () => {
    it("heat flows down the chain and the matrix fills", async () => {
      await withSession(
        {
          peripherals: [
            { name: "matrix", type: "inductionPort", multiblock: "matrix" },
          ],
          mekanism: {
            multiblocks: {
              a_reactor: {
                kind: "fission",
                fuel: 64000,
                coolant: { name: "mekanism:sodium", amount: 5_000_000 },
                burnRate: 4,
                active: true,
                heatedCoolantTo: "b_boiler",
              },
              b_boiler: {
                kind: "boiler",
                length: 7,
                width: 7,
                height: 9,
                waterVolume: 50,
                steamVolume: 75,
                superheaters: 10,
                water: 800_000,
                waterInput: 40_000,
                steamTo: "c_turbine",
                cooledCoolantTo: "a_reactor",
              },
              c_turbine: {
                kind: "turbine",
                length: 7,
                width: 7,
                height: 13,
                blades: 10,
                coils: 3,
                vents: 30,
                energyTo: "d_matrix",
              },
              d_matrix: {
                kind: "matrix",
                cells: { elite: 1 },
                providers: { ultimate: 1 },
              },
            },
          },
        } as unknown as WorldConfig,
        async (step) => {
          const state = await step({ cmd: "advance", seconds: 10 });
          const reactor = mbState(state, "mekanism-generators", "a_reactor");
          const turbine = mbState(state, "mekanism-generators", "c_turbine");
          const boiler = mbState(state, "mekanism-machines", "b_boiler");
          const matrix = mbState(state, "mekanism-machines", "d_matrix");
          expect(reactor.actualBurnRate).toBe(4);
          // the sodium goes round: reactor -> boiler (heated) -> boiler (cooled) -> reactor
          const sodium = (t?: { amount: number }) => t?.amount ?? 0;
          expect(
            sodium(reactor.gasCoolant) +
              sodium(reactor.heatedCoolant) +
              sodium(boiler.heatedCoolant) +
              sodium(boiler.cooledCoolant),
          ).toBe(5_000_000);
          expect(reactor.gasCoolant.amount).toBeGreaterThan(0);
          expect(reactor.temperature).toBeLessThan(1200);
          expect(boiler.boilRate).toBeGreaterThan(0);
          expect(turbine.flowRate).toBeGreaterThan(0);
          expect(matrix.energy).toBeGreaterThan(0);
          expect(matrix.lastInput).toBeGreaterThan(0);
        },
      );
    }, 120000);
  },
);

// ───────────── worlds and addons ─────────────

describe.skipIf(!ready)("demo world and addons", () => {
  it("the demo world loads and answers", async () => {
    const result = await lua(
      `
ccunit.test("demo", function()
  for _, ty in ipairs({ "fissionReactorLogicAdapter", "fissionReactorPort", "turbineValve", "boilerValve", "inductionPort",
      "fusionReactorLogicAdapter", "fusionReactorPort", "eliteEnergyCube", "ultimateFluidTank", "basicChemicalTank",
      "enrichmentChamber", "electrolyticSeparator", "solarGenerator", "advancedSolarGenerator", "windGenerator", "heatGenerator",
      "bioGenerator", "gasBurningGenerator" }) do
    ccunit.truthy(peripheral.find(ty), ty)
  end
  ccunit.eq(peripheral.find("fissionReactorLogicAdapter").isFormed(), true)
end)
`,
      loadNamedWorld(
        join(fileURLToPath(new URL("../../..", import.meta.url)), "worlds"),
        "mekanism-multiblocks-demo",
      ),
      "demo.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("an hour of the demo plant catches up quickly", async () => {
    const demo = loadNamedWorld(
      join(fileURLToPath(new URL("../../..", import.meta.url)), "worlds"),
      "mekanism-multiblocks-demo",
    );
    await withSession(demo, async (step) => {
      const t0 = Date.now();
      const state = await step({ cmd: "advance", seconds: 3600 });
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(gameTime(state, "")).toBeGreaterThanOrEqual(72_000 - 1);
      const matrix = mbState(state, "", "matrix");
      expect(matrix.lastOutput).toBe(1_000_000);
    });
  }, 120000);

  it("fails cleanly with the addon off", async () => {
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        { ...reactorWorld(), addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(
      /fissionReactorLogicAdapter from Mekanism Generators \(addon "mekanism-generators"\)/,
    );
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        {
          peripherals: [{ name: "m", type: "inductionPort" }],
          addons: ["mekanism-generators"],
        } as unknown as WorldConfig,
        "off2.test.lua",
      ),
    ).rejects.toThrow(/needs mekanism/);
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        {
          peripherals: [{ name: "m", type: "inductionPort" }],
          addons: "none",
        } as unknown as WorldConfig,
        "off3.test.lua",
      ),
    ).rejects.toThrow(/inductionPort from Mekanism \(addon "mekanism"\)/);
  }, 60000);

  it("a world with Mekanism but not Generators keeps its matrix and refuses a fission multiblock", async () => {
    const result = await lua(
      `
ccunit.test("matrix only", function()
  ccunit.eq(peripheral.wrap("matrix").getMaxEnergy(), 4e12)
end)
`,
      { ...matrixWorld(), addons: ["mekanism"] } as WorldConfig,
      "mek-only.test.lua",
    );
    expectAllPassed(result);
    const bad = await lua(
      `ccunit.test("x", function() error("show the terminal") end)`,
      {
        peripherals: [],
        addons: ["mekanism"],
        mekanism: { multiblocks: { r: { kind: "fission" } } },
      } as unknown as WorldConfig,
      "mek-only-bad.test.lua",
    );
    expect(JSON.stringify(bad)).toMatch(/fission from Mekanism Generators/);
  }, 60000);
});

// ───────────── single blocks: energy cubes, tanks, machines ─────────────

describe.skipIf(!ready)(
  "energy cube: shared machine methods, side config, ejector, security",
  () => {
    it("answers like the source", async () => {
      const result = await lua(
        `
local c = peripheral.wrap("cube")
local locked = peripheral.wrap("locked")
ccunit.test("energy and block", function()
  ccunit.eq(c.getMaxEnergy(), 4000000)
  ccunit.eq(c.getDirection(), "NORTH")
  ccunit.eq(c.getRedstoneMode(), "DISABLED")
  ccunit.eq(c.getChargeItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(c.getSecurityMode(), "PUBLIC")
  ccunit.eq(c.getOwnerName(), nil)
  ccunit.eq(c.getInstalledUpgrades, nil) -- energy cubes take no upgrades
end)
ccunit.test("side config", function()
  ccunit.eq(c.getConfigurableTypes(), { "ENERGY", "ITEM" })
  ccunit.eq(c.getSupportedModes("ENERGY"), { "NONE", "INPUT", "OUTPUT", "INPUT_OUTPUT" })
  ccunit.eq(c.getMode("ENERGY", "FRONT"), "OUTPUT")
  ccunit.eq(c.getMode("item", "left"), "INPUT")
  ccunit.eq(c.canEject("ENERGY"), true)
  ccunit.eq(c.isEjecting("ENERGY"), true)
  ccunit.eq(c.canEject("ITEM"), false)
  ccunit.eq(err(c.setEjecting, "ITEM", true), "This machine does not support auto-ejecting for transmission type 'ITEM'.")
  ccunit.eq(err(c.canEject, "GAS"), "This machine does not support configuring transmission type 'GAS'.")
  ccunit.eq(err(c.setMode, "ENERGY", "LEFT", "ENERGY"), "This machine does not support mode 'ENERGY' for transmission type 'ENERGY'.")
  c.incrementMode("ENERGY", "BACK")
  ccunit.eq(c.getMode("ENERGY", "BACK"), "OUTPUT")
  c.decrementMode("ENERGY", "BACK")
  c.decrementMode("ENERGY", "BACK")
  ccunit.eq(c.getMode("ENERGY", "BACK"), "NONE")
  c.setMode("ENERGY", "BACK", "INPUT_OUTPUT")
  ccunit.eq(c.getMode("ENERGY", "BACK"), "INPUT_OUTPUT")
  ccunit.eq(err(c.getMode, "ENERGY", "UP"), "Invalid argument 1, getMode expected RelativeSide but received type String with value UP.")
end)
ccunit.test("ejector", function()
  ccunit.eq(c.hasStrictInput(), false)
  ccunit.eq(c.getOutputColor(), nil)
  c.setOutputColor("red")
  ccunit.eq(c.getOutputColor(), "RED")
  ccunit.eq(err(c.setOutputColor, "WHITE"), "Color 'WHITE' is not a supported transporter color.")
  c.incrementInputColor("LEFT")
  ccunit.eq(c.getInputColor("LEFT"), "DARK_BLUE")
  c.decrementInputColor("LEFT")
  ccunit.eq(c.getInputColor("LEFT"), nil)
  c.decrementOutputColor()
  ccunit.eq(c.getOutputColor(), "AQUA") -- the colour before RED in TransporterUtils.colors
  c.setStrictInput(true)
  ccunit.eq(c.hasStrictInput(), true)
end)
ccunit.test("security", function()
  ccunit.eq(locked.getSecurityMode(), "PRIVATE")
  ccunit.eq(locked.getOwnerName(), "Alice")
  ccunit.eq(err(locked.setRedstoneMode, "HIGH"), "Setter not available due to machine security not being public.")
  ccunit.eq(err(locked.setStrictInput, true), "Setter not available due to machine security not being public.")
  ccunit.eq(err(c.setRedstoneMode, "PULSE"), "Unsupported redstone control mode: PULSE")
end)
`,
        {
          players: [{ name: "Alice" }],
          peripherals: [
            { name: "cube", type: "basicEnergyCube" },
            {
              name: "locked",
              type: "ultimateEnergyCube",
              owner: "Alice",
              security: "private",
            },
          ],
        } as unknown as WorldConfig,
        "cube.test.lua",
      );
      expectAllPassed(result);
    }, 60000);

    it("charges from cables, ejects at the tier's rate, stops with redstone", async () => {
      await withSession(
        {
          peripherals: [
            {
              name: "cube",
              type: "basicEnergyCube",
              energyInput: 10_000,
              energyOutput: 6_000,
              redstoneMode: "HIGH",
            },
          ],
        } as unknown as WorldConfig,
        async (step) => {
          let state = await step({ cmd: "advance", seconds: 1 });
          let s = mbState(state, "", "cube");
          expect(s.energy % 10_000).toBe(0); // HIGH without a signal: nothing goes out
          expect(s.lastOutput).toBe(0);
          state = await step({
            cmd: "mekSetRedstone",
            peripheral: "cube",
            powered: true,
          });
          const before = mbState(state, "", "cube").energy;
          const t0 = gameTime(state, "");
          state = await step({ cmd: "advance", seconds: 1 });
          s = mbState(state, "", "cube");
          expect(s.energy - before).toBe(
            (10_000 - 4_000) * (gameTime(state, "") - t0),
          ); // basic: 4000 J/t out
          expect(s.lastOutput).toBe(4_000);
        },
      );
    }, 60000);
  },
);

describe.skipIf(!ready)("fluid and chemical tanks", () => {
  it("readings, edit mode, dumping", async () => {
    const result = await lua(
      `
local f = peripheral.wrap("ftank")
local g = peripheral.wrap("gtank")
ccunit.test("fluid tank", function()
  ccunit.eq(f.getStored(), { name = "minecraft:water", amount = 8000 })
  ccunit.eq(f.getCapacity(), 32000)
  ccunit.eq(f.getNeeded(), 24000)
  ccunit.eq(f.getFilledPercentage(), 0.25)
  ccunit.eq(f.getComparatorLevel(), math.floor(0.25 * 14) + 1)
  ccunit.eq(f.getDirection, nil)
  ccunit.eq(f.getRedstoneMode, nil)
  ccunit.eq(f.getContainerEditMode(), "BOTH")
  f.incrementContainerEditMode()
  ccunit.eq(f.getContainerEditMode(), "FILL")
  f.decrementContainerEditMode()
  f.decrementContainerEditMode()
  ccunit.eq(f.getContainerEditMode(), "EMPTY")
  ccunit.eq(err(f.setContainerEditMode, "x"), "Invalid argument 0, setContainerEditMode expected ContainerEditMode but received type String with value x.")
end)
ccunit.test("chemical tank", function()
  ccunit.eq(g.getCapacity(), 8192000)
  ccunit.eq(g.getStored().name, "mekanism:hydrogen")
  ccunit.eq(g.getConfigurableTypes(), { "GAS", "INFUSION", "PIGMENT", "SLURRY", "ITEM" })
  local before = g.getStored().amount
  g.setDumpingMode("DUMPING")
  ccunit.eq(g.getDumpingMode(), "DUMPING")
  sleep(0.5)
  local after = g.getStored().amount
  ccunit.eq((before - after) % 20480, 0) -- 8192000 / 400 a tick
  ccunit.truthy(before - after >= 20480 * 8)
end)
`,
      {
        peripherals: [
          { name: "ftank", type: "basicFluidTank", fluid: 8000 },
          { name: "gtank", type: "ultimateChemicalTank", chemical: 4_000_000 },
        ],
      } as unknown as WorldConfig,
      "tanks.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

describe.skipIf(!ready)("machines", () => {
  it("enrichment chamber: upgrades change ticks, usage and capacity; it processes", async () => {
    const result = await lua(
      `
local m = peripheral.wrap("chamber")
ccunit.test("upgrades", function()
  ccunit.eq(m.getSupportedUpgrades(), { "SPEED", "ENERGY", "MUFFLING" })
  ccunit.eq(m.getInstalledUpgrades(), { SPEED = 8 })
  ccunit.eq(m.getTicksRequired(), 20) -- 200 * 10^-1
  ccunit.eq(m.getMaxEnergy(), 20000)
  ccunit.eq(m.getConfigurableTypes(), { "ITEM", "ENERGY" })
  ccunit.eq(m.getMode("ITEM", "RIGHT"), "OUTPUT")
  ccunit.eq(m.getMode("ITEM", "BACK"), "ENERGY")
  ccunit.eq(m.getSupportedModes("ITEM"), { "NONE", "INPUT", "OUTPUT", "INPUT_OUTPUT", "ENERGY" })
  ccunit.eq(m.canEject("ENERGY"), false)
end)
ccunit.test("processing", function()
  sleep(0.2)
  ccunit.eq(m.getEnergyUsage(), 5000) -- 50 * 10^2 while active
  sleep(2)
  local out = m.getOutput()
  ccunit.eq(out.name, "mekanism:enriched_iron")
  ccunit.truthy(out.count >= 1)
  ccunit.truthy(m.getInput().count < 10)
end)
`,
      {
        peripherals: [
          {
            name: "chamber",
            type: "enrichmentChamber",
            upgrades: { speed: 8 },
            energy: 20000,
            energyInput: 6000,
            input: { name: "minecraft:iron_ore", count: 10 },
            recipeOutput: "mekanism:enriched_iron",
          },
        ],
      } as unknown as WorldConfig,
      "chamber.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("electrolytic separator: water to hydrogen and oxygen, 400 J an operation", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "sep",
            type: "electrolyticSeparator",
            water: 24000,
            energy: 160000,
            upgrades: { SPEED: 2 },
          },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 0.5 });
        const s = mbState(state, "", "sep");
        const ticks = gameTime(state, "") + 1;
        expect(s.left.amount).toBe(2 * 4 * ticks); // 2^2 operations a tick
        expect(s.right.amount).toBe(4 * ticks);
        expect(s.water.amount).toBe(24000 - 8 * ticks);
        // 400 * 10^(2 * 2/8) per operation
        // 400 * 10^(2 * 2/8) per operation, the multiplier a FloatingLong: 3.1623
        expect(s.energyUsage).toBeCloseTo(4 * 400 * 3.1623, 4);
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("generators on the virtual clock", () => {
  it("solar follows the sun and the weather; wind follows height; bio, heat and gas burn fuel", async () => {
    await withSession(
      {
        peripherals: [
          { name: "solar", type: "solarGenerator" },
          { name: "asolar", type: "advancedSolarGenerator" },
          { name: "wind", type: "windGenerator", y: 64 },
          { name: "bio", type: "bioGenerator", bioFuel: 1000 },
          { name: "heat", type: "heatGenerator", lava: 4000 },
          { name: "gas", type: "gasBurningGenerator", fuel: 1000 },
        ],
        mekanism: { dayTime: 6000, daylightCycle: false },
      } as unknown as WorldConfig,
      async (step) => {
        let state = await step({ cmd: "advance", seconds: 1 });
        const ticks = gameTime(state, "") + 1;
        // noon, clear, plains: brightness 1, peak 1 + 0 - 0.3 * 0.4 = 0.88
        expect(mbState(state, "", "solar").production).toBeCloseTo(44, 3);
        expect(mbState(state, "", "solar").energy).toBeCloseTo(44 * ticks, 2);
        expect(mbState(state, "", "asolar").production).toBeCloseTo(264, 3);
        // wind at y 64: 60 + (480 - 60) / 360 * 44, over 60
        const w = mbState(state, "", "wind");
        expect(w.multiplier).toBeCloseTo(1.8556, 4);
        expect(w.energy).toBeCloseTo(ticks * 60 * 1.8556, 1);
        expect(mbState(state, "", "bio").energy).toBe(350 * ticks);
        expect(mbState(state, "", "bio").bioFuel.amount).toBe(1000 - ticks);
        const heat = mbState(state, "", "heat");
        expect(heat.temperature).toBeGreaterThan(300);
        expect(heat.lava.amount).toBe(4000 - 10 * ticks);
        const gas = mbState(state, "", "gas");
        expect(gas.energy).toBeGreaterThan(0);
        expect(gas.fuel.amount).toBeLessThan(1000);
        // rain: 80 % less, and dimmer; thunder: too dark to see the sun
        await step({ cmd: "mekSetWorld", raining: true });
        state = await step({ cmd: "advance", seconds: 0.2 });
        expect(mbState(state, "", "solar").production).toBeCloseTo(
          50 * 0.75 * 0.88 * 0.2,
          3,
        );
        await step({ cmd: "mekSetWorld", thundering: true });
        state = await step({ cmd: "advance", seconds: 0.2 });
        expect(mbState(state, "", "solar").production).toBe(0);
        await step({
          cmd: "mekSetWorld",
          raining: false,
          thundering: false,
          dayTime: 18000,
        });
        state = await step({ cmd: "advance", seconds: 0.2 });
        expect(mbState(state, "", "solar").production).toBe(0);
        expect(mbState(state, "", "solar").seesSun).toBe(false);
      },
    );
  }, 90000);

  it("computer methods of the generators", async () => {
    const result = await lua(
      `
ccunit.test("generators", function()
  local s, g, w = peripheral.wrap("solar"), peripheral.wrap("gas"), peripheral.wrap("wind")
  sleep(0.2)
  ccunit.eq(s.canSeeSun(), true)
  near(s.getMaxOutput(), 44)
  near(s.getProductionRate(), 44)
  ccunit.eq(s.getSupportedUpgrades(), { "MUFFLING" })
  ccunit.eq(s.getInstalledUpgrades(), {})
  ccunit.eq(s.getMaxEnergy(), 96000)
  ccunit.eq(g.getFuel().name, "mekanism:hydrogen")
  ccunit.eq(g.getFuelCapacity(), 18000)
  ccunit.truthy(g.getBurnRate() > 0)
  ccunit.eq(g.getMaxEnergy(), 200000)
  ccunit.eq(w.isBlacklistedDimension(), false)
  ccunit.truthy(w.getProductionRate() > 100)
  ccunit.eq(w.getConfigurableTypes, nil) -- generators have no side config
end)
`,
      {
        peripherals: [
          { name: "solar", type: "solarGenerator" },
          { name: "gas", type: "gasBurningGenerator", fuel: 1000 },
          { name: "wind", type: "windGenerator" },
        ],
        mekanism: { dayTime: 6000, daylightCycle: false },
      } as unknown as WorldConfig,
      "generators.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
