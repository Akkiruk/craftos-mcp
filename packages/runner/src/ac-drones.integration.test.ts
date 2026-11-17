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
 * AC-Drones alpha 7 (1.20.1), checked against behaviour read from the mod's source (ApioCraft/ac-drones commit
 * a73fcdd) and the release jar. docs/ac-drones.md has the source for every rule.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "acdrones-ws-"));
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
      new URL(`../../../workspace/examples/ac-drones/${name}`, import.meta.url),
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
): Promise<TestRunResult> {
  put(name, source);
  return runTests(config, { paths: [name], world, timeoutMs: 120000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

interface DroneState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  velocity: { x: number; y: number; z: number };
  selected: number;
  slots: Record<string, { name: string; count: number }>;
  accessory?: string;
  carrying?: { name: string; items?: Record<string, { name: string }> };
  attachments: Record<string, string>;
  sides: Record<string, string>;
  falling?: { name: string }[];
}

function droneOf(result: RunResult): DroneState {
  const addons = (result.sim as { addons?: Record<string, unknown> }).addons;
  return (addons!["ac-drones"] as { drone: DroneState }).drone;
}

/** The terminal's lines, without the blanks on the right. */
function linesOf(result: RunResult): string[] {
  return (result.screens[0]?.lines ?? []).map((l) => l.trimEnd());
}

function textOf(result: RunResult): string {
  return linesOf(result).join("\n");
}

const GROUND = {
  y: 63,
  name: "minecraft:stone",
  top: "minecraft:grass_block",
};

/** A drone resting on flat ground at 0,64,0, with the player out of the way. */
const world = (
  drone: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["ac-drones"],
    players: [{ name: "Steve", x: 30.5, y: 64, z: 30.5 }],
    acDrone: { x: 0, y: 64, z: 0, ...drone },
    ground: GROUND,
    ...extra,
  }) as WorldConfig;

/** out(...) writes its values on one line from the top of a cleared screen, so the line numbers are the program's. */
const PRELUDE = `term.clear() term.setCursorPos(1, 1)
local function out(...)
  local t = table.pack(...)
  for i = 1, t.n do t[i] = tostring(t[i]) end
  print(table.concat(t, " "))
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
    const addon = ADDONS.find((a) => a.id === "ac-drones")!;
    expect(addon.versions).toEqual({ "1.20.1": "1.20.1-alpha-7" });
    expect(addon.worldKeys).toEqual(["acDrone"]);
    expect(addonsFor("1.20.1").map((a) => a.id)).toContain("ac-drones");
    expect(addonsFor("1.18.2").map((a) => a.id)).not.toContain("ac-drones");
    expect(addonsFor("1.21.1").map((a) => a.id)).not.toContain("ac-drones");
  });

  it("its computer is an advanced one with the turtle's screen", () => {
    expect(mobComputer({ acDrone: { x: 0, y: 64, z: 0 } })).toEqual({
      key: "acDrone",
      width: 39,
      height: 13,
      colour: true,
    });
  });
});

describe.skipIf(!ready)("the examples", () => {
  it("drone_api.test.lua: every function, as alpha 7 has it", async () => {
    const result = await lua(
      example("drone_api.test.lua"),
      exampleWorld("drone_api.world.json"),
      "drone_api.test.lua",
    );
    expectAllPassed(result);
    expect(result.files[0]!.tests.length).toBe(14);
  }, 180000);

  it("drone_place.test.lua: place() after the fix, and suck() without a quantity", async () => {
    const result = await lua(
      example("drone_place.test.lua"),
      exampleWorld("drone_place.world.json"),
      "drone_place.test.lua",
    );
    expectAllPassed(result);
    expect(result.files[0]!.tests.length).toBe(3);
  }, 180000);

  it("chest_courier.lua carries the chest and takes eight ingots", async () => {
    const result = await run(
      example("chest_courier.lua"),
      exampleWorld("chest_courier.world.json"),
      "chest_courier.lua",
    );
    expect(textOf(result)).toContain("Done: 8 x Iron Ingot");
    const blocks = result.sim!.blocks!;
    expect(blocks["3,64,0"]).toEqual({});
    expect(blocks["3,64,4"]!.name).toBe("minecraft:chest");
    expect(blocks["3,64,4"]!.items).toEqual({
      "1": expect.objectContaining({ name: "minecraft:iron_ingot", count: 4 }),
      "2": expect.objectContaining({ name: "minecraft:bread", count: 5 }),
    });
    const drone = droneOf(result);
    expect(drone.slots).toEqual({
      "1": expect.objectContaining({ name: "minecraft:iron_ingot", count: 8 }),
    });
    // it stands on the chest's lid
    expect(drone.y).toBe(65);
    expect(Math.floor(drone.x)).toBe(3);
    expect(Math.floor(drone.z)).toBe(4);
    expect(drone.sides).toEqual({ top: "modem", bottom: "claw" });
  }, 180000);
});

describe.skipIf(!ready)(
  "flying (DroneMoveCommand and the entity's tick)",
  () => {
    it("stops within a tenth of a block, short of where it was sent", async () => {
      const result = await run(
        `local ok = drone.move(3, 0, 0)
       out(ok)
       sleep(0.5)`,
        world(),
        "move_east.lua",
      );
      expect(textOf(result)).toContain("true");
      const drone = droneOf(result);
      expect(drone.x).toBeGreaterThan(3.4);
      expect(drone.x).toBeLessThan(3.5);
      expect(drone.y).toBe(64);
      expect(drone.z).toBe(0.5);
      // the command stops the drone dead when it is done
      expect(drone.velocity).toEqual({ x: 0, y: 0, z: 0 });
      // east: atan2(-vx, vz) is -90, approached a quarter of the way each tick
      expect(drone.yaw).toBeGreaterThan(-90.001);
      expect(drone.yaw).toBeLessThan(-89.9);
    }, 180000);

    it("gives up after 100 ticks on a long way, and drifts on", async () => {
      const result = await run(
        `local started = os.clock()
       local ok, why = drone.move(40, 0, 0)
       out(ok, why)
       out(("ticks %d"):format(math.floor((os.clock() - started) * 20 + 0.5)))
       sleep(3)`,
        world(),
        "move_far.lua",
      );
      expect(textOf(result)).toContain("false");
      expect(textOf(result)).toContain("Movement took too long");
      // 100 updates, the first in the tick that takes the command, and the answer one tick later
      expect(textOf(result)).toMatch(/ticks 10[1-3]/);
      const drone = droneOf(result);
      // 24 ticks to reach a quarter block a tick, then that speed to the 100th tick: about 22 blocks; the last
      // velocity is left on it and the drag (0.9 a tick) lets it coast ten times that, 2.5 blocks more
      expect(drone.x).toBeGreaterThan(24);
      expect(drone.x).toBeLessThan(26);
      expect(Math.abs(drone.velocity.x)).toBeLessThan(0.001);
    }, 180000);

    it("slides along a wall, and lands on the ground", async () => {
      const result = await run(
        `-- a wall across the way east, from z -2 to z 6
       out(drone.move(4, 0, 3))
       out(drone.move(0, 2, 0))
       out(drone.move(0, -5, 0))`,
        world(
          {},
          {
            fills: [
              { from: [3, 64, -2], to: [3, 66, 6], name: "minecraft:stone" },
            ],
          },
        ),
        "move_wall.lua",
      );
      const lines = linesOf(result);
      // x is stopped by the wall at 3 (the drone is 0.75 wide), z goes on until what is left is x alone
      expect(lines[0]).toBe("false Movement took too long");
      expect(lines[1]).toBe("true");
      expect(lines[2]).toBe("false Movement took too long");
      const drone = droneOf(result);
      expect(drone.x).toBeCloseTo(2.625, 6);
      expect(drone.z).toBeGreaterThan(3.3);
      expect(drone.y).toBe(64);
    }, 180000);

    it("a move starts from where the drone is when its turn comes", async () => {
      const result = await run(
        `local results = {}
       parallel.waitForAll(
         function() results[1] = { drone.move(2, 0, 0) } end,
         function() results[2] = { drone.move(0, 0, 2) } end,
         function() results[3] = { drone.select(3) } end
       )
       out(results[1][1], results[2][1], results[3][1])`,
        world(),
        "move_queue.lua",
      );
      expect(textOf(result)).toContain("true true true");
      const drone = droneOf(result);
      expect(drone.x).toBeGreaterThan(2.4);
      expect(drone.x).toBeLessThan(2.5);
      expect(drone.z).toBeGreaterThan(2.4);
      expect(drone.z).toBeLessThan(2.5);
      expect(drone.selected).toBe(3);
    }, 180000);
  },
);

describe.skipIf(!ready)("the claw", () => {
  it("starts with the block the world gives it, and a block that cannot land breaks", async () => {
    const result = await run(
      `local claw = peripheral.wrap("bottom")
       out(claw.grab())
       out(claw.drop())
       sleep(1)
       out(claw.drop())`,
      world(
        {
          y: 66,
          accessory: "claw",
          carrying: {
            name: "minecraft:barrel",
            items: { "1": { name: "minecraft:apple", count: 2 } },
          },
        },
        { blocks: [{ x: 0, y: 64, z: 0, name: "minecraft:torch" }] },
      ),
      "claw_break.lua",
    );
    const lines = linesOf(result);
    expect(lines[0]).toBe("nil no block to grab");
    expect(lines[1]).toBe("true");
    expect(lines[2]).toBe("nil claw is empty");
    // the barrel came down on the torch: it lies there as an item, and the apples are gone
    expect(result.sim!.droppedItems).toEqual([
      expect.objectContaining({ x: 0, y: 64, z: 0, name: "minecraft:barrel" }),
    ]);
    expect(droneOf(result).carrying).toBeUndefined();
  }, 180000);

  it("keeps what is in the block it carries", async () => {
    const result = await run(
      `local claw = peripheral.wrap("bottom")
       out(claw.grab())`,
      world(
        { accessory: "claw" },
        {
          blocks: [
            {
              x: 0,
              y: 63,
              z: 0,
              name: "minecraft:barrel",
              items: { "3": { name: "minecraft:apple", count: 2 } },
            },
          ],
        },
      ),
      "claw_carry.lua",
    );
    expect(textOf(result)).toContain("true");
    expect(result.sim!.blocks!["0,63,0"]).toEqual({});
    const carrying = droneOf(result).carrying!;
    expect(carrying.name).toBe("minecraft:barrel");
    expect(carrying.items!["3"]!.name).toBe("minecraft:apple");
  }, 180000);

  it("a drone without accessories has no peripherals", async () => {
    const result = await run(
      `out(#peripheral.getNames())`,
      world(),
      "bare.lua",
    );
    expect(linesOf(result)[0]).toBe("0");
  }, 180000);
});

