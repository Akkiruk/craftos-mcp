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
 * Mekanism 10.2.5 QIO, checked against behaviour read from the 1.18.x source the pack's 10.2.5.465 jar was
 * built from (docs/mekanism-qio.md has the line for every rule).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "mek-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

// Lua helpers every test file starts with: err() runs a call and returns its message without the position
const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local function sorted(t) table.sort(t) return t end
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

const ALICE = "00000000-0000-4000-8000-000000000001";
const helmetA = {
  name: "minecraft:diamond_helmet",
  count: 1,
  maxCount: 1,
  nbt: { vaultGear: { id: "a1", level: 50 }, Damage: 0 },
};
const helmetB = {
  name: "minecraft:diamond_helmet",
  count: 1,
  maxCount: 1,
  nbt: '{vaultGear:{id:"b2",level:12},Damage:0}',
};

const world: WorldConfig = {
  players: [{ name: "Alice" }],
  mekanism: {
    qio: {
      frequencies: [
        { name: "Vault", owner: "Alice" },
        { name: "Spare", owner: "Alice", color: "RED" },
        { name: "Secret", public: false, owner: "Alice" },
      ],
    },
  },
  peripherals: [
    {
      name: "array",
      type: "qioDriveArray",
      owner: "Alice",
      frequency: "Vault",
      drives: [
        {
          tier: "base",
          items: [
            {
              name: "minecraft:cobblestone",
              count: 1000,
              tags: ["forge:cobblestone"],
            },
            helmetA,
            helmetB,
            {
              name: "mekanism:ingot_osmium",
              count: 30,
              tags: ["forge:ingots/osmium", "forge:ingots"],
            },
          ],
        },
        { slot: 5, tier: "hyper_dense" },
      ],
    },
    {
      name: "dash",
      type: "qioDashboard",
      owner: "Alice",
      frequency: "Vault",
      facing: "UP",
      crafting: [
        {
          inputs: { "0": { name: "minecraft:oak_planks", count: 2 } },
          output: { name: "minecraft:stick", count: 4 },
        },
      ],
    },
    {
      name: "adapter",
      type: "qioRedstoneAdapter",
      owner: "Alice",
      frequency: "Vault",
      targetItem: "minecraft:cobblestone",
      triggerAmount: 500,
    },
    { name: "lonely", type: "qioDriveArray" },
    {
      name: "locked",
      type: "qioExporter",
      owner: "Alice",
      frequency: "Vault",
      securityMode: "PRIVATE",
    },
  ],
};

