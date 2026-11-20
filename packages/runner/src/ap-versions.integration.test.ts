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
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  checkWorld,
  loadConfig,
  runProgram,
  runTests,
} from "./index.js";

/**
 * Advanced Peripherals on each Minecraft version (docs/advanced-peripherals-versions.md): 1.18.2 runs 0.7.31r,
 * 1.20.1 0.7.48r and 1.21.1 0.7.62b. Method lists are each jar's @LuaFunction names (ap-surface-versions.json, read
 * with javap); behaviour follows the 1.18.2-0.7.30r, 1.20.1-0.7.48r and 1.21.1-0.7.62b source tags. The ME and RS
 * bridges have their own file (ap-bridges-versions.integration.test.ts).
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "ap-versions-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let counter = 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Version = "1.18.2" | "1.20.1" | "1.21.1";
const VERSIONS: Version[] = ["1.18.2", "1.20.1", "1.21.1"];

interface Surface {
  type: string;
  methods: string[];
}
const SURFACE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./ap-surface-versions.json", import.meta.url)),
    "utf8",
  ),
) as Record<Version, Record<string, Surface>>;

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/** The world on that version, without vhcctweaks (it turns four AP blocks off on 1.18.2 and exists nowhere else). */
function on(version: Version, world: WorldConfig): WorldConfig {
  return { ...world, version, vhcctweaks: false } as WorldConfig;
}

const PRELUDE = `
local MC = ...
local SIM = function(cmd) os.queueEvent("ccsim_cmd", nil, textutils.serializeJSON(cmd)) end
local function msg(fn, ...)
  local ok, err = pcall(fn, ...)
  if ok then return nil end
  return (tostring(err):gsub("^[^:]*:%d+: ", ""):gsub("^pcall: ", ""))
end
local function sorted(t) table.sort(t) return t end
local NEW = MC ~= "1.18.2"
`;

async function lua(
  version: Version,
  source: string,
  world: WorldConfig,
): Promise<TestRunResult> {
  counter += 1;
  const name = `apv${counter}.test.lua`;
  put(
    name,
    PRELUDE.replace("local MC = ...", `local MC = "${version}"`) + source,
  );
  return runTests(
    config,
    { paths: [name], world: on(version, world), timeoutMs: 30000 },
    1,
  );
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
  expect(result.files[0]!.tests.length).toBeGreaterThan(0);
}

const toLua = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/"(\w+)":/g, "$1 =");

/** What AP adds besides a peripheral's own methods: BasePeripheral's two, and the owner's operation / fuel plugins. */
const EXTRAS: Record<string, string[]> = {
  "": ["getConfiguration", "getName"],
  chatBox: ["getOperationCooldown"],
  environmentDetector: [
    "getOperationCooldown",
    "getFuelLevel",
    "getMaxFuelLevel",
    "getFuelConsumptionRate",
    "setFuelConsumptionRate",
    // Mekanism's radiation plugin (EnvironmentRadiationPlugin), there when Mekanism is
    "getRadiation",
    "getRadiationRaw",
  ],
  geoScanner: [
    "getOperationCooldown",
    "getFuelLevel",
    "getMaxFuelLevel",
    "getFuelConsumptionRate",
    "setFuelConsumptionRate",
  ],
};

