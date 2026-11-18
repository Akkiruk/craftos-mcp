import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BlockWorldHost } from "./blockworld.js";
import type { EngineHandle } from "./engine.js";
import type { MonitorSpec } from "./lua.js";
import {
  type ResolvedModem,
  type WiredNetworkSpec,
  modemsOf,
  resolveWired,
  withResolvedModems,
} from "./wired.js";
import {
  type ComputerPosition,
  type ModemSpec,
  type PlayerSpec,
  type WorldConfig,
  worldJson,
} from "./world.js";

/** One computer of a linked network. */
export interface LinkedComputerSpec {
  /** What tests call it. Default the computer id. */
  readonly name?: string;
  /** Its full ccsim world. `computerId` must differ between computers; default its place in the list. */
  readonly world?: WorldConfig;
  readonly monitors?: readonly MonitorSpec[];
  readonly timeScale?: number;
  /** Folder copied onto this computer. Default the configured workspace. */
  readonly workspaceDir?: string;
  /** The computer's files are this folder itself, live, instead of a copy (StartOptions.liveDir). */
  readonly liveDir?: string;
}

/** Several computers in one world, their modems really connected. */
export interface NetworkSpec {
  readonly computers: readonly LinkedComputerSpec[];
  readonly wired?: readonly WiredNetworkSpec[];
  readonly timeScale?: number;
}

/** A computer's packets arrive in /results/modem.out; this many ms apart is how often it is read. */
const PUMP_MS = 2;

interface Member {
  readonly name: string;
  readonly handle: EngineHandle;
  world: WorldConfig;
  offset: number;
  seq: number;
  running: boolean;
  /** Relay traffic (ccsim/wiredrelay.lua: a shared cable, and 2.2.36 links) goes to this computer: all but 2.2.35. */
  readonly relay: boolean;
  /** Its last directory entry, `<id>;<encoded entry>`, as ccsim/wiredrelay.lua wrote it. */
  entry?: string;
  linkSeq: number;
}

