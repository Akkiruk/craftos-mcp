// What a world file puts around its computer, the way the runner reads it: a peripheral or monitor named after a
// side ("top", "left", ...) is on that side of the computer; any other name ("minecraft:chest_0") is on the
// computer's wired network; x/y/z are where the block stands. One file is one computer: several computers are
// several files whose modems reach each other (ender modems always, wireless ones within range, wired ones that
// share a `network` id). No vscode here.
import type { JsonPath } from "./jsonDoc.ts";
import { type Problem, type Side, SIDES, isSide } from "./schema.ts";

/** An addon from packages/runner/src/addons.ts, as esbuild.mjs writes them to schemas/addons.json. */
export interface AddonInfo {
  readonly id: string;
  readonly name: string;
  readonly versions: Readonly<Record<string, string>>;
  readonly types: readonly string[];
  readonly worldKeys?: readonly string[];
  readonly requires?: readonly string[];
  readonly docs?: string;
}

export interface AddonCatalog {
  readonly defaultMc: string;
  readonly addons: readonly AddonInfo[];
}

export type World = Record<string, unknown>;

export interface Thing {
  /** Where it is in the file: ["peripherals", 2], ["monitors", 0], ["players", 1]. */
  readonly path: JsonPath;
  readonly kind: "peripheral" | "monitor" | "player";
  readonly name: string;
  readonly type: string;
  /** The side it is on, when its name is one. */
  readonly side?: Side;
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  /** Modems: wireless, ender or wired. */
  readonly modem?: "wireless" | "ender" | "wired";
}

