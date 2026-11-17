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
  worldJson,
} from "./index.js";

/**
 * CC: LiftLink 1.0.3 (Forge 1.20.1) and 1.0.4-neoforge (1.21.1), from tiktop101/CC-LiftLink and both jars, on top of
 * Create 6.0.8 / 6.0.10's elevator (docs/cc-liftlink.md). The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "liftlink-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

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
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
  timeScale?: number,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(
    config,
    { paths: [name], world, timeoutMs: 90000, timeScale },
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

/** Class.getMethods order of the class CC reads, measured on HotSpot with the jars' classes. */
const DECLARED = {
  "1.20.1": [
    "getNearestFloor",
    "callToFloor",
    "getTargetY",
    "isMoving",
    "getCabY",
    "callToY",
    "getRole",
    "listFloors",
    "getSpeed",
    "getState",
    "getOffset",
  ],
  "1.21.1": [
    "getState",
    "getOffset",
    "callToFloor",
    "getNearestFloor",
    "getSpeed",
    "getTargetY",
    "callToY",
    "listFloors",
    "getCabY",
    "isMoving",
    "getRole",
  ],
} as const;

/** CC 1.121's MethodSupplier.getSelfMethods: a default HashMap, filled in that order. */
function javaHashMapOrder(keys: readonly string[]): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 16;
  while (keys.length > cap * 0.75) cap *= 2;
  return keys
    .map((k, i) => ({ k, i, b: hash(k) & (cap - 1) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.k);
}

describe("CC: LiftLink addon (no engine)", () => {
  it("is refused on 1.18.2, where the mod has no release, and when switched off", () => {
    const p = [{ name: "e", type: "create_elevator" }];
    expect(() => worldJson({ version: "1.18.2", peripherals: p })).toThrow(
      /\(create_elevator\): CC: LiftLink .*no release for Minecraft 1\.18\.2/,
    );
    expect(() =>
      worldJson({ version: "1.20.1", addons: ["create"], peripherals: p }),
    ).toThrow(/peripheral "e" is a create_elevator from CC: LiftLink/);
    expect(() =>
      worldJson({ version: "1.20.1", addons: ["cc-liftlink"], peripherals: p }),
    ).toThrow(/addon cc-liftlink needs create/);
    expect(() =>
      worldJson({
        version: "1.21.1",
        addons: ["create", "cc-liftlink"],
        peripherals: p,
      }),
    ).not.toThrow();
  });
});

const world = (version: "1.20.1" | "1.21.1"): WorldConfig =>
  ({
    version,
    addons: ["create", "cc-liftlink"],
    create: { networks: { lift: { speed: 256, capacity: 4096 } } },
    liftlink: {
      columns: {
        main: {
          x: 5,
          z: 9,
          contacts: [
            { y: 10, shortName: "B", longName: "" },
            { y: 20, shortName: "", longName: "" },
            { y: 30, shortName: "7", longName: "Top" },
          ],
          pulley: { y: 40, network: "lift", cabY: 10, contactYOffset: -2 },
        },
        // a contact with no pulley in reach: single-contact tracking
        far: {
          contacts: [{ y: 70, shortName: "Up", longName: "Upper" }],
          pulley: { y: 90, rpm: 32, cabY: 70, distance: 6, assembled: false },
          target: 70,
        },
        lone: {},
      },
    },
    peripherals: [
      { name: "c", type: "create_elevator", column: "main", y: 20 },
      {
        name: "d",
        type: "create_elevator",
        column: "far",
        y: 60,
        shortName: "Down",
        longName: "Lower",
        currentFloor: "Down",
      },
      { name: "n", type: "create_elevator", column: "lone", y: 5 },
    ],
  }) as WorldConfig;

const SCRIPT = (order: string[]) => `
ccunit.test("getMethods order", function()
  ccunit.eq(peripheral.getMethods("c"), ${JSON.stringify(order).replace("[", "{").replace("]", "}")})
end)

ccunit.test("generated floor names and the live pulley", function()
  local c = peripheral.wrap("c")
  local floors = c.listFloors()
  -- ElevatorColumn.initNames: the blank one between "B" and "7" becomes 6, one below the next numbered floor
  ccunit.eq(floors[2].shortName, "6")
  ccunit.eq(floors[2].name, "6")
  ccunit.eq(floors[1].currentFloorName, "B")
  ccunit.eq(floors[1].isCurrent, true)
  ccunit.eq(c.getCabY(), 10)
  ccunit.eq(c.getOffset(), 27) -- 40 + (-2) - 1 - 10
  ccunit.eq(c.getState().hasPulley, true)
  -- the travel range: maxContactY = 40 - 2 - 1 = 37
  ccunit.eq(err(c.callToY, 38), "Y=38 is not a real floor and is outside the elevator travel range")
  ccunit.eq(c.callToY(37), true)
  ccunit.eq(c.getTargetY(), 37)
  ccunit.eq(c.callToFloor("  top "), true)
  ccunit.eq(c.getTargetY(), 30)
  -- 256 RPM: the pulley tops out at 1 block a tick (convertToLinear(512)), accelerating 0.0175 a tick
  local seen = 0
  for i = 1, 200 do
    local s = -c.getSpeed() -- going up: the offset shrinks
    if s > seen then seen = s end
    if c.getCabY() == 30 and not c.isMoving() then break end
    sleep(0.05)
  end
  ccunit.eq(c.getCabY(), 30)
  ccunit.truthy(seen > 0.2 and seen <= 1, seen)
  ccunit.eq(c.getNearestFloor().name, "7")
  ccunit.eq(c.listFloors()[3].isCurrent, true)
  ccunit.eq(c.getState().currentFloorName, "7")
end)

ccunit.test("single-contact tracking without a pulley in reach", function()
  local d = peripheral.wrap("d")
  local s = d.getState()
  ccunit.eq(s.hasPulley, false)
  ccunit.eq(s.trackingMode, "single_contact")
  ccunit.eq(s.speed, 0)
  ccunit.eq(s.offset, nil)
  ccunit.eq(s.cabY, 60) -- from the floor the contacts last reported
  ccunit.eq(s.targetY, 70)
  ccunit.eq(s.moving, true) -- target 70, current floor 60
  ccunit.eq(d.isMoving(), true)
  ccunit.eq(d.getSpeed(), 0)
  ccunit.eq(d.getOffset(), nil)
  ccunit.eq(select("#", d.getOffset()), 1)
  ccunit.eq(d.getCabY(), 60)
  ccunit.eq(d.getNearestFloor(), { y = 60, shortName = "Down", longName = "Lower", name = "Down", distance = 0 })
  ccunit.eq(d.callToFloor("lower"), true)
  ccunit.eq(d.isMoving(), false)
  ccunit.eq(err(d.callToY, 65), "Y=65 is not a real floor and is outside the elevator travel range")
end)

ccunit.test("a contact alone: names generated, nothing reported", function()
  local n = peripheral.wrap("n")
  ccunit.eq(n.listFloors(), { { y = 5, shortName = "0", longName = "", name = "0", isTarget = false, isCurrent = false } })
  ccunit.eq(n.getCabY(), nil)
  ccunit.eq(select("#", n.getCabY()), 1)
  ccunit.eq(n.getTargetY(), nil)
  ccunit.eq(n.getNearestFloor(), nil)
  ccunit.eq(n.isMoving(), false)
  local s = n.getState()
  ccunit.eq(s.targetAvailable, false)
  ccunit.eq(s.targetY, nil)
  ccunit.eq(s.currentFloorName, nil)
  ccunit.eq(s.floorCount, 1)
  ccunit.eq(n.callToY(5), true)
  ccunit.eq(n.getTargetY(), 5)
  ccunit.eq(n.listFloors()[1].isTarget, true)
  -- CC 1.121's getInt: (int) of the long, no integer check
  ccunit.eq(n.callToY(5.9), true)
  ccunit.eq(err(n.callToY, -0.5), "Y=0 is not a real floor and is outside the elevator travel range")
  ccunit.eq(n.callToY(2 ^ 32 + 5), true) -- the long wraps to the int 5
  ccunit.eq(err(n.callToY, 2 ^ 31), "Y=-2147483648 is not a real floor and is outside the elevator travel range")
end)
`;

describe.skipIf(!ready)("CC: LiftLink on the computer", () => {
  for (const version of ["1.20.1", "1.21.1"] as const) {
    it(`${version}: every method against the Create elevator`, async () => {
      const result = await lua(
        SCRIPT(javaHashMapOrder(DECLARED[version])),
        world(version),
        `liftlink-${version}.test.lua`,
      );
      expectAllPassed(result);
    }, 120000);
  }

  it("the example program and its test", async () => {
    const test = "examples/cc-liftlink/lift.test.lua";
    const src = join(base.workspaceDir, "examples", "cc-liftlink");
    for (const f of ["lift.lua", "lift.test.lua"])
      put(
        join("examples", "cc-liftlink", f),
        readFileSync(join(src, f), "utf8"),
      );
    const w = JSON.parse(
      readFileSync(join(src, "lift.world.json"), "utf8"),
    ) as WorldConfig;
    const result = await runTests(
      config,
      { paths: [test], world: w, timeoutMs: 110000, timeScale: 5 },
      1,
    );
    expectAllPassed(result);
  }, 120000);
});
