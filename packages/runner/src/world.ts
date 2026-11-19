import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addonSource, checkWorldAddons, resolveAddons } from "./addons.js";
import {
  type ResolvedVersion,
  type VersionSpec,
  DEFAULT_MC,
  resolveVersion,
  versionForSim,
} from "./versions.js";
import { type MonitorSpec, luaString } from "./lua.js";
import { mobComputer } from "./mobs.js";
import { resolveWired, withResolvedModems } from "./wired.js";
import type {
  ApWorld,
  BiggerReactorsWorld,
  CreateAdditionsWorld,
  CreateWorld,
  ExtremeReactorsWorld,
  MekanismConfig,
  MekanismMultiblockSpec,
  RelativeSide,
  TomsPeripheralsWorld,
  PlethoraWorld,
  PlethoraPlayerFields,
  CcLinkWorld,
  FinerPeripheralsWorld,
  DuckyPeripheralsWorld,
  MorePeripheralsWorld,
  ClassicPeripheralsWorld,
  ScPeripheralsWorld,
  CricketsPeripheralsWorld,
  CcTechWorld,
  EmbeddedComputerWorld,
  LakesCcAdditionsWorld,
  AndroidSpec,
  AndroidConfig,
  CcDroneSpec,
  CcDronePlusSpec,
  AcDroneSpec,
  MobItemSpec,
  UpwWorld,
  MetaphysicsWorld,
  SomePeripheralsWorld,
  CloudSolutionsWorld,
  CcVsWorld,
  CcShopsWorld,
  ShopBlockSpec,
  CccBridgeWorld,
  CreateLogisticsWorld,
  LiftLinkWorld,
} from "./world-peripherals.js";

/** A simulated player on the fake server. */
export interface PlayerSpec extends PlethoraPlayerFields {
  /** Player name. @example "Alice" */
  name: string;
  /** Player UUID. Default 00000000-0000-4000-8000-<index as 12 hex digits>. */
  uuid?: string;
  /** Vault token balance (Dog's PlayerShops). */
  balance?: number;
  /** Offline players can still be hosts or have balances. Default true. */
  online?: boolean;
  /** Game mode; CC: Androids passes over a creative or spectator player. @default "survival" */
  gamemode?: "survival" | "creative" | "adventure" | "spectator";
  /** X coordinate. Default 0. */
  x?: number;
  /** Y coordinate. Default 64. */
  y?: number;
  /** Z coordinate. Default 0. */
  z?: number;
  /** Yaw, degrees. Default 0. */
  yaw?: number;
  /** Pitch, degrees. Default 0. */
  pitch?: number;
  /** Dimension the player is in. Default "minecraft:overworld". */
  dimension?: string;
  /** Health points. Default 20. */
  health?: number;
  /** Most health points. Default 20. */
  maxHealth?: number;
  /** Vault Hunters level, read by 2.2.36's ccvault.getPlayerVaultLevel. Omit for a player with no vault data. */
  vaultLevel?: number;
  /** What the player wears and holds, read by 2.2.36's ccvault.getPlayerEquipment. Items as in chests. */
  equipment?: EquipmentSpec;
  /**
   * 2.2.36: online on another server of the network. The economy knows them (balances, vault level), but this server
   * treats them as offline.
   */
  onOtherServer?: boolean;
  /**
   * 2.2.37: what the player's six combat slots score, read by ccvault.getPlayerGearPower. Vault Hunters' scorer is not
   * modelled: the world gives the slot scores and the emulator works out the rest as the game does.
   */
  gearPower?: GearPowerSpec;
  /** 2.2.37: the player's Temper and Dust, read by ccvault.getPlayerTemper (and Gear Power's multipliers). */
  temper?: TemperSpec;
  /** 2.2.37: reputation with each vault god, read by ccvault.getPlayerReputation. Each defaults to 0. */
  reputation?: {
    /** Reputation with Velara. */
    velara?: number;
    /** Reputation with Tenos. */
    tenos?: number;
    /** Reputation with Wendarr. */
    wendarr?: number;
    /** Reputation with Idona. */
    idona?: number;
  };
  /** 2.2.37: the player's greed tier. Default 0. @integer @minimum 0 */
  greedTier?: number;
  /**
   * 2.2.37: the player's skill trees, read by ccvault.getPlayerSkills (online, or from the saved profile). `false`:
   * Vault Hunters cannot read them ("skills not available").
   */
  skills?: SkillsSpec | false;
  /**
   * 2.2.37: the stat screen's numbers by attribute id, read by ccvault.getPlayerStats for a player on this server.
   * A number is the stat's value. `false`: "stats not available".
   */
  stats?: Record<string, number | StatSpec> | false;
}

/** One learned skill (2.2.37 getPlayerSkills). */
export interface SkillSpec {
  /** Vault Hunters' id of the skill. */
  id: string;
  /** What the skill screen shows. @default the id in title case */
  name?: string;
  /** Points the player put in. Only skills with more than 0 are listed. @default level */
  learned?: number;
  /** The level that works, gear bonuses included; only online. @default learned */
  level?: number;
  /** The most points the skill takes. @default learned (at least 1) */
  maxLevel?: number;
  /** Abilities: the chosen specialization's id. @default the ability's id */
  specialization?: string;
  /** Abilities: the specialization's name. @default the ability's name for index 0 */
  specializationName?: string;
  /** Abilities: the specialization's index, 0 for the plain ability. @default 0 */
  specializationIndex?: number;
  /** Abilities: on the player's ability key (only online). */
  selected?: boolean;
}

/** A player's skill trees (2.2.37). A tree set to `false` cannot be read and is left out of the answer. */
export interface SkillsSpec {
  /** Learned abilities, in the skill tree's order. */
  abilities?: SkillSpec[] | false;
  /** Learned talents. */
  talents?: SkillSpec[] | false;
  /** Learned expertises. */
  expertises?: SkillSpec[] | false;
  /** Learned prestige powers. */
  prestige?: SkillSpec[] | false;
  /** The id of the ability on the player's ability key (or `selected` on the ability). */
  selectedAbility?: string;
  /** Points spent per tree. @default the sum of `learned` in the tree */
  spentPoints?: {
    /** Ability points. */
    abilities?: number;
    /** Talent points. */
    talents?: number;
    /** Expertise points. */
    expertises?: number;
    /** Prestige points. */
    prestige?: number;
  };
}

/** One stat of the Vault Hunters stat screen (2.2.37 getPlayerStats). */
export interface StatSpec {
  /** The number; for a capped stat, the value before the cap when `uncapped` is not given. */
  value?: number;
  /** A capped stat's value before the cap; the answer's value is the smaller of it and the limit. */
  uncapped?: number;
  /** A capped stat's own cap. @default the stat's base cap, never above its max (getLimits statCaps) */
  limit?: number;
  /** The stat's name on the screen. @default the id in title case */
  name?: string;
  /** How the screen writes it. @default from the value: a percentage to one decimal place, else two */
  display?: string;
  /** The value is a fraction shown as a percentage. @default true for the capped stats */
  percent?: boolean;
  /** Listed only because the player has it from gear. */
  extra?: boolean;
}

/** Vault Hunters' word for a Gear Power slot. Only a COUNTED slot scores above 0. */
export type GearSlotStatus =
  | "COUNTED"
  | "EMPTY"
  | "NO_WEAPON"
  | "NOT_VAULT_GEAR"
  | "NOT_COMBAT_GEAR"
  | "INERT"
  | "GREED_TIER_LOCKED"
  | "NO_TIER_CONFIG";

/** What Vault Hunters says about one Gear Power slot (2.2.37 slotDetails). The score comes from `slots`. */
export interface GearSlotDetailSpec {
  /** Default COUNTED for a score above 0, otherwise EMPTY (NO_WEAPON for the weapon slot). */
  status?: GearSlotStatus;
  /** Registry name of the item in the slot. Default: the piece in the player's `equipment` (never for the weapon). */
  item?: string;
  /** Display name of the item in the slot. Default: that of the piece in `equipment`. */
  name?: string;
  /** Weapon only: which hotbar slot holds the weapon that counts. @integer @minimum 1 @maximum 9 */
  hotbarSlot?: number;
  /** Weapon only: how many weapons were on the hotbar to choose from. @integer @minimum 0 */
  hotbarWeapons?: number;
}

