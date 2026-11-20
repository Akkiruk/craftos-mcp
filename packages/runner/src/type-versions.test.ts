// Peripheral types by Minecraft version (AddonInfo.byVersion): the mapping functions in addons.ts, on a made-up
// addon list, so no real mod's data is needed. type-versions.integration.test.ts runs the same in a computer.
import { describe, expect, it } from "vitest";
import {
  ADDONS,
  type AddonInfo,
  addonOfType,
  addonTypeNames,
  addonTypesOn,
  canonicalTypeOf,
  checkWorldAddons,
  ownersOfType,
  reportedTypeName,
  reportedTypeOf,
  typeAbsence,
  typeExistsOn,
  versionTypeNotes,
} from "./addons.js";

const MOD: AddonInfo = {
  id: "fake-mod",
  name: "Fake Mod",
  versions: { "1.18.2": "1.0", "1.20.1": "2.0", "1.21.1": "3.0" },
  types: ["oldName", "gone", "fresh", "plain"],
  byVersion: {
    "1.21.1": {
      rename: { oldName: "old_name" },
      removed: ["gone"],
      added: ["fresh"],
      note: { gone: "replaced by CC:Tweaked's redstone_relay" },
    },
    "1.20.1": { added: ["fresh"] },
  },
};
const PLAIN: AddonInfo = {
  id: "plain-mod",
  name: "Plain Mod",
  versions: { "1.18.2": "1", "1.21.1": "1" },
  types: ["block"],
};
const LIST = [MOD, PLAIN];

const error = (run: () => unknown): string => {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
};

describe("byVersion: one type's names", () => {
  it("either name leads to the canonical one", () => {
    expect(canonicalTypeOf(MOD, "oldName")).toBe("oldName");
    expect(canonicalTypeOf(MOD, "old_name")).toBe("oldName");
    expect(canonicalTypeOf(MOD, "nope")).toBeUndefined();
    expect(canonicalTypeOf(PLAIN, "old_name")).toBeUndefined();
  });

  it("the version's name is reported, the canonical one elsewhere", () => {
    expect(reportedTypeOf(MOD, "oldName", "1.21.1")).toBe("old_name");
    expect(reportedTypeOf(MOD, "oldName", "1.18.2")).toBe("oldName");
    expect(reportedTypeOf(MOD, "oldName", "1.20.1")).toBe("oldName");
    expect(reportedTypeOf(MOD, "plain", "1.21.1")).toBe("plain");
  });

  it("removed: gone on its version only; added: there on its versions only", () => {
    expect(typeExistsOn(MOD, "gone", "1.21.1")).toBe(false);
    expect(typeExistsOn(MOD, "gone", "1.18.2")).toBe(true);
    expect(typeExistsOn(MOD, "fresh", "1.18.2")).toBe(false);
    expect(typeExistsOn(MOD, "fresh", "1.20.1")).toBe(true);
    expect(typeExistsOn(MOD, "fresh", "1.21.1")).toBe(true);
    expect(typeExistsOn(PLAIN, "block", "1.21.1")).toBe(true);
  });

  it("the absence message names the version, the note and where it is", () => {
    expect(typeAbsence(MOD, "gone", "1.21.1")).toBe(
      "Fake Mod 3.0 has no gone on Minecraft 1.21.1 (replaced by CC:Tweaked's redstone_relay); it has one on 1.18.2 as gone, 1.20.1 as gone",
    );
    expect(typeAbsence(MOD, "fresh", "1.18.2")).toBe(
      "Fake Mod 1.0 has no fresh on Minecraft 1.18.2; it has one on 1.20.1 as fresh, 1.21.1 as fresh",
    );
    expect(typeAbsence(MOD, "oldName", "1.21.1")).toBeUndefined();
  });

  it("names, types on a version, owners", () => {
    expect(addonTypeNames(MOD)).toEqual([
      "oldName",
      "gone",
      "fresh",
      "plain",
      "old_name",
    ]);
    expect(addonTypesOn(MOD, "1.21.1")).toEqual(["old_name", "fresh", "plain"]);
    expect(addonTypesOn(MOD, "1.18.2")).toEqual(["oldName", "gone", "plain"]);
    expect(ownersOfType("old_name", LIST)).toEqual([
      { addon: MOD, canonical: "oldName" },
    ]);
    expect(addonOfType("old_name", LIST)).toBe(MOD);
    expect(addonOfType("block", LIST)).toBe(PLAIN);
    expect(addonOfType("nope", LIST)).toBeUndefined();
  });

  it("CC's network name follows the version's name", () => {
    expect(reportedTypeName("oldName", "1.21.1", LIST)).toBe("old_name");
    expect(reportedTypeName("old_name", "1.18.2", LIST)).toBe("oldName");
    expect(reportedTypeName("minecraft:chest", "1.21.1", LIST)).toBe(
      "minecraft:chest",
    );
  });

  it("the tool description line, empty with no byVersion", () => {
    expect(versionTypeNotes(LIST)).toBe(
      "Types by Minecraft version (a world may use either name; getType reports the version's): Fake Mod: oldName is old_name on 1.21.1, gone is not on 1.21.1, fresh only on 1.21.1, fresh only on 1.20.1.",
    );
    expect(versionTypeNotes([PLAIN])).toBe("");
  });
});

