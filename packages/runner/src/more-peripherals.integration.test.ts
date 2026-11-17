import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";
import { checkWorldAddons, resolveAddons } from "./addons.js";

/**
 * More Peripherals 1.20.1-1.13.0 (Forge), written from JheffersonMarques/MorePeripherals at 48518f7 and checked against
 * the jar with javap (docs/more-peripherals.md). The mod is not in the pack: nothing here was measured in game.
 * workspace/examples/more-peripherals/xp_station.test.lua runs the example program and then every emulated method.
 */
const config = loadConfig();
const ready = checkConfig(config).length === 0;

const TEST = "examples/more-peripherals/xp_station.test.lua";
const world = JSON.parse(
  readFileSync(
    join(config.workspaceDir, TEST.replace(/\.test\.lua$/, ".world.json")),
    "utf8",
  ),
) as WorldConfig;

describe("more-peripherals addon registry", () => {
  it("exists on 1.20.1 only", () => {
    expect(resolveAddons(["more-peripherals"], {}, "1.20.1")).toEqual([
      "more-peripherals",
    ]);
    expect(() => resolveAddons(["more-peripherals"], {}, "1.18.2")).toThrow(
      /no release for Minecraft 1\.18\.2/,
    );
  });

  it("refuses its blocks when it is off", () => {
    expect(() =>
      checkWorldAddons(
        { peripherals: [{ name: "s", type: "moreperipherals:scanner" }] },
        [],
        "1.20.1",
      ),
    ).toThrow(/More Peripherals/);
  });
});

describe.skipIf(!ready)("more-peripherals", () => {
  it(
    TEST,
    async () => {
      const result = await runTests(
        config,
        { paths: [TEST], world, timeScale: 5, timeoutMs: 120000 },
        1,
      );
      const file = result.files[0]!;
      const failures = file.tests
        .filter((t) => !t.passed)
        .map((t) => `${t.name}: ${t.error}`);
      expect({
        status: file.status,
        failures,
        terminal: file.terminal,
      }).toEqual({
        status: "passed",
        failures: [],
        terminal: undefined,
      });
      expect(file.tests.length).toBeGreaterThanOrEqual(12);
    },
    180000,
  );
});
