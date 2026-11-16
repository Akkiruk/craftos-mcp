# CC:Tweaked 1.101.3 (MC 1.18.2) turtle: exact behaviour spec

Taken from the real Java source at tag `v1.18.2-1.101.3`. Use it to re-implement turtles in the Lua emulator.

## Reference prefixes

| Prefix | Meaning                                                                                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `J/`   | `src/main/java/dan200/computercraft/` in the CC:T checkout                                                                                                                                                                                   |
| `R/`   | `src/main/resources/data/computercraft/lua/` (the ROM)                                                                                                                                                                                       |
| `G/`   | `src/generated/resources/data/` (upgrade JSON and tags)                                                                                                                                                                                      |
| `MC/`  | Vanilla and Forge sources: `forge-1.18.2-40.2.9_mapped_official_1.18.2-sources.jar` from the local gradle cache. This code is **not** in the CC:T repo. Rules marked _(vanilla)_ come from it, or from vanilla behaviour that CC calls into. |

"Tick" means one server tick (20 per second). Slots are 1..16 in Lua and 0..15 in Java.

The config defaults are `J/ComputerCraft.java:60-70`. The pack's world config (`saves/New World/serverconfig/computercraft-server.toml`) has the same values:

| Config                          | Default     | Notes                                                                 |
| ------------------------------- | ----------- | --------------------------------------------------------------------- |
| `need_fuel` (`turtlesNeedFuel`) | `true`      |                                                                       |
| `normal_fuel_limit`             | `20000`     |                                                                       |
| `advanced_fuel_limit`           | `100000`    |                                                                       |
| `obey_block_protection`         | `true`      |                                                                       |
| `can_push` (`turtlesCanPush`)   | `true`      |                                                                       |
| turtle terminal                 | **39 x 13** | `final` constant, cannot be configured (`J/ComputerCraft.java:69-70`) |

---

## 1. Command queue and timing

### 1.1 executeCommand

`J/shared/turtle/core/TurtleBrain.java:513-521`

1. If `commandQueue.size() > 16`, the call returns `false, "Too many ongoing turtle commands"` straight away, with no yield and no event.
   - The check is `>`, so 17 commands can sit in the queue and the 18th is refused.
   - One coroutine can only have one command in flight, because each call yields. You only reach the limit with `parallel` or other coroutines.
2. Otherwise the command is queued with id `++commandsIssued`. The counter starts at 0 for each brain and is not saved to NBT. The brain object moves with the turtle (`TileTurtle.java:548`), so ids keep counting across moves but reset when the chunk or world reloads.
3. The Lua call then yields through `MethodResult.pullEvent("turtle_response", callback)` (`TurtleBrain.java:950-973`, `J/api/lua/MethodResult.java:97-107`):
   - A resumed `terminate` event raises the Lua error `"Terminated"` (level 0). **The command stays queued and still runs.**
   - Events with too few args, a wrong type, or a different id are swallowed and the coroutine keeps waiting (`TurtleBrain.java:964-969`).
   - For the matching event, the call returns `args[2..]` of the event: `true, ...results` or `false, message`.

### 1.2 turtle_response event

`TurtleBrain.java:795-821`

| Result                  | Event                                      |
| ----------------------- | ------------------------------------------ |
| success with results    | `"turtle_response", id, true, r1, r2, ...` |
| success without results | `"turtle_response", id, true`              |
| failure                 | `"turtle_response", id, false, message`    |

- On failure `message` can be `nil` (`TurtleCommandResult.failure()` has no message; it is used by detect, compare and compareTo). The Lua return is then `false, nil`.
- No event is queued if the callback id is below 0 (never the case from Lua) or if there is no computer.

### 1.3 Per-tick processing

`TurtleBrain.java:128-152` and `775-822`. `TileTurtle.serverTick` (`J/shared/turtle/blocks/TileTurtle.java:218-234`) runs `super.serverTick()` (computer keep-alive, peripheral refresh), then `brain.update()`, then the `turtle_inventory` check.

`brain.update()` does this, in order:

1. `updateCommands()`. It returns at once if `animation != NONE` or the queue is empty. It also skips the tick if the computer's main-thread budget says `!canWork()` (`maxMainComputerTime` 5 ms per computer, `maxMainGlobalTime` 10 ms, `J/ComputerCraft.java:35-36`). Otherwise it polls **one** command, executes it synchronously and queues its `turtle_response`.
2. `updateAnimation()`. If animation is not NONE: push entities (see 3.4), then `++animationProgress`; when it reaches `ANIM_DURATION = 8`, animation becomes NONE (`TurtleBrain.java:68`, `932-939`).
3. `upgrade.update()` for each equipped upgrade. The modem uses it to sync its light; the speaker uses it to tick audio.

`playAnimation` (`TurtleBrain.java:523-540`) sets `animationProgress = 0`, or 4 for `SHORT_WAIT`, which no command uses.

### 1.4 Timing that Lua can see

- A command runs on the first tick after it is queued where the turtle is idle (no animation) and the main-thread budget allows.
- **The Lua call returns in the same tick the command runs.** It does not wait for the animation. Animation only delays the _next_ queued command.
- If a command runs at tick T and starts an animation: progress hits 1 at T, 2..7 at T+1..T+6, and 8 at T+7, where animation becomes NONE. **The next command runs at tick T+8.**
- If a command starts no animation (any failure, detect, compare, compareTo, inspect, select, refuel(0), craft(0), equip with nothing to swap), the next command can run at tick T+1. Only one command runs per tick.
- So a loop of `turtle.forward()` makes one move every 8 ticks (0.4 s). A loop of `turtle.detect()` does at most one call per tick.
- Commands issued while an animation runs are queued (FIFO) and wait.

| Command                                         | Animation on success (8 ticks)                                       | No animation                                |
| ----------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| forward / back / up / down                      | `MOVE_*`                                                             | any failure                                 |
| turnLeft / turnRight                            | `TURN_*` (always succeeds)                                           | —                                           |
| dig* / attack*                                  | `SWING_LEFT_TOOL` or `SWING_RIGHT_TOOL` (by the side that succeeded) | any failure                                 |
| place\*                                         | `WAIT`                                                               | any failure                                 |
| drop* / suck*                                   | `WAIT` (including count 0)                                           | any failure                                 |
| transferTo                                      | `WAIT` (including the "nothing to take" success)                     | `"No space for items"`                      |
| refuel(n>0)                                     | `WAIT` (even if 0 items used because the tank is full)               | refuel(0), failures                         |
| equipLeft / equipRight                          | `WAIT` if either the old or the new upgrade is non-null              | equip with nothing on either side, failures |
| craft(n>0)                                      | `WAIT` if results are not empty                                      | craft(0), failures                          |
| select, detect*, compare*, compareTo, inspect\* | —                                                                    | always none                                 |

Functions that do **not** use the queue run on the computer thread, never yield, and return directly:

- `getItemCount`, `getItemSpace`, `getSelectedSlot`, `getFuelLevel`, `getFuelLimit`, and `getItemDetail(slot)` / `getItemDetail(slot, false)` (`J/shared/turtle/apis/TurtleAPI.java:364-386`, `575-579`, `667-689`, `808-815`).
- `getItemDetail(slot, true)` uses `context.executeMainThreadTask` (`TurtleAPI.java:813`). It yields until the main thread runs it on a later tick, which is a `task_complete` round trip, not `turtle_response`.

