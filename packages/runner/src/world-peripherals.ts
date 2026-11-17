/**
 * The fields each kind of peripheral takes in a world's `peripherals` list, and the world keys the addons read
 * (`ap`, `mekanism`, `create`, ...). Types only: the Lua side (rom-overlay/rom/ccsim) reads these fields, and
 * schemas/world.schema.json is generated from them (world-schema.test.ts), so a field added to the Lua belongs here
 * too. `PeripheralTypeMap` maps every peripheral type to its fields; a test fails when an addon in addons.ts has a
 * type the map lacks.
 *
 * JSDoc tags the schema generator reads: `@default <JSON>` (or prose, which goes into the description), `@example
 * <JSON>`, `@minimum`, `@maximum`, `@integer`.
 */
import type {
  BlockSpec,
  EntangloporterSpec,
  ItemSpec,
  ModemSpec,
  QioBlockSpec,
  WorldConfig,
} from "./world.js";

// ===== shared =====

/** A block face, as a direction. */
export type Direction = "north" | "south" | "east" | "west" | "up" | "down";
/** A block side relative to the block's front. */
export type RelativeSide =
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom";
/** A side: relative to the block's front, or a direction (matched without case). */
export type AnySide = RelativeSide | Direction;

/** Slot (1-based, as a string key) to item. A JSON array also works: entry i is slot i. */
export type InventoryItems = Record<string, ItemSpec> | ItemSpec[];

/** A fluid, as a tank holds it. */
export interface FluidSpec {
  /** Fluid id, e.g. "minecraft:water". */
  name: string;
  /** Millibuckets. A tank with 0 or less starts empty but keeps the name for a positive `rate`. @default 0 */
  amount?: number;
  /** The fluid's NBT, reported by tanks(). */
  nbt?: unknown;
  /** Display name reported by tanks(). */
  displayName?: string;
  /** Fluid tags without "#". */
  tags?: string[];
}

/** One tank of a generic fluid_storage block. */
export interface TankSpec {
  /** Fluid id; omit for an empty tank. */
  name?: string;
  /** Millibuckets held. @default 0 */
  amount?: number;
  /** Millibuckets the tank holds. @default the block's `capacity`, else 16000 */
  capacity?: number;
  /** Millibuckets per game tick (50 ms of virtual time): in when positive, out when negative; kept within 0..capacity. */
  rate?: number;
  /** The fluid's NBT, reported by tanks(). */
  nbt?: unknown;
  /** Display name reported by tanks(). */
  displayName?: string;
  /** Fluid tags without "#". */
  tags?: string[];
}

/** Fields every peripheral entry has, whatever its type. */
export interface PeripheralBase {
  /**
   * The peripheral's name: a side of the computer ("top", "bottom", "left", "right", "front", "back") or a network
   * name such as "minecraft:chest_0".
   * @example "left"
   */
  name: RelativeSide | (string & {});
  /**
   * Peripheral type: an inventory block id ("minecraft:chest"), "fluid_storage", "energy_storage", "speaker",
   * "modem", "drive", or a type of an addon (Advanced Peripherals, Mekanism, Create, ...). Any other type with
   * inventory, tank or energy fields is a generic block of your own naming (e.g. "thermal:machine_furnace").
   * @example "minecraft:chest"
   */
  type: string;
  /** X coordinate of the block. Peripherals that read positions (player detectors, ...) default to 0. */
  x?: number;
  /** Y coordinate of the block. Peripherals that read positions default to 64. */
  y?: number;
  /** Z coordinate of the block. Peripherals that read positions default to 0. */
  z?: number;
  /** Dimension of the block. @default "minecraft:overworld" */
  dimension?: string;
}

// ===== CC:Tweaked generic peripherals (peripherals.lua) =====

/** Item storage: CC:Tweaked's inventory methods. */
export interface InventorySpec {
  /** Number of slots. @default 27 @integer @minimum 1 */
  size?: number;
  /** Starting contents. A saved state for this peripheral name replaces it. */
  items?: InventoryItems;
}

/** Fluid storage: CC:Tweaked's fluid_storage methods. Use `tanks`, or the single tank `fluid` with `capacity`. */
export interface FluidStorageSpec {
  /** Any number of tanks, each with one fluid. Wins over `fluid`. @default one empty tank */
  tanks?: TankSpec[];
  /** Single-tank form: the fluid at the start (ignored when `tanks` is given). */
  fluid?: FluidSpec;
  /** Single-tank capacity in millibuckets, and the default capacity of each of `tanks`. @default 16000 */
  capacity?: number;
}

/** Energy storage: CC:Tweaked's energy_storage methods. getEnergy and getEnergyCapacity stop at 2147483647. */
export interface EnergyStorageSpec {
  /** FE stored. @default 0 */
  energy?: number;
  /** FE capacity. @default the value of `energy` */
  energyCapacity?: number;
  /** FE per game tick: in when positive, out when negative; kept within 0..energyCapacity. @default 0 */
  energyRate?: number;
}

/**
 * Any generic block: a chest, a tank, a battery, or a modded block with a mix of the three. A block of an unknown
 * type is generic when it has any of size, items, tanks, fluid, energy or energyCapacity.
 */
export interface GenericStorageSpec
  extends InventorySpec,
    FluidStorageSpec,
    EnergyStorageSpec {}

/** CC:Tweaked's speaker: a recording fake (headless has no audio). Sounds land in the sim state. No extra fields. */
export interface SpeakerSpec {}

/** The engine's own disk drive. No extra fields: put disks in with `disks` and the drive methods. */
export interface DriveSpec {}

/**
 * "redstone_relay" is two blocks: CC:Tweaked's redstone relay (CC:Tweaked 1.114.0 and later, so only on 1.20.1 and
 * 1.21.1 worlds: `inputs`, `bundledInputs`) and, with the create-additions addon on, the Create Crafts & Additions
 * redstone relay (`powered`, `supply`, `demand`).
 */
export interface RedstoneRelaySpec {
  /** CC:Tweaked relay: side to analog input level (0-15). @default {} */
  inputs?: Partial<Record<RelativeSide, number>>;
  /** CC:Tweaked relay: side to bundled input bitmask. @default {} */
  bundledInputs?: Partial<Record<RelativeSide, number>>;
  /** Create Crafts & Additions relay: powered by redstone, so it passes energy. @default false */
  powered?: boolean;
  /** Create Crafts & Additions relay: FE per tick available on the input side. @default 0 */
  supply?: number;
  /** Create Crafts & Additions relay: FE per tick wanted on the output side. @default 0 */
  demand?: number;
}

// ===== Advanced Peripherals (rom-overlay/rom/ccsim/ap) =====

/** Fields every Advanced Peripherals block reads. */
export interface ApCommonSpec {
  /** What getName() returns. @default "" */
  customName?: string;
}

/** Players come from the world's `players`. Uses the entry's x, y, z and dimension. */
export interface PlayerDetectorSpec extends ApCommonSpec {}

/** Messages go to the sim's chat log; the cooldown is ap.config.chatMessageCooldown. Uses the entry's position. */
export interface ChatBoxSpec extends ApCommonSpec {}

/** Advanced Peripherals energy detector. */
export interface EnergyDetectorSpec extends ApCommonSpec {
  /** What getTransferRate() returns, FE per tick. The setEnergyTransferRate command changes it. @default 0 */
  transferRate?: number;
  /** What getTransferRateLimit() returns at the start, FE per tick. @default ap.config.energyDetectorMaxFlow (2147483647) */
  transferRateLimit?: number;
}

/** Which way a block faces (only `front` is read). */
export interface FrontOrientation {
  /** The block's front. @default "north" */
  front?: "north" | "south" | "east" | "west";
}

/** Advanced Peripherals redstone integrator. */
export interface RedstoneIntegratorSpec extends ApCommonSpec {
  /** Side (relative, through `orientation`, or a direction) to input level 0-15. @default {} */
  inputs?: Partial<Record<AnySide, number>>;
  /** Turns relative sides into directions; top is always up. */
  orientation?: FrontOrientation;
}

/** Advanced Peripherals NBT storage. */
export interface NbtStorageSpec extends ApCommonSpec {
  /** What read() returns at the start. @default {} */
  stored?: Record<string, unknown>;
}

/** An environment detector's own view of the world: the world's `environment` with these keys winning. */
export interface EnvironmentOverrideSpec {
  /** Day time in ticks (0-24000). @default 1000 */
  time?: number;
  /** Whether it rains. @default false */
  raining?: boolean;
  /** Whether it thunders. @default false */
  thunder?: boolean;
  /** What getBiome() returns. @default "plains" */
  biome?: string;
  /** Sky light, 0-15. @default 15 @minimum 0 @maximum 15 */
  skyLight?: number;
  /** Block light, 0-15. @default 0 @minimum 0 @maximum 15 */
  blockLight?: number;
  /** What listDimensions() returns. @default ["dimension"] */
  dimensions?: string[];
  /** World seed for isSlimeChunk; a decimal string for a long past 2^53. @default 0 */
  seed?: number | string;
  /** getRadiation().radiation. @default "99.9999" */
  radiation?: string | number;
  /** getRadiation().unit. @default "nSv" */
  radiationUnit?: string;
  /** What getRadiationRaw() returns. @default 1e-7 */
  radiationRaw?: number;
  /** Not read: getMoonId always answers 0, as the real block does. */
  moonPhase?: number;
}

/** Advanced Peripherals environment detector. Uses the entry's position. */
export interface EnvironmentDetectorSpec extends ApCommonSpec {
  /** This detector's own environment, over the world's `environment`. */
  environment?: EnvironmentOverrideSpec;
}

/** A stack in an ME or RS network fixture. */
export interface BridgeStackSpec {
  /** Item or fluid id. */
  name: string;
  /** Items, or millibuckets for fluids. @default `count`, else 0 */
  amount?: number;
  /** Used for `amount` when that is missing. */
  count?: number;
  /** Display name. @default the registry name in title case */
  displayName?: string;
  /** The stack's NBT, matched by filters; ME reports it as `{ id, tag }`. */
  nbt?: Record<string, unknown>;
  /** NBT text used in the fingerprint hash. @default "{}" without nbt, else the serialized nbt */
  nbtString?: string;
  /** Tags, e.g. "minecraft:item/forge:ingots/gold". @default [] */
  tags?: string[];
  /** Exact fingerprint; give one for stacks with NBT. @default md5 of nbt, name and displayName */
  fingerprint?: string;
  /** Whether the network can craft it. @default false */
  craftable?: boolean;
  /** Stack limit when exported to an inventory. @default 64 */
  maxCount?: number;
}

/** A storage network's energy. */
export interface BridgeEnergySpec {
  /** What getEnergyStorage() returns. @default 0 */
  stored?: number;
  /** What getMaxEnergyStorage() returns. @default 0 */
  max?: number;
  /** What getEnergyUsage() (ME: getAvgPowerUsage()) returns. @default 0 */
  usage?: number;
  /** ME getAvgPowerInjection(). @default 0 */
  injection?: number;
}

/** Fields meBridge and rsBridge share. */
export interface BridgeCommonSpec extends ApCommonSpec {
  /** Whether the network is connected; methods answer nil, "NOT_CONNECTED" when false. @default true */
  connected?: boolean;
  /** Stored items. @default [] */
  items?: BridgeStackSpec[];
  /** Stored fluids (amount in millibuckets). @default [] */
  fluids?: BridgeStackSpec[];
  /** Items with a pattern, in stock or not. @default [] */
  craftableItems?: BridgeStackSpec[];
  /** Fluids with a pattern. @default [] */
  craftableFluids?: BridgeStackSpec[];
  /** Network energy. @default {} */
  energy?: BridgeEnergySpec;
  /** Side or direction to the name of a virtual inventory or tank peripheral, for export and import by side. */
  adjacent?: Partial<Record<AnySide, string>>;
  /** Turns relative sides in `adjacent` into directions. */
  orientation?: FrontOrientation;
}

/** An ME storage cell. */
export interface MeCellSpec {
  /** Cell item id, e.g. "ae2:item_storage_cell_16k". */
  item: string;
  /** What the cell stores. */
  cellType: "item" | "fluid";
  /** Bytes each distinct type costs. @default 8 */
  bytesPerType?: number;
  /** Cell capacity in bytes. @default 0 */
  totalBytes?: number;
  /** Bytes used. @default worked out from the network's items and fluids */
  usedBytes?: number;
}

/** An ME crafting CPU. */
export interface MeCpuSpec {
  /** Name craftItem(filter, cpu) matches. */
  name?: string;
  /** Bytes. @default 0 */
  storage?: number;
  /** Co-processors. @default 0 */
  coProcessors?: number;
  /** Whether it is crafting. @default false */
  isBusy?: boolean;
  /** Returned as it is by getCraftingCPUs. */
  craftingJob?: Record<string, unknown>;
}

/** Advanced Peripherals ME bridge (Applied Energistics 2). */
export interface MeBridgeSpec extends BridgeCommonSpec {
  /** Storage cells. @default [] */
  cells?: MeCellSpec[];
  /** Crafting CPUs. @default [] */
  cpus?: MeCpuSpec[];
}

/** A stack in a Refined Storage pattern. */
export interface RsPatternStackSpec {
  /** Item or fluid id. */
  name: string;
  /** Items or millibuckets. @default `count`, else 1 */
  amount?: number;
  /** Used for `amount` when that is missing. */
  count?: number;
  /** Display name. @default the registry name in title case */
  displayName?: string;
  /** The stack's NBT. */
  nbt?: Record<string, unknown>;
  /** NBT text used in the fingerprint hash. */
  nbtString?: string;
  /** Tags. @default [] */
  tags?: string[];
  /** Exact fingerprint. */
  fingerprint?: string;
}

/** A Refined Storage pattern. */
export interface RsPatternSpec {
  /** What getPattern(filter) matches against. */
  outputs?: RsPatternStackSpec[];
  /** One list per input slot (alternatives). */
  inputs?: RsPatternStackSpec[][];
  /** By-products; reported as [] when `processing` is true. */
  byproducts?: RsPatternStackSpec[];
  /** A processing pattern. @default false */
  processing?: boolean;
}

/** Refined Storage capacities for the getMax*Storage methods. */
export interface RsStorageSpec {
  /** Item disk capacity. @default 0 */
  maxItemDisk?: number;
  /** Fluid disk capacity. @default 0 */
  maxFluidDisk?: number;
  /** External item storage capacity. @default 0 */
  maxItemExternal?: number;
  /** External fluid storage capacity. @default 0 */
  maxFluidExternal?: number;
}

/** Advanced Peripherals RS bridge (Refined Storage). */
export interface RsBridgeSpec extends BridgeCommonSpec {
  /** Patterns. @default [] */
  patterns?: RsPatternSpec[];
  /** Capacities. @default {} */
  storage?: RsStorageSpec;
  /** RS calculation result. Anything but "OK" makes craftItem and craftFluid answer false. @default "OK" */
  craftResult?: string;
}

/** Advanced Peripherals AR controller: draw calls are recorded in the sim state. */
export interface ArControllerSpec extends ApCommonSpec {}

/** Front and top directions, as "north_up" or `{ front, top }`. */
export type FrontAndTop =
  | `${Direction}_${Direction}`
  | {
      /** The front. @default "north" */
      front?: Direction;
      /** The top. @default "up" */
      top?: Direction;
    };

/** A peripheral's own block world, used only when the world itself has no blocks, fills or ground. */
export interface OwnBlockWorldSpec {
  /** Blocks around it, as the world's `blocks`. */
  blocks?: BlockSpec[];
  /** Boxes of blocks, as the world's `fills`. */
  fills?: WorldConfig["fills"];
  /** The ground, as the world's `ground`. */
  ground?: WorldConfig["ground"];
}

/** Advanced Peripherals geo scanner. */
export interface GeoScannerSpec extends ApCommonSpec, OwnBlockWorldSpec {
  /** FE stored; read only when ap.config.enablePoweredPeripherals is true. @default 0 */
  energy?: number;
  /** FE capacity when powered. @default ap.config.poweredPeripheralMaxEnergyStored (100000000) */
  energyCapacity?: number;
}

/** The block in front of a block reader. */
export interface BlockReaderBlockSpec {
  /** Block id ("minecraft:air" is nothing). */
  name: string;
  /** What getBlockData() returns. */
  blockEntity?: Record<string, unknown>;
  /** Container contents, reported as `Items`. */
  items?: InventoryItems;
  /** Marks it as a container even with no items. */
  size?: number;
}

/** Advanced Peripherals block reader. */
export interface BlockReaderSpec extends ApCommonSpec, OwnBlockWorldSpec {
  /** A fixed block in front (a string is `{ name }`); wins over the block world. */
  block?: string | BlockReaderBlockSpec;
  /** Which way the reader faces. @default the block's `orientation` state, then `facing`, then "north_up" */
  orientation?: FrontAndTop;
  /** Front when there is no `orientation`, top up. */
  facing?: Direction;
}

/** Advanced Peripherals inventory manager. Players' items are in ap.players. */
export interface InventoryManagerSpec extends ApCommonSpec, OwnBlockWorldSpec {
  /** Player bound to the memory card; must match an online player exactly. Omit for no card. */
  owner?: string;
  /** Side or direction to the name of an inventory peripheral; else the container next to it in the block world. */
  adjacent?: Partial<Record<AnySide, string>>;
  /** Which way it faces. @default the block's `orientation` state, then `facing`, then "north_up" */
  orientation?: FrontAndTop;
  /** Front when there is no `orientation`, top up. */
  facing?: Direction;
}

/** Advanced Peripherals chunky turtle upgrade. No extra fields. */
export interface ChunkySpec extends ApCommonSpec {}

/** Costs of an Advanced Peripherals scan. Give all four: an object replaces the whole default. */
export interface ApScanConfig {
  /** Milliseconds between scans. @default 2000 */
  cooldown?: number;
  /** Radius scanned for free. @default 8 */
  maxFreeRadius?: number;
  /** Largest radius allowed. @default 16 */
  maxCostRadius?: number;
  /** Fuel per extra block. @default 0.17 */
  extraBlockCost?: number;
}

/** Overrides of the Advanced Peripherals server config. */
export interface ApConfig {
  /** Largest player detector range, blocks. @default 100000000 */
  playerDetMaxRange?: number;
  /** Whether getPlayerPos works. @default true */
  enablePlayerPosFunction?: boolean;
  /** getPlayerPos adds yaw, pitch, dimension and eyeHeight. @default true */
  morePlayerInformation?: boolean;
  /** Chat box prefix. @default "AP" */
  defaultChatBoxPrefix?: string;
  /** Milliseconds between chat messages. @default 100 */
  chatMessageCooldown?: number;
  /** Energy detector's largest flow, FE per tick. @default 2147483647 */
  energyDetectorMaxFlow?: number;
  /** nbtStorage writeJson's largest length, bytes. @default 1048576 */
  nbtStorageMaxSize?: number;
  /** FE per fuel point. @default 575 */
  energyToFuelRate?: number;
  /** Default FE capacity of powered peripherals. @default 100000000 */
  poweredPeripheralMaxEnergyStored?: number;
  /** Geo scanners use fuel. @default false */
  enablePoweredPeripherals?: boolean;
  /** environmentDetector.scanEntities costs. */
  scanEntities?: ApScanConfig;
  /** geoScanner scan and chunkAnalyze costs. */
  scanBlocks?: ApScanConfig;
}

/** An item a player carries, for the inventory manager. */
export interface ApPlayerItemSpec {
  /** Item id. */
  name: string;
  /** Stack size; stacks of 0 or less are dropped. @default 1 */
  count?: number;
  /** Display name. @default the game data's display name */
  displayName?: string;
  /** Tags, replacing the registry's. */
  tags?: string[];
  /** The stack's NBT. */
  nbt?: Record<string, unknown>;
  /** NBT text used in the fingerprint hash. */
  nbtString?: string;
  /** Exact fingerprint. @default md5 of nbt, name and displayName */
  fingerprint?: string;
  /** Stack limit. @default the game data's */
  maxCount?: number;
  /** Armour slot it equips to. @default from the name (_helmet, _chestplate, _leggings, _boots, elytra, heads) */
  equipSlot?: "head" | "chest" | "legs" | "feet";
  /** Counts as an ArmorItem for getArmor's slot numbers. @default from the name */
  armorItem?: boolean;
  /** Damage, part of stack equality. @default 0 */
  damage?: number;
}

/** What one player carries. */
export interface ApPlayerInventorySpec {
  /** Slot "0".."35" to item. */
  inventory?: Record<string, ApPlayerItemSpec>;
  /** "feet", "legs", "chest", "head" (or "0".."3", "100".."103") to item. */
  armor?: Record<string, ApPlayerItemSpec>;
  /** The offhand item. */
  offhand?: ApPlayerItemSpec;
  /** Held hotbar slot, 0-8. @default 0 @integer @minimum 0 @maximum 8 */
  selected?: number;
}

/** Advanced Peripherals settings: server config and what players carry. */
export interface ApWorld {
  /** Overrides of the Advanced Peripherals server config (cooldowns, ranges, ...). */
  config?: ApConfig;
  /** Player name to what they carry, for the inventory manager. */
  players?: Record<string, ApPlayerInventorySpec>;
}

// ===== Mekanism (rom-overlay/rom/ccsim/addons/mekanism-machines, mekanism-generators) =====

/** An enum Mekanism upper-cases before checking: either case works. */
type Ci<T extends string> = T | Lowercase<T>;
/** A rate per tick (J/t or mB/t): a number, or "max" (a negative number is unlimited too). */
export type MekRate = number | "max";
/** A tank: millibuckets of the tank's default fluid or chemical, or `{ name, amount }`. */
export type MekTankSpec =
  | number
  | {
      /** Fluid or chemical id. @default the tank's default */
      name?: string;
      /** Millibuckets. @default 0 */
      amount?: number;
    };
/** An item slot. */
export interface MekItemStackSpec {
  /** Item id. */
  name: string;
  /** Stack size. @default 1 */
  count?: number;
}
/** A block position. */
export interface MekPos {
  /** X coordinate. */
  x: number;
  /** Y coordinate. */
  y: number;
  /** Z coordinate. */
  z: number;
}

/** A Mekanism direction. */
export type MekDirection = "NORTH" | "SOUTH" | "EAST" | "WEST" | "UP" | "DOWN";
/** A redstone control mode. */
export type MekRedstoneControl = "DISABLED" | "HIGH" | "LOW" | "PULSE";
/** A security mode. */
export type MekSecurityMode = "PUBLIC" | "PRIVATE" | "TRUSTED";
/** A side relative to the block's front. */
export type MekRelativeSide =
  | "FRONT"
  | "LEFT"
  | "RIGHT"
  | "BACK"
  | "TOP"
  | "BOTTOM";
/** A transmission type. */
export type MekTransmissionType =
  | "ENERGY"
  | "FLUID"
  | "GAS"
  | "INFUSION"
  | "PIGMENT"
  | "SLURRY"
  | "ITEM"
  | "HEAT";
/** A side config data type. */
export type MekDataType =
  | "NONE"
  | "INPUT"
  | "INPUT_1"
  | "INPUT_2"
  | "OUTPUT"
  | "OUTPUT_1"
  | "OUTPUT_2"
  | "INPUT_OUTPUT"
  | "ENERGY"
  | "EXTRA";
/** A gas tank's dumping mode. */
export type MekGasMode = "IDLE" | "DUMPING_EXCESS" | "DUMPING";
/** A container edit mode. */
export type MekContainerEditMode = "BOTH" | "FILL" | "EMPTY";
/** A transporter colour. */
export type MekEnumColor =
  | "BLACK"
  | "DARK_BLUE"
  | "DARK_GREEN"
  | "DARK_AQUA"
  | "DARK_RED"
  | "PURPLE"
  | "ORANGE"
  | "GRAY"
  | "DARK_GRAY"
  | "INDIGO"
  | "BRIGHT_GREEN"
  | "AQUA"
  | "RED"
  | "PINK"
  | "YELLOW"
  | "WHITE"
  | "BROWN"
  | "BRIGHT_PINK";
/** A tier. */
export type MekTier = "basic" | "advanced" | "elite" | "ultimate";

/**
 * Installed upgrades by name (either case) to count: SPEED, ENERGY and GAS up to 8, MUFFLING 4, others 1. An upgrade
 * the block does not take is an error; blocks with no upgrades ignore it.
 */
export interface MekUpgrades
  extends Partial<
    Record<
      Ci<
        | "SPEED"
        | "ENERGY"
        | "FILTER"
        | "GAS"
        | "MUFFLING"
        | "ANCHOR"
        | "STONE_GENERATOR"
      >,
      number
    >
  > {}

