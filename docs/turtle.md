# Turtles

A world with a `turtle` entry makes the computer a CC:Tweaked 1.101.3 turtle. The `turtle` API is there, along
with `turtle.native`, the ROM's turtle programs (`go`, `tunnel`, `excavate`, `refuel`, `craft`, ...) and a 39x13
terminal. A normal turtle has no colour; an advanced one does. The turtle stands in a block world made of
`blocks`, `fills` and `ground`; everything else is air.

The rules come from the mod's source. [turtle/cct-1.101.3-turtle-rules.md](turtle/cct-1.101.3-turtle-rules.md)
lists each one with its Java line. Block and item data comes from the real game jars (vanilla 1.18.2 and the 262
mods in the pack), plus the game's own block report. Known differences are in
[conformance/emulator-vs-real-deviations.md](conformance/emulator-vs-real-deviations.md) (rows 61-76).

## A world

```json
{
  "turtle": {
    "x": 0,
    "y": 64,
    "z": 0,
    "facing": "north",
    "fuel": 500,
    "advanced": false,
    "right": "minecraft:diamond_pickaxe",
    "left": "computercraft:wireless_modem_normal",
    "selected": 1,
    "inventory": { "1": { "name": "minecraft:cobblestone", "count": 64 } }
  },
  "ground": {
    "y": 63,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "fills": [
    { "from": [5, 64, 5], "to": [9, 66, 9], "name": "minecraft:oak_planks" }
  ],
  "blocks": [
    {
      "x": 0,
      "y": 64,
      "z": -1,
      "name": "minecraft:chest",
      "items": { "1": { "name": "minecraft:coal", "count": 16 } }
    },
    {
      "x": 1,
      "y": 64,
      "z": 0,
      "name": "minecraft:oak_stairs",
      "state": { "facing": "east" }
    },
    { "x": 7, "y": 65, "z": 7, "name": "minecraft:air" },
    {
      "x": -1,
      "y": 64,
      "z": 0,
      "name": "minecraft:stone",
      "peripheral": { "type": "playerDetector" }
    }
  ],
  "items": [
    { "x": 0, "y": 64, "z": 2, "name": "minecraft:diamond", "count": 3 }
  ],
  "entities": [
    {
      "type": "minecraft:zombie",
      "x": 0.5,
      "y": 64,
      "z": -1.5,
      "health": 20,
      "drops": [{ "name": "minecraft:rotten_flesh", "count": 1 }]
    }
  ],
  "turtleConfig": { "needFuel": true },
  "gameData": {
    "maxCount": { "mymod:thing": 16 },
    "fuel": { "mymod:fuel_rod": 3200 }
  }
}
```

- **Coordinates** are block positions. North is -z and east is +x. Seen from a turtle facing north, front is
  `z-1`, back `z+1`, left `x-1`, right `x+1`, top `y+1` and bottom `y-1`.
- **`blocks`** cover `fills`, and later fills cover earlier ones. `ground` is everything at or below its `y`. Give a
  block `"minecraft:air"` to cut a hole.
- **Block `state`** values are strings, as F3 shows them. Leave a property out and it takes the block's default: the
  game's own for vanilla blocks, a good guess for modded ones.
- **Containers** (chest, barrel, hopper, dispenser, dropper, furnaces, brewing stand, shulker boxes, or any block
  with `items` or `size`) hold real inventories. The turtle reaches them with drop and suck, and they show up as
  `inventory` peripherals on its sides. A furnace is sided, as in game: the top reaches the input, the sides the
  fuel and the bottom the output.
- **`peripheral`** on a block makes it any virtual peripheral from `peripherals` (no name needed). The turtle sees
  it on whichever side the block is.
- **The defaults** are the pack's server config: fuel is needed, limits are 20000 and 100000, and pushing is on.

## What is emulated

All of `TurtleAPI` with its exact argument errors and messages. The command queue runs one command per server tick
on a fixed 50 ms grid, holds the next command 8 ticks after an animation, and refuses the 18th waiting command.
Events that arrive while a call waits are lost, as in game. `turtle_inventory` fires at the end of a tick.

