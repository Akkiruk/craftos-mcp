import { describe, expect, it } from "vitest";
import { addonTestKit } from "./addon-test-kit.js";
import { type WorldConfig, pixelScreenPng, pixelScreens } from "./index.js";

/**
 * CC: DirectGPU 1.0.25 (docs/directgpu.md), from the release jar decompiled with Vineflower (the repository has no
 * source). Not measured in game.
 */
const kit = addonTestKit("dg");

const world = {
  version: "1.21.1",
  addons: ["directgpu"],
  peripherals: [
    {
      name: "directgpu_0",
      type: "directgpu",
      monitors: { monitor_0: { width: 2, height: 1 } },
    },
  ],
} as unknown as WorldConfig;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!kit.ready)("CC: DirectGPU", () => {
  it("a display is a pixel screen once updateDisplay sends it", async () => {
    await kit.withSession(world, async (_step, s) => {
      s.typeLine("lua");
      await s.waitForText("lua>");
      s.typeLine(
        'g = peripheral.wrap("directgpu_0") d = g.autoDetectAndCreateDisplay() g.clear(d, 0, 0, 255) g.fillRect(d, 0, 0, 10, 10, 255, 0, 0)',
      );
      await pause(500);
      // drawn but not sent: no screen yet
      expect(pixelScreens(s.resultsDir)).toEqual([]);
      s.typeLine("g.updateDisplay(d)");
      await pause(1500);
      const screens = pixelScreens(s.resultsDir);
      expect(screens.map((p) => [p.peripheral, p.width, p.height])).toEqual([
        ["directgpu_0.0", 328, 164],
      ]);
      const px = (x: number, y: number) =>
        Array.from(
          screens[0]!.rgba.subarray((y * 328 + x) * 4, (y * 328 + x) * 4 + 3),
        );
      expect(px(5, 5)).toEqual([255, 0, 0]);
      expect(px(100, 100)).toEqual([0, 0, 255]);
      expect(pixelScreenPng(screens[0]!).subarray(1, 4).toString()).toBe("PNG");
      // removing the display takes its screen away
      s.typeLine("g.removeDisplay(d)");
      await pause(800);
      expect(pixelScreens(s.resultsDir)).toEqual([]);
    });
  });

  it("mouse input: the queue and directgpu_mouse", async () => {
    await kit.withSession(world, async (step, s) => {
      s.typeLine("lua");
      await s.waitForText("lua>");
      s.typeLine(
        'g = peripheral.wrap("directgpu_0") d = g.autoDetectAndCreateDisplay(320, 160) g.enableMouseEvents(d, true)',
      );
      await pause(500);
      s.typeLine(
        'print(table.concat({ os.pullEvent("directgpu_mouse") }, "|"))',
      );
      await pause(300);
      await step({
        cmd: "dgMouse",
        peripheral: "directgpu_0",
        display: 0,
        x: 12,
        y: 34,
      });
      await s.waitForText("directgpu_mouse|0|mouse_click|12|34|1");
      s.typeLine("e = g.pollEvent(d) print(e.type, e.x, e.y, g.hasEvents(d))");
      await s.waitForText("mouse_click");
    });
  });

  it("is a 1.21.1 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(/directgpu from CC: DirectGPU/);
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, version: "1.20.1" } as WorldConfig,
        "old.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.20\.1/);
  });
});
