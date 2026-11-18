import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADDONS,
  type ResolvedVersion,
  ensureRom,
  setRomBuilder,
  DEFAULT_MC,
  NEWEST_MC,
  VERSIONS,
  versionChoices,
  versionInfo,
  type RunnerConfig,
  addonReport,
  checkWorldAddons,
  engineVersionArgs,
  resolveAddons,
  resolveVersion,
  romDirFor,
  versionReport,
  worldJson,
} from "./index.js";

const config: RunnerConfig = {
  engineExe: "/engine/craftos",
  // the default version's ROM, as loadConfig picks it
  romDir: join("/repo/rom", versionInfo(DEFAULT_MC)!.romDir),
  romsDir: "/repo/rom",
  workspaceDir: "/ws",
  worldsDir: "/worlds",
  runtimeDir: "/runtime",
  luaLibDir: "/lua",
};
const noEnv: NodeJS.ProcessEnv = {};

describe("version selection", () => {
  it("defaults to DEFAULT_MC, with its ROM", () => {
    const v = resolveVersion(undefined, noEnv);
    expect(v).toMatchObject({
      mc: DEFAULT_MC,
      cc: versionInfo(DEFAULT_MC)!.cc,
    });
    expect(romDirFor(config, v)).toBe(config.romDir);
  });

  it("the public build defaults to the newest version", () => {
    expect(DEFAULT_MC).toBe(NEWEST_MC);
    expect(resolveVersion(undefined, noEnv)).toMatchObject({
      mc: "1.21.1",
      cc: "1.121.0",
      loader: "neoforge",
    });
  });

  it("1.18.2 is CC:Tweaked 1.101.3, the engine's own behaviour", () => {
    const v = resolveVersion("1.18.2", noEnv);
    expect(v).toMatchObject({ mc: "1.18.2", cc: "1.101.3", loader: "forge" });
    expect(engineVersionArgs(v)).toEqual([]);
    expect(romDirFor(config, v)).toBe(join("/repo/rom", "cc-1.101.3"));
  });

  it("takes world.version as a string or an object", () => {
    expect(resolveVersion("1.20.1", noEnv)).toMatchObject({
      mc: "1.20.1",
      cc: "1.121.0",
      loader: "forge",
    });
    expect(
      resolveVersion({ mc: "1.21.1", loader: "fabric" }, noEnv),
    ).toMatchObject({ mc: "1.21.1", cc: "1.121.0", loader: "fabric" });
    expect(resolveVersion("1.21.1", noEnv).loader).toBe("neoforge");
  });

  it("falls back to CRAFTOS_VERSION, and the world wins over it", () => {
    const env = { CRAFTOS_VERSION: "1.21.1" };
    expect(resolveVersion(undefined, env).mc).toBe("1.21.1");
    expect(resolveVersion("1.20.1", env).mc).toBe("1.20.1");
    expect(
      resolveVersion(undefined, { CRAFTOS_VERSION: '{"mc":"1.20.1"}' }).mc,
    ).toBe("1.20.1");
    expect(versionReport(env).default?.mc).toBe("1.21.1");
  });

  it("refuses unknown versions with the known ones", () => {
    expect(() => resolveVersion("1.12.2", noEnv)).toThrow(
      /unknown Minecraft version "1\.12\.2"; known: 1\.18\.2 \(CC:Tweaked 1\.101\.3\), 1\.20\.1/,
    );
    expect(() => resolveVersion(undefined, { CRAFTOS_VERSION: "2" })).toThrow(
      /CRAFTOS_VERSION: unknown Minecraft version/,
    );
    expect(() =>
      resolveVersion({ mc: "1.20.1", cc: "1.999.0" }, noEnv),
    ).toThrow(/unknown CC:Tweaked version "1\.999\.0"/);
    expect(() =>
      resolveVersion({ mc: "1.18.2", loader: "fabric" }, noEnv),
    ).toThrow(/no "fabric" build/);
    expect(versionReport({ CRAFTOS_VERSION: "nope" }).source).toMatch(
      /CRAFTOS_VERSION is invalid/,
    );
  });

  it("picks the ROM by CC:Tweaked version; CRAFTOS_ROM pins one ROM for all", () => {
    expect(romDirFor(config, resolveVersion("1.20.1", noEnv))).toBe(
      join("/repo/rom", "cc-1.121.0"),
    );
    expect(romDirFor(config, resolveVersion("1.21.1", noEnv))).toBe(
      join("/repo/rom", "cc-1.121.0"),
    );
    // CRAFTOS_ROM: loadConfig leaves romsDir unset
    const pinned = { ...config, romDir: "/one/rom", romsDir: undefined };
    expect(romDirFor(pinned, resolveVersion("1.21.1", noEnv))).toBe("/one/rom");
    expect(romDirFor(pinned, resolveVersion("1.18.2", noEnv))).toBe("/one/rom");
  });

  it("passes --cc-version to the engine for newer versions only", () => {
    expect(engineVersionArgs(resolveVersion("1.20.1", noEnv))).toEqual([
      "--cc-version",
      "1.121.0",
    ]);
    expect(engineVersionArgs(resolveVersion("1.18.2", noEnv))).toEqual([]);
  });

  it("writes the version into world.json for ccsim (core.version)", () => {
    const def = JSON.parse(worldJson(undefined));
    expect(def.version).toMatchObject({
      mc: DEFAULT_MC,
      cc: versionInfo(DEFAULT_MC)!.cc,
    });
    const old = JSON.parse(worldJson({ version: "1.18.2" }));
    expect(old.version).toMatchObject({ mc: "1.18.2", cc: "1.101.3" });
    const newer = JSON.parse(worldJson({ version: "1.20.1" }));
    expect(newer.version).toMatchObject({
      mc: "1.20.1",
      cc: "1.121.0",
      loader: "forge",
    });
  });
});

