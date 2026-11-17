import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * Embedded Computer 0.6.0 / 1.3.0 (docs/embedded-computer.md), from the mod's source at tags v0.6.0 and v1.3.0. The
 * hashes were checked against Guava 32.1.2 (what HashUtil calls). Not measured in game.
 */
const kit = addonTestKit("ec");

// Guava: sha256 of "pw", then 3 more sha256, then 3 sha512 (HashUtil, EmbeddedComputerPeripheral.unlockHashed)
const CHAIN_PW =
  "c18d0f015907e2d709051d15b72e79b1e507d949e74c6a9de362d1ac18a7267474eed73d3194c029c8b5c6c0907abf6dd0bbb50018dd0b3f87e6b60a5a84ac49";

describe.skipIf(!kit.ready)("Embedded Computer", () => {
  it("an embedded computer: both APIs, a 10x3 screen, security.lock writes the hash chain the peripheral checks", async () => {
    const result = await kit.lua(
      `
ccunit.test("apis", function()
  ccunit.eq({ term.getSize() }, { 10, 3 })
  ccunit.eq(type(embedded.format), "function")
  ccunit.eq(embedded.setPassword, security.lock) -- the autorun file's alias
  security.lock("pw")
  local h = fs.open("/.LOCKED_HASHED", "r")
  ccunit.eq(h.readAll(), "${CHAIN_PW}")
  h.close()
  ccunit.eq(security.hashStrMurmur3("The quick brown fox jumps over the lazy dog"), "6c1b07bc7bbc4be347939ac4a93c437a")
  ccunit.eq(security.hashStrSipHash24(""), "310e0edd47db6f72")
  ccunit.eq(security.hashStrAdler32(""), "01000000")
  ccunit.eq(security.hashStrMurmur3("0123456789abcdef0123456789abcdef!"), "3503929145dd631d6d5858a82a70fcb3")
  ccunit.eq(security.hashStrSHA512(""), "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e")
end)
`,
      {
        version: "1.21.1",
        addons: ["embedded-computer"],
        embeddedComputer: { kind: "embedded" },
      } as unknown as WorldConfig,
      "embedded.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("unlockHashed takes the same chain off another computer; format then works", async () => {
    const world = {
      version: "1.20.1",
      addons: ["embedded-computer"],
      peripherals: [
        {
          name: "left",
          type: "embeddedcomputer",
          id: 4,
          files: { ".LOCKED_HASHED": CHAIN_PW + "\n", "startup.lua": "x" },
        },
      ],
    } as unknown as WorldConfig;
    const result = await kit.lua(
      `
ccunit.test("unlock", function()
  local k = peripheral.wrap("left")
  ccunit.eq(k.format(), false)
  k.unlockHashed("pw", "SHA256") -- the hash type is matched ignoring case
  ccunit.eq(k.format(), true)
end)
`,
      world,
      "unlock.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("no world key: a plain computer, no APIs; the ROM files are there", async () => {
    const result = await kit.lua(
      `
ccunit.test("plain", function()
  ccunit.eq(security, nil)
  ccunit.eq(embedded, nil)
  ccunit.eq(fs.exists("rom/autorun/embedded.lua"), true)
  ccunit.eq(fs.exists("rom/apis/secure/security.lua"), true)
end)
`,
      {
        version: "1.20.1",
        addons: ["embedded-computer"],
      } as unknown as WorldConfig,
      "plain.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("1.3.0's harddrive mounts a nil path at drive", async () => {
    const result = await kit.lua(
      `
ccunit.test("nil path", function()
  local d = peripheral.wrap("right")
  ccunit.eq(d.mount(), true)
  ccunit.eq(fs.getDrive("drive"), "right")
  ccunit.eq(d.unmount(), true)
end)
`,
      {
        version: "1.21.1",
        addons: ["embedded-computer"],
        peripherals: [{ name: "right", type: "harddrive" }],
      } as unknown as WorldConfig,
      "nilpath.test.lua",
    );
    kit.expectAllPassed(result);
  });

  it("has no 1.18.2 release and can be off", async () => {
    const w = {
      addons: ["embedded-computer"],
      peripherals: [{ name: "right", type: "harddrive" }],
    } as unknown as WorldConfig;
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...w, version: "1.18.2" } as WorldConfig,
        "old.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.18\.2/);
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...w, version: "1.20.1", addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(/harddrive from Embedded Computer/);
  });
});
