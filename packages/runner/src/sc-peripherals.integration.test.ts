import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * SwitchCraft Peripherals 1.10.5 (docs/sc-peripherals.md), from the mod's source at commit 50e801b. Not measured in
 * game.
 */
const kit = addonTestKit("sc");

const world = {
  version: "1.20.1",
  addons: ["sc-peripherals"],
  peripherals: [
    { name: "left", type: "3d_printer", chamelium: 10000, ink: 10000 },
  ],
} as unknown as WorldConfig;

describe.skipIf(!kit.ready)("SwitchCraft Peripherals", () => {
  it("a print: state events (commit's own is lost), 100 ticks, equal prints stack, a new model waits for the output slot", async () => {
    const result = await kit.lua(
      `
local p = peripheral.wrap("left")
ccunit.test("print", function()
  p.addShape(0, 0, 0, 16, 16, 16)
  local t0 = os.epoch("utc")
  ccunit.eq(p.commit(2), true)
  -- commit's own "busy" event is lost: it is queued while the main-thread call waits for its task_complete
  ccunit.eq({ os.pullEvent("3d_printer_complete") }, { "3d_printer_complete", 1 })
  local took = os.epoch("utc") - t0
  ccunit.truthy(took >= 5000 and took <= 5300, "first print: " .. took)
  ccunit.eq({ os.pullEvent("3d_printer_state") }, { "3d_printer_state", "busy" })
  ccunit.eq({ os.pullEvent("3d_printer_complete") }, { "3d_printer_complete", 0 })
  ccunit.eq({ os.pullEvent("3d_printer_state") }, { "3d_printer_state", "idle" })
  ccunit.eq(p.getItemDetail(3).count, 2)
  -- 16^3 / 2 = 2048 chamelium, 6 * 256 / 6 = 256 ink each
  ccunit.eq({ p.getChameliumLevel() }, { 10000 - 4096, 256000 })
  ccunit.eq({ p.getInkLevel() }, { 10000 - 512, 100000 })
  -- a different model cannot join that stack
  p.setLabel("other")
  p.commit(1)
  sleep(0.5)
  ccunit.eq(p.status(), "busy")
  ccunit.eq(select(2, p.status()), 0)
  ccunit.eq(p.getItemDetail(3).count, 2)
end)
`,
      world,
      "print.test.lua",
      90000,
    );
    kit.expectAllPassed(result);
  });

  it("not enough chamelium: the job waits; scSetItem brings more in", async () => {
    await kit.withSession(
      {
        ...world,
        peripherals: [
          { name: "left", type: "3d_printer", chamelium: 0, ink: 10000 },
        ],
      } as WorldConfig,
      async (step, s) => {
        s.typeLine("lua");
        await s.waitForText("lua>");
        s.typeLine(
          'local p = peripheral.wrap("left") p.addShape(0, 0, 0, 16, 16, 16) print(p.commit(1))',
        );
        await s.waitForText("true");
        await new Promise((r) => setTimeout(r, 400));
        expect(peripheralState(s.state(), "left")).toMatchObject({
          status: "busy",
          progress: 0,
          chamelium: 0,
        });
        await step({
          cmd: "scSetItem",
          peripheral: "left",
          slot: 1,
          item: { name: "sc-peripherals:chamelium", count: 2 },
        });
        await new Promise((r) => setTimeout(r, 400));
        const st = peripheralState(s.state(), "left");
        // both pieces came in (4000), then the print took 2048 of it
        expect(st.chamelium).toBe(4000 - 2048);
        expect(st.progress as number).toBeGreaterThan(0);
      },
    );
  });

  it("is a 1.20.1 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(/3d_printer from SwitchCraft Peripherals/);
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, version: "1.21.1" } as WorldConfig,
        "new.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.21\.1/);
  });
});
