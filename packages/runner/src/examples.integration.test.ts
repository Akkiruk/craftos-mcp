import {
  cpSync,
  existsSync,
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
  readResultFile,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

/**
 * The example programs in workspace/examples/<topic>/: each has a world next to it (<name>.world.json) and a
 * <name>.test.lua that runs the program itself against that world.
 */
const config = loadConfig();
const ready = checkConfig(config).length === 0;

// The GPU's fonts are built from the mod's jar (scripts/build-toms-fonts.mjs), so a fresh checkout may not have them
const fonts = existsSync(
  join(
    config.romDir,
    "rom",
    "ccsim",
    "addons",
    "toms-peripherals",
    "fonts.lua",
  ),
);

interface Example {
  /** Needs something this checkout may lack. */
  skip?: boolean;
  /** Path of the test, relative to the workspace. */
  test: string;
  monitors?: MonitorSpec[];
  /** Virtual seconds per real second. */
  timeScale?: number;
  timeoutMs?: number;
}

const examples: Example[] = [
  {
    test: "examples/mekanism/reactor.test.lua",
    monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
    // the controller must see each step of the heat-up: a faster clock lets a starved host skip past the scram point
    timeScale: 5,
  },
  {
    test: "examples/create/train_board.test.lua",
    monitors: [{ name: "top", blocksWide: 6, blocksHigh: 2 }],
    timeScale: 20,
  },
  {
    test: "examples/toms-peripherals/gpu_demo.test.lua",
    skip: !fonts,
    timeScale: 2,
  },
  {
    test: "examples/power/power_monitor.test.lua",
    monitors: [{ name: "top", blocksWide: 4, blocksHigh: 3 }],
    timeScale: 20,
  },
  {
    test: "examples/extreme-reactors/rod_controller.test.lua",
    monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
    timeScale: 20,
  },
  {
    test: "examples/advanced-peripherals/greeter.test.lua",
    timeScale: 20,
  },
];

function worldOf(test: string): WorldConfig {
  const file = join(
    config.workspaceDir,
    test.replace(/\.test\.lua$/, ".world.json"),
  );
  return JSON.parse(readFileSync(file, "utf8")) as WorldConfig;
}

describe.skipIf(!ready)("example programs", () => {
  for (const example of examples) {
    it.skipIf(example.skip === true)(
      example.test,
      async () => {
        const result = await runTests(
          config,
          {
            paths: [example.test],
            world: worldOf(example.test),
            monitors: example.monitors,
            timeScale: example.timeScale,
            timeoutMs: example.timeoutMs ?? 90000,
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
        }).toEqual({
          status: "passed",
          failures: [],
          terminal: undefined,
        });
      },
      120000,
    );
  }
});

/**
 * The rednet chat needs two computers: alice runs the ccunit test, bob runs chat.peer.lua. Each gets its own copy of
 * the example and a startup file, then the two modems reach each other like real wireless modems.
 */
describe.skipIf(!ready)("rednet chat (two computers)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "examples-chat-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function workspaceFor(name: string, startup: string): string {
    const dir = join(scratch, name);
    cpSync(
      join(config.workspaceDir, "examples", "rednet"),
      join(dir, "examples", "rednet"),
      { recursive: true },
    );
    writeFileSync(join(dir, "startup.lua"), startup);
    return dir;
  }

  const world = (id: number, x: number): WorldConfig => ({
    computerId: id,
    seed: id, // rednet numbers its messages with math.random, so every computer needs its own seed
    position: { x, y: 70, z: 0 },
    peripherals: [{ name: "top", type: "modem" }],
  });

  it("examples/rednet/chat.test.lua", async () => {
    const test = `
_G.ccunit = dofile("/ccunit/ccunit.lua")
local ok, err = pcall(shell.run, "examples/rednet/chat.test.lua")
if not ok then ccunit.test("load", function() error(err, 0) end) end
ccunit.finish()`;
    const manager = new SessionManager(config);
    try {
      const { computers } = manager.createNetwork({
        timeScale: 10,
        computers: [
          {
            name: "alice",
            world: world(1, 0),
            workspaceDir: workspaceFor("alice", test),
          },
          {
            name: "bob",
            world: world(2, 10),
            workspaceDir: workspaceFor(
              "bob",
              'shell.run("examples/rednet/chat.peer.lua")',
            ),
          },
        ],
      });
      const alice = computers["alice"]!.handle;
      await alice.session.waitForExit(90000);
      const results = readResultFile<{
        tests: { name: string; passed: boolean; error?: string }[];
        failed: number;
      }>(alice.resultsDir, "results.json");
      const failures = (results?.tests ?? [])
        .filter((t) => !t.passed)
        .map((t) => `${t.name}: ${t.error}`);
      expect({ ran: (results?.tests.length ?? 0) >= 5, failures }).toEqual({
        ran: true,
        failures: [],
      });
    } finally {
      await manager.destroyAll();
    }
  }, 120000);
});
