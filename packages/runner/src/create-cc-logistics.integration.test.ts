import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
  worldJson,
} from "./index.js";

/**
 * Create: CC Total Logistics 0.3.7 (Minecraft 1.20.1) and 0.3.6 (1.21.1), written from the mod's source on the
 * 1.20.1-forge branch and master and checked with javap against both released jars; Create's side from
 * mc1.20.1-6.0.8 (docs/create-cc-logistics.md). Nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ccl-ws-"));
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
local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end
local function count(t) local n = 0 for _ in pairs(t) do n = n + 1 end return n end
`;

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(
    config,
    { paths: [name], world, timeoutMs: 60000, timeScale: 10 },
    1,
  );
}

/** Each type's @LuaFunction methods in declaration order (javap of both jars agrees). */
const SOURCE = {
  stockcheckingblock: [
    "inventorySize",
    "itemBasicDetails",
    "itemDetails",
    "getCountOf",
    "countConnectedStockLinks",
    "stockLinkDetails",
  ],
  packageport: [
    "listPackages",
    "capacity",
    "getPackageContentDetails",
    "renamePackageAddress",
    "getAcceptsPackages",
    "setAcceptsPackages",
    "getAddressFilter",
    "setAddressFilter",
  ],
  redstonerequester: ["request", "requestCraft"],
  clipboard: ["isClipboardAttached", "getNumPages", "readPage"],
} as const;

/** CC's PeripheralAPI.getMethods: a HashMap sized to the method count, filled in declaration order. */
function javaHashMapOrder(keys: readonly string[]): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 1;
  while (cap < keys.length) cap *= 2;
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

describe("CC Total Logistics addon (no engine)", () => {
  it("is refused on 1.18.2 and when off", () => {
    expect(() =>
      worldJson({
        version: "1.18.2",
        addons: ["create", "create-cc-logistics"],
        peripherals: [{ name: "s", type: "stockcheckingblock" }],
      }),
    ).toThrow(/has no release for Minecraft 1\.18\.2/);
    expect(() =>
      worldJson({
        version: "1.20.1",
        addons: ["create"],
        peripherals: [{ name: "s", type: "stockcheckingblock" }],
      } as WorldConfig),
    ).toThrow(
      /peripheral "s" is a stockcheckingblock from Create: CC Total Logistics \(addon "create-cc-logistics"\)/,
    );
    expect(() =>
      worldJson({
        version: "1.20.1",
        addons: ["create-cc-logistics"],
      } as WorldConfig),
    ).toThrow(/needs create/);
    expect(() =>
      worldJson({
        version: "1.21.1",
        addons: ["create", "create-cc-logistics"],
        createLogistics: {},
        peripherals: [{ name: "p", type: "packageport" }],
      } as WorldConfig),
    ).not.toThrow();
  });
});

const world: WorldConfig = {
  version: "1.20.1",
  simProgram: true,
  addons: ["create", "create-cc-logistics"],
  createLogistics: {
    travelTicks: 10,
    networks: {
      main: {
        links: [
          {
            name: "a",
            size: 3,
            items: [
              { name: "minecraft:iron_ingot", count: 64 },
              { name: "minecraft:iron_ingot", count: 64 },
              { name: "minecraft:iron_ingot", count: 64 },
            ],
          },
          {
            name: "b",
            power: 3,
            items: [
              { name: "minecraft:iron_ingot", count: 10 },
              {
                name: "minecraft:diamond_sword",
                count: 1,
                maxCount: 1,
                nbt: "abc",
                tag: { Damage: 5 },
              },
            ],
          },
          { name: "bare", inventory: false },
        ],
      },
      other: { links: [] },
    },
  },
  peripherals: [
    { name: "t", type: "stockcheckingblock", network: "main" },
    { name: "r", type: "redstonerequester", network: "main" },
    { name: "lonely", type: "redstonerequester", network: "nowhere" },
    { name: "home", type: "packageport", addressFilter: "Home" },
    { name: "any", type: "packageport", addressFilter: "Ware*" },
    { name: "c", type: "clipboard", pages: [] },
  ],
} as WorldConfig;

