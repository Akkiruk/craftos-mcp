// Messages about the mods (addons.ts): they name where the mods were picked and suggest the id that was meant, and
// each addon says which release the emulator acts as.
import { describe, expect, it } from "vitest";
import {
  ADDONS,
  addonReport,
  checkWorldAddons,
  resolveAddons,
} from "./addons.js";
import { checkProject, projectEnv } from "./project.js";

const fromProject = (file: string, addons: string | string[]) =>
  projectEnv({ file, dir: ".", data: { addons } }, {});

const error = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
};

describe("addon messages", () => {
  it("suggest the nearest id for a typo", () => {
    expect(error(() => resolveAddons(["mekansim"], {}))).toMatch(
      /unknown addon "mekansim" in world\.addons\. Did you mean "mekanism"\?/,
    );
    expect(
      error(() => resolveAddons(["advanced-peripheral", "createe"], {})),
    ).toMatch(
      /"advanced-peripheral": did you mean "advanced-peripherals"\?.*"createe": did you mean "create"\?/,
    );
    // a slip too long for an edit distance still starts like the id
    expect(error(() => resolveAddons(["advanced-perifs"], {}))).toMatch(
      /Did you mean "advanced-peripherals"\?/,
    );
  });

  it("name craftos.json when the mods came from it, not CRAFTOS_ADDONS", () => {
    const env = fromProject("C:/proj/craftos.json", ["create-additions"]);
    expect(env["CRAFTOS_ADDONS"]).toBe("create-additions");
    const needs = error(() => resolveAddons(undefined, env, "1.18.2"));
    expect(needs).toMatch(/addon create-additions needs create/);
    expect(needs).toContain('"addons" in C:/proj/craftos.json');
    expect(needs).not.toContain("CRAFTOS_ADDONS");

    const off = error(() =>
      checkWorldAddons(
        { peripherals: [{ name: "m", type: "inductionPort" }] },
        resolveAddons(undefined, fromProject("C:/p/craftos.json", "create")),
        "1.18.2",
        '"addons" in C:/p/craftos.json',
      ),
    );
    expect(off).toMatch(/which is switched off/);
    expect(off).toContain('The mods come from "addons" in C:/p/craftos.json');
    expect(off).not.toContain("CRAFTOS_ADDONS");

    const typo = error(() =>
      resolveAddons(undefined, fromProject("C:/p/craftos.json", "mekanizm")),
    );
    expect(typo).toMatch(/in "addons" in C:\/p\/craftos\.json/);
  });

  it("name world.addons or CRAFTOS_ADDONS when the mods came from there", () => {
    expect(
      error(() => resolveAddons(undefined, { CRAFTOS_ADDONS: "createe" })),
    ).toMatch(/unknown addon "createe" in CRAFTOS_ADDONS/);
    expect(error(() => resolveAddons(["create-additions"], {}))).toMatch(
      /add create to world\.addons too/,
    );
    expect(
      error(() =>
        resolveAddons(undefined, { CRAFTOS_ADDONS: "create-additions" }),
      ),
    ).toMatch(/add create to CRAFTOS_ADDONS too/);
  });

  it('craftos.json: "addon" asks whether "addons" was meant, and a bad id names craftos.json', () => {
    const errors = checkProject({ addon: ["create"] }).join("\n");
    expect(errors).toMatch(/unknown key "addon" \(did you mean "addons"\?\)/);
    expect(checkProject({ addons: ["mekansim"] }).join("\n")).toMatch(
      /addons: unknown addon "mekansim" in craftos\.json\. Did you mean "mekanism"\?/,
    );
  });

  it("say which release a mod written from its 1.18.2 one acts as on newer versions", () => {
    const report = addonReport({}, "1.21.1");
    const ap = report.addons.find((a) => a.id === "advanced-peripherals")!;
    expect(ap).toMatchObject({ version: "0.7.62b", actsAs: "0.7.31r" });
    const create = report.addons.find((a) => a.id === "create")!;
    expect(create).toMatchObject({ version: "6.0.10", actsAs: "0.5.1.i" });
    // a mod that follows the version's own release acts as it
    const embedded = report.addons.find((a) => a.id === "embedded-computer")!;
    expect(embedded).toMatchObject({ version: "1.3.0", actsAs: "1.3.0" });
    // and on 1.18.2 every mod is the release it acts as
    for (const a of addonReport({}, "1.18.2").addons)
      if (a.version !== "none") expect(a.actsAs, a.id).toBe(a.version);
    // simulates is only ever a 1.18.2 release the addon lists
    for (const a of ADDONS)
      if (a.simulates)
        expect(a.versions["1.18.2"]?.split(" ")[0], a.id).toBe(a.simulates);
  });
});

describe("an opt-in addon (vhcctweaks)", () => {
  it('is never part of "all" or the default, only named', () => {
    expect(resolveAddons(undefined, {}, "1.18.2")).not.toContain("vhcctweaks");
    expect(resolveAddons("all", {}, "1.18.2")).not.toContain("vhcctweaks");
    expect(resolveAddons(["vhcctweaks"], {}, "1.18.2")).toEqual(["vhcctweaks"]);
    const both = resolveAddons("all,vhcctweaks", {}, "1.18.2");
    expect(both).toContain("vhcctweaks");
    expect(both).toContain("advanced-peripherals");
    expect(
      resolveAddons(
        undefined,
        { CRAFTOS_ADDONS: "mekanism,vhcctweaks" },
        "1.18.2",
      ),
    ).toEqual(["mekanism", "vhcctweaks"]);
  });

  it("only exists on 1.18.2", () => {
    expect(error(() => resolveAddons(["vhcctweaks"], {}, "1.21.1"))).toMatch(
      /vhcctweaks \(addon "vhcctweaks"\) has no release for Minecraft 1\.21\.1/,
    );
    expect(resolveAddons("all", {}, "1.21.1")).not.toContain("vhcctweaks");
  });
});
