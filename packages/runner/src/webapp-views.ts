/**
 * What the browser app's views read (webapp/views.js): the block world around a turtle, as a first full copy and then
 * only what changed, and the packets the computers of a network send each other, with who heard each one.
 *
 * The app's server (webapp.ts) hands its requests here first; nothing in this file starts or drives a computer.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import type { BlockDef, BlockWorldHost } from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import type { ComputerNetwork } from "./network.js";
import type { Session, SessionManager } from "./sessions.js";
import { computerPosition, modemsOf } from "./wired.js";
import type { WorldConfig } from "./world.js";

// ───────────────────────── packets ─────────────────────────

/** A Lua value as JSON can hold it: a table with keys 1..n is a list, any other table an object. */
export type LuaValue =
  | null
  | boolean
  | number
  | string
  | LuaValue[]
  | { [key: string]: LuaValue };

interface TableRef {
  readonly table: number;
}
type Raw = null | boolean | number | string | TableRef;

const isRef = (v: Raw): v is TableRef => typeof v === "object" && v !== null;

/** Read what ccsim/modem.lua's `encode` wrote: the root value, and every table as its key and value pairs. */
function parseEncoded(text: string): { root: Raw; tables: [Raw, Raw][][] } {
  let pos = 0;
  const value = (): Raw => {
    const c = text[pos];
    if (c === "s") {
      const colon = text.indexOf(":", pos);
      const length = Number(text.slice(pos + 1, colon));
      if (colon < 0 || !Number.isInteger(length)) throw new Error("bad string");
      const raw = text.slice(colon + 1, colon + 1 + length);
      pos = colon + 1 + length;
      return raw.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    }
    if (c === "d" || c === "r") {
      const stop = text.indexOf(";", pos);
      if (stop < 0) throw new Error("bad number");
      const digits = text.slice(pos + 1, stop);
      pos = stop + 1;
      if (c === "r") return { table: Number(digits) };
      if (digits === "nan") return NaN;
      if (digits === "inf") return Infinity;
      if (digits === "-inf") return -Infinity;
      return Number(digits);
    }
    pos += 1;
    if (c === "T") return true;
    if (c === "F") return false;
    return null;
  };
  const root = value();
  const tables: [Raw, Raw][][] = [];
  while (pos < text.length) {
    const stop = text.indexOf(";", pos);
    const count = Number(text.slice(pos, stop));
    if (stop < 0 || !Number.isInteger(count)) throw new Error("bad table");
    pos = stop + 1;
    const pairs: [Raw, Raw][] = [];
    for (let i = 0; i < count; i++) {
      const key = value();
      pairs.push([key, value()]);
    }
    tables.push(pairs);
  }
  return { root, tables };
}

/**
 * A packet or message as ccsim/modem.lua encoded it, as JSON: a table that holds itself reads "(the same table
 * again)" there, and tables nested deeper than `maxDepth` read "(more)".
 */
export function decodePacket(text: string, maxDepth = 16): LuaValue {
  let parsed: ReturnType<typeof parseEncoded>;
  try {
    parsed = parseEncoded(text);
  } catch {
    return "(could not be read)";
  }
  const open = new Set<number>();
  const convert = (raw: Raw, depth: number): LuaValue => {
    if (typeof raw === "number")
      return Number.isFinite(raw)
        ? raw
        : Number.isNaN(raw)
          ? "nan"
          : raw > 0
            ? "inf"
            : "-inf";
    if (!isRef(raw)) return raw;
    if (open.has(raw.table)) return "(the same table again)";
    if (depth >= maxDepth) return "(more)";
    const pairs = parsed.tables[raw.table - 1] ?? [];
    open.add(raw.table);
    try {
      const byIndex = new Map<number, Raw>();
      for (const [k, v] of pairs)
        if (typeof k === "number" && Number.isInteger(k) && k >= 1)
          byIndex.set(k, v);
      if (byIndex.size === pairs.length) {
        let list = true;
        for (let i = 1; i <= pairs.length; i++)
          if (!byIndex.has(i)) {
            list = false;
            break;
          }
        if (list) {
          const out: LuaValue[] = [];
          for (let i = 1; i <= pairs.length; i++)
            out.push(convert(byIndex.get(i)!, depth + 1));
          return out;
        }
      }
      const out: { [key: string]: LuaValue } = {};
      for (const [k, v] of pairs)
        out[isRef(k) ? "(a table)" : String(k)] = convert(v, depth + 1);
      return out;
    } finally {
      open.delete(raw.table);
    }
  };
  return convert(parsed.root, 0);
}

