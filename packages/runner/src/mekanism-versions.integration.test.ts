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
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  checkWorld,
  loadConfig,
  runTests,
} from "./index.js";

/**
 * Mekanism and Mekanism Generators on each Minecraft version: 10.2.5 (1.18.2), 10.4.16 (1.20.1), 10.7.19 (1.21.1).
 * The differences come from the three jars' @ComputerMethod / generated ComputerHandler classes and the 10.4.16 / 10.7.19
 * tags' source (docs/mekanism-versions.md). The 1.18.2 surfaces are the two *-surface.json files; every other version
 * is that plus or minus what the jars changed (CHANGES below), checked on a world with every block in it.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "mekver-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const VERSIONS = ["1.18.2", "1.20.1", "1.21.1"] as const;
type Mc = (typeof VERSIONS)[number];

const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local function has(t, name) for _, n in ipairs(t) do if n == name then return true end end return false end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 90000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const readSurface = (file: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8"),
  ) as Record<string, string[]>;
/** 1.18.2 (10.2.5): every type's methods, and ":unformed" for the multiblocks. */
const SURFACE_1182: Record<string, string[]> = {
  ...readSurface("./mekanism-multiblocks-surface.json"),
  ...readSurface("./mekanism-surface.json"),
};

// ───────────── what the jars changed (docs/mekanism-versions.md) ─────────────

interface Change {
  add?: string[];
  remove?: string[];
  /** only while formed (a multiblock's data) */
  formedOnly?: boolean;
}
const tiers4 = ["basic", "advanced", "elite", "ultimate"];
const tiers5 = [...tiers4, "creative"];
const tankNames = (p: string) => [
  `get${p}`,
  `get${p}Capacity`,
  `get${p}Needed`,
  `get${p}FilledPercentage`,
];

/** 10.2.5 -> 10.4.16 (also in 10.7.19). */
const CHANGES_104: Record<string, Change> = {
  ...Object.fromEntries(
    tiers5.map((t) => [
      `${t}Bin`,
      { add: ["getLock", "isLocked", "lock", "unlock"] },
    ]),
  ),
  dimensionalStabilizer: {
    add: ["enableChunkLoadingFor", "disableChunkLoadingFor"],
  },
  formulaicAssemblicator: {
    add: ["fillGrid", "emptyGrid"],
    remove: ["fillOrEmptyGrid"],
  },
  fuelwoodHeater: { add: ["getTransferLoss"] },
  resistiveHeater: { add: ["getEnergyUsed", "getTransferLoss"] },
  seismicVibrator: { add: ["isVibrating", "getBlockAt", "getColumnAt"] },
  solarNeutronActivator: { add: ["canSeeSun"] },
  qioRedstoneAdapter: {
    add: ["getFuzzyMode", "setFuzzyMode", "toggleFuzzyMode"],
  },
  fusionReactorLogicAdapter: {
    add: ["getEnvironmentalLoss", "getTransferLoss"],
    formedOnly: true,
  },
};
/** 10.4.16 -> 10.7.19. */
const CHANGES_107: Record<string, Change> = {
  ...Object.fromEntries(
    tiers4.map((t) => [
      `${t}InfusingFactory`,
      {
        add: [...tankNames("Chemical"), "getChemicalItem", "dumpChemical"],
        remove: [
          ...tankNames("InfuseType"),
          "getInfuseTypeItem",
          "dumpInfuseType",
        ],
      },
    ]),
  ),
  nutritionalLiquifier: { add: ["getContainerOutputItem"] },
  qioExporter: { add: ["isRoundRobin", "setRoundRobin"] },
  qioRedstoneAdapter: {
    add: ["invertSignal", "isInverted", "setSignalInverted"],
  },
  quantumEntangloporter: {
    add: tankNames("BufferChemical"),
    remove: ["Gas", "InfuseType", "Pigment", "Slurry"].flatMap((p) =>
      tankNames(`Buffer${p}`),
    ),
  },
  fusionReactorLogicAdapter: { add: ["isIgnited"], formedOnly: true },
};