/** Fields every Mekanism block reads. */
export interface MekTileBase {
  /** false: the block starts unformed (only the tile's own methods). @default true */
  formed?: boolean;
  /** Facing, for getDirection. @default "NORTH" */
  facing?: Ci<MekDirection>;
  /** Security mode; setters fail unless PUBLIC. @default "PUBLIC" */
  security?: Ci<MekSecurityMode>;
  /** Owner: a player name or UUID the world knows, or a raw UUID. */
  owner?: string;
}
/** A block with redstone control. */
export interface MekRedstoneTile {
  /** Redstone control (setRedstoneMode refuses PULSE). @default "DISABLED" */
  redstoneMode?: Ci<MekRedstoneControl>;
  /** Redstone signal at the start (the mekSetRedstone command changes it). @default false */
  powered?: boolean;
}
/** A block with a side config. */
export interface MekSideConfigTile {
  /** Overrides of the default side config: transmission type to side to mode. */
  sideConfig?: MekSideConfig;
}
/** Side config overrides: transmission type to the mode of each side. */
export interface MekSideConfig
  extends Partial<Record<Ci<MekTransmissionType>, MekSideModes>> {}
/** Side (relative to the front) to its data type. */
export interface MekSideModes
  extends Partial<Record<Ci<MekRelativeSide>, Ci<MekDataType>>> {}
/** A block that takes upgrades. */
export interface MekUpgradable {
  /** Installed upgrades. */
  upgrades?: MekUpgrades;
}
/** A block with an energy buffer. */
export interface MekEnergyStore {
  /** Stored energy, J (kept within the capacity). @default 0 */
  energy?: number;
  /** Energy cabled in, J/t. */
  energyInput?: MekRate;
}
/** A block with an energy item slot. */
export interface MekEnergySlot {
  /** Energy item slot. */
  energyItem?: MekItemStackSpec;
}

/** A Digital Miner filter. */
export interface MekMinerFilter {
  /** Filter type (either case). */
  type: Ci<
    | "MINER_ITEMSTACK_FILTER"
    | "MINER_MATERIAL_FILTER"
    | "MINER_MODID_FILTER"
    | "MINER_TAG_FILTER"
  >;
  /** Item stack filters: the item id. */
  item?: string;
  /** Material filters: an item of the material. */
  materialItem?: string;
  /** Mod id filters: the mod id; * and ? are wildcards. */
  modId?: string;
  /** Tag filters: the tag; * and ? are wildcards. */
  tag?: string;
  /** Whether a replacement block is needed. @default false */
  requiresReplacement?: boolean;
  /** Block to replace mined blocks with. @default "minecraft:air" */
  replaceTarget?: string;
}
/** A Logistical Sorter filter. */
export interface MekSorterFilter {
  /** Filter type (either case). */
  type: Ci<
    | "SORTER_ITEMSTACK_FILTER"
    | "SORTER_MATERIAL_FILTER"
    | "SORTER_MODID_FILTER"
    | "SORTER_TAG_FILTER"
  >;
  /** Item stack filters: the item id. */
  item?: string;
  /** Material filters: an item of the material. */
  materialItem?: string;
  /** Mod id filters: the mod id; * and ? are wildcards. */
  modId?: string;
  /** Tag filters: the tag; * and ? are wildcards. */
  tag?: string;
  /** Allow default routing. @default false */
  allowDefault?: boolean;
  /** Transporter colour. @default none */
  color?: Ci<MekEnumColor>;
  /** Size mode. @default false */
  size?: boolean;
  /** Smallest stack, 0..64. @default 0 */
  min?: number;
  /** Largest stack, 0..64. @default 0 */
  max?: number;
  /** Item stack filters: ignore NBT. @default false */
  fuzzy?: boolean;
}
/** An Oredictionificator filter. */
export interface MekOredictionificatorFilter {
  /** Filter type. */
  type: Ci<"OREDICTIONIFICATOR_ITEM_FILTER">;
  /** A tag under forge:dusts/, ingots/, nuggets/, ores/ or storage_blocks/. */
  target: string;
  /** The selected output item. */
  selected?: string;
}

/** Mekanism energy cube. */
export interface EnergyCubeSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile {
  /** Stored J (basic 4M, advanced 16M, elite 64M, ultimate 256M). @default 0 (creative: full) */
  energy?: number;
  /** Charge slot. */
  chargeItem?: MekItemStackSpec;
  /** Discharge slot. */
  dischargeItem?: MekItemStackSpec;
  /** J/t cabled in (the creative cube ignores it). */
  energyInput?: MekRate;
  /** Load on the front output, J/t; at most the tier's output, and it needs ENERGY ejecting. */
  energyOutput?: MekRate;
}
/** Mekanism fluid tank. */
export interface FluidTankSpec extends MekTileBase {
  /** Contents (basic 32k to ultimate 256k mB). @default name "minecraft:water" */
  fluid?: MekTankSpec;
  /** Container edit mode. @default "BOTH" */
  editMode?: Ci<MekContainerEditMode>;
  /** Active: it outputs down only while active. @default false */
  active?: boolean;
  /** Input container slot. */
  inputItem?: MekItemStackSpec;
  /** Output container slot. */
  outputItem?: MekItemStackSpec;
  /** mB/t piped in. */
  fluidInput?: MekRate;
  /** mB/t taken from below, at most the tier's output; only while active. */
  fluidOutput?: MekRate;
}
/** Mekanism chemical tank. */
export interface ChemicalTankSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile {
  /** Contents (basic 64k to ultimate 8.192M mB). @default name "mekanism:hydrogen" */
  chemical?: MekTankSpec;
  /** Dumping mode. @default "IDLE" */
  dumpingMode?: Ci<MekGasMode>;
  /** Drain slot (getDrainItem). */
  inputItem?: MekItemStackSpec;
  /** Fill slot (getFillItem). */
  outputItem?: MekItemStackSpec;
  /** mB/t piped in. */
  chemicalInput?: MekRate;
  /** mB/t taken, at most the tier's output; needs GAS ejecting. */
  chemicalOutput?: MekRate;
}
/** Mekanism bin. */
export interface BinSpec {
  /** false: the block starts unformed. @default true */
  formed?: boolean;
  /** Facing. @default "NORTH" */
  facing?: Ci<MekDirection>;
  /** Stored item (at most 4096, 8192, 32768, 262144 by tier; creative 2^31-1). */
  item?: MekItemStackSpec;
  /** Pushes the bottom stack down every 10 ticks while active. @default false */
  active?: boolean;
  /** A block below takes whatever is pushed. @default false */
  below?: boolean;
}

/** Mekanism electric machine (enrichment chamber, crusher, energized smelter). */
export interface ElectricMachineSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Input slot. */
  input?: MekItemStackSpec;
  /** Output slot. */
  output?: MekItemStackSpec;
  /** What one input becomes. @default the input's own name */
  recipeOutput?: string;
}
/** Mekanism metallurgic infuser. */
export interface MetallurgicInfuserSpec extends ElectricMachineSpec {
  /** Infuse tank (1000 mB). @default name "mekanism:redstone" */
  infuse?: MekTankSpec;
  /** Infuse mB per operation. @default 10 */
  infusePerOperation?: number;
  /** Infuse item slot. */
  infuseItem?: MekItemStackSpec;
  /** Infuse mB/t piped in. */
  infuseInput?: MekRate;
}
/** Mekanism electrolytic separator. */
export interface ElectrolyticSeparatorSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Water tank (24000 mB). @default name "minecraft:water" */
  water?: MekTankSpec;
  /** Left gas tank (2400 mB). @default name "mekanism:hydrogen" */
  left?: MekTankSpec;
  /** Right gas tank (2400 mB). @default name "mekanism:oxygen" */
  right?: MekTankSpec;
  /** Gas made on the left (2 mB per operation). @default "mekanism:hydrogen" */
  leftGas?: string;
  /** Gas made on the right (1 mB per operation). @default "mekanism:oxygen" */
  rightGas?: string;
  /** Left tank's dumping mode. @default "IDLE" */
  leftDumpingMode?: Ci<MekGasMode>;
  /** Right tank's dumping mode. @default "IDLE" */
  rightDumpingMode?: Ci<MekGasMode>;
  /** Fluid input slot. */
  inputItem?: MekItemStackSpec;
  /** Left output slot. */
  leftItem?: MekItemStackSpec;
  /** Right output slot. */
  rightItem?: MekItemStackSpec;
  /** Water mB/t piped in. */
  waterInput?: MekRate;
  /** Left gas taken, mB/t (at most 1024, needs GAS ejecting). */
  leftOutput?: MekRate;
  /** Right gas taken, mB/t (at most 1024, needs GAS ejecting). */
  rightOutput?: MekRate;
}

/** A factory recipe: the output item id, or the full form. */
export type FactoryRecipeSpec =
  | string
  | {
      /** Output item. @default the input's name */
      output?: string;
      /** Output count. @default 1 */
      count?: number;
      /** Input items used. @default 1 */
      input?: number;
      /** Sawing only: the secondary output. */
      secondary?: {
        /** Item id. */
        name: string;
        /** Chance, 0..1. @default 1 */
        chance?: number;
        /** Count. @default 1 */
        count?: number;
      };
    };
/** Mekanism factory (smelting, enriching, crushing; the other kinds add their own fields). */
export interface FactorySpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Input slot per process (3, 5, 7 or 9 by tier). */
  inputs?: (MekItemStackSpec | null)[];
  /** Output slot per process. */
  outputs?: (MekItemStackSpec | null)[];
  /** inputs[0], when there is no `inputs`. */
  input?: MekItemStackSpec;
  /** Recipes by input item id. */
  recipes?: Record<string, FactoryRecipeSpec>;
  /** Output for any input `recipes` lacks. Neither set: an input becomes itself. */
  recipeOutput?: string;
  /** Auto-sort. @default false */
  sorting?: boolean;
  /** Same as `sorting`. */
  autoSort?: boolean;
}
/** Mekanism compressing, purifying or injecting factory. */
export interface ChemicalFactorySpec extends FactorySpec {
  /** Chemical tank (210 mB per process). @default name compressing "mekanism:osmium", purifying "mekanism:oxygen", injecting "mekanism:hydrogen_chloride" */
  chemical?: MekTankSpec;
  /** Chemical per tick of a recipe. @default 1 */
  chemicalPerTick?: number;
  /** Chemical item slot. */
  extraItem?: MekItemStackSpec;
  /** Same as `extraItem`. */
  secondaryInput?: MekItemStackSpec;
  /** Chemical mB/t piped in. */
  chemicalInput?: MekRate;
}
/** Mekanism infusing factory. */
export interface InfusingFactorySpec extends FactorySpec {
  /** Infuse tank (1000 mB per process). @default name "mekanism:redstone" */
  infuse?: MekTankSpec;
  /** Infuse mB per operation. @default 10 */
  infusePerOperation?: number;
  /** Infuse item slot. */
  extraItem?: MekItemStackSpec;
  /** Same as `extraItem`. */
  secondaryInput?: MekItemStackSpec;
  /** Infuse mB/t piped in. */
  infuseInput?: MekRate;
}
/** Mekanism combining factory. */
export interface CombiningFactorySpec extends FactorySpec {
  /** Secondary input slot. */
  secondaryInput?: MekItemStackSpec;
  /** Same as `secondaryInput`. */
  extraItem?: MekItemStackSpec;
  /** Secondary items per operation. @default 1 */
  secondaryPerOperation?: number;
}
/** Mekanism sawing factory. */
export interface SawingFactorySpec extends FactorySpec {
  /** Secondary output slot per process. */
  secondaryOutputs?: (MekItemStackSpec | null)[];
}

/** One recipe entry override: an amount, false (amount 0), or name, amount and chance. */
export type MekRecipeEntrySpec =
  | number
  | false
  | {
      /** Item, fluid or chemical id. */
      name?: string;
      /** Amount. */
      amount?: number;
      /** Item count. */
      count?: number;
      /** Chance, 0..1. */
      chance?: number;
    };
/** Overrides of a machine's default recipe, by input or output slot or tank, plus `duration` and `energy`. */
export interface MekRecipeSpec {
  /** Ticks per operation. @default the machine's own */
  duration?: number;
  /** J/t on top of the base usage. @default 0 */
  energy?: number;
  /** A recipe input or output (named as the machine's slots and tanks) to its override. */
  [entry: string]: MekRecipeEntrySpec | undefined;
}
/**
 * A Mekanism recipe machine (sawmill, compressor, chemical machines, ...). Its item slots, tanks (mB) and the tanks'
 * `<tank>Input` / `<tank>Output` rates (mB/t) are named as in its GUI: see docs/mekanism-multiblocks.md.
 */
export interface RecipeMachineSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Recipe overrides. */
  recipe?: MekRecipeSpec;
  /** Item slots (MekItemStackSpec), tanks (MekTankSpec) and rates (MekRate), named per machine. */
  [slotOrTank: string]: unknown;
}
/** Mekanism rotary condensentrator. */
export interface RotaryCondensentratorSpec extends RecipeMachineSpec {
  /** false: decondensentrating (fluid to gas). @default true */
  condensentrating?: boolean;
}
/** Mekanism solar neutron activator. No energy, no upgrades. */
export interface SolarNeutronActivatorSpec extends RecipeMachineSpec {
  /** Whether it sees the sky. @default true */
  canSeeSky?: boolean;
  /** Biome temperature. @default 0.8 */
  biomeTemperature?: number;
  /** Biome downfall. @default 0.4 */
  downfall?: number;
  /** Whether the biome has precipitation. @default true */
  precipitation?: boolean;
}

/** Mekanism digital miner. */
export interface DigitalMinerSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Lowest build height. @default -64 */
  minBuildHeight?: number;
  /** Highest build height. @default 320 */
  maxBuildHeight?: number;
  /** Radius, blocks. @default 10 */
  radius?: number;
  /** Lowest Y it mines. @default 0 */
  minY?: number;
  /** Highest Y it mines. @default minY + 60 */
  maxY?: number;
  /** Silk touch. @default false */
  silkTouch?: boolean;
  /** Auto-eject. @default false */
  autoEject?: boolean;
  /** Auto-pull. @default false */
  autoPull?: boolean;
  /** Inverse mode. @default false */
  inverse?: boolean;
  /** Inverse mode needs a replacement block. @default false */
  inverseRequiresReplacement?: boolean;
  /** Inverse mode's replacement block. @default "minecraft:air" */
  inverseReplaceTarget?: string;
  /** Filters. */
  filters?: MekMinerFilter[];
  /** The 27 inventory slots. */
  items?: (MekItemStackSpec | null)[];
  /** Blocks the search finds. @default 0 */
  ores?: number;
  /** What one mined block gives. @default "minecraft:cobblestone" */
  drop?: string;
  /** Start running with the search done. @default false */
  running?: boolean;
  /** With autoEject, eject the inventory every 10 ticks. @default true */
  ejectInventory?: boolean;
}

/** Mekanism electric pump or fluidic plenisher. */
export interface PumpSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Input container slot. */
  inputItem?: MekItemStackSpec;
  /** Output container slot. */
  outputItem?: MekItemStackSpec;
  /** Tank (10000 mB). @default name "minecraft:water" */
  fluid?: MekTankSpec;
  /** Pump: source blocks left to pump; plenisher: air blocks left to fill. @default 0 */
  blocks?: number;
  /** Fluid pumped. @default "minecraft:water" */
  fluidType?: string;
  /** mB/t piped in. */
  fluidInput?: MekRate;
  /** mB/t piped out. */
  fluidOutput?: MekRate;
}
/** Mekanism resistive heater. */
export interface ResistiveHeaterSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekEnergyStore,
    MekEnergySlot {
  /** Ambient temperature, K. @default 300 */
  ambientTemperature?: number;
  /** Temperature, K. @default ambientTemperature */
  temperature?: number;
  /** Heat to a neighbour, J/t. */
  heatOutput?: MekRate;
  /** J/t used (capacity is 400 times this; 60% becomes heat). @default 100 */
  energyUsage?: number;
}
/** Mekanism fuelwood heater. */
export interface FuelwoodHeaterSpec extends MekTileBase {
  /** Ambient temperature, K. @default 300 */
  ambientTemperature?: number;
  /** Temperature, K. @default ambientTemperature */
  temperature?: number;
  /** Heat to a neighbour, J/t. */
  heatOutput?: MekRate;
  /** Fuel slot. */
  fuelItem?: MekItemStackSpec;
  /** Ticks left on the current fuel. @default 0 */
  burnTime?: number;
  /** Burn ticks of one fuel item (charcoal 1600). @default 300 */
  fuelBurnTime?: number;
}
/** Mekanism seismic vibrator. */
export interface SeismicVibratorSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekEnergyStore,
    MekEnergySlot {}
/** Mekanism laser, laser amplifier or laser tractor beam. */
export interface LaserSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekEnergyStore {
  /** Block being dug. */
  digging?: MekPos;
  /** Amplifier: ticks between pulses. @default 0 */
  delay?: number;
  /** Amplifier: lowest threshold, J. @default 0 */
  minThreshold?: number;
  /** Amplifier: highest threshold, J. @default the block's storage */
  maxThreshold?: number;
  /** Amplifier: redstone output mode. @default "OFF" */
  redstoneOutputMode?: Ci<"OFF" | "ENTITY_DETECTION" | "ENERGY_CONTENTS">;
  /** Tractor beam: the 27 slots. */
  slots?: (MekItemStackSpec | null)[];
}
/** Mekanism teleporter. Its own x, y, z and dimension are its coordinate. */
export interface TeleporterSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Frequency name (a public PURPLE frequency is made if nobody declared it). */
  frequency?: string;
  /** Whether the frame is built. @default true */
  frame?: boolean;
}
/** Mekanism chargepad. */
export interface ChargepadSpec extends MekEnergyStore {
  /** false: the block starts unformed. @default true */
  formed?: boolean;
  /** Facing. @default "NORTH" */
  facing?: Ci<MekDirection>;
  /** Something on the pad is charging. @default false */
  charging?: boolean;
}
/** Mekanism logistical sorter. */
export interface LogisticalSorterSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekUpgradable {
  /** Default colour. @default none */
  defaultColor?: Ci<MekEnumColor>;
  /** Auto mode. @default false */
  autoMode?: boolean;
  /** Round robin. @default false */
  roundRobin?: boolean;
  /** Single-item mode. @default false */
  single?: boolean;
  /** Filters. */
  filters?: MekSorterFilter[];
}
/** Mekanism oredictionificator. */
export interface OredictionificatorSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile {
  /** Input slot. */
  inputItem?: MekItemStackSpec;
  /** Output slot. */
  outputItem?: MekItemStackSpec;
  /** Filters. */
  filters?: MekOredictionificatorFilter[];
}
/** Mekanism formulaic assemblicator. */
export interface FormulaicAssemblicatorSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekSideConfigTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Formula slot. */
  formulaItem?: MekItemStackSpec;
  /** The 9 grid slots. */
  grid?: (MekItemStackSpec | null)[];
  /** The 18 input slots. */
  inputs?: (MekItemStackSpec | null)[];
  /** The 3 output slots. */
  outputs?: (MekItemStackSpec | null)[];
  /** The formula in the slot. */
  formula?: {
    /** The formula is valid. */
    valid?: boolean;
    /** The formula is encoded. */
    encoded?: boolean;
  };
  /** The grid holds a valid recipe. @default false */
  hasRecipe?: boolean;
  /** Auto mode. @default false */
  autoMode?: boolean;
  /** Stock control. @default false */
  stockControl?: boolean;
}
/** Mekanism modification station. */
export interface ModificationStationSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekEnergyStore,
    MekEnergySlot {
  /** Module slot. */
  moduleItem?: MekItemStackSpec;
  /** Container slot. */
  containerItem?: MekItemStackSpec;
}
/** Mekanism dimensional stabilizer. */
export interface DimensionalStabilizerSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekUpgradable,
    MekEnergyStore,
    MekEnergySlot {
  /** Extra chunks loaded, offsets -2..2 from the centre (always loaded). */
  chunks?: {
    /** Chunk X offset. */
    x: number;
    /** Chunk Z offset. */
    z: number;
  }[];
}

/** Mekanism universal cable. */
export interface UniversalCableSpec {
  /** Transmitters in the network (capacity is the tier's times this). @default 1 */
  network?: number;
  /** Network buffer, J. @default 0 */
  buffer?: number;
}
/** Mekanism mechanical pipe or pressurized tube. */
export interface PipeSpec {
  /** Transmitters in the network. @default 1 */
  network?: number;
  /** Network buffer. @default name "minecraft:water" (pipes) or "mekanism:hydrogen" (tubes) */
  buffer?: MekTankSpec;
}
/** Mekanism diversion transporter. */
export interface DiversionTransporterSpec {
  /** Mode per direction. @default "DISABLED" each */
  modes?: Partial<Record<Direction, Ci<"DISABLED" | "HIGH" | "LOW">>>;
}

/** Mekanism Generators generator. */
export interface GeneratorSpec
  extends MekTileBase,
    MekRedstoneTile,
    MekUpgradable {
  /** Stored J. @default 0 */
  energy?: number;
  /** Fuel slot. */
  fuelItem?: MekItemStackSpec;
  /** Energy item slot. */
  energyItem?: MekItemStackSpec;
  /** Cable load, J/t (at most the generator's output). */
  energyOutput?: MekRate;
}
/** Mekanism solar or advanced solar generator. */
export interface SolarGeneratorSpec extends GeneratorSpec {
  /** Whether it sees the sky. @default true */
  canSeeSky?: boolean;
  /** Whether the dimension has sky light. @default true */
  hasSkyLight?: boolean;
  /** Biome temperature. @default 0.8 */
  biomeTemperature?: number;
  /** Biome downfall. @default 0.4 */
  downfall?: number;
  /** Whether the biome has precipitation. @default true */
  precipitation?: boolean;
}
/** Mekanism wind generator. Its `y` sets the height multiplier. */
export interface WindGeneratorSpec extends GeneratorSpec {
  /** Whether it sees the sky. @default true */
  canSeeSky?: boolean;
  /** The dimension is blacklisted (no output). @default false */
  blacklistedDimension?: boolean;
  /** Lowest Y of the height range. @default 24 */
  minY?: number;
  /** Highest Y of the height range. @default 384 */
  maxY?: number;
}
/** Mekanism heat generator. */
export interface HeatGeneratorSpec extends GeneratorSpec {
  /** Lava tank (24000 mB). @default name "minecraft:lava" */
  lava?: MekTankSpec;
  /** Ambient temperature, K. @default 300 */
  ambientTemperature?: number;
  /** Temperature, K. @default ambientTemperature */
  temperature?: number;
  /** Lava source blocks next to it (+30 each). @default 0 */
  lavaSides?: number;
  /** In an ultrawarm dimension (+100). @default false */
  nether?: boolean;
  /** Lava mB/t piped in. */
  lavaInput?: MekRate;
}
/** Mekanism bio-generator. */
export interface BioGeneratorSpec extends GeneratorSpec {
  /** Bioethanol tank (24000 mB). @default name "mekanismgenerators:bioethanol" */
  bioFuel?: MekTankSpec;
  /** mB/t piped in. */
  bioFuelInput?: MekRate;
}
/** Mekanism gas-burning generator. */
export interface GasBurningGeneratorSpec extends GeneratorSpec {
  /** Fuel tank (18000 mB): mekanism:hydrogen or mekanism:ethene. @default name "mekanism:hydrogen" */
  fuel?: MekTankSpec;
  /** mB/t piped in. */
  fuelInput?: MekRate;
}

/** Fields every Mekanism multiblock has. */
export interface MekMultiblockCommon {
  /** Whether it is formed. @default true */
  formed?: boolean;
  /** Outer length. @default per kind */
  length?: number;
  /** Outer width. @default per kind */
  width?: number;
  /** Outer height. @default per kind */
  height?: number;
  /** Lowest corner. @default {"x":0,"y":64,"z":0} */
  minPos?: MekPos;
  /** Shell blocks. @default worked out from the size */
  casings?: number;
  /** Ambient temperature, K. @default 300 */
  ambientTemperature?: number;
}
/** Thermoelectric boiler fields (default 5x5x6). */
export interface BoilerFields {
  /** Water cavity volume. @default worked out from the size */
  waterVolume?: number;
  /** Steam cavity volume. @default worked out from the size */
  steamVolume?: number;
  /** Superheating elements. @default 0 */
  superheaters?: number;
  /** Water tank. @default name "minecraft:water" */
  water?: MekTankSpec;
  /** Steam tank. @default name "mekanism:steam" */
  steam?: MekTankSpec;
  /** Heated coolant tank. @default name "mekanism:superheated_sodium" */
  heatedCoolant?: MekTankSpec;
  /** Cooled coolant tank. @default name "mekanism:sodium" */
  cooledCoolant?: MekTankSpec;
  /** Temperature, K. @default ambientTemperature */
  temperature?: number;
  /** J/t from heaters. */
  heatInput?: MekRate;
  /** Water mB/t in. */
  waterInput?: MekRate;
  /** Steam mB/t out (through an OUTPUT_STEAM valve if there are valves). */
  steamOutput?: MekRate;
  /** Multiblock id (a turbine) that gets the steam. */
  steamTo?: string;
  /** Cooled coolant mB/t out (OUTPUT_COOLANT valve). */
  cooledCoolantOutput?: MekRate;
  /** Multiblock id (a fission reactor) that gets the cooled sodium. */
  cooledCoolantTo?: string;
}
/** Induction cells or providers: a count of basic ones, or a count per tier. */
export type InductionTierCounts = number | Partial<Record<MekTier, number>>;
/** Induction matrix fields (default 5x5x5). */
export interface MatrixFields {
  /** Induction cells. @default {"basic":1} */
  cells?: InductionTierCounts;
  /** Induction providers. @default {"basic":1} */
  providers?: InductionTierCounts;
  /** Stored J. @default 0 */
  energy?: number;
  /** Input slot. */
  inputItem?: MekItemStackSpec;
  /** Output slot. */
  outputItem?: MekItemStackSpec;
  /** J/t in through input ports. */
  input?: MekRate;
  /** J/t out through output ports. */
  output?: MekRate;
  /** Input ports no computer sees (more than 0 allows input). */
  inputPorts?: number;
  /** Output ports no computer sees (more than 0 allows output). */
  outputPorts?: number;
}
/** A dynamic tank's contents. */
export type DynamicTankContents =
  | MekTankSpec
  | {
      /** Fluid or chemical id. */
      name?: string;
      /** Millibuckets. */
      amount?: number;
      /** What it holds. */
      type?: Ci<"FLUID" | "GAS" | "INFUSION" | "PIGMENT" | "SLURRY">;
    };
