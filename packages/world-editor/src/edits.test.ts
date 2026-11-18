// The Add list's catalogue and the mouse edits both editors share (catalog.ts, edits.ts), against the real schema.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customEntry, matchTypes, typeCatalog } from "./catalog.ts";
import { iconKind } from "./dom.ts";
import {
  addOps,
  computerTitle,
  duplicateOps,
  monitorChars,
  moveToSide,
  thingTitle,
  toNetwork,
} from "./edits.ts";
import { applyOps } from "./jsonDoc.ts";
import { type AddonCatalog, computerOf, thingsOf } from "./model.ts";
import type { Schema } from "./schema.ts";

const schema = JSON.parse(
  readFileSync(
    new URL("../../../schemas/world.schema.json", import.meta.url),
    "utf8",
  ),
) as Schema;
const catalog: AddonCatalog = {
  defaultMc: "1.20.1",
  addons: [
    {
      id: "advanced-peripherals",
      name: "Advanced Peripherals",
      versions: { "1.20.1": "0.7" },
      types: ["playerDetector", "chatBox"],
    },
    {
      id: "needs-ap",
      name: "Needs AP",
      versions: { "1.20.1": "1" },
      types: ["thing"],
      requires: ["advanced-peripherals"],
    },
  ],
};
const apply = (world: object, ops: Parameters<typeof applyOps>[1]) =>
  JSON.parse(applyOps(JSON.stringify(world, null, 2), ops));

describe("typeCatalog", () => {
  const types = typeCatalog(schema, catalog);
  it("CC:Tweaked's blocks first, storage in words, each mod's blocks under its name", () => {
    expect(types[0]).toMatchObject({ label: "Monitor", target: "monitor" });
    expect(types.find((t) => t.type === "minecraft:hopper")).toMatchObject({
      label: "Hopper",
      preset: { size: 5 },
    });
    expect(types.find((t) => t.type === "playerDetector")).toMatchObject({
      group: "Advanced Peripherals",
      addon: "advanced-peripherals",
    });
    // every type the schema knows is somewhere in the list
    const listed = new Set(types.map((t) => t.type));
    expect(schema.definitions?.["PeripheralEntry"]).toBeDefined();
    expect(
      types.filter((t) => t.group === "Other types").length,
    ).toBeGreaterThan(10);
    expect(listed.has("speaker")).toBe(true);
    // a person reads these in the app, where nothing is headless: the speaker says where its sounds go
    const speaker = types.find((t) => t.type === "speaker")!.description;
    expect(speaker).not.toMatch(/headless|no audio|fake/i);
    expect(speaker).toMatch(/window/);
    expect(types.find((t) => t.type === "printer")).toMatchObject({
      label: "Printer",
      group: "CC:Tweaked",
      preset: { ink: 64, paper: 64 },
    });
    expect(iconKind("printer")).toBe("printer");
  });
  it("search finds by name, type, mod or description; players are left out for a side", () => {
    expect(matchTypes(types, "barrel").map((t) => t.type)).toContain(
      "minecraft:barrel",
    );
    expect(
      matchTypes(types, "advanced periph").every(
        (t) =>
          t.group === "Advanced Peripherals" ||
          /advanced periph/i.test(t.description),
      ),
    ).toBe(true);
    expect(
      matchTypes(types, "player", true).some((t) => t.target === "player"),
    ).toBe(false);
    expect(customEntry(types, "mymod:crate")).toMatchObject({
      type: "mymod:crate",
      preset: { size: 9 },
    });
    expect(customEntry(types, "minecraft:chest")).toBeUndefined();
  });
});

describe("edits", () => {
  it("adding: a modem takes a free side, a chest goes on the network, a side asked for is cleared first", () => {
    const types = typeCatalog(schema, catalog);
    const modem = types.find((t) => t.label === "Ender modem")!;
    const chest = types.find((t) => t.type === "minecraft:chest")!;
    let world = apply({}, addOps({}, modem, catalog).ops);
    expect(world.peripherals).toEqual([
      { name: "top", type: "modem", kind: "ender" },
    ]);
    world = apply(world, addOps(world, chest, catalog).ops);
    expect(world.peripherals[1]).toEqual({
      name: "minecraft:chest_0",
      type: "minecraft:chest",
    });
    const put = addOps(world, chest, catalog, "top");
    world = apply(world, put.ops);
    expect(world.peripherals.map((p: { name: string }) => p.name)).toEqual([
      "modem_0",
      "minecraft:chest_0",
      "top",
    ]);
    expect(put.path).toEqual(["peripherals", 2]);
  });
  it("adding a mod's block switches the mod on, and what it needs, when the world lists its mods", () => {
    const thing = typeCatalog(schema, catalog).find((t) => t.type === "thing")!;
    const world = apply(
      { addons: [] },
      addOps({ addons: [] }, thing, catalog).ops,
    );
    expect(world.addons).toEqual(["needs-ap", "advanced-peripherals"]);
  });
  it("moving swaps with what was there; off a side it gets a network name", () => {
    const world = {
      peripherals: [
        { name: "left", type: "speaker" },
        { name: "right", type: "drive" },
      ],
    };
    const [speaker, drive] = thingsOf(world);
    expect(
      apply(world, moveToSide(world, speaker!, "right")).peripherals,
    ).toEqual([
      { name: "right", type: "speaker" },
      { name: "left", type: "drive" },
    ]);
    expect(apply(world, toNetwork(world, drive!)).peripherals[1].name).toBe(
      "drive_0",
    );
    const copy = duplicateOps(world, speaker!);
    expect(apply(world, copy.ops).peripherals[2]).toEqual({
      name: "speaker_0",
      type: "speaker",
    });
  });
  it("titles and monitor sizes", () => {
    const world = {
      monitors: [
        { name: "top", blocksWide: 3, blocksHigh: 2, advanced: false },
      ],
    };
    expect(thingTitle(world, thingsOf(world)[0]!)).toBe("Normal monitor 3×2");
    expect(monitorChars(1, 1, 1)).toEqual({ cols: 7, rows: 5 });
    expect(monitorChars(8, 6, 0.5)).toEqual({ cols: 164, rows: 81 });
  });
});

describe("computerTitle", () => {
  it("a turtle is a normal turtle unless the world says advanced, as the sim has it", () => {
    expect(computerTitle(computerOf({ turtle: { fuel: 10 } }))).toBe("Turtle");
    expect(computerTitle(computerOf({ turtle: { advanced: true } }))).toBe(
      "Advanced Turtle",
    );
    expect(computerTitle(computerOf({}))).toBe("Advanced Computer");
    expect(computerTitle(computerOf({ advanced: false }))).toBe("Computer");
  });
});
