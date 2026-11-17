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
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
  sendAndWait,
  SessionManager,
} from "./index.js";

/**
 * Plethora Peripherals, written from SwitchCraftCC/Plethora-Fabric at 30c2b5d (1.20.1-1.13.0). docs/plethora.md has
 * the source of every rule. The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "plethora-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(base).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
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

type Dict = Record<string, unknown>;

/** An independent port of java.util.HashSet<Identifier>'s iteration order (16 buckets). */
function hashSetOrder(ids: string[]): string[] {
  const strHash = (s: string): number => {
    let h = 0;
    for (let i = 0; i < s.length; i++)
      h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return h;
  };
  const idHash = (id: string): number => {
    const [ns, path] = id.split(":") as [string, string];
    return (Math.imul(31, strHash(ns)) + strHash(path)) | 0;
  };
  return ids
    .map((id, i) => {
      const h = idHash(id);
      return { id, i, b: (h ^ (h >>> 16)) & 15 };
    })
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.id);
}

const w120 = (extra: Record<string, unknown>): WorldConfig =>
  ({
    version: "1.20.1",
    addons: ["plethora"],
    simProgram: true,
    ...extra,
  }) as WorldConfig;

describe.skipIf(!ready)("Plethora Peripherals", () => {
  for (const example of ["ore_hud", "manipulator"]) {
    it(`the example: ${example}.test.lua against ${example}.world.json`, async () => {
      const test = `examples/plethora/${example}.test.lua`;
      const world = JSON.parse(
        readFileSync(
          join(base.workspaceDir, test.replace(/\.test\.lua$/, ".world.json")),
          "utf8",
        ),
      ) as WorldConfig;
      expectAllPassed(
        await runTests(base, { paths: [test], world, timeoutMs: 120000 }, 1),
      );
    }, 150000);
  }

  it("listModules on a neural interface walks a HashSet<Identifier>", async () => {
    const sets = [
      [
        "plethora:laser",
        "plethora:scanner",
        "plethora:sensor",
        "plethora:introspection",
        "plethora:kinetic",
      ],
      ["plethora:glasses", "plethora:keyboard", "plethora:sensor"],
      ["plethora:kinetic", "plethora:laser"],
    ];
    const checks = sets
      .map(
        (s, i) => `
  sim({ cmd = "plethoraSetModules", peripheral = "back", modules = textutils.unserializeJSON(${JSON.stringify(JSON.stringify(s))}) })
  ccunit.eq(peripheral.call("back", "listModules"), textutils.unserializeJSON(${JSON.stringify(JSON.stringify(hashSetOrder(s)))}), "set ${i}")`,
      )
      .join("\n");
    expectAllPassed(
      await lua(
        `
local simCount = 0
function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  os.queueEvent("sim_done")
  os.pullEvent("sim_done")
end
ccunit.test("orders", function()
${checks}
end)
`,
        w120({
          players: [{ name: "Steve", x: 0.5, y: 64, z: 0.5 }],
          peripherals: [
            {
              name: "back",
              type: "neuralInterface",
              modules: ["plethora:sensor"],
            },
          ],
        }),
        "order.lua",
      ),
    );
  }, 60000);

  it("a scanner turtle upgrade: named after the module, centred on the turtle as it moves", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("turtle scanner", function()
  ccunit.eq(peripheral.getType("left"), "plethora:scanner")
  ccunit.eq(peripheral.getMethods("left"), { "listModules", "hasModule", "filterModules", "scan", "getBlockMeta", "getDocs" })
  local s = peripheral.wrap("left")
  ccunit.eq(s.listModules(), { "plethora:scanner" })
  ccunit.eq(s.getBlockMeta(0, 0, -2).name, "minecraft:gold_block")
  ccunit.eq(s.getBlockMeta(0, 0, 0).name, "computercraft:turtle_normal")
  ccunit.truthy(turtle.forward())
  ccunit.eq(s.getBlockMeta(0, 0, -1).name, "minecraft:gold_block")
  ccunit.eq(s.getBlockMeta(0, 0, 1).name, "minecraft:air")
  ccunit.eq(err(s.getBlockMeta, 0, 0, 9), "Z coordinate out of bounds (between -8 and 8)")
end)
`,
        w120({
          plethora: {},
          turtle: {
            x: 0,
            y: 64,
            z: 0,
            facing: "north",
            fuel: 100,
            left: "plethora:module_scanner",
          },
          ground: { y: 63, name: "minecraft:stone" },
          blocks: [{ x: 0, y: 64, z: -2, name: "minecraft:gold_block" }],
        }),
        "turtle.lua",
      ),
    );
  }, 60000);

  it("sim state shows the canvas, lasers in flight and launches", async () => {
    const world = w120({
      players: [{ name: "Steve", x: 0.5, y: 64, z: 0.5 }],
      ground: { y: 40, name: "minecraft:stone" },
      peripherals: [
        {
          name: "back",
          type: "neuralInterface",
          modules: [
            "plethora:glasses",
            "plethora:laser",
            "plethora:kinetic",
            "plethora:sensor",
            "plethora:introspection",
          ],
        },
      ],
    });
    put(
      "state.lua",
      `
local ni = peripheral.wrap("back")
local c = ni.canvas()
c.addText({ 10, 20 }, "HUD", 0x00FF00FF)
c.addRectangle(1, 2, 3, 4)
ni.launch(90, 0, 2)
ni.fire(0, 0, 1)
print("ready")
while true do sleep(1) end
`,
    );
    const manager = new SessionManager(config);
    const s = manager.create([], 1, world);
    try {
      await s.handle.session.waitForText(">", 0, 20000);
      s.handle.session.typeLine("state");
      await s.handle.session.waitForText("ready", 0, 30000);
      expect(
        await sendAndWait(s.handle, {
          cmd: "plethoraSetPlayer",
          player: "Steve",
          food: 3,
        } as unknown as SimCommand),
      ).toBe(true);
      const st = s.handle.readState()! as SimState & {
        addons?: Record<string, Dict>;
      };
      const back = (st.peripherals as Record<string, Dict>)["back"]!;
      const canvas = back["canvas"] as Dict[];
      expect(canvas.map((o) => [o["id"], o["type"], o["parent"]])).toEqual([
        [2, "Text2d", 0],
        [3, "Rectangle2d", 0],
      ]);
      expect(canvas[0]!["text"]).toBe("HUD");
      expect(canvas[0]!["colour"]).toBe(0x00ff00ff);
      // 250 to start: the launch cost 20 (power 2 x 10), the laser 10 (potency 1 x 10), then 10 a tick back
      expect(back["energy"]).toBeGreaterThan(219);
      const addon = st.addons!["plethora"]!;
      const launches = addon["launches"] as Dict[];
      expect(launches).toHaveLength(1);
      // yaw 90 is west: MathHelper's float sine table, the y scaled by 0.5
      expect(launches[0]!["x"]).toBeCloseTo(-2, 5);
      expect(launches[0]!["y"]).toBeCloseTo(0, 5);
      const players = addon["players"] as Record<string, Dict>;
      expect(Object.values(players)[0]!["food"]).toBe(3);
    } finally {
      await manager.destroyAll();
    }
  }, 90000);

  it("a world with the addon off is refused, and 1.18.2 has no release", async () => {
    put("noop.test.lua", `ccunit.test("x", function() end)`);
    await expect(
      runTests(
        config,
        {
          paths: ["noop.test.lua"],
          world: {
            version: "1.20.1",
            addons: [],
            peripherals: [{ name: "m", type: "manipulator" }],
          } as WorldConfig,
        },
        1,
      ),
    ).rejects.toThrow(/Plethora Peripherals \(addon "plethora"\)/);
    await expect(
      runTests(
        config,
        {
          paths: ["noop.test.lua"],
          world: { version: "1.18.2", addons: ["plethora"] } as WorldConfig,
        },
        1,
      ),
    ).rejects.toThrow(/no release for Minecraft 1.18.2/);
  }, 60000);
});