describe.skipIf(!ready)("CC Total Logistics on 1.20.1", () => {
  it("getMethods order, types and the summary", async () => {
    const result = await lua(
      `
local expected = { ${Object.entries(SOURCE)
        .map(
          ([k, v]) =>
            `[${JSON.stringify(k)}] = { ${javaHashMapOrder(v)
              .map((m) => JSON.stringify(m))
              .join(", ")} }`,
        )
        .join(", ")} }
ccunit.test("getMethods is CC's HashMap order", function()
  ccunit.eq(peripheral.getMethods("t"), expected.stockcheckingblock)
  ccunit.eq(peripheral.getMethods("home"), expected.packageport)
  ccunit.eq(peripheral.getMethods("r"), expected.redstonerequester)
  ccunit.eq(peripheral.getMethods("c"), expected.clipboard)
  ccunit.eq({ peripheral.getType("home") }, { "packageport", "inventory" })
end)
ccunit.test("summary: one entry per item and tag, links in order", function()
  local t = peripheral.wrap("t")
  ccunit.eq(t.inventorySize(), 2)
  ccunit.eq(t.itemBasicDetails(1), { count = 202, id = "iron_ingot", displayName = "Iron Ingot" })
  local sword = t.itemDetails(2)
  ccunit.eq(sword.item, '{"id":"minecraft:diamond_sword","Count":1,"tag":{"Damage":5}}')
  ccunit.eq(t.getCountOf(sword.item), 1)
  ccunit.eq(t.getCountOf('{"id":"minecraft:diamond_sword","Count":1}'), 0) -- no tag: another stack
  ccunit.eq(err(t.getCountOf, ' "word" '), 'Item not parseable from " "word" " or non-existent')
  ccunit.eq(err(t.getCountOf, "{\\"id\\":\\"minecraft:iron_ingot\\",\\"Count\\":1,\\"tag\\":[1]}"),
    'Item not parseable from "{"id":"minecraft:iron_ingot","Count":1,"tag":[1]}" or non-existent')
  ccunit.eq(t.countConnectedStockLinks(), 3)
  ccunit.eq(t.stockLinkDetails(3), { capacity = "unknown", type = "minecraft.air" })
end)
ccunit.test("a request bigger than a package: one 9-stack package, then the rest", function()
  local r = peripheral.wrap("r")
  local home = peripheral.wrap("home")
  -- lowest redstone power first, but each inventory is its own group: links a then b, in the sim's order
  ccunit.eq(r.request({ { id = "minecraft:iron_ingot", count = 200 } }, "Home"), true)
  local started = os.clock()
  while count(home.listPackages()) < 1 and os.clock() - started < 20 do sleep(0.25) end
  local p = home.getPackageContentDetails(1)
  ccunit.eq(#p, 3)
  ccunit.eq({ p[1].count, p[2].count, p[3].count }, { 64, 64, 64 })
  while count(home.listPackages()) < 2 and os.clock() - started < 20 do sleep(0.25) end
  ccunit.eq(home.getPackageContentDetails(2)[1].count, 8)
  ccunit.eq(peripheral.wrap("t").itemBasicDetails(1).count, 2)
end)
ccunit.test("no network: nothing to ask, still true when partial", function()
  local r = peripheral.wrap("lonely")
  ccunit.eq(r.request({ { id = "minecraft:stone", count = 1 } }), false)
  ccunit.eq(r.request({ { id = "minecraft:stone", count = 1 } }, "", true), true)
  ccunit.eq(err(r.request, { { index = 1, count = 1 } }), "Index out of range (between 1 and 0)")
  ccunit.eq(r.request({ { id = "minecraft:air", count = 1 } }), true) -- air is an empty stack: nothing to check
end)
ccunit.test("address globs", function()
  local any = peripheral.wrap("any")
  sim({ cmd = "cclAddItems", network = "main", link = "b", items = { { name = "minecraft:apple", count = 4 } } })
  ccunit.eq(peripheral.wrap("r").request({ { id = "minecraft:apple", count = 4 } }, "Warehouse"), true)
  local started = os.clock()
  while count(any.listPackages()) < 1 and os.clock() - started < 20 do sleep(0.25) end
  ccunit.eq(any.listPackages()[1], { address = "Warehouse", orderIsComplete = false })
end)
ccunit.test("clipboard with no pages", function()
  local c = peripheral.wrap("c")
  ccunit.eq(c.getNumPages(), 0)
  ccunit.eq(err(c.readPage, 1), "Index out of range (between 1 and 0)")
end)
`,
      world,
      "ccl-120.test.lua",
    );
    expectAllPassed(result);
  }, 120000);

  it("the example program", async () => {
    const example = "examples/create-cc-logistics/order_desk.test.lua";
    const exampleWorld = JSON.parse(
      readFileSync(
        join(
          base.workspaceDir,
          "examples/create-cc-logistics/order_desk.world.json",
        ),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await runTests(
      base,
      {
        paths: [example],
        world: exampleWorld,
        timeoutMs: 90000,
        timeScale: 10,
      },
      1,
    );
    expectAllPassed(result);
  }, 120000);
});

describe.skipIf(!ready)("CC Total Logistics on 1.21.1", () => {
  it("1.21.1's item formats and order flags", async () => {
    const w = {
      ...world,
      version: "1.21.1",
      createLogistics: {
        travelTicks: 5,
        networks: {
          main: {
            links: [
              {
                name: "a",
                items: [
                  { name: "minecraft:iron_ingot", count: 30 },
                  {
                    name: "minecraft:diamond_sword",
                    count: 1,
                    maxCount: 1,
                    nbt: "x",
                    components: { "minecraft:damage": 5 },
                  },
                ],
              },
            ],
          },
        },
      },
    } as WorldConfig;
    const result = await lua(
      `
ccunit.test("ids are namespaced, the JSON is the 1.21 codec", function()
  local t = peripheral.wrap("t")
  ccunit.eq(t.itemBasicDetails(1), { count = 30, id = "minecraft:iron_ingot", displayName = "Iron Ingot" })
  ccunit.eq(t.itemDetails(1).item, '{"id":"minecraft:iron_ingot","count":30}')
  ccunit.eq(t.itemDetails(2).item, '{"id":"minecraft:diamond_sword","count":1,"components":{"minecraft:damage":5}}')
  ccunit.eq(t.getCountOf('{"id":"minecraft:iron_ingot"}'), 30) -- count is optional now
  ccunit.eq(t.getCountOf('{"id":"minecraft:iron_ingot","count":500}'), 30) -- out of range: the default
  ccunit.eq(err(t.getCountOf, '{"id":"minecraft:air","count":1}'),
    'Item not parseable from "{"id":"minecraft:air","count":1}" or non-existent')
end)
ccunit.test("orderIsComplete reads the order data", function()
  local home = peripheral.wrap("home")
  ccunit.eq(peripheral.wrap("r").request({ { id = "minecraft:iron_ingot", count = 5 } }, "Home"), true)
  local started = os.clock()
  while count(home.listPackages()) < 1 and os.clock() - started < 20 do sleep(0.25) end
  ccunit.eq(home.listPackages()[1], { address = "Home", orderIsComplete = true })
  sim({ cmd = "cclDeliverPackage", port = "home", slot = 5, address = "Home", items = { { name = "minecraft:apple", count = 1 } } })
  ccunit.eq(home.listPackages()[5].orderIsComplete, true) -- no order data at all
  sim({ cmd = "cclDeliverPackage", port = "home", slot = 6, address = "Home", final = false, items = {} })
  ccunit.eq(home.listPackages()[6].orderIsComplete, false)
  ccunit.eq(home.getPackageContentDetails(5)[1].item, '{"id":"minecraft:apple","count":1}')
end)
`,
      w,
      "ccl-121.test.lua",
    );
    expectAllPassed(result);
  }, 120000);
});
