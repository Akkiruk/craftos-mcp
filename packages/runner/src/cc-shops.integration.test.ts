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
 * CC Shops 0.0.1 (1.18.2) and 0.0.1-fixed (1.20.1) over Simple Shops, from the released jars read with javap
 * (docs/cc-shops.md). The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ccshops-ws-"));
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
-- the command runs when the computer takes its event; whatever it queues comes after (sleep would eat it)
local function send(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
end
local function sim(command)
  send(command)
  sleep(0.2)
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

/** CC's PeripheralAPI.getMethods: a HashMap sized to the method count. */
function javaHashMapOrder(keys: string[]): string[] {
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

// SimpleShopPeripheral and SimpleShopCommandPeripheral, as javap lists them in both jars
const BASE = [
  "getStockItem",
  "getStockAmount",
  "getCostItem",
  "getGainsAmount",
  "getBarItem",
  "getOwner",
];
const COMMAND = [
  "setStockItem",
  "setStockAmount",
  "setCostItem",
  "setGainsAmount",
  "setBarItem",
  "setOwner",
];

const OWNER = "4f3a2b1c-0000-4000-8000-00000000abcd";
const STEVE = "11111111-2222-3333-4444-555555555555";

const shopDef = {
  stock: { name: "minecraft:diamond", count: 2 },
  stored: 7,
  cost: { name: "minecraft:emerald", count: 3 },
  gains: 4,
  owner: OWNER,
};

const peripheralWorld: WorldConfig = {
  simProgram: true,
  addons: ["cc-shops"],
  ccShops: {
    players: [{ name: "Alex", uuid: OWNER }],
    entities: [{ name: "Shopkeeper Golem", uuid: STEVE }],
  },
  peripherals: [
    { name: "shop_0", type: "shop", ...shopDef },
    {
      name: "shop_1",
      type: "shop",
      commandComputer: true,
      ...shopDef,
      bar: { name: "simpleshops:wooden_stockbar" },
    },
    { name: "empty", type: "shop" },
    {
      name: "creative",
      type: "shop",
      creative: true,
      stock: { name: "minecraft:apple", count: 1 },
      cost: { name: "minecraft:emerald", count: 1 },
    },
  ],
} as WorldConfig;

describe("CC Shops surface (no engine)", () => {
  it("a world using a shop fails cleanly when the addon is off", () => {
    expect(() =>
      worldJson({
        version: "1.18.2",
        addons: "none",
        peripherals: [{ name: "s", type: "shop" }],
      }),
    ).toThrow(/peripheral "s" is a shop from CC Shops \(addon "cc-shops"\)/);
    expect(() =>
      worldJson({
        version: "1.18.2",
        addons: ["create"],
        ccShops: {},
      } as WorldConfig),
    ).toThrow(/world.ccShops configures CC Shops/);
    // a turtle world is not refused with the addon off: it just has no shop API
    expect(() =>
      worldJson({ addons: "none", turtle: {} } as WorldConfig),
    ).not.toThrow();
  });
});

describe.skipIf(!ready)("CC Shops peripheral", () => {
  for (const mc of ["1.18.2", "1.20.1"]) {
    it(`every method, its values and its errors (${mc})`, async () => {
      const result = await lua(
        `
local base = { ${javaHashMapOrder(BASE)
          .map((m) => JSON.stringify(m))
          .join(", ")} }
local command = { ${javaHashMapOrder([...COMMAND, ...BASE])
          .map((m) => JSON.stringify(m))
          .join(", ")} }
local s, c = peripheral.wrap("shop_0"), peripheral.wrap("shop_1")

ccunit.test("types and method order", function()
  ccunit.eq(peripheral.getType("shop_0"), "shop")
  ccunit.eq(peripheral.getType("shop_1"), "shop")
  ccunit.eq(peripheral.getMethods("shop_0"), base)
  ccunit.eq(peripheral.getMethods("shop_1"), command)
  ccunit.eq(s.setStockAmount, nil)
end)

ccunit.test("getters", function()
  ccunit.eq(s.getStockItem(), { name = "minecraft:diamond", count = 2 })
  ccunit.eq(s.getStockAmount(), 3) -- 7 stored / 2 a sale
  ccunit.eq(s.getCostItem(), { name = "minecraft:emerald", count = 3 })
  ccunit.eq(s.getGainsAmount(), 4)
  ccunit.eq(s.getBarItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(c.getBarItem(), { name = "simpleshops:wooden_stockbar", count = 1 })
  ccunit.eq(table.pack(s.getOwner()), { n = 2, "Alex", "${OWNER}" })
  local e = peripheral.wrap("empty")
  ccunit.eq(e.getStockItem(), { name = "minecraft:air", count = 0 })
  ccunit.eq(e.getStockAmount(), 0)
  ccunit.eq(table.pack(e.getOwner()), { n = 2, nil, "00000000-0000-0000-0000-000000000000" })
end)

ccunit.test("setters", function()
  ccunit.eq(table.pack(c.setStockItem({ name = "minecraft:gold_ingot", count = 4 })), { n = 0 })
  ccunit.eq(c.getStockItem(), { name = "minecraft:gold_ingot", count = 4 })
  ccunit.eq(c.getStockAmount(), 1) -- still 7 stored
  c.setStockAmount(20)
  ccunit.eq(c.getStockAmount(), 5) -- the total of items, not of sales
  c.setStockAmount(4294967297.9) -- getLong, then (int)
  ccunit.eq(c.getStockAmount(), 0)
  c.setStockAmount(-8)
  ccunit.eq(c.getStockAmount(), -2)
  c.setCostItem({ name = "minecraft:iron_ingot" })
  ccunit.eq(c.getCostItem(), { name = "minecraft:iron_ingot", count = 1 })
  c.setCostItem({ name = "minecraft:air", count = 5 })
  ccunit.eq(c.getCostItem(), { name = "minecraft:air", count = 0 })
  c.setCostItem({ name = "minecraft:stone", count = 0 })
  ccunit.eq(c.getCostItem(), { name = "minecraft:air", count = 0 })
  c.setCostItem({ name = "minecraft:stone", count = 1e12 })
  ccunit.eq(c.getCostItem(), { name = "minecraft:stone", count = 2147483647 })
  c.setGainsAmount(12)
  ccunit.eq(c.getGainsAmount(), 12)
  c.setStockItem({ name = "minecraft:diamond", count = 2 })
  c.setStockAmount(7)
end)

ccunit.test("setBarItem sets a stock viewer and throws either way", function()
  ccunit.eq(err(c.setBarItem, { name = "simpleshops:red_stockbar" }), "Not a Bar")
  ccunit.eq(c.getBarItem(), { name = "simpleshops:red_stockbar", count = 1 })
  ccunit.eq(err(c.setBarItem, { name = "minecraft:stick" }), "Not a Bar")
  ccunit.eq(c.getBarItem(), { name = "simpleshops:red_stockbar", count = 1 })
end)

ccunit.test("setOwner sets a loaded player or entity and throws either way", function()
  ccunit.eq(err(c.setOwner, "${STEVE.toUpperCase()}"), "Invalid UUID")
  ccunit.eq(table.pack(c.getOwner()), { n = 2, "Shopkeeper Golem", "${STEVE}" })
  ccunit.eq(err(c.setOwner, "1-2-3-4-5"), "Invalid UUID") -- nobody: unchanged
  ccunit.eq(select(2, c.getOwner()), "${STEVE}")
  -- a leading "-" is the first dash to indexOf, so no group can be negative; "+" is parseLong's
  ccunit.eq(err(c.setOwner, "-1-0-0-0-0"), "Java Exception Thrown: java.lang.IllegalArgumentException: Invalid UUID string: -1-0-0-0-0")
  ccunit.eq(err(c.setOwner, "+1-2-3-4-5"), "Invalid UUID")
  ccunit.eq(select(2, c.getOwner()), "${STEVE}")
  ccunit.eq(err(c.setOwner, "${OWNER}"), "Invalid UUID")
  ccunit.eq(select(2, c.getOwner()), "${OWNER}")
  ccunit.eq(err(c.setOwner, "nope"), "Java Exception Thrown: java.lang.IllegalArgumentException: Invalid UUID string: nope")
  ccunit.eq(err(c.setOwner, "1-2-3-4-5-6"), "Java Exception Thrown: java.lang.IllegalArgumentException: Invalid UUID string: 1-2-3-4-5-6")
  ccunit.eq(err(c.setOwner, ("0"):rep(37)), "Java Exception Thrown: java.lang.IllegalArgumentException: UUID string too large")
  ccunit.eq(err(c.setOwner, "-1-2-3-4"), 'Java Exception Thrown: java.lang.NumberFormatException: For input string: "" under radix 16')
  ccunit.eq(err(c.setOwner, "1-2-3-4-xyz"), 'Java Exception Thrown: java.lang.NumberFormatException: Error at index 0 in: "xyz"')
  ccunit.eq(err(c.setOwner, "1-2-3-4-+"), 'Java Exception Thrown: java.lang.NumberFormatException: Error at index 1 in: "+"')
  ccunit.eq(err(c.setOwner, "11111111111111111-1-1-1-1"), 'Java Exception Thrown: java.lang.NumberFormatException: Error at index 16 in: "11111111111111111"')
  ccunit.eq(err(c.setOwner, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(c.setOwner), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("argument errors", function()
  ccunit.eq(err(c.setStockItem), "bad argument #1 (table expected, got nil)")
  ccunit.eq(err(c.setStockItem, "x"), "bad argument #1 (table expected, got string)")
  ccunit.eq(err(c.setStockItem, {}), "Invalid Item Data, needs name")
  ccunit.eq(err(c.setStockItem, { name = print }), "Invalid Item Data, needs name")
  ccunit.eq(err(c.setStockItem, { name = 5 }),
    "Java Exception Thrown: java.lang.ClassCastException: class java.lang.Double cannot be cast to class java.lang.String (java.lang.Double and java.lang.String are in module java.base of loader 'bootstrap')")
  ccunit.eq(err(c.setCostItem, { name = "Minecraft:Stone" }),
    "Java Exception Thrown: net.minecraft.ResourceLocationException: Non [a-z0-9_.-] character in namespace of location: Minecraft:Stone")
  ccunit.eq(err(c.setCostItem, { name = "minecraft:no_such_item" }), "Invalid Item Name, use namespace:id format")
  ccunit.eq(err(c.setCostItem, { name = "air" }), "Invalid Item Name, use namespace:id format")
  ccunit.eq(err(c.setCostItem, { name = "minecraft:stone", count = "3" }),
    "Java Exception Thrown: java.lang.ClassCastException: class java.lang.String cannot be cast to class java.lang.Double (java.lang.String and java.lang.Double are in module java.base of loader 'bootstrap')")
  ccunit.eq(err(c.setBarItem, { name = "minecraft:stone", count = true }),
    "Java Exception Thrown: java.lang.ClassCastException: class java.lang.Boolean cannot be cast to class java.lang.Double (java.lang.Boolean and java.lang.Double are in module java.base of loader 'bootstrap')")
  ccunit.eq(err(c.setStockAmount), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(c.setStockAmount, "5"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(c.setGainsAmount, 0/0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(c.setGainsAmount, math.huge), "bad argument #1 (number expected, got inf)")
  ccunit.eq(err(c.setGainsAmount, -math.huge), "bad argument #1 (number expected, got -inf)")
  ccunit.eq(c.getStockItem(), { name = "minecraft:diamond", count = 2 })
end)

ccunit.test("a player buys: buy_attempt to the computer", function()
  send({ cmd = "shopPlayerBuy", shop = "shop_0", player = "Steve", item = { name = "minecraft:emerald", count = 5 } })
  local ev = table.pack(os.pullEvent("buy_attempt"))
  ccunit.eq(ev, { n = 5, "buy_attempt", "Steve", { name = "minecraft:emerald", count = 5 }, false, true })
  ccunit.eq(s.getStockAmount(), 2) -- 5 stored
  ccunit.eq(s.getGainsAmount(), 7)
  send({ cmd = "shopPlayerBuy", shop = "shop_0", player = "Steve", item = { name = "minecraft:dirt", count = 64 } })
  ev = table.pack(os.pullEvent("buy_attempt"))
  ccunit.eq(ev, { n = 5, "buy_attempt", "Steve", { name = "minecraft:dirt", count = 64 }, false, false })
  send({ cmd = "shopPlayerBuy", shop = "creative", player = "Steve", item = { name = "minecraft:emerald", count = 1 } })
  ev = table.pack(os.pullEvent("buy_attempt"))
  ccunit.eq(ev, { n = 5, "buy_attempt", "Steve", { name = "minecraft:emerald", count = 1 }, true, true })
  ccunit.eq(peripheral.wrap("creative").getStockAmount(), 0) -- a creative shop never runs out
  sim({ cmd = "shopSet", shop = "shop_0", stored = 1 })
  send({ cmd = "shopPlayerBuy", shop = "shop_0", player = "Steve", item = { name = "minecraft:emerald", count = 5 } })
  ev = table.pack(os.pullEvent("buy_attempt"))
  ccunit.eq(ev[5], false) -- sold out: 1 stored, 2 a sale
end)
`,
        { ...peripheralWorld, version: mc } as WorldConfig,
        `shops-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 120000);
  }
});

type Items = Record<string, { name: string; count: number }>;
const turtleWorld = (
  mc: string,
  inventory: Items = {
    "1": { name: "minecraft:emerald", count: 6 },
    "3": { name: "minecraft:diamond", count: 63 },
  },
): WorldConfig =>
  ({
    version: mc,
    simProgram: true,
    addons: ["cc-shops"],
    turtle: { x: 0, y: 64, z: 0, facing: "north", selected: 1, inventory },
    blocks: [
      {
        x: 0,
        y: 64,
        z: -1,
        name: "simpleshops:simple_shop",
        shop: {
          stock: { name: "minecraft:diamond", count: 1 },
          stored: 3,
          cost: { name: "minecraft:emerald", count: 3 },
          owner: OWNER,
        },
      },
      {
        x: 0,
        y: 65,
        z: 0,
        name: "simpleshops:creative_simple_shop",
        shop: {
          stock: { name: "minecraft:apple", count: 2 },
          cost: { name: "minecraft:emerald", count: 1 },
        },
      },
    ],
  }) as unknown as WorldConfig;

describe.skipIf(!ready)("CC Shops turtle API", () => {
  it("1.18.2: buy, buyUp, buyDown and every failure", async () => {
    const result = await lua(
      `
ccunit.test("the API", function()
  ccunit.eq(type(shop), "table")
  local names = {}
  for k in pairs(shop) do names[#names + 1] = k end
  table.sort(names)
  ccunit.eq(names, { "buy", "buyDown", "buyUp" })
  ccunit.eq(peripheral.getType("front"), "shop")
  ccunit.eq(peripheral.getType("top"), "shop")
end)

ccunit.test("buying moves the items and tells the attached computer", function()
  os.setComputerLabel("Bot")
  local got
  parallel.waitForAll(function()
    ccunit.eq(table.pack(shop.buy()), { n = 1, true })
  end, function()
    got = table.pack(os.pullEvent("buy_attempt"))
  end)
  ccunit.eq(got, { n = 5, "buy_attempt", "Bot", { name = "minecraft:emerald", count = 6 }, false, true })
  ccunit.eq(turtle.getItemCount(1), 3)
  ccunit.eq(turtle.getItemDetail(2), { name = "minecraft:diamond", count = 1 }) -- the first empty slot
  local f = peripheral.wrap("front")
  ccunit.eq(f.getStockAmount(), 2)
  ccunit.eq(f.getGainsAmount(), 3)
end)

ccunit.test("paying with the whole stack leaves a ghost the next sale revives", function()
  -- slot 1 had 3 emeralds: all of it goes; Java leaves a 0-count emerald stack there
  ccunit.eq(table.pack(shop.buy()), { n = 1, true })
  ccunit.eq(turtle.getItemCount(1), 0)
  ccunit.eq(turtle.getItemCount(2), 2)
  ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Incorrect Payment Item" }) -- slot 1 reads as empty
  turtle.select(4)
  ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Incorrect Payment Item" })
end)

ccunit.test("failures", function()
  turtle.select(3) -- 63 diamonds
  ccunit.eq(table.pack(shop.buyDown()), { n = 2, false, "Not a Shop" })
  ccunit.eq(table.pack(shop.buyUp()), { n = 2, false, "Incorrect Payment Item" })
  sim({ cmd = "shopSet", shop = "0,64,-1", stored = 0 })
  ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Out of Stock" })
  sim({ cmd = "shopSet", shop = "0,64,-1", stored = 10, cost = { name = "minecraft:diamond", count = 64 } })
  ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Insufficient Funds" })
end)

ccunit.test("the ghost in slot 1 turns a sale into emeralds", function()
  -- creative shop above: apples for 1 diamond; slot 1 is the first empty slot, and still names emeralds
  sim({ cmd = "shopSet", pos = { 0, 65, 0 }, cost = { name = "minecraft:diamond", count = 1 } })
  turtle.select(3)
  ccunit.eq(table.pack(shop.buyUp()), { n = 1, true })
  ccunit.eq(turtle.getItemDetail(1), { name = "minecraft:emerald", count = 2 })
  ccunit.eq(turtle.getItemCount(3), 62)
  ccunit.eq(table.pack(shop.buyUp()), { n = 1, true })
  ccunit.eq(turtle.getItemDetail(4), { name = "minecraft:apple", count = 2 }) -- slot 1 holds emeralds now
  ccunit.eq(peripheral.wrap("top").getStockAmount(), 0)
end)
`,
      turtleWorld("1.18.2"),
      "turtle-1.18.2.test.lua",
    );
    expectAllPassed(result);
  }, 120000);

  it("1.18.2: Not Enough Space, and the event still goes out", async () => {
    const inventory: Items = { "1": { name: "minecraft:emerald", count: 6 } };
    for (let i = 2; i <= 16; i++)
      inventory[String(i)] = { name: "minecraft:stone", count: 64 };
    const w = turtleWorld("1.18.2", inventory);
    const result = await lua(
      `
ccunit.test("a full turtle", function()
  local got
  parallel.waitForAll(function()
    ccunit.eq(table.pack(shop.buy()), { n = 2, false, "Not Enough Space" })
  end, function()
    got = table.pack(os.pullEvent("buy_attempt"))
  end)
  ccunit.eq(got, { n = 5, "buy_attempt", nil, { name = "minecraft:emerald", count = 6 }, false, false })
  ccunit.eq(turtle.getItemCount(1), 6)
  ccunit.eq(peripheral.wrap("front").getStockAmount(), 3)
end)
`,
      w,
      "turtle-full.test.lua",
    );
    expectAllPassed(result);
  }, 120000);

  it("1.20.1: the mod's reflection fails, so no turtle has the API", async () => {
    const result = await lua(
      `
ccunit.test("no shop API", function()
  ccunit.eq(shop, nil)
  ccunit.eq(peripheral.getType("front"), "shop")
  ccunit.eq(peripheral.wrap("front").getStockAmount(), 3)
end)
`,
      turtleWorld("1.20.1"),
      "turtle-1.20.1.test.lua",
    );
    expectAllPassed(result);
  }, 120000);
});

describe.skipIf(!ready)("CC Shops examples", () => {
  for (const name of ["kiosk", "buyer_bot"]) {
    it(`examples/cc-shops/${name}.test.lua`, async () => {
      const world = JSON.parse(
        readFileSync(
          join(base.workspaceDir, "examples", "cc-shops", `${name}.world.json`),
          "utf8",
        ),
      ) as WorldConfig;
      const result = await runTests(
        base,
        {
          paths: [`examples/cc-shops/${name}.test.lua`],
          world,
          timeScale: 5,
          timeoutMs: 90000,
        },
        1,
      );
      expectAllPassed(result);
    }, 120000);
  }
});
