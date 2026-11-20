# Advanced Peripherals emulation

Every Advanced Peripherals (AP) peripheral that is **enabled in your server's config** is
emulated in Lua (`rom-overlay/rom/ccsim/ap/`), with the full method surface, argument checking,
return values, error strings, cooldowns and config values of the real mod.

This page describes 0.7.31r, the 1.18.2 release. On 1.20.1 the emulator follows 0.7.48r and on 1.21.1 0.7.62b
(snake_case types such as `player_detector`, no Redstone Integrator, rewritten bridges, new events):
[advanced-peripherals-versions.md](advanced-peripherals-versions.md) lists every difference.

## What "100%" means here

- **Surface: complete.** A test (`ap.integration.test.ts`, "API surface") asserts that every
  `@LuaFunction` name, aliases included, of each enabled peripheral exists, plus the methods
  AP adds to all peripherals (`getName`, `getConfiguration`) and the operation/fuel plugin
  methods. That is 134 peripheral methods across 9 types. All of them were also confirmed to
  exist in the 0.7.31r jar your pack ships.
- **Behaviour: written from source, not from memory.** Semantics come from the 0.7.30r source
  (the newest 1.18.2 tag; there is no tag for 0.7.31r). Where I could not confirm 0.7.31r
  behaves the same I say so below.
- **Data: a fixture world, not a real Minecraft server.** Items, fluids, players, energy and
  the environment are whatever you put in the world. Nothing is simulated beyond moving
  items and fluids, so results are only as realistic as the fixture.

## Which peripherals exist

Decided by your instance's `peripherals.toml`:

| Peripheral                                                                                                               | Emulated  | Why                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------- |
| `playerDetector`, `chatBox`, `energyDetector`, `environmentDetector`, `redstoneIntegrator`, `nbtStorage`, `arController` | Yes       | enabled                                                           |
| `meBridge` (AE2 11.7.6 is installed), `rsBridge` (Refined Storage 1.10.6 is installed)                                   | Yes       | enabled                                                           |
| `blockReader`, `geoScanner`, `inventoryManager`, chunky turtle (`chunky`)                                                | See below | see "Geo scanner, block reader, inventory manager, chunky turtle" |
| `colonyIntegrator`                                                                                                       | No        | enabled in config but MineColonies is not installed               |
| turtle / pocket / automata cores, `compass`, pocket geo scanner                                                          | No        | turtle and pocket peripherals                                     |
| `beacon`, `note_block` integrations (AP adds these to vanilla blocks)                                                    | No        | not used by your scripts; not built                               |

All four are enabled in AP's default config and emulated. With the opt-in vhcctweaks addon on ([vhcctweaks.md](vhcctweaks.md)) none of them exists: the server it was measured on turns them off.

`worlds/ap-extra-demo.json` has all four.

## Fixtures

Every peripheral is a `peripherals` entry in the world: `{ "name": ..., "type": ..., ... }`
with a position (`x`, `y`, `z`, `dimension`) and a `customName` for `getName()`.

- **playerDetector**: players come from `players` (position, dimension, online).
- **chatBox**: messages land in the chat log (`craftos_sim_state`).
- **energyDetector**: `transferRate`, `transferRateLimit`.
- **redstoneIntegrator**: `inputs: { south: 9 }`, `orientation: { front: "north" }`.
- **nbtStorage**: `stored`.
- **environmentDetector**: world-level `environment` (`time`, `raining`, `thunder`, `biome`,
  `skyLight`, `blockLight`, `moonPhase`, `dimensions`) and `entities`.
- **meBridge / rsBridge**: `items`, `fluids`, `craftableItems`, `craftableFluids`, `energy`,
  `adjacent` (side to inventory name), plus ME `cells` and `cpus`, RS `patterns` and `storage`.
- **inventories** (`minecraft:chest`, ...) and **`fluid_storage`** tanks are the targets of bridge transfers.
- **arController**: the canvas is recorded (`state.peripherals.<name>.canvas`).

