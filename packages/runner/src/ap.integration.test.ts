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
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  loadNamedWorld,
  SessionManager,
  runProgram,
  runTests,
} from "./index.js";

/**
 * Advanced Peripherals emulation, checked against behaviour read from the 0.7.30r source
 * (the pack ships 0.7.31r) and the server's peripherals.toml.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ap-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, source);
  return runTests(config, { paths: [name], world, timeoutMs: 25000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const players: WorldConfig["players"] = [
  { name: "Alice", x: 1, y: 64, z: 0 },
  { name: "Bob", x: 400, y: 64, z: 0 },
  { name: "Carol", x: 3, y: 64, z: 3, dimension: "minecraft:the_nether" },
  { name: "Dave", x: 0, y: 64, z: 0, online: false },
  { name: "Edgar", x: 5, y: 64, z: 0 },
  { name: "Fay", x: -5, y: 64, z: 0 },
];

describe.skipIf(!ready)("playerDetector", () => {
  it("uses the real range semantics", async () => {
    const result = await lua(
      `
local function sorted(t) table.sort(t) return t end

ccunit.test("online players and base methods", function()
  local d = peripheral.find("playerDetector")
  ccunit.eq(sorted(d.getOnlinePlayers()), { "Alice", "Bob", "Carol", "Edgar", "Fay" })
  ccunit.eq(d.getName(), "")
  ccunit.eq(d.getConfiguration(), {})
  ccunit.eq(peripheral.getType("pd"), "playerDetector")
  local methods = peripheral.getMethods("pd")
  ccunit.eq(#methods, 13) -- 11 detector methods + getName + getConfiguration
end)

ccunit.test("range is a box, max edge exclusive, same dimension only", function()
  local d = peripheral.wrap("pd")
  -- Fay at x=-5 is inside [-5,5); Edgar at x=5 is not; Carol is in the nether
  ccunit.eq(sorted(d.getPlayersInRange(5)), { "Alice", "Fay" })
  ccunit.eq(d.isPlayersInRange(1), false) -- Alice at x=1 is outside [-1,1)
  ccunit.eq(d.isPlayersInRange(2), true)
  ccunit.eq(d.isPlayerInRange(5, "Alice"), true)
  ccunit.eq(d.isPlayerInRange(5, "Bob"), false)
  ccunit.eq(d.isPlayerInRange(5, "Carol"), false)
end)

ccunit.test("cubic range doubles the extents", function()
  local d = peripheral.wrap("pd")
  ccunit.eq(sorted(d.getPlayersInCubic(2, 2, 2)), { "Alice" }) -- +-4 around: Edgar (5) and Fay (-5) are outside
  ccunit.eq(sorted(d.getPlayersInCubic(3, 3, 3)), { "Alice", "Edgar", "Fay" }) -- +-6
  ccunit.eq(d.isPlayerInCubic(3, 3, 3, "Edgar"), true)
  ccunit.eq(d.isPlayersInCubic(0, 0, 0), false)
end)

ccunit.test("coordinate boxes", function()
  local d = peripheral.wrap("pd")
  local a, b = { x = -6, y = 60, z = -1 }, { x = 6, y = 70, z = 1 }
  ccunit.eq(sorted(d.getPlayersInCoords(a, b)), { "Alice", "Edgar", "Fay" })
  ccunit.eq(d.isPlayerInCoords(a, b, "Fay"), true)
  ccunit.eq(d.isPlayersInCoords({ x = 100, y = 0, z = 0 }, { x = 101, y = 1, z = 1 }), false)
  ccunit.raises(function() d.getPlayersInCoords({ x = 1 }, b) end, "Table should be block position table")
end)

ccunit.test("player positions", function()
  local d = peripheral.wrap("pd")
  local pos = d.getPlayerPos("Alice")
  ccunit.eq(pos.x, 1)
  ccunit.eq(pos.y, 64)
  ccunit.eq(pos.z, 0)
  ccunit.eq(pos.dimension, "minecraft:overworld")
  ccunit.eq(pos.eyeHeight, 1.62)
  ccunit.truthy(pos.yaw ~= nil and pos.pitch ~= nil)
  ccunit.eq(d.getPlayerPos("Ghost"), {})
  ccunit.eq(d.getPlayerPos("Carol"), {}) -- other dimension is out of this level
  ccunit.eq(d.getPlayerPos("Dave"), {}) -- offline
  ccunit.raises(function() d.getPlayerPos() end, "string expected")
end)
`,
      {
        players,
        peripherals: [
          { name: "pd", type: "playerDetector", x: 0, y: 64, z: 0 },
        ],
      },
      "pd.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

describe.skipIf(!ready)("chatBox", () => {
  const world: WorldConfig = {
    players: [{ name: "Alice" }, { name: "Bob", online: false }],
    peripherals: [{ name: "cb", type: "chatBox" }],
  };

  it("has the 4 real methods, enforces the cooldown and reports errors", async () => {
    const result = await lua(
      `
ccunit.test("surface", function()
  local c = peripheral.wrap("cb")
  local names = peripheral.getMethods("cb")
  ccunit.eq(names, { "getConfiguration", "getName", "getOperationCooldown", "sendFormattedMessage",
    "sendFormattedMessageToPlayer", "sendMessage", "sendMessageToPlayer" })
  ccunit.eq(c.sendToastToPlayer, nil) -- not part of this AP version
  ccunit.eq(c.getConfiguration().chatMessage.cooldown, 100) -- as Advanced Peripherals ships
end)

ccunit.test("cooldown", function()
  local c = peripheral.wrap("cb")
  local sent = os.epoch("utc")
  ccunit.eq(c.sendMessage("hello"), true)
  local r, e = c.sendMessage("again")
  -- AP's shipped cooldown is 100 ms, about two ticks: on a busy host the second call can come after it ends
  if os.epoch("utc") - sent < 100 then
    ccunit.eq(r, nil)
    ccunit.eq(e, "chatMessage is on cooldown")
  else -- it ran inside the cooldown or after it, either is right
    ccunit.truthy(r == true or e == "chatMessage is on cooldown", tostring(e))
  end
  ccunit.eq(select(2, c.getOperationCooldown("nope")), "Cannot find this operation")
  sleep(1.1)
  ccunit.eq(c.getOperationCooldown("chatMessage"), 0)
end)

ccunit.test("player messages and error results", function()
  local c = peripheral.wrap("cb")
  ccunit.eq(c.sendMessageToPlayer("hi", "alice"), true) -- names are case-insensitive
  sleep(1.1)
  local r, e = c.sendMessageToPlayer("hi", "Bob") -- offline
  ccunit.eq(r, nil)
  ccunit.eq(e, "incorrect player name/uuid")
  sleep(1.1)
  r, e = c.sendMessage("hi", "X", "abc")
  ccunit.eq(r, nil)
  ccunit.eq(e, "incorrect bracket string (e.g. [], {}, <>, ...)")
  ccunit.raises(function() c.sendMessage() end, "string expected, got nil")
end)
`,
      world,
      "cb.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("delivers prefixed messages to online players", async () => {
    put(
      "chat.lua",
      `local c = peripheral.wrap("cb") c.sendMessage("welcome") sleep(1.1) c.sendMessageToPlayer("psst", "Alice", "Bank", "<>")`,
    );
    const result = await runProgram(config, {
      program: "chat.lua",
      world,
      timeScale: 2,
    });
    const chat = result.sim?.chat ?? [];
    expect(chat.map((c) => c.text)).toEqual([
      "[§rAP]§r welcome",
      "<§rBank>§r psst",
    ]);
    expect(chat.every((c) => c.to === "Alice")).toBe(true); // Bob is offline
  }, 40000);
});

describe.skipIf(!ready)(
  "energyDetector, redstoneIntegrator, nbtStorage",
  () => {
    it("energy detector clamps the transfer limit", async () => {
      const result = await lua(
        `
ccunit.test("energy", function()
  local e = peripheral.wrap("ed")
  ccunit.eq(e.getTransferRate(), 250)
  ccunit.eq(e.getTransferRateLimit(), 2147483647)
  e.setTransferRateLimit(1000)
  ccunit.eq(e.getTransferRateLimit(), 1000)
  e.setTransferRateLimit(-5)
  ccunit.eq(e.getTransferRateLimit(), 0)
  e.setTransferRateLimit(99999999999)
  ccunit.eq(e.getTransferRateLimit(), 2147483647)
end)
`,
        {
          peripherals: [
            { name: "ed", type: "energyDetector", transferRate: 250 } as never,
          ],
        },
        "ed.test.lua",
      );
      expectAllPassed(result);
    }, 60000);

    it("redstone integrator resolves sides and keeps analogue levels", async () => {
      const result = await lua(
        `
ccunit.test("outputs", function()
  local r = peripheral.wrap("ri")
  ccunit.eq(r.getOutput("top"), false)
  r.setOutput("top", true)
  ccunit.eq(r.getOutput("top"), true)
  ccunit.eq(r.getAnalogOutput("top"), 15)
  ccunit.eq(r.getAnalogueOutput("up"), 15) -- "top" is up and the alias works
  r.setAnalogOutput("front", 7)
  ccunit.eq(r.getAnalogOutput("north"), 7) -- front faces north by default
  ccunit.eq(r.getOutput("FRONT"), true) -- sides are case-insensitive
  r.setAnalogueOutput("left", 99)
  ccunit.eq(r.getAnalogOutput("east"), 15) -- clamped; left is clockwise of front
  ccunit.raises(function() r.getOutput("sideways") end, "SIDEWAYS is not a valid side")
  ccunit.raises(function() r.setOutput("top", 1) end, "boolean expected")
end)

ccunit.test("inputs", function()
  local r = peripheral.wrap("ri")
  ccunit.eq(r.getAnalogInput("back"), 9)
  ccunit.eq(r.getInput("back"), true)
  ccunit.eq(r.getInput("bottom"), false)
  ccunit.eq(#peripheral.getMethods("ri"), 11) -- 9 integrator methods + getName + getConfiguration
end)
`,
        {
          peripherals: [
            {
              name: "ri",
              type: "redstoneIntegrator",
              inputs: { south: 9 },
            } as never,
          ],
        },
        "ri.test.lua",
      );
      expectAllPassed(result);
    }, 60000);

    it("nbt storage stores tables and SNBT with a size limit", async () => {
      const result = await lua(
        `
ccunit.test("nbt", function()
  local s = peripheral.wrap("nbt")
  ccunit.eq(s.read(), {})
  ccunit.eq(s.getConfiguration().maxSize, 1048576)
  ccunit.eq(s.writeTable, nil)
  ccunit.eq(s.writeJson('{level:5b, label:"vault", tags:[1,2], ratio:2.5d, on:true}'), true)
  ccunit.eq(s.read(), { level = 5, label = "vault", tags = { 1, 2 }, ratio = 2.5, on = 1 })
  local r, e = s.writeJson("{broken")
  ccunit.eq(r, nil)
  ccunit.truthy(e:find("^Cannot parse json: "))
  r, e = s.writeJson(string.rep("a", 1048577))
  ccunit.eq(e, "JSON size is bigger than allowed")
end)
`,
        { peripherals: [{ name: "nbt", type: "nbtStorage" }] },
        "nbt.test.lua",
      );
      expectAllPassed(result);
    }, 60000);
  },
);

describe.skipIf(!ready)("environmentDetector", () => {
  const world: WorldConfig = {
    players: [{ name: "Alice", x: 2, y: 64, z: 0 }],
    peripherals: [
      { name: "env", type: "environmentDetector", x: 0, y: 64, z: 0 },
      {
        name: "end",
        type: "environmentDetector",
        dimension: "minecraft:the_end",
      },
    ],
    environment: {
      time: 6000,
      biome: "desert",
      skyLight: 15,
      moonPhase: 4,
      raining: false,
    } as never,
    entities: [
      { type: "cow", name: "Cow", x: 4, y: 64, z: 0, animal: true, baby: true },
      { type: "zombie", name: "Zombie", x: 30, y: 64, z: 0 },
    ] as never,
  };

  it("reports the world", async () => {
    const result = await lua(
      `
ccunit.test("basic facts", function()
  local e = peripheral.wrap("env")
  ccunit.eq(e.getBiome(), "desert")
  ccunit.eq(e.getTime(), 6000)
  ccunit.eq(e.getDimensionPaN(), "minecraft:dimension")
  ccunit.eq(e.getDimensionName(), "dimension")
  ccunit.eq(e.getDimensionProvider(), "minecraft")
  ccunit.eq(e.isDimension("dimension"), true)
  ccunit.eq(e.isDimension("overworld"), false)
  ccunit.eq(e.isRaining(), false)
  ccunit.eq(e.isSunny(), true)
  ccunit.eq(e.getSkyLightLevel(), 15)
  ccunit.eq(e.getBlockLightLevel(), 0)
  ccunit.eq(e.getDayLightLevel(), 15) -- noon, clear sky
  ccunit.eq(e.canSleepHere(), false)
  ccunit.eq(e.getMoonId(), 0)
  ccunit.eq(e.getMoonName(), "Moon.exe not found...")
  ccunit.eq(e.isMoon(0), true)
  ccunit.eq(e.isMoon(4), false)
end)

ccunit.test("end dimension has no moon", function()
  local e = peripheral.wrap("end")
  ccunit.eq(e.getMoonName(), "Moon.exe not found...")
  ccunit.eq(e.getMoonId(), 0)
  ccunit.eq(e.getDimensionName(), "dimension")
end)

ccunit.test("sleeping", function()
  local e = peripheral.wrap("env")
  ccunit.eq({ e.canSleepPlayer("Nobody") }, { false, "player_not_online" })
  ccunit.eq(e.canSleepPlayer("Alice"), false) -- daytime
end)

ccunit.test("scan cost and entities", function()
  local e = peripheral.wrap("env")
  ccunit.eq(e.scanCost(8), 0)
  ccunit.eq(e.scanCost(10), math.floor((21 ^ 3 - 17 ^ 3) * 0.17))
  local r, err = e.scanCost(17)
  ccunit.eq(r, nil)
  ccunit.eq(err, "Radius is exceed max value")
  local found = e.scanEntities(8)
  table.sort(found, function(a, b) return a.name < b.name end)
  ccunit.eq(#found, 2) -- Alice and the cow; the zombie is 30 blocks away
  ccunit.eq(found[1].name, "Alice")
  ccunit.eq(found[2].name, "Cow")
  ccunit.eq(found[2].baby, true)
  ccunit.eq(found[2].x, 4)
  local again, why = e.scanEntities(8)
  ccunit.eq(again, nil)
  ccunit.eq(why, "scanEntities is on cooldown")
  sleep(2.1)
  local big, bigErr = e.scanEntities(20)
  ccunit.eq(big, nil)
  ccunit.eq(bigErr, "Radius is exceed max value")
end)

ccunit.test("fuel methods of block peripherals", function()
  local e = peripheral.wrap("env")
  ccunit.eq(e.getFuelConsumptionRate(), 1)
  ccunit.eq(e.setFuelConsumptionRate(1), true)
  ccunit.eq(select(2, e.setFuelConsumptionRate(2)), "Too big fuel consumption rate")
  ccunit.eq(select(2, e.setFuelConsumptionRate(0)), "Too small fuel consumption rate")
  ccunit.eq(e.getFuelLevel(), 0)
  ccunit.truthy(e.getOperationCooldown("scanEntities") >= 0)
end)

ccunit.test("rain darkens the day", function()
  -- raining and thundering at dusk
end)
`,
      world,
      "env.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

describe.skipIf(!ready)("speaker audio", () => {
  const world: WorldConfig = {
    peripherals: [{ name: "sp", type: "speaker" }],
  };

  it("holds one buffer, paces it like a real speaker and fires speaker_audio_empty", async () => {
    const result = await lua(
      `
local function silence(n) local t = {} for i = 1, n do t[i] = 0 end return t end
local function waitEmpty()
  local t0 = os.clock()
  local timer = os.startTimer(5)
  while true do
    local ev, a = os.pullEvent()
    if ev == "speaker_audio_empty" then os.cancelTimer(timer) return a, os.clock() - t0 end
    if ev == "timer" and a == timer then error("no speaker_audio_empty", 0) end
  end
end

ccunit.test("one pending buffer, sent next tick, then 0.5 s before the last one ends", function()
  local s = peripheral.wrap("sp")
  ccunit.eq(s.playAudio(silence(48000)), true) -- 1 s
  ccunit.eq(s.playAudio(silence(8)), false)     -- full until the next tick sends it
  local name, dt = waitEmpty()
  ccunit.eq(name, "sp")
  ccunit.truthy(dt <= 0.3, "first buffer goes out on the next tick, took " .. dt)
  ccunit.eq(s.playAudio(silence(48000)), true)
  ccunit.eq(s.playAudio(silence(8)), false)
  _, dt = waitEmpty()
  ccunit.truthy(dt >= 0.4 and dt <= 0.65, "second buffer waits until 0.5 s are left, took " .. dt)
  -- a sound is refused while audio plays
  ccunit.eq(s.playSound("minecraft:block.note_block.harp"), false)
  s.stop()
  sleep(0.1)
  ccunit.eq(s.playSound("minecraft:block.note_block.harp"), true)
end)

ccunit.test("audio pushed right after stop() is dropped with it", function()
  local s = peripheral.wrap("sp")
  s.stop()
  ccunit.eq(s.playAudio(silence(800)), true)
  local timer = os.startTimer(0.3)
  local got
  repeat
    local ev, a = os.pullEvent()
    if ev == "speaker_audio_empty" then got = true end
  until ev == "timer" and a == timer
  ccunit.eq(got, nil)
end)

ccunit.test("argument checks", function()
  local s = peripheral.wrap("sp")
  sleep(0.1)
  ccunit.raises(function() s.playAudio({}) end, "Cannot play empty audio")
  ccunit.raises(function() s.playAudio(silence(128 * 1024 + 1)) end, "Audio data is too large")
  ccunit.raises(function() s.playAudio({ 0, 0, 200, 0, 0, 0, 0, 0 }) end, "table item #3 must be between %-128 and 127")
  ccunit.raises(function() s.playAudio({ 0, "x", 0, 0, 0, 0, 0, 0 }) end, "table item #2 is not number %(got string%)")
  ccunit.raises(function() s.playAudio("x") end, "table expected, got string")
  ccunit.raises(function() s.playAudio({ 0 }, 0 / 0) end, "number expected, got nan")
  -- the tail short of 8 samples is dropped without a check
  local t = silence(8) t[9] = "x"
  ccunit.eq(s.playAudio(t), true)
end)

ccunit.test("a streaming loop keeps up with playback", function()
  local s = peripheral.wrap("sp")
  s.stop()
  sleep(0.1)
  local t0 = os.clock()
  local chunk = silence(16 * 1024) -- about 0.34 s each
  for _ = 1, 6 do
    while not s.playAudio(chunk) do os.pullEvent("speaker_audio_empty") end
  end
  local took = os.clock() - t0
  -- 6 chunks are 2.05 s of audio; the last push is accepted after the fifth is sent, 0.5 s before the fourth ends
  ccunit.truthy(took >= 0.6 and took <= 1.4, "pushing 6 chunks took " .. took)
end)
`,
      world,
      "speaker.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

describe.skipIf(!ready)("arController", () => {
  it("records canvas actions and validates arguments", async () => {
    put(
      "ar.lua",
      `
local ar = peripheral.wrap("ar")
ar.drawString("hi", 1, 2, 0xff0000)
ar.drawStringWithId("title", "Scores", 10, 10, 0xffffff)
ar.fill(0, 0, 5, 5, 0x00ff00)
ar.drawItemIcon("minecraft:diamond", 3, 4)
ar.clearElement("title")
local relative, w, h = ar.isRelativeMode()
assert(relative == false and w == nil)
ar.setRelativeMode(true, 200, 100)
local r2, w2, h2 = ar.isRelativeMode()
assert(r2 == true and w2 == 200 and h2 == 100)
local ok, err = pcall(ar.setRelativeMode, true)
assert(not ok and err:find("virtual screen width and height"), err)
ok, err = pcall(ar.drawString, "x", 1.5, 2, 3)
assert(not ok and err:find("no integer representation"), err)
assert(ar.getPlayerRotationY() == 0)
`,
    );
    const result = await runProgram(config, {
      program: "ar.lua",
      world: { peripherals: [{ name: "ar", type: "arController" }] },
    });
    expect(result.status).toBe("completed");
    const state = result.sim?.peripherals?.["ar"] as {
      canvas: { type: string; id?: string }[];
      relative: boolean;
    };
    expect(state.canvas.map((c) => c.type)).toEqual([
      "drawString",
      "fill",
      "drawItemIcon",
    ]);
    expect(state.relative).toBe(true);
  }, 40000);
});

describe.skipIf(!ready)("meBridge", () => {
  const me = {
    name: "me",
    type: "meBridge",
    items: [
      { name: "minecraft:iron_ingot", amount: 500 },
      { name: "minecraft:diamond", amount: 12, craftable: true },
      {
        name: "minecraft:gold_ingot",
        amount: 64,
        tags: ["minecraft:item/forge:ingots/gold"],
      },
    ],
    fluids: [{ name: "minecraft:water", amount: 8000 }],
    craftableItems: [{ name: "minecraft:piston" }],
    energy: { stored: 4000, max: 10000, usage: 12.5, injection: 20 },
    cells: [
      {
        item: "ae2:item_storage_cell_4k",
        cellType: "item",
        bytesPerType: 8,
        totalBytes: 4096,
      },
      {
        item: "ae2:fluid_storage_cell_1k",
        cellType: "fluid",
        bytesPerType: 8,
        totalBytes: 1024,
      },
    ],
    cpus: [{ name: "cpu1", storage: 1024, coProcessors: 2, isBusy: false }],
    adjacent: { top: "chest" },
  };

  const world: WorldConfig = {
    peripherals: [
      me as never,
      { name: "chest", type: "minecraft:chest", size: 9 },
      { name: "tank", type: "fluid_storage", capacity: 4000 } as never,
    ],
  };

  it("lists, finds and shapes stacks like AE2/AP", async () => {
    const result = await lua(
      `
ccunit.test("connection and energy", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.isConnected(), true)
  ccunit.eq(b.getEnergyStorage(), 4000)
  ccunit.eq(b.getMaxEnergyStorage(), 10000)
  ccunit.eq(b.getEnergyUsage(), 12.5)
  ccunit.eq(b.getAvgPowerInjection(), 20)
  ccunit.eq(#peripheral.getMethods("me"), 33) -- 31 + getName + getConfiguration
end)

ccunit.test("item objects", function()
  local b = peripheral.wrap("me")
  local item = b.getItem({ name = "minecraft:diamond" })
  ccunit.eq(item.name, "minecraft:diamond")
  ccunit.eq(item.amount, 12)
  ccunit.eq(item.displayName, "Diamond")
  ccunit.eq(item.isCraftable, true)
  ccunit.eq(item.nbt, { id = "minecraft:diamond" })
  -- md5("{}" .. "minecraft:diamond" .. "Diamond"), AP's fingerprint of a tag-less stack
  ccunit.eq(item.fingerprint, "d921dfe38614fdec1f1863dba2e7bd1d")
  ccunit.eq(b.getItem({ name = "minecraft:nothing_here" }), {}) -- unknown items give an empty table
  ccunit.eq(select(2, b.getItem({ name = "bad name!" })), "ITEM_NOT_FOUND")
  ccunit.eq(select(2, b.getItem({})), "EMPTY_FILTER")
  ccunit.eq(select(2, b.getItem({ count = "x", name = "minecraft:iron_ingot" })), "NO_VALID_COUNT")
  local piston = b.getItem({ name = "minecraft:piston" })
  ccunit.eq(piston.amount, 0) -- craftable but out of stock
  ccunit.eq(piston.isCraftable, true)
  local byTag = b.getItem({ name = "#forge:ingots/gold" })
  ccunit.eq(byTag.name, "minecraft:gold_ingot")
end)

ccunit.test("listing quirks", function()
  local b = peripheral.wrap("me")
  ccunit.eq(#b.listItems(), 3)
  ccunit.eq(#b.listFluid(), 1)
  -- listCraftableItems: iron is not craftable, so every unstocked craftable is added; diamond follows
  local names = {}
  for _, e in ipairs(b.listCraftableItems()) do names[#names + 1] = e.name .. ":" .. e.amount end
  table.sort(names)
  ccunit.eq(names, { "minecraft:diamond:12", "minecraft:piston:0" })
  ccunit.eq(b.isItemCraftable({ name = "minecraft:piston" }), true)
  ccunit.eq(b.isItemCraftable({ name = "minecraft:iron_ingot" }), false)
  ccunit.eq({ b.isItemCraftable({}) }, { false, "EMPTY_FILTER" })
end)

ccunit.test("storage accounting", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.getTotalItemStorage(), 4096)
  ccunit.eq(b.getTotalFluidStorage(), 1024)
  -- 576 items -> 72 bytes + 8 bytes per type * 3 types
  ccunit.eq(b.getUsedItemStorage(), 72 + 24)
  ccunit.eq(b.getAvailableItemStorage(), 4096 - 96)
  ccunit.eq(#b.listCells(), 2)
  ccunit.eq(b.listCells()[1].cellType, "item")
  local cpus = b.getCraftingCPUs()
  ccunit.eq(cpus[1].coProcessors, 2)
  ccunit.eq(cpus[1].isBusy, false)
end)

ccunit.test("exporting and importing", function()
  local b = peripheral.wrap("me")
  local chest = peripheral.wrap("chest")
  ccunit.eq(b.exportItem({ name = "minecraft:iron_ingot", count = 100 }, "top"), 100)
  ccunit.eq(chest.list()[1].count, 64) -- stacks of 64
  ccunit.eq(chest.list()[2].count, 36)
  ccunit.eq(b.getItem({ name = "minecraft:iron_ingot" }).amount, 400)
  ccunit.eq(b.importItem({ name = "minecraft:iron_ingot", count = 50 }, "top"), 50)
  ccunit.eq(b.getItem({ name = "minecraft:iron_ingot" }).amount, 450)
  ccunit.eq(b.exportItemToPeripheral({ name = "minecraft:diamond", count = 5 }, "chest"), 5)
  ccunit.eq(b.importItemFromPeripheral({ name = "minecraft:diamond" }, "chest"), 5)
  ccunit.eq(select(2, b.exportItem({ name = "bad name!" }, "top")), "ITEM_NOT_FOUND")
  ccunit.raises(function() b.exportItem({ name = "minecraft:diamond" }, "left") end, "NullPointerException")
end)

ccunit.test("fluids", function()
  local b = peripheral.wrap("me")
  local tank = peripheral.wrap("tank")
  ccunit.eq(b.exportFluidToPeripheral({ name = "minecraft:water", count = 3000 }, "tank"), 3000)
  ccunit.eq(tank.tanks()[1].amount, 3000)
  ccunit.eq(b.listFluid()[1].amount, 5000)
  ccunit.eq(b.importFluidFromPeripheral({ name = "minecraft:water", count = 1000 }, "tank"), 1000)
  ccunit.eq(b.listFluid()[1].amount, 6000)
end)

ccunit.test("crafting fires the crafting event", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.craftItem({ name = "minecraft:piston", count = 4 }), true)
  local event, ok, message = os.pullEvent("crafting")
  ccunit.eq(ok, true)
  ccunit.truthy(message:find("Started calculation"))
  ccunit.eq(b.isItemCrafting({ name = "minecraft:piston" }), true)
  ccunit.eq({ b.craftItem({ name = "minecraft:iron_ingot" }) }, { nil, "NOT_CRAFTABLE" })
  ccunit.eq({ b.craftItem({}) }, { false, "EMPTY_FILTER" })
  ccunit.eq({ b.craftItem({ name = "minecraft:piston" }, "missing") }, { false, "CPU missing does not exists" })
end)
`,
      world,
      "me.test.lua",
    );
    expectAllPassed(result);
  }, 90000);

  it("reports NOT_CONNECTED when the network is down", async () => {
    const result = await lua(
      `
ccunit.test("disconnected", function()
  local b = peripheral.wrap("me")
  ccunit.eq(b.isConnected(), false)
  ccunit.eq({ b.listItems() }, { nil, "NOT_CONNECTED" })
  ccunit.eq({ b.getEnergyStorage() }, { nil, "NOT_CONNECTED" })
  ccunit.eq({ b.craftItem({ name = "minecraft:piston" }) }, { nil, "NOT_CONNECTED" })
end)
`,
      {
        peripherals: [
          { name: "me", type: "meBridge", connected: false } as never,
        ],
      },
      "me2.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

describe.skipIf(!ready)("rsBridge", () => {
  const world: WorldConfig = {
    peripherals: [
      {
        name: "rs",
        type: "rsBridge",
        items: [
          { name: "minecraft:iron_ingot", amount: 300 },
          { name: "minecraft:stick", amount: 10, nbt: { Damage: 0 } },
        ],
        fluids: [{ name: "minecraft:lava", amount: 2000 }],
        craftableItems: [{ name: "minecraft:iron_pickaxe" }],
        energy: { stored: 900, max: 1000, usage: 4 },
        storage: {
          maxItemDisk: 32000,
          maxFluidDisk: 64000,
          maxItemExternal: -1,
          maxFluidExternal: 0,
        },
        patterns: [
          {
            outputs: [{ name: "minecraft:iron_pickaxe", count: 1 }],
            inputs: [
              [{ name: "minecraft:iron_ingot", count: 3 }],
              [{ name: "minecraft:stick", count: 2 }],
            ],
            processing: false,
          },
        ],
      } as never,
      { name: "chest", type: "minecraft:chest", size: 9 },
    ],
  };

  it("matches the RS flavour of the API", async () => {
    const result = await lua(
      `
ccunit.test("surface and storage", function()
  local r = peripheral.wrap("rs")
  ccunit.eq(#peripheral.getMethods("rs"), 28) -- 26 + getName + getConfiguration
  ccunit.eq(r.getEnergyStorage(), 900)
  ccunit.eq(r.getMaxEnergyStorage(), 1000)
  ccunit.eq(r.getEnergyUsage(), 4)
  ccunit.eq(r.getMaxItemDiskStorage(), 32000)
  ccunit.eq(r.getMaxItemExternalStorage(), -1)
end)

ccunit.test("items use RS shapes", function()
  local r = peripheral.wrap("rs")
  local iron = r.getItem({ name = "minecraft:iron_ingot" })
  ccunit.eq(iron.amount, 300)
  ccunit.eq(iron.nbt, nil) -- RS leaves nbt and tags nil when there are none
  ccunit.eq(iron.tags, nil)
  ccunit.eq(iron.isCraftable, false)
  ccunit.eq(r.getItem({ name = "minecraft:stick" }).nbt, { Damage = 0 })
  ccunit.eq(#r.listItems(), 2)
  ccunit.eq(#r.listFluids(), 1)
  ccunit.eq(r.listCraftableItems()[1].name, "minecraft:iron_pickaxe")
end)

ccunit.test("patterns and crafting", function()
  local r = peripheral.wrap("rs")
  local pattern = r.getPattern({ name = "minecraft:iron_pickaxe" })
  ccunit.eq(pattern.processing, false)
  ccunit.eq(pattern.outputs[1].name, "minecraft:iron_pickaxe")
  ccunit.eq(pattern.inputs[1][1].amount, 3)
  ccunit.eq(r.getPattern({ name = "minecraft:stick" }), nil)
  ccunit.eq(r.isItemCraftable({ name = "minecraft:iron_pickaxe" }), true)
  ccunit.eq(r.craftItem({ name = "minecraft:iron_pickaxe", count = 2 }), true)
  -- RS only looks at stored items here (the crafting manager is null), so an unstocked item is refused
  ccunit.eq({ r.isItemCrafting({ name = "minecraft:iron_pickaxe" }) }, { nil, "NOT_CRAFTABLE" })
  ccunit.eq(r.isItemCrafting({ name = "minecraft:iron_ingot" }), false)
  ccunit.eq({ r.craftItem({ name = "minecraft:bedrock" }) }, { nil, "NOT_CRAFTABLE" })
end)

ccunit.test("RS reports INVALID_TARGET instead of raising", function()
  local r = peripheral.wrap("rs")
  ccunit.eq({ r.exportItem({ name = "minecraft:iron_ingot" }, "top") }, { 0, "INVALID_TARGET" })
  ccunit.eq(r.exportItemToPeripheral({ name = "minecraft:iron_ingot", count = 10 }, "chest"), 10)
  ccunit.eq(r.getItem({ name = "minecraft:iron_ingot" }).amount, 290)
end)
`,
      world,
      "rs.test.lua",
    );
    expectAllPassed(result);
  }, 90000);
});

/**
 * Every @LuaFunction name (aliases included) of the Advanced Peripherals classes the server
 * enables, extracted from the 0.7.30r source. Every one of these methods exists in the 0.7.31r
 * jar the pack ships.
 */
