import { describe, expect, it } from "vitest";
import { ADDON_SUMMARIES, addonSummary } from "./addon-summaries.js";
import { ADDONS } from "./addons.js";

describe("the mods' plain descriptions", () => {
  it("every mod has one, and none is left over from a mod that is gone", () => {
    const ids = ADDONS.map((a) => a.id).sort();
    expect(Object.keys(ADDON_SUMMARIES).sort()).toEqual(ids);
  });

  it("each is one short plain line", () => {
    for (const a of ADDONS) {
      const line = addonSummary(a.id);
      expect(line.length, a.id).toBeGreaterThan(10);
      expect(line.length, a.id).toBeLessThan(110);
      expect(line, a.id).not.toMatch(/[\n—]/);
    }
    expect(addonSummary("no-such-mod")).toBe("");
  });
});
