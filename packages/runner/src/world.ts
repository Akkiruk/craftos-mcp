import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkWorldAddons, resolveAddons } from "./addons.js";
import { luaString } from "./lua.js";
import { resolveWired, withResolvedModems } from "./wired.js";

/** A simulated player on the fake server. */
export interface PlayerSpec {
  name: string;
  uuid?: string;
  /** Default true. */
  online?: boolean;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  dimension?: string;
  health?: number;
  maxHealth?: number;
}

/** Worn and held items. `curios` is slot type (as Curios names it, e.g. "ring") to index (from 1) to item. */
export interface EquipmentSpec {
  head?: ItemSpec;
  chest?: ItemSpec;
  legs?: ItemSpec;
  feet?: ItemSpec;
  mainhand?: ItemSpec;
  offhand?: ItemSpec;
  curios?: Record<string, Record<string, ItemSpec>>;
}

/** Item stack in a virtual inventory; extra fields (vaultData, nbt, ...) are passed to getItemDetail. */
export interface ItemSpec {
  name: string;
  count: number;
  [extra: string]: unknown;
}

/** A turtle (CC:Tweaked 1.101.3). Its position is `x/y/z/dimension` here or the world's `position`. */
/** Chunk coordinates (block coordinate / 16, rounded down): one chunk, or the box between two corners. */
export type ChunkRange =
  | [number, number]
  | { from: [number, number]; to?: [number, number] };

export interface TurtleSpec {
  x?: number;
  y?: number;
  z?: number;
  dimension?: string;
  /** "north" (default), "south", "east" or "west". */
  facing?: "north" | "south" | "east" | "west";
  /** Advanced turtle: colour screen, 100000 fuel limit. */
  advanced?: boolean;
  fuel?: number;
  /** Selected slot, 1-16 (default 1). */
  selected?: number;
  /** Slot (1-16) to item. */
  inventory?: Record<string, ItemSpec>;
  /** Upgrade item ids: "minecraft:diamond_pickaxe", "computercraft:wireless_modem_normal", "minecraft:crafting_table", ... */
  left?: string;
  right?: string;
}

/**
 * A block in a turtle's world. `state` holds its block state properties (strings, as in F3). Containers take
 * `items` (slot to item) and `size`; any block can carry `peripheral`, a virtual peripheral (as in `peripherals`,
 * without a name) that a turtle next to it sees on that side.
 */
export interface BlockSpec {
  x: number;
  y: number;
  z: number;
  /** Block id; omit or "minecraft:air" for air (to cut a hole in a fill). */
  name?: string;
  state?: Record<string, string>;
  items?: Record<string, ItemSpec>;
  size?: number;
  peripheral?: Omit<VirtualPeripheralSpec, "name">;
  blockEntity?: Record<string, unknown>;
}

/** Peripherals implemented in Lua by the sim: inventories, playerDetector, chatBox. */
export interface VirtualPeripheralSpec {
  name: string;
  /**
   * Inventories ("minecraft:chest", "minecraft:barrel", ...), "fluid_storage" tanks, "speaker"
   * (a recording fake: the headless engine has no audio device), or an Advanced Peripherals type:
   * playerDetector, chatBox, energyDetector, redstoneIntegrator, nbtStorage, environmentDetector,
   * meBridge, rsBridge, arController; or a Mekanism QIO block (see QioBlockSpec): qioDriveArray,
   * qioDashboard, qioImporter, qioExporter, qioRedstoneAdapter; or "quantumEntangloporter" (EntangloporterSpec).
   */
  type: string;
  size?: number;
  /**
   * Inventories: slot (1-based) -> item. Storage bridges: a list of stacks
   * `{ name, amount, displayName?, nbt?, tags?, craftable? }`.
   */
  items?: Record<string, ItemSpec> | Record<string, unknown>[];
  x?: number;
  y?: number;
  z?: number;
  dimension?: string;
  /** Peripheral-specific fixture data (fluids, energy, cells, cpus, patterns, inputs, ...). */
  [extra: string]: unknown;
}

