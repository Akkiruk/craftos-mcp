import type {
  BlockPos,
  ComputerPosition,
  ModemSpec,
  WorldConfig,
} from "./world.js";

/**
 * One wired network: cables and full modems that touch, and what is attached to them. Blocks that
 * touch join, so a `cables` list alone describes a network; computers join it with a modem whose
 * `block` is one of those blocks (or touches one). `id` is the shorthand with no cables at all:
 * every modem with that `network` is on it, and distances are then straight lines.
 */
export interface WiredNetworkSpec {
  id?: string;
  /** Cable and full modem blocks. A route through them gives the distance modem_message reports. */
  cables?: BlockPos[];
  /** Peripherals behind a switched-on modem. Without a name they get `<type>_<n>` like the real counter. */
  peripherals?: { name?: string; type: string; [extra: string]: unknown }[];
}

/** One computer as the network sees it. `running: false` is a computer that was shut down. */
export interface WiredComputer {
  readonly world: WorldConfig;
  readonly running?: boolean;
}

/** A computer or peripheral a modem reaches, in the shape the Lua side registers. */
export interface RemotePeripheral {
  name: string;
  type: string;
  [extra: string]: unknown;
}

/** What the sim needs to know about one wired modem. */
export interface ResolvedModem {
  key: string;
  net: string;
  on: boolean;
  localName: string;
  /** Sender's modem key -> [route up to this modem's block, last step to this computer]. */
  peers: Record<string, [number, number]>;
  remotes: RemotePeripheral[];
}

const OVERWORLD = "minecraft:overworld";

const blockKey = (b: BlockPos, dimension?: string): string =>
  `${b.dimension ?? dimension ?? OVERWORLD}:${b.x}:${b.y}:${b.z}`;

export function computerPosition(
  world: WorldConfig | undefined,
): Required<ComputerPosition> {
  return {
    x: world?.position?.x ?? 0,
    y: world?.position?.y ?? 64,
    z: world?.position?.z ?? 0,
    dimension: world?.position?.dimension ?? OVERWORLD,
  };
}

export const modemsOf = (world: WorldConfig | undefined): ModemSpec[] =>
  (world?.peripherals ?? []).filter((p) => p.type === "modem") as ModemSpec[];

function javaHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++)
    hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * getNamesRemote is the key set of a ConcurrentHashMap, so its order comes from the names' Java
 * hashes: buckets in order, and in one bucket whoever came first. Same names, same order.
 */
