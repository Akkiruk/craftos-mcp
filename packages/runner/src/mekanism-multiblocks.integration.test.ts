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
  sendCommandResult,
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
  timeoutMs = 10000,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    await s.handle.session.waitForText(">", 0, 20000);
    await run(async (c) => {
      expect(
        await sendAndWait(s.handle, c as unknown as SimCommand, timeoutMs),
      ).toBe(true);
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

/** How many ticks the clock module has simulated since boot (each once, however they were caught up). */
function ticksRun(state: SimState): number {
  const addons = (
    state as unknown as { addons?: Record<string, { ticksRun: number }> }
  ).addons;
  return addons!["mekanism-machines"]!.ticksRun;
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

/**
 * The computer methods each class (with its Mekanism parents, less TileEntityMekanism, TileEntityMultiblock and
 * MultiblockData) annotates in Mekanism-1.18.2-10.2.5.465.jar: javap -p -v, the ComputerMethod nameOverride, the
 * WrappingComputerMethod methodNames and the SyntheticComputerMethod getters, in class order.
 */
const JAR: Record<string, string[]> = {
  Factory: [
    "getEnergyItem",
    "isAutoSortEnabled",
    "getEnergyUsage",
    "getTicksRequired",
    "setAutoSort",
    "getRecipeProgress",
    "getInput",
    "getOutput",
  ],
  ItemStackGasToItemStackFactory: [
    "getChemicalItem",
    "getChemical",
    "getChemicalCapacity",
    "getChemicalNeeded",
    "getChemicalFilledPercentage",
    "dumpChemical",
  ],
  MetallurgicInfuserFactory: [
    "getInfuseTypeItem",
    "getInfuseType",
    "getInfuseTypeCapacity",
    "getInfuseTypeNeeded",
    "getInfuseTypeFilledPercentage",
    "dumpInfuseType",
  ],
  CombiningFactory: ["getSecondaryInput"],
  SawingFactory: ["getSecondaryOutput"],
  Bin: ["getStored", "getCapacity"],
  TankMultiblockData: [
    "getContainerEditMode",
    "getInputItem",
    "getOutputItem",
    "getTankCapacity",
    "getChemicalTankCapacity",
    "setContainerEditMode",
    "incrementContainerEditMode",
    "decrementContainerEditMode",
    "getStored",
    "getFilledPercentage",
  ],
  EvaporationMultiblockData: [
    "getInput",
    "getInputCapacity",
    "getInputNeeded",
    "getInputFilledPercentage",
    "getOutput",
    "getOutputCapacity",
    "getOutputNeeded",
    "getOutputFilledPercentage",
    "getProductionAmount",
    "getEnvironmentalLoss",
    "getInputItemInput",
    "getInputItemOutput",
    "getOutputItemInput",
    "getOutputItemOutput",
    "getTemperature",
    "getActiveSolars",
  ],
  SPSMultiblockData: [
    "getInput",
    "getInputCapacity",
    "getInputNeeded",
    "getInputFilledPercentage",
    "getOutput",
    "getOutputCapacity",
    "getOutputNeeded",
    "getOutputFilledPercentage",
    "getProcessRate",
    "getCoils",
  ],
  SPSPort: ["getMode", "setMode"],
  DigitalMiner: [
    "getEnergyItem",
    "getSilkTouch",
    "getRadius",
    "getMinY",
    "getMaxY",
    "getInverseMode",
    "getInverseModeRequiresReplacement",
    "getInverseModeReplaceTarget",
    "getFilters",
    "getToMine",
    "isRunning",
    "getAutoEject",
    "getAutoPull",
    "getEnergyUsage",
    "getSlotCount",
    "getItemInSlot",
    "getState",
    "setAutoEject",
    "setAutoPull",
    "setSilkTouch",
    "start",
    "stop",
    "reset",
    "getMaxRadius",
    "setRadius",
    "setMinY",
    "setMaxY",
    "setInverseMode",
    "setInverseModeRequiresReplacement",
    "setInverseModeReplaceTarget",
    "clearInverseModeReplaceTarget",
    "addFilter",
    "removeFilter",
  ],
  PrecisionSawmill: [
    "getInput",
    "getOutput",
    "getSecondaryOutput",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  AdvancedElectricMachine: [
    "getChemical",
    "getChemicalCapacity",
    "getChemicalNeeded",
    "getChemicalFilledPercentage",
    "getInput",
    "getOutput",
    "getChemicalItem",
    "getEnergyItem",
    "getEnergyUsage",
    "dumpChemical",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  Combiner: [
    "getMainInput",
    "getSecondaryInput",
    "getOutput",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  PressurizedReactionChamber: [
    ...tank("InputFluid"),
    ...tank("InputGas"),
    ...tank("OutputGas"),
    "getInputItem",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  ChemicalCrystallizer: [
    "getInputItem",
    "getOutput",
    "getEnergyItem",
    "getEnergyUsage",
    ...tank("Input"),
    "getRecipeProgress",
    "getTicksRequired",
  ],
  ChemicalDissolutionChamber: [
    ...tank("GasInput"),
    "getInputGasItem",
    "getInputItem",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    ...tank("Output"),
    "getRecipeProgress",
    "getTicksRequired",
  ],
  ChemicalInfuser: [
    ...tank("LeftInput"),
    ...tank("RightInput"),
    ...tank("Output"),
    "getLeftInputItem",
    "getOutputItem",
    "getRightInputItem",
    "getEnergyItem",
    "getEnergyUsage",
  ],
  ChemicalOxidizer: [
    ...tank("Output"),
    "getInput",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  ChemicalWasher: [
    ...tank("Fluid"),
    ...tank("SlurryInput"),
    ...tank("SlurryOutput"),
    "getFluidItemInput",
    "getFluidItemOutput",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
  ],
  RotaryCondensentrator: [
    ...tank("Gas"),
    ...tank("Fluid"),
    "getGasItemInput",
    "getGasItemOutput",
    "getFluidItemInput",
    "getFluidItemOutput",
    "getEnergyItem",
    "getEnergyUsage",
    "isCondensentrating",
    "setCondensentrating",
  ],
  IsotopicCentrifuge: [
    ...tank("Input"),
    ...tank("Output"),
    "getInputItem",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
  ],
  NutritionalLiquifier: [
    ...tank("Output"),
    "getInput",
    "getContainerFillItem",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  AntiprotonicNucleosynthesizer: [
    ...tank("InputChemical"),
    "getInputChemicalItem",
    "getInputItem",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  PigmentExtractor: [
    ...tank("Output"),
    "getInput",
    "getOutputItem",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  PigmentMixer: [
    ...tank("LeftInput"),
    ...tank("RightInput"),
    ...tank("Output"),
    "getLeftInputItem",
    "getOutputItem",
    "getRightInputItem",
    "getEnergyItem",
    "getEnergyUsage",
  ],
  PaintingMachine: [
    ...tank("PigmentInput"),
    "getInputPigmentItem",
    "getInputItem",
    "getOutput",
    "getEnergyItem",
    "getEnergyUsage",
    "getRecipeProgress",
    "getTicksRequired",
  ],
  SolarNeutronActivator: [
    ...tank("Input"),
    ...tank("Output"),
    "getPeakProductionRate",
    "getProductionRate",
    "getInputItem",
    "getOutputItem",
  ],
  ElectricPump: [
    ...tank("Fluid"),
    "getInputItem",
    "getOutputItem",
    "getEnergyItem",
    "reset",
  ],
  FluidicPlenisher: [
    ...tank("Fluid"),
    "getInputItem",
    "getOutputItem",
    "getEnergyItem",
    "reset",
  ],
  ResistiveHeater: [
    "getTemperature",
    "getEnergyItem",
    "getEnvironmentalLoss",
    "getEnergyUsage",
    "setEnergyUsage",
  ],
  FuelwoodHeater: ["getFuelItem", "getTemperature", "getEnvironmentalLoss"],
  SeismicVibrator: ["getEnergyItem"],
  Laser: ["getDiggingPos"],
  LaserAmplifier: [
    "getRedstoneOutputMode",
    "getDelay",
    "getMinThreshold",
    "getMaxThreshold",
    "setRedstoneOutputMode",
    "setDelay",
    "setMinThreshold",
    "setMaxThreshold",
    "getDiggingPos",
  ],
  LaserTractorBeam: ["getSlotCount", "getItemInSlot", "getDiggingPos"],
  Teleporter: [
    "getEnergyItem",
    "getFrequencies",
    "hasFrequency",
    "getFrequency",
    "setFrequency",
    "createFrequency",
    "getFrequencyColor",
    "setFrequencyColor",
    "incrementFrequencyColor",
    "decrementFrequencyColor",
    "getActiveTeleporters",
    "getStatus",
  ],
  Chargepad: [],
  LogisticalSorter: [
    "getDefaultColor",
    "getAutoMode",
    "isRoundRobin",
    "isSingle",
    "getFilters",
    "setSingle",
    "setRoundRobin",
    "setAutoMode",
    "clearDefaultColor",
    "incrementDefaultColor",
    "decrementDefaultColor",
    "setDefaultColor",
    "addFilter",
    "removeFilter",
  ],
  Oredictionificator: [
    "getInputItem",
    "getOutputItem",
    "getFilters",
    "addFilter",
    "removeFilter",
  ],
  FormulaicAssemblicator: [
    "getExcessRemainingItems",
    "getFormulaItem",
    "getEnergyItem",
    "hasRecipe",
    "getRecipeProgress",
    "getTicksRequired",
    "getCraftingInputSlot",
    "getCraftingOutputSlots",
    "getCraftingOutputSlot",
    "hasValidFormula",
    "getSlots",
    "getItemInSlot",
    "encodeFormula",
    "fillOrEmptyGrid",
    "craftSingleItem",
    "craftAvailableItems",
    "getStockControl",
    "setStockControl",
    "getAutoMode",
    "setAutoMode",
  ],
  ModificationStation: ["getEnergyItem", "getModuleItem", "getContainerItem"],
  DimensionalStabilizer: [
    "getChunksLoaded",
    "getEnergyItem",
    "isChunkLoadingAt",
    "toggleChunkLoadingAt",
    "setChunkLoadingAt",
  ],
  Transmitter: ["getBuffer", "getCapacity", "getNeeded", "getFilledPercentage"],
  DiversionTransporter: [
    "getMode",
    "setMode",
    "incrementMode",
    "decrementMode",
  ],
};
SOURCE.dynamicValve = {
  tile: ["isFormed", "getComparatorLevel"],
  multiblock: [...JAR.TankMultiblockData!, ...shape],
};
SOURCE.thermalEvaporationController = {
  tile: ["isFormed", "getDirection"],
  multiblock: [...JAR.EvaporationMultiblockData!, ...shape],
};
SOURCE.thermalEvaporationValve = {
  tile: ["isFormed", "getComparatorLevel"],
  multiblock: [...JAR.EvaporationMultiblockData!, ...shape],
};
SOURCE.spsPort = {
  tile: [...JAR.SPSPort!, "isFormed", ...energy],
  multiblock: [...JAR.SPSMultiblockData!, ...shape],
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

/**
 * The other single blocks: the jar's methods, the TileEntityMekanism ones their block attributes allow (D facing,
 * R redstone, C comparator, E energy containers), then upgrade, security, side config and ejector as they have them.
 */
function single(own: string[], attrs: string, comps: string): string[][] {
  const tile = [...own];
  if (attrs.includes("D")) tile.push(...dir);
  if (attrs.includes("R")) tile.push(...red);
  if (attrs.includes("C")) tile.push(...cmp);
  if (attrs.includes("E")) tile.push(...energy);
  const groups = [tile];
  if (comps.includes("U")) groups.push(UPG);
  if (comps.includes("S")) groups.push(SEC);
  if (comps.includes("F")) groups.push(CFG);
  if (comps.includes("J")) groups.push(EJ);
  return groups;
}
const FACTORY_TYPES: Record<string, string[]> = {
  Smelting: [],
  Enriching: [],
  Crushing: [],
  Compressing: JAR.ItemStackGasToItemStackFactory!,
  Combining: JAR.CombiningFactory!,
  Purifying: JAR.ItemStackGasToItemStackFactory!,
  Injecting: JAR.ItemStackGasToItemStackFactory!,
  Infusing: JAR.MetallurgicInfuserFactory!,
  Sawing: JAR.SawingFactory!,
};
for (const t of ["basic", "advanced", "elite", "ultimate"])
  for (const [f, own] of Object.entries(FACTORY_TYPES))
    SINGLES[`${t}${f}Factory`] = single(
      [...own, ...JAR.Factory!],
      "DRCE",
      "USFJ",
    );
for (const t of tiers) SINGLES[`${t}Bin`] = single(JAR.Bin!, "DC", "");
const MACHINES: Record<string, [string, string, string]> = {
  digitalMiner: ["DigitalMiner", "DRCE", "US"],
  precisionSawmill: ["PrecisionSawmill", "DRCE", "USFJ"],
  osmiumCompressor: ["AdvancedElectricMachine", "DRCE", "USFJ"],
  purificationChamber: ["AdvancedElectricMachine", "DRCE", "USFJ"],
  chemicalInjectionChamber: ["AdvancedElectricMachine", "DRCE", "USFJ"],
  combiner: ["Combiner", "DRCE", "USFJ"],
  pressurizedReactionChamber: ["PressurizedReactionChamber", "DRCE", "USFJ"],
  chemicalCrystallizer: ["ChemicalCrystallizer", "DRCE", "USFJ"],
  chemicalDissolutionChamber: ["ChemicalDissolutionChamber", "DRCE", "USFJ"],
  chemicalInfuser: ["ChemicalInfuser", "DRCE", "USFJ"],
  chemicalOxidizer: ["ChemicalOxidizer", "DRCE", "USFJ"],
  chemicalWasher: ["ChemicalWasher", "DRCE", "USFJ"],
  rotaryCondensentrator: ["RotaryCondensentrator", "DRCE", "USFJ"],
  isotopicCentrifuge: ["IsotopicCentrifuge", "DRCE", "USFJ"],
  nutritionalLiquifier: ["NutritionalLiquifier", "DRCE", "USFJ"],
  antiprotonicNucleosynthesizer: [
    "AntiprotonicNucleosynthesizer",
    "DRCE",
    "USFJ",
  ],
  pigmentExtractor: ["PigmentExtractor", "DRCE", "USFJ"],
  pigmentMixer: ["PigmentMixer", "DRCE", "USFJ"],
  paintingMachine: ["PaintingMachine", "DRCE", "USFJ"],
  solarNeutronActivator: ["SolarNeutronActivator", "DRC", "SFJ"],
  electricPump: ["ElectricPump", "DRCE", "US"],
  fluidicPlenisher: ["FluidicPlenisher", "DRCE", "US"],
  resistiveHeater: ["ResistiveHeater", "DRE", "S"],
  fuelwoodHeater: ["FuelwoodHeater", "D", "S"],
  seismicVibrator: ["SeismicVibrator", "DRE", "S"],
  laser: ["Laser", "DE", "S"],
  laserAmplifier: ["LaserAmplifier", "DRCE", "S"],
  laserTractorBeam: ["LaserTractorBeam", "DCE", "S"],
  teleporter: ["Teleporter", "RCE", "US"],
  chargepad: ["Chargepad", "DE", ""],
  logisticalSorter: ["LogisticalSorter", "DRC", "US"],
  oredictionificator: ["Oredictionificator", "DR", "SFJ"],
  formulaicAssemblicator: ["FormulaicAssemblicator", "DRCE", "USFJ"],
  modificationStation: ["ModificationStation", "DRE", "S"],
  dimensionalStabilizer: ["DimensionalStabilizer", "RCE", "US"],
  diversionTransporter: ["DiversionTransporter", "", ""],
};
for (const [type, [cls, attrs, comps]] of Object.entries(MACHINES))
  SINGLES[type] = single(JAR[cls]!, attrs, comps);
for (const t of ["basic", "advanced", "elite", "ultimate"])
  for (const f of ["UniversalCable", "MechanicalPipe", "PressurizedTube"])
    SINGLES[`${t}${f}`] = [JAR.Transmitter!];

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
  -- each call is a server tick of its own, and a busy host can let several pass between two of them: the boil rate
  -- read between two readings of the most it could boil is under the larger (the heat moves one way meanwhile)
  local max1, rate, max2 = b.getMaxBoilRate(), b.getBoilRate(), b.getMaxBoilRate()
  ccunit.truthy(rate <= math.max(max1, max2), rate .. " over " .. max1 .. " and " .. max2)
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
          // steam goes out through a second valve, slower than it boils: with nowhere to go it filled the boiler in
          // under a second of ticks and the boiling stopped before a busy host got to look. Now the boiler fills and
          // then boils as fast as the steam leaves, for as long as the test takes
          {
            name: "steamValve",
            type: "boilerValve",
            multiblock: "boiler",
            mode: "OUTPUT_STEAM",
          },
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
              steamOutput: 10_000,
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
      "bioGenerator", "gasBurningGenerator", "basicSmeltingFactory", "ultimateInfusingFactory", "basicSawingFactory", "basicBin",
      "creativeBin", "dynamicValve", "thermalEvaporationController", "thermalEvaporationValve", "spsPort", "digitalMiner",
      "chemicalInfuser", "solarNeutronActivator", "teleporter", "logisticalSorter", "basicUniversalCable", "diversionTransporter" }) do
    ccunit.truthy(peripheral.find(ty), ty)
  end
  ccunit.eq(peripheral.wrap("teleporter_0").getStatus(), "ready")
  ccunit.eq(peripheral.wrap("dynamicValve_0").getStored().name, "minecraft:water")
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

  it("an hour of the demo plant catches up, every tick simulated once", async () => {
    const demo = loadNamedWorld(
      join(fileURLToPath(new URL("../../..", import.meta.url)), "worlds"),
      "mekanism-multiblocks-demo",
    );
    await withSession(
      demo,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 3600 });
        // The work done, not the wall time it took (a busy host only makes it slower): every tick of the hour ran,
        // and none ran twice. It takes seconds of the computer's thread, which is the server's work there, so it must
        // not trip the 7 s "Too long without yielding" limit either (core.serverWork): that would end the session.
        expect(gameTime(state, "")).toBeGreaterThanOrEqual(72_000 - 1);
        expect(ticksRun(state)).toBe(gameTime(state, "") + 1);
        const matrix = mbState(state, "", "matrix");
        expect(matrix.lastOutput).toBe(1_000_000);
        // the single blocks ran all hour too
        expect(mbState(state, "", "basicSmeltingFactory_0").processed).toBe(48);
        expect(mbState(state, "", "digitalMiner_0").mined).toBe(400);
        expect(mbState(state, "", "sps").antimatterMade).toBeGreaterThan(0);
      },
      170000,
    ); // ~7 s on a quiet machine: an hour of 73 machines and multiblocks, tick by tick
  }, 200000);

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
  ccunit.eq(select("#", c.getOutputColor()), 1) -- a null return is one nil, not no values
  ccunit.eq(select("#", c.setOutputColor("red")), 0) -- void: no values
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

// ───────────── factories, bins, dynamic tank, evaporation, SPS, miner, other machines ─────────────

describe.skipIf(!ready)("factories", () => {
  it("methods, process bounds, side config, security, chemical and infuse tanks", async () => {
    const result = await lua(
      `
local f = peripheral.wrap("smelt")
local g = peripheral.wrap("compress")
local inf = peripheral.wrap("infuse")
local saw = peripheral.wrap("saw")
local locked = peripheral.wrap("locked")
ccunit.test("readings", function()
  ccunit.eq(f.getTicksRequired(), 200)
  ccunit.eq(f.getMaxEnergy(), 30000) -- max(20000 / 2, 50) x 3 processes
  ccunit.eq(peripheral.wrap("ult").getMaxEnergy(), 90000)
  ccunit.eq(f.isAutoSortEnabled(), false)
  ccunit.eq(f.getEnergyUsage(), 0)
  ccunit.eq(f.getInput(0), { name = "minecraft:iron_ore", count = 5 })
  ccunit.eq(f.getOutput(2), { name = "minecraft:air", count = 0 })
  ccunit.eq(f.getRecipeProgress(1), 0)
  ccunit.eq(f.getSupportedUpgrades(), { "SPEED", "ENERGY", "MUFFLING" })
  ccunit.eq(g.getSupportedUpgrades(), { "SPEED", "ENERGY", "MUFFLING" })
  ccunit.eq(peripheral.wrap("inject").getSupportedUpgrades(), { "SPEED", "ENERGY", "GAS", "MUFFLING" })
  ccunit.eq(f.getDirection(), "NORTH")
end)
ccunit.test("process bounds", function()
  ccunit.eq(err(f.getInput, 3), "Process: '3' is out of bounds, as this factory only has '3' processes (zero indexed).")
  ccunit.eq(err(f.getRecipeProgress, -1), "Process: '-1' is out of bounds, as this factory only has '3' processes (zero indexed).")
  ccunit.eq(peripheral.wrap("ult").getOutput(8), { name = "minecraft:air", count = 0 })
  ccunit.eq(err(f.getInput), "Mismatched parameter count. getInput expected: '1' arguments, but received: '0' arguments.")
end)
ccunit.test("side config", function()
  ccunit.eq(f.getConfigurableTypes(), { "ITEM", "ENERGY" })
  ccunit.eq(g.getConfigurableTypes(), { "ITEM", "ENERGY", "GAS" })
  ccunit.eq(inf.getConfigurableTypes(), { "ITEM", "ENERGY", "INFUSION" })
  ccunit.eq(f.getSupportedModes("ITEM"), { "NONE", "INPUT", "OUTPUT", "INPUT_OUTPUT", "ENERGY" })
  ccunit.eq(g.getSupportedModes("ITEM"), { "NONE", "INPUT", "OUTPUT", "INPUT_OUTPUT", "ENERGY", "EXTRA" })
  ccunit.eq(g.getMode("ITEM", "BOTTOM"), "EXTRA")
  ccunit.eq(f.getMode("ITEM", "BOTTOM"), "INPUT")
  ccunit.eq(f.getMode("ITEM", "RIGHT"), "OUTPUT")
  ccunit.eq(inf.getMode("INFUSION", "RIGHT"), "OUTPUT")
  ccunit.eq(inf.canEject("INFUSION"), false)
  ccunit.eq(g.canEject("GAS"), false)
end)
ccunit.test("tanks", function()
  ccunit.eq(g.getChemical(), { name = "mekanism:osmium", amount = 600 })
  ccunit.eq(g.getChemicalCapacity(), 630) -- 210 a process
  ccunit.eq(g.getChemicalItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(inf.getInfuseType(), { name = "mekanism:empty_infuse_type", amount = 0 })
  ccunit.eq(inf.getInfuseTypeCapacity(), 3000)
  ccunit.eq(saw.getSecondaryOutput(0), { name = "minecraft:air", count = 0 })
  ccunit.eq(peripheral.wrap("combine").getSecondaryInput(), { name = "minecraft:cobblestone", count = 3 })
  g.dumpChemical()
  ccunit.eq(g.getChemical(), { name = "mekanism:empty", amount = 0 })
end)
ccunit.test("security and auto sort", function()
  f.setAutoSort(true)
  ccunit.eq(f.isAutoSortEnabled(), true)
  ccunit.eq(err(locked.setAutoSort, true), "Setter not available due to machine security not being public.")
  ccunit.eq(err(locked.dumpChemical), "Setter not available due to machine security not being public.")
end)
`,
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "smelt",
            type: "basicSmeltingFactory",
            inputs: [{ name: "minecraft:iron_ore", count: 5 }],
          },
          { name: "ult", type: "ultimateEnrichingFactory" },
          { name: "compress", type: "basicCompressingFactory", chemical: 600 },
          { name: "inject", type: "basicInjectingFactory" },
          { name: "infuse", type: "basicInfusingFactory" },
          { name: "saw", type: "basicSawingFactory" },
          {
            name: "combine",
            type: "basicCombiningFactory",
            secondaryInput: { name: "minecraft:cobblestone", count: 3 },
          },
          {
            name: "locked",
            type: "basicPurifyingFactory",
            owner: "Alice",
            security: "private",
          },
        ],
      } as unknown as WorldConfig,
      "factories.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("processes in parallel, one tick's energy per busy process; auto-sort spreads the inputs", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "f",
            type: "basicSmeltingFactory",
            energy: 30000,
            energyInput: 150,
            sorting: true,
            inputs: [
              { name: "minecraft:iron_ore", count: 4 },
              { name: "minecraft:iron_ore", count: 4 },
            ],
            recipeOutput: "minecraft:iron_ingot",
          },
          {
            name: "u",
            type: "ultimateCompressingFactory",
            energy: 0,
            energyInput: "max",
            chemical: 1890,
            upgrades: { speed: 8 },
            inputs: [{ name: "mekanism:ingot_osmium", count: 5 }],
            recipeOutput: "mekanism:ingot_refined_obsidian",
          },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        let state = await step({ cmd: "advance", seconds: 1 });
        let s = mbState(state, "", "f");
        // sorted over the empty third process: 3, 3, 2
        expect(s.inputs).toEqual([
          { name: "minecraft:iron_ore", count: 3 },
          { name: "minecraft:iron_ore", count: 3 },
          { name: "minecraft:iron_ore", count: 2 },
        ]);
        expect(s.energyUsage).toBe(150);
        expect(s.energy).toBe(30000);
        const t1 = gameTime(state, "") + 1;
        expect(s.progress).toEqual([t1, t1, t1]);
        state = await step({ cmd: "advance", seconds: 10 });
        s = mbState(state, "", "f");
        const t = gameTime(state, "") + 1;
        const ops = Math.floor(t / 200);
        expect(s.processed).toBe(3 * ops);
        for (const o of s.outputs)
          expect(o).toEqual({ name: "minecraft:iron_ingot", count: ops });
        expect(s.progress).toEqual([t % 200, t % 200, t % 200]);
        // speed 8: 20 ticks an operation, the 200 mB base usage spread over them (10 mB a tick)
        const u = mbState(state, "", "u");
        expect(u.ticksRequired).toBe(20);
        const done = Math.min(5, Math.floor(t / 20));
        expect(u.outputs[0]).toEqual({
          name: "mekanism:ingot_refined_obsidian",
          count: done,
        });
        expect(u.chemical.amount).toBe(1890 - 10 * Math.min(t, 100));
      },
    );
  }, 90000);

  it("sawing gives its secondary output, infusing uses its infuse type", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "s",
            type: "basicSawingFactory",
            energy: 30000,
            energyInput: 50,
            inputs: [{ name: "minecraft:oak_log", count: 2 }],
            recipes: {
              "minecraft:oak_log": {
                output: "minecraft:oak_planks",
                count: 6,
                secondary: { name: "mekanism:sawdust", chance: 1 },
              },
            },
          },
          {
            name: "i",
            type: "basicInfusingFactory",
            energy: 30000,
            energyInput: 50,
            infuse: { name: "mekanism:redstone", amount: 100 },
            inputs: [{ name: "minecraft:iron_ingot", count: 2 }],
            recipeOutput: "mekanism:alloy_infused",
          },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 10.5 });
        const s = mbState(state, "", "s");
        expect(s.outputs[0]).toEqual({
          name: "minecraft:oak_planks",
          count: 6,
        });
        expect(s.secondaryOutputs[0]).toEqual({
          name: "mekanism:sawdust",
          count: 1,
        });
        const i = mbState(state, "", "i");
        expect(i.outputs[0]).toEqual({
          name: "mekanism:alloy_infused",
          count: 1,
        });
        expect(i.infuse.amount).toBe(90);
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("bins", () => {
  it("stored item, capacity, comparator; an active bin pushes a stack down every 6 ticks", async () => {
    const result = await lua(
      `
local b, c = peripheral.wrap("bin"), peripheral.wrap("cbin")
ccunit.test("bin", function()
  ccunit.eq(b.getStored(), { name = "minecraft:cobblestone", count = 1000 })
  ccunit.eq(b.getCapacity(), 4096)
  ccunit.eq(c.getCapacity(), 2147483647)
  ccunit.eq(peripheral.wrap("ebin").getStored(), { name = "minecraft:air", count = 0 })
  ccunit.eq(b.getComparatorLevel(), math.floor(1000 / 4096 * 14) + 1)
  ccunit.eq(b.getDirection(), "NORTH")
  ccunit.eq(b.getOwnerName, nil) -- no security
  ccunit.eq(b.getRedstoneMode, nil)
  ccunit.eq({ peripheral.getType("bin") }, { "basicBin" }) -- not an inventory
end)
`,
      {
        peripherals: [
          {
            name: "bin",
            type: "basicBin",
            item: { name: "minecraft:cobblestone", count: 1000 },
          },
          {
            name: "cbin",
            type: "creativeBin",
            item: { name: "minecraft:stone", count: 10 },
          },
          { name: "ebin", type: "eliteBin" },
        ],
      } as unknown as WorldConfig,
      "bins.test.lua",
    );
    expectAllPassed(result);
    await withSession(
      {
        peripherals: [
          {
            name: "bin",
            type: "basicBin",
            active: true,
            below: true,
            item: { name: "minecraft:cobblestone", count: 1000 },
          },
          {
            name: "cbin",
            type: "creativeBin",
            active: true,
            below: true,
            item: { name: "minecraft:stone", count: 10 },
          },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 1 });
        const t = gameTime(state, "") + 1;
        const pushes = Math.floor((t - 1) / 6) + 1;
        expect(mbState(state, "", "bin").pushed).toBe(64 * pushes);
        expect(mbState(state, "", "bin").item.count).toBe(1000 - 64 * pushes);
        expect(mbState(state, "", "cbin").item.count).toBe(10); // a creative bin never empties
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("dynamic tank", () => {
  it("one merged tank, capacities from the volume, edit mode, formation", async () => {
    const result = await lua(
      `
local v = peripheral.wrap("valve")
local g = peripheral.wrap("gas")
ccunit.test("readings", function()
  ccunit.eq(v.isFormed(), true)
  ccunit.eq(v.getStored(), { name = "minecraft:water", amount = 2000000 })
  ccunit.eq(v.getTankCapacity(), 27 * 350000)
  ccunit.eq(v.getChemicalTankCapacity(), 27 * 16000000)
  near(v.getFilledPercentage(), 2000000 / (27 * 350000))
  ccunit.eq(v.getComparatorLevel(), math.floor(2000000 / (27 * 350000) * 14) + 1)
  ccunit.eq({ v.getLength(), v.getWidth(), v.getHeight() }, { 3, 3, 3 })
  ccunit.eq(v.getInputItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(g.getStored(), { name = "mekanism:hydrogen", amount = 5000 })
  near(g.getFilledPercentage(), 5000 / (5 * 5 * 5 * 16000000))
  ccunit.eq(peripheral.wrap("empty").getStored(), { name = "minecraft:empty", amount = 0 })
  ccunit.eq(peripheral.wrap("empty").getFilledPercentage(), 0)
end)
ccunit.test("edit mode", function()
  ccunit.eq(v.getContainerEditMode(), "BOTH")
  v.incrementContainerEditMode()
  ccunit.eq(v.getContainerEditMode(), "FILL")
  v.setContainerEditMode("empty")
  ccunit.eq(v.getContainerEditMode(), "EMPTY")
  v.incrementContainerEditMode()
  ccunit.eq(v.getContainerEditMode(), "BOTH")
  ccunit.eq(err(v.setContainerEditMode, "x"), "Invalid argument 0, setContainerEditMode expected ContainerEditMode but received type String with value x.")
end)
`,
      {
        peripherals: [
          { name: "valve", type: "dynamicValve", fluid: 2000000 },
          {
            name: "gas",
            type: "dynamicValve",
            length: 5,
            width: 5,
            height: 5,
            chemical: { name: "mekanism:hydrogen", amount: 5000 },
          },
          { name: "empty", type: "dynamicValve" },
        ],
      } as unknown as WorldConfig,
      "dynamic.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("pipes fill it; a chemical is refused while it holds a fluid; unforming drops the multiblock's methods", async () => {
    const manager = new SessionManager(config);
    const s = manager.create([], 1, {
      peripherals: [{ name: "v", type: "dynamicValve", multiblock: "tank" }],
      mekanism: {
        multiblocks: {
          tank: { kind: "dynamicTank", fluid: 1000, fluidInput: 100 },
        },
      },
    } as unknown as WorldConfig);
    try {
      await s.handle.session.waitForText(">", 0, 20000);
      expect(
        await sendAndWait(s.handle, {
          cmd: "advance",
          seconds: 1,
        } as unknown as SimCommand),
      ).toBe(true);
      let state = s.handle.readState()!;
      const t = gameTime(state, "") + 1;
      expect(mbState(state, "", "tank").stored).toEqual({
        type: "FLUID",
        name: "minecraft:water",
        amount: 1000 + 100 * t,
      });
      const refused = await sendCommandResult(s.handle, {
        cmd: "mekAddTank",
        multiblock: "tank",
        tank: "chemical",
        amount: 10,
        name: "mekanism:oxygen",
      } as unknown as SimCommand);
      expect(refused.error).toMatch(/does not take mekanism:oxygen/);
      expect(
        await sendAndWait(s.handle, {
          cmd: "mekSetFormed",
          multiblock: "tank",
          formed: false,
        } as unknown as SimCommand),
      ).toBe(true);
      state = s.handle.readState()!;
      expect(mbState(state, "", "tank").formed).toBe(false);
    } finally {
      await manager.destroyAll();
    }
  }, 60000);
});

/** EvaporationMultiblockData.tick: environment, heat, temperature multiplier, 10 mB water to 1 mB brine. */
function evaporationModel(
  ticks: number,
  o: { heatInput: number; height: number; water: number },
) {
  const cap = 100 * o.height;
  let heat = cap * 300,
    water = o.water,
    brine = 0,
    opTicks = 0,
    gain = 0;
  for (let i = 0; i < ticks; i++) {
    let pending = o.heatInput;
    const cur = heat / cap;
    if (Math.abs(cur - 300) < 0.001) pending += 300 * cap - heat;
    else {
      let incr = 0.02 * Math.sqrt(Math.abs(cur - 300));
      if (cur > 300) incr = -incr;
      pending += cap * incr;
    }
    heat += pending;
    const tm = (Math.min(3000, heat / cap) - 300) * 0.4 * (o.height / 18);
    const required = tm > 0 && tm < 1 ? Math.ceil(1 / tm) : 1;
    let ops = tm > 0 && tm < 1 ? 1 : Math.trunc(tm);
    ops = Math.min(ops, Math.floor(water / 10), 10000 - brine);
    if (ops > 0) {
      gain = tm > 0 && tm < 1 ? 1 / Math.ceil(1 / tm) : tm;
      opTicks++;
      if (opTicks >= required) {
        opTicks = 0;
        water -= ops * 10;
        brine += ops;
      }
    } else gain = 0;
  }
  return { temperature: heat / cap, water, brine, gain };
}

describe.skipIf(!ready)("thermal evaporation plant", () => {
  it("readings through the controller and a valve", async () => {
    const result = await lua(
      `
local c, v = peripheral.wrap("controller"), peripheral.wrap("valve")
ccunit.test("readings", function()
  ccunit.eq(c.isFormed(), true)
  ccunit.eq(c.getDirection(), "EAST")
  ccunit.eq(c.getComparatorLevel, nil)
  ccunit.eq(v.getDirection, nil)
  ccunit.eq(v.getComparatorLevel(), math.floor(400000 / 4608000 * 14) + 1)
  ccunit.eq(c.getInput().name, "minecraft:water") -- the solars warm it, so it is already evaporating
  ccunit.eq(c.getInputCapacity(), 18 * 4 * 64000)
  ccunit.eq(c.getOutputCapacity(), 10000)
  ccunit.truthy(c.getOutputNeeded() <= 10000)
  ccunit.truthy(c.getTemperature() > 300)
  ccunit.eq(c.getActiveSolars(), 4) -- noon, four advanced solar generators on the corners
  ccunit.truthy(c.getProductionAmount() >= 0)
  ccunit.eq({ c.getLength(), c.getWidth(), c.getHeight() }, { 4, 4, 18 })
  ccunit.eq(c.getInputItemInput(), { name = "minecraft:air", count = 0 })
end)
`,
      {
        peripherals: [
          {
            name: "controller",
            type: "thermalEvaporationController",
            multiblock: "plant",
            facing: "east",
          },
          {
            name: "valve",
            type: "thermalEvaporationValve",
            multiblock: "plant",
          },
        ],
        mekanism: {
          dayTime: 6000,
          daylightCycle: false,
          multiblocks: {
            plant: { kind: "evaporation", input: 400000, solars: 4 },
          },
        },
      } as unknown as WorldConfig,
      "evaporation.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("heats up and evaporates tick for tick like EvaporationMultiblockData.tick", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "c",
            type: "thermalEvaporationController",
            multiblock: "plant",
          },
        ],
        mekanism: {
          multiblocks: {
            plant: {
              kind: "evaporation",
              height: 9,
              input: 1000000,
              heatInput: 500,
            },
          },
        },
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 5 });
        const t = gameTime(state, "") + 1;
        const m = evaporationModel(t, {
          heatInput: 500,
          height: 9,
          water: 1000000,
        });
        const s = mbState(state, "", "plant");
        expect(s.temperature).toBeCloseTo(m.temperature, 9);
        expect(s.input.amount).toBe(m.water);
        expect(s.output?.amount ?? 0).toBe(m.brine);
        expect(s.productionAmount).toBeCloseTo(m.gain, 9);
        expect(m.brine).toBeGreaterThan(0);
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("supercritical phase shifter", () => {
  it("coil energy turns polonium into antimatter at 1 MJ a mB, 1000 mB an antimatter", async () => {
    const result = await lua(
      `
local p = peripheral.wrap("port")
ccunit.test("readings", function()
  ccunit.eq(p.isFormed(), true)
  ccunit.eq(p.getMode(), false)
  p.setMode(true)
  ccunit.eq(p.getMode(), true)
  ccunit.eq(p.getInputCapacity(), 2000)
  ccunit.eq(p.getOutputCapacity(), 1000)
  ccunit.eq(p.getInput(), { name = "mekanism:polonium", amount = 2000 })
  ccunit.eq(p.getMaxEnergy(), 1000000000)
  ccunit.eq(p.getCoils(), 2)
  ccunit.eq({ p.getLength(), p.getWidth(), p.getHeight() }, { 7, 7, 7 })
  ccunit.eq(p.getComparatorLevel, nil)
end)
`,
      {
        peripherals: [{ name: "port", type: "spsPort", multiblock: "sps" }],
        mekanism: {
          multiblocks: { sps: { kind: "sps", input: 2000, coils: 2 } },
        },
      } as unknown as WorldConfig,
      "sps.test.lua",
    );
    expectAllPassed(result);
    await withSession(
      {
        peripherals: [
          {
            name: "port",
            type: "spsPort",
            multiblock: "sps",
            energyInput: 10000000,
          },
        ],
        mekanism: { multiblocks: { sps: { kind: "sps", input: 2000 } } },
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 6 });
        const t = gameTime(state, "") + 1;
        const processed = Math.min(2000, 10 * (t - 1)); // the first tick's energy is processed the next tick
        const s = mbState(state, "", "sps");
        expect(s.input?.amount ?? 0).toBe(2000 - processed);
        expect(s.output?.amount ?? 0).toBe(Math.floor(processed / 1000));
        expect(s.inputProcessed).toBe(processed % 1000);
        expect(s.processRate).toBe(0.01);
        expect(s.lastReceivedEnergy).toBe(10000000);
        expect(s.coils).toBe(1);
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("digital miner", () => {
  it("methods, configuration checks, filters", async () => {
    const result = await lua(
      `
local m = peripheral.wrap("miner")
ccunit.test("readings", function()
  ccunit.eq(m.getState(), "IDLE")
  ccunit.eq(m.getRadius(), 10)
  ccunit.eq({ m.getMinY(), m.getMaxY() }, { 0, 60 })
  ccunit.eq(m.getMaxRadius(), 32)
  ccunit.eq(m.getSlotCount(), 27)
  ccunit.eq(m.getItemInSlot(0), { name = "minecraft:air", count = 0 })
  ccunit.eq(err(m.getItemInSlot, 27), "Slot: '27' is out of bounds, as this digital miner only has '27' slots (zero indexed).")
  ccunit.eq(m.getSupportedUpgrades(), { "SPEED", "ENERGY", "ANCHOR", "STONE_GENERATOR" })
  ccunit.eq(m.getMaxEnergy(), 50000)
  ccunit.eq(m.getEnergyUsage(), 0)
  ccunit.eq(m.getInverseModeReplaceTarget(), "minecraft:air")
  ccunit.eq(m.getConfigurableTypes, nil)
end)
ccunit.test("configuration", function()
  ccunit.eq(err(m.setRadius, 33), "Radius '33' is out of range must be between 0 and 32. (Inclusive)")
  m.setRadius(32)
  ccunit.eq(m.getRadius(), 32)
  ccunit.eq(err(m.setMinY, 61), "Min Y '61' is out of range must be between -64 and 60. (Inclusive)")
  ccunit.eq(err(m.setMaxY, 320), "Max Y '320' is out of range must be between 0 and 319. (Inclusive)")
  m.setMinY(-64)
  m.setSilkTouch(true)
  m.setInverseModeReplaceTarget("minecraft:stone")
  ccunit.eq(m.getInverseModeReplaceTarget(), "minecraft:stone")
  m.clearInverseModeReplaceTarget()
  ccunit.eq(m.getInverseModeReplaceTarget(), "minecraft:air")
end)
ccunit.test("filters", function()
  local f = { type = "MINER_ITEMSTACK_FILTER", item = "minecraft:diamond_ore" }
  ccunit.eq(m.addFilter(f), true)
  ccunit.eq(m.addFilter(f), false)
  ccunit.eq(m.addFilter({ type = "miner_tag_filter", tag = "Forge:Ores/*" }), true)
  ccunit.eq(m.getFilters(), {
    { type = "MINER_ITEMSTACK_FILTER", item = "minecraft:diamond_ore", requiresReplacement = false, replaceTarget = "minecraft:air" },
    { type = "MINER_TAG_FILTER", tag = "forge:ores/*", requiresReplacement = false, replaceTarget = "minecraft:air" },
  })
  ccunit.truthy(err(m.addFilter, { type = "SORTER_TAG_FILTER", tag = "x" }):find("addFilter expected MinerFilter", 1, true))
  ccunit.eq(m.removeFilter(f), true)
  ccunit.eq(#m.getFilters(), 1)
end)
ccunit.test("start, then the configuration is locked", function()
  m.start()
  ccunit.eq(m.isRunning(), true)
  ccunit.eq(m.getState(), "FINISHED")
  ccunit.eq(m.getToMine(), 5)
  ccunit.eq(err(m.setRadius, 5), "Miner must be stopped and reset before its targeting configuration is changed.")
  m.stop()
  ccunit.eq(m.isRunning(), false)
  ccunit.eq(m.getState(), "FINISHED")
  m.reset()
  ccunit.eq(m.getState(), "IDLE")
  ccunit.eq(m.getToMine(), 0)
  m.setRadius(5)
end)
`,
      {
        peripherals: [{ name: "miner", type: "digitalMiner", ores: 5 }],
      } as unknown as WorldConfig,
      "miner.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("mines one block every 80 ticks at its energy per tick (silk touch x12, radius and height cost)", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "m",
            type: "digitalMiner",
            running: true,
            ores: 3,
            drop: "minecraft:iron_ore",
            energy: 50000,
            energyInput: 2000,
          },
          {
            name: "s",
            type: "digitalMiner",
            running: true,
            ores: 100,
            silkTouch: true,
            radius: 32,
            maxY: 120,
            energy: 50000,
          },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 9 });
        const t = gameTime(state, "") + 1;
        const m = mbState(state, "", "m");
        const mined = Math.min(3, Math.floor((t - 1) / 80) + 1);
        expect(m.mined).toBe(mined);
        expect(m.items[0]).toEqual({
          name: "minecraft:iron_ore",
          count: mined,
        });
        expect(m.toMine).toBe(3 - mined);
        // 1000 x 12 x (1 + 22/22) x (1 + 60/323), FloatingLong steps of four decimals
        const perTick = 24000 * (1 + 60 / 323);
        const s = mbState(state, "", "s");
        const ticksRun = Math.floor(50000 / perTick);
        expect(s.energy).toBeCloseTo(50000 - perTick * ticksRun, 1);
        expect(s.active).toBe(false); // out of energy
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("other recipe machines", () => {
  it("readings, side config and the rotary condensentrator's inverted setter", async () => {
    const result = await lua(
      `
ccunit.test("machines", function()
  local o = peripheral.wrap("oxidizer")
  ccunit.eq(o.getTicksRequired(), 100)
  ccunit.eq(o.getOutputCapacity(), 10000)
  ccunit.eq(o.getConfigurableTypes(), { "ITEM", "GAS", "ENERGY" })
  ccunit.eq(o.getMode("GAS", "RIGHT"), "OUTPUT")
  ccunit.eq(o.getMode("GAS", "LEFT"), "NONE")
  local inf = peripheral.wrap("infuser")
  ccunit.eq(inf.getMode("GAS", "LEFT"), "INPUT_1")
  ccunit.eq(inf.getMode("ITEM", "BACK"), "ENERGY")
  ccunit.eq(inf.isEjecting("GAS"), true)
  ccunit.eq(inf.getSupportedModes("GAS"), { "NONE", "INPUT_1", "INPUT_2", "OUTPUT", "INPUT_OUTPUT" })
  ccunit.eq(inf.getRecipeProgress, nil)
  local c = peripheral.wrap("centrifuge")
  ccunit.eq(c.getMode("GAS", "TOP"), "NONE")
  c.setMode("GAS", "TOP", "OUTPUT") -- a disabled side stays NONE
  ccunit.eq(c.getMode("GAS", "TOP"), "NONE")
  local r = peripheral.wrap("rotary")
  ccunit.eq(r.isCondensentrating(), true)
  r.setCondensentrating(true) -- sets the mode flag, which is the opposite of condensentrating
  ccunit.eq(r.isCondensentrating(), false)
  local prc = peripheral.wrap("prc")
  ccunit.eq(prc.getInputFluidCapacity(), 10000)
  ccunit.eq(prc.getConfigurableTypes(), { "ITEM", "ENERGY", "FLUID", "GAS" })
  ccunit.eq(prc.getTicksRequired(), 100)
  local comp = peripheral.wrap("compressor")
  ccunit.eq(comp.getChemicalCapacity(), 210)
  ccunit.eq(comp.getMode("ITEM", "BOTTOM"), "EXTRA")
  comp.dumpChemical()
  ccunit.eq(comp.getChemical(), { name = "mekanism:empty", amount = 0 })
  local sna = peripheral.wrap("sna")
  near(sna.getPeakProductionRate(), 64 * (1 - 0.3 * 0.4))
  ccunit.eq(sna.getMaxEnergy, nil)
  ccunit.eq(sna.getSupportedUpgrades, nil)
  ccunit.eq(peripheral.wrap("antiproton").getSupportedUpgrades(), { "MUFFLING" })
  ccunit.eq(peripheral.wrap("antiproton").getTicksRequired(), 400)
  ccunit.eq(peripheral.wrap("dissolver").getConfigurableTypes(), { "ITEM", "GAS", "INFUSION", "PIGMENT", "SLURRY", "ENERGY" })
  ccunit.eq(peripheral.wrap("crystallizer").getConfigurableTypes(), { "ITEM", "ENERGY", "GAS", "INFUSION", "PIGMENT", "SLURRY" })
end)
`,
      {
        peripherals: [
          { name: "oxidizer", type: "chemicalOxidizer" },
          { name: "infuser", type: "chemicalInfuser" },
          { name: "centrifuge", type: "isotopicCentrifuge" },
          { name: "rotary", type: "rotaryCondensentrator" },
          { name: "prc", type: "pressurizedReactionChamber" },
          { name: "compressor", type: "osmiumCompressor", chemical: 200 },
          { name: "sna", type: "solarNeutronActivator" },
          { name: "antiproton", type: "antiprotonicNucleosynthesizer" },
          { name: "dissolver", type: "chemicalDissolutionChamber" },
          { name: "crystallizer", type: "chemicalCrystallizer" },
        ],
      } as unknown as WorldConfig,
      "recipe-machines.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("progress machines finish every N ticks; recipe machines run 2^speed operations a tick; the SNA follows the sun", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "o",
            type: "chemicalOxidizer",
            energy: 80000,
            energyInput: 200,
            input: { name: "mekanism:dust_sulfur", count: 10 },
          },
          {
            name: "i",
            type: "chemicalInfuser",
            energy: 80000,
            energyInput: "max",
            upgrades: { speed: 2 },
            leftInput: 1000,
            rightInput: 1000,
          },
          {
            name: "c",
            type: "osmiumCompressor",
            energy: 80000,
            energyInput: 100,
            chemical: 200,
            input: { name: "mekanism:ingot_osmium", count: 2 },
          },
          { name: "n", type: "solarNeutronActivator", input: 10000 },
        ],
        mekanism: { dayTime: 6000, daylightCycle: false },
      } as unknown as WorldConfig,
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 6 });
        const t = gameTime(state, "") + 1;
        const o = mbState(state, "", "o");
        expect(o.tanks.output.amount).toBe(100 * Math.floor(t / 100));
        expect(o.progress).toBe(t % 100);
        const i = mbState(state, "", "i");
        expect(i.tanks.output.amount).toBe(4 * t);
        expect(i.energyUsage).toBeCloseTo(4 * 200 * 3.1623, 4);
        const c = mbState(state, "", "c");
        expect(c.tanks.chemical?.amount ?? 0).toBe(200 - Math.min(t, 200));
        // noon, clear: 64 x (1 + 0 - 0.12) x brightness 1, so 56 operations a tick
        const n = mbState(state, "", "n");
        expect(n.productionRate).toBeCloseTo(56.32, 4);
        expect(n.tanks.output.amount).toBe(Math.min(10000, 56 * t));
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("other blocks", () => {
  it("heaters, lasers, teleporter, sorter, oredictionificator, assemblicator, stabilizer, transmitters", async () => {
    const result = await lua(
      `
ccunit.test("resistive heater", function()
  local h = peripheral.wrap("heater")
  ccunit.eq(h.getEnergyUsage(), 100)
  ccunit.eq(h.getMaxEnergy(), 40000)
  h.setEnergyUsage(1000)
  ccunit.eq(h.getEnergyUsage(), 1000)
  ccunit.eq(h.getMaxEnergy(), 400000)
  ccunit.eq(h.getComparatorLevel, nil)
  sleep(0.5)
  ccunit.truthy(h.getTemperature() > 300)
  ccunit.eq(peripheral.wrap("fuelwood").getTemperature(), 300)
end)
ccunit.test("laser amplifier", function()
  local a = peripheral.wrap("amp")
  ccunit.eq(a.getRedstoneOutputMode(), "OFF")
  ccunit.eq(a.getMaxThreshold(), 5000000000)
  ccunit.eq(err(a.setDelay, -1), "Delay cannot be negative. Received: -1")
  a.setMaxThreshold("1000")
  ccunit.eq(a.getMaxThreshold(), 1000)
  a.setMinThreshold(5000)
  ccunit.eq({ a.getMinThreshold(), a.getMaxThreshold() }, { 5000, 5000 })
  ccunit.eq(err(a.setMinThreshold, -1), "Invalid argument 0, setMinThreshold expected FloatingLong but received type Double with value -1.0.")
  a.setRedstoneOutputMode("ENERGY_CONTENTS")
  ccunit.eq(a.getRedstoneOutputMode(), "ENERGY_CONTENTS")
  ccunit.eq(peripheral.wrap("laser").getDiggingPos(), nil)
  ccunit.eq(err(peripheral.wrap("tractor").getItemInSlot, 27), "Slot: '27' is out of bounds, as this laser amplifier only has '27' slots (zero indexed).")
end)
ccunit.test("teleporter", function()
  local t = peripheral.wrap("tele")
  ccunit.eq(t.hasFrequency(), false)
  ccunit.eq(t.getStatus(), "no frequency")
  ccunit.eq(err(t.getFrequency), "No frequency is currently selected.")
  ccunit.eq(err(t.setFrequency, "nope"), "No public teleporter frequency with name 'nope' found.")
  t.createFrequency("home")
  ccunit.eq(err(t.createFrequency, "home"), "Unable to create public teleporter frequency with name 'home' as one already exists.")
  ccunit.eq(t.getFrequency(), { key = "home", public = true })
  ccunit.eq(t.getFrequencyColor(), "PURPLE")
  t.incrementFrequencyColor()
  ccunit.eq(t.getFrequencyColor(), "ORANGE")
  ccunit.eq(t.getStatus(), "no link")
  ccunit.eq(#t.getActiveTeleporters(), 1)
  ccunit.eq(t.getFrequencies(), { { key = "home", public = true } })
end)
ccunit.test("logistical sorter", function()
  local s = peripheral.wrap("sorter")
  ccunit.eq(s.getDefaultColor(), nil)
  s.incrementDefaultColor()
  ccunit.eq(s.getDefaultColor(), "DARK_BLUE")
  ccunit.eq(err(s.setDefaultColor, "white"), "Color 'WHITE' is not a supported transporter color.")
  local f = { type = "SORTER_ITEMSTACK_FILTER", item = "minecraft:iron_ingot", color = "red", min = 1, max = 8 }
  ccunit.eq(s.addFilter(f), true)
  ccunit.eq(s.addFilter(f), false)
  ccunit.eq(s.getFilters()[1], { type = "SORTER_ITEMSTACK_FILTER", item = "minecraft:iron_ingot", allowDefault = false, color = "RED",
    size = false, min = 1, max = 8, fuzzy = false })
  ccunit.truthy(err(s.addFilter, { type = "SORTER_ITEMSTACK_FILTER", item = "minecraft:iron_ingot", min = 9, max = 8 }):find("expected SorterFilter", 1, true))
  s.setRoundRobin(true)
  ccunit.eq(s.isRoundRobin(), true)
end)
ccunit.test("oredictionificator", function()
  local o = peripheral.wrap("oredict")
  ccunit.eq(o.addFilter({ type = "OREDICTIONIFICATOR_ITEM_FILTER", target = "forge:ingots/copper" }), true)
  ccunit.eq(o.getFilters(), { { type = "OREDICTIONIFICATOR_ITEM_FILTER", target = "forge:ingots/copper", selected = "minecraft:air" } })
  ccunit.truthy(err(o.addFilter, { type = "OREDICTIONIFICATOR_ITEM_FILTER", target = "minecraft:logs" }):find("expected OredictionificatorItemFilter", 1, true))
  ccunit.eq(o.getConfigurableTypes(), { "ITEM" })
end)
ccunit.test("formulaic assemblicator", function()
  local a = peripheral.wrap("assembler")
  ccunit.eq(a.hasValidFormula(), false)
  ccunit.eq(err(a.encodeFormula), "No formula found.")
  ccunit.eq(err(a.getAutoMode), "Auto-Mode requires a valid formula.")
  ccunit.eq(err(a.setStockControl, true), "Stock Control requires a valid formula.")
  ccunit.eq(err(a.craftSingleItem), "Unable to perform craft as there is currently no matching recipe in the grid.")
  ccunit.eq(a.getSlots(), 18)
  ccunit.eq(err(a.getCraftingInputSlot, 9), "Crafting Input Slot '9' is out of bounds, must be between 0 and 9.")
  ccunit.eq(a.getExcessRemainingItems(), {})
end)
ccunit.test("dimensional stabilizer", function()
  local d = peripheral.wrap("stabilizer")
  ccunit.eq(d.getChunksLoaded(), 1)
  ccunit.eq(d.isChunkLoadingAt(0, 0), true)
  d.setChunkLoadingAt(1, -2, true)
  ccunit.eq(d.getChunksLoaded(), 2)
  d.toggleChunkLoadingAt(1, -2)
  ccunit.eq(d.getChunksLoaded(), 1)
  ccunit.eq(err(d.isChunkLoadingAt, 3, 0), "X offset '3' is not in range, must be between -2 and 2 inclusive.")
  ccunit.eq(err(d.isChunkLoadingAt, 0, -3), "Z offset '-3' is not in range, must be between -2 and 2 inclusive.")
end)
ccunit.test("transmitters", function()
  local c = peripheral.wrap("cable")
  ccunit.eq(c.getCapacity(), 8000 * 3)
  ccunit.eq(c.getBuffer(), 6000)
  ccunit.eq(c.getNeeded(), 18000)
  ccunit.eq(c.getFilledPercentage(), 0.25)
  ccunit.eq(peripheral.wrap("pipe").getBuffer(), { name = "minecraft:empty", amount = 0 })
  ccunit.eq(peripheral.wrap("pipe").getCapacity(), 128000)
  ccunit.eq(peripheral.wrap("tube").getBuffer(), { name = "mekanism:hydrogen", amount = 100 })
  local d = peripheral.wrap("diversion")
  ccunit.eq(d.getMode("north"), "DISABLED")
  d.incrementMode("NORTH")
  ccunit.eq(d.getMode("NORTH"), "HIGH")
  d.setMode("up", "low")
  ccunit.eq(d.getMode("UP"), "LOW")
  d.incrementMode("UP")
  ccunit.eq(d.getMode("UP"), "DISABLED")
  ccunit.eq(err(d.getMode, "front"), "Invalid argument 0, getMode expected Direction but received type String with value front.")
end)
`,
      {
        peripherals: [
          {
            name: "heater",
            type: "resistiveHeater",
            energy: 40000,
            energyInput: 1000,
          },
          { name: "fuelwood", type: "fuelwoodHeater" },
          { name: "amp", type: "laserAmplifier" },
          { name: "laser", type: "laser" },
          { name: "tractor", type: "laserTractorBeam" },
          { name: "tele", type: "teleporter" },
          { name: "sorter", type: "logisticalSorter" },
          { name: "oredict", type: "oredictionificator" },
          { name: "assembler", type: "formulaicAssemblicator" },
          { name: "stabilizer", type: "dimensionalStabilizer" },
          {
            name: "cable",
            type: "basicUniversalCable",
            network: 3,
            buffer: 6000,
          },
          { name: "pipe", type: "ultimateMechanicalPipe" },
          { name: "tube", type: "basicPressurizedTube", buffer: 100 },
          { name: "diversion", type: "diversionTransporter" },
        ],
      } as unknown as WorldConfig,
      "other-blocks.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("fails cleanly with the addon off", async () => {
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        {
          peripherals: [{ name: "f", type: "basicSmeltingFactory" }],
          addons: "none",
        } as unknown as WorldConfig,
        "off-factory.test.lua",
      ),
    ).rejects.toThrow(
      /basicSmeltingFactory from Mekanism \(addon "mekanism"\)/,
    );
  }, 60000);
});
