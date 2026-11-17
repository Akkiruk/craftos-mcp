import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  type LinkedComputerSpec,
  type LinkedNetwork,
  type ModemSpec,
  type NetworkSpec,
  type WorldConfig,
  SessionManager,
  checkConfig,
  loadConfig,
  runTests,
} from "./index.js";

// Runs Lua on each computer the way tools/conformance/modem-compare.mjs does: code arrives as an event, the answer as a
// file, and everything the computer hears is logged with its full argument count.
const AGENT = `
local function shown(v)
  local ok, text = pcall(textutils.serialise, v, { compact = true })
  return ok and text or ("unserialisable " .. type(v))
end
local function agent()
  local h = fs.open("ready.dat", "w")
  h.close()
  while true do
    local _, request, code = os.pullEvent("test_exec")
    local chunk, err = load(code, "=remote", "t", _G)
    local results = chunk and table.pack(pcall(chunk)) or { false, err, n = 2 }
    local reply = {}
    for i = 1, results.n do reply[i] = results[i] == nil and textutils.json_null or results[i] end
    local out = fs.open("rc_" .. request .. ".tmp", "w")
    out.write(textutils.serialiseJSON(reply))
    out.close()
    fs.move("rc_" .. request .. ".tmp", "rc_" .. request .. ".dat")
  end
end
local function listen()
  while true do
    local e = table.pack(os.pullEvent())
    if e[1] == "modem_message" or e[1] == "rednet_message" or e[1] == "peripheral" or e[1] == "peripheral_detach" then
      local h = fs.open("rx.log", "a")
      h.writeLine(textutils.serialiseJSON({ event = e[1], n = e.n, a = e[2], b = e[3], c = shown(e[4]), d = shown(e[5]), e = e[6] or textutils.json_null }))
      h.close()
    end
  end
end
parallel.waitForAny(agent, listen)
`;

interface Heard {
  event: string;
  n: number;
  a: unknown;
  b: unknown;
  c: string;
  d: string;
  e: unknown;
}

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "network-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
writeFileSync(join(scratch, "startup.lua"), AGENT);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const wireless = (name = "top"): ModemSpec => ({ name, type: "modem" });
const ender = (name = "top"): ModemSpec => ({
  name,
  type: "modem",
  kind: "ender",
});

/** A world at x, y 70, with these modems. */
const place = (
  computerId: number,
  x: number,
  peripherals: WorldConfig["peripherals"],
  extra: WorldConfig = {},
): WorldConfig => ({
  computerId,
  position: { x, y: 70, z: 0 },
  peripherals,
  ...extra,
});

class Rig {
  readonly manager = new SessionManager(config);
  readonly linked: LinkedNetwork;
  private request = 0;

  constructor(spec: NetworkSpec) {
    this.linked = this.manager.createNetwork(spec);
  }

  private dir(name: string): string {
    const handle = this.linked.computers[name]!.handle;
    const id = JSON.parse(
      readFileSync(join(handle.resultsDir, "world.json"), "utf8"),
    ).computerId as number;
    return join(handle.dir, "computer", String(id));
  }

  async up(): Promise<this> {
    for (const name of Object.keys(this.linked.computers)) {
      const end = Date.now() + 20000;
      while (!existsSync(join(this.dir(name), "ready.dat"))) {
        if (Date.now() > end) throw new Error(`${name} did not start`);
        await sleep(20);
      }
    }
    return this;
  }

  /** Run Lua on a computer and return its results; a Lua error rejects. */
  async lua(name: string, code: string): Promise<unknown[]> {
    const request = ++this.request;
    this.linked.computers[name]!.handle.session.event(
      "test_exec",
      request,
      code,
    );
    const file = join(this.dir(name), `rc_${request}.dat`);
    const end = Date.now() + 10000;
    while (!existsSync(file)) {
      if (Date.now() > end) throw new Error(`no answer from ${name}`);
      await sleep(5);
    }
    const [ok, ...results] = JSON.parse(readFileSync(file, "utf8")) as [
      boolean,
      ...unknown[],
    ];
    if (!ok) throw new Error(String(results[0]));
    return results;
  }

