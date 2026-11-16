/**
 * Mods besides CC:Tweaked that the emulator can simulate. Each one is an addon that can be switched off, so a
 * program written for a pack without that mod cannot lean on its peripherals by accident.
 *
 * Which addons are on, first match wins:
 *   1. `world.addons`: a list of ids, or "all" / "none".
 *   2. The CRAFTOS_ADDONS environment variable: "all", "none", or ids separated by commas.
 *   3. Everything.
 * A world that uses a peripheral of an addon that is off fails at boot with a message naming the addon.
 *
 * CC:Tweaked's own generic peripherals (inventories, fluid_storage, energy_storage) are not addons: any block from
 * any mod can have them, so they are always there.
 *
 * The Lua side of each addon lives in rom-overlay/rom/ccsim/addons/<module>/ (see the README there); its world
 * types and docs are listed here.
 *
 * Each addon names its mod version per Minecraft version (versions.ts). A world on a Minecraft version the mod has
 * no release for cannot switch it on (Bigger Reactors on 1.21.1); "all" and the default leave it out. The Lua side
 * still simulates the 1.18.2 version of every mod: the other versions say which release a later round follows.
 */
import { DEFAULT_MC } from "./versions.js";

export interface AddonInfo {
  /** Id used in `world.addons` and CRAFTOS_ADDONS. */
  readonly id: string;
  /** Mod name. */
  readonly name: string;
  /** Minecraft version -> the mod version for it. A Minecraft version missing here has no release of the mod. */
  readonly versions: Readonly<Record<string, string>>;
  /** Peripheral types (`world.peripherals[].type`) that belong to it. */
  readonly types: readonly string[];
  /** Top-level world keys that configure it. */
  readonly worldKeys?: readonly string[];
  /** Ids of addons it needs switched on too. */
  readonly requires?: readonly string[];
  /** Where its documentation is. */
  readonly docs?: string;
  /** Short list of its sim commands for tool descriptions. */
  readonly commands?: string;
}