Runtime commands (`craftos_sim_command`): `setEnergyTransferRate`, `setRedstoneInput`,
`completeCraft`, `setNetworkConnected`, `setEnvironment`, `addEntity`, `chat`, `playerClick`,

`setItem`.

`worlds/advanced-peripherals-demo.json` has one of every peripheral.

## Events

Only what the source fires: `chat` (`username, message, uuid, isHidden`) to chat boxes,
`playerClick` (`username`) to player detectors, and `crafting` (`success, message`) from

`meBridge.craftItem`. A message starting with `$` arrives with its `$` signs removed and `isHidden` true.
There are no `playerJoin` / `playerLeave` events in this AP version. With the vhcctweaks addon on, its changes apply instead: no hidden `$` channel, a 1 s chat cooldown, the two `sendFormatted*` methods disabled, and `isSlimeChunk()` always `false`.

## Behaviours worth knowing (all from the source)

- Ranges are **boxes**, not spheres, centred on the detector block; the maximum edge is
  exclusive; players in another dimension never match. `getPlayersInCubic(x, y, z)` uses
  extents of `2x`, `2y`, `2z`.
- `getPlayerPos` returns `{}` for unknown, offline or out-of-dimension players, and reports
  `yaw`, `pitch`, `dimension` and `eyeHeight` as well as the floored coordinates.

- Chat: a 100 ms cooldown (`chatMessage is on cooldown`); unknown players give `nil, "incorrect player name/uuid"`; the two `sendFormatted*` methods take a JSON text component.

- `environmentDetector.scanEntities` has a 2 s cooldown, refuses radius > 16 with
  `Radius is exceed max value`, and costs no fuel because powered peripherals are off.

- `isSlimeChunk()` is vanilla's answer for the detector's chunk and `environment.seed` (default 0).

- ME bridge: `listCraftableItems` reproduces AE2/AP's odd behaviour (an unstocked craftable is
  only listed once a stored non-craftable key is seen). Unknown items from `getItem` return `{}`.
  Exporting to a side with no inventory raises a null-pointer error, as the real mod does.
  RS bridge: the same situation returns `0, "INVALID_TARGET"`.
- `getItem` on an ME bridge reports `nbt` as AE2's key tag (`{ id = <name>, tag = <nbt> }`); the
  RS bridge reports plain NBT, or `nil` when there is none, and `tags` is `nil` when empty.
