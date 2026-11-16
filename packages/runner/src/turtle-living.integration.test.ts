// The living world around a turtle (docs/conformance/emulator-vs-real-deviations.md, row 66): water and lava flow,
// crops grow, bone meal works, furnaces smelt, hoppers move items, dropped items merge and despawn. The tests run on a
// sped-up clock; every random draw comes from world.seed, so a run repeats.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type TurtleSpec,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "turtle-living-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runLua(
  lua: string,
  world: WorldConfig,
  timeScale = 100,
): Promise<TestRunResult> {
  counter += 1;
  const name = `living${counter}.test.lua`;
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lua);
  return runTests(
    config,
    { paths: [name], world, timeoutMs: 200000, timeScale },
    1,
  );
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(
    result.files.map((f) => f.status),
    JSON.stringify(result.files).slice(0, 2000),
  ).toEqual(["passed"]);
}

// The turtle stands at 0,64,0 facing north (-z): front is 0,64,-1, down is 0,63,0.
function turtleWorld(t: TurtleSpec, extra: WorldConfig = {}): WorldConfig {
  return {
    turtle: { x: 0, y: 64, z: 0, facing: "north", fuel: 100, ...t },
    ground: { y: 63, name: "minecraft:stone" },
    seed: 7,
    ...extra,
  };
}
const at = (
  x: number,
  y: number,
  z: number,
  name: string,
  more: object = {},
) => ({ x, y, z, name, ...more });

// Lua helpers: poll until something shows up in front of the turtle, with the time it took
const helpers = `
local function waitFor(fn, limit)
  local t0 = os.clock()
  while os.clock() - t0 < limit do
    local v = fn()
    if v then return os.clock() - t0, v end
    sleep(0.05)
  end
end
local function front()
  local ok, b = turtle.inspect()
  return ok and b or nil
end
`;
const pick = "minecraft:diamond_pickaxe";
const water = { state: { level: "0" } };