/** A player's Gear Power as the world gives it (2.2.37). Gear Score, Gear Power and temper are derived. */
export interface GearPowerSpec {
  /** Slot scores, 0 to 1500 each; a slot left out scores 0. `weapon` is the best weapon on the hotbar. */
  slots?: {
    /** Helmet slot score. @minimum 0 @maximum 1500 */
    head?: number;
    /** Chestplate slot score. @minimum 0 @maximum 1500 */
    chest?: number;
    /** Leggings slot score. @minimum 0 @maximum 1500 */
    legs?: number;
    /** Boots slot score. @minimum 0 @maximum 1500 */
    feet?: number;
    /** Score of the best weapon on the hotbar. @minimum 0 @maximum 1500 */
    weapon?: number;
    /** Offhand slot score. @minimum 0 @maximum 1500 */
    offhand?: number;
  };
  /**
   * Per slot, why it scores what it does. `false`: Vault Hunters could not explain the slots, so getPlayerGearPower
   * leaves slotDetails out.
   */
  slotDetails?:
    | false
    | {
        /** Helmet slot. */
        head?: GearSlotDetailSpec;
        /** Chestplate slot. */
        chest?: GearSlotDetailSpec;
        /** Leggings slot. */
        legs?: GearSlotDetailSpec;
        /** Boots slot. */
        feet?: GearSlotDetailSpec;
        /** The best weapon on the hotbar. */
        weapon?: GearSlotDetailSpec;
        /** Offhand slot. */
        offhand?: GearSlotDetailSpec;
      };
  /** The highest Gear Power the player ever reached (peakGearPower). Default 0; the emulator never raises it. @integer @minimum 0 */
  peak?: number;
}

/** One Temper category (2.2.37). The ladder from levels to multipliers is Vault Hunters' own: the world gives both. */
export interface TemperCategorySpec {
  /** Levels bought. Default 0. @integer @minimum 0 @maximum 400 */
  level?: number;
  /** What the category multiplies Gear Power by. Default 1 at level 0; above that it is left out unless given. */
  multiplier?: number;
  /** What the category multiplies its effect by inside a vault. Default 1 at level 0; above that left out unless given. */
  power?: number;
}

/** A player's Temper (2.2.37). */
export interface TemperSpec {
  /** Dust in hand. Default 0. @integer @minimum 0 */
  dust?: number;
  /** Might. The better of Might and Magic counts for Gear Power. */
  might?: TemperCategorySpec;
  /** Magic. */
  magic?: TemperCategorySpec;
  /** Vigor: averaged with the better of Might and Magic. */
  vigor?: TemperCategorySpec;
  /** Has a multiplier too, but does not count for Gear Power. */
  tool?: TemperCategorySpec;
  /** Band bosses beaten (online players only). Default 0. @integer @minimum 0 */
  bossesBeaten?: number;
  /** The furthest trial room reached. Default 0. @integer @minimum 0 */
  trialsRecord?: number;
  /** Altar favors taken (online players only). Default 0. @integer @minimum 0 */
  favorsUsed?: number;
}

/** Worn and held items. `curios` is slot type (as Curios names it, e.g. "ring") to index (from 1) to item. */
export interface EquipmentSpec {
  /** Helmet slot. */
  head?: ItemSpec;
  /** Chestplate slot. */
  chest?: ItemSpec;
  /** Leggings slot. */
  legs?: ItemSpec;
  /** Boots slot. */
  feet?: ItemSpec;
  /** Held in the main hand. */
  mainhand?: ItemSpec;
  /** Held in the offhand. */
  offhand?: ItemSpec;
  /** Curios slot type (e.g. "ring") to index (from 1) to item. */
  curios?: Record<string, Record<string, ItemSpec>>;
  /**
   * 2.2.37: hotbar slot (1-9) to item. Given, the held slot's item is `mainhand` in getPlayerEquipment. Default: the
   * held slot holds `mainhand`.
   */
  hotbar?: Record<string, ItemSpec>;
  /** 2.2.37: the hotbar slot the player holds, 1 to 9. @default 1 */
  selectedHotbarSlot?: number;
  /**
   * 2.2.37: the hotbar slot of the weapon Gear Power counts, overriding the emulator's pick (the best Gear Score among
   * identified main-hand gear on the hotbar, the held slot first on a tie).
   */
  weaponHotbarSlot?: number;
}

/** Item stack in a virtual inventory; extra fields (vaultData, nbt, ...) are passed to getItemDetail. */
export interface ItemSpec {
  /** Item id. @example "minecraft:iron_ingot" */
  name: string;
  /** Stack size. @integer @minimum 1 */
  count: number;
  /** The item's NBT: stacks merge only when name and nbt are equal; list() reports it. */
  nbt?: unknown;
  /** Stack limit in a slot. @default 64 */
  maxCount?: number;
  /** getItemDetail's display name. @default the registry name in title case */
  displayName?: string;
  /**
   * vhcctweaks 2.2.37, a container item (a Sophisticated backpack, a shulker box, a vault barrel, or any item with
   * `itemHandler`): inner slot (1-based) to item. Absent: empty (a backpack nobody opened). Not in getItemDetail.
   */
  contents?: Record<string, ItemSpec>;
  /** 2.2.37: the container's slot count. @default backpacks by tier (27, 54, 81, 108, 120), shulker boxes 27, the wooden vault barrel 36, other vault barrels 45 */
  containerSlots?: number;
  /** 2.2.37: another mod's bag with a Forge item handler: a container like a backpack (its nbt stays when its contents change). */
  itemHandler?: boolean;
  /** 2.2.37: a backpack's filter upgrade: only `allow` (when given) and never `deny` item ids may leave. A refused inner move moves 0 with no reason. */
  outputFilter?: {
    /** Item ids that may leave; when given, nothing else may. */
    allow?: string[];
    /** Item ids that may never leave. */
    deny?: string[];
  };
  /** 2.2.37: a shulker box's other BlockEntityTag keys: it keeps a tag (an nbt hash) once emptied. */
  blockEntityTag?: Record<string, unknown>;
  /** 2.2.37 identify: the vaultData the piece has once identified. Default: a seeded, plausible roll that keeps the level and rarity rules. */
  identifiesTo?: Record<string, unknown>;
  /** 2.2.37 identify: false is an item Vault Hunters cannot identify even with a vaultData state. */
  identifiable?: boolean;
  /** Any other field reaches getItemDetail as it is. */
  [extra: string]: unknown;
}

/** Chunk coordinates (block coordinate / 16, rounded down): one chunk, or the box between two corners. */
export type ChunkRange =
  | [number, number]
  | {
      /** One corner, [cx, cz]. */
      from: [number, number];
      /** The other corner, [cx, cz]. Default: `from`. */
      to?: [number, number];
    };

/** A turtle (CC:Tweaked 1.101.3). Its position is `x/y/z/dimension` here or the world's `position`. */
export interface TurtleSpec {
  /** X coordinate. Default: the world's position. */
  x?: number;
  /** Y coordinate. Default: the world's position. */
  y?: number;
  /** Z coordinate. Default: the world's position. */
  z?: number;
  /** Dimension. Default: the world's position. */
  dimension?: string;
  /** Which way it faces. @default "north" */
  facing?: "north" | "south" | "east" | "west";
  /** Advanced turtle: colour screen, 100000 fuel limit. */
  advanced?: boolean;
  /** Fuel level at the start. @default 0 */
  fuel?: number;
  /** Selected slot, 1-16. @default 1 @integer @minimum 1 @maximum 16 */
  selected?: number;
  /** Slot (1-16) to item. */
  inventory?: Record<string, ItemSpec>;
  /** Left upgrade item id: "minecraft:diamond_pickaxe", "computercraft:wireless_modem_normal", "minecraft:crafting_table", ... */
  left?: string;
  /** Right upgrade item id, as `left`. */
  right?: string;
}

/**
 * A block in a turtle's world. `state` holds its block state properties (strings, as in F3). Containers take
 * `items` (slot to item) and `size`; any block can carry `peripheral`, a virtual peripheral (as in `peripherals`,
 * without a name) that a turtle next to it sees on that side.
 */