`select` **is** queued (`TurtleAPI.java:347-355`): it takes at least one tick, has no animation, and always returns `true`.

### 1.5 Argument conversion (all functions)

`J/api/lua/IArguments.java`, `J/core/lua/VarargArguments.java`, `J/api/lua/LuaValues.java`

**Required `int` parameters** (`select`, `compareTo`, `transferTo` slot):

- The value must be a Lua number; otherwise `bad argument #N (number expected, got <luatype>)`.
- Lua integers are used as-is. Floats must be finite (`bad argument #N (number expected, got nan|inf|-inf)`) and are cast with `(long)`, which truncates toward zero.
- Then `(int)` keeps the low 32 bits. So `select(4294967297)` selects slot 1.

**Optional ints and booleans** use the default `optLong` / `optBoolean` (`IArguments.java:228-275`) on values converted by `CobaltLuaMachine.toObject` (`J/core/lua/CobaltLuaMachine.java:366-427`):

- `nil` means absent.
- **A function, coroutine or userdata also converts to null, so it is treated as absent.** For example `turtle.drop(print)` behaves like `turtle.drop()`.
- A string or table gives `bad argument #N (number expected, got string|table)`.
- Floats are truncated as above, then `Long.intValue()` is applied.

**Optional side** (`Optional<TurtleSide>`) is `optEnum`:

- It needs a string, case-insensitive `"left"` or `"right"`.
- Anything else gives `bad argument #N (unknown option <value>)`; a non-string gives `bad argument #N (string expected, got <type>)` (`LuaValues.java:170-178`).

`LuaException`s from these functions use the default level 1, so the message carries the caller's position (for example `prog.lua:3: Slot number 17 out of range`).

Checks inside `TurtleAPI.java`:

| Check                                                              | Error message                       | Line                                                          |
| ------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------- |
| slot outside 1..16                                                 | `"Slot number <n> out of range"`    | 830-834                                                       |
| count outside 0..64 (default 64)                                   | `"Item count <n> out of range"`     | 841-846                                                       |
| refuel count below 0 (default `Integer.MAX_VALUE`, no upper limit) | `"Refuel count <n> out of range"`   | 618-624                                                       |
| craft limit outside 0..64 (default 64)                             | `"Crafting count <n> out of range"` | `J/shared/turtle/upgrades/CraftingTablePeripheral.java:41-47` |

In these messages `<n>` is the value after the int conversion.

### 1.6 The ROM wrapper

`R/rom/apis/turtle/turtle.lua`, loaded by `R/bios.lua:606` only when the `turtle` global exists.

- Every native function is copied unchanged into the API table, and `turtle.native` is set to the native table.
- `equipLeft` and `equipRight` are wrapped. After the native call they re-run `addCraftMethod(turtle)` and return only `result, err` (two values).
- `turtle.craft(...)` exists only if `peripheral.getType("left") == "workbench"`, checked first, or else `"right"`. It is `peripheral.call(side, "craft", ...)`. Without a workbench, `turtle.craft` is `nil`.

---

## 2. TurtleAPI functions

All of these are in `J/shared/turtle/apis/TurtleAPI.java`. The "Order" columns list each possible return in the order the code checks it.

### 2.1 Movement and turning

| Function                                                                          | Code                                                                               | Returns                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| `forward()`, `back()`, `up()`, `down()`                                           | `TurtleMoveCommand`, see section 3                                                 | `true`, or `false, msg` |
| `turnLeft()`, `turnRight()` (`J/shared/turtle/core/TurtleTurnCommand.java:26-47`) | facing becomes counter-clockwise / clockwise, then the matching `TURN_*` animation | always `true`, no fuel  |

- `"Unknown direction"` is unreachable from Lua.
- `setDirection` (`TileTurtle.java:330-339`) does `setBlockAndUpdate`, `updateOutput`, then `updateInputsImmediately`. Peripherals and redstone are re-read for all six sides, so the peripherals on front/back/left/right can change, with `peripheral` / `peripheral_detach` events.

### 2.2 dig, digUp, digDown([side]) and attack, attackUp, attackDown([side])

`TurtleToolCommand.java:29-63`. The side argument is an optional `"left"` / `"right"`.

1. Sides are tried in the order **LEFT, then RIGHT**. A side is skipped if a side was given and it is not that side, if no upgrade is fitted there, or if the upgrade's type is not TOOL or BOTH. A modem, speaker or crafting table is never used as a tool.
2. For each tool tried, call `useTool`. On the first success, play `SWING_LEFT_TOOL` or `SWING_RIGHT_TOOL` and return `true`.
3. If every tool fails, return the **first** failure, so the left tool's message wins.
4. If no tool was tried, return `false, "No tool to dig with"` or `false, "No tool to attack with"`.

Neither dig nor attack uses fuel. The per-tool rules are in section 4.

### 2.3 place, placeUp, placeDown([text])

All Lua args are passed as `args.getAll()` (`TurtleAPI.java:241-279`). Only `args[1]` is used, and only if it is a Lua string; it sets sign text. See section 5.

| Order | Return                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| 1     | `false, "No items to place"` (selected slot empty)                                                               |
| 2     | `true` if something was placed or used                                                                           |
| 3     | `false, "Cannot place in protected area"` (only if a protection check failed during an attempt)                  |
| 4     | `false, "Cannot place block here"` (item is a `BlockItem`) or `false, "Cannot place item here"` (any other item) |

No fuel is used.

### 2.4 drop, dropUp, dropDown([count])

`TurtleDropCommand.java:35-91`. Count is 0..64, default 64.

| Order | Condition                                                                                                                                                              | Return                                                                                                                                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | count == 0                                                                                                                                                             | `true` (WAIT), even if the slot is empty                                                                                                                                                                                                                                             |
| 2     | take up to count from the **selected slot only**, capped at the item's max stack size; nothing taken                                                                   | `false, "No items to drop"`                                                                                                                                                                                                                                                          |
| 3a    | the target has an inventory (6.2); store into it from its slot 0 onward; put any remainder back into the turtle starting at the selected slot, wrapping through all 16 | `true` (WAIT) if anything was stored, else `false, "No space for items"`                                                                                                                                                                                                             |
| 3b    | no inventory                                                                                                                                                           | the stack is spawned as an item entity at turtle centre + 0.4 x dir, with velocity dir x 0.7 + rand(-0.1..0.1) on each axis and the default pickup delay (`J/shared/util/WorldUtil.java:157-196`); level event 1000 (dispenser click) plays at the target pos; returns `true` (WAIT) |

- Case 3b succeeds even if the target block is solid.
- The remainder in case 3a can land in a different slot from the one it came from.

### 2.5 suck, suckUp, suckDown([count])

`TurtleSuckCommand.java:38-143`. Count is 0..64, default 64.

| Order | Condition                   | Return                  |
| ----- | --------------------------- | ----------------------- |
| 1     | count == 0                  | `true` (WAIT)           |
| 2     | the target has an inventory | see below               |
| 3     | no inventory                | ground items, see below |

**With an inventory (step 2):**

- Call `takeItems(count, inv)` starting at inv slot 0 (6.1). If nothing comes out: `false, "No items to take"`.
- Store the items into the turtle starting at the selected slot, wrapping. Any remainder goes back into the inventory from slot 0.
- Returns `true` (WAIT) if anything moved, else `false, "No space for items"`.
- **Ground items are ignored when an inventory exists, even if it is empty.**