/** A value as one short line of Lua, cut at `limit` characters. */
export function luaPreview(value: LuaValue, limit = 80): string {
  let out = "";
  const write = (v: LuaValue): void => {
    if (out.length > limit) return;
    if (v === null) out += "nil";
    else if (typeof v === "string") out += JSON.stringify(v);
    else if (typeof v !== "object") out += String(v);
    else if (Array.isArray(v)) {
      out += "{";
      v.forEach((item, i) => {
        if (i) out += ", ";
        write(item);
      });
      out += "}";
    } else {
      out += "{";
      Object.entries(v).forEach(([k, item], i) => {
        if (i) out += ", ";
        out += /^[A-Za-z_]\w*$/.test(k) ? `${k} = ` : `[${k}] = `;
        write(item);
      });
      out += "}";
    }
  };
  write(value);
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

// ───────────────────────── block colours ─────────────────────────

const DYES: Record<string, number> = {
  white: 0xf0f0f0,
  orange: 0xf2b233,
  magenta: 0xe57fd8,
  light_blue: 0x99b2f2,
  yellow: 0xdede6c,
  lime: 0x7fcc19,
  pink: 0xf2b2cc,
  gray: 0x4c4c4c,
  light_gray: 0x999999,
  cyan: 0x4c99b2,
  purple: 0xb266e5,
  blue: 0x3366cc,
  brown: 0x7f664c,
  green: 0x57a64e,
  red: 0xcc4c4c,
  black: 0x1e1e1e,
};

/** Blocks a map draws like the stone around them, or not at all, that a person watching a turtle wants to tell apart. */
const OWN_COLOURS: [RegExp, number, number?][] = [
  [/coal_ore$/, 0x2b2b2b],
  [/iron_ore$/, 0xd8af93],
  [/copper_ore$/, 0xe0734d],
  [/gold_ore$/, 0xfcee4b],
  [/redstone_ore$/, 0xd32f2f],
  [/emerald_ore$/, 0x17dd62],
  [/lapis_ore$/, 0x345ec3],
  [/diamond_ore$/, 0x4aedd9],
  [/quartz_ore$/, 0xe3dbd0],
  [/^minecraft:ancient_debris$/, 0x6b4a3f],
  [/^computercraft:turtle_advanced$/, 0xd9b84a],
  [/^computercraft:turtle_normal$/, 0xa8a8a8],
  [/^computercraft:computer_advanced$/, 0xc8a93c],
  [/^computercraft:computer_(normal|command)$/, 0x8c8c8c],
  [/^computercraft:monitor_advanced$/, 0x6a5a22],
  [/^computercraft:monitor_normal$/, 0x3c3c3c],
  [/^computercraft:(cable|wired_modem|wired_modem_full)$/, 0x5c5c5c],
  [/^computercraft:wireless_modem_advanced$/, 0xb9a23a],
  [/^computercraft:/, 0x7d7d7d],
  [/(^|:|_)torch$/, 0xffd27f],
  [/glowstone|sea_lantern|shroomlight|lantern$/, 0xf5d77a],
  [/stained_glass/, 0, 0.45], // the dye's colour, below
  [/glass/, 0xcfe8f0, 0.35],
  [/^minecraft:water$/, 0x3f76e4, 0.6],
  [/^minecraft:lava$/, 0xf2701d],
  [/(^|_)ice$/, 0x9fc4f5, 0.75],
  [/^minecraft:bedrock$/, 0x333333],
  [/^minecraft:obsidian$/, 0x1b1029],
];

/** What a block is made of, read from its name, for blocks no data file knows. */
const BY_WORD: [RegExp, number][] = [
  [/deepslate|blackstone|basalt/, 0x4f4f55],
  [/stone|andesite|gravel|cobble|tuff/, 0x808080],
  [/granite/, 0x9a6b56],
  [/diorite|calcite|quartz/, 0xdcdcdc],
  [/grass|moss/, 0x6da544],
  [/leaves|vine|sapling|plant|cactus|fern|crop|wheat/, 0x3f8a2b],
  [/dirt|mud|podzol|farmland|soul/, 0x8a6344],
  [/sandstone|sand|end_stone/, 0xdacf9f],
  [
    /log|wood|planks|chest|barrel|crafting|fence|door|sign|ladder|bookshelf/,
    0x9c7f4e,
  ],
  [/netherrack|nether_brick|crimson/, 0x7a2f2f],
  [/brick|terracotta|clay/, 0xa0604c],
  [/iron|steel|anvil|hopper|rail/, 0xcfcfcf],
  [/gold/, 0xf5d142],
  [/diamond/, 0x5decf5],
  [/emerald/, 0x2fcf6a],
  [/redstone/, 0xb51b0a],
  [/lapis/, 0x2a4fb5],
  [/copper/, 0xc06c4f],
  [/snow|wool|bone/, 0xf2f2f2],
  [/furnace|dispenser|dropper|observer|piston/, 0x6e6e6e],
];

/**
 * A colour for each block. The game's own map colours where the turtle data has them (the 1.20.1 set: MapColor per
 * block; they fit every version's vanilla blocks), ores and CC blocks in colours of their own, any other block from
 * what its name says it is made of, and a steady colour picked from the name when nothing fits.
 */
export class BlockColours {
  private readonly map = new Map<string, number>();
  private readonly loaded = new Set<string>();
  private readonly known = new Map<string, { rgb: number; alpha: number }>();

  /** `dataDirs`: folders that may hold the 1.20.1 data files (`<rom>/rom/ccsim/turtle/data/1.20.1`). */
  constructor(private readonly dataDirs: readonly string[]) {}

  private load(namespace: string): void {
    if (this.loaded.has(namespace)) return;
    this.loaded.add(namespace);
    if (!/^[\w.-]+$/.test(namespace)) return;
    for (const dir of this.dataDirs) {
      const file = join(dir, `${namespace}.lua`);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const start = text.indexOf("\nmapColours={");
      if (start < 0) return;
      const end = text.indexOf("\n},", start);
      const lines = text.slice(start, end < 0 ? undefined : end).split("\n");
      for (const line of lines) {
        // ["minecraft:stone"]=7368816,   or   ["minecraft:oak_log"]={by={"axis",},default=8476209,values={y=9402184,},},
        const m = /^\["([^"]+)"\]=(?:(\d+)|\{.*?default=(\d+))/.exec(line);
        if (m) this.map.set(m[1]!, Number(m[2] ?? m[3]));
      }
      return;
    }
  }

  colour(name: string): { rgb: number; alpha: number } {
    const hit = this.known.get(name);
    if (hit) return hit;
    const made = this.make(name);
    this.known.set(name, made);
    return made;
  }

  private make(name: string): { rgb: number; alpha: number } {
    const path = name.slice(name.indexOf(":") + 1);
    const dye = Object.keys(DYES)
      .sort((a, b) => b.length - a.length)
      .find((d) => path.startsWith(`${d}_`));
    for (const [re, rgb, alpha] of OWN_COLOURS)
      if (re.test(name)) {
        if (rgb === 0 && dye) return { rgb: DYES[dye]!, alpha: alpha ?? 1 };
        if (rgb !== 0) return { rgb, alpha: alpha ?? 1 };
      }
    this.load(
      name.includes(":") ? name.slice(0, name.indexOf(":")) : "minecraft",
    );
    const mapped = this.map.get(name);
    if (mapped) return { rgb: mapped, alpha: 1 };
    if (dye) return { rgb: DYES[dye]!, alpha: 1 };
    for (const [re, rgb] of BY_WORD)
      if (re.test(path)) return { rgb, alpha: 1 };
    // nothing fits: a colour that is the same every time for this name
    let hash = 0;
    for (let i = 0; i < name.length; i++)
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return { rgb: hsl(hash % 360, 0.4, 0.55), alpha: 1 };
  }
}