/** The uuid ccsim/core.lua gives the n-th player of a world (from 1) that names none. */
const uuidFor = (index: number): string =>
  `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

/**
 * One economy knows a player once, so every world of a network gives a name the same uuid: the one it has where it
 * first appears. The host and the default player are written out, as core.lua would add them.
 */
function sameUuids(worlds: WorldConfig[]): WorldConfig[] {
  const uuids = new Map<string, string>();
  return worlds.map((world) => {
    const players: PlayerSpec[] = [
      ...(world.players?.length
        ? world.players
        : [{ name: "Player", balance: 0 }]),
    ];
    const host = world.host?.toLowerCase();
    if (host && !players.some((p) => p.name.toLowerCase() === host))
      players.push({ name: world.host!, online: false });
    return {
      ...world,
      players: players.map((p, index) => {
        const key = p.name.toLowerCase();
        const uuid = p.uuid ?? uuids.get(key) ?? uuidFor(index + 1);
        if (!uuids.has(key)) uuids.set(key, uuid);
        return { ...p, uuid };
      }),
    };
  });
}

/** What every computer of a network shares: balances by uuid, the ledger and the refused transfers. */
export interface SharedEconomy {
  balances: Record<string, number>;
  ledger: Record<string, unknown>[];
  rejections: Record<string, unknown>[];
}

/**
 * Lay out a network's one economy (ccsim/core.lua reads it): each player's balance from the first world that lists
 * them, a version the computers watch. A computer holds the economy while it changes it by creating `lock` (fs.__ccsimTryLock).
 */
export function seedEconomy(dir: string, worlds: readonly WorldConfig[]): void {
  const balances: Record<string, number> = {};
  for (const world of worlds)
    for (const p of world.players ?? [])
      if (p.uuid && !(p.uuid in balances)) balances[p.uuid] = p.balance ?? 0;
  mkdirSync(dir, { recursive: true });
  const economy: SharedEconomy = { balances, ledger: [], rejections: [] };
  writeFileSync(join(dir, "economy.json"), JSON.stringify(economy));
  writeFileSync(join(dir, "version"), "1");
}

function withoutItems(
  modems: Record<string, ResolvedModem>,
): Record<string, ResolvedModem> {
  return Object.fromEntries(
    Object.entries(modems).map(([name, modem]) => [
      name,
      {
        ...modem,
        remotes: modem.remotes.map(({ items: _items, ...rest }) => rest),
      },
    ]),
  );
}

/** The world each computer starts with, its id settled and its wired modems resolved. */
export function linkedWorlds(
  computers: readonly LinkedComputerSpec[],
  wired: readonly WiredNetworkSpec[] = [],
): WorldConfig[] {
  const worlds = sameUuids(
    computers.map((c, index) => ({
      ...c.world,
      computerId: c.world?.computerId ?? index,
      modemLink: true,
    })),
  );
  const ids = worlds.map((w) => w.computerId);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined)
    throw new Error(`two computers on one network have id ${twice}`);
  // rednet numbers its messages with math.random and drops any number it has seen, so one seed means lost messages
  const seeds = worlds.flatMap((w) => (w.seed === undefined ? [] : [w.seed]));
  if (new Set(seeds).size !== seeds.length)
    throw new Error(
      "computers on one network need different world.seed values",
    );
  const resolved = resolveWired(
    worlds.map((world) => ({ world })),
    wired,
  );
  return worlds.map((world, index) =>
    withResolvedModems(world, resolved[index]!),
  );
}

/**
 * Passes packets between linked computers: every computer's outbox to every other computer, as one
 * `ccsim_net` event for each batch. It knows no modem rules; those are in ccsim/modem.lua, on the
 * side that receives. It also holds the wired network together, since moving a computer or
 * switching a modem changes what every other computer on the cable sees.
 */
export class ComputerNetwork {
  private readonly members: Member[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly wired: readonly WiredNetworkSpec[] = [],
    /** Where the network's one economy lives (seedEconomy); none for a computer on its own. */
    readonly economyDir?: string,
  ) {}

  /** Join a started computer. The first one starts the relay. */
  add(name: string, handle: EngineHandle, world: WorldConfig): void {
    this.members.push({
      name,
      handle,
      world,
      offset: 0,
      seq: 0,
      running: true,
      relay: world.vhcctweaks !== "2.2.35",
      linkSeq: 0,
    });
    for (const modem of modemsOf(world))
      for (const remote of ((modem as { remotes?: unknown }).remotes ?? []) as {
        name: string;
        owner?: unknown;
      }[])
        if (typeof remote.owner === "number")
          this.owners.set(remote.name, remote.owner);
    this.timer ??= setInterval(() => this.pump(), PUMP_MS);
    this.timer.unref();
  }

  private member(name: string): Member {
    const found = this.members.find((m) => m.name === name);
    if (!found) throw new Error(`no computer named ${name} on this network`);
    return found;
  }

  /** Lines this computer has written since the last read. */
  private read(member: Member): string[] {
    const file = join(member.handle.resultsDir, "modem.out");
    try {
      const size = statSync(file).size;
      if (size <= member.offset) return [];
      const fd = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(size - member.offset);
        readSync(fd, buffer, 0, buffer.length, member.offset);
        const end = buffer.lastIndexOf(10);
        if (end < 0) return []; // caught halfway through its first line
        member.offset += end + 1;
        return buffer
          .toString("latin1", 0, end)
          .split("\n")
          .map((line) => line.replace(/\r$/, ""))
          .filter(Boolean);
      } finally {
        closeSync(fd);
      }
    } catch {
      return []; // nothing sent yet, or the session is being destroyed
    }
  }

  /** A block world shared by this network's computers (blockworld.ts). */
  private blockHost: BlockWorldHost | undefined;
  private worldSeq = 0;

  attachBlockWorld(host: BlockWorldHost): void {
    this.blockHost = host;
  }

  /** Block changes for every running computer. */
  broadcastWorld(lines: string[], except?: Member): void {
    if (lines.length === 0) return;
    for (const to of this.members) {
      if (!to.running || to === except) continue;
      this.worldSeq += 1;
      to.handle.session.event("ccsim_world", this.worldSeq, lines.join("\n"));
    }
  }

  /** Every computer on the network, by name. */
  handles(): Map<string, EngineHandle> {
    return new Map(this.members.map((m) => [m.name, m.handle]));
  }

  /** A viewer's tap (webapp-views.ts): called with every packet a computer sends, as its modem wrote it. */
  onPacket: ((from: string, packet: string) => void) | undefined;

  /** Every computer on the network with the world it has now, for viewers. */
  computers(): {
    name: string;
    handle: EngineHandle;
    world: WorldConfig;
    running: boolean;
  }[] {
    return this.members.map((m) => ({
      name: m.name,
      handle: m.handle,
      world: m.world,
      running: m.running,
    }));
  }

  private control(line: string): void {
    const parsed = JSON.parse(line) as {
      op: string;
      target?: number;
      pos?: string;
    };
    if (parsed.pos !== undefined) {
      if (this.blockHost)
        this.broadcastWorld(this.blockHost.control(parsed.op, parsed.pos));
      return;
    }
    const { op, target } = parsed as { op: string; target: number };
    const member = this.members.find((m) => m.world.computerId === target);
    if (!member) return;
    if (op === "turnOn") {
      // ComputerPeripheral.turnOn: a computer that is off starts again, with its files and the server's state
      if (member.running || member.handle.session.running) return;
      member.running = true;
      this.publish(member); // world.json first: the computer reads it as it boots
      member.handle.restart();
      return;
    }
    if (!member.running) return;
    if (op === "reboot") member.handle.sendCommand({ cmd: "reboot" });
    if (op === "shutdown") member.handle.sendCommand({ cmd: "shutdown" });
  }

  /**
   * A computer whose engine stopped while it held the economy (killed mid-transfer) can never let go of it, so the
   * host removes its lock. Only the host may: a computer that took it back itself, after waiting, would take it from
   * one that was only slow, and both would move the same tokens.
   */
  private returnEconomyToken(computerId: number | undefined): void {
    if (!this.economyDir || computerId === undefined) return;
    const lock = join(this.economyDir, "lock");
    try {
      if (readFileSync(lock, "utf8") === String(computerId)) rmSync(lock);
    } catch {
      // nobody holds it
    }
  }

  private pump(): void {
    let changed = false;
    for (const member of this.members) {
      if (member.running && !member.handle.session.running) {
        member.running = false;
        changed = true;
        this.returnEconomyToken(member.world.computerId);
      }
    }
    if (changed) this.publish();
    const live = this.members.filter((m) => m.running);
    if (live.length === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
      return;
    }
    const outgoing = new Map<Member, string[]>();
    // the relay: directory entries and messages between computers sharing a cable or linked (2.2.36)
    const linkMessages = new Map<Member, string[]>();
    let directoryChanged = changed;
    for (const from of live) {
      const worldLines: string[] = [];
      const flushWorld = (): void => {
        if (worldLines.length === 0 || !this.blockHost) return;
        const { relay, toAll } = this.blockHost.onLines(worldLines.splice(0));
        this.broadcastWorld(relay, from);
        this.broadcastWorld(toAll);
      };
      for (const line of this.read(from)) {
        if (line.startsWith("C")) {
          // a block this computer just placed must be known before something is asked of it
          flushWorld();
          this.control(line.slice(1));
        } else if (line.startsWith("W")) worldLines.push(line.slice(1));
        else if (line.startsWith("P")) {
          this.onPacket?.(from.name, line.slice(1));
          for (const to of live) {
            if (to === from) continue;
            const batch = outgoing.get(to) ?? [];
            batch.push(line.slice(1));
            outgoing.set(to, batch);
          }
        } else if (line.startsWith("D") && from.relay) {
          from.entry = line.slice(1);
          directoryChanged = true;
        } else if (line.startsWith("M") && from.relay) {
          const target = Number(line.slice(1, line.indexOf(";")));
          // a message for a computer that is gone is lost; the sender learns it from the directory
          const to = live.find((m) => m.relay && m.world.computerId === target);
          if (!to) continue;
          const batch = linkMessages.get(to) ?? [];
          batch.push(line);
          linkMessages.set(to, batch);
        }
      }
      flushWorld();
    }
    for (const [to, lines] of outgoing) {
      to.seq += 1;
      to.handle.session.event("ccsim_net", to.seq, lines.join("\n"));
    }
    // The directory goes first, so a message never arrives before the link it relies on
    const directory = directoryChanged ? this.directoryLines() : [];
    for (const to of live) {
      if (!to.relay) continue;
      const lines = [...directory, ...(linkMessages.get(to) ?? [])];
      if (lines.length === 0) continue;
      to.linkSeq += 1;
      to.handle.session.event("ccsim_link", to.linkSeq, lines.join("\n"));
    }
  }

  /** Every relay computer's entry, `D<1 running|0 not>;<id>;<entry>`. */
  private directoryLines(): string[] {
    return this.members
      .filter((m) => m.relay && m.entry !== undefined)
      .map((m) => `D${m.running ? 1 : 0};${m.entry}`);
  }

  /** The computer's chunk unloads: it stops, and computers linked to it lose its peripherals. */
  unload(computer: string): void {
    this.member(computer).handle.sendCommand({ cmd: "unload" });
  }

  /** The chunk loads again: the computer boots afresh, and its peripherals come back to computers linked to it. */
  load(computer: string): void {
    this.member(computer).handle.sendCommand({ cmd: "load" });
  }

  /** Tell every computer what its wired modems reach now, and leave it in world.json for its next boot. */
  private publish(booting?: Member): void {
    const resolved = resolveWired(
      this.members.map((m) => ({ world: m.world, running: m.running })),
      this.wired,
    );
    this.handOver(resolved);
    this.members.forEach((member, index) => {
      const modems = resolved[index]!;
      member.world = withResolvedModems(member.world, modems);
      if (!member.running || Object.keys(modems).length === 0) return;
      // What a chest held when it changed hands is for that moment only: a later boot has its own saved state
      const saved =
        member === booting
          ? member.world
          : withResolvedModems(member.world, withoutItems(modems));
      writeFileSync(
        join(member.handle.resultsDir, "world.json"),
        worldJson(saved),
      );
      // a computer about to boot reads it all from world.json
      if (member !== booting)
        member.handle.sendCommand({ cmd: "modemTopology", modems });
    });
  }

  /** Right-click a wired modem: its computer joins or leaves the network as a peripheral. */
  setModemOn(computer: string, modem: string, on: boolean): void {
    const member = this.member(computer);
    if (!modemsOf(member.world).some((m) => m.name === modem))
      throw new Error(`${computer} has no modem ${modem}`);
    member.world = {
      ...member.world,
      peripherals: member.world.peripherals?.map((p) =>
        p.name === modem ? ({ ...p, on } as ModemSpec) : p,
      ),
    };
    this.publish();
  }

  /** Put a computer somewhere else; it hears and reaches from there at once. */
  move(computer: string, position: ComputerPosition): void {
    const member = this.member(computer);
    member.world = {
      ...member.world,
      position: { ...member.world.position, ...position },
    };
    member.handle.sendCommand({ cmd: "setComputerPos", ...position });
    this.publish();
  }

  /** Which computer holds each peripheral on a cable, as last published. */
  private readonly owners = new Map<string, number>();

  /**
   * A peripheral's holder went away, so another computer holds it now. What is in a chest is in the world, not in
   * the computer that held it: the new holder starts from what the old one last saved.
   */
  private handOver(resolved: Record<string, ResolvedModem>[]): void {
    const now = new Map<string, number>();
    for (const modems of resolved)
      for (const modem of Object.values(modems))
        for (const remote of modem.remotes)
          if (typeof remote.owner === "number")
            now.set(remote.name, remote.owner);
    const items = new Map<string, unknown>();
    for (const [name, owner] of now) {
      const before = this.owners.get(name);
      if (before === undefined || before === owner) continue;
      const held = this.members
        .find((m) => m.world.computerId === before)
        ?.handle.readState()?.inventories?.[name];
      if (held !== undefined) items.set(name, held);
    }
    for (const modems of resolved)
      for (const modem of Object.values(modems))
        modem.remotes = modem.remotes.map((remote) =>
          items.has(remote.name)
            ? { ...remote, items: items.get(remote.name) }
            : remote,
        );
    this.owners.clear();
    for (const [name, owner] of now) this.owners.set(name, owner);
  }

  /** The network's one economy as the computers last wrote it, or undefined when it has none. */
  economy(): SharedEconomy | undefined {
    if (!this.economyDir) return undefined;
    try {
      const raw = JSON.parse(
        readFileSync(join(this.economyDir, "economy.json"), "utf8"),
      ) as Record<string, unknown>;
      // CC's JSON encoder writes an empty list as {}
      const list = (value: unknown): Record<string, unknown>[] =>
        Array.isArray(value) ? value : [];
      return {
        balances: (raw.balances ?? {}) as Record<string, number>,
        ledger: list(raw.ledger),
        rejections: list(raw.rejections),
      };
    } catch {
      return undefined; // caught while a computer rewrites it; the next read sees it whole
    }
  }

  /**
   * The server crashes and comes back: every computer restarts, and what the server held only in memory (sessions,
   * the last touch, pending approvals, allowances) is gone. The economy, ownership and the world stay.
   */
  crashServer(): void {
    for (const member of this.members)
      if (member.running) member.handle.sendCommand({ cmd: "crashServer" });
  }

  /** Stop relaying. The computers keep running, each on its own. */
  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
