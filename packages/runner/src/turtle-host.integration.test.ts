// What the block world host holds for every computer in it (blockworld.ts): the nbt hash, protection, the computer and
// disk counters, wired networks from placed cables, shared monitor walls, placed turtles and interactive sessions.
// Expected values come from the CC:Tweaked 1.101.3 source (docs/turtle/cct-1.101.3-turtle-rules.md and the classes
// named in each case).
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SessionManager,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runProgram,
  runTests,
  startInBlockWorld,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "turtle-host-ws-"));
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
  const name = `host${counter}.test.lua`;
  put(name, WAIT_FOR + lua);
  return runTests(config, { paths: [name], world, timeoutMs: 90000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures, JSON.stringify(result.files[0]?.terminal)).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const WAIT_FOR = `
local function waitFor(fn, seconds)
  local deadline = os.clock() + (seconds or 10)
  while os.clock() < deadline do
    local ok, v = pcall(fn)
    if ok and v then return v end
    sleep(0.1)
  end
  return nil
end
`;

const at = (x: number, y: number, z: number, name: string, more = {}) => ({
  x,
  y,
  z,
  name,
  ...more,
});

function turtleWorld(
  inventory: Record<string, Record<string, unknown>> = {},
  extra: WorldConfig = {},
): WorldConfig {
  return {
    turtle: {
      x: 0,
      y: 64,
      z: 0,
      facing: "north",
      fuel: 100,
      inventory: inventory as never,
    },
    ground: { y: 63, name: "minecraft:stone" },
    ...extra,
  };
}

/** The NBT NBTUtil writes: a compound with its keys sorted, ints and strings only. */
function nbtCompound(entries: [string, number | string][]): Buffer {
  const parts: Buffer[] = [Buffer.from([10, 0, 0])];
  for (const [key, value] of [...entries].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const name = Buffer.from(key, "utf8");
    if (typeof value === "number") {
      parts.push(Buffer.from([3, 0, name.length]), name);
      const v = Buffer.alloc(4);
      v.writeInt32BE(value);
      parts.push(v);
    } else {
      const text = Buffer.from(value, "utf8");
      parts.push(Buffer.from([8, 0, name.length]), name);
      parts.push(Buffer.from([text.length >> 8, text.length & 255]), text);
    }
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
const md5 = (b: Buffer): string => createHash("md5").update(b).digest("hex");

describe.skipIf(!ready)(
  "the block world host",
  { concurrent: true, timeout: 180000 },
  () => {
    it("hashes NBT as NBTUtil does: MD5 of the tag written big-endian, keys sorted", async () => {
      // Programs do not see rom/ccsim, as a real ROM has none: the module under test and its one dependency are copied in
      for (const file of ["turtle/nbt.lua", "mek/java.lua"]) {
        const to = join(scratch, "ccsim", file);
        mkdirSync(join(to, ".."), { recursive: true });
        copyFileSync(join(base.romDir, "rom", "ccsim", file), to);
      }
      const damage0 = md5(nbtCompound([["Damage", 0]]));
      const damage5 = md5(nbtCompound([["Damage", 5]]));
      const named = md5(
        nbtCompound([
          ["RepairCost", 2],
          ["Damage", 1],
          ["Name", "Sword"],
        ]),
      );
      const r = await runLua(
        `
local function simModule(path)
  local env = setmetatable({}, { __index = _G })
  function env.dofile(p) return assert(loadfile((p:gsub("^/rom/ccsim/", "/ccsim/")), nil, env))() end
  return env.dofile(path)
end
ccunit.test("md5", function()
  local N = simModule("/rom/ccsim/turtle/nbt.lua")()
  ccunit.eq(N.md5(""), "d41d8cd98f00b204e9800998ecf8427e")
  ccunit.eq(N.md5("abc"), "900150983cd24fb0d6963f7d28e17f72")
  ccunit.eq(N.md5(("a"):rep(100)), "${md5(Buffer.from("a".repeat(100)))}")
end)
ccunit.test("a new tool is {Damage:0}", function()
  ccunit.eq(turtle.getItemDetail(1, true).nbt, "${damage0}")
  ccunit.eq(turtle.getItemDetail(2, true).nbt, "${damage5}")
  ccunit.eq(turtle.getItemDetail(1).nbt, nil, "no nbt in the basic detail")
end)
ccunit.test("a full tag, as a table or as SNBT", function()
  ccunit.eq(turtle.getItemDetail(3, true).nbt, "${named}")
  ccunit.eq(turtle.getItemDetail(4, true).nbt, "${named}")
end)
ccunit.test("floats, longs, lists and nesting go through", function()
  local N = simModule("/rom/ccsim/turtle/nbt.lua")()
  -- {a:1.5f}: 0a 0000 05 0001 61 3fc00000 00
  ccunit.eq(N.encode("{a:1.5f}"), "\\10\\0\\0\\5\\0\\1a\\63\\192\\0\\0\\0")
  -- {l:[I;1]}: an int array
  ccunit.eq(N.encode("{l:[I;1]}"), "\\10\\0\\0\\11\\0\\1l\\0\\0\\0\\1\\0\\0\\0\\1\\0")
  -- {n:-1L}
  ccunit.eq(N.encode("{n:-1L}"), "\\10\\0\\0\\4\\0\\1n" .. ("\\255"):rep(8) .. "\\0")
  -- a list of strings
  ccunit.eq(N.encode('{t:["x"]}'), "\\10\\0\\0\\9\\0\\1t\\8\\0\\0\\0\\1\\0\\1x\\0")
end)
`,
        turtleWorld({
          "1": { name: "minecraft:diamond_pickaxe", count: 1 },
          "2": { name: "minecraft:iron_sword", count: 1, damage: 5 },
          "3": {
            name: "minecraft:iron_sword",
            count: 1,
            damage: 1,
            nbt: { Damage: 1, RepairCost: 2, Name: "Sword" },
          },
          "4": {
            name: "minecraft:iron_sword",
            count: 1,
            damage: 1,
            nbt: '{Name:"Sword",Damage:1,RepairCost:2}',
          },
        }),
      );
      expectAllPassed(r);
    });

    it("spawn protection, unloaded chunks and the world border stop a turtle", async () => {
      const r = await runLua(
        `
ccunit.test("spawn protection: enter, dig, place", function()
  -- spawn 0,-3, radius 1: x -1..1, z -4..-2 is protected, and there is dirt at 0,64,-2
  ccunit.eq({ turtle.forward() }, { true })
  ccunit.eq({ turtle.forward() }, { false, "Cannot enter protected area" })
  ccunit.eq({ turtle.dig() }, { false, "Cannot break protected block" })
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { false, "Cannot place in protected area" })
  ccunit.eq({ turtle.placeDown() }, { false, "Cannot place block here" }, "outside the area it is the usual answer")
end)
ccunit.test("an unloaded chunk", function()
  turtle.turnLeft() -- west, from 0,64,-1: chunk x -1 is not loaded
  ccunit.eq({ turtle.forward() }, { false, "Cannot leave loaded world" })
end)
ccunit.test("the world border", function()
  turtle.turnLeft() turtle.turnLeft() -- east; the border is 12 wide around 0,0: x -6..5
  for i = 1, 5 do ccunit.eq({ turtle.forward() }, { true }) end
  ccunit.eq({ turtle.forward() }, { false, "Cannot pass the world border" })
end)
`,
        turtleWorld(
          {
            "1": { name: "minecraft:diamond_pickaxe", count: 1 },
            "2": { name: "minecraft:stone", count: 4 },
          },
          {
            turtle: {
              x: 0,
              y: 64,
              z: 0,
              facing: "north",
              fuel: 100,
              right: "minecraft:diamond_pickaxe",
              inventory: { "2": { name: "minecraft:stone", count: 4 } },
            },
            blocks: [at(0, 64, -2, "minecraft:dirt")],
            spawnProtection: { radius: 1, spawn: { x: 0, z: -3 } },
            worldBorder: { size: 12 },
            unloadedChunks: [{ from: [-1, -1], to: [-1, 0] }],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("no ops, an op owner or obey_block_protection off: no spawn protection", async () => {
      const lua = `
ccunit.test("free", function()
  ccunit.eq({ turtle.forward() }, { true })
  ccunit.eq({ turtle.forward() }, { true })
end)
`;
      for (const extra of [
        { spawnProtection: { radius: 1, spawn: { x: 0, z: -2 }, ops: false } },
        {
          spawnProtection: { radius: 1, spawn: { x: 0, z: -2 }, ownerOp: true },
        },
        {
          spawnProtection: { radius: 1, spawn: { x: 0, z: -2 } },
          turtleConfig: { obeyBlockProtection: false },
        },
      ])
        expectAllPassed(await runLua(lua, turtleWorld({}, extra)));
    });

    it("computers get their ids when they first boot, disks from one counter", async () => {
      const r = await runLua(
        `
ccunit.test("placed computers have no id until they boot", function()
  turtle.select(1) turtle.place()          -- A at 0,64,-1
  turtle.turnRight() turtle.select(1) turtle.place() -- B at 1,64,0; A is on the left now
  ccunit.eq(peripheral.call("left", "getID"), -1)
  ccunit.eq(peripheral.call("front", "getID"), -1)
  ccunit.eq(peripheral.call("front", "isOn"), false)
  -- B first: it is the first computer the world numbers
  peripheral.call("front", "turnOn")
  ccunit.eq(waitFor(function() local id = peripheral.call("front", "getID") return id >= 0 and id end), 1)
  turtle.turnLeft()
  peripheral.call("front", "turnOn")
  ccunit.eq(waitFor(function() local id = peripheral.call("front", "getID") return id >= 0 and id end), 2)
end)
ccunit.test("blank floppies are numbered 0, 1 by the world", function()
  turtle.select(2)
  ccunit.eq({ turtle.dropUp(1) }, { true })
  ccunit.eq(disk.getID("top"), 0)
  ccunit.eq(turtle.getItemCount(2), 1)
  turtle.turnLeft()
  ccunit.eq({ turtle.drop(1) }, { true })
  ccunit.eq(disk.getID("front"), 1)
  ccunit.eq(disk.getID("bottom"), 7, "a numbered disk keeps its number")
end)
`,
        turtleWorld(
          {
            "1": { name: "computercraft:computer_normal", count: 2 },
            "2": { name: "computercraft:disk", count: 2 },
          },
          {
            blocks: [
              at(0, 65, 0, "computercraft:disk_drive"),
              at(-1, 64, 0, "computercraft:disk_drive"),
              at(0, 63, 0, "computercraft:disk_drive", {
                items: { "1": { name: "computercraft:disk", diskId: 7 } },
              }),
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("cables and wired modems a turtle places", async () => {
      const r = await runLua(
        `
ccunit.test("a modem goes on the block it is put against, a cable joins it", function()
  turtle.select(1)
  ccunit.eq({ turtle.place() }, { true })
  local _, b = turtle.inspect()
  ccunit.eq(b.name, "computercraft:cable")
  ccunit.eq(b.state.modem, "north_off", "stuck on the stone two ahead")
  ccunit.eq(b.state.cable, false)
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  _, b = turtle.inspect()
  ccunit.eq(b.state.modem, "north_off")
  ccunit.eq(b.state.cable, true)
  ccunit.eq(b.state.north, true, "the arm to its own modem")
  ccunit.eq(turtle.getItemCount(2), 3)
end)
ccunit.test("a cable on its own shows its arms", function()
  turtle.turnLeft()
  turtle.select(2)
  ccunit.eq({ turtle.place() }, { true })
  local _, b = turtle.inspect()
  ccunit.eq(b.state.modem, "none")
  ccunit.eq(b.state.cable, true)
  ccunit.eq(b.state.east, false)
end)
`,
        turtleWorld(
          {
            "1": { name: "computercraft:wired_modem", count: 1 },
            "2": { name: "computercraft:cable", count: 4 },
          },
          { blocks: [at(0, 64, -2, "minecraft:stone")] },
        ),
      );
      expectAllPassed(r);
    });

    it("a wired network a turtle builds carries messages", async () => {
      // B (id 5) east of the turtle, its modem on the cable above it; the turtle puts a full modem above itself
      const r = await runLua(
        `
ccunit.test("ping over the cable", function()
  turtle.select(1)
  ccunit.eq({ turtle.placeUp() }, { true })
  ccunit.eq(peripheral.getType("top"), "modem")
  local m = peripheral.wrap("top")
  ccunit.eq(m.isWireless(), false)
  peripheral.call("right", "turnOn")
  m.open(8)
  local got
  for _ = 1, 40 do
    m.transmit(7, 8, "ping")
    local timer = os.startTimer(0.5)
    while true do
      local ev = { os.pullEvent() }
      if ev[1] == "modem_message" then got = ev break end
      if ev[1] == "timer" and ev[2] == timer then break end
    end
    if got then break end
  end
  ccunit.truthy(got, "an answer")
  ccunit.eq({ got[2], got[3], got[4], got[5], got[6] }, { "top", 8, 7, "pong", 3 })
  ccunit.eq(waitFor(function() return peripheral.call("right", "getLabel") end), "ping:3")
end)
`,
        turtleWorld(
          { "1": { name: "computercraft:wired_modem_full", count: 1 } },
          {
            blocks: [
              at(1, 64, 0, "computercraft:computer_normal", {
                state: { facing: "north" },
                blockEntity: { ComputerId: 5 },
              }),
              at(1, 65, 0, "computercraft:cable", {
                state: { cable: "true", modem: "down_off" },
              }),
              at(2, 64, 0, "computercraft:disk_drive", {
                items: { "1": { name: "computercraft:disk", diskId: 4 } },
              }),
            ],
            disks: {
              "4": {
                "startup.lua": [
                  `local m = peripheral.find("modem")`,
                  `m.open(7)`,
                  `local _, _, ch, rep, msg, dist = os.pullEvent("modem_message")`,
                  `m.transmit(rep, 7, "pong")`,
                  `os.setComputerLabel(tostring(msg) .. ":" .. tostring(dist))`,
                ].join("\n"),
              },
            },
          },
        ),
      );
      expectAllPassed(r);
    });

    it("monitor walls form and split the way CC's are", async () => {
      const r = await runLua(
        `
local function stateAt(move, back)
  move()
  local _, b = turtle.inspect()
  back()
  return b and b.state.state
end
ccunit.test("a 3x2 wall, then the middle of its bottom row is dug", function()
  -- the wall is at z=-1 in front of a backing wall at z=-2; the turtle builds it from z=0
  turtle.select(1)
  local function left() turtle.turnLeft() turtle.forward() turtle.turnRight() end
  local function right() turtle.turnRight() turtle.forward() turtle.turnLeft() end
  left() turtle.place() right() turtle.place() right() turtle.place()
  turtle.up() turtle.place() left() turtle.place() left() turtle.place()
  -- at -1,65,0: every block is in the 3x2 wall
  ccunit.eq(select(2, turtle.inspect()).state.state, "rd")
  ccunit.eq({ peripheral.call("front", "getSize") }, { 29, 12 })
  turtle.down()
  right()
  ccunit.eq({ turtle.dig() }, { true })
  -- contractNeighbours: the bottom row left and right of it are 1x1, the top row stays one 3x1 wall
  ccunit.eq(stateAt(left, right), "none")
  ccunit.eq(stateAt(right, left), "none")
  turtle.up()
  ccunit.eq(select(2, turtle.inspect()).state.state, "lr")
  ccunit.eq({ peripheral.call("front", "getSize") }, { 29, 5 })
end)
`,
        turtleWorld(
          {
            "1": { name: "computercraft:monitor_advanced", count: 8 },
            "2": { name: "minecraft:diamond_pickaxe", count: 1 },
          },
          {
            turtle: {
              x: 0,
              y: 64,
              z: 0,
              facing: "north",
              fuel: 100,
              right: "minecraft:diamond_pickaxe",
              inventory: {
                "1": { name: "computercraft:monitor_advanced", count: 8 },
              },
            },
            fills: [
              { from: [-2, 64, -2], to: [2, 66, -2], name: "minecraft:stone" },
            ],
          },
        ),
      );
      expectAllPassed(r);
    });

    it("one wall is one screen for every computer on it; a normal monitor is grey", async () => {
      // monitors (normal) at 0,65,0 and 1,65,0 facing south: above the turtle and above computer 5 east of it.
      // Computer 5 boots from the disk and writes on the wall; the turtle writes too.
      put(
        "wall.lua",
        `
peripheral.call("right", "turnOn")
local deadline = os.clock() + 20
while os.clock() < deadline and peripheral.call("right", "getLabel") ~= "drawn" do sleep(0.1) end
local m = peripheral.wrap("top")
local w, h = m.getSize()
m.setCursorPos(1, 2)
m.write("turtle " .. w .. "x" .. h .. " " .. tostring(m.isColour()))
local r, g, b = m.getPaletteColour(colours.red)
m.setCursorPos(1, 3)
m.write(("%.2f %.2f %.2f"):format(r, g, b))
sleep(1.5)
`,
      );
      const { handle, network, host } = startInBlockWorld(
        config,
        `shell.run("wall.lua") os.shutdown(0)`,
        {
          world: turtleWorld(
            {},
            {
              blocks: [
                at(0, 65, 0, "computercraft:monitor_normal", {
                  state: { facing: "south" },
                }),
                at(1, 65, 0, "computercraft:monitor_normal", {
                  state: { facing: "south" },
                }),
                at(1, 64, 0, "computercraft:computer_normal", {
                  state: { facing: "south" },
                  blockEntity: { ComputerId: 5 },
                }),
                at(2, 64, 0, "computercraft:disk_drive", {
                  items: { "1": { name: "computercraft:disk", diskId: 3 } },
                }),
              ],
              disks: {
                "3": {
                  "startup.lua": [
                    `local m = peripheral.wrap("top")`,
                    `m.setBackgroundColour(colours.red)`,
                    `m.clear()`,
                    `m.setCursorPos(1, 1)`,
                    `m.write("from 5")`,
                    `os.setComputerLabel("drawn")`,
                    `sleep(1)`,
                  ].join("\n"),
                },
              },
            },
          ),
        },
      );
      try {
        await handle.session.waitForExit(60000);
        await new Promise((r) => setTimeout(r, 200));
        const monitorOf = (h: typeof handle) => {
          const w = h.session
            .allWindows()
            .filter((w) => w.peripheral === "top" && w.frame)
            .at(-1)!;
          const f = w.frame!;
          const lines: string[] = [];
          for (let y = 0; y < 3; y++)
            lines.push(
              Buffer.from(f.text.subarray(y * f.width, (y + 1) * f.width))
                .toString("latin1")
                .trimEnd(),
            );
          return { lines, palette: f.palette };
        };
        const mine = monitorOf(handle);
        expect(mine.lines).toEqual([
          "from 5",
          "turtle 18x5 false",
          "0.80 0.30 0.30",
        ]);
        // red on a normal monitor draws as the grey (r + g + b) / 3 = 118
        expect([...mine.palette.subarray(14 * 3, 14 * 3 + 3)]).toEqual([
          118, 118, 118,
        ]);
        const computer = host.computers().find((c) => c.id === 5)!;
        expect(computer).toBeDefined();
        expect(monitorOf(computer.handle).lines).toEqual(mine.lines);
      } finally {
        network.close();
        await host.dispose();
        handle.dispose();
      }
    });

    it("a turtle placed from an item boots and runs", async () => {
      const r = await runProgram(config, {
        program: "placeturtle.lua",
        world: turtleWorld(
          {
            "1": { name: "computercraft:turtle_normal", count: 1, fuel: 5 },
          },
          {
            blocks: [
              at(1, 64, -1, "computercraft:disk_drive", {
                items: { "1": { name: "computercraft:disk", diskId: 4 } },
              }),
            ],
            disks: {
              "4": {
                "startup.lua": `os.setComputerLabel("walker") turtle.forward() turtle.forward()`,
              },
            },
          },
        ),
        timeoutMs: 60000,
      }).catch((e: unknown) => {
        throw e;
      });
      expect(r.status, r.stderr).toBe("completed");
      expect(r.computers?.length).toBe(1);
      const placed = r.computers![0]!;
      expect(placed.id).toBe(1);
      expect(placed.pos).toBe("0,64,-3");
      expect(placed.sim?.turtle).toMatchObject({
        x: 0,
        y: 64,
        z: -3,
        facing: "north",
        fuel: 3,
      });
      expect(r.sim?.blocks?.["0,64,-1"]).toEqual({});
    });

    it("an interactive session hosts its block world", async () => {
      const ws = mkdtempSync(join(tmpdir(), "turtle-host-session-"));
      writeFileSync(
        join(ws, "startup.lua"),
        `turtle.select(1) turtle.place() peripheral.call("front", "turnOn")`,
      );
      const manager = new SessionManager({ ...config, workspaceDir: ws });
      try {
        const session = manager.create(
          [],
          1,
          turtleWorld({
            "1": { name: "computercraft:computer_advanced", count: 1 },
          }),
        );
        expect(session.blockWorld).toBeDefined();
        const deadline = Date.now() + 30000;
        while (
          Date.now() < deadline &&
          !session.blockWorld!.host.computers().some((c) => c.id === 1)
        )
          await new Promise((r) => setTimeout(r, 100));
        const computer = session
          .blockWorld!.host.computers()
          .find((c) => c.id === 1);
        expect(computer?.pos).toBe("0,64,-1");
        expect(computer?.handle.session.running).toBe(true);
      } finally {
        await manager.destroyAll();
        rmSync(ws, { recursive: true, force: true });
      }
    });
  },
);

put(
  "placeturtle.lua",
  `
turtle.select(1)
assert(turtle.place(), "placed")
peripheral.call("front", "turnOn")
local deadline = os.clock() + 20
while os.clock() < deadline and turtle.detect() do sleep(0.1) end
sleep(1)
`,
);