/** Dynamic tank fields (default 3x3x3): one merged tank. */
export interface DynamicTankFields {
  /** Fluid contents (ignored when `chemical` is given). @default name "minecraft:water" */
  fluid?: DynamicTankContents;
  /** Chemical contents. @default name "mekanism:hydrogen", type "GAS" */
  chemical?: DynamicTankContents;
  /** Container edit mode. @default "BOTH" */
  editMode?: Ci<MekContainerEditMode>;
  /** Input container slot. */
  inputItem?: MekItemStackSpec;
  /** Output container slot. */
  outputItem?: MekItemStackSpec;
  /** Fluid mB/t in. */
  fluidInput?: MekRate;
  /** Fluid mB/t out. */
  fluidOutput?: MekRate;
  /** Chemical mB/t in. */
  chemicalInput?: MekRate;
  /** Chemical mB/t out. */
  chemicalOutput?: MekRate;
}
/** Thermal evaporation plant fields (default 4x4, height 18, kept within 3..18). */
export interface EvaporationFields {
  /** Input fluid (height times 4 times 64000 mB). @default name "minecraft:water" */
  input?: MekTankSpec;
  /** Output (10000 mB). @default name "mekanism:brine" */
  output?: MekTankSpec;
  /** Temperature, K. @default ambientTemperature */
  temperature?: number;
  /** Advanced solar generators on the corners (0..4). @default 0 */
  solars?: number;
  /** More recipes by input fluid (water to brine and brine to lithium are built in). */
  recipes?: Record<
    string,
    {
      /** mB in. @default 10 */
      input?: number;
      /** Output fluid. */
      output: string;
      /** mB out. @default 1 */
      amount?: number;
    }
  >;
  /** Input fluid container slot in. */
  inputItemInput?: MekItemStackSpec;
  /** Input fluid container slot out. */
  inputItemOutput?: MekItemStackSpec;
  /** Output fluid container slot in. */
  outputItemInput?: MekItemStackSpec;
  /** Output fluid container slot out. */
  outputItemOutput?: MekItemStackSpec;
  /** J/t from heaters on the valves. */
  heatInput?: MekRate;
  /** Input fluid mB/t in. */
  inputRate?: MekRate;
  /** Output mB/t out. */
  outputRate?: MekRate;
}
/** Supercritical phase shifter fields (default 7x7x7). */
export interface SpsFields {
  /** Polonium (2000 mB). @default name "mekanism:polonium" */
  input?: MekTankSpec;
  /** Antimatter (1000 mB). @default name "mekanism:antimatter" */
  output?: MekTankSpec;
  /** Polonium processed toward the next antimatter mB (0..999). @default 0 */
  inputProcessed?: number;
  /** Coil ports no computer sees. @default 0 */
  coils?: number;
  /** J/t straight to the coils (on a port: into that port's buffer). */
  energyInput?: MekRate;
  /** Polonium mB/t in. */
  poloniumInput?: MekRate;
  /** Antimatter mB/t out (through an output port, if any). */
  antimatterOutput?: MekRate;
}
/** Fission reactor fields (default 5x5x5). */
export interface FissionFields {
  /** Fuel assemblies. @default 8 */
  fuelAssemblies?: number;
  /** Surface area. @default fuelAssemblies times 5 */
  surfaceArea?: number;
  /** Fissile fuel (8000 mB per assembly). @default name "mekanism:fissile_fuel" */
  fuel?: MekTankSpec;
  /** Nuclear waste. @default name "mekanism:nuclear_waste" */
  waste?: MekTankSpec;
  /** Water coolant (a number), or { name: "mekanism:sodium", amount } for gas coolant. */
  coolant?: MekTankSpec;
  /** Gas coolant tank. @default name "mekanism:sodium" */
  gasCoolant?: MekTankSpec;
  /** Heated coolant. @default name "mekanism:steam" */
  heatedCoolant?: MekTankSpec;
  /** Temperature, K. @default ambientTemperature */
  temperature?: number;
  /** Damage, percent. @default 0 */
  damage?: number;
  /** Burn rate limit, mB/t. @default config.defaultBurnRate (0.1) */
  burnRate?: number;
  /** Whether it is on. @default false */
  active?: boolean;
  /** Forced off. @default false */
  forceDisabled?: boolean;
  /** Fuel mB/t in. */
  fuelInput?: MekRate;
  /** Coolant mB/t in. */
  coolantInput?: MekRate;
  /** Waste mB/t out (OUTPUT_WASTE port, if any). */
  wasteOutput?: MekRate;
  /** Heated coolant mB/t out (OUTPUT_COOLANT port, if any). */
  heatedCoolantOutput?: MekRate;
  /** Multiblock id (a turbine or boiler) that gets the heated coolant. */
  heatedCoolantTo?: string;
}
/** Industrial turbine fields (default 5x5x9). */
export interface TurbineFields {
  /** Blades. @default 6 */
  blades?: number;
  /** Coils. @default 2 */
  coils?: number;
  /** Vents. @default 12 */
  vents?: number;
  /** Condensers. @default 0 */
  condensers?: number;
  /** Lower volume. @default worked out from the size and blades */
  lowerVolume?: number;
  /** Steam tank. @default name "mekanism:steam" */
  steam?: MekTankSpec;
  /** Stored J. @default 0 */
  energy?: number;
  /** Dumping mode. @default "IDLE" */
  dumpingMode?: Ci<MekGasMode>;
  /** Steam mB/t in. */
  steamInput?: MekRate;
  /** Energy J/t out. */
  energyOutput?: MekRate;
  /** Multiblock id (an induction matrix) that gets the energy. */
  energyTo?: string;
}
/** Fusion reactor fields (default 5x5x5). */
export interface FusionFields {
  /** Injection rate. @default 2 */
  injectionRate?: number;
  /** Deuterium tank. @default name "mekanism:deuterium" */
  deuterium?: MekTankSpec;
  /** Tritium tank. @default name "mekanism:tritium" */
  tritium?: MekTankSpec;
  /** D-T fuel tank. @default name "mekanism:fusion_fuel" */
  dtFuel?: MekTankSpec;
  /** Water tank. @default name "minecraft:water" */
  water?: MekTankSpec;
  /** Steam tank. @default name "mekanism:steam" */
  steam?: MekTankSpec;
  /** Stored J. @default 0 */
  energy?: number;
  /** Plasma temperature, K. @default ambientTemperature */
  plasmaTemperature?: number;
  /** Case temperature, K. @default ambientTemperature */
  caseTemperature?: number;
  /** Whether it burns. @default false */
  burning?: boolean;
  /** A hohlraum in the controller (true or "filled": filled). @default false */
  hohlraum?: boolean | "filled";
  /** Deuterium mB/t in. */
  deuteriumInput?: MekRate;
  /** Tritium mB/t in. */
  tritiumInput?: MekRate;
  /** Water mB/t in. */
  waterInput?: MekRate;
  /** Steam mB/t out (through an output port, if any). */
  steamOutput?: MekRate;
  /** Multiblock id that gets the steam. */
  steamTo?: string;
  /** Energy J/t out. */
  energyOutput?: MekRate;
  /** Multiblock id that gets the energy. */
  energyTo?: string;
}
/** A thermoelectric boiler. */
export interface BoilerMultiblockSpec
  extends MekMultiblockCommon,
    BoilerFields {
  /** Multiblock kind. */
  kind: "boiler";
}
/** An induction matrix. */
export interface MatrixMultiblockSpec
  extends MekMultiblockCommon,
    MatrixFields {
  /** Multiblock kind. */
  kind: "matrix";
}
/** A dynamic tank. */
export interface DynamicTankMultiblockSpec
  extends MekMultiblockCommon,
    DynamicTankFields {
  /** Multiblock kind. */
  kind: "dynamicTank";
}
/** A thermal evaporation plant. */
export interface EvaporationMultiblockSpec
  extends MekMultiblockCommon,
    EvaporationFields {
  /** Multiblock kind. */
  kind: "evaporation";
}
/** A supercritical phase shifter. */
export interface SpsMultiblockSpec extends MekMultiblockCommon, SpsFields {
  /** Multiblock kind. */
  kind: "sps";
}
/** A fission reactor. */
export interface FissionMultiblockSpec
  extends MekMultiblockCommon,
    FissionFields {
  /** Multiblock kind. */
  kind: "fission";
}
/** An industrial turbine. */
export interface TurbineMultiblockSpec
  extends MekMultiblockCommon,
    TurbineFields {
  /** Multiblock kind. */
  kind: "turbine";
}
/** A fusion reactor. */
export interface FusionMultiblockSpec
  extends MekMultiblockCommon,
    FusionFields {
  /** Multiblock kind. */
  kind: "fusion";
}
/** A Mekanism multiblock, by `kind` (docs/mekanism-multiblocks.md). */
export type MekanismMultiblockSpec =
  | BoilerMultiblockSpec
  | MatrixMultiblockSpec
  | DynamicTankMultiblockSpec
  | EvaporationMultiblockSpec
  | SpsMultiblockSpec
  | FissionMultiblockSpec
  | TurbineMultiblockSpec
  | FusionMultiblockSpec;

/**
 * A multiblock's port, valve or adapter. `multiblock` names an entry of mekanism.multiblocks or is the multiblock
 * itself; without it, the peripheral's own fields are the multiblock.
 */
export interface MultiblockPeripheralSpec extends MekMultiblockCommon {
  /** The multiblock: an id in mekanism.multiblocks, or its fields here (kind implied). */
  multiblock?: string | Record<string, unknown>;
  /** The multiblock's own fields, when there is no `multiblock` (see MekanismMultiblockSpec). */
  [field: string]: unknown;
}
/** Thermoelectric boiler valve. */
export interface BoilerValveSpec extends MultiblockPeripheralSpec {
  /** Valve mode. @default "INPUT" */
  mode?: Ci<"INPUT" | "OUTPUT_STEAM" | "OUTPUT_COOLANT">;
}
/** Induction port. */
export interface InductionPortSpec extends MultiblockPeripheralSpec {
  /** true or "output": output mode; anything else input. @default "input" */
  mode?: boolean | "output" | "input";
}
/** Thermal evaporation controller. */
export interface ThermalEvaporationControllerSpec
  extends MultiblockPeripheralSpec {
  /** Facing. @default "NORTH" */
  facing?: Ci<"NORTH" | "SOUTH" | "EAST" | "WEST">;
}
/** Supercritical phase shifter port. */
export interface SpsPortSpec extends MultiblockPeripheralSpec {
  /** Exactly "output" (or `output: true`): output mode. @default "input" */
  mode?: "output" | "input";
  /** true: output mode. */
  output?: boolean;
  /** Has a coil (counts for getCoils, passes energy on). @default true */
  coil?: boolean;
  /** Port buffer, J (at most 1e9). @default 0 */
  energy?: number;
}
/** Fission reactor logic adapter. */
export interface FissionAdapterSpec extends MultiblockPeripheralSpec {
  /** Logic mode. @default "DISABLED" */
  logicMode?: Ci<
    | "DISABLED"
    | "ACTIVATION"
    | "TEMPERATURE"
    | "EXCESS_WASTE"
    | "DAMAGED"
    | "DEPLETED"
  >;
  /** Redstone control. @default "DISABLED" */
  redstoneMode?: Ci<MekRedstoneControl>;
  /** Redstone in (ACTIVATION mode turns the reactor on and off). @default false */
  powered?: boolean;
}
/** Fission reactor port. */
export interface FissionPortSpec extends MultiblockPeripheralSpec {
  /** Port mode. @default "INPUT" */
  mode?: Ci<"INPUT" | "OUTPUT_WASTE" | "OUTPUT_COOLANT">;
}
/** Fusion reactor logic adapter. */
export interface FusionAdapterSpec extends MultiblockPeripheralSpec {
  /** Logic mode. @default "DISABLED" */
  logicMode?: Ci<"DISABLED" | "READY" | "CAPACITY" | "DEPLETED">;
  /** Actively cooled. @default false */
  activeCooled?: boolean;
}
/** Fusion reactor port. */
export interface FusionPortSpec extends MultiblockPeripheralSpec {
  /** true or "output": eject mode. @default "input" */
  mode?: boolean | "output" | "input";
}

/** Mekanism and Mekanism Generators config values the multiblocks use. Other keys are an error. */
export interface MekanismConfig {
  /** Most energy, J, per mB of steam (turbine). @default 10 */
  maxEnergyPerSteam?: number;
  /** Boiler water conductivity. @default 0.7 */
  boilerWaterConductivity?: number;
  /** Heat a superheating element moves, J/t. @default 16000000 */
  superheatingHeatTransfer?: number;
  /** Share of a tank kept when dumping excess. @default 0.9 */
  dumpExcessKeepRatio?: number;
  /** J per mB of fissile fuel. @default 1000000 */
  energyPerFissionFuel?: number;
  /** Fission casing heat capacity. @default 1000 */
  fissionCasingHeatCapacity?: number;
  /** Fission surface area target per assembly. @default 4 */
  fissionSurfaceAreaTarget?: number;
  /** Whether fission reactors can melt down. @default true */
  fissionMeltdownsEnabled?: boolean;
  /** Meltdown chance per tick past full damage. @default 0.001 */
  fissionMeltdownChance?: number;
  /** Damage, percent, after a meltdown. @default 75 */
  fissionPostMeltdownDamage?: number;
  /** Default fission burn rate, mB/t. @default 0.1 */
  defaultBurnRate?: number;
  /** Burn rate per fuel assembly, mB/t. @default 1 */
  burnPerAssembly?: number;
  /** Turbine blades one coil supports. @default 4 */
  turbineBladesPerCoil?: number;
  /** Steam flow per vent, mB/t. @default 32000 */
  turbineVentGasFlow?: number;
  /** Steam flow per dispersor, mB/t. @default 1280 */
  turbineDisperserGasFlow?: number;
  /** Water per condenser, mB/t. @default 64000 */
  condenserRate?: number;
  /** J per mB of fusion fuel. @default 10000000 */
  energyPerFusionFuel?: number;
  /** Fusion thermocouple efficiency. @default 0.05 */
  fusionThermocoupleEfficiency?: number;
  /** Fusion casing thermal conductivity. @default 0.1 */
  fusionCasingThermalConductivity?: number;
  /** Fusion water heating ratio. @default 0.3 */
  fusionWaterHeatingRatio?: number;
  /** Most D-T fuel a hohlraum holds, mB. @default 10 */
  hohlraumMaxGas?: number;
}

// ===== Create (rom-overlay/rom/ccsim/addons/create) =====

/** A kinetic network. Stress is `stress` plus `impact` times |speed|; past `capacity` every block on it reads 0. */
export interface CreateNetwork {
  /** RPM when no `source` drives it. @default 0 */
  speed?: number;
  /** Stress capacity, SU. A driving electric motor adds its own. @default 0 */
  capacity?: number;
  /** Fixed stress, SU. @default 0 */
  stress?: number;
  /** Load in SU per RPM, times |speed|. @default 0 */
  impact?: number;
  /** Peripheral name of the block that drives it (a speed controller, sequenced gearshift or electric motor). */
  source?: string;
}

/** Create server config values. */
export interface CreateConfig {
  /** Longest elevator rope, blocks (cc-liftlink's reach below the pulley). @default 384 */
  maxRopeLength?: number;
  /** Largest RPM for speed controllers, and digital_adapter getKineticTopSpeed. @default 256 */
  maxRotationSpeed?: number;
  /** Top speed of a train without fuel, blocks/s. @default 28 */
  trainTopSpeed?: number;
  /** Top speed of a fuelled train, blocks/s. @default 40 */
  poweredTrainTopSpeed?: number;
  /** Acceleration of a train without fuel, blocks/s². @default 3 */
  trainAcceleration?: number;
  /** Acceleration of a fuelled train, blocks/s². @default 3 */
  poweredTrainAcceleration?: number;
}

/** An item stack in a schedule. */
export interface CreateScheduleItem {
  /** Item id, e.g. "minecraft:wheat"; "minecraft:air" or a count of 0 is empty. */
  id: string;
  /** Count. */
  count: number;
  /** Stack NBT. */
  tag?: Record<string, unknown>;
}

/** A schedule instruction: destination (go to the station whose name matches `text`, * a wildcard), rename or throttle. */
export interface CreateScheduleInstruction {
  /** Instruction id. */
  id:
    | "create:destination"
    | "create:rename"
    | "create:throttle"
    | (string & {});
  /** Its data: `{ text }` for destination and rename, `{ value }` (percent) for throttle. */
  data: Record<string, unknown>;
}

/**
 * A wait condition: create:delay / create:idle `{ value, time_unit }` (0 ticks, 1 seconds, 2 minutes),
 * create:time_of_day `{ hour, minute, rotation? }`, create:item_threshold `{ threshold (a string), operator (0 more, 1
 * less, 2 equal), measure?, item? }`, create:fluid_threshold `{ threshold, operator, bucket? }`, create:redstone_link
 * `{ frequency: [item, item], inverted? }`, create:player_count `{ count, exact? }`, create:unloaded, create:powered.
 */
export interface CreateWaitCondition {
  /** Condition id. */
  id:
    | "create:delay"
    | "create:idle"
    | "create:time_of_day"
    | "create:item_threshold"
    | "create:fluid_threshold"
    | "create:redstone_link"
    | "create:player_count"
    | "create:unloaded"
    | "create:powered"
    | (string & {});
  /** Its data, with snake_case keys. */
  data?: Record<string, unknown>;
}

/** One schedule entry. */
export interface CreateScheduleEntry {
  /** What to do. */
  instruction: CreateScheduleInstruction;
  /** Destinations only: columns are OR'd, the conditions in a column run in turn. */
  conditions?: CreateWaitCondition[][];
}

/** A train schedule, as Create_Station setSchedule takes it (snake_case keys). */
export interface CreateSchedule {
  /** The entries. */
  entries: CreateScheduleEntry[];
  /** Start over after the last entry; false stops there. @default false */
  cyclic?: boolean;
  /** 0-based entry to start at. @default 0 */
  progress?: number;
}

/** An item a train carries. */
export interface CreateCargoItem {
  /** Item id ("minecraft:" is added without a namespace). */
  name: string;
  /** Count. @default 1 */
  count?: number;
  /** Stack size, for full-stack thresholds. @default 64 */
  maxCount?: number;
}

/** A fluid a train carries. */
export interface CreateCargoFluid {
  /** Fluid id ("minecraft:" is added without a namespace). */
  name: string;
  /** Millibuckets. @default 0 */
  amount?: number;
}

/** A stop of a shorthand route: a destination and a wait. */
export interface CreateRouteStop {
  /** Station name filter. */
  station: string;
  /** Seconds to wait there. @default 5 */
  wait?: number;
}

/** A train, as in create.trains and the createAddTrain command. */
export interface CreateTrain {
  /** Train name. @default "Unnamed Train" */
  name?: string;
  /** Station it starts at (an error if no station has that name). */
  at?: string;
  /** Full schedule; wins over `route`. */
  schedule?: CreateSchedule;
  /** Shorthand schedule. */
  route?: CreateRouteStop[];
  /** Whether a `route` loops. @default true */
  cyclic?: boolean;
  /** Whether the schedule is an auto-schedule. @default false */
  autoSchedule?: boolean;
  /** Station it is already driving to. */
  heading?: string;
  /** Blocks left to `heading`. @default create.distance (300) */
  distance?: number;
  /** Has a conductor; without one destinations fail with "missing_conductor". @default true */
  conductor?: boolean;
  /** Fuelled: the powered top speed and acceleration. @default false */
  powered?: boolean;
  /** true: same as `powered`. @default false */
  fuel?: boolean;
  /** Top speed, blocks/s, over the config's. */
  maxSpeed?: number;
  /** Passengers, for player_count waits. @default 0 */
  players?: number;
  /** Item cargo. @default [] */
  items?: CreateCargoItem[];
  /** Fluid cargo. @default [] */
  fluids?: CreateCargoFluid[];
  /** Assembly mode can disassemble it. @default true */
  canDisassemble?: boolean;
}

/** Carriages on a station's track, ready to assemble. */
export interface CreatePendingAssembly {
  /** Name of the train (a remembered name of a disassembled train wins). @default "Unnamed Train" */
  name?: string;
  /** Has a conductor. @default true */
  conductor?: boolean;
  /** Fuelled. @default false */
  powered?: boolean;
  /** Top speed, blocks/s. */
  maxSpeed?: number;
}

/** A station's fields. */
export interface CreateStationFields {
  /** Station name. A Create_Station named as a create.stations entry is the same station. @default "Track Station" */
  station?: string;
  /** false: not on a track; most methods then fail. @default true */
  track?: boolean;
  /** Starts in assembly mode. @default false */
  assembling?: boolean;
  /** Powered by redstone (for create:powered waits). @default false */
  powered?: boolean;
  /** Carriages ready to assemble (true is `{}`). */
  pending?: true | CreatePendingAssembly;
}

/** A station no computer touches. */
export interface CreateFixtureStation extends CreateStationFields {
  /** Station name, when there is no `station`. */
  name?: string;
}

/** A display board a Display Link writes to. */
export interface CreateDisplayBoardTarget {
  /** Target kind. @default "display_board" */
  type?: "display_board";
  /** Width in blocks. @default 1 */
  width?: number;
  /** Height in blocks (2 rows per block). @default 1 */
  height?: number;
  /** Kinetic network id: the board takes text only while it turns. */
  network?: string;
  /** Fixed RPM without `network`; 0 never takes text. @default 16 */
  speed?: number;
  /** Text already shown, one string per row. @default [] */
  lines?: string[];
}
/** A sign a Display Link writes to. */
export interface CreateSignTarget {
  /** Target kind. */
  type: "sign";
  /** Up to 4 lines of 15 columns. @default ["","","",""] */
  lines?: string[];
}
/** A lectern a Display Link writes to. */
export interface CreateLecternTarget {
  /** Target kind. */
  type: "lectern";
  /** The book; an update turns "writable" into "written"; "none" takes nothing. @default "written" */
  book?: "written" | "writable" | "none";
  /** Pages already there. @default [] */
  pages?: string[];
}
/** Nixie tubes a Display Link writes to. */
export interface CreateNixieTubeTarget {
  /** Target kind. */
  type: "nixie_tube";
  /** Number of tubes (2 columns each). @default 1 */
  tubes?: number;
  /** Text shown. @default "" */
  text?: string;
}
/** What a Display Link writes to: a kind name, or the block's fields. */
export type CreateDisplayTarget =
  | "none"
  | "sign"
  | "display_board"
  | "lectern"
  | "nixie_tube"
  | CreateDisplayBoardTarget
  | CreateSignTarget
  | CreateLecternTarget
  | CreateNixieTubeTarget;