export const ADDONS: readonly AddonInfo[] = [
  {
    id: "advanced-peripherals",
    name: "Advanced Peripherals",
    versions: { "1.18.2": "0.7.31r", "1.20.1": "0.7.48r", "1.21.1": "0.7.62b" },
    types: [
      "playerDetector",
      "chatBox",
      "energyDetector",
      "redstoneIntegrator",
      "nbtStorage",
      "environmentDetector",
      "meBridge",
      "rsBridge",
      "arController",
      "geoScanner",
      "blockReader",
      "inventoryManager",
      "chunky",
    ],
    worldKeys: ["ap"],
    docs: "docs/advanced-peripherals.md",
    commands:
      "setEnergyTransferRate {peripheral, rate}, setRedstoneInput {peripheral, side, level}, completeCraft {peripheral, name?}, setNetworkConnected {peripheral, connected}, " +
      "setPlayerItem {player, slot, item|null} or {player, selected}, setMemoryCard {peripheral, owner|null}",
  },
  {
    id: "mekanism",
    name: "Mekanism",
    versions: { "1.18.2": "10.2.5", "1.20.1": "10.4.16", "1.21.1": "10.7.19" },
    types: [
      "qioDriveArray",
      "qioDashboard",
      "qioImporter",
      "qioExporter",
      "qioRedstoneAdapter",
      "quantumEntangloporter",
      "boilerValve",
      "inductionPort",
      "enrichmentChamber",
      "crusher",
      "energizedSmelter",
      "metallurgicInfuser",
      "electrolyticSeparator",
      "dynamicValve",
      "thermalEvaporationController",
      "thermalEvaporationValve",
      "spsPort",
      "precisionSawmill",
      "osmiumCompressor",
      "purificationChamber",
      "chemicalInjectionChamber",
      "combiner",
      "pressurizedReactionChamber",
      "chemicalCrystallizer",
      "chemicalDissolutionChamber",
      "chemicalInfuser",
      "chemicalOxidizer",
      "chemicalWasher",
      "rotaryCondensentrator",
      "isotopicCentrifuge",
      "nutritionalLiquifier",
      "antiprotonicNucleosynthesizer",
      "pigmentExtractor",
      "pigmentMixer",
      "paintingMachine",
      "solarNeutronActivator",
      "digitalMiner",
      "electricPump",
      "fluidicPlenisher",
      "resistiveHeater",
      "fuelwoodHeater",
      "seismicVibrator",
      "laser",
      "laserAmplifier",
      "laserTractorBeam",
      "teleporter",
      "chargepad",
      "logisticalSorter",
      "oredictionificator",
      "formulaicAssemblicator",
      "modificationStation",
      "dimensionalStabilizer",
      "diversionTransporter",
      ...["basic", "advanced", "elite", "ultimate", "creative"].flatMap((t) => [
        `${t}EnergyCube`,
        `${t}FluidTank`,
        `${t}ChemicalTank`,
        `${t}Bin`,
      ]),
      ...["basic", "advanced", "elite", "ultimate"].flatMap((t) => [
        ...[
          "Smelting",
          "Enriching",
          "Crushing",
          "Compressing",
          "Combining",
          "Purifying",
          "Injecting",
          "Infusing",
          "Sawing",
        ].map((f) => `${t}${f}Factory`),
        `${t}UniversalCable`,
        `${t}MechanicalPipe`,
        `${t}PressurizedTube`,
      ]),
    ],
    worldKeys: ["mekanism"],
    docs: "docs/mekanism-qio.md, docs/mekanism-multiblocks.md",
    commands:
      "qioSetPowered {block, powered}, qioSetDrive {block, slot, drive|null}, qioSetSecurity {block, mode}, qioSetUpgrades {block, speed}, qioInsert/qioExtract {frequency, item}, qeInsert {frequency, item, public?, owner?}, qeExtract {frequency, count?}, qeSetLoaded {block, loaded}, " +
      "mekSetFormed {multiblock|peripheral, formed}, mekSet {multiblock|peripheral, ...fields}, mekAddTank {multiblock|peripheral, tank, amount, name?}, mekSetRedstone {peripheral, powered}, mekSetWorld {dayTime?, raining?, thundering?, daylightCycle?}",
  },
  {
    id: "mekanism-generators",
    name: "Mekanism Generators",
    versions: { "1.18.2": "10.2.5", "1.20.1": "10.4.16", "1.21.1": "10.7.19" },
    types: [
      "fissionReactorLogicAdapter",
      "fissionReactorPort",
      "turbineValve",
      "fusionReactorLogicAdapter",
      "fusionReactorPort",
      "solarGenerator",
      "advancedSolarGenerator",
      "windGenerator",
      "heatGenerator",
      "bioGenerator",
      "gasBurningGenerator",
    ],
    requires: ["mekanism"],
    docs: "docs/mekanism-multiblocks.md",
    commands:
      "mekSetFormed, mekSet, mekAddTank, mekSetRedstone (see mekanism), mekFusionLaser {multiblock|peripheral, energy}, mekInsertHohlraum {multiblock|peripheral, filled?}",
  },
  {
    id: "create",
    name: "Create",
    versions: { "1.18.2": "0.5.1.i", "1.20.1": "6.0.8", "1.21.1": "6.0.10" },
    types: [
      "Create_DisplayLink",
      "Create_Speedometer",
      "Create_Stressometer",
      "Create_RotationSpeedController",
      "Create_SequencedGearshift",
      "Create_Station",
    ],
    worldKeys: ["create"],
    docs: "docs/create.md",
    commands:
      "createTrainArrive {train, station}, createTrainLeave {train}, createTrainApproach {train, station, distance?}, createAddTrain {train}, createRemoveTrain {train}, " +
      "createSetCargo {train, items?, fluids?, players?}, createSetStationPowered {station, powered}, createSetAssemblyReady {station, name?, ready?}, createSetRedstoneLink {first?, second?, powered}, " +
      "createSetSpeed {network|peripheral, speed}, createSetStress {network|peripheral, stress?, capacity?, impact?}, createSetLinkPowered {peripheral, powered}, createSetLinkTarget {peripheral, target}",
  },
  {
    id: "create-additions",
    name: "Create Crafts & Additions",
    versions: { "1.18.2": "1.0.0", "1.20.1": "1.3.3", "1.21.1": "1.7.2" },
    types: [
      "electric_motor",
      "modular_accumulator",
      "portable_energy_interface",
      "redstone_relay",
      "digital_adapter",
    ],
    worldKeys: ["createAdditions"],
    requires: ["create"],
    docs: "docs/create-additions.md",
    commands:
      "caSetEnergy {peripheral, energy}, caSetEnergyInput {peripheral, rate}, caSetEnergyOutput {peripheral, rate}, caSetRedstone {peripheral, powered}, caSetRelayFlow {peripheral, supply?, demand?}, " +
      "caConnectContraption {peripheral, energy?, capacity?}, caDisconnectContraption {peripheral}, caSetContraption {peripheral, side, offset?, angle?, rpm?, running?, targetY?, assembled?}",
  },
  {
    id: "toms-peripherals",
    name: "Tom's Peripherals",
    versions: {
      "1.18.2": "1.18.2-1.2.1",
      "1.20.1": "1.20.1-1.3.1",
      "1.21.1": "1.21.1-1.3.1",
    },
    types: ["tm_gpu", "tm_keyboard", "tm_rsPort", "tm_wdt"],
    worldKeys: ["tomsPeripherals"],
    docs: "docs/toms-peripherals.md",
    commands:
      "tmTouch {peripheral?, x, y, sneak?}, tmMonitorEvent {peripheral?, event, x, y, param?}, tmSetMonitors {peripheral?, width, height}, tmReloadGpu {peripheral?}, tmKey/tmKeyUp {peripheral?, key, repeat?}, tmChar {char}, tmType {text}, tmPaste {text}, tmKeyboardEvent {event}, tmPortable {connected, id?}, tmSetRedstoneInput {peripheral, side, level?, bundled?}",
  },
  {
    id: "bigger-reactors",
    name: "Bigger Reactors",
    // there is no Bigger Reactors for 1.21.1
    versions: {
      "1.18.2": "1.18.2-0.6.0-beta.1.4 (Phosphophyllite 1.18.2-0.6.0-beta.1.6)",
      "1.20.1": "1.20.1-0.6.0-beta.10.5",
    },
    types: ["BiggerReactors_Reactor", "BiggerReactors_Turbine"],
    worldKeys: ["biggerReactors"],
    docs: "docs/bigger-reactors.md",
    commands:
      'brAddFuel/brAddWaste {peripheral, amount}, brSetLoad {peripheral, rate}, brDrainEnergy {peripheral, amount}, brAddCoolant {peripheral, amount} (reactor water), brAddSteam {peripheral, amount} (turbine), brSetCoolantSupply/brSetSteamSupply {peripheral, rate|"full"}, brSetActive {peripheral, active}, brSetAssembled {peripheral, assembled}',
  },
  {
    id: "extreme-reactors",
    name: "Extreme Reactors",
    versions: {
      "1.18.2": "1.18.2-2.0.71 (ZeroCore2 1.18.2-2.1.39)",
      "1.20.1": "1.20.1-2.0.97",
      "1.21.1": "1.21.1-2.4.28",
    },
    types: ["BigReactors-Reactor", "BigReactors-Turbine"],
    worldKeys: ["extremeReactors"],
    docs: "docs/extreme-reactors.md",
    commands:
      'erAddFuel {peripheral, amount, fuelType?}, erAddWaste {peripheral, amount}, erSetLoad {peripheral, rate}, erDrainEnergy {peripheral, amount}, erAddCoolant/erAddSteam {peripheral, amount}, erSetCoolantSupply {peripheral, rate|"full"}, erSetSteamSupply {peripheral, rate|"full"}, erSetActive {peripheral, active}, erSetAssembled {peripheral, assembled}, erSetConnected {peripheral, connected}',
  },
];