- **Movement:** obstruction is checked before fuel. The turtle walks into air, liquids and replaceable plants, snow
  and fire, which then vanish without drops. `Too high` and `Too low` follow the build limits. It pushes mobs out
  of the way.
- **Dig:** drops come from the real loot tables with the tool the turtle holds. Torches and plants on the broken
  block pop off, and container contents spill. Everything is captured from the selected slot on; what does not fit
  is thrown behind the turtle. A shovel flattens and a hoe tills before they dig. Tool tags are as in CC. An axe
  turtle can dig stone but gets nothing. Sand and gravel fall into the gap.
- **Place:** the four deploy attempts in CC's order, which decide the clicked face and how the fake player looks.
  Facing, axis, half, slab type, rotation and waterlogging follow vanilla placement. So do doors, beds, wall and
  floor torches, signs (with text) and banners, and survival checks such as a torch needing support. Buckets pick
  up and pour, flint and steel lights fires, and bone meal grows crops.
- **Inventory:** drop, suck (from inventories or from item entities on the ground), transferTo, compareTo,
  getItemSpace (real stack sizes), getItemDetail (basic is `name` and `count` only; detailed adds the real display
  name, tags, durability and so on), compare, inspect (real block tags) and detect.
- **Refuel** uses furnace burn times (coal 80, lava 1000 with the bucket returned, and so on).
- **Upgrades:** the five diamond tools, wireless and ender modems (working modems on the network), speaker, and
  crafting table. `turtle.craft` uses the jars' shaped and shapeless recipes, with tags and remainders. Equipping
  swaps items as in CC.
- **Peripherals on the sides** follow the turtle as it moves, turns and equips, with `peripheral` and
  `peripheral_detach` events.
- **Attack:** damage 3, 6 or 9 by tool. Within 10 ticks, a hit that is not harder than the last is ignored. A mob
  that dies leaves its `drops`.

## What a turtle builds comes alive

The computers in a block world share it. Every block one of them changes reaches the others, and the runner keeps
the master copy (`packages/runner/src/blockworld.ts`). So a turtle can build a working computer setup:

- **Computer blocks** get a computer id on their first boot (`getID` is -1 before). Next to a computer or turtle they are `computer` peripherals
  (`turnOn`, `shutdown`, `reboot`, `getID`, `isOn`, `getLabel`); turtles next to them are `turtle` peripherals.
  `turnOn` starts that computer's own emulator. It starts empty, as a new computer does. It runs `startup` from a
  disk, keeps its files across a shutdown, and its label shows to the computers around it.
- **Disk drives** take a floppy dropped in by a turtle (`computercraft:disk` with an optional `diskId`). The disk
  mounts in every computer next to the drive, and all of them see the same files. `world.disks` puts files on
  disks before the run: `{ "7": { "startup.lua": "..." } }`.
- **Monitors** join into walls as CC grows and splits them (up to 8x6), and a wall is one screen for every
  computer on it; normal monitors draw grey. A
  computer next to any block of the wall gets it. Mind the placement rules (spec 5.3): with nothing to click 2
  blocks ahead, a turtle puts a monitor onto the block below it, looking down, and the monitor ends up lying face
  up. Build against a backing wall.
- **Modem blocks** (wireless and ender) on a computer's side are its modems; **speaker blocks** are speakers.
  **Chests** are shared: what one computer takes out is gone for the others.

`craftos_run` returns the computers that were turned on under `computers` (name, id, position, screens, state).
`packages/runner/src/turtle-build.integration.test.ts` has a turtle that places a computer and a drive, inserts an
installer floppy, turns the computer on and checks that it installed itself. Wired modems and cables placed as
blocks form networks, a placed turtle boots like a computer, and sessions host block worlds too
(`turtle-host.integration.test.ts`).

## What a test sees