/** Create Display Link. */
export interface CreateDisplayLinkSpec {
  /** The block in front of the link; absent or "none" is no target. */
  target?: CreateDisplayTarget;
  /** First target line it writes to, 1-based. @default 1 */
  line?: number;
  /** "computer", "none", or a digital_adapter peripheral name (refreshes every 100 ticks). @default "computer" */
  source?: string;
  /** Powered by redstone: updates and refreshes do nothing. @default false */
  powered?: boolean;
  /** Source text already written. */
  lines?: string[];
  /** The server restarted: getSize fails until the first update. @default false */
  restarted?: boolean;
}
/** Create speedometer. */
export interface CreateSpeedometerSpec {
  /** Kinetic network id; wins over `speed`. */
  network?: string;
  /** Fixed RPM without a `network`. @default 0 */
  speed?: number;
}
/** Create stressometer. */
export interface CreateStressometerSpec {
  /** Kinetic network id; wins over `stress` and `capacity`. */
  network?: string;
  /** Fixed stress, SU. @default 0 */
  stress?: number;
  /** Fixed capacity, SU. @default 0 */
  capacity?: number;
}
/** Create rotation speed controller. */
export interface CreateRotationSpeedControllerSpec {
  /** Input network id; the output is 0 without it or when it stops. */
  network?: string;
  /** Target RPM at the start (whole, within ±maxRotationSpeed). @default 16 */
  targetSpeed?: number;
}
/** Create sequenced gearshift. */
export interface CreateSequencedGearshiftSpec {
  /** Input network id. */
  network?: string;
}
/** Create train station. */
export interface CreateStationSpec extends CreateStationFields {}

/** Create settings: kinetic networks, stations without computers, trains. */
export interface CreateWorld {
  /** Game tick at boot. @default 0 */
  gameTime?: number;
  /** Day time at boot, for time_of_day waits. @default environment.time, else 0 */
  dayTime?: number;
  /** Create server config values. */
  config?: CreateConfig;
  /** Kinetic networks by id. */
  networks?: Record<string, CreateNetwork>;
  /** Stations no computer touches: a name, or the station's fields. */
  stations?: (string | CreateFixtureStation)[];
  /** Blocks between two stations `distances` does not list. @default 300 */
  distance?: number;
  /** Blocks between pairs of stations, keyed "A|B" (both ways). */
  distances?: Record<string, number>;
  /** Trains, placed the first time anything looks. */
  trains?: CreateTrain[];
}

// ===== Create Crafts & Additions =====

/** Create Crafts & Additions config values. */
export interface CreateAdditionsConfig {
  /** FE/t a motor draws at 256 RPM (scales with RPM). @default 480 */
  fe_at_max_rpm?: number;
  /** Motor stress capacity at 256 RPM, SU. @default 16384 */
  max_stress?: number;
  /** Largest motor RPM. @default 256 */
  motor_rpm_range?: number;
  /** Least FE/t a running motor draws. @default 8 */
  motor_min_consumption?: number;
  /** Motor's largest input, FE/t. @default 5000 */
  motor_max_input?: number;
  /** Motor energy buffer, FE. @default 5000 */
  motor_capacity?: number;
  /** Redstone relay's largest input, FE/t. @default 1024 */
  small_connector_max_input?: number;
  /** Redstone relay's largest output, FE/t. @default 1024 */
  small_connector_max_output?: number;
  /** Accumulator's largest input, FE/t. @default 5000 */
  accumulator_max_input?: number;
  /** Accumulator's largest output, FE/t. @default 5000 */
  accumulator_max_output?: number;
  /** FE per accumulator block. @default 2000000 */
  accumulator_capacity?: number;
  /** Widest accumulator, blocks. @default 3 */
  accumulator_max_width?: number;
  /** Tallest accumulator, blocks. @default 5 */
  accumulator_max_height?: number;
  /** Portable energy interface's largest input, FE/t. @default 5000 */
  pei_max_input?: number;
  /** Portable energy interface's largest output, FE/t. @default 5000 */
  pei_max_output?: number;
}

/** Create Crafts & Additions settings. */
export interface CreateAdditionsWorld {
  /** Config values. */
  config?: CreateAdditionsConfig;
}

/** Create Crafts & Additions electric motor. */
export interface ElectricMotorSpec {
  /** RPM it makes (whole, within ±motor_rpm_range); drives the create.networks entry whose `source` is this motor. @default 32 */
  rpm?: number;
  /** Stored FE. @default 0 */
  energy?: number;
  /** FE/t fed in. @default 0 */
  input?: number;
  /** Powered by redstone: the motor stops. @default false */
  powered?: boolean;
  /** Running at boot. @default false */
  active?: boolean;
}
/** Create Crafts & Additions modular accumulator. */
export interface ModularAccumulatorSpec {
  /** Width, blocks. @default 1 */
  width?: number;
  /** Height, blocks. @default 1 */
  height?: number;
  /** Stored FE. @default 0 */
  energy?: number;
  /** FE/t pushed in. @default 0 */
  input?: number;
  /** FE/t drawn out. @default 0 */
  output?: number;
}
/** Create Crafts & Additions portable energy interface. */
export interface PortableEnergyInterfaceSpec {
  /** A contraption is docked (true when `contraption` is given). @default false */
  connected?: boolean;
  /** The docked contraption. */
  contraption?: {
    /** FE it holds. @default 0 */
    energy?: number;
    /** FE it can hold. @default 0 */
    capacity?: number;
  };
  /** FE/t pushed in while connected. @default 0 */
  input?: number;
  /** FE/t pulled out while connected. @default 0 */
  output?: number;
}
/** A floor of an elevator pulley. */
export interface DigitalAdapterElevatorFloor {
  /** Floor Y. */
  y: number;
  /** Floor name. */
  name?: string;
  /** false: gotoElevatorFloor does not go there. @default true */
  reachable?: boolean;
}
/** A block next to a digital adapter that no computer sees. */
export interface DigitalAdapterSideSpec {
  /** What the block is. */
  kind:
    | "speed_controller"
    | "speedometer"
    | "stressometer"
    | "piston"
    | "pulley"
    | "hose_pulley"
    | "elevator_pulley"
    | "bearing";
  /** Kinetic blocks: network id. */
  network?: string;
  /** Speed controller: target RPM; speedometer: fixed RPM. */
  targetSpeed?: number;
  /** Speedometer: fixed RPM. */
  speed?: number;
  /** Stressometer: fixed stress, SU. */
  stress?: number;
  /** Stressometer: fixed capacity, SU. */
  capacity?: number;
  /** Piston and pulleys: extension, blocks. @default 0 */
  offset?: number;
  /** Bearing: angle at boot, degrees. @default 0 */
  angle?: number;
  /** Bearing: RPM. @default 0 */
  rpm?: number;
  /** Bearing: turning. @default rpm is not 0 */
  running?: boolean;
  /** Elevator floors. @default [] */
  floors?: DigitalAdapterElevatorFloor[];
  /** Elevator target Y. @default the first floor's */
  targetY?: number;
  /** false: the elevator methods see no contraption. @default true */
  assembled?: boolean;
}
/** Create Crafts & Additions digital adapter. */
export interface DigitalAdapterSpec {
  /** Neighbours by direction: a Create kinetic peripheral's name, or a block of its own. */
  sides?: Partial<Record<Direction, string | DigitalAdapterSideSpec>>;
}

// ===== Tom's Peripherals =====

/** Tom's Peripherals settings. */
export interface TomsPeripheralsWorld {
  /** Largest monitor wall, blocks per side (the mod allows 1-64). @default 16 */
  maxScreenSize?: number;
}
/** Tom's Peripherals GPU. */
export interface TmGpuSpec {
  /** The monitor wall the GPU touches. */
  monitor?: {
    /** Width in monitor blocks; 0 is no monitors. @default 0 */
    width?: number;
    /** Height in monitor blocks; 0 is no monitors. @default 0 */
    height?: number;
  };
}
/** Tom's Peripherals keyboard. */
export interface TmKeyboardSpec {
  /** A keyboard dongle (portable_connect and portable_disconnect events). @default false */
  dongle?: boolean;
}
/** Tom's Peripherals redstone port. */
export interface TmRsPortSpec {
  /** Incoming redstone level 0-15 by direction. @default 0 per side */
  inputs?: Partial<Record<Direction, number>>;
  /** Incoming bundled mask by direction. @default 0 per side */
  bundledInputs?: Partial<Record<Direction, number>>;
}
/** Tom's Peripherals watchdog timer. */
export interface TmWdtSpec {
  /** Enabled; the countdown starts at boot. @default false */
  enabled?: boolean;
  /** Time limit, ticks. @default 0 */
  timeout?: number;
  /** false: it does not face this computer, so firing turns it off without a reboot. @default true */
  target?: boolean;
}

// ===== Bigger Reactors and Extreme Reactors =====

/** mB per tick, or "full" ("all" too). */
export type SupplyRate = number | "full" | "all";
/** Outer size including the casing, [x, y, z] blocks. */
export type Dimensions3 = [number, number, number];
/** Outer size, [x, y, z] or { x, y, z }. */
export type ExtremeDimensions =
  | Dimensions3
  | {
      /** X size. */
      x?: number;
      /** Y size. */
      y?: number;
      /** Z size. */
      z?: number;
    };

/** One control rod's settings, in rod order. */
export interface ControlRodSpec {
  /** Rod name. @default "" */
  name?: string;
  /** Insertion, percent 0..100. @default rodLevel, else 0 */
  level?: number;
}

/** A custom Bigger Reactors moderator (or [absorption, efficiency, moderation, conductivity]). */
export interface BiggerReactorsCustomModerator {
  /** Radiation absorption, 0..1. @default 0 */
  absorption?: number;
  /** Share of absorbed radiation that heats the stack. @default 0 */
  efficiency?: number;
  /** Same as `efficiency`. */
  heatEfficiency?: number;
  /** Moderation, 1 or more. @default 1 */
  moderation?: number;
  /** Heat conductivity. @default 0 */
  conductivity?: number;
  /** Same as `conductivity`. */
  heatConductivity?: number;
}

/** A Bigger Reactors reactor. */
export interface BiggerReactorsReactorSpec {
  /** Outer size, at least 3x3x3. @default [5,5,5] */
  dimensions?: Dimensions3;
  /** Interior: one string per x, one character per z. X fuel rod, . air, M manifold, others from `legend`. @default a checkerboard of rods */
  layout?: string[];
  /** Layout character to a moderator name ("graphite", "minecraft:gold_block", ...), "manifold", or a custom moderator. */
  legend?: Record<
    string,
    string | BiggerReactorsCustomModerator | [number, number, number, number]
  >;
  /** Cooling: anything but "active" is passive. @default "passive" */
  cooling?: "passive" | "active";
  /** Assembled. @default true */
  assembled?: boolean;
  /** On at the start. @default false */
  active?: boolean;
  /** Fuel, mB (4000 per rod block, fuel and waste together). @default 0 */
  fuel?: number;
  /** Waste, mB. @default 0 */
  waste?: number;
  /** Fertility at the start. @default 1 */
  fertility?: number;
  /** Fuel temperature, K. @default 293.15 */
  fuelHeat?: number;
  /** Stack temperature, K. @default 293.15 */
  stackHeat?: number;
  /** Same as `stackHeat`. */
  casingHeat?: number;
  /** Stored FE (passive only). @default 0 */
  energy?: number;
  /** Water in the coolant tank, mB (active only). @default 0 */
  coolant?: number;
  /** Steam in the coolant tank, mB (active only). @default 0 */
  steam?: number;
  /** Insertion of every rod, percent 0..100. @default 0 */
  rodLevel?: number;
  /** Rod settings by rod index. */
  controlRods?: ControlRodSpec[];
  /** FE per tick a power tap takes (passive only). @default 0 */
  load?: number;
  /** An access port ejects whole ingots of waste each tick. @default false */
  wasteOutlet?: boolean;
  /** Water pumped in, mB/t or "full" (active only). @default off */
  coolantSupply?: SupplyRate;
  /** A BiggerReactors_Turbine peripheral that gets the steam and sends water back. */
  steamTo?: string;
  /** Steam taken away without a steamTo turbine, mB/t or "full". @default off */
  steamDrain?: SupplyRate;
}

/** A Bigger Reactors turbine coil: a block name, { block, distance }, or [block, distance]. */
export type BiggerReactorsCoilEntry =
  | string
  | {
      /** Coil block. */
      block: string;
      /** Rings from the shaft. @default 1 */
      distance?: number;
    }
  | [string, number?];

/** A Bigger Reactors turbine. */
export interface BiggerReactorsTurbineSpec {
  /** Outer size; y runs along the rotor. @default [5,10,5] */
  dimensions?: Dimensions3;
  /** Coils: { block: count } in the first ring, or a list. @default {"minecraft:gold_block":8} */
  coils?: Record<string, number> | BiggerReactorsCoilEntry[];
  /** The rotor: [a, b, c, d] blade lengths per shaft block; wins over shafts, bladeLength and bladedShafts. */
  rotor?: [number, number, number, number][];
  /** Shaft blocks. @default interior height */
  shafts?: number;
  /** Blade length, blocks. @default worked out from the interior */
  bladeLength?: number;
  /** Shafts with blades. @default shafts */
  bladedShafts?: number;
  /** Nominal steam flow, mB/t. @default worked out from the rotor */
  flowRate?: number;
  /** Assembled. @default true */
  assembled?: boolean;
  /** On at the start. @default false */
  active?: boolean;
  /** Coils engaged. @default true */
  coilEngaged?: boolean;
  /** Vent mode; anything else is "overflow". @default "overflow" */
  vent?: "overflow" | "closed" | "all";
  /** Rotor speed at the start, RPM. @default 0 */
  rpm?: number;
  /** Stored FE. @default 0 */
  energy?: number;
  /** Input tank's fluid name. @default "biggerreactors:steam" */
  steamFluid?: string;
  /** Steam at the start, mB. @default 0 */
  steam?: number;
  /** Water at the start, mB. @default 0 */
  water?: number;
  /** FE per tick a power tap takes. @default 0 */
  load?: number;
  /** Steam pumped in, mB/t or "full". @default off */
  steamSupply?: SupplyRate;
  /** Water taken away when no reactor feeds it, mB/t or "full". @default off */
  waterDrain?: SupplyRate;
}

/** Bigger Reactors settings. */
export interface BiggerReactorsWorld {
  /** Game tick at boot. @default 0 */
  gameTime?: number;
  /** Seed of the random rod order. @default 0 */
  seed?: number;
}

/** An Extreme Reactors rate: mB/t, "full", true ("full") or false (0). */
export type ExtremeSupplyRate = SupplyRate | boolean;

/** An Extreme Reactors reactor. */
export interface ExtremeReactorsReactorSpec {
  /** Casing variant. @default "basic" */
  variant?: "basic" | "reinforced";
  /** "active" needs the reinforced variant. @default "passive" */
  cooling?: "passive" | "active";
  /** true: same as cooling "active". */
  activelyCooled?: boolean;
  /** Interior from above: one string per z row, one character per x. X or R is a rod; sets x and z. */
  layout?: string[];
  /** Layout character to moderator name, over the built-in legend (. air, W water, G graphite, I iron, ...). */
  legend?: Record<string, string>;
  /** Outer size, at least 3x3x3; with a layout only y counts. @default [5,5,5] */
  dimensions?: ExtremeDimensions;
  /** Same as `dimensions`. */
  size?: ExtremeDimensions;
  /** Interior moderator without a layout (one rod in the centre). @default "air" */
  moderator?: string;
  /** Insertion of every rod, percent 0..100. @default 0 */
  rodLevel?: number;
  /** Rod settings by rod index. */
  controlRods?: ControlRodSpec[];
  /** Fuel, mB (4000 per fuel rod block). @default 0 */
  fuel?: number;
  /** Waste, mB. @default 0 */
  waste?: number;
  /** Fuel type. @default "yellorium" */
  fuelType?: "yellorium" | "blutonium" | "verderium";
  /** Partial fuel use carried over. @default 0 */
  radiationFuelUsage?: number;
  /** Fertility at the start. @default 1 */
  fertility?: number;
  /** Fuel temperature, °C. @default 0 */
  fuelHeat?: number;
  /** Casing temperature, °C. @default 0 */
  casingHeat?: number;
  /** Stored FE. @default 0 */
  energy?: number;
  /** On at the start. @default false */
  active?: boolean;
  /** Water, mB (active only). @default 0 */
  coolant?: number;
  /** Steam, mB (active only). @default 0 */
  steam?: number;
  /** Hot fluid's name. @default "bigreactors:steam" */
  steamFluid?: string;
  /** Water pulled in, mB/t or "full". @default 0 with steamTo, else "full" */
  coolantSupply?: ExtremeSupplyRate;
  /** Steam pushed away without a steamTo turbine. @default "full" */
  steamDrain?: ExtremeSupplyRate;
  /** A BigReactors-Turbine peripheral that gets the steam and sends water back. */
  steamTo?: string;
  /** FE per tick the power taps push out (passive only). @default 0 */
  load?: number;
  /** Anything but "manual" ejects waste automatically. @default "automatic" */
  wasteEjection?: "automatic" | "manual";
  /** An output access port: whole ingots of waste leave. @default false */
  wasteOutlet?: boolean;
  /** An input access port, so doEjectFuel removes whole ingots of fuel. @default false */
  fuelInlet?: boolean;
  /** A controller is connected; false makes every method return nothing. @default true */
  connected?: boolean;
  /** Assembled; false answers but does not tick. @default true */
  assembled?: boolean;
  /** Lowest corner, for mbGetMinimumCoordinate and mbGetMaximumCoordinate. @default [0,0,0] */
  position?: ExtremeDimensions;
}

/** An Extreme Reactors turbine. */
export interface ExtremeReactorsTurbineSpec {
  /** Casing variant. @default "basic" */
  variant?: "basic" | "reinforced";
  /** Outer size, at least 5x4x5. @default [5,7,5] */
  dimensions?: ExtremeDimensions;
  /** Same as `dimensions`. */
  size?: ExtremeDimensions;
  /** Rotor shaft blocks. @default outer y - 2 */
  shafts?: number;
  /** Rotor blade blocks. @default 4 times min(shafts, 2) */
  blades?: number;
  /** Coil material ("gold", "minecraft:gold_block", ...) to block count. @default {"gold":8} */
  coils?: Record<string, number>;
  /** On at the start. @default false */
  active?: boolean;
  /** Inductor engaged. @default false */
  inductor?: boolean;
  /** Same as `inductor`. */
  inductorEngaged?: boolean;
  /** Vent mode; anything else is "overflow". @default "overflow" */
  vent?: "none" | "overflow" | "all";
  /** Largest steam intake, mB/t (basic 1000, reinforced 2000). @default the variant's largest */
  flowRate?: number;
  /** Rotor energy at the start. @default 0 */
  rotorEnergy?: number;
  /** Rotor speed at the start, RPM; wins over rotorEnergy. */
  rotorSpeed?: number;
  /** Steam at the start, mB. @default 0 */
  steam?: number;
  /** Water at the start, mB. @default 0 */
  water?: number;
  /** Same as `water`. */
  coolant?: number;
  /** Steam pulled in, mB/t or "full". @default 0 when a reactor feeds it, else "full" */
  steamSupply?: ExtremeSupplyRate;
  /** Water pushed away when no reactor takes it. @default "full" */
  waterDrain?: ExtremeSupplyRate;
  /** FE per tick the power taps push out. @default 0 */
  load?: number;
  /** Stored FE. @default 0 */
  energy?: number;
  /** A controller is connected. @default true */
  connected?: boolean;
  /** Assembled. @default true */
  assembled?: boolean;
  /** Lowest corner, for the mbGet*Coordinate methods. @default [0,0,0] */
  position?: ExtremeDimensions;
}

/** Extreme Reactors config multipliers. */
export interface ExtremeReactorsConfig {
  /** Fuel use multiplier. @default 1 */
  fuelUsageMultiplier?: number;
  /** Power multiplier for both machines. @default 1 */
  powerProductionMultiplier?: number;
  /** Reactor power multiplier. @default 1 */
  reactorPowerProductionMultiplier?: number;
  /** Turbine power multiplier. @default 1 */
  turbinePowerProductionMultiplier?: number;
  /** Turbine aerodynamic drag multiplier. @default 1 */
  turbineAeroDragMultiplier?: number;
  /** Turbine mass drag multiplier. @default 1 */
  turbineMassDragMultiplier?: number;
  /** Steam per blade multiplier. @default 1 */
  turbineFluidPerBladeMultiplier?: number;
}

/** Extreme Reactors settings. */
export interface ExtremeReactorsWorld {
  /** Game tick at boot. @default 0 */
  gameTime?: number;
  /** Config multipliers. */
  config?: ExtremeReactorsConfig;
}

// ===== UnlimitedPeripheralWorks (rom-overlay/rom/ccsim/addons/unlimited-peripheral-works) =====

/** Block and sky light, as the ultimate sensor's `light` inspector reads them. */
export interface UpwLightSpec {
  /** Block light, 0-15. @default 0 */
  block?: number;
  /** Sky light, 0-15. @default 15 */
  sky?: number;
}

/** A player the universal scanner sees (`upw.players`). */
export interface UpwPlayerSpec {
  /** Player name; also its displayName. @example "Steve" */
  name: string;
  /** Player UUID. @default 00000000-0000-4000-8000-0001<place as 8 hex digits> */
  uuid?: string;
  /** X coordinate. A player without x, y and z is never seen. */
  x?: number;
  /** Y coordinate (the feet). */
  y?: number;
  /** Z coordinate. */
  z?: number;
  /** Health points. @default 20 */
  health?: number;
  /** Experience level. @default 0 */
  experienceLevel?: number;
  /** Food level. @default 20 */
  foodLevel?: number;
  /** Saturation. @default 5 */
  saturationLevel?: number;
  /** In creative mode. @default false */
  isCreative?: boolean;
  /** Yaw, degrees. @default 0 */
  yRot?: number;
  /** Pitch, degrees. @default 0 */
  xRot?: number;
  /** Entity tags. @default [] */
  tags?: string[];
  /** Width of the box the scan meets. @default 0.6 */
  width?: number;
  /** Height of the box the scan meets, from the feet. @default 1.8 */
  height?: number;
}

/** UnlimitedPeripheralWorks config overrides (PeripheralWorksConfig), by the mod's setting names. */
export interface UpwConfig {
  /** Cooldowns at or below this many ms do not start. @default 100 */
  cooldownTreshholdLevel?: number;
  /** Most items one item pedestal pushItems/pullItems moves. @default 1024 */
  itemStorageTransferLimit?: number;
  /** Universal scanner cooldown, ms. @default 500 */
  stationaryUniversalScanCooldown?: number;
  /** Universal scanner: largest radius that costs nothing (a bigger one fails: a block has no fuel). @default 24 */
  stationaryUniversalScanMaxFreeRadius?: number;
  /** Universal scanner: largest radius at all (its maxRadius). @default 24 */
  stationaryUniversalScanMaxCostRadius?: number;
  /** Universal scanner: fuel per block past the free radius. @default 0 */
  stationaryUniversalScanExtraBlockCost?: number;
  /** Ultimate sensor `chunk` inspector cooldown, ms. @default 10000 */
  inspectChunkCooldown?: number;
}

/** UnlimitedPeripheralWorks: what the ultimate sensor reads, the scanner's players and config (docs/unlimited-peripheral-works.md). */
export interface UpwWorld {
  /** Day time in ticks at boot. @default 6000 */
  dayTime?: number;
  /** false: the day time stands still; otherwise it moves one a tick of the virtual clock. @default true */
  daylightCycle?: boolean;
  /** It rains. @default false */
  raining?: boolean;
  /** It thunders (wins over rain). @default false */
  thundering?: boolean;
  /** The sensor's biome. @default "minecraft:plains" */
  biome?: string;
  /** The sensor's light. @default {"block":0,"sky":15} */
  light?: UpwLightSpec;
  /** What analyze("dimension") lists. @default ["minecraft:overworld","minecraft:the_nether","minecraft:the_end"] */
  dimensions?: string[];
  /** Slime chunks, as "chunkX,chunkZ". @default [] @example ["0,0"] */
  slimeChunks?: string[];
  /** Players the universal scanner sees. @default [] */
  players?: UpwPlayerSpec[];
  /** Config overrides. */
  config?: UpwConfig;
}

/** An item a UPW block starts with; `count` may be left out. Other fields reach getItemDetail as they are. */
export interface UpwItemSpec {
  /** Item id. @example "minecraft:music_disc_13" */
  name: string;
  /** Stack size (a display pedestal and a jukebox hold one). @default 1 */
  count?: number;
  /** The item's NBT. */
  nbt?: unknown;
  /** getItemDetail's display name. */
  displayName?: string;
  /** Any other field reaches getItemDetail as it is. */
  [extra: string]: unknown;
}

/** What a book holds. */
export interface UpwBookContents {
  /** The pages: plain text for a book and quill, JSON text components for a written book. @default [] */
  pages?: string[];
  /** A written book's title. */
  title?: string;
  /** A written book's author. */
  author?: string;
}

/** A book on a lectern: "minecraft:writable_book" or "minecraft:written_book" (anything else is no book). */
export interface UpwBookSpec {
  /** Item id. @example "minecraft:written_book" */
  name: string;
  /** Stack size. @default 1 */
  count?: number;
  /** The book's pages, title and author. */
  __book?: UpwBookContents;
  /** Pages, when `__book` has none. */
  pages?: string[];
  /** Title, when `__book` has none. */
  title?: string;
  /** Author, when `__book` has none. */
  author?: string;
  /** Any other field is kept as it is. */
  [extra: string]: unknown;
}

