import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/** CCX 6.1.1 (docs/ccx.md), from the mod's source at commit 20f1e4e. Not measured in game. */
const kit = addonTestKit("ccx");

const world = {
  version: "1.20.1",
  addons: ["ccx"],
  peripherals: [
    {
      name: "pcie_0",
      type: "pcie",
      cards: {
        "1": { kind: "inventory", target: "chest" },
        "2": { kind: "inventory", target: "nothing_here" },
        "3": { kind: "command" },
      },
    },
    { name: "usb_port_0", type: "usb_port", usb: {} },
    {
      name: "chest",
      type: "minecraft:chest",
      size: 9,
      items: { "1": { name: "minecraft:stone", count: 3 } },
    },
  ],
} as unknown as WorldConfig;

describe.skipIf(!kit.ready)("CCX", () => {
  it("cards without a block, the command card, an unbound card", async () => {
    const result = await kit.lua(
      `
ccunit.test("cards", function()
  local cards = peripheral.call("pcie_0", "getMethods")
  ccunit.eq({ cards.card_2.size() }, { false, "Block is NOT a inventory!" })
  ccunit.eq(cards.card_3, nil) -- PCIePeripheral has no case for the command card
  ccunit.eq({ peripheral.call("usb_port_0", "getMethods").usb.getChannel() }, { true, 1 })
end)
`,
      world,
      "cards.test.lua",
    );
    kit.expectAllPassed(result);
    const unbound = await kit.lua(
      `ccunit.test("nil", function() ccunit.eq(peripheral.call("pcie_0", "getMethods"), nil) end)`,
      {
        ...world,
        peripherals: [
          {
            name: "pcie_0",
            type: "pcie",
            cards: { "1": { kind: "inventory", bound: false } },
          },
        ],
      } as WorldConfig,
      "unbound.test.lua",
    );
    kit.expectAllPassed(unbound);
  });

  it("functions taken before a card or USB comes out say it is gone", async () => {
    await kit.withSession(world, async (step, s) => {
      s.typeLine("lua");
      await s.waitForText("lua>");
      s.typeLine(
        'card = peripheral.call("pcie_0", "getMethods").card_1 usb = peripheral.call("usb_port_0", "getMethods").usb',
      );
      await new Promise((r) => setTimeout(r, 300));
      let st = await step({
        cmd: "ccxSetCard",
        peripheral: "pcie_0",
        slot: 1,
        card: null,
      });
      expect(
        (peripheralState(st, "pcie_0").cards as Record<string, unknown>)["1"],
      ).toBeUndefined();
      st = await step({
        cmd: "ccxSetUsb",
        peripheral: "usb_port_0",
        usb: null,
      });
      s.typeLine("print(select(2, card.list()), select(2, usb.getChannel()))");
      await s.waitForText("Card not inserted!");
      await s.waitForText("USB not inserted!");
    });
  });

  it("is a 1.20.1 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(/pcie from CCX/);
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, version: "1.21.1" } as WorldConfig,
        "new.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.21\.1/);
  });
});
