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
 * Classic Peripherals 0.5.1 (Minecraft 1.20.1) and 0.6.6 (1.21.1), written from Ale32bit/ClassicPeripherals at those
 * tags (docs/classic-peripherals.md). The mod is not in the pack: nothing here was measured in game. The crypto and
 * zlib results are checked against classic-peripherals-vectors.json, made by calling the mod's own Crypto and
 * Compression classes from its jars on a JVM (JDK 17 for 0.5.1, JDK 21 for 0.6.6, Bouncy Castle 1.78.1 from the jar).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "cp-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => {
  if (!process.env["CP_KEEP"])
    rmSync(scratch, { recursive: true, force: true });
});

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
--- Run a sim command and wait for its reply, keeping every event that arrives meanwhile for the test.
local function sim(command)
  simCount = simCount + 1
  local token = ("sim:%d:%.0f"):format(simCount, os.epoch("utc"))
  os.queueEvent("ccsim_cmd", token, textutils.serializeJSON(command))
  local kept = {}
  while true do
    local ev = table.pack(os.pullEvent())
    if ev[1] == "ccsim_reply" and ev[2] == token then
      if not ev[3] then error("sim command failed: " .. tostring(ev[4]), 2) end
      break
    end
    kept[#kept + 1] = ev
  end
  for _, ev in ipairs(kept) do os.queueEvent(table.unpack(ev, 1, ev.n)) end
end
local function H(h) return (h:gsub("..", function(x) return string.char(tonumber(x, 16)) end)) end
local function X(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
  timeoutMs = 60000,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

type Dict = Record<string, unknown>;

// ───────────── the reference vectors ─────────────

interface Vector {
  cls: "C" | "Z" | "U";
  fn: string;
  args: (string | boolean | number | { recipe: [string, number, number][] })[];
  ok?: string;
  sha256?: string;
  error?: string;
  message?: string;
  text?: string;
}
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("./classic-peripherals-vectors.json", import.meta.url),
    ),
    "utf8",
  ),
) as Record<"0.5.1" | "0.6.6", Vector[]>;

const WORDS = [
  "the ",
  "quick ",
  "brown ",
  "fox ",
  "jumps ",
  "over ",
  "lazy ",
  "dog ",
  "radio ",
  "tower ",
  "\n",
];
/** A big input, rebuilt from its recipe the way the vector generator built it. */
function recipe(parts: [string, number, number][]): Buffer {
  return Buffer.concat(
    parts.map(([kind, n, seed]) => {
      let st = seed;
      const next = () => {
        st = (st * 1103515245 + 12345) % 2147483648;
        return Math.floor(st / 65536);
      };
      if (kind === "b")
        return Buffer.from(Array.from({ length: n }, () => next() % 256));
      let s = "";
      while (s.length < n) s += WORDS[next() % WORDS.length];
      return Buffer.from(s.slice(0, n), "latin1");
    }),
  );
}

const lit = (a: Vector["args"][number]): string => {
  if (typeof a === "boolean" || typeof a === "number") return String(a);
  const hex = typeof a === "string" ? a : recipe(a.recipe).toString("hex");
  return `H"${hex}"`;
};
const len = (a: Vector["args"][number]) =>
  typeof a === "string"
    ? a.length / 2
    : typeof a === "object"
      ? recipe(a.recipe).length
      : 0;