/** UnlimitedPeripheralWorks universal scanner. Its position is the scan centre. */
export interface UniversalScannerSpec {
  /** Which way it faces: scan results are relative to it; up, down or anything else counts as north. @default "north" */
  facing?: Direction;
}

/** UnlimitedPeripheralWorks ultimate sensor. Its `dimension` is what the dimension inspector reports. */
export interface UltimateSensorSpec {
  /** Which way it faces (orientation: north 0, east 90, south 180, west 270; up or down has none). @default "north" */
  facing?: Direction;
  /** This sensor's biome. @default upw.biome */
  biome?: string;
  /** This sensor's light. @default upw.light */
  light?: UpwLightSpec;
  /** Its chunk is a slime chunk. @default whether upw.slimeChunks lists it */
  slimeChunk?: boolean;
}

/** UnlimitedPeripheralWorks item pedestal: a one-slot inventory. */
export interface ItemPedestalSpec {
  /** The item on it. Wins over `items`. */
  item?: ItemSpec;
  /** Its one slot, as an inventory's `items`. */
  items?: InventoryItems;
}

/** UnlimitedPeripheralWorks display pedestal. */
export interface DisplayPedestalSpec {
  /** The item shown. @default none */
  item?: UpwItemSpec;
  /** Shows the item's label. @default true */
  renderLabel?: boolean;
  /** Shows the item. @default true */
  renderItem?: boolean;
}

/** A note block instrument (NoteBlockInstrument, 1.20.1). */
export type NoteBlockInstrument =
  | "harp"
  | "basedrum"
  | "snare"
  | "hat"
  | "bass"
  | "flute"
  | "bell"
  | "guitar"
  | "chime"
  | "xylophone"
  | "iron_xylophone"
  | "cow_bell"
  | "didgeridoo"
  | "bit"
  | "banjo"
  | "pling"
  | "zombie"
  | "skeleton"
  | "creeper"
  | "dragon"
  | "wither_skeleton"
  | "piglin"
  | "custom_head";

/** A note block, through UnlimitedPeripheralWorks. */
export interface UpwNoteBlockSpec {
  /** Note, 0-24. @default 0 @integer @minimum 0 @maximum 24 */
  note?: number;
  /** Instrument. @default "harp" */
  instrument?: NoteBlockInstrument;
}

/** A jukebox, through UnlimitedPeripheralWorks. */
export interface UpwJukeboxSpec {
  /** The record in it (count is always 1). @default none */
  disc?: UpwItemSpec;
  /** false: the record is in but not playing. @default true when there is a disc */
  playing?: boolean;
}

/** A beacon, through UnlimitedPeripheralWorks. */
export interface UpwBeaconSpec {
  /** Pyramid levels, 0-4. @default 0 @integer @minimum 0 @maximum 4 */
  levels?: number;
  /** Primary effect id, e.g. "minecraft:speed". @default none */
  primary?: string;
  /** Secondary effect id (the primary again: level II). @default none */
  secondary?: string;
}

/** A lectern, through UnlimitedPeripheralWorks. */
export interface UpwLecternSpec {
  /** The book on it. @default none */
  book?: UpwBookSpec;
  /** Open page, 1-based (kept within the book). @default 1 @integer */
  page?: number;
}

// ===== Metaphysics (rom-overlay/rom/ccsim/addons/metaphysics) =====

/** A point; a coordinate left out is 0. */
export interface MetaphysicsVec3 {
  /** X. @default 0 */
  x?: number;
  /** Y. @default 0 */
  y?: number;
  /** Z. @default 0 */
  z?: number;
}

/** A player the coord API sees (`metaphysics.players`). */
export interface MetaphysicsPlayerSpec {
  /** Player name. @example "Alex" */
  name: string;
  /** Player UUID. @default 00000000-0000-4000-8000-0001<place as 8 hex digits> */
  uuid?: string;
  /** X coordinate. */
  x: number;
  /** Y coordinate (the feet). */
  y: number;
  /** Z coordinate. */
  z: number;
  /** Dimension; a player elsewhere is not seen. @default the computer's */
  dimension?: string;
  /** Health points; 0 or less is dead (getPlayers leaves it out). @default 20 */
  health?: number;
  /** Most health points. @default 20 */
  maxHealth?: number;
  /** Armor points. @default 0 */
  armor?: number;
  /** Pitch, degrees. @default 0 */
  xRot?: number;
  /** Yaw, degrees. @default 0 */
  yRot?: number;
  /** Head yaw, degrees. @default yRot */
  yHeadRot?: number;
  /** Motion per tick (getEntities' `vector`). @default {"x":0,"y":0,"z":0} */
  motion?: MetaphysicsVec3;
  /** Eye height. @default 1.62 */
  eyeHeight?: number;
  /** Pose. @default "STANDING" */
  pose?: string;
  /** Riding something. @default false */
  isPassenger?: boolean;
  /** In creative mode. @default false */
  isCreative?: boolean;
  /** In spectator mode. @default false */
  isSpectator?: boolean;
}

/** A Valkyrien Skies 2 ship the coord API sees. */
export interface MetaphysicsShipSpec {
  /** Ship id. @example 7 */
  id: number;
  /** Ship slug (name). */
  slug?: string;
  /** Low corner of its world box. @default {"x":0,"y":0,"z":0} */
  min?: MetaphysicsVec3;
  /** High corner of its world box. @default {"x":0,"y":0,"z":0} */
  max?: MetaphysicsVec3;
  /** Dimension as VS2 names it. @default "minecraft:dimension:" + the computer's dimension */
  dimension?: string;
  /** The ship the computer is on: where its block is in the world (what getCoord reports). */
  computerWorldPosition?: MetaphysicsVec3;
}

/** Metaphysics: the key switches its APIs on (`{}` is enough); players, ships and world facts (docs/metaphysics.md). */
export interface MetaphysicsWorld {
  /** Players. @default [] */
  players?: MetaphysicsPlayerSpec[];
  /** VS2 ships. @default [] */
  ships?: MetaphysicsShipSpec[];
  /** Id of the ship the computer stands on; null or left out: none. */
  computerShip?: number | null;
  /** Block id to explosion resistance; a block with none (and no `explosionResistance` of its own) is an error. */
  explosionResistance?: Record<string, number>;
  /** Chunks that are not loaded, as "chunkX,chunkZ". @default [] @example ["5,-3"] */
  unloadedChunks?: string[];
  /** The dimension has sky light. @default true in the overworld, else false */
  hasSkyLight?: boolean;
}

// ===== Some Peripherals (rom-overlay/rom/ccsim/addons/some-peripherals) =====

/** A vector; a coordinate left out takes the field's default. */
export interface SpVec3 {
  /** X. */
  x?: number;
  /** Y. */
  y?: number;
  /** Z. */
  z?: number;
}

/** A player the radar sees (`somePeripherals.players`). */
export interface SpPlayerSpec {
  /** Player name (the radar's `nickname`). @example "Steve" */
  name: string;
  /** X coordinate. */
  x: number;
  /** Y coordinate (the feet). */
  y: number;
  /** Z coordinate. */
  z: number;
  /** Dimension; a player elsewhere is not seen. @default the computer's */
  dimension?: string;
  /** Width of its box. @default 0.6 */
  width?: number;
  /** Height of its box, from the feet. @default 1.8 */
  height?: number;
  /** Eye height. @default 1.62 */
  eyeHeight?: number;
  /** Health points. @default 20 */
  health?: number;
  /** Most health points. @default 20 */
  maxHealth?: number;
  /** Armor points. @default 0 */
  armor?: number;
  /** Share of armor slots filled, 0-1. @default 0 */
  armorCover?: number;
  /** Absorption hearts. @default 0 */
  absorption?: number;
  /** A baby. @default false */
  baby?: boolean;
  /** Blocking with a shield. @default false */
  blocking?: boolean;
  /** Sleeping. @default false */
  sleeping?: boolean;
  /** Flying with an elytra. @default false */
  fallFlying?: boolean;
  /** Movement speed attribute. @default 0.1 */
  speed?: number;
  /** Pitch, degrees. @default 0 */
  xRot?: number;
  /** Yaw, degrees. @default 0 */
  yRot?: number;
  /** Head yaw, degrees. @default yRot */
  yHeadRot?: number;
  /** Body yaw, degrees. @default yRot */
  yBodyRot?: number;
  /** Air left, ticks. @default 300 */
  airSupply?: number;
  /** Most air, ticks. @default 300 */
  maxAirSupply?: number;
  /** Experience level. @default 0 */
  experienceLevel?: number;
  /** Progress to the next level, 0-1. @default 0 */
  experienceProgress?: number;
}

/** A quaternion. */
export interface SpQuaternion {
  /** X. @default 0 */
  x?: number;
  /** Y. @default 0 */
  y?: number;
  /** Z. @default 0 */
  z?: number;
  /** W. @default 1 */
  w?: number;
}

/** A Valkyrien Skies 2 ship the radar sees (with `valkyrienSkies` on). */
export interface SpShipSpec {
  /** Ship id. @example 1 */
  id: number;
  /** Low corner of its world box (what the scan meets). @default {"x":0,"y":0,"z":0} */
  min?: SpVec3;
  /** High corner of its world box. @default {"x":0,"y":0,"z":0} */
  max?: SpVec3;
  /** Low corner in the shipyard (`size` is max minus min). @default {"x":0,"y":0,"z":0} */
  shipyardMin?: SpVec3;
  /** High corner in the shipyard. @default {"x":0,"y":0,"z":0} */
  shipyardMax?: SpVec3;
  /** Position. @default {"x":0,"y":0,"z":0} */
  pos?: SpVec3;
  /** Mass, kg. @default 0 */
  mass?: number;
  /** Rotation. @default {"x":0,"y":0,"z":0,"w":1} */
  rotation?: SpQuaternion;
  /** Velocity. @default {"x":0,"y":0,"z":0} */
  velocity?: SpVec3;
  /** Scale. @default {"x":1,"y":1,"z":1} */
  scale?: SpVec3;
  /** Moment of inertia tensor, 3x3 rows. @default [[0,0,0],[0,0,0],[0,0,0]] */
  inertia?: number[][];
  /** Centre of mass in the ship. @default {"x":0,"y":0,"z":0} */
  centerOfMass?: SpVec3;
  /** The ship the computer is on: where its block is in the world (the radar scans from there). */
  computerWorldPosition?: SpVec3;
}

/** Some Peripherals config overrides, by the mod's config keys. */
export interface SpConfig {
  /** Largest radar entity radius; 0 or less: no limit. @default -1 */
  max_entity_search_radius?: number;
  /** Largest radar ship radius; 0 or less: no limit. @default -1 */
  max_ship_search_radius?: number;
  /** World scanner range, blocks; below 0: no limit. @default -1 */
  max_allowed_range?: number;
}

/** Some Peripherals: players, VS2 ships, digitized items and config (docs/some-peripherals.md). */
export interface SomePeripheralsWorld {
  /** Valkyrien Skies 2 is installed (the radar then reports ships). @default false */
  valkyrienSkies?: boolean;
  /** Players the radar sees. @default [] */
  players?: SpPlayerSpec[];
  /** VS2 ships. @default [] */
  ships?: SpShipSpec[];
  /** Id of the ship the computer stands on; null or left out: none. */
  computerShip?: number | null;
  /** The world's digitized stacks at boot, by UUID. A saved store wins for the same UUID. @default {} */
  digitalItems?: Record<string, ItemSpec>;
  /** Config overrides. */
  config?: SpConfig;
}

/** Some Peripherals radar. Scans around its position. No extra fields. */
export interface SpRadarSpec {}

/** Some Peripherals world scanner. getBlockAt is relative to its position. No extra fields. */
export interface WorldScannerSpec {}

/** Some Peripherals ballistic accelerator: pure maths. No extra fields. */
export interface BallisticAcceleratorSpec {}

/** Some Peripherals digitizer: a one-slot inventory. */
export interface DigitizerSpec {
  /** The item in its slot. Wins over `items`. */
  item?: ItemSpec;
  /** Its one slot, as an inventory's `items`. */
  items?: InventoryItems;
}

// ===== SirEdvin's Cloud Solutions (rom-overlay/rom/ccsim/addons/cloud-solutions) =====

/** A stored KV value: text (numbers and booleans are turned into text), or the text with its expiry. */
export type CloudSolutionsKvValue =
  | string
  | number
  | boolean
  | {
      /** The value, kept as text. */
      value: string | number | boolean;
      /** Epoch second it expires at; omit to keep it. */
      expire?: number;
    };

/** The mod's server config (ModConfig.kt); keys left out keep the mod's defaults. */
export interface CloudSolutionsConfig {
  /** "DISABLED" turns the KV storage off; anything else is on. @default "SQLITE" */
  kvStorageMode?: "SQLITE" | "DISABLED";
  /** Most keys one owner may hold. @default 10240 */
  kvStorageKeyLimit?: number;
  /** Longest value, characters. @default 500000 */
  kvStorageValueLimit?: number;
  /** "DISABLED" turns Crafka off (every broker call is then a NullPointerException). @default "SQLITE" */
  crafkaStorageMode?: "SQLITE" | "DISABLED";
  /** Most topics one owner may hold. @default 512 */
  crafkaTopicLimit?: number;
  /** Most messages a topic keeps. @default 512 */
  crafkaTopicSizeLimit?: number;
  /** Longest message, characters. @default 500000 */
  crafkaMessageSizeLimit?: number;
  /** Resends of an unacknowledged message before its subscription is dropped. @default 21 */
  crafkaMaxResendSteps?: number;
  /** First resend delay, ms (each next wait one step longer). @default 100 */
  crafkaCursorRevalidationDelay?: number;
  /** StatsD connection on. @default false */
  enableStatsDConnection?: boolean;
  /** Prefix of every StatsD line. @default "" */
  statsdPrefix?: string;
  /** StatsD calls a minute per player. @default 1000 */
  statsdPlayerRateLimit?: number;
  /** StatsD calls a minute for the whole server. @default 21000 */
  statsdGlobalRateLimit?: number;
}

/** SirEdvin's Cloud Solutions settings. */
export interface CloudSolutionsWorld {
  /** UUID of the player who placed every block (a block's own `owner` wins). @default "8667ba71-b85a-4004-af54-457a9734eed7" */
  owner?: string;
  /** Player name StatsD aspects start with. @default "Steve" */
  ownerName?: string;
  /** The owner is on the server (StatsD needs it). @default true */
  ownerOnline?: boolean;
  /** The KV store at boot: owner UUID to key to value. */
  kv?: Record<string, Record<string, CloudSolutionsKvValue>>;
  /** Server config overrides. */
  config?: CloudSolutionsConfig;
}

/** A Cloud Solutions block (crafka_broker; base of the others). */
export interface CloudSolutionsBlockSpec {
  /** UUID of the player who placed it; false: nobody ("Cannot find attached player"). @default world.cloudSolutions.owner */
  owner?: string | false;
}

/** A Cloud Solutions KV storage. */
export interface KvStorageSpec extends CloudSolutionsBlockSpec {
  /** Subscriptions at boot: key pattern (a Java regex) to the computer ids subscribed. */
  subscriptions?: Record<string, number[]>;
}

/** A Cloud Solutions StatsD bridge. */
export interface StatsdBridgeSpec extends CloudSolutionsBlockSpec {
  /** Player name its aspects start with. @default world.cloudSolutions.ownerName */
  ownerName?: string;
  /** The owner is on the server. @default world.cloudSolutions.ownerOnline */
  ownerOnline?: boolean;
}

// ===== CC: VS (rom-overlay/rom/ccsim/addons/cc-vs) =====

/** A vector: { x, y, z } (missing parts are 0) or [x, y, z]. */
export type CcVsVec3 =
  | {
      /** X. @default 0 */
      x?: number;
      /** Y. @default 0 */
      y?: number;
      /** Z. @default 0 */
      z?: number;
    }
  | [number, number, number];

/** A quaternion: { x, y, z, w } or [x, y, z, w]. */
export type CcVsQuaternion =
  | {
      /** X. @default 0 */
      x?: number;
      /** Y. @default 0 */
      y?: number;
      /** Z. @default 0 */
      z?: number;
      /** W. @default 1 */
      w?: number;
    }
  | [number, number, number, number];

/** A 3x3 matrix: three rows of three numbers. */
export type CcVsMatrix3 = number[][];

/** cc_vs-common.toml and Valkyrien Skies' server config. */
export interface CcVsConfig {
  /** ship.teleport is allowed. @default false */
  canTeleport?: boolean;
  /** Admin methods need a command computer (inverted in 0.5.1, as in the mod). @default true */
  commandOnly?: boolean;
  /** physics_ticks events are sent. @default false */
  exposePhysTick?: boolean;
  /** Physics ticks per game tick. @default 3 */
  physicsTicksPerGameTick?: number;
  /** aero.getDragCoefficient. @default 2.18 */
  dragCoefficient?: number;
}

/** The ship's shipAABB, in whole blocks. */
export interface CcVsAabb {
  /** Lowest x. @default 0 */
  minX?: number;
  /** Lowest y. @default 0 */
  minY?: number;
  /** Lowest z. @default 0 */
  minZ?: number;
  /** Highest x. @default 0 */
  maxX?: number;
  /** Highest y. @default 0 */
  maxY?: number;
  /** Highest z. @default 0 */
  maxZ?: number;
}

/** The ship's drag controller (1.20.1 drag API). */
export interface CcVsDrag {
  /** drag.getDragForce. @default {"x":0,"y":0,"z":0} */
  dragForce?: CcVsVec3;
  /** drag.getLiftForce. @default {"x":0,"y":0,"z":0} */
  liftForce?: CcVsVec3;
  /** Drag on. @default true */
  drag?: boolean;
  /** Lift on. @default true */
  lift?: boolean;
  /** Rotational drag on. @default true */
  rotDrag?: boolean;
  /** Wind direction. @default {"x":0,"y":0,"z":0} */
  windDirection?: CcVsVec3;
  /** Wind speed. @default 0 */
  windSpeed?: number;
}

/** The ship the computer is on. */
export interface CcVsShip {
  /** Ship id. @default 1 */
  id?: number;
  /** Ship name; without one getSlug says "no-name". */
  slug?: string;
  /** Mass, kg. @default 1000 */
  mass?: number;
  /** Moment of inertia tensor, rows. @default all zeros */
  inertia?: CcVsMatrix3;
  /** 1.18.2 getMomentOfInertiaTensorToSave. @default inertia */
  inertiaToSave?: CcVsMatrix3;
  /** Centre of mass in the world. @default {"x":0,"y":0,"z":0} */
  position?: CcVsVec3;
  /** Centre of mass in the shipyard. @default {"x":0,"y":0,"z":0} */
  shipyardPosition?: CcVsVec3;
  /** Rotation. @default {"x":0,"y":0,"z":0,"w":1} */
  rotation?: CcVsQuaternion;
  /** Scale: one number for all axes, or per axis. @default 1 */
  scale?: number | CcVsVec3;
  /** Velocity, m/s. @default {"x":0,"y":0,"z":0} */
  velocity?: CcVsVec3;
  /** Angular velocity. @default {"x":0,"y":0,"z":0} */
  omega?: CcVsVec3;
  /** Static (frozen). @default false */
  static?: boolean;
  /** Dimension id. @default the computer's dimension */
  dimension?: string;
  /** The ship's shipAABB; omit for none. */
  aabb?: CcVsAabb;
  /** 1.18.2 getConstraints: the maps VSConstraint.toLua makes, returned as given. @default [] */
  constraints?: Record<string, unknown>[];
  /** 1.20.1 getJoints: the maps VSJointAndId.toLua makes, returned as given. @default [] */
  joints?: Record<string, unknown>[];
  /** Buoyant factor physics-tick snapshots report. @default 1 */
  buoyantFactor?: number;
  /** doFluidDrag physics-tick snapshots report. @default true */
  doFluidDrag?: boolean;
  /** 1.20.1 drag controller; false: none. @default all forces zero, everything on */
  drag?: CcVsDrag | false;
}

/** One dimension's atmosphere (aero.getAtmosphericParameters). */
export interface CcVsAtmosphere {
  /** Top of the atmosphere. @default 962 */
  maxY?: number;
  /** Sea level. @default 62 */
  seaLevel?: number;
  /** Gravity. @default 10 */
  gravity?: number;
}

/** An air value: one number at every height, or by y ("100", read as given then as a whole number). */
export type CcVsAirValue = number | Record<string, number>;

/** Air values; Valkyrien Skies' atmosphere model is not emulated, so a getter with no value errors. */
export interface CcVsAir {
  /** aero.getAirDensity. */
  density?: CcVsAirValue;
  /** aero.getAirPressure. */
  pressure?: CcVsAirValue;
  /** aero.getAirTemperature. */
  temperature?: CcVsAirValue;
}

/** The aerodynamics API's fixtures (1.20.1). */
export interface CcVsAero {
  /** Dimension id to its atmosphere. */
  atmospheres?: Record<string, CcVsAtmosphere>;
  /** Air density, pressure and temperature. */
  air?: CcVsAir;
}

/** CC: VS settings. */
export interface CcVsWorld {
  /** Computer family (only command matters); a turtle world is always a turtle. @default "normal" */
  family?: "normal" | "advanced" | "command";
  /** Mod and Valkyrien Skies config. */
  config?: CcVsConfig;
  /** The ship the computer is on; omit: on no ship. */
  ship?: CcVsShip;
  /** Aerodynamics fixtures (1.20.1 only). */
  aero?: CcVsAero;
}

// ===== CC Shops (rom-overlay/rom/ccsim/addons/cc-shops) =====

/** An item in a shop. A name without ":" gets "minecraft:"; a count of 0 or less is empty. */
export interface ShopItemSpec {
  /** Item id. @example "minecraft:emerald" */
  name: string;
  /** Count. @default 1 */
  count?: number;
  /** NBT hash, as getItemDetail shows it. */
  nbt?: string;
}

/** A player or loaded entity, by UUID. */
export interface ShopPlayerSpec {
  /** Name (a player's profile name, or an entity's display name). @default "" */
  name?: string;
  /** UUID; an entry without one is skipped. */
  uuid: string;
}

/** CC Shops settings. */
export interface CcShopsWorld {
  /** Online players (getOwner, setOwner). */
  players?: ShopPlayerSpec[];
  /** Other loaded entities (getOwner, setOwner). */
  entities?: ShopPlayerSpec[];
  /** Default of commandComputer for shop peripherals that do not say. @default false */
  commandComputer?: boolean;
  /** Item ids to accept besides the game data's and Simple Shops' own. */
  items?: string[];
}

/** A Simple Shop's contents (a shop block's `shop`). */
export interface ShopBlockSpec {
  /** What one sale gives. @default empty */
  stock?: ShopItemSpec;
  /** Items held for sale (invNr), not sales. @default 0 */
  stored?: number;
  /** The price. @default empty */
  cost?: ShopItemSpec;
  /** Payments held for the owner. @default 0 */
  gains?: number;
  /** The stock viewer item. @default empty */
  bar?: ShopItemSpec;
  /** Owner UUID. @default "00000000-0000-0000-0000-000000000000" */
  owner?: string;
}

/** A CC Shops shop peripheral. */
export interface ShopSpec extends ShopBlockSpec {
  /** A Creative Simple Shop (never runs out). @default false */
  creative?: boolean;
  /** The computer touching it is a command computer (adds the setters). @default world.ccShops.commandComputer */
  commandComputer?: boolean;
}

// ===== CC:C Bridge (rom-overlay/rom/ccsim/addons/cccbridge) =====

/** CC:C Bridge settings: none yet; the key only loads the addon at boot. */
export interface CccBridgeWorld {}

/** An animatronic part's rotation, degrees: [x, y, z] (each taken modulo 360). */
export type AnimatronicRotation = [number, number, number];

/** CC:C Bridge animatronic. */
export interface AnimatronicSpec {
  /** Face shown at boot. @default "normal" */
  face?: "normal" | "happy" | "question" | "sad";
  /** Transition between poses (1.7.x). @default "rusty" */
  transition?: "rusty" | "none" | "linear";
  /** The pose already applied, per part. @default every part [0, 0, 0] */
  pose?: {
    /** Head rotation. */
    head?: AnimatronicRotation;
    /** Body rotation. */
    body?: AnimatronicRotation;
    /** Left arm rotation. */
    leftArm?: AnimatronicRotation;
    /** Right arm rotation. */
    rightArm?: AnimatronicRotation;
  };
}

/** CC:C Bridge RedRouter. */
export interface RedRouterSpec {
  /** Which way the block's front faces. @default "north" */
  facing?: "north" | "south" | "east" | "west";
  /** Incoming redstone 0-15 by side (relative to the block's front) or direction. @default 0 per side */
  inputs?: Partial<Record<AnySide, number>>;
  /** Redstone it already sends, 0-15, by side or direction. @default 0 per side */
  outputs?: Partial<Record<AnySide, number>>;
}

