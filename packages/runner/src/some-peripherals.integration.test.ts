import {
  cpSync,
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
 * Some Peripherals 0.0.12 (1.18.2), checked against behaviour read from the mod's source (branch 1.18.2 at 955ec42)
 * and ballistic numbers from a Java port of its BallisticFunctions.kt. docs/some-peripherals.md has the source for
 * every rule. The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "sp-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const EXAMPLE = "examples/some-peripherals";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

cpSync(join(base.workspaceDir, EXAMPLE), join(scratch, EXAMPLE), {
  recursive: true,
});

const exampleWorld = JSON.parse(
  readFileSync(join(scratch, EXAMPLE, "turret.world.json"), "utf8"),
) as WorldConfig;

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

describe.skipIf(!ready)("Some Peripherals", () => {
  it("the example and every method", async () => {
    const result = await runTests(
      config,
      {
        paths: [`${EXAMPLE}/turret.test.lua`],
        world: exampleWorld,
        timeScale: 10,
        timeoutMs: 120000,
      },
      1,
    );
    expectAllPassed(result);
  }, 180000);

  it("with Valkyrien Skies the radar reports ships too, its own first", async () => {
    writeFileSync(
      join(scratch, "sp-vs.test.lua"),
      `
local radar = peripheral.wrap("radar")
ccunit.test("ships", function()
  local ships = radar.scanForShips(50)
  ccunit.eq(#ships, 2)
  ccunit.eq({ ships[1].is_ship, ships[1].id, ships[2].id }, { true, 2, 1 })
  ccunit.eq(ships[2].size, { x = 8, y = 4, z = 6 })
  ccunit.eq(ships[2].rotation, { x = 0, y = 0, z = 0, w = 1 })
  ccunit.eq(#radar.scan(50), 2) -- no entities, two ships
  ccunit.eq(#radar.scanForShips(1), 1) -- the ship it stands on is always there
end)
`,
    );
    const world = {
      version: "1.18.2",
      addons: ["some-peripherals"],
      somePeripherals: {
        valkyrienSkies: true,
        computerShip: 2,
        ships: [
          {
            id: 1,
            min: { x: 20, y: 60, z: 0 },
            max: { x: 28, y: 64, z: 6 },
            shipyardMin: { x: 0, y: 0, z: 0 },
            shipyardMax: { x: 8, y: 4, z: 6 },
            mass: 1200,
          },
          {
            id: 2,
            min: { x: -2, y: 62, z: -2 },
            max: { x: 2, y: 66, z: 2 },
          },
        ],
      },
      peripherals: [{ name: "radar", type: "sp_radar" }],
    } as unknown as WorldConfig;
    expectAllPassed(
      await runTests(config, { paths: ["sp-vs.test.lua"], world }, 1),
    );
  }, 120000);

  it("exists only on 1.18.2", () => {
    for (const version of ["1.20.1", "1.21.1"]) {
      expect(() =>
        worldJson({ ...exampleWorld, version } as WorldConfig),
      ).toThrow(/no release for Minecraft/);
    }
  });
});
