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
  checkWorldAddons,
  loadConfig,
  resolveAddons,
  runTests,
} from "./index.js";

/**
 * CC: Link 6.2.1 (Forge 1.20.1), written from minecraftbossdj/CC-Link at b24e027 and checked against the 6.2.1 jar.
 * docs/cc-link.md has the source of every rule. The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "cclink-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(base).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  sleep(0.2)
end
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

const world = (
  ccLink: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["cc-link"],
    simProgram: true,
    ccLink,
    ...extra,
  }) as WorldConfig;

describe("CC: Link addon registry", () => {
  it("exists on 1.20.1 only", () => {
    expect(resolveAddons(["cc-link"], {}, "1.20.1")).toEqual(["cc-link"]);
    expect(() => resolveAddons(["cc-link"], {}, "1.18.2")).toThrow(
      /no release for Minecraft 1.18.2/,
    );
    expect(resolveAddons("all", {}, "1.18.2")).not.toContain("cc-link");
  });
  it("a world using it fails cleanly when the addon is off", () => {
    expect(() =>
      checkWorldAddons(
        { peripherals: [{ name: "back", type: "link_armor" }] },
        [],
        "1.20.1",
      ),
    ).toThrow(/CC: Link \(addon "cc-link"\)/);
    expect(() =>
      checkWorldAddons({ ccLink: { core: "link" } }, [], "1.20.1"),
    ).toThrow(/world.ccLink/);
  });
});

describe.skipIf(!ready)("CC: Link", () => {
  it("the example: hud.lua against hud.world.json, and every function", async () => {
    const test = "examples/cc-link/hud.test.lua";
    const w = JSON.parse(
      readFileSync(
        join(base.workspaceDir, test.replace(/\.test\.lua$/, ".world.json")),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await runTests(
      base,
      { paths: [test], world: w, timeoutMs: 120000 },
      1,
    );
    expectAllPassed(result);
  }, 150000);

  it("the Integrated Link core: its own link API, a position in getInfo, reach 10, no inventory functions", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("integrated", function()
  local info = link.getInfo()
  ccunit.eq({ info.x, info.y, info.z }, { 10, 70, -4 })
  ccunit.eq(link.list, nil)
  ccunit.eq(link.getSlot, nil)
  ccunit.eq(link.moveItem, nil)
  local names = {}
  for k in pairs(link) do names[#names + 1] = k end
  table.sort(names)
  ccunit.eq(names, { "consume", "getInfo", "getUpgradeFunctions", "hasUpgrade", "listUpgrades", "lookAt", "lookAtBlock",
    "raycastBlock", "raycastEntity", "swingMainHand" })
  -- a pig 8 blocks ahead (south): out of a Link core's reach of 5, inside the Integrated one's 10
  local e = link.raycastEntity(20)
  ccunit.eq(e.id, "minecraft:pig")
  ccunit.eq(e.x, 10.5) -- not floored on the Integrated core
  ccunit.eq(link.getUpgradeFunctions().world.getDimension(), "minecraft:the_nether")
end)
`,
        world(
          {
            core: "integrated",
            upgrades: ["cclink:world_upgrade"],
            player: {
              name: "Ivy",
              x: 10.5,
              y: 70,
              z: -3.5,
              dimension: "minecraft:the_nether",
            },
          },
          {
            entities: [
              {
                type: "minecraft:pig",
                x: 10.5,
                y: 70.5,
                z: 4.5,
                dimension: "minecraft:the_nether",
              },
            ],
          },
        ),
        "integrated.lua",
      ),
    );
  }, 60000);

  it("upgrade tables of the wrong family, and the armor without a Link core, throw a NullPointerException", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("no core", function()
  ccunit.eq(link, nil)
  local f = peripheral.call("back", "getArmorFunctions")
  ccunit.eq(err(f.sensor.sense, 4), "Java Exception Thrown: java.lang.NullPointerException")
  ccunit.eq({ peripheral.call("back", "listUpgrades") }, { true, { "cclink:sensor_upgrade" } })
end)
`,
        world(
          {
            core: "none",
            player: {
              name: "Nia",
              inventory: {
                "38": {
                  name: "cclink:link_chestplate",
                  modules: ["cclink:sensor_upgrade"],
                },
              },
            },
          },
          { peripherals: [{ name: "back", type: "link_armor" }] },
        ),
        "nocore.lua",
      ),
    );
  }, 60000);

  it("link_turtle on a Link Turtle", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("link_turtle", function()
  ccunit.eq(link, nil)
  ccunit.eq(link_turtle.getDirection(), "east")
  ccunit.eq(link_turtle.raycast(5), { id = "minecraft:stone", x = 3, y = 64, z = 0, distance = 3 })
  ccunit.eq(link_turtle.raycast(2), {})
  ccunit.eq(link_turtle.raycastUp(1), { id = "minecraft:dirt", x = 0, y = 65, z = 0, distance = 1 })
  ccunit.eq(link_turtle.raycastDown(9).id, "minecraft:grass_block")
  ccunit.eq(err(link_turtle.raycast), "bad argument #1 (number expected, got nil)")
  local list = link_turtle.list()
  ccunit.eq(#list, 16)
  ccunit.eq(list[1].name, "minecraft:coal")
  ccunit.eq(list[1].slot, 1)
  ccunit.eq(list[2], {})
  turtle.turnLeft()
  ccunit.eq(link_turtle.getDirection(), "north")
end)
`,
        world(
          { core: "turtle" },
          {
            turtle: {
              x: 0,
              y: 64,
              z: 0,
              facing: "east",
              inventory: { "1": { name: "minecraft:coal", count: 5 } },
            },
            ground: {
              y: 63,
              name: "minecraft:stone",
              top: "minecraft:grass_block",
            },
            blocks: [
              { x: 3, y: 64, z: 0, name: "minecraft:stone" },
              { x: 0, y: 65, z: 0, name: "minecraft:dirt" },
            ],
          },
        ),
        "turtle.lua",
      ),
    );
  }, 60000);
});