/**
 * An item in a QIO drive or a QIO fixture. Every distinct name + NBT is its own type. `nbt` is the item's full
 * NBT: a JSON object (whole numbers become ints, other numbers doubles, booleans bytes) or an SNBT string with
 * types (`{Damage:0,Level:3b}`). Other fields (maxCount, displayName, tags, vaultData, ...) travel with the
 * item into chests. Vault gear: give each piece its own NBT and `maxCount: 1`.
 */
export interface QioItemSpec {
  name: string;
  count?: number;
  nbt?: Record<string, unknown> | string;
  /** The `nbt` hash a chest's list() shows for this item (default: a hash of the NBT, not the real one). */
  nbtHash?: string;
  maxCount?: number;
  /** Item tags without "#", e.g. "forge:ingots/iron". */
  tags?: string[];
  /** Mod id for mod id filters (default: the name's namespace). */
  modId?: string;
  [extra: string]: unknown;
}

/** A QIO drive: tier base (16,000 items, 128 types), hyper_dense, time_dilating or supermassive. */
export interface QioDriveSpec {
  /** 0-11; default the position in the list. */
  slot?: number;
  tier?: "base" | "hyper_dense" | "time_dilating" | "supermassive";
  items?: QioItemSpec[];
}

/** A QIO filter, as the computer methods take and return it. */
export interface QioFilterSpec {
  type: "QIO_ITEMSTACK_FILTER" | "QIO_TAG_FILTER" | "QIO_MODID_FILTER";
  item?: string;
  itemNBT?: Record<string, unknown> | string;
  fuzzy?: boolean;
  tag?: string;
  modId?: string;
}

/**
 * A QIO block: as a `peripherals` entry (type qioDriveArray, qioDashboard, qioImporter, qioExporter,
 * qioRedstoneAdapter) the computer sees it; in `mekanism.qio.blocks` (with `id`) it only takes part.
 */
export interface QioBlockSpec {
  name?: string;
  id?: string;
  type: string;
  /** Frequency name (public), or `{ name, public: false }`. A name nobody declared is created, public. */
  frequency?: string | { name: string; public?: boolean };
  /** Player name or UUID. Without an owner, setFrequency and createFrequency do nothing. */
  owner?: string;
  securityMode?: "PUBLIC" | "PRIVATE" | "TRUSTED";
  facing?: string;
  /** Drive array. */
  drives?: QioDriveSpec[] | Record<string, QioDriveSpec>;
  /** Importer/exporter: the inventory behind it, by name (a peripheral or a `mekanism.qio.inventories` entry). */
  target?: string;
  filters?: QioFilterSpec[];
  importWithoutFilter?: boolean;
  exportWithoutFilter?: boolean;
  redstoneMode?: "DISABLED" | "HIGH" | "LOW" | "PULSE";
  powered?: boolean;
  /** Speed upgrades, 0-8. */
  speedUpgrades?: number;
  /** Ticks until the machine next acts (default 0: on the first tick). */
  delay?: number;
  /** Dashboard: up to 3 crafting windows, `inputs` 9 slots (array or "0".."8"), `output`. */
  crafting?: {
    inputs?: QioItemSpec[] | Record<string, QioItemSpec>;
    output?: QioItemSpec;
  }[];
  /** Redstone adapter. */
  targetItem?: string | QioItemSpec;
  triggerAmount?: number;
  [extra: string]: unknown;
}