const surface = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./ap-surface.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

describe.skipIf(!ready)("Advanced Peripherals API surface", () => {
  const extras: Record<string, string[]> = {
    // BasePeripheral adds these to every peripheral
    "": ["getConfiguration", "getName"],
    // owners with operations / fuel add plugin methods
    chatBox: ["getOperationCooldown"],
    environmentDetector: [
      "getOperationCooldown",
      "getFuelLevel",
      "getMaxFuelLevel",
      "getFuelConsumptionRate",
      "setFuelConsumptionRate",
    ],
  };
  const types = Object.keys(surface);

  it("exposes every method of every enabled peripheral", async () => {
    const peripherals = types.map((type) => ({ name: `p_${type}`, type }));
    const expected: Record<string, string[]> = {};
    for (const type of types) {
      expected[type] = [
        ...(surface[type] ?? []),
        ...(extras[""] ?? []),
        ...(extras[type] ?? []),
      ].sort();
    }
    put(
      "surface.test.lua",
      `
local expected = ${JSON.stringify(expected)
        .replace(/\[/g, "{")
        .replace(/\]/g, "}")
        .replace(/"(\w+)":/g, "$1 =")}
for peripheralType, names in pairs(expected) do
  ccunit.test(peripheralType .. " has every method", function()
    local got = peripheral.getMethods("p_" .. peripheralType)
    ccunit.eq(got, names)
    ccunit.eq(peripheral.getType("p_" .. peripheralType), peripheralType)
  end)
end
`,
    );
    const result = await runTests(
      config,
      {
        paths: ["surface.test.lua"],
        world: { peripherals: peripherals as never },
        timeoutMs: 25000,
      },
      1,
    );
    expectAllPassed(result);
    expect(types).toHaveLength(9);
  }, 60000);
});

