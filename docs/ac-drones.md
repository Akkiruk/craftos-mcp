# AC-Drones emulation

Addon id `ac-drones`. Lua in `rom-overlay/rom/ccsim/addons/ac-drones/` (on top of `rom-overlay/rom/ccsim/mob.lua`,
which the mobs with a computer in them share). Tests in `packages/runner/src/ac-drones.integration.test.ts`.
Examples in `workspace/examples/ac-drones/`.

AC-Drones adds a flying drone with a computer in it: an entity, not a block. A world with an `acDrone` entry makes
the emulated computer that drone. It has a `drone` API, four item slots, a claw that carries blocks, and room for two
attachments (wireless modems, a chunkloader).

## Source and versions

Written from the mod's source, [ApioCraft/ac-drones](https://github.com/ApioCraft/ac-drones) at commit
[`a73fcdd`](https://github.com/ApioCraft/ac-drones/tree/a73fcddfb2d2916cd99d2fe80c2b6f536f39f594) (2025-09-19), which
is what the Modrinth releases `1.20.1-alpha-7` and `1.21-alpha-7` of that day were built from. Paths below are
relative to `src/main/java/net/apiocraft/acdrones/`.

| Minecraft | Mod release      | In the emulator                                                                     |
| --------- | ---------------- | ----------------------------------------------------------------------------------- |
| 1.18.2    | none             | the addon cannot be switched on                                                     |
| 1.20.1    | `1.20.1-alpha-7` | emulated                                                                            |
| 1.21.1    | none that loads  | the addon cannot be switched on: the `1.21-alpha-7` jar asks for Minecraft `1.21`   |
|           |                  | exactly (`fabric.mod.json`: `"minecraft": "1.21"`), and Fabric refuses it on 1.21.1 |

The repository has one branch, and it is the 1.21 code. The 1.20.1 source is not published, so the 1.20.1 jar was
compared with the 1.21 one class by class (`javap -c` on both release jars). The Lua side of the two is the same
except for one call:

- `drone.compare` uses `ItemStack.areEqual` on 1.20.1 (yarn `method_7973`: item, NBT **and count**) and
  `ItemStack.areItemsAndComponentsEqual` on 1.21 (count ignored). The emulator follows 1.20.1.
- Outside Lua: the 1.21 entity calls `applyGravity()` (a drone whose computer is off falls); the 1.20.1 one does not.

The repository's head, [`fa57149`](https://github.com/ApioCraft/ac-drones/commit/fa5714951e1f5f3fc18d006575af76c782f47331)
(2026-03-02, not released), changes one thing: `drone.place()` (below). `"build": "fa57149"` in the world gives that
behaviour.

CC:Tweaked code the mod calls into was read at `v1.20.1-1.113.1` (the mod asks for 1.112.0 or later; the files used
are the same in both).

Nothing here was measured in a running game.

## World

A drone world is a block world like a turtle's (`blocks`, `fills`, `ground`, `items`, `entities`, see
[turtle.md](turtle.md)) with an `acDrone` entry, and it has to say `"version": "1.20.1"`.

```json
{
  "version": "1.20.1",
  "addons": ["ac-drones"],
  "acDrone": {
    "x": 0,
    "y": 64,
    "z": 0,
    "inventory": { "1": { "name": "minecraft:cobblestone", "count": 8 } },
    "accessory": "claw",
    "attachments": ["modem", "chunkloader"]
  },
  "ground": {
    "y": 63,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "blocks": [
    { "x": 3, "y": 64, "z": 0, "name": "minecraft:chest", "items": {} }
  ]
}
```

| `acDrone` field | Meaning                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `x`, `y`, `z`   | Where it is (its feet). Whole `x` and `z` put it in the middle of that block; fractions are taken as given |
| `dimension`     | Default `minecraft:overworld`                                                                              |
| `yaw`, `pitch`  | Degrees, default 0 (0 is south, 90 west, 180 north, -90 east)                                              |
| `inventory`     | Slots `"1"` to `"4"`                                                                                       |
| `selectedSlot`  | 1 to 4, default 1                                                                                          |
| `accessory`     | The bottom slot: `"claw"` (or `"acdrones:drone_claw"`), default none                                       |
| `carrying`      | The block a claw starts with: a `blocks` entry without its position (`name`, `state`, `items`)             |
| `attachments`   | The two attachment slots: `"modem"`, `"advanced_modem"`, `"chunkloader"` or `"none"` (item ids work too)   |
| `build`         | `"alpha-7"` (default) or `"fa57149"`                                                                       |
| `suckOverload`  | `"quantity"` (default) or `"none"`: which of the mod's two `suck` methods the computer got (below)         |

