// Turtles that build: a computer a turtle places is numbered, turns on, boots from a floppy in a drive the turtle
// put next to it, and the blocks and disks are the same for every computer in the world (blockworld.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runProgram,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "turtle-build-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, text: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

async function runLua(lua: string, world: WorldConfig): Promise<TestRunResult> {
  counter += 1;
  const name = `build${counter}.test.lua`;
  put(name, lua);
  return runTests(config, { paths: [name], world, timeoutMs: 90000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures, JSON.stringify(result.files[0]?.terminal)).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

// The installer floppy: copies the game, names the computer, leaves a receipt on the disk
const installer = {
  "startup.lua": [
    `fs.copy("disk/game.lua", "/game.lua")`,
    `os.setComputerLabel("cabinet")`,
    `local h = fs.open("disk/installed.txt", "w") h.write(tostring(os.getComputerID())) h.close()`,
  ].join("\n"),
  "game.lua": `print("game")`,
};

function buildWorld(extra: WorldConfig = {}): WorldConfig {
  return {
    turtle: {
      x: 0,
      y: 64,
      z: 0,
      facing: "north",
      fuel: 100,
      inventory: {
        "1": { name: "computercraft:computer_advanced", count: 1 },
        "2": { name: "computercraft:disk_drive", count: 1 },
        "3": { name: "computercraft:disk", count: 1, diskId: 7 },
        "4": { name: "computercraft:monitor_advanced", count: 8 },
      },
    },
    ground: { y: 63, name: "minecraft:stone" },
    disks: { "7": installer },
    ...extra,
  };
}

describe.skipIf(!ready)(
  "turtles that build computers",
  { concurrent: true, timeout: 180000 },
  () => {
    it("places a computer, gives it an installer disk and turns it on", async () => {
      const r = await runLua(
        `
local function waitFor(fn, seconds)
  local deadline = os.clock() + seconds
  while os.clock() < deadline do
    local ok, v = pcall(fn)
    if ok and v then return v end
    sleep(0.2)
  end
  return nil
end

ccunit.test("the computer goes down facing the turtle, with no number until it boots", function()
  turtle.select(1)
  ccunit.eq({ turtle.place() }, { true })
  local _, b = turtle.inspect()
  ccunit.eq(b.name, "computercraft:computer_advanced")
  ccunit.eq(b.state.facing, "south")
  ccunit.eq(peripheral.getType("front"), "computer")
  ccunit.eq(peripheral.call("front", "getID"), -1)
  ccunit.eq(peripheral.call("front", "isOn"), false)
end)

ccunit.test("a drive on the computer's side, with the floppy in it", function()
  turtle.turnRight() turtle.forward() turtle.turnLeft() -- now at 1,64,0 facing north
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  ccunit.eq(peripheral.getType("front"), "drive")
  turtle.select(3)
  ccunit.eq({ turtle.drop() }, { true })
  ccunit.eq(turtle.getItemCount(3), 0)
  ccunit.truthy(disk.isPresent("front"), "the disk is in")
  ccunit.eq(disk.getID("front"), 7)
  ccunit.truthy(fs.exists("disk/startup.lua"), "the turtle reads the floppy")
end)

ccunit.test("turned on, it boots from the disk and installs", function()
  turtle.turnLeft() turtle.forward() turtle.turnRight() -- back at 0,64,0 facing the computer
  peripheral.call("front", "turnOn")
  ccunit.truthy(waitFor(function() return peripheral.call("front", "isOn") end, 10), "it turned on")
  ccunit.eq(waitFor(function() return peripheral.call("front", "getLabel") end, 20), "cabinet")
  ccunit.eq(peripheral.call("front", "getID"), 1, "the world's next computer number")
end)

ccunit.test("the receipt on the disk carries the computer's id", function()
  turtle.turnRight() turtle.forward() turtle.turnLeft()
  local id = waitFor(function()
    if not fs.exists("disk/installed.txt") then return nil end
    local h = fs.open("disk/installed.txt", "r") local t = h.readAll() h.close()
    return tonumber(t)
  end, 10)
  turtle.turnLeft() turtle.forward() turtle.turnRight()
  ccunit.eq(id, peripheral.call("front", "getID"))
end)
`,
        buildWorld(),
      );
      expectAllPassed(r);
    });

    it("the placed computer runs and keeps its files", async () => {
      put(
        "build.lua",
        `
turtle.select(1) turtle.place()
turtle.turnRight() turtle.forward() turtle.turnLeft()
turtle.select(2) turtle.place()
turtle.select(3) turtle.drop()
turtle.turnLeft() turtle.forward() turtle.turnRight()
peripheral.call("front", "turnOn")
local deadline = os.clock() + 20
while os.clock() < deadline and peripheral.call("front", "getLabel") ~= "cabinet" do sleep(0.2) end
sleep(1)
`,
      );
      const r = await runProgram(config, {
        program: "build.lua",
        world: buildWorld(),
        timeoutMs: 60000,
      });
      expect(r.status).toBe("completed");
      expect(r.computers?.length).toBe(1);
      const computer = r.computers![0]!;
      expect(computer.id).toBe(1);
      expect(computer.pos).toBe("0,64,-1");
      expect(r.sim?.blocks?.["0,64,-1"]?.name).toBe(
        "computercraft:computer_advanced",
      );
      expect(r.sim?.blocks?.["1,64,-1"]?.name).toBe("computercraft:disk_drive");
    });

    it("monitors placed side by side make one wall", async () => {
      const r = await runLua(
        `
ccunit.test("a 3x2 wall on top of a computer", function()
  -- a computer at 0,64,-1, then monitors on the row above and the one above that, all facing the turtle
  turtle.select(1) turtle.place()
  turtle.up()
  turtle.select(4)
  turtle.turnLeft() turtle.forward() turtle.turnRight()  -- -1,65,0
  turtle.place()
  turtle.turnRight() turtle.forward() turtle.turnLeft()  -- 0,65,0
  turtle.place()
  turtle.turnRight() turtle.forward() turtle.turnLeft()  -- 1,65,0
  turtle.place()
  turtle.up()
  turtle.place()
  turtle.turnLeft() turtle.forward() turtle.turnRight()
  turtle.place()
  turtle.turnLeft() turtle.forward() turtle.turnRight()
  turtle.place()
  local _, m = turtle.inspect()
  ccunit.eq(m.name, "computercraft:monitor_advanced")
  ccunit.eq(m.state.facing, "south")
  -- the turtle sees the wall in front of it as one monitor
  ccunit.eq(peripheral.getType("front"), "monitor")
  local w, h = peripheral.call("front", "getSize")
  ccunit.eq({ w, h }, { 29, 12 }, "3x2 blocks at text scale 1")
end)
ccunit.test("without a block behind it, a monitor put on top of another lies face up", function()
  turtle.up()
  turtle.select(4)
  turtle.place() -- nothing 2 ahead: the turtle clicks the top of the monitor below, looking down
  local _, m = turtle.inspect()
  ccunit.eq(m.state.orientation, "up")
end)
`,
        // A wall behind the monitors: each one is put against it, looking straight ahead (spec 5.3)
        buildWorld({
          fills: [
            { from: [-1, 64, -2], to: [1, 66, -2], name: "minecraft:stone" },
          ],
        }),
      );
      expectAllPassed(r);
    });
  },
);
