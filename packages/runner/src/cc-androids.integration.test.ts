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
  type RunResult,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runProgram,
  runTests,
} from "./index.js";
import { ADDONS, addonsFor } from "./addons.js";
import { mobComputer } from "./mobs.js";

/**
 * CC: Androids 1.3.0 (Minecraft 1.20.1), checked against behaviour read from the mod's source
 * (ThunderBear2006/CC-Androids commit a804326). docs/cc-androids.md has the source for every rule.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "androids-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

function example(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(
        `../../../workspace/examples/cc-androids/${name}`,
        import.meta.url,
      ),
    ),
    "utf8",
  );
}

function exampleWorld(name: string): WorldConfig {
  return JSON.parse(example(name)) as WorldConfig;
}

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
  timeScale = 1,
): Promise<TestRunResult> {
  put(name, source);
  return runTests(
    config,
    { paths: [name], world, timeoutMs: 120000, timeScale },
    1,
  );
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

interface AndroidState {
  type: string;
  x: number;
  y: number;
  z: number;
  fuel: number;
  health: number;
  face: string;
  task: string;
  main?: { name: string; count: number; damage?: number };
  off?: { name: string; count: number };
  slots: Record<string, { name: string; count: number }>;
  interactions: Record<string, unknown>[];
  chat: { name: string; message: string }[];
}

interface AddonState {
  android: AndroidState;
  entities: {
    uuid: string;
    type: string;
    x: number;
    health?: number;
    leashedTo?: string;
    interactions?: number;
  }[];
}

function stateOf(result: RunResult): AddonState {
  const addons = (result.sim as { addons?: Record<string, unknown> }).addons;
  return addons!["cc-androids"] as AddonState;
}

/** The terminal's lines, without the blanks on the right. */
function linesOf(result: RunResult): string[] {
  return (result.screens[0]?.lines ?? []).map((l) => l.trimEnd());
}

const GROUND = {
  y: 63,
  name: "minecraft:stone",
  top: "minecraft:grass_block",
};

/** An android on flat ground at 0,64,0 with fuel, and the player out of the way. */
const world = (
  android: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["cc-androids"],
    simProgram: true,
    players: [{ name: "Steve", x: 60.5, y: 64, z: 60.5 }],
    android: { x: 0, y: 64, z: 0, fuel: 500, ...android },
    ground: GROUND,
    ...extra,
  }) as WorldConfig;

/** out(...) writes its values on one line from the top of a cleared screen; sim() sends a sim command. */
const PRELUDE = `term.clear() term.setCursorPos(1, 1)
local function out(...)
  local t = table.pack(...)
  for i = 1, t.n do t[i] = tostring(t[i]) end
  print(table.concat(t, " "))
end
local function waitIdle()
  local started = os.clock()
  while android.currentTask() ~= "idle" and os.clock() - started < 60 do sleep(0.1) end
end
local simCount = 0
local function sim(command)
  simCount = simCount + 1
  local token = ("sim:%d:%.0f"):format(simCount, os.epoch("utc"))
  os.queueEvent("ccsim_cmd", token, textutils.serializeJSON(command))
  while true do
    local _, got, ok, message = os.pullEvent("ccsim_reply")
    if got == token then
      if message == nil then return ok end
      return ok, message
    end
  end
end
`;

async function run(
  source: string,
  w: WorldConfig,
  name: string,
): Promise<RunResult> {
  put(name, PRELUDE + source);
  const result = await runProgram(config, {
    program: name,
    world: w,
    timeoutMs: 120000,
  });
  expect(result.status).toBe("completed");
  return result;
}

describe("the addon (no engine)", () => {
  it("is registered for 1.20.1 only", () => {
    const addon = ADDONS.find((a) => a.id === "cc-androids")!;
    expect(addon.versions).toEqual({ "1.20.1": "1.3.0" });
    expect(addon.worldKeys).toContain("android");
    expect(addonsFor("1.20.1").map((a) => a.id)).toContain("cc-androids");
    expect(addonsFor("1.18.2").map((a) => a.id)).not.toContain("cc-androids");
    expect(addonsFor("1.21.1").map((a) => a.id)).not.toContain("cc-androids");
  });

  it("its computer has the turtle's screen, and colour unless it is a normal android", () => {
    expect(mobComputer({ android: { x: 0 } })).toEqual({
      key: "android",
      width: 39,
      height: 13,
      colour: false,
    });
    expect(mobComputer({ android: { type: "advanced" } })?.colour).toBe(true);
    expect(mobComputer({ android: { type: "command" } })?.colour).toBe(true);
    // a turtle stays a turtle
    expect(mobComputer({ android: {}, turtle: {} })).toBeUndefined();
  });
});