**Without an inventory (step 3):**

- List the live `ItemEntity`s whose AABB overlaps the 1x1x1 cell of the target block. The list order comes from the world's entity lookup (_vanilla_, effectively spawn or section order). If the list is empty: `false, "No items to take"`.
- For each entity in order:
  - Split off `min(count, stack)` items and store them from the selected slot.
  - If any were stored, update the entity (discard it, shrink it, or put the remainder back), play level event 1000 at the **turtle** pos, and return `true` (WAIT). **Only one entity is taken from per call.**
- If no entity accepted anything: `false, "No space for items"`.
- The pickup delay is ignored.

### 2.6 select(slot)

- `"Slot number <n> out of range"` is thrown before queueing.
- The call is queued and returns `true`. It sets `selectedSlot` and does **not** fire `turtle_inventory`.

### 2.7 getItemCount([slot]) and getItemSpace([slot])

Both default to the selected slot.

- `getItemCount` returns the slot's `count`, which is 0 if the slot is empty (`TurtleAPI.java:364-369`).
- `getItemSpace` returns `64` if the slot is empty, otherwise `min(maxStackSize, 64) - count` (`TurtleAPI.java:380-386`). Examples: an ender pearl 16-stack with 3 items gives 13; a sword gives 0.

### 2.8 detect, detectUp, detectDown()

`TurtleDetectCommand.java:39-41`

- Returns `true` if the target is **not liquid** (material `isLiquid`) **and not air** (`state.isAir()`).
- Otherwise it returns `false`, with no message.
- Replaceable blocks (grass, snow layer, fire) give `true`, even though the turtle can move into them.

### 2.9 compare, compareUp, compareDown()

`TurtleCompareCommand.java:33-83`

1. If the target is air (`isEmptyBlock`), compare against the empty stack, whose item is `minecraft:air`.
2. Otherwise:
   - Roll the block's loot without a tool (`Block.getDrops(state, level, pos, be)`) up to 5 times, and take the first drop whose item equals `block.asItem()`.
   - If none matches, use `new ItemStack(block)`.
   - **In practice the compared item is always `block.asItem()`.** That is `minecraft:air` for blocks with no item, such as water, lava and fire. Vanilla `Item.BY_BLOCK` maps wall torch to torch, wheat crop to wheat_seeds, potatoes to potato, and so on.
3. Return `true` if the selected stack's item equals that item, else `false` with no message. **NBT, damage and count are ignored.**

Results that follow from this:

- An empty selected slot facing air gives `true`.
- An empty selected slot facing water or lava gives `true`, because both items are AIR.
- Cobblestone compared to stone gives `false`.

### 2.10 compareTo(slot)

`TurtleCompareToCommand.java:27-34`

The result is `true` if `a == b` (same Java object) or Forge `canItemStacksStack(a, b)` (`MC/net/minecraftforge/items/ItemHandlerHelper.java:40-46`).

`canItemStacksStack` requires:

- `a` is not empty,
- same item,
- both have a tag or both have none,
- the tags are equal,
- the capabilities are compatible.

It does **not** check the max stack size. So two identical unenchanted pickaxes give `true`.

Edge cases:

- `compareTo(selected)` is always `true` (same object, even if empty).
- Two empty slots give `true` only if both hold the shared `ItemStack.EMPTY` instance. A slot emptied by an in-place shrink (place or craft) can hold a 0-count stack, and then the result is `false`. If you want determinism, treat empty vs empty as `true`.

### 2.11 transferTo(slot [, count])

`TurtleTransferToCommand.java:30-58`. The slot and count are checked first (count 0..64, default 64).

1. Take up to count from the selected slot, capped at the max stack size. If nothing is taken (empty slot, or count 0), return **`true`** (WAIT).
2. Store into the target slot only. Put any remainder back into the selected slot only.
3. Return `true` (WAIT) if anything moved, else `false, "No space for items"`. This happens when the target holds a different item or is full.

Transferring into the selected slot itself takes the items out and puts them all back, which returns `true`.

### 2.12 refuel([count])

See section 7. The returns, in order:

1. `false, "No items to combust"`
2. `false, "Items not combustible"`
3. `true`

### 2.13 getFuelLevel() and getFuelLimit()

- If `needsFuel` is false, both return the **string** `"unlimited"`.
- Otherwise `getFuelLevel` returns `min(fuel, limit)` and `getFuelLimit` returns 20000 for a normal turtle or 100000 for an advanced one (`TurtleBrain.java:454-484`, `TurtleAPI.java:575-579`, `685-689`).

### 2.14 equipLeft() and equipRight()

See 9.3. The returns, in order:

1. `false, "Not a valid upgrade"`
2. `true`

### 2.15 inspect, inspectUp, inspectDown()

`TurtleInspectCommand.java:31-47`

- `state.isAir()` (air, cave_air, void_air) returns `false, "No block to inspect"`.
- Otherwise it returns `true, table` (see 8.1). Liquids are inspectable, for example `{name="minecraft:water", state={level=0}, tags={...}}`.

### 2.16 getItemDetail([slot [, detailed]])

`TurtleAPI.java:808-827`

- An empty slot returns `nil`.
- `detailed` must be a boolean; otherwise `bad argument #2 (boolean expected, got ...)`.
- See 8.2 for the table contents.

### 2.17 getSelectedSlot()

Returns `selectedSlot + 1`.

---

## 3. Movement

`J/shared/turtle/core/TurtleMoveCommand.java`

### 3.1 Target direction

`MoveDirection.java:18-32`

| Command   | Target                 |
| --------- | ---------------------- |
| forward   | facing                 |
| back      | the opposite of facing |
| up / down | world UP / DOWN        |

### 3.2 Checks, in order

1. **canEnter** (`TurtleMoveCommand.java:126-147`):
   - **(a)** `isOutsideBuildHeight(pos)`, meaning `y < minBuildHeight || y >= maxBuildHeight` (`MC/.../LevelHeightAccessor.java:31-33`; overworld -64..319, nether and end 0..255). The message is `"Too low to move"` **if the target y < 0**, else `"Too high to move"`. The `y < 0` test is literal: in the overworld, moving from y=-64 to -65 says "Too low", and moving to 320 says "Too high".
   - **(b)** If `!isInWorldBounds` (|x| or |z| beyond 30,000,000; `MC/.../Level.java:143-153`): `"Cannot leave the world"`.
   - **(c)** If `obeyBlockProtection` and the spawn protection check fails: `"Cannot enter protected area"`. The check is `server.isUnderSpawnProtection(level, pos, fakePlayer)` (`J/shared/TurtlePermissions.java:16-25`); _vanilla_: dedicated server, overworld, radius from server.properties, ops exempt, off if no ops.
   - **(d)** If the chunk is not loaded: `"Cannot leave loaded world"`.
   - **(e)** If outside the world border: `"Cannot pass the world border"`.