export interface BlockSpec {
  /** X coordinate. */
  x: number;
  /** Y coordinate. */
  y: number;
  /** Z coordinate. */
  z: number;
  /** Block id; omit or "minecraft:air" for air (to cut a hole in a fill). @example "minecraft:stone" */
  name?: string;
  /** Block state properties, as strings (as F3 shows them). @example {"facing":"north"} */
  state?: Record<string, string>;
  /** Containers: slot (1-based) to item. */
  items?: Record<string, ItemSpec>;
  /** Containers: number of slots. */
  size?: number;
  /** A virtual peripheral (as in `peripherals`, without a name) that a turtle next to it sees on that side. */
  peripheral?: Omit<VirtualPeripheralSpec, "name">;
  /** The block entity's NBT, as JSON. */
  blockEntity?: Record<string, unknown>;
  /** Plethora: hardness for the scanner and laser (wins over gameData.hardness and vanilla's). */
  hardness?: number;
  /** CC: Link and Finer Peripherals scanners: the block's tags as reported ("minecraft:block/logs"). @default the game data's */
  tags?: string[];
  /** Metaphysics: explosion resistance (wins over metaphysics.explosionResistance). */
  explosionResistance?: number;
  /** Metaphysics: getBlockIsSolid's answer. @default the game data's collision rule */
  solid?: boolean;
  /** CC Shops: a simpleshops:simple_shop or simpleshops:creative_simple_shop block's contents (creative comes from the block name). */
  shop?: ShopBlockSpec;
}

/** Peripherals implemented in Lua by the sim: inventories, playerDetector, chatBox. */
export interface VirtualPeripheralSpec {
  /** Peripheral name: a side of the computer or a network name. */
  name: string;
  /**
   * Inventories ("minecraft:chest", "minecraft:barrel", ...), "fluid_storage" tanks, "speaker"
   * (what it plays is listed in the sim state; `craftos-mcp window` plays it out loud), or an Advanced Peripherals type:
   * playerDetector, chatBox, energyDetector, redstoneIntegrator, nbtStorage, environmentDetector,
   * meBridge, rsBridge, arController; or a Mekanism QIO block (see QioBlockSpec): qioDriveArray,
   * qioDashboard, qioImporter, qioExporter, qioRedstoneAdapter; or "quantumEntangloporter" (EntangloporterSpec).
   */
  type: string;
  /** Inventories: number of slots. */
  size?: number;
  /**
   * Inventories: slot (1-based) -> item. Storage bridges: a list of stacks
   * `{ name, amount, displayName?, nbt?, tags?, craftable? }`.
   */
  items?: Record<string, ItemSpec> | Record<string, unknown>[];
  /**
   * vhcctweaks 2.2.37: `false` is an inventory that does not let its slots be set or hands out copies: pushContents,
   * inner moves and identify give "can't change items in this inventory"; listContents still works. Default true.
   */
  canChangeItems?: boolean;
  /** X coordinate of the block. */
  x?: number;
  /** Y coordinate of the block. */
  y?: number;
  /** Z coordinate of the block. */
  z?: number;
  /** Dimension of the block. */
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
  /** Item id. */
  name: string;
  /** How many. @default 1 */
  count?: number;
  /** The item's full NBT: a JSON object or an SNBT string with types. */
  nbt?: Record<string, unknown> | string;
  /** The `nbt` hash a chest's list() shows for this item (default: a hash of the NBT, not the real one). */
  nbtHash?: string;
  /** Stack limit. @default 64 */
  maxCount?: number;
  /** Item tags without "#", e.g. "forge:ingots/iron". */
  tags?: string[];
  /** Mod id for mod id filters (default: the name's namespace). */
  modId?: string;
  /** Other fields (displayName, ...) travel with the item into chests. */
  [extra: string]: unknown;
}

/** A QIO drive: tier base (16,000 items, 128 types), hyper_dense, time_dilating or supermassive. */
export interface QioDriveSpec {
  /** 0-11; default the position in the list. @integer @minimum 0 @maximum 11 */
  slot?: number;
  /** Drive tier. @default "base" */
  tier?: "base" | "hyper_dense" | "time_dilating" | "supermassive";
  /** What the drive holds. */
  items?: QioItemSpec[];
}

/** A QIO filter, as the computer methods take and return it. */
export interface QioFilterSpec {
  /** Filter kind. */
  type: "QIO_ITEMSTACK_FILTER" | "QIO_TAG_FILTER" | "QIO_MODID_FILTER";
  /** Item stack filters: the item id. */
  item?: string;
  /** Item stack filters: the item's NBT (JSON or SNBT). */
  itemNBT?: Record<string, unknown> | string;
  /** Item stack filters: ignore NBT. */
  fuzzy?: boolean;
  /** Tag filters: the tag. */
  tag?: string;
  /** Mod id filters: the mod id. */
  modId?: string;
}

/**
 * A QIO block: as a `peripherals` entry (type qioDriveArray, qioDashboard, qioImporter, qioExporter,
 * qioRedstoneAdapter) the computer sees it; in `mekanism.qio.blocks` (with `id`) it only takes part.
 */
export interface QioBlockSpec {
  /** Peripheral name, for a `peripherals` entry. */
  name?: string;
  /** Id of a block in `mekanism.qio.blocks`, which no computer sees. */
  id?: string;
  /** qioDriveArray, qioDashboard, qioImporter, qioExporter or qioRedstoneAdapter. */
  type: string;
  /** Frequency name (public), or `{ name, public: false }`. A name nobody declared is created, public. */
  frequency?:
    | string
    | {
        /** Frequency name. */
        name: string;
        /** Public frequency. @default true */
        public?: boolean;
      };
  /** Player name or UUID. Without an owner, setFrequency and createFrequency do nothing. */
  owner?: string;
  /** Security mode. @default "PUBLIC" */
  securityMode?: "PUBLIC" | "PRIVATE" | "TRUSTED";
  /** Which way the block faces (NORTH, SOUTH, ...). */
  facing?: string;
  /** Drive array: its drives, as a list or slot ("0".."11") to drive. */
  drives?: QioDriveSpec[] | Record<string, QioDriveSpec>;
  /** Importer/exporter: the inventory behind it, by name (a peripheral or a `mekanism.qio.inventories` entry). */
  target?: string;
  /** Importer/exporter filters. */
  filters?: QioFilterSpec[];
  /** Importer: import items no filter matches. */
  importWithoutFilter?: boolean;
  /** Exporter: export items without a filter. */
  exportWithoutFilter?: boolean;
  /** Redstone control. @default "DISABLED" */
  redstoneMode?: "DISABLED" | "HIGH" | "LOW" | "PULSE";
  /** Redstone signal at the start. @default false */
  powered?: boolean;
  /** Speed upgrades, 0-8. @integer @minimum 0 @maximum 8 */
  speedUpgrades?: number;
  /** Ticks until the machine next acts (default 0: on the first tick). */
  delay?: number;
  /** Dashboard: up to 3 crafting windows, `inputs` 9 slots (array or "0".."8"), `output`. */
  crafting?: {
    /** The 9 grid slots, as a list or "0".."8" to item. */
    inputs?: QioItemSpec[] | Record<string, QioItemSpec>;
    /** The output slot. */
    output?: QioItemSpec;
  }[];
  /** Redstone adapter: the item it watches. */
  targetItem?: string | QioItemSpec;
  /** Redstone adapter: the count that turns the signal on. */
  triggerAmount?: number;
  /** Other block fields, passed to the sim as they are. */
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
  multiblocks?: Record<string, MekanismMultiblockSpec>;
  /** Mekanism and Mekanism Generators config values the multiblocks use (docs/mekanism-multiblocks.md). */
  config?: MekanismConfig;
  /** Overworld day time for solar generators, 0 sunrise, 6000 noon. @default 6000 */
  dayTime?: number;
  /** Whether the day time moves on. @default true */
  daylightCycle?: boolean;
  /** Whether it rains (solar and wind generators). @default false */
  raining?: boolean;
  /** Whether it thunders (only while raining). @default false */
  thundering?: boolean;
  /** Public teleporter frequencies: a name, or `{ name, color }` (color default PURPLE). */
  teleporterFrequencies?: (
    | string
    | {
        /** Frequency name. */
        name: string;
        /** Frequency colour, e.g. "PURPLE". */
        color?: string;
      }
  )[];
  /** The QIO system: frequencies, blocks no computer sees, and the inventories they touch. */
  qio?: {
    /** QIO frequencies. */
    frequencies?: {
      /** Frequency name. */
      name: string;
      /** Public frequency. @default true */
      public?: boolean;
      /** Owner of a private frequency. */
      owner?: string;
      /** Frequency colour. */
      color?: string;
    }[];
    /** QIO blocks no computer sees (with `id`). */
    blocks?: QioBlockSpec[];
    /** Inventories only QIO blocks touch: `{ name, type, size, items }` like a chest peripheral. */
    inventories?: VirtualPeripheralSpec[];
  };
  /** Quantum Entangloporters. Buffers default to the server's general.toml. */
  entangloporter?: {
    /** Energy buffer per frequency, J. */
    energyBuffer?: number;
    /** Fluid buffer per frequency, mB. */
    fluidBuffer?: number;
    /** Chemical buffer per frequency, mB. */
    chemicalBuffer?: number;
    /** Inventory frequencies and what they hold. */
    frequencies?: EntangloporterFrequencySpec[];
    /** Entangloporters the computer cannot see (with `id`). */
    blocks?: EntangloporterSpec[];
  };
}