describe.skipIf(!ready)("the examples", () => {
  it("android_api.test.lua: every function, as 1.3.0 has it", async () => {
    const result = await lua(
      example("android_api.test.lua"),
      exampleWorld("android_api.world.json"),
      "android_api.test.lua",
    );
    expectAllPassed(result);
    expect(result.files[0]!.tests.length).toBe(16);
  }, 180000);

  it("courier.lua carries both stacks to the other chest", async () => {
    put("examples/cc-androids/courier.lua", example("courier.lua"));
    const result = await lua(
      example("courier.test.lua"),
      exampleWorld("courier.world.json"),
      "courier.test.lua",
      4,
    );
    expectAllPassed(result);
  }, 180000);
});

describe.skipIf(!ready)("the three androids (EntityRegistry, config)", () => {
  it("an advanced android has colour, sees three times as far and walks faster", async () => {
    const far = {
      entities: [
        { type: "minecraft:cow", uuid: "0-0-0-0-1", x: 25.5, y: 64, z: 0.5 },
      ],
    };
    const program = `out(term.isColour(), #android.getNearbyMobs("cow"))
android.moveTo(0, 64, 12)
sleep(1)
android.cancelTask()
out(android.getSelf().posZ)`;
    const normal = await run(program, world({}, far), "normal.lua");
    const advanced = await run(
      program,
      world({ type: "advanced" }, far),
      "advanced.lua",
    );
    expect(linesOf(normal)[0]).toBe("false 0");
    expect(linesOf(advanced)[0]).toBe("true 1");
    // (0.5 x speed)^2 x 0.98 / 0.454 blocks a tick: 0.19 at speed 0.6, 0.44 at 0.9
    const walked = (r: RunResult) => Number(linesOf(r)[1]) - 0.5;
    expect(walked(normal)).toBeGreaterThan(3);
    expect(walked(normal)).toBeLessThan(4.6);
    expect(walked(advanced)).toBeGreaterThan(7.5);
    expect(walked(advanced)).toBeLessThan(10);
    expect(stateOf(advanced).android.type).toBe("advanced");
  }, 120000);

  it("a command android needs no fuel; the others do", async () => {
    const program = `out(android.fuelLevel(), pcall(android.moveTo, 0, 64, 3))
waitIdle()
out(math.floor(android.getSelf().posZ))`;
    const command = await run(
      program,
      world({ type: "command", fuel: 0 }),
      "command.lua",
    );
    expect(linesOf(command).slice(0, 2)).toEqual(["0 true", "2"]);
    const normal = await run(program, world({ fuel: 0 }), "nofuel.lua");
    expect(linesOf(normal).slice(0, 2)).toEqual([
      "0 false Android requires fuel.",
      "0",
    ]);
  }, 120000);

  it("refuses a world on a Minecraft version the mod does not have", async () => {
    put("nothing.lua", "print('x')");
    await expect(
      runProgram(config, {
        program: "nothing.lua",
        world: { ...world(), version: "1.18.2" } as WorldConfig,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow(/cc-androids/);
    await expect(
      runProgram(config, {
        program: "nothing.lua",
        world: { ...world(), addons: [] } as WorldConfig,
        timeoutMs: 30000,
      }),
    ).rejects.toThrow(/cc-androids/);
  }, 60000);
});

describe.skipIf(!ready)(
  "the sides (BaseAndroidEntity.updatePeripherals)",
  () => {
    const chest = (x: number, y: number, z: number) => ({
      x,
      y,
      z,
      name: "minecraft:chest",
    });
    const around = {
      blocks: [
        chest(0, 64, 1), // south
        chest(0, 64, -1), // north
        chest(1, 64, 0), // east
        chest(-1, 64, 0), // west
        chest(0, 63, 0), // below
        chest(0, 66, 0), // above its head
      ],
    };

    it("the sides are fixed to the compass and there is never a top", async () => {
      const result = await run(
        `local names = peripheral.getNames() table.sort(names)
out(table.concat(names, ","))
out(peripheral.getType("front"), peripheral.call("front", "size"))`,
        world({}, around),
        "sides.lua",
      );
      expect(linesOf(result).slice(0, 2)).toEqual([
        "back,bottom,front,left,right",
        "minecraft:chest 27",
      ]);
    }, 60000);

    it("a pocket upgrade in a hand takes that side: main hand right, off hand left", async () => {
      const result = await run(
        `out(peripheral.getType("right"), peripheral.getType("left"))
android.swapHands()
out(peripheral.getType("right"), peripheral.getType("left"))
sim({ cmd = "androidSetHand", hand = "main", item = "computercraft:speaker" })
out(peripheral.getType("right"), peripheral.getType("left"))`,
        world(
          {
            hands: {
              main: { name: "computercraft:wireless_modem_normal", count: 1 },
            },
          },
          around,
        ),
        "hands.lua",
      );
      expect(linesOf(result).slice(0, 3)).toEqual([
        "modem minecraft:chest inventory",
        "minecraft:chest modem",
        "speaker modem",
      ]);
    }, 60000);

    it("what it walks up to is a peripheral once it has stood idle for a second", async () => {
      const result = await run(
        `out(#peripheral.getNames())
android.moveTo(0, 64, 5)
waitIdle()
sleep(1.2)
out(peripheral.getType("front"))`,
        world({}, { blocks: [chest(0, 64, 5)] }),
        "walkup.lua",
      );
      expect(linesOf(result).slice(0, 2)).toEqual([
        "0",
        "minecraft:chest inventory",
      ]);
      // it stopped within two blocks, and the chest is right in front of it (south)
      expect(Math.floor(stateOf(result).android.z)).toBe(4);
    }, 60000);
  },
);

describe.skipIf(!ready)("tasks", () => {
  it("breaking a block: the tool decides how long it takes, what drops and wears", async () => {
    const stone = { blocks: [{ x: 0, y: 64, z: 2, name: "minecraft:stone" }] };
    const program = `local started = os.clock()
android.breakBlock(0, 64, 2)
waitIdle()
out(math.floor((os.clock() - started) * 20 + 0.5))`;
    const hand = await run(program, world({}, stone), "hand.lua");
    const pick = await run(
      program,
      world(
        { hands: { main: { name: "minecraft:iron_pickaxe", count: 1 } } },
        stone,
      ),
      "pick.lua",
    );
    // progress a tick is (speed / 5) / hardness / (30 with the right tool, else 100) x 100, done at 10:
    // by hand 0.2 / 1.5 / 100 x 100 = 0.133, 75 ticks; an iron pickaxe 1.2 / 1.5 / 30 x 100 = 2.67, 4 ticks
    const ticks = (r: RunResult) => Number(linesOf(r)[0]);
    expect(ticks(hand)).toBeGreaterThanOrEqual(75);
    expect(ticks(hand)).toBeLessThan(82);
    expect(ticks(pick)).toBeGreaterThanOrEqual(4);
    expect(ticks(pick)).toBeLessThan(10);
    expect(hand.sim!.blocks!["0,64,2"]).toEqual({});
    expect(hand.sim!.droppedItems ?? []).toEqual([]);
    expect(pick.sim!.droppedItems).toEqual([
      expect.objectContaining({
        x: 0,
        y: 64,
        z: 2,
        name: "minecraft:cobblestone",
        count: 1,
      }),
    ]);
    expect(stateOf(pick).android.main).toMatchObject({
      name: "minecraft:iron_pickaxe",
      damage: 1,
    });
  }, 120000);

  it("a weapon in the hand adds its damage; bedrock is not a task", async () => {
    const zombie = {
      entities: [
        {
          type: "minecraft:zombie",
          uuid: "0-0-0-0-2",
          x: 0.5,
          y: 64,
          z: 1.5,
          health: 20,
        },
      ],
      blocks: [{ x: 3, y: 64, z: 0, name: "minecraft:bedrock" }],
    };
    const result = await run(
      `android.breakBlock(3, 64, 0)
sleep(0.2)
out(android.currentTask())
android.attack("0-0-0-0-2")
sleep(0.3)
android.cancelTask()
out(android.getNearbyMobs("zombie")[1].health)`,
      world(
        { hands: { main: { name: "minecraft:diamond_sword", count: 1 } } },
        zombie,
      ),
      "sword.lua",
    );
    // the bedrock task ended on its first tick; one hit of 1 + 6 landed
    expect(linesOf(result).slice(0, 2)).toEqual(["idle", "13"]);
  }, 60000);

  it("walks through a wooden door, and uses a lever", async () => {
    const result = await run(
      `android.moveTo(0, 64, 6)
waitIdle()
out(android.getSelf().posZ > 4)
android.useBlock(1, 64, 6)
waitIdle()`,
      world(
        {},
        {
          fills: [
            { from: [-4, 64, 3], to: [4, 66, 3], name: "minecraft:oak_planks" },
          ],
          blocks: [
            {
              x: 0,
              y: 64,
              z: 3,
              name: "minecraft:oak_door",
              state: { half: "lower" },
            },
            {
              x: 0,
              y: 65,
              z: 3,
              name: "minecraft:oak_door",
              state: { half: "upper" },
            },
            { x: 1, y: 64, z: 6, name: "minecraft:lever" },
          ],
        },
      ),
      "door.lua",
    );
    expect(linesOf(result)[0]).toBe("true");
    expect(result.sim!.blocks!["1,64,6"]!.state).toMatchObject({
      powered: "true",
    });
    expect(stateOf(result).android.interactions).toEqual([
      expect.objectContaining({ name: "minecraft:lever" }),
    ]);
  }, 60000);

  it("useEntity: a lead leashes a mob, an empty hand lets it go", async () => {
    const result = await run(
      `android.useEntity("0-0-0-0-3")
waitIdle()
out(android.getHandInfo("main"))
android.useEntity("0-0-0-0-3")
waitIdle()
out(select("#", android.pickup("lead")))`,
      world(
        { hands: { main: { name: "minecraft:lead", count: 1 } } },
        {
          entities: [
            {
              type: "minecraft:cow",
              uuid: "0-0-0-0-3",
              x: 2.5,
              y: 64,
              z: 0.5,
            },
          ],
        },
      ),
      "lead.lua",
    );
    expect(linesOf(result).slice(0, 2)).toEqual(["Air 0", "0"]);
    expect(stateOf(result).android.main).toMatchObject({
      name: "minecraft:lead",
    });
  }, 60000);
});

describe.skipIf(!ready)("sim commands", () => {
  it("change the android and the world around it while it runs", async () => {
    const result = await run(
      // the android's screen has 13 lines: one line a command
      `out(sim({ cmd = "androidSetHand", item = { name = "minecraft:redstone_block", count = 2 } }), android.getHandInfo("main"))
out(android.refuel())
out(sim({ cmd = "androidSetSlot", slot = 4, item = "minecraft:stick" }), android.getSlotInfo(4))
out(sim({ cmd = "androidSetFuel", fuel = 7 }), android.fuelLevel())
out(sim({ cmd = "androidSetHealth", health = 3 }), android.getSelf().health)
out(sim({ cmd = "androidTeleport", x = 10, y = 64, z = 10 }), android.getSelf().posX)
out(sim({ cmd = "mobSpawn", type = "minecraft:sheep", x = 12.5, y = 64, z = 10.5, uuid = "0-0-0-0-9" }), android.getClosestMob("sheep").name)
out(sim({ cmd = "mobMove", uuid = "0-0-0-0-9", x = 13.5, y = 64, z = 10.5 }), android.getClosestMob("sheep").posX)
out(sim({ cmd = "mobRemove", uuid = "0-0-0-0-9" }), next(android.getClosestMob("sheep")))
out(sim({ cmd = "mobDropItem", x = 10, y = 64, z = 11, name = "minecraft:emerald", count = 2 }), select("#", android.pickup("emerald")), android.getHandInfo("main"))
out(sim({ cmd = "mobSetBlock", x = 11, y = 64, z = 10, name = "minecraft:chest", items = { ["1"] = { name = "minecraft:coal", count = 3 } } }), android.getContainerInfo(11, 64, 10).slots[1][2])
out(sim({ cmd = "mobSetBlock", x = 11, y = 64, z = 10 }), #android.getBlocksOfType("chest"))
write(table.concat({ tostring(sim({ cmd = "androidSetSlot", slot = 9, item = "minecraft:stick" })) }, " "))`,
      world({ fuel: 0 }),
      "commands.lua",
    );
    expect(linesOf(result).slice(0, 13)).toEqual([
      "true Block of Redstone 2",
      "false Fuel level increased to 160",
      "true false Stick",
      "true 7",
      "true 3",
      "true 10.5",
      "true Sheep",
      "true 13.5",
      "true nil",
      "true 0 Emerald 2",
      "true 3",
      "true 0",
      "false",
    ]);
  }, 60000);
});
