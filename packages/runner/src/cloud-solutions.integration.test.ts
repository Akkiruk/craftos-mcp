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
  runProgram,
  runTests,
  worldJson,
} from "./index.js";

/**
 * SirEdvin's Cloud Solutions 0.3.4 (1.20.1 and 1.21.1), checked against behaviour read from the mod's source (tags
 * v1.20.1-0.3.4 and v1.21.1-0.3.4). docs/cloud-solutions.md has the source for every rule. The mod is not in the
 * pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "cs-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const EXAMPLE = "examples/cloud-solutions";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

cpSync(join(base.workspaceDir, EXAMPLE), join(scratch, EXAMPLE), {
  recursive: true,
});

const exampleWorld = JSON.parse(
  readFileSync(join(scratch, EXAMPLE, "scoreboard.world.json"), "utf8"),
) as WorldConfig;

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

describe.skipIf(!ready)("Cloud Solutions", () => {
  for (const version of ["1.20.1", "1.21.1"]) {
    it(`the example and every method on ${version}`, async () => {
      const result = await runTests(
        config,
        {
          paths: [`${EXAMPLE}/scoreboard.test.lua`],
          world: { ...exampleWorld, version } as WorldConfig,
          timeScale: 1,
          timeoutMs: 120000,
        },
        1,
      );
      expectAllPassed(result);
    }, 180000);
  }

  it("StatsD with the connection on: the lines it sends, and the rate limits", async () => {
    writeFileSync(
      join(scratch, "cs-statsd.lua"),
      `
local s = peripheral.wrap("statsd")
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then return "ok" end
  return (tostring(e):gsub("^[^:]*:%d+: ", ""))
end
print("first " .. err(s.count, "jumps", 3))
sleep(0.1) s.gauge("power", -5)
sleep(0.1) s.delta("power", 2)
sleep(0.1) s.set("users", "Alex")
sleep(0.1) s.time("tick", 12)
sleep(0.1)
-- a burst: the limiters start empty and the player's gives one permit every 60 ms, so most of these are refused
local refused = {}
for i = 1, 10 do
  local e = err(s.count, "burst", 1)
  if e ~= "ok" then refused[e] = true end
end
for e in pairs(refused) do print("refused " .. e) end
os.queueEvent("ccsim_cmd", "sim:1:" .. os.epoch("utc"), textutils.serializeJSON({ cmd = "csSetOwnerOnline", online = false }))
sleep(0.1)
print("offline " .. err(s.count, "jumps", 1))
`,
    );
    const world = {
      version: "1.20.1",
      simProgram: true,
      addons: ["cloud-solutions"],
      cloudSolutions: {
        ownerName: "Steve",
        config: { enableStatsDConnection: true, statsdPrefix: "mc" },
      },
      peripherals: [{ name: "statsd", type: "statsd_bridge" }],
    } as unknown as WorldConfig;
    const result = await runProgram(config, {
      program: "cs-statsd.lua",
      world,
      timeoutMs: 60000,
    });
    const screen = result.screens[0]!.lines.join("\n");
    expect(screen).toContain("first ok");
    // which limiter says no first depends on the wall clock (the global one gives a permit every 2.9 ms)
    expect(screen).toMatch(
      /refused Too many (request from you|requests to server), please wait a/,
    );
    expect(screen).toContain("offline Cannot find owner");
    const addons = (
      result.sim as { addons?: Record<string, { statsd?: string[] }> }
    ).addons!;
    expect(addons["cloud-solutions"]!.statsd!.slice(0, 6)).toEqual([
      "mc.Steve.jumps:3|c",
      "mc.Steve.power:0|g",
      "mc.Steve.power:-5|g",
      "mc.Steve.power:+2|g",
      "mc.Steve.users:Alex|s",
      "mc.Steve.tick:12|ms",
    ]);
  }, 120000);

  it("exists on 1.20.1 and 1.21.1 only", () => {
    expect(() =>
      worldJson({ ...exampleWorld, version: "1.18.2" } as WorldConfig),
    ).toThrow(/no release for Minecraft 1\.18\.2/);
  });
});