export interface MekanismWorld {
  /** Game time of the first tick (drive LEDs update when it is a multiple of 10). Default 0. */
  gameTime?: number;
  /** Seed of Mekanism's own randomness (exporter sampling over 100 types, the random drive save). */
  seed?: number;
  /** Item registry for setTargetItem and item filters. Default: every valid name except minecraft:air. */
  knownItems?: string[];
  /** Fission, turbine, boiler, matrix and fusion multiblocks by id (docs/mekanism-multiblocks.md). */
  multiblocks?: Record<string, { kind: string; [field: string]: unknown }>;
  /** Mekanism and Mekanism Generators config values the multiblocks use (docs/mekanism-multiblocks.md). */
  config?: Record<string, number | boolean>;
  qio?: {
    frequencies?: {
      name: string;
      public?: boolean;
      owner?: string;
      color?: string;
    }[];
    blocks?: QioBlockSpec[];
    /** Inventories only QIO blocks touch: `{ name, type, size, items }` like a chest peripheral. */
    inventories?: VirtualPeripheralSpec[];
  };
  /** Quantum Entangloporters. Buffers default to the server's general.toml. */
  entangloporter?: {
    energyBuffer?: number;
    fluidBuffer?: number;
    chemicalBuffer?: number;
    frequencies?: EntangloporterFrequencySpec[];
    /** Entangloporters the computer cannot see (with `id`). */
    blocks?: EntangloporterSpec[];
  };
}

/** An inventory frequency: the buffers every entangloporter on it shares. Private ones belong to `owner`. */
export interface EntangloporterFrequencySpec {
  name: string;
  public?: boolean;
  owner?: string;
  /** The one item slot (one stack, full NBT kept). */
  item?: QioItemSpec;
  fluid?: { name: string; amount: number; nbt?: Record<string, unknown> };
  gas?: { name: string; amount: number };
  infuseType?: { name: string; amount: number };
  pigment?: { name: string; amount: number };
  slurry?: { name: string; amount: number };
  /** Joules. */
  energy?: number;
  /** Kelvin, default 300. */
  temperature?: number;
}

/** A Quantum Entangloporter: a `peripherals` entry of type "quantumEntangloporter", or in `entangloporter.blocks`. */
export interface EntangloporterSpec {
  name?: string;
  id?: string;
  type?: "quantumEntangloporter";
  owner?: string;
  securityMode?: "PUBLIC" | "PRIVATE" | "TRUSTED";
  /** NORTH (default), SOUTH, EAST, WEST, UP, DOWN. */
  facing?: string;
  frequency?: string | { name: string; public?: boolean };
  /** Neighbouring inventories by direction (north, up, ...) or side (front, left, ...). */
  adjacent?: Record<string, string>;
  /** Side config per transmission type, e.g. `{ ITEM: { ejecting: true, sides: { FRONT: "OUTPUT" } } }`. */
  config?: Record<
    string,
    { ejecting?: boolean; sides?: Record<string, string> }
  >;
  ejector?: {
    strictInput?: boolean;
    outputColor?: string;
    inputColors?: Record<string, string>;
  };
  /** false: its chunk is not loaded, so it does not tick. Default true. */
  loaded?: boolean;
  anchorUpgrade?: boolean;
  tickDelay?: number;
  transferLoss?: number;
  environmentalLoss?: number;
  [extra: string]: unknown;
}

/** Peripherals the engine itself emulates. Monitors use the `monitors` parameter. */
export interface EnginePeripheralSpec {
  name: string;
  type: "drive";
}

/** A block in the world. Without `dimension`: the overworld, or for a modem's block its computer's. */
export interface BlockPos {
  x: number;
  y: number;
  z: number;
  dimension?: string;
}

/** Where a computer stands. Its modems report this position, as real modems report the block they sit on. */
export interface ComputerPosition {
  x?: number;
  y?: number;
  z?: number;
  dimension?: string;
}

/**
 * A modem, emulated in Lua (ccsim/modem.lua). Plain `{ name, type: "modem" }` is a normal wireless modem.
 * Wired modems link up through `network`, or through `block` and a network's cables (see `WiredNetworkSpec`).
 */
export interface ModemSpec {
  name: string;
  type: "modem";
  /** "wireless" (default), "ender" (reaches every wireless modem, any distance, any dimension) or "wired". */
  kind?: "wireless" | "ender" | "wired";
  /** Wired: the network this modem joins, by id. */
  network?: string;
  /** Wired: the full modem or cable block behind this modem. Blocks that touch join; routes give distances. */
  block?: BlockPos;
  /**
   * Wired: false is a modem nobody right-clicked. Its computer is then not on the network as a peripheral and
   * getNameLocal is nil. The modem itself stays connected. Default true.
   */
  on?: boolean;
  /** Wired: what getNameLocal answers, e.g. "computer_11". Default computer_<n> from the network's counter. */
  localName?: string;
}