/** CC:C Bridge scroller pane. */
export interface ScrollerSpec {
  /** Value at boot, kept within -limit..limit. @integer @default 0 */
  value?: number;
  /** The limit: values run -limit..limit. @integer @default 15 */
  limit?: number;
  /** Minus spectrum on: players can pick negative values. @default false */
  minus?: boolean;
  /** Locked: players cannot turn it. @default false */
  locked?: boolean;
}

/** CC:C Bridge source block. */
export interface CreateSourceSpec {
  /** A display link that reads this source; without it nothing reads it. */
  link?: {
    /** Rows of the link's target. @integer @default 1 */
    rows?: number;
    /** Columns of the link's target. @integer @default 1 */
    columns?: number;
    /** Powered by redstone: the link does not send. @default false */
    powered?: boolean;
  };
}

/** CC:C Bridge target block. */
export interface CreateTargetSpec {
  /** Width in characters (1.21.1 only; earlier versions are 32). @integer @minimum 1 @default 32 */
  width?: number;
  /** Height in lines (1.21.1 only; 1.20.1 is 8, 1.18.2 is 24). @integer @minimum 1 @default 8 */
  height?: number;
}

// ===== Create: CC Total Logistics (rom-overlay/rom/ccsim/addons/create-cc-logistics) =====

/** An item in a package or on a clipboard. */
export interface LogisticsItemSpec {
  /** Item id. @example "minecraft:iron_ingot" */
  name: string;
  /** Stack size. @integer @default 1 */
  count?: number;
  /** The item's NBT, for stacking. */
  nbt?: unknown;
  /** Stack limit. @default 64 */
  maxCount?: number;
  /** Display name. @default the registry name in title case */
  displayName?: string;
  /** 1.20.1: the item's NBT as JSON, for the item JSON the mod prints and reads. */
  tag?: Record<string, unknown>;
  /** 1.21.1: the item's components, for the item JSON the mod prints and reads. */
  components?: Record<string, unknown>;
}

/** A stock link on a packager, facing an inventory. */
export interface LogisticsLinkSpec {
  /** Link name (sim commands use it). @default "link_<its place in the list>" */
  name?: string;
  /** The inventory the packager faces: a world inventory peripheral's name, or false for none. Without it the link has its own (`items`, `size`). */
  inventory?: string | false;
  /** Its own inventory's items. @default [] */
  items?: InventoryItems;
  /** Its own inventory's slots. @integer @default 27 */
  size?: number;
  /** Block id the packager faces, for stockLinkDetails().type. @default the inventory peripheral's type, else "minecraft:chest" */
  block?: string;
  /** Redstone on the link; 15 takes it off the network. @integer @minimum 0 @maximum 15 @default 0 */
  power?: number;
  /** false: a link with no packager behind it. @default true */
  packager?: boolean;
  /** A packageport peripheral above the packager (its address filter is the link's address). */
  frogport?: string;
  /** The frogport address it reports, without a `frogport`. */
  frogportAddress?: string;
  /** Ticks a package takes from this packager to a port. @default the network's, else createLogistics.travelTicks */
  travelTicks?: number;
}

/** A logistics network: the stock links on one frequency. */
export interface LogisticsNetworkSpec {
  /** Ticks a package takes from a packager to a port on this network. @default createLogistics.travelTicks */
  travelTicks?: number;
  /** Its stock links. @default [] */
  links?: LogisticsLinkSpec[];
}

/** Create: CC Total Logistics settings: logistics networks and their stock links. */
export interface CreateLogisticsWorld {
  /** Ticks a package takes from its packager to a port. @default 40 */
  travelTicks?: number;
  /** Extra item ids that exist, beyond the game data and the items the world names. @default [] */
  items?: string[];
  /** Logistics networks by id (the `network` of stock tickers and requesters). */
  networks?: Record<string, LogisticsNetworkSpec>;
}

/** Stock ticker (stockcheckingblock). */
export interface StockCheckingBlockSpec {
  /** Network id in createLogistics.networks; an unknown id is an empty frequency. */
  network?: string;
}

/** Redstone requester. */
export interface RedstoneRequesterSpec {
  /** Network id in createLogistics.networks; an unknown id is an empty frequency. */
  network?: string;
}

/** A package already in a package port. */
export interface LogisticsPackageSpec {
  /** Port slot, 1-18. @integer @minimum 1 @maximum 18 @default its place in the list */
  slot?: number;
  /** Address on the package. @default "" */
  address?: string;
  /** Contents, up to 9 stacks (more are dropped). @default [] */
  items?: LogisticsItemSpec[];
  /** Set: the package is a fragment of an order; true marks the final one. */
  final?: boolean;
}

/** Package port (frogport, postbox). */
export interface PackagePortSpec {
  /** Address filter. @default "" */
  addressFilter?: string;
  /** Takes packages. @default true */
  acceptsPackages?: boolean;
  /** Packages already in its 18 slots. @default [] */
  packages?: LogisticsPackageSpec[];
}

/** One clipboard entry. */
export interface ClipboardEntrySpec {
  /** Entry text. @default "" */
  text?: string;
  /** Ticked. @default false */
  checked?: boolean;
  /** Item icon. */
  icon?: LogisticsItemSpec;
  /** Item amount readPage reports as the icon's count. @default 0 */
  amount?: number;
}

/** Clipboard. */
export interface ClipboardSpec {
  /** Pages, each a list of entries. @default [] */
  pages?: ClipboardEntrySpec[][];
}

// ===== CC: LiftLink (rom-overlay/rom/ccsim/addons/cc-liftlink) =====

/** An elevator contact, by its height and names. */
export interface LiftLinkContactFields {
  /** Contact Y. @integer @default 0 */
  y?: number;
  /** Short floor name; blank gets Create's generated names at boot. @default "" */
  shortName?: string;
  /** Long floor name. @default "" */
  longName?: string;
  /** The floor it last showed (lastReportedCurrentFloor). @default "" (an assembled cab's floor at boot) */
  currentFloor?: string;
  /** Calling the cab. @default false */
  calling?: boolean;
  /** Powered by redstone. @default false */
  powered?: boolean;
}

/** An elevator contact no computer touches. */
export interface LiftLinkContactSpec extends LiftLinkContactFields {}

/** A column's elevator pulley and its cab. */
export interface LiftLinkPulleySpec {
  /** The pulley block's Y. @integer @default the highest contact's + 3 */
  y?: number;
  /** The cab's contact, relative to the cab's top block. @integer @default 0 */
  contactYOffset?: number;
  /** Horizontal blocks between the pulley and the contact column. @integer @default 1 */
  distance?: number;
  /** Kinetic network id in create.networks; wins over `rpm`. */
  network?: string;
  /** Input RPM without a `network`. @default 32 (0 with a network) */
  rpm?: number;
  /** The cab is a moving contraption. @default true */
  assembled?: boolean;
  /** Where the cab's contact stands. @default the column's target, else the lowest contact */
  cabY?: number;
  /** Rope length, blocks: while disassembled, or over the cab's position. @default -1 while disassembled */
  offset?: number;
}

/** An elevator column. */
export interface LiftLinkColumnSpec {
  /** Column X (getState blockX). @integer @default 0 */
  x?: number;
  /** Column Z (getState blockZ). @integer @default 0 */
  z?: number;
  /** Which way the contacts face. @default "south" */
  facing?: Direction;
  /** The column's target Y at boot. @default the assembled cab's floor, else none */
  target?: number;
  /** Contacts without a computer. @default [] */
  contacts?: LiftLinkContactSpec[];
  /** The elevator pulley; without it the column has no cab. */
  pulley?: LiftLinkPulleySpec;
}

/** CC: LiftLink settings: elevator columns. */
export interface LiftLinkWorld {
  /** The world's lowest Y, for the pulley's extension range. @integer @default -64 */
  minBuildHeight?: number;
  /** Elevator columns by id (the `column` of create_elevator peripherals). */
  columns?: Record<string, LiftLinkColumnSpec>;
}

/** CC: LiftLink elevator contact. */
export interface CreateElevatorSpec extends LiftLinkContactFields {
  /** Column id in liftlink.columns; without it the contact is a column of its own. */
  column?: string;
}

// ===== Mobs with a computer in them (rom-overlay/rom/ccsim/mob.lua) =====

/** An item in a mob's hand or slot, or one it drops (brain.normItem: a name without ":" gets "minecraft:"). */
export interface MobItemSpec {
  /** Item id. @example "minecraft:redstone" */
  name: string;
  /** Stack size; 0 or less is no item. @default 1 */
  count?: number;
  /** The stack's NBT: a hash, SNBT or JSON (a full tag is carried as its hash). */
  nbt?: unknown;
  /** Display name (getItemDetail; also tells stacks apart). */
  displayName?: string;
  /** Stack limit. @default the game data's, at most 64 */
  maxCount?: number;
  /** Damage a tool has taken. @default 0 */
  damage?: number;
  /** Damage at which a tool breaks (CC: Androids). @default the game data's */
  maxDamage?: number;
  /** A tool that never wears out (CC: Androids). @default false */
  unbreakable?: boolean;
  /** Attack damage bonus of this item as a weapon (CC: Androids). @default the vanilla tool's, else 0 */
  attackDamage?: number;
}

/** Where a mob starts. Whole x and z put it in the middle of that block; fractions are taken as they are. */
export interface MobPlaceSpec {
  /** X of its feet. @default 0 */
  x?: number;
  /** Y of its feet. @default 64 */
  y?: number;
  /** Z of its feet. @default 0 */
  z?: number;
  /** Dimension. @default "minecraft:overworld" */
  dimension?: string;
}

// ===== CC: Androids (rom-overlay/rom/ccsim/addons/cc-androids) =====

/** An android's two hands. */
export interface AndroidHandsSpec {
  /** Main hand: the right side's pocket upgrade, and the tool or weapon it uses. */
  main?: MobItemSpec;
  /** Off hand: the left side's pocket upgrade. */
  off?: MobItemSpec;
}

/** The player who opened the android first; it acts and chats as them. */
export interface AndroidOwnerSpec {
  /** The player's name. */
  name?: string;
  /** The player's UUID, which the android's chat and actions carry. */
  uuid: string;
}

/** CC: Androids: the computer is this android (docs/cc-androids.md). */
export interface AndroidSpec extends MobPlaceSpec {
  /** Which android: its computer, health, damage, speed and sight. @default "normal" */
  type?: "normal" | "advanced" | "command";
  /** Without `type`: true makes it an advanced android. @default false */
  advanced?: boolean;
  /** Fuel; a normal or advanced android with none cannot act until fed redstone. @default 0 @minimum 0 @maximum 10000 */
  fuel?: number;
  /** Health points. @default the type's full health */
  health?: number;
  /** What it holds in each hand. */
  hands?: AndroidHandsSpec;
  /** The stash: slot "0" to "8" (as the API counts them) to item. */
  inventory?: Record<string, MobItemSpec>;
  /** The player who opened it first; without one it is CC's fake player. */
  owner?: AndroidOwnerSpec;
  /** The android's own UUID (getSelf). @default "00000000-0000-4000-a000-000000000001" */
  uuid?: string;
}

/** CC: Androids config file values, by their names there. */
export interface AndroidConfig {
  /** A normal android's full health. @default 20 */
  AndroidMaxHealth?: number;
  /** A normal android's base attack damage. @default 1 */
  AndroidDamage?: number;
  /** A normal android's walking speed. @default 0.6 */
  AndroidSpeed?: number;
  /** An advanced android's full health. @default 25 */
  AdvAndroidMaxHealth?: number;
  /** An advanced android's base attack damage. @default 3 */
  AdvAndroidDamage?: number;
  /** An advanced android's walking speed. @default 0.9 */
  AdvAndroidSpeed?: number;
  /** A command android's full health. @default 25 */
  ComAndroidMaxHealth?: number;
  /** A command android's base attack damage. @default 3 */
  ComAndroidDamage?: number;
  /** A command android's walking speed. @default 0.9 */
  ComAndroidSpeed?: number;
}

// ===== CC: Drones and CC: Drones+ (rom-overlay/rom/ccsim/addons/cc-drones) =====

/** A CC: Drones+ upgrade. */
export type DroneUpgrade = "mine" | "carry" | "survey" | "modem";

/** CC: Drones: the computer is this drone (docs/cc-drones.md). */
export interface CcDroneSpec extends MobPlaceSpec {
  /** Yaw, degrees as F3 shows them: 0 south, 90 west, 180 north, -90 east. @default 0 */
  yaw?: number;
  /** Pitch, degrees; nothing in the API changes it. @default 0 */
  pitch?: number;
  /** Start with the engine on. @default false */
  engineOn?: boolean;
  /** Start without gravity (NoGravity); otherwise a drone in the air falls. @default false */
  hover?: boolean;
}

/** CC: Drones+: the computer is this drone (docs/cc-drones.md). */
export interface CcDronePlusSpec extends CcDroneSpec {
  /** Upgrades installed at the start. @default [] */
  upgrades?: DroneUpgrade[];
}

/** A block the drone workbench reads, without a block world around it. */
export interface DroneWorkbenchBlockSpec {
  /** Block id. @example "minecraft:stone" */
  name: string;
  /** Block state properties, as strings. @default {} */
  state?: Record<string, string>;
}

/** A block near the drone workbench, by its offset from it. */
export interface DroneWorkbenchAroundSpec extends DroneWorkbenchBlockSpec {
  /** X offset from the workbench. @integer */
  dx: number;
  /** Y offset from the workbench. @integer */
  dy: number;
  /** Z offset from the workbench. @integer */
  dz: number;
}

/** A drone within 2 blocks of the workbench. */
export interface DroneWorkbenchDroneSpec {
  /** The drone's computer id. */
  id?: number;
  /** The drone's computer id, when there is no `id`. */
  computerId?: number;
}

/** CC: Drones / CC: Drones+ drone workbench. In a block world it reads the real blocks instead of below and around. */
export interface DroneWorkbenchSpec {
  /** Whose workbench it is when both addons are on. @default "cc-drones" with both on, else the one that is on */
  mod?: "cc-drones" | "cc-drones-plus";
  /** The block under it, for debug(). @default air */
  below?: DroneWorkbenchBlockSpec;
  /** Blocks around it by offset, for survey(). @default [] */
  around?: DroneWorkbenchAroundSpec[];
  /** Drones within 2 blocks, nearest first (a computer id, or an object with one); export writes to the first. @default [] */
  drones?: (number | DroneWorkbenchDroneSpec)[];
}

// ===== AC-Drones (rom-overlay/rom/ccsim/addons/ac-drones) =====

/** An AC-Drones attachment slot: a kind, its item id, or empty. */
export type AcDroneAttachment =
  | "modem"
  | "advanced_modem"
  | "chunkloader"
  | "computercraft:wireless_modem_normal"
  | "computercraft:wireless_modem_advanced"
  | "acdrones:drone_chunkloader"
  | "none"
  | ""
  | false
  | null;

/** AC-Drones: the computer is this drone (docs/ac-drones.md). */
export interface AcDroneSpec extends MobPlaceSpec {
  /** Yaw, degrees as F3 shows them: 0 south, 90 west, 180 north, -90 east. @default 0 */
  yaw?: number;
  /** Pitch, degrees. @default 0 */
  pitch?: number;
  /** The four slots: "1" to "4" (as the API counts them) to item. */
  inventory?: Record<string, MobItemSpec>;
  /** Selected slot. @default 1 @integer @minimum 1 @maximum 4 */
  selectedSlot?: number;
  /** The bottom slot: a claw (by name or item id), or empty. @default "none" */
  accessory?: "claw" | "acdrones:drone_claw" | "none" | "" | false | null;
  /** The block a claw starts with: a `blocks` entry without its position. */
  carrying?: Omit<BlockSpec, "x" | "y" | "z">;
  /** The two attachment slots (top, back), as a list or by "1" and "2". @default [] */
  attachments?: AcDroneAttachment[] | Record<string, AcDroneAttachment>;
  /** Which build: "alpha-7" (or "a73fcdd", the release) or "fa57149" (or "master", the later fix of place()). @default "alpha-7" */
  build?: "alpha-7" | "a73fcdd" | "fa57149" | "master";
  /** Which of the mod's two suck methods the computer got: "quantity" is suck(n), "none" is suck(). @default "quantity" */
  suckOverload?: "quantity" | "none";
}

// ===== Mounted drive folders (rom-overlay/rom/ccsim/addons/mounts.lua) =====

/**
 * What a mod's drive block held before the world started: path (relative to the drive's root) to file text. Written
 * once, into a new save folder (results/addons/...); a folder that already exists keeps its files.
 * @example {"startup.lua":"print('hi')"}
 */
export type MountedDriveFiles = Record<string, string>;

// ===== CC: Lectern Hub (rom-overlay/rom/ccsim/addons/lectern-hub) =====

/** The pocket computer on a lectern. */
export interface LecternPocketSpec {
  /** Its computer ID (getID). @integer @default 1 */
  id?: number;
  /** Its label (getLabel). @default none */
  label?: string;
  /** Running at boot (isOn). @default false */
  on?: boolean;
}

/** CC: Lectern Hub lectern: CC:Tweaked's lectern holding a pocket computer or a printout. */
export interface CcLecternSpec {
  /** The pocket computer on the lectern; wins over `item`. */
  pocket?: LecternPocketSpec;
  /** Without `pocket`: the printout's item id (only shown in sim state). @default "computercraft:printed_page" */
  item?: string;
}

// ===== Cricket's Peripherals (rom-overlay/rom/ccsim/addons/crickets-peripherals) =====

/** Cricket's Peripherals settings (the mod's config). */
export interface CricketsPeripheralsWorld {
  /** Config hddSize: a hard drive's capacity in bytes (fs.getCapacity; not enforced). @integer @default 2097152 */
  hddSize?: number;
}

/** Cricket's Peripherals hard drive: mounts its save folder at "hdd" (or "hdd1", ...). */
export interface CricketsHardDriveSpec {
  /** Its save folder number (results/addons/hdd/<mountId>). @integer @minimum 0 @default the next free number */
  mountId?: number;
  /** What the drive held before the world started. */
  files?: MountedDriveFiles;
}

/** Cricket's Peripherals data coprocessor. No extra fields. */
export interface DataCoprocessorSpec {}

// ===== CCTech (rom-overlay/rom/ccsim/addons/cctech) =====

/** CCTech settings (the mod's config). */
export interface CcTechWorld {
  /** Cassette Operation Time: bytes a cassette deck moves per second. @default 10000 */
  cassetteBytesPerSecond?: number;
  /** Reel Operation Time: bytes a reel to reel moves per second. @default 20000 */
  reelBytesPerSecond?: number;
  /** Cassette Default Size: a tape's length in bytes when it gives none. @default 360000 */
  defaultLength?: number;
}

/** A tape in a drive. Its data file is results/addons/cctech/<cassette|reel>/<uuid>. */
export interface CcTechTapeSpec {
  /** The tape's UUID, which names its data file. @default a random UUID */
  uuid?: string;
  /** Length in bytes. @integer @default cctech.defaultLength */
  length?: number;
  /** The tape's label. @default none */
  label?: string;
  /** What the tape holds from position 0, for a tape with no data file yet. @default all zero bytes */
  data?: string;
  /** The saved pointer, for a tape with no data file yet (a reel always starts at 0). @integer @default 0 */
  pointer?: number;
}

/** CCTech cassette deck. */
export interface CassetteDeckSpec {
  /** The door is open (every read and write fails with "Door open"). @default false */
  open?: boolean;
  /** The tape in the slot. @default none */
  tape?: CcTechTapeSpec;
}

/** CCTech reel to reel. */
export interface ReelToReelSpec extends CassetteDeckSpec {
  /** Locked: the door stays shut, and it must be locked to be ready. @default false */
  locked?: boolean;
}

/** A magnetic card. */
export interface CcTechCardSpec {
  /** The UUID of the writer that wrote it. @default none (a blank card) */
  uuid?: string;
  /** What was written on it. @default none */
  contents?: string;
  /** The card's label. @default none */
  label?: string;
}

/** CCTech card writer (also a magnetic_card_reader). */
export interface CardWriterSpec {
  /** The door is open (every card method fails with "Door open"). @default false */
  open?: boolean;
  /** The writer's UUID (getUUID; the uuid of the cards it writes). @default a random UUID */
  writerUUID?: string;
  /** The card in the slot. @default none */
  card?: CcTechCardSpec;
}

/** CCTech magnetic card reader. No extra fields: swipes come from the ctSwipe sim command. */
export interface MagneticCardReaderSpec {}

// ===== Embedded Computer (rom-overlay/rom/ccsim/addons/embedded-computer) =====

/** Embedded Computer settings, and what this computer is. */
export interface EmbeddedComputerWorld {
  /**
   * Make this computer one of the mod's: "embedded" (10x3 screen, `embedded` and `security` APIs) or "secure" (49x17
   * screen, `security`). `terminal` still wins for the size. @default none (a plain computer)
   */
  kind?: "embedded" | "secure";
  /** Config HARD_DRIVE_STORAGE: a hard drive mount's capacity in bytes. @integer @default 25000000 */
  hardDriveStorage?: number;
}

/** Embedded Computer's embedded or secure computer block (not run: its files are a folder). */
export interface EmbeddedComputerBlockSpec {
  /** Its computer ID (getId); names its folder results/addons/embedded/<id>. @integer @default 1 */
  id?: number;
  /** Which of the mod's computers it is. @default "embedded" */
  kind?: "embedded" | "secure";
  /** Its files at the start, e.g. ".LOCKED" or ".LOCKED_HASHED" to lock it. */
  files?: MountedDriveFiles;
}

/** Embedded Computer hard drive: mount(path) mounts its folder results/addons/ec-hdd/<uuid>. */
export interface EmbeddedHardDriveSpec {
  /** The drive's UUID, which names its folder. @default a random UUID on the first mount */
  uuid?: string;
  /** What the drive held before the world started. */
  files?: MountedDriveFiles;
}

// ===== Lake's CC Additions (rom-overlay/rom/ccsim/addons/lakes-cc-additions) =====

/** Lake's CC Additions settings (ScannerConfig). */
export interface LakesCcAdditionsWorld {
  /** requirePrintoutMaterials: createPrintout needs paper (in the slot, or in the folder there). @default false */
  requirePrintoutMaterials?: boolean;
  /** The Exposure mod is installed (the photo methods then fail as not emulated). @default false */
  exposure?: boolean;
}

/** An NBT tag in the addon's own form (nbt.lua): a type and a value. Prefer SNBT text. */
export interface LakesNbtTag {
  /** Tag type, e.g. "compound", "list", "string", "byte_array". */
  t: string;
  /** Tag value: for a compound, key to tag; for a list, its tags. */
  v: unknown;
}

/** A decoration on a filled map. */
export interface LakesMapDecorationSpec {
  /** Decoration type, any case. @default "player" */
  type?: string;
  /** X on the map. @integer @default 0 */
  x?: number;
  /** Y on the map. @integer @default 0 */
  y?: number;
  /** Rotation, 0-15. @integer @default 0 */
  rotation?: number;
  /** Its name. @default none */
  name?: string;
}

/** A filled map's saved data (scanMap and the map pixel methods). */
export interface LakesMapSpec {
  /** Centre X. @integer @default 0 */
  centerX?: number;
  /** Centre Z. @integer @default 0 */
  centerZ?: number;
  /** Scale, 0-4. @integer @default 0 */
  scale?: number;
  /** Locked in a cartography table. @default false */
  locked?: boolean;
  /** The map's dimension. @default "minecraft:overworld" */
  dimension?: string;
  /** Banners, players and other markers. @default [] */
  decorations?: LakesMapDecorationSpec[];
  /** The 16384 packed map colour bytes (colour id * 4 + shade), row by row; wins over `fill`. */
  colors?: number[];
  /** One packed colour byte for every pixel, without `colors`. @integer @default 0 */
  fill?: number;
}

/** The item in a scanner's slot. */
export interface LakesScannerItemSpec {
  /** Item id. @example "lakescanner:folder" */
  name: string;
  /** Stack size. @integer @default 1 */
  count?: number;
  /** getItem's display name. @default the item path in title case */
  displayName?: string;
  /** Damage taken, with `maxDamage`. @integer @default 0 */
  damage?: number;
  /** Most damage: makes it a damageable item (getItem reports damage and maxDamage). @integer */
  maxDamage?: number;
  /** The item's NBT as SNBT, read as Minecraft's TagParser does (or a tag in nbt.lua's form). */
  nbt?: string | LakesNbtTag;
  /**
   * Pen ink per printout page (1-based page to rows of 0-3: none, dark, red, blue), written to LakeDrawing<n>. A JSON
   * array also works: entry i is page i.
   * @example {"1":["0123"]}
   */
  drawings?: Record<string, string[]> | string[][];
  /** A stamp's emblem: 32 rows of 32 digits 0-3, written to Emblem. */
  emblem?: string[];
  /** A filled map's saved data. */
  map?: LakesMapSpec;
}

