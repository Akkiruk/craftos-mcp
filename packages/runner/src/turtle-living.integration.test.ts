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

// jump(seconds): the sim jumps the virtual clock (a test's own ccsim_cmd), and the world catches up, before it returns
const jump = `
local function jump(seconds)
  os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON({ cmd = "advance", seconds = seconds }))
  sleep(0.05)
end
`;

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
  local stamp, before, wet, looked = {}, {}, {}, {}
  local asked = os.clock()
  ccunit.truthy(turtle.digDown())
  local dug = os.clock()
  local t0 = dug
  for k = 1, 6 do
    before[k] = (os.clock() - t0) * 20
    ccunit.truthy(turtle.forward())
    stamp[k] = (os.clock() - t0) * 20
    local ok, b = turtle.inspectDown()
    looked[k] = (os.clock() - asked) * 20
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
  -- The dig freed the flow no earlier than it was asked for, so cell k (k blocks east of the dug cell) is never wet
  -- before 5 * (k + 1) ticks after that; a look that saw water had returned by then. Both ends are ones no load can
  -- move the wrong way: the dig cannot run before it is asked for, and the look cannot return before it ran (a
  -- return can come late, and the look runs 8 ticks after its move, so the time a move returned says nothing).
  for k = 1, 6 do
    if wet[k] then ccunit.truthy(looked[k] >= 5 * (k + 1) - 0.5, "cell " .. k .. " seen wet " .. looked[k] .. " ticks after the dig was asked for") end
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
      `${helpers}${jump}
local furnace = peripheral.wrap("bottom")
-- the clock jumps from one look to the next, on real time: on a 5x clock a busy host's late looks ran a second past
ccunit.test("two ores cook one after the other", function()
  ccunit.eq(furnace.list()[3], nil)
  turtle.dropDown(2)
  sleep(0.05)
  jump(9)
  ccunit.eq(furnace.list()[3], nil, "not done at 9 s")
  ccunit.eq(furnace.list()[1].count, 2)
  local _, b = turtle.inspectDown()
  ccunit.eq(b.state.lit, true)
  jump(2)
  ccunit.eq(furnace.list()[3], { name = "minecraft:iron_ingot", count = 1 }, "one ingot at 11 s")
  ccunit.eq(furnace.list()[1].count, 1)
  jump(10)
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
      1,
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
  -- the first few crossed while the turtle was still climbing down: judge the ones it watched arrive. Each is timed
  -- when a look saw it, and a busy host can make any look late, so one gap can come out short and the next long:
  -- the average over the arrivals watched is the hopper's pace.
  -- (items seen in one look came while it was not looking: start from the first one seen arrive on its own)
  local first = 1
  while first < 5 and times[first + 1] == times[first] do first = first + 1 end
  if first > 1 and first < 4 then first = first + 1 end
  ccunit.truthy(first < 5 and times[5] > times[first], "saw only one arrival time")
  local pace = (times[5] - times[first]) / (5 - first)
  ccunit.truthy(pace >= 0.3 and pace <= 0.55, "one item every " .. pace .. " s")
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
    // 100 ticks either side of the limit: on a 100x clock that was 50 ms of real time, which a busy host's sleep
    // overran (the item gone at "5900"). The clock jumps instead, on real time, where the slack is a few ticks.
    const early = await runLua(
      `${helpers}${jump}