- Fingerprints are `md5(nbt string + name + display name)` as in AP. That is exact for stacks
  without NBT (the MD5 matches Python's). With NBT the exact Minecraft tag formatting is not
  reproduced, so give such items an explicit `fingerprint`.

## Approximations and known gaps

- **Version:** source is 0.7.30r; the pack has 0.7.31r. All method names match. Behaviour changes
  between the two, if any, are not known. Other Minecraft versions: see
  [advanced-peripherals-versions.md](advanced-peripherals-versions.md).
- **Crafting:** `craftItem` records a job and fires the `crafting` event; nothing is produced
  until you send `completeCraft`. CPU progress, patterns' real resource checks and RS
  calculation results (only `craftResult` in the fixture) are not simulated.
- **Display names** default to a title-cased registry name (`minecraft:iron_ingot` becomes
  `Iron Ingot`); real names come from language files. Set `displayName` when it matters.
- **Tags** come from the fixture (`tags: ["minecraft:item/forge:ingots/gold"]`), not from a registry.
- **nbtStorage:** `writeJson` accepts stringified NBT (SNBT) with a simplified parser; error
  messages are approximate, and values round-trip as plain Lua numbers/strings/tables rather
  than typed NBT.
- **chatBox `range`** uses an inclusive box; the real code uses the same exclusive-edge box as
  the detector.
- **arController** records draw calls; nothing is rendered and there is no goggles player.
- **ME storage totals** use fixture cells (`usedBytes` or the AP formula over the fixture items).
- **On a wired network** (`wired[].peripherals`) one computer on the cable holds each peripheral and the others call it
  through a relay, so every computer sees the same chest, as in the real game.

## Geo scanner, block reader, inventory manager, chunky turtle

Written in `rom-overlay/rom/ccsim/ap/extra.lua` from the 1.18.2-0.7.30r source and checked against the 0.7.31r jar
(same methods, signatures and strings). Tests: `packages/runner/src/ap-extra.integration.test.ts`.

### Where the blocks come from

The geo scanner and the block reader look at real blocks: the turtle block world (`blocks`, `fills`, `ground`, see
docs/turtle.md) with the turtle's game data, so they see what a turtle placed or dug. A plain computer gets the
same world from its world file. A peripheral in a world with no blocks at all can carry its own `blocks`, `fills`
and `ground`. A block reader can instead take `block: { name, blockEntity, items }`, the block in front of it.

In a turtle world the blocks `advancedperipherals:geo_scanner`, `advancedperipherals:block_reader` and
`advancedperipherals:inventory_manager` are those peripherals on the turtle's sides, wherever they came from.
A turtle can equip `advancedperipherals:geo_scanner` (a `geoScanner`) and `advancedperipherals:chunk_controller`
(a `chunky`).

### Fixtures

| Field         | On                            | Meaning                                                                                                 |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `x`, `y`, `z` | all three blocks              | where the block stands (default 0, 64, 0); a block in a turtle world uses its own position              |
| `orientation` | blockReader, inventoryManager | `"north_up"` (front, then top) or `{ front, top }`; default the block's `orientation` state, else north |
| `blocks` ...  | geoScanner, blockReader       | its own block world, used only when the world has no blocks                                             |
| `block`       | blockReader                   | the block in front: `{ name, blockEntity?, items? }`                                                    |
| `energy`      | geoScanner                    | FE stored, used only when `ap.config.enablePoweredPeripherals` is true                                  |
| `owner`       | inventoryManager              | the player name on its memory card; leave it out for no card                                            |
| `adjacent`    | inventoryManager              | side or direction to a chest in `peripherals`; otherwise the container beside it in the block world     |

Players' inventories are under `ap.players`, by name: `inventory` (slot 0-35 to item), `armor` (`feet`, `legs`,
`chest`, `head` to item), `offhand` and `selected` (the held hotbar slot, 0-8). Items are as in chests, plus
`displayName`, `tags`, `nbt` (a table) and `fingerprint` if you want them exact.

Sim commands: `setPlayerItem {player, slot, item|null}` (slot 0-35, 36 the off hand, 100-103 boots to helmet) or
`{player, selected}`, and `setMemoryCard {peripheral, owner|null}`. State: `state.peripherals.<manager>` holds the
card's `owner` and that player's inventory (`player`), and `state.peripherals.<side>.loadedChunk` the chunky
turtle's chunk. A player's inventory survives a reboot.

### Behaviour (all from the source)

- **Waits:** `cost`, `getOwner`, `getName` and `getConfiguration` run on the computer thread. Everything else waits
  for the server tick and loses the events that arrive meanwhile.
- **Geo scanner** (`GeoScannerPeripheral.java`): `scan(radius)` (line 126) walks a **cube** of side `2r+1`, x then
  y then z (`ScanUtils.java` line 22), and returns every non-air block as `{ x, y, z, name, tags }`, relative to
  the scanner and including the scanner itself. Tags read `minecraft:block/<tag>`. `chunkAnalyze()` (line 102)
  counts the blocks tagged `forge:ores` in the scanner's chunk, by name. `cost(radius)` (line 93) is
  `floor(((2r+1)^3 - 17^3) * 0.17)` above radius 8, so 330 for 9 and 5274 for 16; above 16 it is
  `nil, "Radius is exceed max value"`. Scan and chunkAnalyze share the `scanBlocks` operation: 2 s cooldown
  (`scanBlocks is on cooldown`); a refused radius starts no cooldown (`OperationAbility.java` line 59).
- **Fuel:** a block geo scanner has the block's fuel. Powered peripherals are off by default, so a scan is free and
  the fuel methods say 0. On a turtle the cost comes out of the turtle's fuel; `Not enough fuel for operation`
  (line 83) when it has too little, and nothing is taken when turtles need no fuel. The consumption rate can only
  be 1.