/** Lake's CC Additions scanner. */
export interface LakesScannerSpec {
  /** The item in its slot; null or none is empty. */
  item?: LakesScannerItemSpec | null;
}

// ===== SwitchCraft Peripherals (rom-overlay/rom/ccsim/addons/sc-peripherals) =====

/** SwitchCraft Peripherals config (default-config.toml). */
export interface ScPeripheralsWorld {
  /** Ticks a 3D print takes (maxPrintProgress). @default 100 */
  printTicks?: number;
  /** Chamelium one chamelium item adds. @default 2000 */
  chameliumValue?: number;
  /** Ink one ink cartridge adds. @default 50000 */
  inkValue?: number;
  /** Highest light level a print may give (setLightLevel). @default 7 */
  maxBaseLightLevel?: number;
  /** Most shapes per state of a print. @default 128 */
  maxShapes?: number;
  /** Extra chamelium for a redstone level of 1 to 14. @default 300 */
  customRedstoneCost?: number;
  /** Chamelium multiplier for a print that does not collide in a state. @default 2 */
  noclipCostMultiplier?: number;
  /** Ticks a poster takes. @default 100 */
  posterPrintTicks?: number;
  /** Ink a fully coloured poster takes. @default 5000 */
  posterInkCost?: number;
}

/** SwitchCraft Peripherals 3D printer or poster printer. */
export interface ScPrinterSpec {
  /** Slots 1 (chamelium; paper for the poster printer), 2 (ink cartridge) and 3 (output). */
  items?: InventoryItems;
  /** Ink held, 0-100000. @integer @default 0 */
  ink?: number;
}

/** SwitchCraft Peripherals 3D printer. */
export interface ScThreeDPrinterSpec extends ScPrinterSpec {
  /** Chamelium held, 0-256000. @integer @default 0 */
  chamelium?: number;
}

// ===== CCX (rom-overlay/rom/ccsim/addons/ccx) =====

/** A card in a CCX PCIe slot. */
export interface CcxCardSpec {
  /** Which card: inventory, peripheral or command. */
  kind: "inventory" | "peripheral" | "command";
  /** Peripheral name of the block the card is bound to (any inventory or peripheral of the world). */
  target?: string;
  /** false: a card never bound (no NBT), so getMethods answers nil. @default true */
  bound?: boolean;
}

/** CCX PCIe block. */
export interface CcxPcieSpec {
  /** Cards in slots 1-4, by slot (a JSON array also works: entry i is slot i). @default {} */
  cards?: Record<string, CcxCardSpec> | CcxCardSpec[];
}

/** The wireless USB in a CCX USB port. */
export interface CcxUsbSpec {
  /** Wireless channel. @default 1 */
  channel?: number;
}

/** CCX USB port. */
export interface CcxUsbPortSpec {
  /** The wireless USB in the port (true: one with no channel); omit for an empty port. */
  usb?: CcxUsbSpec | boolean;
}

// ===== CC: DirectGPU (rom-overlay/rom/ccsim/addons/directgpu) =====

/** A monitor DirectGPU can find (autoDetectAndCreateDisplay). */
export interface DirectGpuMonitorSpec {
  /** Monitor X. @integer @default 0 */
  x?: number;
  /** Monitor Y. @integer @default 0 */
  y?: number;
  /** Monitor Z. @integer @default 0 */
  z?: number;
  /** Which way the monitor faces. @default "north" */
  facing?: Direction | (string & {});
  /** Width in blocks. @integer @default 1 */
  width?: number;
  /** Height in blocks. @integer @default 1 */
  height?: number;
}

/** CC: DirectGPU block. */
export interface DirectGpuSpec {
  /** Monitors it can find, by peripheral name (they need not be peripherals of the world). @default {} */
  monitors?: Record<string, DirectGpuMonitorSpec>;
}

// ===== Plethora Peripherals (rom-overlay/rom/ccsim/addons/plethora) =====

/** A vector, { x, y, z } or [x, y, z]. */
export type PlethoraVector =
  | {
      /** X part. @default 0 */
      x?: number;
      /** Y part. @default 0 */
      y?: number;
      /** Z part. @default 0 */
      z?: number;
    }
  | number[];

/** Worn armour, by slot. */
export interface PlethoraArmorSpec {
  /** Boots. */
  feet?: ItemSpec;
  /** Leggings. */
  legs?: ItemSpec;
  /** Chestplate. */
  chest?: ItemSpec;
  /** Helmet. */
  head?: ItemSpec;
}

/** What Plethora's sensor meta reads of a living thing, player or mob. */
export interface PlethoraLivingFields {
  /** Worn armour (getMetaOwner, getMetaByID: armor.boots ... helmet; a player's getEquipment). */
  armor?: PlethoraArmorSpec;
  /** Item in the off hand. */
  offhand?: ItemSpec;
  /** Motion per tick (motionX/Y/Z). @default {"x":0,"y":0,"z":0} */
  motion?: PlethoraVector;
  /** Movement since the last tick (deltaPosX/Y/Z). @default {"x":0,"y":0,"z":0} */
  deltaPos?: PlethoraVector;
  /** Potion effect names (potionEffects). @default [] */
  potionEffects?: string[];
  /** Absorption hearts. @default 0 */
  absorption?: number;
  /** Eye height above the feet. @default 1.62 for a player (1.27 sneaking), else 0.85 of the height */
  eyeHeight?: number;
  /** false: in the air (isAirborne). @default true */
  onGround?: boolean;
  /** On fire (isBurning). @default false */
  burning?: boolean;
  /** In water (isInWater, isWet). @default false */
  inWater?: boolean;
  /** Wet from rain (isWet). @default false */
  wet?: boolean;
  /** On a ladder (isOnLadder). @default false */
  climbing?: boolean;
  /** Asleep (isSleeping). @default false */
  sleeping?: boolean;
  /** Riding something (isRiding). @default false */
  riding?: boolean;
  /** Sneaking (isSneaking; a sneaking player's box is 1.5 tall). @default false */
  sneaking?: boolean;
  /** Sprinting (isSprinting). @default false */
  sprinting?: boolean;
  /** A baby (isChild). @default false */
  baby?: boolean;
  /** Flying with an elytra (isElytraFlying). @default false */
  elytraFlying?: boolean;
}

/** Plethora's fields of a player in `players`: what the neural interface's wearer carries and does. */
export interface PlethoraPlayerFields extends PlethoraLivingFields {
  /** Plethora: the 36 main slots, slot (1-based) to item. @default {} */
  inventory?: InventoryItems;
  /** Plethora: the ender chest, 27 slots (1-based) to item. @default {} */
  ender?: InventoryItems;
  /** Plethora: selected hotbar slot, 0-8. @integer @minimum 0 @maximum 8 @default 0 */
  heldItemSlot?: number;
  /** Plethora: food level, 0-20. @default 20 */
  food?: number;
  /** Plethora: saturation. @default 5 */
  saturation?: number;
  /** Plethora: game mode; "spectator" hides the player from the sensor. @default "survival" */
  gameMode?: "survival" | "creative" | "adventure" | "spectator";
  /** Plethora: Trinkets group to slot to index to item. @default the neural interface in head.face */
  trinkets?: Record<string, Record<string, InventoryItems>>;
}

/** An entity the Plethora sensor and laser see, besides the players. */
export interface PlethoraEntitySpec extends PlethoraLivingFields {
  /** Entity UUID. @default 00000000-0000-4000-9000-<place as 12 hex digits> */
  uuid?: string;
  /** Another name the sim commands find it by (plethoraMoveEntity entity). */
  id?: string;
  /** Entity type id. @default "minecraft:pig" */
  type?: string;
  /** X of the feet. @default 0 */
  x?: number;
  /** Y of the feet. @default 64 */
  y?: number;
  /** Z of the feet. @default 0 */
  z?: number;
  /** Dimension. @default "minecraft:overworld" */
  dimension?: string;
  /** Yaw, degrees. @default 0 */
  yaw?: number;
  /** Pitch, degrees. @default 0 */
  pitch?: number;
  /** Health points. @default maxHealth */
  health?: number;
  /** Most health points. @default 20 */
  maxHealth?: number;
  /** false: already dead (the sensor skips it). @default true */
  alive?: boolean;
  /** A living entity (armour, health, laser damage). @default the vanilla type's own, else true */
  living?: boolean;
  /** Custom name (displayName). */
  customName?: string;
  /** Box width. @default the vanilla type's, else 0.6 */
  width?: number;
  /** Box height. @default the vanilla type's, else 1 */
  height?: number;
  /** A dropped item (type "minecraft:item"): the stack. */
  item?: ItemSpec;
  /** Item in the main hand. */
  heldItem?: ItemSpec;
  /** Sheep: wool colour (woolColour). @default "white" */
  color?: string;
  /** Same as `color`. */
  colour?: string;
}

/** A player a manipulator's module is bound to, when they are not in `players`. */
export interface PlethoraBoundSpec {
  /** Player UUID. @default "00000000-0000-0000-0000-000000000000" */
  uuid?: string;
  /** Player name. */
  name?: string;
}

/** A module in a neural interface or manipulator, with its level and binding. */
export interface PlethoraModuleSlotSpec {
  /** Module id; without a namespace it gets "plethora:". @example "plethora:scanner" */
  id?: string;
  /** Same as `id`. */
  name?: string;
  /** Module level (range upgrades of the scanner and sensor). @integer @default 0 */
  level?: number;
  /** Bound player: a name or UUID in `players`, or a player of its own. */
  bound?: string | PlethoraBoundSpec;
}

/** A module: its id ("plethora:scanner", "plethora:sensor", "plethora:introspection", "plethora:laser", "plethora:kinetic", "plethora:glasses", "plethora:keyboard"), or one with a level and binding. */
export type PlethoraModuleSpec = string | PlethoraModuleSlotSpec;

/** PlethoraConfig laser section. */
export interface PlethoraLaserConfig {
  /** Lowest potency. @default 0.5 */
  minimumPotency?: number;
  /** Highest potency. @default 5 */
  maximumPotency?: number;
  /** Damage per potency. @default 4 */
  damage?: number;
  /** Energy per potency. @default 10 */
  cost?: number;
  /** Ticks a laser flies. @default 100 */
  lifetime?: number;
}

/** PlethoraConfig kinetic section. */
export interface PlethoraKineticConfig {
  /** Highest launch power. @default 4 */
  launchMax?: number;
  /** Energy per launch power. @default 10 */
  launchCost?: number;
  /** Y scale of a launch. @default 0.5 */
  launchYScale?: number;
  /** A launch resets the fall distance. @default true */
  launchFallReset?: boolean;
  /** A launch resets the float timer. @default true */
  launchFloatReset?: boolean;
  /** Scale of a launch while flying with an elytra. @default 0.4 */
  launchElytraScale?: number;
}

/** PlethoraConfig scanner section. */
export interface PlethoraScannerConfig {
  /** Range at level 0. @default 8 */
  radius?: number;
  /** Range at the top level. @default 16 */
  maxRadius?: number;
  /** Energy of scan() per level. @default 50 */
  scanLevelCost?: number;
}

/** PlethoraConfig sensor section. */
export interface PlethoraSensorConfig {
  /** Range at level 0. @default 16 */
  radius?: number;
  /** Range at the top level. @default 32 */
  maxRadius?: number;
  /** Energy of sense() per level. @default 40 */
  senseLevelCost?: number;
}

/** PlethoraConfig costSystem section. */
export interface PlethoraCostConfig {
  /** Energy at the start. @default 250 */
  initial?: number;
  /** Energy back per tick. @default 10 */
  regen?: number;
  /** Most energy. @default 250 */
  limit?: number;
  /** Energy may go below 0. @default false */
  allowNegative?: boolean;
  /** Wait for energy instead of failing. @default true */
  awaitRegen?: boolean;
}

/** PlethoraConfig overrides, by section. */
export interface PlethoraConfig {
  /** Laser settings. */
  laser?: PlethoraLaserConfig;
  /** Kinetic settings. */
  kinetic?: PlethoraKineticConfig;
  /** Scanner settings. */
  scanner?: PlethoraScannerConfig;
  /** Sensor settings. */
  sensor?: PlethoraSensorConfig;
  /** Energy settings. */
  costSystem?: PlethoraCostConfig;
}

/** Plethora settings: other entities, config and the clock. `{}` loads the module so a turtle knows its upgrades. */
export interface PlethoraWorld {
  /** Entities besides the online players. @default [] */
  entities?: PlethoraEntitySpec[];
  /** PlethoraConfig overrides. */
  config?: PlethoraConfig;
  /** Game tick at the start. @default 0 */
  gameTime?: number;
}

/** Plethora neural interface, worn by a player. */
export interface NeuralInterfaceSpec extends OwnBlockWorldSpec {
  /** The wearer: a name or UUID in `players`. @default the first player */
  owner?: string;
  /** Up to five modules; extra ones are dropped. */
  modules?: PlethoraModuleSpec[];
}

/** Plethora manipulator block. */
export interface ManipulatorSpec extends OwnBlockWorldSpec {
  /** Mark I (one module slot) or Mark II (five). @default 1 */
  mark?: 1 | 2;
  /** Its modules, in slot order; extra ones are dropped. */
  modules?: PlethoraModuleSpec[];
}

/** A Plethora module as a turtle upgrade (the turtle's left/right "plethora:module_<name>"). */
export interface PlethoraModuleUpgradeSpec extends OwnBlockWorldSpec {
  /** Module level. @integer @default 0 */
  level?: number;
}

/** Plethora redstone integrator. */
export interface PlethoraRedstoneIntegratorSpec {
  /** Direction to analog input level (0-15) at the start. @default {} */
  inputs?: Partial<Record<Direction, number>>;
  /** Direction to bundled input bitmask at the start. @default {} */
  bundledInputs?: Partial<Record<Direction, number>>;
}

// ===== CC: Link (rom-overlay/rom/ccsim/addons/cc-link) =====

/** What an item is good for as food. */
export interface CcLinkFoodSpec {
  /** Food points. @default 0 */
  nutrition?: number;
  /** Saturation modifier. @default 0 */
  saturation?: number;
}

/** A CC: Link item. A name without ":" gets "minecraft:"; a count of 0 or less is empty. */
export interface CcLinkItemSpec {
  /** Item id. @example "minecraft:bread" */
  name: string;
  /** Count. @default 1 */
  count?: number;
  /** NBT: a table (NBTUtil.toLua shows it), or an NBT hash string. */
  nbt?: unknown;
  /** Display name, without the square brackets. @default the registry name in title case */
  displayName?: string;
  /** Damage of a damageable item (its Damage tag). @default 0 */
  damage?: number;
  /** Food value, or false for not edible. @default vanilla's own for vanilla foods */
  food?: CcLinkFoodSpec | false;
  /** Item tags as reported ("minecraft:item/<tag>"). @default the game data's */
  tags?: string[];
  /** Stack limit. @default the game data's */
  maxCount?: number;
  /** Modular Link armor: its modules, item ids or items. */
  modules?: (string | CcLinkItemSpec)[];
  /** Modular Link armor: FE stored. @default 0 */
  energy?: number;
}

/** The Link core's wearer. */
export interface CcLinkPlayerSpec {
  /** A name in `players`, or a new player. @default the first player */
  name?: string;
  /** UUID. */
  uuid?: string;
  /** X of the feet. */
  x?: number;
  /** Y of the feet. */
  y?: number;
  /** Z of the feet. */
  z?: number;
  /** Yaw, degrees. */
  yaw?: number;
  /** Pitch, degrees. */
  pitch?: number;
  /** Dimension. */
  dimension?: string;
  /** Health points. */
  health?: number;
  /** Most health points. */
  maxHealth?: number;
  /** Food level. @default 20 */
  food?: number;
  /** Saturation. @default 5 */
  saturation?: number;
  /** Air, ticks. @default 300 */
  air?: number;
  /** Armor points. @default 0 */
  armorValue?: number;
  /** Movement speed attribute. @default 0.1 */
  speed?: number;
  /** Head yaw, degrees. @default yaw */
  headYaw?: number;
  /** In water. @default false */
  inWater?: boolean;
  /** In powder snow. @default false */
  inPowderSnow?: boolean;
  /** Creative mode. @default false */
  creative?: boolean;
  /** Spectator mode. @default false */
  spectator?: boolean;
  /** Flying with an elytra (a launch is 0.4 as strong). @default false */
  fallFlying?: boolean;
  /** Eye height above the feet. @default 1.62 */
  eyeHeight?: number;
  /** Fall distance. @default 0 */
  fallDistance?: number;
  /** Slot (0-based: 0-35 main, 36-39 boots to helmet, 40 off hand) to item. @default {} */
  inventory?: Record<string, CcLinkItemSpec | string>;
  /** Ender chest slot (0-26) to item. @default {} */
  ender?: Record<string, CcLinkItemSpec | string>;
}

/** A biome, as the world upgrade reports it. */
export interface CcLinkBiomeSpec {
  /** Biome id. @default "minecraft:plains" */
  name?: string;
  /** It snows. @default false */
  canSnow?: boolean;
  /** It rains (never when it snows). @default true */
  canRain?: boolean;
  /** Fog colour. @default 12638463 */
  fogColor?: number;
  /** Foliage colour. @default 0 */
  foliageColor?: number;
  /** false: no precipitation at all. @default true */
  precipitation?: boolean;
}

/** Weather, time and biome where the wearer stands. */
export interface CcLinkWorldFacts {
  /** Raining. @default false */
  raining?: boolean;
  /** Thundering. @default false */
  thundering?: boolean;
  /** Day time. @default true */
  day?: boolean;
  /** Sky light at the block under the feet (rain only counts there). @default false */
  canSeeSky?: boolean;
  /** Biome id, or the biome in full. @default "minecraft:plains" */
  biome?: string | CcLinkBiomeSpec;
}

/** CCLinkConfig overrides. */
export interface CcLinkConfig {
  /** The kinetic upgrade table on Link cores. @default true */
  kineticLinkEnabled?: boolean;
  /** FE per launch power from the armor. @default 5000 */
  kineticEnergyMultiplier?: number;
  /** Ticks between overlay packets. @default 1 */
  packetCooldownTicks?: number;
  /** FE of a tier 1 battery module. @default 10000 */
  tier1MaxEnergy?: number;
  /** FE of a tier 2 battery module. @default 50000 */
  tier2MaxEnergy?: number;
  /** FE of a tier 3 battery module. @default 100000 */
  tier3MaxEnergy?: number;
}

/** CC: Link settings: the Link core the computer is, its wearer and their surroundings. */
export interface CcLinkWorld {
  /** The Link core; "turtle" needs `turtle`, "none" is a pocket with only link_armor. @default "link" with a `player`, else "none" */
  core?: "link" | "link_command" | "integrated" | "turtle" | "none";
  /** The core's upgrade slots, in order: item ids or items. @default [] */
  upgrades?: (string | CcLinkItemSpec)[];
  /** How many upgrade slots the core has. @integer @default 8, or more if `upgrades` lists more */
  upgradeSlots?: number;
  /** The wearer: a player name, or the player in full. */
  player?: string | CcLinkPlayerSpec;
  /** Weather, time and biome. */
  world?: CcLinkWorldFacts;
  /** CCLinkConfig overrides. */
  config?: CcLinkConfig;
}

/** CC: Link armor manager pocket upgrade. No fields: the modules come from the wearer's Link armor. */
export interface LinkArmorSpec {}

// ===== Finer Peripherals (rom-overlay/rom/ccsim/addons/finer-peripherals) =====

/** A Finer Peripherals item. A name without ":" gets "minecraft:"; a count of 0 or less is empty. */
export interface FinerItemSpec {
  /** Item id. @example "minecraft:diamond" */
  name: string;
  /** Count. @default 1 */
  count?: number;
  /** NBT: a table, or an NBT hash string. */
  nbt?: unknown;
  /** Display name, without the square brackets. @default the registry name in title case */
  displayName?: string;
  /** Damage of a damageable item. @default 0 */
  damage?: number;
  /** Item tags as reported ("minecraft:item/<tag>"). @default the game data's */
  tags?: string[];
  /** Stack limit. @default the game data's */
  maxCount?: number;
}

/** A respawn point. */
export interface FinerRespawnSpec {
  /** X. @default 0 */
  x?: number;
  /** Y. @default 0 */
  y?: number;
  /** Z. @default 0 */
  z?: number;
  /** Dimension. @default "minecraft:overworld" */
  dimension?: string;
}

/** Finer Peripherals settings. `{}` loads the module so a turtle knows its upgrades. */
export interface FinerPeripheralsWorld {
  /** The turtle's owner (a name or UUID in `players`), for the ender chest upgrade. */
  owner?: string;
  /** The owner's ender chest: slot (0-26) to item. @default {} */
  ender?: Record<string, FinerItemSpec | string>;
  /** Player name to respawn point (getPlayerPos respawnPos). @default {} */
  respawn?: Record<string, FinerRespawnSpec>;
  /** Extra item ids the holographic display accepts. @example {"mymod:gem":true} */
  items?: Record<string, boolean>;
}

/** A Finer Peripherals block or upgrade: x, y, z place a geo explorer block or a pocket upgrade's holder. No other fields. */
export interface FinerPeripheralSpec {}

/** Finer Peripherals holographic item display. */
export interface FinerHoloItemDisplaySpec {
  /** Item id it shows at the start. */
  item?: string;
}

// ===== Ducky Peripherals (rom-overlay/rom/ccsim/addons/ducky-peripherals) =====

/** An entity near an entity detector. */
export interface DuckyEntitySpec {
  /** X of the feet, relative to the detector block. */
  x: number;
  /** Y of the feet, relative to the detector block. */
  y: number;
  /** Z of the feet, relative to the detector block. */
  z: number;
  /** Name. @default the type */
  name?: string;
  /** Type display name. @default "Player" for a player, else "Pig" */
  type?: string;
  /** A player. @default false */
  player?: boolean;
  /** Same as `player`. */
  isPlayer?: boolean;
  /** UUID. @default one made from the detector and the name */
  uuid?: string;
  /** false: never seen (items, arrows, boats). @default true */
  living?: boolean;
  /** Box width. @default 0.6 */
  width?: number;
  /** Box height. @default 1.8 */
  height?: number;
}

/** Ducky Peripherals settings: the weather. */
export interface DuckyPeripheralsWorld {
  /** Raining. @default false */
  raining?: boolean;
  /** Thundering. @default false */
  thundering?: boolean;
}

/** Ducky Peripherals entity detector. */
export interface EntityDetectorSpec {
  /** Entities around it at the start. @default [] */
  entities?: DuckyEntitySpec[];
}

/** Ducky Peripherals weather machine. */
export interface WeatherMachineSpec {
  /** Biome id where it stands. @default "minecraft:plains" */
  biome?: string;
  /** Biome temperature. @default 0.8 */
  temperature?: number;
  /** Precipitation. @default "snow" below 0.15, else "rain" */
  precipitation?: "rain" | "snow" | "none";
}

/** Ducky Peripherals keyboard. No fields: type with the ducky* sim commands. */
export interface DuckyKeyboardSpec {}

/** Ducky Peripherals sculkophone. No fields. */
export interface SculkophoneSpec {}

// ===== More Peripherals (rom-overlay/rom/ccsim/addons/more-peripherals) =====

/** A potion effect. */
export interface MpEffectSpec {
  /** Ticks left. @default 0 */
  duration?: number;
  /** Amplifier. @integer @default 0 */
  amplifier?: number;
}

/** What a player carries, for the player and ender chest interfaces. */
export interface MpPlayerSpec {
  /** Slot (1-36 main, 37-40 feet to head, 41 off hand) to item. Items with `food: { nutrition, saturation }` are edible. @default {} */
  inventory?: InventoryItems;
  /** Ender chest slot (1-27) to item. @default {} */
  enderChest?: InventoryItems;
  /** Selected hotbar slot, 0-8. @integer @minimum 0 @maximum 8 @default 0 */
  selected?: number;
  /** Food level. @default 20 */
  food?: number;
  /** Saturation. @default 5 */
  saturation?: number;
  /** Effect id to effect. @default {} */
  effects?: Record<string, MpEffectSpec>;
}

/** More Peripherals settings. */
export interface MorePeripheralsWorld {
  /** Player name to what they carry. @default {} */
  players?: Record<string, MpPlayerSpec>;
  /** Entity ids a spawner card may carry besides vanilla's spawn-egg mobs. @default [] */
  entities?: string[];
}

/** A More Peripherals block with no fields of its own (xp_bottler, crafter, loom_interface). */
export interface MpBlockSpec {}

/** More Peripherals xp collector. */
export interface XpCollectorSpec {
  /** Stored experience points. @integer @default 0 */
  xp?: number;
}