/** The peripheral call for a static Crypto/Compression call, and what the peripheral must answer. */
function toCall(
  version: "0.5.1" | "0.6.6",
  v: Vector,
): { call: string; expect: string } | undefined {
  const a = v.args.map(lit);
  const is066 = version === "0.6.6";
  const jet = (text: string) =>
    `{ err = ${JSON.stringify("Java Exception Thrown: " + text)} }`;
  let call: string;
  switch (v.fn) {
    case "md5Hmac":
    case "sha1Hmac":
    case "sha256Hmac":
    case "sha512Hmac":
      call = `c.hmac${v.fn[0]!.toUpperCase()}${v.fn.slice(1, -4)}(${a.join(", ")})`;
      break;
    case "blake3Hash":
      call = `c.blake3(${a[0]}, ${a[1]}, "hash", nil, ${a[2]})`;
      break;
    case "blake3Keyed":
      call = `c.blake3(${a[0]}, ${a[2]}, "keyed", ${a[1]}, ${a[3]})`;
      break;
    case "blake3Derive":
      call = `c.blake3(${a[0]}, ${a[2]}, "derive", ${a[1]}, ${a[3]})`;
      break;
    case "deriveECDHPublicKey":
      call = `c.deriveEcdhPublicKey(${a.join(", ")})`;
      break;
    case "normaliseLabel":
      return undefined; // checked through the NFC reader
    default:
      call = `c.${v.fn}(${a.join(", ")})`;
  }
  let expect: string | undefined;
  if (v.fn === "encryptAes" || v.fn === "decryptAes") {
    if (is066) {
      const k = len(v.args[1]!),
        iv = len(v.args[2]!);
      if (![16, 24, 32].includes(k))
        expect = `{ err = "bad argument length #2 (expected 16, 24, 32, got ${k})" }`;
      else if (iv !== 16)
        expect = `{ err = "bad argument length #3 (expected 16, got ${iv})" }`;
    }
    if (!expect && v.error) {
      const caught =
        v.error.startsWith("javax.crypto.") ||
        v.error.startsWith("java.security.");
      expect = caught ? `{ err = ${JSON.stringify(v.message)} }` : jet(v.text!);
    }
  } else if (v.error) {
    if (v.fn === "decodeBase64")
      expect = is066 ? "{ isNil = true }" : jet(v.text!);
    else if (v.fn === "inflate")
      expect = `{ err = "invalid compressed data format" }`;
    else if (v.fn === "verify" || v.fn === "computeSharedSecret")
      expect = jet(v.text!);
    else throw new Error(`no mapping for ${v.fn} ${v.text}`);
  } else if (v.fn === "verify") {
    expect = `{ bool = ${v.ok === "true"} }`;
  }
  expect ??= v.sha256 ? `{ sha = "${v.sha256}" }` : `{ ok = "${v.ok}" }`;
  return { call, expect };
}

function vectorTest(version: "0.5.1" | "0.6.6"): string {
  const rows = vectors[version]
    .map((v) => toCall(version, v))
    .filter((x) => x !== undefined)
    .map(
      (x, i) =>
        `cases[${i + 1}] = { function() return ${x.call} end, ${x.expect}, ${JSON.stringify(x.call.slice(0, 60))} }`,
    );
  return `
local c = peripheral.wrap("crypto")
local cases = {}
${rows.join("\n")}
ccunit.test("${version}: every vector", function()
  local failures = {}
  for i, case in ipairs(cases) do
    local ok, r = pcall(case[1])
    local want = case[2]
    local problem
    if want.err then
      local e = ok and "(no error)" or tostring(r):gsub("^[^:]*:%d+: ", "")
      if e ~= want.err then problem = "error " .. e .. " ~= " .. want.err end
    elseif not ok then
      problem = "raised " .. tostring(r)
    elseif want.isNil then
      if r ~= nil then problem = "expected nil" end
    elseif want.bool ~= nil then
      if r ~= want.bool then problem = "got " .. tostring(r) end
    elseif want.sha then
      if c.sha256(r) ~= want.sha then problem = "sha256 differs (" .. #r .. " bytes)" end
    elseif X(r) ~= want.ok then
      problem = "got " .. X(r):sub(1, 64)
    end
    if problem then failures[#failures + 1] = i .. " " .. case[3] .. ": " .. problem end
    if i % 8 == 0 then sleep(0) end
  end
  ccunit.eq(failures, {})
  ccunit.truthy(#cases > 300, #cases)
end)
`;
}

/** CC's HashMap order of the declared @LuaFunction methods (see init.lua's hashMapOrder). */
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

// declaration order in each peripheral class, from the source
const CRYPTO_051 = [
  "md5",
  "sha1",
  "sha256",
  "sha512",
  "hmacMd5",
  "hmacSha1",
  "hmacSha256",
  "hmacSha512",
  "random",
  "randomBytes",
  "encodeBase64",
  "decodeBase64",
  "encryptAes",
  "decryptAes",
  "generatePrivateKey",
  "derivePublicKey",
  "sign",
  "verify",
  "deriveEcdhPublicKey",
  "computeSharedSecret",
];
const CRYPTO_066 = [
  ...CRYPTO_051.slice(0, 4),
  "blake3",
  ...CRYPTO_051.slice(4),
  "deflate",
  "inflate",
];
const RADIO = [
  "isValid",
  "broadcast",
  "canBroadcast",
  "setFrequency",
  "getFrequency",
  "getHeight",
];
const NFC = ["write", "cancelWrite", "sign", "cancelSign"];
const SCANNER = ["hasPages", "getLabel", "getPageCount", "eject", "scan"];

const luaList = (xs: string[]) =>
  `{ ${xs.map((x) => JSON.stringify(x)).join(", ")} }`;