/** A fluid or chemical held by a frequency. */
export interface EntangloporterStack {
  /** Fluid or chemical id. */
  name: string;
  /** Millibuckets. */
  amount: number;
}

/** An inventory frequency: the buffers every entangloporter on it shares. Private ones belong to `owner`. */
export interface EntangloporterFrequencySpec {
  /** Frequency name. */
  name: string;
  /** Public frequency. @default true */
  public?: boolean;
  /** Owner of a private frequency. */
  owner?: string;
  /** The one item slot (one stack, full NBT kept). */
  item?: QioItemSpec;
  /** Fluid buffer. */
  fluid?: {
    /** Fluid id. */
    name: string;
    /** Millibuckets. */
    amount: number;
    /** The fluid's NBT. */
    nbt?: Record<string, unknown>;
  };
  /** Gas buffer. */
  gas?: EntangloporterStack;
  /** Infuse type buffer. */
  infuseType?: EntangloporterStack;
  /** Pigment buffer. */
  pigment?: EntangloporterStack;
  /** Slurry buffer. */
  slurry?: EntangloporterStack;
  /** Joules. */
  energy?: number;
  /** Kelvin, default 300. */
  temperature?: number;
}

/** A Quantum Entangloporter: a `peripherals` entry of type "quantumEntangloporter", or in `entangloporter.blocks`. */
export interface EntangloporterSpec {
  /** Peripheral name, for a `peripherals` entry. */
  name?: string;
  /** Id of an entangloporter no computer sees. */
  id?: string;
  /** Peripheral type. */
  type?: "quantumEntangloporter";
  /** Player name or UUID. */
  owner?: string;
  /** Security mode. @default "PUBLIC" */
  securityMode?: "PUBLIC" | "PRIVATE" | "TRUSTED";
  /** NORTH (default), SOUTH, EAST, WEST, UP, DOWN. */
  facing?: string;
  /** Frequency name (public), or `{ name, public: false }`. */
  frequency?:
    | string
    | {
        /** Frequency name. */
        name: string;
        /** Public frequency. @default true */
        public?: boolean;
      };
  /** Neighbouring inventories by direction (north, up, ...) or side (front, left, ...). */
  adjacent?: Record<string, string>;
  /** Side config per transmission type, e.g. `{ ITEM: { ejecting: true, sides: { FRONT: "OUTPUT" } } }`. */
  config?: Record<
    string,
    {
      /** Eject on output sides. */
      ejecting?: boolean;
      /** Side (FRONT, LEFT, ...) to mode (INPUT, OUTPUT, NONE, ...). */
      sides?: Record<string, string>;
    }
  >;
  /** Auto-eject settings. */
  ejector?: {
    /** Strict input. */
    strictInput?: boolean;
    /** Output colour. */
    outputColor?: string;
    /** Side to input colour. */
    inputColors?: Record<string, string>;
  };
  /** false: its chunk is not loaded, so it does not tick. Default true. */
  loaded?: boolean;
  /** Has an anchor upgrade (keeps its chunk loaded). */
  anchorUpgrade?: boolean;
  /** Ticks between transfers. */
  tickDelay?: number;
  /** Share of each transfer lost. */
  transferLoss?: number;
  /** Heat lost to the environment. */
  environmentalLoss?: number;
  /** Other block fields, passed to the sim as they are. */
  [extra: string]: unknown;
}

/** Peripherals the engine itself emulates. Monitors use the `monitors` parameter. */
export interface EnginePeripheralSpec {
  /** Peripheral name. */
  name: string;
  /** Engine peripheral type. */
  type: "drive";
  /**
   * A floppy disk in the drive from the start, by its id: the computer finds it mounted at /disk, as after a boot
   * with a disk in. Its files are `disks[id]` (empty without one) and live in computer/disk/<id>.
   */
  disk?: number;
}

/** A block in the world. Without `dimension`: the overworld, or for a modem's block its computer's. */
export interface BlockPos {
  /** X coordinate. */
  x: number;
  /** Y coordinate. */
  y: number;
  /** Z coordinate. */
  z: number;
  /** Dimension. */
  dimension?: string;
}

/** Where a computer stands. Its modems report this position, as real modems report the block they sit on. */
export interface ComputerPosition {
  /** X coordinate. @default 0 */
  x?: number;
  /** Y coordinate. @default 64 */
  y?: number;
  /** Z coordinate. @default 0 */
  z?: number;
  /** Dimension. @default "minecraft:overworld" */
  dimension?: string;
}

/**
 * A modem, emulated in Lua (ccsim/modem.lua). Plain `{ name, type: "modem" }` is a normal wireless modem.
 * Wired modems link up through `network`, or through `block` and a network's cables (see `WiredNetworkSpec`).
 */
