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
import { ADDONS, addonsFor, checkWorldAddons } from "./addons.js";
import { mobComputer } from "./mobs.js";

/**
 * CC: Drones 0.0.1 (JSJBDEV/CCDrones commit 5c8f4ed) and its fork CC: Drones+ 0.2.0 (minecraftbossdj/CCDrones commit
 * c85ef36), both for Minecraft 1.20.1, checked against behaviour read from each mod's source. docs/cc-drones.md has
 * the source for every rule.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ccdrones-ws-"));
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
      new URL(`../../../workspace/examples/cc-drones/${name}`, import.meta.url),
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

interface DroneState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  engineOn: boolean;
  hover: boolean;
  onGround: boolean;
  colliding: boolean;
  upgrades?: string[];
  carrying?: { name: string; items?: Record<string, { name: string }> };
  passenger?: string;
}

interface AddonState {
  drone: DroneState;
  entities: { uuid: string; type: string; x: number; y: number; z: number }[];
  exports?: { drone: number; path: string; program: string }[];
  apiGiven?: boolean;
}

function stateOf(result: RunResult, addon = "cc-drones"): AddonState {
  const addons = (result.sim as { addons?: Record<string, unknown> }).addons;
  return addons![addon] as AddonState;
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
const PIG = "11111111-2222-3333-4444-555555555555";

/** A CC: Drones drone in the air over flat ground, with the player out of the way. */
const world = (
  drone: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["cc-drones"],
    simProgram: true,
    players: [{ name: "Steve", x: 60.5, y: 64, z: 60.5 }],
    drone: { x: 0, y: 70, z: 0, ...drone },
    ground: GROUND,
    ...extra,
  }) as WorldConfig;

