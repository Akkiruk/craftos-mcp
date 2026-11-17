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
} from "./index.js";

/**
 * Ducky Peripherals, written from SamsTheNerd/ducky-periphs: 1.20.1-1.3.1 (commit f4fc865) and, for Minecraft 1.18.2,
 * 1.0.2 (commit 1699d8c). docs/ducky-peripherals.md has the source of every rule. The mod is not in the pack: nothing
 * here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ducky-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(base).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  -- one yield so the sim runs it, without throwing away the events it queues (sleep would)
  os.queueEvent("sim_done")
  os.pullEvent("sim_done")
end
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
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

/** UUID.hashCode, then HashMap.hash and the bucket: the order a HashMap<UUID, ?> of this size walks its keys. */
function hashMapOrder(uuids: string[]): string[] {
  let cap = 16;
  while (uuids.length > cap * 0.75) cap *= 2;
  const hash = (u: string): number => {
    const hex = u.replace(/-/g, "");
    const msb = BigInt.asIntN(64, BigInt("0x" + hex.slice(0, 16)));
    const lsb = BigInt.asIntN(64, BigInt("0x" + hex.slice(16)));
    const hilo = msb ^ lsb;
    const h =
      Number(BigInt.asIntN(32, hilo >> 32n)) ^ Number(BigInt.asIntN(32, hilo));
    return (h ^ (h >>> 16)) & (cap - 1);
  };
  return uuids
    .map((u, i) => ({ u, i, b: hash(u) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.u);
}

const UUIDS = [
  "8667ba71-b85a-4004-af54-457a9734eed7",
  "069a79f4-44e9-4726-a5be-fca90e38aaf5",
  "853c80ef-3c37-49fd-aa49-938b674adae6",
  "61699b2e-d327-4a01-9f1e-0ea8c3f06bc6",
  "f7c77d99-9f15-4a66-a87d-c4a51ef30d19",
  "c06f8906-4c8a-4911-9c29-ea1dbd1aab82",
];

const w120 = (
  peripherals: unknown[],
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["ducky-peripherals"],
    simProgram: true,
    peripherals,
    ...extra,
  }) as WorldConfig;
const w118 = (
  peripherals: unknown[],
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.18.2",
    addons: ["ducky-peripherals"],
    simProgram: true,
    peripherals,
    ...extra,
  }) as WorldConfig;

