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
  runTests,
  sendAndWait,
  SessionManager,
} from "./index.js";

/**
 * Create 6.0 (6.0.8 on 1.20.1, 6.0.10 on 1.21.1): the twelve peripherals it added and what changed in the six of
 * 0.5.1.i, read from the source at tags mc1.20.1-6.0.8 / mc1.21.1-6.0.10 and the two jars (docs/create-versions.md).
 * Every test runs on both versions; create.integration.test.ts has the 1.18.2 side of each change.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "create6-ws-"));
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
-- events of the given names until the timeout, as { name, args... }
local function collect(names, seconds, untilName)
  local want = {}
  for _, n in ipairs(names) do want[n] = true end
  local got = {}
  local timer = os.startTimer(seconds)
  while true do
    local ev = table.pack(os.pullEvent())
    if ev[1] == "timer" and ev[2] == timer then break end
    if want[ev[1]] then
      got[#got + 1] = { table.unpack(ev, 1, ev.n) }
      if ev[1] == untilName then break end
    end
  end
  return got
end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 90000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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

/** Every @LuaFunction of each Create peripheral class in the 6.0.8 and 6.0.10 jars (the same), declaration order. */
const surface6 = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./create-surface-6.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

const toLua = (v: unknown): string =>
  JSON.stringify(v)
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/"(\w+)":/g, "$1 =");

describe("Create 6.0 method surface (no engine)", () => {
  it("lists the eighteen peripheral types of the 6.0 jars", () => {
    expect(Object.keys(surface6)).toHaveLength(18);
    expect(surface6["Create_Station"]).toHaveLength(16);
    expect(surface6["Create_DisplayLink"]).toContain("writeBytes");
  });
});

