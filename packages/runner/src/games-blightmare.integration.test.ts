import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type MonitorSpec,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

/**
 * BLIGHTMARE in workspace/examples/games/blightmare/: the RPG ported to plain CC:Tweaked. Every test file runs on its
 * own computer, all at once:
 * - play.test.lua and detector.test.lua play the whole cabinet by monitor touches on a 6x6 wall, without and with an
 *   Advanced Peripherals player detector;
 * - install.test.lua builds install/ (build.mjs) and runs it on CC:Tweaked's default 1,000,000-byte disk, with nothing
 *   else on the computer: it has to fit, load from the pack, and play to a save;
 * - tests/ holds the game's own checks: the engine, battles, the map, the art, every region's content (region_*) and a
 *   bot playing each region through with real fights (playthrough_*), every boss at its level, and one whole game from
 *   a new save to the ending (full), which is the slowest at a few minutes.
 */
const config = loadConfig();
const ready = checkConfig(config).length === 0;

const DIR = "examples/games/blightmare";
const GAME = join(config.workspaceDir, DIR);

const worldOf = (file: string) => {
  const { monitors, ...world } = JSON.parse(
    readFileSync(join(GAME, file), "utf8"),
  ) as WorldConfig & { monitors: MonitorSpec[] };
  return { world, monitors };
};
const plain = worldOf("blightmare.world.json");
const detector = worldOf("detector.world.json");

const REGIONS = [
  "heart",
  "plexios",
  "sindal",
  "windmill",
  "empire",
  "underdark",
  "vault",
  "ruin_south",
  "ruin_north",
  "ruin_deep",
  "finale",
];
const CHECKS = [
  "engine",
  "battle",
  "world",
  "tap",
  "art",
  "content",
  "bosses",
  "full",
  ...REGIONS.map((r) => `region_${r}`),
  ...REGIONS.map((r) => `playthrough_${r}`),
];

type Run = {
  path: string;
  world: WorldConfig;
  monitors: MonitorSpec[];
  timeScale?: number;
  computerSpaceLimit?: number;
  timeoutMs: number;
};

const RUNS: Run[] = [
  { path: `${DIR}/play.test.lua`, ...plain, timeScale: 4, timeoutMs: 400000 },
  {
    path: `${DIR}/detector.test.lua`,
    ...detector,
    timeScale: 4,
    timeoutMs: 300000,
  },
  {
    path: `${DIR}/install.test.lua`,
    // only the installed game and this test on the computer, on CC:Tweaked's own default disk
    world: {
      ...plain.world,
      deploy: [
        { from: `${DIR}/install`, to: `${DIR}/install` },
        { from: `${DIR}/install.test.lua`, to: `${DIR}/install.test.lua` },
      ],
    },
    monitors: plain.monitors,
    timeScale: 4,
    computerSpaceLimit: 1_000_000,
    timeoutMs: 300000,
  },
  ...CHECKS.map((name) => ({
    path: `${DIR}/tests/${name}.test.lua`,
    ...plain,
    timeoutMs: name === "full" ? 1500000 : 900000,
  })),
];

describe.skipIf(!ready).concurrent("BLIGHTMARE", () => {
  // install/ is built once, before the install test copies it
  const built = import(pathToFileURL(join(GAME, "build.mjs")).href).then(
    (m: { build: (out?: string, o?: { quiet?: boolean }) => number }) =>
      m.build(undefined, { quiet: true }),
  );

  for (const run of RUNS) {
    it(run.path, { timeout: run.timeoutMs + 60000 }, async () => {
      if (run.path.endsWith("install.test.lua"))
        expect(await built).toBeLessThan(1_000_000);
      const result = await runTests(
        config,
        {
          paths: [run.path],
          world: run.world,
          monitors: run.monitors,
          timeScale: run.timeScale,
          computerSpaceLimit: run.computerSpaceLimit,
          timeoutMs: run.timeoutMs,
        },
        1,
      );
      const file = result.files[0]!;
      const failures = file.tests
        .filter((t) => !t.passed)
        .map((t) => `${t.name}: ${t.error}`);
      // the screen it ended on, for a file that did not pass (a crash has no failures to show)
      expect({
        status: file.status,
        failures,
        ran: file.tests.length > 0,
        terminal: file.terminal,
      }).toEqual({
        status: "passed",
        failures: [],
        ran: true,
        terminal: undefined,
      });
    });
  }
});