const BY_ID = new Map(ADDONS.map((a) => [a.id, a]));

/** Accept a few spellings: "Advanced Peripherals", "advanced_peripherals", "advancedperipherals". */
function normalise(id: string): string {
  const flat = id
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (BY_ID.has(flat)) return flat;
  const squashed = flat.replace(/-/g, "");
  for (const a of ADDONS) if (a.id.replace(/-/g, "") === squashed) return a.id;
  return flat;
}

/** The mod version an addon follows on a Minecraft version, or undefined when the mod has none there. */
export function addonVersion(
  addon: AddonInfo,
  mc: string = DEFAULT_MC,
): string | undefined {
  return addon.versions[mc];
}

/** The addons that exist on a Minecraft version. */
export function addonsFor(mc: string = DEFAULT_MC): AddonInfo[] {
  return ADDONS.filter((a) => addonVersion(a, mc) !== undefined);
}

function parseList(spec: string | readonly string[], mc: string): string[] {
  const list = typeof spec === "string" ? spec.split(",") : [...spec];
  const trimmed = list.map((s) => s.trim()).filter((s) => s !== "");
  if (trimmed.length === 1 && trimmed[0]!.toLowerCase() === "all")
    return addonsFor(mc).map((a) => a.id);
  if (trimmed.length === 1 && trimmed[0]!.toLowerCase() === "none") return [];
  const ids = trimmed.map(normalise);
  const unknown = ids.filter((id) => !BY_ID.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `unknown addon ${unknown.map((u) => JSON.stringify(u)).join(", ")}; known: ${ADDONS.map((a) => a.id).join(", ")}`,
    );
  }
  const missing = ids.filter(
    (id) => addonVersion(BY_ID.get(id)!, mc) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `${missing.map((id) => `${BY_ID.get(id)!.name} (addon "${id}")`).join(", ")} has no release for Minecraft ${mc}; ` +
        `addons on ${mc}: ${
          addonsFor(mc)
            .map((a) => a.id)
            .join(", ") || "none"
        }. Leave it out or pick another world.version.`,
    );
  }
  return ids;
}

