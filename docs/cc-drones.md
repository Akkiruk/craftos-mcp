# CC: Drones and CC: Drones+ emulation

Addon ids `cc-drones` and `cc-drones-plus`. Lua in `rom-overlay/rom/ccsim/addons/cc-drones/drone.lua` for both: the
fork is the original with its changes switched on (`rom-overlay/rom/ccsim/addons/cc-drones-plus/` only says so). Both
sit on `rom-overlay/rom/ccsim/mob.lua`, which the mobs with a computer in them share. Tests in
`packages/runner/src/cc-drones.integration.test.ts`. Examples in `workspace/examples/cc-drones/`.

CC: Drones adds a small flying mob with a computer in it and a `drone` API, and a drone workbench block that is a
peripheral. CC: Drones+ is a fork of it. A world with a `drone` entry makes the emulated computer a CC: Drones
drone; `dronePlus` makes it a CC: Drones+ one. Either flies through the block world a turtle lives in
([turtle.md](turtle.md): `blocks`, `fills`, `ground`, `items`, `entities`) on the game's own entity physics.

## Source and versions

| Addon            | Mod                                                                     | Commit read                                                                        | Release                     |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------- |
| `cc-drones`      | [JSJBDEV/CCDrones](https://github.com/JSJBDEV/CCDrones)                 | [`5c8f4ed`](https://github.com/JSJBDEV/CCDrones/tree/5c8f4ed) (2024-05-13)         | 0.0.1 on Modrinth, that day |
| `cc-drones-plus` | [minecraftbossdj/CCDrones](https://github.com/minecraftbossdj/CCDrones) | [`c85ef36`](https://github.com/minecraftbossdj/CCDrones/tree/c85ef36) (2025-09-04) | 0.2.0 on Modrinth, that day |

Both are Fabric mods for Minecraft 1.20.1 (Modrinth lists 0.0.1 for 1.20.1 to 1.20.6; it is built for 1.20.1). The
addons cannot be switched on for 1.18.2 or 1.21.1, so a world needs `"version": "1.20.1"`. Paths below are relative
to `src/main/java/ace/actually/ccdrones/`.

Each repository has moved on since its release, and the emulator follows the releases:

- CC: Drones' head (`d90933a`, five days later, never released) adds upgrade items and `findUpgrades`. The fork
  starts from it.
- CC: Drones+'s head (`45dc066`, tag `0.3.0-BETA-TEST1`) moves the upgrades into an inventory with slots and adds a
  nanodrone with its own `nanodrone` API. Not emulated.

The two mods have the same mod id (`ccdrones`), so a real pack has one or the other. The emulator lets both addons
be on. The world key says which drone the computer is; a drone workbench is the original's when both are on (give
the peripheral `"mod": "cc-drones-plus"` for the fork's).

## World

```json
{
  "version": "1.20.1",
  "addons": ["cc-drones"],
  "drone": { "x": 0, "y": 66, "z": 0, "yaw": 0, "hover": true },
  "ground": {
    "y": 63,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "blocks": [{ "x": 0, "y": 66, "z": 4, "name": "minecraft:oak_log" }],
  "entities": [{ "type": "minecraft:pig", "x": 0.5, "y": 64, "z": 0.5 }]
}
```

| `drone` / `dronePlus` field | Meaning                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `x`, `y`, `z`               | Its feet. Whole `x` and `z` put it in the middle of that block; fractions are taken as they are. It is half a block wide and half a block high. |
| `dimension`                 | Default `minecraft:overworld`.                                                                                                                  |
| `yaw`, `pitch`              | Degrees, as F3 shows them: yaw 0 looks south, 90 west, 180 north, -90 east. Default 0. Nothing in the API changes the pitch.                    |
| `engineOn`                  | Start with the engine on. Default false.                                                                                                        |
| `hover`                     | Start without gravity (`NoGravity`). Default false: a drone in the air falls until a program calls `hoverOn(true)`.                             |
| `upgrades`                  | CC: Drones+ only: a list of `mine`, `carry`, `survey`, `modem`.                                                                                 |

| Drone       | Computer           | Screen |
| ----------- | ------------------ | ------ |
| `drone`     | normal (no colour) | 51x19  |
| `dronePlus` | advanced           | 51x19  |

A drone has no sides: nothing beside it is a peripheral.

## The `drone` API

`entities/DroneAPI.java`. 16 functions in CC: Drones 0.0.1, 17 in CC: Drones+ 0.2.0 (no `debug`; `findUpgrades` and
`getPos` added). Arguments are checked the way CC:Tweaked checks them (`bad argument #1 (boolean expected, got nil)`).

0.0.1 answers nothing from any call but `isColliding`, `rotation`, `lookForward` and `lookBack`. The fork answers
`true` or `false` and a message from most.

Functions marked **tick** run on the server thread (`mainThread = true`): the call takes one game tick, and events
that arrive meanwhile are lost.

| Function                  | What it does                                                                                                                                | 0.0.1 answers | 0.2.0 answers                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `engineOn(on)`            | While on, the drone's velocity is set to a tenth of a block a tick the way it faces, every tick. Off: the velocity is set to nothing, once. | nothing       | `true, "Turned On Engine!"` / `true, "Turned Off Engine"`                                                             |
| `hoverOn(on)`             | Gravity off or on.                                                                                                                          | nothing       | `true, "Hover on!"` / `true, "Hover Off!"`                                                                            |
| `right(n)`, `left(n)`     | Turns it `n x 0.15` degrees (`Entity.turn`): a quarter turn is 600.                                                                         | nothing       | nothing                                                                                                               |
| `up(n)`, `down(n)`        | Adds `n / 10` blocks a tick to its upward speed.                                                                                            | nothing       | nothing                                                                                                               |
| `isColliding()`           | Whether its last tick's move was stopped sideways by a block.                                                                               | boolean       | boolean                                                                                                               |
| `rotation()`              | Its yaw in degrees. Not wrapped: eight quarter turns right is 720.                                                                          | number        | number                                                                                                                |
| `lookForward()`           | The block a 3-block ray along its facing hits: `{ name, state, tags }`. Air when nothing is hit.                                            | table         | table                                                                                                                 |
| `lookBack()`              | The same, backwards.                                                                                                                        | table         | table                                                                                                                 |
| `breakForward()`          | Breaks the block `lookForward` sees. Its drops lie there.                                                                                   | nothing       | `true, "Broke Block!"`; without `mine`: `false, "Mining Upgrade Not Installed!"`                                      |
| `pickupBlock()` **tick**  | Takes the block a 2-block ray straight down hits, with what is in it, into the drone.                                                       | nothing       | `true, "Picked Up Block!"`; without `carry`: `false, "Carry Upgrade Not Installed!"`                                  |
| `dropBlock()` **tick**    | Sets the carried block on top of the block that ray hits.                                                                                   | nothing       | nothing                                                                                                               |
| `pickUpEntity()` **tick** | One of the entities near it, at random, rides two blocks under it.                                                                          | nothing       | `true, "Picked up Entity!"`, `false, "No Entities Nearby!"`; without `carry`: `false, "Carry Upgrade Not Installed!"` |
| `dropEntity()` **tick**   | The passenger gets off.                                                                                                                     | nothing       | `true, "Ejected Passenger!"`, `false, "No Passengers!"`                                                               |
| `debug()`                 | 0.0.1 only: prints the drone's block on the server console.                                                                                 | nothing       | (not there)                                                                                                           |
| `findUpgrades()` **tick** | 0.2.0 only: adds the upgrade of every upgrade item lying within 2 blocks. The items stay.                                                   | (not there)   | nothing                                                                                                               |
| `getPos()` **tick**       | 0.2.0 only: its exact position.                                                                                                             | (not there)   | `true, { x, y, z }`; without `modem`: `false, "Modem Upgrade Not Installed!"`                                         |

### How it flies

The drone is a `Mob` with no AI, so every game tick is `LivingEntity.travel` with no input, then
`DroneEntity.tick`:

1. Velocity components under 0.003 become 0.
2. It moves by its velocity; a block in the way stops it on that axis and sets that component to 0.
3. Unless it hovers, 0.08 comes off the upward speed. Then the upward speed is multiplied by 0.98 and the sideways
   speed by 0.91 (0.546 on the ground).
4. If the engine is on, the velocity is replaced by `facing x 0.1`.

What follows from that, and is tested:

- **The engine holds it up.** With the engine on, step 4 wipes out the fall of step 3 every tick, so a drone flies
  level without `hoverOn`. Turn the engine off without hover and it drops.
- **`up` and `down` are a shove, not a distance.** Hovering with the engine off, `up(10)` moves it 1 block the first
  tick, 0.98 the next, and so on: 50 blocks in all unless something stops it. `engineOn(false)` is the brake: it
  sets the velocity to nothing. With the engine on, the shove lasts one tick (`up(10)` is one block).
- **`right(20)` is 3 degrees.** The yaw is a Java float, so `right(7)` gives 1.0500001, not 1.05.
- **Facing** uses the game's sine table (`Mth.sin`), so north, south, east and west are exact.

### What it looks at

`lookForward`, `lookBack`, `breakForward`, `pickupBlock` and `dropBlock` cast their ray from the middle of
`Entity.getOnPos()`, not from the drone:

- In the air that is the block its feet are in, or the one below when it floats at a whole height (y = 66.0 looks
  from the block at 65).
- **On the ground it is the block it stands on.** The ray starts inside that block and hits it at once, so a landed
  drone "sees" the block under it both ways, `breakForward` breaks that block, `pickupBlock` picks it up, and
  `dropBlock` sets the carried block where the drone is.

`breakForward` is `Level.destroyBlock`: it breaks anything, bedrock included, and the drops are the loot table's
with no tool (stone gives cobblestone). Water and lava are hit by the ray and left as they are.

`pickupBlock` does not look at what it takes: air is "carried" too (and `dropBlock` then sets air), and a block
already carried is forgotten. `dropBlock` overwrites whatever is where it puts the block.

`pickUpEntity` looks in a box of 2 blocks around the block a 3-block ray down hits (0.0.1), or 2 blocks around and
below the drone's block (0.2.0).

### CC: Drones+ upgrades

A drone has a list of upgrade names. `breakForward` needs `mine`, `pickupBlock` and `pickUpEntity` need `carry`,
`getPos` needs `modem`; `survey` does nothing yet. A player adds one by sneak-clicking the drone with the item
(sim command `droneAddUpgrade`), or the drone's own `findUpgrades()` adds the upgrade of every
`ccdrones:<name>_upgrade` item lying near it, without picking the item up, so calling it twice adds it twice. A
crowbar drops them all (`droneRemoveUpgrades`).

A new CC: Drones+ drone has a file `/startup/go.lua` holding `--default startup program` (`DroneAPI.initDrive`).

## The drone workbench

Peripheral type `droneworkbench` (`blocks/DroneWorkbenchPeripheral.java`), in both mods.

```json
{
  "name": "left",
  "type": "droneworkbench",
  "below": { "name": "minecraft:stone" },
  "around": [{ "dx": 1, "dy": 0, "dz": 0, "name": "minecraft:oak_log" }],
  "drones": [{ "id": 7 }]
}
```

| Field    | Meaning                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------- |
| `below`  | The block under the workbench (`name`, `state`), for `debug`. Default air.                               |
| `around` | Blocks around it by offset (`dx`, `dy`, `dz`, `name`), for `survey`.                                     |
| `drones` | The drones within 2 blocks, nearest first (`id`: the drone's computer id). `export` writes to the first. |
| `mod`    | `cc-drones` or `cc-drones-plus`: whose workbench it is, when both addons are on.                         |

A workbench that is a block of a block world (a block with `"peripheral": { "type": "droneworkbench" }` beside a
turtle, a placed computer or an android) reads the real blocks around it instead of `below` and `around`.

| Method         | What it does                                                                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug()`      | The block under the workbench: `{ name, state, tags }`.                                                                                                                                                                                                                          |
| `survey()`     | The surveyable blocks from -5 to 4 on each axis around it, as `{ ["dx,dy,dz"] = { name = ... } }`. Surveyable (`data/ccdrones/tags/blocks/surveyable.json`): grass blocks, leaves, logs, planks, stone bricks, stairs, slabs, fences and walls.                                  |
| `export(path)` | Copies the file to `/startup/go.lua` of the nearest drone and reboots it: `"Successfully copied data to drone, booting it up!"`. A missing file answers nothing in 0.0.1 and `"File does not exist!"` in 0.2.0. With no drone near it throws Java's `IndexOutOfBoundsException`. |
| `api()`        | 0.0.1: gives this computer the `drone` API and reboots it. There is no drone behind that API, so every function of it throws a `NullPointerException`; it is there so `edit` can complete the names. 0.2.0: does nothing.                                                        |

`export` here records what it sent in sim state (`exports`: `drone`, `path`, `program`). The drone's own computer is
another computer; see below.

## Sim state

`addons["cc-drones"]` (or `["cc-drones-plus"]`) in state.json (`sim` in run results):

- `drone`: `x`, `y`, `z`, `yaw`, `pitch`, `vx`, `vy`, `vz`, `engineOn`, `hover`, `onGround`, `colliding`,
  `carrying` (the block, with its `items`), `passenger` (a uuid) and, for the fork, `upgrades`.
- `entities`: every mob in the world with its position.
- `exports` and `apiGiven`: what a workbench on this computer did.

Blocks the drone changed are in `blocks` and what lies on the ground in `droppedItems`, as for a turtle.

## Sim commands

| Command               | Arguments                                           | What it does                                               |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `droneTeleport`       | `x`, `y`, `z`, `yaw?`, `pitch?`                     | puts it somewhere else, at rest                            |
| `dronePush`           | `x?`, `y?`, `z?`                                    | adds to its velocity (blocks a tick)                       |
| `droneAddUpgrade`     | `upgrade`                                           | CC: Drones+: a player's sneak-click with the upgrade item  |
| `droneRemoveUpgrades` |                                                     | CC: Drones+: the crowbar; every upgrade drops at the drone |
| `mobSpawn`            | `type`, `x`, `y`, `z`, `uuid?`, `health?`, `drops?` | a mob appears                                              |
| `mobMove`             | `uuid`, `x`, `y`, `z`                               | a mob is somewhere else                                    |
| `mobRemove`           | `uuid`                                              | a mob is gone                                              |
| `mobDropItem`         | `x`, `y`, `z`, `name`, `count?`                     | an item lands on the ground                                |
| `mobSetBlock`         | `x`, `y`, `z`, `name?`, `state?`, `items?`          | a block is placed, or taken away without a name            |

## Simplified

- **Blocks are whole.** The drone's box (0.5 x 0.5 x 0.5) collides with full cubes, and the rays hit full cubes: a
  slab or a fence counts as a whole block. It never steps up onto anything.
- **Every block is as slippery as stone.** Ice and slime make no difference to a drone sliding on the ground.
- **Water** does not slow it or carry it.
- **A passenger** hangs exactly two blocks under the drone, and on `dropEntity` stands on the ground under it at
  once instead of getting off on top of the drone and falling.
- **`pickUpEntity`** picks among the world's `entities` and players. In game, dropped items and anything else that
  is an entity can be picked too.
- **A carried block** keeps its state, its items and its `blockEntity` fields. A block picked up while another is
  carried replaces it cleanly; in game the old block's contents can be left behind in the drone and end up in the
  new block.
- **`peripheral.getMethods`** of the workbench is in alphabetical order; the game's order is not known.

## Not emulated

- **The drone's own body**: fall damage, being hit, dying and dropping as an item, being pushed by other entities.
- **A drone picking itself up.** In 0.0.1 a landed drone is inside its own `pickUpEntity` box and can be the entity
  chosen, which leaves it riding itself. The emulator never chooses the drone.
- **`export` reaching the drone.** The drone is another computer, and the emulator runs one mob computer in a world:
  the program is recorded in sim state, not written to a drone and run.
- **The null API's exact error.** After 0.0.1's `api()` every `drone` function throws
  `Java Exception Thrown: java.lang.NullPointerException: ...`; the rest of the text names a Java method and
  differs from the game's.
- **The `drone` API on every computer.** CC: Drones+ 0.2.0 registers its API for all computers, so on a server with
  it any computer has a `drone` table whose functions throw. Here only a drone has it.
- **The first-boot reboot** of a CC: Drones+ drone: it writes `/startup/go.lua` five ticks after it first starts
  and reboots. Here the file is there from the start.
- **The drone controller item, the crowbar as a weapon and the GUI**, which a program cannot see.
- **CC: Drones+ 0.3.0 beta**: upgrade slots and the nanodrone.
