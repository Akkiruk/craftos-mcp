// New World for This File: the world a program asks for (src/worldTemplate.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { worldForProgram, worldText } from "../../src/worldTemplate.ts";

const data = {
  newest: "1.21.1",
  versions: [{ mc: "1.21.1", cc: "1.121.0" }],
  addons: [
    {
      id: "advanced-peripherals",
      name: "Advanced Peripherals",
      versions: { "1.21.1": "0.7" },
      types: ["playerDetector", "chatBox"],
      requires: [],
    },
    {
      id: "needs-ap",
      name: "Needs AP",
      versions: { "1.21.1": "1" },
      types: ["thing"],
      requires: ["advanced-peripherals"],
    },
  ],
};

test("a program that finds a monitor gets one monitor and nothing else", () => {
  const world = worldForProgram(
    'local mon = peripheral.find("monitor")\nmon.clear()\n',
    data,
  );
  assert.deepEqual(world, {
    monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
  });
  assert.equal(worldText("print('hi')", data), "{}\n");
});

test("wrapped sides get the type their calls point at; rednet.open gets a modem", () => {
  const world = worldForProgram(
    `local out = peripheral.wrap("left")
local box = peripheral.wrap("right")
local p = peripheral.wrap("bottom")
rednet.open("back")
out.setTextScale(0.5)
box.pushItems("left", 1)
p.newPage()
-- peripheral.find("speaker") in a comment is not asked for
local s = "peripheral.find('drive')"`,
    data,
  );
  assert.deepEqual(world, {
    monitors: [{ name: "left", blocksWide: 3, blocksHigh: 2 }],
    peripherals: [
      { name: "back", type: "modem" },
      { name: "right", type: "minecraft:chest", size: 27 },
      { name: "bottom", type: "printer", ink: 64, paper: 64 },
    ],
  });
});

test("a mod's block switches its mod on, with what it needs, and brings a player", () => {
  const world = worldForProgram(
    'local det = peripheral.find("playerDetector")\nlocal t = peripheral.find("thing")\nlocal c = peripheral.find("inventory")',
    data,
  );
  assert.deepEqual(world.addons, ["advanced-peripherals", "needs-ap"]);
  assert.deepEqual(world.players, [{ name: "Alice", x: 2, y: 64, z: 0 }]);
  assert.deepEqual(
    world.peripherals?.map((p) => [p.name, p.type]),
    [
      ["top", "playerDetector"],
      ["right", "thing"],
      ["left", "minecraft:chest"],
    ],
  );
});

test("a turtle program gets a turtle with fuel; a network name keeps its name and type", () => {
  const world = worldForProgram(
    'turtle.forward()\nlocal c = peripheral.wrap("minecraft:barrel_0")\nc.list()',
    data,
  );
  assert.deepEqual(world, {
    turtle: { fuel: 1000 },
    peripherals: [
      { name: "minecraft:barrel_0", type: "minecraft:barrel", size: 27 },
    ],
  });
});

test("a type nobody knows is left for the person to add", () => {
  assert.deepEqual(
    worldForProgram('peripheral.find("nosuchmod:block")', data),
    {},
  );
});
