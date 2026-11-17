import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * CC: Lectern Hub 1.0.0-1.115.0 (docs/lectern-hub.md), from the mod's source at commit 566ba01. Not measured in game.
 */
const kit = addonTestKit("lh");

const world = {
  version: "1.20.1",
  addons: ["lectern-hub"],
  peripherals: [
    {
      name: "left",
      type: "cc_lectern",
      pocket: { id: 3, label: "Map", on: false },
    },
    { name: "right", type: "cc_lectern" },
  ],
} as unknown as WorldConfig;

describe.skipIf(!kit.ready)("CC: Lectern Hub", () => {
  it("every method, on a pocket and on a printout", async () => {
    const result = await kit.lua(
      `
ccunit.test("pocket", function()
  local l = peripheral.wrap("left")
  ccunit.eq(peripheral.getMethods("left"), { "reboot", "getLabel", "turnOn", "isPocket", "isOn", "getID", "shutdown" })
  ccunit.eq({ l.isPocket(), l.getID(), l.getLabel(), l.isOn() }, { true, 3, "Map", false })
  ccunit.eq(select("#", l.turnOn()), 0)
  ccunit.eq(l.isOn(), false)
  os.sleep(0.1)
  ccunit.eq(l.isOn(), true)
  ccunit.eq(select("#", l.shutdown()), 0)
  ccunit.eq(l.isOn(), false)
end)
ccunit.test("printout (the default item)", function()
  local r = peripheral.wrap("right")
  ccunit.eq({ r.isPocket(), r.getID(), r.isOn() }, { false, -1, false })
  ccunit.eq(select("#", r.getLabel()), 1)
  ccunit.eq(select("#", r.reboot()), 0)
end)
`,
      world,
      "methods.test.lua",
    );
    kit.expectAllPassed(result);
  }, 120000);

  it("sim commands: lhSetPocket, the item leaving the lectern, state", async () => {
    await kit.withSession(world, async (step) => {
      let st = await step({
        cmd: "lhSetPocket",
        peripheral: "left",
        on: true,
        label: "Atlas",
        id: 9,
      });
      expect(peripheralState(st, "left")).toEqual({
        pocket: { id: 9, label: "Atlas", on: true },
        starting: false,
      });
      st = await step({ cmd: "lhSetPocket", peripheral: "left", label: false });
      expect(
        (peripheralState(st, "left").pocket as Record<string, unknown>).label,
      ).toBeUndefined();
      expect(peripheralState(st, "right")).toEqual({
        item: "computercraft:printed_page",
      });
      // taking the pocket off turns the lectern back into a vanilla one: no peripheral
      st = await step({ cmd: "detachPeripheral", name: "left" });
      expect(st.peripherals?.["left"]).toBeUndefined();
    });
  }, 120000);

  it("a printout cannot take lhSetPocket", async () => {
    await kit.withSession(world, async (_step, s) => {
      expect(
        await s.send({ cmd: "lhSetPocket", peripheral: "right", on: true }),
      ).toEqual({
        applied: true,
        error: "right holds a printout, not a pocket computer",
      });
    });
  }, 120000);

  it("is a 1.20.1 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(
      /cc_lectern from CC: Lectern Hub \(addon "lectern-hub"\)/,
    );
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, version: "1.18.2" } as WorldConfig,
        "old.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.18\.2/);
  });
});