- **Block reader** (`BlockReaderPeripheral.java`): `getBlockName()` is the block in front or `"none"` for air.
  `getBlockData()` is its block entity as a table: the world's `blockEntity`, and for a container `Items` as
  `{ Slot (from 0), id, Count }`. Air or a block with no block entity give `nil`.
- **Inventory manager** (`InventoryManagerPeripheral.java`): works on the online player whose name is on the card,
  wherever they are. With no card, an unbound card or an offline owner, `getOwner()` is `nil` and every other
  method fails with `The Inventory Manager doesn't have a memory card or it isn't bound to a player.`
  - Slots are 0-based. `getItems`/`list` list slots 0-35 with `slot`; `getArmor` gives 100-103 by the item's armour
    type, and 0 for a worn item that is no armour (a pumpkin). Display names are in brackets (`[Cobblestone]`), as
    `ItemStack.getDisplayName` gives them. `isWearing(i)` compares `i` with the worn count minus 100 (line 214), so
    only -100 to -97 can be true.
  - `removeItemFromPlayer`/`pushItems(side, count, slot?, name?)` and `addItemToPlayer`/`pullItems` are the
    deprecated forms: `slot` is the target slot (the chest's for a push, the player's for a pull). The `NBT` forms
    take an item filter table; its `count` wins over the argument. A filter error is `0, "<CODE>"`
    (`ITEM_NOT_FOUND`, `NO_VALID_ITEM`, `NO_VALID_COUNT`, ...).
  - The player side is the whole inventory (0-35, then the armour, then the off hand), the armour alone for slot
    100-103 and the off hand for 36. An empty filter matches every item, armour included. Items go into the first
    slot that takes them, empty or not (Forge's `ItemHandlerHelper.insertItem`), and an armour slot only takes what
    fits it. `InventoryUtil.moveItem` is followed line by line, including its `amount -= remainder` quirk (line 95).
  - No chest on that side: a push and `listChest` give `INVENTORY_TO_INVALID`, a pull moves 0. A chest slot out of
    range is `Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index 30 out of bounds for length 27`.
    A side that is no side is `SIDEWAYS is not a valid side`.
- **Chunky turtle** (`ChunkyPeripheral.java`, `TurtleChunkyUpgrade.java` line 36): type `chunky`, only `getName`
  (`nil`) and `getConfiguration` (`{}`). While it is equipped it force-loads the turtle's chunk with a Forge ticket
  of distance 2, so that chunk and the two around it in every direction are loaded wherever the turtle goes. With
  `loadedChunks` set, a turtle without it stops at the edge with `Cannot leave loaded world`; with it, it keeps
  going. Unequipped, the force goes.

### Not simulated / not confirmed

- The pocket computer geo scanner: a pocket upgrade, not built (a world can be a pocket computer, `"kind": "pocket"`,
  but AP's pocket upgrades are not there).
- `chunkAnalyze` counts blocks from `blocks` and `fills` only, never `ground`, and skips fills larger than 250000
  blocks.
- Block entities: only containers and blocks with `blockEntity` have one. Signs, beds, computers and the like
  give `nil` unless the world says otherwise. Item NBT in `Items` is only there when the item's `nbt` is a table.
- Furnaces and other sided containers are reached as plain inventories by the inventory manager.
- Armour slots are worked out from item names (`_helmet`, `_chestplate`, `_leggings`, `_boots`, elytra, pumpkins
  and heads). Give an item `equipSlot` (`"head"`, ...) or `armorItem` to override.
- The bracketed display names follow the source (`ItemStack.getDisplayName`), not a measurement. Fingerprints use
  them too. Items with NBT need an explicit `fingerprint`.
- Tags are sorted; the game gives them in no fixed order.
- The chunk record's 600 s timeout (`chunkLoadValidTime`) is not simulated: the turtle touches it every tick
  while it runs anyway.
