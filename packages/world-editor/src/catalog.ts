// Every block a world can hold, for the Add list: CC:Tweaked's own first, then storage any mod's blocks share, then
// each mod's types under its name, then whatever else the schema knows. Labels are what a player calls the block.
// No DOM, no vscode.
import type { AddonCatalog } from "./model.ts";
import { type Schema, peripheralTypes } from "./schema.ts";

export interface TypeEntry {
  readonly label: string;
  readonly type: string;
  readonly group: string;
  readonly description: string;
  /** Fields a new one starts with besides name and type. */
  readonly preset?: Record<string, unknown>;
  readonly addon?: string;
  readonly target: "monitor" | "player" | "peripheral";
}

export const CC_GROUP = "CC:Tweaked";
export const STORAGE_GROUP = "Storage (any mod's blocks)";

/** Generic peripherals: inventories, tanks and batteries, whichever mod's block they are. */
export const STORAGE: ReadonlySet<string> = new Set([
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:hopper",
  "minecraft:dispenser",
  "minecraft:dropper",
  "minecraft:shulker_box",
  "minecraft:furnace",
  "inventory",
  "fluid_storage",
  "energy_storage",
]);

/** What a player calls the storage blocks, what each is, and the slots it has in game. */
const STORAGE_INFO: Readonly<
  Record<string, { label: string; description: string; size?: number }>
> = {
  "minecraft:chest": { label: "Chest", description: "27 slots." },
  "minecraft:trapped_chest": {
    label: "Trapped chest",
    description: "27 slots.",
  },
  "minecraft:barrel": { label: "Barrel", description: "27 slots." },
  "minecraft:hopper": { label: "Hopper", description: "5 slots.", size: 5 },
  "minecraft:dispenser": {
    label: "Dispenser",
    description: "9 slots.",
    size: 9,
  },
  "minecraft:dropper": { label: "Dropper", description: "9 slots.", size: 9 },
  "minecraft:shulker_box": { label: "Shulker box", description: "27 slots." },
  "minecraft:furnace": {
    label: "Furnace",
    description: "3 slots: what cooks, the fuel, the result.",
    size: 3,
  },
  inventory: {
    label: "Inventory (any mod's container)",
    description: "Any mod's block with slots: give it a size and items.",
  },
  fluid_storage: {
    label: "Tank (any mod's fluid block)",
    description: "Any mod's tank: give it a fluid, or several tanks.",
  },
  energy_storage: {
    label: "Battery (any mod's energy block)",
    description: "Any mod's energy cell: give it energy and a capacity.",
  },
};

/** The block types for the Add list, grouped. */
export function typeCatalog(
  schema: Schema | undefined,
  catalog: AddonCatalog,
): TypeEntry[] {
  const all = schema ? peripheralTypes(schema) : [];
  const describe = (t: string): string =>
    all.find((x) => x.type === t)?.description ?? "";
  const cc = CC_GROUP;
  const out: TypeEntry[] = [
    {
      label: "Monitor",
      type: "monitor",
      group: cc,
      description: "A monitor wall: 1x1 up to 8x6 blocks.",
      target: "monitor",
    },
    {
      label: "Wireless modem",
      type: "modem",
      group: cc,
      description: "Reaches wireless modems within 64 blocks (384 high up).",
      target: "peripheral",
    },
    {
      label: "Ender modem",
      type: "modem",
      group: cc,
      description: "Reaches every wireless modem, any distance, any dimension.",
      preset: { kind: "ender" },
      target: "peripheral",
    },
    {
      label: "Wired modem",
      type: "modem",
      group: cc,
      description:
        "Joins a wired network by its id, or through cables at `block`.",
      preset: { kind: "wired", network: "main" },
      target: "peripheral",
    },
    {
      label: "Speaker",
      type: "speaker",
      group: cc,
      description: describe("speaker"),
      target: "peripheral",
    },
    {
      label: "Printer",
      type: "printer",
      group: cc,
      description:
        "Prints pages of 25x21 letters. Starts with a stack of black dye and of paper.",
      preset: { ink: 64, paper: 64 },
      target: "peripheral",
    },
    {
      label: "Disk drive",
      type: "drive",
      group: cc,
      description: describe("drive"),
      target: "peripheral",
    },
    {
      label: "Redstone relay",
      type: "redstone_relay",
      group: cc,
      description: describe("redstone_relay"),
      target: "peripheral",
    },
    {
      label: "Player",
      type: "player",
      group: cc,
      description:
        "Someone on the server: detectors, chat boxes and inventory managers see them.",
      target: "player",
    },
  ];
  for (const t of STORAGE) {
    const info = STORAGE_INFO[t];
    out.push({
      label: info?.label ?? t,
      type: t,
      group: STORAGE_GROUP,
      description: info?.description ?? describe(t),
      target: "peripheral",
      ...(info?.size ? { preset: { size: info.size } } : {}),
    });
  }
  const taken = new Set([
    "modem",
    "speaker",
    "printer",
    "drive",
    "redstone_relay",
    ...STORAGE,
  ]);
  for (const a of catalog.addons)
    for (const t of a.types) {
      if (taken.has(t)) continue;
      taken.add(t);
      out.push({
        label: t,
        type: t,
        group: a.name,
        addon: a.id,
        description: describe(t),
        target: "peripheral",
      });
    }
  for (const t of all)
    if (!taken.has(t.type))
      out.push({
        label: t.type,
        type: t.type,
        group: "Other types",
        description: t.description,
        target: "peripheral",
      });
  return out;
}

/** The entries whose label, type, mod or description holds `filter`; players are left out when a side is chosen. */
export function matchTypes(
  list: readonly TypeEntry[],
  filter: string,
  forSide = false,
): TypeEntry[] {
  const f = filter.trim().toLowerCase();
  const pool = forSide ? list.filter((t) => t.target !== "player") : [...list];
  if (!f) return pool;
  return pool.filter((t) =>
    `${t.label} ${t.type} ${t.group} ${t.description}`
      .toLowerCase()
      .includes(f),
  );
}

/** A block of the person's own naming, when what they typed is no type the list has. */
export function customEntry(
  list: readonly TypeEntry[],
  filter: string,
): TypeEntry | undefined {
  const typed = filter.trim();
  if (!typed || list.some((t) => t.type === typed)) return undefined;
  return {
    label: `${typed} (a block of your own naming)`,
    type: typed,
    group: "Your own",
    description: "A generic block: give it size/items, tanks or energy.",
    target: "peripheral",
    preset: { size: 9 },
  };
}