function apply(
  names: string[],
  c: Change | undefined,
  formed: boolean,
): string[] {
  if (!c || (c.formedOnly && !formed)) return names;
  return [
    ...names.filter((n) => !(c.remove ?? []).includes(n)),
    ...(c.add ?? []),
  ];
}
/** The sorted method names of `type` on `mc`, formed or not. */
function expectedNames(type: string, mc: Mc, formed: boolean): string[] {
  const key =
    !formed && SURFACE_1182[`${type}:unformed`] ? `${type}:unformed` : type;
  let names = [...SURFACE_1182[key]!];
  if (mc !== "1.18.2")
    names = ["help", ...apply(names, CHANGES_104[type], formed)];
  if (mc === "1.21.1") names = apply(names, CHANGES_107[type], formed);
  return [...new Set(names)].sort();
}

const TYPES = Object.keys(SURFACE_1182).filter((k) => !k.includes(":"));
const ADDED_104 = [
  "radioactiveWasteBarrel",
  "industrialAlarm",
  "personalChest",
  "personalBarrel",
  "securityDesk",
];
/** The blocks 10.4 gave computer support: TileEntityMekanism's methods their attributes allow, and security's. */
const SECURITY = ["getOwnerUUID", "getOwnerName", "getSecurityMode"];
const ADDED_SURFACE: Record<string, string[]> = {
  radioactiveWasteBarrel: [
    "getDirection",
    "getComparatorLevel",
    "getStored",
    "getCapacity",
    "getNeeded",
    "getFilledPercentage",
  ],
  industrialAlarm: ["getDirection", "getRedstoneMode", "setRedstoneMode"],
  personalChest: ["getDirection", ...SECURITY],
  personalBarrel: ["getDirection", ...SECURITY],
  securityDesk: ["getDirection", ...SECURITY],
};

/**
 * A java.util.HashMap filled with `keys` in order (buckets, resizing that keeps each bucket's order), iterated.
 * `initial` is the constructor's capacity (tableSizeFor), 16 for new HashMap().
 */
function hashMapIteration(keys: string[], initial: number): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 1;
  while (cap < initial) cap *= 2;
  let table: string[][] = Array.from({ length: cap }, () => []);
  let size = 0;
  for (const k of keys) {
    const b = table[hash(k) & (cap - 1)]!;
    if (b.includes(k)) continue;
    b.push(k);
    if (++size > cap * 0.75) {
      const next: string[][] = Array.from({ length: cap * 2 }, () => []);
      for (const bucket of table)
        for (const x of bucket) next[hash(x) & (cap * 2 - 1)]!.push(x);
      table = next;
      cap *= 2;
    }
  }
  return table.flat();
}
/**
 * CC:Tweaked 1.121.0's peripheral.getMethods for a 10.4+ Mekanism block: Mekanism's ArrayListMultimap keys (a
 * HashMap made for 12 keys: HashMap(17), 32 buckets), put into PeripheralWrapper's new HashMap().
 */
const cc121Order = (bindingOrder: string[]) =>
  hashMapIteration(hashMapIteration(bindingOrder, 17), 16);
const QIO_TYPES = [
  "qioDriveArray",
  "qioDashboard",
  "qioImporter",
  "qioExporter",
  "qioRedstoneAdapter",
  "quantumEntangloporter",
];

const luaTable = (v: unknown): string =>
  JSON.stringify(v)
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/"([\w:.]+)":/g, '["$1"] =');

const allTypesWorld = (mc: Mc, formed: boolean): WorldConfig =>
  ({
    version: mc,
    players: [{ name: "Alice" }],
    peripherals: [...TYPES, ...(mc === "1.18.2" ? [] : ADDED_104)].map(
      (type) => ({
        name: `p_${type}`,
        type,
        formed,
        owner: "Alice",
      }),
    ),
  }) as unknown as WorldConfig;