describe("addons per Minecraft version", () => {
  it("every addon has a release for a version the emulator runs, and only for those", () => {
    const known = ["1.18.2", "1.20.1", "1.21.1"];
    for (const a of ADDONS) {
      expect(Object.keys(a.versions).length, a.id).toBeGreaterThan(0);
      for (const mc of Object.keys(a.versions)) expect(known).toContain(mc);
    }
  });

  it("each version's default holds exactly the addons with a release for it", () => {
    for (const mc of ["1.18.2", "1.20.1", "1.21.1"]) {
      const want = ADDONS.filter((a) => a.versions[mc]).map((a) => a.id);
      expect([...resolveAddons(undefined, noEnv, mc)].sort(), mc).toEqual(
        [...want].sort(),
      );
    }
  });

  it("mods that only came out for newer Minecraft are left out of 1.18.2's default", () => {
    const ids = resolveAddons(undefined, noEnv, "1.18.2");
    expect(ids).toContain("some-peripherals");
    expect(ids).toContain("cccbridge");
    expect(ids).not.toContain("metaphysics");
    expect(ids).not.toContain("cloud-solutions");
    expect(ids).not.toContain("unlimited-peripheral-works");
    expect(ids).not.toContain("create-cc-logistics");
    expect(ids).not.toContain("cc-liftlink");
    expect(resolveAddons(undefined, noEnv, "1.20.1")).toContain("metaphysics");
    expect(ids).not.toContain("cc-androids");
    expect(ids).not.toContain("cc-drones");
    expect(resolveAddons(undefined, noEnv, "1.20.1")).toContain("cc-liftlink");
    expect(resolveAddons(undefined, noEnv, "1.20.1")).toContain("cc-drones");
  });

  it("refuses an addon with no release for the version", () => {
    expect(() => resolveAddons(["bigger-reactors"], noEnv, "1.21.1")).toThrow(
      /Bigger Reactors \(addon "bigger-reactors"\) has no release for Minecraft 1\.21\.1/,
    );
    expect(() =>
      resolveAddons(undefined, { CRAFTOS_ADDONS: "bigger-reactors" }, "1.21.1"),
    ).toThrow(/no release for Minecraft 1\.21\.1/);
    expect(resolveAddons(["bigger-reactors"], noEnv, "1.20.1")).toEqual([
      "bigger-reactors",
    ]);
  });

  it('"all" and the default leave out what the version lacks', () => {
    expect(resolveAddons(undefined, noEnv, "1.21.1")).not.toContain(
      "bigger-reactors",
    );
    expect(resolveAddons("all", noEnv, "1.21.1")).not.toContain(
      "bigger-reactors",
    );
    expect(resolveAddons(undefined, noEnv, "1.18.2")).toContain(
      "bigger-reactors",
    );
  });

  it("says which versions a missing mod has, and the three ways to pick one", () => {
    const world = {
      version: "1.21.1",
      peripherals: [{ name: "reactor", type: "BiggerReactors_Reactor" }],
    };
    let message = "";
    try {
      checkWorldAddons(
        world,
        resolveAddons(undefined, noEnv, "1.21.1"),
        "1.21.1",
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /^peripheral "reactor" \(BiggerReactors_Reactor\): /,
    );
    expect(message).toMatch(
      /it has 1\.18\.2 \(Bigger Reactors .*\), 1\.20\.1 \(Bigger Reactors /,
    );
    expect(message).toMatch(
      /world\.version "1\.20\.1", --mc 1\.20\.1 on the command line, or CRAFTOS_VERSION=1\.20\.1/,
    );
  });

  it("the default is a known version, and NEWEST_MC is the newest", () => {
    expect(VERSIONS.map((v) => v.mc)).toContain(DEFAULT_MC);
    expect(NEWEST_MC).toBe("1.21.1");
    expect(versionChoices()).toMatch(
      new RegExp(
        `^1\\.18\\.2 \\(CC:Tweaked 1\\.101\\.3\\), 1\\.20\\.1 or 1\\.21\\.1 \\(CC:Tweaked 1\\.121\\.0\\); default ${DEFAULT_MC.replace(/\./g, "\\.")}$`,
      ),
    );
  });

  it("a world using a missing mod's peripheral says the version lacks it", () => {
    const world = {
      peripherals: [{ name: "reactor", type: "BiggerReactors_Reactor" }],
    };
    expect(() =>
      checkWorldAddons(
        world,
        resolveAddons(undefined, noEnv, "1.21.1"),
        "1.21.1",
      ),
    ).toThrow(/has no release for Minecraft 1\.21\.1/);
    expect(() =>
      worldJson({ version: "1.21.1", addons: ["bigger-reactors"] }),
    ).toThrow(/no release for Minecraft 1\.21\.1/);
  });

  it("reports the mod version for the chosen Minecraft", () => {
    const report = addonReport(noEnv, "1.21.1");
    const br = report.addons.find((a) => a.id === "bigger-reactors")!;
    expect(br).toMatchObject({ version: "none", on: false });
    const ap = report.addons.find((a) => a.id === "advanced-peripherals")!;
    expect(ap.version).toBe("0.7.62b");
    expect(
      addonReport(noEnv, "1.18.2").addons.find(
        (a) => a.id === "advanced-peripherals",
      )!.version,
    ).toBe("0.7.31r");
  });
});

describe("a ROM built on demand (an installed package's ensureRom)", () => {
  const roms = mkdtempSync(join(tmpdir(), "roms-"));
  const config = {
    romDir: join(roms, versionInfo(DEFAULT_MC)!.romDir),
    romsDir: roms,
  } as RunnerConfig;
  const other = VERSIONS.find(
    (v) => v.romDir !== versionInfo(DEFAULT_MC)!.romDir,
  )!;

  it("asks the builder for a missing ROM, once it is there no more, and never without a builder", async () => {
    const asked: [string, ResolvedVersion][] = [];
    await ensureRom(config, other.mc); // no builder: nothing, startEngine says what is missing
    setRomBuilder(async (dir, version) => {
      asked.push([dir, version]);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "bios.lua"), "");
    });
    try {
      await ensureRom(config, other.mc);
      await ensureRom(config, other.mc);
      expect(asked).toHaveLength(1);
      expect(asked[0]![0]).toBe(join(roms, other.romDir));
      expect(asked[0]![1].mc).toBe(other.mc);
      // no world version: CRAFTOS_VERSION, else the default
      await ensureRom(config, undefined, { CRAFTOS_VERSION: other.mc });
      expect(asked).toHaveLength(1);
      await ensureRom(config, undefined, {});
      expect(asked.map(([d]) => d)).toEqual([
        join(roms, other.romDir),
        config.romDir,
      ]);
      // CRAFTOS_ROM (no romsDir) is the user's own ROM, and an unknown version is startEngine's to refuse
      await ensureRom({ romDir: join(roms, "mine") } as RunnerConfig, other.mc);
      await ensureRom(config, "9.9.9");
      expect(asked).toHaveLength(2);
    } finally {
      setRomBuilder(undefined);
      rmSync(roms, { recursive: true, force: true });
    }
  });
});