export interface WorldConfig {
  /**
   * Mods besides CC:Tweaked this world has (addons.ts): addon ids such as "advanced-peripherals", "mekanism",
   * "create", or "all" / "none". Default: the CRAFTOS_ADDONS environment variable, else all. A peripheral of an
   * addon that is off is an error.
   */
  addons?: string | string[];
  /**
   * Give the computer the emulator's `sim` shell program, so a person can change the world by typing (`sim join
   * Alice`). Not CC:Tweaked's, so off unless a person drives the computer (`craftos-mcp window` and `app` turn it on).
   */
  simProgram?: boolean;
  players?: PlayerSpec[];
  computerId?: number;
  /** "pocket" computers get the pocket computer's 26x20 terminal unless `terminal` says otherwise. */
  kind?: "block" | "pocket";
  /** false: a normal computer or pocket computer, with no colour (default advanced). Turtles use `turtle.advanced`. */
  advanced?: boolean;
  /** Terminal size in characters (default 51x19, or 26x20 for pocket computers). */
  terminal?: { width: number; height: number };
  /** Overrides of the server config. */
  config?: {
    /** computercraft-server.toml. Defaults are the server's: 64 and 384, storms the same. */
    modemRange?: number;
    modemHighAltitudeRange?: number;
    modemRangeDuringStorm?: number;
    modemHighAltitudeRangeDuringStorm?: number;
    /** Height of the world for the high altitude range. Default 320 (256 in the nether and the end). */
    modemWorldTop?: number;
  };
  /** Where the computer stands. Default x 0, y 64, z 0 in the overworld. */
  position?: ComputerPosition;
  /**
   * Run Lua this many times slower than native, as CC:Tweaked's Cobalt VM does (about 8x: a 2,000,000-step loop
   * takes about 90 ms on the server against 12 ms here). `true` is 8, `false` or 1 runs at native speed.
   * Default: see DEFAULT_COBALT_SPEED in engine.ts.
   */
  cobaltSpeed?: number | boolean;
  /** What another computer's `computer_N` peripheral answers to getLabel. */
  label?: string;
  /** Set by the runner on a computer whose modems reach other computers through a relay. */
  modemLink?: boolean;
  /**
   * Assemble the computer from workspace subfolders instead of copying the whole
   * workspace, like an installer does. Each entry copies `from` (workspace-relative)
   * into `to` (computer-relative, default the root). Later entries win.
   */
  deploy?: { from: string; to?: string }[];
  peripherals?: (VirtualPeripheralSpec | EnginePeripheralSpec | ModemSpec)[];
  /** World facts read by environmentDetector peripherals. */
  environment?: {
    /** Day time in ticks (0-24000). */
    time?: number;
    raining?: boolean;
    thunder?: boolean;
    biome?: string;
    skyLight?: number;
    blockLight?: number;
    /** 0 full moon .. 7 waxing gibbous. */
    moonPhase?: number;
    /** Result of listDimensions (default overworld, the_nether, the_end, vault). */
    dimensions?: string[];
    /** World seed for isSlimeChunk. A long past 2^53 goes as a decimal string. Default 0. */
    seed?: number | string;
  };
  /** Living entities that scanEntities can see (players are added automatically). */
  entities?: {
    type?: string;
    name?: string;
    x: number;
    y: number;
    z: number;
    dimension?: string;
    animal?: boolean;
    baby?: boolean;
    inLove?: boolean;
    aggressive?: boolean;
    tags?: string[];
  }[];
  /** Overrides of the Advanced Peripherals server config (cooldowns, ranges, ...). */
  ap?: {
    config?: Record<string, unknown>;
    /**
     * What players carry, for the inventory manager: `inventory` (slot 0-35 to item), `armor` (feet, legs, chest,
     * head to item), `offhand` (an item) and `selected` (the held hotbar slot, 0-8).
     */
    players?: Record<string, Record<string, unknown>>;
  };
  /** Mekanism 10.2.5: the QIO system. See docs/mekanism-qio.md. */
  mekanism?: MekanismWorld;
  /** Make this computer a turtle (docs/turtle.md). Its world is `blocks`, `fills` and `ground`. */
  turtle?: TurtleSpec;
  /** Set by the runner on a computer block a turtle placed and something turned on: where it stands. */
  placed?: {
    x: number;
    y: number;
    z: number;
    facing?: string;
    block: string;
    dimension?: string;
  };
  /** Floppy disk contents at the start: disk id to path to file text (computer/disk/<id>). */
  disks?: Record<string, Record<string, string>>;
  /** Blocks of the world around a turtle. Anything not listed (and not filled or ground) is air. */
  blocks?: BlockSpec[];
  /** Boxes of one block (inclusive corners). Later fills cover earlier ones; `blocks` cover fills. */
  fills?: {
    from: BlockPos | [number, number, number];
    to: BlockPos | [number, number, number];
    name?: string;
    state?: Record<string, string>;
  }[];
  /** Everything at or below `y` is `name` (default stone), its top layer `top` if given. */
  ground?: { y?: number; name?: string; top?: string };
  /** Item stacks lying in the world, by the block they are in. */
  items?: {
    x: number;
    y: number;
    z: number;
    name: string;
    count?: number;
    nbt?: string;
  }[];
  /** Game rules the living world reads (ccsim/turtle/living.lua): randomTickSpeed (default 3). */
  gameRules?: { randomTickSpeed?: number };
  /** computercraft-server.toml [turtle]. Defaults are the pack's: fuel needed, 20000 / 100000, pushing on. */
  turtleConfig?: {
    needFuel?: boolean;
    normalFuelLimit?: number;
    advancedFuelLimit?: number;
    canPush?: boolean;
    /** obey_block_protection (default true): spawn protection stops a turtle moving, digging and placing. */
    obeyBlockProtection?: boolean;
    /** term_sizes.monitor in blocks: the largest monitor wall (default 8 x 6). */
    monitorWidth?: number;
    monitorHeight?: number;
  };
  /**
   * The server's spawn protection (server.properties spawn-protection, DedicatedServer.isUnderSpawnProtection): blocks
   * within `radius` of the spawn's x and z, in the overworld. `ops: false` is a server with no ops (then it is off);
   * `ownerOp` is a turtle owned by an op, who is exempt.
   */
  spawnProtection?: {
    radius?: number;
    spawn?: { x?: number; z?: number };
    ops?: boolean;
    ownerOp?: boolean;
  };
  /** The world border (WorldBorder): a square `size` wide around `center`. */
  worldBorder?: { center?: { x?: number; z?: number }; size: number };
  /** Only these chunks are loaded (chunk coordinates: `[cx, cz]` or `{ from, to }` corners). */
  loadedChunks?: ChunkRange[];
  /** These chunks are not loaded. */
  unloadedChunks?: ChunkRange[];
  /** The next number the world's disk counter hands a blank floppy (ids.json "disk"; default 0). */
  nextDiskId?: number;
  /**
   * Additions and overrides of the game data the turtle reads from the jars: names, loot tables, tags, recipes
   * (`recipes: { id: false }` removes one), maxCount, maxDamage, fuel (burn ticks), and rule lists
   * (liquids, replaceable, unbreakable, instabreak, gravity, requiresTool, placesBlock).
   */
  gameData?: Record<string, unknown>;
  /**
   * Pin math.random: seeds it at boot and makes every later math.randomseed(x) call reseed with
   * this value instead, so shuffles and dice are reproducible even for programs that seed
   * themselves from the clock.
   */
  seed?: number;
}