describe("Mekanism version tables (no engine)", () => {
  it("every changed type exists in the 1.18.2 surface, and what is removed was there", () => {
    for (const changes of [CHANGES_104, CHANGES_107])
      for (const [type, c] of Object.entries(changes)) {
        expect(SURFACE_1182[type], type).toBeDefined();
        for (const n of c.remove ?? [])
          if (changes === CHANGES_104)
            expect(SURFACE_1182[type], `${type} ${n}`).toContain(n);
      }
  });
});

describe.skipIf(!ready)("Mekanism method surface by Minecraft version", () => {
  for (const mc of VERSIONS)
    for (const formed of [true, false])
      it(`${mc}: every block has the version's methods (${formed ? "formed" : "unformed"})`, async () => {
        const expected: Record<string, string[]> = {};
        for (const t of TYPES) expected[t] = expectedNames(t, mc, formed);
        if (mc !== "1.18.2")
          for (const t of ADDED_104)
            expected[t] = ["help", ...ADDED_SURFACE[t]!].sort();
        // the QIO blocks bind help, then their methods by name: the order is CC 1.121.0's two HashMaps over that
        const ordered: Record<string, string[]> = {};
        if (mc !== "1.18.2")
          for (const t of QIO_TYPES)
            ordered[t] = cc121Order([
              "help",
              ...expected[t]!.filter((n) => n !== "help"),
            ]);
        const result = await lua(
          `
local expected, ordered = ${luaTable(expected)}, ${luaTable(ordered)}
for ty, names in pairs(expected) do
  ccunit.test(ty, function()
    local got = peripheral.getMethods("p_" .. ty)
    if ordered[ty] then ccunit.eq(got, ordered[ty]) end
    table.sort(got)
    ccunit.eq(got, names)
    ccunit.eq({ peripheral.getType("p_" .. ty) }, { ty })
  end)
end
`,
          allTypesWorld(mc, formed),
          `surface-${mc}-${formed}.test.lua`,
        );
        expectAllPassed(result);
      }, 120000);
});

describe("Mekanism types by Minecraft version", () => {
  it("1.18.2 refuses the blocks 10.4 gave computer support; 1.20.1 and 1.21.1 take them", () => {
    for (const mc of VERSIONS) {
      const w = {
        version: mc,
        peripherals: ADDED_104.map((type, i) => ({ name: `b${i}`, type })),
      } as unknown as WorldConfig;
      const errors = checkWorld(w, {}).errors.join("\n");
      if (mc === "1.18.2")
        for (const t of ADDED_104)
          expect(errors).toMatch(new RegExp(`${t}.*Minecraft 1\\.18\\.2`));
      else expect(errors).toBe("");
    }
  });
});

// ───────────── behaviour that changed ─────────────