function world(version: string, extra: Dict = {}): WorldConfig {
  return {
    version,
    simProgram: true,
    addons: ["classic-peripherals"],
    classicPeripherals: {
      seed: 99,
      pocket: true,
      cards: {
        blank: {},
        alice: { data: "alice-badge" },
        locked: { data: "sealed", readOnly: true },
      },
      entities: [],
    },
    peripherals: [
      { name: "crypto", type: "cryptographic_accelerator" },
      { name: "tower", type: "radio_tower", height: 4, x: 0, y: 100, z: 0 },
      { name: "tower2", type: "radio_tower", height: 2, x: 300, y: 64, z: 0 },
      { name: "ant", type: "radio_tower", kind: "antenna", x: 50, y: 70, z: 0 },
      { name: "broken", type: "radio_tower", height: 1, x: 0, y: 64, z: 0 },
      { name: "nfc", type: "nfc_reader" },
      {
        name: "rfid",
        type: "rfid_scanner",
        x: 0,
        y: 64,
        z: 0,
        facing: "north",
      },
      {
        name: "scan",
        type: "classicperipherals:scanner",
        printout: {
          title: "Report",
          pages: 2,
          lines: ["Line one", { text: "Red", color: "eee" }],
        },
      },
    ],
    ...extra,
  } as WorldConfig;
}

describe("Classic Peripherals registry (no engine)", () => {
  it("only 1.20.1 and 1.21.1 have it, and an off addon refuses its blocks", () => {
    expect(() =>
      worldJson({
        version: "1.18.2",
        addons: ["classic-peripherals"],
        peripherals: [{ name: "c", type: "cryptographic_accelerator" }],
      } as WorldConfig),
    ).toThrow(
      /Classic Peripherals \(addon "classic-peripherals"\) has no release for Minecraft 1.18.2/,
    );
    expect(() =>
      worldJson({
        version: "1.20.1",
        addons: "none",
        peripherals: [{ name: "s", type: "classicperipherals:scanner" }],
      } as WorldConfig),
    ).toThrow(
      /peripheral "s" is a classicperipherals:scanner from Classic Peripherals/,
    );
    expect(() =>
      worldJson({
        version: "1.21.1",
        addons: ["create"],
        classicPeripherals: {},
      } as WorldConfig),
    ).toThrow(/world.classicPeripherals configures Classic Peripherals/);
    expect(() =>
      worldJson({
        version: "1.21.1",
        addons: ["classic-peripherals"],
        peripherals: [{ name: "r", type: "radio_tower" }],
      } as WorldConfig),
    ).not.toThrow();
  });

  it("the vectors cover every crypto method and both releases", () => {
    const fns051 = new Set(vectors["0.5.1"].map((v) => v.fn));
    const fns066 = new Set(vectors["0.6.6"].map((v) => v.fn));
    for (const fn of [
      "md5",
      "sha512",
      "sha256Hmac",
      "encryptAes",
      "decryptAes",
      "decodeBase64",
      "sign",
      "verify",
      "computeSharedSecret",
    ])
      expect(fns051.has(fn) && fns066.has(fn)).toBe(true);
    for (const fn of [
      "blake3Hash",
      "blake3Keyed",
      "blake3Derive",
      "deflate",
      "inflate",
    ])
      expect(fns066.has(fn)).toBe(true);
  });
});

describe.skipIf(!ready)(
  "Classic Peripherals crypto against the mod's own classes",
  () => {
    it("0.5.1 on 1.20.1", async () => {
      expectAllPassed(
        await lua(
          vectorTest("0.5.1"),
          world("1.20.1"),
          "vectors051.test.lua",
          240000,
        ),
      );
    }, 300000);
    it("0.6.6 on 1.21.1", async () => {
      expectAllPassed(
        await lua(
          vectorTest("0.6.6"),
          world("1.21.1"),
          "vectors066.test.lua",
          240000,
        ),
      );
    }, 300000);
  },
);

const SURFACE = (crypto: string[]) => `
ccunit.test("types and getMethods order", function()
  ccunit.eq({ peripheral.getType("crypto") }, { "cryptographic_accelerator" })
  ccunit.eq({ peripheral.getType("tower") }, { "radio_tower" })
  ccunit.eq({ peripheral.getType("nfc") }, { "nfc_reader" })
  ccunit.eq({ peripheral.getType("rfid") }, { "rfid_scanner" })
  ccunit.eq({ peripheral.getType("scan") }, { "scanner" })
  ccunit.eq(peripheral.getMethods("crypto"), ${luaList(javaHashMapOrder(crypto))})
  ccunit.eq(peripheral.getMethods("tower"), ${luaList(javaHashMapOrder(RADIO))})
  ccunit.eq(peripheral.getMethods("nfc"), ${luaList(javaHashMapOrder(NFC))})
  ccunit.eq(peripheral.getMethods("rfid"), { "scan" })
  ccunit.eq(peripheral.getMethods("scan"), ${luaList(javaHashMapOrder(SCANNER))})
end)
`;

