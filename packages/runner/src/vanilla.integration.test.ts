import {
  cpSync,
  existsSync,
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
  type LinkedNetwork,
  type RunnerConfig,
  type TestRunResult,
  type WorldConfig,
  SessionManager,
  checkConfig,
  loadConfig,
  runProgram,
  runTests,
} from "./index.js";

/** Plain CC:Tweaked 1.101.3 with Advanced Peripherals 0.7.31r and Mekanism behaving as they ship. */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "vanilla-ws-"));
const config: RunnerConfig = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

const strippedConfig = (cfg: RunnerConfig = config): RunnerConfig => cfg;

// Computers on one cable run this: it executes Lua sent as a `test_exec` event and leaves the results in a file.
const AGENT = `
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
`;
const cableWs = mkdtempSync(join(tmpdir(), "vanilla-cable-"));
writeFileSync(join(cableWs, "startup.lua"), AGENT);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Two computers, `a` (id 1) and `b` (id 2), on one cable with two chests; the first holds 5 diamonds. */
async function cableOfTwo(
  cfg: RunnerConfig,
  world: (id: number) => WorldConfig,
): Promise<{
  manager: SessionManager;
  lua: (name: string, code: string) => Promise<unknown[]>;
}> {
  const manager = new SessionManager({ ...cfg, workspaceDir: cableWs });
  const net: LinkedNetwork = manager.createNetwork({
    computers: [
      { name: "a", world: world(1) },
      { name: "b", world: world(2) },
    ],
    wired: [
      {
        id: "floor",
        peripherals: [
          {
            name: "minecraft:chest_0",
            type: "minecraft:chest",
            size: 27,
            items: { "1": { name: "minecraft:diamond", count: 5 } },
          },
          { name: "minecraft:chest_1", type: "minecraft:chest", size: 27 },
        ],
      },
    ],
  });
  const dir = (name: string): string => {
    const handle = net.computers[name]!.handle;
    const id = JSON.parse(
      readFileSync(join(handle.resultsDir, "world.json"), "utf8"),
    ).computerId as number;
    return join(handle.dir, "computer", String(id));
  };
  for (const name of ["a", "b"]) {
    const end = Date.now() + 20000;
    while (!existsSync(join(dir(name), "ready.dat"))) {
      if (Date.now() > end) throw new Error(`${name} did not start`);
      await sleep(20);
    }
  }
  await sleep(150); // every computer's directory entry has gone round
  let request = 0;
  const lua = async (name: string, code: string): Promise<unknown[]> => {
    const id = ++request;
    net.computers[name]!.handle.session.event("test_exec", id, code);
    const file = join(dir(name), `rc_${id}.dat`);
    const end = Date.now() + 15000;
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
  };
  return { manager, lua };
}

const onCable = (extra: WorldConfig) => (id: number) => ({
  ...extra,
  computerId: id,
  position: { x: id * 10, y: 70, z: 0 },
  peripherals: [
    {
      name: "back",
      type: "modem" as const,
      kind: "wired" as const,
      network: "floor",
    },
  ],
});

/** How many items each chest on the cable holds, as one computer sees them. */
const COUNTS = `local function n(name)
  local total = 0
  for _, item in pairs(peripheral.call(name, "list")) do total = total + item.count end
  return total
end
return n("minecraft:chest_0"), n("minecraft:chest_1")`;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(cableWs, { recursive: true, force: true });
});