  heard(name: string, event = "modem_message"): Heard[] {
    const file = join(this.dir(name), "rx.log");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Heard)
      .filter((entry) => entry.event === event);
  }

  clear(name: string): void {
    rmSync(join(this.dir(name), "rx.log"), { force: true });
  }

  /** Wait until a computer has heard `count` of an event, then long enough for any extra one to show. */
  async hears(
    name: string,
    count: number,
    event = "modem_message",
  ): Promise<Heard[]> {
    const end = Date.now() + 5000;
    while (this.heard(name, event).length < count && Date.now() < end)
      await sleep(10);
    await sleep(120);
    return this.heard(name, event);
  }

  close(): Promise<void> {
    return this.manager.destroyAll();
  }
}

const open = (channel = 100): string =>
  `for _, n in ipairs(peripheral.getNames()) do if peripheral.hasType(n, "modem") then peripheral.call(n, "open", ${channel}) end end return true`;
const send = (body = `"hi"`, modem = "peripheral.find('modem')"): string =>
  `${modem}.transmit(100, 7, ${body}) return true`;

let rig: Rig | undefined;

async function start(
  computers: LinkedComputerSpec[],
  wired?: NetworkSpec["wired"],
): Promise<Rig> {
  rig = new Rig({ computers, ...(wired ? { wired } : {}) });
  return rig.up();
}

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const ONE_MINUTE = 60000;

