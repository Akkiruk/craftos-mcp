// New World for This File: a first world for a program, from what its Lua asks for. peripheral.find("monitor") gets
// a monitor, peripheral.wrap("left") a block on the left of the type its calls point at, rednet.open("back") a modem
// on the back, turtle.* a turtle; a mod's block switches that mod on. Nothing else goes in, so the World Editor opens
// on what the program needs and the person adds the rest.
//
// No vscode import: the unit tests load this file in plain Node.
import { type Token, tokenize } from "./luaScan.ts";
import { type PackData, typeOwners } from "./pack.ts";

const SIDES = ["top", "bottom", "left", "right", "front", "back"];
/** Where a found block goes when the program names no side: the order a player tends to build in. */
const FREE_ORDER = ["top", "right", "left", "back", "bottom", "front"];

/** What a block starts with, per type. */
const PRESETS: Record<string, Record<string, unknown>> = {
  "minecraft:chest": { size: 27 },
  "minecraft:trapped_chest": { size: 27 },
  "minecraft:barrel": { size: 27 },
  "minecraft:shulker_box": { size: 27 },
  "minecraft:hopper": { size: 5 },
  "minecraft:dispenser": { size: 9 },
  "minecraft:dropper": { size: 9 },
  "minecraft:furnace": { size: 3 },
  printer: { ink: 64, paper: 64 },
  energy_storage: { energy: 50000, energyCapacity: 100000 },
  fluid_storage: { capacity: 16000 },
};
/** CC:Tweaked's own types the sim builds (besides monitors) */
const CC_TYPES = new Set([
  "modem",
  "speaker",
  "printer",
  "drive",
  "redstone_relay",
  "energy_storage",
  "fluid_storage",
]);

/** A method a wrapped peripheral is called with, to the type it belongs to. */
const METHOD_TYPES: [RegExp, string][] = [
  [
    /^(setTextScale|getTextScale|blit|setBackgroundColou?r|setCursorPos|clear|write|scroll|setPaletteColou?r|isColou?r)$/,
    "monitor",
  ],
  [
    /^(transmit|open|close|isOpen|closeAll|isWireless|getNamesRemote|getNameLocal)$/,
    "modem",
  ],
  [/^(playNote|playSound|playAudio)$/, "speaker"],
  [
    /^(newPage|endPage|getPaperLevel|getInkLevel|setPageTitle|getPageSize)$/,
    "printer",
  ],
  [
    /^(isDiskPresent|getDiskLabel|setDiskLabel|hasData|getMountPath|hasAudio|playAudio|ejectDisk|getDiskID)$/,
    "drive",
  ],
  [
    /^(list|pushItems|pullItems|getItemDetail|getItemLimit|size)$/,
    "minecraft:chest",
  ],
  [/^(tanks|pushFluid|pullFluid)$/, "fluid_storage"],
  [/^(getEnergy|getEnergyCapacity)$/, "energy_storage"],
];
/** A variable's name, to the type it suggests. */
const NAME_TYPES: [RegExp, string][] = [
  [/mon|screen|display/i, "monitor"],
  [/modem|wifi|net/i, "modem"],
  [/speaker|sound/i, "speaker"],
  [/printer/i, "printer"],
  [/drive|disk/i, "drive"],
  [/chest|inv|barrel|storage/i, "minecraft:chest"],
];

export interface TemplateWorld {
  addons?: string[];
  turtle?: Record<string, unknown>;
  monitors?: { name: string; blocksWide: number; blocksHigh: number }[];
  players?: Record<string, unknown>[];
  peripherals?: Record<string, unknown>[];
}

const isOp = (t: Token | undefined, v: string): boolean =>
  t?.kind === "op" && t.value === v;