export interface ModemSpec {
  /** The side the modem is on ("top", "back", ...). */
  name: RelativeSide | (string & {});
  /** Peripheral type. */
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
   * The Minecraft version the computer is on (versions.ts): "1.18.2" (CC:Tweaked 1.101.3), "1.20.1" or "1.21.1"
   * (CC:Tweaked 1.121.0), or { mc, cc?, loader? }. Default: the CRAFTOS_VERSION environment variable, else 1.18.2.
   * It picks the ROM, the engine's CC:Tweaked behaviour and the mod versions; an addon with no release for that
   * Minecraft cannot be switched on.
   */
  version?: VersionSpec;
  /**
   * Give the computer the emulator's `sim` shell program, so a person can change the world by typing (`sim join
   * Alice`). Not CC:Tweaked's, so off unless a person drives the computer (`craftos-mcp window` and `app` turn it on).
   */
  simProgram?: boolean;
  /**
   * Give programs CraftOS-PC's `periphemu`, `config` and `mounter` APIs, for code written for CraftOS-PC. CC:Tweaked
   * has none of them, so they are off by default. When on they act as the game would: periphemu.create places the
   * block in this world, live; config and mounter answer but change nothing (docs/coming-from-craftos-pc.md).
   */
  craftosPcApis?: boolean;
  /**
   * Show the ROM's message of the day (the random tip under "CraftOS 1.8") at boot. Default false here, so captured
   * screens are the same every run; CC:Tweaked's own default is true (docs/conformance/emulator-vs-real-deviations.md).
   */
  motd?: boolean;
  /** Players on the simulated server: who player detectors, chat boxes and inventory managers see. */
  players?: PlayerSpec[];
  /** Computer owner ("host" in ccvault). Omit for an unowned computer. */
  host?: string;
  /** Player currently using the computer ("player" in ccvault). */
  interacting?: string;
  /** Approve ccvault.requestAuth() immediately, as if the player clicked [APPROVE]. */
  autoApprove?: boolean;
  /** false simulates Dog's PlayerShops being absent. */
  economyAvailable?: boolean;
  /** The computer's id (os.getComputerID). Give each computer on a network its own. @default 0 @integer @minimum 0 */
  computerId?: number;
  /**
   * "pocket" computers do not claim ownership on first interaction and get the pocket
   * computer's 26x20 terminal unless `terminal` says otherwise.
   */
  kind?: "block" | "pocket";
  /**
   * Keep the interaction fresh as if the player kept the computer's GUI open. Default
   * true for pocket computers; block computers expire after 30 s without a click.
   */
  holdInteraction?: boolean;
  /** false: a normal computer or pocket computer, with no colour (default advanced). Turtles use `turtle.advanced`. */
  advanced?: boolean;
  /** Terminal size in characters (default 51x19, or 26x20 for pocket computers). */
  terminal?: {
    /** Width in characters. @integer @minimum 1 @maximum 255 */
    width: number;
    /** Height in characters. @integer @minimum 1 @maximum 255 */
    height: number;
  };
  /** Overrides of the vhcctweaks server config. */
  config?: {
    /** ccvault nonce lifetime, seconds. */
    nonceExpirySeconds?: number;
    /** ccvault approval idle timeout, minutes. */
    authIdleTimeoutMinutes?: number;
    /** Largest ccvault transfer. */
    maxTransferAmount?: number;
    /** Seconds before an interaction goes stale. */
    interactionStaleSeconds?: number;
    /** Most ccvault history results. */
    maxHistoryResults?: number;
    /** computercraft-server.toml modem_range: wireless range low down. @default 64 */
    modemRange?: number;
    /** modem_high_altitude_range: wireless range at the top of the world. @default 384 */
    modemHighAltitudeRange?: number;
    /** modem_range_during_storm. @default 64 */
    modemRangeDuringStorm?: number;
    /** modem_high_altitude_range_during_storm. @default 384 */
    modemHighAltitudeRangeDuringStorm?: number;
    /** Height of the world for the high altitude range. Default 320 (256 in the nether and the end). */
    modemWorldTop?: number;
    /** vhcctweaks 2.2.36: links.maxLinksPerComputer, default 64. */
    maxLinksPerComputer?: number;
    /** inventory.maxBatchMoves, default 256. */
    maxBatchMoves?: number;
    /** inventory.batchTimeBudgetMicros, default 2000. */
    batchTimeBudgetMicros?: number;
    /** inventory.maxWatchesPerComputer, default 64. */
    maxWatchesPerComputer?: number;
    /** ccvault.maxAllowanceMinutes, default 240. */
    maxAllowanceMinutes?: number;
    /**
     * Emulator only: what one moveMany move costs against batchTimeBudgetMicros, default 10. The batch stops after
     * the move that takes it past the budget, so cost 1000 and budget 2000 stop every batch after 3 moves.
     */
    batchMoveCostMicros?: number;
    /** vhcctweaks 2.2.37: vaultDetails.gearScore, default true. false: identified gear gets no Gear Score fields. */
    gearScore?: boolean;
    /** vhcctweaks 2.2.37: vaultDetails.gearScoreLines, default true. false: modifiers get no score fields. */
    gearScoreLines?: boolean;
    /**
     * vhcctweaks 2.2.37: inventory.containerItems, default true. false: listContents, pushContents, inner moves and
     * identify with an inner slot give "container items are turned off".
     */
    containerItems?: boolean;
    /** vhcctweaks 2.2.37: inventory.identify, default true. false: identify gives "identify is turned off". */
    identify?: boolean;
    /** vhcctweaks 2.2.37: vhccFiles.maxBytesPerComputer, what vhcc.getUsage reports as the limit. Default 16777216. */
    maxBytesPerComputer?: number;
    /**
     * Emulator only (2.2.37): Vault Hunters' own gear_power.json minLevel, the vault level Gear Power starts at.
     * Default 100.
     */
    gearPowerMinLevel?: number;
  };
  /**
   * Which vhcctweaks (github.com/Akkiruk/vhcctweaks, a Vault Hunters server mod for Minecraft 1.18.2 only) the
   * server runs: an opt-in addon. Default off (`false`), or "2.2.36" when world.addons, craftos.json's addons or
   * CRAFTOS_ADDONS name `vhcctweaks` ("all" leaves it out). "2.2.36": linked ender modems, listDetailed/moveMany,
   * inventory watches, spending allowances, money calls on the economy thread and the rest (docs/vhcctweaks.md).
   * "2.2.35" opts out, for comparisons with measurements made before 2.2.36; such a computer takes no part in links.
   * "2.2.37" is 2.2.36 plus the 2.2.37 API as the emulator models it from the mod's spec: getPlayerGearPower/getPlayerTemper/getPlayerReputation,
   * getPlayerSkills/getPlayerStats, the hotbar and counted weapon in getPlayerEquipment, getLimits (statCaps too), vhcc.getUsage, moveMany's expectName and the Gear Score fields in item details, and on every inventory
   * listContents/pushContents/moveMany `inner` (backpacks, shulker boxes and vault barrels in a slot) and identify.
   * `false`: no vhcctweaks at all, as does a ROM without /rom/ccsim/vhcc.lua. The server is plain CC:Tweaked 1.101.3,
   * Advanced Peripherals 0.7.31r and Mekanism on their own defaults: no ccvault, vhcc or lockdown, a plain ender modem,
   * AP's hidden "$" chat channel, working sendFormatted* chat box methods, a 100 ms chat cooldown and real isSlimeChunk.
   */
  vhcctweaks?: "2.2.35" | "2.2.36" | "2.2.37" | false;
  /**
   * What a call to a vhcctweaks-linked computer's monitor (or any of its peripherals' computer-thread methods) costs,
   * in ms of game time, as in game (about 30 ms). "fast" (or 0) answers at once. Inventory methods wait for the server
   * tick either way. Default CRAFTOS_LINK_LATENCY, else 30.
   */
  linkLatency?: number | "fast";
  /**
   * 2.2.37: whether the server's Vault Hunters has Gear Power and Temper (3.21.74 or newer). Default true. `false` is
   * an older one: getPlayerGearPower and getPlayerTemper answer "gear power not available" and "temper not available"
   * for a player on this server, a saved Temper has no multipliers, and gear gets no Gear Score fields.
   */
  gearPowerAvailable?: boolean;
  /**
   * 2.2.37, emulator only: `false` is a server whose Vault Hunters cannot identify from a computer, so an inventory's
   * identify gives "identify not available" once every other check passed. Default true.
   */
  identifyAvailable?: boolean;
  /**
   * 2.2.36: server ticks the economy thread takes per money call (transfer, getPlayerBalance, getBalance of someone not
   * online here). Default 0: the answer comes at the next timer. Raise it to hold calls open in a test.
   */
  economyDelayTicks?: number;
  /** 2.2.36 tests: ccvault function name -> how many calls answer `nil, "internal error"` (-1: every call). */
  internalErrors?: Record<string, number>;
  /** Where the computer stands. Default x 0, y 64, z 0 in the overworld. */
  position?: ComputerPosition;
  /**
   * Run Lua this many times slower than native, as CC:Tweaked's Cobalt VM does (about 8x: a 2,000,000-step loop
   * takes about 90 ms on the server against 12 ms here). `true` is 8, `false` or 1 runs at native speed.
   * Default: see DEFAULT_COBALT_SPEED in engine.ts.
   */
  cobaltSpeed?: number | boolean;
  /** The computer's label: os.getComputerLabel, and what another computer's `computer_N` peripheral answers to getLabel. */
  label?: string;
  /** Set by the runner on a computer whose modems reach other computers through a relay. */
  modemLink?: boolean;
  /**
   * Assemble the computer from workspace subfolders instead of copying the whole
   * workspace, like an installer does. Each entry copies `from` (workspace-relative)
   * into `to` (computer-relative, default the root). Later entries win.
   */
  deploy?: {
    /** Workspace-relative folder or file to copy. @example "Shared/lib" */
    from: string;
    /** Where on the computer it goes. @default "" (the root) */
    to?: string;
  }[];
  /**
   * Blocks next to the computer or on its wired network: inventories, tanks, speakers, modems, drives and the
   * addons' blocks. Each type takes its own fields (see world-peripherals.ts, PeripheralTypeMap).
   */
  peripherals?: (VirtualPeripheralSpec | EnginePeripheralSpec | ModemSpec)[];
  /** World facts read by environmentDetector peripherals. */
  environment?: {
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
    /** 0 full moon .. 7 waxing gibbous. Not read: getMoonId always answers 0, as the real block does. */
    moonPhase?: number;
    /** What listDimensions() returns. @default ["dimension"] */
    dimensions?: string[];
    /** getRadiation().radiation. @default "99.9999" */
    radiation?: string | number;
    /** getRadiation().unit. @default "nSv" */
    radiationUnit?: string;
    /** What getRadiationRaw() returns. @default 1e-7 */
    radiationRaw?: number;
    /**
     * World seed for isSlimeChunk when vhcctweaks is off (on, it is always false). A long past 2^53 goes as a decimal
     * string. Default 0.
     */
    seed?: number | string;
  };
  /** Living entities that scanEntities can see (players are added automatically). */
  entities?: {
    /** Entity type id, e.g. "minecraft:cow". */
    type?: string;
    /** Name. @default the type in title case */
    name?: string;
    /** X coordinate. */
    x: number;
    /** Y coordinate. */
    y: number;
    /** Z coordinate. */
    z: number;
    /** Dimension. @default "minecraft:overworld" */
    dimension?: string;
    /** An animal: scanEntities then reports baby, inLove and aggressive. */
    animal?: boolean;
    /** A baby animal. @default false */
    baby?: boolean;
    /** In love. @default false */
    inLove?: boolean;
    /** Aggressive. @default false */
    aggressive?: boolean;
    /** Entity tags. @default [] */
    tags?: string[];
    /** scanEntities id. @default 1000 + its place in the list */
    id?: number;
    /** Entity UUID. @default 00000000-0000-4000-9000-<place as 12 hex digits> */
    uuid?: string;
    /** Display name (UPW, Metaphysics). @default customName, else the type in title case */
    displayName?: string;
    /** Custom name, when there is no displayName (UPW, Metaphysics). */
    customName?: string;
    /** Mob category, e.g. "MONSTER" (UPW reports it as it is, Metaphysics lower case). @default the vanilla mob's own, else "MISC" */
    category?: string;
    /** false: not a living entity (no health; the UPW scanner skips it). @default true */
    living?: boolean;
    /** Width of its box. @default 0.6 */
    width?: number;
    /** Height of its box, from the feet. @default 1.8 */
    height?: number;
    /** Eye height (Some Peripherals). @default 0.85 of height */
    eyeHeight?: number;
    /** Health points; 0 or less is dead (Metaphysics' getMonster and getMobs skip it). @default 20 */
    health?: number;
    /** Most health points. @default 20 */
    maxHealth?: number;
    /** Armor points. @default 0 */
    armor?: number;
    /** Share of armor slots filled, 0-1 (Some Peripherals). @default 0 */
    armorCover?: number;
    /** Absorption hearts (Some Peripherals). @default 0 */
    absorption?: number;
    /** Blocking with a shield (Some Peripherals). @default false */
    blocking?: boolean;
    /** Sleeping (Some Peripherals). @default false */
    sleeping?: boolean;
    /** Flying with an elytra (Some Peripherals). @default false */
    fallFlying?: boolean;
    /** Movement speed attribute; 0 for a mob that is not walking (Some Peripherals). @default 0 */
    speed?: number;
    /** Pitch, degrees. @default 0 */
    xRot?: number;
    /** Yaw, degrees. @default 0 */
    yRot?: number;
    /** Head yaw, degrees (a living entity looks this way). @default yRot */
    yHeadRot?: number;
    /** Body yaw, degrees (Some Peripherals). @default yRot */
    yBodyRot?: number;
    /** Motion per tick (Metaphysics' `vector`). @default {"x":0,"y":0,"z":0} */
    motion?: {
      /** X per tick. @default 0 */
      x?: number;
      /** Y per tick. @default 0 */
      y?: number;
      /** Z per tick. @default 0 */
      z?: number;
    };
    /** Air left, ticks (Some Peripherals). @default 300 */
    airSupply?: number;
    /** Most air, ticks (Some Peripherals). @default 300 */
    maxAirSupply?: number;
    /** Counts as a Monster for Metaphysics' getMonster. @default true for vanilla monsters */
    monster?: boolean;
    /** Counts as a Mob for Metaphysics' getMobs. @default true, except armor stands */
    mob?: boolean;
    /** Items it leaves where it stood when it dies (CC: Androids). @default [] */
    drops?: MobItemSpec[];
    /** UUID of the android holding its lead (CC: Androids). */
    leashedTo?: string;
    /** Cannot be hurt: an android's attack passes it over (CC: Androids). @default false */
    invulnerable?: boolean;
    /** Air left, ticks (CC: Link). @default 300 */
    air?: number;
    /** Most air, ticks (CC: Link). @default 300 */
    maxAir?: number;
    /** In powder snow (CC: Link). @default false */
    inPowderSnow?: boolean;
    /** A ray can hit it (CC: Link raycastEntity). @default false for items, orbs, arrows, snowballs, eggs, else true */
    pickable?: boolean;
  }[];
  /** Advanced Peripherals: server config overrides and what players carry (docs/advanced-peripherals.md). */
  ap?: ApWorld;
  /** Mekanism: the QIO system, entangloporters, multiblocks and config. See docs/mekanism-qio.md, docs/mekanism-multiblocks.md. */
  mekanism?: MekanismWorld;
  /** Create: kinetic networks, stations and trains (docs/create.md). */
  create?: CreateWorld;
  /** Create Crafts & Additions config (docs/create-additions.md). */
  createAdditions?: CreateAdditionsWorld;
  /** Tom's Peripherals settings (docs/toms-peripherals.md). */
  tomsPeripherals?: TomsPeripheralsWorld;
  /** Bigger Reactors settings (docs/bigger-reactors.md). */
  biggerReactors?: BiggerReactorsWorld;
  /** Extreme Reactors settings (docs/extreme-reactors.md). */
  extremeReactors?: ExtremeReactorsWorld;
  /** Plethora Peripherals: other entities, config, game time; `{}` lets a turtle know the module upgrades (docs/plethora.md). */
  plethora?: PlethoraWorld;
  /** CC: Link: the Link core, its upgrades, wearer and surroundings (docs/cc-link.md). */
  ccLink?: CcLinkWorld;
  /** Finer Peripherals: the ender chest owner, respawn points, extra items; `{}` lets a turtle know its upgrades (docs/finer-peripherals.md). */
  finerPeripherals?: FinerPeripheralsWorld;
  /** Ducky Peripherals: the weather (docs/ducky-peripherals.md). */
  duckyPeripherals?: DuckyPeripheralsWorld;
  /** More Peripherals: what players carry, known spawner mobs (docs/more-peripherals.md). */
  morePeripherals?: MorePeripheralsWorld;
  /** Classic Peripherals: seed, pocket, NFC cards, RFID entities, config (docs/classic-peripherals.md). */
  classicPeripherals?: ClassicPeripheralsWorld;
  /** SwitchCraft Peripherals: printer config (docs/sc-peripherals.md). */
  scPeripherals?: ScPeripheralsWorld;
  /** Cricket's Peripherals: the hard drive capacity (docs/crickets-peripherals.md). */
  cricketsPeripherals?: CricketsPeripheralsWorld;
  /** CCTech: tape speeds and default length (docs/cctech.md). */
  cctech?: CcTechWorld;
  /** Embedded Computer: make this computer an embedded or secure one; hard drive size (docs/embedded-computer.md). */
  embeddedComputer?: EmbeddedComputerWorld;
  /** Lake's CC Additions: scanner config (docs/lakes-cc-additions.md). */
  lakesCcAdditions?: LakesCcAdditionsWorld;
  /** UnlimitedPeripheralWorks: what the ultimate sensor reads, scanner players, config (docs/unlimited-peripheral-works.md). */
  upw?: UpwWorld;
  /** Metaphysics: switches its crypto and coord APIs on; players, ships, world facts (docs/metaphysics.md). */
  metaphysics?: MetaphysicsWorld;
  /** Some Peripherals: players, VS2 ships, digitized items, config (docs/some-peripherals.md). */
  somePeripherals?: SomePeripheralsWorld;
  /** SirEdvin's Cloud Solutions: owner, KV store and server config (docs/cloud-solutions.md). */
  cloudSolutions?: CloudSolutionsWorld;
  /** CC: VS: the ship the computer is on, config and aerodynamics (docs/cc-vs.md). */
  ccvs?: CcVsWorld;
  /** CC Shops: online players, entities and defaults (docs/cc-shops.md). */
  ccShops?: CcShopsWorld;
  /** CC:C Bridge: no settings yet; the key only loads the addon (docs/cccbridge.md). */
  cccbridge?: CccBridgeWorld;
  /** Create: CC Total Logistics: logistics networks and stock links (docs/create-cc-logistics.md). */
  createLogistics?: CreateLogisticsWorld;
  /** CC: LiftLink: elevator columns, contacts and pulleys (docs/cc-liftlink.md). */
  liftlink?: LiftLinkWorld;
  /**
   * Name of a persistent vhcc_data store shared between runs. Omit for a fresh,
   * empty store per run.
   */
  vhccStore?: string;
  /** Make this computer a turtle (docs/turtle.md). Its world is `blocks`, `fills` and `ground`. */
  turtle?: TurtleSpec;
  /** CC: Androids: make this computer an android in the block world (docs/cc-androids.md). */
  android?: AndroidSpec;
  /** CC: Androids config values: health, damage and speed of each android type (docs/cc-androids.md). */
  androidConfig?: AndroidConfig;
  /** CC: Drones: make this computer a drone in the block world (docs/cc-drones.md). */
  drone?: CcDroneSpec;
  /** CC: Drones+: make this computer a drone in the block world (docs/cc-drones.md). */
  dronePlus?: CcDronePlusSpec;
  /** AC-Drones: make this computer a drone in the block world (docs/ac-drones.md). */
  acDrone?: AcDroneSpec;
  /** Set by the runner on a computer block a turtle placed and something turned on: where it stands. */
  placed?: {
    /** X coordinate. */
    x: number;
    /** Y coordinate. */
    y: number;
    /** Z coordinate. */
    z: number;
    /** Which way it faces. */
    facing?: string;
    /** The computer block's id. */
    block: string;
    /** Dimension. */
    dimension?: string;
  };
  /** Floppy disk contents at the start: disk id to path to file text (computer/disk/<id>). */
  disks?: Record<string, Record<string, string>>;
  /** Blocks of the world around a turtle. Anything not listed (and not filled or ground) is air. */
  blocks?: BlockSpec[];
  /** Boxes of one block (inclusive corners). Later fills cover earlier ones; `blocks` cover fills. */
  fills?: {
    /** One corner, `{ x, y, z }` or [x, y, z]. */
    from: BlockPos | [number, number, number];
    /** The other corner. */
    to: BlockPos | [number, number, number];
    /** Block id; omit or "minecraft:air" for air. */
    name?: string;
    /** Block state properties, as strings. */
    state?: Record<string, string>;
    /** Metaphysics: explosion resistance (wins over metaphysics.explosionResistance). */
    explosionResistance?: number;
    /** Metaphysics: getBlockIsSolid's answer. @default the game data's collision rule */
    solid?: boolean;
    /** Plethora: hardness for the scanner and laser (wins over gameData.hardness and vanilla's). */
    hardness?: number;
    /** CC: Link and Finer Peripherals scanners: the blocks' tags as reported ("minecraft:block/logs"). @default the game data's */
    tags?: string[];
  }[];
  /** Everything at or below `y` is `name` (default stone), its top layer `top` if given. */
  ground?: {
    /** Top of the ground. */
    y?: number;
    /** Block id of the ground. @default "minecraft:stone" */
    name?: string;
    /** Block id of the top layer, e.g. "minecraft:grass_block". */
    top?: string;
  };
  /** Item stacks lying in the world, by the block they are in. */
  items?: {
    /** X coordinate. */
    x: number;
    /** Y coordinate. */
    y: number;
    /** Z coordinate. */
    z: number;
    /** Item id. */
    name: string;
    /** Stack size. @default 1 */
    count?: number;
    /** The stack's NBT, as SNBT. */
    nbt?: string;
  }[];
  /** Game rules the living world reads (ccsim/turtle/living.lua). */
  gameRules?: {
    /** Random ticks per chunk section per tick. @default 3 */
    randomTickSpeed?: number;
  };
  /** computercraft-server.toml [turtle]. Defaults are the pack's: fuel needed, 20000 / 100000, pushing on. */
  turtleConfig?: {
    /** need_fuel. @default true */
    needFuel?: boolean;
    /** turtle_fuel_limit. @default 20000 */
    normalFuelLimit?: number;
    /** advanced_turtle_fuel_limit. @default 100000 */
    advancedFuelLimit?: number;
    /** can_push: turtles push entities. @default true */
    canPush?: boolean;
    /** obey_block_protection (default true): spawn protection stops a turtle moving, digging and placing. */
    obeyBlockProtection?: boolean;
    /** term_sizes.monitor in blocks: the widest monitor wall. @default 8 */
    monitorWidth?: number;
    /** term_sizes.monitor in blocks: the tallest monitor wall. @default 6 */
    monitorHeight?: number;
  };
  /**
   * The server's spawn protection (server.properties spawn-protection, DedicatedServer.isUnderSpawnProtection): blocks
   * within `radius` of the spawn's x and z, in the overworld. `ops: false` is a server with no ops (then it is off);
   * `ownerOp` is a turtle owned by an op, who is exempt.
   */
  spawnProtection?: {
    /** Protected radius around the spawn, blocks (0 or less: off). @default 16 */
    radius?: number;
    /** The spawn point. @default {"x":0,"z":0} */
    spawn?: {
      /** Spawn X. @default 0 */
      x?: number;
      /** Spawn Z. @default 0 */
      z?: number;
    };
    /** false: the server has no ops, so protection is off. @default true */
    ops?: boolean;
    /** The turtle's owner is an op, who is exempt. @default false */
    ownerOp?: boolean;
  };
  /** The world border (WorldBorder): a square `size` wide around `center`. */
  worldBorder?: {
    /** Centre of the border. @default {"x":0,"z":0} */
    center?: {
      /** Centre X. @default 0 */
      x?: number;
      /** Centre Z. @default 0 */
      z?: number;
    };
    /** Width of the square, blocks (vanilla 59999968). */
    size: number;
  };
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

/**
 * A world file: `<name>.world.json` next to a program, or `worlds/<name>.json`. The world itself, plus the monitor
 * walls the window, the VS Code extension and the test runner attach from it. schemas/world.schema.json is generated
 * from this type (world-schema.test.ts).
 */
export interface WorldFile extends WorldConfig {
  /** The JSON Schema of this file, for editors. The runner ignores it. */
  $schema?: string;
  /** Monitor walls next to the computer (`craftos-mcp window`, the VS Code extension and `*.test.lua` runs). */
  monitors?: MonitorSpec[];
}

const ENGINE_TYPES = new Set(["drive"]);

/** A world parsed from a file, without the keys that only editors read (`$schema`). */
export function withoutEditorKeys<T extends object>(world: T): T {
  if (!("$schema" in world)) return world;
  const { $schema: _schema, ...rest } = world as T & { $schema?: unknown };
  return rest as T;
}

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
  return withoutEditorKeys(
    JSON.parse(readFileSync(file, "utf8")) as WorldConfig,
  );
}