describe.skipIf(!ready)("modems over a linked network", () => {
  it(
    "reaches exactly the real range, on height and in both directions",
    async () => {
      const r = await start([
        { name: "a", world: place(1, 0, [wireless()]) },
        { name: "near", world: place(2, 64, [wireless()]) },
        { name: "far", world: place(3, 65, [wireless()]) },
        {
          name: "high",
          world: {
            ...place(4, 200, [wireless()]),
            position: { x: 200, y: 300, z: 0 },
          },
        },
      ]);
      for (const n of ["a", "near", "far", "high"]) await r.lua(n, open());
      await r.lua("a", send());
      expect((await r.hears("near", 1)).map((h) => h.e)).toEqual([64]);
      expect(r.heard("far")).toEqual([]);
      // 300 up reaches 356.7, and the low modem shares the larger reach: both ways
      expect(r.heard("high").length).toBe(1);
      r.clear("a");
      await r.lua("high", send());
      const back = await r.hears("a", 1);
      expect(back[0]!.e).toBeCloseTo(Math.hypot(200, 230), 9);
    },
    ONE_MINUTE,
  );

  it(
    "takes the storm range from the world, and the sim config",
    async () => {
      const r = await start([
        {
          name: "a",
          world: place(1, 0, [wireless()], {
            config: { modemRangeDuringStorm: 16 },
            environment: { raining: true, thunder: true },
          }),
        },
        {
          name: "b",
          world: place(2, 20, [wireless()], {
            config: { modemRangeDuringStorm: 16 },
            environment: { raining: true, thunder: true },
          }),
        },
      ]);
      await r.lua("b", open());
      await r.lua("a", send());
      await sleep(250);
      expect(r.heard("b")).toEqual([]);
    },
    ONE_MINUTE,
  );

  it(
    "crosses distance and dimensions with an ender modem, with nil distance across dimensions",
    async () => {
      const r = await start([
        { name: "ender", world: place(1, 0, [ender()]) },
        { name: "farEnder", world: place(2, 9000, [ender()]) },
        { name: "farNormal", world: place(3, 9000, [wireless()]) },
        {
          name: "nether",
          world: {
            ...place(4, 0, [wireless()]),
            position: { x: 0, y: 70, z: 0, dimension: "minecraft:the_nether" },
          },
        },
        { name: "plain", world: place(5, 9500, [wireless()]) },
      ]);
      for (const n of ["ender", "farEnder", "farNormal", "nether", "plain"])
        await r.lua(n, open());
      await r.lua("ender", send());
      expect((await r.hears("farNormal", 1))[0]!.e).toBe(9000);
      expect(r.heard("farEnder")[0]!.e).toBe(9000);
      const across = r.heard("nether")[0]!;
      expect(across.e).toBeNull();
      expect(across.n).toBe(5); // no distance argument at all
      // A normal modem reaches an ender modem at any range, not another normal one
      r.clear("ender");
      await r.lua("plain", send());
      expect((await r.hears("ender", 1)).length).toBe(1);
      expect(r.heard("farNormal").length).toBe(1);
    },
    ONE_MINUTE,
  );

  it(
    "carries messages like the real conversion",
    async () => {
      const r = await start([
        { name: "a", world: place(1, 0, [wireless()]) },
        { name: "b", world: place(2, 5, [wireless()]) },
      ]);
      await r.lua("b", open());
      await r.lua(
        "a",
        `local m = peripheral.find("modem")
        local shared = { 1 }
        local loop = {}
        loop.me = loop
        m.transmit(100, 7, { x = shared, y = shared })
        m.transmit(100, 7, loop)
        m.transmit(100, 7, { [true] = "yes", [1.5] = "half", f = print, [print] = 1, [{ 1 }] = "key" })
        m.transmit(100, 7, { bytes = string.char(0, 10, 13, 37, 127, 128, 255), big = 1e300, tiny = -0.1, inf = math.huge })
        m.transmit(100, 7, string.rep("x", 200000))
        local late = { v = 1 }
        m.transmit(100, 7, late)
        late.v = 2
        return true`,
      );
      const got = await r.hears("b", 6);
      expect(got.length).toBe(6);
      expect(got[0]!.d).toBe("unserialisable table"); // repeated entries survived
      expect(got[1]!.d).toBe("unserialisable table"); // and so did the cycle
      expect(got[2]!.d).toContain('[ true ]="yes"'.replace(/ /g, ""));
      expect(got[2]!.d).toContain('[1.5]="half"');
      expect(got[2]!.d).not.toContain("f=");
      expect(got[4]!.d.length).toBeGreaterThan(200000);
      expect(got[5]!.d).toBe("{v=1,}"); // frozen when it was sent
    },
    ONE_MINUTE,
  );

  it(
    "keeps identity and bytes, and gives every receiver its own copy",
    async () => {
      const r = await start([
        { name: "a", world: place(1, 0, [wireless()]) },
        {
          name: "b",
          world: place(2, 5, [wireless("top"), wireless("bottom")]),
        },
      ]);
      await r.lua("b", open());
      // Looks at the message from inside the receiver, two modems so two copies
      const looked = r.lua(
        "b",
        `local _, side1, _, _, one = os.pullEvent("modem_message")
        local _, side2, _, _, two = os.pullEvent("modem_message")
        local same = 0
        for i = 0, 255 do if one.bytes:byte(i + 1) == i then same = same + 1 end end
        return {
          sides = { side1, side2 },
          shared = one.x == one.y,
          loop = one.me == one,
          copies = one ~= two and one.x ~= two.x,
          bytes = same,
          huge = one.huge == math.huge,
          nan = one.nan ~= one.nan,
          tiny = one.tiny == 1e-300,
        }`,
      );
      await sleep(100);
      await r.lua(
        "a",
        `local bytes = {}
        for i = 0, 255 do bytes[i + 1] = string.char(i) end
        local shared = {}
        local message = { x = shared, y = shared, bytes = table.concat(bytes), huge = math.huge, nan = 0 / 0, tiny = 1e-300 }
        message.me = message
        peripheral.find("modem").transmit(100, 7, message)
        return true`,
      );
      expect((await looked)[0]).toMatchObject({
        shared: true,
        loop: true,
        copies: true,
        bytes: 256,
        huge: true,
        nan: true,
        tiny: true,
      });
    },
    ONE_MINUTE,
  );

  it(
    "has the real surface and errors",
    async () => {
      // measured on 1.18.2: CC:Tweaked 1.101.3 puts "pcall: " in front of a Java method's error, 1.121.0 does not
      const r = await start([
        {
          name: "a",
          world: { ...place(1, 0, [wireless()]), version: "1.18.2" },
        },
        {
          name: "w",
          world: {
            ...place(2, 5, [
              { name: "left", type: "modem", kind: "wired", network: "n" },
            ]),
            version: "1.18.2",
          },
        },
      ]);
      const [out] = await r.lua(
        "a",
        `local m = peripheral.find("modem")
        local function try(f, ...) local r = { pcall(f, ...) } return { r[1], r[2] } end
        return {
          methods = peripheral.getMethods("top"),
          types = { peripheral.getType("top") },
          big = try(m.open, 4294967396),
          nan = try(m.open, 0 / 0),
          inf = try(m.open, math.huge),
          none = try(m.open),
          badChannel = try(m.transmit, -1, 1),
          badType = try(m.transmit, 1, "x"),
          closeBad = try(m.close, 70000),
          isOpenBad = try(m.isOpen, 70000),
          closed = m.isOpen(5),
        }`,
      );
      expect(out).toMatchObject({
        methods: [
          "transmit",
          "isOpen",
          "closeAll",
          "isWireless",
          "close",
          "open",
        ],
        types: ["modem"],
        big: [true], // a Java int: 4294967396 wraps round to 100
        nan: [false, "pcall: bad argument #1 (number expected, got nan)"],
        inf: [false, "pcall: bad argument #1 (number expected, got inf)"],
        none: [false, "pcall: bad argument #1 (number expected, got nil)"],
        badChannel: [false, "pcall: Expected number in range 0-65535"],
        badType: [
          false,
          "pcall: bad argument #2 (number expected, got string)",
        ],
        closeBad: [false, "pcall: Expected number in range 0-65535"],
        isOpenBad: [false, "pcall: Expected number in range 0-65535"],
        closed: false,
      });
      const [wired] = await r.lua(
        "w",
        `local m = peripheral.wrap("left")
        local function try(f, ...) local r = { pcall(f, ...) } return { r[1], r[2] } end
        return {
          wireless = m.isWireless(),
          hub = peripheral.hasType("left", "peripheral_hub"),
          missing = try(m.callRemote, "nope", "x"),
          noType = m.getTypeRemote("nope") == nil,
          noMethods = m.getMethodsRemote("nope") == nil,
          noHas = m.hasTypeRemote("nope", "x") == nil,
          numberName = try(m.isPresentRemote, 5),
        }`,
      );
      expect(wired).toMatchObject({
        wireless: false,
        hub: true,
        missing: [false, "pcall: No peripheral: nope"],
        noType: true,
        noMethods: true,
        noHas: true,
        numberName: [
          false,
          "pcall: bad argument #1 (string expected, got number)",
        ],
      });
    },
    ONE_MINUTE,
  );

  it(
    "joins wired computers along cables, shares peripherals and follows the switch",
    async () => {
      const block = (x: number) => ({ x, y: 70, z: 0 });
      const r = await start(
        [
          {
            name: "a",
            world: place(1, 0, [
              { name: "right", type: "modem", kind: "wired", block: block(1) },
            ]),
          },
          {
            name: "b",
            world: place(2, 10, [
              { name: "left", type: "modem", kind: "wired", block: block(9) },
            ]),
          },
          {
            name: "cut",
            world: place(3, 20, [
              { name: "left", type: "modem", kind: "wired", block: block(19) },
            ]),
          },
          {
            name: "off",
            world: place(4, 30, [
              {
                name: "left",
                type: "modem",
                kind: "wired",
                block: block(5),
                on: false,
              },
            ]),
          },
        ],
        [
          {
            cables: [2, 3, 4, 5, 6, 7, 8].map(block),
            peripherals: [{ name: "speaker_7", type: "speaker" }],
          },
        ],
      );
      for (const n of ["a", "b", "cut", "off"]) await r.lua(n, open());
      await r.lua("a", send(`"wired"`, `peripheral.wrap("right")`));
      expect((await r.hears("b", 1))[0]!.e).toBe(10);
      expect(r.heard("cut")).toEqual([]);
      // Switched off, a modem still hangs on the cable: only its computer is not on offer
      expect(r.heard("off").length).toBe(1);
      expect((await r.lua("a", `return peripheral.getNames()`))[0]).toEqual([
        "right",
        ...((
          await r.lua("a", `return peripheral.wrap("right").getNamesRemote()`)
        )[0] as string[]),
      ]);
      expect(
        (await r.lua("a", `return peripheral.wrap("right").getNameLocal()`))[0],
      ).toBe("computer_0");
      expect(
        (await r.lua("off", `return peripheral.wrap("left").getNameLocal()`))
          .length,
      ).toBe(0);
      expect(
        (await r.lua("a", `return peripheral.isPresent("computer_3")`))[0],
      ).toBe(false);
      // Through callRemote and through the name, the same speaker methods
      await r.lua(
        "a",
        `peripheral.wrap("right").callRemote("speaker_7", "playSound", "minecraft:block.note_block.bell") peripheral.call("speaker_7", "playNote", "harp") return true`,
      );
      await r.lua(
        "a",
        `return peripheral.wrap("right").getTypeRemote("speaker_7")`,
      );
      expect(
        (await r.lua("a", `return peripheral.getType("speaker_7")`))[0],
      ).toBe("speaker");

      // The other computer as a peripheral
      expect(
        await r.lua(
          "a",
          `local c = peripheral.wrap("computer_1") return c.getID(), c.isOn(), peripheral.getType("computer_1")`,
        ),
      ).toEqual([2, true, "computer"]);

      // Right-click the off modem: everyone on the cable sees computer_3 arrive
      r.clear("a");
      r.linked.network.setModemOn("off", "left", true);
      const arrived = await r.hears("a", 1, "peripheral");
      expect(arrived.map((h) => h.a)).toEqual(["computer_3"]);
      expect(
        (
          await r.lua("off", `return peripheral.wrap("left").getNameLocal()`)
        )[0],
      ).toBe("computer_3");
      r.linked.network.setModemOn("off", "left", false);
      expect(
        (await r.hears("a", 1, "peripheral_detach")).map((h) => h.a),
      ).toEqual(["computer_3"]);
    },
    ONE_MINUTE,
  );

  it(
    "drops wired messages past 256 blocks of cable",
    async () => {
      const line = (from: number, to: number) => {
        const out = [];
        for (let x = from; x <= to; x++) out.push({ x, y: 70, z: 0 });
        return out;
      };
      const r = await start(
        [
          {
            name: "a",
            world: place(1, 0, [
              {
                name: "right",
                type: "modem",
                kind: "wired",
                block: { x: 1, y: 70, z: 0 },
              },
            ]),
          },
          {
            name: "edge",
            world: place(2, 256, [
              {
                name: "left",
                type: "modem",
                kind: "wired",
                block: { x: 255, y: 70, z: 0 },
              },
            ]),
          },
          {
            name: "past",
            world: place(3, 257, [
              {
                name: "left",
                type: "modem",
                kind: "wired",
                block: { x: 256, y: 70, z: 0 },
              },
            ]),
          },
        ],
        [{ cables: line(2, 300) }],
      );
      await r.lua("edge", open());
      await r.lua("past", open());
      await r.lua("a", send(`"along"`, `peripheral.wrap("right")`));
      expect((await r.hears("edge", 1))[0]!.e).toBe(256);
      expect(r.heard("past")).toEqual([]);
    },
    ONE_MINUTE,
  );

  it(
    "runs the unmodified rednet over wireless and wired",
    async () => {
      const r = await start([
        { name: "a", world: place(1, 0, [wireless()]) },
        { name: "b", world: place(2, 40, [wireless()]) },
        { name: "far", world: place(3, 110, [wireless()]) },
      ]);
      for (const n of ["a", "b", "far"])
        await r.lua(n, `rednet.open("top") return rednet.isOpen()`);
      await r.lua(
        "a",
        `rednet.broadcast({ kind = "hello" }, "demo.v2") return true`,
      );
      const near = await r.hears("b", 1, "rednet_message");
      expect(near[0]).toMatchObject({
        a: 1,
        b: { kind: "hello" },
        c: '"demo.v2"',
      });
      expect(r.heard("far", "rednet_message")).toEqual([]);
      expect(
        await r.lua("a", `return rednet.send(2, "direct", "demo.v2")`),
      ).toEqual([true]);
      expect((await r.hears("b", 2, "rednet_message"))[1]).toMatchObject({
        b: "direct",
      });
      expect(await r.lua("a", `return rednet.send(9999, "nobody")`)).toEqual([
        true,
      ]);
      await r.lua("b", `rednet.host("demo.v2", "hub") return true`);
      expect(
        await r.lua("a", `return rednet.lookup("demo.v2", "hub")`),
      ).toEqual([2]);
      expect(
        await r.lua("far", `return rednet.lookup("demo.v2", "hub")`),
      ).toEqual([null]);
    },
    ONE_MINUTE,
  );

  it(
    "moves computers, keeps the place across a reboot, and hears after one",
    async () => {
      const r = await start([
        { name: "a", world: place(1, 0, [wireless()]) },
        { name: "b", world: place(2, 40, [wireless()]) },
      ]);
      await r.lua("b", open());
      r.linked.network.move("b", { x: 500 });
      await sleep(100);
      await r.lua("a", send());
      await sleep(250);
      expect(r.heard("b")).toEqual([]);
      r.linked.network.move("b", { x: 40, dimension: "minecraft:the_nether" });
      await sleep(100);
      await r.lua("a", send());
      await sleep(250);
      expect(r.heard("b")).toEqual([]);
      r.linked.network.move("b", { x: 50, dimension: "minecraft:overworld" });
      await sleep(100);
      await r.lua("a", send());
      expect((await r.hears("b", 1))[0]!.e).toBe(50);

      // A reboot closes every channel; the computer stays where it was put
      const handle = r.linked.computers["b"]!.handle;
      handle.sendCommand({ cmd: "reboot" });
      await sleep(300);
      const file = join(handle.dir, "computer", "2", "ready.dat");
      rmSync(file, { force: true });
      const end = Date.now() + 15000;
      while (!existsSync(file) && Date.now() < end) await sleep(20);
      expect(
        (await r.lua("b", `return peripheral.find("modem").isOpen(100)`))[0],
      ).toBe(false);
      await r.lua("b", open());
      r.clear("b");
      await r.lua("a", send());
      expect((await r.hears("b", 1))[0]!.e).toBe(50);
    },
    ONE_MINUTE,
  );
});