2. **Block** (lines 56-62): the move fails with `"Movement obstructed"` unless the target is air (`isEmptyBlock`, meaning `isAir()`), liquid (`Material.isLiquid`), or has a replaceable **material** (`Material.isReplaceable`, a property of the material, _vanilla_). From `MC/net/minecraft/world/level/material/Material.java:4-17` and `Blocks.java`, the materials that pass are:

   | Material                    | Blocks                                                                                                               |
   | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
   | AIR                         | air, cave_air, void_air, light                                                                                       |
   | STRUCTURAL_AIR              | structure_void                                                                                                       |
   | WATER (liquid)              | water                                                                                                                |
   | LAVA (liquid)               | lava                                                                                                                 |
   | BUBBLE_COLUMN (liquid)      | bubble_column                                                                                                        |
   | REPLACEABLE_PLANT           | grass, tall_grass, fern, large_fern, dead_bush, vine, glow_lichen, hanging_roots, sunflower, lilac, rose_bush, peony |
   | REPLACEABLE_FIREPROOF_PLANT | nether_sprouts, crimson_roots, warped_roots                                                                          |
   | REPLACEABLE_WATER_PLANT     | seagrass, tall_seagrass                                                                                              |
   | TOP_SNOW                    | snow (**any layer count**)                                                                                           |
   | FIRE                        | fire, soul_fire                                                                                                      |

   Everything else is obstructed. That includes flowers (PLANT material), cobweb, torches, carpets and other turtles.

3. **Entities** (lines 65-92):
   - Take the target state's collision shape. If it is **empty**, the check passes with no entity test (`MC/.../EntityGetter.java:36-48`). Air, liquids, plants and fire all have empty collision, so **entities never block a move into them**; they are only pushed (3.4).
   - Only snow with 2 or more layers has a non-empty shape. Then, if an entity with `blocksBuilding` (mobs, players, boats, minecarts; not items or XP) intersects the shape:
     - If `!turtlesCanPush`, or the move is up or down: `"Movement obstructed"`.
     - Otherwise, for each such entity, its bounding box moved one block in the move direction must be free of entities. If not: `"Movement obstructed"`.
4. **Fuel** (lines 95-98): if `needsFuel` and fuel < 1, `"Out of fuel"`. **Obstruction is reported before lack of fuel.**
5. **Teleport** (`TurtleBrain.java:291-366`). This fails with `"Movement failed"` if `setBlock` fails or the chunk check, border check or tile copy fails.
   - The turtle block replaces whatever was there. Grass, snow and fire are deleted **without drops**.
   - The new state is waterlogged if the target was a water **source**; flowing water does not waterlog it.
   - The old block is removed and the new turtle runs `updateOutput` and `updateInputsImmediately`.
6. Use 1 fuel (none if fuel is not needed), play `MOVE_FORWARD`, `MOVE_BACK`, `MOVE_UP` or `MOVE_DOWN`, and return `true`.

`back()` uses exactly the same checks on the cell behind. There is no extra rule.

### 3.3 Fuel cost

- Exactly 1 per successful move (`turtle.consumeFuel(1)`). Failed moves cost nothing, and turns cost nothing.
- `consumeFuel` returns `true` without changing the level when fuel is not needed (`TurtleBrain.java:487-500`).

### 3.4 Entity pushing during a move animation

`TurtleBrain.java:830-907`. This only applies if `turtlesCanPush`.

For each of the 8 animation ticks:

1. Take an AABB that is the turtle's cell, shrunk on the side it is moving toward by `push = max(1 - (progress+1)/8 + 0.0125, 0)`.
2. Find entities in it that are not spectators and do not have `PushReaction.IGNORE`.
3. Move each one by `dir * 1/8` with `MoverType.PISTON`.

---

## 4. Dig and attack (TurtleTool)

`J/shared/turtle/upgrades/TurtleTool.java`

### 4.1 Default tool upgrades

`G/minecraft/computercraft/turtle_upgrades/*.json`, serialiser `TurtleToolSerialiser.java:30-45`. The default damage multiplier is 3.0.

| Upgrade id                  | Item            | damageMultiplier | breakable tag                                                                                                                                  |
| --------------------------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `minecraft:diamond_pickaxe` | diamond_pickaxe | 3.0              | none, so any breakable block                                                                                                                   |
| `minecraft:diamond_axe`     | diamond_axe     | 6.0              | none, so any breakable block                                                                                                                   |
| `minecraft:diamond_shovel`  | diamond_shovel  | 3.0              | `computercraft:turtle_shovel_harvestable` = `#minecraft:mineable/shovel`, melon, pumpkin, carved_pumpkin, jack_o_lantern                       |
| `minecraft:diamond_hoe`     | diamond_hoe     | 3.0              | `computercraft:turtle_hoe_harvestable` = `#minecraft:crops`, `#minecraft:mineable/hoe`, cactus, melon, pumpkin, carved_pumpkin, jack_o_lantern |
| `minecraft:diamond_sword`   | diamond_sword   | 9.0              | `computercraft:turtle_sword_harvestable` = `#minecraft:wool`, cobweb                                                                           |

`computercraft:turtle_always_breakable` = `#minecraft:leaves`, bamboo, bamboo_sapling. Any tool can break these (`G/computercraft/tags/blocks/*.json`).

Other mods in the pack may add more upgrades; only the CC defaults are listed here.

### 4.2 dig(direction)

`TurtleTool.java:195-266`

1. **Shovel or hoe pre-step.** If the tool item can do `SHOVEL_FLATTEN` or `HOE_DIG`, it runs `TurtlePlaceCommand.deployCopiedItem(toolCopy, turtle, dir, null, null)`. That is the full place logic from section 5: entity first, then the 4 block attempts, using the tool as the held item. If it succeeds, dig returns `true` without breaking anything.
   - Per Forge `ToolActions.java:105-106`, shovels and hoes have these actions; pickaxe, axe and sword do not.
   - _Vanilla_ rules then apply:
     - A shovel turns grass into a dirt path, or puts out a lit campfire. The clicked face must not be DOWN, and for path-making the block above must be air (`MC/.../ShovelItem.java`).
     - A hoe tills grass or dirt into farmland (face not DOWN, air above).
   - **This can affect blocks other than the one in front**, because the place attempts also click the block 2 ahead, the block below the front cell, and the turtle itself (section 5). For example, `dig()` with a shovel, facing air above a grass block, turns that grass into a path and returns `true`.
2. If the turtle tile is gone: `"Turtle has vanished from existence."` (unreachable in normal play).
3. If the target is air (`isEmptyBlock`) or **liquid**: `"Nothing to dig here"`.
4. If `obeyBlockProtection`:
   - A Forge `BlockEvent.BreakEvent` that is cancelled gives `"Cannot break protected block"`.
   - Spawn protection gives the same message.
5. `checkBlockBreakable` (lines 114-126):
   - `state.isAir()`, bedrock, `getDestroyProgress(player) <= 0` (_vanilla_: hardness < 0, for example barrier, end portal frame, command block, structure block, jigsaw), or `!canEntityDestroy` all give **`"Cannot break unbreakable block"`**.
   - Otherwise, if the tool has a breakable tag and the block is not in it, not in `turtle_always_breakable`, and its `getDestroySpeed != 0` (not instabreak), the result is **`"Cannot break block with this tool"`**.
