// Edits a person makes with the mouse, as ops on paths: put a block on a side (whatever was there moves to the
// network), take it off, add one, copy one. Both editors send these ops to whatever holds the text. No DOM.
import type { TypeEntry } from "./catalog.ts";
import type { EditOp, JsonPath } from "./jsonDoc.ts";
import {
  type AddonCatalog,
  type ComputerFacts,
  type Thing,
  type World,
  bySide,
  computerOf,
  freeName,
  freeSide,
  thingsOf,
} from "./model.ts";
import type { Side } from "./schema.ts";

/** The value at `path` in the world, or undefined. */
export function valueAt(world: World | undefined, path: JsonPath): unknown {
  let v: unknown = world;
  for (const seg of path)
    v =
      v && typeof v === "object"
        ? (v as Record<string | number, unknown>)[seg]
        : undefined;
  return v;
}

/** Ops that put `thing` on `side`; whatever was there takes the thing's old place. */
export function moveToSide(
  world: World,
  thing: Thing,
  side: Side,
  key: (p: JsonPath) => string = JSON.stringify,
): EditOp[] {
  const occupant = bySide(thingsOf(world))[side].find(
    (t) => t.kind !== "player" && key(t.path) !== key(thing.path),
  );
  const ops: EditOp[] = [
    { op: "set", path: [...thing.path, "name"], value: side },
  ];
  if (occupant) {
    const back = thing.side ?? freeName(world, occupant.type);
    ops.push({ op: "set", path: [...occupant.path, "name"], value: back });
  }
  return ops;
}

/** Ops that move `thing` off its side onto the wired network, with a free network name. */
export function toNetwork(world: World, thing: Thing): EditOp[] {
  if (!thing.side) return [];
  return [
    {
      op: "set",
      path: [...thing.path, "name"],
      value: freeName(world, thing.type),
    },
  ];
}

/** Whatever is on `side` moves to the network, to make room. */
export function clearSide(world: World, side: Side): EditOp[] {
  return bySide(thingsOf(world))
    [side].filter((t) => t.kind !== "player")
    .flatMap((t) => toNetwork(world, t));
}

/** Ops that add a new block, monitor or player of `entry`, and where it lands. */
export function addOps(
  world: World,
  entry: TypeEntry,
  catalog: AddonCatalog,
  side?: Side,
): { ops: EditOp[]; path: JsonPath } {
  const comp = computerOf(world);
  const ops: EditOp[] = [];
  const count = (key: string): number =>
    Array.isArray(world[key]) ? (world[key] as unknown[]).length : 0;
  if (entry.target === "player") {
    const n = count("players");
    ops.push({
      op: "push",
      path: ["players"],
      value: {
        name: n ? `Player${n + 1}` : "Alice",
        x: comp.x + 2,
        y: comp.y,
        z: comp.z,
      },
    });
    return { ops, path: ["players", n] };
  }
  if (entry.target === "monitor") {
    const name = side ?? freeSide(world) ?? freeName(world, "monitor");
    if (side) ops.push(...clearSide(world, side));
    ops.push({
      op: "push",
      path: ["monitors"],
      value: { name, blocksWide: 3, blocksHigh: 2 },
    });
    return { ops, path: ["monitors", count("monitors")] };
  }
  const name =
    side ??
    (entry.type === "modem" ? freeSide(world) : undefined) ??
    freeName(world, entry.type);
  if (side) ops.push(...clearSide(world, side));
  ops.push({
    op: "push",
    path: ["peripherals"],
    value: { name, type: entry.type, ...(entry.preset ?? {}) },
  });
  // switch the addon on when the world lists its addons
  if (
    entry.addon &&
    Array.isArray(world["addons"]) &&
    !(world["addons"] as unknown[]).includes(entry.addon)
  ) {
    const a = catalog.addons.find((x) => x.id === entry.addon);
    ops.push({ op: "push", path: ["addons"], value: entry.addon });
    for (const need of a?.requires ?? [])
      if (!(world["addons"] as unknown[]).includes(need))
        ops.push({ op: "push", path: ["addons"], value: need });
  }
  return { ops, path: ["peripherals", count("peripherals")] };
}

/** Ops that add a copy of `thing` (a free name, or "<name> 2" for a player), and where it lands. */
export function duplicateOps(
  world: World,
  thing: Thing,
): { ops: EditOp[]; path: JsonPath } {
  const copy = JSON.parse(
    JSON.stringify(valueAt(world, thing.path) ?? {}),
  ) as Record<string, unknown>;
  const list = thing.path[0] as string;
  if (thing.kind === "player") copy["name"] = `${thing.name} 2`;
  else copy["name"] = freeName(world, thing.type);
  const index = Array.isArray(world[list])
    ? (world[list] as unknown[]).length
    : 0;
  return {
    ops: [{ op: "push", path: [list], value: copy }],
    path: [list, index],
  };
}

export function computerTitle(c: ComputerFacts): string {
  const adv = c.advanced ? "Advanced " : "";
  if (c.kind === "turtle") return `${adv}Turtle`;
  if (c.kind === "pocket") return `${adv}Pocket Computer`;
  if (c.kind === "android") return "Android";
  if (c.kind === "drone") return "Drone";
  return `${adv}Computer`;
}

/** A thing's short title: "Monitor 3×2", "Ender modem", the player's name, or its type. */
export function thingTitle(world: World, t: Thing): string {
  if (t.kind === "monitor") {
    const m = (valueAt(world, t.path) ?? {}) as Record<string, unknown>;
    return `${m["advanced"] === false ? "Normal monitor" : "Monitor"} ${m["blocksWide"] ?? 1}×${m["blocksHigh"] ?? 1}`;
  }
  if (t.kind === "player") return t.name || "Player";
  if (t.modem) return `${t.modem[0]!.toUpperCase()}${t.modem.slice(1)} modem`;
  return t.type || "(no type)";
}

/** Characters on a monitor wall, as CC:Tweaked's MonitorBlockEntity works them out: (64 * blocks - 20) / (6 or 9 * scale). */
export function monitorChars(
  blocksWide: number,
  blocksHigh: number,
  scale: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.round((64 * blocksWide - 20) / (6 * scale))),
    rows: Math.max(1, Math.round((64 * blocksHigh - 20) / (9 * scale))),
  };
}
