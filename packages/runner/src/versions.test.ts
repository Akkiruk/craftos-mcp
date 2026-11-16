import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADDONS,
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
  romDir: "/repo/rom/cc-1.101.3",
  romsDir: "/repo/rom",
  workspaceDir: "/ws",
  worldsDir: "/worlds",
  runtimeDir: "/runtime",
  luaLibDir: "/lua",
};
const noEnv: NodeJS.ProcessEnv = {};

describe("version selection", () => {
  it("defaults to Minecraft 1.18.2 / CC:Tweaked 1.101.3", () => {
    const v = resolveVersion(undefined, noEnv);
    expect(v).toMatchObject({ mc: "1.18.2", cc: "1.101.3", loader: "forge" });
    expect(engineVersionArgs(v)).toEqual([]);
    expect(romDirFor(config, v)).toBe(config.romDir);
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
    const pinned = { ...config, romsDir: undefined };
    expect(romDirFor(pinned, resolveVersion("1.21.1", noEnv))).toBe(
      config.romDir,
    );
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
    expect(def.version).toMatchObject({ mc: "1.18.2", cc: "1.101.3" });
    const newer = JSON.parse(worldJson({ version: "1.20.1" }));
    expect(newer.version).toMatchObject({
      mc: "1.20.1",
      cc: "1.121.0",
      loader: "forge",
    });
  });
});

describe("addons per Minecraft version", () => {
  it("every addon has a 1.18.2 version", () => {
    for (const a of ADDONS) expect(a.versions["1.18.2"]).toBeTruthy();
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
    expect(resolveAddons(undefined, noEnv)).toContain("bigger-reactors");
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
      addonReport(noEnv).addons.find((a) => a.id === "advanced-peripherals")!
        .version,
    ).toBe("0.7.31r");
  });
});