describe.skipIf(!ready)("Classic Peripherals 0.6.6 (1.21.1)", () => {
  it("every method, its values and its errors", async () => {
    const result = await lua(
      SURFACE(CRYPTO_066) +
        `
local c = peripheral.wrap("crypto")
ccunit.test("accelerator arguments and errors", function()
  ccunit.eq(err(c.md5), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(c.md5, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(c.md5, "a", 1), "bad argument #2 (boolean expected, got number)")
  ccunit.eq(c.md5("a", false), H"0cc175b9c0f1b6a831c399e269772661")
  ccunit.eq(err(c.hmacSha256, "k"), "bad argument #2 (string expected, got nil)")
  ccunit.eq(select("#", c.md5("")), 1)
  for _ = 1, 20 do
    local r = c.random()
    ccunit.truthy(r >= 0 and r < 1, r)
    r = c.random(10)
    ccunit.truthy(r >= 0 and r < 10 and r ~= math.floor(r), r)
    r = c.random(-3, 2.5)
    ccunit.truthy(r >= -3 and r < 2.5, r)
  end
  ccunit.truthy(math.abs(c.random(0)) <= 2 ^ 63)
  ccunit.eq(err(c.random, -1), "bad argument #1 (interval is empty)")
  ccunit.eq(err(c.random, 5, 5), "bad argument #1 (interval is empty)")
  ccunit.eq(err(c.random, 1 / 0), "bad argument #1 (number expected, got inf)")
  ccunit.eq(err(c.random, 0 / 0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(c.random, nil), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(c.random, -1e308, 1e308), "Java Exception Thrown: java.lang.IllegalArgumentException: bound must be greater than origin")
  ccunit.eq(#c.randomBytes(65536), 65536)
  ccunit.eq(c.randomBytes(0), "")
  ccunit.eq(err(c.randomBytes, 65537), "buffer size limit exceeded")
  ccunit.eq(err(c.randomBytes, -2), "Java Exception Thrown: java.lang.NegativeArraySizeException: -2")
  ccunit.eq(err(c.randomBytes, "x"), "bad argument #1 (number expected, got string)")
  ccunit.eq(c.decodeBase64("!!!!"), nil)
  ccunit.eq(select("#", c.decodeBase64("!!!!")), 1)
  local key = c.generatePrivateKey()
  ccunit.eq(#key, 32)
  ccunit.truthy(key ~= c.generatePrivateKey())
  local pub = c.derivePublicKey(key)
  ccunit.eq(c.verify("m", c.sign("m", key), pub), true)
  ccunit.eq(err(c.derivePublicKey, "short"), "Invalid key length, expected 32 bytes.")
  ccunit.eq(err(c.sign, "m", "short"), "Invalid key length, expected 32 bytes.")
  ccunit.eq(err(c.verify, "m", "short", "short"), "Invalid key length, expected 32 bytes.")
  ccunit.eq(err(c.verify, "m", "short", pub), "Invalid signature length, expected 64 bytes.")
  ccunit.eq(err(c.deriveEcdhPublicKey, ""), "Invalid key length, expected 32 bytes.")
  ccunit.eq(err(c.computeSharedSecret, key, "x"), "Invalid key length, expected 32 bytes.")
  local other = c.generatePrivateKey()
  ccunit.eq(c.computeSharedSecret(key, c.deriveEcdhPublicKey(other)), c.computeSharedSecret(other, c.deriveEcdhPublicKey(key)))
  ccunit.eq(err(c.encryptAes, "d", "k", ("i"):rep(16)), "bad argument length #2 (expected 16, 24, 32, got 1)")
  ccunit.eq(err(c.encryptAes, "d", ("k"):rep(16), "iv"), "bad argument length #3 (expected 16, got 2)")
  ccunit.eq(c.decryptAes(c.encryptAes("secret", ("k"):rep(24), ("i"):rep(16)), ("k"):rep(24), ("i"):rep(16)), "secret")
  ccunit.eq(err(c.blake3), "bad argument #1 (string expected, got nil)")
  ccunit.eq(#c.blake3("x"), 64)
  ccunit.eq(c.blake3("x", true, "HASH"), c.blake3("x"))
  ccunit.eq(err(c.blake3, "x", true, "nope"), "bad argument #3 (unknown option nope)")
  ccunit.eq(err(c.blake3, "x", true, 5), "bad argument #3 (string expected, got number)")
  ccunit.eq(err(c.blake3, "x", true, "hash", nil, 0), "output size must be greater than 0")
  ccunit.eq(err(c.blake3, "x", true, "hash", nil, 4097), "output size must be less than or equal to 4096")
  ccunit.eq(err(c.blake3, "x", true, "keyed", nil, 0), "output size must be greater than 0")
  ccunit.eq(err(c.blake3, "x", true, "keyed"), "bad argument #4 (string expected, got nil)")
  ccunit.eq(err(c.blake3, "x", true, "keyed", "short"), "Invalid key length, expected 32 bytes.")
  ccunit.eq(#c.blake3("x", false, "derive", "ctx", 7), 7)
  ccunit.eq(c.inflate(c.deflate("round trip")), "round trip")
  ccunit.eq(err(c.inflate, "junk"), "invalid compressed data format")
  ccunit.eq(err(c.deflate), "bad argument #1 (string expected, got nil)")
end)

local tower, tower2, ant, broken = peripheral.wrap("tower"), peripheral.wrap("tower2"), peripheral.wrap("ant"), peripheral.wrap("broken")
ccunit.test("radio towers", function()
  ccunit.eq(tower.isValid(), true)
  ccunit.eq(tower.getHeight(), 4)
  ccunit.eq(tower.getFrequency(), 0)
  ccunit.eq(tower.canBroadcast(), true)
  ccunit.eq(ant.getHeight(), 1)
  ccunit.eq(broken.isValid(), false)
  ccunit.eq(broken.canBroadcast(), false)
  ccunit.eq(err(broken.getFrequency), "The radio tower is not built correctly.")
  ccunit.eq(err(broken.getHeight), "The radio tower is not built correctly.")
  ccunit.eq(err(broken.broadcast, "x"), "The radio tower is not built correctly.")
  ccunit.eq(err(broken.setFrequency, 5), "The radio tower is not built correctly.")
  ccunit.eq(err(broken.setFrequency, 70000), "Frequency out of range. Must be between 0 and 65535.")
  ccunit.eq(err(tower.setFrequency, -1), "Frequency out of range. Must be between 0 and 65535.")
  ccunit.eq(err(tower.setFrequency, "5"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(tower.broadcast), "bad argument #1 (string expected, got nil)")
  tower.setFrequency(7.9)
  ccunit.eq(tower.getFrequency(), 7)
  ant.setFrequency(7)
  tower2.setFrequency(7)
  tower.broadcast("hello")
  -- the antenna 50 blocks off (across the ground) and the second tower 300 off both hear it, clean
  local got = {}
  for _ = 1, 2 do
    local _, side, data, distance = os.pullEvent("radio_message")
    got[side] = { data, distance }
  end
  ccunit.eq(got.ant, { "hello", 50 })
  ccunit.eq(got.tower2, { "hello", 300 })
  -- the antenna's range is 0: it reaches the tall tower (512) but not the low one (83 at y 65.5)
  ant.broadcast("from ant")
  local _, side, data, distance = os.pullEvent("radio_message")
  ccunit.eq({ side, data, distance }, { "tower", "from ant", 50 })
  sim({ cmd = "cpRadioReceive", frequency = 7, data = "near", x = 100, y = 0, z = 0 })
  _, side, data, distance = os.pullEvent("radio_message")
  ccunit.eq({ side, data, distance }, { "tower", "near", 100 })
  -- past 85% of the range the message is corrupted, bits flipped at random
  ant.setFrequency(8)
  tower2.setFrequency(8)
  local long = ("A"):rep(64)
  sim({ cmd = "cpRadioReceive", frequency = 7, data = long, x = 500, y = 0, z = 0 })
  _, side, data, distance = os.pullEvent("radio_message")
  ccunit.eq({ side, #data, distance }, { "tower", 64, 500 })
  ccunit.truthy(data ~= long, "corrupted")
  sim({ cmd = "cpRadioReceive", frequency = 7, data = "too far", x = 600, y = 0, z = 0 })
  sim({ cmd = "cpSetRadio", peripheral = "broken", height = 3 })
  ccunit.eq(broken.isValid(), true)
  ccunit.eq(broken.getHeight(), 3)
  local timer = os.startTimer(0.5)
  local ev = { os.pullEvent() }
  ccunit.eq(ev[1], "timer", "nothing heard from 600 blocks")
end)

local nfc = peripheral.wrap("nfc")
--- The next event called name, or { "timed out", name } after 5 seconds
local function nextEvent(name)
  local timer = os.startTimer(5)
  while true do
    local ev = { os.pullEvent() }
    if ev[1] == name then
      os.cancelTimer(timer)
      return ev
    end
    if ev[1] == "timer" and ev[2] == timer then return { "timed out", name } end
  end
end
ccunit.test("NFC reader: write, read, sign", function()
  ccunit.eq(nfc.cancelWrite(), false)
  ccunit.eq(nfc.cancelSign(), false)
  ccunit.eq(err(nfc.write), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(nfc.write, "a", 5), "bad argument #2 (string expected, got number)")
  ccunit.eq(err(nfc.write, "a", nil, "x"), "bad argument #3 (boolean expected, got string)")
  ccunit.eq(err(nfc.write, "a", nil, nil, "short"), "Invalid key length, expected 32 bytes.")
  nfc.write("hello " .. ("x"):rep(200), "My\\tCard", false)
  ccunit.eq(nfc.cancelWrite(), true)
  nfc.write("hello", "My Card")
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "blank" })
  ccunit.eq(nextEvent("nfc_write"), { "nfc_write", "nfc", true, "success" })
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "blank" })
  local ev = nextEvent("nfc_data")
  ccunit.eq({ ev[1], ev[2], ev[3], #ev[4] }, { "nfc_data", "nfc", "hello", 32 })
  local blankKey = ev[4]
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "blank" })
  ccunit.eq(nextEvent("nfc_data")[4], blankKey, "the card keeps the key it was given")
  nfc.write("again")
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "locked" })
  ccunit.eq(nextEvent("nfc_write"), { "nfc_write", "nfc", false, "read_only" })
  -- signing with the card's own key; the signature checks out against the key the card reads with
  -- cancelWrite sets the reader idle whatever it was doing: a pending signature is dropped too
  nfc.sign("dropped")
  ccunit.eq(nfc.cancelWrite(), false)
  ccunit.eq(nfc.cancelSign(), false)
  nfc.sign("pay 5")
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "alice" })
  ev = nextEvent("nfc_sign")
  ccunit.eq({ ev[1], ev[2], #ev[3], #ev[4] }, { "nfc_sign", "nfc", 64, 32 })
  ccunit.eq(c.verify("pay 5", ev[3], ev[4]), true)
  local alicePub = ev[4]
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "alice" })
  ccunit.eq(nextEvent("nfc_data"), { "nfc_data", "nfc", "alice-badge", alicePub })
  -- a new write cancels a pending signature; a key written to the card is the one it reads with
  nfc.sign("x")
  local key = c.generatePrivateKey()
  nfc.write("keyed", nil, true, key)
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "blank" })
  ccunit.eq(nextEvent("nfc_write"), { "nfc_write", "nfc", true, "success" })
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "blank" })
  ccunit.eq(nextEvent("nfc_data"), { "nfc_data", "nfc", "keyed", c.derivePublicKey(key) })
  nfc.write("no more")
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = "blank" })
  ccunit.eq(nextEvent("nfc_write"), { "nfc_write", "nfc", false, "read_only" })
  -- a blank card read: nothing
  sim({ cmd = "cpNfcTap", peripheral = "nfc", card = { data = "" } })
  local timer = os.startTimer(0.3)
  ccunit.eq({ os.pullEvent() }, { "timer", timer })
end)

ccunit.test("os.nfc and os.ban", function()
  local pocket = require("os.nfc")
  ccunit.eq(pocket.pop(), nil)
  pocket.write(("p"):rep(200))
  ccunit.eq(#pocket.pop(), 128)
  ccunit.eq(pocket.pop(), nil)
  ccunit.eq(err(pocket.setPrivateKey, "short"), "Invalid key length, expected 32 bytes.")
  ccunit.eq(err(pocket.write, 5), "bad argument #1 (string expected, got number)")
  local key = c.generatePrivateKey()
  pocket.setPrivateKey(key)
  pocket.write("from pocket")
  sim({ cmd = "cpNfcTapPocket", peripheral = "nfc", self = true })
  -- PocketNfcAccess hands out the public key as the key: the reader derives once more
  ccunit.eq(nextEvent("nfc_data"), { "nfc_data", "nfc", "from pocket", c.derivePublicKey(c.derivePublicKey(key)) })
  ccunit.eq(pocket.pop(), nil)
  nfc.write("to pocket", "Lbl", true)
  sim({ cmd = "cpNfcTapPocket", peripheral = "nfc", self = true })
  ccunit.eq(nextEvent("nfc_data"), { "nfc_data", "internal", "to pocket", "Lbl", true })
  ccunit.eq(nfc.cancelWrite(), false)
  -- the label goes through CC's StringUtil.normaliseLabel (vectors from CC 1.121.0's own)
  local labels = { ${vectors["0.6.6"]
    .filter((v) => v.fn === "normaliseLabel")
    .map((v) => `{ H"${v.args[0] as string}", H"${v.ok}" }`)
    .join(", ")} }
  for _, pair in ipairs(labels) do
    nfc.write("l", pair[1])
    sim({ cmd = "cpNfcTapPocket", peripheral = "nfc", self = true })
    ccunit.eq(nextEvent("nfc_data")[4], pair[2])
  end
  nfc.sign("deal")
  sim({ cmd = "cpNfcTapPocket", peripheral = "nfc", self = true })
  local ev = nextEvent("nfc_sign")
  ccunit.eq(ev[4], c.derivePublicKey(c.derivePublicKey(key)))
  ccunit.eq(c.verify("deal", ev[3], ev[4]), true)
  sim({ cmd = "cpNfcCardToPocket", card = "alice" })
  ccunit.eq(nextEvent("nfc_data"), { "nfc_data", "internal", "alice-badge" })
  local ban = require("os.ban")
  ccunit.eq(ban.isWireless(), true)
  ban.open(5)
  ccunit.eq(ban.isOpen(5), true)
  ban.transmit(5, 5, "into the void")
  ban.closeAll()
  ccunit.eq(ban.isOpen(5), false)
  ccunit.eq(err(ban.open, 70000), "Expected number in range 0-65535")
end)

local rfid = peripheral.wrap("rfid")
ccunit.test("RFID scanner", function()
  ccunit.eq(rfid.scan(), {})
  -- the scanner at 0,64,0 faces north: it reads around 0,64,-1
  sim({ cmd = "cpSetEntities", entities = {
    { kind = "player", x = 3, y = 64, z = -1, inventory = { "badge-a", "" }, equipped = "trinket" },
    { kind = "player", x = 20, y = 64, z = 0, inventory = { "far" } },
    { kind = "mob", x = 1, y = 64, z = -1, injected = "chip", hands = { "held" } },
    { kind = "mob", x = 5, y = 64, z = -1, injected = "outside the box" },
    { kind = "item", x = 0, y = 64, z = 1, data = "dropped" },
    { kind = "player", x = 0, y = 64, z = 0, dimension = "minecraft:the_nether", inventory = { "nether" } },
  } })
  ccunit.eq(rfid.scan(), {
    { data = "badge-a", distance = 3 }, { data = "trinket", distance = 3 },
    { data = "chip", distance = 1 }, { data = "held", distance = 1 }, { data = "dropped", distance = 2 },
  })
end)

local scan = peripheral.wrap("scan")
ccunit.test("scanner", function()
  ccunit.eq(scan.hasPages(), true)
  ccunit.eq(scan.getLabel(), "Report")
  ccunit.eq(scan.getPageCount(), 2)
  local pages = scan.scan()
  ccunit.eq(#pages, 2)
  ccunit.eq(pages[1][1][1], "Line one                 ")
  ccunit.eq(pages[1][2][2], "eeeffffffffffffffffffffff")
  ccunit.eq(pages[1][1][22], nil)
  -- page 2's lines keep their index in the whole printout
  ccunit.eq(pages[2][1][1], nil)
  ccunit.eq(pages[2][1][22], (" "):rep(25))
  scan.eject()
  ccunit.eq(scan.hasPages(), true, "ejected on the next tick")
  ccunit.eq(nextEvent("scanner_eject"), { "scanner_eject", "scan" })
  ccunit.eq(scan.hasPages(), false)
  ccunit.eq(scan.getLabel(), nil)
  ccunit.eq(select("#", scan.getLabel()), 1)
  ccunit.eq(scan.getPageCount(), 0)
  ccunit.eq(scan.scan(), nil)
  ccunit.eq(select("#", scan.eject()), 0)
  sim({ cmd = "cpSetPrintout", peripheral = "scan", printout = { title = "", lines = { "hi" } } })
  ccunit.eq(nextEvent("scanner"), { "scanner", "scan" })
  ccunit.eq(scan.getLabel(), nil)
  sim({ cmd = "cpSetPrintout", peripheral = "scan", printout = { item = "minecraft:dirt" } })
  ccunit.eq(nextEvent("scanner_eject"), { "scanner_eject", "scan" })
  ccunit.eq(nextEvent("scanner"), { "scanner", "scan" })
  ccunit.eq(scan.hasPages(), false)
end)
`,
      world("1.21.1"),
      "cp066.test.lua",
      120000,
    );
    expectAllPassed(result);
  }, 180000);
});