describe.skipIf(!ready)("the modem", () => {
  it("an advanced modem in a drone is a plain wireless one, on the back when it is the second attachment", async () => {
    const result = await lua(
      `ccunit.test("modem", function()
         ccunit.eq(peripheral.getType("top"), "chunkloader")
         ccunit.eq(peripheral.getType("back"), "modem")
         local modem = peripheral.wrap("back")
         ccunit.eq(modem.isWireless(), true)
         modem.open(7)
         ccunit.eq(modem.isOpen(7), true)
         rednet.open("back")
         ccunit.eq(rednet.isOpen("back"), true)
       end)`,
      world({ attachments: ["chunkloader", "advanced_modem"] }),
      "modem.test.lua",
    );
    expectAllPassed(result);
  }, 180000);
});

describe.skipIf(!ready)("worlds that cannot have a drone", () => {
  it("the addon switched off", async () => {
    put("off.lua", "print('never')");
    await expect(
      runProgram(config, {
        program: "off.lua",
        world: { ...world(), addons: "none" },
        timeoutMs: 20000,
      }),
    ).rejects.toThrow(/ac-drones/);
  }, 60000);

  it("Minecraft 1.18.2 and 1.21.1, where the mod has no release that loads", async () => {
    put("off.lua", "print('never')");
    for (const version of ["1.18.2", "1.21.1"]) {
      await expect(
        runProgram(config, {
          program: "off.lua",
          world: { ...world(), version } as WorldConfig,
          timeoutMs: 20000,
        }),
        version,
      ).rejects.toThrow(/ac-drones/);
    }
  }, 60000);

  it("an accessory the mod does not have", async () => {
    put("bad.lua", "print(drone)");
    const result = await runProgram(config, {
      program: "bad.lua",
      world: world({ attachments: ["speaker"] }),
      timeoutMs: 20000,
    });
    // the simulation says why it did not start, and the computer is a plain one
    expect(textOf(result)).toContain("ccsim failed to start");
    expect(textOf(result)).toContain("world.acDrone.attachments: speaker");
    expect(linesOf(result)).toContain("nil");
  }, 60000);
});