/** Terminal size for the computer, or undefined to keep the engine default. */
export function terminalSize(
  world: WorldConfig | undefined,
): { width: number; height: number } | undefined {
  if (world?.terminal) return world.terminal;
  if (world?.kind === "pocket") return { width: 26, height: 20 };
  // Normal and advanced turtles alike (TileTurtle)
  if (world?.turtle) return { width: 39, height: 13 };
  // An android or a drone: the computer its mod builds into it (mobs.ts)
  const mob = mobComputer(world as Record<string, unknown> | undefined);
  if (mob) return { width: mob.width, height: mob.height };
  // Embedded Computer's two computers (EmbeddedComputerBlockEntity / SecureComputerBlockEntity.createComputer)
  const ec = world?.embeddedComputer;
  if (ec?.kind === "embedded") return { width: 10, height: 3 };
  if (ec?.kind === "secure") return { width: 49, height: 17 };
  return undefined;
}

/** The Minecraft / CC:Tweaked version a world runs as: world.version, else CRAFTOS_VERSION, else 1.18.2. */
export function worldVersion(world: WorldConfig | undefined): ResolvedVersion {
  return resolveVersion(world?.version);
}

/** The one Minecraft version vhcctweaks exists for. */
export const VHCC_MC = "1.18.2";

/** Whether the vhcctweaks server mod exists on this version (it is a 1.18.2 mod). */
export function vhccExists(version: ResolvedVersion): boolean {
  return version.mc === VHCC_MC;
}

