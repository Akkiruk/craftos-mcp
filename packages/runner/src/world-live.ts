/**
 * A world changed while its computer runs, as the game would change it: the steps that take a running computer from
 * one world file to another. A block put next to it is attached (`peripheral`), a block broken is detached
 * (`peripheral_detach`), a block whose settings changed is broken and placed again, a chest's contents, a tank's
 * fluid and a battery's energy change in place, a monitor wall grows or shrinks (`monitor_resize`), players join,
 * leave and move. What no event can carry (the Minecraft version, the mods, a player's health...) is listed in
 * `later`: it is in the world file, and a computer started from the file has it.
 */
import type { MonitorSpec } from "./lua.js";
import type { SimCommand, WorldConfig } from "./world.js";

export interface LiveStep {
  /** What happens, in a player's words: "Put a minecraft:chest on the left". */
  readonly what: string;
  readonly command: SimCommand;
  /** Steps that do the same another way, run when this one fails (a chest whose contents cannot be set in place is placed again). */
  readonly fallback?: readonly LiveStep[];
}

export interface LivePlan {
  readonly steps: LiveStep[];
  /** Changes the running computer cannot pick up: they apply when a computer starts from this world. */
  readonly later: string[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const SIDES = new Set(["top", "bottom", "left", "right", "front", "back"]);

/** "the left side" or "the network as minecraft:chest_0". */
function where(name: string): string {
  return SIDES.has(name) ? `on the ${name}` : `on the network as ${name}`;
}

function byName(list: unknown, lower = false): Map<string, Obj> {
  const out = new Map<string, Obj>();
  if (!Array.isArray(list)) return out;
  for (const item of list)
    if (isObj(item) && typeof item["name"] === "string" && item["name"])
      out.set(lower ? item["name"].toLowerCase() : item["name"], item);
  return out;
}

/** Keys whose values differ between two objects. */
function changedKeys(a: Obj, b: Obj): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => !same(a[k], b[k]),
  );
}

/** The peripheral spec attachPeripheral takes. */
function attachOf(p: Obj): SimCommand {
  return { cmd: "attachPeripheral", peripheral: p as never };
}

function monitorAttach(m: Obj): SimCommand {
  const spec: Obj = { name: m["name"], type: "monitor" };
  for (const k of ["blocksWide", "blocksHigh", "textScale", "advanced"])
    if (m[k] !== undefined) spec[k] = m[k];
  return { cmd: "attachPeripheral", peripheral: spec as never };
}

const monitorLabel = (m: Obj): string =>
  `${m["advanced"] === false ? "normal monitor" : "monitor"} ${Number(m["blocksWide"] ?? 1)}x${Number(m["blocksHigh"] ?? 1)}`;

/** In-place steps for a generic storage block's contents, or undefined when only placing it again will do. */
function contentSteps(
  name: string,
  before: Obj,
  after: Obj,
  keys: readonly string[],
): LiveStep[] | undefined {
  const out: LiveStep[] = [];
  for (const k of keys) {
    if (k === "items") {
      const a = before["items"] ?? {};
      const b = after["items"] ?? {};
      if (!isObj(a) || !isObj(b)) return undefined;
      const slots = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      if (slots.some((s) => !/^\d+$/.test(s))) return undefined;
      for (const s of slots.sort((x, y) => Number(x) - Number(y))) {
        if (same(a[s], b[s])) continue;
        const item = b[s] ?? null;
        out.push({
          what: item
            ? `Put ${String((item as Obj)["count"] ?? 1)} ${String((item as Obj)["name"])} in slot ${s} of ${name}`
            : `Emptied slot ${s} of ${name}`,
          command: {
            cmd: "setItem",
            peripheral: name,
            slot: Number(s),
            item: item as never,
          },
        });
      }
    } else if (k === "energy") {
      if (typeof after["energy"] !== "number") return undefined;
      out.push({
        what: `${name} now holds ${after["energy"]} FE`,
        command: {
          cmd: "setEnergy",
          peripheral: name,
          energy: after["energy"],
        },
      });
    } else if (k === "fluid") {
      if (after["tanks"] !== undefined) continue; // `tanks` wins over `fluid`
      const f = after["fluid"];
      if (f !== undefined && !(isObj(f) && typeof f["name"] === "string"))
        return undefined;
      out.push({
        what: f
          ? `${name} now holds ${String((f as Obj)["amount"] ?? 0)} mB of ${String((f as Obj)["name"])}`
          : `Emptied ${name}`,
        command: {
          cmd: "setFluid",
          peripheral: name,
          tank: 1,
          fluid: (f ?? null) as never,
        },
      });
    } else if (k === "tanks") {
      const a = Array.isArray(before["tanks"])
        ? (before["tanks"] as unknown[])
        : [];
      const b = Array.isArray(after["tanks"])
        ? (after["tanks"] as unknown[])
        : undefined;
      if (!b || a.length !== b.length) return undefined;
      for (let i = 0; i < b.length; i++) {
        const ta = isObj(a[i]) ? (a[i] as Obj) : {};
        const tb = isObj(b[i]) ? (b[i] as Obj) : {};
        const diff = changedKeys(ta, tb);
        if (!diff.length) continue;
        if (diff.some((d) => d !== "name" && d !== "amount")) return undefined;
        const fluid =
          typeof tb["name"] === "string"
            ? { name: tb["name"], amount: Number(tb["amount"] ?? 0) }
            : null;
        out.push({
          what: fluid
            ? `Tank ${i + 1} of ${name} now holds ${fluid.amount} mB of ${fluid.name}`
            : `Emptied tank ${i + 1} of ${name}`,
          command: {
            cmd: "setFluid",
            peripheral: name,
            tank: i + 1,
            fluid: fluid as never,
          },
        });
      }
    } else return undefined;
  }
  return out;
}

