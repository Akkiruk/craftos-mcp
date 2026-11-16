import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MonitorSpec,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

/**
 * The action games cabinet in workspace/examples/games/action/: Snake, Blocks, Bricks, Lander and Mines, each played
 * through the real cabinet by its own <game>.test.lua with taps on a 6x6 monitor, at the emulator's own speed.
 */
const config = loadConfig();
const ready = checkConfig(config).length === 0;
const DIR = "examples/games/action";
const GAMES = ["snake", "blocks", "bricks", "lander", "mines"];

const { monitors, ...world } = JSON.parse(
  readFileSync(join(config.workspaceDir, DIR, "action.world.json"), "utf8"),
) as WorldConfig & { monitors: MonitorSpec[] };

describe.skipIf(!ready).concurrent("action games", () => {
  for (const game of GAMES) {
    it(`${DIR}/${game}.test.lua`, async () => {
      const result = await runTests(
        config,
        {
          paths: [`${DIR}/${game}.test.lua`],
          world,
          monitors,
          timeoutMs: 170000,
        },
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
      }).toEqual({ status: "passed", failures: [], terminal: undefined });
    }, 180000);
  }
});