`state.json` (`sim` in run results) holds:

- `turtle`: position, facing, fuel, selected slot, slots and upgrades.
- `blocks`: every block the sim changed, keyed `"x,y,z"` to `{ name, state, items }`; `{}` means air.
- `droppedItems`: item stacks lying in the world.

A reboot keeps all three. `packages/runner/src/turtle.integration.test.ts` has worked examples.

## Data

`tools/turtledata/extract.py` regenerates `rom-overlay/rom/ccsim/turtle/data/` from the game jars, one file per mod
namespace plus the combined `_recipes.lua`, `_cooking.lua` and `_tag_members.lua`. It also runs Minecraft's data
generator for the vanilla block report (needs `java` on PATH). Rerun it after the pack changes, then copy the overlay
into the ROM (`scripts/build-rom.mjs`, or copy `rom-overlay/rom` over `rom/cc-1.101.3/rom`).
`gameData` in a world adds to or overrides any of it.

There are two data sets:

- **Pack** (default): vanilla 1.18.2, Forge and every jar in the instance's `mods/`. Most mod data is All Rights Reserved,
  so keep a pack set to yourself. `python -I tools/turtledata/extract.py --instance <dir>` writes it to the overlay.
- **Vanilla**: vanilla, Forge and the CC:Tweaked jar (`cc-tweaked-1.18.2-1.101.3.jar`) only, safe to publish. Even
  `minecraft.lua` and the `_*.lua` files carry mod tags and recipes in the pack set, so the public set is generated,
  never filtered out of it: `python -I tools/turtledata/extract.py --vanilla --out .public-data/turtle-data`
  (`/.public-data/` is git-ignored).

`--out DIR` picks the output directory (every `*.lua` in it is deleted first). The jars default to
`%APPDATA%\PrismLauncher`; override them with `--instance` (the instance's `minecraft` dir), `--libraries`, `--client-jar`, `--forge-jar` and `--cc-jar`, or the
`TURTLEDATA_INSTANCE`, `TURTLEDATA_LIBRARIES`, `TURTLEDATA_CLIENT_JAR`, `TURTLEDATA_FORGE_JAR` and `TURTLEDATA_CC_JAR`
environment variables. A missing jar or directory stops the run with the flag to fix.

To run the emulator on the vanilla set, copy `rom/cc-1.101.3` somewhere, replace its `rom/ccsim/turtle/data` with the
vanilla set, and point `CRAFTOS_ROM` at the copy. The turtle suites (`turtle`, `turtle-build`, `turtle-host`,
`turtle-living` integration tests) pass on both sets.

### One set per Minecraft version

Each Minecraft version has its own set, picked by the world's version (`core.version.blockData`, from
`packages/runner/src/versions.ts`):

| Version | Folder                           | Made from                                                           | Size                       |
| ------- | -------------------------------- | ------------------------------------------------------------------- | -------------------------- |
| 1.18.2  | `turtle/data/`                   | the pack (private) or vanilla, Forge 40.2.21, CC 1.101.3            | 20 MB pack, 1.1 MB vanilla |
| 1.20.1  | `turtle/data/1.20.1/`            | vanilla only: Minecraft 1.20.1, Forge 47.4.28, CC 1.121.0 (forge)   | 1.4 MB                     |
| 1.21.1  | none yet: falls back to 1.18.2's | (1.21 renames the data folders and gives recipe results components) |                            |

1.18.2's folder and paths are what they always were. `extract.py --mc 1.20.1` makes the 1.20.1 set; there is no 1.20.1
pack instance, so it is vanilla (`--vanilla` is implied) and the same set ships in the public copy
(`.public-data/turtle-data/1.20.1/`):

```sh
python -I tools/turtledata/extract.py --mc 1.20.1 --jars <scratch dir> --download
python -I tools/turtledata/extract.py --mc 1.20.1 --jars <scratch dir> --out .public-data/turtle-data/1.20.1
```