const ENGINE_TYPES = new Set(["drive"]);

function isEngine(
  p: VirtualPeripheralSpec | EnginePeripheralSpec | ModemSpec,
): p is EnginePeripheralSpec {
  return ENGINE_TYPES.has(p.type);
}

/** Load `<worldsDir>/<name>.json`; names are restricted so they cannot leave the folder. */
export function loadNamedWorld(worldsDir: string, name: string): WorldConfig {
  if (!/^[\w.-]{1,64}$/.test(name) || name.startsWith(".")) {
    throw new Error(`world name must match [\\w.-]{1,64}: ${name}`);
  }
  const file = join(worldsDir, `${name}.json`);
  if (!existsSync(file))
    throw new Error(`no world named "${name}" in ${worldsDir}`);
  return JSON.parse(readFileSync(file, "utf8")) as WorldConfig;
}

/** Terminal size for the computer, or undefined to keep the engine default. */
export function terminalSize(
  world: WorldConfig | undefined,
): { width: number; height: number } | undefined {
  if (world?.terminal) return world.terminal;
  if (world?.kind === "pocket") return { width: 26, height: 20 };
  // Normal and advanced turtles alike (TileTurtle)
  if (world?.turtle) return { width: 39, height: 13 };
  return undefined;
}

/** The world as the Lua sim reads it (engine peripherals are created separately). */
export function worldJson(world: WorldConfig | undefined): string {
  // A computer alone is a network of one; linked computers arrive already resolved
  const resolved =
    world && !world.modemLink
      ? withResolvedModems(world, resolveWired([{ world }])[0]!)
      : world;
  const copy: Record<string, unknown> = { ...(resolved ?? {}) };
  // The mods this world runs with (addons.ts): a world using one that is off fails here, before the computer boots
  const addons = resolveAddons(resolved?.addons);
  checkWorldAddons(copy, addons);
  copy["addons"] = addons;
  delete copy["deploy"];
  copy["peripherals"] = (resolved?.peripherals ?? []).filter(
    (p) => !isEngine(p),
  );
  return JSON.stringify(copy);
}

