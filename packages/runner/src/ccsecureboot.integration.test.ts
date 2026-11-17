import { describe, expect, it } from "vitest";
import { addonTestKit } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * CCSecureBoot 1.0.2 (docs/ccsecureboot.md), from the mod's source at tag 1.0.2. The mod's own Lua (enroll-secure-
 * boot, pxboot, sign, unenroll-secure-boot) runs unchanged against the emulated server side. Not measured in game.
 */
const kit = addonTestKit("sb");

const world = {
  version: "1.20.1",
  addons: ["ccsecureboot"],
  peripherals: [{ name: "left", type: "drive" }],
} as unknown as WorldConfig;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!kit.ready)("CCSecureBoot", () => {
  it("the API is a module; the certs mount; nothing is enrolled", async () => {
    const result = await kit.lua(
      `
ccunit.test("module", function()
  local sb = require("secureboot")
  ccunit.eq(type(sb.enroll), "function")
  ccunit.eq(type(sb.unenroll), "function")
  ccunit.eq(secureboot, nil) -- no global: getNames() is empty
  ccunit.eq(fs.exists("rom/pxboot/certs/root.pem"), true)
  ccunit.eq(fs.exists("rom/pxboot/certs/revoked.crl"), true)
  ccunit.eq(fs.isReadOnly("rom/pxboot/certs/root.pem"), true)
  ccunit.eq(fs.exists("rom/pxboot/certs/enrolled/" .. os.getComputerID()), false)
  ccunit.eq(fs.exists("rom/programs/enroll-secure-boot.lua"), true)
  ccunit.eq({ sb.unenroll("x", "y") }, { true }) -- not enrolled: true, as the Java does
  ccunit.eq(select(2, pcall(sb.enroll, "junk")):find("^Could not sign certificate: ") ~= nil, true)
end)
`,
      world,
      "module.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("enroll with a key disk, reboot into pxboot, unenroll", async () => {
    await kit.withSession(world, async (step, s) => {
      s.typeLine("enroll-secure-boot");
      await s.waitForText("Do you wish to continue?");
      s.typeLine("y");
      await s.waitForText("Enter your name:");
      s.typeLine("Alex");
      await s.waitForText("Enter a password");
      s.typeLine("");
      await s.waitForText("Please insert a floppy disk");
      await step({ cmd: "insertDisk", peripheral: "left", disk: 3 });
      await s.waitForText("successfully been enrolled", 60000);
      expect(
        (s.state() as { addons?: Record<string, unknown> }).addons?.[
          "ccsecureboot"
        ],
      ).toEqual({
        enrolled: true,
        revoked: 0,
      });
      // a reboot: the autorun file hands the computer to pxboot, which offers the disk's signed rescue shell
      await s.send({ cmd: "reboot" }, 300);
      await pause(1500);
      await s.waitForText("Rescue shell", 30000);
      expect(s.screen()).toContain("startup.lua");
      // the rescue shell: the key disk's own signed startup
      s.tap("down");
      await pause(300);
      s.tap("enter");
      await s.waitForText("CraftOS", 20000);
      // an unsigned startup.lua is refused
      s.typeLine(`edit_x = nil`); // a harmless line first: the prompt is up
      await pause(300);
      s.typeLine(`lua`);
      await s.waitForText("lua>");
      s.typeLine(
        'local h = fs.open("startup.lua", "w") h.write("print(\\"hello signed\\") sleep(5)") h.close() exit()',
      );
      await pause(500);
      await s.send({ cmd: "reboot" }, 300);
      await pause(1500);
      await s.waitForText("Rescue shell", 30000);
      s.tap("enter");
      await s.waitForText("Could not find signature", 20000);
      expect(s.screen()).not.toContain("hello signed");
      // sign it with the key disk, and it runs
      await s.send({ cmd: "reboot" }, 300);
      await pause(1500);
      await s.waitForText("Rescue shell", 30000);
      s.tap("down");
      await pause(300);
      s.tap("enter");
      await s.waitForText("CraftOS", 20000);
      s.typeLine("sign startup.lua");
      await pause(4000);
      await s.send({ cmd: "reboot" }, 300);
      await pause(1500);
      await s.waitForText("Rescue shell", 30000);
      const ran = s.waitForText("hello signed", 20000);
      s.tap("enter");
      await ran;
      // unenroll from the rescue shell: the key disk's key signs this computer's id
      await s.send({ cmd: "reboot" }, 300);
      await pause(1500);
      await s.waitForText("Rescue shell", 30000);
      s.tap("down");
      await pause(300);
      s.tap("enter");
      await s.waitForText("CraftOS", 20000);
      s.typeLine("unenroll-secure-boot");
      await s.waitForText("Are you sure", 20000);
      s.typeLine("y");
      await s.waitForText("Successfully unenrolled", 60000);
      expect(
        (s.state() as { addons?: Record<string, unknown> }).addons?.[
          "ccsecureboot"
        ],
      ).toEqual({ enrolled: false, revoked: 1 });
    });
  });
});