const POSITION = ["x", "y", "z", "yaw", "pitch", "dimension"];

/**
 * The steps from `before` to `after`. `departed`: players who left earlier in this run (the server still knows
 * them, so they come back by joining, not by being added).
 */
export function planLive(
  before: WorldConfig,
  after: WorldConfig,
  departed: ReadonlySet<string> = new Set(),
): LivePlan {
  const b = before as Obj;
  const a = after as Obj;
  const steps: LiveStep[] = [];
  const later: string[] = [];
  const detaches: LiveStep[] = [];
  const attaches: LiveStep[] = [];
  const updates: LiveStep[] = [];

  // ---- monitors ----
  const monA = byName(b["monitors"]);
  const monB = byName(a["monitors"]);
  for (const [name, m] of monA)
    if (!monB.has(name))
      detaches.push({
        what: `Broke the ${monitorLabel(m)} ${where(name)}`,
        command: { cmd: "detachPeripheral", name },
      });
  for (const [name, m] of monB) {
    const old = monA.get(name);
    if (!old) {
      attaches.push({
        what: `Put a ${monitorLabel(m)} ${where(name)}`,
        command: monitorAttach(m),
      });
      continue;
    }
    const keys = changedKeys(old, m);
    if (!keys.length) continue;
    if (keys.includes("advanced")) {
      detaches.push({
        what: `Broke the ${monitorLabel(old)} ${where(name)}`,
        command: { cmd: "detachPeripheral", name },
      });
      attaches.push({
        what: `Put a ${monitorLabel(m)} ${where(name)}`,
        command: monitorAttach(m),
      });
      continue;
    }
    if (keys.includes("blocksWide") || keys.includes("blocksHigh"))
      updates.push({
        what: `The monitor ${where(name)} is now ${Number(m["blocksWide"] ?? 1)}x${Number(m["blocksHigh"] ?? 1)} blocks`,
        command: {
          cmd: "resizeMonitor",
          monitor: name,
          blocksWide: Number(m["blocksWide"] ?? 1),
          blocksHigh: Number(m["blocksHigh"] ?? 1),
        },
      });
    if (keys.includes("textScale"))
      later.push(
        `The text scale of the monitor ${where(name)} is where it starts: the running program sets its own.`,
      );
  }

  // ---- peripherals (by name: a block moved to another side is broken here and placed there) ----
  const perA = byName(b["peripherals"]);
  const perB = byName(a["peripherals"]);
  for (const [name, p] of perA)
    if (!perB.has(name))
      detaches.push({
        what: `Broke the ${String(p["type"])} ${where(name)}`,
        command: { cmd: "detachPeripheral", name },
      });
  for (const [name, p] of perB) {
    const old = perA.get(name);
    const place: LiveStep = {
      what: `Put a ${String(p["type"])} ${where(name)}`,
      command: attachOf(p),
    };
    if (!old) {
      attaches.push(place);
      continue;
    }
    const keys = changedKeys(old, p);
    if (!keys.length) continue;
    const replace: LiveStep[] = [
      {
        what: `Broke the ${String(old["type"])} ${where(name)}`,
        command: { cmd: "detachPeripheral", name },
      },
      {
        ...place,
        what: `Put a ${String(p["type"])} ${where(name)} again, with its new settings`,
      },
    ];
    const inPlace = keys.includes("type")
      ? undefined
      : contentSteps(name, old, p, keys);
    if (inPlace?.length) {
      // the first in-place step carries the way back: if the block has no such contents, place it again
      updates.push({ ...inPlace[0]!, fallback: replace }, ...inPlace.slice(1));
    } else if (inPlace === undefined) {
      detaches.push(replace[0]!);
      attaches.push(replace[1]!);
    }
  }

  // ---- players ----
  const plA = byName(b["players"], true);
  const plB = byName(a["players"], true);
  for (const [key, p] of plA)
    if (!plB.has(key) && p["online"] !== false)
      updates.push({
        what: `${String(p["name"])} logged out`,
        command: { cmd: "leave", player: String(p["name"]) },
      });
  for (const [key, p] of plB) {
    const name = String(p["name"]);
    const old = plA.get(key);
    const pos: Obj = {};
    if (!old) {
      if (departed.has(key)) {
        if (p["online"] !== false)
          updates.push({
            what: `${name} logged in again`,
            command: { cmd: "join", player: name },
          });
        for (const k of POSITION) if (p[k] !== undefined) pos[k] = p[k];
        if (Object.keys(pos).length)
          updates.push({
            what: `${name} is at ${[pos["x"], pos["y"], pos["z"]].map((v) => v ?? "?").join(", ")}`,
            command: {
              cmd: "setPlayerPos",
              player: name,
              ...pos,
            } as SimCommand,
          });
      } else
        updates.push({
          what: `${name} joined the server`,
          command: { cmd: "addPlayer", ...p } as SimCommand,
        });
      continue;
    }
    const keys = changedKeys(old, p);
    if (!keys.length) continue;
    if (keys.includes("online"))
      updates.push(
        p["online"] === false
          ? {
              what: `${name} logged out`,
              command: { cmd: "leave", player: name },
            }
          : {
              what: `${name} logged in`,
              command: { cmd: "join", player: name },
            },
      );
    const moved = keys.filter((k) => POSITION.includes(k));
    if (moved.length) {
      for (const k of moved) pos[k] = p[k];
      updates.push({
        what: `${name} moved to ${[p["x"], p["y"], p["z"]].map((v) => v ?? "?").join(", ")}${p["dimension"] ? ` in ${String(p["dimension"])}` : ""}`,
        command: { cmd: "setPlayerPos", player: name, ...pos } as SimCommand,
      });
    }
    const rest = keys.filter(
      (k) => k !== "online" && k !== "name" && !POSITION.includes(k),
    );
    if (rest.length)
      later.push(
        `${name}'s ${rest.join(", ")}: a computer started from this world sees the new value.`,
      );
  }

  // ---- the computer and the world around it ----
  for (const key of changedKeys(b, a)) {
    if (
      key === "monitors" ||
      key === "peripherals" ||
      key === "players" ||
      key === "simProgram" ||
      key === "$schema"
    )
      continue;
    if (key === "position" && isObj(a["position"])) {
      const pos = a["position"] as Obj;
      const cmd: Obj = { cmd: "setComputerPos" };
      for (const k of ["x", "y", "z", "dimension"])
        if (pos[k] !== undefined) cmd[k] = pos[k];
      updates.push({
        what: `The computer moved to ${[pos["x"], pos["y"], pos["z"]].map((v) => v ?? "?").join(", ")}`,
        command: cmd as SimCommand,
      });
    } else if (key === "environment" && isObj(a["environment"])) {
      const env = a["environment"] as Obj;
      const was = isObj(b["environment"]) ? (b["environment"] as Obj) : {};
      const values: Obj = {};
      for (const k of changedKeys(was, env))
        if (env[k] !== undefined) values[k] = env[k];
      if (Object.keys(values).length)
        updates.push({
          what: `The weather and time: ${Object.entries(values)
            .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
            .join(", ")}`,
          command: { cmd: "setEnvironment", values } as SimCommand,
        });
      if (Object.keys(was).some((k) => env[k] === undefined))
        later.push(
          "A removed environment setting goes back to its default when a computer starts from this world.",
        );
    } else if (key === "entities" && Array.isArray(a["entities"])) {
      const was = Array.isArray(b["entities"])
        ? (b["entities"] as unknown[])
        : [];
      const now = a["entities"] as unknown[];
      if (was.every((e, i) => same(e, now[i])))
        for (const e of now.slice(was.length))
          updates.push({
            what: `An entity appeared nearby`,
            command: { cmd: "addEntity", entity: e } as SimCommand,
          });
      else
        later.push(
          "Changed or removed entities: a computer started from this world sees them as they are now.",
        );
    } else later.push(laterText(key));
  }

  steps.push(...detaches, ...attaches, ...updates);
  return { steps, later };
}

function laterText(key: string): string {
  if (key === "version")
    return "The Minecraft version: a new computer from this world uses it.";
  if (key === "addons")
    return "The mods: a new computer from this world has them.";
  if (key === "label")
    return "The label: the running program can set its own with os.setComputerLabel.";
  if (key === "computerId")
    return "The computer id: a new computer from this world has it.";
  return `${key}: a computer started from this world has it.`;
}

/** The world a session runs with, as the app keeps it for its world panel: its monitors back in the file's list. */
export function worldForPanel(
  world: WorldConfig,
  monitors: readonly MonitorSpec[],
): WorldConfig {
  const out: Obj = { ...(world as Obj) };
  delete out["simProgram"];
  if (monitors.length) out["monitors"] = monitors.map((m) => ({ ...m }));
  return out as WorldConfig;
}
