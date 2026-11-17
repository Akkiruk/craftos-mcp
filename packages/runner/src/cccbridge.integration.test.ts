import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  worldJson,
} from "./index.js";

/**
 * CC:C Bridge: 1.5.1-forge on 1.18.2, 1.7.1 on 1.20.1, 1.7.3 on 1.21.1, written from tweaked-programs/cccbridge and
 * checked against those jars with javap (docs/cccbridge.md has the source of every rule). The mod is not in the pack:
 * nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "cccb-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

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
local simCount = 0
-- runs a sim command and returns every event that came in the next 0.2 s (sleep would throw them away)
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  local timer, got = os.startTimer(0.2), {}
  while true do
    local e = table.pack(os.pullEvent())
    if e[1] == "timer" and e[2] == timer then return got end
    got[#got + 1] = e
  end
end
local function named(events, kind)
  local out = {}
  for _, e in ipairs(events) do
    if e[1] == kind then out[#out + 1] = e end
  end
  return out
end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(
    config,
    { paths: [name], world: { simProgram: true, ...world }, timeoutMs: 60000 },
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

type Dict = Record<string, unknown>;

async function withSession(
  w: WorldConfig,
  run: (step: (c: Dict) => Promise<SimState>) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    await s.handle.session.waitForText(">", 0, 20000);
    await run(async (c) => {
      expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
        true,
      );
      return s.handle.readState()!;
    });
  } finally {
    await manager.destroyAll();
  }
}

const machine = (st: SimState, name: string) =>
  (st.peripherals as Record<string, Dict>)[name]!;

// ───────────── surface ─────────────

/** @LuaFunction names in declaration order, per mod version (javap of each jar). */
const TERM_121 = [
  "scroll",
  "getCursorPos",
  "setCursorPos",
  "getCursorBlink",
  "setCursorBlink",
  "getSize",
  "clear",
  "clearLine",
  "getTextColour",
  "getTextColor",
  "setTextColour",
  "setTextColor",
  "getBackgroundColour",
  "getBackgroundColor",
  "setBackgroundColour",
  "setBackgroundColor",
  "isColour",
  "isColor",
  "blit",
  "setPaletteColour",
  "setPaletteColor",
  "getPaletteColour",
  "getPaletteColor",
];
const ROT = [
  "push",
  "setHeadRot",
  "setBodyRot",
  "setLeftArmRot",
  "setRightArmRot",
  "getStoredHeadRot",
  "getStoredBodyRot",
  "getStoredLeftArmRot",
  "getStoredRightArmRot",
  "getAppliedHeadRot",
  "getAppliedBodyRot",
  "getAppliedLeftArmRot",
  "getAppliedRightArmRot",
];
const REDROUTER = [
  "setOutput",
  "getOutput",
  "getInput",
  "setAnalogOutput",
  "setAnalogueOutput",
  "getAnalogOutput",
  "getAnalogueOutput",
  "getAnalogInput",
  "getAnalogueInput",
];
const SCROLLER = [
  "isLocked",
  "setLock",
  "getValue",
  "setValue",
  "getLimit",
  "hasMinusSpectrum",
  "toggleMinusSpectrum",
  "setLimit",
];
const SOURCE: Record<string, Record<string, string[]>> = {
  "1.5.1": {
    animatronic: ["setFace", ...ROT],
    redrouter: REDROUTER,
    scroller: SCROLLER,
    create_source: [
      "setCursorPos",
      "write",
      "scroll",
      "clear",
      "clearLine",
      "getLine",
      "getCursorPos",
      "getSize",
    ],
    create_target: ["setWidth", "clear", "clearLine", "getLine", "getSize"],
  },
  "1.7": {
    animatronic: ["setFace", "setTransition", ...ROT],
    redrouter: REDROUTER,
    scroller: SCROLLER,
    create_source: ["write", "getLine", ...TERM_121],
    create_target: ["resize", "getLine", "dump", "getSize"],
  },
};

/** CC's PeripheralAPI.getMethods: a HashMap sized to the method count. */
function javaHashMapOrder(keys: string[]): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 1;
  while (cap < keys.length) cap *= 2;
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

const surface = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./cccbridge-surface.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, Record<string, string[]>>;