describe.skipIf(!ready)("turtle living world", { timeout: 240000 }, () => {
  it("a move takes 8 ticks of the same clock water flows on, load or no load", async () => {
    // The turtle digs the stone that holds a water source back; water spreads one block per 5 ticks. It walks east, one
    // move per 8 ticks, and looks down at each cell. Real time (timeScale 1) so a busy host shows. Fluid is never
    // early and the moves never run faster than 8 ticks; late-running ticks must not make the moves pile up delay.
    const w = await runLua(
      `
ccunit.test("moves and water share one clock", function()
  local stamp, before, wet = {}, {}, {}
  ccunit.truthy(turtle.digDown())
  local dug = os.clock()
  local t0 = dug
  for k = 1, 6 do
    before[k] = (os.clock() - t0) * 20
    ccunit.truthy(turtle.forward())
    stamp[k] = (os.clock() - t0) * 20
    local ok, b = turtle.inspectDown()
    wet[k] = ok and b.name == "minecraft:water"
  end
  -- Each move runs at least 8 ticks after the one before it ran. A return can reach the program late, so the gap
  -- between two returns proves nothing, but move k cannot have finished before move 1 was asked for plus 8 (k - 1):
  -- a bound no amount of load can break.
  for k = 2, 6 do
    ccunit.truthy(stamp[k] - before[1] >= 8 * (k - 1) - 0.5,
      "move " .. k .. " done " .. (stamp[k] - before[1]) .. " ticks after move 1 was asked for")
  end
  -- 5 gaps of 8 ticks; late ticks on a busy host add some, a hold that drifted per move would add far more
  ccunit.truthy(stamp[6] - stamp[1] < 5 * 8 * 1.6, "6 moves took " .. (stamp[6] - stamp[1]) .. " ticks")
  -- the dig freed the flow at clock 0, so cell k (k blocks east of the dug cell) is never wet before 5 * (k + 1) ticks
  for k = 1, 6 do
    if wet[k] then ccunit.truthy(stamp[k] >= 5 * (k + 1) - 2, "cell " .. k .. " wet at tick " .. stamp[k]) end
  end
  -- and by the last cell, 6 moves in (over 50 ticks) the whole 35-tick chain has certainly arrived
  ccunit.truthy(wet[6], "cell 6 still dry at tick " .. stamp[6] .. " wet " .. textutils.serialize(wet, {compact=true}))
end)
`,
      turtleWorld(
        { facing: "east", right: pick },
        {
          ground: { y: 62, name: "minecraft:stone" },
          blocks: [
            at(0, 63, 0, "minecraft:stone"),
            at(0, 63, -1, "minecraft:water", water),
          ],
        },
      ),
      1,
    );
    expectAllPassed(w);
  });

  it("water flows 5 ticks after a block is dug out, and lava 30", async () => {
    const w = await runLua(
      `${helpers}
ccunit.test("water arrives in 5 ticks as flowing level 1", function()
  ccunit.truthy(turtle.dig())
  -- the fluid tick can never run early, so the lower bound is exact; a busy machine only makes it late, so the
  -- wait is generous and there is no upper bound on the time
  local took, b = waitFor(front, 30)
  ccunit.truthy(took, "water never came")
  ccunit.eq(b.name, "minecraft:water")
  ccunit.eq(b.state.level, 1)
  ccunit.truthy(took >= 0.1, "took " .. took)
end)
`,
      turtleWorld(
        { right: pick },
        {
          blocks: [
            at(0, 64, -1, "minecraft:stone"),
            at(0, 64, -2, "minecraft:water", water),
          ],
        },
      ),
      1,
    );
    expectAllPassed(w);
    const l = await runLua(
      `${helpers}
ccunit.test("lava arrives in 30 ticks as flowing level 2", function()
  ccunit.truthy(turtle.dig())
  local took, b = waitFor(front, 60) -- never early; late only on a busy machine
  ccunit.truthy(took, "lava never came")
  ccunit.eq(b.name, "minecraft:lava")
  ccunit.eq(b.state.level, 2, "a source loses 2 per block in the overworld")
  ccunit.truthy(took >= 1.3, "took " .. took)
end)
`,
      turtleWorld(
        { right: pick },
        {
          blocks: [
            at(0, 64, -1, "minecraft:stone"),
            at(0, 64, -2, "minecraft:lava", water),
          ],
        },
      ),
      1,
    );
    expectAllPassed(l);
  });

  it("flowing water drains once its source is built over", async () => {
    const r = await runLua(
      `${helpers}
ccunit.test("it flows, then it dries up", function()
  ccunit.truthy(turtle.place())
  sleep(2)
  ccunit.truthy(turtle.up())
  ccunit.truthy(turtle.forward())
  ccunit.truthy(turtle.forward())
  local ok, b = turtle.inspectDown()
  ccunit.truthy(ok and b.name == "minecraft:water", "no flow two blocks away")
  ccunit.truthy(turtle.back())
  turtle.select(2)
  ccunit.truthy(turtle.placeDown(), "could not build over the source")
  ccunit.truthy(turtle.forward())
  local took = waitFor(function() return not turtle.inspectDown() end, 12)
  ccunit.truthy(took, "the water never drained")
end)
`,
      turtleWorld({
        inventory: {
          "1": { name: "minecraft:water_bucket", count: 1 },
          "2": { name: "minecraft:cobblestone", count: 4 },
        },
      }),
    );
    expectAllPassed(r);
  });

  it("lava and water make obsidian, cobblestone and stone", async () => {
    const obsidian = await runLua(
      `${helpers}
ccunit.test("water poured next to a lava source makes obsidian", function()
  ccunit.truthy(turtle.place())
  ccunit.truthy(turtle.forward())
  local b = front()
  ccunit.eq(b and b.name, "minecraft:obsidian")
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:water_bucket", count: 1 } } },
        { blocks: [at(0, 64, -2, "minecraft:lava", water)] },
      ),
    );
    expectAllPassed(obsidian);
    const cobble = await runLua(
      `${helpers}
ccunit.test("flowing lava that meets water becomes cobblestone", function()
  ccunit.truthy(turtle.place())
  ccunit.truthy(turtle.up())
  ccunit.truthy(turtle.forward())
  ccunit.truthy(turtle.forward())
  sleep(3)
  local ok, b = turtle.inspectDown()
  ccunit.eq(ok and b.name, "minecraft:cobblestone")
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:lava_bucket", count: 1 } } },
        { blocks: [at(0, 64, -3, "minecraft:water", water)] },
      ),
    );
    expectAllPassed(cobble);
    const stone = await runLua(
      `${helpers}
ccunit.test("lava falling onto water makes stone", function()
  ccunit.truthy(turtle.place())
  sleep(3)
  ccunit.truthy(turtle.forward())
  local ok, b = turtle.inspectDown()
  ccunit.eq(ok and b.name, "minecraft:stone")
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:lava_bucket", count: 1 } } },
        { blocks: [at(0, 63, -1, "minecraft:water", water)] },
      ),
    );
    expectAllPassed(stone);
  });

  it("wheat grows on random ticks", async () => {
    const r = await runLua(
      `${helpers}
ccunit.test("after a long while it is ripe", function()
  sleep(8000)
  ccunit.eq(front().state.age, 7)
end)
`,
      turtleWorld(
        {},
        {
          fills: [
            {
              from: [-1, 63, -2],
              to: [1, 63, 0],
              name: "minecraft:farmland",
              state: { moisture: "7" },
            },
          ],
          blocks: [
            at(0, 64, -1, "minecraft:wheat", { state: { age: "0" } }),
            at(3, 63, -1, "minecraft:water", water),
          ],
        },
      ),
      1000,
    );
    expectAllPassed(r);
  });

  it("a pumpkin stem ripens and puts a pumpkin on the free soil beside it", async () => {
    const r = await runLua(
      `${helpers}
ccunit.test("the fruit grows in front of the stem", function()
  sleep(20000)
  local b = front()
  ccunit.eq(b and b.name, "minecraft:pumpkin")
end)
`,
      turtleWorld(
        {},
        {
          fills: [
            {
              from: [-1, 63, -3],
              to: [1, 63, 0],
              name: "minecraft:farmland",
              state: { moisture: "7" },
            },
          ],
          blocks: [
            at(0, 64, -2, "minecraft:pumpkin_stem", { state: { age: "0" } }),
            at(1, 64, -2, "minecraft:stone"),
            at(-1, 64, -2, "minecraft:stone"),
            at(0, 64, -3, "minecraft:stone"),
            at(3, 63, -1, "minecraft:water", water),
          ],
        },
      ),
      2000,
    );
    expectAllPassed(r);
  });

  it("bone meal ripens crops and grows saplings into trees", async () => {
    const crop = await runLua(
      `${helpers}
ccunit.test("each meal adds 2 to 5 stages until it is ripe", function()
  local age = 0
  local used = 0
  while turtle.place() do
    used = used + 1
    local now = tonumber(front().state.age)
    ccunit.truthy(now - age >= 2 or now == 7, "grew " .. (now - age))
    ccunit.truthy(now - age <= 5, "grew " .. (now - age))
    age = now
  end
  ccunit.eq(age, 7)
  ccunit.truthy(used >= 2 and used <= 4, "used " .. used)
  ccunit.eq(turtle.getItemCount(1), 16 - used)
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:bone_meal", count: 16 } } },
        {
          blocks: [
            at(0, 63, -1, "minecraft:farmland", { state: { moisture: "7" } }),
            at(0, 64, -1, "minecraft:wheat", { state: { age: "0" } }),
          ],
        },
      ),
    );
    expectAllPassed(crop);
    const tree = await runLua(
      `${helpers}
ccunit.test("meal on a sapling makes a basic oak tree", function()
  local tries = 0
  while front().name == "minecraft:oak_sapling" and tries < 60 do
    turtle.place()
    tries = tries + 1
  end
  ccunit.eq(front().name, "minecraft:oak_log")
  local height = 1
  for _ = 1, 8 do
    turtle.digUp()
    if not turtle.up() then break end
    local b = front()
    if b and b.name == "minecraft:oak_log" then height = height + 1 else break end
  end
  ccunit.truthy(height >= 4 and height <= 6, "trunk " .. height)
  ccunit.eq(front().name, "minecraft:oak_leaves")
end)
`,
      turtleWorld(
        {
          right: pick,
          inventory: { "1": { name: "minecraft:bone_meal", count: 64 } },
        },
        {
          blocks: [
            at(0, 63, -1, "minecraft:grass_block"),
            at(0, 64, -1, "minecraft:oak_sapling", { state: { stage: "0" } }),
          ],
        },
      ),
    );
    expectAllPassed(tree);
    const blocked = await runLua(
      `${helpers}
ccunit.test("no room, no tree", function()
  for _ = 1, 40 do turtle.place() end
  ccunit.eq(front().name, "minecraft:oak_sapling")
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:bone_meal", count: 64 } } },
        {
          blocks: [
            at(0, 64, -1, "minecraft:oak_sapling", { state: { stage: "0" } }),
            at(0, 66, -1, "minecraft:stone"),
          ],
        },
      ),
    );
    expectAllPassed(blocked);
  });

  it("furnaces smelt at 200 ticks an item", async () => {
    const r = await runLua(
      `${helpers}
local furnace = peripheral.wrap("bottom")
ccunit.test("two ores cook one after the other", function()
  ccunit.eq(furnace.list()[3], nil)
  turtle.dropDown(2)
  sleep(9)
  ccunit.eq(furnace.list()[3], nil, "not done at 9 s")
  ccunit.eq(furnace.list()[1].count, 2)
  local _, b = turtle.inspectDown()
  ccunit.eq(b.state.lit, true)
  sleep(2)
  ccunit.eq(furnace.list()[3], { name = "minecraft:iron_ingot", count = 1 }, "one ingot at 11 s")
  ccunit.eq(furnace.list()[1].count, 1)
  sleep(10)
  ccunit.eq(furnace.list()[3], { name = "minecraft:iron_ingot", count = 2 }, "two ingots at 21 s")
  ccunit.eq(furnace.list()[1], nil)
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:iron_ore", count: 2 } } },
        {
          blocks: [
            at(0, 63, 0, "minecraft:furnace", {
              items: { "2": { name: "minecraft:coal", count: 1 } },
            }),
          ],
        },
      ),
      5,
    );
    expectAllPassed(r);
  });

  it("furnace fuel lasts its burn time: two sticks cook one item, one stick none", async () => {
    const two = await runLua(
      `${helpers}
local furnace = peripheral.wrap("bottom")
ccunit.test("two sticks are 200 ticks", function()
  turtle.dropDown(1)
  sleep(11)
  ccunit.eq(furnace.list()[3], { name = "minecraft:iron_ingot", count = 1 })
  ccunit.eq(furnace.list()[2], nil)
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:raw_iron", count: 1 } } },
        {
          blocks: [
            at(0, 63, 0, "minecraft:furnace", {
              items: { "2": { name: "minecraft:stick", count: 2 } },
            }),
          ],
        },
      ),
      5,
    );
    expectAllPassed(two);
    const one = await runLua(
      `${helpers}
local furnace = peripheral.wrap("bottom")
ccunit.test("one stick is 100 ticks, not enough", function()
  turtle.dropDown(1)
  sleep(15)
  ccunit.eq(furnace.list()[3], nil)
  ccunit.eq(furnace.list()[1], { name = "minecraft:raw_iron", count = 1 })
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:raw_iron", count: 1 } } },
        {
          blocks: [
            at(0, 63, 0, "minecraft:furnace", {
              items: { "2": { name: "minecraft:stick", count: 1 } },
            }),
          ],
        },
      ),
      5,
    );
    expectAllPassed(one);
  });

  it("a blast furnace cooks ore in 100 ticks, and a log makes charcoal by its tag", async () => {
    const blast = await runLua(
      `${helpers}
local furnace = peripheral.wrap("bottom")
ccunit.test("blasting is twice as fast", function()
  turtle.dropDown(1)
  sleep(4)
  ccunit.eq(furnace.list()[3], nil)
  sleep(2)
  ccunit.eq(furnace.list()[3], { name = "minecraft:iron_ingot", count = 1 })
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:raw_iron", count: 1 } } },
        {
          blocks: [
            at(0, 63, 0, "minecraft:blast_furnace", {
              items: { "2": { name: "minecraft:coal", count: 1 } },
            }),
          ],
        },
      ),
      5,
    );
    expectAllPassed(blast);
    const log = await runLua(
      `${helpers}
local furnace = peripheral.wrap("bottom")
ccunit.test("a log is smelted to charcoal", function()
  turtle.dropDown(1)
  sleep(11)
  ccunit.eq(furnace.list()[3], { name = "minecraft:charcoal", count = 1 })
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:oak_log", count: 1 } } },
        {
          blocks: [
            at(0, 63, 0, "minecraft:furnace", {
              items: { "2": { name: "minecraft:coal", count: 1 } },
            }),
          ],
        },
      ),
      5,
    );
    expectAllPassed(log);
  });

  it("a hopper passes one item every 8 ticks", async () => {
    const r = await runLua(
      `${helpers}
ccunit.test("five items cross at 0.4 s each", function()
  turtle.drop(5) -- into the hopper in front, which faces down onto a chest
  ccunit.truthy(turtle.digDown())
  ccunit.truthy(turtle.down())
  local chest = peripheral.wrap("front")
  local function count()
    local n = 0
    for _, item in pairs(chest.list()) do n = n + item.count end
    return n
  end
  local seen, times = 0, {}
  local t0 = os.clock()
  while seen < 5 and os.clock() - t0 < 6 do
    local now = count()
    while seen < now do seen = seen + 1 times[seen] = os.clock() end
    sleep(0.05)
  end
  ccunit.eq(seen, 5)
  -- the first few crossed while the turtle was still climbing down: judge the ones it watched arrive
  local distinct = { times[1] }
  for i = 2, 5 do
    if times[i] ~= distinct[#distinct] then distinct[#distinct + 1] = times[i] end
  end
  ccunit.truthy(#distinct >= 2, "saw only one arrival time")
  for i = 2, #distinct do
    local gap = distinct[i] - distinct[i - 1]
    ccunit.truthy(gap >= 0.3 and gap <= 0.55, "gap " .. i .. " = " .. gap)
  end
end)
`,
      turtleWorld(
        {
          right: pick,
          inventory: { "1": { name: "minecraft:cobblestone", count: 5 } },
        },
        {
          blocks: [
            at(0, 64, -1, "minecraft:hopper", { state: { facing: "down" } }),
            at(0, 63, -1, "minecraft:chest"),
          ],
        },
      ),
      1,
    );
    expectAllPassed(r);
  });

  it("a hopper picks up the stack lying above it", async () => {
    const r = await runLua(
      `${helpers}
ccunit.test("the dropped stack ends up inside", function()
  turtle.drop(3)
  sleep(2)
  ccunit.eq(turtle.suck(), false, "nothing is left lying there")
  ccunit.truthy(turtle.down())
  local hopper = peripheral.wrap("front")
  ccunit.eq(hopper.list()[1], { name = "minecraft:cobblestone", count = 3 })
end)
`,
      turtleWorld(
        {
          y: 65,
          inventory: { "1": { name: "minecraft:cobblestone", count: 3 } },
        },
        {
          blocks: [
            at(0, 64, -1, "minecraft:hopper", { state: { facing: "down" } }),
            at(0, 65, -2, "minecraft:stone"),
            at(0, 64, 0, "minecraft:air"),
          ],
        },
      ),
    );
    expectAllPassed(r);
  });

  it("dropped stacks merge, and despawn after 6000 ticks", async () => {
    const merge = await runLua(
      `${helpers}
ccunit.test("two stacks in one block become one", function()
  turtle.drop(10)
  turtle.drop(10)
  sleep(3)
  ccunit.truthy(turtle.suck())
  ccunit.eq(turtle.getItemCount(1), 20)
  ccunit.eq(turtle.suck(), false)
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:cobblestone", count: 20 } } },
        { blocks: [at(0, 64, -2, "minecraft:stone")] },
      ),
    );
    expectAllPassed(merge);
    const early = await runLua(
      `${helpers}
ccunit.test("still there after 5900 ticks", function()
  turtle.drop(5)
  sleep(295)
  ccunit.truthy(turtle.suck())
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:cobblestone", count: 5 } } },
        { blocks: [at(0, 64, -2, "minecraft:stone")] },
      ),
    );
    expectAllPassed(early);
    const gone = await runLua(
      `${helpers}
ccunit.test("gone after 6000 ticks", function()
  turtle.drop(5)
  sleep(305)
  ccunit.eq({ turtle.suck() }, { false, "No items to take" })
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:cobblestone", count: 5 } } },
        { blocks: [at(0, 64, -2, "minecraft:stone")] },
      ),
    );
    expectAllPassed(gone);
  });
});