The computer is an advanced one with the turtle's screen, 39 x 13 (`ComputerDroneEntity.createComputer`:
`ComputerFamily.ADVANCED`, `Config.turtleTermWidth/Height`). There is no `turtle` API and nothing next to the drone is
wrapped as a peripheral: the computer is not a block.

A drone has no fuel or energy. While its computer is on it has no gravity (`setNoGravity(computer.isOn())`), so it
stays where it is put.

The default player of a world stands at 0,64,0. Give the world a `players` entry somewhere else when the drone is to
place a block there (a player in the way stops it, as in the game).

## The `drone` API

`apis/DroneAPI.java`. Eight functions; `drone` is a global only (the API has no module name, so `require("drone")`
does not find it).

| Function                    | Returns                                | Runs                |
| --------------------------- | -------------------------------------- | ------------------- |
| `drone.move(x, y, z)`       | `true` or `false, message`             | command queue       |
| `drone.select(slot)`        | `true` or `false, "Slot out of range"` | command queue       |
| `drone.getSelectedSlot()`   | number, 1 to 4                         | at once             |
| `drone.suck(quantity)`      | `true` or `false, message`             | command queue       |
| `drone.place()`             | `true` or `false, message`             | command queue       |
| `drone.compare(slot)`       | `true` or `false, nil`                 | command queue       |
| `drone.getRotation()`       | `yaw, pitch`                           | main thread, 1 tick |
| `drone.getItemDetail(slot)` | the item's table, or one `nil`         | main thread, 1 tick |

Arguments are checked the way CC:Tweaked checks any `@LuaFunction` (`bad argument #1 (number expected, got nil)`;
a `double` must be finite, an `int` is cut toward zero).

### The command queue

`core/DroneBrain.java`. Six of the functions queue a command and wait for a `drone_command_result` event:

- The drone takes one command a tick, on the first tick after the call. A command that finishes at once answers in
  that same tick.
- The event is `drone_command_result, id, true, results...` or `drone_command_result, id, false, message`. The
  whole computer sees it; `id` counts up from 1. The waiting call takes any event with its id whose third value is
  a boolean, so a program can answer its own command with `os.queueEvent`.
- When more than 16 commands are waiting, the call returns `false, "The command queue is too fat"` at once (the
  queue holds 17).
- A failure always carries its message, so a failure without one returns two values, `false, nil` (`compare`).

### move

`commands/DroneMoveCommand.java` and `ComputerDroneEntity.tick`. `x, y, z` is a distance from where the drone is when
the command starts, in blocks, fractions allowed.

Each tick the command sets the drone's velocity toward what is left of the way:

- the speed starts at 0.01 blocks a tick and grows by 0.01 a tick, up to 0.25, while less than half the way is done;
- past half way, once within 2 blocks of the end and faster than 0.05, it drops by `0.01 x (2 - distance)` a tick;
- when less than 0.1 block is left the drone stops dead and the command answers `true`. So **a move ends up to a
  tenth of a block short**, and the shortfalls of several moves add up;
- after 100 ticks it answers `false, "Movement took too long"`. The velocity is left as it was, and the drag
  (x 0.9 a tick) lets the drone coast on ten times its last step, up to 2.5 blocks. 20 blocks in one move work
  (94 ticks); much more does not.

The answer comes one tick after the command is done, so the shortest move (`move(0, 0, 0)`) takes two ticks.

The entity moves like any Minecraft entity (`Entity.move`): a box 0.75 wide and 0.25 high, y first, then the larger
of x and z, stopped by blocks, the blocked axis losing its speed. A blocked drone keeps pushing until the 100 ticks
are over; it slides along a wall, and comes down on top of a block when sent below it (which is how to land on a
chest). A block the drone is already inside does not hold it.