`--download` fetches into `--jars` (once; each is hash-checked): the client and server jars and the server mappings from
Mojang's version manifest, Forge's universal jar from its maven, CC:Tweaked from Modrinth (the pin in `versions.ts`).
The jars are only read as data. The block report comes from the server jar's bundler, so no launcher libraries are
needed. The 1.20.1 set has two things the 1.18.2 sets do not, read from the game's own code with Mojang's mappings:
`mapColours` in each namespace file (every block state's `MapColor`, compacted to the properties that change it) and
`_compostables.lua` (`ComposterBlock.COMPOSTABLES`). CC:Tweaked's own blocks take their map colour from its
`ModRegistry` (a table in `extract.py`). 1.20.1's data folders and JSON are 1.18.2's (`loot_tables`, `recipes`,
`tags/blocks`, `tags/items`); its recipes add `category` and `show_notification`, which are ignored, and its smithing
recipes are not crafting recipes. Every loot function, condition and entry type in the 1.20.1 block loot tables is
one `loot.lua` already knows.

## Minecraft versions

A world's `version` (or `CRAFTOS_VERSION`) picks Minecraft 1.18.2 (CC:Tweaked 1.101.3, the default), 1.20.1 or
1.21.1 (both CC:Tweaked 1.121.0). Everything 1.121.0 does differently is behind `core.cc121`, so 1.18.2 is untouched.
Each is from CC:Tweaked's 1.121.0 source (tag `v1.20.1-1.121.0`) and tested in
`packages/runner/src/turtle-cc121.integration.test.ts`; the turtle suites also run whole on 1.20.1
(`turtle-1.20.1.integration.test.ts`).

- `turtle.getEquippedLeft()` / `getEquippedRight()` (1.116.0): the full item details of the upgrade, or nil. They
  wait for a server tick, like `getItemDetail(slot, true)`.
- **Upgrades keep their item.** `equipLeft`/`Right` store the very item and give it back unequipped (name, NBT).
  `TurtleTool.isItemSuitable` with the vanilla tools' defaults refuses a damaged or enchanted tool but takes a renamed
  one (1.101.3 refuses renamed tools too). An old upgrade that does not fit goes behind the turtle
  (`TurtleUtil.storeItemOrDrop`), as do `turtle.craft` results that do not fit; 1.101.3 dropped both in front.
- **`turtle.suck` from an inventory** goes slot by slot (`ForgeItemContainer.moveTo`): the first slot whose items fit
  moves, at most a stack and only from that slot. A slot that cannot fit is passed over, so a full turtle still takes
  what it has room for; "No space for items" only when nothing fits. 1.101.3 took the first stack's item from every
  slot holding it, and failed when that item had no room.
- **`turtle.place` right-clicks** the block straight in front first when it is in `#computercraft:turtle_can_use`
  (`turtle/canuse.lua`): a composter takes compostables (`ComposterBlock.addItem` with the jar's chances; level 7 waits
  20 ticks for 8) and gives bone meal at 8; cauldrons take and give water, lava and powder snow buckets and water
  bottles (`CauldronInteraction`); a full beehive gives honey to a glass bottle or honeycomb to shears.
- **Item and block details** (`turtle.getItemDetail(slot, true)`, `getEquipped*`, `inspect`, an inventory's
  `getItemDetail`) gain `mapColour` and `mapColor` (RGB, from the item's block for items; none for `MapColor.NONE`),
  and `itemGroups` is always empty. `potionEffects` shows when the world gives it on the item.
- **`redstone_relay`** (1.114.0) is a peripheral: CC's `RedstoneMethods` on its own sides. Its inputs come from the
  world (`blockEntity.inputs`, `bundledInputs`, or `inputs` on a `peripherals` entry); its outputs land in state.json.
- **Speaker `playSound`**: one sound per server tick (a second returns false), music disc sounds return false, names
  over 512 characters and malformed names raise `bad argument #1 (...)`.

What is not matched is in `docs/conformance/emulator-vs-real-deviations.md`.