/** The addons a world runs with, in ADDONS order. `mc`: the world's Minecraft version (versions.ts). */
export function resolveAddons(
  worldAddons: string | readonly string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  mc: string = DEFAULT_MC,
): string[] {
  const envSpec = env["CRAFTOS_ADDONS"];
  const ids =
    worldAddons !== undefined
      ? parseList(worldAddons, mc)
      : envSpec !== undefined
        ? parseList(envSpec, mc)
        : addonsFor(mc).map((a) => a.id);
  const on = new Set(ids);
  for (const id of on) {
    for (const need of BY_ID.get(id)?.requires ?? []) {
      if (!on.has(need)) {
        throw new Error(
          `addon ${id} needs ${need}: switch it on too (world.addons or CRAFTOS_ADDONS)`,
        );
      }
    }
  }
  return ADDONS.filter((a) => on.has(a.id)).map((a) => a.id);
}

/** The addon a peripheral type belongs to, if any. */
export function addonOfType(type: string): AddonInfo | undefined {
  return ADDONS.find((a) => a.types.includes(type));
}

/** Refuse a world that uses an addon that is off, naming the addon and how to switch it on. */
export function checkWorldAddons(
  world: {
    peripherals?: readonly { name?: string; type?: string }[];
    [key: string]: unknown;
  },
  enabled: readonly string[],
  mc: string = DEFAULT_MC,
): void {
  const on = new Set(enabled);
  const problems: string[] = [];
  const absent: string[] = [];
  for (const p of world.peripherals ?? []) {
    const addon = p.type ? addonOfType(p.type) : undefined;
    if (addon && !on.has(addon.id)) {
      const what = `peripheral ${JSON.stringify(p.name)} is a ${p.type} from ${addon.name} (addon "${addon.id}")`;
      if (addonVersion(addon, mc) === undefined) absent.push(what);
      else problems.push(what);
    }
  }
  for (const addon of ADDONS) {
    if (on.has(addon.id)) continue;
    for (const key of addon.worldKeys ?? []) {
      if (world[key] !== undefined) {
        const what = `world.${key} configures ${addon.name} (addon "${addon.id}")`;
        if (addonVersion(addon, mc) === undefined) absent.push(what);
        else problems.push(what);
      }
    }
  }
  if (absent.length > 0) {
    throw new Error(
      `${absent.join("; ")}, which has no release for Minecraft ${mc}. Leave it out or pick another world.version.`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      `${problems.join("; ")}, which is switched off. Enabled addons: ${enabled.length > 0 ? enabled.join(", ") : "none"}. ` +
        `Add it to world.addons or CRAFTOS_ADDONS, or leave the peripheral out.`,
    );
  }
}

/**
 * For craftos_info: every addon, its version on `mc` ("none" when the mod has no release there) and whether the
 * default (CRAFTOS_ADDONS) has it on.
 */
export function addonReport(
  env: NodeJS.ProcessEnv = process.env,
  mc: string = DEFAULT_MC,
): {
  source: string;
  addons: { id: string; name: string; version: string; on: boolean }[];
} {
  let enabled: string[];
  let source: string;
  try {
    enabled = resolveAddons(undefined, env, mc);
    source =
      env["CRAFTOS_ADDONS"] !== undefined
        ? `CRAFTOS_ADDONS=${env["CRAFTOS_ADDONS"]}`
        : "default: all (set CRAFTOS_ADDONS to the mods in your pack)";
  } catch (error) {
    enabled = [];
    source = `CRAFTOS_ADDONS is invalid: ${(error as Error).message}`;
  }
  return {
    source,
    addons: ADDONS.map((a) => ({
      id: a.id,
      name: a.name,
      version: addonVersion(a, mc) ?? "none",
      on: enabled.includes(a.id),
    })),
  };
}