const ALICE = "00000000-0000-4000-8000-000000000001";
const behaviourWorld = (mc: Mc): WorldConfig =>
  ({
    version: mc,
    players: [{ name: "Alice", uuid: ALICE }],
    mekanism: {
      qio: { frequencies: [{ name: "Vault", owner: "Alice" }] },
      multiblocks: {
        fusion: {
          kind: "fusion",
          deuterium: 1000,
          tritium: 1000,
          water: 1_000_000,
        },
      },
    },
    peripherals: [
      { name: "chamber", type: "enrichmentChamber", energy: 1234.5678 },
      {
        name: "bin",
        type: "basicBin",
        item: { name: "minecraft:cobblestone", count: 100 },
      },
      { name: "cbin", type: "creativeBin" },
      { name: "ebin", type: "eliteBin" },
      { name: "heater", type: "resistiveHeater" },
      { name: "vib", type: "seismicVibrator" },
      { name: "stab", type: "dimensionalStabilizer" },
      { name: "asm", type: "formulaicAssemblicator" },
      { name: "inf", type: "basicInfusingFactory" },
      { name: "cube", type: "creativeEnergyCube" },
      { name: "sorter", type: "logisticalSorter" },
      {
        name: "fusion",
        type: "fusionReactorLogicAdapter",
        multiblock: "fusion",
      },
      {
        name: "array",
        type: "qioDriveArray",
        owner: "Alice",
        frequency: "Vault",
        drives: [
          {
            tier: "base",
            items: [
              { name: "minecraft:cobblestone", count: 1000 },
              { name: "minecraft:dirt", count: 5 },
            ],
          },
        ],
      },
      {
        name: "adapter",
        type: "qioRedstoneAdapter",
        owner: "Alice",
        frequency: "Vault",
        targetItem: "minecraft:cobblestone",
      },
      {
        name: "exporter",
        type: "qioExporter",
        owner: "Alice",
        frequency: "Vault",
      },
      { name: "qe", type: "quantumEntangloporter", owner: "Alice" },
      ...(mc === "1.18.2"
        ? []
        : [
            {
              name: "waste",
              type: "radioactiveWasteBarrel",
              stored: 100,
              decays: false,
            },
            { name: "waste2", type: "radioactiveWasteBarrel", stored: 100 },
            { name: "alarm", type: "industrialAlarm" },
            { name: "chest", type: "personalChest", owner: "Alice" },
          ]),
    ],
  }) as unknown as WorldConfig;