export function remoteOrder<T extends { name: string }>(items: T[]): T[] {
  let buckets = 16;
  while (items.length > buckets * 0.75) buckets *= 2;
  const bucket = (name: string): number => {
    const hash = javaHash(name);
    return (hash ^ (hash >>> 16)) & 0x7fffffff & (buckets - 1);
  };
  return items
    .map((item, index) => ({ item, index, at: bucket(item.name) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.item);
}

class Union {
  private readonly parent = new Map<string, string>();

  find(key: string): string {
    const parent = this.parent.get(key);
    if (parent === undefined) {
      this.parent.set(key, key);
      return key;
    }
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  join(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

interface WiredModem {
  readonly computer: number;
  readonly spec: ModemSpec;
  readonly key: string;
  readonly at: Required<ComputerPosition>;
  readonly block: string | undefined;
  readonly localName: string;
}

const NEIGHBOURS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

function neighbours(key: string): string[] {
  const parts = key.split(":");
  const z = Number(parts.pop());
  const y = Number(parts.pop());
  const x = Number(parts.pop());
  const dimension = parts.join(":");
  return NEIGHBOURS.map(
    ([dx, dy, dz]) => `${dimension}:${x + dx}:${y + dy}:${z + dz}`,
  );
}

/** Blocks from one modem block to every block joined to it, like the steps of WiredNetwork.transmitPacket. */
function stepsFrom(start: string, blocks: Set<string>): Map<string, number> {
  const steps = new Map([[start, 0]]);
  const queue = [start];
  for (const key of queue) {
    for (const next of neighbours(key)) {
      if (blocks.has(next) && !steps.has(next)) {
        steps.set(next, steps.get(key)! + 1);
        queue.push(next);
      }
    }
  }
  return steps;
}

function distance(a: BlockPos, b: BlockPos): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Work out which wired modems share a network, what each one reaches and how far apart they are.
 * The result lists, per computer, its wired modems by peripheral name.
 */
export function resolveWired(
  computers: readonly WiredComputer[],
  networks: readonly WiredNetworkSpec[] = [],
): Record<string, ResolvedModem>[] {
  const taken = new Set<string>();
  for (const { world } of computers)
    for (const m of modemsOf(world)) if (m.localName) taken.add(m.localName);
  for (const n of networks)
    for (const p of n.peripherals ?? []) if (p.name) taken.add(p.name);
  const counters = new Map<string, number>();
  const nextName = (type: string): string => {
    for (;;) {
      const n = counters.get(type) ?? 0;
      counters.set(type, n + 1);
      if (!taken.has(`${type}_${n}`)) return `${type}_${n}`;
    }
  };

  const modems: WiredModem[] = [];
  computers.forEach(({ world }, computer) => {
    const at = computerPosition(world);
    for (const spec of modemsOf(world)) {
      if (spec.kind !== "wired") continue;
      modems.push({
        computer,
        spec,
        key: `${world.computerId ?? 0}/${spec.name}`,
        at,
        block: spec.block ? blockKey(spec.block, at.dimension) : undefined,
        localName: spec.localName ?? nextName("computer"),
      });
    }
  });

  const union = new Union();
  const blocks = new Set<string>();
  networks.forEach((network, index) => {
    const name = `network:${network.id ?? index}`;
    union.find(name);
    for (const cable of network.cables ?? []) {
      const key = blockKey(cable);
      blocks.add(key);
      union.join(key, name);
    }
  });
  for (const m of modems) {
    union.find(m.key);
    if (m.block) {
      blocks.add(m.block);
      union.join(m.key, m.block);
    }
    if (m.spec.network) union.join(m.key, `network:${m.spec.network}`);
  }
  for (const key of blocks)
    for (const next of neighbours(key))
      if (blocks.has(next)) union.join(key, next);

  const attached: (RemotePeripheral & { network: string })[] = [];
  networks.forEach((network, index) => {
    for (const p of network.peripherals ?? [])
      attached.push({
        ...p,
        name: p.name ?? nextName(p.type),
        network: union.find(`network:${network.id ?? index}`),
      });
  });

  const routes = new Map(
    modems
      .filter((m) => m.block)
      .map((m) => [m.key, stepsFrom(m.block!, blocks)]),
  );
  const blockPos = (m: WiredModem): BlockPos => m.spec.block!;

  // A peripheral on a cable is one block, so one computer holds it and the others call it through the relay: the first
  // running computer on that network that uses the relay (ccsim/wiredrelay.lua): 2.2.36 or vhcctweaks off, as plain
  // CC:Tweaked shares the block too. Only 2.2.35 computers keep a copy each.
  const owners = new Map<string, number>();
  for (const modem of modems) {
    const { world, running } = computers[modem.computer]!;
    const net = union.find(modem.key);
    if (running === false || world.vhcctweaks === "2.2.35" || owners.has(net))
      continue;
    owners.set(net, world.computerId ?? 0);
  }

  const result: Record<string, ResolvedModem>[] = computers.map(() => ({}));
  for (const modem of modems) {
    const net = union.find(modem.key);
    const remotes: RemotePeripheral[] = [];
    const peers: Record<string, [number, number]> = {};
    const owner = owners.get(net);
    for (const { network, ...peripheral } of attached)
      if (network === net)
        remotes.push(
          owner === undefined ? peripheral : { ...peripheral, owner },
        );
    for (const other of modems) {
      if (other === modem || union.find(other.key) !== net) continue;
      const id = computers[other.computer]!;
      if (other.spec.on !== false && other.localName !== modem.localName)
        remotes.push({
          name: other.localName,
          type: "computer",
          id: id.world.computerId ?? 0,
          label: id.world.label,
          running: id.running !== false,
        });
      const steps = modem.block
        ? routes.get(other.key)?.get(modem.block)
        : undefined;
      if (steps !== undefined) {
        peers[other.key] = [
          distance(other.at, blockPos(other)) + steps,
          distance(blockPos(modem), modem.at),
        ];
      }
    }
    result[modem.computer]![modem.spec.name] = {
      key: modem.key,
      net,
      on: modem.spec.on !== false,
      localName: modem.localName,
      peers,
      remotes: remoteOrder(remotes),
    };
  }
  return result;
}

/** The world with its wired modems resolved, as the Lua side reads it. */
export function withResolvedModems(
  world: WorldConfig,
  resolved: Record<string, ResolvedModem>,
): WorldConfig {
  return {
    ...world,
    peripherals: (world.peripherals ?? []).map((p) => ({
      ...p,
      ...resolved[p.name],
    })),
  };
}