describe("CC:C Bridge method surface (no engine)", () => {
  it("cccbridge-surface.json is the source's methods in CC's order", () => {
    expect(Object.keys(surface).sort()).toEqual(Object.keys(SOURCE).sort());
    for (const [version, types] of Object.entries(SOURCE)) {
      for (const [type, own] of Object.entries(types)) {
        expect(surface[version]![type]).toEqual(javaHashMapOrder(own));
      }
    }
  });

  it("a world using them fails cleanly when the addon is off, and needs create", () => {
    expect(() =>
      worldJson({
        addons: ["create"],
        peripherals: [{ name: "s", type: "scroller" }],
      }),
    ).toThrow(
      /peripheral "s" is a scroller from CC:C Bridge \(addon "cccbridge"\)/,
    );
    expect(() =>
      worldJson({
        addons: ["cccbridge"],
        peripherals: [{ name: "s", type: "scroller" }],
      }),
    ).toThrow(/addon cccbridge needs create/);
    expect(() =>
      worldJson({
        addons: ["create", "cccbridge"],
        peripherals: [{ name: "s", type: "scroller" }],
      }),
    ).not.toThrow();
  });
});

const ALL: WorldConfig = {
  // 1.18.2 (CC:C Bridge 1.5.1) unless a test says otherwise; the public default is newer
  version: "1.18.2",
  addons: ["create", "cccbridge"],
  peripherals: [
    { name: "a", type: "animatronic" },
    { name: "r", type: "redrouter", facing: "south", inputs: { up: 4 } },
    { name: "s", type: "scroller", value: 3, limit: 10 },
    { name: "src", type: "create_source" },
    { name: "tgt", type: "create_target" },
  ],
};

function surfaceTable(version: string): string {
  return `{ ${Object.entries(surface[version]!)
    .map(
      ([k, v]) =>
        `[${JSON.stringify(k)}] = { ${v.map((m) => JSON.stringify(m)).join(", ")} }`,
    )
    .join(", ")} }`;
}

