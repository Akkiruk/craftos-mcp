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

/** Sim commands every mob addon has (rom-overlay/rom/ccsim/mob.lua): the world around the mob. */
const MOB_COMMANDS =
  "mobSpawn {type, x, y, z, uuid?, name?, health?, drops?}, mobMove {uuid, x, y, z}, mobRemove {uuid}, mobDropItem {x, y, z, name, count?}, mobSetBlock {x, y, z, name?, state?, items?}";

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
  {
    id: "unlimited-peripheral-works",
    name: "UnlimitedPeripheralWorks",
    // 1.18.2 has only a Fabric build (0.2.9, a different API); the emulator's 1.18.2 is Forge
    versions: { "1.20.1": "1.20.1-1.9.2", "1.21.1": "1.21.1-1.9.2" },
    types: [
      "universal_scanner",
      "ultimate_sensor",
      "item_pedestal",
      "display_pedestal",
      "minecraft:note_block",
      "minecraft:jukebox",
      "minecraft:beacon",
      "minecraft:lectern",
    ],
    worldKeys: ["upw"],
    docs: "docs/unlimited-peripheral-works.md",
    commands:
      "upwSetBlock {x, y, z, name?, state?}, upwAddEntity {entity}, upwRemoveEntity {uuid?|type?}, upwSetPlayer {player, remove?}, " +
      "upwSetWorld {dayTime?, raining?, thundering?, biome?, light?, dimensions?}, upwTurnPage {peripheral, page}, upwPlaceBook {peripheral, book|null, player?}, " +
      "upwSetJukebox {peripheral, playing}, upwSetBeacon {peripheral, levels}",
  },
  {
    id: "metaphysics",
    name: "Metaphysics",
    versions: { "1.20.1": "0.0.6" },
    // no peripherals: the crypto and coord APIs are globals, there when the world has a `metaphysics` key
    types: [],
    worldKeys: ["metaphysics"],
    docs: "docs/metaphysics.md",
    commands:
      "metaPlayerDeath {name, source?, killer?, killerTags?}, metaSetPlayer {player, remove?}, metaSetBlock {x, y, z, name?, state?, explosionResistance?, solid?}, " +
      "metaAddEntity {entity}, metaRemoveEntity {uuid?|type?}, metaSetShips {ships, computerShip?, leaveShip?}",
  },
  {
    id: "some-peripherals",
    name: "Some Peripherals",
    // 1.18.2 only (its 1.19.2 branch has no release for a version the emulator runs)
    versions: { "1.18.2": "0.0.12" },
    types: ["sp_radar", "world_scanner", "ballistic_accelerator", "digitizer"],
    worldKeys: ["somePeripherals"],
    docs: "docs/some-peripherals.md",
    commands:
      "spSetPlayer {player, remove?}, spAddEntity {entity}, spRemoveEntity {uuid?|type?}, spSetBlock {x, y, z, name?, state?}, spSetShips {ships, computerShip?, leaveShip?}",
  },
  {
    id: "cloud-solutions",
    name: "SirEdvin's Cloud Solutions",
    versions: { "1.20.1": "1.20.1-0.3.4", "1.21.1": "1.21.1-0.3.4" },
    types: ["kv_storage", "crafka_broker", "statsd_bridge"],
    worldKeys: ["cloudSolutions"],
    docs: "docs/cloud-solutions.md",
    commands:
      "csPut {key, value|null, owner?, expire?} (another computer writes a key), csPublish {topic, message, owner?}, csSetOwnerOnline {online}",
  },
  {
    id: "cccbridge",
    name: "CC:C Bridge",
    versions: { "1.18.2": "1.5.1-forge", "1.20.1": "1.7.1", "1.21.1": "1.7.3" },
    types: [
      "animatronic",
      "redrouter",
      "scroller",
      "create_source",
      "create_target",
    ],
    worldKeys: ["cccbridge"],
    requires: ["create"],
    docs: "docs/cccbridge.md",
    commands:
      "cccbSetInput {peripheral, side, level}, cccbScroll {peripheral, value}, cccbLinkSource {peripheral, rows?, columns?, powered?, linked?, read?}, cccbLinkTarget {peripheral, lines, line?}",
  },
  {
    id: "create-cc-logistics",
    name: "Create: CC Total Logistics",
    // Create 6 logistics: there is no 1.18.2 release
    versions: { "1.20.1": "0.3.7", "1.21.1": "0.3.6" },
    types: [
      "stockcheckingblock",
      "packageport",
      "redstonerequester",
      "clipboard",
    ],
    worldKeys: ["createLogistics"],
    requires: ["create"],
    docs: "docs/create-cc-logistics.md",
    commands:
      "cclAddItems {network, link?, items}, cclRemoveItems {network, link?, name, count?}, cclSetLinkPower {network, link, power}, cclAddLink {network, link}, cclDeliverPackage {port, slot?, address?, items, final?}, cclTakePackage {port, slot}, cclSetClipboard {peripheral, pages}",
  },
  {
    id: "cc-liftlink",
    name: "CC: LiftLink",
    // there is no LiftLink for 1.18.2
    versions: { "1.20.1": "1.0.3", "1.21.1": "1.0.4-neoforge" },
    types: ["create_elevator"],
    worldKeys: ["liftlink"],
    requires: ["create"],
    docs: "docs/cc-liftlink.md",
    commands:
      "liftlinkAssemble {column}, liftlinkDisassemble {column}, liftlinkSetSpeed {column, rpm}, liftlinkPower {column, y, powered?}, liftlinkRename {column, y, shortName?, longName?}, liftlinkAddContact {column, y, shortName?, longName?}, liftlinkRemoveContact {column, y}",
  },
  {
    id: "cc-vs",
    name: "CC: VS",
    versions: { "1.18.2": "0.5.1", "1.20.1": "0.6.6" },
    types: [],
    worldKeys: ["ccvs"],
    docs: "docs/cc-vs.md",
    commands:
      "ccvsSetShip {ship|null}, ccvsSet {position?, shipyardPosition?, rotation?, velocity?, omega?, scale?, mass?, inertia?, static?, slug?, dimension?, joints?, constraints?, drag?}, ccvsCollision {phase, shipIdA?, shipIdB?, dimensionId?, contactPoints?} (1.20.1)",
  },
  {
    id: "cc-shops",
    name: "CC Shops",
    versions: { "1.18.2": "0.0.1", "1.20.1": "0.0.1-fixed" },
    types: ["shop"],
    worldKeys: ["ccShops"],
    docs: "docs/cc-shops.md",
    commands:
      "shopPlayerBuy {shop|pos, player, item, uuid?, creativeMode?}, shopSet {shop|pos, stock?, cost?, bar?, stored?, gains?, owner?}, shopSetPlayers {players?, entities?}",
  },
  // Mobs with a computer in them (mobs.ts): `world.android` and the like make the computer that mob.
  {
    id: "cc-androids",
    name: "CC: Androids",
    versions: { "1.20.1": "1.3.0" },
    types: [],
    worldKeys: ["android", "androidConfig"],
    docs: "docs/cc-androids.md",
    commands:
      "androidSetHand {hand?, item|null}, androidSetSlot {slot, item|null}, androidSetFuel {fuel}, androidSetHealth {health}, androidTeleport {x, y, z}, " +
      MOB_COMMANDS,
  },
  {
    id: "ac-drones",
    name: "AC-Drones",
    // the 1.21 jar asks for Minecraft 1.21 exactly (fabric.mod.json), so it does not load on 1.21.1
    versions: { "1.20.1": "1.20.1-alpha-7" },
    types: [],
    worldKeys: ["acDrone"],
    docs: "docs/ac-drones.md",
    commands:
      "acDroneSetSlot {slot, item|null}, acDroneSetAccessory {accessory|null, carrying?}, acDroneSetAttachment {slot, attachment|null}, acDroneTeleport {x, y, z, yaw?, pitch?}, " +
      MOB_COMMANDS,
  },
  {
    id: "cc-drones",
    name: "CC: Drones",
    // Modrinth lists 0.0.1 for 1.20.1 to 1.20.6; it is built for 1.20.1
    versions: { "1.20.1": "0.0.1" },
    types: ["droneworkbench"],
    worldKeys: ["drone"],
    docs: "docs/cc-drones.md",
    commands:
      "droneTeleport {x, y, z, yaw?, pitch?}, dronePush {x?, y?, z?}, " +
      MOB_COMMANDS,
  },
  {
    // A fork of CC: Drones with the same mod id, so a real pack has one or the other. The drone workbench is in
    // both: with both addons on it is the original's (docs/cc-drones.md).
    id: "cc-drones-plus",
    name: "CC: Drones+",
    versions: { "1.20.1": "0.2.0" },
    types: ["droneworkbench"],
    worldKeys: ["dronePlus"],
    docs: "docs/cc-drones.md",
    commands:
      "droneTeleport {x, y, z, yaw?, pitch?}, dronePush {x?, y?, z?}, droneAddUpgrade {upgrade}, droneRemoveUpgrades {}, " +
      MOB_COMMANDS,
  },
  {
    id: "advanced-math",
    name: "Advanced Math",
    // a datapack: one release for every Minecraft version
    versions: { "1.18.2": "0.3.7", "1.20.1": "0.3.7", "1.21.1": "0.3.7" },
    types: [],
    docs: "docs/advanced-math.md",
  },
  {
    id: "lectern-hub",
    name: "CC: Lectern Hub",
    // needs CC:Tweaked's pocket computers on lecterns (1.115+): 1.20.1 only
    versions: { "1.20.1": "1.0.0-1.115.0" },
    types: ["cc_lectern"],
    docs: "docs/lectern-hub.md",
    commands: "lhSetPocket {peripheral, on?, label?, id?}",
  },
  {
    id: "crickets-peripherals",
    name: "Cricket's Peripherals",
    versions: { "1.21.1": "0.1.1" },
    types: ["hard_drive", "data_coprocessor"],
    worldKeys: ["cricketsPeripherals"],
    docs: "docs/crickets-peripherals.md",
  },
  {
    id: "cctech",
    name: "CCTech",
    // only ever released for 1.18.2
    versions: { "1.18.2": "0.1.6" },
    types: [
      "cassette_deck",
      "reel_to_reel",
      "magnetic_card_reader",
      "card_writer",
    ],
    worldKeys: ["cctech"],
    docs: "docs/cctech.md",
    commands:
      "ctSetDoor {peripheral, open}, ctInsert {peripheral, tape?}, ctEject {peripheral}, ctInsertCard {peripheral, card?}, ctEjectCard {peripheral}, ctSwipe {peripheral, uuid?, contents?}",
  },
  {
    id: "embedded-computer",
    name: "Embedded Computer",
    versions: { "1.20.1": "0.6.0", "1.21.1": "1.3.0" },
    types: ["embeddedcomputer", "harddrive"],
    worldKeys: ["embeddedComputer"],
    docs: "docs/embedded-computer.md",
  },
  {
    id: "lakes-cc-additions",
    name: "Lake's CC Additions",
    versions: { "1.20.1": "1.7.0" },
    types: ["scanner"],
    worldKeys: ["lakesCcAdditions"],
    docs: "docs/lakes-cc-additions.md",
    commands:
      "lkSetItem {peripheral, item|null}, lkBiometric {peripheral, player?, uuid?}",
  },
  {
    id: "sc-peripherals",
    name: "SwitchCraft Peripherals",
    versions: { "1.20.1": "1.20.1-1.10.5" },
    types: ["3d_printer", "poster_printer"],
    worldKeys: ["scPeripherals"],
    docs: "docs/sc-peripherals.md",
    commands: "scSetItem {peripheral, slot, item|null}",
  },
  {
    id: "ccsecureboot",
    name: "CCSecureBoot",
    // needs CC:Tweaked 1.112+: not on 1.18.2
    versions: { "1.20.1": "1.0.2", "1.21.1": "1.0.2" },
    types: [],
    docs: "docs/ccsecureboot.md",
  },
  {
    id: "ccx",
    name: "CCX",
    // 1.21.1's CCX (0.3.x) is a separate code base with no public source: left out
    versions: { "1.20.1": "6.1.1" },
    types: ["pcie", "usb_port"],
    docs: "docs/ccx.md",
    commands:
      "ccxSetCard {peripheral, slot, card|null}, ccxSetUsb {peripheral, usb|null}",
  },
  {
    id: "directgpu",
    name: "CC: DirectGPU",
    // every release is NeoForge 1.21.1
    versions: { "1.21.1": "1.0.25" },
    types: ["directgpu"],
    docs: "docs/directgpu.md",
    commands: "dgMouse {peripheral, display, x, y, type?, button?}",
  },
  {
    id: "cide",
    name: "CIDE",
    versions: { "1.21.1": "1.1.0" },
    types: [],
    docs: "docs/cide.md",
  },
  {
    id: "plethora",
    name: "Plethora Peripherals",
    // Lemmmy / SwitchCraft's Fabric port; its releases are all for 1.19.x and 1.20.1
    versions: { "1.20.1": "1.20.1-1.13.0" },
    types: [
      "neuralInterface",
      "manipulator",
      "redstone_integrator",
      // modules as turtle upgrades: TurtleUpgradeModule names the peripheral after the module
      "plethora:scanner",
      "plethora:sensor",
      "plethora:introspection",
      "plethora:laser",
    ],
    worldKeys: ["plethora"],
    docs: "docs/plethora.md",
    commands:
      "plethoraSetModules {peripheral, modules}, plethoraAddEntity {entity}, plethoraMoveEntity {uuid, x?, y?, z?, yaw?, pitch?, health?}, plethoraRemoveEntity {uuid}, " +
      "plethoraSetPlayer {player, food?, saturation?, heldItemSlot?, health?, slot?, item?, ender?, feet?, legs?, chest?, head?, offhand?, sneaking?, gameMode?, ...}, " +
      "plethoraSetRedstoneInput {peripheral, side, level?, bundled?}, plethoraSetEnergy {peripheral, energy}; setPlayerPos moves the wearer",
  },
  {
    id: "cc-link",
    name: "CC: Link",
    // Forge 1.20.1 only
    versions: { "1.20.1": "6.2.1" },
    types: ["link_armor"],
    worldKeys: ["ccLink"],
    docs: "docs/cc-link.md",
    commands:
      'ccLinkSetPlayer {x?, y?, z?, yaw?, pitch?, food?, saturation?, ...}, ccLinkSetItem {inventory?: "inv"|"ender", slot, item|null}, ccLinkSetUpgrades {upgrades}, ccLinkSetWorld {raining?, thundering?, day?, canSeeSky?, biome?, dimension?}, ccLinkSetEntities {entities}, ccLinkChat {message}',
  },
  {
    id: "finer-peripherals",
    name: "Finer Peripherals",
    // Fabric 1.20.1 only. World types are the mod's block and upgrade ids; getType gives the mod's names
    versions: { "1.20.1": "1.20.1-0.6.1" },
    types: [
      "finerperipherals:chatbox",
      "finerperipherals:chatbox_pocket",
      "finerperipherals:chatbox_turtle",
      "finerperipherals:geoexplorer",
      "finerperipherals:geoexplorer_pocket",
      "finerperipherals:geoexplorer_turtle",
      "finerperipherals:player_finder",
      "finerperipherals:eventrelayer",
      "finerperipherals:eventrelayer_pocket",
      "finerperipherals:eventrelayer_turtle",
      "finerperipherals:holoitemdisplay",
      "finerperipherals:compass_turtle",
      "finerperipherals:enderchest_turtle",
      "finerperipherals:debug_pocket",
    ],
    worldKeys: ["finerPeripherals"],
    docs: "docs/finer-peripherals.md",
    commands:
      "finerChat {player, message}, finerSetEnder {slot, item|null}, finerSetOwner {owner}",
  },
  {
    id: "ducky-peripherals",
    name: "Ducky Peripherals",
    // 1.18.2 had only a Fabric release (for CC: Restitched); 1.21.1 has none
    versions: { "1.18.2": "1.0.2", "1.20.1": "1.20.1-1.3.1" },
    types: ["entity_detector", "weather_machine", "keyboard", "sculkophone"],
    worldKeys: ["duckyPeripherals"],
    docs: "docs/ducky-peripherals.md",
    commands:
      "duckyAddEntity {peripheral?, entity}, duckyMoveEntity {peripheral?, entity, x?, y?, z?}, duckyRemoveEntity {peripheral?, entity}, duckySetWeather {raining?, thundering?}, duckySetBiome {peripheral?, biome?, temperature?, precipitation?}, " +
      "duckyKey/duckyKeyUp {peripheral?, key, repeat?}, duckyChar {char}, duckyType {text}, duckyKeyboardEvent {event}, duckyVibration {peripheral?, event, distance}, duckyStepOn {peripheral?}",
  },
  {
    id: "more-peripherals",
    name: "More Peripherals",
    // Forge 1.20.1 only here: the 1.18.2 line stopped at 1.18.2-1.8 with a smaller API that is not emulated
    versions: { "1.20.1": "1.20.1-1.13.0" },
    types: [
      "xp_collector",
      "xp_bottler",
      "crafter",
      "loom_interface",
      "magnetic_card_manipulator",
      "beehive_interface",
      "trading_interface",
      "spawner_interface",
      "player_interface",
      "ender_chest_interface",
      // its "scanner" (Classic Peripherals has one too); peripheral.getType says "scanner"
      "moreperipherals:scanner",
      "grinder",
    ],
    worldKeys: ["morePeripherals"],
    docs: "docs/more-peripherals.md",
    commands:
      "mpAddXP {peripheral, amount}, mpSetCard {peripheral, card|null}, mpSwipeCard {peripheral, data?}, mpSetBeehive {peripheral, beehive?, beehives?}, mpSetVillager {peripheral, villager|null}, " +
      "mpSetSpawner {peripheral, mob?|false, spawners?}, mpSetPlayerCard {peripheral, card|null}, mpSetPlayer {player, inventory?, enderChest?, selected?, food?, saturation?, effects?, online?, dimension?}, mpSetScannerItem {peripheral, item|null}",
  },
  {
    id: "classic-peripherals",
    name: "Classic Peripherals",
    // 0.5.1 is the last 1.20.1 release (Fabric only); 0.6.x is 1.21.1 only; nothing for 1.18.2
    versions: { "1.20.1": "0.5.1", "1.21.1": "0.6.6" },
    types: [
      "cryptographic_accelerator",
      "radio_tower",
      "nfc_reader",
      "rfid_scanner",
      // its "scanner" (More Peripherals has one too); peripheral.getType says "scanner"
      "classicperipherals:scanner",
    ],
    worldKeys: ["classicPeripherals"],
    docs: "docs/classic-peripherals.md",
    commands:
      "cpNfcTap {peripheral, card}, cpNfcTapPocket {peripheral, self?|data?, privateKey?}, cpNfcCardToPocket {card}, cpRadioReceive {frequency, data, x?, y?, z?, dimension?, range?}, " +
      "cpSetRadio {peripheral, valid?, height?, complete?, x?, y?, z?}, cpSetEntities {entities}, cpSetPrintout {peripheral, printout|null}",
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

/**
 * Why an addon cannot be on for a Minecraft version, and what to do: the versions the mod has a release for, and the
 * three ways to pick one. Every addon without a release somewhere says it the same way.
 */
export function noReleaseMessage(addon: AddonInfo, mc: string): string {
  const has = Object.keys(addon.versions);
  const pick = has.at(-1) ?? DEFAULT_MC;
  return (
    `${addon.name} (addon "${addon.id}") has no release for Minecraft ${mc}; it has ${has
      .map((v) => `${v} (${addon.name} ${addon.versions[v]})`)
      .join(", ")}. ` +
    `Run this world on one of those: world.version "${pick}", --mc ${pick} on the command line, or ` +
    `CRAFTOS_VERSION=${pick} for every computer; or leave ${addon.name} out`
  );
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
      `${missing.map((id) => noReleaseMessage(BY_ID.get(id)!, mc)).join(". ")}. ` +
        `Addons on ${mc}: ${
          addonsFor(mc)
            .map((a) => a.id)
            .join(", ") || "none"
        }.`,
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
  // what uses an addon with no release on this version, per addon, so each gets one full explanation
  const absent = new Map<AddonInfo, string[]>();
  const noRelease = (addon: AddonInfo, what: string): void => {
    absent.set(addon, [...(absent.get(addon) ?? []), what]);
  };
  for (const p of world.peripherals ?? []) {
    // a type two mods share (a fork keeps its parent's blocks) is fine while either of them is on
    const owners = p.type
      ? ADDONS.filter((a) => a.types.includes(p.type!))
      : [];
    const addon =
      owners.find((a) => addonVersion(a, mc) !== undefined) ?? owners[0];
    if (addon && !owners.some((a) => on.has(a.id))) {
      const what = `peripheral ${JSON.stringify(p.name)} is a ${p.type} from ${addon.name} (addon "${addon.id}")`;
      if (addonVersion(addon, mc) === undefined)
        noRelease(addon, `peripheral ${JSON.stringify(p.name)} (${p.type})`);
      else problems.push(what);
    }
  }
  for (const addon of ADDONS) {
    if (on.has(addon.id)) continue;
    for (const key of addon.worldKeys ?? []) {
      if (world[key] !== undefined) {
        const what = `world.${key} configures ${addon.name} (addon "${addon.id}")`;
        if (addonVersion(addon, mc) === undefined)
          noRelease(addon, `world.${key}`);
        else problems.push(what);
      }
    }
  }
  if (absent.size > 0) {
    throw new Error(
      [...absent]
        .map(
          ([addon, uses]) =>
            `${uses.join(" and ")}: ${noReleaseMessage(addon, mc)}.`,
        )
        .join(" "),
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