function put(dir: string, name: string, content: string): void {
  const file = join(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
  cfg: RunnerConfig = config,
): Promise<TestRunResult> {
  put(cfg.workspaceDir, name, source);
  return runTests(cfg, { paths: [name], world, timeoutMs: 25000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

/** A sim command from inside the program, as the host would send it (no sequence number). */
const SIM = `local function sim(cmd) os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON(cmd)) end`;

const off: WorldConfig = {
  players: [{ name: "Alice", x: 1, y: 64, z: 0 }],
  peripherals: [
    { name: "cb", type: "chatBox" },
    { name: "top", type: "modem", kind: "ender" },
  ],
};

describe.skipIf(!ready)("Advanced Peripherals as it ships", () => {
  it('keeps AP\'s own hidden "$" channel', async () => {
    const result = await lua(
      `
${SIM}
ccunit.test("a $ message reaches the chat box, hidden, with every $ taken out", function()
  sim({ cmd = "chat", player = "Alice", message = "$se$cret" })
  local _, user, message, uuid, hidden = os.pullEvent("chat")
  ccunit.eq(user, "Alice")
  ccunit.eq(message, "secret")
  ccunit.eq(uuid, "00000000-0000-4000-8000-000000000001")
  ccunit.eq(hidden, true)
end)

ccunit.test("a plain message is not hidden", function()
  sim({ cmd = "chat", player = "Alice", message = "hello" })
  local _, _, message, _, hidden = os.pullEvent("chat")
  ccunit.eq(message, "hello")
  ccunit.eq(hidden, false)
end)
`,
      off,
      "dollar.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("runs the chat box's formatted messages, on AP's 100 ms cooldown", async () => {
    put(
      scratch,
      "formatted.lua",
      `
local cb = peripheral.wrap("cb")
local function check(label, ok, err) print(label .. "=" .. tostring(ok) .. "/" .. tostring(err)) end
local t0 = os.epoch("utc")
check("f1", cb.sendFormattedMessage('{"text":"Hello","extra":[{"text":" world","color":"red"}]}'))
check("cd", cb.sendMessage("too soon"))
print("ms=" .. (os.epoch("utc") - t0))
sleep(0.15)
check("bad", cb.sendFormattedMessage("null"))
sleep(0.15)
check("br", cb.sendFormattedMessage('"x"', "P", "[[["))
sleep(0.15)
check("f2", cb.sendFormattedMessageToPlayer('["A",{"text":"B"}]', "Alice", "Box", "<>"))
sleep(0.15)
check("who", cb.sendFormattedMessageToPlayer('"x"', "Nobody"))
`,
    );
    const result = await runProgram(config, {
      program: "formatted.lua",
      world: off,
      timeoutMs: 20000,
    });
    expect(result.status).toBe("completed");
    const text = result.screens[0]!.lines.join("\n");
    expect(text).toContain("f1=true/nil");
    // The cooldown is 100 ms of the real clock. If the two calls (measured from before the first to after the second,
    // so it brackets them) came within 100 ms the second has to be refused; a busy machine can make them come later,
    // and then the second goes through, as it would on a real server.
    const ms = Number(/ms=(\d+)/.exec(text)![1]);
    const refused = text.includes("cd=nil/chatMessage is on cooldown");
    if (ms < 100) expect(refused).toBe(true);
    else expect(refused || text.includes("cd=true/nil")).toBe(true);
    const late = !refused;
    expect(text).toContain("bad=nil/incorrect json");
    expect(text).toContain("br=nil/incorrect bracket string"); // the rest wraps
    expect(text).toContain("f2=true/nil");
    expect(text).toContain("who=nil/incorrect player name/uuid");
    const chat = (result.sim?.chat ?? []) as { to: string; text: string }[];
    expect(
      chat.map((c) => c.text).filter((t) => !t.includes("too soon")),
    ).toEqual(["[§rAP]§r Hello world", "<§rBox>§r AB"]);
    expect(chat.some((c) => c.text.includes("too soon"))).toBe(late);
    expect(chat.every((c) => c.to === "Alice")).toBe(true);
  }, 60000);

  it("answers isSlimeChunk as vanilla does for the world seed", async () => {
    // From java.util.Random with WorldgenRandom.seedSlimeChunk's formula (JDK 21), chunk x -8..7 by z -8..7, then the
    // chunks in FAR. Rows are x, columns z.
    const javaGrid: Record<string, string> = {
      "0": "0000000011001000000000000100000000000000000000000000000000000100110000000000000001000000000000000000000010000000000000000000001000000000000000000000010000000000000001000010100000000000000000000000000000100000000001000000000000000001000000000001100001000000|0000000",
      "12345":
        "0100001000000000000000000101000000000000000000000000000000100000000000001000000000000000000000010000100001001000000000000010000000100010000000010000000000000000000000000000000000000000100001000011010001000000000001000000000000000010000000010000000000000000|0000110",
      "-4172144997902289642":
        "1000000001000000000000100000000001010000000000000000000000110000000010000000000000001000000000000001000000010000000100000000000011000000000000000000000011000000000100000000000000000000100000000000101000010000101100000000000000110000000000000000000000000000|0100000",
    };
    const FAR = [
      [0, 0],
      [1, 0],
      [-1, -1],
      [2, 5],
      [-7, 3],
      [100000, -200000],
      [1875000, -1875000],
    ];
    const chunks: [number, number][] = [];
    for (let x = -8; x < 8; x++)
      for (let z = -8; z < 8; z++) chunks.push([x, z]);
    chunks.push(...(FAR as [number, number][]));
    for (const [seed, expected] of Object.entries(javaGrid)) {
      // a seed past 2^53 goes as a string
      const seedValue = Number.isSafeInteger(Number(seed))
        ? Number(seed)
        : seed;
      const world: WorldConfig = {
        environment: { seed: seedValue },
        peripherals: chunks.map(([x, z], i) => ({
          name: `env_${i}`,
          type: "environmentDetector" as const,
          x: x * 16 + 5,
          y: 64,
          z: z * 16 + 11,
        })),
      };
      put(
        scratch,
        "slime.lua",
        `local out = {}
for i = 0, ${chunks.length - 1} do out[#out + 1] = peripheral.call("env_" .. i, "isSlimeChunk") and "1" or "0" end
local s = table.concat(out)
print("S=" .. s:sub(1, 256) .. "|" .. s:sub(257))`,
      );
      const result = await runProgram(config, {
        program: "slime.lua",
        world,
        timeoutMs: 120000, // 279 calls of a tick each when idle; the clock is the real one
      });
      expect(result.status).toBe("completed");
      const line = result.screens[0]!.lines.join("").replace(/\s+/g, "");
      expect(line).toContain(`S=${expected}`);
    }
  }, 400000);
});

describe.skipIf(!ready)("a plain computer", () => {
  it("boots and runs a program as plain CC:Tweaked", async () => {
    const cfg = strippedConfig();
    expect(checkConfig(cfg)).toEqual([]);

    put(
      scratch,
      "plain.lua",
      `
local cb = peripheral.wrap("cb")
local modem = peripheral.wrap("top")
print("types=" .. table.concat({ peripheral.getType("top") }, ","))
print("hub=" .. tostring(peripheral.hasType("top", "peripheral_hub")))
print("links=" .. tostring(modem.getLinks))
print("chest=" .. tostring(peripheral.wrap("chest").listDetailed) .. "/" .. #peripheral.wrap("chest").list())
print("fmt=" .. tostring(cb.sendFormattedMessage('{"text":"hi"}')))
os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON({ cmd = "chat", player = "Alice", message = "$x" }))
local _, _, message, _, hidden = os.pullEvent("chat")
print("chat=" .. message .. "/" .. tostring(hidden))
print("done")
`,
    );
    const result = await runProgram(cfg, {
      program: "plain.lua",
      world: {
        players: [{ name: "Alice" }],
        peripherals: [
          { name: "cb", type: "chatBox" },
          { name: "top", type: "modem", kind: "ender" },
          {
            name: "chest",
            type: "minecraft:chest",
            items: { 1: { name: "minecraft:dirt", count: 3 } },
          },
        ],
      },
      timeoutMs: 20000,
    });
    const text = result.screens[0]!.lines.join("\n");
    expect(text).not.toContain("ccsim failed to start");
    expect(result.status).toBe("completed");
    expect(text).toContain("types=modem");
    expect(text).toContain("hub=false");
    expect(text).toContain("links=nil");
    expect(text).toContain("chest=nil/1");
    expect(text).toContain("fmt=true");
    expect(text).toContain("chat=x/true");
    expect(text).toContain("done");
    expect(result.sim?.chat?.map((c) => c.text)).toEqual(["[§rAP]§r hi"]);
  }, 120000);

  it("shares one chest on a cable: what computer a pushes out, computer b finds gone", async () => {
    const { manager, lua } = await cableOfTwo(strippedConfig(), onCable({}));
    try {
      expect(
        await lua("a", `return peripheral.isPresent("minecraft:chest_0")`),
      ).toEqual([true]);
      expect(await lua("b", COUNTS)).toEqual([5, 0]);
      expect(
        await lua(
          "a",
          `return peripheral.call("minecraft:chest_0", "pushItems", "minecraft:chest_1", 1, 4)`,
        ),
      ).toEqual([4]);
      expect(await lua("b", COUNTS)).toEqual([1, 4]);
      expect(
        await lua(
          "b",
          `return peripheral.wrap("minecraft:chest_1").getItemDetail(1).count`,
        ),
      ).toEqual([4]);
    } finally {
      await manager.destroyAll();
    }
  }, 120000);
});

describe.skipIf(!ready)("a wired network", () => {
  it("shares one chest between every computer on the cable", async () => {
    const { manager, lua } = await cableOfTwo(config, onCable({}));
    try {
      expect(
        await lua(
          "b",
          `return peripheral.call("minecraft:chest_0", "pushItems", "minecraft:chest_1", 1, 2), peripheral.getType("minecraft:chest_0")`,
        ),
      ).toEqual([2, "minecraft:chest", "inventory"]);
      expect(await lua("a", COUNTS)).toEqual([3, 2]);
      expect(
        await lua(
          "a",
          `return peripheral.wrap("minecraft:chest_1").pushItems("minecraft:chest_0", 1)`,
        ),
      ).toEqual([2]);
      expect(await lua("b", COUNTS)).toEqual([5, 0]);
      expect(await lua("a", COUNTS)).toEqual([5, 0]);
      // no 2.2.36 extras on a shared chest either
      expect(
        await lua(
          "b",
          `return peripheral.wrap("minecraft:chest_0").listDetailed`,
        ),
      ).toEqual([null]);
    } finally {
      await manager.destroyAll();
    }
  }, 120000);
});

describe.skipIf(!ready)("chests over a reboot", () => {
  it("keeps what is in a chest when the computer reboots, as the world does", async () => {
    const ws = mkdtempSync(join(tmpdir(), "vanilla-reboot-"));
    put(
      ws,
      "startup.lua",
      `local a, b = peripheral.wrap("chest_0"), peripheral.wrap("chest_1")
if not fs.exists("/booted") then
  fs.open("/booted", "w").close()
  a.pushItems("chest_1", 1, 3)
  os.reboot()
end
local n = 0
for _, item in pairs(b.list()) do n = n + item.count end
print("after reboot " .. n .. "/" .. a.getItemDetail(1).count)`,
    );
    const manager = new SessionManager({ ...config, workspaceDir: ws });
    try {
      const session = manager.create([], 1, {
        peripherals: [
          {
            name: "chest_0",
            type: "minecraft:chest",
            items: { "1": { name: "minecraft:diamond", count: 5 } },
          },
          { name: "chest_1", type: "minecraft:chest" },
        ],
      });
      await session.handle.session.waitForText("after reboot", 0, 30000);
      const text = (manager.screens(session.id)[0]?.lines ?? []).join("\n");
      expect(text).toContain("after reboot 3/2");
    } finally {
      await manager.destroyAll();
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60000);
});