/** vhcctweaks is an opt-in addon: on only when a world names it (addons) or gives it a version (vhcctweaks). */
const VHCC_DEFAULT_ON: boolean = false;

/**
 * Which vhcctweaks a world runs, or false for none: `world.vhcctweaks` when it names a release (false turns it off),
 * else "2.2.36" when the addon "vhcctweaks" is on (world.addons, craftos.json, CRAFTOS_ADDONS; "all" leaves it out).
 * It only exists on Minecraft 1.18.2: naming a release on another version is an error, the addon there is refused by
 * resolveAddons. `addons`: the world's resolved addon list, when the caller has it.
 */
export function vhccVersion(
  world: WorldConfig | undefined,
  version: ResolvedVersion = worldVersion(world),
  addons?: readonly string[],
): "2.2.35" | "2.2.36" | "2.2.37" | false {
  const asked = world?.vhcctweaks;
  if (asked === false) return false;
  if (!vhccExists(version)) {
    if (typeof asked === "string")
      throw new Error(
        `world.vhcctweaks ${JSON.stringify(asked)}: vhcctweaks only exists for Minecraft ${VHCC_MC}, this world is on ${version.mc}. Add "version": "${VHCC_MC}" to the world`,
      );
    return false;
  }
  if (typeof asked === "string") return asked;
  const on =
    VHCC_DEFAULT_ON ||
    (addons ?? resolveAddons(world?.addons, process.env, version.mc)).includes(
      "vhcctweaks",
    );
  return on ? "2.2.36" : false;
}