6. Break the block:
   - Drop capture starts (4.4).
   - Play level event 2001 (break particles and sound).
   - `canHarvest = state.canHarvestBlock(...)`. In Forge this is `isCorrectToolForDrops`: true if the block does not need the right tool, otherwise the held diamond tool must be correct (`MC/.../IForgeBlock.java:140`).
   - `onDestroyedByPlayer(...)` removes the block and leaves the fluid state, so a waterlogged block leaves water. Then `destroy`, then `playerDestroy` (drops with the tool's loot context) only if canHarvest.
   - **So an axe turtle can dig stone, but it gets no drops.**
   - The tool is a fresh copy each time, so it never wears out and has no enchantments.
7. Drop capture ends and the call returns `true`.

Dig uses no fuel. _(Vanilla)_ No XP orbs come from the ore; I did not check whether Forge spawns XP here.

### 4.3 attack(direction)

`TurtleTool.java:128-193`

1. Place the fake player at the turtle centre, offset 0.48 in the attack direction (`TurtlePlayer.java:114-146`), and ray-trace entities over 1.5 blocks (`WorldUtil.java:72-138`).
   - The trace stops at the first block collider in the way. It also takes entities whose box overlaps the ray box grown by 0.375 on the two other axes.
   - Entities must be alive and `isPickable` (item entities and XP are not).
   - The closest entity wins, and one containing the start point wins at once.
2. If nothing is hit: `"Nothing to attack here"`.
3. If a Forge `AttackEntityEvent` cancels it, or `!entity.isAttackable()`: `"Nothing to attack here"`.
4. Unless `skipAttackInteraction`, damage = `ATTACK_DAMAGE attribute x multiplier`, with source `playerAttack(fakePlayer)`.
   - The fake player is never ticked, so the held tool's attribute modifiers are never applied. The attribute stays at the player base **1.0** (`MC/.../Player.java:194`, `FakePlayer.java:94`).
   - Damage is therefore **3 for pickaxe, shovel and hoe, 6 for axe, 9 for sword**. This is derived, not measured.
   - An armour stand is hurt twice and always counts as attacked. Any other entity counts as attacked only if `hurt(...)` returns true.
5. If attacked: return `true`. Otherwise: `"Nothing to attack here"`.

_(Vanilla)_ `LivingEntity.hurt` (`MC/.../LivingEntity.java:1038-1047`): while `invulnerableTime > 10`, which is the 10 ticks after a hit, a hit is ignored unless it does more damage than the last one. Turtle attacks are 8 ticks apart. **So when one turtle attacks the same mob over and over, every second attack returns `false, "Nothing to attack here"`.**

Attack uses no fuel.

### 4.4 Drop collection (dig and attack)

`J/shared/util/DropConsumer.java`, `TurtleTool.java:268-277`

- **Dig:** every `ItemEntity` that spawns inside `AABB(blockPos).inflate(2)` (a 5x5x5 box) while the break runs is captured.
  - This includes a chest's contents, torches or plants that pop off because of the break, and the other half of doors and tall plants.
- **Attack:** the target's `LivingDropsEvent` drops are captured, plus any item spawned within `AABB(entity.blockPosition()).inflate(2)` during the hit.
- Each captured stack is stored into the turtle **from the selected slot, wrapping through all 16** (`InventoryUtil.storeItems(drop, turtle, selectedSlot)`).
- Whatever does not fit is spawned as items when capture ends: at the **turtle** position, thrown **behind** the turtle (`direction = facing.getOpposite()`), whatever the dig direction.
- If the turtle tile was removed during the break (for example a TNT chain), nothing is captured and items drop with no direction.

---

## 5. Place

`J/shared/turtle/core/TurtlePlaceCommand.java`

### 5.1 Setup

Lines 56-91.

1. The selected stack is required (`"No items to place"`).
2. The fake player is positioned at the centre of the target cell (the front, up or down cell), facing `dir`.
3. `loadInventory(turtle)` copies **all 16 slots** into the fake player's inventory, rotated so that player slot 0 is the turtle's selected slot. Slot i holds turtle slot `(sel+i)%16`, and the held item is player slot 0 (`TurtlePlayer.java:155-168`). These are the same stack objects.
4. After the deploy, `unloadInventory` (lines 170-196):
   - Writes player slots 0..15 back to `(sel+i)%16`.
   - Stores any items that ended up in player slots 16..40 into the turtle from the selected slot.
   - Drops anything that does not fit behind the turtle.

   For example, filling one bucket from a stack of empty buckets puts the water bucket in the first free slot counting from the selected one.

### 5.2 deploy order

Lines 104-121. It stops at the first success.

1. **Entity** (lines 123-176). Ray-trace 1.5 blocks from the **target cell centre** in `dir`.
   - If an entity is hit, drops are captured as in dig (into the player inventory, then back to the turtle; overflow behind the turtle).
   - The steps tried: Forge `onInteractEntityAt`, else `entity.interactAt`. Then Forge `onInteractEntity`; if that returns a value it decides the result. Otherwise `entity.interact`, then `stack.interactLivingEntity` for living entities.
   - Typical successes: shears on sheep, bucket on cow, breeding food, dye on sheep, name tag, saddle.
2. **Block attempts.** Each one is `deployOnBlock(position, side, allowReplace)`:

   | #   | Clicked block `position`                           | Clicked face `side`                              | allowReplace | Fake player position, look                                                  |
   | --- | -------------------------------------------------- | ------------------------------------------------ | ------------ | --------------------------------------------------------------------------- |
   | A   | target cell (front, up or down)                    | `dir.getOpposite()` (the face toward the turtle) | **true**     | the turtle cell + 0.48 x dir, facing `dir`                                  |
   | B   | 2 cells away (`target + dir`)                      | `dir.getOpposite()`                              | false        | target cell centre, facing `dir`                                            |
   | C   | **horizontal dir only**: the cell below the target | `UP`                                             | false        | target cell centre; yaw = turtle facing, pitch 90 (down)                    |
   | D   | the **turtle's own cell**                          | `dir`                                            | false        | target cell centre, facing `dir.getOpposite()` (**back toward the turtle**) |

   For `dir` UP or DOWN with a vertical look, `setPosition` keeps the turtle's yaw and sets pitch from `toPitchAngle`: DOWN = 90, UP = 270 (`DirectionUtil.java:29-39`).

   `canDeployOnBlock` (lines 178-209) **skips** the attempt, without an error, if any of these is true:
   - `position` is outside the world bounds,
   - `position` is air,
   - the held item is a `BlockItem` and `position` is liquid,
   - `!allowReplace` and `state.canBeReplaced(ctx)` (_vanilla_, depends on the item; for example grass, snow layer 1, water for most blocks).

   Then, if `obeyBlockProtection`, it checks edit permission on `position` (when replaceable) or `position + side` (otherwise). On failure it sets the message `"Cannot place in protected area"` and skips the attempt.

   The hit vector is built from **cell-local fractions, not world coordinates**: `(0.5+sx*0.5, 0.5+sy*0.5, 0.5+sz*0.5)`, with y set to 0.45 when the face is horizontal (lines 222-228). _(Derived)_ Vanilla code that reads `clickLocation - pos` (stair and slab half, for example) therefore sees odd values. Normally that gives the bottom half, but at negative world Y it can give the top half. This is derived, not tested.

   `doDeployOnBlock` (lines 267-301) tries these steps in order:
   1. Forge `RightClickBlock` event (if cancelled, use its result),
   2. `stack.onItemUseFirst(ctx)`,
   3. `stack.useOn(ctx)`; a `BlockItem` places a block here,
   4. only for `BucketItem`, `BoatItem`, `WaterLilyBlockItem` and `BottleItem`: Forge `onItemRightClick`, then `stack.use(level, player, hand)`. It counts if it consumes the action and the stack changed, and the new stack goes into the hand.

   **The block's own `use()` is never called.** Place never opens chests or flips levers and buttons. Throwables, food and ender pearls are never "used", so they fail with `"Cannot place item here"`.

### 5.3 What follows for normal block placement

For a forward place into an air or replaceable front cell, the first attempt that works decides how the block is placed:

1. **Front cell replaceable** (grass, a 1-layer snow, water for non-BlockItems):
   - Attempt A clicks it with replaceClicked, so the block replaces it.
   - The player looks along `dir`. _(Vanilla)_ Blocks placed facing the player end up facing the turtle; for example a furnace or chest front points back at the turtle.
2. **Front cell is air or liquid, and a solid block is 2 ahead:** attempt B. The block is attached to that block's near face (wall torches, signs, logs on the `dir` axis). The player looks along `dir`.
3. **Otherwise, for a horizontal place, a solid block below the front cell:** attempt C. The block sits on that block's top face (log axis Y; floor sign or torch). The player looks down with yaw = facing.
4. **Otherwise:** attempt D, against the turtle's own front face. The player looks back toward the turtle, so blocks that face the player face **away** from the turtle. Wall-mounted blocks hang on the turtle.
5. If the front cell is solid and not replaceable, every attempt fails and the result is `"Cannot place block here"`.

_(Vanilla)_ `BlockItem` placement also fails if an entity occupies the cell (`isUnobstructed` with collision), or if the block cannot survive there (a torch with no support, for example).

Orientation is decided by vanilla `getStateForPlacement` from this context (look yaw/pitch, clicked face, hit vector). CC itself never sets a facing.

### 5.4 Sign text

Lines 240-251 and 303-325. This applies only when the placement succeeded, the item is a `SignItem`, and `args[1]` is a string.

1. Find the sign's block entity: the one at `position` if it is new, otherwise the one at `position + side`. Skip if it is not a `SignBlockEntity`.
2. Split the text with Java `text.split("\n")`. This is a regex split and **trailing empty strings are removed**: `""` gives `[""]`, `"\n\n"` gives `[]`.
3. `firstLine = (#lines <= 2) ? 1 : 0`. Row i gets `lines[i - firstLine]` when it exists, otherwise `""`.
4. Lines beyond the 4th are ignored, and each line is cut to its first 15 characters (UTF-16 chars, which are byte-chars for CC strings).

So:

- `"a"` goes on row 2 (1-based).
- `"a\nb"` goes on rows 2 and 3.
- `"a\nb\nc"` goes on rows 1 to 3.

### 5.5 Fuel

Place uses no fuel and never changes the turtle's facing.

---

## 6. Inventory rules

`J/shared/util/InventoryUtil.java`, Forge `InvWrapper`

### 6.1 Helpers

- **`storeItems(stack, inv, start, range, begin)`** (lines 113-126):
  - Visit slots `start + (i + begin - start) % range` for i = 0..range-1. Each one gets `insertItem(slot, remainder)`, stopping when the remainder is empty.
  - The 3-argument form `storeItems(stack, inv, begin)` covers all slots starting at `begin`, wrapping. The 2-argument form starts at 0.
  - It returns `stack` itself if nothing changed (`ItemStack.matches`), otherwise the remainder. Callers use `remainder != stack` to mean "something moved".
- **`insertItem`** (Forge `MC/net/minecraftforge/items/wrapper/InvWrapper.java:59-140`):
  - **Into an empty slot:** if `canPlaceItem` allows it, put in `min(maxStack, slotLimit)`.
  - **Into a filled slot:** the slot must not be full (`count < min(itemMax, slotLimit)`), and `canItemStacksStack` must hold (same item, equal NBT, see 2.10). Then add up to the space left.
  - The turtle's slot limit is 64 (`Container.getMaxStackSize`), and `canPlaceItem` is always true.
- **`takeItems(count, inv, start, range, begin)`** (lines 143-179):
  - Walk the slots in the same wrapping order. The first non-empty slot that yields anything sets the item, and count becomes `min(count, maxStackSize)`.
  - Later slots are only taken from if they are stackable with the first (same item and NBT).
  - It stops when count reaches 0.
  - The turtle's own drop and transferTo use `range 1` (selected slot only). Suck from an inventory uses the whole inventory from slot 0.

### 6.2 What counts as an inventory

`getInventory(level, pos, side)`, lines 48-96. `side` is the target's face toward the turtle. The checks, in order:

1. The block entity's Forge `ITEM_HANDLER_CAPABILITY` for `side`. This gives sided inventories, for example a furnace: from the top you reach the input, from the sides the fuel slot, and from the bottom the output (_vanilla_/Forge).
2. A `WorldlyContainer` block entity, through `SidedInvWrapper`.
3. Any `Container` block entity.
4. A `WorldlyContainerHolder` block, such as the composter.
5. An entity that is a `Container` (chest or hopper minecart). It is found by a ray starting at `pos centre + 0.6*side` and running 1.1 blocks into the cell.

Otherwise there is no inventory, and drop and suck use the world.

### 6.3 Same item and getItemSpace

- **Stacking and compareTo** use NBT, so damaged, enchanted or renamed stacks differ.
- **compare** (the world block) uses the item only.
- **Detect, turtle_inventory change detection** and `setItem` no-op detection use `ItemStack.matches`: count, item and NBT (`MC/.../ItemStack.java:428-446`).
- **getItemSpace** with an empty slot always returns 64. Otherwise it is `min(maxStackSize, 64) - count`.

### 6.4 The turtle_inventory event

`TileTurtle.java:218-234`, `445-498`

- At the end of the turtle's server tick, after the command has run and its `turtle_response` has been queued, `"turtle_inventory"` (no args) is queued once, if the inventory changed since the last snapshot.
- So in the same tick the order is: `turtle_response`, then `turtle_inventory`.
- What marks a change:
  - `setItem` with a stack that does not match,
  - a partial `removeItem`,
  - `clearContent`,
  - `setChanged()` when any slot differs from the snapshot. `updateBlock()` calls this override, and every animated command leads to it through `playAnimation`. `select` and `setDirection` call `onTileEntityChange`, which is `super.setChanged()` and does **no** snapshot compare.
- The cause does not matter: player GUI edits, hoppers, other turtles, suck, dig drops all count.
- `select` and fuel changes do not change the inventory, so they never fire it.

---

## 7. Refuel

`TurtleRefuelCommand.java:29-46`, `J/shared/turtle/FurnaceRefuelHandler.java`

1. If the selected slot is empty: `"No items to combust"`.
2. Post a Forge `TurtleRefuelEvent`. The built-in handler takes the event only if `fuelPerItem > 0`. If no handler takes it: `"Items not combustible"`.
3. If `limit == 0`, return **`true`** with no items used and no animation. This is the "is this fuel?" test.
4. Otherwise, run the handler's `refuel(limit)` (lines 30-51) and play `WAIT`:
   1. `space = fuelLimit - fuelLevel`.
   2. `fuelPerItem = (ForgeHooks.getBurnTime(stack, null) * 5) / 100`. This is integer division, so it equals `burnTime / 20` rounded down.
   3. `itemLimit = ceil(space / fuelPerItem)`, and `limit = min(limit, itemLimit)`.
   4. Extract `limit` items from the selected slot (fewer if the slot has fewer). Add `fuelPerItem x extracted` fuel, capped at `fuelLimit` (`setFuelLevel` clamps).
   5. The container item from `getContainerItem(extracted)` (an empty bucket for a lava bucket) is stored from the selected slot. If it does not fit, it is dropped behind the turtle.
   6. Return `true`.
5. **Refuelling with a full tank returns `true`**: `itemLimit` is 0, so nothing is used, but the WAIT animation still plays.
6. One item more than needed is used to reach the limit, because of the `ceil`. The extra fuel is lost to the clamp.
7. **With `needsFuel = false`, refuel still works and uses items.** The level is stored and capped, but Lua sees `"unlimited"`.

Fuel limits: normal 20000, advanced 100000 (`TurtleBrain.java:474-484`). The level is read back as `min(level, limit)`.

_(Vanilla)_ Fuel per item, from `MC/.../AbstractFurnaceBlockEntity.java:113-174`. Items in `#non_flammable_wood` (crimson and warped wood) are excluded, and Forge item overrides and events can change values.

| Item                                                                                                                                                             | Fuel per item |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| lava bucket                                                                                                                                                      | 1000          |
| coal block                                                                                                                                                       | 800           |
| dried kelp block                                                                                                                                                 | 200           |
| blaze rod                                                                                                                                                        | 120           |
| coal, charcoal                                                                                                                                                   | 80            |
| boats                                                                                                                                                            | 60            |
| logs, planks, wooden stairs, trapdoors, pressure plates, fences, fence gates, chests, crafting table, bookshelf, bow, fishing rod, ladder, banners, barrel, etc. | 15            |
| scaffolding                                                                                                                                                      | 20            |
| signs, wooden tools, wooden doors                                                                                                                                | 10            |
| wooden slabs                                                                                                                                                     | 7             |
| sticks, saplings, wool, wooden buttons, bowl, dead bush, azalea                                                                                                  | 5             |
| carpet (67)                                                                                                                                                      | 3             |
| bamboo (50)                                                                                                                                                      | 2             |

---

## 8. inspect and getItemDetail tables

### 8.1 inspect

Detail registry `BLOCK_IN_WORLD`, made of `BlockData.fillBasic` and `BlockData.fill` (`J/ComputerCraftAPIImpl.java:64`, `J/shared/Registry.java:391`, `J/shared/peripheral/generic/data/BlockData.java`). Mods can add extra providers.

```
{ name = "minecraft:oak_stairs",              -- registry id
  state = { facing = "north", half = "bottom", shape = "straight", waterlogged = false },
  tags  = { ["minecraft:stairs"] = true, ... } }  -- block tags, each value true
```

- State values: strings, numbers and booleans are kept as-is (an int property is a Lua number). Enum properties use `property.getName(value)`, the lowercase serialised name.
- `tags` comes from `state.getTags()`, a map from tag id to `true`.

### 8.2 getItemDetail

- **Basic** (`detailed` false or omitted): `ItemData.fillBasicSafe` gives **only** `{ name = "<item id>", count = <n> }`. **There is no `nbt` key** (`ItemData.java:28-34`).
- **Detailed** (`true`): registry `ITEM_STACK` = `ItemData.fillBasic`, then `ItemData.fill`, then any mod providers (`ItemData.java:36-91`):

| Key                   | When present                                              | Value                                                                      |
| --------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| `name`                | always                                                    | item id                                                                    |
| `count`               | always                                                    | number                                                                     |
| `nbt`                 | the stack has a tag                                       | lowercase hex MD5 of the tag (see below)                                   |
| `displayName`         | always                                                    | `getHoverName().getString()`                                               |
| `maxCount`            | always                                                    | `getMaxStackSize()`                                                        |
| `damage`, `maxDamage` | `isDamageableItem()` (false if the tag has `Unbreakable`) | numbers                                                                    |
| `durability`          | `isBarVisible` (damaged)                                  | `getBarWidth/13.0`; _vanilla_ barWidth = `round(13 - damage*13/maxDamage)` |
| `tags`                | always                                                    | `{ ["<item tag>"]=true, ... }`                                             |
| `itemGroups`          | always                                                    | list of `{ id = group.langId, displayName = ... }`                         |
| `lore`                | `display.Lore` list exists                                | list of strings, parsed JSON components; bad entries skipped               |
| `enchantments`        | visible enchantments exist                                | list of `{ name, level, displayName }`                                     |
| `unbreakable`         | tag `Unbreakable` and `(HideFlags & 4) == 0`              | `true`                                                                     |

- Enchantments: enchanted books are shown if `(HideFlags & 32) == 0`; normal enchantments if `(HideFlags & 1) == 0`.
- The `nbt` hash (`J/shared/util/NBTUtil.java:173-219`) is the MD5 of a big-endian NBT write with the root name `""`. Keys are sorted at **every compound level reached by recursion**, but compounds _inside lists_ are written in vanilla (unsorted) order.
- _Vanilla:_ a new damageable item has the tag `{Damage:0}`, so tools always have `nbt`.

---

## 9. Upgrades and peripherals

### 9.1 Default upgrades

`G/computercraft/computercraft/turtle_upgrades/` and `G/minecraft/computercraft/turtle_upgrades/`

| Upgrade id                                      | Item                    | Type       | Peripheral type | Code                                               |
| ----------------------------------------------- | ----------------------- | ---------- | --------------- | -------------------------------------------------- |
| `computercraft:wireless_modem_normal`           | wireless_modem_normal   | PERIPHERAL | `"modem"`       | `TurtleModem.java`                                 |
| `computercraft:wireless_modem_advanced` (ender) | wireless_modem_advanced | PERIPHERAL | `"modem"`       | `TurtleModem.java`                                 |
| `computercraft:speaker`                         | speaker                 | PERIPHERAL | `"speaker"`     | `TurtleSpeaker.java`, `SpeakerPeripheral.java:190` |
| `minecraft:crafting_table`                      | crafting_table          | PERIPHERAL | `"workbench"`   | `CraftingTablePeripheral.java:36-39`               |
| the 5 diamond tools (4.1)                       | —                       | TOOL       | none            | —                                                  |

- **Modem methods:** `open`, `isOpen`, `close`, `closeAll`, `transmit`, `isWireless` (`ModemPeripheral.java:177-270`).
  - Range for a normal modem: 64, rising linearly above y=96 to 384 at max height. The storm values are the same, 64 and 384 (`WirelessModemPeripheral.java:36-60`, `J/ComputerCraft.java:51-54`). Ender modems have unlimited range across dimensions.
  - **The turtle modem's position is the integer block corner (x,y,z), not the centre** (`TurtleModem.java:47-55`). This changes reported distances slightly.
  - The modem light is stored in upgrade NBT `active`.
- **Speaker methods:** `playNote`, `playSound`, `playAudio`, `stop`. Its position is the turtle block centre.
- **Workbench method:** `craft([limit])` (9.4).

### 9.2 Sides and peripherals on the turtle's own computer

`TurtleBrain.java:744-773`, `TileTurtle.java:316-320`, `525-540`, `TileComputerBase.java:259-294`

- The turtle's computer has peripherals on all 6 local sides: `front`, `back`, `top`, `bottom`, `left`, `right`.
  - `DirectionUtil.toLocal` maps `left` to the counter-clockwise direction from facing and `right` to clockwise (`DirectionUtil.java:17-27`).
  - **Turtles are not left/right swapped** the way computers are (`TileComputer.java:77-84`).
- A side with a **peripheral** upgrade shows that upgrade's peripheral, and the adjacent block on that side is hidden (`isPeripheralBlockedOnSide`).
- A side with a **tool** upgrade, or nothing, shows the adjacent block's peripheral, if there is one (`setPeripheral(side, null)`, then `refreshPeripheral`).
- Adjacent blocks are read through `Peripherals.getPeripheral`: the `CAPABILITY_PERIPHERAL` capability first, then providers, then generic peripherals (`J/shared/Peripherals.java:41-71`). So a chest in front of a turtle is `peripheral.wrap("front")`, an `inventory` generic peripheral.
- Peripherals are re-read after every move, turn and upgrade change, with the usual `peripheral` / `peripheral_detach` events.

### 9.3 equipLeft() and equipRight()

`TurtleEquipCommand.java:29-87`

1. **The selected item.** If the selected stack is not empty, look it up with `TurtleUpgrades.get(stack)`: the item must equal an upgrade's crafting item, and `isItemSuitable` must pass (`J/shared/UpgradeManager.java:77-91`). If not: `false, "Not a valid upgrade"`.
   - For tools (`TurtleTool.java:73-89`): no tag or an empty tag passes. Otherwise the stack must not be **damaged**, **enchanted** or **renamed**, and must not carry a non-empty `AttributeModifiers`; other NBT is allowed.
   - For other upgrades (`J/api/upgrades/IUpgradeBase.java:74-86`): the share tag must equal the crafting item's share tag, where null and empty count as equal.
2. **The old upgrade** on this side gives back a **fresh** `new ItemStack(craftingItem)` (a copy with no extra NBT).
3. If there is a new item, take **one** from the selected slot.
4. If there is an old item, store it from the selected slot, wrapping. If it does not fit, drop it in **front** of the turtle (`dropItemStack(..., facing)`).
5. `setUpgrade(side, new)`. This updates peripherals and runs `updateInputsImmediately()`, so a block peripheral hidden behind the old upgrade can appear.
6. Play `WAIT` if the old or the new upgrade is not null. Return **`true`**. These cases are also `true`:
   - an empty slot with nothing equipped (no animation),
   - unequipping into an empty hand,
   - equipping the same upgrade that is already fitted (items swapped, peripheral kept).

Equipping uses no fuel. The ROM wrapper refreshes `turtle.craft` afterwards (1.6).

### 9.4 craft([limit])

This is the workbench peripheral, reached through `turtle.craft` or `peripheral.call(side, "craft", n)`.

The limit must be 0..64, default 64; otherwise `"Crafting count N out of range"`. The call goes through the same command queue (`CraftingTablePeripheral.java:41-47`). Then `TurtleCraftCommand.java:31-50` and `TurtleInventoryCrafting.java`:

1. Look for a 3x3 window in the 4x4 inventory. Slot index = `x + 4*y`, and slot 1 is the top left. The windows are tried in this order, as (xStart, yStart): **(0,0), (0,1), (1,0), (1,1)**. A window is only used if **every slot outside it is empty**. It is matched with the vanilla `RecipeManager` crafting lookup (shaped recipes may sit anywhere in the window, and mirrored shapes match).
2. If no window matches: `false, "No matching recipes"`.
3. If limit is 0: return `true`, with nothing crafted and no animation.
4. Otherwise repeat up to `limit` times while the recipe still matches:
   - Assemble one result, which can hold several items (for example 4 planks). It goes into a results list.
   - Fire `onCraftedBy` and the Forge crafting event.
   - Take **one** from every non-empty grid slot.
   - Handle remainders (empty buckets, bottles and the like): put each in its slot if the slot is now empty, merge it if it is the same item and NBT, otherwise add it to the results.

   **The limit counts crafting steps, not items.**

5. After the loop, store each result stack from the selected slot, wrapping. Anything that does not fit is dropped in **front** of the turtle.
6. Play `WAIT` if there were results, and return `true`.

---

## 10. The turtle as seen by others

- **Peripheral type `"turtle"`** (`TileTurtle.java:571-579`). It is a `ComputerPeripheral` with the methods `turnOn`, `shutdown`, `reboot`, `getID`, `isOn`, `getLabel` (`J/shared/computer/blocks/ComputerPeripheral.java:44-102`).
  - It is returned through `CAPABILITY_PERIPHERAL`, which is checked first, **so a turtle never shows up as a generic `inventory` peripheral** in this version.
  - After a turtle moves, the old block's capability is invalidated and neighbours get `peripheral_detach`.
- **The turtle's item handler** (`TileTurtle.java:565-569`) is an unsided `InvWrapper` over all 16 slots, the same from every side. Hoppers, droppers and other turtles' drop and suck work on it; another turtle sucking from it takes from slot 1 first.
- **Terminal size:** 39 x 13 for both normal and advanced turtles (`TileTurtle.java:92-101`). Advanced turtles have colour (`ServerComputer.java:57`, `family != NORMAL`); normal turtles do not.
- **Other block properties:**
  - Hardness 2.5, stone material (`J/shared/Registry.java:122-125`).
  - Explosion resistance is 2000 for advanced turtles, or for any turtle when the explosion comes from a living entity or projectile (creeper, ghast). Otherwise it uses the default (`BlockTurtle.java:168-177`).
  - When broken, a turtle drops itself with its id, label, colour, fuel (if above 0), upgrades and overlay, plus its inventory contents (`TurtleItemFactory.java`, `ItemTurtle.java:40-61`, `TileTurtle.java:110-139`).

---

## 11. Other things Lua can observe

- **Label:** `os.getComputerLabel` and `os.setComputerLabel` work as on computers. A name tag renames turtles (`canNameWithTag` returns true, `TileTurtle.java:207-210`). The label is kept on the dropped item as its custom name.
- **Redstone:** works exactly as on computers. It is read and written on the 6 _local_ sides and re-read after every move and turn (`TileComputerBase.java:250-294`). When a turtle moves, its outputs propagate from the new position, and the old position is cleared.
- **Owning player:** the fake player uses the owner's GameProfile if one is known, otherwise `[ComputerCraft]` with UUID `0d0c4ca0-4ff1-11e4-916c-0800200c9a66` (`TurtlePlayer.java:38-71`). It matters for protection checks.
- **Dye and water bucket:** a player can dye the turtle or wash the dye off (`TileTurtle.java:160-204`). It has no Lua API.
- **Waterlogging:** set only when the turtle moves into a water source (3.2 step 5).
- **The `turtle` global** exists only on turtles. On other computers, loading `rom/apis/turtle` raises `"Cannot load turtle API on computer"`.

---

## Not determined from this repo

- Exact vanilla `canBeReplaced` for each item and block in place attempts. Material replaceability for movement is listed above.
- Vanilla block orientation for each block (it is decided by each block's `getStateForPlacement`).
- Loot tables and whether XP orbs drop.
- Exact spawn-protection behaviour on the server.
- The sort order of the entity list (which item entity `suck` takes first).
- Damage from mods' Forge events.
- Whether a trailing `nil` in `false, nil` is preserved for `select("#", ...)`.
- The attack damage values (3/6/9) and the every-second-attack i-frame miss are derived from vanilla code and not measured in game.