describe.skipIf(!ready)("modems on one computer", () => {
  function runLua(lua: string, world: WorldConfig, monitors = false) {
    const dir = mkdtempSync(join(tmpdir(), "modem-one-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "case.test.lua"), lua);
    const cfg = { ...base, workspaceDir: dir };
    return runTests(
      cfg,
      {
        paths: ["case.test.lua"],
        world,
        timeoutMs: 20000,
        ...(monitors
          ? { monitors: [{ name: "monitor_0", blocksWide: 1, blocksHigh: 1 }] }
          : {}),
      },
      1,
    ).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  const passed = (result: Awaited<ReturnType<typeof runLua>>): void => {
    const failures = result.files.flatMap((f) =>
      f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
    );
    expect(failures).toEqual([]);
    expect(result.files.map((f) => f.status)).toEqual(["passed"]);
  };

  it("needs no relay: two modems on one computer hear each other, a modem not itself", async () => {
    passed(
      await runLua(
        `
ccunit.test("hears only the other modem", function()
  local top, bottom = peripheral.wrap("top"), peripheral.wrap("bottom")
  top.open(5)
  bottom.open(5)
  top.transmit(5, 6, "up")
  local e = table.pack(os.pullEvent("modem_message"))
  ccunit.eq(e[2], "bottom")
  ccunit.eq(e[5], "up")
  ccunit.eq(e[6], 0)
  local timer = os.startTimer(0.1)
  while true do
    local ev, id = os.pullEvent()
    ccunit.truthy(ev ~= "modem_message")
    if ev == "timer" and id == timer then break end
  end
end)
ccunit.test("a closed channel hears nothing", function()
  local top, bottom = peripheral.wrap("top"), peripheral.wrap("bottom")
  bottom.closeAll()
  top.transmit(5, 6, "up")
  local timer = os.startTimer(0.1)
  while true do
    local ev, id = os.pullEvent()
    ccunit.truthy(ev ~= "modem_message")
    if ev == "timer" and id == timer then break end
  end
end)
ccunit.test("128 channels and no more, re-opening costs nothing", function()
  local top = peripheral.wrap("top")
  top.closeAll()
  for c = 1, 128 do top.open(c) end
  top.open(1)
  ccunit.raises(function() top.open(129) end)
  top.close(1)
  top.open(129)
end)
`,
        {
          peripherals: [
            { name: "top", type: "modem" },
            { name: "bottom", type: "modem", kind: "ender" },
          ],
        },
      ),
    );
  });

  it("lists a modem with any name, and a named monitor with no modem", async () => {
    passed(
      await runLua(
        `
ccunit.test("names", function()
  local names = table.concat(peripheral.getNames(), " ")
  ccunit.truthy(names:find("modem_0", 1, true))
  ccunit.truthy(names:find("monitor_0", 1, true))
  ccunit.eq(peripheral.getType("modem_0"), "modem")
  ccunit.eq(peripheral.__ccsimNamed, nil)
end)
ccunit.test("rednet finds it", function()
  rednet.open("modem_0")
  ccunit.truthy(rednet.isOpen("modem_0"))
end)
`,
        { peripherals: [{ name: "modem_0", type: "modem" }] },
        true,
      ),
    );
  });
});