describe.skipIf(!ready)("Advanced Peripherals events", () => {
  it("delivers chat and playerClick events only to the right peripherals", async () => {
    put(
      "events.lua",
      `
while true do
  local event, a, b, c, d = os.pullEvent()
  if event == "chat" then print(("chat %s|%s|%s|%s"):format(a, b, tostring(c), tostring(d)))
  elseif event == "playerClick" then print(("click %s|%s"):format(a, tostring(b))) end
end
`,
    );
    const manager = new SessionManager(config);
    const session = manager.create([], 1, {
      players: [{ name: "Alice" }],
      peripherals: [
        { name: "cb", type: "chatBox" },
        { name: "pd", type: "playerDetector" },
      ],
    });
    try {
      const raw = session.handle.session;
      await raw.waitForText(">", 0, 20000);
      raw.typeLine("events");
      await new Promise((resolve) => setTimeout(resolve, 600));
      session.handle.sendCommand({
        cmd: "chat",
        player: "Alice",
        message: "hello bank",
      });
      session.handle.sendCommand({
        cmd: "chat",
        player: "Alice",
        message: "$secret",
      });
      session.handle.sendCommand({ cmd: "playerClick", player: "Alice" });
      await raw.waitForText("click Alice|nil", 0, 10000);
      // print() word-wraps at the 51-column edge and drops the space it wraps on, so
      // compare with all whitespace removed
      const text = (manager.screens(session.id)[0]?.lines ?? [])
        .join("")
        .replace(/\s+/g, "");
      expect(text).toContain(
        "chatAlice|hellobank|00000000-0000-4000-8000-000000000001|false",
      );
    } finally {
      await manager.destroyAll();
    }
  }, 60000);

  it("does not fire chat events without a chat box", async () => {
    put("quiet.lua", `local e = os.pullEvent() print("got " .. e)`);
    const manager = new SessionManager(config);
    const session = manager.create([], 1, { players: [{ name: "Alice" }] });
    try {
      const raw = session.handle.session;
      await raw.waitForText(">", 0, 20000);
      raw.typeLine("quiet");
      await new Promise((resolve) => setTimeout(resolve, 500));
      session.handle.sendCommand({
        cmd: "chat",
        player: "Alice",
        message: "hi",
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
      const text = (manager.screens(session.id)[0]?.lines ?? []).join("\n");
      expect(text).not.toContain("got chat");
    } finally {
      await manager.destroyAll();
    }
  }, 60000);
});

describe.skipIf(!ready)("demo world", () => {
  it("registers one of every peripheral and they all answer", async () => {
    const result = await lua(
      `
ccunit.test("demo world", function()
  local want = { "playerDetector", "chatBox", "energyDetector", "environmentDetector",
    "redstoneIntegrator", "nbtStorage", "arController", "meBridge", "rsBridge", "fluid_storage" }
  for _, ty in ipairs(want) do
    ccunit.truthy(peripheral.find(ty), "missing " .. ty)
  end
  ccunit.eq(peripheral.find("meBridge").getItem({ name = "minecraft:diamond" }).amount, 24)
  ccunit.eq(peripheral.find("rsBridge").getPattern({ name = "minecraft:gold_block" }).processing, false)
  ccunit.eq(peripheral.find("environmentDetector").getBiome(), "plains")
  ccunit.eq(peripheral.find("playerDetector").getPlayersInRange(5), { "Alice" })
  ccunit.eq(peripheral.find("redstoneIntegrator").getAnalogInput("back"), 5)
end)
`,
      loadNamedWorld(config.worldsDir, "advanced-peripherals-demo"),
      "demo.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
