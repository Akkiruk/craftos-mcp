# UnlimitedPeripheralWorks

Addon id `unlimited-peripheral-works`. UnlimitedPeripheralWorks (UPW) by SirEdvin, release 1.9.2: `1.20.1-1.9.2` on
Minecraft 1.20.1 (Forge and Fabric) and `1.21.1-1.9.2` on 1.21.1 (NeoForge and Fabric). The 1.18.2 release is
Fabric only (0.2.9, a much older API) and the emulator's 1.18.2 is Forge, so the addon does not exist there: a 1.18.2
world that asks for it is refused before the computer boots.

Written from [SirEdvin/UnlimitedPeripheralWorks](https://github.com/SirEdvin/UnlimitedPeripheralWorks) at the tags
`v1.20.1-1.9.2` and `v1.21.1-1.9.2`, and from the libraries that release bundles,
[SirEdvin/Minecraft-Modding-Libs](https://github.com/SirEdvin/Minecraft-Modding-Libs) branch `1.20` at "release
Tweakium 1.4.10" (Tweakium 1.4.10, Peripheralium 1.4.5, Broccolium 1.4.5: the same versions as the jars inside
`peripheralworks-forge-1.20.1-1.9.2.jar`). Every peripheral here has the same Lua behaviour in the 1.21.1 source;
what changed there is how items keep their data (components instead of NBT). The mod is not in the pack, so nothing
here was measured in game. The module is `rom-overlay/rom/ccsim/addons/unlimited-peripheral-works/`.

UPW is big: besides its own blocks it adds peripherals to vanilla blocks and integrates about forty mods. This addon
covers its most used own blocks and its vanilla integrations; the rest is listed under "Not emulated".

## What is emulated

54 methods on 8 peripheral types. Methods marked (tick) are `mainThread = true` and wait for the next server tick (an
event that arrives meanwhile is lost to the caller); the others run at once. `peripheral.getMethods` is CC's HashMap
of the names. Every method returns exactly what the Kotlin returns: `MethodResult.of(null, "message")` is `nil,
"message"`, a `Unit` method returns nothing.

| Type                   | Methods                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `universal_scanner`    | `scan(mode, radius?, filter?)` (tick), `getCooldown(name)` (tick), `getOperations()`, `getConfiguration()`                                                                                                                                  |
| `ultimate_sensor`      | `analyze(name)`, `inspect(name)`, `listAnalyzers()`, `listInspectors()` (all tick), `getCooldown(name)` (tick), `getOperations()`, `getConfiguration()`                                                                                     |
| `item_pedestal`        | `size()`, `list(detailed?, filter?)`, `getItemDetail(slot)`, `getItemLimit(slot)`, `pushItems(to, fromSlot or query, limit?, toSlot?)`, `pullItems(...)` (all tick), `getConfiguration()`                                                   |
| `display_pedestal`     | `getItem()`, `setItem(id, name?, nbt?)`, `isLabelRendered()`, `isItemRendered()`, `setLabelRendered(b)`, `setItemRendered(b)` (all tick), `getConfiguration()`                                                                              |
| `minecraft:note_block` | `getNote()`, `getInstrument()`, `setNote(n)`, `setInstrument(name)`, `play()` (all tick), `getConfiguration()`                                                                                                                              |
| `minecraft:jukebox`    | `getDisc()`, `replay()`, `stop()`, `ejectDisc(to)`, `injectDisc(from, query?)` (all tick), `getConfiguration()`                                                                                                                             |
| `minecraft:beacon`     | `getLevel()`, `getPossiblePowers()`, `getPowers()`, `configure(effect, from, query?, regeneration?)` (all tick), `getConfiguration()`                                                                                                       |
| `minecraft:lectern`    | `hasBook()`, `getPageCount()`, `getActivePage()`, `setActivePage(p)`, `getText()`, `isBookEditable()`, `addPage(text?)`, `removePage(p)`, `editPage(p, text)`, `ejectBook(to)`, `injectBook(from, query?)` (all tick), `getConfiguration()` |

The rules, with their source (paths under `projects/core/src/main/kotlin/site/siredvin/peripheralworks/` unless they
name the library):

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Source                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan`: the mode is checked as a string, the radius is optional (default and maximum 24) and must be 1..24 (`radius should be between 1 and 24`), then an unknown mode is `There is no scanning method X`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tweakium `boon/ScanningBoon.kt` `scan`; `util/ValidationHelpers.kt`                                                                                  |
| A block scanner (no fuel) uses `STATIONARY_UNIVERSAL_SCAN`: cooldown 500 ms, free radius 24, so it never costs. A scan inside the cooldown is `nil, "stationaryUniversalScan is on cooldown"`; a cooldown starts only when it is over the threshold (`cooldownTreshholdLevel`, 100 ms).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `computercraft/operations/SphereOperations.kt`; Tweakium `boon/OperationBoon.kt` `performOperation`; `common/configuration/PeripheralWorksConfig.kt` |
| Blocks: every position of the cube around the scanner, x then y then z, that is not air (or that matches the filter: a filter can match air, `{}` does). Each is CC's block details (`name`, `state`, `tags`, the map colour on 1.121.0) plus `displayName`, and `x`, `y`, `z` relative to the scanner turned to its facing (north turns clockwise, south anticlockwise, west half way, east as is).                                                                                                                                                                                                                                                                                                                                                       | `ScanningBoon.BlockScanningMethod`; Broccolium `ScanUtils.traverseBlocks`, `BlockPosExt.toRelative`                                                  |
| Entities, items, players: everything whose box meets the scanner's block centre +- (radius + 0.5), inflated by 0.99. `entity` is living entities that are not players: `name`, `uuid`, `category`, `type` (`entity.minecraft.zombie`), `displayName`, `tags`, `health`. `item` is the item entity's stack details. `player` adds `experienceLevel`, `foodLevel`, `saturationLevel`, `isCreative`, `yRot`, `xRot`.                                                                                                                                                                                                                                                                                                                                          | `ScanningBoon.EntityScanningMethod`; Broccolium `ScanUtils.getBox`; Tweakium `representation/LuaRepresentation.kt`                                   |
| Filters (block and item queries): a name, or a table whose keys AND together: `or`/`any`, `and`/`all`, `none`, `not`, `name` and `tag` (a string or `{ in = {...} }` / `{ not_in = {...} }`), `displayName` (a block's description id), `nbt` (items). Unknown names: `There is no item X` (also for blocks); a query of the wrong type: `Block query should be string or table` / `Item query should be string or table`; the other messages as in the source.                                                                                                                                                                                                                                                                                            | Tweakium `plugins/PeripheralPluginUtils.kt`                                                                                                          |
| `getConfiguration` gathers every boon's and plugin's: the scanner gives `maxRadius`, `scanMethods`, `scanAPIVersion` {1, 3} and each operation's description (`name`, `type`, `cooldown`, radii, `extraBlockCost`). `getOperations` lists the operation names, `getCooldown(name)` the milliseconds left (`nil, "Cannot find this operation"`).                                                                                                                                                                                                                                                                                                                                                                                                            | Tweakium `OwnedPeripheral.peripheralConfiguration`; `OperationBoon`                                                                                  |
| Sensor: `analyze("dimension")` lists the dimensions; `inspect` has dimension, biome, weather (`thunder`, `rain`, `stable`), orientation (north 0, east 90, south 180, west 270), time (the day time), light (`light`, `sunlight` above the block), calendar (`day`, and `moonPhase` in the overworld), chunk (`oresDistribution` of `forge:ores`/`c:ores` blocks in its chunk from y -64 to 320, `isSlime`; 10 s cooldown). Unknown names: `There is no such analyzer` / `There is no such inspector`.                                                                                                                                                                                                                                                     | `computercraft/peripherals/UltimateSensorPeripheral.kt`; `utils/SensorCollection.kt`; `UnconditionalFreeOperations.kt`                               |
| Item pedestal: one slot. `list` gives basic details (detailed with `true`), keyed by slot; `getItemDetail` gives the full details with `rawNBT`. Slots outside 1..1: `slot should be between 1 and 1`. `pushItems`/`pullItems` take a slot or an item query, move at most 1024 (`itemStorageTransferLimit`), check the target (`Target 'x' does not exist`, `Target 'x' is not an inventory`; `Source ...` for pulls) and the slots (`toSlot should be between 1 and N`, `fromSlot should be between 1 and N`). Types `item_pedestal`, `inventory`, `inventory_extended`. Other blocks' `pushItems` reach it.                                                                                                                                              | `computercraft/plugins/PedestalInventoryPlugin.kt`; Tweakium `plugins/AbstractInventoryPlugin.kt`, `AbstractRudimentInventoryPlugin.kt`              |
| Display pedestal: `setItem` makes a one-item stack (`nil, "Cannot find item with id X"` when the id is unknown); `name` sets its hover name (the tag `display.Name` = `{"text":"name"}`), `nbt` is SNBT parsed into its tag. `getItem` is the full details with `rawNBT` and CC's `nbt` hash of that tag. Label and item are rendered by default.                                                                                                                                                                                                                                                                                                                                                                                                          | `computercraft/peripherals/DisplayPedestalPeripheral.kt`; `common/blockentity/DisplayPedestalBlockEntity.kt`                                         |
| Note block: `setNote` 0..24 (`note should be between 0 and 24`); `setInstrument` takes any case of the 23 `NoteBlockInstrument` names, otherwise `Instrument should be one of: harp, basedrum, ...`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `computercraft/plugins/specific/NoteBlockPlugin.kt`                                                                                                  |
| Jukebox: `Disc should present in jukebox` / `Jukebox should be empty`; `injectDisc` takes one item with the `minecraft:music_discs` tag (and the query) and starts it; `ejectDisc` stops the record (`nil, "Not enough space in target inventory"` when it does not fit). Inventories by name: `Target 'x' does not exist` / `Target 'x' is not an item inventory`.                                                                                                                                                                                                                                                                                                                                                                                        | `computercraft/plugins/specific/JukeboxPlugin.kt`                                                                                                    |
| Beacon: the powers on offer are the first `min(levels, 3)` tiers (regeneration never: the range stops at index 2). `configure` looks the effect up there first (`nil, "Cannot find desired effect in list of available effects"`), then takes one payment item (iron, gold, diamond, emerald, netherite; and the query) from the named inventory (`nil, "Target storage cannot provide desired items"`). At level 4 the secondary power is regeneration when asked, else the primary again (amplifier 1); below 4 the secondary stays what it was. `getPowers`: duration `(9 + levels * 2) * 20`, ambient.                                                                                                                                                 | `computercraft/plugins/specific/BeaconPlugin.kt`                                                                                                     |
| Lectern: `Lectern should contain book`, `Lectern shouldn't contain book`, `Book should be editable` (only a book and quill is), `page should be between 1 and N`. A written book's pages are text components and `getText` gives their text. New and edited pages are cut where a book page runs out (14 lines of 95 pixels, the mod's character widths; a section sign hides the next character). Events (no peripheral name): `lectern_page_changed` with the page asked for, each time the page is set (also by a player), `lectern_book_changed` with the book's name (and the player's, when a player put it there), `lectern_book_removed`. A call's own event comes while it waits for the tick, so the caller only sees it from another coroutine. | `computercraft/plugins/specific/LecternPlugin.kt`; `mixins/LecternMixin.java`; Broccolium `util/TextBookUtils.kt`                                    |
| The vanilla blocks are UPW's `PluggablePeripheral`: the type is the block id, `getConfiguration` is `{ implementationProvider = "upw" }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `computercraft/peripherals/PluggablePeripheral.kt`; `plugins/specific/SpecificPluginProviders.kt`                                                    |

## The world

```json
{
  "version": "1.20.1",
  "addons": ["unlimited-peripheral-works"],
  "position": { "x": 0, "y": 64, "z": 0 },
  "upw": {
    "dayTime": 1000,
    "daylightCycle": true,
    "raining": false,
    "thundering": false,
    "biome": "minecraft:plains",
    "light": { "block": 0, "sky": 15 },
    "dimensions": [
      "minecraft:overworld",
      "minecraft:the_nether",
      "minecraft:the_end"
    ],
    "slimeChunks": ["0,0"],
    "players": [
      { "name": "Steve", "uuid": "...", "x": 2.5, "y": 64, "z": -1.5 }
    ],
    "config": { "stationaryUniversalScanCooldown": 500 }
  },
  "ground": {
    "y": 60,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "blocks": [{ "x": 3, "y": 58, "z": 1, "name": "minecraft:iron_ore" }],
  "entities": [
    { "type": "minecraft:zombie", "x": -2.5, "y": 61, "z": 3.5, "health": 20 }
  ],
  "items": [
    { "x": 1.5, "y": 61, "z": 1.5, "name": "minecraft:diamond", "count": 2 }
  ],
  "peripherals": [
    {
      "name": "universal_scanner_0",
      "type": "universal_scanner",
      "x": 0,
      "y": 63,
      "z": 0,
      "facing": "east"
    }
  ]
}
```

- **The block world** the scanner and the sensor's chunk inspector look at is the one turtles use: the world file's
  top-level `blocks`, `fills`, `ground`, `items` (item entities) and `entities` (docs/turtle.md). With a turtle or a
  placed computer it is that same world, so what a turtle digs a scanner sees.
- **Entities** (`entities`): `type`, `x`, `y`, `z`, and optionally `health` (20), `uuid` (one is made up from the
  entry's place in the list), `displayName`, `category` (a vanilla mob's own by default, else `MISC`), `tags` (a
  list), `living` (false: not a living entity, the scanner skips it), `width`/`height` (the box, 0.6 x 1.8).
- **Players** (`upw.players`): `name`, `uuid`, `x`, `y`, `z`, and `health`, `experienceLevel`, `foodLevel`,
  `saturationLevel`, `isCreative`, `yRot`, `xRot`, `tags`.
- **The sensor**: `upw.dayTime` (6000) moves one a tick on the virtual clock unless `daylightCycle` is false;
  `raining`, `thundering`, `biome`, `light`, `dimensions` and `slimeChunks` ("chunkX,chunkZ") are what it reads. A
  sensor can have its own `biome`, `light`, `dimension` and `slimeChunk`.
- **Each block** (`peripherals`): `x`, `y`, `z` (the computer's position when left out) and `facing` (north) for the
  scanner and the sensor; `item` (or `items`) for the item pedestal; `item`, `renderLabel`, `renderItem` for the
  display pedestal; `note`, `instrument` for a note block; `disc`, `playing` for a jukebox; `levels` (0..4),
  `primary`, `secondary` (effect ids) for a beacon; `book` and `page` (1-based) for a lectern. A book is an item
  whose `__book` holds `pages` (strings; JSON text components for a written book), `title` and `author`; books in
  chests carry it the same way.
- **`upw.config`** overrides the mod's config defaults: `cooldownTreshholdLevel` (100), `itemStorageTransferLimit`
  (1024), and per operation `<name>Cooldown`, `<name>MaxFreeRadius`, `<name>MaxCostRadius`, `<name>ExtraBlockCost`
  (`stationaryUniversalScan`, `inspectChunk`).

What each block keeps survives a reboot (state.json `peripherals.<name>.restore`): cooldowns, pedestal items, the
note, the disc, the beacon's powers, the book.

## Sim commands

| Command                                                                                    | Does                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `upwSetBlock {x, y, z, name?, state?}`                                                     | puts a block in the block world (no name: air)                |
| `upwAddEntity {entity}` / `upwRemoveEntity {uuid?, type?}`                                 | adds or removes an entity                                     |
| `upwSetPlayer {player, remove?}`                                                           | adds, replaces (by name) or removes a player                  |
| `upwSetWorld {dayTime?, raining?, thundering?, biome?, light?, dimensions?, slimeChunks?}` | changes what the sensor reads                                 |
| `upwTurnPage {peripheral, page}`                                                           | a player turns a lectern's page (`lectern_page_changed`)      |
| `upwPlaceBook {peripheral, book, player?}`                                                 | a player puts a book on a lectern, or takes it (`book: null`) |
| `upwSetJukebox {peripheral, playing}`                                                      | the record stops or starts on its own                         |
| `upwSetBeacon {peripheral, levels}`                                                        | the pyramid under a beacon changes                            |

## Not emulated

- **UPW's generic storage.** With the mod installed (default config), every block with an item, fluid or energy
  storage becomes a UPW peripheral with UPW's own `list`/`pushItems`/... (item queries, a 1024 transfer limit,
  `getConfiguration`), in place of CC's generic `inventory`/`fluid_storage`/`energy_storage`. The emulator keeps CC's
  own for chests and tanks.
- **The other own blocks**: map pedestal (needs map data), informative registry and recipe registry (need the game's
  registries and recipes), remote observer, network manager, peripheral proxy, entity link, hologram projector,
  statue workbench, reality forger, flexible reality anchor, the peripheralium hub; the powered rail integration
  (minecarts); the turtle and pocket upgrades (a portable scanner has fuel and a cost: radius 8 free, 16 at most), the
  tweaked turtle peripheral and entity peripherals.
- **The mod integrations** (AE2, Create, Powah, GregTech CEu, KubeJS, Ars Nouveau, Occultism, Integrated Dynamics,
  Deep Resonance, ProjectE, Nature's Compass, Hostile Neural Networks, Easy Villagers, Tom's Storage, Flux Networks,
  Theurgy, Mana and Artifice, Embers, Automobility, Additional Lanterns, Modern Industrialization, ...).
- **What the blocks do to the world**: a note block's `play` makes no sound (it is counted in state.json), a record
  plays until stopped (no song length), a beacon's level comes from the fixture (no pyramid) and gives no effects.
- **Slime chunks** come from the fixture: the game works them out from the world seed with 64-bit arithmetic.
- **Item ids** in queries and `setItem`: vanilla ids are checked against the version's item list; another mod's ids
  cannot be, so they count as real.
- **`setItem`'s SNBT**: a parse error is the same exception, but its message text is the sim's own. On 1.21.1 the
  mod decodes that text as a data component patch; the sim treats it as 1.20.1's tag, so `nbt` hashes differ there.
- **Entity boxes** are a fixed width and height around the fixture's position, not each mob's real size.
