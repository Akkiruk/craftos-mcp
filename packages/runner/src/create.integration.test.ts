import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  loadNamedWorld,
  runTests,
  sendAndWait,
  SessionManager,
} from "./index.js";

// Every surface here was read off the 1.18.2 jars (Create 0.5.1, Crafts & Additions 1.0.0), and on 1.20.1 and 1.21.1
// CC's own redstone_relay takes the type name Crafts & Additions' relay has here: this file runs on 1.18.2 whatever the
// default version is.
beforeAll(() => {
  vi.stubEnv("CRAFTOS_VERSION", "1.18.2");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/**
 * Create 0.5.1.i and Create Crafts & Additions 1.0.0, checked against the behaviour read from their source at the
 * commits the pack's jars were built from (docs/create.md and docs/create-additions.md give the line for each rule).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "create-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

// err() runs a call and returns its message without the position
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
  timeScale?: number,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(
    config,
    { paths: [name], world, timeoutMs: 60000, timeScale },
    1,
  );
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

/** Run an idle session and step it with sim commands; each step returns the state after the command. */
async function withSession(
  w: WorldConfig,
  run: (
    step: (c: { cmd: string; [k: string]: unknown }) => Promise<SimState>,
    program: (name: string, done: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    const raw = s.handle.session;
    await raw.waitForText(">", 0, 20000);
    await run(
      async (c) => {
        expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
          true,
        );
        return s.handle.readState()!;
      },
      async (name, done) => {
        raw.typeLine(name);
        try {
          await raw.waitForText(done, 0, 20000);
        } catch (error) {
          const screen = (manager.screens(s.id)[0]?.lines ?? []).join("\n");
          throw new Error(`${(error as Error).message}\n${screen}`);
        }
      },
    );
  } finally {
    await manager.destroyAll();
  }
}

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const periph = (state: SimState, name: string): Any =>
  (state.peripherals?.[name] ?? {}) as Any;
const createState = (state: SimState): Any =>
  ((state as Any)["addons"]?.create ?? {}) as Any;
const train = (state: SimState, name: string): Any =>
  (createState(state).trains as Any[]).find((t) => t.name === name)!;

const world = {
  create: {
    dayTime: 1000,
    stations: ["Mine", "Farm Stop"],
    distances: {
      "Central|Mine": 200,
      "Central|Farm Stop": 600,
      "Mine|Farm Stop": 500,
    },
    networks: {
      main: { speed: 64, capacity: 4096, impact: 8 },
      heavy: { speed: 32, capacity: 100, stress: 50, impact: 4 },
      geared: { source: "gear" },
      controlled: { source: "ctl" },
    },
    trains: [{ name: "Express", at: "Central" }],
  },
  peripherals: [
    { name: "station", type: "Create_Station", station: "Central" },
    {
      name: "depot",
      type: "Create_Station",
      station: "Depot",
      assembling: true,
      pending: { name: "Freight" },
    },
    { name: "loose", type: "Create_Station", track: false },
    { name: "speedo", type: "Create_Speedometer", network: "main" },
    { name: "overspeedo", type: "Create_Speedometer", network: "heavy" },
    { name: "outspeedo", type: "Create_Speedometer", network: "controlled" },
    { name: "stresso", type: "Create_Stressometer", network: "main" },
    { name: "overstresso", type: "Create_Stressometer", network: "heavy" },
    { name: "ctl", type: "Create_RotationSpeedController", network: "main" },
    { name: "gear", type: "Create_SequencedGearshift", network: "main" },
    { name: "link", type: "Create_DisplayLink", target: { type: "sign" } },
  ],
} as unknown as WorldConfig;

// ───────────── surface ─────────────

/** java.util.HashMap iteration order for String keys put in this order into new HashMap<>(initialCapacity). */
function javaHashMapOrder(keys: string[], initialCapacity: number): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 1;
  while (cap < initialCapacity) cap *= 2;
  let threshold = Math.floor(cap * 0.75);
  for (let size = 1; size <= keys.length; size++) {
    if (size > threshold) {
      cap *= 2;
      threshold = Math.floor(cap * 0.75);
    }
  }
  return keys
    .map((k, i) => ({ k, i, b: hash(k) & (cap - 1) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.k);
}

/** Every @LuaFunction of each peripheral class in the jars, in declaration order (javap -p). */
const surface = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./create-surface.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

const SURFACE_WORLD = {
  peripherals: Object.keys(surface).map((type) => ({
    name: `p_${type}`,
    type,
  })),
} as unknown as WorldConfig;

describe("Create method surface (no engine)", () => {
  it("lists the eleven peripheral types of the two jars", () => {
    expect(Object.keys(surface).sort()).toEqual(
      [
        "Create_DisplayLink",
        "Create_RotationSpeedController",
        "Create_SequencedGearshift",
        "Create_Speedometer",
        "Create_Station",
        "Create_Stressometer",
        "digital_adapter",
        "electric_motor",
        "modular_accumulator",
        "portable_energy_interface",
        "redstone_relay",
      ].sort(),
    );
    expect(surface["Create_Station"]).toHaveLength(14);
    expect(surface["digital_adapter"]).toHaveLength(21);
  });
});

describe.skipIf(!ready)("Create method surface", () => {
  it("getMethods is CC's HashMap order of the jar's methods; getType is the mod's type", async () => {
    const expected = Object.fromEntries(
      Object.entries(surface).map(([t, names]) => [
        t,
        javaHashMapOrder(names, names.length),
      ]),
    );
    const result = await lua(
      `
local expected = ${JSON.stringify(expected)
        .replace(/\[/g, "{")
        .replace(/\]/g, "}")
        .replace(/"(\w+)":/g, "$1 =")}
for ty, names in pairs(expected) do
  ccunit.test(ty, function()
    ccunit.eq(peripheral.getMethods("p_" .. ty), names)
    ccunit.eq({ peripheral.getType("p_" .. ty) }, { ty })
    ccunit.truthy(peripheral.find(ty), "find " .. ty)
  end)
end
ccunit.test("the electric motor answers getType itself", function()
  ccunit.eq(peripheral.call("p_electric_motor", "getType"), "electric_motor")
end)
`,
      SURFACE_WORLD,
      "surface.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── kinetics ─────────────

describe.skipIf(!ready)("Create kinetics", () => {
  it("gauges, overstress, the speed controller and its output network", async () => {
    const result = await lua(
      `
ccunit.test("speedometer and stressometer", function()
  ccunit.eq(peripheral.call("speedo", "getSpeed"), 64)
  ccunit.eq(peripheral.call("stresso", "getStress"), 512) -- impact 8 SU/RPM x 64 RPM
  ccunit.eq(peripheral.call("stresso", "getStressCapacity"), 4096)
end)

ccunit.test("an overstressed network stops, the stressometer still reads", function()
  ccunit.eq(peripheral.call("overspeedo", "getSpeed"), 0)
  ccunit.eq(peripheral.call("overstresso", "getStress"), 50 + 4 * 32)
  ccunit.eq(peripheral.call("overstresso", "getStressCapacity"), 100)
end)

ccunit.test("speed controller: default 16, clamped to the 256 RPM limit", function()
  local c = peripheral.wrap("ctl")
  ccunit.eq(c.getTargetSpeed(), 16)
  ccunit.eq(peripheral.call("outspeedo", "getSpeed"), 16)
  c.setTargetSpeed(300)
  ccunit.eq(c.getTargetSpeed(), 256)
  c.setTargetSpeed(-300)
  ccunit.eq(c.getTargetSpeed(), -256)
  c.setTargetSpeed(0)
  ccunit.eq(peripheral.call("outspeedo", "getSpeed"), 0)
  c.setTargetSpeed(48)
  ccunit.eq(peripheral.call("outspeedo", "getSpeed"), 48)
  ccunit.eq(err(c.setTargetSpeed, 0 / 0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(c.setTargetSpeed, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(c.setTargetSpeed), "bad argument #1 (number expected, got nil)")
end)
`,
      world,
      "kinetics.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── call timing ─────────────

describe.skipIf(!ready)("Create call timing", () => {
  it("main-thread methods wait a tick and lose events, the others answer at once", async () => {
    const result = await lua(
      `
local function survives(fn)
  os.queueEvent("probe_before")
  pcall(fn)
  os.queueEvent("probe_after")
  local kept = false
  while true do
    local ev = os.pullEvent()
    if ev == "probe_before" then kept = true end
    if ev == "probe_after" then break end
  end
  return kept
end

ccunit.test("which methods wait", function()
  local s, l, c, g = peripheral.wrap("station"), peripheral.wrap("link"), peripheral.wrap("ctl"), peripheral.wrap("gear")
  ccunit.eq(survives(function() s.getStationName() end), true)
  ccunit.eq(survives(function() s.isTrainPresent() end), true)
  ccunit.eq(survives(function() s.getSchedule() end), true)
  ccunit.eq(survives(function() s.setStationName("Central") end), false)
  ccunit.eq(survives(function() s.setSchedule("x") end), false) -- argument checks run on the server thread too
  ccunit.eq(survives(function() s.setAssemblyMode(false) end), false)
  ccunit.eq(survives(function() l.write("x") end), true)
  ccunit.eq(survives(function() l.getCursorPos() end), true)
  ccunit.eq(survives(function() l.getSize() end), false)
  ccunit.eq(survives(function() l.update() end), false)
  ccunit.eq(survives(function() c.getTargetSpeed() end), true)
  ccunit.eq(survives(function() c.setTargetSpeed(16) end), false)
  ccunit.eq(survives(function() g.isRunning() end), true)
  ccunit.eq(survives(function() g.rotate(1) end), false)
  ccunit.eq(survives(function() peripheral.call("speedo", "getSpeed") end), true)
  ccunit.eq(survives(function() peripheral.call("stresso", "getStress") end), true)
  local t0 = os.clock()
  for _ = 1, 4 do c.setTargetSpeed(16) end
  ccunit.truthy(os.clock() - t0 >= 0.2, "four calls take four ticks")
end)
`,
      world,
      "timing.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── sequenced gearshift ─────────────

describe.skipIf(!ready)("Create sequenced gearshift", () => {
  it("void methods return no values, getters exactly one", async () => {
    const result = await lua(
      `
ccunit.test("counts", function()
  local g = peripheral.wrap("gear")
  ccunit.eq(select("#", g.rotate(90)), 0)
  ccunit.eq(select("#", g.isRunning()), 1)
  sleep(0.5)
end)
`,
      world,
      "returns.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("rotate and move run for the time the source works out at the input speed", async () => {
    const result = await lua(
      `
ccunit.test("arguments", function()
  local g = peripheral.wrap("gear")
  ccunit.eq(err(g.rotate), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(g.rotate, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(g.rotate, 90, "fast"), "bad argument #2 (number expected, got string)")
  ccunit.eq(err(g.move, 1 / 0), "bad argument #1 (number expected, got inf)")
  ccunit.eq(err(g.rotate, 90, nil), "bad argument #2 (number expected, got nil)") -- count() sees the nil
  sleep(0.5)
end)

-- How long the gearshift runs, by polling until it stops. It can never stop early, so the lower bound is exact; a
-- loaded machine only makes the poll late, so the upper bound has slack.
local function runs(g, ticks)
  local start = os.epoch("utc")
  while g.isRunning() do sleep(0) end
  local ms = os.epoch("utc") - start
  ccunit.truthy(ms >= (ticks - 1) * 50, -- one tick of slack for where the poll lands in a tick
     ("stopped after %d ms, before %d ticks"):format(ms, ticks))
  ccunit.truthy(ms < ticks * 50 + 1500, ("still running %d ms after %d ticks"):format(ms - ticks * 50, ticks))
end

ccunit.test("rotate 90 at 64 RPM: ceil(90 / 19.2) + 2 = 7 ticks", function()
  local g = peripheral.wrap("gear")
  ccunit.eq(g.isRunning(), false)
  g.rotate(90)
  ccunit.eq(g.isRunning(), true)
  runs(g, 7 - 1) -- one tick already passed in the isRunning above
end)

ccunit.test("the output turns at the modifier while running", function()
  local g = peripheral.wrap("gear")
  g.rotate(-180, -2) -- angle is made positive, the modifier sets the direction and speed
  ccunit.eq(peripheral.call("speedo", "getSpeed"), 64)
  ccunit.eq(g.isRunning(), true)
  runs(g, 7 - 2) -- ceil(180 / 38.4) + 2 = 7 ticks, two already spent on the calls above
end)

ccunit.test("move 4 blocks at 64 RPM: ceil(4 / 0.125) + 2 = 34 ticks", function()
  local g = peripheral.wrap("gear")
  g.move(4)
  runs(g, 34 - 1)
end)

ccunit.test("an unknown modifier is FORWARD", function()
  local g = peripheral.wrap("gear")
  g.rotate(9, 7)
  ccunit.eq(g.isRunning(), true)
  runs(g, 3 - 1) -- ceil(9 / 19.2) + 2 = 3 ticks
end)
`,
      world,
      "gearshift.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("isRunning over the virtual clock, output speed in sim state, speed changes", async () => {
    put(
      "turn.lua",
      `peripheral.call("gear", "move", 10, 2) print("moving now")`,
    );
    put(
      "turn2.lua",
      `peripheral.call("gear", "move", 10) print("moving again")`,
    );
    put(
      "turn3.lua",
      `peripheral.call("gear", "rotate", 90) print("turning now")`,
    );
    put(
      "turn4.lua",
      `peripheral.call("gear", "rotate", 90) print("stalled turn")`,
    );
    await withSession(
      {
        create: { networks: { input: { speed: 32 }, out: { source: "gear" } } },
        peripherals: [
          { name: "gear", type: "Create_SequencedGearshift", network: "input" },
          { name: "out", type: "Create_Speedometer", network: "out" },
        ],
      } as unknown as WorldConfig,
      async (step, program) => {
        let state = await step({ cmd: "advance", seconds: 0.2 });
        expect(periph(state, "gear").running).toBe(false);
        expect(periph(state, "out").speed).toBe(0);
        // 10 blocks at 32 RPM x 2: 10 / (64 / 512) = 80 ticks, + 2
        await program("turn", "moving now");
        state = await step({ cmd: "advance", seconds: 0.05 });
        expect(periph(state, "gear")).toMatchObject({
          running: true,
          duration: 82,
          outputSpeed: 64,
        });
        expect(periph(state, "out").speed).toBe(64);
        state = await step({ cmd: "advance", seconds: 5 });
        expect(periph(state, "gear").running).toBe(false);
        expect(periph(state, "out").speed).toBe(0);
        // the input speeds up mid-way: the rest is worked out again at the new speed
        await program("turn2", "moving again");
        state = await step({ cmd: "advance", seconds: 2 }); // about 40 of 162 ticks at 32 RPM
        const progress = periph(state, "gear").progress as number;
        expect(progress).toBeGreaterThan(2);
        state = await step({
          cmd: "createSetSpeed",
          network: "input",
          speed: 64,
        });
        state = await step({ cmd: "advance", seconds: 0.05 });
        expect(periph(state, "gear").duration).toBeLessThan(162 - 30);
        state = await step({ cmd: "advance", seconds: 4 });
        expect(periph(state, "gear").running).toBe(false);
        // the input stops: the gearshift gives up
        await program("turn3", "turning now");
        state = await step({
          cmd: "createSetSpeed",
          network: "input",
          speed: 0,
        });
        state = await step({ cmd: "advance", seconds: 0.05 });
        expect(periph(state, "gear").running).toBe(false);
        // no input at all: the duration overflows and the gearshift waits for rotation, running
        await program("turn4", "stalled turn");
        state = await step({ cmd: "advance", seconds: 3 });
        expect(periph(state, "gear")).toMatchObject({
          running: true,
          duration: -2147483647,
        });
      },
    );
  }, 60000);
});

// ───────────── display link ─────────────

describe.skipIf(!ready)("Create display link", () => {
  const linkWorld = {
    create: { networks: { board: { speed: 0 } } },
    peripherals: [
      { name: "sign", type: "Create_DisplayLink", target: { type: "sign" } },
      {
        name: "board",
        type: "Create_DisplayLink",
        target: { type: "display_board", width: 3, height: 2 },
        line: 2,
      },
      {
        name: "still",
        type: "Create_DisplayLink",
        target: { type: "display_board", network: "board" },
      },
      {
        name: "book",
        type: "Create_DisplayLink",
        target: { type: "lectern", book: "writable" },
        line: 2,
      },
      {
        name: "nixie",
        type: "Create_DisplayLink",
        target: { type: "nixie_tube", tubes: 3 },
      },
      {
        name: "fresh",
        type: "Create_DisplayLink",
        target: "sign",
        restarted: true,
      },
      { name: "nothing", type: "Create_DisplayLink" },
      {
        name: "lit",
        type: "Create_DisplayLink",
        target: "sign",
        powered: true,
      },
    ],
  } as unknown as WorldConfig;

  it("void methods return no values, the others exactly what Java returns", async () => {
    const result = await lua(
      `
ccunit.test("counts", function()
  local l = peripheral.wrap("sign")
  ccunit.eq(select("#", l.write("a")), 0)
  ccunit.eq(select("#", l.clear()), 0)
  ccunit.eq(select("#", l.clearLine()), 0)
  ccunit.eq(select("#", l.setCursorPos(1, 1)), 0)
  ccunit.eq(select("#", l.getCursorPos()), 2)
  ccunit.eq(select("#", l.getSize()), 2)
  ccunit.eq(select("#", l.isColor()), 1)
  ccunit.eq(select("#", l.update()), 0)
end)
`,
      linkWorld,
      "returns.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("cursor, write, clear, sizes and errors", async () => {
    const result = await lua(
      `
ccunit.test("cursor and write", function()
  local l = peripheral.wrap("sign")
  ccunit.eq({ l.getCursorPos() }, { 1, 1 })
  l.write("Hello")
  ccunit.eq({ l.getCursorPos() }, { 6, 1 })
  l.setCursorPos(3, 3)
  l.write("ab")
  l.setCursorPos(2, 1)
  l.write("EY")
  ccunit.eq({ l.getCursorPos() }, { 4, 1 })
  ccunit.eq(l.isColor(), false)
  ccunit.eq(l.isColour(), false)
end)

ccunit.test("sizes are rows, then columns", function()
  ccunit.eq({ peripheral.call("sign", "getSize") }, { 4, 15 })
  ccunit.eq({ peripheral.call("board", "getSize") }, { 4, 13 }) -- 2 blocks high, (3 * 16 - 2) / 3.5 wide
  ccunit.eq({ peripheral.call("book", "getSize") }, { 50, 256 })
  ccunit.eq({ peripheral.call("nixie", "getSize") }, { 1, 6 })
end)

ccunit.test("no target yet: Create's NullPointerException", function()
  local e = err(peripheral.call, "fresh", "getSize")
  ccunit.truthy(e:find("^Java Exception Thrown: java.lang.NullPointerException"), e)
  ccunit.truthy(err(peripheral.call, "nothing", "getSize"):find("NullPointerException"))
  peripheral.call("fresh", "update")
  ccunit.eq({ peripheral.call("fresh", "getSize") }, { 4, 15 })
end)

ccunit.test("Java's errors for a cursor off the left or top", function()
  local l = peripheral.wrap("nixie")
  l.setCursorPos(0, 1)
  ccunit.eq(err(l.write, "abcd"), "Java Exception Thrown: java.lang.StringIndexOutOfBoundsException: start -1, end 0, length 0")
  l.setCursorPos(1, 0)
  ccunit.eq(err(l.write, "abcd"), "Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index -1 out of bounds for length 0")
  ccunit.eq(err(l.clearLine), "Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index -1 out of bounds for length 0")
  ccunit.eq(err(l.setCursorPos, -1 / 0, 1), "bad argument #1 (number expected, got -inf)") -- a fraction would be truncated (row 124)
  ccunit.eq(err(l.setCursorPos, 1), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(l.write), "bad argument #1 (string expected, got nil)")
  l.setCursorPos(1, 1)
  l.write("CC")
  l.update()
end)
`,
      linkWorld,
      "link.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("update sends the lines to the target; the sim state shows the result", async () => {
    put(
      "send.lua",
      `
local sign = peripheral.wrap("sign")
sign.write("Line one")
sign.setCursorPos(1, 3)
sign.write("Line three")
sign.setCursorPos(4, 1)
sign.write("_")
sign.update()
local board = peripheral.wrap("board")
board.write("Arrivals") board.setCursorPos(1, 2) board.write("Express 12:00")
board.update()
peripheral.call("still", "write", "x") peripheral.call("still", "update")
local book = peripheral.wrap("book")
book.write("page") book.update()
local nixie = peripheral.wrap("nixie")
nixie.write("42") nixie.setCursorPos(1, 2) nixie.write("ignored") nixie.update()
local lit = peripheral.wrap("lit")
lit.write("dark") lit.update()
print("all sent")
`,
    );
    await withSession(linkWorld, async (step, program) => {
      let state = await step({ cmd: "advance", seconds: 0.1 });
      expect(periph(state, "sign").target.lines).toEqual(["", "", "", ""]);
      await program("send", "all sent");
      state = await step({ cmd: "advance", seconds: 0.05 });
      const sign = periph(state, "sign");
      expect(sign.lines).toEqual(["Lin_ one", "", "Line three"]);
      expect(sign.target.lines).toEqual(["Lin_ one", "", "Line three", ""]);
      expect(sign.updates).toBe(1);
      // starts at line 2, clears the rows below the text, leaves row 1 alone
      expect(periph(state, "board").target.lines).toEqual([
        "",
        "Arrivals",
        "Express 12:00",
        "",
      ]);
      expect(periph(state, "still").target.lines).toEqual(["", ""]); // the board is not turning
      expect(periph(state, "book").target).toMatchObject({
        book: "written",
        pages: ["", "page"],
      });
      expect(periph(state, "nixie").target.text).toBe("42");
      expect(periph(state, "lit").target.lines).toEqual(["", "", "", ""]); // redstone holds the link
      expect(periph(state, "lit").lines).toEqual(["dark"]);
      // the link sends when the redstone goes off
      state = await step({
        cmd: "createSetLinkPowered",
        peripheral: "lit",
        powered: false,
      });
      expect(periph(state, "lit").target.lines).toEqual(["dark", "", "", ""]);
      // a new target
      state = await step({
        cmd: "createSetLinkTarget",
        peripheral: "lit",
        target: { type: "nixie_tube", tubes: 2 },
      });
      expect(periph(state, "lit").target).toMatchObject({
        type: "nixie_tube",
        rows: 1,
        columns: 4,
      });
      // the board turns: the next update reaches it
      state = await step({
        cmd: "createSetSpeed",
        network: "board",
        speed: 32,
      });
      expect(createState(state).networks.board.speed).toBe(32);
    });
  }, 60000);
});

// ───────────── train stations ─────────────

const stationWorld = {
  create: {
    stations: ["Mine", "Farm Stop"],
    distances: {
      "Central|Mine": 200,
      "Central|Farm Stop": 600,
      "Mine|Farm Stop": 500,
    },
    trains: [{ name: "Express", at: "Central" }],
  },
  peripherals: [
    { name: "station", type: "Create_Station", station: "Central" },
    {
      name: "depot",
      type: "Create_Station",
      station: "Depot",
      assembling: true,
      pending: { name: "Freight" },
    },
    {
      name: "empty",
      type: "Create_Station",
      station: "Siding",
      assembling: true,
    },
    { name: "loose", type: "Create_Station", track: false },
  ],
} as unknown as WorldConfig;

describe.skipIf(!ready)("Create station", () => {
  it("names, the present train, errors off the track", async () => {
    const result = await lua(
      `
ccunit.test("a station with a train", function()
  local s = peripheral.wrap("station")
  ccunit.eq(s.getStationName(), "Central")
  ccunit.eq(s.isTrainPresent(), true)
  ccunit.eq(s.isTrainImminent(), true)
  ccunit.eq(s.isTrainEnroute(), true)
  ccunit.eq(s.getTrainName(), "Express")
  ccunit.eq(s.hasSchedule(), false)
  ccunit.eq(err(s.getSchedule), "train doesn't have a schedule")
  s.setTrainName("Rocket")
  ccunit.eq(s.getTrainName(), "Rocket")
  s.setTrainName("Express")
  s.setStationName("Hub")
  ccunit.eq(s.getStationName(), "Hub")
  s.setStationName("Central")
  ccunit.eq(s.isInAssemblyMode(), false)
  ccunit.eq(err(s.setStationName), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(s.setAssemblyMode, "yes"), "bad argument #1 (boolean expected, got string)")
  ccunit.eq(err(s.assemble), "station must be in assembly mode")
  ccunit.eq(err(s.setAssemblyMode, false), "failed to exit assembly mode")
end)

ccunit.test("a station off the track", function()
  local s = peripheral.wrap("loose")
  ccunit.eq(err(s.getStationName), "station is not connected to a track")
  ccunit.eq(err(s.isTrainPresent), "station is not connected to a track")
  ccunit.eq(err(s.isTrainImminent), "station is not connected to a track")
  ccunit.eq(err(s.isTrainEnroute), "station is not connected to a track")
  ccunit.eq(err(s.getTrainName), "station is not connected to a track")
  ccunit.eq(err(s.hasSchedule), "station is not connected to a track")
  ccunit.eq(err(s.setStationName, "x"), "could not set station name")
  ccunit.eq(err(s.setAssemblyMode, true), "failed to enter assembly mode")
  ccunit.eq(err(s.disassemble), "station is not connected to a track")
  ccunit.eq(err(s.setSchedule, { entries = { {} }, cyclic = true }), "station is not connected to a track")
  ccunit.eq(s.isInAssemblyMode(), false)
end)

ccunit.test("assembly", function()
  local d = peripheral.wrap("depot")
  ccunit.eq(d.isInAssemblyMode(), true)
  ccunit.eq(d.isTrainPresent(), false)
  ccunit.eq(d.isTrainEnroute(), false)
  ccunit.eq(err(d.getTrainName), "there is no train present")
  ccunit.eq(err(d.disassemble), "station must not be in assembly mode")
  d.assemble()
  ccunit.eq(d.isInAssemblyMode(), false)
  ccunit.eq(d.isTrainPresent(), true)
  ccunit.eq(d.getTrainName(), "Freight")
  ccunit.eq(d.hasSchedule(), false)
  d.setSchedule({ cyclic = true, entries = { { instruction = { id = "create:destination", data = { text = "Depot" } }, conditions = {} } } })
  d.disassemble() -- drops the schedule, remembers the name
  ccunit.eq(d.isInAssemblyMode(), true)
  ccunit.eq(d.isTrainPresent(), false)
  ccunit.eq(err(d.setAssemblyMode, true), "failed to enter assembly mode")
  d.assemble()
  ccunit.eq(d.getTrainName(), "Freight")
  ccunit.eq(d.hasSchedule(), false)
  d.setAssemblyMode(true) -- disassembles the train it finds
  ccunit.eq(d.isTrainPresent(), false)
  d.setAssemblyMode(false)
  ccunit.eq(d.isInAssemblyMode(), false)
  ccunit.eq(err(d.disassemble), "there is no train present")
end)

ccunit.test("assembly without carriages", function()
  local e = peripheral.wrap("empty")
  ccunit.eq(err(e.assemble), "failed to assemble train")
  ccunit.eq(e.isInAssemblyMode(), true)
end)
`,
      stationWorld,
      "station.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── schedules ─────────────

describe.skipIf(!ready)("Create schedules", () => {
  it("setSchedule checks and getSchedule shapes, as StationPeripheral converts them", async () => {
    const result = await lua(
      `
local s = peripheral.wrap("station")

ccunit.test("validation", function()
  ccunit.eq(err(s.setSchedule), "bad argument #1 (table expected, got nil)")
  ccunit.eq(err(s.setSchedule, "x"), "bad argument #1 (table expected, got string)")
  ccunit.eq(err(s.setSchedule, {}), "Not a valid schedule")
  ccunit.eq(err(s.setSchedule, { entries = {} }), "Not a valid schedule")
  ccunit.eq(err(s.setSchedule, { entries = {}, cyclic = true }), "Schedule must have at least one entry")
  ccunit.eq(err(s.setSchedule, { entries = { {} }, cyclic = true, extra = 1 }), "Not a valid schedule")
  ccunit.eq(err(peripheral.call, "depot", "setSchedule", { entries = { {} }, cyclic = true }), "there is no train present")
  ccunit.eq(err(s.setSchedule, { entries = { { [5] = 1 } }, cyclic = true }), "table key is not of type string")
  ccunit.eq(err(s.setSchedule, { {}, {} }),
    "Java Exception Thrown: java.lang.ClassCastException: class net.minecraft.nbt.ListTag cannot be cast to class net.minecraft.nbt.CompoundTag")
  ccunit.eq(err(s.setSchedule, { entries = { { instruction = { id = "Create:Destination" } } }, cyclic = true }),
    "Java Exception Thrown: net.minecraft.ResourceLocationException: Non [a-z0-9_.-] character in namespace of location: Create:Destination")
  ccunit.eq(err(s.setSchedule, { entries = { {}, "x" }, cyclic = true }),
    "Java Exception Thrown: java.lang.UnsupportedOperationException: Trying to add tag of type 8 to list of 10")
  ccunit.eq(err(s.setSchedule, { entries = { { [""] = 1 } }, cyclic = true }),
    "Java Exception Thrown: java.lang.StringIndexOutOfBoundsException: begin 0, end 1, length 0")
  ccunit.eq(err(s.setSchedule, { entries = { { instruction = { id = "create:destination", data = { count = "x" } } } }, cyclic = true }),
    "Java Exception Thrown: java.lang.ClassCastException: class java.lang.String cannot be cast to class java.lang.Number")
  ccunit.eq(s.hasSchedule(), false) -- none of those got through
end)

ccunit.test("round trip: snake_case keys, items keep id/count, defaults written back", function()
  s.setSchedule({
    cyclic = true,
    entries = {
      { instruction = { id = "create:destination", data = { text = "Quarry" } },
        conditions = {
          { { id = "create:delay", data = { value = 5, time_unit = 1 } } },
          { { id = "create:item_threshold", data = { threshold = "10", operator = 0, measure = 0, item = { id = "minecraft:coal", count = 1 } } } },
        } },
      { instruction = { id = "create:rename", data = { text = "Coal run" } }, conditions = { { { id = "create:delay", data = {} } } } },
      { instruction = { id = "create:throttle", data = { value = 50 } } },
      { instruction = { id = "create:destination", data = { text = "Cent*", flag = true, ratio = 0.5 } },
        conditions = { { { id = "create:powered", data = {} }, { id = "create:redstone_link", data = { inverted = 0 } } } } },
    },
  })
  ccunit.eq(s.hasSchedule(), true)
  local air = { id = "minecraft:air", count = 1 }
  ccunit.eq(s.getSchedule(), {
    cyclic = true,
    entries = {
      { instruction = { id = "create:destination", data = { text = "Quarry" } },
        conditions = {
          { { id = "create:delay", data = { value = 5, time_unit = 1 } } },
          { { id = "create:item_threshold", data = { threshold = "10", operator = 0, measure = 0, item = { id = "minecraft:coal", count = 1 } } } },
        } },
      { instruction = { id = "create:rename", data = { text = "Coal run" } } }, -- no conditions on a rename
      { instruction = { id = "create:throttle", data = { value = 50 } } },
      { instruction = { id = "create:destination", data = { text = "Cent*", flag = true, ratio = 0.5 } },
        conditions = { { { id = "create:powered", data = {} },
          { id = "create:redstone_link", data = { inverted = 0, frequency = { air, air } } } } } },
    },
  })
end)

ccunit.test("CamelCase keys and unknown ids", function()
  -- the tail after the last "_" keeps its case: "maxWait" -> "MaxWait" -> back as "max_wait"
  s.setSchedule({ cyclic = 1, entries = { { instruction = { id = "destination", data = { maxWait = 3 } } } } })
  ccunit.eq(s.getSchedule(), { cyclic = true, entries = { { instruction = { id = "create:destination", data = { max_wait = 3 } }, conditions = {} } } })
  -- an item without a count: "id" turns into "Id", the stack is empty
  s.setSchedule({ cyclic = true, entries = { { instruction = { id = "create:destination", data = {} },
    conditions = { { { id = "create:item_threshold", data = { item = { id = "minecraft:coal" } } } } } } } })
  ccunit.eq(s.getSchedule().entries[1].conditions[1][1].data.item, { id = "minecraft:air", count = 1 })
  -- an unknown condition is a null in the list: getSchedule fails
  s.setSchedule({ cyclic = true, entries = { { instruction = { id = "create:destination", data = {} },
    conditions = { { { id = "create:teleport", data = {} } } } } } })
  ccunit.eq(err(s.getSchedule), "Java Exception Thrown: java.lang.NullPointerException")
  -- progress without cyclic (two keys): cyclic reads false, progress comes back
  s.setSchedule({ progress = 1, entries = { { instruction = { id = "create:rename", data = { text = "a" } } },
    { instruction = { id = "create:rename", data = { text = "b" } } } } })
  local back = s.getSchedule()
  ccunit.eq(back.cyclic, false)
  ccunit.eq(back.progress, 1)
end)
`,
      stationWorld,
      "schedule.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("a fixture route is a schedule of destinations and delays", async () => {
    const result = await lua(
      `
ccunit.test("route", function()
  local s = peripheral.wrap("station")
  ccunit.eq(s.getSchedule(), { cyclic = true, entries = {
    { instruction = { id = "create:destination", data = { text = "Central" } },
      conditions = { { { id = "create:delay", data = { value = 600, time_unit = 1 } } } } },
    { instruction = { id = "create:destination", data = { text = "Mine" } },
      conditions = { { { id = "create:delay", data = { value = 4, time_unit = 1 } } } } },
  } })
end)
`,
      {
        create: {
          stations: ["Mine"],
          trains: [
            {
              name: "Shuttle",
              at: "Central",
              // its first stop is where it stands, for ten minutes: the clock runs while the computer boots, and a
              // train that set off for Mine at once was gone from the station before a busy host got to look
              route: [
                { station: "Central", wait: 600 },
                { station: "Mine", wait: 4 },
              ],
            },
          ],
        },
        peripherals: [
          { name: "station", type: "Create_Station", station: "Central" },
        ],
      } as unknown as WorldConfig,
      "route.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── trains on the virtual clock ─────────────

describe.skipIf(!ready)("Create trains", () => {
  it("a scheduled train leaves, is en route, imminent, present, waits and goes on", async () => {
    await withSession(
      {
        create: {
          stations: ["Mine"],
          distances: { "Central|Mine": 200 },
          trains: [
            {
              name: "Shuttle",
              at: "Central",
              route: [
                { station: "Mine", wait: 2 },
                { station: "Central", wait: 2 },
              ],
            },
          ],
        },
        peripherals: [
          { name: "station", type: "Create_Station", station: "Central" },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        const seen: {
          t: number;
          at?: string;
          to?: string;
          d?: number;
          present: boolean;
          imminent: boolean;
          enroute: boolean;
        }[] = [];
        // the world's own clock (in ticks of 50 ms), not the count of steps: the sim also runs in real time, so a busy
        // machine makes the steps cover more than 0.5 s each
        for (let i = 0; i < 100; i++) {
          const state = await step({ cmd: "advance", seconds: 0.5 });
          const t = (createState(state).gameTime as number) / 20;
          const tr = train(state, "Shuttle");
          const st = periph(state, "station");
          seen.push({
            t,
            at: tr.station,
            to: tr.destination,
            d: tr.distance,
            present: st.trainPresent,
            imminent: st.trainImminent,
            enroute: st.trainEnroute,
          });
        }
        // it leaves at once for Mine: Central sees nothing
        expect(seen[0]).toMatchObject({
          to: "Mine",
          present: false,
          enroute: false,
        });
        const atMine = seen.filter((s) => s.at === "Mine");
        // 200 blocks from a standstill at 3 b/s^2, top 28 b/s: about 16.3 s
        // the first sample is at most one step (and some real time) after arrival; arrival is never early
        const mineAt = seen.indexOf(atMine[0]!);
        expect(atMine[0]!.t).toBeGreaterThanOrEqual(14);
        expect(seen[mineAt - 1]!.t).toBeLessThanOrEqual(17);
        // a 2 s delay, plus the ticks ScheduleRuntime takes to move on: it cannot leave before 2 s, so the samples
        // around the stay span at least that; it stays only a few ticks longer, so the ones inside it span less than 3
        const leaveAt = seen.findIndex((s, i) => i > mineAt && s.at !== "Mine");
        expect(seen[leaveAt]!.t - seen[mineAt - 1]!.t).toBeGreaterThanOrEqual(
          2,
        );
        expect(seen[leaveAt - 1]!.t - atMine[0]!.t).toBeLessThanOrEqual(2.5); // the samples of that one stay
        const back = seen.filter((s) => s.to === "Central");
        expect(back.length).toBeGreaterThan(20);
        expect(back.every((s) => s.enroute)).toBe(true);
        expect(back.filter((s) => s.imminent).every((s) => s.d! <= 30)).toBe(
          true,
        );
        expect(back.some((s) => s.imminent)).toBe(true);
        expect(back.some((s) => !s.imminent)).toBe(true);
        const home = seen.findIndex((s) => s.at === "Central");
        expect(seen[home]).toMatchObject({
          present: true,
          imminent: true,
          enroute: true,
        });
        // back: the 2 s wait, a few ticks to move on, and the same 200 blocks
        expect(seen[home]!.t - atMine[0]!.t).toBeGreaterThanOrEqual(17.5);
        // late only by how coarsely a busy machine sampled
        const gap = Math.max(...seen.slice(1).map((s, i) => s.t - seen[i]!.t));
        expect(seen[home]!.t - atMine[0]!.t).toBeLessThanOrEqual(19.5 + gap);
      },
    );
  }, 120000);

  it("wait conditions: powered, cargo, redstone link, players, idle, time of day", async () => {
    const at = (station: string, cond: unknown) => ({
      name: station,
      at: station,
      schedule: {
        cyclic: false,
        entries: [
          {
            instruction: { id: "create:destination", data: { text: station } },
            conditions: [[cond]],
          },
          {
            instruction: { id: "create:destination", data: { text: "Mine" } },
            conditions: [],
          },
        ],
      },
    });
    await withSession(
      {
        create: {
          dayTime: 1000,
          stations: ["A", "B", "C", "D", "E", "F", "G", "Mine"],
          trains: [
            at("A", { id: "create:powered", data: {} }),
            at("B", {
              id: "create:item_threshold",
              data: {
                threshold: "10",
                operator: 0,
                measure: 0,
                item: { id: "minecraft:coal", count: 1 },
              },
            }),
            at("C", {
              id: "create:redstone_link",
              data: {
                inverted: 0,
                frequency: [
                  { id: "minecraft:coal", count: 1 },
                  { id: "minecraft:iron_ingot", count: 1 },
                ],
              },
            }),
            at("D", {
              id: "create:player_count",
              data: { count: 2, exact: 0 },
            }),
            at("E", { id: "create:idle", data: { value: 3, time_unit: 1 } }),
            at("F", {
              id: "create:time_of_day",
              data: { hour: 8, minute: 0, rotation: 0 },
            }),
            at("G", {
              id: "create:fluid_threshold",
              data: {
                threshold: "abc",
                operator: 0,
                bucket: { id: "minecraft:water_bucket", count: 1 },
              },
            }),
          ],
        },
        peripherals: [{ name: "a", type: "Create_Station", station: "A" }],
      } as unknown as WorldConfig,
      async (step) => {
        const gone = (state: SimState, name: string) =>
          train(state, name).destination === "Mine";
        let state = await step({ cmd: "advance", seconds: 2 });
        for (const n of ["A", "B", "C", "D", "E", "F", "G"])
          expect(gone(state, n)).toBe(false);
        expect(train(state, "A").schedule).toMatchObject({
          state: "POST_TRANSIT",
          currentEntry: 1,
        });
        state = await step({
          cmd: "createSetStationPowered",
          station: "A",
          powered: true,
        });
        state = await step({
          cmd: "createSetCargo",
          train: "B",
          items: [{ name: "minecraft:coal", count: 11 }],
        });
        state = await step({
          cmd: "createSetRedstoneLink",
          first: "minecraft:coal",
          second: "minecraft:iron_ingot",
          powered: true,
        });
        state = await step({ cmd: "createSetCargo", train: "D", players: 2 });
        state = await step({ cmd: "advance", seconds: 1.5 });
        for (const n of ["A", "B", "C", "D", "E"])
          expect(gone(state, n), n).toBe(true);
        // 8:00 is day time 2000; the world started at 1000
        expect(gone(state, "F")).toBe(false);
        state = await step({ cmd: "advance", seconds: 46 });
        expect(createState(state).dayTime).toBeGreaterThan(1900);
        expect(gone(state, "F")).toBe(false);
        state = await step({ cmd: "advance", seconds: 2.5 });
        expect(gone(state, "F")).toBe(true);
        expect(gone(state, "G")).toBe(false); // "abc" reads as 0 and is written back as "0"
        state = await step({
          cmd: "createSetCargo",
          train: "G",
          fluids: [{ name: "minecraft:water", amount: 1500 }],
        });
        state = await step({ cmd: "advance", seconds: 1.5 });
        expect(gone(state, "G")).toBe(true);
        // station A has a computer: its train went, nothing is on the way
        expect(periph(state, "a")).toMatchObject({
          trainPresent: false,
          trainEnroute: false,
          powered: true,
        });
      },
    );
  }, 120000);

  it("sim commands move trains by hand; a filter with no station; no conductor", async () => {
    await withSession(
      {
        create: {
          stations: ["Mine"],
          trains: [
            { name: "Lost", at: "Mine", route: [{ station: "Nowhere*" }] },
            {
              name: "Driverless",
              conductor: false,
              route: [{ station: "Mine" }],
            },
          ],
        },
        peripherals: [
          { name: "station", type: "Create_Station", station: "Central" },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        let state = await step({ cmd: "advance", seconds: 0.5 });
        expect(train(state, "Lost").status).toBe("no_target: Nowhere*");
        expect(train(state, "Driverless").status).toBe("missing_conductor");
        state = await step({
          cmd: "createTrainApproach",
          train: "Local",
          station: "Central",
          distance: 100,
        });
        expect(periph(state, "station")).toMatchObject({
          trainEnroute: true,
          trainImminent: false,
          trainPresent: false,
        });
        state = await step({ cmd: "advance", seconds: 9 });
        expect(periph(state, "station")).toMatchObject({
          trainEnroute: true,
          trainImminent: true,
          trainPresent: false,
        });
        state = await step({ cmd: "advance", seconds: 5 });
        expect(periph(state, "station")).toMatchObject({
          trainPresent: true,
          train: "Local",
        });
        state = await step({ cmd: "createTrainLeave", train: "Local" });
        expect(periph(state, "station")).toMatchObject({
          trainEnroute: false,
          trainPresent: false,
        });
        state = await step({
          cmd: "createTrainArrive",
          train: "Local",
          station: "station",
        });
        expect(periph(state, "station")).toMatchObject({
          trainPresent: true,
          train: "Local",
        });
        state = await step({ cmd: "createRemoveTrain", train: "Local" });
        expect(periph(state, "station").trainPresent).toBe(false);
        state = await step({
          cmd: "createAddTrain",
          train: { name: "Spare", at: "Central" },
        });
        expect(periph(state, "station").train).toBe("Spare");
        state = await step({
          cmd: "createSetAssemblyReady",
          station: "station",
          name: "New",
        });
        expect(periph(state, "station").readyToAssemble).toBe(true);
      },
    );
  }, 60000);

  it("setSchedule from a program sends the train", async () => {
    const result = await lua(
      `
ccunit.test("dispatch", function()
  local s = peripheral.wrap("station")
  s.setSchedule({ cyclic = false, entries = {
    { instruction = { id = "create:destination", data = { text = "Mine" } },
      conditions = { { { id = "create:delay", data = { value = 1, time_unit = 1 } } } } } } })
  sleep(0.3)
  ccunit.eq(s.isTrainPresent(), false)
  ccunit.eq(s.isTrainEnroute(), false)
  ccunit.eq(err(s.getTrainName), "there is no train present")
end)
`,
      stationWorld,
      "dispatch.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── Create Crafts & Additions ─────────────

const caWorld = {
  create: {
    networks: {
      motor: { source: "motor", impact: 2 },
      main: { speed: 64, capacity: 4096, impact: 8 },
    },
  },
  peripherals: [
    { name: "motor", type: "electric_motor", energy: 5000, input: 1000 },
    { name: "cold", type: "electric_motor", rpm: 128 },
    {
      name: "acc",
      type: "modular_accumulator",
      width: 2,
      height: 3,
      energy: 6000000,
    },
    { name: "pei", type: "portable_energy_interface" },
    {
      name: "relay",
      type: "redstone_relay",
      powered: true,
      supply: 800,
      demand: 500,
    },
    { name: "ctl", type: "Create_RotationSpeedController", network: "main" },
    { name: "gauge", type: "Create_Speedometer", network: "motor" },
    { name: "stress", type: "Create_Stressometer", network: "motor" },
    {
      name: "adapter",
      type: "digital_adapter",
      sides: {
        up: "ctl",
        north: "gauge",
        south: "stress",
        east: { kind: "piston", offset: 3 },
        west: { kind: "bearing", angle: 90 },
        down: {
          kind: "elevator_pulley",
          offset: 4,
          floors: [
            { y: 60, name: "Ground" },
            { y: 70, name: "Upper" },
          ],
        },
      },
    },
    {
      name: "link",
      type: "Create_DisplayLink",
      source: "adapter",
      target: "sign",
    },
  ],
} as unknown as WorldConfig;

describe.skipIf(!ready)("Create Crafts & Additions", () => {
  it("electric motor: speed, anti spam, durations, energy", async () => {
    const result = await lua(
      `
local m = peripheral.wrap("motor")
ccunit.test("defaults", function()
  ccunit.eq(m.getType(), "electric_motor")
  ccunit.eq(m.getSpeed(), 32)
  ccunit.eq(m.getStressCapacity(), 64) -- 16384 SU at 256 RPM
  ccunit.eq(m.getEnergyConsumption(), 60) -- 480 FE/t at 256 RPM
  ccunit.eq(m.getMaxInsert(), 5000)
  ccunit.eq(m.getMaxExtract(), 0)
  ccunit.eq(peripheral.call("cold", "getEnergyConsumption"), 240)
end)

ccunit.test("rotate and translate answer the time in seconds", function()
  ccunit.eq(m.rotate(90), 0.5) -- (int)(90 / 9.6 + 1) = 10 ticks
  ccunit.eq(m.rotate(-90, 64), 0.25)
  ccunit.eq(m.getSpeed(), -64)
  ccunit.eq(m.translate(10, 64), 4)
  ccunit.eq(m.translate(3), 1.2000000476837158) -- at -64 RPM: 3 / (64 / 512) = 24 ticks; a float
  ccunit.eq(err(m.rotate), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(m.rotate, 90, "x"), "bad argument #2 (number expected, got string)")
  ccunit.eq(err(m.setSpeed, 0 / 0), "bad argument #1 (number expected, got nan)")
end)

ccunit.test("anti spam: five changes per lazy tick", function()
  local fails, last = 0, nil
  for i = 1, 25 do
    local ok, e = pcall(m.setSpeed, 100 + i)
    if not ok then fails = fails + 1 last = e end
  end
  ccunit.truthy(fails >= 5, "fails " .. fails)
  ccunit.truthy(last:find("Speed is set too many times per second %(Anti Spam%)%.$"), last)
  ccunit.eq(m.getSpeed(), 125) -- the value is kept and applied at the next lazy tick
  m.setSpeed(125) -- the same value returns at once, spam or not
  sleep(1.1) -- a lazy tick (every 21 ticks) allows five more
  m.setSpeed(9999)
  ccunit.eq(m.getSpeed(), 256) -- clamped to motor_rpm_range
  sleep(1.2)
  ccunit.eq(m.getEnergyConsumption(), 480)
  m.stop()
  ccunit.eq(m.getSpeed(), 0)
end)

ccunit.test("energy and kinetics", function()
  ccunit.eq(peripheral.call("gauge", "getSpeed"), 0) -- stopped
  m.setSpeed(32)
  sleep(1.2)
  ccunit.eq(peripheral.call("gauge", "getSpeed"), 32)
  ccunit.eq(peripheral.call("stress", "getStressCapacity"), 64 * 32)
  ccunit.eq(peripheral.call("stress", "getStress"), 2 * 32)
  ccunit.eq(peripheral.call("cold", "getSpeed"), 128) -- no energy: not running, but it still reports its setting
end)
`,
      caWorld,
      "motor.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("accumulator, portable energy interface, relay", async () => {
    const result = await lua(
      `
ccunit.test("accumulator", function()
  local a = peripheral.wrap("acc")
  ccunit.eq(a.getCapacity(), 2 * 2 * 3 * 2000000)
  ccunit.eq(a.getEnergy(), 6000000)
  ccunit.eq(a.getPercent(), 25)
  ccunit.eq(a.getWidth(), 2)
  ccunit.eq(a.getHeight(), 3)
  ccunit.eq(a.getMaxInsert(), 5000)
  ccunit.eq(a.getMaxExtract(), 5000)
end)

ccunit.test("portable energy interface", function()
  local p = peripheral.wrap("pei")
  ccunit.eq(p.isConnected(), false)
  ccunit.eq(p.getEnergy(), 0)
  ccunit.eq(p.getCapacity(), 0)
  ccunit.eq(p.getMaxInsert(), 5000)
  ccunit.eq(p.getMaxExtract(), 5000)
end)

ccunit.test("relay", function()
  local r = peripheral.wrap("relay")
  ccunit.eq(r.isPowered(), true)
  ccunit.eq(r.getThroughput(), 500)
  ccunit.eq(r.getMaxInsert(), 1024)
  ccunit.eq(r.getMaxExtract(), 1024)
end)
`,
      caWorld,
      "energy.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("return counts are exactly what the Java methods return: void gives none, a value gives one", async () => {
    const result = await lua(
      `
local d = peripheral.wrap("adapter")
local m = peripheral.wrap("motor")
ccunit.test("void methods return nothing, the rest exactly one value", function()
  ccunit.eq(select("#", d.print("x")), 0)
  ccunit.eq(select("#", d.clearLine()), 0)
  ccunit.eq(select("#", d.clear()), 0)
  ccunit.eq(select("#", d.setTargetSpeed("up", 10)), 0)
  ccunit.eq(select("#", m.setSpeed(64)), 0)
  ccunit.eq(select("#", m.stop()), 0)
  ccunit.eq(select("#", d.setLine(3)), 1)
  ccunit.eq(select("#", d.getElevatorFloorName("down", 99)), 1)
  ccunit.eq(select("#", d.gotoElevatorFloor("north", 1)), 1)
  ccunit.eq(select("#", m.rotate(90)), 1)
  ccunit.eq(select("#", peripheral.call("acc", "getPercent")), 1)
  ccunit.eq(select("#", peripheral.call("relay", "isPowered")), 1)
end)
`,
      caWorld,
      "returns.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("digital adapter: lines, neighbours, durations", async () => {
    const result = await lua(
      `
local d = peripheral.wrap("adapter")
ccunit.test("lines", function()
  ccunit.eq(d.getMaxLines(), 16)
  ccunit.eq(d.getLine(), 1)
  d.print("hello")
  ccunit.eq(d.getLine(), 2)
  ccunit.eq(d.setLine(0), 2)
  ccunit.eq(d.setLine(17), 2)
  ccunit.eq(d.setLine(16), 16)
  d.print("a") d.print("b")
  ccunit.eq(d.getLine(), 16)
  d.setLine(1)
  d.clearLine()
  d.clear()
  ccunit.eq(err(d.print), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(d.setLine, "x"), "bad argument #1 (number expected, got string)")
end)

ccunit.test("speed controller and gauges next to it", function()
  ccunit.eq(d.getTargetSpeed("up"), 16)
  d.setTargetSpeed("top", 300)
  ccunit.eq(peripheral.call("ctl", "getTargetSpeed"), 256)
  d.setTargetSpeed("up", 64)
  ccunit.eq(d.getTargetSpeed("north"), 0) -- a speedometer is there, not a controller
  ccunit.eq(d.getKineticSpeed("north"), 32) -- the motor turns its network
  ccunit.eq(d.getKineticSpeed("Up"), 32) -- not a name Helpers knows: north
  ccunit.eq(d.getKineticStress("south"), 64)
  ccunit.eq(d.getKineticCapacity("south"), 2048)
  ccunit.eq(d.getKineticSpeed("east"), 0) -- a piston: no speedometer there
  ccunit.eq(d.getKineticTopSpeed(), 256)
  ccunit.eq(err(d.setTargetSpeed, "up"), "bad argument #2 (number expected, got nil)")
end)

ccunit.test("contraptions", function()
  ccunit.eq(d.getPistonDistance("east"), 3)
  ccunit.eq(d.getPistonDistance("west"), 0)
  ccunit.eq(d.getBearingAngle("west"), 90)
  ccunit.eq(d.getPulleyDistance("down"), 4)
  ccunit.eq(d.getElevatorFloors("down"), 2)
  ccunit.eq(d.getElevatorFloor("down"), 0)
  ccunit.eq(d.getElevatorFloorName("down", 1), "Upper")
  ccunit.eq(d.getElevatorFloorName("down", 5), "5")
  ccunit.eq(d.getElevatorFloorName("east", 1), "1")
  ccunit.eq(d.gotoElevatorFloor("down", 1), 10)
  ccunit.eq(d.getElevatorFloor("down"), 1)
  ccunit.eq(d.gotoElevatorFloor("down", 9), 0)
  ccunit.eq(d.gotoElevatorFloor("down", 0), -10)
end)

ccunit.test("durations", function()
  ccunit.eq(d.getDurationAngle(90, 32), 0.5)
  ccunit.eq(d.getDurationAngle(90, 0), 0)
  ccunit.eq(d.getDurationDistance(10, 64), 4)
  ccunit.eq(err(d.getDurationAngle, 90), "bad argument #2 (number expected, got nil)")
end)
`,
      caWorld,
      "adapter.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("energy, kinetics and the adapter's display link over the virtual clock", async () => {
    await withSession(
      {
        create: { networks: { m: { source: "motor", impact: 1 } } },
        peripherals: [
          { name: "motor", type: "electric_motor", rpm: 64 },
          { name: "acc", type: "modular_accumulator", energy: 1000 },
          { name: "pei", type: "portable_energy_interface" },
          { name: "relay", type: "redstone_relay", supply: 300, demand: 200 },
          {
            name: "adapter",
            type: "digital_adapter",
            sides: { west: { kind: "bearing", rpm: 10 } },
          },
          {
            name: "link",
            type: "Create_DisplayLink",
            source: "adapter",
            target: "sign",
          },
        ],
      } as unknown as WorldConfig,
      async (step) => {
        let state = await step({ cmd: "advance", seconds: 0.5 });
        expect(periph(state, "motor")).toMatchObject({
          active: false,
          energy: 0,
          outputSpeed: 0,
        });
        expect(createState(state).networks.m).toMatchObject({
          speed: 0,
          capacity: 0,
        });
        state = await step({
          cmd: "caSetEnergyInput",
          peripheral: "motor",
          rate: 1000,
        });
        state = await step({ cmd: "advance", seconds: 1 });
        expect(periph(state, "motor")).toMatchObject({
          active: true,
          consumption: 120,
          outputSpeed: 64,
        });
        expect(createState(state).networks.m).toMatchObject({
          speed: 64,
          capacity: 64 * 64,
          stress: 64,
        });
        state = await step({ cmd: "advance", seconds: 5 });
        expect(periph(state, "motor").energy).toBe(5000 - 120); // full, less one tick of use
        state = await step({
          cmd: "caSetEnergyInput",
          peripheral: "motor",
          rate: 0,
        });
        state = await step({ cmd: "advance", seconds: 5 }); // 4880 FE at 120 FE/t: 41 ticks
        expect(periph(state, "motor")).toMatchObject({
          active: false,
          outputSpeed: 0,
        });
        state = await step({
          cmd: "caSetEnergy",
          peripheral: "motor",
          energy: 5000,
        });
        state = await step({
          cmd: "caSetRedstone",
          peripheral: "motor",
          powered: true,
        });
        state = await step({ cmd: "advance", seconds: 0.5 });
        expect(periph(state, "motor").active).toBe(false); // redstone stops it
        // accumulator
        state = await step({
          cmd: "caSetEnergyInput",
          peripheral: "acc",
          rate: 9000,
        });
        state = await step({ cmd: "advance", seconds: 1 });
        expect(periph(state, "acc").energy).toBeGreaterThanOrEqual(
          1000 + 5000 * 20,
        );
        state = await step({
          cmd: "caSetEnergyInput",
          peripheral: "acc",
          rate: 0,
        });
        state = await step({
          cmd: "caSetEnergyOutput",
          peripheral: "acc",
          rate: 100000,
        });
        state = await step({ cmd: "advance", seconds: 2 });
        expect(periph(state, "acc").energy).toBe(0);
        // portable energy interface
        state = await step({
          cmd: "caConnectContraption",
          peripheral: "pei",
          energy: 300,
          capacity: 1000,
        });
        expect(periph(state, "pei")).toMatchObject({
          connected: true,
          energy: 300,
          capacity: 1000,
        });
        state = await step({
          cmd: "caDisconnectContraption",
          peripheral: "pei",
        });
        expect(periph(state, "pei").connected).toBe(false);
        // relay: nothing until powered, then the throughput follows a tick behind the demand
        expect(periph(state, "relay").throughput).toBe(0);
        state = await step({
          cmd: "caSetRedstone",
          peripheral: "relay",
          powered: true,
        });
        state = await step({ cmd: "advance", seconds: 0.2 });
        expect(periph(state, "relay").throughput).toBe(200);
        state = await step({
          cmd: "caSetRelayFlow",
          peripheral: "relay",
          supply: 50,
        });
        state = await step({ cmd: "advance", seconds: 0.2 });
        expect(periph(state, "relay").throughput).toBe(50);
        // bearing: 10 RPM is 3 degrees a tick
        state = await step({
          cmd: "caSetContraption",
          peripheral: "adapter",
          side: "west",
          rpm: 0,
          angle: 45,
        });
        expect(periph(state, "adapter").sides.west.angle).toBe(45);
        // the adapter's lines reach the sign through the display link every 100 ticks
        expect(periph(state, "link").target.lines).toEqual(["", "", "", ""]);
      },
    );
  }, 120000);

  it("the adapter's text shows on the link's sign within 5 seconds", async () => {
    put(
      "adapt.lua",
      `
local d = peripheral.wrap("adapter")
d.print("Power 80%") d.print("Trains: 2")
print("printed lines")
`,
    );
    await withSession(
      {
        peripherals: [
          { name: "adapter", type: "digital_adapter" },
          {
            name: "link",
            type: "Create_DisplayLink",
            source: "adapter",
            target: "sign",
          },
        ],
      } as unknown as WorldConfig,
      async (step, program) => {
        await program("adapt", "printed lines");
        const state = await step({ cmd: "advance", seconds: 5.1 });
        expect(periph(state, "link").target.lines).toEqual([
          "Power 80%",
          "Trains: 2",
          "",
          "",
        ]);
        expect(periph(state, "adapter").lines.slice(0, 3)).toEqual([
          "Power 80%",
          "Trains: 2",
          "",
        ]);
      },
    );
  }, 60000);
});

// ───────────── what changed between 0.5.1.i and 6.0, on each version ─────────────
// (create6.integration.test.ts has the 6.0 blocks and the 6.0 side of each change in depth)

describe.skipIf(!ready)("Create per Minecraft version", () => {
  for (const mc of ["1.18.2", "1.20.1", "1.21.1"] as const) {
    const V6 = mc !== "1.18.2";
    it(`${mc}: methods, events, setSchedule checks, package instructions (Create ${V6 ? (mc === "1.20.1" ? "6.0.8" : "6.0.10") : "0.5.1.i"})`, async () => {
      const result = await lua(
        `
local V6, V21 = ${V6}, ${mc === "1.21.1"}
local s, l = peripheral.wrap("station"), peripheral.wrap("link")
ccunit.test("the methods 6.0 added", function()
  ccunit.eq(s.canTrainReach ~= nil, V6)
  ccunit.eq(s.distanceTo ~= nil, V6)
  ccunit.eq(l.writeBytes ~= nil, V6)
  ccunit.eq(#peripheral.getMethods("station"), V6 and 16 or 14)
end)

ccunit.test("gauges send events only on 6.0", function()
  peripheral.call("ctl", "setTargetSpeed", 48)
  local got = {}
  local timer = os.startTimer(0.5)
  while true do
    local ev = { os.pullEvent() }
    if ev[1] == "timer" and ev[2] == timer then break end
    if ev[1] == "speed_change" then got[#got + 1] = ev end
  end
  ccunit.eq(got, V6 and { { "speed_change", "outspeedo", 48 } } or {})
end)

ccunit.test("setSchedule: which check comes first", function()
  ccunit.eq(err(peripheral.call, "nobody", "setSchedule", "x"),
    V6 and "there is no train present" or "bad argument #1 (table expected, got string)")
  ccunit.eq(err(s.setSchedule, { entries = {}, cyclic = true, x = 1 }),
    V6 and "Schedule must have at least one entry" or "Not a valid schedule")
end)

ccunit.test("getSize after a restart", function()
  if V6 then
    ccunit.eq({ peripheral.call("restarted", "getSize") }, { 4, 15 })
  else
    ccunit.truthy(err(peripheral.call, "restarted", "getSize"):find("NullPointerException", 1, true))
  end
end)

ccunit.test("setCursorPos below 1", function()
  if V21 then
    ccunit.eq(err(l.setCursorPos, 0, 1), "cursor position must be larger then 0")
  else
    l.setCursorPos(0, 1)
    ccunit.eq({ l.getCursorPos() }, { 0, 1 })
  end
end)

ccunit.test("a package delivery entry: 6.0 knows it, 0.5.1 reads it as a destination", function()
  s.setSchedule({ cyclic = false, entries = {
    { instruction = { id = "create:package_delivery", data = {} }, conditions = {} },
  } })
  ccunit.eq(s.getSchedule().entries[1].instruction.id, V6 and "create:package_delivery" or "create:destination")
end)
`,
        {
          version: mc,
          create: {
            networks: {
              main: { speed: 64, capacity: 4096 },
              controlled: { source: "ctl" },
            },
            trains: [{ name: "Express", at: "Central" }],
          },
          peripherals: [
            { name: "station", type: "Create_Station", station: "Central" },
            { name: "nobody", type: "Create_Station", station: "Empty" },
            { name: "link", type: "Create_DisplayLink", target: "sign" },
            {
              name: "restarted",
              type: "Create_DisplayLink",
              target: "sign",
              restarted: true,
            },
            {
              name: "ctl",
              type: "Create_RotationSpeedController",
              network: "main",
            },
            {
              name: "outspeedo",
              type: "Create_Speedometer",
              network: "controlled",
            },
          ],
        } as unknown as WorldConfig,
        `versions-${mc}.test.lua`,
      );
      expectAllPassed(result);
    }, 60000);
  }

  it("1.18.2 refuses the blocks Create 6.0 added", async () => {
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        {
          version: "1.18.2",
          peripherals: [{ name: "m", type: "Create_CreativeMotor" }],
        } as unknown as WorldConfig,
        "refuse6.test.lua",
      ),
    ).rejects.toThrow(
      /Create 0\.5\.1\.i has no Create_CreativeMotor on Minecraft 1\.18\.2; it has one on 1\.20\.1 as Create_CreativeMotor, 1\.21\.1 as Create_CreativeMotor/,
    );
  }, 60000);
});

// ───────────── addons off, demo world ─────────────

describe.skipIf(!ready)("Create addons switched off", () => {
  it("a world with Create blocks fails cleanly", async () => {
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        { ...stationWorld, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(
      /peripheral "station" is a Create_Station from Create \(addon "create"\)/,
    );
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        {
          peripherals: [{ name: "m", type: "electric_motor" }],
          addons: ["create-additions"],
        } as unknown as WorldConfig,
        "off2.test.lua",
      ),
    ).rejects.toThrow(/needs create/);
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        {
          peripherals: [{ name: "m", type: "electric_motor" }],
          addons: ["create"],
        } as unknown as WorldConfig,
        "off3.test.lua",
      ),
    ).rejects.toThrow(
      /electric_motor from Create Crafts & Additions \(addon "create-additions"\)/,
    );
    await expect(
      lua(
        `ccunit.test("x", function() end)`,
        { create: {}, addons: "none" } as unknown as WorldConfig,
        "off4.test.lua",
      ),
    ).rejects.toThrow(/world.create configures Create/);
  }, 60000);
});

describe.skipIf(!ready)("Create demo world", () => {
  it("loads and answers", async () => {
    const result = await lua(
      `
ccunit.test("demo", function()
  ccunit.eq(peripheral.find("Create_Station").getStationName(), "Central")
  ccunit.truthy(peripheral.find("Create_DisplayLink"))
  ccunit.truthy(peripheral.find("Create_Speedometer").getSpeed() > 0)
  ccunit.truthy(peripheral.find("Create_Stressometer").getStressCapacity() > 0)
  ccunit.truthy(peripheral.find("Create_RotationSpeedController"))
  ccunit.eq(peripheral.find("Create_SequencedGearshift").isRunning(), false)
  ccunit.eq(peripheral.find("electric_motor").getType(), "electric_motor")
  ccunit.truthy(peripheral.find("modular_accumulator").getCapacity() > 0)
  ccunit.truthy(peripheral.find("portable_energy_interface"))
  ccunit.truthy(peripheral.find("redstone_relay"))
  ccunit.eq(peripheral.find("digital_adapter").getMaxLines(), 16)
end)
`,
      loadNamedWorld(config.worldsDir, "create-demo"),
      "demo.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
