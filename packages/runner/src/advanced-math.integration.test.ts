import { describe, it } from "vitest";
import { addonTestKit } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * Advanced Math 0.3.7 (docs/advanced-math.md): a datapack whose files sit in the ROM. This also covers the ROM-file
 * mount every such addon uses (rom-overlay/rom/ccsim/romfiles.lua): what fs, require, help and completion see.
 */
const kit = addonTestKit("am");

const on = { addons: ["advanced-math"] } as unknown as WorldConfig;
const off = { addons: "none" } as unknown as WorldConfig;

describe.skipIf(!kit.ready)("Advanced Math", () => {
  for (const mc of ["1.18.2", "1.20.1", "1.21.1"]) {
    it(`mounts its files and loads its APIs on ${mc}`, async () => {
      const result = await kit.lua(
        `
ccunit.test("fs sees the datapack", function()
  ccunit.eq(type(quaternion), "table")
  ccunit.eq(type(matrix), "table")
  local apis = fs.list("rom/apis")
  local seen = {}
  for i, name in ipairs(apis) do
    seen[name] = true
    if i > 1 then ccunit.truthy(apis[i - 1] < name, "sorted") end
  end
  ccunit.truthy(seen["quaternion.lua"] and seen["matrix.lua"] and seen["vector.lua"], "merged with CC's own")
  ccunit.eq(fs.isDir("rom/modules/main/advanced_math"), true)
  ccunit.eq(fs.isDir("rom/apis/matrix.lua"), false)
  ccunit.eq(fs.getDrive("rom/modules/main/advanced_math"), "rom")
  ccunit.eq(fs.isReadOnly("rom/modules/main/advanced_math/pid.lua"), true)
  ccunit.eq(fs.attributes("rom/apis/matrix.lua").isDir, false)
  ccunit.eq(fs.attributes("rom/apis/matrix.lua").size, fs.getSize("rom/apis/matrix.lua"))
  ccunit.eq(fs.find("rom/modules/main/advanced_math/p*"), { "rom/modules/main/advanced_math/pid.lua" })
  ccunit.eq(fs.find("rom/*/matrix.*"), { "rom/apis/matrix.lua", "rom/help/matrix.txt" })
  ccunit.eq(fs.complete("rom/modules/main/adv", ""), { "anced_math/", "anced_math" })
  ccunit.truthy(help.lookup("quaternion"):find("quaternion"), "help")
  local h = fs.open("rom/apis/quaternion.lua", "r")
  ccunit.truthy(h.readLine():find("quaternion"), "reads")
  h.close()
  ccunit.eq(select(2, fs.open("rom/apis/quaternion.lua", "w")), "/rom/apis/quaternion.lua: Access denied")
  fs.copy("rom/apis/matrix.lua", "m.lua")
  ccunit.eq(fs.getSize("m.lua"), fs.getSize("rom/apis/matrix.lua"))
  ccunit.eq(type(require("advanced_math.stats").mean), "function")
  ccunit.eq(fs.exists("rom/ccsim"), false)
end)
`,
        { ...on, version: mc } as WorldConfig,
        `on-${mc}.test.lua`,
      );
      kit.expectAllPassed(result);
    });
  }

  it("is gone when the addon is off", async () => {
    const result = await kit.lua(
      `
ccunit.test("nothing", function()
  ccunit.eq(quaternion, nil)
  ccunit.eq(matrix, nil)
  ccunit.eq(fs.exists("rom/apis/quaternion.lua"), false)
  ccunit.eq(fs.exists("rom/modules/main/advanced_math"), false)
  ccunit.eq(help.lookup("matrix"), nil)
  ccunit.eq(pcall(require, "advanced_math.pid"), false)
end)
`,
      off,
      "off.test.lua",
    );
    kit.expectAllPassed(result);
  });
});