/** A linked call's cost in game, in ms (deviation 164: 40 setCursorPos on a linked monitor took about 1.2 s). */
export const LINK_LATENCY_DEFAULT = 30;

/**
 * The ms a call to a linked computer's peripheral costs: world.linkLatency, else CRAFTOS_LINK_LATENCY, else
 * LINK_LATENCY_DEFAULT. "fast" is 0.
 */
export function linkLatencyMs(
  world: WorldConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw: unknown = world?.linkLatency ?? env["CRAFTOS_LINK_LATENCY"];
  if (raw === undefined || raw === "") return LINK_LATENCY_DEFAULT;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "fast") return 0;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 0)
    throw new Error(
      `linkLatency ${JSON.stringify(raw)}: a number of ms (0 or more) or "fast"`,
    );
  return ms;
}

/** What to tell a person once per session when a world uses vhcctweaks' linked computers (linksInUse). */
export const LINKS_WARNING =
  "vhcctweaks linked computers (ender modem links, remote peripherals) run in real time: on a slow or busy machine " +
  "(many emulated computers at once) a linked-peripheral call can time out, stall or behave inconsistently.";

/**
 * Whether a world can use vhcctweaks' linked computers: the mod on at 2.2.36 or later and an ender modem (the
 * links' only way in). False for any world vhccVersion refuses.
 */
export function linksInUse(world: WorldConfig | undefined): boolean {
  if (!world) return false;
  try {
    const v = vhccVersion(world);
    if (v === false || v === "2.2.35") return false;
  } catch {
    return false;
  }
  return (world.peripherals ?? []).some(
    (p) => (p as { kind?: string }).kind === "ender",
  );
}

/** The world as the Lua sim reads it (engine peripherals are created separately). */
export function worldJson(world: WorldConfig | undefined): string {
  // A computer alone is a network of one; linked computers arrive already resolved
  const resolved =
    world && !world.modemLink
      ? withResolvedModems(world, resolveWired([{ world }])[0]!)
      : world;
  const copy: Record<string, unknown> = { ...(resolved ?? {}) };
  // The Minecraft / CC:Tweaked version (versions.ts): ccsim reads it as core.version
  const version = worldVersion(resolved);
  copy["version"] = versionForSim(version);
  // The mods this world runs with (addons.ts): a world using one that is off fails here, before the computer boots
  const addons = resolveAddons(resolved?.addons, process.env, version.mc);
  checkWorldAddons(
    copy,
    addons,
    version.mc,
    addonSource(resolved?.addons, process.env),
  );
  copy["addons"] = addons;
  // vhcctweaks is a 1.18.2 server mod: other versions run plain CC:Tweaked. The sim gets the release, or false.
  copy["vhcctweaks"] = vhccVersion(resolved, version, addons);
  copy["linkLatency"] = linkLatencyMs(resolved);
  delete copy["vhccStore"];
  delete copy["deploy"];
  delete copy["$schema"]; // an editor's key (world files point at schemas/world.schema.json)
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
        `periphemu.create(${luaString(p.name)}, ${luaString(p.type)}${
          Number.isInteger(p.disk) ? `, ${p.disk}` : ""
        })\n` +
        `if peripheral.__ccsimNamed then peripheral.__ccsimNamed(${luaString(p.name)}) end`,
    )
    .join("\n");
}

/** Reject names that could escape the runtime directory. */
export function safeStoreName(name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name) || name.startsWith(".")) {
    throw new Error(
      `vhccStore must match [\\w.-]{1,64} and not start with a dot: ${name}`,
    );
  }
  return name;
}

/** What the sim keeps in state.json for itself (what a reboot reads back), never part of a result. */
const INTERNAL_STATE = ["survives"];
const HIDDEN_STATE = INTERNAL_STATE;

/**
 * The sim state as results show it (craftos_sim_state, a run's `sim`): without the sim's own bookkeeping
 * (INTERNAL_STATE) and, in the public build, without sections that are empty.
 */
export function shownState<T extends SimState | undefined>(state: T): T {
  if (!state) return state;
  const out: Record<string, unknown> = { ...state };
  for (const key of HIDDEN_STATE) delete out[key];
  for (const [key, value] of Object.entries(out))
    if (
      value === null ||
      (typeof value === "object" && Object.keys(value as object).length === 0)
    )
      delete out[key];
  return out as T;
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
  /** 2.2.37: what Vault Hunters knows about each player that has any of it. */
  vaultStats?: Record<
    string,
    {
      gearPower?: GearPowerSpec;
      temper?: TemperSpec;
      reputation?: PlayerSpec["reputation"];
      greedTier?: number;
    }
  >;
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
  /** The world as it stands now (players, peripherals, position, ...): a snapshot starts a computer from it. */
  live?: {
    players?: { name?: string; online?: boolean; [k: string]: unknown }[];
    [k: string]: unknown;
  };
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
  | { cmd: "interact"; player: string }
  | { cmd: "approve"; player?: string; nonce?: string }
  /**
   * A player runs code on the computer through the mod (/vhcc pc exec): it gets `vhcc_rc_exec(request, code)` and
   * answers with `vhcc.rcReply(request, result)`, which sends the player `[vhcc-rc] {...}` in chat. `request` picks
   * the id (default random hex).
   */
  | { cmd: "rcExec"; player: string; code: string; request?: string }
  /** /ccvault revoke: that player's approval here (all players' without one); on 2.2.36 their allowances too. */
  | { cmd: "revoke"; player?: string }
  | { cmd: "setBalance"; player: string; balance: number }
  /** 2.2.36: a player's vault level changes; null leaves them with no vault data. */
  | { cmd: "setVaultLevel"; player: string; level: number | null }
  /** 2.2.36: the player moves to another server of the network (true) or comes back here (false). */
  | { cmd: "setOnOtherServer"; player: string; onOtherServer: boolean }
  /** 2.2.37: the player's slot scores, slot details and peak change; null takes them away. */
  | { cmd: "setGearPower"; player: string; gearPower: GearPowerSpec | null }
  /** 2.2.37: the player's Temper and Dust change; null takes them away. */
  | { cmd: "setTemper"; player: string; temper: TemperSpec | null }
  /** 2.2.37: the player's god reputation changes; null puts every god back to 0. */
  | {
      cmd: "setReputation";
      player: string;
      reputation: PlayerSpec["reputation"] | null;
    }
  /** 2.2.37: the player's greed tier changes; null puts it back to 0. */
  | { cmd: "setGreedTier"; player: string; greedTier: number | null }
  /** 2.2.37: the player's skill trees change; null takes them away. */
  | { cmd: "setSkills"; player: string; skills: SkillsSpec | null }
  /** 2.2.37: the player's stats change; null takes them away. */
  | {
      cmd: "setStats";
      player: string;
      stats: Record<string, number | StatSpec> | null;
    }
  /** 2.2.36: the next `times` (default 1, -1 every, 0 none) calls of a ccvault function answer nil, "internal error". */
  | { cmd: "internalError"; function: string; times?: number }
  /** 2.2.36: server ticks per economy-thread call from now on (economyDelayTicks). */
  | { cmd: "setEconomyDelay"; ticks: number }
  /**
   * 2.2.36: change what a player wears or holds: `slot` (head, chest, legs, feet, mainhand, offhand) or `curio` and
   * `index`, with `item` (null takes it off); or `equipment` to replace everything.
   */
  | {
      cmd: "setEquipment";
      player: string;
      slot?: "head" | "chest" | "legs" | "feet" | "mainhand" | "offhand";
      curio?: string;
      index?: number;
      item?: ItemSpec | null;
      equipment?: EquipmentSpec;
    }
  | { cmd: "addPlayer"; name: string; balance?: number; online?: boolean }
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
  | { cmd: "setHost"; player?: string | null }
  | { cmd: "setEconomy"; available: boolean }
  /** The economy refuses the next `times` transfers (default 1, -1 every one, 0 none again); each is logged as REJECTED. */
  | { cmd: "refuseTransfers"; times?: number }
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
            textScale?: number;
            /** false: a normal monitor (greys, no touches). */
            advanced?: boolean;
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
  /** A player puts floppy `disk` (its id) into an empty engine drive: the disk mounts and `disk` is queued. */
  | { cmd: "insertDisk"; peripheral: string; disk: number }
  /** A player takes the floppy out of an engine drive: its mount goes and `disk_eject` is queued. */
  | { cmd: "ejectDisk"; peripheral: string }
  | { cmd: "seed"; value: number }
  | { cmd: "advance"; seconds: number };