/** A magnetic card. */
export interface MagneticCardSpec {
  /** Data on the card. */
  data?: string;
  /** Custom name. @default "Magnetic Card" */
  label?: string;
  /** The secure (sensible) flag. */
  sensible?: boolean;
}

/** More Peripherals magnetic card manipulator. */
export interface MagneticCardManipulatorSpec {
  /** The card in it; leave out for none. */
  card?: MagneticCardSpec;
}

/** A bee in a hive. */
export interface MpBeeSpec {
  /** Ticks in the hive. @integer @default 0 */
  ticksInHive?: number;
  /** Ticks it stays. @integer @default 600 */
  minOccupationTicks?: number;
  /** Has stung. @default false */
  hasStung?: boolean;
  /** Health. @default 10 */
  health?: number;
  /** Carries nectar. @default false */
  hasNectar?: boolean;
  /** Age, ticks. @integer @default 0 */
  age?: number;
  /** Anger time, ticks. @integer @default 0 */
  angerTime?: number;
}

/** A beehive. */
export interface MpBeehiveSpec {
  /** Honey level, 0-5. @integer @minimum 0 @maximum 5 @default 0 */
  honeyLevel?: number;
  /** A fire nearby. @default false */
  fireNearby?: boolean;
  /** Bees inside. @default [] */
  bees?: MpBeeSpec[];
}

/** More Peripherals beehive interface. */
export interface BeehiveInterfaceSpec {
  /** The hive next to it; leave out for none. */
  beehive?: MpBeehiveSpec;
  /** How many hives touch it. @integer @default 1 with a `beehive`, else 0 */
  beehives?: number;
}

/** An enchantment on a trade stack. */
export interface MpEnchantmentSpec {
  /** Enchantment id. @example "minecraft:mending" */
  name: string;
  /** Level. @integer */
  level: number;
}

/** A stack in a trade. */
export interface MpTradeStackSpec {
  /** Item id. */
  name: string;
  /** Count. @integer @default 1 */
  count?: number;
  /** Enchantments. @default [] */
  enchantments?: MpEnchantmentSpec[];
}

/** A villager's offer. */
export interface MpTradeSpec {
  /** First cost. */
  costA?: MpTradeStackSpec;
  /** Second cost (never required). */
  costB?: MpTradeStackSpec;
  /** What it gives. */
  result?: MpTradeStackSpec;
}

/** A villager next to a trading interface. */
export interface MpVillagerSpec {
  /** Profession name. @default "none" */
  profession?: string;
  /** Villager level. @integer @default 1 */
  level?: number;
  /** Villager experience. @integer @default 0 */
  xp?: number;
  /** Offers. @default [] */
  offers?: MpTradeSpec[];
  /** Offer lists cycleTrades moves through, in order. @default [] */
  rerolls?: MpTradeSpec[][];
}

/** More Peripherals trading interface. */
export interface TradingInterfaceSpec {
  /** The villager; leave out for none. */
  villager?: MpVillagerSpec;
}

/** A mob spawner. */
export interface MpSpawnerSpec {
  /** Entity id it spawns. @default "minecraft:pig" */
  mob?: string;
}

/** More Peripherals spawner interface. */
export interface SpawnerInterfaceSpec {
  /** The spawner next to it: its mob id or the spawner; leave out for none. */
  spawner?: string | MpSpawnerSpec;
  /** How many spawners touch it. @integer @default 1 with a `spawner`, else 0 */
  spawners?: number;
}

/** A player card. */
export interface MpPlayerCardSpec {
  /** Bound player's name; omit for an unbound card. */
  owner?: string;
  /** Bound player's UUID. @default the owner's in `players` */
  uuid?: string;
}

/** More Peripherals player interface or ender chest interface (whose `dimension` defaults to the computer's). */
export interface PlayerCardInterfaceSpec {
  /** The card in it: the bound player's name, or the card; leave out for none. */
  card?: string | MpPlayerCardSpec;
}

/** A book or printout's text. */
export interface MpBookSpec {
  /** Title. */
  title?: string;
  /** Author. */
  author?: string;
  /** Copy generation: 0 original, 1 copy, 2 copy of a copy. @integer */
  generation?: number;
  /** Written book: pages as JSON text; book and quill: plain pages; printout: the page count. */
  pages?: string[] | number;
  /** Printout: its lines. */
  lines?: string[];
}

/** An item in the More Peripherals scanner. */
export interface MpScannerItemSpec extends ItemSpec {
  /** Book or printout contents. */
  book?: MpBookSpec;
}

/** More Peripherals scanner (getType "scanner"). */
export interface MpScannerSpec {
  /** The item in it; leave out for none. */
  item?: MpScannerItemSpec;
}

/** More Peripherals grinder. */
export interface GrinderSpec {
  /** The sword in it (an item tagged minecraft:swords, or with `sword: true`). */
  sword?: ItemSpec;
}

// ===== Classic Peripherals (rom-overlay/rom/ccsim/addons/classic-peripherals) =====

/** An NFC card cpNfcTap can use. */
export interface NfcCardSpec {
  /** Data on the card. @default "" */
  data?: string;
  /** Label. */
  label?: string;
  /** Read only. @default false */
  readOnly?: boolean;
  /** Private key, 32 bytes as a string. @default made on its first tap */
  privateKey?: string;
  /** The card has an item id (can hold a key) though it has no data. @default false */
  id?: boolean;
}

/** Something an RFID scanner sees. */
export interface RfidEntitySpec {
  /** What it is. */
  kind: "player" | "mob" | "item";
  /** X. @default 0 */
  x?: number;
  /** Y. @default 0 */
  y?: number;
  /** Z. @default 0 */
  z?: number;
  /** Dimension. @default "minecraft:overworld" */
  dimension?: string;
  /** Player: badge data in the inventory, in order. @default [] */
  inventory?: string[];
  /** Player: the worn badge's data. */
  equipped?: string;
  /** Mob or item: box width. @default 0.6 for a mob, 0.25 for an item */
  width?: number;
  /** Mob or item: box height. @default 1.8 for a mob, 0.25 for an item */
  height?: number;
  /** Mob: an injected badge's data. */
  injected?: string;
  /** Mob: held badges' data. @default [] */
  hands?: string[];
  /** Item: the dropped badge's data. */
  data?: string;
}

/** ClassicPeripheralsConfig overrides. */
export interface ClassicPeripheralsConfig {
  /** Tallest valid tower. @default 24 */
  radioTowerMaxHeight?: number;
  /** Shortest valid tower. @default 2 */
  radioTowerMinHeight?: number;
  /** Range per tower block. @default 128 */
  radioTowerSegmentRange?: number;
  /** Below this Y a tower's range shrinks (0.6.6 only). @default 96 */
  radioTowerMinY?: number;
  /** Share of the range past which bits are lost. @default 0.15 */
  radioTowerLossFactor?: number;
  /** Largest broadcast, bytes. @default 8388608 */
  radioTowerMaxMessageSize?: number;
  /** A mini antenna can broadcast. @default true */
  antennaCanBroadcast?: boolean;
  /** Largest NFC card data, bytes. @default 128 */
  nfcMaxDataSize?: number;
  /** RFID range, blocks. @default 8 */
  rfidScanRange?: number;
  /** Largest randomBytes (0.6.6). @default 65536 */
  cryptographicRandomBytesMaxSize?: number;
}

/** Classic Peripherals settings. */
export interface ClassicPeripheralsWorld {
  /** Seed of the random numbers (keys, random, randomBytes, radio corruption). @default the clock */
  seed?: number;
  /** A pocket computer: os.nfc, and nfc_data("internal", ...). @default false */
  pocket?: boolean;
  /** Card id to card, for cpNfcTap. @default {} */
  cards?: Record<string, NfcCardSpec>;
  /** What RFID scanners see. @default [] */
  entities?: RfidEntitySpec[];
  /** ClassicPeripheralsConfig overrides. */
  config?: ClassicPeripheralsConfig;
}

/** Classic Peripherals cryptographic accelerator. No fields. */
export interface CryptographicAcceleratorSpec {}

/** Classic Peripherals NFC reader. No fields: tap cards with cpNfcTap. */
export interface NfcReaderSpec {}

/** Classic Peripherals radio: a tower (x, y, z the base), mini antenna, or turtle or pocket radio. */
export interface RadioTowerSpec {
  /** What it is. @default "tower" */
  kind?: "tower" | "antenna" | "pocket" | "turtle";
  /** Tower height, base and head included. @integer @default 2 */
  height?: number;
  /** Tower: the head is on. @default true */
  complete?: boolean;
  /** false: a tower or antenna that is not built right. @default true */
  valid?: boolean;
  /** Frequency, 0-65535. @integer @default 0 */
  frequency?: number;
}

/** Classic Peripherals RFID scanner. */
export interface RfidScannerSpec {
  /** What it is. @default "block" */
  kind?: "block" | "pocket" | "turtle";
  /** Block: which way it faces (it scans from the block in front). @default "north" */
  facing?: Direction;
}

/** A printout line with its colours. */
export interface ClassicPrintoutLineSpec {
  /** Text, up to 25 characters. @default "" */
  text?: string;
  /** Colour characters, one per character. @default "f" for each */
  color?: string;
}

/** A printout, or another item, in a Classic Peripherals scanner. */
export interface ClassicPrintoutSpec {
  /** Item id; anything but a printed page, pages or book is not a printout. @default "computercraft:printed_page" */
  item?: string;
  /** Title. @default "" */
  title?: string;
  /** Page count. @integer @minimum 1 @default 1 */
  pages?: number;
  /** Lines of all pages, 21 a page: text, `{ text, color }`, or [text, color]. @default [] */
  lines?: (string | ClassicPrintoutLineSpec | string[])[];
}

/** Classic Peripherals scanner (getType "scanner"). */
export interface ClassicScannerSpec {
  /** The printout in it; leave out for none. */
  printout?: ClassicPrintoutSpec;
}

// ===== every type =====

/**
 * Peripheral type to the fields an entry of that type takes (beyond name, type and position). A type not listed is a
 * generic block (GenericStorageSpec).
 */
export interface PeripheralTypeMap {
  // CC:Tweaked and the engine
  "minecraft:chest": GenericStorageSpec;
  "minecraft:trapped_chest": GenericStorageSpec;
  "minecraft:barrel": GenericStorageSpec;
  "minecraft:hopper": GenericStorageSpec;
  "minecraft:dispenser": GenericStorageSpec;
  "minecraft:dropper": GenericStorageSpec;
  "minecraft:shulker_box": GenericStorageSpec;
  "minecraft:furnace": GenericStorageSpec;
  inventory: GenericStorageSpec;
  fluid_storage: GenericStorageSpec;
  energy_storage: GenericStorageSpec;
  speaker: SpeakerSpec;
  drive: DriveSpec;
  modem: ModemSpec;
  redstone_relay: RedstoneRelaySpec;
  // Advanced Peripherals
  playerDetector: PlayerDetectorSpec;
  chatBox: ChatBoxSpec;
  energyDetector: EnergyDetectorSpec;
  redstoneIntegrator: RedstoneIntegratorSpec;
  nbtStorage: NbtStorageSpec;
  environmentDetector: EnvironmentDetectorSpec;
  meBridge: MeBridgeSpec;
  rsBridge: RsBridgeSpec;
  arController: ArControllerSpec;
  geoScanner: GeoScannerSpec;
  blockReader: BlockReaderSpec;
  inventoryManager: InventoryManagerSpec;
  chunky: ChunkySpec;
  // Mekanism: QIO and the entangloporter (docs/mekanism-qio.md)
  qioDriveArray: QioBlockSpec;
  qioDashboard: QioBlockSpec;
  qioImporter: QioBlockSpec;
  qioExporter: QioBlockSpec;
  qioRedstoneAdapter: QioBlockSpec;
  quantumEntangloporter: EntangloporterSpec;
  // Mekanism: multiblocks
  boilerValve: BoilerValveSpec;
  inductionPort: InductionPortSpec;
  dynamicValve: MultiblockPeripheralSpec;
  thermalEvaporationController: ThermalEvaporationControllerSpec;
  thermalEvaporationValve: MultiblockPeripheralSpec;
  spsPort: SpsPortSpec;
  // Mekanism: machines
  enrichmentChamber: ElectricMachineSpec;
  crusher: ElectricMachineSpec;
  energizedSmelter: ElectricMachineSpec;
  metallurgicInfuser: MetallurgicInfuserSpec;
  electrolyticSeparator: ElectrolyticSeparatorSpec;
  precisionSawmill: RecipeMachineSpec;
  osmiumCompressor: RecipeMachineSpec;
  purificationChamber: RecipeMachineSpec;
  chemicalInjectionChamber: RecipeMachineSpec;
  combiner: RecipeMachineSpec;
  pressurizedReactionChamber: RecipeMachineSpec;
  chemicalCrystallizer: RecipeMachineSpec;
  chemicalDissolutionChamber: RecipeMachineSpec;
  chemicalInfuser: RecipeMachineSpec;
  chemicalOxidizer: RecipeMachineSpec;
  chemicalWasher: RecipeMachineSpec;
  rotaryCondensentrator: RotaryCondensentratorSpec;
  isotopicCentrifuge: RecipeMachineSpec;
  nutritionalLiquifier: RecipeMachineSpec;
  antiprotonicNucleosynthesizer: RecipeMachineSpec;
  pigmentExtractor: RecipeMachineSpec;
  pigmentMixer: RecipeMachineSpec;
  paintingMachine: RecipeMachineSpec;
  solarNeutronActivator: SolarNeutronActivatorSpec;
  digitalMiner: DigitalMinerSpec;
  electricPump: PumpSpec;
  fluidicPlenisher: PumpSpec;
  resistiveHeater: ResistiveHeaterSpec;
  fuelwoodHeater: FuelwoodHeaterSpec;
  seismicVibrator: SeismicVibratorSpec;
  laser: LaserSpec;
  laserAmplifier: LaserSpec;
  laserTractorBeam: LaserSpec;
  teleporter: TeleporterSpec;
  chargepad: ChargepadSpec;
  logisticalSorter: LogisticalSorterSpec;
  oredictionificator: OredictionificatorSpec;
  formulaicAssemblicator: FormulaicAssemblicatorSpec;
  modificationStation: ModificationStationSpec;
  dimensionalStabilizer: DimensionalStabilizerSpec;
  diversionTransporter: DiversionTransporterSpec;
  basicEnergyCube: EnergyCubeSpec;
  advancedEnergyCube: EnergyCubeSpec;
  eliteEnergyCube: EnergyCubeSpec;
  ultimateEnergyCube: EnergyCubeSpec;
  creativeEnergyCube: EnergyCubeSpec;
  basicFluidTank: FluidTankSpec;
  advancedFluidTank: FluidTankSpec;
  eliteFluidTank: FluidTankSpec;
  ultimateFluidTank: FluidTankSpec;
  creativeFluidTank: FluidTankSpec;
  basicChemicalTank: ChemicalTankSpec;
  advancedChemicalTank: ChemicalTankSpec;
  eliteChemicalTank: ChemicalTankSpec;
  ultimateChemicalTank: ChemicalTankSpec;
  creativeChemicalTank: ChemicalTankSpec;
  basicBin: BinSpec;
  advancedBin: BinSpec;
  eliteBin: BinSpec;
  ultimateBin: BinSpec;
  creativeBin: BinSpec;
  basicSmeltingFactory: FactorySpec;
  advancedSmeltingFactory: FactorySpec;
  eliteSmeltingFactory: FactorySpec;
  ultimateSmeltingFactory: FactorySpec;
  basicEnrichingFactory: FactorySpec;
  advancedEnrichingFactory: FactorySpec;
  eliteEnrichingFactory: FactorySpec;
  ultimateEnrichingFactory: FactorySpec;
  basicCrushingFactory: FactorySpec;
  advancedCrushingFactory: FactorySpec;
  eliteCrushingFactory: FactorySpec;
  ultimateCrushingFactory: FactorySpec;
  basicCompressingFactory: ChemicalFactorySpec;
  advancedCompressingFactory: ChemicalFactorySpec;
  eliteCompressingFactory: ChemicalFactorySpec;
  ultimateCompressingFactory: ChemicalFactorySpec;
  basicCombiningFactory: CombiningFactorySpec;
  advancedCombiningFactory: CombiningFactorySpec;
  eliteCombiningFactory: CombiningFactorySpec;
  ultimateCombiningFactory: CombiningFactorySpec;
  basicPurifyingFactory: ChemicalFactorySpec;
  advancedPurifyingFactory: ChemicalFactorySpec;
  elitePurifyingFactory: ChemicalFactorySpec;
  ultimatePurifyingFactory: ChemicalFactorySpec;
  basicInjectingFactory: ChemicalFactorySpec;
  advancedInjectingFactory: ChemicalFactorySpec;
  eliteInjectingFactory: ChemicalFactorySpec;
  ultimateInjectingFactory: ChemicalFactorySpec;
  basicInfusingFactory: InfusingFactorySpec;
  advancedInfusingFactory: InfusingFactorySpec;
  eliteInfusingFactory: InfusingFactorySpec;
  ultimateInfusingFactory: InfusingFactorySpec;
  basicSawingFactory: SawingFactorySpec;
  advancedSawingFactory: SawingFactorySpec;
  eliteSawingFactory: SawingFactorySpec;
  ultimateSawingFactory: SawingFactorySpec;
  basicUniversalCable: UniversalCableSpec;
  advancedUniversalCable: UniversalCableSpec;
  eliteUniversalCable: UniversalCableSpec;
  ultimateUniversalCable: UniversalCableSpec;
  basicMechanicalPipe: PipeSpec;
  advancedMechanicalPipe: PipeSpec;
  eliteMechanicalPipe: PipeSpec;
  ultimateMechanicalPipe: PipeSpec;
  basicPressurizedTube: PipeSpec;
  advancedPressurizedTube: PipeSpec;
  elitePressurizedTube: PipeSpec;
  ultimatePressurizedTube: PipeSpec;
  // Mekanism Generators
  fissionReactorLogicAdapter: FissionAdapterSpec;
  fissionReactorPort: FissionPortSpec;
  turbineValve: MultiblockPeripheralSpec;
  fusionReactorLogicAdapter: FusionAdapterSpec;
  fusionReactorPort: FusionPortSpec;
  solarGenerator: SolarGeneratorSpec;
  advancedSolarGenerator: SolarGeneratorSpec;
  windGenerator: WindGeneratorSpec;
  heatGenerator: HeatGeneratorSpec;
  bioGenerator: BioGeneratorSpec;
  gasBurningGenerator: GasBurningGeneratorSpec;
  // Create
  Create_DisplayLink: CreateDisplayLinkSpec;
  Create_Speedometer: CreateSpeedometerSpec;
  Create_Stressometer: CreateStressometerSpec;
  Create_RotationSpeedController: CreateRotationSpeedControllerSpec;
  Create_SequencedGearshift: CreateSequencedGearshiftSpec;
  Create_Station: CreateStationSpec;
  // Create Crafts & Additions (redstone_relay is above)
  electric_motor: ElectricMotorSpec;
  modular_accumulator: ModularAccumulatorSpec;
  portable_energy_interface: PortableEnergyInterfaceSpec;
  digital_adapter: DigitalAdapterSpec;
  // Tom's Peripherals
  tm_gpu: TmGpuSpec;
  tm_keyboard: TmKeyboardSpec;
  tm_rsPort: TmRsPortSpec;
  tm_wdt: TmWdtSpec;
  // Bigger Reactors and Extreme Reactors
  BiggerReactors_Reactor: BiggerReactorsReactorSpec;
  BiggerReactors_Turbine: BiggerReactorsTurbineSpec;
  "BigReactors-Reactor": ExtremeReactorsReactorSpec;
  "BigReactors-Turbine": ExtremeReactorsTurbineSpec;
  // UnlimitedPeripheralWorks
  universal_scanner: UniversalScannerSpec;
  ultimate_sensor: UltimateSensorSpec;
  item_pedestal: ItemPedestalSpec;
  display_pedestal: DisplayPedestalSpec;
  "minecraft:note_block": UpwNoteBlockSpec;
  "minecraft:jukebox": UpwJukeboxSpec;
  "minecraft:beacon": UpwBeaconSpec;
  "minecraft:lectern": UpwLecternSpec;
  // Some Peripherals
  sp_radar: SpRadarSpec;
  world_scanner: WorldScannerSpec;
  ballistic_accelerator: BallisticAcceleratorSpec;
  digitizer: DigitizerSpec;
  // SirEdvin's Cloud Solutions
  kv_storage: KvStorageSpec;
  crafka_broker: CloudSolutionsBlockSpec;
  statsd_bridge: StatsdBridgeSpec;
  // CC Shops
  shop: ShopSpec;
  // CC:C Bridge
  animatronic: AnimatronicSpec;
  redrouter: RedRouterSpec;
  scroller: ScrollerSpec;
  create_source: CreateSourceSpec;
  create_target: CreateTargetSpec;
  // Create: CC Total Logistics
  stockcheckingblock: StockCheckingBlockSpec;
  packageport: PackagePortSpec;
  redstonerequester: RedstoneRequesterSpec;
  clipboard: ClipboardSpec;
  // CC: LiftLink
  create_elevator: CreateElevatorSpec;
  droneworkbench: DroneWorkbenchSpec;
  cc_lectern: CcLecternSpec;
  hard_drive: CricketsHardDriveSpec;
  data_coprocessor: DataCoprocessorSpec;
  cassette_deck: CassetteDeckSpec;
  reel_to_reel: ReelToReelSpec;
  magnetic_card_reader: MagneticCardReaderSpec;
  card_writer: CardWriterSpec;
  embeddedcomputer: EmbeddedComputerBlockSpec;
  harddrive: EmbeddedHardDriveSpec;
  scanner: LakesScannerSpec;
  // SwitchCraft Peripherals
  "3d_printer": ScThreeDPrinterSpec;
  poster_printer: ScPrinterSpec;
  // CCX
  pcie: CcxPcieSpec;
  usb_port: CcxUsbPortSpec;
  // CC: DirectGPU
  directgpu: DirectGpuSpec;
  // Plethora Peripherals
  neuralInterface: NeuralInterfaceSpec;
  manipulator: ManipulatorSpec;
  redstone_integrator: PlethoraRedstoneIntegratorSpec;
  "plethora:scanner": PlethoraModuleUpgradeSpec;
  "plethora:sensor": PlethoraModuleUpgradeSpec;
  "plethora:introspection": PlethoraModuleUpgradeSpec;
  "plethora:laser": PlethoraModuleUpgradeSpec;
  // CC: Link
  link_armor: LinkArmorSpec;
  // Finer Peripherals
  "finerperipherals:chatbox": FinerPeripheralSpec;
  "finerperipherals:chatbox_pocket": FinerPeripheralSpec;
  "finerperipherals:chatbox_turtle": FinerPeripheralSpec;
  "finerperipherals:geoexplorer": FinerPeripheralSpec;
  "finerperipherals:geoexplorer_pocket": FinerPeripheralSpec;
  "finerperipherals:geoexplorer_turtle": FinerPeripheralSpec;
  "finerperipherals:player_finder": FinerPeripheralSpec;
  "finerperipherals:eventrelayer": FinerPeripheralSpec;
  "finerperipherals:eventrelayer_pocket": FinerPeripheralSpec;
  "finerperipherals:eventrelayer_turtle": FinerPeripheralSpec;
  "finerperipherals:holoitemdisplay": FinerHoloItemDisplaySpec;
  "finerperipherals:compass_turtle": FinerPeripheralSpec;
  "finerperipherals:enderchest_turtle": FinerPeripheralSpec;
  "finerperipherals:debug_pocket": FinerPeripheralSpec;
  // Ducky Peripherals
  entity_detector: EntityDetectorSpec;
  weather_machine: WeatherMachineSpec;
  keyboard: DuckyKeyboardSpec;
  sculkophone: SculkophoneSpec;
  // More Peripherals
  xp_collector: XpCollectorSpec;
  xp_bottler: MpBlockSpec;
  crafter: MpBlockSpec;
  loom_interface: MpBlockSpec;
  magnetic_card_manipulator: MagneticCardManipulatorSpec;
  beehive_interface: BeehiveInterfaceSpec;
  trading_interface: TradingInterfaceSpec;
  spawner_interface: SpawnerInterfaceSpec;
  player_interface: PlayerCardInterfaceSpec;
  ender_chest_interface: PlayerCardInterfaceSpec;
  "moreperipherals:scanner": MpScannerSpec;
  grinder: GrinderSpec;
  // Classic Peripherals
  cryptographic_accelerator: CryptographicAcceleratorSpec;
  radio_tower: RadioTowerSpec;
  nfc_reader: NfcReaderSpec;
  rfid_scanner: RfidScannerSpec;
  "classicperipherals:scanner": ClassicScannerSpec;
}
