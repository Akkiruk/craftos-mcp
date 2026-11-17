import { describe, expect, it } from "vitest";
import { addonTestKit } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/** CIDE 1.1.0 (docs/cide.md): what a computer sees of the editor mod, read from its jar. */
const kit = addonTestKit("cide");

describe.skipIf(!kit.ready)("CIDE", () => {
  it("cide_dbg and rom/cide are there with the addon and gone without it", async () => {
    const on = await kit.lua(
      `ccunit.test("on", function()
  ccunit.eq(type(cide_dbg.isActive), "function")
  ccunit.eq(fs.list("rom/cide"), { "agent.lua", "run.lua" })
end)`,
      { version: "1.21.1", addons: ["cide"] } as unknown as WorldConfig,
      "on.test.lua",
    );
    kit.expectAllPassed(on);
    const off = await kit.lua(
      `ccunit.test("off", function()
  ccunit.eq(cide_dbg, nil)
  ccunit.eq(fs.exists("rom/cide"), false)
end)`,
      { version: "1.21.1", addons: "none" } as unknown as WorldConfig,
      "off.test.lua",
    );
    kit.expectAllPassed(off);
  });

  it("has only a 1.21.1 release", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { version: "1.20.1", addons: ["cide"] } as unknown as WorldConfig,
        "old.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.20\.1/);
  });
});
