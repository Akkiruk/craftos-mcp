/**
 * Peripheral types by Minecraft version (AddonInfo.byVersion, `byVersion` in types.lua) in a real computer, with a
 * made-up mod: a copy of the ROMs gets a test-only module, and the Advanced Math entry of ADDONS gets its types and
 * byVersion for this file only (no real mod's data is touched). Then: a world naming the old name or the new one gets
 * the version's name from getType, a type the version lacks is refused, and 1.18.2 is as before.
 *
 * The last test checks every real types.lua (and ap/types.lua) has the same byVersion as ADDONS.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADDONS,
  type AddonInfo,
  type AddonTypeChanges,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  checkWorld,
  loadConfig,
  runTests,
} from "./index.js";

const base = loadConfig();
const ready = checkConfig(base).length === 0;
const scratch = mkdtempSync(join(tmpdir(), "tv-"));
const workspace = join(scratch, "ws");
const roms = join(scratch, "rom");
const config = {
  ...base,
  workspaceDir: workspace,
  romDir: join(roms, "cc-1.101.3"),
  romsDir: roms,
};

const HOST = "advanced-math"; // an addon on every version with no peripherals of its own
const FIXTURE_TYPES = ["fixtureOld", "fixtureGone", "fixtureNew", "fixtureInv"];
const FIXTURE: Record<string, AddonTypeChanges> = {
  "1.21.1": {
    rename: { fixtureOld: "fixture_old", fixtureInv: "fixture_inv" },
    removed: ["fixtureGone"],
    added: ["fixtureNew"],
    note: { fixtureGone: "replaced by fixture_relay" },
  },
};

const TYPES_LUA = `return {
  addon = "${HOST}",
  types = { "fixtureOld", "fixtureGone", "fixtureNew", "fixtureInv" },
  byVersion = {
    ["1.21.1"] = {
      rename = { fixtureOld = "fixture_old", fixtureInv = "fixture_inv" },
      removed = { "fixtureGone" },
      added = { "fixtureNew" },
      note = { fixtureGone = "replaced by fixture_relay" },
    },
  },
}
`;
// what the module sees: def.type and def.reportedType; fixtureInv says it is an inventory too, as a mod's would
const INIT_LUA = `return function(core, host)
  return {
    peripheral = function(def)
      if def.broken then error("this fixture block is broken", 0) end
      local p = { methods = {
        defType = function() return def.type end,
        reportedType = function() return def.reportedType end,
      } }
      if def.type == "fixtureInv" then p.types = { "fixtureInv", "inventory" } end
      return p
    end,
  }
end
`;

let host: AddonInfo;
let saved: { types: readonly string[]; byVersion?: AddonInfo["byVersion"] };

beforeAll(() => {
  if (!ready) return;
  mkdirSync(workspace, { recursive: true });
  for (const dir of ["cc-1.101.3", "cc-1.121.0"]) {
    const rom = join(roms, dir);
    cpSync(join(base.romsDir ?? join(base.romDir, ".."), dir), rom, {
      recursive: true,
    });
    const module = join(rom, "rom", "ccsim", "addons", "zz-type-versions");
    mkdirSync(module, { recursive: true });
    writeFileSync(join(module, "types.lua"), TYPES_LUA);
    writeFileSync(join(module, "init.lua"), INIT_LUA);
    const list = join(rom, "rom", "ccsim", "addons", "modules.lua");
    const text = readFileSync(list, "utf8");
    writeFileSync(list, text.replace(/\}\s*$/, '  "zz-type-versions",\n}\n'));
    // programs do not see rom/ccsim (a real ROM has none): the files the Lua tests read are copied in as sim-<dir>/
    const sim = join(rom, "rom", "ccsim");
    const to = join(workspace, `sim-${dir}`);
    for (const file of ["typenames.lua", "ap/types.lua", "addons/modules.lua"])
      cpSync(join(sim, file), join(to, file));
    for (const entry of readdirSync(join(sim, "addons"), {
      withFileTypes: true,
    }))
      if (
        entry.isDirectory() &&
        existsSync(join(sim, "addons", entry.name, "types.lua"))
      )
        cpSync(
          join(sim, "addons", entry.name, "types.lua"),
          join(to, "addons", entry.name, "types.lua"),
        );
  }
  host = ADDONS.find((a) => a.id === HOST)!;
  saved = { types: host.types, byVersion: host.byVersion };
  Object.assign(host, {
    types: [...host.types, ...FIXTURE_TYPES],
    byVersion: { ...(host.byVersion ?? {}), ...FIXTURE },
  });
}, 120000);

afterAll(() => {
  if (host) Object.assign(host, saved);
  rmSync(scratch, { recursive: true, force: true });
});

const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
-- a rom/ccsim file, from the copy beforeAll put in the workspace
local SIM = "/sim-" .. (_HOST:find("Minecraft 1.18.2", 1, true) and "cc-1.101.3" or "cc-1.121.0") .. "/"
local function sim(path) return dofile((path:gsub("^/rom/ccsim/", SIM))) end
`;

let n = 0;
async function lua(source: string, world: WorldConfig): Promise<TestRunResult> {
  const name = `t${n++}.lua`;
  writeFileSync(join(workspace, name), PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 60000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const world = (
  version: string,
  peripherals: { name: string; type: string }[],
): WorldConfig =>
  ({ version, addons: [HOST], peripherals }) as unknown as WorldConfig;

describe.skipIf(!ready)("peripheral types by Minecraft version", () => {
  // not about versions, but this file has the test-only module: one block that fails to build used to stop all of
  // ccsim at boot, so the world came up with no peripherals and only a line on the screen said why
  it("a block that fails to build is left out, and the rest of the world still comes up", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("the rest is there", function()
  ccunit.eq(peripheral.isPresent("left"), false)
  ccunit.eq({ peripheral.getType("right") }, { "fixtureInv", "inventory" })
  ccunit.eq(peripheral.getType("top"), "fixtureOld")
end)
`,
        world("1.18.2", [
          { name: "left", type: "fixtureOld", broken: true } as unknown as {
            name: string;
            type: string;
          },
          { name: "right", type: "fixtureInv" },
          { name: "top", type: "fixtureOld" },
        ]),
      ),
    );
  });

  for (const given of ["fixtureOld", "fixture_old"])
    it(`1.21.1, the world says ${given}: the program sees fixture_old`, async () => {
      expectAllPassed(
        await lua(
          `
ccunit.test("renamed", function()
  ccunit.eq(peripheral.getType("left"), "fixture_old")
  ccunit.eq(peripheral.hasType("left", "fixture_old"), true)
  ccunit.eq(peripheral.hasType("left", "fixtureOld"), false)
  ccunit.eq(peripheral.find("fixtureOld"), nil)
  local p = peripheral.find("fixture_old")
  ccunit.truthy(p, "found by the version's name")
  ccunit.eq(peripheral.getName(p), "left")
  ccunit.eq(p.defType(), "fixtureOld")
  ccunit.eq(p.reportedType(), "fixture_old")
  -- the module's own types: the canonical one replaced, "inventory" kept
  ccunit.eq({ peripheral.getType("right") }, { "fixture_inv", "inventory" })
  ccunit.eq(peripheral.hasType("right", "inventory"), true)
  ccunit.eq(peripheral.getName(peripheral.find("fixture_inv")), "right")
  -- a type only 1.21.1 has
  ccunit.eq(peripheral.getType("top"), "fixtureNew")
end)
`,
          world("1.21.1", [
            { name: "left", type: given },
            { name: "right", type: "fixtureInv" },
            { name: "top", type: "fixtureNew" },
          ]),
        ),
      );
    });

  it("1.21.1 refuses a type the version removed, naming the version and the note", async () => {
    const w = world("1.21.1", [{ name: "left", type: "fixtureGone" }]);
    const check = checkWorld(w, {});
    expect(check.errors.join("\n")).toMatch(
      /peripheral "left" is a fixtureGone: .*has no fixtureGone on Minecraft 1\.21\.1 \(replaced by fixture_relay\)/,
    );
    await expect(lua("print('never')", w)).rejects.toThrow(
      /Minecraft 1\.21\.1 \(replaced by fixture_relay\)/,
    );
  });

  it("the Lua side refuses one too (ccsim/typenames.lua)", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("typenames", function()
  local info = sim("/rom/ccsim/addons/zz-type-versions/types.lua")
  local new = sim("/rom/ccsim/typenames.lua")("1.21.1", { info })
  local canonical, message = new.resolve("fixtureGone")
  ccunit.eq(canonical, nil)
  ccunit.eq(message, "${HOST} has no peripheral type 'fixtureGone' on Minecraft 1.21.1 (replaced by fixture_relay)")
  ccunit.eq({ new.resolve("fixture_old") }, { "fixtureOld", "fixture_old" })
  ccunit.eq({ new.resolve("fixtureOld") }, { "fixtureOld", "fixture_old" })
  ccunit.eq({ new.resolve("minecraft:chest") }, { "minecraft:chest", "minecraft:chest" })
  local old = sim("/rom/ccsim/typenames.lua")("1.18.2", { info })
  ccunit.eq({ old.resolve("fixtureGone") }, { "fixtureGone", "fixtureGone" })
  ccunit.eq({ old.resolve("fixture_old") }, { "fixtureOld", "fixtureOld" })
  ccunit.eq(select(2, old.resolve("fixtureNew")), "${HOST} has no peripheral type 'fixtureNew' on Minecraft 1.18.2")
end)
`,
        world("1.21.1", []),
      ),
    );
  });

  it("1.18.2 is as before: canonical names, the removed type there, the added one refused", async () => {
    expectAllPassed(
      await lua(
        `
ccunit.test("1.18.2", function()
  ccunit.eq(peripheral.getType("left"), "fixtureOld")
  ccunit.eq(peripheral.find("fixture_old"), nil)
  ccunit.eq(peripheral.getName(peripheral.find("fixtureOld")), "left")
  ccunit.eq(peripheral.getType("back"), "fixtureOld") -- named by the 1.21.1 name, still the block
  ccunit.eq(peripheral.getType("top"), "fixtureGone")
  ccunit.eq({ peripheral.getType("right") }, { "fixtureInv", "inventory" })
end)
`,
        world("1.18.2", [
          { name: "left", type: "fixtureOld" },
          { name: "back", type: "fixture_old" },
          { name: "top", type: "fixtureGone" },
          { name: "right", type: "fixtureInv" },
        ]),
      ),
    );
    expect(
      checkWorld(
        world("1.18.2", [{ name: "top", type: "fixtureNew" }]),
        {},
      ).errors.join("\n"),
    ).toMatch(
      /has no fixtureNew on Minecraft 1\.18\.2; it has one on 1\.21\.1/,
    );
  });

  // every byVersion the Lua side reads (each module's types.lua, ap/types.lua) is the one in ADDONS
  for (const mc of ["1.18.2", "1.21.1"])
    it(`types.lua and ADDONS agree on byVersion (${mc} ROM)`, async () => {
      type Changes = Record<string, unknown>;
      const norm = (c: AddonTypeChanges): Changes => {
        const out: Changes = {};
        if (c.rename && Object.keys(c.rename).length) out["rename"] = c.rename;
        for (const k of ["removed", "added"] as const)
          if (c[k]?.length) out[k] = [...c[k]!].sort();
        if (c.note && Object.keys(c.note).length) out["note"] = c.note;
        return out;
      };
      const expected: Record<string, Record<string, Changes>> = {};
      for (const a of ADDONS)
        for (const [v, c] of Object.entries(a.byVersion ?? {})) {
          const n = norm(c);
          if (Object.keys(n).length) (expected[a.id] ??= {})[v] = n;
        }
      expectAllPassed(
        await lua(
          `
ccunit.test("same byVersion", function()
  local infos = { sim("/rom/ccsim/ap/types.lua") }
  for _, module in ipairs(sim("/rom/ccsim/addons/modules.lua")) do
    infos[#infos + 1] = sim("/rom/ccsim/addons/" .. module .. "/types.lua")
  end
  local got = {}
  for id, by in pairs(sim("/rom/ccsim/typenames.lua")("${mc}", infos).byAddon) do
    for v, c in pairs(by) do
      local n = {}
      if next(c.rename) then n.rename = c.rename end
      for _, k in ipairs({ "removed", "added" }) do
        if #c[k] > 0 then table.sort(c[k]); n[k] = c[k] end
      end
      if next(c.note) then n.note = c.note end
      if next(n) then got[id] = got[id] or {}; got[id][v] = n end
    end
  end
  ccunit.eq(got, textutils.unserializeJSON(${JSON.stringify(JSON.stringify(expected))}))
end)
`,
          { version: mc, addons: "none" } as unknown as WorldConfig,
        ),
      );
    });
});
