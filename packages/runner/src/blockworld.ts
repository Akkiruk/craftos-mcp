import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunnerConfig } from "./config.js";
import { type EngineHandle, makeRuntimeDir, startEngine } from "./engine.js";
import { monitorSetupLua } from "./lua.js";
import { mobComputer } from "./mobs.js";
import { ComputerNetwork, linkedWorlds } from "./network.js";
import { type RemotePeripheral, remoteOrder } from "./wired.js";
import type { WorldConfig } from "./world.js";

/** Start a computer in a block world, with the host that relays its changes and starts the computers it places. */
export function startInBlockWorld(
  config: RunnerConfig,
  bootLua: string,
  options: { label?: string; timeScale?: number; world: WorldConfig },
): { handle: EngineHandle; network: ComputerNetwork; host: BlockWorldHost } {
  const world = linkedWorlds([{ world: options.world }])[0]!;
  const network = new ComputerNetwork();
  const host = new BlockWorldHost(
    config,
    world,
    network,
    options.timeScale ?? 1,
  );
  network.attachBlockWorld(host);
  const handle = startEngine(config, bootLua, {
    label: options.label ?? "run",
    timeScale: options.timeScale ?? 1,
    world,
    shared: host.sharedFor(),
  });
  network.add("main", handle, world);
  host.setMain(handle, world.computerId ?? 0);
  return { handle, network, host };
}

/*
 * A block world shared by several computers (docs/turtle.md, "What a turtle builds comes alive"). Every computer's sim
 * keeps its own copy of the blocks and sends what it changes as `W<x,y,z>\t<json>` lines; this host keeps the
 * authoritative copy, passes changes to the other computers as `ccsim_world` events, and starts a computer block's or
 * turtle's own engine when something turns it on. It also holds what the world holds once for everyone: the computer
 * and disk counters (IDAssigner), the wired networks the cables make, and the screens of monitor walls.
 */

/** A world that has blocks: a turtle, a placed computer, or blocks around a computer. */
export function isBlockWorld(world: WorldConfig | undefined): boolean {
  return !!(
    world?.turtle ||
    world?.placed ||
    mobComputer(world as Record<string, unknown> | undefined) ||
    world?.blocks ||
    world?.fills ||
    world?.ground
  );
}

interface BlockDef {
  name?: string;
  state?: Record<string, string>;
  items?: Record<string, Record<string, unknown>>;
  blockEntity?: Record<string, unknown> & {
    ComputerId?: number;
    label?: string;
    on?: boolean;
  };
  [extra: string]: unknown;
}

const COMPUTER = /^computercraft:computer_(normal|advanced)$/;
const TURTLE = /^computercraft:turtle_(normal|advanced)$/;
const MONITOR = /^computercraft:monitor_(normal|advanced)$/;
const CABLE = "computercraft:cable";
const FULL_MODEM = "computercraft:wired_modem_full";
const isComputer = (name: string | undefined): boolean =>
  !!name && (COMPUTER.test(name) || TURTLE.test(name));

/** A computer block's or turtle's own engine, started when it was turned on. */
export interface PlacedComputer {
  readonly name: string;
  readonly id: number;
  /** Where it stands now: a turtle moves. */
  pos: string;
  readonly handle: EngineHandle;
}

const DIRS: Record<string, [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
};
const OPPOSITE: Record<string, string> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
  up: "down",
  down: "up",
};

function step(key: string, dir: string): string {
  const [x, y, z] = key.split(",").map(Number) as [number, number, number];
  const [dx, dy, dz] = DIRS[dir]!;
  return `${x + dx},${y + dy},${z + dz}`;
}

/** The face a cable's modem is on, or undefined. */
function cableModem(def: BlockDef): string | undefined {
  const m = def.state?.modem;
  if (!m || m === "none") return undefined;
  return m.split("_")[0];
}