describe.skipIf(!ready)("CC:C Bridge computer side", () => {
  it("the example: power_panel.test.lua", async () => {
    const world = JSON.parse(
      readFileSync(
        join(base.workspaceDir, "examples/cccbridge/power_panel.world.json"),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await runTests(
      base,
      {
        paths: ["examples/cccbridge/power_panel.test.lua"],
        world,
        timeScale: 5,
        timeoutMs: 90000,
      },
      1,
    );
    expectAllPassed(result);
  }, 120000);

  it("1.18.2 (1.5.1): getMethods order, events and quirks", async () => {
    const result = await lua(
      `
local expected = ${surfaceTable("1.5.1")}
ccunit.test("getMethods order", function()
  for _, name in ipairs({ "a", "r", "s", "src", "tgt" }) do
    ccunit.eq(peripheral.getMethods(name), expected[peripheral.getType(name)])
  end
end)

ccunit.test("redrouter: sides follow the facing; 1.5.1 never sends a redstone event", function()
  local r = peripheral.wrap("r")
  ccunit.eq(r.getAnalogInput("top"), 4) -- the neighbour above
  r.setAnalogOutput("front", 9)
  r.setOutput("left", true)
  local got = sim({ cmd = "cccbSetInput", peripheral = "r", side = "front", level = 12 })
  ccunit.eq(r.getAnalogInput("front"), 12)
  ccunit.eq(#named(got, "redstone"), 0)
  ccunit.eq(err(r.getInput, "sideways"), "bad argument #1 (unknown option sideways)")
  ccunit.eq(err(r.getInput, print), "bad argument #1 (string expected, got nil)") -- get() makes a function null
  r.setAnalogOutput("back", 2 ^ 32 + 5) -- getInt: the low 32 bits
  ccunit.eq(r.getAnalogOutput("back"), 5)
end)

ccunit.test("source: monitor_resize from a display link, its name then an empty table", function()
  local src = peripheral.wrap("src")
  ccunit.eq({ src.getSize() }, { 4, 2 })
  src.write("ab")
  local got = named(sim({ cmd = "cccbLinkSource", peripheral = "src", rows = 3, columns = 6, read = true }), "monitor_resize")
  ccunit.eq(#got, 1)
  ccunit.eq({ got[1][1], got[1][2], got[1][3], got[1].n }, { "monitor_resize", "src", {}, 3 })
  ccunit.eq({ src.getSize() }, { 6, 3 })
  ccunit.eq(src.getLine(1), "ab    ") -- resizing keeps the text
end)

ccunit.test("target: lines from a display link keep the rest", function()
  local t = peripheral.wrap("tgt")
  sim({ cmd = "cccbLinkTarget", peripheral = "tgt", line = 1, lines = { "one", "two" } })
  sim({ cmd = "cccbLinkTarget", peripheral = "tgt", line = 2, lines = { "x" } })
  ccunit.eq(t.getLine(1):sub(1, 4), "one ")
  ccunit.eq(t.getLine(2):sub(1, 4), "x   ")
end)

ccunit.test("scroller: the limit and value", function()
  local s = peripheral.wrap("s")
  ccunit.eq(s.getLimit(), 10)
  ccunit.eq(s.getValue(), 3)
  s.setLimit(-2147483648) -- Math.abs of the smallest int is negative, so the clamp makes it 1
  ccunit.eq(s.getLimit(), 1)
end)
`,
      ALL,
      "cccb_118.test.lua",
    );
    expectAllPassed(result);
  });

  it("1.18.2: sim state and commands", async () => {
    await withSession(
      {
        ...ALL,
        peripherals: [
          ...ALL.peripherals!,
          {
            name: "lnk",
            type: "create_source",
            link: { rows: 2, columns: 5 },
          },
          {
            name: "locked",
            type: "scroller",
            locked: true,
          },
        ],
      },
      async (step) => {
        let st = await step({
          cmd: "cccbSetInput",
          peripheral: "r",
          side: "north",
          level: 15,
        });
        expect(machine(st, "r")).toMatchObject({
          facing: "south",
          inputs: { up: 4, north: 15 },
        });
        st = await step({ cmd: "advance", seconds: 2 });
        expect(machine(st, "lnk")).toMatchObject({
          width: 5,
          height: 2,
          sent: ["     ", "     "],
        });
        st = await step({
          cmd: "cccbScroll",
          peripheral: "s",
          value: 7,
        });
        expect(machine(st, "s")).toMatchObject({ value: 7, limit: 10 });
        st = await step({
          cmd: "cccbLinkTarget",
          peripheral: "tgt",
          lines: ["hello"],
        });
        expect((machine(st, "tgt").lines as string[])[0]).toBe(
          "hello" + " ".repeat(27),
        );
        // toCCTxt: é is CC's 233, § (not in CC's charset: 167 is a full block there) is "?"
        st = await step({
          cmd: "cccbLinkTarget",
          peripheral: "tgt",
          line: 2,
          lines: ["é§"],
        });
        expect((machine(st, "tgt").lines as string[])[1]).toBe(
          "é? " + " ".repeat(29),
        );
        expect(machine(st, "a")).toMatchObject({ face: "normal", pushes: 0 });
      },
    );
  }, 60000);

  it("1.20.1 (1.7.1): the new API, the redstone event and the shared attachment list", async () => {
    const result = await lua(
      `
local expected = ${surfaceTable("1.7")}
ccunit.test("getMethods order", function()
  for _, name in ipairs({ "a", "r", "s", "src", "tgt" }) do
    ccunit.eq(peripheral.getMethods(name), expected[peripheral.getType(name)])
  end
end)

ccunit.test("animatronic: faces ignore case, transitions", function()
  local a = peripheral.wrap("a")
  a.setFace("HAPPY")
  ccunit.eq(err(a.setFace, "angry"), "Given string must be one of the following options: { normal, happy, question, sad }")
  a.setTransition("Linear")
  ccunit.eq(err(a.setTransition, "fast"), "Given string must be one of the following options: { rusty, none, linear }")
  ccunit.eq(err(a.setTransition), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(a.setFace, print), "bad argument #1 (string expected, got function)")
end)

ccunit.test("redstone: once per attached CC:C Bridge peripheral, each under its own name", function()
  local names = {}
  for _, e in ipairs(named(sim({ cmd = "cccbSetInput", peripheral = "r", side = "east", level = 3 }), "redstone")) do
    names[#names + 1] = e[2]
    ccunit.eq(e[3], {})
  end
  ccunit.eq(names, { "a", "r", "s", "src", "tgt" })
  -- the same level again changes nothing: no event
  ccunit.eq(#named(sim({ cmd = "cccbSetInput", peripheral = "r", side = "east", level = 3 }), "redstone"), 0)
  ccunit.eq(peripheral.call("r", "getAnalogInput", "left"), 3) -- facing south: left is east
end)

ccunit.test("scroller: setValue is quiet; a player's turn is not", function()
  local s = peripheral.wrap("s")
  s.setValue(-50)
  ccunit.eq(s.getValue(), -10)
  local got = named(sim({ cmd = "cccbScroll", peripheral = "s", value = 2 }), "scroller_changed")
  ccunit.eq(#got, 5) -- once per attached CC:C Bridge peripheral
  ccunit.eq({ got[1][2], got[1][3] }, { "a", { 2 } })
end)

ccunit.test("source: CC's TermMethods", function()
  local src = peripheral.wrap("src")
  ccunit.eq({ src.getSize() }, { 4, 2 })
  ccunit.eq(src.isColour(), false)
  ccunit.eq(src.isColor(), false)
  ccunit.eq(src.getTextColour(), colours.white)
  ccunit.eq(src.getBackgroundColor(), colours.black)
  src.setTextColour(colours.red)
  ccunit.eq(src.getTextColor(), colours.red)
  src.setBackgroundColour(colours.blue + colours.white) -- the highest bit counts
  ccunit.eq(src.getBackgroundColour(), colours.blue)
  ccunit.eq(err(src.setTextColour, 0), "Colour out of range")
  ccunit.eq(err(src.setTextColour, 65536), "Colour out of range")
  ccunit.eq({ src.getPaletteColour(colours.white) }, { 0.9411764740943909, 0.9411764740943909, 0.9411764740943909 })
  src.setPaletteColour(colours.red, 0x102030)
  local r, g, b = src.getPaletteColor(colours.red)
  ccunit.eq(math.floor(r * 255 + 0.5), 16)
  ccunit.eq(math.floor(b * 255 + 0.5), 48)
  src.setPaletteColor(colours.red, 0.5, 0.25, 1)
  ccunit.eq({ src.getPaletteColour(colours.red) }, { 0.5, 0.25, 1 })
  ccunit.eq(err(src.setPaletteColour, colours.red, 0.5, 1), "bad argument #4 (number expected, got nil)")
  src.setPaletteColour(colours.red, 0.5) -- two arguments: the second is an RGB int, 0.5 truncates to 0 (black)
  ccunit.eq({ src.getPaletteColour(colours.red) }, { 0, 0, 0 })
  ccunit.eq(err(src.setPaletteColour, colours.red, 0 / 0, 1, 1), "bad argument #2 (number expected, got nan)")
  ccunit.eq(src.getCursorBlink(), false)
  src.setCursorBlink(true)
  ccunit.eq(src.getCursorBlink(), true)
  src.setCursorPos(1, 1)
  src.blit("ab", "01", "ff")
  ccunit.eq({ src.getCursorPos() }, { 3, 1 })
  ccunit.eq(err(src.blit, "ab", "0", "ff"), "Arguments must be the same length")
  ccunit.eq(src.getLine(1), "ab  ")
  src.write("cd")
  ccunit.eq(src.getLine(1), "abcd")
  src.scroll(-1)
  ccunit.eq(src.getLine(2), "abcd")
  src.clearLine()
  src.clear()
  ccunit.eq(src.getLine(2), "    ")
end)

ccunit.test("target: resize and dump; a link clears it first", function()
  local t = peripheral.wrap("tgt")
  ccunit.eq({ t.getSize() }, { 32, 8 })
  t.resize(3, 2)
  ccunit.eq(t.dump(), { "   ", "   " })
  ccunit.eq(err(t.resize, 0, 2), "The width and height of the terminal must be bigger than zero.")
  sim({ cmd = "cccbLinkTarget", peripheral = "tgt", line = 1, lines = { "x" } })
  sim({ cmd = "cccbLinkTarget", peripheral = "tgt", line = 2, lines = { "yz" } })
  ccunit.eq(t.dump(), { "   ", "yz " })
  ccunit.eq(err(t.getLine, 3), "Expected number in range 1-2")
end)
`,
      { ...ALL, version: "1.20.1" },
      "cccb_120.test.lua",
    );
    expectAllPassed(result);
  });

  it("1.21.1 (1.7.3): the target keeps its size in the block", async () => {
    const result = await lua(
      `
ccunit.test("a target sized before", function()
  ccunit.eq({ peripheral.call("tgt", "getSize") }, { 10, 3 })
  ccunit.eq(#peripheral.call("tgt", "dump"), 3)
  peripheral.call("a", "push") -- main thread on 1.21.1
  peripheral.call("tgt", "resize", 4, 4)
  ccunit.eq({ peripheral.call("tgt", "getSize") }, { 4, 4 })
end)
`,
      {
        addons: ["create", "cccbridge"],
        version: "1.21.1",
        peripherals: [
          { name: "a", type: "animatronic" },
          { name: "tgt", type: "create_target", width: 10, height: 3 },
        ],
      },
      "cccb_121.test.lua",
    );
    expectAllPassed(result);
  });
});