Yaw and pitch follow the velocity (`updateDirection`): yaw goes a quarter of the way toward `atan2(-vx, vz)` each
tick while the drone moves faster than 0.01 sideways, pitch a quarter of the way toward `-1.5 x atan(speed)`. Both are
Java floats, and `getRotation` shows the float's digits (`-89.99998474121094`).

### select, getSelectedSlot, getItemDetail, compare

- `select(slot)`: 1 to 4, else `false, "Slot out of range"`.
- `getItemDetail([slot])`: the selected slot when none is given. The table is CC's full item detail
  (`VanillaDetailRegistries.ITEM_STACK`: name, count, displayName, maxCount, tags, ...). A slot outside 1 to 4 is a
  Java exception: `Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index 4 out of bounds for length 4`.
- `compare(slot)`: whether the selected slot and `slot` hold equal stacks, **counts included** (1.20.1). Two empty
  slots are equal. A slot outside 1 to 4 throws inside the drone's tick on a real server, which crashes it; the
  emulator raises an error that says so.

### suck

`commands/DroneSuckCommand.java`. It works on the block **below** the drone (`getBlockPos().down()`).

- `suck(0)` succeeds and does nothing.
- An inventory below: one call moves items out of **one** slot, the first whose items fit into the drone, at most
  `quantity` of them (CC:Tweaked's `FabricContainerTransfer.moveTo`). Slots whose items do not fit are passed over.
  `false, "No space for items"` when it has items but none fit, `false, "No items to take"` when it is empty.
- No inventory below: the first dropped stack lying in that block of which something fits; up to `quantity` of it.
  `false, "No items to take"` when nothing lies there, `false, "No space for items"` when nothing fits.
- Items go into the selected slot first, then the next ones round (`storeItemsFromOffset`).
- A quantity below 0 throws inside the drone's tick on a real server (inventory below) or does odd things (loose
  items); the emulator raises an error that says so.

**Two `suck` methods.** `DroneAPI` has `suck(int quantity)` and `suck()`, both `@LuaFunction`. CC:Tweaked keeps one
function per name: the one `Class.getMethods()` lists last, and Java does not define that order (HotSpot sorts
methods by the address of their name, which the two share). So a real drone has either `suck(n)`, where `suck()`
is an error, or `suck()`, where `suck(64)` takes one item. The mod's wiki uses both. The emulator gives `suck(n)`
by default and `suck()` with `"suckOverload": "none"`. **`drone.suck(1)` behaves the same with both**; a program
that should run on any server calls nothing else.

### place

`commands/DroneUseCommand.java`. The selected item is used on the drone's own block, clicked from above.

1. An empty slot: `false, "No items to place or use"`.
2. `letMePlace` looks at the block below the drone: it must be inside the build limit and not air, not a liquid
   when the item is a block, and nothing (no mob, no dropped item) may be in it. Else
   `false, "Cannot place block here"`.
3. Alpha 7 ends `letMePlace` with `return !CommonProtection.canPlaceBlock(...)`. With no protection mod claiming
   the block that is always false, so **in alpha 7 `place()` never places anything** on an unprotected block: it
   answers `false, "Cannot place block here"`. Commit `fa57149` ("Whoops! The check was inverted!") fixes it;
   `"build": "fa57149"` emulates that.
4. With the fix: a block item goes into the drone's own block when that can be replaced (air), else into the block
   above it. It needs what the block needs (a torch something to stand on), and a mob or player there stops a solid
   block. One item is used up. Anything else: `false, "Cannot place block here"`.

## Accessories

`accessories/`, `registries/DroneAccessoryRegistry.java`, `inventory/`.

| Slot               | Takes                              | Side of the computer |
| ------------------ | ---------------------------------- | -------------------- |
| bottom (accessory) | claw                               | `bottom`             |
| attachment 1       | modem, advanced modem, chunkloader | `top`                |
| attachment 2       | modem, advanced modem, chunkloader | `back`               |