/** BlockCable.canConnectIn and a full modem's six faces: is there a wired element on this face? */
function connectsIn(def: BlockDef | false | undefined, dir: string): boolean {
  if (!def) return false;
  if (def.name === FULL_MODEM) return true;
  return (
    def.name === CABLE &&
    def.state?.cable !== "false" &&
    cableModem(def) !== dir
  );
}

/** A monitor's place in its wall (TileMonitor XIndex, YIndex, Width, Height). */
function wallOf(
  def: BlockDef | false | undefined,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!def || !def.name || !MONITOR.test(def.name)) return undefined;
  const be = def.blockEntity ?? {};
  return {
    x: Number(be.XIndex ?? 0),
    y: Number(be.YIndex ?? 0),
    w: Number(be.Width ?? 1),
    h: Number(be.Height ?? 1),
  };
}

/** One monitor wall's screen: the calls since it was last cleared, and enough state to clear it again. */
interface ScreenLog {
  ops: string[];
  scale?: string;
  palette: Map<string, string>;
  text?: string;
  back?: string;
  blink?: string;
  cx: number;
  cy: number;
}

const unescape = (s: string): string =>
  s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );

export class BlockWorldHost {
  /** Blocks the world file set and every change since: "x,y,z" -> block, or false for air. */
  private readonly blocks = new Map<string, BlockDef | false>();
  private nextId: number;
  private nextDiskId: number;
  readonly sharedDir: string;
  readonly diskDir: string;
  private readonly placed = new Map<string, PlacedComputer>();
  private readonly stopped: PlacedComputer[] = [];
  private main: { handle: EngineHandle; id: number } | undefined;
  /** Wired modem names on the network, `computer_<n>` per modem block, as the peripheral counter hands them out. */
  private readonly localNames = new Map<string, string>();
  private nextLocalName = 0;
  private readonly topologySent = new Map<number, string>();
  private topologyDirty = true;
  private readonly screens = new Map<string, ScreenLog>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly base: WorldConfig,
    private readonly network: ComputerNetwork,
    private readonly timeScale = 1,
  ) {
    this.sharedDir = makeRuntimeDir(config, "blockworld");
    this.diskDir = join(this.sharedDir, "disk");
    mkdirSync(this.diskDir, { recursive: true });
    for (const [id, files] of Object.entries(base.disks ?? {})) {
      for (const [path, text] of Object.entries(files)) {
        const file = join(this.diskDir, String(id), path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    }
    let maxId = base.computerId ?? 0;
    for (const b of base.blocks ?? []) {
      const key = `${b.x},${b.y},${b.z}`;
      const def = (b.name && b.name !== "minecraft:air" ? { ...b } : false) as
        | BlockDef
        | false;
      this.blocks.set(key, def);
      const id = def ? def.blockEntity?.ComputerId : undefined;
      if (typeof id === "number") maxId = Math.max(maxId, id);
    }
    this.nextId = maxId + 1;
    // IDAssigner "disk": the world's ids.json counter, 0 in a new world
    this.nextDiskId = base.nextDiskId ?? 0;
  }

  /** The computer the run started with. */
  setMain(handle: EngineHandle, id: number): void {
    this.main = { handle, id };
    this.topologyDirty = true;
  }

  /** The shared folders a computer of this world gets. */
  sharedFor(
    computerId?: number,
    fresh = false,
  ): { diskDir: string; computerDir?: string; fresh?: boolean } {
    return {
      diskDir: this.diskDir,
      ...(computerId !== undefined && {
        computerDir: join(this.sharedDir, "computers", String(computerId)),
      }),
      ...(fresh && { fresh }),
    };
  }

  /** The world file a computer of this world starts from: the base, with every block as it stands now. */
  private worldNow(): WorldConfig {
    const blocks: NonNullable<WorldConfig["blocks"]> = [];
    for (const [key, def] of this.blocks) {
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      if (def) blocks.push({ ...(def as object), x, y, z } as never);
      else blocks.push({ x, y, z, name: "minecraft:air" });
    }
    const { turtle: _turtle, placed: _placed, ...rest } = this.base;
    return { ...rest, blocks };
  }

  /** Lines a computer sent: store them and return the lines every other computer gets, and those everyone gets. */
  onLines(lines: string[]): { relay: string[]; toAll: string[] } {
    const relay: string[] = [];
    const toAll: string[] = [];
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const key = line.slice(0, tab);
      if (key.startsWith("screen:")) {
        this.onScreen(key.slice(7), line.slice(tab + 1), relay, toAll);
        continue;
      }
      let def: BlockDef | false;
      try {
        def = JSON.parse(line.slice(tab + 1)) as BlockDef | false;
      } catch {
        continue;
      }
      const before = this.blocks.get(key);
      const now = def && def.name ? def : false;
      this.blocks.set(key, now);
      relay.push(line);
      this.screenWallChanged(key, before, now);
      if (
        isWired(before) ||
        isWired(now) ||
        isComputer(before ? before.name : undefined) ||
        isComputer(now ? now.name : undefined)
      )
        this.topologyDirty = true;
      // a turtle that was placed and turned on, standing somewhere new: it moved
      const id = now ? now.blockEntity?.ComputerId : undefined;
      if (now && TURTLE.test(now.name!) && typeof id === "number") {
        for (const [at, computer] of this.placed) {
          if (computer.id === id && at !== key) {
            this.placed.delete(at);
            computer.pos = key;
            this.placed.set(key, computer);
          }
        }
      }
      const running = this.placed.get(key);
      if (
        running &&
        (!now ||
          !isComputer(now.name) ||
          now.blockEntity?.ComputerId !== running.id)
      ) {
        // the computer was dug up: it stops
        this.placed.delete(key);
        void running.handle.session.stop(0);
      }
    }
    this.publishTopology();
    return { relay, toAll };
  }

  /** `turnOn`, `shutdown`, `reboot` or `diskId` on the block at `pos`. Returns lines to send to every computer. */
  control(op: string, pos: string): string[] {
    const def = this.blocks.get(pos);
    if (op === "diskId") return this.numberDisk(pos, def);
    if (op === "topology") {
      // a computer that just started asks again: what was sent before its sim was ready is lost
      const id = def ? def.blockEntity?.ComputerId : undefined;
      if (typeof id === "number") this.topologySent.delete(id);
      this.topologyDirty = true;
      this.publishTopology();
      return [];
    }
    if (!def || !isComputer(def.name)) return [];
    const running = this.placed.get(pos);
    if (running && running.handle.session.running) {
      if (op === "reboot") running.handle.sendCommand({ cmd: "reboot" });
      if (op === "shutdown") running.handle.sendCommand({ cmd: "shutdown" });
      return [];
    }
    if (op !== "turnOn" && op !== "reboot") return [];
    return this.boot(pos, def);
  }

  /** ItemDisk.createDataMount: a blank floppy in a drive gets the world's next disk number. */
  private numberDisk(pos: string, def: BlockDef | false | undefined): string[] {
    if (!def || def.name !== "computercraft:disk_drive") return [];
    const disk = def.items?.["1"];
    if (
      !disk ||
      (disk.name !== "computercraft:disk" &&
        disk.name !== "computercraft:treasure_disk") ||
      typeof disk.diskId === "number"
    )
      return [];
    const numbered: BlockDef = {
      ...def,
      items: { ...def.items, "1": { ...disk, diskId: this.nextDiskId++ } },
    };
    this.blocks.set(pos, numbered);
    return [`${pos}\t${JSON.stringify(numbered)}`];
  }

  private boot(pos: string, def: BlockDef): string[] {
    const [x, y, z] = pos.split(",").map(Number) as [number, number, number];
    // TileComputerBase.createServerComputer: the first boot numbers it
    const id =
      typeof def.blockEntity?.ComputerId === "number"
        ? def.blockEntity.ComputerId
        : this.nextId++;
    const be = def.blockEntity ?? {};
    const dimension =
      this.base.position?.dimension ?? this.base.turtle?.dimension;
    const turtle = TURTLE.test(def.name!);
    const world: WorldConfig = {
      ...this.worldNow(),
      computerId: id,
      ...(turtle
        ? {
            turtle: {
              x,
              y,
              z,
              facing: (def.state?.facing ?? "north") as "north",
              advanced: def.name === "computercraft:turtle_advanced",
              fuel: typeof be.Fuel === "number" ? be.Fuel : 0,
              ...(typeof be.LeftUpgrade === "string" && {
                left: be.LeftUpgrade,
              }),
              ...(typeof be.RightUpgrade === "string" && {
                right: be.RightUpgrade,
              }),
              ...(dimension && { dimension }),
            },
          }
        : {
            placed: {
              x,
              y,
              z,
              facing: def.state?.facing ?? "north",
              block: def.name!,
              dimension,
            },
          }),
      position: {
        x,
        y,
        z,
        ...(this.base.position?.dimension && {
          dimension: this.base.position.dimension,
        }),
      },
      ...(typeof be.label === "string" && { label: be.label }),
      ...(this.base.seed !== undefined && { seed: this.base.seed + id + 1 }),
      modemLink: true,
    };
    const handle = startEngine(this.config, monitorSetupLua([]), {
      label: `${turtle ? "turtle" : "computer"}${id}`,
      timeScale: this.timeScale,
      world,
      shared: this.sharedFor(id, true),
    });
    const name = `computer_${id}`;
    const computer: PlacedComputer = { name, id, pos, handle };
    this.placed.set(pos, computer);
    this.network.add(name, handle, world);
    handle.session.on("exit", () => this.onExit(computer));
    const on: BlockDef = {
      ...def,
      ...(!turtle && { state: { ...(def.state ?? {}), state: "on" } }),
      blockEntity: { ...be, ComputerId: id, on: true },
    };
    this.blocks.set(pos, on);
    this.topologyDirty = true;
    this.publishTopology();
    return [`${pos}\t${JSON.stringify(on)}`];
  }

  private onExit(computer: PlacedComputer): void {
    if (this.placed.get(computer.pos) === computer)
      this.placed.delete(computer.pos);
    this.stopped.push(computer);
    const def = this.blocks.get(computer.pos);
    if (
      def &&
      isComputer(def.name) &&
      def.blockEntity?.ComputerId === computer.id
    ) {
      const off: BlockDef = {
        ...def,
        ...(COMPUTER.test(def.name!) && {
          state: { ...(def.state ?? {}), state: "off" },
        }),
        blockEntity: { ...(def.blockEntity ?? {}), on: false },
      };
      this.blocks.set(computer.pos, off);
      this.network.broadcastWorld([`${computer.pos}\t${JSON.stringify(off)}`]);
    }
    this.topologyDirty = true;
    this.publishTopology();
  }

  /** Every computer block that has been started, running or not. */
  computers(): PlacedComputer[] {
    return [...this.placed.values(), ...this.stopped];
  }

  // ===== wired networks (TileCable, TileWiredModemFull, WiredNetwork) =====

  /** The handle of the running computer with this id. */
  private handleOf(id: number): EngineHandle | undefined {
    if (this.main && this.main.id === id) return this.main.handle;
    for (const c of this.placed.values()) if (c.id === id) return c.handle;
    return undefined;
  }

  /**
   * Work out the wired networks from the blocks and tell every running computer what its block modems reach, under
   * the name `@x,y,z` of the modem block (ccsim/turtle/brain.lua gives each to the side it is on).
   */
  private publishTopology(): void {
    if (!this.topologyDirty) return;
    this.topologyDirty = false;
    const wired = new Map<string, BlockDef>();
    for (const [key, def] of this.blocks)
      if (def && isWired(def)) wired.set(key, def as BlockDef);

    // blocks join where both faces have a wired element
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let p = parent.get(k) ?? k;
      if (p !== k) {
        p = find(p);
        parent.set(k, p);
      }
      return p;
    };
    const links = new Map<string, string[]>();
    for (const [key, def] of wired) {
      for (const dir of Object.keys(DIRS)) {
        const next = step(key, dir);
        const other = wired.get(next);
        if (connectsIn(def, dir) && connectsIn(other, OPPOSITE[dir]!)) {
          parent.set(find(key), find(next));
          links.set(key, [...(links.get(key) ?? []), next]);
        }
      }
    }

    // every modem face touching a computer: the computer sees a wired modem on that side
    interface Attachment {
      block: string;
      id: number;
      at: string;
      shared: boolean;
      label?: string;
    }
    const attachments: Attachment[] = [];
    for (const [key, def] of wired) {
      const faces =
        def.name === FULL_MODEM
          ? Object.keys(DIRS)
          : cableModem(def)
            ? [cableModem(def)!]
            : [];
      const shared =
        def.name === FULL_MODEM
          ? def.state?.peripheral === "true"
          : (def.state?.modem ?? "").endsWith("_peripheral");
      for (const face of faces) {
        const at = step(key, face);
        const computer = this.blocks.get(at);
        const id = computer ? computer.blockEntity?.ComputerId : undefined;
        if (!computer || !isComputer(computer.name) || typeof id !== "number")
          continue;
        attachments.push({
          block: key,
          id,
          at,
          shared,
          ...(typeof computer.blockEntity?.label === "string" && {
            label: computer.blockEntity.label,
          }),
        });
      }
    }
    const nameOf = (a: Attachment): string => {
      const k = `${a.block}>${a.at}`;
      let name = this.localNames.get(k);
      if (!name) {
        name = `computer_${this.nextLocalName++}`;
        this.localNames.set(k, name);
      }
      return name;
    };
    const stepsFrom = (start: string): Map<string, number> => {
      const steps = new Map([[start, 0]]);
      const queue = [start];
      for (const k of queue)
        for (const n of links.get(k) ?? [])
          if (!steps.has(n)) {
            steps.set(n, steps.get(k)! + 1);
            queue.push(n);
          }
      return steps;
    };

    const perComputer = new Map<number, Record<string, unknown>>();
    for (const a of attachments) {
      const net = `blocks:${find(a.block)}`;
      const routes = stepsFrom(a.block);
      const peers: Record<string, [number, number]> = {};
      const remotes: RemotePeripheral[] = [];
      const localName = a.shared ? nameOf(a) : undefined;
      for (const o of attachments) {
        if (o === a || find(o.block) !== find(a.block)) continue;
        const steps = routes.get(o.block);
        // the other computer is one block from its modem, and so is this one
        if (steps !== undefined) peers[`${o.id}@${o.block}`] = [1 + steps, 1];
        if (o.shared && nameOf(o) !== localName)
          remotes.push({
            name: nameOf(o),
            type: "computer",
            id: o.id,
            label: o.label,
            running: this.handleOf(o.id)?.session.running ?? false,
          });
      }
      const modems = perComputer.get(a.id) ?? {};
      modems[`@${a.block}`] = {
        key: `${a.id}@${a.block}`,
        net,
        on: a.shared,
        ...(localName && { localName }),
        peers,
        remotes: remoteOrder(remotes),
      };
      perComputer.set(a.id, modems);
    }
    const ids = new Set<number>([
      ...perComputer.keys(),
      ...this.topologySent.keys(),
    ]);
    for (const id of ids) {
      const modems = perComputer.get(id) ?? {};
      const text = JSON.stringify(modems);
      if (this.topologySent.get(id) === text) continue;
      const handle = this.handleOf(id);
      if (!handle || !handle.session.running) {
        this.topologySent.delete(id);
        continue;
      }
      this.topologySent.set(id, text);
      if (Object.keys(modems).length > 0)
        handle.sendCommand({ cmd: "modemTopology", modems });
    }
  }

  // ===== monitor walls: one screen each, kept here (ccsim/turtle/screens.lua) =====

  private screen(wall: string): ScreenLog {
    let log = this.screens.get(wall);
    if (!log) {
      log = { ops: [], palette: new Map(), cx: 1, cy: 1 };
      this.screens.set(wall, log);
    }
    return log;
  }

  /** A `screen:<wall>` line: a call to keep and pass on, or `?<id>`, a computer asking for the screen. */
  private onScreen(
    wall: string,
    text: string,
    relay: string[],
    toAll: string[],
  ): void {
    if (text.startsWith("?")) {
      const log = this.screens.get(wall);
      toAll.push(
        `screen:${wall}\t~${text.slice(1)}\x1e${(log?.ops ?? []).join("\x1e")}`,
      );
      return;
    }
    const parts = text.split(";");
    const method = parts[1] ?? "";
    const args = parts.slice(2);
    const log = this.screen(wall);
    const num = (s: string | undefined): number =>
      s?.startsWith("n") ? Number(s.slice(1)) : 0;
    switch (method) {
      case "write":
        log.cx += unescape((args[0] ?? "s").slice(1)).length;
        break;
      case "blit":
        log.cx += unescape((args[0] ?? "s").slice(1)).length;
        break;
      case "setCursorPos":
        log.cx = Math.floor(num(args[0]));
        log.cy = Math.floor(num(args[1]));
        break;
      case "setTextScale":
        log.scale = text;
        break;
      case "setPaletteColour":
      case "setPaletteColor":
        log.palette.set(args[0] ?? "", text);
        break;
      case "setTextColour":
      case "setTextColor":
        log.text = text;
        break;
      case "setBackgroundColour":
      case "setBackgroundColor":
        log.back = text;
        break;
      case "setCursorBlink":
        log.blink = text;
        break;
    }
    if (method === "clear" && log.ops.length > 64) {
      // nothing drawn before a clear shows any more: keep only the state it leaves
      this.fold(log);
    } else {
      log.ops.push(text);
    }
    relay.push(`screen:${wall}\t${text}`);
  }

  /** The screen as a fresh terminal would get it: its settings, the cursor where it was, then a clear. */
  private fold(log: ScreenLog): void {
    log.ops = [
      ...(log.scale ? [log.scale] : []),
      ...log.palette.values(),
      ...(log.text ? [log.text] : []),
      ...(log.back ? [log.back] : []),
      ...(log.blink ? [log.blink] : []),
      `-1;setCursorPos;n${log.cx};n${log.cy}`,
      "-1;clear",
    ];
  }

  /**
   * A monitor block changed. The screen lives in the wall's origin (ServerMonitor): a block that stops being an origin
   * takes its screen with it, a new origin starts blank, and an origin whose wall changes size is cleared.
   */
  private screenWallChanged(
    key: string,
    before: BlockDef | false | undefined,
    now: BlockDef | false,
  ): void {
    const was = wallOf(before);
    const is = wallOf(now);
    const wasOrigin = was && was.x === 0 && was.y === 0;
    const isOrigin = is && is.x === 0 && is.y === 0;
    if (!isOrigin || !wasOrigin || before === undefined) {
      if (wasOrigin || isOrigin) this.screens.delete(key);
      return;
    }
    if (was.w !== is.w || was.h !== is.h) {
      const log = this.screens.get(key);
      if (log) this.fold(log);
    }
  }

  /** Stop every placed computer and remove the shared folders. */
  async dispose(keep = false): Promise<void> {
    await Promise.all(
      [...this.placed.values()].map((c) =>
        c.handle.session.stop(0).catch(() => undefined),
      ),
    );
    if (!keep) {
      for (const c of this.computers()) c.handle.dispose();
      rmSync(this.sharedDir, { recursive: true, force: true });
    }
  }
}

function isWired(def: BlockDef | false | undefined): boolean {
  return !!def && (def.name === CABLE || def.name === FULL_MODEM);
}