export interface ComputerFacts {
  readonly kind: "computer" | "pocket" | "turtle" | "android" | "drone";
  readonly advanced: boolean;
  readonly id: number;
  readonly label?: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dimension: string;
  /** The object its x, y and z are in: `position`, or `turtle` for a turtle that gives its own. */
  readonly at: "position" | "turtle";
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

export function computerOf(world: World): ComputerFacts {
  const turtle = obj(world["turtle"]);
  // a turtle's own x, y, z and dimension win over the world's position, each on its own (TurtleSpec)
  const at =
    turtle && (num(turtle["x"]) !== undefined || num(turtle["z"]) !== undefined)
      ? "turtle"
      : "position";
  const world_ = obj(world["position"]) ?? {};
  const own = turtle ?? {};
  const pick = (k: string): unknown => own[k] ?? world_[k];
  const pos = {
    x: pick("x"),
    y: pick("y"),
    z: pick("z"),
    dimension: pick("dimension"),
  };
  const kind = turtle
    ? "turtle"
    : world["android"]
      ? "android"
      : world["drone"] || world["dronePlus"] || world["acDrone"]
        ? "drone"
        : world["kind"] === "pocket"
          ? "pocket"
          : "computer";
  // a turtle is a normal one unless it says advanced (TurtleSpec.advanced); a computer is advanced unless it says not
  const advanced = turtle
    ? turtle["advanced"] === true
    : world["advanced"] !== false;
  return {
    kind,
    advanced,
    id: num(world["computerId"]) ?? 0,
    label: str(world["label"]),
    x: num(pos.x) ?? 0,
    y: num(pos.y) ?? 64,
    z: num(pos.z) ?? 0,
    dimension: str(pos.dimension) ?? "minecraft:overworld",
    at,
  };
}

/** Everything placed in the world: peripherals, monitors and players, in file order. */
export function thingsOf(world: World): Thing[] {
  const out: Thing[] = [];
  const list = (key: string): unknown[] =>
    Array.isArray(world[key]) ? (world[key] as unknown[]) : [];
  list("monitors").forEach((m, k) => {
    const o = obj(m) ?? {};
    const name = str(o["name"]) ?? "";
    out.push({
      path: ["monitors", k],
      kind: "monitor",
      name,
      type: "monitor",
      side: isSide(name) ? name : undefined,
    });
  });
  list("peripherals").forEach((p, k) => {
    const o = obj(p) ?? {};
    const name = str(o["name"]) ?? "";
    const type = str(o["type"]) ?? "";
    const kind = str(o["kind"]);
    out.push({
      path: ["peripherals", k],
      kind: "peripheral",
      name,
      type,
      side: isSide(name) ? name : undefined,
      x: num(o["x"]),
      y: num(o["y"]),
      z: num(o["z"]),
      modem:
        type === "modem"
          ? kind === "ender" || kind === "wired"
            ? kind
            : "wireless"
          : undefined,
    });
  });
  list("players").forEach((p, k) => {
    const o = obj(p) ?? {};
    out.push({
      path: ["players", k],
      kind: "player",
      name: str(o["name"]) ?? "",
      type: "player",
      x: num(o["x"]),
      y: num(o["y"]),
      z: num(o["z"]),
    });
  });
  return out;
}

/** What is on each side; more than one thing on a side is a clash the runner will not like. */
export function bySide(things: readonly Thing[]): Record<Side, Thing[]> {
  const sides = Object.fromEntries(
    SIDES.map((s) => [s, [] as Thing[]]),
  ) as Record<Side, Thing[]>;
  for (const t of things) if (t.side) sides[t.side].push(t);
  return sides;
}

/** A free network name for a new block of `type`: `minecraft:chest_0`, `monitor_1`, ... */
export function freeName(world: World, type: string): string {
  const used = new Set(thingsOf(world).map((t) => t.name));
  for (let n = 0; ; n++) if (!used.has(`${type}_${n}`)) return `${type}_${n}`;
}

/** A side nothing is on yet, or undefined. */
export function freeSide(world: World): Side | undefined {
  const sides = bySide(thingsOf(world));
  return SIDES.find((s) => !sides[s].length);
}

/** The world's Minecraft version: its own, else the editor's default. */
export function mcOf(world: World, fallback: string): string {
  const v = world["version"];
  if (typeof v === "string") return v;
  const o = obj(v);
  return str(o?.["mc"]) ?? fallback;
}

/**
 * The addon ids a world runs with, or "all" when every addon with a release for its version is on. Mirrors
 * resolveAddons in packages/runner/src/addons.ts. `fallback`: CRAFTOS_ADDONS / the craftos-mcp.addons setting.
 */
export function addonsOn(
  world: World,
  catalog: AddonCatalog,
  mc: string,
  fallback = "",
): Set<string> {
  const spec = world["addons"] ?? (fallback.trim() ? fallback : undefined);
  const forMc = catalog.addons
    .filter((a) => a.versions[mc] !== undefined)
    .map((a) => a.id);
  if (spec === undefined) return new Set(forMc);
  const list = (
    typeof spec === "string" ? spec.split(",") : Array.isArray(spec) ? spec : []
  )
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (list.length === 1 && list[0]!.toLowerCase() === "all")
    return new Set(forMc);
  if (list.length === 1 && list[0]!.toLowerCase() === "none") return new Set();
  return new Set(list);
}

export function addonOfType(
  catalog: AddonCatalog,
  type: string,
): AddonInfo | undefined {
  return catalog.addons.find((a) => a.types.includes(type));
}

/** Problems the schema cannot see: an addon that is off or has no release, two things on one side. */
export function worldProblems(
  world: World,
  catalog: AddonCatalog,
  fallbackMc: string,
  fallbackAddons = "",
): Problem[] {
  const out: Problem[] = [];
  const mc = mcOf(world, fallbackMc);
  const on = addonsOn(world, catalog, mc, fallbackAddons);
  const byId = new Map(catalog.addons.map((a) => [a.id, a]));
  const listed = world["addons"];
  if (Array.isArray(listed))
    listed.forEach((id, k) => {
      const a = byId.get(String(id));
      if (a && a.versions[mc] === undefined)
        out.push({
          path: ["addons", k],
          message: `${a.name} has no release for Minecraft ${mc}; it has ${Object.keys(a.versions).join(", ")}.`,
        });
      for (const need of a?.requires ?? [])
        if (!on.has(need))
          out.push({
            path: ["addons", k],
            message: `${a!.name} needs ${byId.get(need)?.name ?? need} switched on too.`,
          });
    });
  for (const t of thingsOf(world)) {
    if (t.kind !== "peripheral") continue;
    const a = addonOfType(catalog, t.type);
    if (a && !on.has(a.id))
      out.push({
        path: [...t.path, "type"],
        message: `${t.type} comes from ${a.name} (addon "${a.id}"), which is off in this world.`,
      });
  }
  for (const key of Object.keys(world)) {
    const a = catalog.addons.find((x) => x.worldKeys?.includes(key));
    if (a && !on.has(a.id))
      out.push({
        path: [key],
        message: `"${key}" configures ${a.name} (addon "${a.id}"), which is off in this world.`,
      });
  }
  const sides = bySide(thingsOf(world));
  for (const s of SIDES) {
    const on = sides[s].filter((t) => t.kind !== "player");
    if (on.length > 1)
      for (const t of on.slice(1))
        out.push({
          path: [...t.path, "name"],
          message: `Two blocks on the ${s} side: ${on.map((x) => x.type).join(" and ")}.`,
        });
  }
  return out;
}

/** Another computer's world file next to this one, and whether their modems reach each other. */
export interface Neighbour {
  readonly file: string;
  readonly computer: ComputerFacts;
  readonly modems: readonly ("wireless" | "ender" | "wired")[];
  readonly networks: readonly string[];
}

export function neighbourOf(file: string, world: World): Neighbour {
  const modems = thingsOf(world).filter((t) => t.modem);
  const networks = (
    Array.isArray(world["peripherals"])
      ? (world["peripherals"] as unknown[])
      : []
  )
    .map((p) => str(obj(p)?.["network"]))
    .filter((n): n is string => !!n);
  return {
    file,
    computer: computerOf(world),
    modems: modems.map((m) => m.modem!),
    networks,
  };
}

/**
 * How two computers' modems would reach each other: "ender" (always), "wireless" (within range, given here as the
 * distance), "wired" (a shared network id), or undefined.
 */
export function linkBetween(
  a: Neighbour,
  b: Neighbour,
  range = 64,
): string | undefined {
  if (
    a.modems.includes("ender") &&
    (b.modems.includes("ender") || b.modems.includes("wireless"))
  )
    return "ender";
  if (b.modems.includes("ender") && a.modems.includes("wireless"))
    return "ender";
  if (a.networks.some((n) => b.networks.includes(n))) return "wired";
  if (
    a.modems.includes("wireless") &&
    b.modems.includes("wireless") &&
    a.computer.dimension === b.computer.dimension
  ) {
    const d = Math.hypot(
      a.computer.x - b.computer.x,
      a.computer.y - b.computer.y,
      a.computer.z - b.computer.z,
    );
    if (d <= range) return "wireless";
  }
  return undefined;
}
