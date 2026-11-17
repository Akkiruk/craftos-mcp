import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
  sendAndWait,
  SessionManager,
  worldJson,
} from "./index.js";

/**
 * CC: VS (docs/cc-vs.md): 0.5.1 on 1.18.2 and 0.6.6 on 1.20.1, from TechTastic/CC-VS (1.18.x/archived at 7a65541,
 * 1.20.x/main at e0fd0de) and checked against both jars with javap. Not measured in game: the mod is not in the pack.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ccvs-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const workspace = fileURLToPath(
  new URL("../../../workspace/", import.meta.url),
);

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
local function keys(t)
  local out = {}
  for k in pairs(t) do out[#out + 1] = k end
  table.sort(out)
  return out
end
local simCount = 0
local function sim(command, noWait)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  if not noWait then sleep(0.2) end
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

const lst = (names: readonly string[]) =>
  `{ ${[...names]
    .sort()
    .map((n) => JSON.stringify(n))
    .join(", ")} }`;

// The @LuaFunction methods of each API, from javap on the jars
const SHIP_051 = [
  "pullPhysicsTicks",
  "getId",
  "getMass",
  "getMomentOfInertiaTensorToSave",
  "getMomentOfInertiaTensor",
  "getSlug",
  "getOmega",
  "getQuaternion",
  "getScale",
  "getShipyardPosition",
  "getSize",
  "getVelocity",
  "getWorldspacePosition",
  "transformPositionToWorld",
  "isStatic",
  "setSlug",
  "getTransformationMatrix",
  "getConstraints",
  "applyInvariantForce",
  "applyInvariantTorque",
  "applyInvariantForceToPos",
  "applyRotDependentForce",
  "applyRotDependentTorque",
  "applyRotDependentForceToPos",
  "setStatic",
  "setScale",
  "teleport",
];
const SHIP_066 = [
  "getId",
  "getMass",
  "getMomentOfInertiaTensor",
  "getSlug",
  "getAngularVelocity",
  "getQuaternion",
  "getScale",
  "getShipyardPosition",
  "getSize",
  "getVelocity",
  "getWorldspacePosition",
  "transformPositionToWorld",
  "isStatic",
  "setSlug",
  "getTransformationMatrix",
  "getJoints",
  "pullPhysicsTicks",
  "applyWorldForce",
  "applyWorldTorque",
  "applyModelForce",
  "applyModelTorque",
  "applyWorldForceToModelPos",
  "applyBodyForce",
  "applyBodyTorque",
  "applyWorldForceToBodyPos",
  "setStatic",
  "setScale",
  "teleport",
];
const AERO_066 = [
  "getDefaultMax",
  "getDefaultSeaLevel",
  "getDragCoefficient",
  "getGravitationalAcceleration",
  "getUniversalGasConstant",
  "getAirMolarMass",
  "getAtmosphericParameters",
  "getAirDensity",
  "getAirPressure",
  "getAirTemperature",
];
const DRAG_066 = [
  "getDragForce",
  "getLiftForce",
  "enableDrag",
  "disableDrag",
  "enableLift",
  "disableLift",
  "enableRotDrag",
  "disableRotDrag",
  "setWindDirection",
  "setWindSpeed",
  "applyWindImpulse",
];
// what the mod's ship.lua adds on top: stubs for removed methods
const DEPRECATED = [
  "getEulerAnglesZYX",
  "getEulerAnglesZXY",
  "getEulerAnglesYXZ",
  "getEulerAnglesXYZ",
  "getRoll",
  "getYaw",
  "getPitch",
  "getRotationMatrix",
];
const DEPRECATED_066 = [
  ...DEPRECATED,
  "applyInvariantForce",
  "applyInvariantForceToPos",
  "applyInvariantTorque",
  "applyRotDependentForce",
  "applyRotDependentForceToPos",
  "applyRotDependentTorque",
  "getOmega",
];

const SHIP = {
  id: 9,
  slug: "barge",
  mass: 800,
  inertia: [
    [10, 0, 0],
    [0, 20, 0],
    [0, 0, 30],
  ],
  inertiaToSave: [
    [11, 0, 0],
    [0, 21, 0],
    [0, 0, 31],
  ],
  position: { x: 10, y: 80, z: 20 },
  shipyardPosition: { x: 1000, y: 64, z: 1000 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  velocity: { x: 1, y: 0, z: 0 },
  omega: { x: 0, y: 0.5, z: 0 },
  aabb: { minX: 998, minY: 63, minZ: 997, maxX: 1003, maxY: 66, maxZ: 1004 },
  constraints: [
    { shipId0: 9, shipId1: 3, type: "ROPE", compliance: 0, ropeLength: 5 },
  ],
};

describe("CC: VS addon registry (no engine)", () => {
  it("a world configuring it fails cleanly when the addon is off, and 1.21.1 has no release", () => {
    expect(() =>
      worldJson({
        version: "1.18.2",
        addons: ["create"],
        ccvs: { ship: SHIP },
      } as WorldConfig),
    ).toThrow(/world.ccvs configures CC: VS \(addon "cc-vs"\)/);
    expect(() =>
      worldJson({ version: "1.21.1", addons: ["cc-vs"] } as WorldConfig),
    ).toThrow(/CC: VS \(addon "cc-vs"\) has no release for Minecraft 1.21.1/);
    expect(() =>
      worldJson({
        version: "1.18.2",
        addons: ["cc-vs"],
        ccvs: {},
      } as WorldConfig),
    ).not.toThrow();
  });

  it("the example world is valid", () => {
    const w = JSON.parse(
      readFileSync(
        join(workspace, "examples/cc-vs/altitude_hold.world.json"),
        "utf8",
      ),
    ) as WorldConfig;
    expect(() => worldJson(w)).not.toThrow();
  });
});

describe.skipIf(!ready)("CC: VS 0.5.1 on 1.18.2", () => {
  it("the ship API, its wrapper, its values and its errors", async () => {
    const result = await lua(
      `
ccunit.test("globals and method surface", function()
  ccunit.eq(keys(ship), ${lst([...SHIP_051, ...DEPRECATED])})
  ccunit.eq(type(quaternion), "table")
  ccunit.eq(type(matrix), "table")
  ccunit.eq(aero, nil)
  ccunit.eq(drag, nil)
end)

ccunit.test("getters", function()
  ccunit.eq(ship.getId(), 9)
  ccunit.eq(ship.getSlug(), "barge")
  ccunit.eq(ship.getMass(), 800)
  ccunit.eq(ship.getMomentOfInertiaTensor(), { { 10, 0, 0 }, { 0, 20, 0 }, { 0, 0, 30 } })
  ccunit.eq(ship.getMomentOfInertiaTensorToSave(), { { 11, 0, 0 }, { 0, 21, 0 }, { 0, 0, 31 } })
  ccunit.eq(tostring(ship.getOmega()), "0,0.5,0")
  ccunit.eq(tostring(ship.getVelocity()), "1,0,0")
  ccunit.eq(tostring(ship.getWorldspacePosition()), "10,80,20")
  ccunit.eq(tostring(ship.getShipyardPosition()), "1000,64,1000")
  ccunit.eq(tostring(ship.getScale()), "1,1,1")
  ccunit.eq(ship.getSize(), { x = 5, y = 3, z = 7 })
  ccunit.eq(ship.isStatic(), false)
  ccunit.eq(tostring(ship.transformPositionToWorld(1001, 65, 1002)), "11,81,22")
  ccunit.eq(tostring(ship.transformPositionToWorld({ x = 1000, y = 64 })), "10,80,-980")
  local m = ship.getTransformationMatrix()
  ccunit.eq({ m.rows, m.columns }, { 4, 4 })
  -- ship.lua's getConstraints wrapper calls the native getTransformationMatrix: it returns the matrix rows
  ccunit.eq(ship.getConstraints(), { { 1, 0, 0, -990 }, { 0, 1, 0, 16 }, { 0, 0, 1, -980 }, { 0, 0, 0, 1 } })
  ccunit.eq(err(ship.getYaw), "This method no longer exists! Please utilize the new quaternion API!")
end)

ccunit.test("argument errors", function()
  ccunit.eq(err(ship.transformPositionToWorld), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(ship.transformPositionToWorld, nil), "bad argument #1 (table expected, got nil)")
  ccunit.eq(err(ship.setSlug), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(ship.setStatic, "yes"), "bad argument #1 (boolean expected, got string)")
  ccunit.eq(err(ship.setScale), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(ship.teleport, {}), "Teleporting is Disabled via CC: VS Config!")
  ccunit.eq(err(ship.pullPhysicsTicks), "Physics Tick is not exposed! This is a configuration option!")
  ccunit.eq(err(ship.applyInvariantForceToPos, 1, 2, 3, 4, 5), "bad argument #6 (expected number, got nil)")
  -- 1.101.3's vectors have no __name: the wrapper refuses them
  ccunit.truthy(err(ship.applyInvariantForce, vector.new(1, 2, 3)):find("bad argument #1", 1, true))
end)

ccunit.test("setters and forces on a normal computer", function()
  ship.setSlug("galleon")
  ccunit.eq(ship.getSlug(), "galleon")
  ship.applyInvariantForce(1, 2, 3)
  ship.applyInvariantTorque(1, 2, 3)
  ship.applyInvariantForceToPos(1, 2, 3, 4, 5, 6)
  ship.applyRotDependentForce(1, 2, 3)
  ship.applyRotDependentTorque(1, 2, 3)
  ship.applyRotDependentForceToPos(1, 2, 3, 4, 5, 6)
  ship.setStatic(true)
  ccunit.eq(ship.isStatic(), false) -- queued for the next physics tick
  ship.setScale(3)
  sleep(0.1)
  ccunit.eq(ship.isStatic(), true)
  ccunit.eq(tostring(ship.getScale()), "3,3,3")
end)

ccunit.test("the ship goes away", function()
  sim({ cmd = "ccvsSetShip", ship = textutils.json_null })
  ccunit.eq(err(ship.getId), "This computer is not on a Ship!")
  ccunit.eq(err(ship.applyInvariantForce, 1, 2, 3), "This computer is not on a Ship!")
  ccunit.eq(err(ship.pullPhysicsTicks), "Physics Tick is not exposed! This is a configuration option!")
end)
`,
      {
        version: "1.18.2",
        addons: ["cc-vs"],
        simProgram: true,
        ccvs: { ship: SHIP },
      } as WorldConfig,
      "ccvs118.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("verifyAdmin in 0.5.1 refuses command computers; teleport; physics ticks; no ship, no API", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("command computer", function()
  ccunit.eq(err(ship.applyInvariantForce, 1, 2, 3), "This method requires a Command Computer!")
  ccunit.eq(err(ship.applyRotDependentTorque, 1, 2, "x"), "bad argument #3 (number expected, got string)")
  ship.setStatic(true) -- no admin check
end)
ccunit.test("teleport", function()
  ccunit.eq(err(ship.teleport, { pos = { x = 1, y = 2 } }), "Malformed z key of pos")
  ccunit.truthy(err(ship.teleport, { scale = "big" }):find("java.lang.ClassCastException: class java.lang.String cannot be cast to class java.lang.Double", 1, true))
  ship.teleport({ pos = { x = 0, y = 100, z = 0 }, rot = { x = 0, y = 0, z = 1, w = 1 }, omega = { x = 0, y = 0, z = 0 } })
  ccunit.eq(tostring(ship.getWorldspacePosition()), "10,80,20") -- until the next tick
  sleep(0.1)
  ccunit.eq(tostring(ship.getWorldspacePosition()), "0,100,0")
  local q = ship.getQuaternion()
  ccunit.truthy(math.abs(q.v.z - math.sqrt(0.5)) < 1e-12 and math.abs(q.a - math.sqrt(0.5)) < 1e-12, tostring(q))
  ccunit.eq(tostring(ship.getOmega()), "0,0,0")
end)
ccunit.test("physics ticks: one event per tick, the array as one argument", function()
  sleep(0.2) -- drops the events queued before the teleport
  local e = { os.pullEvent("physics_ticks") }
  ccunit.eq(#e, 2)
  ccunit.eq(#e[2], 3)
  local p = e[2][1]
  ccunit.eq(p.getBuoyantFactor(), 1)
  ccunit.eq(p.isStatic(), true)
  ccunit.eq(p.doFluidDrag(), true)
  ccunit.eq(p.getInertia(), { momentOfInertiaTensor = { { 10, 0, 0 }, { 0, 20, 0 }, { 0, 0, 30 } }, mass = 800 })
  ccunit.eq(p.getPoseVel().pos, { x = 0, y = 100, z = 0 })
  ccunit.eq(p.getForcesInducers(), {})
  -- ship.lua's pullPhysicsTicks then calls getPoseVel on the array itself
  ccunit.truthy(err(ship.pullPhysicsTicks):find("attempt to call", 1, true))
end)
`,
        {
          version: "1.18.2",
          addons: ["cc-vs"],
          ccvs: {
            family: "command",
            config: { canTeleport: true, exposePhysTick: true },
            ship: SHIP,
          },
        } as WorldConfig,
        "ccvs118cmd.test.lua",
      ),
    );
    expectAllPassed(
      await lua(
        `
ccunit.test("off a ship there is no ship API", function()
  ccunit.eq(ship, nil)
  ccunit.eq(type(quaternion.identity), "function")
  ccunit.eq(type(matrix.identity), "function")
end)
`,
        { version: "1.18.2", addons: ["cc-vs"], ccvs: {} } as WorldConfig,
        "ccvs118none.test.lua",
      ),
    );
  }, 90000);
});

describe.skipIf(!ready)("CC: VS 0.6.6 on 1.20.1", () => {
  it("every computer has the APIs; off a ship they throw", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("method surface", function()
  ccunit.eq(keys(ship), ${lst([...new Set([...SHIP_066, ...DEPRECATED_066])])})
  ccunit.eq(keys(aerodynamics), ${lst(AERO_066)})
  ccunit.eq(keys(aero), ${lst(AERO_066)})
  ccunit.eq(keys(drag), ${lst(DRAG_066)})
  ccunit.truthy(aero ~= aerodynamics) -- aero.lua's copy replaces the native aero
end)
ccunit.test("off a ship", function()
  ccunit.eq(err(ship.getId), "This computer is not on a Ship!")
  ccunit.eq(err(ship.getWorldspacePosition), "This computer is not on a Ship!")
  ccunit.eq(err(drag.getDragForce), "This computer is not on a Ship!")
  ccunit.eq(ship.getJoints(), {})
  ccunit.eq(err(ship.pullPhysicsTicks), "Physics Tick is not exposed! This is a configuration option!")
  -- admin first, then the ship
  ccunit.eq(err(ship.setStatic, true), "This method requires a Command Computer!")
  ccunit.eq(aero.getDefaultMax(), 962)
  ccunit.eq(aero.getAtmosphericParameters(), { maxY = 962, seaLevel = 62, gravity = 10 })
  ccunit.truthy(err(aero.getAirDensity):find("not emulated", 1, true))
end)
ccunit.test("a normal computer cannot push", function()
  sim({ cmd = "ccvsSetShip", ship = { id = 3 } })
  ccunit.eq(ship.getId(), 3)
  ccunit.eq(ship.getSlug(), "no-name")
  ccunit.eq(err(ship.applyWorldTorque, vector.new(0, 1, 0)), "This method requires a Command Computer!")
  ccunit.eq(err(drag.enableDrag), "This method requires a Command Computer!")
  ccunit.eq(err(ship.teleport, {}), "This method requires a Command Computer!")
  ccunit.eq(err(ship.setScale, "x"), "bad argument #1 (number expected, got string)")
end)
`,
        {
          version: "1.20.1",
          addons: ["cc-vs"],
          simProgram: true,
          ccvs: {},
        } as WorldConfig,
        "ccvs120none.test.lua",
      ),
    );
  }, 90000);

  it("physics ticks, collisions, the force queue in sim state", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("physics ticks: spread, three per tick", function()
  local e = table.pack(os.pullEvent("physics_ticks"))
  ccunit.eq(e.n, 4)
  ccunit.eq(e[2].getInertia().momentOfInertia, { { 10, 0, 0 }, { 0, 20, 0 }, { 0, 0, 30 } })
  ccunit.eq(e[2].getPoseVel().pos, { x = 1000, y = 64, z = 1000 })
  local p = table.pack(ship.pullPhysicsTicks())
  ccunit.eq(p[1], "physics_ticks")
  ccunit.eq(tostring(p[2].getPoseVel().vel), "1,0,0")
  ccunit.eq(getmetatable(p[2].getPoseVel().rot).__name, "quaternion")
end)
ccunit.test("collision events", function()
  sim({ cmd = "ccvsCollision", phase = "start", shipIdA = 9, shipIdB = 4,
    contactPoints = { { position = { 1, 2, 3 }, normal = { 0, 1, 0 }, separation = -0.1, velocity = { 0, 0, 0 } } } }, true)
  local _, c = os.pullEvent("collisions_started")
  ccunit.eq(c.shipIdA, 9)
  ccunit.eq(c.shipIdB, 4)
  ccunit.eq(c.dimensionId, "minecraft:overworld")
  ccunit.eq(c.contactPoints[1].position, { x = 1, y = 2, z = 3 })
  ccunit.eq(c.contactPoints[1].separation, -0.1)
end)
ccunit.test("forces with and without a position", function()
  ship.applyWorldForce(vector.new(1, 0, 0))
  ship.applyWorldForce(vector.new(0, 1, 0), vector.new(1, 2, 3))
  ship.applyBodyForce(vector.new(0, 0, 1))
  ship.applyWorldForceToBodyPos(vector.new(1, 1, 1), vector.new(0, 0, 0))
  local bad = setmetatable({ x = 1, y = "up", z = 0 }, getmetatable(vector.new()))
  ccunit.eq(err(ship.applyModelForce, vector.new(1, 0, 0), bad), "bad argument #5 (number expected, got string)")
  ccunit.eq(err(ship.applyWorldForce, bad), "bad argument #2 (number expected, got string)")
end)
`,
        {
          version: "1.20.1",
          addons: ["cc-vs"],
          simProgram: true,
          ccvs: {
            family: "command",
            config: { exposePhysTick: true },
            ship: SHIP,
          },
        } as WorldConfig,
        "ccvs120phys.test.lua",
      ),
    );
  }, 90000);

  it("sim commands and state", async () => {
    put(
      "push.lua",
      `ship.applyWorldForce(vector.new(5, 0, 0), vector.new(1, 2, 3))
ship.applyBodyForce(vector.new(0, 0, 1))
ship.applyWorldForceToBodyPos(vector.new(1, 1, 1), vector.new(0, 0, 0))
print("pushed")`,
    );
    const manager = new SessionManager(config);
    const s = manager.create([], 1, {
      version: "1.20.1",
      addons: ["cc-vs"],
      ccvs: { family: "command", ship: SHIP },
    } as WorldConfig);
    type Dict = Record<string, unknown>;
    const addon = (st: SimState) =>
      (st as { addons?: Record<string, Dict> }).addons!["cc-vs"]!;
    try {
      await s.handle.session.waitForText(">", 0, 20000);
      const step = async (c: Dict) => {
        expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
          true,
        );
        return s.handle.readState()!;
      };
      let st = await step({
        cmd: "ccvsSet",
        position: { x: 1, y: 2, z: 3 },
        static: true,
        slug: "raft",
      });
      let ship = addon(st).ship as Dict;
      expect(ship.position).toEqual({ x: 1, y: 2, z: 3 });
      expect(ship.static).toBe(true);
      expect(ship.slug).toBe("raft");
      expect(addon(st).version).toBe("0.6.6");
      s.handle.session.typeLine("push");
      await s.handle.session.waitForText("pushed", 0, 10000);
      st = await step({
        cmd: "ccvsSet",
        drag: { dragForce: { x: 0, y: 1, z: 0 } },
      });
      const forces = addon(st).forces as Dict[];
      expect(forces.map((f) => [f.method, f.call])).toEqual([
        ["applyWorldForce", "applyWorldForce"],
        ["applyBodyForce", "applyBodyForce"],
        ["applyWorldForceToBodyPos", "applyWorldForceToModelPos"],
      ]);
      expect(forces[0]!.pos).toEqual({ x: 1, y: 2, z: 3 });
      expect(forces[1]!.pos).toEqual({ x: 0, y: 0, z: 0 }); // applyBodyForce defaults its position
      expect((addon(st).ship as Dict).drag).toMatchObject({
        dragForce: { x: 0, y: 1, z: 0 },
      });
      st = await step({ cmd: "ccvsSetShip", ship: null });
      ship = addon(st).ship as Dict;
      expect(ship).toBeUndefined();
    } finally {
      await manager.destroyAll();
    }
  }, 60000);

  it("the example: altitude hold", async () => {
    const world = JSON.parse(
      readFileSync(
        join(workspace, "examples/cc-vs/altitude_hold.world.json"),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await runTests(
      { ...base },
      {
        paths: ["examples/cc-vs/altitude_hold.test.lua"],
        world,
        timeScale: 5,
        timeoutMs: 90000,
      },
      1,
    );
    expectAllPassed(result);
  }, 120000);
});