/** The same for CC: Drones+. */
const plusWorld = (
  drone: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["cc-drones-plus"],
    simProgram: true,
    players: [{ name: "Steve", x: 60.5, y: 64, z: 60.5 }],
    dronePlus: { x: 0, y: 70, z: 0, ...drone },
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

describe("the addons (no engine)", () => {
  it("are registered for 1.20.1 only", () => {
    const original = ADDONS.find((a) => a.id === "cc-drones")!;
    const plus = ADDONS.find((a) => a.id === "cc-drones-plus")!;
    expect(original.versions).toEqual({ "1.20.1": "0.0.1" });
    expect(plus.versions).toEqual({ "1.20.1": "0.2.0" });
    expect(original.worldKeys).toEqual(["drone"]);
    expect(plus.worldKeys).toEqual(["dronePlus"]);
    const on1201 = addonsFor("1.20.1").map((a) => a.id);
    expect(on1201).toContain("cc-drones");
    expect(on1201).toContain("cc-drones-plus");
    expect(addonsFor("1.18.2").map((a) => a.id)).not.toContain("cc-drones");
    expect(addonsFor("1.21.1").map((a) => a.id)).not.toContain(
      "cc-drones-plus",
    );
  });

  it("the original's computer is a normal one, the fork's an advanced one", () => {
    expect(mobComputer({ drone: {} })).toEqual({
      key: "drone",
      width: 51,
      height: 19,
      colour: false,
    });
    expect(mobComputer({ dronePlus: {} })).toEqual({
      key: "dronePlus",
      width: 51,
      height: 19,
      colour: true,
    });
  });

  it("the drone workbench belongs to both: either addon will do", () => {
    const bench = { peripherals: [{ name: "left", type: "droneworkbench" }] };
    expect(() =>
      checkWorldAddons(bench, ["cc-drones"], "1.20.1"),
    ).not.toThrow();
    expect(() =>
      checkWorldAddons(bench, ["cc-drones-plus"], "1.20.1"),
    ).not.toThrow();
    expect(() => checkWorldAddons(bench, ["create"], "1.20.1")).toThrow(
      /droneworkbench from CC: Drones \(addon "cc-drones"\), which is switched off/,
    );
    expect(() => checkWorldAddons(bench, [], "1.18.2")).toThrow(
      /no release for Minecraft 1\.18\.2/,
    );
  });
});

describe.skipIf(!ready)("the examples", () => {
  it("drone_api.test.lua: every function of CC: Drones 0.0.1", async () => {
    const result = await lua(
      example("drone_api.test.lua"),
      exampleWorld("drone_api.world.json"),
      "drone_api.test.lua",
    );
    expectAllPassed(result);
    expect(result.files[0]!.tests.length).toBe(9);
  }, 180000);

  it("drone_plus_api.test.lua: every function of CC: Drones+ 0.2.0", async () => {
    const result = await lua(
      example("drone_plus_api.test.lua"),
      exampleWorld("drone_plus_api.world.json"),
      "drone_plus_api.test.lua",
    );
    expectAllPassed(result);
    expect(result.files[0]!.tests.length).toBe(7);
  }, 180000);

  it("workbench.test.lua: the drone workbench", async () => {
    const result = await lua(
      example("workbench.test.lua"),
      exampleWorld("workbench.world.json"),
      "workbench.test.lua",
    );
    expectAllPassed(result);
    expect(result.files[0]!.tests.length).toBe(4);
  }, 180000);

  it("tunnel.lua breaks three blocks and stops before the glass, on both mods", async () => {
    put("examples/cc-drones/tunnel.lua", example("tunnel.lua"));
    const original = await lua(
      example("tunnel.test.lua"),
      exampleWorld("tunnel.world.json"),
      "tunnel.test.lua",
      2,
    );
    expectAllPassed(original);
    const w = exampleWorld("tunnel.world.json") as Record<string, unknown>;
    const { drone, ...rest } = w;
    const plus = await lua(
      example("tunnel.test.lua"),
      {
        ...rest,
        addons: ["cc-drones-plus"],
        dronePlus: { ...(drone as object), upgrades: ["mine"] },
      } as WorldConfig,
      "tunnel_plus.test.lua",
      2,
    );
    expectAllPassed(plus);
  }, 180000);
});

describe.skipIf(!ready)(
  "flying (LivingEntity.travel and DroneEntity.tick)",
  () => {
    it("falls under gravity and lands; hovering it stays", async () => {
      const fell = await run(`sleep(3)`, world(), "fall.lua");
      expect(stateOf(fell).drone).toMatchObject({
        x: 0.5,
        y: 64,
        z: 0.5,
        onGround: true,
      });
      // the world's clock runs while the computer boots: a drone that starts in the air falls until the program
      // gets going, longer on a busy host. So it starts hovering, and the program turns hover off and on again at
      // once (no tick between): it only stays up if hoverOn(true) holds it.
      const hovered = await run(
        `drone.hoverOn(false) drone.hoverOn(true) sleep(3)`,
        world({ hover: true }),
        "hover.lua",
      );
      expect(stateOf(hovered).drone).toMatchObject({
        y: 70,
        hover: true,
        onGround: false,
      });
      // a world can start it hovering
      const started = await run(
        `sleep(1)`,
        world({ hover: true }),
        "hover2.lua",
      );
      expect(stateOf(started).drone.y).toBe(70);
    }, 120000);

    it("the engine moves it a tenth of a block a tick the way it faces, and holds it up", async () => {
      // no hover: the engine sets the whole velocity each tick, so gravity never builds up. The world's clock runs
      // while the computer boots, so the drone hovers until the program starts: a busy host's slower boot let a
      // drone in the air fall for a tick or two first.
      const south = await run(
        `drone.hoverOn(false) drone.engineOn(true) sleep(1) drone.engineOn(false)`,
        world({ hover: true }),
        "south.lua",
      );
      const s = stateOf(south).drone;
      const ticks = (s.z - 0.5) / 0.1;
      expect(Math.abs(ticks - Math.round(ticks))).toBeLessThan(1e-6);
      expect(Math.round(ticks)).toBeGreaterThanOrEqual(18);
      expect(Math.round(ticks)).toBeLessThanOrEqual(22);
      expect(s.x).toBeCloseTo(0.5, 9);
      expect(s.y).toBeGreaterThan(69.8); // one tick of falling at most, once the engine is off

      const west = await run(
        `drone.hoverOn(true) drone.right(600) drone.engineOn(true) sleep(1) drone.engineOn(false)`,
        world({ hover: true }),
        "west.lua",
      );
      const w = stateOf(west).drone;
      expect(w.yaw).toBe(90);
      expect(w.x).toBeLessThan(-1.2);
      expect(w.x).toBeGreaterThan(-1.8);
      expect(w.z).toBeCloseTo(0.5, 6);
      expect(w.y).toBe(70);
    }, 120000);

    it("up() adds a tenth of its number to the upward speed, which then fades 2% a tick", async () => {
      const result = await run(
        `drone.hoverOn(true) drone.up(10) sleep(0.5) drone.engineOn(false)`,
        world({ hover: true }), // up from where it starts: in the air it would fall while the computer boots
        "up.lua",
      );
      const d = stateOf(result).drone;
      // ten ticks: 1 + 0.98 + ... = 9.15 blocks
      expect(d.y - 70).toBeGreaterThan(8);
      expect(d.y - 70).toBeLessThan(10.5);
      expect(d).toMatchObject({ vx: 0, vy: 0, vz: 0 });
      // with the engine on the push lasts one tick: the engine sets the velocity again
      const pushed = await run(
        `drone.hoverOn(false) drone.engineOn(true) sleep(0.5) drone.up(10) sleep(0.5) drone.engineOn(false)`,
        world({ hover: true }),
        "push.lua",
      );
      expect(stateOf(pushed).drone.y).toBeGreaterThan(70.9);
      expect(stateOf(pushed).drone.y).toBeLessThanOrEqual(71);
    }, 120000);

    it("a sim command can move and shove it", async () => {
      const result = await run(
        `drone.hoverOn(true)
out(sim({ cmd = "droneTeleport", x = 5, y = 80, z = -3, yaw = 180 }), drone.rotation())
out(sim({ cmd = "dronePush", y = 0.5 }))
sleep(0.2)
drone.engineOn(false)`,
        world(),
        "moved.lua",
      );
      expect(linesOf(result).slice(0, 2)).toEqual(["true 180", "true"]);
      const d = stateOf(result).drone;
      expect({ x: d.x, z: d.z }).toEqual({ x: 5.5, z: -2.5 });
      expect(d.y).toBeGreaterThan(81);
    }, 60000);
  },
);

describe.skipIf(!ready)("carrying", () => {
  it("a chest is carried with what is in it", async () => {
    const chestWorld = {
      blocks: [
        {
          x: 0,
          y: 64,
          z: 0,
          name: "minecraft:chest",
          items: { "1": { name: "minecraft:coal", count: 4 } },
        },
      ],
    };
    const held = await run(
      `drone.hoverOn(true) drone.pickupBlock()`,
      world({ y: 66 }, chestWorld),
      "carry.lua",
    );
    expect(stateOf(held).drone.carrying).toMatchObject({
      name: "minecraft:chest",
      items: { "1": { name: "minecraft:coal", count: 4 } },
    });
    expect(held.sim!.blocks!["0,64,0"]).toEqual({});
    expect(held.sim!.droppedItems ?? []).toEqual([]);

    const moved = await run(
      `drone.hoverOn(true) drone.pickupBlock()
drone.engineOn(true) sleep(2) drone.engineOn(false)
drone.dropBlock()`,
      world({ y: 66 }, chestWorld),
      "carry2.lua",
    );
    const d = stateOf(moved).drone;
    expect(d.carrying).toBeUndefined();
    // put down on the ground two blocks under the block it floats over
    const at = `0,64,${Math.floor(d.z)}`;
    expect(moved.sim!.blocks![at]).toMatchObject({
      name: "minecraft:chest",
      items: { "1": { name: "minecraft:coal", count: 4 } },
    });
  }, 120000);

  it("0.0.1 picks up an entity near the block under it and carries it two blocks below", async () => {
    const result = await run(
      `drone.hoverOn(true) drone.pickUpEntity()
drone.engineOn(true) sleep(1) drone.engineOn(false)`,
      world(
        { y: 66 },
        {
          entities: [
            { type: "minecraft:pig", uuid: PIG, x: 0.5, y: 64, z: 0.5 },
          ],
        },
      ),
      "ride.lua",
    );
    const s = stateOf(result);
    expect(s.drone.passenger).toBe(PIG);
    expect(s.entities[0]).toMatchObject({
      uuid: PIG,
      x: s.drone.x,
      y: s.drone.y - 2,
      z: s.drone.z,
    });
    expect(s.drone.z).toBeGreaterThan(2);

    const dropped = await run(
      `drone.hoverOn(true) drone.pickUpEntity() drone.up(10) sleep(0.2) drone.engineOn(false) drone.dropEntity()`,
      world(
        { y: 66 },
        {
          entities: [
            { type: "minecraft:pig", uuid: PIG, x: 0.5, y: 64, z: 0.5 },
          ],
        },
      ),
      "unride.lua",
    );
    const after = stateOf(dropped);
    expect(after.drone.passenger).toBeUndefined();
    expect(after.entities[0]).toMatchObject({ x: 0.5, y: 64, z: 0.5 });
  }, 120000);

  it("breakForward breaks anything, bedrock too, and stone drops cobblestone", async () => {
    const result = await run(
      `drone.hoverOn(true)
drone.breakForward()
drone.right(1200)
drone.breakForward()`,
      world(
        { y: 66.5 },
        {
          blocks: [
            { x: 0, y: 66, z: 2, name: "minecraft:stone" },
            { x: 0, y: 66, z: -2, name: "minecraft:bedrock" },
          ],
        },
      ),
      "break.lua",
    );
    expect(result.sim!.blocks!["0,66,2"]).toEqual({});
    expect(result.sim!.blocks!["0,66,-2"]).toEqual({});
    expect(result.sim!.droppedItems).toEqual([
      expect.objectContaining({ name: "minecraft:cobblestone", count: 1 }),
    ]);
  }, 60000);
});

describe.skipIf(!ready)("CC: Drones+ upgrades", () => {
  it("a world can give them, findUpgrades adds one each time it is called, the crowbar drops them", async () => {
    const result = await run(
      `out(drone.getPos())
out(drone.breakForward())
drone.findUpgrades() drone.findUpgrades()
out(sim({ cmd = "droneAddUpgrade", upgrade = "wings" }))
out(sim({ cmd = "droneRemoveUpgrades" }), drone.getPos())`,
      plusWorld(
        { y: 66, hover: true, upgrades: ["mine"] },
        {
          items: [
            { x: 1, y: 64, z: 0, name: "ccdrones:survey_upgrade", count: 1 },
          ],
        },
      ),
      "upgrades.lua",
    );
    expect(linesOf(result).slice(0, 4)).toEqual([
      "false Modem Upgrade Not Installed!",
      "true Broke Block!",
      "false upgrade must be mine, carry, survey or modem",
      "true false Modem Upgrade Not Installed!",
    ]);
    // (an empty list is written as an empty object)
    expect(
      Object.keys(stateOf(result, "cc-drones-plus").drone.upgrades ?? {}),
    ).toEqual([]);
    // mine, survey and survey again lie under the drone; the survey item itself was never picked up
    const names = (result.sim!.droppedItems ?? []).map((i) => i.name).sort();
    expect(names).toEqual([
      "ccdrones:mine_upgrade",
      "ccdrones:survey_upgrade",
      "ccdrones:survey_upgrade",
      "ccdrones:survey_upgrade",
    ]);
  }, 60000);
});

describe.skipIf(!ready)("the drone workbench", () => {
  const bench = (extra: Record<string, unknown> = {}): WorldConfig =>
    ({
      version: "1.20.1",
      addons: ["cc-drones"],
      peripherals: [
        { name: "left", type: "droneworkbench", drones: [{ id: 7 }], ...extra },
      ],
    }) as WorldConfig;

  it("0.0.1's api() reboots the computer into a drone API with no drone behind it", async () => {
    const result = await run(
      `if drone then
  local n = 0
  for _ in pairs(drone) do n = n + 1 end
  out("after", n, pcall(drone.engineOn, true))
else
  peripheral.call("left", "api")
  out("not reached")
end`,
      bench(),
      "api.lua",
    );
    expect(linesOf(result).join(" ")).toContain(
      "after 16 false Java Exception Thrown: java.lang.NullPointerException",
    );
    expect(stateOf(result).apiGiven).toBe(true);
  }, 60000);

  it("0.2.0's api() does nothing, and its export says when the file is missing", async () => {
    const result = await run(
      `out(select("#", peripheral.call("left", "api")), drone)
out(peripheral.call("left", "export", "/nothing.lua"))
local h = fs.open("/go.lua", "w") h.write("print('hi')") h.close()
out(peripheral.call("left", "export", "/go.lua"))`,
      { ...bench(), addons: ["cc-drones-plus"] } as WorldConfig,
      "api_plus.lua",
    );
    expect(linesOf(result).slice(0, 3)).toEqual([
      "0 nil",
      "File does not exist!",
      "Successfully copied data to drone, booting it up!",
    ]);
    expect(stateOf(result, "cc-drones-plus").exports).toEqual([
      { drone: 7, path: "/go.lua", program: "print('hi')" },
    ]);
  }, 60000);

  it("standing in a block world it reads the blocks around it (here beside an android)", async () => {
    const result = await run(
      `local below = peripheral.call("left", "debug")
out(peripheral.getType("left"), below.name)
local found = peripheral.call("left", "survey")
local keys = {}
for k, v in pairs(found) do keys[#keys + 1] = k .. "=" .. v.name end
table.sort(keys)
out(#keys, found["0,-1,0"].name == found["-5,-1,4"].name, found["3,0,0"].name, tostring(found["5,-1,0"]))`,
      {
        version: "1.20.1",
        addons: ["cc-androids", "cc-drones"],
        players: [{ name: "Steve", x: 60.5, y: 64, z: 60.5 }],
        android: { x: 0, y: 64, z: 0 },
        ground: GROUND,
        blocks: [
          {
            x: 1,
            y: 64,
            z: 0,
            name: "minecraft:crafting_table",
            peripheral: { type: "droneworkbench" },
          },
          { x: 4, y: 64, z: 0, name: "minecraft:oak_log" },
        ],
      } as WorldConfig,
      "bench_world.lua",
    );
    // the grass of the ground from -5 to 4 around it (100 blocks) and the log
    expect(linesOf(result).slice(0, 2)).toEqual([
      "droneworkbench minecraft:grass_block",
      "101 true minecraft:oak_log nil",
    ]);
  }, 60000);
});

describe.skipIf(!ready)("refused worlds", () => {
  it("the addon switched off, or a Minecraft version without the mod", async () => {
    put("nothing.lua", "print('x')");
    for (const w of [
      { ...world(), addons: [] },
      { ...world(), version: "1.18.2" },
      { ...plusWorld(), addons: ["cc-drones"] },
      { ...plusWorld(), version: "1.21.1" },
    ]) {
      await expect(
        runProgram(config, {
          program: "nothing.lua",
          world: w as WorldConfig,
          timeoutMs: 30000,
        }),
      ).rejects.toThrow(/cc-drones/);
    }
  }, 60000);
});
