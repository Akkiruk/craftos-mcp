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
 * The board game cabinet in workspace/examples/games/board/: every game's test, each on its own computer with the
 * cabinet's world (a speaker) and two 6x6 monitor walls, all at once. Each test plays real games through monitor
 * touches and checks the rules, so a test file takes a few seconds to a few tens of seconds.
 */
const config = loadConfig();
const ready = checkConfig(config).length === 0;

const DIR = "examples/games/board";
const GAMES = [
  "uttt",
  "fourinarow",
  "reversi",
  "checkers",
  "dots",
  "mancala",
  "fleet",
  "codebreaker",
];

const walls: MonitorSpec[] = [
  { name: "left", blocksWide: 6, blocksHigh: 6 },
  { name: "right", blocksWide: 6, blocksHigh: 6 },
];

const world = JSON.parse(
  readFileSync(join(config.workspaceDir, DIR, "arcade.world.json"), "utf8"),
) as WorldConfig;

describe.skipIf(!ready).concurrent("board game cabinet", () => {
  for (const game of GAMES) {
    const test = `${DIR}/${game}.test.lua`;
    it(test, { timeout: 240000 }, async () => {
      const result = await runTests(
        config,
        {
          paths: [test],
          world,
          monitors: walls,
          timeScale: 4,
          timeoutMs: 200000,
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
        ran: file.tests.length > 4,
      }).toEqual({
        status: "passed",
        failures: [],
        ran: true,
      });
    });
  }
});