describe.skipIf(!ready).each(VERSIONS)("Advanced Peripherals on %s", (mc) => {
  it("has each jar's types and methods, under the version's type names", async () => {
    // the chunky turtle is a turtle upgrade (ap-extra.integration.test.ts); everything else is a block here
    const types = Object.keys(SURFACE[mc]).filter((t) => t !== "chunky");
    const expected: Record<string, { type: string; methods: string[] }> = {};
    for (const t of types)
      expected[t] = {
        type: SURFACE[mc][t]!.type,
        methods: [
          ...SURFACE[mc][t]!.methods,
          ...EXTRAS[""]!,
          ...(EXTRAS[t] ?? []),
        ].sort(),
      };
    const r = await lua(
      mc,
      `
local expected = ${toLua(expected)}
for canonical, want in pairs(expected) do
  ccunit.test(canonical, function()
    ccunit.eq(peripheral.getType("p_" .. canonical), want.type)
    ccunit.eq(peripheral.getMethods("p_" .. canonical), want.methods)
    ccunit.truthy(peripheral.find(want.type), "find " .. want.type)
  end)
end
`,
      {
        peripherals: types.map((type) => ({
          name: `p_${type}`,
          type,
        })) as never,
      },
    );
    expectAllPassed(r);
    const all = [
      "playerDetector",
      "chatBox",
      "energyDetector",
      "nbtStorage",
      "environmentDetector",
      "meBridge",
      "rsBridge",
      "geoScanner",
      "blockReader",
      "inventoryManager",
    ];
    expect(types.sort()).toEqual(
      [
        ...all,
        ...(mc === "1.21.1" ? [] : ["redstoneIntegrator"]),
        ...(mc === "1.18.2" ? ["arController"] : []),
      ].sort(),
    );
  }, 90000);

  it("refuses the types this version's jar does not have", async () => {
    const gone =
      mc === "1.21.1"
        ? ["redstoneIntegrator", "arController"]
        : mc === "1.20.1"
          ? ["arController"]
          : [];
    for (const type of gone) {
      const w = on(mc, { peripherals: [{ name: "x", type }] as never });
      expect(checkWorld(w, {}).errors.join("\n")).toContain(
        `has no ${type} on Minecraft ${mc}`,
      );
      await expect(lua(mc, "print('never')", w)).rejects.toThrow(
        `Minecraft ${mc}`,
      );
    }
    if (mc !== "1.21.1")
      expect(
        checkWorld(
          on(mc, {
            peripherals: [{ name: "x", type: "redstoneIntegrator" }] as never,
          }),
          {},
        ).errors,
      ).toEqual([]);
    if (mc === "1.21.1") {
      expect(
        checkWorld(
          on(mc, {
            peripherals: [{ name: "x", type: "redstoneIntegrator" }] as never,
          }),
          {},
        ).errors.join("\n"),
      ).toContain("removed in 0.7.50b; use CC:Tweaked's redstone_relay");
      // a world may name a block by its 1.21.1 name too
      const r = await lua(
        mc,
        `ccunit.test("new name", function() ccunit.eq(peripheral.getType("pd"), "player_detector") end)`,
        { peripherals: [{ name: "pd", type: "player_detector" }] as never },
      );
      expectAllPassed(r);
    }
  }, 60000);

  it("player detector ranges, getPlayerPos and the advancedperipherals API", async () => {
    const r = await lua(
      mc,
      `
local d = peripheral.wrap("pd")

ccunit.test("ranges", function()
  if not NEW then
    -- 0.7.30r: boxes around the block corner, max edge exclusive, the detector's dimension only
    ccunit.eq(sorted(d.getPlayersInRange(2)), { "Alice" })
    ccunit.eq(d.getPlayersInRange(0), {})
    ccunit.eq(sorted(d.getOnlinePlayers()), { "Alice", "Bob", "Carol", "Edgar" })
    ccunit.eq(sorted(d.getPlayersInCubic(3, 1, 3)), { "Alice", "Edgar" }) -- extents doubled: x in [-6, 6)
    return
  end
  -- 0.7.48r on: from the block centre, feet to eyes; -1 is everyone, 0 nobody; other dimensions are seen while the
  -- range is unlimited (the default), and a cubic range only checks the dimension when there is a limit
  ccunit.eq(sorted(d.getPlayersInRange(2)), { "Alice" })
  ccunit.eq(sorted(d.getPlayersInRange(5)), { "Alice", "Edgar" })
  ccunit.eq(d.getPlayersInRange(0), {})
  ccunit.eq(sorted(d.getPlayersInRange(-1)), { "Alice", "Bob", "Carol", "Edgar" })
  ccunit.eq(sorted(d.getPlayersInCubic(3, 1, 3)), { "Alice", "Carol" })
  ccunit.eq(sorted(d.getOnlinePlayers()), { "Alice", "Bob", "Carol", "Edgar" })
  ccunit.eq(d.isPlayersInRange(-1), true)
  ccunit.eq(sorted(d.getPlayersInCoords({ x = -10, y = 0, z = -10 }, { x = 10, y = 100, z = 10 })), { "Alice", "Edgar" })
end)

ccunit.test("names", function()
  ccunit.eq(d.isPlayerInRange(10, "Alice"), true)
  -- 0.7.62b asks the server for the player by name, in any case
  ccunit.eq(d.isPlayerInRange(10, "alice"), MC == "1.21.1")
end)

ccunit.test("getPlayerPos", function()
  local p = d.getPlayerPos("Alice")
  if not NEW then
    ccunit.eq(p, { x = 1, y = 64, z = 0, yaw = 0, pitch = 0, dimension = "minecraft:overworld", eyeHeight = 1.62 })
    ccunit.eq(d.getPlayer, nil)
    ccunit.eq({ d.getPlayerPos("Nobody") }, { {} })
    return
  end
  local want = { x = 1, y = 64, z = 0, yaw = 0, pitch = 0, dimension = "minecraft:overworld", eyeHeight = 1.62,
    health = 20, maxHealth = 20, airSupply = 300, respawnDimension = "minecraft:overworld", respawnAngle = 0 }
  if MC == "1.20.1" then want.maxHeatlh = 20 else want.uuid = p.uuid want.name = "Alice" end
  ccunit.eq(p, want)
  ccunit.eq(d.getPlayerPos("Alice", 2).x, 1.25)
  ccunit.eq(d.getPlayer("Alice", 9).x, 1.2567) -- at most 4 decimals
  if MC == "1.20.1" then
    ccunit.eq({ d.getPlayerPos("Nobody") }, { {}, "PLAYER_NOT_FOUND" })
  else
    ccunit.eq({ d.getPlayerPos("Nobody") }, { nil })
  end
end)

ccunit.test("advancedperipherals API", function()
  if MC ~= "1.21.1" then ccunit.eq(advancedperipherals, nil) return end
  ccunit.eq(advancedperipherals.getMCVersion(), "1.21.1")
  ccunit.eq(advancedperipherals.getAPVersion(), "0.7.62b")
  ccunit.eq(advancedperipherals.getAddonVersions(), {})
end)
`,
      {
        players: [
          { name: "Alice", x: 1.25678, y: 64, z: 0 },
          { name: "Bob", x: 400, y: 64, z: 0 },
          {
            name: "Carol",
            x: 3,
            y: 64,
            z: 3,
            dimension: "minecraft:the_nether",
          },
          { name: "Dave", x: 0, y: 64, z: 0, online: false },
          { name: "Edgar", x: 5, y: 64, z: 0 },
        ],
        peripherals: [{ name: "pd", type: "playerDetector" }] as never,
      },
    );
    expectAllPassed(r);
  }, 60000);

  it("player and chat events", async () => {
    const r = await lua(
      mc,
      `
local function next(want)
  local timer = os.startTimer(2)
  while true do
    local e = { os.pullEvent() }
    if e[1] == want then return e end
    if e[1] == "timer" and e[2] == timer then return nil end
  end
end

ccunit.test("playerClick", function()
  SIM({ cmd = "playerClick", player = "Alice" })
  local e = next("playerClick")
  -- 0.7.48r on: and the detector's name on this computer
  if NEW then ccunit.eq(e, { "playerClick", "Alice", "pd" }) else ccunit.eq(e, { "playerClick", "Alice" }) end
end)

ccunit.test("chat", function()
  SIM({ cmd = "chat", player = "Alice", message = "hello" })
  local e = next("chat")
  local uuid = e[4]
  -- 0.7.48r on: a fifth argument, the message as UTF-8 bytes
  if NEW then ccunit.eq(e, { "chat", "Alice", "hello", uuid, false, "hello" })
  else ccunit.eq(e, { "chat", "Alice", "hello", uuid, false }) end
end)

ccunit.test("join, leave and dimension change", function()
  SIM({ cmd = "leave", player = "Alice" })
  local left = next("playerLeave")
  SIM({ cmd = "join", player = "Alice" })
  local joined = next("playerJoin")
  SIM({ cmd = "setPlayerPos", player = "Alice", dimension = "minecraft:the_end" })
  local moved = next("playerChangedDimension")
  if not NEW then
    ccunit.eq({ left, joined, moved }, {}) -- 0.7.31r has none of the three
    return
  end
  ccunit.eq(left, { "playerLeave", "Alice", "minecraft:overworld" })
  ccunit.eq(joined, { "playerJoin", "Alice", "minecraft:overworld" })
  ccunit.eq(moved, { "playerChangedDimension", "Alice", "minecraft:overworld", "minecraft:the_end" })
end)
`,
      {
        players: [{ name: "Alice" }],
        peripherals: [
          { name: "pd", type: "playerDetector" },
          { name: "cb", type: "chatBox" },
        ] as never,
      },
    );
    expectAllPassed(r);
  }, 60000);

  it("chat box ranges, prefixes, toasts and limits", async () => {
    // what each call returns (pcall's results)
    const want =
      mc === "1.18.2"
        ? // 0.7.30r: no range argument on sendMessageToPlayer, & codes stay text, no toasts
          [
            "sendMessage true,true",
            "sendMessage true,true",
            "sendMessageToPlayer true,true",
          ]
        : [
            "sendMessage true,true",
            "sendMessage true,true",
            "sendMessageToPlayer true,true",
            "sendToastToPlayer true,true",
            'sendFormattedToastToPlayer true,nil,"incorrect json for title"',
            'sendFormattedToastToPlayer true,nil,"incorrect bracket string (e.g. [], {}, <>, ,,,)"',
            ...(mc === "1.21.1"
              ? [
                  'sendMessage true,nil,"Message is too long"',
                  // 0.7.62b reads the formatted message's UTF-8 flag from the range's place
                  'sendFormattedMessageToPlayer false,"bad argument #6 (boolean expected, got number)"',
                ]
              : [
                  "sendMessage true,true",
                  "sendFormattedMessageToPlayer true,true",
                ]),
          ];
    put(
      `chat-${mc}.lua`,
      `
local c = peripheral.wrap("cb")
local out = {}
local function call(name, ...)
  local r = table.pack(pcall(c[name], ...))
  local parts = {}
  for i = 1, r.n do parts[i] = type(r[i]) == "string" and ("%q"):format(r[i]) or tostring(r[i]) end
  out[#out + 1] = name .. " " .. table.concat(parts, ",")
  sleep(0.15) -- past the 100 ms cooldown
end
call("sendMessage", "all")
call("sendMessage", "near", "&aP", nil, "&c", 3)
call("sendMessageToPlayer", "dm", "Carol", nil, nil, nil, 2)
if c.sendToastToPlayer then
  call("sendToastToPlayer", "body", "Title", "Alice")
  call("sendFormattedToastToPlayer", '{"text":"x"}', "not json", "Alice")
  call("sendFormattedToastToPlayer", '{"text":"x"}', '{"text":"T"}', "Alice", nil, "[")
  call("sendMessage", string.rep("a", 1025))
  call("sendFormattedMessageToPlayer", '{"text":"x"}', "Alice", nil, nil, nil, 5)
end
local want = { ${want.map((w) => JSON.stringify(w)).join(", ")} }
local got, expected = table.concat(out, "\\n"), table.concat(want, "\\n")
if got ~= expected then error("returns differ; got:\\n" .. got, 0) end
`,
    );
    const result = await runProgram(config, {
      program: `chat-${mc}.lua`,
      world: on(mc, {
        players: [
          { name: "Alice", x: 1, y: 64, z: 0 },
          { name: "Bob", x: 400, y: 64, z: 0 },
          {
            name: "Carol",
            x: 3,
            y: 64,
            z: 3,
            dimension: "minecraft:the_nether",
          },
        ],
        peripherals: [{ name: "cb", type: "chatBox" }] as never,
      }),
      timeoutMs: 30000,
    });
    expect(result.error?.message ?? "").toBe("");
    expect(result.status).toBe("completed");
    const chat = (result.sim?.chat ?? []).map(
      (c) =>
        `${String(c.to)}: ${String(c.text)}` +
        ((c as { title?: string }).title
          ? ` (${String((c as { title?: string }).title)})`
          : ""),
    );
    if (mc === "1.18.2") {
      expect(chat).toEqual([
        "Alice: [§rAP]§r all",
        "Bob: [§rAP]§r all",
        "Carol: [§rAP]§r all",
        "Alice: &c[§r&aP&c]§r near",
        "Carol: [§rAP]§r dm",
      ]);
      return;
    }
    expect(chat.slice(0, 5)).toEqual([
      "Alice: [§rAP]§r all",
      "Bob: [§rAP]§r all",
      "Carol: [§rAP]§r all",
      // range 3 from the block centre, in its dimension; & codes become § in the prefix and bracket colour
      "Alice: §c[§r§aP§c]§r near",
      // Carol is 2.5 blocks off in another dimension: true, and nothing sent
      "Alice: [§rAP]§r body (Title)",
    ]);
  }, 60000);

  it("environment detector names, moon and scan errors", async () => {
    const r = await lua(
      mc,
      `
local e = peripheral.wrap("env")
ccunit.test("names", function()
  if not NEW then
    ccunit.eq(e.getBiome(), "plains")
    ccunit.eq(e.getDimensionName(), "dimension")
    ccunit.eq(e.isDimension("overworld"), false)
    ccunit.eq(e.getMoonName(), "Moon.exe not found...")
    ccunit.eq({ e.scanCost(17) }, { nil, "Radius is exceed max value" })
    return
  end
  ccunit.eq(e.getBiome(), "minecraft:plains")
  ccunit.eq(e.getDimension(), "minecraft:overworld")
  ccunit.eq(e.isDimension("minecraft:overworld"), true)
  ccunit.eq(sorted(e.listDimensions()), { "overworld", "the_end", "the_nether" })
  ccunit.eq({ e.getMoonId(), e.getMoonName(), e.isMoon(4) }, { 4, "New moon", true })
  ccunit.eq({ e.scanCost(17) }, { nil, "Radius exceeds max value" })
end)
ccunit.test("scanned players carry health", function()
  local list = e.scanEntities(4)
  ccunit.eq(#list, 1)
  if NEW then
    ccunit.eq({ list[1].health, list[1].maxHealth, list[1].isInWall }, { 15, 20, false })
  else
    ccunit.eq(list[1].health, nil)
  end
end)
`,
      {
        players: [{ name: "Alice", x: 1, y: 64, z: 1, health: 15 }],
        environment: { biome: "plains", moonPhase: 4 } as never,
        peripherals: [{ name: "env", type: "environmentDetector" }] as never,
      },
    );
    expectAllPassed(r);
  }, 60000);

  it("block reader states, NBT storage writeTable, inventory manager filters", async () => {
    const r = await lua(
      mc,
      `
local br, nbt, im = peripheral.wrap("br"), peripheral.wrap("nbt"), peripheral.wrap("im")
ccunit.test("block reader", function()
  ccunit.eq(br.getBlockName(), "minecraft:chest")
  if not NEW then ccunit.eq({ br.getBlockStates, br.isTileEntity }, {}) return end
  ccunit.eq(br.getBlockStates(), { facing = "east", type = "single", waterlogged = false })
  ccunit.eq(br.isTileEntity(), true)
end)
ccunit.test("nbt storage", function()
  if not NEW then ccunit.eq(nbt.writeTable, nil) return end -- 0.7.30r's throws IOException: CC never offers it
  ccunit.eq(nbt.writeTable({ a = true, b = { 1, "x" } }), true)
  ccunit.eq(nbt.read(), { a = 1, b = { ["1"] = 1, ["2"] = "x" } })
end)
ccunit.test("inventory manager", function()
  SIM({ cmd = "setMemoryCard", peripheral = "im", owner = "Alice" })
  sleep(0.2)
  SIM({ cmd = "setPlayerItem", player = "Alice", slot = 0, item = { name = "minecraft:apple", count = 5 } })
  sleep(0.2)
  local item = im.getItems()[1]
  if not NEW then
    ccunit.eq(im.removeItemFromPlayer("up", 2, nil, "minecraft:apple"), 2)
    ccunit.eq(msg(im.getItemsChest, "sideways"), "SIDEWAYS is not a valid side")
    ccunit.eq(item.fingerprint, nil)
    ccunit.eq(im.getItemInOffHand(), {})
    return
  end
  ccunit.eq(im.pushItems, nil)
  ccunit.eq(im.addItemToPlayerNBT, nil)
  ccunit.eq({ im.removeItemFromPlayer("up", { name = "minecraft:apple", count = 2 }) }, { 2 })
  ccunit.eq(msg(im.removeItemFromPlayer, "up", 2), "bad argument #2 (table expected, got number)")
  ccunit.eq(type(item.fingerprint), "string")
  if MC == "1.20.1" then
    ccunit.eq(item.nbt, {})
    ccunit.eq(msg(im.getItemsChest, "sideways"), "sideways is not a valid side")
    ccunit.eq({ im.addItemToPlayer("up", { name = "minecraft:apple", count = 1 }) }, { 1, nil })
    ccunit.eq(im.getItemInOffHand(), {})
    ccunit.eq({ im.removeItemFromPlayer("up", { name = 5 }) }, { 0, "NO_VALID_ITEM" })
  else
    ccunit.eq({ item.nbt, item.components }, { nil, {} })
    ccunit.eq(msg(im.getItemsChest, "sideways"), "Java Exception Thrown: java.lang.NullPointerException")
    ccunit.eq({ im.addItemToPlayer("down", { name = "minecraft:apple" }) }, { 0, "INVENTORY_FROM_INVALID" })
    ccunit.eq(im.getItemInOffHand(), nil)
    ccunit.eq(msg(im.removeItemFromPlayer, "up", { name = 5 }), "bad field 'name' (string expected, got number)")
  end
end)
`,
      {
        players: [{ name: "Alice" }],
        peripherals: [
          {
            name: "br",
            type: "blockReader",
            block: {
              name: "minecraft:chest",
              items: [],
              state: { facing: "east" },
            },
          },
          { name: "nbt", type: "nbtStorage" },
          {
            name: "im",
            type: "inventoryManager",
            adjacent: { up: "chest" },
          },
          { name: "chest", type: "minecraft:chest" },
        ] as never,
      },
    );
    expectAllPassed(r);
  }, 60000);
});
