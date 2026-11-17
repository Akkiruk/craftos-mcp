import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * CCTech 0.1.6 (docs/cctech.md), from the mod's source at commit ab949e6 checked against the 0.1.6 jar. Not measured
 * in game.
 */
const kit = addonTestKit("ct");

const world = {
  // CCTech only came out for 1.18.2; the public default is newer
  version: "1.18.2",
  addons: ["cctech"],
  peripherals: [
    {
      name: "left",
      type: "cassette_deck",
      open: true,
      tape: { uuid: "aaaa", length: 20000 },
    },
    {
      name: "right",
      type: "reel_to_reel",
      locked: true,
      tape: { length: 10000 },
    },
    { name: "back", type: "card_writer", writerUUID: "w-1" },
    { name: "top", type: "magnetic_card_reader" },
  ],
} as unknown as WorldConfig;

describe.skipIf(!kit.ready)("CCTech", () => {
  it("an operation's event comes (int)(bytes * ticksPerByte) ticks after the tick that takes it", async () => {
    const result = await kit.lua(
      `
ccunit.test("timing", function()
  local reel = peripheral.wrap("right")
  -- reel to reel: 20000 B/s, 1000 bytes a tick; a 1-byte read takes 0 ticks but still waits for the next tick
  local t0 = os.epoch("utc")
  reel.read(1)
  local t1 = os.epoch("utc")
  ccunit.truthy(t1 - t0 <= 100, "1 byte: " .. (t1 - t0))
  -- 5000 bytes: 5 ticks, so the event comes on the 6th tick after the one that takes it off the queue
  reel.seekAbs(0)
  local t2 = os.epoch("utc")
  ccunit.eq(#reel.read(5000), 5000)
  local took = os.epoch("utc") - t2
  -- at least the six ticks; the top is loose, as each tick waited for can come late on a busy host (449 ms was seen):
  -- it only has to show a read that waits far too long
  ccunit.truthy(took >= 300 and took <= 800, "5000 bytes: " .. took)
  ccunit.eq(reel.getPos(), 5000)
end)
ccunit.test("the cassette's door is open", function()
  ccunit.eq(err(peripheral.wrap("left").read, 1), "Door open")
end)
`,
      world,
      "timing.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("doors, inserting and ejecting a tape keeps its data in the tape's file", async () => {
    await kit.withSession(world, async (step, s) => {
      // the cassette's door is open: nothing can be read until it shuts
      let st = await step({
        cmd: "ctSetDoor",
        peripheral: "left",
        open: false,
      });
      expect(peripheralState(st, "left")).toMatchObject({
        open: false,
        tape: { uuid: "aaaa", length: 20000 },
        pointer: 0,
      });
      expect(await s.send({ cmd: "ctEject", peripheral: "left" })).toEqual({
        applied: true,
        error: "open the door first (ctSetDoor)",
      });
      // the reel is locked: its door cannot open
      expect(
        await s.send({ cmd: "ctSetDoor", peripheral: "right", open: true }),
      ).toEqual({
        applied: true,
        error: "the reel to reel is locked: its door stays shut",
      });
      s.typeLine(
        `lua`, // the Lua prompt, to write to the tape like a player at the keyboard
      );
      await s.waitForText("lua>");
      s.typeLine(`peripheral.wrap("left").write("saved!")`);
      await s.waitForText("true");
      s.typeLine(`exit()`);
      await step({ cmd: "ctSetDoor", peripheral: "left", open: true });
      st = await step({ cmd: "ctEject", peripheral: "left" });
      expect(peripheralState(st, "left").tape).toBeUndefined();
      st = await step({
        cmd: "ctInsert",
        peripheral: "left",
        tape: { uuid: "aaaa", length: 20000 },
      });
      // the cassette keeps its pointer in the file: it is back where the write left it
      expect(peripheralState(st, "left")).toMatchObject({ pointer: 6 });
      st = await step({ cmd: "ctSetDoor", peripheral: "left", open: false });
    });
  });

  it("card reader swipes and the card writer's slot", async () => {
    await kit.withSession(world, async (step, s) => {
      expect(
        await s.send({ cmd: "ctInsertCard", peripheral: "back", card: {} }),
      ).toEqual({ applied: true, error: "open the door first (ctSetDoor)" });
      await step({ cmd: "ctSetDoor", peripheral: "back", open: true });
      let st = await step({
        cmd: "ctInsertCard",
        peripheral: "back",
        card: { uuid: "w-9", contents: "vip", label: "Bob" },
      });
      expect(peripheralState(st, "back")).toEqual({
        open: true,
        writerUUID: "w-1",
        card: { uuid: "w-9", contents: "vip", label: "Bob" },
      });
      st = await step({ cmd: "ctEjectCard", peripheral: "back" });
      expect(peripheralState(st, "back").card).toBeUndefined();
      // a program waits for the reader's event; a player swipes a card written by w-1
      s.typeLine("lua");
      await s.waitForText("lua>");
      s.typeLine(
        'print(table.concat({ os.pullEvent("magnetic_card_scanned") }, "|"))',
      );
      await new Promise((r) => setTimeout(r, 300));
      await step({
        cmd: "ctSwipe",
        peripheral: "top",
        uuid: "w-1",
        contents: "staff",
      });
      // no side name: just the writer's UUID and the contents
      await s.waitForText("magnetic_card_scanned|w-1|staff");
    });
  });

  it("the jar's tape program and its completion are in the ROM", async () => {
    const result = await kit.lua(
      `
ccunit.test("rom", function()
  ccunit.eq(fs.exists("rom/programs/tape.lua"), true)
  ccunit.eq(fs.exists("rom/autorun/cctech_completion.lua"), true)
  ccunit.eq(shell.resolveProgram("tape"), "rom/programs/tape.lua")
  ccunit.eq(shell.complete("tape lo"), { "ad ", "ck " })
end)
`,
      world,
      "rom.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("a pointer byte of 128 or more reads back negative, as FileManager.getPointer adds signed bytes", async () => {
    const result = await kit.lua(
      `
ccunit.test("signed", function()
  local deck = peripheral.wrap("left")
  -- the fixture's pointer 200 is stored as the byte 0xC8, which getPointer reads as -56
  ccunit.eq(err(deck.read, 1), "Attempt to read past tape end.")
  ccunit.eq(deck.read(1), "a") -- the failed read clamped the pointer to 0
end)
`,
      {
        version: "1.18.2",
        addons: ["cctech"],
        peripherals: [
          {
            name: "left",
            type: "cassette_deck",
            tape: { length: 300, pointer: 200, data: "abc" },
          },
        ],
      } as unknown as WorldConfig,
      "signed.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("is a 1.18.2 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(/cassette_deck from CCTech \(addon "cctech"\)/);
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, version: "1.20.1" } as WorldConfig,
        "new.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.20\.1/);
    const off = await kit.lua(
      `ccunit.test("no tape program", function() ccunit.eq(fs.exists("rom/programs/tape.lua"), false) end)`,
      { addons: "none" } as unknown as WorldConfig,
      "noprog.test.lua",
    );
    kit.expectAllPassed(off);
  });
});