for (const mc of ["1.20.1", "1.21.1"] as const) {
  const V21 = mc === "1.21.1";
  const slotErr = (slot: number, max: number) =>
    `Slot ${slot} out of range,${V21 ? " " : ""}available slots between 1 and ${max}`;

  describe.skipIf(!ready)(`Create 6.0 on ${mc}`, () => {
    it("getMethods is CC's HashMap order of the jar's methods; getType is the mod's type", async () => {
      const expected = Object.fromEntries(
        Object.entries(surface6).map(([t, names]) => [
          t,
          javaHashMapOrder(names, names.length),
        ]),
      );
      const result = await lua(
        `
local expected = ${toLua(expected)}
for ty, names in pairs(expected) do
  ccunit.test(ty, function()
    ccunit.eq(peripheral.getMethods("p_" .. ty), names)
    ccunit.eq({ peripheral.getType("p_" .. ty) }, { ty })
  end)
end
`,
        {
          version: mc,
          peripherals: Object.keys(surface6).map((type) => ({
            name: `p_${type}`,
            type,
          })),
        } as unknown as WorldConfig,
        `surface6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("kinetic events, the creative motor", async () => {
      const result = await lua(
        `
ccunit.test("speed_change and stress_change follow the controller; overstressed", function()
  local c = peripheral.wrap("ctl")
  c.setTargetSpeed(48)
  local got = collect({ "speed_change", "stress_change", "overstressed" }, 0.6)
  ccunit.eq(#got, 2)
  local by = {}
  for _, e in ipairs(got) do by[e[1]] = e end
  ccunit.eq(by.speed_change, { "speed_change", "outspeedo", 48 })
  ccunit.eq(by.stress_change, { "stress_change", "outstresso", 384, 1000 })
  c.setTargetSpeed(256) -- 2048 SU on 1000: overstressed, the gauge reads 0
  got = collect({ "speed_change", "stress_change", "overstressed" }, 0.6)
  by = {}
  for _, e in ipairs(got) do by[e[1]] = e end
  ccunit.eq(by.overstressed, { "overstressed", "outstresso" })
  ccunit.eq(by.speed_change, { "speed_change", "outspeedo", 0 })
  ccunit.eq(by.stress_change, nil)
  -- nothing changes: nothing is sent
  ccunit.eq(collect({ "speed_change", "stress_change", "overstressed" }, 0.4), {})
end)

ccunit.test("creative motor: default 16, clamped, drives its network", function()
  local m = peripheral.wrap("motor")
  ccunit.eq(m.getGeneratedSpeed(), 16)
  ccunit.eq(peripheral.call("motorspeedo", "getSpeed"), 16)
  m.setGeneratedSpeed(300)
  ccunit.eq(m.getGeneratedSpeed(), 256)
  ccunit.eq(peripheral.call("motorspeedo", "getSpeed"), 256)
  ccunit.eq(collect({ "speed_change" }, 0.4), { { "speed_change", "motorspeedo", 256 } })
  ccunit.eq(select("#", m.setGeneratedSpeed(-20)), 0)
  ccunit.eq(m.getGeneratedSpeed(), -20)
  ccunit.eq(err(m.setGeneratedSpeed, "x"), "bad argument #1 (number expected, got string)")
end)
`,
        {
          version: mc,
          create: {
            networks: {
              main: { speed: 64, capacity: 4096 },
              controlled: { source: "ctl", capacity: 1000, impact: 8 },
              motorNet: { source: "motor" },
            },
          },
          peripherals: [
            {
              name: "ctl",
              type: "Create_RotationSpeedController",
              network: "main",
            },
            {
              name: "outspeedo",
              type: "Create_Speedometer",
              network: "controlled",
            },
            {
              name: "outstresso",
              type: "Create_Stressometer",
              network: "controlled",
            },
            { name: "motor", type: "Create_CreativeMotor" },
            {
              name: "motorspeedo",
              type: "Create_Speedometer",
              network: "motorNet",
            },
          ],
        } as unknown as WorldConfig,
        `kinetics6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("station: canTrainReach, distanceTo, setSchedule order, events, package instructions", async () => {
      const result = await lua(
        `
local s, mine = peripheral.wrap("station"), peripheral.wrap("mine")
ccunit.test("paths", function()
  ccunit.eq(table.pack(s.canTrainReach("Mine")), { true, nil, n = 2 })
  ccunit.eq(table.pack(s.distanceTo("Mine")), { 40, nil, n = 2 })
  ccunit.eq(table.pack(s.distanceTo("M*")), { 40, nil, n = 2 })
  ccunit.eq(table.pack(s.distanceTo("Farm Stop")), { 600, nil, n = 2 })
  ccunit.eq(table.pack(s.canTrainReach("Nowhere")), { false, "no-target", n = 2 })
  ccunit.eq(table.pack(s.distanceTo("Nowhere")), { nil, "no-target", n = 2 })
  ccunit.eq(table.pack(s.canTrainReach("Depot")), { false, "cannot-reach", n = 2 }) -- in assembly mode
  ccunit.eq(err(mine.canTrainReach, "Central"), "there is no train present")
  ccunit.eq(err(peripheral.wrap("loose").distanceTo, "Mine"), "station is not connected to a track")
  ccunit.eq(err(s.distanceTo, 5), "bad argument #1 (string expected, got number)")
end)

ccunit.test("setSchedule: the train first, no key count, the parsed entries", function()
  ccunit.eq(err(mine.setSchedule, "x"), "there is no train present")
  ccunit.eq(err(s.setSchedule, "x"), "bad argument #1 (table expected, got string)")
  ccunit.eq(err(s.setSchedule, { entries = {}, cyclic = true, extra = 1 }), "Schedule must have at least one entry")
  ccunit.eq(err(s.setSchedule, { Entries = {}, cyclic = true }), "Schedule must have at least one entry")
end)

ccunit.test("a package delivery entry is kept, skipped, and the train goes on to Mine", function()
  s.setSchedule({ cyclic = false, entries = {
    { instruction = { id = "create:package_delivery", data = {} }, conditions = {} },
    { instruction = { id = "create:destination", data = { text = "Mine" } },
      conditions = { { { id = "create:delay", data = { value = 1, time_unit = 1 } } } } },
  } })
  ccunit.eq(s.getSchedule().entries[1].instruction.id, "create:package_delivery")
  local got = collect({ "train_departure", "train_imminent", "train_arrival" }, 20, "train_arrival")
  ccunit.eq(got, {
    { "train_departure", "station", "Express" },
    { "train_imminent", "mine", "Express" },
    { "train_arrival", "mine", "Express" },
  })
  ccunit.eq(mine.getTrainName(), "Express")
end)
`,
        {
          version: mc,
          create: {
            stations: ["Farm Stop"],
            distances: { "Central|Mine": 40, "Central|Farm Stop": 600 },
            trains: [{ name: "Express", at: "Central" }],
          },
          peripherals: [
            { name: "station", type: "Create_Station", station: "Central" },
            { name: "mine", type: "Create_Station", station: "Mine" },
            {
              name: "depot",
              type: "Create_Station",
              station: "Depot",
              assembling: true,
            },
            { name: "loose", type: "Create_Station", track: false },
          ],
        } as unknown as WorldConfig,
        `station6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("display link: writeBytes, getSize after a restart, the cursor check", async () => {
      const result = await lua(
        `
local l = peripheral.wrap("link")
ccunit.test("writeBytes", function()
  l.writeBytes({ 72, 105 })
  l.writeBytes("!\\200")
  ccunit.eq(table.pack(l.getCursorPos()), { 5, 1, n = 2 })
  l.setCursorPos(1, 2)
  l.writeBytes({ 0xC3, 0xA9 })
  ccunit.eq(table.pack(l.getCursorPos()), { 2, 2, n = 2 }) -- the two UTF-8 bytes are one character
  ccunit.eq(err(l.writeBytes, 5), "bad argument #1 (string or table expected, got number)")
  ccunit.eq(err(l.writeBytes, { "x" }), "bad item #1 (number expected, got string)")
end)
ccunit.test("getSize finds the target itself: no NullPointerException after a restart", function()
  ccunit.eq(table.pack(peripheral.call("restarted", "getSize")), { 4, 15, n = 2 })
end)
ccunit.test("setCursorPos below 1", function()
  ${
    V21
      ? `ccunit.eq(err(l.setCursorPos, 0, 1), "cursor position must be larger then 0")
  ccunit.eq(err(l.setCursorPos, 1, -3), "cursor position must be larger then 0")`
      : `l.setCursorPos(0, 1) -- 6.0.8 takes it; the write then fails in Java
  ccunit.eq(table.pack(l.getCursorPos()), { 0, 1, n = 2 })`
  }
end)
`,
        {
          version: mc,
          peripherals: [
            { name: "link", type: "Create_DisplayLink", target: "sign" },
            {
              name: "restarted",
              type: "Create_DisplayLink",
              target: "sign",
              restarted: true,
            },
          ],
        } as unknown as WorldConfig,
        `link6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("sticker, signal, nixie tube", async () => {
      const result = await lua(
        `
ccunit.test("sticker", function()
  local s = peripheral.wrap("sticker")
  ccunit.eq(s.isExtended(), false)
  ccunit.eq(s.isAttachedToBlock(), false)
  ccunit.eq(s.extend(), true)
  ccunit.eq(s.extend(), false)
  ccunit.eq(s.isAttachedToBlock(), true)
  ccunit.eq(s.toggle(), true)
  ccunit.eq(s.isExtended(), false)
  ccunit.eq(s.retract(), false)
end)

ccunit.test("signal: state, type, forced red, its event and the 15-tick hold", function()
  local g = peripheral.wrap("sig")
  ccunit.eq(g.getState(), "GREEN")
  ccunit.eq(g.getSignalType(), "ENTRY_SIGNAL")
  ccunit.eq(g.listBlockingTrainNames(), {})
  ccunit.eq(g.isForcedRed(), false)
  g.setForcedRed(true)
  ccunit.eq(g.isForcedRed(), true)
  ccunit.eq(collect({ "train_signal_state_change" }, 0.5), { { "train_signal_state_change", "sig", "RED" } })
  ccunit.eq(g.getState(), "RED")
  g.setForcedRed(false)
  ccunit.eq(collect({ "train_signal_state_change" }, 0.5, "train_signal_state_change"),
    { { "train_signal_state_change", "sig", "GREEN" } })
  g.setForcedRed(true)
  local t0 = os.clock()
  ccunit.eq(collect({ "train_signal_state_change" }, 2, "train_signal_state_change"),
    { { "train_signal_state_change", "sig", "RED" } })
  ccunit.truthy(os.clock() - t0 >= 0.5, "red waits 15 ticks after green")
  g.cycleSignalType()
  ccunit.eq(g.getSignalType(), "CROSS_SIGNAL")
  local none = peripheral.wrap("nosig")
  ccunit.eq(none.getState(), "INVALID")
  ccunit.eq(err(none.getSignalType), "no signal")
  ccunit.eq(err(none.listBlockingTrainNames), "no signal")
  ccunit.eq(peripheral.call("busy", "listBlockingTrainNames"), { "Freight" })
  ccunit.eq(peripheral.call("busy", "getState"), "RED")
end)

ccunit.test("nixie tube: arguments and errors", function()
  local n = peripheral.wrap("nixie")
  ccunit.eq(select("#", n.setText("12")), 0)
  n.setText("x", "grey")
  n.setTextColor("LIGHT_BLUE")
  ccunit.eq(err(n.setText, "x", "pink2"), "bad argument #2 (unknown option pink2)")
  ccunit.eq(err(n.setTextColour, "nope"), "bad argument #2 (unknown option nope)") -- (sic) #2
  ccunit.eq(err(n.setText, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(n.setText, "x", 5), "bad argument #2 (string expected, got number)")
  ccunit.eq(err(n.setSignal, { r = 300 }), "field r must be in range 0-255")
  ccunit.eq(err(n.setSignal, { b = -1 }), "field r must be in range 0-255") -- (sic) r
  ccunit.eq(err(n.setSignal, { glowWidth = 5 }), "field glowWidth must be in range 1-4")
  ccunit.eq(err(n.setSignal, { g = "x" }), "bad field 'g' (number expected, got string)")
  ccunit.eq(err(n.setSignal, 5), "bad argument #1 (table expected, got number)")
  n.setSignal(nil, { r = 0, g = 0, b = 0 })
end)
`,
        {
          version: mc,
          peripherals: [
            { name: "sticker", type: "Create_Sticker" },
            { name: "sig", type: "Create_Signal" },
            { name: "nosig", type: "Create_Signal", signal: false },
            { name: "busy", type: "Create_Signal", trains: ["Freight"] },
            { name: "nixie", type: "Create_NixieTube", tubes: 2 },
          ],
        } as unknown as WorldConfig,
        `blocks6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("stock ticker filters, redstone requester, table cloth", async () => {
      const result = await lua(
        `
local t = peripheral.wrap("ticker")
ccunit.test("stock and its details", function()
  ccunit.eq(t.stock(), {
    { name = "minecraft:diamond", count = 100 },
    { name = "minecraft:iron_ingot", count = 640 },
    { name = "minecraft:oak_log", count = 32 },
  })
  ccunit.eq(t.stock(true)[1].displayName, "Diamond")
  ccunit.eq(t.getStockItemDetail(2).count, 640)
  ccunit.eq(err(t.getStockItemDetail, 4), ${JSON.stringify(slotErr(4, 3))})
  ccunit.eq(t.list(), {})
  ccunit.eq(err(t.getItemDetail, 28), ${JSON.stringify(slotErr(28, 27))})
end)

ccunit.test("requestFiltered", function()
  ccunit.eq(t.requestFiltered("Farm", { name = "minecraft:diamond", _requestCount = 10 }), 10)
  ccunit.eq(t.stock()[1].count, 90)
  ccunit.eq(t.requestFiltered("Farm", { name = "diamond" }), 0) -- (sic) a name without a namespace never matches
  ccunit.eq(t.requestFiltered("Farm", { count = { _op = ">=", value = 500 } }), 640)
  ccunit.eq(t.requestFiltered("Farm", { tags = { ["minecraft:logs"] = true }, _requestCount = 5 }), 5)
  ccunit.eq(t.requestFiltered("Farm", { name = { _op = "glob", value = "minecraft:*_log" } }), 27)
  ccunit.eq(t.requestFiltered("Farm", { name = { _op = "not", value = "minecraft:stone" }, _requestCount = 1 },
    { name = "minecraft:diamond", _requestCount = 2 }), 3)
  ccunit.eq(t.requestFiltered("Farm"), 0)
  ccunit.eq(t.stock(), { { name = "minecraft:diamond", count = 87 } })
end)

ccunit.test("requestFiltered errors", function()
  ccunit.eq(err(t.requestFiltered, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(t.requestFiltered, "a", 5), "Filter must be a table")
  ccunit.eq(err(t.requestFiltered, "a", { "x" }), "Filter keys must be strings")
  ccunit.eq(err(t.requestFiltered, "a", { _requestCount = 0 }), "_requestCount must be a positive number or nil for no limit")
  ccunit.eq(err(t.requestFiltered, "a", { _requestCount = "x" }), "_requestCount must be a positive number or nil for no limit")
  ccunit.eq(err(t.requestFiltered, "a", { name = { _op = "any", value = "x" } }), "any operator requires a list of values")
  ccunit.eq(err(t.requestFiltered, "a", { count = { _op = "type", value = "blah" } }), "Unknown type: blah")
  ccunit.eq(err(t.requestFiltered, "a", { count = { _op = "%", value = 1 } }), "Unknown operator: %")
  ccunit.eq(err(t.requestFiltered, "a", { name = { _op = ">", value = 1 } }), "Operator > not supported for type Double")
  ccunit.eq(err(t.requestFiltered, "a", { _mode = "weird" }), "Invalid match mode: weird, expected 'exact', 'contained' or 'contains'")
end)

ccunit.test("redstone requester", function()
  local r = peripheral.wrap("req")
  ccunit.eq(r.getRequest(), {})
  ccunit.eq(r.getConfiguration(), "strict")
  r.setRequest("minecraft:diamond", { name = "minecraft:diamond", count = 3 })
  local q = r.getRequest()
  ccunit.eq({ q[1].name, q[1].count, q[2].count }, { "minecraft:diamond", 1, 3 })
  ccunit.eq(err(r.setRequest, { name = "x:y", count = 300 }), "Count for item x:y exceeds 256")
  ccunit.eq(err(r.setConfiguration, "bad"), 'Unknown configuration: "bad" Possible configurations are: "allow_partial" and "strict".')
  ccunit.eq(err(r.setCraftingRequest, "x"), "bad argument #1 (number expected, got string)")
  r.setAddress("Base")
  ccunit.eq(r.getAddress(), "Base")
  r.request()
  ccunit.eq(peripheral.call("ticker2", "stock"), { { name = "minecraft:diamond", count = 1 } })
  r.request() -- strict: 4 wanted, 1 there: nothing
  ccunit.eq(peripheral.call("ticker2", "stock"), { { name = "minecraft:diamond", count = 1 } })
  r.setConfiguration("allow_partial")
  r.request()
  ccunit.eq(peripheral.call("ticker2", "stock"), {})
end)

ccunit.test("table cloth shop", function()
  local c = peripheral.wrap("cloth")
  ccunit.eq(c.isShop(), false)
  ccunit.eq(err(c.getAddress), "TableCloth is not a shop!")
  ccunit.eq(err(c.setWares, { name = "minecraft:emerald", count = 300 }), "Count for item minecraft:emerald exceeds 256")
  ccunit.eq(err(c.setWares, "x"), "bad argument #1 (table expected, got string)")
  ccunit.eq(err(c.setWares, { name = "Bad Name" }), "Invalid item at index: 1")
  c.setWares(nil, { name = "minecraft:emerald", count = 2 })
  ccunit.eq(c.isShop(), true)
  ccunit.eq(c.getWares()[1].count, 2)
  c.setPriceTagItem("minecraft:diamond")
  ccunit.eq(c.getPriceTagItem().name, "minecraft:diamond")
  c.setPriceTagCount(500)
  ccunit.eq(c.getPriceTagCount(), 100)
  c.setPriceTagCount()
  ccunit.eq(c.getPriceTagCount(), 1)
  ccunit.eq(err(peripheral.wrap("manual").setWares, {}), "Tablecloth isn't empty.")
end)
`,
        {
          version: mc,
          create: {
            stock: {
              main: [
                { name: "minecraft:diamond", count: 100 },
                { name: "minecraft:iron_ingot", count: 640 },
                {
                  name: "minecraft:oak_log",
                  count: 32,
                  tags: { "minecraft:logs": true },
                },
              ],
              req: [{ name: "minecraft:diamond", count: 5 }],
            },
          },
          peripherals: [
            { name: "ticker", type: "Create_StockTicker" },
            { name: "ticker2", type: "Create_StockTicker", network: "req" },
            {
              name: "req",
              type: "Create_RedstoneRequester",
              network: "req",
            },
            { name: "cloth", type: "Create_TableClothShop" },
            {
              name: "manual",
              type: "Create_TableClothShop",
              items: [{ name: "minecraft:apple", count: 1 }],
            },
          ],
        } as unknown as WorldConfig,
        `logistics6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("packagers, package objects, package ports", async () => {
      const result = await lua(
        `
ccunit.test("packager: makePackage, the event, the held box, the address", function()
  local p = peripheral.wrap("pk")
  ccunit.eq(p.getAddress(), "Farm")
  p.setAddress("Mine")
  ccunit.eq(p.getAddress(), "Mine")
  p.setAddress()
  ccunit.eq(p.getAddress(), "Farm")
  ccunit.eq(p.getPackage(), nil)
  ccunit.eq(p.makePackage(), true)
  -- package_created is queued while makePackage waits for its tick, so the caller never sees it (CC drops events
  -- that come during a main-thread call)
  ccunit.eq(collect({ "package_created" }, 0.3), {})
  local obj = p.getPackage()
  ccunit.eq(obj.getAddress(), "Farm")
  ccunit.eq(obj.isEditable(), true)
  ccunit.eq(p.makePackage(), false)
  local box = p.getPackage()
  ccunit.eq(box.list(), {
    { name = "minecraft:cobblestone", count = 64 },
    { name = "minecraft:dirt", count = 10 },
    { name = "minecraft:cobblestone", count = 36 },
  })
  ccunit.eq(err(box.getItemDetail, 10), ${JSON.stringify(slotErr(10, 9))})
  box.setAddress("Mine")
  ccunit.eq(box.getAddress(), "Mine")
  ccunit.eq(p.list(), {})
  sleep(1.5) -- the belt takes it when the animation ends
  ccunit.eq(p.getPackage(), nil)
  ccunit.eq(box.isEditable(), false)
  ccunit.eq(err(box.setAddress, "x"), "Package is not editable")
  ccunit.eq(err(p.getItemDetail, 0), ${JSON.stringify(slotErr(0, 27))})
  ccunit.eq(peripheral.call("linked", "makePackage"), false)
end)

ccunit.test("nothing takes the box: it stays", function()
  local p = peripheral.wrap("held")
  ccunit.eq(p.makePackage(), true)
  sleep(1.5)
  ccunit.truthy(p.getPackage())
  ccunit.eq(p.makePackage(), false)
end)

ccunit.test("repackager passes a whole package on with its own address", function()
  local r = peripheral.wrap("repack")
  ccunit.eq(r.makePackage(), true)
  ccunit.eq(r.getPackage().getAddress(), "Y")
  ccunit.eq(r.getPackage().list()[1], { name = "minecraft:stone", count = 3 })
end)

ccunit.test("ports", function()
  local f = peripheral.wrap("frog")
  ccunit.eq(f.getConfiguration(), "send_recieve")
  ccunit.eq(f.setConfiguration("send"), true)
  ccunit.eq(f.getConfiguration(), "send")
  ccunit.eq(err(f.setConfiguration, "x"), 'Unknown configuration: "x" Possible configurations are: "send_recieve" and "send".')
  f.setAddress("Farm")
  ccunit.eq(f.getAddress(), "Farm")
  ccunit.eq(f.list()[1].name, "create:cardboard_package_12x12")
  ccunit.eq(f.getItemDetail(1).package.getAddress(), "Mine")
  ccunit.eq(f.getItemDetail(1).package.list()[1].name, "minecraft:apple")
  ccunit.eq(f.getItemDetail(2), nil)
  ccunit.eq(err(f.getItemDetail, 19), ${JSON.stringify(slotErr(19, 18))})
  local b = peripheral.wrap("box")
  ccunit.eq(table.pack(b.getConfiguration()), { nil, n = 1 })
  ccunit.eq(b.setConfiguration("x"), false)
end)
`,
        {
          version: mc,
          peripherals: [
            {
              name: "pk",
              type: "Create_Packager",
              address: "Farm",
              items: [
                { name: "minecraft:cobblestone", count: 100 },
                { name: "minecraft:dirt", count: 10 },
              ],
            },
            {
              name: "linked",
              type: "Create_Packager",
              linked: true,
              items: [{ name: "minecraft:dirt", count: 1 }],
            },
            {
              name: "held",
              type: "Create_Packager",
              output: "none",
              items: [{ name: "minecraft:stone", count: 5 }],
            },
            {
              name: "repack",
              type: "Create_Repackager",
              address: "Y",
              items: [
                {
                  name: "create:cardboard_package_12x12",
                  package: {
                    address: "X",
                    items: [{ name: "minecraft:stone", count: 3 }],
                  },
                },
              ],
            },
            {
              name: "frog",
              type: "Create_Frogport",
              items: [
                {
                  name: "create:cardboard_package_12x12",
                  package: {
                    address: "Mine",
                    items: [{ name: "minecraft:apple", count: 2 }],
                  },
                },
              ],
            },
            { name: "box", type: "Create_Postbox", target: false },
          ],
        } as unknown as WorldConfig,
        `packages6-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 90000);

    it("sim commands: a train passes the observer, packages arrive and leave, getSize sends", async () => {
      put(
        "ev6.lua",
        `
local l = peripheral.wrap("link")
l.write("sent by getSize")
l.getSize()
print("size asked")
local got = {}
while #got < 4 do
  local e = { os.pullEvent() }
  if e[1] == "train_passing" or e[1] == "train_passed" then got[#got + 1] = e[1] .. ":" .. e[2] .. ":" .. e[3]
  elseif e[1] == "package_received" or e[1] == "package_sent" then
    got[#got + 1] = e[1] .. ":" .. e[2] .. ":" .. e[3].getAddress()
  end
  if #got == 1 and e[1] == "train_passing" then print("passing " .. tostring(peripheral.call("obs", "getPassingTrainName"))) end
end
print(table.concat(got, ","))
print("events done")
`,
      );
      const manager = new SessionManager(config);
      const s = manager.create([], 1, {
        version: mc,
        create: { trains: [{ name: "Express" }] },
        peripherals: [
          { name: "obs", type: "Create_TrainObserver" },
          { name: "frog", type: "Create_Frogport" },
          { name: "link", type: "Create_DisplayLink", target: "sign" },
        ],
      } as unknown as WorldConfig);
      try {
        const raw = s.handle.session;
        await raw.waitForText(">", 0, 20000);
        raw.typeLine("ev6");
        await raw.waitForText("size asked", 0, 20000);
        const step = async (c: Any): Promise<SimState> => {
          expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
            true,
          );
          return s.handle.readState()!;
        };
        let state = await step({ cmd: "advance", seconds: 0.5 });
        expect((state.peripherals?.["link"] as Any).target.lines[0]).toBe(
          "sent by getSize",
        );
        await step({
          cmd: "createTrainPass",
          peripheral: "obs",
          train: "Express",
        });
        await step({ cmd: "advance", seconds: 0.2 });
        await step({
          cmd: "createTrainPass",
          peripheral: "obs",
          train: "Express",
          passing: false,
        });
        await step({
          cmd: "createDeliverPackage",
          peripheral: "frog",
          address: "Home",
          items: [{ name: "minecraft:apple", count: 1 }],
        });
        // getAddress waits a tick, and an event that comes meanwhile is lost: give the program time
        await step({ cmd: "advance", seconds: 0.3 });
        state = await step({ cmd: "createSendPackage", peripheral: "frog" });
        try {
          await raw.waitForText("events done", 0, 20000);
        } catch (error) {
          const screen = (manager.screens(s.id)[0]?.lines ?? []).join("\n");
          throw new Error(`${(error as Error).message}\n${screen}`);
        }
        const screen = (manager.screens(s.id)[0]?.lines ?? []).join("\n");
        expect(screen).toContain("passing Express");
        expect(screen.replace(/\n/g, "")).toContain(
          "train_passing:obs:Express,train_passed:obs:Express,package_received:frog:Home,package_sent:frog:Home",
        );
        expect((state.peripherals?.["frog"] as Any).items).toEqual({});
      } finally {
        await manager.destroyAll();
      }
    }, 90000);

    it("a 6.0 type is refused on 1.18.2 before boot", async () => {
      await expect(
        lua(
          `ccunit.test("x", function() end)`,
          {
            version: "1.18.2",
            peripherals: [{ name: "t", type: "Create_StockTicker" }],
          } as unknown as WorldConfig,
          `refuse6-${mc}.test.lua`,
        ),
      ).rejects.toThrow(/has no Create_StockTicker on Minecraft 1\.18\.2/);
    }, 60000);
  });
}