describe.skipIf(!ready)("Classic Peripherals 0.5.1 (1.20.1)", () => {
  it("what differs from 0.6.6", async () => {
    const result = await lua(
      SURFACE(CRYPTO_051) +
        `
local c = peripheral.wrap("crypto")
ccunit.test("0.5.1 accelerator", function()
  ccunit.eq(c.blake3, nil)
  ccunit.eq(c.deflate, nil)
  for _ = 1, 20 do
    local r = c.random(10)
    ccunit.truthy(r >= 0 and r < 10 and r == math.floor(r), r)
    -- the mod's own two-argument formula: floor(value * max) + min
    r = c.random(2, 5)
    ccunit.truthy(r >= 2 and r <= 6 and r == math.floor(r), r)
  end
  ccunit.eq(c.random(1.9), 0)
  ccunit.eq(err(c.random, 1 / 0), "bad argument #1 (number expected, got inf)")
  ccunit.eq(#c.randomBytes(70000), 70000)
  ccunit.eq(err(c.randomBytes, -1), "Java Exception Thrown: java.lang.NegativeArraySizeException: -1")
  ccunit.eq(err(c.decodeBase64, "!!"), "Java Exception Thrown: java.lang.IllegalArgumentException: Illegal base64 character 21")
  ccunit.eq(err(c.encryptAes, "d", "", "iv"), "Java Exception Thrown: java.lang.IllegalArgumentException: Empty key")
  ccunit.eq(err(c.encryptAes, "d", "k", "iv"), "Wrong IV length: must be 16 bytes long")
  ccunit.eq(err(c.encryptAes, "d", "k", ("i"):rep(16)), "Invalid AES key length: 1 bytes")
  ccunit.eq(c.decryptAes("", ("k"):rep(16), ("i"):rep(16)), "")
end)

ccunit.test("0.5.1 radio measures in three dimensions", function()
  local tower, ant = peripheral.wrap("tower"), peripheral.wrap("ant")
  tower.broadcast("3d")
  local _, side, data, distance = os.pullEvent("radio_message")
  while side ~= "ant" do _, side, data, distance = os.pullEvent("radio_message") end
  ccunit.eq({ side, data }, { "ant", "3d" })
  -- the tower's head is at y 103, the antenna at 70
  ccunit.eq(distance, math.sqrt(50 * 50 + 33 * 33))
end)
`,
      world("1.20.1", { classicPeripherals: { seed: 5 } }),
      "cp051.test.lua",
      120000,
    );
    expectAllPassed(result);
  }, 180000);
});

