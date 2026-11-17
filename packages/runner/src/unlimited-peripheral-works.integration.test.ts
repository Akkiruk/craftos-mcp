import {
  cpSync,
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
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  SessionManager,
  checkConfig,
  loadConfig,
  runTests,
  sendAndWait,
  worldJson,
} from "./index.js";

/**
 * UnlimitedPeripheralWorks 1.9.2 (1.20.1 and 1.21.1), checked against behaviour read from the mod's source (tags
 * v1.20.1-1.9.2 and v1.21.1-1.9.2, and Minecraft-Modding-Libs at Tweakium 1.4.10). docs/unlimited-peripheral-works.md
 * has the source for every rule. The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "upw-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const EXAMPLE = "examples/unlimited-peripheral-works";

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

cpSync(join(base.workspaceDir, EXAMPLE), join(scratch, EXAMPLE), {
  recursive: true,
});

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const exampleWorld = JSON.parse(
  readFileSync(join(scratch, EXAMPLE, "ore_survey.world.json"), "utf8"),
) as WorldConfig;

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

type Dict = Record<string, unknown>;

describe.skipIf(!ready)("UnlimitedPeripheralWorks", () => {
  for (const version of ["1.20.1", "1.21.1"]) {
    it(`the example and every method on ${version}`, async () => {
      const result = await runTests(
        config,
        {
          paths: [`${EXAMPLE}/ore_survey.test.lua`],
          world: { ...exampleWorld, version } as WorldConfig,
          timeScale: 10,
          timeoutMs: 120000,
        },
        1,
      );
      expectAllPassed(result);
    }, 180000);
  }

  it("has no release for the emulator's 1.18.2 (Forge)", () => {
    expect(() =>
      worldJson({
        ...exampleWorld,
        version: "1.18.2",
      } as WorldConfig),
    ).toThrow(/no release for Minecraft 1\.18\.2/);
  });

  it("blocks set by a sim command show up in a scan, and state.json shows each block", async () => {
    const world: WorldConfig = {
      version: "1.20.1",
      simProgram: true,
      addons: ["unlimited-peripheral-works"],
      upw: {},
      peripherals: [
        { name: "scanner", type: "universal_scanner", x: 10, y: 70, z: 10 },
        { name: "beacon", type: "minecraft:beacon", levels: 1 },
      ],
    } as WorldConfig;
    put(
      "upw-scan.test.lua",
      `
local s = peripheral.wrap("scanner")
ccunit.test("a block placed by a sim command is found, north of a north-facing scanner", function()
  ccunit.eq(s.scan("block", 4), {})
  os.queueEvent("ccsim_cmd", "sim:1:" .. os.epoch("utc"), textutils.serializeJSON({
    cmd = "upwSetBlock", x = 10, y = 71, z = 8, name = "minecraft:gold_block" }))
  sleep(0.6)
  local found = s.scan("block", 4)
  ccunit.eq(#found, 1)
  ccunit.eq({ found[1].name, found[1].x, found[1].y, found[1].z }, { "minecraft:gold_block", 2, 1, 0 })
end)
`,
    );
    expectAllPassed(
      await runTests(config, { paths: ["upw-scan.test.lua"], world }, 1),
    );

    const manager = new SessionManager(config);
    const session = manager.create([], 1, world);
    try {
      await session.handle.session.waitForText(">", 0, 20000);
      const send = async (c: Dict): Promise<SimState> => {
        expect(
          await sendAndWait(session.handle, c as unknown as SimCommand),
        ).toBe(true);
        return session.handle.readState()!;
      };
      await send({
        cmd: "upwSetBlock",
        x: 11,
        y: 70,
        z: 9,
        name: "minecraft:gold_block",
      });
      const st = await send({
        cmd: "upwSetBeacon",
        peripheral: "beacon",
        levels: 3,
      });
      const peripherals = st.peripherals as Record<string, Dict>;
      expect(peripherals["beacon"]!["levels"]).toBe(3);
      expect(peripherals["scanner"]).toBeDefined();
    } finally {
      await manager.destroyAll();
    }
  }, 120000);
});
