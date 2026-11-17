import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * Lake's CC Additions 1.7.0 (docs/lakes-cc-additions.md), from the mod's source at commit 6ecd001. The fingerprints
 * are SHA-256 of "<id>|<Tag.toString()>", worked out by hand from Minecraft 1.20.1's StringTagVisitor rules. Not
 * measured in game.
 */
const kit = addonTestKit("lk");

const scanner = (item: unknown, extra: Record<string, unknown> = {}) =>
  ({
    version: "1.20.1",
    addons: ["lakes-cc-additions"],
    ...extra,
    peripherals: [{ name: "top", type: "scanner", item }],
  }) as unknown as WorldConfig;

describe.skipIf(!kit.ready)("Lake's CC Additions scanner", () => {
  it("fingerprints hash the item's SNBT as Minecraft writes it", async () => {
    const result = await kit.lua(
      `
local s = peripheral.wrap("top")
ccunit.test("quotes", function()
  -- a string holding " is quoted with '; keys sort; ints have no suffix
  ccunit.eq(s.fingerprint(), "343896279a083115de737343ab177fbe021ead023bf280fea230a8bef525530a")
  ccunit.eq(s.scanNBT(), { name = "minecraft:paper", count = 3, nbt = { display = { Name = '{"text":"Memo"}' } } })
  ccunit.eq(s.getItem(), { name = "minecraft:paper", count = 3, displayName = "Memo" })
end)
`,
      scanner({
        name: "minecraft:paper",
        count: 3,
        displayName: "Memo",
        nbt: `{display:{Name:'{"text":"Memo"}'}}`,
      }),
      "fp.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("maps: pixels, the 16 commonest colours, the atlas tile", async () => {
    // a 128x128 map: the top half grass (id 1, shade 2), the bottom half water (id 12, shade 1)
    const colors = [
      ...Array(64 * 128).fill(1 * 4 + 2),
      ...Array(64 * 128).fill(12 * 4 + 1),
    ];
    const result = await kit.lua(
      `
local s = peripheral.wrap("top")
ccunit.test("map", function()
  local m = s.scanMap()
  ccunit.eq({ m.centerX, m.centerZ, m.scale, m.locked, m.dimension }, { 200, -40, 1, true, "minecraft:overworld" })
  ccunit.eq(m.decorations, { { type = "player", x = 3, y = -4, rotation = 8 } })
  local px = s.scanMapPixels()
  ccunit.eq({ px.width, px.height, #px.rows, px.rows[1]:byte(1), px.rows[128]:byte(128) }, { 128, 128, 128, 6, 49 })
  local mon = s.scanMapForMonitor()
  -- grass at full shade is MapColor 1 itself; water (4210943) at 220/255
  local water = math.floor(0x40 * 220 / 255) * 65536 + math.floor(0x40 * 220 / 255) * 256 + math.floor(0xFF * 220 / 255)
  ccunit.eq({ mon.palette[1] == 8368696 or mon.palette[1] == water, mon.palette[3] }, { true, 0 })
  ccunit.eq(mon.rows[1]:sub(1, 3) ~= mon.rows[128]:sub(1, 3), true)
  local tile = s.scanMapTile()
  ccunit.eq(tile.palette[3], 0x7FB238)
  ccunit.eq(tile.rows[1]:sub(1, 1), "2") -- the atlas's grass
  ccunit.eq(tile.rows[128]:sub(1, 1), "4") -- the atlas's water
  ccunit.eq({ tile.gridX, tile.gridZ, tile.scale }, { 1, 0, 1 })
end)
`,
      scanner({
        name: "minecraft:filled_map",
        nbt: "{map:7}",
        map: {
          centerX: 200,
          centerZ: -40,
          scale: 1,
          locked: true,
          decorations: [{ type: "PLAYER", x: 3, y: -4, rotation: 8 }],
          colors,
        },
      }),
      "map.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("books, stamps, drawings and containers", async () => {
    const stampRows = Array.from({ length: 32 }, (_, y) =>
      y === 0 ? "123" + "0".repeat(29) : "0".repeat(32),
    );
    const result = await kit.lua(
      `
local s = peripheral.wrap("top")
ccunit.test("book", function()
  local b = s.scanBook()
  ccunit.eq(b, { type = "written", title = "Log", author = "Alex", generation = 0, pages = { "Day one", "plain" }, pageCount = 2 })
end)
`,
      scanner({
        name: "minecraft:written_book",
        nbt: `{title:"Log",author:"Alex",pages:['{"text":"Day ","extra":[{"text":"one"}]}','"plain"']}`,
      }),
      "book.test.lua",
    );
    kit.expectAllPassed(result);
    const stamp = await kit.lua(
      `
ccunit.test("stamp", function()
  local st = peripheral.wrap("top").scanStamp()
  ccunit.eq(st.size, 32)
  ccunit.eq(st.rows[1], "123" .. ("0"):rep(29))
end)
`,
      scanner({ name: "lakescanner:stamp", emblem: stampRows }),
      "stamp.test.lua",
    );
    kit.expectAllPassed(stamp);
    const ink = await kit.lua(
      `
ccunit.test("ink", function()
  local s = peripheral.wrap("top")
  ccunit.eq(s.countInk(0, 0, 10, 10), { total = 3, dark = 1, red = 1, blue = 1 })
  ccunit.eq(s.countInk(1, 0, 1, 1), { total = 1, dark = 0, red = 1, blue = 0 })
  ccunit.eq(s.scanPrintout().pages[1].drawing[1]:sub(1, 4), "1230")
end)
`,
      scanner({
        name: "computercraft:printed_page",
        nbt: '{Title:"Form",Pages:1}',
        drawings: { "1": ["123"] },
      }),
      "ink.test.lua",
    );
    kit.expectAllPassed(ink);
    const box = await kit.lua(
      `
ccunit.test("box", function()
  ccunit.eq(peripheral.wrap("top").scanContainer(), {
    { slot = 1, name = "minecraft:stone", count = 64, hasNbt = false, nested = false },
    { slot = 5, name = "minecraft:shulker_box", count = 1, hasNbt = true, nested = true },
  })
end)
`,
      scanner({
        name: "minecraft:shulker_box",
        nbt: '{BlockEntityTag:{Items:[{Slot:0b,id:"minecraft:stone",Count:64b},{Slot:4b,id:"minecraft:shulker_box",Count:1b,tag:{BlockEntityTag:{Items:[]}}}]}}',
      }),
      "box.test.lua",
    );
    kit.expectAllPassed(box);
  });

  it("events: an item going in or out, a biometric scan; createPrintout into the empty slot", async () => {
    await kit.withSession(scanner(null), async (step, s) => {
      s.typeLine("lua");
      await s.waitForText("lua>");
      s.typeLine(
        'local a = { os.pullEvent("scanner") } local b = { os.pullEvent("scanner") } print(a[2] .. "|" .. tostring(a[3]) .. "|" .. tostring(b[3]))',
      );
      await new Promise((r) => setTimeout(r, 300));
      await step({
        cmd: "lkSetItem",
        peripheral: "top",
        item: { name: "minecraft:paper" },
      });
      await step({ cmd: "lkSetItem", peripheral: "top", item: null });
      await s.waitForText("top|true|false");
      s.typeLine(
        'print(table.concat({ os.pullEvent("scanner_biometric") }, "|"))',
      );
      await new Promise((r) => setTimeout(r, 300));
      await step({
        cmd: "lkBiometric",
        peripheral: "top",
        player: "Alex",
        uuid: "u-1",
      });
      await s.waitForText("scanner_biometric|top|Alex|u-1");
      s.typeLine(
        'peripheral.wrap("top").createPrintout({ { text = { "Hi" } } }, "Note")',
      );
      await new Promise((r) => setTimeout(r, 500));
      const item = peripheralState(s.state(), "top").item as Record<
        string,
        unknown
      >;
      expect(item.name).toBe("computercraft:printed_page");
      expect(item.nbt as string).toContain('Text0:"Hi                       "');
    });
  });

  it("requirePrintoutMaterials takes paper from the slot's exact stack", async () => {
    const result = await kit.lua(
      `
ccunit.test("paper", function()
  local s = peripheral.wrap("top")
  ccunit.eq(err(s.createPrintout, { { text = {} }, { text = {} } }),
    "Printing requires paper: a folder containing 2+ paper, or an exact stack of 2 paper in the slot")
  s.createPrintout({ { text = { "a" } }, { text = { "b" } }, { text = { "c" } } })
  ccunit.eq(s.getItem().name, "computercraft:printed_pages")
  ccunit.eq(s.scanPrintout().pageCount, 3)
end)
`,
      scanner(
        { name: "minecraft:paper", count: 3 },
        { lakesCcAdditions: { requirePrintoutMaterials: true } },
      ),
      "paper.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("is a 1.20.1 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...scanner(null), addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(/scanner from Lake's CC Additions/);
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...scanner(null), version: "1.18.2" } as WorldConfig,
        "old.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.18\.2/);
  });
});
