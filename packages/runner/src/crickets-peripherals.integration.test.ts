import { describe, expect, it } from "vitest";
import { addonTestKit, peripheralState } from "./addon-test-kit.js";
import type { WorldConfig } from "./index.js";

/**
 * Cricket's Peripherals 0.1.1 (docs/crickets-peripherals.md), from the mod's source at tag 0.1.1. The data
 * coprocessor's expected bytes come from Java 21 (java.util.zip.Deflater, javax.crypto) running the mod's own code.
 * Not measured in game.
 */
const kit = addonTestKit("cp");

const world = {
  version: "1.21.1",
  addons: ["crickets-peripherals"],
  peripherals: [
    { name: "dc", type: "data_coprocessor" },
    { name: "left", type: "hard_drive", files: { "a.txt": "first" } },
  ],
} as unknown as WorldConfig;

// The text Java deflated: a 31-bit LCG, mostly copies from up to `reach` bytes back, else letters of `alpha`
const LCG = `
local function gen(seed, n, alpha, reach)
  local x = seed
  local function nextr()
    local hi, lo = math.floor(x / 65536), x % 65536
    x = ((hi * 1103515245 % 2147483648) * 65536 + lo * 1103515245 + 12345) % 2147483648
    return math.floor(x / 256)
  end
  local b = {}
  for i = 0, n - 1 do
    local r = nextr()
    if i > 20 and r % 10 < 7 then b[i + 1] = b[i - nextr() % math.min(i, reach)] else b[i + 1] = (97 + nextr() % alpha) % 256 end
  end
  local parts = {}
  for i = 1, n, 4096 do parts[#parts + 1] = string.char(table.unpack(b, i, math.min(i + 4095, n))) end
  return table.concat(parts)
end
local function hex(s) return (s:gsub(".", function(c) return ("%02x"):format(c:byte()) end)) end
`;

describe.skipIf(!kit.ready)("Cricket's Peripherals", () => {
  it("deflate matches the JDK byte for byte across window slides and block splits", async () => {
    const result = await kit.lua(
      LCG +
        `
local cp = peripheral.wrap("dc")
for _, c in ipairs({
  { 2, 90000, 8, 30000, 39564, "4108e9c1d913e3f7f062599826df92b291036af373ff98eb4e3d4178b1875ba3" },
  { 3, 50000, 200, 5, 38721, "5a6427b8989b03c64588261cc17ece61ca39854cf7be2a61f5e9dffc776ee063" },
}) do
  ccunit.test("case " .. c[1], function()
    local input = gen(c[1], c[2], c[3], c[4])
    local z = cp.deflate(input)
    ccunit.eq(#z, c[5])
    ccunit.eq(hex(cp.sha256(z)), c[6])
    ccunit.eq(cp.inflate(z) == input, true)
  end)
end
`,
      world,
      "deflate.test.lua",
      120000,
    );
    kit.expectAllPassed(result);
  }, 120000);

  it("the drive's files outlive a reboot, mounted at hdd again", async () => {
    await kit.withSession(world, async (step, s) => {
      expect(peripheralState(s.state(), "left")).toEqual({
        mountId: 0,
        mountPath: "hdd",
      });
      s.typeLine("copy hdd/a.txt hdd/kept.txt");
      await new Promise((r) => setTimeout(r, 500));
      await s.send({ cmd: "reboot" }, 300); // the computer restarts before it can answer
      await new Promise((r) => setTimeout(r, 1500));
      s.typeLine("ls hdd");
      await s.waitForText("kept.txt");
      expect(peripheralState(s.state(), "left")).toEqual({
        mountId: 0,
        mountPath: "hdd",
      });
    });
  }, 120000);

  it("the drive's files, capacity (hddSize) and drive name", async () => {
    const write = await kit.lua(
      `
ccunit.test("write", function()
  ccunit.eq(fs.open("hdd/a.txt", "r").readAll(), "first")
  local h = fs.open("hdd/b.txt", "w") h.write("second") h.close()
  ccunit.eq(fs.getCapacity("hdd"), 4096)
  ccunit.eq(fs.getFreeSpace("hdd"), 4096 - 11)
  ccunit.eq(fs.getDrive("hdd/b.txt"), "left")
  ccunit.eq(fs.isReadOnly("hdd"), false)
end)
`,
      { ...world, cricketsPeripherals: { hddSize: 4096 } } as WorldConfig,
      "write.test.lua",
    );
    kit.expectAllPassed(write);
  }, 120000);

  it("is a 1.21.1 mod and an addon that can be off", async () => {
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, addons: "none" } as WorldConfig,
        "off.test.lua",
      ),
    ).rejects.toThrow(
      /data_coprocessor from Cricket's Peripherals \(addon "crickets-peripherals"\)/,
    );
    await expect(
      kit.lua(
        `ccunit.test("x", function() end)`,
        { ...world, version: "1.20.1" } as WorldConfig,
        "old.test.lua",
      ),
    ).rejects.toThrow(/no release for Minecraft 1\.20\.1/);
  });
});
