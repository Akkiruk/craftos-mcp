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
  type MonitorSpec,
  SessionManager,
  type WorldConfig,
  checkConfig,
  loadConfig,
  readResultFile,
  runTests,
} from "./index.js";

/**
 * The versus cabinet in workspace/examples/games/versus/: Paddle, Trails and Artillery, two players on two computers,
 * each with its own 6x6 monitor, linked by wireless modems. Each network test starts two computers in range of each
 * other: "north" runs the game's ccunit test as player 1, and "south" runs peer.lua, the cabinet with a stand-in
 * player 2 that reports what its own wall shows. computer.test.lua runs one cabinet alone, against the computer.
 */
const config = loadConfig();
const ready = checkConfig(config).length === 0;
const DIR = "examples/games/versus";

const { monitors, ...world } = JSON.parse(
  readFileSync(join(config.workspaceDir, DIR, "versus.world.json"), "utf8"),
) as WorldConfig & { monitors: MonitorSpec[] };

interface Results {
  tests: { name: string; passed: boolean; error?: string }[];
}

const scratch = mkdtempSync(join(tmpdir(), "games-versus-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A computer's own copy of the cabinet, with a startup file. */
function workspaceFor(name: string, startup: string): string {
  const dir = join(scratch, name);
  cpSync(join(config.workspaceDir, DIR), join(dir, DIR), { recursive: true });
  writeFileSync(join(dir, "startup.lua"), startup);
  return dir;
}

/** Each computer at its own place, ten blocks apart, well within a wireless modem's range. */
const place = (id: number, x: number): WorldConfig => ({
  ...world,
  computerId: id,
  seed: id, // rednet numbers its messages with math.random, so every computer needs its own seed
  position: { x, y: 70, z: 0 },
});

describe.skipIf(!ready).concurrent("versus games", () => {
  it(`${DIR}/computer.test.lua`, async () => {
    const result = await runTests(
      config,
      {
        paths: [`${DIR}/computer.test.lua`],
        world,
        monitors,
        timeoutMs: 110000,
      },
      1,
    );
    const file = result.files[0]!;
    const failures = file.tests
      .filter((t) => !t.passed)
      .map((t) => `${t.name}: ${t.error}`);
    expect({ status: file.status, failures }).toEqual({
      status: "passed",
      failures: [],
    });
  }, 120000);

  for (const game of ["paddle", "trails", "artillery"]) {
    it(`${DIR}/${game}.test.lua (two computers)`, async () => {
      const test = `
_G.ccunit = dofile("/ccunit/ccunit.lua")
local ok, err = pcall(shell.run, "${DIR}/${game}.test.lua")
if not ok then ccunit.test("load", function() error(err, 0) end) end
ccunit.finish()`;
      const manager = new SessionManager(config);
      try {
        const { computers } = manager.createNetwork({
          computers: [
            {
              name: "north",
              world: place(1, 0),
              monitors,
              workspaceDir: workspaceFor(`${game}-north`, test),
            },
            {
              name: "south",
              world: place(2, 10),
              monitors,
              workspaceDir: workspaceFor(
                `${game}-south`,
                `shell.run("${DIR}/peer.lua")`,
              ),
            },
          ],
        });
        const north = computers["north"]!.handle;
        await north.session.waitForExit(170000);
        const results = readResultFile<Results>(
          north.resultsDir,
          "results.json",
        );
        const failures = (results?.tests ?? [])
          .filter((t) => !t.passed)
          .map((t) => `${t.name}: ${t.error}`);
        expect({ ran: (results?.tests.length ?? 0) >= 4, failures }).toEqual({
          ran: true,
          failures: [],
        });
      } finally {
        await manager.destroyAll();
      }
    }, 180000);
  }
});
