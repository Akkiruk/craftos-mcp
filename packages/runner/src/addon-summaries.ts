/**
 * One plain line per mod (addons.ts ADDONS): what it gives a computer, for a person picking mods from a list (the
 * desktop app's checklist). Kept apart from ADDONS so that list stays about ids, versions and types.
 * addon-summaries.test.ts checks every addon has one.
 */
export const ADDON_SUMMARIES: Readonly<Record<string, string>> = {
  "advanced-peripherals":
    "Player detector, chat box, ME and RS bridges, geo scanner, inventory manager and more.",
  mekanism:
    "Machines, QIO storage, induction matrix, boiler and the other multiblocks as peripherals.",
  "mekanism-generators":
    "Fission and fusion reactors, turbines and the generators.",
  create:
    "Display links, train stations, speedometers, stress gauges, speed controllers and gearshifts.",
  "create-additions":
    "Electric motor, accumulator, redstone relay and the digital adapter for Create.",
  "toms-peripherals":
    "A pixel GPU for monitors, a keyboard, a redstone port and a watchdog timer.",
  "bigger-reactors": "Bigger Reactors' reactors and turbines.",
  "extreme-reactors": "Extreme Reactors' reactors and turbines.",
  "unlimited-peripheral-works":
    "Universal scanner, sensors, pedestals, and note blocks and jukeboxes as peripherals.",
  metaphysics: "Extra APIs for computers on Minecraft 1.20.1.",
  "some-peripherals":
    "Radar, world scanner, ballistic accelerator and digitizer.",
  "cloud-solutions":
    "Key-value storage, a message broker and a statsd bridge for computers.",
  cccbridge:
    "Animatronics, the RedRouter, scrollers, and Create display sources and targets.",
  "create-cc-logistics":
    "Create's stock keeping and packages: stock checker, package port, redstone requester.",
  "cc-liftlink": "Control Create elevators from a computer.",
  "cc-vs":
    "Valkyrien Skies ships: APIs to read and steer the ship a computer is on.",
  "cc-shops": "Simple Shops' shop block as a peripheral.",
  "cc-androids":
    "Androids: mobs with a computer inside that walk, mine and fight.",
  "ac-drones": "Drones: flying mobs with a computer inside.",
  "cc-drones": "Drones you program, and their workbench.",
  "cc-drones-plus": "CC: Drones with the fork's extra features.",
  "advanced-math":
    "Matrix, quaternion and other math libraries on every computer.",
  "lectern-hub": "Read and write books on lecterns.",
  "crickets-peripherals": "A hard drive and a data coprocessor.",
  cctech:
    "Cassette decks, reel-to-reel tape, and magnetic card readers and writers.",
  "embedded-computer": "A small embedded computer and a hard drive.",
  "lakes-cc-additions": "A scanner block.",
  "sc-peripherals": "SwitchCraft's 3D printer and poster printer.",
  ccsecureboot: "Secure boot for computers: signed startup files.",
  ccx: "PCIe cards and USB ports for computers.",
  directgpu: "A fast pixel GPU for monitors.",
  cide: "CIDE's debugging API for computers.",
  plethora:
    "Neural interface, manipulator, scanner, sensor and the other Plethora modules.",
  "cc-link": "Link armor: a computer link you wear.",
  "finer-peripherals":
    "A chat box and a geo explorer, also for pockets and turtles.",
  "ducky-peripherals":
    "Entity detector, weather machine, keyboard and sculkophone.",
  "more-peripherals":
    "XP collector and bottler, crafter, loom and beehive interfaces, card manipulator.",
  "classic-peripherals":
    "Cryptographic accelerator, radio tower, NFC reader and RFID scanner.",
};

/** The plain line for a mod, or "" when it has none. */
export function addonSummary(id: string): string {
  return ADDON_SUMMARIES[id] ?? "";
}