describe.skipIf(!ready)("Mekanism behaviour by Minecraft version", () => {
  for (const mc of VERSIONS)
    it(`${mc}`, async () => {
      const NEW = mc !== "1.18.2";
      const V21 = mc === "1.21.1";
      const result = await lua(
        `
local NEW, V21 = ${NEW}, ${V21}
local chamber = peripheral.wrap("chamber")
ccunit.test("help() is on every 10.4+ block", function()
  ccunit.eq(has(peripheral.getMethods("chamber"), "help"), NEW)
  if NEW then
    ccunit.truthy(err(chamber.help):find("help%(%) is not simulated"))
    ccunit.eq(err(chamber.help, "a", "b"), "Found 2 arguments, expected 0 or 1")
  end
end)
ccunit.test("argument errors: Mekanism's own on 10.2.5, CC's on 10.4+", function()
  if NEW then
    ccunit.eq(err(chamber.setRedstoneMode), "Found 0 arguments, expected 1")
    ccunit.eq(err(chamber.setRedstoneMode, 0), "bad argument #1 (string expected, got number)")
    ccunit.eq(err(chamber.setRedstoneMode, "bogus"), "bad argument #1 (unknown option bogus)")
    ccunit.eq(err(chamber.setRedstoneMode, "pulse"), "Unsupported redstone control mode: PULSE")
    chamber.setRedstoneMode("high")
    ccunit.eq(chamber.getRedstoneMode(), "HIGH")
  else
    ccunit.eq(err(chamber.setRedstoneMode), "Mismatched parameter count. setRedstoneMode expected: '1' arguments, but received: '0' arguments.")
    chamber.setRedstoneMode(1) -- an ordinal
    ccunit.eq(chamber.getRedstoneMode(), "HIGH")
  end
end)
ccunit.test("energy: FloatingLong on 10.2 / 10.4, whole joules on 10.7", function()
  ccunit.eq(chamber.getEnergy(), V21 and 1234 or 1234.5678)
  ccunit.eq(peripheral.wrap("cube").getMaxEnergy(), V21 and 9.2233720368547758e18 or 1.8446744073709552e19)
end)
ccunit.test("side config: CHEMICAL replaces GAS / INFUSION / PIGMENT / SLURRY on 10.7", function()
  local inf = peripheral.wrap("inf")
  local types = inf.getConfigurableTypes()
  ccunit.eq(has(types, "CHEMICAL"), V21)
  ccunit.eq(has(types, "INFUSION"), not V21)
  if V21 then
    ccunit.eq(err(inf.getMode, "INFUSION", "FRONT"), "bad argument #1 (unknown option INFUSION)")
    ccunit.eq(inf.getChemical(), { name = "mekanism:empty", amount = 0 })
  else
    ccunit.eq(inf.getInfuseType(), { name = "mekanism:empty_infuse_type", amount = 0 })
  end
end)
if NEW then
  ccunit.test("bins lock (10.4), and unlock() locks the way the jar does", function()
    local bin, cbin, ebin = peripheral.wrap("bin"), peripheral.wrap("cbin"), peripheral.wrap("ebin")
    ccunit.eq(bin.isLocked(), false)
    ccunit.eq(bin.getLock(), { name = "minecraft:air", count = 0 })
    bin.lock()
    ccunit.eq(bin.isLocked(), true)
    ccunit.eq(bin.getLock(), { name = "minecraft:cobblestone", count = 1 })
    ccunit.eq(err(bin.lock), "This bin is already locked!")
    ccunit.eq(err(bin.unlock), "This bin is not locked!")
    ccunit.eq(err(cbin.lock), "Creative bins cannot be locked!")
    ccunit.eq(err(ebin.lock), "Empty bins cannot be locked!")
  end)
  ccunit.test("heater, vibrator, stabilizer, assemblicator", function()
    local heater, vib, stab, asm = peripheral.wrap("heater"), peripheral.wrap("vib"), peripheral.wrap("stab"), peripheral.wrap("asm")
    ccunit.eq(heater.getEnergyUsed(), 0)
    ccunit.eq(heater.getTransferLoss(), 0)
    ccunit.eq(vib.isVibrating(), false)
    ccunit.eq(err(vib.getBlockAt, 0, 0, 0), "Seismic Vibrator is not currently vibrating any chunks")
    ccunit.eq(stab.getChunksLoaded(), 1)
    stab.enableChunkLoadingFor(1)
    ccunit.eq(stab.getChunksLoaded(), 9)
    stab.enableChunkLoadingFor(2)
    ccunit.eq(stab.getChunksLoaded(), 25)
    stab.disableChunkLoadingFor(1)
    ccunit.eq(stab.getChunksLoaded(), 17)
    ccunit.eq(err(stab.enableChunkLoadingFor, 3), "Radius '3' is not in range, must be between 1 and 2 inclusive.")
    ccunit.eq(asm.fillOrEmptyGrid, nil)
    ccunit.eq(select("#", asm.fillGrid()), 0)
    ccunit.eq(select("#", asm.emptyGrid()), 0)
  end)
  ccunit.test("the blocks 10.4 gave computer support", function()
    local waste = peripheral.wrap("waste")
    ccunit.eq(waste.getStored(), { name = "mekanism:spent_nuclear_waste", amount = 100 })
    ccunit.eq(waste.getCapacity(), 512000)
    ccunit.eq(waste.getNeeded(), 511900)
    sleep(1.1) -- 1 mB every 20 ticks
    ccunit.truthy(peripheral.wrap("waste2").getStored().amount < 100, "decays")
    ccunit.eq(peripheral.wrap("alarm").getRedstoneMode(), "DISABLED")
    ccunit.eq(peripheral.wrap("chest").getOwnerName(), "Alice")
  end)
  ccunit.test("logistical sorter filters: 10.4 errors, 10.7 snake_case keys and stacks of 99", function()
    local sorter = peripheral.wrap("sorter")
    ccunit.eq(err(sorter.addFilter, { type = "NOPE" }), "Unknown 'type' value")
    ccunit.eq(err(sorter.addFilter, { type = "QIO_TAG_FILTER", tag = "x" }), V21 and "Unexpected format for: type" or "Type is not of an expected format")
    ccunit.eq(err(sorter.addFilter, { type = "SORTER_TAG_FILTER" }), "Invalid or missing tag specified for Tag filter")
    ccunit.eq(err(sorter.addFilter, "x"), "bad argument #1 (table expected, got string)")
    local f = { type = "SORTER_TAG_FILTER", tag = "forge:ores", max = 99 }
    if V21 then
      ccunit.eq(sorter.addFilter(f), true)
      local got = sorter.getFilters()[1]
      ccunit.eq(got.allow_default, false)
      ccunit.eq(got.enabled, true)
      ccunit.eq(got.max, 99)
    else
      ccunit.eq(err(sorter.addFilter, f), "Invalid or min/max: 0 <= min <= max <= 64")
      f.max = 64
      ccunit.eq(sorter.addFilter(f), true)
      ccunit.eq(sorter.getFilters()[1].allowDefault, false)
      ccunit.eq(sorter.getFilters()[1].enabled, true)
    end
  end)
end
ccunit.test("fusion reactor", function()
  local fusion = peripheral.wrap("fusion")
  ccunit.eq(fusion.getEnvironmentalLoss ~= nil, NEW)
  ccunit.eq(fusion.isIgnited ~= nil, V21)
  if V21 then ccunit.eq(fusion.isIgnited(), false) end
end)
ccunit.test("QIO frequencies and stacks", function()
  local array = peripheral.wrap("array")
  if V21 then
    ccunit.eq(array.getFrequency(), { key = "Vault", security_mode = "PUBLIC", owner = "${ALICE}" })
    ccunit.eq(array.getDrive(0), { name = "mekanism:qio_drive_base", count = 1,
      components = '{"mekanism:drive_metadata":{count:1005L,types:2}}' })
  else
    ccunit.eq(array.getFrequency(), { key = "Vault", public = true })
    local nbt = array.getDrive(0).nbt
    if NEW then
      ccunit.eq(nbt, "{mekData:{qioMetaCount:1005L,qioMetaTypes:2}}")
    else
      ccunit.eq(type(nbt), "table")
      ccunit.eq(nbt.mekData.qioMetaCount, 1005)
    end
  end
end)
ccunit.test("QIO redstone adapter and exporter", function()
  local adapter, exporter = peripheral.wrap("adapter"), peripheral.wrap("exporter")
  ccunit.eq(adapter.getFuzzyMode ~= nil, NEW)
  ccunit.eq(adapter.isInverted ~= nil, V21)
  ccunit.eq(exporter.isRoundRobin ~= nil, V21)
  if NEW then
    ccunit.eq(adapter.getFuzzyMode(), false)
    adapter.toggleFuzzyMode()
    ccunit.eq(adapter.getFuzzyMode(), true)
    ccunit.eq(exporter.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:dirt" }), true)
    local f = exporter.getFilters()[1]
    ccunit.eq(f.enabled, true)
    ccunit.eq(f.item, "minecraft:dirt")
    ccunit.eq(err(exporter.addFilter, { type = "SORTER_TAG_FILTER", tag = "x" }), V21 and "Unexpected format for: type" or "Type is not of an expected format")
    ccunit.eq(err(exporter.addFilter, {}), "Missing 'type' element")
  else
    ccunit.truthy(err(exporter.addFilter, {}):find("^Invalid argument 0, addFilter expected QIOFilter"))
  end
  if V21 then
    adapter.invertSignal()
    ccunit.eq(adapter.isInverted(), true)
    exporter.setRoundRobin(true)
    ccunit.eq(exporter.isRoundRobin(), true)
  end
end)
ccunit.test("entangloporter: one chemical buffer on 10.7", function()
  local qe = peripheral.wrap("qe")
  ccunit.eq(qe.getBufferChemical ~= nil, V21)
  ccunit.eq(qe.getBufferGas ~= nil, not V21)
  ccunit.eq(has(qe.getConfigurableTypes(), "CHEMICAL"), V21)
end)
`,
        behaviourWorld(mc),
        `behaviour-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 120000);
});
