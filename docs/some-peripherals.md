# Some Peripherals

Addon id `some-peripherals`. Some Peripherals by SuperSpaceEye, release 0.0.12, Minecraft 1.18.2 (Forge and Fabric).
It has no release for 1.20.1 or 1.21.1, so the addon exists on 1.18.2 only.

Written from [SuperSpaceEye/Some-Peripherals](https://github.com/SuperSpaceEye/Some-Peripherals), branch `1.18.2` at
`955ec42` ("minor fix", 22 January 2024, the day 0.0.12 was published; the repository has no tags). Paths below are
under `common/src/main/kotlin/net/spaceeye/someperipherals/`. The ballistic numbers in the tests come from a
line-for-line Java port of `stuff/BallisticFunctions.kt` and `stuff/utils/linspace.kt`. The mod is not in the pack,
so nothing here was measured in game. The module is `rom-overlay/rom/ccsim/addons/some-peripherals/`.

Its peripherals return errors as a table, `{ error = "message" }` (`makeErrorReturn`), not as `nil, message`.

## What is emulated

18 methods on 4 peripheral types. Methods marked (tick) are `mainThread = true` and wait for the next server tick.

| Type                    | Methods                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sp_radar`              | `scan(r)`, `scanForEntities(r)`, `scanForShips(r)`, `scanForPlayers(r)` (all tick), `getConfigInfo()`                                                                                       |
| `world_scanner`         | `getBlockAt(x, y, z, inShipyard?)`                                                                                                                                                          |
| `ballistic_accelerator` | `timeInAir(...)`, `tryPitch(...)`, `calculatePitch(...)`, `batchCalculatePitches(...)`, `getDrag(base, multiplier)`                                                                         |
| `digitizer`             | `digitizeAmount(n?)`, `rematerializeAmount(id, n?)`, `mergeDigitalItems(into, from, n?)`, `separateDigitalItem(id, n)`, `checkID(id)`, `getItemInSlot()`, `getItemLimitInSlot()` (all tick) |

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Source                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Radar: the radius is at least 1 and at most the config's limit (-1: none). Entities are everything whose box meets the box `pos +- r` around the radar's block (mobs, item entities, players); players alone (`scanForPlayers`) are those whose feet are inside it (the max side open). `scan` gives entities, then ships when Valkyrien Skies is installed; `scanForShips` without it is `{ error = "No Valkyrien Skies installed." }`. A radar on a ship scans from its world position, and lists its own ship first.                                                                                                                                                                                                                                                                                                        | `stuff/radar/scanInRadius.kt`                                                                 |
| An entity: `is_entity`, `pos`, `eye_pos`, `eye_height`, `look_angle` (the view vector, in floats with `Mth`'s sine table), `dimension` (`ResourceKey[minecraft:dimension / minecraft:overworld]`), `entity_type` (`entity.minecraft.cow`), `air_supply`, `max_air_supply`; living ones add `health`, `max_health`, `armor_value`, `armor_cover_percentage`, `absorption_amount`, `is_baby`, `is_blocking`, `is_sleeping`, `is_fall_flying`, `speed`, `xRot`, `yHeadRot`, `yBodyRot`; players `is_player`, `nickname`, `experience_level`, `xp_needed_for_next_level`, `experience_progress`.                                                                                                                                                                                                                                   | `stuff/utils/entityToMap.kt` (`entityToMapRadar`, every field on by default)                  |
| A ship: `is_ship`, `id`, `pos`, `mass`, `rotation` (a quaternion), `velocity`, `size` (its shipyard box), `scale`, `moment_of_inertia_tensor`, `center_of_mass_in_a_ship`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `stuff/radar/shipToMap.kt`                                                                    |
| `getConfigInfo`: `max_entity_search_radius`, `max_ship_search_radius` (-1 by default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `stuff/configToMap/Radar.kt`; `SomePeripheralsConfig.kt`                                      |
| World scanner: the offsets are added to the scanner's block and floored; `{ block_type = "block.minecraft.stone" }` (the description id). Over `max_allowed_range` (default -1: none): `{ error = "Block is outside of range" }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `integrations/cc/peripherals/WorldScannerPeripheral.kt`                                       |
| Ballistics: `timeInAir(y, targetY, vy, gravity?, drag?, maxSteps?)` gives `{ ticks below, ticks to land }` (-1 when it never gets there); `tryPitch(pitch, speed, length, distance, cannon, target, ...)` `{ deltaT, pitch, airTime }` or `{ -1, -1, -1 }`; `calculatePitch(cannon, target, speed, length, amin?, amax?, gravity?, drag?, maxDeltaTError?, maxSteps?, iterations?, elements?, checkImpossible?)` the low and the high arc, each `{ -1, -1, -1 }` when impossible; `batchCalculatePitches` the same for a list of targets; `getDrag` CBC's dimension drag. Defaults: gravity 0.05, drag 0.99, pitch -30..60, max error 1, 1000000 steps, 5 iterations of 20 elements. The mod's `linspace` quirks are kept (below zero its values come out shifted, and it adds the end twice), so the pitches match the mod's. | `stuff/BallisticFunctions.kt`; `stuff/utils/linspace.kt`; `BallisticAcceleratorPeripheral.kt` |
| Vectors (`cannon`, `target`) are read as keys 1.0 .. N, N being every entry of the table: `Can't convert cannon item at  1.0` (two spaces, as the mod builds it) when one is not a number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `integrations/cc/CCTableConversions.kt`                                                       |
| Digitizer: one slot (limit 64). `digitizeAmount` turns up to n items of the slot into a stored stack and gives its UUID; the store is the world's (`DigitalItemsSavedData`), shared by every digitizer. `rematerializeAmount` puts up to n back, as far as the slot has room; merging, separating and `checkID` (`{ item = details }`) as in the source. UUIDs are read as `UUID.fromString` does (any case; a bad one: `First argument is not a UUID`). Errors: `Invalid amount`, `Empty slot`, `UUID doesn't exist`, `Items have same id`, `First id does not exists`, `Can't stack items`, `Item is not stackable`, `Cannot separate stack`, `Failed to merge item inside digitizer with already rematerialized items`. Other blocks can push items into its slot.                                                          | `integrations/cc/peripherals/DigitizerPeripheral.kt`; `stuff/digitizer/*`                     |

## The world

```json
{
  "version": "1.18.2",
  "addons": ["some-peripherals"],
  "position": { "x": 0, "y": 64, "z": 0 },
  "somePeripherals": {
    "valkyrienSkies": false,
    "players": [
      {
        "name": "Steve",
        "x": 3.5,
        "y": 64,
        "z": 2.5,
        "health": 17,
        "experienceLevel": 16
      }
    ],
    "ships": [
      {
        "id": 1,
        "min": { "x": 20, "y": 60, "z": 0 },
        "max": { "x": 28, "y": 64, "z": 6 },
        "mass": 1200
      }
    ],
    "computerShip": null,
    "digitalItems": {
      "6f1e2d3c-4b5a-4968-8776-655443322110": {
        "name": "minecraft:diamond",
        "count": 3
      }
    },
    "config": {
      "max_entity_search_radius": -1,
      "max_ship_search_radius": -1,
      "max_allowed_range": -1
    }
  },
  "ground": {
    "y": 63,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "entities": [
    { "type": "minecraft:zombie", "x": 120.5, "y": 70, "z": 40.5, "health": 20 }
  ],
  "items": [
    { "x": 1.5, "y": 64, "z": 1.5, "name": "minecraft:diamond", "count": 1 }
  ],
  "peripherals": [
    { "name": "sp_radar_0", "type": "sp_radar" },
    {
      "name": "digitizer_0",
      "type": "digitizer",
      "item": { "name": "minecraft:iron_ingot", "count": 20 }
    }
  ]
}
```

- **Each block** stands at `x`, `y`, `z` (the computer's position when left out). A digitizer starts with `item`.
- **The block world** (the world scanner) and **entities** are the ones turtles use (docs/turtle.md): top-level
  `blocks`, `fills`, `ground`, `items`, `entities`. An entity can give `width`, `height`, `eyeHeight`, `health`,
  `maxHealth`, `armor`, `armorCover`, `absorption`, `baby`, `blocking`, `sleeping`, `fallFlying`, `speed` (0 for a
  mob that is not walking, 0.1 for a player), `xRot`, `yRot`, `yHeadRot`, `yBodyRot`, `airSupply`, `maxAirSupply`,
  `dimension`, `living` (false: not living).
- **Players** (`somePeripherals.players`): `name`, `x`, `y`, `z`, `dimension`, and the entity fields, plus
  `experienceLevel`, `experienceProgress`.
- **`valkyrienSkies`**: whether VS2 is installed (off by default). **Ships**: `id`, `min`/`max` (the world box),
  `shipyardMin`/`shipyardMax` (what `size` is worked out from), `pos`, `mass`, `rotation`, `velocity`, `scale`,
  `inertia` (3x3), `centerOfMass`; `computerShip` is the id of the ship the computer stands on, and that ship's
  `computerWorldPosition` where the radar scans from.
- **`digitalItems`**: the world's digitized stacks at boot, by UUID. What the digitizers store survives a reboot.
- **`config`**: `max_entity_search_radius`, `max_ship_search_radius`, `max_allowed_range` (the mod's config keys).

## Sim commands

| Command                                                  | Does                                                 |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `spSetPlayer {player, remove?}`                          | adds, replaces (by name) or removes a player         |
| `spAddEntity {entity}` / `spRemoveEntity {uuid?, type?}` | adds or removes an entity                            |
| `spSetBlock {x, y, z, name?, state?}`                    | puts a block in the world (no name: air)             |
| `spSetShips {ships, computerShip?, leaveShip?}`          | replaces the ships; puts the computer on one, or off |

## Not emulated

- **The raycaster** (`raycast`, `addStickers`, `getConfigInfo`, `getFacingDirection`): its ray walks the world
  through every block's real collision shape, entities and VS ships, a step at a time across ticks; the sim has no
  block shapes to do that faithfully.
- **The goggle link port** and the status and range goggles: they need players wearing goggles and raycasts made from
  the players' clients.
- **Valkyrien Skies in detail**: which ships are "near" (`transformToNearbyShipsAndWorld`) is approximated as ships
  whose world box meets the scan box; the world scanner does not look at blocks on ships (VS's shipyard lookup), so
  with VS on it reads the world block.
- **The world scanner's `no_chunkloading`** option (off by default): every chunk counts as loaded.
- **Entity eye heights** are 0.85 of the height unless the fixture gives `eyeHeight` (players 1.62); boxes are a fixed
  width and height around the fixture's position.
- **The digitizer's GUI** and its menu.
- **Digitized items across computers**: in game the store is the world's; in the sim it is each computer's.