/** Lua that attaches the engine-emulated peripherals (drives). */
export function enginePeripheralLua(world: WorldConfig | undefined): string {
  return (world?.peripherals ?? [])
    .filter(isEngine)
    .map(
      (p) =>
        `periphemu.create(${luaString(p.name)}, ${luaString(p.type)})\n` +
        `if peripheral.__ccsimNamed then peripheral.__ccsimNamed(${luaString(p.name)}) end`,
    )
    .join("\n");
}

export interface SimState {
  /** Turtles: where it is, its fuel, slots and upgrades. */
  turtle?: TurtleSpec & { slots?: Record<string, ItemSpec> };
  /** Block worlds: every block the sim changed, "x,y,z" -> block ({} for air). */
  blocks?: Record<
    string,
    {
      name?: string;
      state?: Record<string, string>;
      items?: Record<string, ItemSpec>;
    }
  >;
  /** Block worlds: item stacks lying in the world. */
  droppedItems?: {
    x: number;
    y: number;
    z: number;
    name: string;
    count: number;
  }[];
  balances?: Record<string, number>;
  /** 2.2.36: players' vault levels. */
  vaultLevels?: Record<string, number>;
  /** 2.2.36: what players wear and hold. */
  equipment?: Record<string, EquipmentSpec>;
  ledger?: Record<string, unknown>[];
  rejections?: Record<string, unknown>[];
  chat?: {
    to: string;
    text: string;
    kind?: string;
    nonce?: string;
    command?: string;
    time?: string;
  }[];
  host?: string | null;
  interacting?: string | null;
  authenticated?: string | null;
  pendingApprovals?: number;
  inventories?: Record<string, Record<string, unknown>>;
  /** Per-peripheral state: redstone outputs, NBT contents, AR canvas, storage networks, tanks, QIO blocks. */
  peripherals?: Record<string, unknown>;
  /** Mekanism QIO: every frequency's contents, every QIO block, the QIO-only inventories. */
  qio?: {
    gameTime: number;
    frequencies: {
      name: string;
      public: boolean;
      color: string;
      itemCount: number;
      itemCapacity: number;
      typeCount: number;
      typeCapacity: number;
      items: { name: string; count: number; nbt?: unknown }[];
    }[];
    blocks: Record<string, Record<string, unknown>>;
    inventories: Record<string, Record<string, unknown>>;
    entangloporter?: {
      frequencies: {
        name: string;
        public: boolean;
        item?: { name: string; count: number; nbt?: unknown };
        energy: number;
        temperature: number;
        [k: string]: unknown;
      }[];
    };
  };
}