function hsl(h: number, s: number, l: number): number {
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Where the 1.20.1 block data can be: in the default ROM, and in any other ROM under the ROMs folder. */
function colourDirs(config: RunnerConfig): string[] {
  const roms = new Set<string>([config.romDir]);
  const romsDir = (config as { romsDir?: string }).romsDir;
  if (romsDir && existsSync(romsDir))
    for (const name of readdirSync(romsDir)) roms.add(join(romsDir, name));
  return [...roms].map((rom) =>
    join(rom, "rom", "ccsim", "turtle", "data", "1.20.1"),
  );
}

// ───────────────────────── the block world ─────────────────────────

const FACINGS = ["", "north", "east", "south", "west", "up", "down"];

/** What `GET /api/sessions/<id>/blocks` answers. */
export interface BlocksReply {
  /** The number of the last block change in this answer: ask for what came after it with `?since=`. */
  seq: number;
  /** True: the whole world, drop what you had. False: only the blocks changed after `since`. */
  full: boolean;
  /** Block ids the numbers in this answer stand for, with a colour (0xRRGGBB) and how solid each looks (0..1). */
  names: string[];
  colours: number[];
  alphas: number[];
  /** Five numbers a block: x, y, z, its place in `names` (-1 for air), its facing (0 none, 1 north, 2 east, 3 south, 4 west, 5 up, 6 down). */
  blocks: number[];
  /** Computers and turtles among `blocks`. */
  computers: {
    x: number;
    y: number;
    z: number;
    id: number;
    label?: string;
    on: boolean;
  }[];
  /** Where each turtle went, by computer id: x, y, z of every step (after `since`). */
  trails: Record<string, number[]>;
  /** The computer the world started with. */
  main: number | null;
  /** Only when `full`: the world file's ground and its boxes of one block (name -1: a box of air), in order. */
  ground?: { y: number; name: number; top: number } | null;
  fills?: number[][];
}

const xyz = (key: string): [number, number, number] =>
  key.split(",").map(Number) as [number, number, number];

const blockId = (name: string): string =>
  name.includes(":") ? name : `minecraft:${name}`;

/** The block world for a viewer: all of it, or (with `since`, when the host still remembers that far) what changed. */
export function blocksReply(
  host: BlockWorldHost,
  colours: BlockColours,
  since?: number,
): BlocksReply {
  // read before the blocks: a change that lands meanwhile is then sent again next time, never lost
  const seq = host.changeCount;
  const changed = since === undefined ? undefined : host.changesSince(since);
  const full = changed === undefined;
  const names: string[] = [];
  const index = new Map<string, number>();
  const nameIndex = (name: string): number => {
    const id = blockId(name);
    let i = index.get(id);
    if (i === undefined) {
      i = names.length;
      names.push(id);
      index.set(id, i);
    }
    return i;
  };
  const blocks: number[] = [];
  const computers: BlocksReply["computers"] = [];
  const add = (key: string, def: BlockDef | false): void => {
    const [x, y, z] = xyz(key);
    if (!def || !def.name) {
      blocks.push(x, y, z, -1, 0);
      return;
    }
    const facing = FACINGS.indexOf(String(def.state?.["facing"] ?? ""));
    blocks.push(x, y, z, nameIndex(def.name), Math.max(facing, 0));
    const id = def.blockEntity?.ComputerId;
    if (typeof id === "number")
      computers.push({
        x,
        y,
        z,
        id,
        ...(typeof def.blockEntity?.label === "string" && {
          label: def.blockEntity.label,
        }),
        on: def.blockEntity?.on === true,
      });
  };
  for (const [key, def] of changed ?? host.blockEntries()) add(key, def);
  const trails: Record<string, number[]> = {};
  for (const [id, steps] of host.trailsSince(full ? 0 : since!))
    trails[String(id)] = steps.flatMap(xyz);
  const reply: BlocksReply = {
    seq,
    full,
    names,
    colours: [],
    alphas: [],
    blocks,
    computers,
    trails,
    main: host.mainId ?? null,
  };
  if (full) {
    const base = host.baseWorld;
    reply.ground =
      typeof base.ground === "object" && base.ground
        ? {
            y: base.ground.y ?? 63,
            name: nameIndex(base.ground.name ?? "minecraft:stone"),
            top: nameIndex(
              base.ground.top ?? base.ground.name ?? "minecraft:stone",
            ),
          }
        : null;
    reply.fills = (base.fills ?? []).map((f) => {
      const a = corner(f.from);
      const b = corner(f.to);
      const air = !f.name || blockId(f.name) === "minecraft:air";
      return [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.min(a[2], b[2]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
        Math.max(a[2], b[2]),
        air ? -1 : nameIndex(f.name!),
      ];
    });
  }
  for (const name of names) {
    const c = colours.colour(name);
    reply.colours.push(c.rgb);
    reply.alphas.push(c.alpha);
  }
  return reply;
}

function corner(value: unknown): [number, number, number] {
  const v = (value ?? {}) as Record<string, unknown>;
  const pick = (i: number, k: string): number => Number(v[i] ?? v[k] ?? 0);
  return [pick(0, "x"), pick(1, "y"), pick(2, "z")];
}

// ───────────────────────── networks ─────────────────────────

const REDNET_BROADCAST = 65535;
const REDNET_REPEAT = 65533;
/** Messages a network's log keeps; older ones are dropped. */
const LOG_LENGTH = 3000;
/** A message's payload is kept whole up to this many characters, so the page can show all of it. */
const PAYLOAD_LIMIT = 200_000;
const NODES_FRESH_MS = 400;

type ModemKind = "wireless" | "ender" | "wired";

interface ModemInfo {
  name: string;
  kind: ModemKind;
  /** Wired: the cable network it is on. */
  net?: string;
  /** The channels it has open, when the computer has said. */
  channels?: number[];
}

/** One computer of a network, as the page draws it. */
export interface NetworkNode {
  name: string;
  /** Its session in the app, when it has one (a computer a turtle placed has none). */
  session?: string;
  id: number;
  label?: string;
  running: boolean;
  x: number;
  y: number;
  z: number;
  dimension: string;
  modems: ModemInfo[];
}

/** One packet a modem sent, as the page lists it. */
export interface NetworkMessage {
  seq: number;
  /** When the relay saw it, ms since 1970. */
  at: number;
  from: string;
  /** The side or name of the modem that sent it. */
  modem: string;
  kind: ModemKind;
  channel: number;
  reply: number;
  /** The computers that heard it: in reach, on the same kind of modem, with the channel open. */
  to: string[];
  /** A rednet message: who it is for (a computer id, or "everyone"), its protocol, and whether this is the copy rednet sends for repeaters. */
  rednet?: { to: number | "everyone"; protocol?: string; repeat: boolean };
  preview: string;
  /** Characters in the encoded message. */
  size: number;
}

interface Stored extends NetworkMessage {
  packet: {
    x: number;
    y: number;
    z: number;
    dimension: string;
    range: number;
    ender: boolean;
    net?: string;
    sender: string;
  };
  payload: string;
  cut: boolean;
  heardKnown: boolean;
}

/** WirelessModemPeripheral.getRange with the default config and clear weather (ccsim/modem.lua rangeOf). */
function wirelessRange(y: number, dimension: string): number {
  const low = 64;
  const high = 384;
  if (y <= 96) return low;
  const top = dimension === "minecraft:overworld" ? 320 : 256;
  return low + (y - 96) * ((high - low) / (top - 1 - 96));
}

function reaches(
  a: { x: number; y: number; z: number; dimension: string },
  aKind: ModemKind,
  aRange: number,
  b: NetworkNode,
  bModem: ModemInfo,
  aNet?: string,
): boolean {
  if ((aKind === "wired") !== (bModem.kind === "wired")) return false;
  if (aKind === "wired")
    return !!aNet && aNet === bModem.net && a.dimension === b.dimension;
  const ender = aKind === "ender" || bModem.kind === "ender";
  if (a.dimension !== b.dimension) return ender;
  if (ender) return true;
  const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
  const reach = Math.max(aRange, wirelessRange(b.y, b.dimension));
  return d2 <= reach * reach;
}

/** The packets of one network, kept as they are sent (ComputerNetwork.onPacket). */
export class NetworkLog {
  private messages: Stored[] = [];
  private seq = 0;
  private cached: { at: number; nodes: NetworkNode[] } | undefined;

  constructor(
    readonly name: string,
    private readonly network: ComputerNetwork,
    /** The app session of the computer with this name on the network, if it has one. */
    private readonly sessionOf: (computer: string) => string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    network.onPacket = (from, packet) => this.add(from, packet);
  }

  /** Stop listening (the network's computers are gone). */
  close(): void {
    this.network.onPacket = undefined;
  }

  private add(from: string, text: string): void {
    const packet = decodePacket(text, 2);
    if (typeof packet !== "object" || packet === null || Array.isArray(packet))
      return;
    const num = (key: string): number => Number(packet[key] ?? 0);
    const str = (key: string): string => String(packet[key] ?? "");
    const kind = (["wireless", "ender", "wired"] as const).includes(
      str("kind") as ModemKind,
    )
      ? (str("kind") as ModemKind)
      : "wireless";
    const whole = str("payload");
    const cut = whole.length > PAYLOAD_LIMIT;
    const message = cut ? undefined : decodePacket(whole);
    const sender = str("sender");
    const stored: Stored = {
      seq: ++this.seq,
      at: this.now(),
      from,
      modem: sender.slice(sender.indexOf("/") + 1),
      kind: packet["ender"] === true ? "ender" : kind,
      channel: num("channel"),
      reply: num("reply"),
      to: [],
      preview: "",
      size: whole.length,
      packet: {
        x: num("x"),
        y: num("y"),
        z: num("z"),
        dimension: str("dimension") || "minecraft:overworld",
        range: num("range"),
        ender: packet["ender"] === true,
        ...(typeof packet["net"] === "string" && { net: packet["net"] }),
        sender,
      },
      payload: cut ? "" : whole,
      cut,
      heardKnown: false,
    };
    // rednet.send: { nMessageID, nRecipient, nSender, message, sProtocol }, once on the recipient's channel and once
    // on the repeat channel
    if (
      message !== undefined &&
      typeof message === "object" &&
      message !== null &&
      !Array.isArray(message) &&
      typeof message["nMessageID"] === "number" &&
      typeof message["nRecipient"] === "number"
    ) {
      stored.rednet = {
        to:
          message["nRecipient"] === REDNET_BROADCAST
            ? "everyone"
            : message["nRecipient"],
        ...(typeof message["sProtocol"] === "string" && {
          protocol: message["sProtocol"],
        }),
        repeat:
          stored.channel === REDNET_REPEAT &&
          message["nRecipient"] !== REDNET_REPEAT,
      };
      stored.preview = luaPreview(message["message"] ?? null);
    } else if (message !== undefined) stored.preview = luaPreview(message);
    else stored.preview = `(a large message: ${whole.length} characters)`;
    this.messages.push(stored);
    if (this.messages.length > 2 * LOG_LENGTH)
      this.messages = this.messages.slice(-LOG_LENGTH);
  }

  /** The computers as they are now. Reading each one's state costs a file read, so the answer is kept a moment. */
  nodes(): NetworkNode[] {
    const now = this.now();
    if (this.cached && now - this.cached.at < NODES_FRESH_MS)
      return this.cached.nodes;
    const nodes = this.network.computers().map((c): NetworkNode => {
      const world: WorldConfig = c.world;
      const state = (c.handle.readState() ?? {}) as Record<string, unknown>;
      const at = computerPosition(world);
      const turtle = (state["turtle"] ??
        world.turtle ??
        world.placed ??
        {}) as Partial<typeof at>;
      const moved = (state["position"] ?? {}) as Partial<typeof at>;
      const modems = new Map<string, ModemInfo>();
      for (const spec of modemsOf(world)) {
        const net = (spec as { net?: unknown }).net;
        modems.set(spec.name, {
          name: spec.name,
          kind: spec.kind ?? "wireless",
          ...(typeof net === "string" && { net }),
        });
      }
      // what the computer itself says of its modems: the channels open now, and modems the world file does not list
      // (a turtle's modem upgrade, a modem block next to a placed computer)
      const said = (state["peripherals"] ?? {}) as Record<string, unknown>;
      for (const [name, value] of Object.entries(said)) {
        const p = value as {
          kind?: unknown;
          channels?: unknown;
          net?: unknown;
        };
        if (
          p?.kind !== "wireless" &&
          p?.kind !== "ender" &&
          p?.kind !== "wired"
        )
          continue;
        if (!Array.isArray(p.channels) && !modems.has(name)) continue;
        const known = modems.get(name);
        modems.set(name, {
          name,
          kind: p.kind,
          ...(typeof p.net === "string"
            ? { net: p.net }
            : known?.net !== undefined && { net: known.net }),
          ...(Array.isArray(p.channels) && {
            channels: (p.channels as unknown[]).map(Number),
          }),
        });
      }
      const session = this.sessionOf(c.name);
      const label =
        typeof state["label"] === "string" ? state["label"] : world.label;
      return {
        name: c.name,
        ...(session !== undefined && { session }),
        id: world.computerId ?? 0,
        ...(label !== undefined && { label }),
        running: c.handle.session.running,
        x: Number(moved.x ?? turtle.x ?? at.x),
        y: Number(moved.y ?? turtle.y ?? at.y),
        z: Number(moved.z ?? turtle.z ?? at.z),
        dimension: String(moved.dimension ?? turtle.dimension ?? at.dimension),
        modems: [...modems.values()],
      };
    });
    this.cached = { at: now, nodes };
    return nodes;
  }

  /** Which pairs of computers can hear each other at all, one entry for each kind of modem that joins them. */
  links(nodes: NetworkNode[]): { a: string; b: string; kind: ModemKind }[] {
    const out: { a: string; b: string; kind: ModemKind }[] = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const [a, b] = [nodes[i]!, nodes[j]!];
        const kinds = new Set<ModemKind>();
        for (const ma of a.modems)
          for (const mb of b.modems)
            if (
              reaches(
                a,
                ma.kind,
                wirelessRange(a.y, a.dimension),
                b,
                mb,
                ma.net,
              )
            )
              kinds.add(
                ma.kind === "wired"
                  ? "wired"
                  : ma.kind === "ender" || mb.kind === "ender"
                    ? "ender"
                    : "wireless",
              );
        for (const kind of kinds) out.push({ a: a.name, b: b.name, kind });
      }
    return out;
  }

  private heard(message: Stored, nodes: NetworkNode[]): void {
    if (message.heardKnown) return;
    message.heardKnown = true;
    const p = message.packet;
    const kind: ModemKind = p.ender ? "ender" : message.kind;
    message.to = nodes
      .filter(
        (node) =>
          node.name !== message.from &&
          node.running &&
          node.modems.some(
            (modem) =>
              reaches(p, kind, p.range, node, modem, p.net) &&
              (!modem.channels || modem.channels.includes(message.channel)),
          ),
      )
      .map((node) => node.name);
  }

  /** The network for the page: its computers, what joins them, and the messages after number `since` (500 at most). */
  view(since = 0): {
    name: string;
    seq: number;
    /** Messages after `since` that are not in this answer: dropped from the log, or more than one answer holds. */
    missed: number;
    nodes: NetworkNode[];
    links: { a: string; b: string; kind: ModemKind }[];
    messages: NetworkMessage[];
  } {
    const nodes = this.nodes();
    let fresh = this.messages.filter((m) => m.seq > since);
    const wanted = this.seq - Math.min(since, this.seq);
    fresh = fresh.slice(-500);
    for (const m of fresh) this.heard(m, nodes);
    return {
      name: this.name,
      seq: this.seq,
      missed: wanted - fresh.length,
      nodes,
      links: this.links(nodes),
      messages: fresh.map(
        ({ packet: _p, payload: _t, cut: _c, heardKnown: _h, ...m }) => m,
      ),
    };
  }

  /** One message with all of what it carried. */
  message(
    seq: number,
  ):
    | (NetworkMessage & { message: LuaValue; distanceFrom: Stored["packet"] })
    | undefined {
    const found = this.messages.find((m) => m.seq === seq);
    if (!found) return undefined;
    this.heard(found, this.nodes());
    const { packet, payload, cut, heardKnown: _h, ...m } = found;
    return {
      ...m,
      message: cut
        ? `(too large to keep: ${found.size} characters)`
        : decodePacket(payload),
      distanceFrom: packet,
    };
  }
}

// ───────────────────────── the routes ─────────────────────────

export interface Views {
  /**
   * What the session list says of each computer for the views: has it a block world, which network is it on, and for
   * a computer a turtle placed, its name, what it is and the session of the world it stands in.
   */
  summary(session: Session): {
    blocks: boolean;
    network: string | null;
    placedBy: string | null;
    name?: string;
    kind?: "computer" | "turtle";
  };
  /**
   * A session and, after it, the computers placed and turned on in its block world. Each of those is a session to
   * the app too, `<session>-p<computer id>`, so the page can show its screen and type on it.
   */
  withPlaced(session: Session): Session[];
  /** The placed computer with this id (`<session>-p<computer id>`), or undefined for any other id. */
  find(id: string): Session | undefined;
  /** `/api/networks...`. True when the request was one of these and has been answered. */
  route(method: string, path: string, url: URL, res: ServerResponse): boolean;
  /** `/api/sessions/<id>/blocks`. True when answered. */
  sessionRoute(
    session: Session,
    method: string,
    sub: string,
    url: URL,
    res: ServerResponse,
  ): boolean;
}

export function createViews(options: {
  sessions: SessionManager;
  config: RunnerConfig;
  /** Answer with JSON (webapp.ts's own). */
  json: (res: ServerResponse, value: unknown, status?: number) => void;
}): Views {
  const { sessions, json } = options;
  const colours = new BlockColours(colourDirs(options.config));
  const logs = new Map<ComputerNetwork, NetworkLog>();
  // a block world's computers are a network too: world1, world2, ... in the order they are first seen
  const worldNames = new Map<string, string>();
  const worldName = (sessionId: string): string => {
    let name = worldNames.get(sessionId);
    if (!name) {
      name = `world${worldNames.size + 1}`;
      worldNames.set(sessionId, name);
    }
    return name;
  };

  /** Every network there is now: the ones started as networks, and each block world with the computers placed in it. */
  const networks = (): Map<string, NetworkLog> => {
    const live = new Map<string, NetworkLog>();
    const keep = (
      name: string,
      network: ComputerNetwork,
      sessionOf: (computer: string) => string | undefined,
    ): void => {
      let log = logs.get(network);
      if (!log) {
        log = new NetworkLog(name, network, sessionOf);
        logs.set(network, log);
      }
      live.set(name, log);
    };
    for (const n of sessions.listNetworks())
      keep(n.name, n.network, (computer) => n.computers.get(computer));
    for (const s of sessions.list()) {
      const session = sessions.get(s.id);
      const world = session.blockWorld;
      if (world)
        keep(worldName(session.id), world.network, (computer) => {
          if (computer === "main") return session.id;
          const placed = world.host
            .computers()
            .find((c) => c.name === computer);
          return placed && `${session.id}-p${placed.id}`;
        });
    }
    for (const [network, log] of logs)
      if (![...live.values()].includes(log)) {
        log.close();
        logs.delete(network);
      }
    return live;
  };

  const networkOf = (session: Session): string | null => {
    for (const n of sessions.listNetworks())
      if ([...n.computers.values()].includes(session.id)) return n.name;
    // a turtle's world is a network once something it placed runs beside it
    if (session.blockWorld && session.blockWorld.network.computers().length > 1)
      return worldName(session.id);
    return null;
  };

  const PLACED = /^(\w+)-p(\d+)$/;
  const placedIn = (parent: Session): Session[] =>
    (parent.blockWorld?.host.computers() ?? [])
      .filter((c) => c.handle.session.running)
      .map((c) => ({
        id: `${parent.id}-p${c.id}`,
        handle: c.handle,
        createdAt: parent.createdAt,
      }));

  return {
    summary(session) {
      networks(); // a network is listened to from the first time anyone lists the computers
      const placed = PLACED.exec(session.id);
      if (placed) {
        const parent = sessions.get(placed[1]!);
        const computer = parent.blockWorld?.host
          .computers()
          .find((c) => c.id === Number(placed[2]));
        const block = computer && parent.blockWorld?.host.blockAt(computer.pos);
        const kind =
          block && /^computercraft:turtle_/.test(block.name ?? "")
            ? "turtle"
            : "computer";
        const label = block ? block.blockEntity?.label : undefined;
        return {
          blocks: false,
          network: worldName(parent.id),
          placedBy: parent.id,
          name: typeof label === "string" ? label : `${kind} ${placed[2]}`,
          kind,
        };
      }
      return {
        blocks: !!session.blockWorld,
        network: networkOf(session),
        placedBy: null,
      };
    },

    withPlaced(session) {
      return [session, ...placedIn(session)];
    },

    find(id) {
      const placed = PLACED.exec(id);
      if (!placed) return undefined;
      let parent: Session;
      try {
        parent = sessions.get(placed[1]!);
      } catch {
        return undefined;
      }
      return placedIn(parent).find((s) => s.id === id);
    },

    route(method, path, url, res) {
      if (method !== "GET" || !path.startsWith("/api/networks")) return false;
      const live = networks();
      if (path === "/api/networks") {
        json(
          res,
          [...live.values()].map((log) => ({
            name: log.name,
            computers: log
              .nodes()
              .map((n) => ({ name: n.name, session: n.session ?? null })),
          })),
        );
        return true;
      }
      const m = /^\/api\/networks\/([\w-]+)(?:\/messages\/(\d+))?$/.exec(path);
      const log = m && live.get(m[1]!);
      if (!m || !log) {
        json(res, { error: "no such network" }, 404);
        return true;
      }
      if (m[2] !== undefined) {
        const message = log.message(Number(m[2]));
        if (message) json(res, message);
        else json(res, { error: "that message is no longer in the log" }, 404);
        return true;
      }
      json(res, log.view(Number(url.searchParams.get("since")) || 0));
      return true;
    },

    sessionRoute(session, method, sub, url, res) {
      if (method !== "GET" || sub !== "/blocks") return false;
      if (!session.blockWorld) {
        json(res, { error: "this computer has no block world" }, 404);
        return true;
      }
      const since = url.searchParams.get("since");
      json(
        res,
        blocksReply(
          session.blockWorld.host,
          colours,
          since === null || since === "" ? undefined : Number(since),
        ),
      );
      return true;
    },
  };
}