describe.skipIf(!ready)("QIO computer methods", () => {
  it("frequencies, drives and the common methods", async () => {
    const result = await lua(
      `
ccunit.test("types and frequency", function()
  ccunit.eq(peripheral.getType("array"), "qioDriveArray")
  local a = peripheral.wrap("array")
  ccunit.eq(a.hasFrequency(), true)
  ccunit.eq(a.getFrequency(), { key = "Vault", public = true })
  ccunit.eq(a.getFrequencies(), { { key = "Vault", public = true }, { key = "Spare", public = true } })
  ccunit.eq(a.getFrequencyColor(), "INDIGO")
  ccunit.eq(a.getDirection(), "NORTH")
  ccunit.eq(peripheral.call("dash", "getDirection"), "UP")
  ccunit.eq(a.getOwnerUUID(), "${ALICE}")
  ccunit.eq(a.getOwnerName(), "Alice")
  ccunit.eq(a.getSecurityMode(), "PUBLIC")
end)

ccunit.test("totals: every distinct item and NBT is a type", function()
  local a = peripheral.wrap("array")
  ccunit.eq(a.getSlotCount(), 12)
  ccunit.eq(a.getFrequencyItemCount(), 1032)
  ccunit.eq(a.getFrequencyItemCapacity(), 16000 + 128000)
  ccunit.eq(a.getFrequencyItemTypeCount(), 4)
  ccunit.eq(a.getFrequencyItemTypeCapacity(), 128 + 256)
  ccunit.eq(a.getFrequencyItemPercentage(), 1032 / 144000)
  ccunit.eq(a.getFrequencyItemTypePercentage(), 4 / 384)
end)

ccunit.test("drives and their LEDs", function()
  local a = peripheral.wrap("array")
  ccunit.eq(a.getDriveStatus(0), "READY")
  ccunit.eq(a.getDriveStatus(5), "READY")
  ccunit.eq(a.getDriveStatus(1), "NONE")
  ccunit.eq(a.getDrive(1), { name = "minecraft:air", count = 0 })
  ccunit.eq(a.getDrive(5), { name = "mekanism:qio_drive_hyper_dense", count = 1 })
  local d = a.getDrive(0)
  ccunit.eq(d.name, "mekanism:qio_drive_base")
  ccunit.eq(d.count, 1)
  ccunit.eq(d.nbt.mekData.qioMetaCount, 1032)
  ccunit.eq(d.nbt.mekData.qioMetaTypes, 4)
  local map = d.nbt.mekData.qioItemMap
  ccunit.eq(map[0].Item.id, "minecraft:cobblestone")
  ccunit.eq(map[0].Item.Count, 1)
  ccunit.eq(map[0].amount, 1000)
  ccunit.eq(map[1].Item.tag, { vaultGear = { id = "a1", level = 50 }, Damage = 0 })
  ccunit.eq(map[4], nil)
  local lonely = peripheral.wrap("lonely")
  ccunit.eq(lonely.hasFrequency(), false)
  ccunit.eq(lonely.getOwnerUUID(), nil)
  ccunit.eq(select("#", lonely.getOwnerUUID()), 1) -- Java returned null: one nil value
  ccunit.eq(select("#", peripheral.call("array", "setFrequencyColor", "red")), 0) -- void: no values
end)

ccunit.test("errors", function()
  local a = peripheral.wrap("array")
  local lonely = peripheral.wrap("lonely")
  ccunit.eq(err(lonely.getFrequency), "No frequency is currently selected.")
  ccunit.eq(err(lonely.getFrequencyItemCount), "No frequency is currently selected.")
  ccunit.eq(err(a.getDrive, 12), "Slot: '12' is out of bounds, as this QIO drive array only has '12' drive slots (zero indexed).")
  ccunit.eq(err(a.getDrive, -1), "Slot: '-1' is out of bounds, as this QIO drive array only has '12' drive slots (zero indexed).")
  ccunit.eq(a.getDriveStatus(0.9), "READY") -- (int) truncates toward zero
  ccunit.eq(err(a.getDrive), "Mismatched parameter count. getDrive expected: '1' arguments, but received: '0' arguments.")
  ccunit.eq(err(a.getSlotCount, 1), "Mismatched parameter count. getSlotCount expected: '0' arguments, but received: '1' arguments.")
  ccunit.eq(err(a.getDrive, nil), "Invalid argument 0, getDrive expected int but received null.")
  ccunit.eq(err(a.getDrive, "1"), "Invalid argument 0, getDrive expected int but received type String with value 1.")
  ccunit.eq(err(a.getDrive, 1e10), "Invalid argument 0, getDrive expected int but received type Double with value 1.0E10.")
  ccunit.eq(err(a.getDrive, 0/0), "Invalid argument 0, getDrive expected int but received type Double with value NaN.")
  ccunit.eq(err(a.setFrequency, 5), "Invalid argument 0, setFrequency expected String but received type Double with value 5.0.")
  ccunit.eq(err(a.setFrequency, true), "Invalid argument 0, setFrequency expected String but received type Boolean with value true.")
  ccunit.eq(err(a.setFrequency, {}), "Invalid argument 0, setFrequency expected String but received type HashMap with value {}.")
  ccunit.eq(err(a.setFrequency, "Nope"), "No public QIO frequency with name 'Nope' found.")
  ccunit.eq(err(a.setFrequency, "Secret"), "No public QIO frequency with name 'Secret' found.")
  ccunit.eq(err(a.createFrequency, "Spare"), "Unable to create public QIO frequency with name 'Spare' as one already exists.")
  ccunit.eq(err(a.setFrequency, "100%"), "Java Exception Thrown: java.util.UnknownFormatConversionException: Conversion = '''")
  ccunit.eq(err(a.setFrequency, "%s"), "Java Exception Thrown: java.util.MissingFormatArgumentException: Format specifier '%s'")
  ccunit.eq(err(a.setFrequencyColor, "mauve"), "Invalid argument 0, setFrequencyColor expected EnumColor but received type String with value mauve.")
  ccunit.eq(err(a.setFrequencyColor, 18), "Invalid argument 0, setFrequencyColor expected EnumColor but received type Double with value 18.0.")
  ccunit.eq(err(peripheral.wrap("locked").setExportsWithoutFilter, true), "Setter not available due to machine security not being public.")
  ccunit.eq(peripheral.wrap("locked").getFrequencyColor(), "RED") -- getters work whatever the security
end)

ccunit.test("colours step through all 18 and wrap", function()
  local a = peripheral.wrap("array")
  a.setFrequencyColor("indigo")
  a.incrementFrequencyColor()
  ccunit.eq(a.getFrequencyColor(), "BRIGHT_GREEN")
  a.setFrequencyColor(0)
  a.decrementFrequencyColor()
  ccunit.eq(a.getFrequencyColor(), "BRIGHT_PINK")
  a.incrementFrequencyColor()
  ccunit.eq(a.getFrequencyColor(), "BLACK")
  -- the colour belongs to the frequency: every block on it sees it
  ccunit.eq(peripheral.call("dash", "getFrequencyColor"), "BLACK")
end)

ccunit.test("frequencies are shared and move drives", function()
  local a, dash = peripheral.wrap("array"), peripheral.wrap("dash")
  a.setFrequency("Spare")
  ccunit.eq(a.getFrequencyItemCount(), 1032)
  ccunit.eq(dash.getFrequency().key, "Vault")
  a.createFrequency("Fresh")
  ccunit.eq(a.getFrequency(), { key = "Fresh", public = true })
  ccunit.eq(#a.getFrequencies(), 3)
  peripheral.call("lonely", "createFrequency", "Orphan") -- no owner: nothing happens
  ccunit.eq(#a.getFrequencies(), 3)
  ccunit.eq(peripheral.call("lonely", "hasFrequency"), false)
  dash.setFrequency("Fresh")
  ccunit.eq(dash.getFrequency().key, "Fresh")
  a.setFrequency("Vault")
  ccunit.eq(a.getFrequencyItemTypeCount(), 4)
end)
`,
      world,
      "basic.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("filters, importer and exporter settings, dashboard, redstone adapter", async () => {
    const result = await lua(
      `
ccunit.test("exporter settings and filters", function()
  local e = peripheral.wrap("exp")
  ccunit.eq(e.getExportWithoutFilter(), false)
  e.setExportsWithoutFilter(true)
  ccunit.eq(e.getExportWithoutFilter(), true)
  ccunit.eq(e.getFilters(), {})
  ccunit.eq(e.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:cobblestone" }), true)
  -- equality ignores NBT: the same item and fuzzy mode is a duplicate
  ccunit.eq(e.addFilter({ type = "qio_itemstack_filter", item = "cobblestone", itemNBT = { a = 1 } }), false)
  ccunit.eq(e.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet", fuzzy = true }), true)
  ccunit.eq(e.addFilter({ type = "QIO_TAG_FILTER", tag = "Forge:Ingots/*" }), true)
  ccunit.eq(e.addFilter({ type = "QIO_MODID_FILTER", modId = "mekan*" }), true)
  ccunit.eq(e.getFilters(), {
    { type = "QIO_ITEMSTACK_FILTER", item = "minecraft:cobblestone", fuzzy = false },
    { type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet", fuzzy = true },
    { type = "QIO_TAG_FILTER", tag = "forge:ingots/*" },
    { type = "QIO_MODID_FILTER", modId = "mekan*" },
  })
  ccunit.eq(e.removeFilter({ type = "QIO_TAG_FILTER", tag = "forge:ingots/*" }), true)
  ccunit.eq(e.removeFilter({ type = "QIO_TAG_FILTER", tag = "forge:ingots/*" }), false)
  ccunit.eq(e.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:stick", itemNBT = { Level = 3, Name = "x" } }), true)
  local f = e.getFilters()[4]
  ccunit.eq(f.itemNBT, { Level = 3, Name = "x" })
  ccunit.eq(e.getRedstoneMode(), "DISABLED")
  e.setRedstoneMode("high")
  ccunit.eq(e.getRedstoneMode(), "HIGH")
  e.setRedstoneMode(2)
  ccunit.eq(e.getRedstoneMode(), "LOW")
  ccunit.eq(err(e.setRedstoneMode, "pulse"), "Unsupported redstone control mode: PULSE")
  ccunit.eq(err(e.setRedstoneMode, "off"), "Invalid argument 0, setRedstoneMode expected RedstoneControl but received type String with value off.")
  ccunit.eq(e.getSupportedUpgrades(), { "SPEED" })
  ccunit.eq(e.getInstalledUpgrades(), { SPEED = 3 })
  ccunit.eq(peripheral.call("imp", "getInstalledUpgrades"), {})
end)

ccunit.test("filter tables Mekanism refuses", function()
  local e = peripheral.wrap("exp")
  local function bad(t, shown)
    ccunit.eq(err(e.addFilter, t), "Invalid argument 0, addFilter expected QIOFilter but received type HashMap with value " .. shown .. ".")
  end
  bad({ type = "QIO_ITEMSTACK_FILTER" }, "{type=QIO_ITEMSTACK_FILTER}")
  bad({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:air" }, "{item=minecraft:air, type=QIO_ITEMSTACK_FILTER}")
  bad({ type = "QIO_ITEMSTACK_FILTER", item = "Bad Name" }, "{item=Bad Name, type=QIO_ITEMSTACK_FILTER}")
  bad({ type = "SORTER_TAG_FILTER", tag = "forge:ingots" }, "{tag=forge:ingots, type=SORTER_TAG_FILTER}")
  bad({ type = "QIO_TAG_FILTER", tag = "" }, "{tag=, type=QIO_TAG_FILTER}")
  bad({ type = "QIO_TAG_FILTER", tag = "a b" }, "{tag=a b, type=QIO_TAG_FILTER}")
  bad({ type = "QIO_MODID_FILTER", modId = "a:b" }, "{type=QIO_MODID_FILTER, modId=a:b}")
  -- NBT lists must be keyed from 0, as Mekanism returns them; a Lua array is refused
  bad({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:stick", itemNBT = { L = { 1, 2 } } },
    "{item=minecraft:stick, type=QIO_ITEMSTACK_FILTER, itemNBT={L={1.0=1.0, 2.0=2.0}}}")
  -- Java's own HashMap.toString order (checked with a JDK). Keys that share a bucket (x, name and count all do)
  -- come out in Cobalt's insertion order, which the emulator cannot know, so this table avoids that
  ccunit.eq(err(e.setFrequency, { "a", "b", "c", x = true, n = 64 }),
    "Invalid argument 0, setFrequency expected String but received type HashMap with value {1.0=a, 2.0=b, 3.0=c, x=true, n=64.0}.")
  ccunit.eq(e.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:apple", itemNBT = { L = { [0] = 1, [1] = 300 } } }), true)
  local got = e.getFilters()
  ccunit.eq(got[#got].itemNBT, { L = { [0] = 1, [1] = 300 } })
  ccunit.eq(err(e.addFilter, "x"), "Invalid argument 0, addFilter expected QIOFilter but received type String with value x.")
end)

ccunit.test("importer settings", function()
  local i = peripheral.wrap("imp")
  ccunit.eq(i.getImportWithoutFilter(), true)
  i.setImportsWithoutFilter(false)
  ccunit.eq(i.getImportWithoutFilter(), false)
  ccunit.eq(err(i.setImportsWithoutFilter, 1), "Invalid argument 0, setImportsWithoutFilter expected boolean but received type Double with value 1.0.")
end)

ccunit.test("dashboard crafting windows", function()
  local d = peripheral.wrap("dash")
  ccunit.eq(d.getCraftingInput(0, 0), { name = "minecraft:oak_planks", count = 2 })
  ccunit.eq(d.getCraftingInput(0, 1), { name = "minecraft:air", count = 0 })
  ccunit.eq(d.getCraftingOutput(0), { name = "minecraft:stick", count = 4 })
  ccunit.eq(d.getCraftingOutput(2), { name = "minecraft:air", count = 0 })
  ccunit.eq(err(d.getCraftingOutput, 3), "Window '3' is out of bounds, must be between 0 and 3.")
  ccunit.eq(err(d.getCraftingInput, 0, 9), "Slot '9' is out of bounds, must be between 0 and 9.")
  ccunit.eq(err(d.getCraftingInput, 0), "Mismatched parameter count. getCraftingInput expected: '2' arguments, but received: '1' arguments.")
end)

ccunit.test("redstone adapter", function()
  local r = peripheral.wrap("adapter")
  ccunit.eq(r.getTargetItem(), { name = "minecraft:cobblestone", count = 1 })
  ccunit.eq(r.getTriggerAmount(), 500)
  r.setTriggerAmount(2.9)
  ccunit.eq(r.getTriggerAmount(), 2)
  ccunit.eq(err(r.setTriggerAmount, -1), "Trigger amount cannot be negative. Received: -1")
  r.setTargetItem("stone")
  ccunit.eq(r.getTargetItem(), { name = "minecraft:stone", count = 1 })
  ccunit.eq(err(r.setTargetItem, "minecraft:air"), "Target item 'minecraft:air' could not be found. If you are trying to clear it consider using clearTargetItem instead.")
  ccunit.eq(err(r.setTargetItem, "Stone"), "Invalid argument 0, setTargetItem expected ResourceLocation but received type String with value Stone.")
  r.clearTargetItem()
  ccunit.eq(r.getTargetItem(), { name = "minecraft:air", count = 0 })
end)
`,
      {
        ...world,
        peripherals: [
          ...(world.peripherals ?? []),
          {
            name: "exp",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            speedUpgrades: 3,
          },
          { name: "imp", type: "qioImporter", owner: "Alice" },
        ],
      },
      "settings.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("restricts known items when the world lists them", async () => {
    const result = await lua(
      `
ccunit.test("registry", function()
  local r = peripheral.wrap("adapter")
  r.setTargetItem("minecraft:diamond")
  ccunit.eq(err(r.setTargetItem, "minecraft:dirt"), "Target item 'minecraft:dirt' could not be found. If you are trying to clear it consider using clearTargetItem instead.")
  r.setTargetItem("minecraft:diamond_helmet") -- seen in a fixture, so it exists
end)
`,
      {
        ...world,
        mekanism: { ...world.mekanism, knownItems: ["minecraft:diamond"] },
      },
      "registry.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

describe.skipIf(!ready)("QIO call timing", () => {
  it("waits a server tick and eats events, but bad arguments fail at once", async () => {
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
  local a = peripheral.wrap("array")
  ccunit.eq(survives(function() a.getSlotCount() end), false)
  ccunit.eq(survives(function() a.getDrive(99) end), false) -- range check runs on the server thread
  ccunit.eq(survives(function() a.getDrive("x") end), true) -- argument types are checked before the wait
  ccunit.eq(survives(function() a.getSlotCount(1) end), true)
  local t0 = os.clock()
  for _ = 1, 4 do a.getSlotCount() end
  ccunit.truthy(os.clock() - t0 >= 0.2, "four calls take four ticks")
end)
`,
      world,
      "timing.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── machines on the virtual clock ─────────────

type Stack = { name: string; count: number; [k: string]: unknown };

/** Run an idle session and step it with sim commands; each step returns the state after the command. */
async function withSession(
  w: WorldConfig,
  run: (step: (c: SimCommand) => Promise<SimState>) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
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

function inv(state: SimState, name: string): Record<string, Stack> {
  return (state.inventories?.[name] ?? {}) as Record<string, Stack>;
}

function total(slots: Record<string, Stack>, item: string): number {
  return Object.values(slots)
    .filter((s) => s.name === item)
    .reduce((a, s) => a + s.count, 0);
}

function frequency(state: SimState, name: string) {
  return state.qio!.frequencies.find((f) => f.name === name)!;
}

/** The exporter and importer act on the first tick, then every 11th (delay 10). */
function operations(gameTime: number): number {
  return Math.floor(gameTime / 11) + 1;
}

const vaultDrive = {
  tier: "base" as const,
  items: [{ name: "minecraft:cobblestone", count: 1000 }, helmetA, helmetB],
};

describe.skipIf(!ready)("QIO exporter", () => {
  it("exports 64 of one type every 11 ticks, slot by slot, gear one per slot", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [vaultDrive],
          },
          { name: "out", type: "minecraft:chest", size: 27 },
          {
            name: "exp",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            target: "out",
            exportWithoutFilter: true,
          },
        ],
      },
      async (step) => {
        for (const seconds of [0.3, 0.6, 2, 6]) {
          const state = await step({ cmd: "advance", seconds });
          const n = operations(state.qio!.gameTime);
          const cobble = Math.min(1000, 64 * n);
          const helmets = Math.max(0, Math.min(2, n - 16));
          const out = inv(state, "out");
          expect(total(out, "minecraft:cobblestone")).toBe(cobble);
          expect(total(out, "minecraft:diamond_helmet")).toBe(helmets);
          expect(frequency(state, "Vault").itemCount).toBe(
            1002 - cobble - helmets,
          );
          if (n >= 18) {
            // 15 full stacks, then the last 40, then each helmet in its own slot (stack size 1)
            expect(out["15"]?.count).toBe(64);
            expect(out["16"]).toMatchObject({
              name: "minecraft:cobblestone",
              count: 40,
            });
            expect(out["17"]).toMatchObject({
              name: "minecraft:diamond_helmet",
              count: 1,
            });
            expect(out["18"]).toMatchObject({
              name: "minecraft:diamond_helmet",
              count: 1,
            });
            expect(frequency(state, "Vault").typeCount).toBe(0);
          }
        }
      },
    );
  }, 90000);

  it("speed upgrades: 320 items and 5 types per operation; a full chest takes nothing", async () => {
    const gear = Array.from({ length: 8 }, (_, i) => ({
      name: "minecraft:diamond_sword",
      count: 1,
      maxCount: 1,
      nbt: { gear: { id: `s${i}` } },
    }));
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [{ tier: "base", items: gear }],
          },
          { name: "out", type: "minecraft:chest", size: 27 },
          {
            name: "exp",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            target: "out",
            exportWithoutFilter: true,
            speedUpgrades: 8,
          },
          {
            name: "full",
            type: "minecraft:chest",
            size: 1,
            items: { "1": { name: "minecraft:dirt", count: 64 } },
          },
          {
            name: "exp2",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            target: "full",
            exportWithoutFilter: true,
          },
        ],
      },
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 0.05 });
        const n = operations(state.qio!.gameTime);
        // the full chest's exporter ticks too, but nothing fits: it removes nothing
        expect(inv(state, "full")["1"]).toMatchObject({ count: 64 });
        expect(total(inv(state, "out"), "minecraft:diamond_sword")).toBe(
          Math.min(8, 5 * n),
        );
      },
    );
  }, 60000);

  it("fills slots from the first: a partial stack later in the chest is not topped up first", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [vaultDrive],
          },
          {
            name: "out",
            type: "minecraft:chest",
            size: 27,
            items: { "5": { name: "minecraft:cobblestone", count: 10 } },
          },
          {
            name: "exp",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            target: "out",
            filters: [
              { type: "QIO_ITEMSTACK_FILTER", item: "minecraft:cobblestone" },
            ],
          },
        ],
      },
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 0.05 });
        const out = inv(state, "out");
        expect(out["1"]).toMatchObject({ count: 64 });
        expect(out["5"]).toMatchObject({ count: 10 });
      },
    );
  }, 60000);

  it("redstone control: HIGH waits for a signal, and the delay only counts down while it may run", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [vaultDrive],
          },
          { name: "out", type: "minecraft:chest", size: 27 },
          {
            name: "exp",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            target: "out",
            exportWithoutFilter: true,
            redstoneMode: "HIGH",
          },
        ],
      },
      async (step) => {
        let state = await step({ cmd: "advance", seconds: 2 });
        expect(total(inv(state, "out"), "minecraft:cobblestone")).toBe(0);
        state = await step({
          cmd: "qioSetPowered",
          block: "exp",
          powered: true,
        });
        const on = state.qio!.gameTime;
        state = await step({ cmd: "advance", seconds: 1 });
        const ran = state.qio!.gameTime - on; // ticks it has been powered
        expect(total(inv(state, "out"), "minecraft:cobblestone")).toBe(
          64 * (Math.floor((ran - 1) / 11) + 1),
        );
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("QIO importer", () => {
  it("takes from the last slot first, one type and 64 items per operation", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [{ tier: "base" }],
          },
          {
            name: "in",
            type: "minecraft:chest",
            size: 27,
            items: {
              "1": { name: "minecraft:cobblestone", count: 64 },
              "2": { name: "minecraft:cobblestone", count: 36 },
              "3": { name: "minecraft:dirt", count: 10 },
              "27": { name: "minecraft:stone", count: 64 },
            },
          },
          {
            name: "imp",
            type: "qioImporter",
            owner: "Alice",
            frequency: "Vault",
            target: "in",
          },
        ],
      },
      async (step) => {
        for (const seconds of [0.05, 0.5, 0.5, 1]) {
          const state = await step({ cmd: "advance", seconds });
          const n = operations(state.qio!.gameTime);
          const want = [
            { stone: 64, dirt: 0, cobble: 0 },
            { stone: 64, dirt: 10, cobble: 0 },
            { stone: 64, dirt: 10, cobble: 64 }, // slot 2's 36 first, then 28 of slot 1: one type, 64 an operation
            { stone: 64, dirt: 10, cobble: 100 },
          ][Math.min(n, 4) - 1]!;
          const items = frequency(state, "Vault").items;
          const count = (name: string) =>
            items.find((i) => i.name === name)?.count ?? 0;
          expect(count("minecraft:stone")).toBe(want.stone);
          expect(count("minecraft:dirt")).toBe(want.dirt);
          expect(count("minecraft:cobblestone")).toBe(want.cobble);
          expect(total(inv(state, "in"), "minecraft:cobblestone")).toBe(
            100 - want.cobble,
          );
        }
      },
    );
  }, 90000);

  it("a type the drives refuse still uses up the operation's one type", async () => {
    const full = Array.from({ length: 128 }, (_, i) => ({
      name: "minecraft:paper",
      count: 1,
      nbt: { n: i },
    }));
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [{ tier: "base", items: full }],
          },
          {
            name: "in",
            type: "minecraft:chest",
            size: 27,
            items: {
              "1": { name: "minecraft:paper", count: 5, nbt: { n: 0 } },
              "27": { name: "minecraft:stone", count: 64 },
            },
          },
          {
            name: "imp",
            type: "qioImporter",
            owner: "Alice",
            frequency: "Vault",
            target: "in",
          },
        ],
      },
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 3 });
        // 128 of 128 types: stone is refused, and the paper (a stored type) is never reached
        expect(frequency(state, "Vault").typeCount).toBe(128);
        expect(inv(state, "in")["27"]).toMatchObject({ count: 64 });
        expect(inv(state, "in")["1"]).toMatchObject({ count: 5 });
      },
    );
  }, 60000);

  it("a drive takes no more than its item limit", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [
              {
                tier: "base",
                items: [{ name: "minecraft:cobblestone", count: 15990 }],
              },
            ],
          },
          {
            name: "in",
            type: "minecraft:chest",
            size: 27,
            items: { "1": { name: "minecraft:cobblestone", count: 64 } },
          },
          {
            name: "imp",
            type: "qioImporter",
            owner: "Alice",
            frequency: "Vault",
            target: "in",
          },
        ],
      },
      async (step) => {
        const state = await step({ cmd: "advance", seconds: 2 });
        expect(frequency(state, "Vault").itemCount).toBe(16000);
        expect(inv(state, "in")["1"]).toMatchObject({ count: 54 });
        expect(
          (state.qio!.blocks["array"]!["drives"] as Record<string, unknown>)[
            "0"
          ],
        ).toMatchObject({ status: "FULL" });
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("QIO filters move the right items", () => {
  it("fuzzy, exact NBT, tag and mod id filters; and Lua numbers are the wrong NBT type", async () => {
    const result = await lua(
      `
local exp = peripheral.wrap("exp")
local out = peripheral.wrap("out")
local function names()
  local t = {}
  for _, item in pairs(out.list()) do t[#t + 1] = item.name .. "x" .. item.count end
  return sorted(t)
end
local function clear() for slot in pairs(out.list()) do out.pushItems("bin", slot) end end

ccunit.test("an exact filter without NBT matches no gear", function()
  exp.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet" })
  sleep(1)
  ccunit.eq(names(), {})
  exp.removeFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet" })
end)

ccunit.test("Lua numbers become bytes, so a Lua NBT filter does not match int NBT", function()
  exp.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet",
    itemNBT = { vaultGear = { id = "a1", level = 50 }, Damage = 0 } })
  sleep(1)
  ccunit.eq(names(), {})
  exp.removeFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet" })
end)

ccunit.test("type hints make ints, and then the exact piece moves", function()
  local int = function(v) return { [0] = v, typeHint = 3 } end
  exp.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet",
    itemNBT = { vaultGear = { id = "a1", level = int(50) }, Damage = int(0) } })
  sleep(1)
  ccunit.eq(names(), { "minecraft:diamond_helmetx1" })
  local detail = out.getItemDetail(1)
  ccunit.eq(detail.maxCount, 1)
  ccunit.eq(detail.__qioTag, nil)
  ccunit.eq(peripheral.call("array", "getFrequencyItemTypeCount"), 3) -- that piece was its own type
  exp.removeFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet" })
  clear()
end)

ccunit.test("fuzzy takes every piece", function()
  exp.addFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet", fuzzy = true })
  sleep(1)
  ccunit.eq(names(), { "minecraft:diamond_helmetx1" }) -- the one left
  exp.removeFilter({ type = "QIO_ITEMSTACK_FILTER", item = "minecraft:diamond_helmet", fuzzy = true })
  clear()
end)

ccunit.test("tag and mod id wildcards", function()
  exp.addFilter({ type = "QIO_TAG_FILTER", tag = "forge:ingots/*" })
  sleep(1)
  ccunit.eq(names(), { "mekanism:ingot_osmiumx30" })
  exp.removeFilter({ type = "QIO_TAG_FILTER", tag = "forge:ingots/*" })
  clear()
  exp.addFilter({ type = "QIO_MODID_FILTER", modId = "mine*" })
  sleep(0.6)
  ccunit.eq(names(), { "minecraft:cobblestonex64" })
end)

ccunit.test("items that come back are the same type", function()
  exp.removeFilter({ type = "QIO_MODID_FILTER", modId = "mine*" })
  for slot in pairs(out.list()) do out.pushItems("in", slot) end
  sleep(1)
  ccunit.eq(peripheral.call("array", "getFrequencyItemTypeCount"), 1) -- the 64 cobblestone, merged back into one type
  ccunit.eq(peripheral.call("array", "getFrequencyItemCount"), 64)
end)
`,
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [
              {
                tier: "base",
                items: [
                  { name: "minecraft:cobblestone", count: 64 },
                  helmetA,
                  helmetB,
                  {
                    name: "mekanism:ingot_osmium",
                    count: 30,
                    tags: ["forge:ingots/osmium"],
                  },
                ],
              },
            ],
          },
          { name: "out", type: "minecraft:chest", size: 27 },
          { name: "bin", type: "minecraft:chest", size: 27 },
          { name: "in", type: "minecraft:chest", size: 27 },
          {
            name: "exp",
            type: "qioExporter",
            owner: "Alice",
            frequency: "Vault",
            target: "out",
            speedUpgrades: 8,
          },
          {
            name: "imp",
            type: "qioImporter",
            owner: "Alice",
            frequency: "Vault",
            target: "in",
          },
        ],
      },
      "filters.test.lua",
    );
    expectAllPassed(result);
  }, 90000);
});

describe.skipIf(!ready)("QIO drives and the redstone adapter over time", () => {
  it("drive NBT is written when the world saves; the counts in it are live", async () => {
    const result = await lua(
      `
ccunit.test("save", function()
  local a = peripheral.wrap("array")
  local d = a.getDrive(0)
  ccunit.eq(d.nbt, nil) -- an empty drive has no NBT at all
  -- the importer stores 64; game time passes 6000: the autosave writes the drive. The importer waits for its
  -- redstone signal: running from boot, it made the frequency dirty at once, and a dirty frequency writes its drives
  -- on a random tick (1 in 100), so a boot of 25 ticks wrote the drive before the first look about 1 run in 4. The
  -- clock then jumps past 6000 (the sim catches up tick by tick); starting just short of 6000 let a busy host's boot
  -- run past the autosave before the first look
  os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON({ cmd = "qioSetPowered", block = "imp", powered = true }))
  os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON({ cmd = "advance", seconds = 10.5 }))
  sleep(0.5)
  d = a.getDrive(0)
  ccunit.eq(d.nbt.mekData.qioMetaCount, 64)
  ccunit.eq(d.nbt.mekData.qioItemMap[0].amount, 64)
  ccunit.eq(d.nbt.mekData.qioItemMap[0].Item.id, "minecraft:cobblestone")
end)

ccunit.test("redstone adapter", function()
  ccunit.eq(peripheral.call("adapter", "getTriggerAmount"), 64)
end)
`,
      {
        players: [{ name: "Alice" }],
        mekanism: { gameTime: 5800 },
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [{ tier: "base" }],
          },
          {
            name: "in",
            type: "minecraft:chest",
            size: 27,
            items: { "1": { name: "minecraft:cobblestone", count: 64 } },
          },
          {
            name: "imp",
            type: "qioImporter",
            owner: "Alice",
            frequency: "Vault",
            target: "in",
            redstoneMode: "high", // not before the test powers it
          },
          {
            name: "adapter",
            type: "qioRedstoneAdapter",
            owner: "Alice",
            frequency: "Vault",
            targetItem: "minecraft:cobblestone",
            triggerAmount: 64,
          },
        ],
      },
      "drivesave.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("the adapter emits 15 once the stored count reaches the trigger", async () => {
    await withSession(
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "array",
            type: "qioDriveArray",
            owner: "Alice",
            frequency: "Vault",
            drives: [{ tier: "base" }],
          },
          {
            name: "adapter",
            type: "qioRedstoneAdapter",
            owner: "Alice",
            frequency: "Vault",
            targetItem: "minecraft:cobblestone",
            triggerAmount: 100,
          },
        ],
      },
      async (step) => {
        let state = await step({
          cmd: "qioInsert",
          frequency: "Vault",
          item: { name: "minecraft:cobblestone", count: 99 },
        });
        expect(state.qio!.blocks["adapter"]).toMatchObject({
          powering: false,
          redstoneOutput: 0,
        });
        state = await step({
          cmd: "qioInsert",
          frequency: "Vault",
          item: { name: "minecraft:cobblestone", count: 1 },
        });
        expect(state.qio!.blocks["adapter"]).toMatchObject({
          powering: true,
          redstoneOutput: 15,
        });
      },
    );
  }, 60000);
});

// ───────────── surface ─────────────

/**
 * Every @ComputerMethod of the QIO tiles, their TileEntityMekanism base and their components, as the 10.2.5
 * source declares them, in Mekanism's binding order: the tile's methods sorted by name, then the upgrade
 * component's, then the security component's.
 */
const SOURCE: Record<
  string,
  { tile: string[]; upgrade: boolean; after?: string[] }
> = (() => {
  const component = [
    "createFrequency",
    "decrementFrequencyColor",
    "getFrequencies",
    "getFrequency",
    "getFrequencyColor",
    "hasFrequency",
    "incrementFrequencyColor",
    "setFrequency",
    "setFrequencyColor",
    "getDirection", // TileEntityMekanism, restriction DIRECTIONAL: every QIO block faces somewhere
  ];
  const filters = [
    "addFilter",
    "getFilters",
    "removeFilter",
    "getRedstoneMode", // TileEntityMekanism, restriction REDSTONE_CONTROL
    "setRedstoneMode",
  ];
  return {
    qioDriveArray: {
      tile: [
        ...component,
        "getDrive",
        "getDriveStatus",
        "getFrequencyItemCapacity",
        "getFrequencyItemCount",
        "getFrequencyItemPercentage",
        "getFrequencyItemTypeCapacity",
        "getFrequencyItemTypeCount",
        "getFrequencyItemTypePercentage",
        "getSlotCount",
      ],
      upgrade: false,
    },
    qioDashboard: {
      tile: [...component, "getCraftingInput", "getCraftingOutput"],
      upgrade: false,
    },
    qioImporter: {
      tile: [
        ...component,
        ...filters,
        "getImportWithoutFilter",
        "setImportsWithoutFilter",
      ],
      upgrade: true,
    },
    qioExporter: {
      tile: [
        ...component,
        ...filters,
        "getExportWithoutFilter",
        "setExportsWithoutFilter",
      ],
      upgrade: true,
    },
    qioRedstoneAdapter: {
      tile: [
        ...component,
        "clearTargetItem",
        "getTargetItem",
        "getTriggerAmount",
        "setTargetItem",
        "setTriggerAmount",
      ],
      upgrade: false,
    },
    // TileEntityQuantumEntangloporter (tank wrappers expand to four names each) and TileEntityMekanism with ENERGY
    quantumEntangloporter: {
      tile: [
        "hasFrequency",
        "getTransferLoss",
        "getEnvironmentalLoss",
        "getFrequencies",
        "getFrequency",
        "setFrequency",
        "createFrequency",
        "getBufferItem",
        ...["Fluid", "Gas", "InfuseType", "Pigment", "Slurry"].flatMap((t) =>
          ["", "Capacity", "Needed", "FilledPercentage"].map(
            (s) => `getBuffer${t}${s}`,
          ),
        ),
        "getTemperature",
        "getDirection",
        "getEnergy",
        "getMaxEnergy",
        "getEnergyNeeded",
        "getEnergyFilledPercentage",
      ],
      upgrade: true,
      // after security: TileComponentConfig, then TileComponentEjector, each sorted
      after: [
        ...[
          "getConfigurableTypes",
          "canEject",
          "isEjecting",
          "setEjecting",
          "getSupportedModes",
          "getMode",
          "setMode",
          "incrementMode",
          "decrementMode",
        ].sort(),
        ...[
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
        ].sort(),
      ],
    },
  };
})();

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

const surface = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./mekanism-surface.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

describe("QIO method surface (no engine)", () => {
  it("the HashMap order reproduces the measured modem order", () => {
    expect(
      javaHashMapOrder(
        // isOpen and closeAll share a bucket, so they keep their insertion order
        ["open", "isOpen", "close", "closeAll", "transmit", "isWireless"],
        6,
      ),
    ).toEqual([
      "transmit",
      "isOpen",
      "closeAll",
      "isWireless",
      "close",
      "open",
    ]);
  });

  it("mekanism-surface.json is the source's methods in CC's order", () => {
    expect(Object.keys(surface).sort()).toEqual(Object.keys(SOURCE).sort());
    for (const [type, { tile, upgrade, after }] of Object.entries(SOURCE)) {
      const bound = [
        ...[...tile].sort(),
        ...(upgrade ? ["getInstalledUpgrades", "getSupportedUpgrades"] : []),
        "getOwnerName",
        "getOwnerUUID",
        "getSecurityMode",
        ...(after ?? []),
      ];
      expect(surface[type]).toEqual(javaHashMapOrder(bound, bound.length));
    }
  });
});

describe.skipIf(!ready)("QIO method surface", () => {
  it("every QIO peripheral has exactly these methods in this order", async () => {
    const types = Object.keys(surface);
    const result = await lua(
      `
local expected = ${JSON.stringify(surface)
        .replace(/\[/g, "{")
        .replace(/\]/g, "}")
        .replace(/"(\w+)":/g, "$1 =")}
for ty, names in pairs(expected) do
  ccunit.test(ty, function()
    ccunit.eq(peripheral.getMethods("p_" .. ty), names)
    ccunit.eq({ peripheral.getType("p_" .. ty) }, { ty })
    local wrapped = peripheral.wrap("p_" .. ty)
    local n = 0
    for _ in pairs(wrapped) do n = n + 1 end
    ccunit.eq(n, #names)
    ccunit.truthy(peripheral.find(ty), "find " .. ty)
  end)
end
`,
      {
        players: [{ name: "Alice" }],
        peripherals: types.map((type) => ({
          name: `p_${type}`,
          type,
          owner: "Alice",
        })),
      },
      "surface.test.lua",
    );
    expectAllPassed(result);
    expect(types).toHaveLength(6);
  }, 60000);
});

describe.skipIf(!ready)("QIO demo world", () => {
  it("loads and answers", async () => {
    const result = await lua(
      `
ccunit.test("demo", function()
  local array = peripheral.find("qioDriveArray")
  ccunit.eq(array.getFrequency().key, "Vault Storage")
  ccunit.truthy(array.getFrequencyItemTypeCount() >= 4) -- 6 types, the exporter starts sending the helmets at once
  ccunit.truthy(peripheral.find("qioExporter"))
  ccunit.truthy(peripheral.find("qioImporter"))
  ccunit.truthy(peripheral.find("qioDashboard"))
  ccunit.truthy(peripheral.find("qioRedstoneAdapter"))
  sleep(1)
  local gear = 0
  for _, item in pairs(peripheral.wrap("gear_chest").list()) do
    if item.name:find("^minecraft:diamond_") then gear = gear + 1 end
  end
  ccunit.truthy(gear >= 1, "the exporter's fuzzy helmet filter sends gear to the chest")
  local qe = peripheral.find("quantumEntangloporter")
  ccunit.eq(qe.getFrequency().key, "Shop Link")
  ccunit.eq(peripheral.wrap("shop_drop").list()[1].name, "minecraft:diamond_chestplate") -- ejected through the front
end)
`,
      loadNamedWorld(config.worldsDir, "mekanism-qio-demo"),
      "demo.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