describe.skipIf(!ready)("Classic Peripherals state and labels", () => {
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
  const addon = (st: SimState) =>
    (st as { addons?: Record<string, Dict> }).addons!["classic-peripherals"]!;

  it("cards, radios and the scanner in sim state", async () => {
    await withSession(world("1.21.1"), async (step) => {
      let st = await step({ cmd: "cpSetRadio", peripheral: "tower2", y: 200 });
      const peripherals = st.peripherals as Record<string, Dict>;
      expect(peripherals["tower"]).toMatchObject({
        kind: "tower",
        frequency: 0,
        valid: true,
        height: 4,
        range: 512,
        x: 0,
        y: 103,
      });
      expect(peripherals["broken"]).toMatchObject({ valid: false, range: 0 });
      expect(peripherals["scan"]).toMatchObject({
        printout: { title: "Report", pages: 2 },
      });
      st = await step({
        cmd: "cpRadioReceive",
        frequency: 0,
        data: "ping",
        x: 10,
      });
      expect(addon(st)).toMatchObject({
        version: "0.6.6",
        cards: { alice: { data: "alice-badge", readOnly: false } },
      });
      expect(
        await step({
          cmd: "cpSetPrintout",
          peripheral: "scan",
          printout: null,
        }),
      ).toBeDefined();
      st = await step({ cmd: "cpNfcTap", peripheral: "nfc", card: "alice" });
      expect(addon(st)).toMatchObject({ cards: { alice: { hasKey: true } } });
      expect(
        (st.peripherals as Record<string, Dict>)["scan"]!["printout"],
      ).toBeUndefined();
    });
  }, 60000);
});

describe.skipIf(!ready)("workspace/examples/classic-peripherals", () => {
  it("badge_door.test.lua", async () => {
    const examples = fileURLToPath(
      new URL(
        "../../../workspace/examples/classic-peripherals/",
        import.meta.url,
      ),
    );
    for (const f of ["badge_door.lua", "badge_door.test.lua"])
      put(
        `examples/classic-peripherals/${f}`,
        readFileSync(join(examples, f), "utf8"),
      );
    const w = JSON.parse(
      readFileSync(join(examples, "badge_door.world.json"), "utf8"),
    ) as WorldConfig;
    const result = await runTests(
      config,
      {
        paths: ["examples/classic-peripherals/badge_door.test.lua"],
        world: w,
        timeScale: 5,
        timeoutMs: 90000,
      },
      1,
    );
    expectAllPassed(result);
  }, 120000);
});