/** Commands the host can send to a running sim. */
export type SimCommand =
  | { cmd: "addPlayer"; name: string; online?: boolean }
  | { cmd: "join" | "leave"; player: string }
  | {
      cmd: "setPlayerPos";
      player: string;
      x?: number;
      y?: number;
      z?: number;
      yaw?: number;
      pitch?: number;
      dimension?: string;
    }
  /**
   * The server crashes and comes back: the computer restarts and the sessions, last touch, approvals and allowances
   * the server held in memory are gone. `onReboot`: the next reboot of this computer, whatever causes it, is that crash.
   */
  | { cmd: "crashServer"; onReboot?: boolean }
  | { cmd: "reboot" }
  | { cmd: "shutdown" }
  /** The computer's chunk unloads (it runs nothing; linked computers lose its peripherals), or loads and boots again. */
  | { cmd: "unload" }
  | { cmd: "load" }
  | ({ cmd: "setComputerPos" } & ComputerPosition)
  | { cmd: "modemTopology"; modems: Record<string, unknown> }
  | { cmd: "chat"; player: string; message: string }
  | { cmd: "playerClick"; player: string; device?: string }
  | { cmd: "setItem"; peripheral: string; slot: number; item: ItemSpec | null }
  | { cmd: "setEnergy"; peripheral: string; energy: number }
  | {
      cmd: "setFluid";
      peripheral: string;
      tank?: number;
      fluid: { name: string; amount: number } | null;
    }
  | { cmd: "setEnergyTransferRate"; peripheral: string; rate: number }
  | { cmd: "setRedstoneInput"; peripheral: string; side: string; level: number }
  | { cmd: "completeCraft"; peripheral: string; name?: string }
  | { cmd: "setNetworkConnected"; peripheral: string; connected: boolean }
  | { cmd: "setEnvironment"; values: Record<string, unknown> }
  | { cmd: "addEntity"; entity: Record<string, unknown> }
  | { cmd: "qioSetPowered"; block: string; powered: boolean }
  | {
      cmd: "qioSetDrive";
      block: string;
      slot: number;
      drive: QioDriveSpec | null;
    }
  | { cmd: "qioSetSecurity"; block: string; mode: string }
  | { cmd: "qioSetUpgrades"; block: string; speed: number }
  | { cmd: "qioInsert" | "qioExtract"; frequency: string; item: QioItemSpec }
  | {
      cmd: "qeInsert";
      frequency: string;
      public?: boolean;
      owner?: string;
      item: QioItemSpec;
    }
  | {
      cmd: "qeExtract";
      frequency: string;
      public?: boolean;
      owner?: string;
      count?: number;
    }
  | { cmd: "qeSetLoaded"; block: string; loaded: boolean }
  /** A block is placed next to the computer: a virtual peripheral, or the engine's own monitor or drive. */
  | {
      cmd: "attachPeripheral";
      peripheral:
        | VirtualPeripheralSpec
        | EnginePeripheralSpec
        | {
            name: string;
            type: "monitor";
            blocksWide?: number;
            blocksHigh?: number;
          };
    }
  /** The block is broken: `peripheral_detach`, and peripheral.getNames stops listing it. */
  | { cmd: "detachPeripheral"; name: string }
  /** Monitor blocks added to or taken off a wall (at most 8x6): monitor_resize follows a tick later. */
  | {
      cmd: "resizeMonitor";
      monitor: string;
      blocksWide: number;
      blocksHigh: number;
    }
  | { cmd: "seed"; value: number }
  | { cmd: "advance"; seconds: number };
