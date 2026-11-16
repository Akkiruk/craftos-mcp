import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  resolveVersion,
  romDirFor,
  runTests,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "versions-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
// the 1.121.0 ROM: node scripts/build-rom.mjs --download 1.20.1
const newer = existsSync(
  join(romDirFor(config, resolveVersion("1.20.1", {})), "bios.lua"),
);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function runLua(
  lua: string,
  world: WorldConfig | undefined,
  name: string,
): Promise<TestRunResult> {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lua);
  return runTests(config, { paths: [name], world, timeoutMs: 20000 }, 1);
}

function failures(result: TestRunResult): string[] {
  expect(result.files.map((f) => f.status)).toHaveLength(1);
  return result.files.flatMap((f) =>
    f.status === "passed"
      ? []
      : [
          `${f.status}`,
          ...f.tests
            .filter((t) => !t.passed)
            .map((t) => `${t.name}: ${t.error}`),
        ],
  );
}

const worldVersionLua = `
local function worldVersion()
  local h = fs.open("/results/world.json", "r")
  local world = textutils.unserializeJSON(h.readAll())
  h.close()
  return world.version
end
`;

describe.skipIf(!ready)("the version reaches the engine", () => {
  it("1.18.2 by default: CC:Tweaked 1.101.3's _HOST and file handles", async () => {
    const result = await runLua(
      `${worldVersionLua}
ccunit.test("host", function() ccunit.truthy(_HOST:find("ComputerCraft 1.101.3 ", 1, true), _HOST) end)
ccunit.test("world.json", function() ccunit.eq(worldVersion().mc, "1.18.2") ccunit.eq(worldVersion().cc, "1.101.3") end)
ccunit.test("no w+ before 1.109", function() ccunit.raises(function() fs.open("x.txt", "w+") end, "Unsupported mode") end)
ccunit.test("directory read message", function()
  local h, err = fs.open("rom", "r") ccunit.eq(h, nil) ccunit.eq(err, "/rom: No such file")
end)
ccunit.test("1.101.3's private addresses", function()
  ccunit.eq(http.checkURL("http://10.1.2.3"), false)
  ccunit.eq(http.checkURL("http://[::1]"), false)
  ccunit.eq(http.checkURL("http://100.100.100.200"), false)
  ccunit.eq(http.checkURL("http://100.64.1.1"), true)
  ccunit.eq(http.checkURL("http://192.30.255.113"), true)
end)
ccunit.test("numbers written as Java doubles", function()
  local w = fs.open("n.txt", "w") w.write(65) w.close()
  local r = fs.open("n.txt", "r") ccunit.eq(r.readAll(), "65.0") r.close()
end)
ccunit.finish()
`,
      undefined,
      "default.test.lua",
    );
    expect(failures(result)).toEqual([]);
  });

  it.skipIf(!newer)(
    "1.20.1: CC:Tweaked 1.121.0's _HOST, r+/w+ handles and messages",
    async () => {
      const result = await runLua(
        `${worldVersionLua}
ccunit.test("host", function() ccunit.truthy(_HOST:find("ComputerCraft 1.121.0 ", 1, true), _HOST) end)
ccunit.test("world.json", function()
  local v = worldVersion() ccunit.eq(v.mc, "1.20.1") ccunit.eq(v.cc, "1.121.0") ccunit.eq(v.loader, "forge")
end)
ccunit.test("w+ reads back what it wrote", function()
  local h = fs.open("x.txt", "w+") h.write("hello") h.seek("set", 0) ccunit.eq(h.readAll(), "hello") h.close()
end)
ccunit.test("directory read message", function()
  local h, err = fs.open("rom", "r") ccunit.eq(h, nil) ccunit.eq(err, "/rom: Not a file")
end)
ccunit.test("numbers written as Lua prints them", function()
  local w = fs.open("n.txt", "w") w.write(65) w.close()
  local r = fs.open("n.txt", "r") ccunit.eq(r.readAll(), "65") ccunit.eq(r.readAll(), "") r.close()
end)
ccunit.test("raw bytes in text mode", function()
  local w = fs.open("b.txt", "wb") w.write("\\225lo") w.close()
  local r = fs.open("b.txt", "r") ccunit.eq(r.readAll(), "\\225lo") r.close()
end)
ccunit.test("queueEvent copies tables", function()
  local t = {} os.queueEvent("copy_me", t) local _, u = os.pullEvent("copy_me") ccunit.truthy(u ~= t)
end)
ccunit.test("fs.getDir of ..", function() ccunit.eq(fs.getDir(".."), "../..") end)
ccunit.test("1.121.0's private addresses", function()
  ccunit.eq(http.checkURL("http://100.64.1.1"), false)
  ccunit.eq(http.checkURL("http://[fc00::1]"), false)
  ccunit.eq(http.checkURL("http://192.30.255.113"), true)
end)
ccunit.finish()
`,
        { version: "1.20.1" },
        "newer.test.lua",
      );
      expect(failures(result)).toEqual([]);
    },
  );

  it.skipIf(!newer)("1.21.1 shares the 1.121.0 ROM, on NeoForge", async () => {
    const result = await runLua(
      `${worldVersionLua}
ccunit.test("host", function() ccunit.truthy(_HOST:find("ComputerCraft 1.121.0 ", 1, true), _HOST) end)
ccunit.test("world.json", function() ccunit.eq(worldVersion().mc, "1.21.1") ccunit.eq(worldVersion().loader, "neoforge") end)
ccunit.finish()
`,
      { version: "1.21.1" },
      "neoforge.test.lua",
    );
    expect(failures(result)).toEqual([]);
  });

  it("refuses an addon the version lacks before booting", async () => {
    await expect(
      runLua(
        `ccunit.finish()`,
        { version: "1.21.1", addons: ["bigger-reactors"] },
        "refused.test.lua",
      ),
    ).rejects.toThrow(/Bigger Reactors .*no release for Minecraft 1\.21\.1/);
  });
});