describe.skipIf(!ready)("Ducky Peripherals", () => {
  it("the example: porch.lua against porch.world.json", async () => {
    const test = "examples/ducky-peripherals/porch.test.lua";
    const world = JSON.parse(
      readFileSync(
        join(base.workspaceDir, test.replace(/\.test\.lua$/, ".world.json")),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await runTests(
      base,
      { paths: [test], world, timeoutMs: 90000 },
      1,
    );
    expectAllPassed(result);
  }, 120000);

  it("entity_detector: the box is the block grown 8 sideways and 16 up and down, living entities only", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("range", function()
  local names = {}
  for _, e in ipairs(peripheral.call("ed", "nearbyEntities")) do names[#names + 1] = e.name end
  ccunit.eq(names, { "edgeX", "edgeLow", "edgeHigh" })
end)
`,
        w120([
          {
            name: "ed",
            type: "entity_detector",
            entities: [
              // box x from -8 to 9: a 0.6 wide entity at 9.29 still overlaps, at 9.3 it only touches
              { name: "edgeX", x: 9.29, y: 0, z: 0 },
              { name: "outX", x: 9.3, y: 0, z: 0 },
              { name: "outNegX", x: -8.3, y: 0, z: 0 },
              // y from -16 to 17: feet below 17 is in, head above -16 is in
              { name: "edgeLow", x: 0, y: -17.7, z: 0 },
              { name: "outLow", x: 0, y: -17.9, z: 0 },
              { name: "edgeHigh", x: 0, y: 16.99, z: 0 },
              { name: "outHigh", x: 0, y: 17, z: 0 },
              { name: "item", living: false, x: 0, y: 0, z: 0 },
            ],
          },
        ]),
        "range.lua",
      ),
    );
  }, 60000);

  it("entity_detector: new ones first, then the ones that left, each in HashMap<UUID> order", async () => {
    const order = hashMapOrder(UUIDS);
    expectAllPassed(
      await lua(
        `
local uuids = textutils.unserializeJSON(${JSON.stringify(JSON.stringify(UUIDS))})
local expected = textutils.unserializeJSON(${JSON.stringify(JSON.stringify(order))})
ccunit.test("one tick of changes", function()
  for i, u in ipairs(uuids) do
    os.queueEvent("ccsim_cmd", ("sim:a%d:%.0f"):format(i, os.epoch("utc")),
      textutils.serializeJSON({ cmd = "duckyAddEntity", entity = { uuid = u, name = "e" .. i, x = 0, y = 0, z = 0 } }))
  end
  local got = {}
  for i = 1, #uuids do
    local event, name, e = os.pullEvent("new_entity")
    ccunit.eq(name, "ed")
    got[i] = e.uuid
  end
  ccunit.eq(got, expected)
  sim({ cmd = "duckyMoveEntity", entity = "e1", x = 50 })
  sim({ cmd = "duckyRemoveEntity", entity = "e2" })
  local _, _, a = os.pullEvent("removed_entity")
  local _, _, b = os.pullEvent("removed_entity")
  local left = { [a.name] = a, [b.name] = b }
  ccunit.eq(left.e1.x, 50) -- the cached Entity: where it is now
  ccunit.eq(left.e2.x, 0)
end)
ccunit.test("the four left", function()
  ccunit.eq(#peripheral.call("ed", "nearbyEntities"), 4)
end)
`,
        w120([{ name: "ed", type: "entity_detector" }]),
        "order.lua",
      ),
    );
  }, 60000);

  it("1.18.2 (1.0.2): no peripheral name in the events, key up comes as a key event, no sculkophone", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("events", function()
  sim({ cmd = "duckyAddEntity", entity = { name = "Steve", player = true, x = 1, y = 0, z = 1 } })
  local event, e = os.pullEvent("new_entity")
  ccunit.eq(e.name, "Steve")
  ccunit.eq(e.type, "Player")
  sim({ cmd = "duckyKey", key = "a" })
  ccunit.eq({ os.pullEvent("key") }, { "key", keys.a, false })
  sim({ cmd = "duckyKeyUp", key = "a" })
  ccunit.eq({ os.pullEvent("key") }, { "key", keys.a, false })
  sim({ cmd = "duckyChar", char = "x" })
  ccunit.eq({ os.pullEvent("char") }, { "char", "x" })
  sim({ cmd = "duckyKeyboardEvent", event = "terminate" })
  ccunit.eq({ os.pullEventRaw("terminate") }, { "terminate" })
end)
ccunit.test("weather", function()
  local w = peripheral.wrap("wm")
  ccunit.eq({ w.getBiome(), w.isRaining(), w.isThundering() }, { "minecraft:plains", false, false })
end)
`,
        w118(
          [
            { name: "ed", type: "entity_detector" },
            { name: "wm", type: "weather_machine" },
            { name: "kb", type: "keyboard" },
          ],
          { duckyPeripherals: { thundering: true } },
        ),
        "old.lua",
      ),
    );
    // the sim refuses to build it ("ccsim failed to start: ccsim: the sculkophone is not in Ducky Peripherals
    // 1.0.2 ..." on the terminal at boot), so there is no such block
    expectAllPassed(
      await lua(
        `ccunit.test("no sculkophone", function() ccunit.eq(peripheral.isPresent("s"), false) end)`,
        w118([{ name: "s", type: "sculkophone" }]),
        "oldsculk.lua",
      ),
    );
  }, 120000);

  it("a world with the addon off is refused, and 1.21.1 has no release", async () => {
    put("noop.test.lua", `ccunit.test("x", function() end)`);
    await expect(
      runTests(
        config,
        {
          paths: ["noop.test.lua"],
          world: {
            addons: [],
            peripherals: [{ name: "k", type: "keyboard" }],
          } as WorldConfig,
        },
        1,
      ),
    ).rejects.toThrow(/Ducky Peripherals \(addon "ducky-peripherals"\)/);
    await expect(
      runTests(
        config,
        {
          paths: ["noop.test.lua"],
          world: {
            version: "1.21.1",
            addons: ["ducky-peripherals"],
          } as WorldConfig,
        },
        1,
      ),
    ).rejects.toThrow(/no release for Minecraft 1.21.1/);
  }, 60000);
});