describe("byVersion: world checks", () => {
  const world = (type: string) => ({ peripherals: [{ name: "p", type }] });
  const check = (type: string, mc: string, on = ["fake-mod"]) =>
    checkWorldAddons(world(type), on, mc, undefined, LIST);

  it("either name of a renamed type is a fine world", () => {
    for (const mc of ["1.18.2", "1.20.1", "1.21.1"]) {
      expect(() => check("oldName", mc)).not.toThrow();
      expect(() => check("old_name", mc)).not.toThrow();
    }
  });

  it("a removed type is refused on its version, naming it and the note", () => {
    const message = error(() => check("gone", "1.21.1"));
    expect(message).toContain('peripheral "p" is a gone');
    expect(message).toContain("Minecraft 1.21.1");
    expect(message).toContain("replaced by CC:Tweaked's redstone_relay");
    expect(() => check("gone", "1.18.2")).not.toThrow();
  });

  it("an added type is refused on the versions without it", () => {
    expect(error(() => check("fresh", "1.18.2"))).toMatch(
      /Fake Mod 1\.0 has no fresh on Minecraft 1\.18\.2/,
    );
    expect(() => check("fresh", "1.20.1")).not.toThrow();
  });

  it("an addon that is off still says so first, by either name", () => {
    expect(error(() => check("old_name", "1.21.1", []))).toMatch(
      /is a old_name from Fake Mod \(addon "fake-mod"\).*switched off/,
    );
  });

  it("an addon with no byVersion is as before", () => {
    expect(() =>
      checkWorldAddons(
        world("block"),
        ["plain-mod"],
        "1.21.1",
        undefined,
        LIST,
      ),
    ).not.toThrow();
    expect(
      error(() =>
        checkWorldAddons(world("block"), [], "1.21.1", undefined, LIST),
      ),
    ).toMatch(/switched off/);
  });
});

describe("byVersion: the real list", () => {
  it("every byVersion names canonical types, and added ones are in types", () => {
    for (const a of ADDONS) {
      for (const [mc, changes] of Object.entries(a.byVersion ?? {})) {
        const at = `${a.id} ${mc}`;
        expect(Object.keys(a.versions), at).toContain(mc);
        for (const t of [
          ...Object.keys(changes.rename ?? {}),
          ...(changes.removed ?? []),
          ...(changes.added ?? []),
          ...Object.keys(changes.note ?? {}),
        ])
          expect(a.types, `${at}: ${t}`).toContain(t);
        // a renamed name must not be some other type's canonical name in the same mod
        for (const renamed of Object.values(changes.rename ?? {}))
          expect(a.types, `${at}: ${renamed}`).not.toContain(renamed);
      }
    }
  });
});