ccunit.test("still there after 5900 ticks", function()
  turtle.drop(5)
  sleep(0.1)
  jump(295)
  ccunit.truthy(turtle.suck())
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:cobblestone", count: 5 } } },
        { blocks: [at(0, 64, -2, "minecraft:stone")] },
      ),
      1,
    );
    expectAllPassed(early);
    const gone = await runLua(
      `${helpers}${jump}
ccunit.test("gone after 6000 ticks", function()
  turtle.drop(5)
  sleep(0.1)
  jump(305)
  ccunit.eq({ turtle.suck() }, { false, "No items to take" })
end)
`,
      turtleWorld(
        { inventory: { "1": { name: "minecraft:cobblestone", count: 5 } } },
        { blocks: [at(0, 64, -2, "minecraft:stone")] },
      ),
      1,
    );
    expectAllPassed(gone);
  });

  it("water poured off a ledge falls straight down as falling water and spreads 7 blocks at the bottom", async () => {
    // FlowingFluid.spread: a block that can flow down only flows down (fewer than 3 sources beside it), the block
    // below it is falling water (level 8, amount 8) and spreads no further sideways in the air; where it lands it
    // spreads to the sides as if it had amount 8, one less per block, so 7 blocks out over flat ground.
    const fall = await runLua(
      `${helpers}
ccunit.test("a column, then a diamond on the floor", function()
  ccunit.truthy(turtle.place()) -- the source on the edge of the ledge: it runs off east, where there is a drop
  ccunit.truthy(turtle.up())
  for _ = 1, 3 do ccunit.truthy(turtle.forward()) end
  turtle.turnLeft()
  turtle.turnLeft() -- at 2,71,0 facing west: the column at x = 1 is in front on the way down
  for y = 70, 65, -1 do
    ccunit.truthy(turtle.down(), "nothing spreads sideways out of the column at y " .. y)
    local b = front()
    ccunit.eq(b and b.name, "minecraft:water", "y " .. y)
    ccunit.eq(b.state.level, y == 70 and 1 or 8, "y " .. y .. ": the lip off the ledge, then falling water")
  end
  turtle.turnLeft()
  turtle.turnLeft() -- facing east along the floor, from beside the foot of the column at 1,64,0
  for x = 2, 9 do
    if x > 2 then ccunit.truthy(turtle.forward()) end
    local ok, b = turtle.inspectDown()
    if x <= 8 then
      ccunit.truthy(ok and b.name == "minecraft:water", "floor at x " .. x)
      ccunit.eq(b.state.level, x - 1, "floor at x " .. x)
    else
      ccunit.eq(ok, false, "nothing 8 blocks from the foot")
    end
  end
end)
`,
      turtleWorld(
        {
          x: -1,
          y: 70,
          facing: "east",
          inventory: { "1": { name: "minecraft:water_bucket", count: 1 } },
        },
        {
          fills: [
            { from: [-3, 64, -3], to: [0, 69, 3], name: "minecraft:stone" },
          ],
        },
      ),
    );
    expectAllPassed(fall);
    // The times, on real time: a column held up by a shelf, which the turtle digs out from beside it. The water
    // above the shelf falls a block every 5 ticks (66, 65, 64) and spreads onto the floor 5 ticks after landing.
    const timed = await runLua(
      `${helpers}
ccunit.test("one block per 5 ticks, then onto the floor", function()
  local asked = os.clock()
  ccunit.truthy(turtle.dig())
  ccunit.truthy(turtle.down())
  local b = front()
  ccunit.eq(b and b.name, "minecraft:water")
  ccunit.eq(b.state.level, 8, "falling past the turtle")
  -- the dig cannot run before it was asked for, and the fluid never runs early: 4 steps of 5 ticks at the least
  local took, under = waitFor(function()
    local ok, d = turtle.inspectDown()
    return ok and d or nil
  end, 30)
  ccunit.truthy(took, "the floor never got wet")
  ccunit.eq(under.state.level, 1)
  ccunit.truthy(os.clock() - asked >= 1.0 - 0.05, "on the floor " .. (os.clock() - asked) * 20 .. " ticks after the dig was asked for")
end)
`,
      turtleWorld(
        { x: 2, y: 66, facing: "west", right: pick },
        {
          blocks: [
            at(1, 70, 0, "minecraft:water", water),
            at(1, 69, 0, "minecraft:water", { state: { level: "8" } }),
            at(1, 68, 0, "minecraft:water", { state: { level: "8" } }),
            at(1, 67, 0, "minecraft:water", { state: { level: "8" } }),
            at(1, 66, 0, "minecraft:stone"),
          ],
        },
      ),
      1,
    );
    expectAllPassed(timed);
  });

  it("two sources make a third between them over solid ground, and not over a drop", async () => {
    // WaterFluid.canConvertToSource: a block with two or more water sources beside it becomes a source when the block
    // below it is solid or a source. Here two sources sit in pockets either side of a stone the turtle digs out; the
    // only way out of each pocket is the dug cell.
    const pockets = (extra: ReturnType<typeof at>[]) => ({
      blocks: [
        at(-1, 64, -1, "minecraft:water", water),
        at(1, 64, -1, "minecraft:water", water),
        at(0, 64, -1, "minecraft:stone"),
        at(-2, 64, -1, "minecraft:stone"),
        at(-1, 64, -2, "minecraft:stone"),
        at(-1, 64, 0, "minecraft:stone"),
        at(2, 64, -1, "minecraft:stone"),
        at(1, 64, -2, "minecraft:stone"),
        at(1, 64, 0, "minecraft:stone"),
        at(0, 64, -2, "minecraft:stone"),
        ...extra,
      ],
    });
    const solid = await runLua(
      `${helpers}
ccunit.test("a new source, and again after it is bucketed", function()
  local asked = os.clock()
  ccunit.truthy(turtle.dig())
  local took, b = waitFor(front, 30)
  ccunit.truthy(took, "no water came")
  ccunit.eq(b.name, "minecraft:water")
  ccunit.eq(b.state.level, 0, "a source, not the flowing level 1 one source would give")
  ccunit.truthy(os.clock() - asked >= 0.25 - 0.05, "never early")
  -- infinite water: take it, and it is there again
  ccunit.truthy(turtle.place(), "the bucket takes the new source")
  ccunit.eq(turtle.getItemDetail(1).name, "minecraft:water_bucket")
  asked = os.clock()
  took, b = waitFor(front, 30)
  ccunit.truthy(took, "it did not come back")
  ccunit.eq(b.state.level, 0)
  ccunit.truthy(os.clock() - asked >= 0.25 - 0.05, "never early")
end)
`,
      turtleWorld(
        {
          right: pick,
          inventory: { "1": { name: "minecraft:bucket", count: 1 } },
        },
        pockets([]),
      ),
      1,
    );
    expectAllPassed(solid);
    const drop = await runLua(
      `${helpers}
ccunit.test("over a drop it is only flowing water", function()
  ccunit.truthy(turtle.dig())
  local took, b = waitFor(front, 30)
  ccunit.truthy(took, "no water came")
  ccunit.eq(b.state.level, 1)
  -- it pours into the hole below, and falling water under it is no source either
  sleep(1.5)
  ccunit.eq(front().state.level, 1, "still flowing")
end)
`,
      turtleWorld({ right: pick }, pockets([at(0, 63, -1, "minecraft:air")])),
      1,
    );
    expectAllPassed(drop);
  });

  it("a large open flood off a ledge is caught up inside the yield limit", async () => {
    // Eight sources in a row on a 9 x 9 ledge 119 blocks over an open plane: the water runs to every edge and falls
    // the whole way in columns (600 ticks of falling), then spreads on the plane below. A jump of the clock makes one
    // catch-up do nearly all of it, the worst case for the 7 s limit without yielding.
    const r = await runLua(
      `${jump}
local function look(fn)
  local ok, b = fn()
  return ok and b or nil
end
ccunit.test("the flood runs its course", function()
  -- a row of sources from x = 4 down to x = -3, the turtle backing west along it
  for slot = 1, 8 do
    turtle.select(slot)
    ccunit.truthy(turtle.place(), "source " .. slot)
    if slot < 8 then ccunit.truthy(turtle.back()) end
  end
  -- 10 s of the flood with the program waiting on events all the while: the sim's state file (a thing of the emulator,
  -- not the game) is not written again at every wait while the world changes on its own. Each write rewrites every
  -- changed block, and it was written at every catch-up, 2 a second (20 here, most of a flood's time); now when the
  -- changes come to a quarter of the changed blocks, or every 100 ticks. Counted by its size, which grows with the flood.
  local function size() return fs.getSize("/results/state.json") end
  local writes, seen, t0 = 0, size(), os.clock()
  while os.clock() - t0 < 10 do
    os.queueEvent("poll")
    os.pullEvent("poll")
    local s = size()
    if s ~= seen then writes, seen = writes + 1, s end
  end
  ccunit.truthy(writes <= 8, "the state was written " .. writes .. " times in 10 s")
  local before = os.clock()
  jump(60)
  -- the jump itself is 60 s; what it took beyond that is the catch-up, in real seconds on a 5x clock (about 0.4 s;
  -- over 3 s before the slope search kept its caches, and the guard's 7 s before the tag lookups were cached)
  local over = (os.clock() - before - 60) / 5
  ccunit.truthy(over < 1.5, "the catch-up took " .. over .. " s")
  local src = look(turtle.inspect)
  ccunit.eq(src and src.name, "minecraft:water")
  ccunit.eq(src.state.level, 0, "a source stays a source")
  -- the east end: the source at x = 4 runs off the ledge into x = 5, which falls the whole way as falling water
  ccunit.truthy(turtle.up())
  for _ = 1, 10 do ccunit.truthy(turtle.forward()) end -- above the row, to x = 6
  turtle.turnLeft()
  turtle.turnLeft() -- facing west, the column in front
  ccunit.truthy(turtle.down())
  local lip = look(turtle.inspect)
  ccunit.eq(lip and lip.name, "minecraft:water")
  ccunit.eq(lip.state.level, 1, "the block that ran off the edge, one less than its source")
  for y = 69, 66, -1 do
    ccunit.truthy(turtle.down(), "nothing spreads sideways out of the column at y " .. y)
    local b = look(turtle.inspect)
    ccunit.eq(b and b.name, "minecraft:water", "column at y " .. y)
    ccunit.eq(b.state.level, 8, "falling at y " .. y)
  end
end)
`,
      turtleWorld(
        {
          x: 3,
          y: 70,
          z: 0,
          facing: "east",
          inventory: Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [
              String(i + 1),
              { name: "minecraft:water_bucket", count: 1 },
            ]),
          ),
        },
        {
          ground: { y: -50, name: "minecraft:stone" },
          fills: [
            { from: [-4, -49, -4], to: [4, 69, 4], name: "minecraft:stone" },
          ],
        },
      ),
      5,
    );
    expectAllPassed(r);
  });
});