/** The world a program asks for. `data` says which types are a mod's. */
export function worldForProgram(source: string, data: PackData): TemplateWorld {
  const tokens = tokenize(source);
  const wanted: { type: string; side?: string; name?: string }[] = [];
  const wrapped = new Map<string, string>(); // variable -> the side or name it wraps, of no type yet
  let turtle = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== "name") continue;
    if (
      t.value === "turtle" &&
      isOp(tokens[i + 1], ".") &&
      !isOp(tokens[i - 1], ".")
    )
      turtle = true;
    if (!isOp(tokens[i + 1], ".") || isOp(tokens[i - 1], ".")) continue;
    const field = tokens[i + 2];
    const arg = tokens[i + 4];
    if (
      field?.kind !== "name" ||
      !isOp(tokens[i + 3], "(") ||
      arg?.kind !== "string"
    )
      continue;
    if (t.value === "peripheral" && field.value === "find")
      wanted.push({ type: arg.value });
    else if (t.value === "peripheral" && field.value === "wrap") {
      // local x = peripheral.wrap("left"): what x is called with says what it is
      const variable =
        isOp(tokens[i - 1], "=") && tokens[i - 2]?.kind === "name"
          ? tokens[i - 2]!.value
          : undefined;
      if (variable) wrapped.set(variable, arg.value);
      else
        wanted.push({
          type: typeOfName(arg.value) ?? "",
          ...placeOf(arg.value),
        });
    } else if (t.value === "rednet" && field.value === "open")
      wanted.push({ type: "modem", ...placeOf(arg.value) });
  }

  // the wrapped ones: their network name says their type ("minecraft:barrel_0"), else their calls, else the variable
  for (const [variable, where] of wrapped) {
    let type = typeOfName(where);
    for (let i = 0; i < tokens.length && !type; i++) {
      const t = tokens[i]!;
      if (t.kind !== "name" || t.value !== variable || isOp(tokens[i - 1], "."))
        continue;
      if (!(isOp(tokens[i + 1], ".") || isOp(tokens[i + 1], ":"))) continue;
      const method = tokens[i + 2];
      if (method?.kind === "name")
        type = METHOD_TYPES.find(([re]) => re.test(method.value))?.[1];
    }
    type ??= NAME_TYPES.find(([re]) => re.test(variable))?.[1];
    wanted.push({ type: type ?? "", ...placeOf(where) });
  }

  const world: TemplateWorld = {};
  const taken = new Set<string>();
  const addons = new Set<string>();
  const players = new Set<string>();
  const sideFor = (w: { side?: string; name?: string }): string | undefined => {
    if (w.side) return taken.has(w.side) ? undefined : w.side;
    if (w.name) return taken.has(w.name) ? undefined : w.name;
    return FREE_ORDER.find((s) => !taken.has(s));
  };
  const seenTypes = new Set<string>();
  for (const w of wanted) {
    if (!w.type) continue;
    // a found type once is enough; a named side or block each time
    if (!w.side && !w.name) {
      if (seenTypes.has(w.type)) continue;
      seenTypes.add(w.type);
    }
    const type = w.type === "inventory" ? "minecraft:chest" : w.type;
    // a mod type by either name (addons.ts byVersion): the world may name it either way, the canonical one picks the preset
    const typed = typeOwners(data, type);
    const owners = typed.map((o) => o.addon);
    const canonical = typed[0]?.canonical ?? type;
    const known =
      type === "monitor" ||
      CC_TYPES.has(type) ||
      type.startsWith("minecraft:") ||
      owners.length > 0;
    if (!known) continue;
    const name = sideFor(w);
    if (!name) continue;
    taken.add(name);
    if (type === "monitor") {
      (world.monitors ??= []).push({ name, blocksWide: 3, blocksHigh: 2 });
      continue;
    }
    (world.peripherals ??= []).push({
      name,
      type,
      ...(PRESETS[type] ?? PRESETS[canonical] ?? {}),
    });
    const owner = owners[0];
    if (owner && !CC_TYPES.has(type)) {
      addons.add(owner.id);
      for (const need of owner.requires) addons.add(need);
    }
    if (/playerDetector|chatBox|inventoryManager/.test(canonical))
      players.add("Alice");
  }
  if (addons.size) world.addons = [...addons];
  if (turtle) world.turtle = { fuel: 1000 };
  if (players.size)
    world.players = [...players].map((name) => ({ name, x: 2, y: 64, z: 0 }));
  // a stable key order: what the program runs on first, then what is around it
  const ordered: TemplateWorld = {};
  for (const key of [
    "addons",
    "turtle",
    "monitors",
    "players",
    "peripherals",
  ] as const)
    if (world[key] !== undefined)
      (ordered as Record<string, unknown>)[key] = world[key];
  return ordered;
}

/** A side ("left") or a network name ("minecraft:chest_0"). */
function placeOf(where: string): { side?: string; name?: string } {
  return SIDES.includes(where) ? { side: where } : { name: where };
}

/** A network name's type: CC names a block on a network after its type, "minecraft:chest_0", "monitor_2". */
function typeOfName(where: string): string | undefined {
  if (SIDES.includes(where)) return undefined;
  const m = /^(.+)_\d+$/.exec(where);
  return m ? m[1] : undefined;
}

/** The new file's text. */
export function worldText(source: string, data: PackData): string {
  return `${JSON.stringify(worldForProgram(source, data), null, 2)}\n`;
}
