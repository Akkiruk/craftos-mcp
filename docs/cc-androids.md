# CC: Androids emulation

Addon id `cc-androids`. Lua in `rom-overlay/rom/ccsim/addons/cc-androids/` (on top of `rom-overlay/rom/ccsim/mob.lua`,
which the mobs with a computer in them share). Tests in `packages/runner/src/cc-androids.integration.test.ts`.
Examples in `workspace/examples/cc-androids/`.

CC: Androids adds androids: mobs with a computer in them that walk, mine, fight and carry things on their own once a
program tells them what to do. A world with an `android` entry makes the emulated computer that android. It stands in
the same block world a turtle does ([turtle.md](turtle.md): `blocks`, `fills`, `ground`, `items`, `entities`), with
an `android` API in place of `turtle`.

## Source and versions

Written from the mod's source, [ThunderBear2006/CC-Androids](https://github.com/ThunderBear2006/CC-Androids) at commit
[`a804326`](https://github.com/ThunderBear2006/CC-Androids/tree/a804326) (2025-07-15), which is release 1.3.0 on
Modrinth (Forge and Fabric, one source). The repository's head (`dc51f8e`, 1.3.1, not released) changes only the
screen. Paths below are relative to `common/src/main/java/com/thunderbear06/`.

| Minecraft | Mod release | In the emulator                 |
| --------- | ----------- | ------------------------------- |
| 1.18.2    | none        | the addon cannot be switched on |
| 1.20.1    | 1.3.0       | emulated                        |
| 1.21.1    | none        | the addon cannot be switched on |

So a world needs `"version": "1.20.1"`.

## World

```json
{
  "version": "1.20.1",
  "addons": ["cc-androids"],
  "android": {
    "x": 0,
    "y": 64,
    "z": 0,
    "type": "normal",
    "fuel": 100,
    "hands": { "main": { "name": "minecraft:iron_pickaxe", "count": 1 } },
    "inventory": { "0": { "name": "minecraft:redstone", "count": 16 } },
    "owner": { "name": "Steve", "uuid": "00000000-0000-4000-8000-000000000001" }
  },
  "ground": {
    "y": 63,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "blocks": [{ "x": 3, "y": 64, "z": 0, "name": "minecraft:chest" }],
  "items": [
    { "x": 1, "y": 64, "z": 1, "name": "minecraft:diamond", "count": 3 }
  ],
  "entities": [
    {
      "type": "minecraft:zombie",
      "uuid": "0-0-0-0-1",
      "x": 4.5,
      "y": 64,
      "z": 4.5,
      "health": 20
    }
  ]
}
```

| `android` field      | Meaning                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `x`, `y`, `z`        | Where it stands. Whole `x` and `z` put it in the middle of that block; fractions are taken as they are. Put in the air, it comes down to the ground below.                        |
| `dimension`          | Default `minecraft:overworld`.                                                                                                                                                    |
| `type`               | `normal` (default), `advanced` or `command`. See the table below.                                                                                                                 |
| `fuel`               | 0 to 10000. Default 0: it can do nothing that moves it until it is fed.                                                                                                           |
| `health`             | Default: the type's full health.                                                                                                                                                  |
| `hands.main`, `.off` | The item in each hand.                                                                                                                                                            |
| `inventory`          | The stash: slots `"0"` to `"8"`, numbered as the API numbers them.                                                                                                                |
| `owner`              | The player who opened it first (`name`, `uuid`). The android's chat and actions carry this uuid; without an owner it is CC's fake player, `0d0c4ca0-4ff1-11e4-916c-0800200c9a66`. |
| `uuid`               | The android's own uuid, for `getSelf`.                                                                                                                                            |

`androidConfig` at the top of the world holds values of the mod's config file by their names there
(`AndroidMaxHealth`, `AndroidDamage`, `AndroidSpeed`, and the same with `AdvAndroid` and `ComAndroid`).

The three androids (`entity/EntityRegistry.java`, `config/CCAndroidsConfig.java`, `entity/android/*.java`):

| Type       | Computer | Health | Damage | Speed | Sees mobs and blocks within | Fuel       |
| ---------- | -------- | ------ | ------ | ----- | --------------------------- | ---------- |
| `normal`   | normal   | 20     | 1      | 0.6   | 10                          | needed     |
| `advanced` | advanced | 25     | 3      | 0.9   | 30                          | needed     |
| `command`  | command  | 25     | 3      | 0.9   | 30                          | not needed |

The computer has the turtle's 39x13 screen (`AndroidComputerContainer.createComputer`); a normal android's has no
colour. A command android does not get the `commands` API here.

**Entities** are the block world's (`world.entities`): `type`, `x`, `y`, `z`, and optionally `uuid`, `name`,
`health` (default 20), `drops` (items left when it dies), `width` and `height` (default 0.6 and 1.8). A uuid can be
written short (`"0-0-0-0-1"`); the API always gives the full form. The world's `players` count as entities too
(`type` `minecraft:player`); one with `"gamemode": "creative"` or `"spectator"` is passed over where the game passes
it over.

## The `android` API

Every function of `computer/api/AndroidAPI.java`, 27 in all, also as `require("android")`. Arguments are checked the
way CC:Tweaked checks them (`bad argument #1 (string expected, got nil)`). Most functions answer nothing when they
did what was asked and `true, <message>` when they could not; a few answer a single string or `false, <message>`,
and the table keeps the mod's own inconsistencies.

Functions marked **tick** run on the server thread (`mainThread = true`): the call takes one game tick, and events
that arrive meanwhile are lost, as with any such call in game.

| Function                                       | Answers                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `currentTask()`                                | `idle`, `movingToBlock`, `movingToEntity`, `attacking`, `breakingBlock`, `usingBlock` or `usingEntity`                                                                                                                         |
| `getSelf()`                                    | `{ uuid, name, posX, posY, posZ, health }`. The name is the computer's label, or `Android` for all three types.                                                                                                                |
| `attack(uuid)`                                 | starts `attacking`. `true, "Unknown entity or invalid UUID"` when there is no such entity.                                                                                                                                     |
| `goTo(uuid)`                                   | starts `movingToEntity`. Same failure.                                                                                                                                                                                         |
| `moveTo(x, y, z)` or `moveTo({x=,y=,z=})`      | starts `movingToBlock`. `true, "Block pos must be within build limit"`.                                                                                                                                                        |
| `breakBlock(pos)`                              | starts `breakingBlock`. `true, "Block position must be within a 100 block radius"`, `true, "Block position must be in world build limit"`.                                                                                     |
| `useBlock(pos)`                                | starts `usingBlock`. `true, "Block position must be in world build limit"`.                                                                                                                                                    |
| `useEntity(uuid)`                              | starts `usingEntity`. `true, "Unknown entity or invalid UUID"`.                                                                                                                                                                |
| `pickup([type])` **tick**                      | takes the first dropped item within 5 blocks whose id contains `type` into the main hand. `true, "Could not find item"`, `true, "Cannot pickup item without an empty hand"`.                                                   |
| `dropItem()` **tick**                          | drops the main hand's stack at its feet. `"Hand is empty"` (one value).                                                                                                                                                        |
| `storeItem(index)` **tick**                    | main hand to stash slot 0-8: `false, "Stashed held item at index N"`. `true, "No item in hand to stash"`, `"Index must be between 0 and 9"` (one value, and yes, 9), `"Index is occupied by another item stack!"` (one value). |
| `equipSlot(index)` **tick**                    | stash slot to main hand: `false, "Equipped stack from index N"`. `true, "Index must be between 0 and 8"`, `"Cannot equip item while holding an item"` (one value), `"Index of stash is empty"` (one value).                    |
| `swapHands()` **tick**                         | nothing                                                                                                                                                                                                                        |
| `getHandInfo(hand)` **tick**                   | the stack's display name and count (`"Air", 0` when empty). `hand` is `main`/`right` or `off`/`left`; anything else `true, "Invalid hand name"`.                                                                               |
| `getSlotInfo(index)` **tick**                  | `false, <item name>`, or `"empty"` (one value). `true, "Index must be between 0 and 8"`.                                                                                                                                       |
| `refuel([count])` **tick**                     | burns the main hand's stack: `false, "Fuel level increased to N"`. `true, "Hand is empty"`, `true, "Held item stack cannot be used for fuel"`.                                                                                 |
| `fuelLevel()` **tick**                         | the fuel                                                                                                                                                                                                                       |
| `getClosestPlayer()` **tick**                  | the nearest player within 100 blocks, as `getSelf` describes itself; `{}` when there is none                                                                                                                                   |
| `getNearbyMobs([type])` **tick**               | a list of every living thing in range that it can see (players too), each as above. `type` is a piece of the entity id (`"zombie"`).                                                                                           |
| `getClosestMob([type])` **tick**               | one of them, or `{}`                                                                                                                                                                                                           |
| `getBlocksOfType(type)` **tick**               | a list of `{ x, y, z }` of the blocks in range whose id contains `type` and that it can see, nearest first                                                                                                                     |
| `getContainerInfo(pos)` **tick**               | `{ slotCount, locked, slots }`, each slot `{ <name>, <count> }`; `{}` for a block that is no container. Error `Position out of range`.                                                                                         |
| `storeHeldItemInContainer(pos, slot)` **tick** | nothing. Errors `Position out of range`, `Targeted block does not have an inventory`, `There is already a item in that slot`.                                                                                                  |
| `grabItemFromContainer(pos, slot)` **tick**    | nothing. Errors `Position out of range`, `Targeted block does not have an inventory`, `Slot is empty`, `Slot is blocked by item`.                                                                                              |
| `sendChatMessage(text)`                        | nothing; the message is in sim state under `chat`                                                                                                                                                                              |
| `changeFace(name)`                             | nothing. `angry`, `annoyed`, `happy`, `sad`, `woozy`; anything else is the normal face.                                                                                                                                        |
| `cancelTask()`                                 | nothing                                                                                                                                                                                                                        |

Things the source does that are easy to trip over, all emulated:

- **Fuel.** `attack`, `goTo`, `moveTo`, `breakBlock`, `useBlock` and `useEntity` throw `Android requires fuel.`
  at 0 fuel. A running task burns 1 fuel a second (`BaseAndroidEntity.tick`); at 0 the task stays the current task
  but stops being worked on. Redstone is worth 10 and a redstone block 80
  (`data/cc_androids/tags/items/*_android_fuel.json`; a world's `gameData.itemTags` can put more items in
  `cc_androids:minor_android_fuel`, `medium` and `major`, worth 10, 80 and 800). `refuel` counts the room left in
  items instead of fuel, as `addFuel` does, and the cap is 10000.
- **Positions** (`getPosFromArgs`) are three numbers or one table with `x`, `y` and `z`. A table without all three
  throws `x,y,z keys expected`; one with a value that is no number throws a Java `ClassCastException`.
- **Uuids** go through `UUID.fromString`, so text that is no uuid throws
  `Java Exception Thrown: java.lang.IllegalArgumentException: Invalid UUID string: ...`.
- **Container slots count from 0**, and a slot past the end throws Java's `ArrayIndexOutOfBoundsException`. The
  container must be within 10 blocks (30 for an advanced or command android).
- **`getContainerInfo` names** are Java's `Text.toString()`, not the name:
  `translation{key='item.minecraft.coal', args=[]}`, and `translation{key='block.minecraft.air', args=[]}` for an
  empty slot.
- **`getClosestMob`** measures from `(x, y, x)` of the android's block: the source passes its x where z belongs.
- **The android hears itself.** `sendChatMessage` raises `onChatMessage` on its own computer, because the fake
  player that speaks stands where the android does.

### Tasks

One task at a time (`ai/task/`); a new one replaces the old. Each game tick the android first walks, then works on
its task (`AndroidEntity.tickMovement`).

- **movingToBlock** ends once the android's block is less than 2 blocks from the target (so beside it, not on it).
- **movingToEntity** ends once it stands in the entity's block, or the entity is dead.
- **attacking** walks until less than 2 blocks away, then hits once every 11 ticks until the target is dead. Damage
  is the type's plus the main hand's weapon (vanilla swords, axes, pickaxes, shovels and the trident; an item's
  `attackDamage` in the world overrides it). A mob that dies leaves its `drops` where it stood.
- **breakingBlock** walks until less than 3 blocks away, then adds
  `(speed / 5) / hardness / (30 if the hand's tool is right for the block, else 100) x 100` to its progress each
  tick and breaks the block at 10 (`MiningModule`; the fifth is because the fake player never stands on the ground).
  By hand, stone takes 75 ticks; with an iron pickaxe, 4. The drops lie where the block was, by the loot tables,
  and only if the tool can harvest it. A tool takes 1 damage. Bedrock and the like end the task at once.
- **usingBlock** walks until less than 2 blocks away, then right-clicks the block's top with the main hand: doors,
  trapdoors and fence gates open or shut, a lever flips, a button is pressed (and springs back), and a block item
  is placed on top of the block.
- **usingEntity** walks until less than 2 blocks away, then right-clicks the entity: a lead leashes a mob, an empty
  hand unleashes it (the lead drops), `cc_androids:components` repairs another android by 5.

A task that cannot be finished never ends by itself (a block that cannot be reached, say): `cancelTask()`.

### Events

| Event           | Arguments                             | When                                                                                      |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `onChatMessage` | message, sender's name, sender's uuid | a player within 50 blocks says something (sim command `chat`), or the android itself does |

### Peripherals

`BaseAndroidEntity.updatePeripherals`: once a second, while it has no task, the android wraps the blocks around it.
The sides are fixed to the compass whichever way it faces: `back` north, `front` south, `right` west, `left` east,
`bottom` below. Nothing is ever on `top`.

A pocket upgrade in a hand is a peripheral on that side: the main hand is `right`, the off hand `left`
(`AndroidComputerContainer.onHandItemChanged`). The emulator knows the wireless modem, the ender modem and the
speaker.

## Sim state

`addons["cc-androids"]` in state.json (`sim` in run results):

- `android`: `type`, `x`, `y`, `z`, `fuel`, `health`, `face`, `main`, `off`, `slots`, `task`, `target`,
  `interactions` (what `useBlock` and `useEntity` clicked) and `chat` (what it said).
- `entities`: every mob in the world, with `uuid`, `type`, position, `health`, `leashedTo`, `interactions`.

Blocks the android changed are in `blocks` and what lies on the ground in `droppedItems`, as for a turtle.

## Sim commands

| Command            | Arguments                                              | What it does                                                               |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `androidSetHand`   | `hand?` (`main`, `off`), `item` (an item, an id, null) | what a sneaking player's click puts in its hand                            |
| `androidSetSlot`   | `slot` (0-8), `item`                                   | a stash slot                                                               |
| `androidSetFuel`   | `fuel`                                                 |                                                                            |
| `androidSetHealth` | `health`                                               |                                                                            |
| `androidTeleport`  | `x`, `y`, `z`                                          | puts it somewhere else                                                     |
| `chat`             | `player`, `message`                                    | the emulator's own: a player speaks, and an android within 50 blocks hears |
| `mobSpawn`         | `type`, `x`, `y`, `z`, `uuid?`, `health?`, `drops?`    | a mob appears                                                              |
| `mobMove`          | `uuid`, `x`, `y`, `z`                                  | a mob is somewhere else                                                    |
| `mobRemove`        | `uuid`                                                 | a mob is gone                                                              |
| `mobDropItem`      | `x`, `y`, `z`, `name`, `count?`                        | an item lands on the ground                                                |
| `mobSetBlock`      | `x`, `y`, `z`, `name?`, `state?`, `items?`             | a block is placed, or taken away without a name                            |

The five `mob` commands are the same for every mob addon (`rom-overlay/rom/ccsim/mob.lua`).

## Simplified

- **Walking** is a path over whole blocks: up one block, down up to three, through wooden doors (which it opens),
  found by A\* over at most 256 blocks within 24 of the android, as far toward the target as it can get. The game's
  own pathfinder weighs water, fences, danger and partial blocks; none of that is here. The android moves at the
  speed a mob of its movement speed settles at (0.19 blocks a tick, 0.44 advanced), without speeding up or slowing
  down.
- **Blocks are whole.** Sight lines, collisions and the "is this block solid" test of `getBlocksOfType` treat a
  slab or a fence as a full cube.
- **Block hardness** is in the game's code, not its data: the emulator has the common vanilla values and counts
  anything else as stone (1.5). A world gives others in `gameData.hardness`.
- **Breaking speed** knows the vanilla tool tiers. Enchantments and shears are not counted.
- **`getBlocksOfType`** gives the blocks in the order of `BlockPos.iterateOutwards`, as read from the game's code.
- **`useBlock`** does the clicks listed above. Any other item (a bucket, flint and steel, bone meal) and any other
  block's own click do nothing.
- **`useEntity`** on a mob other than the cases above only counts the click (`interactions` in sim state).
- **Peripherals** beside the android are there from boot, and a change of hand items looks at all sides at once;
  in game the first look is up to a second after boot.
- **A Java exception's text** is right for the cases listed here. `UUID.fromString` on hex groups with other
  characters gives a `NumberFormatException` whose text may differ.

## Not emulated

- **The android's own body**: taking damage, dying and dropping its parts, being locked with a tripwire hook, dyed,
  wrenched apart or repaired by a player. `health` only changes by sim command.
- **Other androids** as computers. Another android in `entities` is a mob.
- **The ROM programs** `follow` and `guard` and the android tips in the MOTD: the mod is CC BY-NC, so its files are
  not shipped. The `android` API they are written against is all here.
- **The `commands` API** of a command android.
- **Rogue androids** (they have no computer).
- **Armour, knockback and enchantments** in fights; the look of the face and the dyes.