- **Claw** (`droneClaw/DroneClawAccessory.java`): peripheral type `claw`, methods `grab()` and `drop()`, both on the
  main thread (one tick).
  - `grab()`: takes the block the drone is in, or when that is air the one below it. `nil, "no block to grab"`
    when that is air too, then `nil, "claw is full"`, then `nil, "cannot grab block"` for a block in
    `#acdrones:claw_blacklist` (`#computercraft:turtle`, `#minecraft:dragon_immune`, `#minecraft:wither_immune`).
    Otherwise `true`: the block is gone from the world and its contents went with it. Any other block can be
    taken, water too; hardness does not matter.
  - `drop()`: `nil, "block below drone is not air"`, then `nil, "claw is empty"`, else `true`: the block becomes a
    falling block in the block below the drone. It lands on the first solid block below with its contents; on a
    block it cannot replace (a torch) it breaks into its item and the contents are lost.
- **Modem**: a wireless modem peripheral. `DroneModemAccessory` passes `advanced = false` to CC's modem for both
  items, so an advanced modem in a drone has a normal modem's range and does not cross dimensions.
- **Chunkloader**: a peripheral of type `chunkloader` with no methods.

`ComputerDroneEntity.updateInputsImmediately` and `DroneBrain.update` have two quirks, both emulated:

- putting an attachment in rebuilds every side, which empties `bottom`: the claw's peripheral is gone (the claw is
  still in its slot) until a claw is put in again;
- taking an attachment out leaves its peripheral on the side.

## Sim commands

| Command                                                          | Fields                                       | What happens                                                             |
| ---------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `acDroneSetSlot`                                                 | `slot` 1-4, `item` (an item, an id, or none) | A player changes a slot                                                  |
| `acDroneSetAccessory`                                            | `accessory` (`"claw"` or none), `carrying?`  | The bottom slot. A claw taken out loses its block. Seen on the next tick |
| `acDroneSetAttachment`                                           | `slot` 1-2, `attachment` (a name or none)    | An attachment slot, with the quirks above                                |
| `acDroneTeleport`                                                | `x`, `y`, `z`, `yaw?`, `pitch?`              | The drone is somewhere else                                              |
| `mobSpawn`, `mobMove`, `mobRemove`, `mobDropItem`, `mobSetBlock` | see `rom-overlay/rom/ccsim/mob.lua`          | The world around it                                                      |

Sim state has the drone under `addons["ac-drones"].drone`: `x`, `y`, `z`, `yaw`, `pitch`, `velocity`, `selected`,
`slots`, `accessory`, `carrying`, `attachments`, `sides` (what the computer has on `top`, `back` and `bottom`),
`queued`, `moving` and `falling` (blocks the claw dropped that have not landed). Changed blocks and dropped items are
where a turtle world has them (`blocks`, `droppedItems`).

## Simplified

- Collision is with whole blocks: a slab, a fence or a chest is a full cube. Other entities do not stop the drone.
- Soul sand, honey and cobwebs do not slow it, and slime does not bounce it.
- `place()` only knows block items (with the turtle rules for which block an item places and how it faces). Items
  that do something else when used on a block do nothing and fail.
- A falling block is not an entity while it falls: it cannot be seen or pushed, it lands on the first block with a
  collision shape, and it does not hurt anything.
- A block the claw takes leaves without block updates in the game (flag 2); here sand above it falls and the like.
- The modem's position is the drone's block, not its exact spot.
- Main-thread calls (`getRotation`, `getItemDetail`, the claw) wait one 50 ms tick, not for the tick grid.

## Not emulated

- Protection mods (Common Protection API): nothing is ever protected. In alpha 7 a protected block is the only
  place `place()` works; that is not emulated.
- The drone's owner. The emulated drone always has one; `suck` from an inventory looks the owner up without checking
  that there is one.
- Chunk loading (the chunkloader only shows up as a peripheral; the emulated world is always loaded).
- A drone whose computer is off (it would drop on 1.21), players riding the drone, breaking it, its GUI.
- The commands that are in the source but not in the API: `DroneMineCommand`, `DroneInspectBlockCommand`,
  `DroneLidarCommand` (`lidar` is commented out in `DroneAPI`).
- `compare` with a slot outside 1 to 4 and `suck` with a negative quantity: they crash a real server; the emulator
  raises an error instead.

## Open questions

- Which `suck` a real server gives (above). It can differ from one server start to the next.
- `peripheral.getMethods` order of the claw (`drop`, `grab` here, sorted).
